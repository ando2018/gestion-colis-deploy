import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  Colis, COLIS, Conteneur, CONTENEUR, Depot, Message, Destination, Evenement, ModePaiement, Palette, PALETTE, Parametres, ROLES, Utilisateur,
} from '../modeles.js';
import { conflit, filtreDepot, introuvable, journaliser, requete, texte } from '../noyau.js';
import { codeProvisoire, poserCodeProvisoire } from '../acces.js';
import { envoyerCodeProvisoire, normaliserSmtp, origineRequete, testerSmtp, vueSmtp } from '../courriel.js';

/** Champs modifiables par référentiel (les autres sont ignorés). */
const REFERENTIELS = {
  depots: { modele: Depot, champs: ['code', 'nom', 'adresse', 'prefixe', 'imprimante', 'actif'] },
  destinations: { modele: Destination, champs: ['code', 'pays', 'ville', 'tarifKg', 'delaiJours', 'actif'] },
  'modes-paiement': { modele: ModePaiement, champs: ['code', 'libelle', 'depotsAutorises', 'actif'] },
};

const garder = (b, champs) => Object.fromEntries(champs.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));

/** Libellés des champs, pour des messages d'erreur compréhensibles. */
const LIBELLES = {
  code: 'Code', nom: 'Nom', adresse: 'Adresse', pays: 'Pays', ville: 'Ville', tarifKg: 'Tarif €/kg', delaiJours: 'Délai (jours)',
  libelle: 'Libellé', 'imprimante.hote': 'Imprimante (IP)', 'imprimante.port': 'Port', 'imprimante.dpi': 'DPI',
  'imprimante.largeurMm': 'Largeur d’étiquette', 'imprimante.hauteurMm': 'Hauteur d’étiquette', 'imprimante.type': 'Type d’imprimante', 'imprimante.largeurPapier': 'Largeur du rouleau', 'imprimante.etiquettesParPage': 'Étiquettes par feuille A4',
  // chemins courts renvoyés pour le sous-document « imprimante »
  hote: 'Imprimante (IP)', port: 'Port', dpi: 'DPI', largeurMm: 'Largeur d’étiquette', hauteurMm: 'Hauteur d’étiquette',
};
const libelleChamp = (chemin) => LIBELLES[chemin] ?? chemin;

function messageChamp(err) {
  const champ = `« ${libelleChamp(err.path)} »`;
  switch (err.kind) {
    case 'required': return `${champ} est obligatoire`;
    case 'min': return `${champ} doit valoir au moins ${err.properties?.min}`;
    case 'max': return `${champ} doit valoir au plus ${err.properties?.max}`;
    case 'enum': return `${champ} doit être l’une de ces valeurs : ${err.properties?.enumValues?.join(', ')}`;
    case 'Number': return `${champ} doit être un nombre`;
    default: return `${champ} est invalide`;
  }
}

function traduire(e) {
  if (e.code === 11000) return conflit(`« ${Object.values(e.keyValue ?? {}).join(', ')} » est déjà utilisé`);
  if (e instanceof mongoose.Error.ValidationError) return requete(Object.values(e.errors).map(messageChamp).join(' · '));
  if (e instanceof mongoose.Error.CastError) return requete(messageChamp({ ...e, kind: e.kind ?? 'Number' }));
  return e;
}

/** Dépôts : un port ou un DPI effacé reprend sa valeur par défaut (sinon les étiquettes seraient fausses). */
function normaliser(ref, donnees) {
  if (ref === 'destinations' && ['PAL', 'CTN', 'COL'].includes(texte(donnees.code).toUpperCase())) {
    throw requete('Les codes PAL, CTN et COL sont réservés aux numéros de palette, de conteneur et de colis');
  }
  if (ref === 'destinations' && donnees.code !== undefined && !/^[A-Za-z]{2,6}$/.test(texte(donnees.code))) {
    throw requete('Le code de destination doit contenir de 2 à 6 lettres (ex. ABJ)');
  }
  if (ref !== 'depots' || !donnees.imprimante) return donnees;
  const vide = (v) => v === null || v === undefined || v === '';
  const imp = { ...donnees.imprimante };
  if (vide(imp.port)) imp.port = 9100;
  if (vide(imp.dpi)) imp.dpi = 203;
  if (vide(imp.largeurMm)) imp.largeurMm = 100;
  if (vide(imp.hauteurMm)) imp.hauteurMm = 150;
  if (vide(imp.type)) imp.type = 'ZEBRA';
  if (vide(imp.largeurPapier)) imp.largeurPapier = 80;
  if (vide(imp.etiquettesParPage)) imp.etiquettesParPage = 4;
  imp.hote = texte(imp.hote);
  return { ...donnees, imprimante: imp };
}

