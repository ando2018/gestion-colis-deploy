import bcrypt from 'bcryptjs';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, Utilisateur, Colis, Palette, Conteneur, Entreprise } from './modeles.js';
import { dansEntreprise } from './locataire.js';
import { CODE_DEMO, CODE_PIN, changerAcces, verifierAcces } from './acces.js';
import { origineRequete } from './courriel.js';
import { etatLicence } from './licence.js';
import { authentifier, avecDepot, entrepriseActive, ErreurMetier, estCodeCourt, exiger, interdit, signer } from './noyau.js';
import * as plateforme from './services/plateforme.js';
import * as contact from './services/contact.js';
import * as exporter from './services/export.js';
import * as offres from './services/offres.js';
import * as colis from './services/colis.js';
import * as conteneurs from './services/conteneurs.js';
import * as impression from './services/impression.js';
import * as palettes from './services/palettes.js';
import * as param from './services/parametrage.js';
import * as stats from './services/statistiques.js';
import * as formulaires from './services/formulaires.js';

const { ADMIN, RECEPTION, CARISTE, CHEF_QUAI, CLIENT } = ROLES;
const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function creerApp() {
  const app = express();
  // Derrière un proxy (Nginx, IIS) : adresse https et IP réelles des en-têtes X-Forwarded-*
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Une route par action métier : chaque route vérifie le statut attendu, écrit l'événement, renvoie l'objet à jour.
  const api = express.Router();
  const terrain = (...roles) => [exiger(...roles), avecDepot];

  // ── Gestion de la plateforme (page /plateforme) : comptes et jetons distincts de ceux des entreprises ──
  const pf = express.Router();
  pf.post('/connexion', async (req, res) => res.json(await plateforme.connexion(req.body)));
  pf.get('/demo', (_req, res) => res.json(process.env.DEMO === '1'
    ? { actif: true, email: (process.env.PLATEFORME_EMAIL ?? 'plateforme@colis.local').toLowerCase(), motDePasse: process.env.PLATEFORME_MOT_DE_PASSE ?? 'Colis2026!' }
    : { actif: false }));
  pf.use(plateforme.authentifierPlateforme);
  pf.get('/moi', (req, res) => res.json(req.admin));
  pf.put('/moi/mot-de-passe', async (req, res) => res.json(await plateforme.changerMotDePasse(req, req.body)));
  pf.get('/entreprises', async (_req, res) => res.json(await plateforme.liste()));
  pf.get('/entreprises/code-libre', async (_req, res) => res.json(await plateforme.proposerCode()));
  pf.post('/entreprises', async (req, res) => res.status(201).json(await plateforme.creer(req.body, origineRequete(req), req.admin)));
  pf.get('/smtp', async (_req, res) => res.json(await plateforme.lireSmtp()));
  // Messages des établissements (page Contact de l'application) et coordonnées de l'éditeur
  pf.get('/contact', async (req, res) => res.json(await contact.messagesPlateforme(req.query)));
  pf.put('/contact/:id', async (req, res) => res.json(await contact.marquerLu(req.params.id, req.body?.lu)));
  pf.get('/reglages-contact', async (_req, res) => res.json(await contact.reglagesContact()));
  pf.put('/reglages-contact', async (req, res) => res.json(await contact.modifierReglagesContact(req.body ?? {})));
  pf.put('/smtp', async (req, res) => res.json(await plateforme.modifierSmtp(req.body ?? {})));
  pf.post('/smtp/test', async (req, res) => res.json(await plateforme.testerSmtpPlateforme(req.body ?? {})));
  pf.put('/entreprises/:id', async (req, res) => res.json(await plateforme.modifier(req.params.id, req.body ?? {})));
  pf.get('/entreprises/:id/manuel', async (req, res) => {
    const { nom, pdf } = await plateforme.telechargerManuel(req.params.id, origineRequete(req));
    res.type('application/pdf').set('Content-Disposition', `inline; filename="${nom}"`).send(pdf);
  });
  pf.post('/entreprises/:id/manuel', async (req, res) => res.json(await plateforme.renvoyerManuel(req.params.id, req.body ?? {}, origineRequete(req), req.admin)));
  pf.post('/entreprises/:id/licence', async (req, res) => res.json(await plateforme.renouvelerLicence(req.params.id, req.body ?? {}, req.admin)));
  pf.post('/entreprises/:id/administrateur', async (req, res) => res.json(await plateforme.administrateur(req.params.id, req.body ?? {}, origineRequete(req))));
  pf.get('/entreprises/:id/utilisateurs', async (req, res) => res.json(await plateforme.utilisateurs(req.params.id)));
  pf.post('/entreprises/:id/utilisateurs/:uid/mot-de-passe', async (req, res) =>
    res.json(await plateforme.reinitialiserMotDePasse(req.params.id, req.params.uid, origineRequete(req))));
  pf.use((_req, res) => res.status(404).json({ erreur: 'Route inconnue' }));
  api.use('/plateforme', pf);

  // ── Routes publiques d'une entreprise : son identifiant est donné (corps ou paramètre « entreprise ») ──
  /** Exécute la suite dans la base de l'entreprise demandée, ou répond 404. */
  const publique = (lire, suite) => async (req, res) => {
    const e = await entrepriseActive(lire(req));
    if (!e) return res.status(404).json({ erreur: 'Identifiant entreprise inconnu ou désactivé', code: 'ENTREPRISE_INCONNUE' });
    req.entreprise = e;
    return dansEntreprise(e, () => suite(req, res, e));
  };
  const parQuery = (req) => req.query.entreprise;

  api.post('/auth/connexion', publique((req) => req.body?.entreprise, async (req, res, e) => {
    const u = await Utilisateur.findOne({ email: String(req.body?.email ?? '').toLowerCase().trim(), actif: true }).select('+motDePasse');
    await verifierAcces(u, req.body?.motDePasse, 'E-mail ou code incorrect');
    // Ancien mot de passe (avant les codes à 4 chiffres) : accepté une dernière fois, puis code à choisir.
    if (!u.mdpProvisoire && !CODE_PIN.test(String(req.body?.motDePasse ?? ''))) {
      u.mdpProvisoire = true;
      await u.save();
    }
    res.json({
      jeton: signer(u, e), entreprise: { code: e.code, nom: e.nom },
      utilisateur: { id: u._id, nom: u.nom, email: u.email, role: u.role, depots: u.depots, doitChangerMdp: u.mdpProvisoire },
    });
  }));

  // Mode démo uniquement (DEMO=1), entreprise de démonstration seulement : comptes proposés en connexion rapide.
  // Sans identifiant : indique l'entreprise de démonstration (bouton « Essayer » de la page de connexion).
  api.get('/auth/demo', async (req, res, next) => {
    if (req.query.entreprise) return next();
    const e = process.env.DEMO === '1' ? await Entreprise.findOne({ parDefaut: true, actif: true }, { code: 1, nom: 1 }).lean() : null;
    res.json(e ? { actif: true, entreprise: { code: e.code, nom: e.nom }, comptes: [] } : { actif: false, comptes: [] });
  });
  api.get('/auth/demo', publique(parQuery, async (_req, res, e) => {
    if (process.env.DEMO !== '1' || !e.parDefaut) return res.json({ actif: false, comptes: [] });
    const comptes = await Utilisateur.find({ actif: true }, { email: 1, nom: 1, role: 1, depots: 1 }).sort({ role: 1, email: 1 }).lean();
    res.json({ actif: true, motDePasse: CODE_DEMO(), comptes });
  }));

  // Nom de l'application (Administration → Paramètres) et de l'entreprise : public, pour la page de connexion
  // (vérifie aussi l'identifiant saisi) et le titre de l'onglet.
  api.get('/marque', publique(parQuery, async (_req, res, e) => {
    const p = await param.parametres();
    res.json({ nomApplication: p.nomApplication || 'Gestion colis', entreprise: { code: e.code, nom: e.nom }, logo: param.urlLogo(e.code, p.logoMaj) });
  }));
  // Logo de l'entreprise (Administration → Paramètres) : public, pour la page de connexion.
  api.get('/logo/:entreprise', publique((req) => req.params.entreprise, async (_req, res) => {
    const l = await param.logo();
    if (!l) return res.status(404).json({ erreur: 'Pas de logo' });
    res.set('Cache-Control', 'public, max-age=86400').type(l.type).send(l.octets);
  }));

  api.use(authentifier);
  // Code-barres numérique (8 chiffres) scanné : remplacé par le numéro du colis, de la palette ou du conteneur,
  // dans l'adresse (:numero, :colis) comme dans le corps (code, numero) — toutes les routes restent inchangées.
  const resoudre = async (v) => {
    const c = String(v ?? '').trim();
    if (!estCodeCourt(c)) return v;
    const modele = { 1: Colis, 2: Palette, 3: Conteneur }[c[0]];
    return (await modele.findOne({ code: c }, { numero: 1 }).lean())?.numero ?? v;
  };
  for (const nom of ['numero', 'colis']) {
    api.param(nom, async (req, _res, next, v) => { try { req.params[nom] = await resoudre(v); next(); } catch (e) { next(e); } });
  }
  api.use(async (req, _res, next) => {
    try {
      for (const k of ['code', 'numero']) if (typeof req.body?.[k] === 'string') req.body[k] = await resoudre(req.body[k]);
      next();
    } catch (e) { next(e); }
  });

  // Le compte client (borne, tablette) ne voit que son formulaire et les listes utiles : aucune donnée de colis.
  const ACCES_CLIENT = ['GET /auth/moi', 'GET /licence', 'PUT /auth/mot-de-passe', 'GET /destinations', 'GET /depots', 'POST /formulaires'];
  api.use((req, _res, next) => next(req.user.role !== CLIENT || ACCES_CLIENT.includes(`${req.method} ${req.path}`) ? undefined : interdit()));
  // Code provisoire : rien d'autre que le choix du code personnel (et les lectures utiles à l'écran).
  const ACCES_PROVISOIRE = ['GET /auth/moi', 'GET /licence', 'PUT /auth/mot-de-passe', 'GET /parametres', 'GET /depots'];
  api.use((req, _res, next) => next(!req.user.doitChangerMdp || ACCES_PROVISOIRE.includes(`${req.method} ${req.path}`)
    ? undefined : new ErreurMetier(403, 'Choisissez d’abord votre code personnel', 'MDP_A_CHANGER')));
  // Jeton d'utilisation expiré : consultation seule. Restent permis : son code, les impressions (réimpressions)
  // et le paramétrage de l'admin (comptes, dépôts, réglages) ; tout le reste (colis, palettes, conteneurs…) est refusé.
  const PERMIS_LECTURE_SEULE = [/^PUT \/auth\/mot-de-passe$/, /^POST \/print\//, /^POST \/contact$/,
    /^(POST|PUT|DELETE) \/(parametres|utilisateurs|depots|destinations|modes-paiement)(\/|$)/];
  api.use((req, _res, next) => {
    if (req.method === 'GET') return next();
    const l = etatLicence(req.entreprise?.licence);
    if (l.etat === 'valide' || l.etat === 'bientot' || PERMIS_LECTURE_SEULE.some((r) => r.test(`${req.method} ${req.path}`))) return next();
    const quand = l.expireLe ? ` le ${new Date(l.expireLe).toLocaleDateString('fr-FR')}` : '';
    next(new ErreurMetier(403, `Jeton d'utilisation expiré${quand} : l'application est en consultation seule. Faites renouveler le jeton pour continuer.`, 'LICENCE_EXPIREE'));
  });
  api.get('/auth/moi', (req, res) => res.json(req.user));
  // État du jeton d'utilisation (bandeau de l'application) ; le jeton lui-même n'est montré qu'à l'admin.
  api.get('/licence', (req, res) => {
    const l = req.entreprise?.licence;
    res.json({ ...etatLicence(l), debut: l?.debut ?? null, ...(req.user.role === ADMIN ? { jeton: l?.jeton ?? null } : {}) });
  });
  // Changement de son propre code : actuel, nouveau et confirmation (4 chiffres).
  api.put('/auth/mot-de-passe', async (req, res) => {
    const u = await Utilisateur.findById(req.user.id).select('+motDePasse');
    await changerAcces(u, req.body, { pin: true });
    res.json({ ok: true });
  });

  // Paramétrage (lecture pour tous : listes déroulantes ; écriture admin)
  for (const ref of ['depots', 'destinations', 'modes-paiement']) {
    api.get(`/${ref}`, async (_req, res) => res.json(await param.lister(ref)));
    api.post(`/${ref}`, exiger(ADMIN), async (req, res) => res.status(201).json(await param.creerRef(req, ref, req.body ?? {})));
    api.put(`/${ref}/:id`, exiger(ADMIN), async (req, res) => res.json(await param.modifierRef(req, ref, req.params.id, req.body ?? {})));
  }
  api.get('/parametres', async (_req, res) => res.json(await param.parametres()));
  api.put('/parametres', exiger(ADMIN), async (req, res) => res.json(await param.modifierParametres(req, req.body ?? {})));
  // Contact : message vers l'administrateur de la plateforme (permis même jeton expiré, pour demander le renouvellement)
  api.get('/contact/editeur', async (_req, res) => res.json((await contact.reglagesContact()).editeur));
  api.get('/contact', async (req, res) => res.json(await contact.messagesEntreprise(req)));
  api.post('/contact', async (req, res) => res.status(201).json(await contact.envoyerMessage(req, req.body ?? {}, origineRequete(req))));
  api.put('/parametres/logo', exiger(ADMIN), async (req, res) => res.json(await param.modifierLogo(req, req.body ?? {})));
  api.get('/utilisateurs', exiger(ADMIN), async (_req, res) => res.json(await param.listeUtilisateurs()));
  api.post('/utilisateurs', exiger(ADMIN), async (req, res) => res.status(201).json(await param.creerUtilisateur(req, req.body ?? {})));
  api.put('/utilisateurs/:id', exiger(ADMIN), async (req, res) => res.json(await param.modifierUtilisateur(req, req.params.id, req.body ?? {})));
  api.post('/utilisateurs/:id/reinitialiser-code', exiger(ADMIN), async (req, res) => res.json(await param.reinitialiserCode(req, req.params.id)));

  // Étape 1 — réception
  api.get('/clients', async (req, res) => res.json(await colis.clientParTelephone(req.query.tel)));
  api.post('/colis', terrain(RECEPTION), async (req, res) => res.status(201).json(await colis.receptionner(req, req.body ?? {})));
  // Formulaires clients : saisis par le client (borne) ou depuis l'onglet ouvert par la réception
  api.post('/formulaires', terrain(CLIENT, RECEPTION), async (req, res) => res.status(201).json(await formulaires.creer(req, req.body ?? {})));
  api.get('/formulaires', terrain(RECEPTION), async (req, res) => res.json(await formulaires.liste(req, req.query)));
  api.delete('/formulaires/:id', terrain(RECEPTION), async (req, res) => res.json(await formulaires.annuler(req, req.params.id)));
  api.post('/envois', terrain(RECEPTION), async (req, res) => res.status(201).json(await colis.receptionnerEnvoi(req, req.body ?? {})));
  api.get('/envois/:numero', async (req, res) => res.json(await colis.envoi(req, req.params.numero)));
  api.get('/colis', async (req, res) => res.json(await colis.liste(req, req.query)));
  api.get('/colis/:numero', async (req, res) => res.json(await colis.fiche(req, req.params.numero)));
  api.post('/colis/:numero/paiement', exiger(RECEPTION, CHEF_QUAI), async (req, res) => res.json(await colis.payer(req, req.params.numero, req.body ?? {})));
  api.post('/colis/:numero/annuler', exiger(RECEPTION, CHEF_QUAI), async (req, res) => res.json(await colis.annuler(req, req.params.numero, req.body ?? {})));

  // Étape 2 — palettisation
  api.post('/palettes', terrain(CARISTE, CHEF_QUAI), async (req, res) => res.status(201).json(await palettes.creer(req, req.body ?? {})));
  api.get('/palettes', async (req, res) => res.json(await palettes.liste(req, req.query)));
  api.get('/palettes/file-zone-depart', async (req, res) => res.json(await palettes.fileZoneDepart(req, req.query.destination)));
  api.get('/palettes/:numero', async (req, res) => res.json(await palettes.detail(req, req.params.numero)));
  api.post('/palettes/:numero/colis', terrain(CARISTE, CHEF_QUAI), async (req, res) =>
    res.json(await palettes.ajouterColis(req, req.params.numero, req.body ?? {})));
  api.delete('/palettes/:numero/colis/:colis', terrain(CARISTE, CHEF_QUAI), async (req, res) =>
    res.json(await palettes.retirerColis(req, req.params.numero, req.params.colis, req.body ?? {})));
  api.delete('/palettes/:numero', terrain(CARISTE, CHEF_QUAI), async (req, res) => res.json(await palettes.supprimer(req, req.params.numero)));
  api.post('/palettes/:numero/fermer', terrain(CARISTE, CHEF_QUAI), async (req, res) => res.json(await palettes.fermer(req, req.params.numero)));
  api.post('/palettes/:numero/rouvrir', terrain(CARISTE, CHEF_QUAI), async (req, res) => res.json(await palettes.rouvrir(req, req.params.numero, req.body ?? {})));

  // Étape 3 — zone de départ et chargement
  api.post('/colis/:numero/zone-depart', terrain(CHEF_QUAI), async (req, res) => res.json(await colis.versZoneDepart(req, req.params.numero)));
  api.post('/colis/:numero/hors-zone-depart', terrain(CHEF_QUAI), async (req, res) => res.json(await colis.horsZoneDepart(req, req.params.numero, req.body ?? {})));
  api.post('/palettes/:numero/zone-depart', terrain(CHEF_QUAI), async (req, res) => res.json(await palettes.versZoneDepart(req, req.params.numero)));
  api.post('/palettes/:numero/hors-zone-depart', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await palettes.horsZoneDepart(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs', terrain(CHEF_QUAI), async (req, res) => res.status(201).json(await conteneurs.creer(req, req.body ?? {})));
  api.get('/conteneurs', async (req, res) => res.json(await conteneurs.liste(req, req.query)));
  api.get('/conteneurs/:numero', async (req, res) => res.json(await conteneurs.detail(req, req.params.numero)));
  api.post('/conteneurs/:numero/palettes', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await conteneurs.scanner(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs/:numero/retours', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await conteneurs.retour(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs/:numero/retirer', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await conteneurs.retirer(req, req.params.numero, req.body ?? {})));
  api.get('/conteneurs/:numero/recap', async (req, res) => res.json(await conteneurs.recap(req, req.params.numero)));
  api.post('/conteneurs/:numero/valider', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await conteneurs.valider(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs/:numero/annuler-validation', terrain(ADMIN), async (req, res) =>
    res.json(await conteneurs.annulerValidation(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs/:numero/partir', terrain(CHEF_QUAI), async (req, res) =>
    res.json(await conteneurs.partir(req, req.params.numero, req.body ?? {})));
  api.post('/conteneurs/:numero/arriver', exiger(ADMIN), async (req, res) => res.json(await conteneurs.arriver(req, req.params.numero)));

  // Impression et suivi
  api.get('/print/manifeste/:numero', async (req, res) => res.json(await conteneurs.detail(req, req.params.numero)));
  const typeEtiquette = (req, _res, next) => next(['colis', 'palette'].includes(req.params.type) ? undefined : 'route');
  api.get('/print/:type/:numero', typeEtiquette, async (req, res) =>
    res.type('text/plain').send(await impression.zpl(req, req.params.type, req.params.numero)));
  api.post('/print/:type/:numero', typeEtiquette, async (req, res) =>
    res.json(await impression.imprimer(req, req.params.type, req.params.numero, req.body ?? {})));
  api.get('/evenements', async (req, res) => res.json(await param.evenements(req, req.query)));
  api.get('/tableau-de-bord', async (req, res) => res.json(await param.tableauDeBord(req)));
  // Offres : clients abonnés, codes promo, envoi d'une offre (liste de diffusion)
  api.get('/codes-promo/verifier', exiger(RECEPTION), async (req, res) => res.json(await offres.verifierCode(req.query.code)));
  api.get('/clients-offres', exiger(ADMIN), async (req, res) => res.json(await offres.clients(req.query)));
  api.put('/clients-offres/:id', exiger(ADMIN), async (req, res) => res.json(await offres.modifierClient(req, req.params.id, req.body ?? {})));
  api.delete('/clients-offres/:id', exiger(ADMIN), async (req, res) => res.json(await offres.supprimerClient(req.params.id)));
  api.get('/codes-promo', exiger(ADMIN), async (_req, res) => res.json(await offres.codesPromo()));
  api.post('/codes-promo', exiger(ADMIN), async (req, res) => res.status(201).json(await offres.creerCode(req, req.body ?? {})));
  api.put('/codes-promo/:id', exiger(ADMIN), async (req, res) => res.json(await offres.modifierCode(req, req.params.id, req.body ?? {})));
  api.get('/campagnes', exiger(ADMIN), async (_req, res) => res.json(await offres.campagnes()));
  api.post('/campagnes', exiger(ADMIN), async (req, res) => res.json(await offres.envoyerCampagne(req, req.body ?? {}, origineRequete(req))));
  // Export détaillé des colis (avec palette et conteneur) : CSV, Excel, PDF
  api.get('/export/colis/apercu', exiger(ADMIN), async (req, res) => res.json(await exporter.apercu(req, req.query)));
  api.get('/export/colis', exiger(ADMIN), async (req, res) => {
    const f = await exporter.fichier(req, req.query);
    res.type(f.type).set('Content-Disposition', `attachment; filename="${f.nom}"`).send(f.contenu);
  });
  api.get('/statistiques', exiger(ADMIN), async (req, res) => res.json(await stats.statistiques(req, req.query)));

  api.use((_req, res) => res.status(404).json({ erreur: 'Route inconnue' }));
  app.use('/api', api);

  // Désinscription des offres (lien en bas de chaque e-mail d'offre)
  app.get('/desinscription/:entreprise/:id/:jeton', async (req, res) => {
    const e = await entrepriseActive(req.params.entreprise);
    const c = e ? await dansEntreprise(e, () => offres.desinscrire(e.code, req.params.id, req.params.jeton)) : null;
    const corps = c ? `<h1>Désinscription confirmée</h1><p>${echapper(c.email)} ne recevra plus nos offres.</p>`
      : '<h1>Lien invalide</h1><p>Ce lien de désinscription n\'est pas valide ou a expiré.</p>';
    res.status(c ? 200 : 404).send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Désinscription</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1d2330}</style></head><body>${corps}</body></html>`);
  });

  // Page publique du QR palette : https://<domaine>/p/<entreprise>.<dépôt>/<numéro>
  // (ancienne forme /p/<dépôt>/<numéro> : entreprise par défaut, celle des données d'avant le multi-entreprise).
  app.get('/p/:depot/:numero', async (req, res) => {
    const [code, depot] = req.params.depot.includes('.') ? req.params.depot.split('.', 2) : [null, req.params.depot];
    const e = code ? await entrepriseActive(code) : await Entreprise.findOne({ parDefaut: true, actif: true }, { code: 1, nom: 1, base: 1 }).lean();
    if (!e) return res.status(404).send('Palette inconnue');
    await dansEntreprise({ code: e.code, nom: e.nom, base: e.base }, () => pagePalette(depot, req.params.numero, res));
  });
  async function pagePalette(depot, numero, res) {
    const r = await palettes.pagePublique(depot, numero);
    if (!r) return res.status(404).send('Palette inconnue');
    const { palette: p, colis: liste } = r;
    const marque = (await param.parametres()).nomApplication || 'Gestion colis';
    res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Palette ${echapper(p.numero)} · ${echapper(marque)}</title><style>body{font-family:system-ui,sans-serif;margin:16px;max-width:640px}
table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}</style></head><body>
<p style="color:#677085;margin:0">${echapper(marque)}</p><h1 style="margin-top:4px">Palette ${echapper(p.numero)}</h1><p>Dépôt ${echapper(p.depot)} · destination ${echapper(p.destination)} · ${echapper(p.statut)}
· ${p.nbColis} colis · ${p.poidsTotal} kg</p>
<table><tr><th>Colis</th><th>Pièces</th><th>Poids</th><th>Statut</th></tr>
${liste.map((c) => `<tr><td>${echapper(c.numero)}</td><td>${c.nbPieces}</td><td>${c.poidsKg} kg</td><td>${echapper(c.statut)}</td></tr>`).join('')}
</table><p><small>Liste à jour au ${new Date().toLocaleString('fr-FR')}</small></p></body></html>`);
  }

  // Front Angular compilé (production) : web/dist/web/browser, ou le dossier indiqué par DOSSIER_WEB
  const front = process.env.DOSSIER_WEB
    ? path.resolve(process.env.DOSSIER_WEB)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist/web/browser');
  if (fs.existsSync(path.join(front, 'index.html'))) {
    app.use(express.static(front));
    app.get('/{*chemin}', (_req, res) => res.sendFile(path.join(front, 'index.html')));
    if (!process.env.NODE_TEST_CONTEXT) console.log(`Écran servi depuis ${front}`);
  } else {
    // Sans build : seule l'API répond (« Cannot GET /connexion »). Le chemin attendu est affiché pour corriger.
    if (!process.env.NODE_TEST_CONTEXT) console.warn(`⚠ Écran compilé introuvable : ${path.join(front, 'index.html')} — compilez web/ (npm run build) ou réglez DOSSIER_WEB, puis redémarrez.`);
    app.get('/', (_req, res) => res.status(503).type('text/plain; charset=utf-8')
      .send(`Écran compilé introuvable sur le serveur.
Attendu : ${path.join(front, 'index.html')}
Compilez web/ (npm run build) ou réglez DOSSIER_WEB dans api/.env, puis redémarrez l'application.`));
  }

  app.use((err, _req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ erreur: err.message, code: err.code, donnees: err.donnees });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'JSON invalide' });
    console.error(err);
    res.status(500).json({ erreur: 'Erreur interne' });
  });
  return app;
}