export const lister = (ref) => REFERENTIELS[ref].modele.find().sort({ code: 1 }).lean();

export async function creerRef(req, ref, b) {
  const { modele, champs } = REFERENTIELS[ref];
  try {
    const doc = await modele.create(normaliser(ref, garder(b, champs)));
    await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `${ref}:${doc.code}`, apres: doc.toObject() });
    return doc.toObject();
  } catch (e) {
    throw traduire(e);
  }
}

export async function modifierRef(req, ref, id, b) {
  const { modele, champs } = REFERENTIELS[ref];
  if (!mongoose.isValidObjectId(id)) throw introuvable('Élément introuvable');
  try {
    const avant = await modele.findById(id).lean();
    if (!avant) throw introuvable('Élément introuvable');
    const maj = normaliser(ref, garder(b, champs.filter((c) => c !== 'code')));
    const apres = await modele.findByIdAndUpdate(id, { $set: maj }, { returnDocument: 'after', runValidators: true }).lean();
    await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `${ref}:${avant.code}`, avant, apres });
    return apres;
  } catch (e) {
    throw traduire(e);
  }
}

export async function parametres() {
  // Mot de passe SMTP lu pour savoir s'il est enregistré, puis retiré (vueSmtp).
  const p = (await Parametres.findById('general').select('+smtp.motDePasse').lean()) ?? (await Parametres.create({ _id: 'general' })).toObject();
  return { ...p, smtp: vueSmtp(p.smtp) };
}

/** SMTP de l'entreprise : mot de passe gardé s'il n'est pas ressaisi. */
export async function modifierSmtp(req, b) {
  const ancien = (await Parametres.findById('general').select('+smtp.motDePasse').lean())?.smtp ?? {};
  const smtp = normaliserSmtp(b, ancien);
  await Parametres.updateOne({ _id: 'general' }, { $set: { smtp } }, { upsert: true });
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: 'smtp', details: { ...vueSmtp(smtp) } });
  return vueSmtp(smtp);
}

/** E-mail de test avec les réglages saisis (mot de passe enregistré si non ressaisi). */
export async function testerSmtpEntreprise(req, b) {
  const p = await Parametres.findById('general').select('+smtp.motDePasse').lean();
  const smtp = normaliserSmtp({ ...b?.smtp, actif: true }, p?.smtp ?? {});
  return testerSmtp(smtp, b?.a, p?.nomApplication || 'Gestion colis', req.user.nom);
}

// ───────────── Messages envoyés ─────────────

const echapperRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** E-mails envoyés (plus récents d'abord), filtrés par recherche (destinataire, objet), motif ou statut ; sans le HTML. */
export async function messages(q) {
  const filtre = {};
  const t = texte(q?.q);
  if (t) {
    const r = new RegExp(echapperRegex(t), 'i');
    filtre.$or = [{ a: r }, { sujet: r }, { destinataireNom: r }];
  }
  if (['creation', 'reinitialisation', 'test'].includes(q?.motif)) filtre.motif = q.motif;
  if (q?.statut === 'envoye') filtre.envoye = true;
  if (q?.statut === 'echec') filtre.envoye = false;
  const limite = Math.min(500, Math.max(1, Number(q?.limite) || 200));
  const [liste, total] = await Promise.all([
    Message.find(filtre, { html: 0 }).sort({ date: -1 }).limit(limite).lean(),
    Message.countDocuments(filtre),
  ]);
  return { total, messages: liste };
}

export async function message(id) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Message introuvable');
  const m = await Message.findById(id).lean();
  if (!m) throw introuvable('Message introuvable');
  return m;
}

export async function modifierParametres(req, b) {
  const champs = ['paletteMaxKg', 'typesConteneur', 'reliquatAlerteReports', 'reliquatAlerteJours', 'bloquerPartielAuChargement', 'urlPublique', 'typeCode', 'nomApplication'];
  const avant = await parametres();
  const apres = await Parametres.findByIdAndUpdate('general', { $set: garder(b, champs) }, { returnDocument: 'after', upsert: true, runValidators: true }).lean();
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: 'parametres', avant, apres });
  return apres;
}

// ───────────── Logo de l'entreprise ─────────────

const LOGO = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const LOGO_MAX = 400 * 1024;

/** Image du logo (type et octets), ou null. */
export async function logo() {
  const p = await Parametres.findById('general').select('+logo').lean();
  const m = p?.logo?.match(LOGO);
  return m ? { type: `image/${m[1]}`, octets: Buffer.from(m[2], 'base64'), maj: p.logoMaj } : null;
}

/** Remplace (image PNG, JPEG ou WebP en data URL, 400 Ko au plus) ou retire (image vide) le logo. */
export async function modifierLogo(req, b) {
  const image = texte(b?.image);
  if (image) {
    const m = image.match(LOGO);
    if (!m) throw requete('Logo : image PNG, JPEG ou WebP attendue');
    if (Buffer.byteLength(m[2], 'base64') > LOGO_MAX) throw requete('Logo trop lourd (400 Ko au plus)');
  }
  const logoMaj = image ? new Date() : null;
  await Parametres.updateOne({ _id: 'general' }, { $set: { logo: image, logoMaj } }, { upsert: true });
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: 'logo', details: { logo: image ? 'remplacé' : 'retiré' } });
  return { logoMaj };
}

/** Adresse publique du logo de l'entreprise (versionnée pour le cache), ou null. */
export const urlLogo = (code, maj) => (maj ? `/api/logo/${code}?v=${new Date(maj).getTime()}` : null);

// ───────────── Utilisateurs ─────────────

export const listeUtilisateurs = () => Utilisateur.find().sort({ nom: 1 }).lean();

async function verifierDepots(role, depots) {
  if (role === ROLES.ADMIN) return [];
  const codes = [...new Set((depots ?? []).map((d) => texte(d).toUpperCase()).filter(Boolean))];
  if (!codes.length) throw requete('Au moins un dépôt autorisé');
  const n = await Depot.countDocuments({ code: { $in: codes } });
  if (n !== codes.length) throw requete('Dépôt inconnu dans la liste');
  return codes;
}

/** Nouveau compte avec un code provisoire à 4 chiffres (renvoyé une seule fois), à changer à la première connexion. */
export async function creerUtilisateur(req, b) {
  if (!Object.values(ROLES).includes(b.role)) throw requete('Rôle inconnu');
  try {
    const code = codeProvisoire();
    const u = await Utilisateur.create({
      email: b.email, nom: b.nom, role: b.role, depots: await verifierDepots(b.role, b.depots),
      motDePasse: await bcrypt.hash(code, 10), mdpProvisoire: true,
    });
    const { motDePasse, ...publie } = u.toObject();
    await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `utilisateur:${u.email}`, apres: { ...publie } });
    const mail = await envoyerCodeProvisoire({ email: u.email, nom: u.nom, code, motif: 'creation', origine: origineRequete(req), par: req.user.nom });
    return { ...publie, codeProvisoire: code, mail };
  } catch (e) {
    throw traduire(e);
  }
}

/** Réinitialisation par l'admin : nouveau code provisoire (renvoyé une seule fois), compte débloqué. */
export async function reinitialiserCode(req, id) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Utilisateur introuvable');
  const u = await Utilisateur.findById(id).select('+motDePasse');
  if (!u) throw introuvable('Utilisateur introuvable');
  const code = await poserCodeProvisoire(u);
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `utilisateur:${u.email}`, details: { code: 'réinitialisé (provisoire)' } });
  const mail = await envoyerCodeProvisoire({ email: u.email, nom: u.nom, code, motif: 'reinitialisation', origine: origineRequete(req), par: req.user.nom });
  return { email: u.email, nom: u.nom, codeProvisoire: code, mail };
}

export async function modifierUtilisateur(req, id, b) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Utilisateur introuvable');
  const u = await Utilisateur.findById(id);
  if (!u) throw introuvable('Utilisateur introuvable');
  const soi = u._id.equals(req.user.id);
  if (soi && (b.actif === false || (b.role && b.role !== ROLES.ADMIN))) throw requete('Vous ne pouvez pas désactiver ou rétrograder votre propre compte');
  // Un administrateur reste toujours actif (pas d'entreprise sans administrateur par erreur).
  if (b.actif === false && (b.role ?? u.role) === ROLES.ADMIN) throw requete('Un compte administrateur ne peut pas être désactivé', 'ADMIN_ACTIF');
  if (b.nom !== undefined) u.nom = b.nom;
  if (b.actif !== undefined) u.actif = Boolean(b.actif);
  if (b.role !== undefined) {
    if (!Object.values(ROLES).includes(b.role)) throw requete('Rôle inconnu');
    u.role = b.role;
  }
  if (b.role !== undefined || b.depots !== undefined) u.depots = await verifierDepots(u.role, b.depots ?? u.depots);
  // Le code ne se modifie plus ici : réinitialisation (code provisoire) ou changement par le titulaire.
  await u.save();
  const { motDePasse, ...publie } = u.toObject();
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `utilisateur:${u.email}`, apres: { ...publie } });
  return publie;
}

// ───────────── Tableau de bord ─────────────

export async function tableauDeBord(req) {
  const f = filtreDepot(req);
  const params = await parametres();
  const limite = new Date(Date.now() - params.reliquatAlerteJours * 86400000);
  const compter = (modele) => modele.aggregate([{ $match: f }, { $group: { _id: '$statut', n: { $sum: 1 } } }])
    .then((l) => Object.fromEntries(l.map((x) => [x._id, x.n])));
  const [colis, palettes, conteneurs, alertes, enChargement, evenements] = await Promise.all([
    compter(Colis),
    compter(Palette),
    compter(Conteneur),
    Colis.find({
      ...f,
      statut: { $in: [COLIS.RELIQUAT, COLIS.SUR_PALETTE, COLIS.ZONE_DEPART, COLIS.RECU] },
      $or: [{ nbReports: { $gte: params.reliquatAlerteReports } }, { priorite: { $gt: 0 }, dateReception: { $lt: limite } }],
    }).sort({ nbReports: -1, dateReception: 1 }).limit(100).lean(),
    Conteneur.find({ ...f, statut: CONTENEUR.EN_CHARGEMENT }).lean(),
    Evenement.find(f).sort({ date: -1 }).limit(40).lean(),
  ]);
  // Palettes en zone de départ pas encore prévues dans un conteneur, et nombre de colis dessus.
  const [zone] = await Palette.aggregate([
    { $match: { ...f, statut: PALETTE.ZONE_DEPART, conteneurId: null } },
    { $group: { _id: null, palettes: { $sum: 1 }, colis: { $sum: '$nbColis' } } },
  ]);
  const colisSeulsEnZone = await Colis.countDocuments({ ...f, statut: COLIS.ZONE_DEPART, paletteId: null, conteneurId: null });
  // Colis prévus dans les conteneurs encore en chargement.
  const colisEnChargement = await Colis.countDocuments({ ...f, conteneurId: { $in: enChargement.map((c) => c._id) } });
  return {
    colis, palettes, conteneurs, palettesEnZoneLibres: zone?.palettes ?? 0, colisEnZoneLibres: (zone?.colis ?? 0) + colisSeulsEnZone, colisSeulsEnZone, colisEnChargement, alertesReliquats: alertes, conteneursEnChargement: enChargement, evenements };
}

export function evenements(req, q) {
  const filtre = {};
  if (q.entiteId && mongoose.isValidObjectId(q.entiteId)) filtre.entiteId = q.entiteId;
  if (q.numero) filtre.numero = String(q.numero).toUpperCase();
  if (q.type) filtre.type = q.type;
  Object.assign(filtre, filtreDepot(req));
  return Evenement.find(filtre).sort({ date: -1 }).limit(Math.min(Number(q.limite) || 200, 1000)).lean();
}
