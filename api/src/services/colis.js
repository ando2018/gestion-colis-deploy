import { Colis, COLIS, Destination, Evenement, MODE_A_DESTINATION, ModePaiement, PAIEMENT } from '../modeles.js';
import {
  codeCourt, codeScanne, jjmmaa, conflit, evtColis, filtreDepot, introuvable, journaliser, pad, prochain, r2, requete, texte, transaction,
} from '../noyau.js';
import * as formulaires from './formulaires.js';
import { retirerDePalette } from './palettes.js';

export const statutPaiement = (montant, recu, mode) => {
  if (recu >= montant - 0.005) return PAIEMENT.PAYE;
  if (mode === MODE_A_DESTINATION && recu <= 0) return PAIEMENT.A_DESTINATION;
  return PAIEMENT.PARTIEL;
};

/** Libellé de mode quand un colis a été réglé par plusieurs moyens (carte + espèces…). */
export const MODE_MIXTE = 'MIXTE';

/**
 * Paiements de l'envoi : une liste [{ mode, montant, reference }] (ex. 100 € carte + 80 € espèces),
 * ou l'ancien format { mode, recu, reference }. « Paiement à destination » ne se combine pas.
 */
async function preparerPaiements(b, total, depot) {
  if (Array.isArray(b.paiements) && b.paiements.length) {
    const lignes = [];
    for (const [i, p] of b.paiements.entries()) {
      const mode = await verifierMode(p.mode, depot);
      if (mode.code === MODE_A_DESTINATION) {
        if (b.paiements.length > 1) throw requete('Le paiement à destination ne se combine pas avec un autre moyen');
        return { aDestination: true, lignes: [] };
      }
      const montant = r2(p.montant);
      if (!(montant > 0)) throw requete(`Paiement ${i + 1} (${mode.libelle}) : montant obligatoire`);
      lignes.push({ mode: mode.code, montant, reference: texte(p.reference) });
    }
    const somme = r2(lignes.reduce((s, l) => s + l.montant, 0));
    if (somme > total + 0.005) throw requete(`Paiements (${somme}) supérieurs au total de l'envoi (${total})`, 'TROP_PERCU');
    return { aDestination: false, lignes };
  }
  const mode = await verifierMode(b.paiement?.mode, depot);
  if (mode.code === MODE_A_DESTINATION) return { aDestination: true, lignes: [] };
  const montant = r2(b.paiement?.recu ?? total);
  if (montant < 0 || montant > total + 0.005) throw requete(`Montant reçu invalide (total de l'envoi : ${total})`);
  return { aDestination: false, lignes: montant > 0 ? [{ mode: mode.code, montant, reference: texte(b.paiement?.reference) }] : [], modeSeul: mode.code };
}

const modeDe = (versements, defaut) => {
  const modes = [...new Set(versements.map((v) => v.mode))];
  return modes.length > 1 ? MODE_MIXTE : (modes[0] ?? defaut);
};

async function verifierMode(code, depot) {
  const mode = await ModePaiement.findOne({ code: texte(code).toUpperCase(), actif: true }).lean();
  if (!mode) throw requete(`Mode de paiement ${code || '(vide)'} inconnu ou inactif`);
  if (mode.depotsAutorises.length && !mode.depotsAutorises.includes(depot)) {
    throw requete(`Mode de paiement ${mode.libelle} non autorisé au dépôt ${depot}`);
  }
  return mode;
}

/**
 * Étape 1 — réception d'un envoi : un expéditeur, un destinataire, une destination et un ou plusieurs colis
 * (C1, C2…). Chaque colis a son numéro, son poids, son montant et son étiquette ; ils partagent le numéro d'envoi
 * (celui du premier colis). Le montant reçu est réparti sur les colis dans l'ordre.
 */
export async function receptionnerEnvoi(req, b) {
  const depot = req.depot;
  const destination = await Destination.findOne({ code: texte(b.destination).toUpperCase(), actif: true }).lean();
  if (!destination) throw requete('Destination inconnue ou inactive');
  if (!texte(b.expediteur?.nom) || !texte(b.expediteur?.tel)) throw requete('Nom et téléphone de l\'expéditeur obligatoires');
  if (!texte(b.destinataire?.nom) || !texte(b.destinataire?.tel)) throw requete('Nom et téléphone du destinataire obligatoires');

  const lignes = Array.isArray(b.colis) && b.colis.length ? b.colis : [b];
  if (lignes.length > 50) throw requete('50 colis maximum par envoi');
  const options = (b.options ?? []).filter((o) => texte(o.libelle)).map((o) => ({ libelle: texte(o.libelle), montant: r2(o.montant) }));
  const motifMontant = texte(b.motifMontant);

  const colisPrepares = lignes.map((l, i) => {
    const poidsKg = r2(l.poidsKg);
    if (!(poidsKg > 0)) throw requete(`Colis ${i + 1} : poids (kg) obligatoire`);
    // Les options de l'envoi (emballage, assurance…) sont portées par le premier colis.
    const opts = i === 0 ? options : [];
    const montantCalcule = r2(poidsKg * destination.tarifKg + opts.reduce((s, o) => s + o.montant, 0));
    const montant = l.montant == null || l.montant === '' ? montantCalcule : r2(l.montant);
    if (montant !== montantCalcule && !motifMontant) {
      throw requete(`Colis ${i + 1} : montant modifié (${montantCalcule} → ${montant}), motif obligatoire`, 'MOTIF_REQUIS');
    }
    return {
      // Sans description saisie : « Colis 1 », « Colis 2 »… (seul le poids est à remplir)
      description: texte(l.description) || `Colis ${i + 1}`,
      nbPieces: Math.max(1, parseInt(l.nbPieces, 10) || 1),
      poidsKg,
      dimensions: texte(l.dimensions),
      valeurDeclaree: r2(l.valeurDeclaree),
      options: opts,
      montantCalcule,
      montant,
      motifMontant: montant !== montantCalcule ? motifMontant : '',
    };
  });

  const total = r2(colisPrepares.reduce((s, c) => s + c.montant, 0));
  const paiements = await preparerPaiements(b, total, depot.code);
  const recuTotal = r2(paiements.lignes.reduce((s, l) => s + l.montant, 0));
  const modeEnvoi = paiements.aDestination ? MODE_A_DESTINATION : modeDe(paiements.lignes, paiements.modeSeul ?? 'ESPECES');
  // File des paiements à répartir : C1 est soldé en premier, puis C2…
  const file = paiements.lignes.map((l) => ({ ...l }));

  return transaction(async (session) => {
    const jour = jjmmaa();
    let envoi = null;
    const crees = [];
    for (const c of colisPrepares) {
      // Numéro = COL + destination + date JJMMAA + séquence (ex. COL-ABJ-121026-0003), comme PAL-… et CTN-….
      // Le compteur est commun à tous les dépôts pour une destination et un jour : jamais deux fois le même numéro.
      const numero = `COL-${destination.code}-${jour}-${pad(await prochain(`colis-${destination.code}-${jour}`, session))}`;
      envoi ??= numero;
      const versements = [];
      let du = c.montant;
      while (du > 0.005 && file.length) {
        const p = file[0];
        const part = r2(Math.min(du, p.montant));
        versements.push({ mode: p.mode, montant: part, reference: p.reference, date: new Date(), par: req.user.nom });
        du = r2(du - part);
        p.montant = r2(p.montant - part);
        if (p.montant <= 0.005) file.shift();
      }
      const recu = r2(versements.reduce((s, v) => s + v.montant, 0));
      const [colis] = await Colis.create([{
        ...c,
        numero,
        code: await codeCourt('colis', session),
        envoi,
        rangEnvoi: crees.length + 1,
        nbEnvoi: colisPrepares.length,
        depot: depot.code,
        destination: destination.code,
        expediteur: { nom: texte(b.expediteur.nom), tel: texte(b.expediteur.tel), pieceIdentite: texte(b.expediteur.pieceIdentite) },
        destinataire: { nom: texte(b.destinataire.nom), tel: texte(b.destinataire.tel), adresse: texte(b.destinataire.adresse) },
        paiement: {
          mode: modeDe(versements, modeEnvoi),
          statut: statutPaiement(c.montant, recu, modeEnvoi),
          recu,
          reference: [...new Set(versements.map((v) => v.reference).filter(Boolean))].join(', '),
          versements,
        },
      }], { session });

      const details = { envoi, rang: `${crees.length + 1}/${colisPrepares.length}` };
      await journaliser(req, session, 'RECEPTION', evtColis(colis, { apres: { statut: COLIS.RECU, destination: destination.code, poidsKg: c.poidsKg, montant: c.montant }, details }));
      if (c.montant !== c.montantCalcule) {
        await journaliser(req, session, 'MODIFICATION_MONTANT', evtColis(colis, { avant: c.montantCalcule, apres: c.montant, motif: motifMontant }));
      }
      await journaliser(req, session, 'PAIEMENT', evtColis(colis, {
        apres: colis.paiement.statut,
        details: { mode: colis.paiement.mode, montant: recu, ...(versements.length > 1 ? { detail: versements.map((v) => `${v.mode} ${v.montant}`).join(' + ') } : {}) },
      }));
      crees.push(colis.toObject());
    }
    // Formulaire client repris par la réception : consommé par cet envoi.
    await formulaires.utiliser(req, session, b.formulaire, envoi);
    return {
      envoi,
      colis: crees,
      total,
      recu: recuTotal,
      resteAPayer: r2(total - recuTotal),
      paiements: paiements.lignes,
      modePaiement: modeEnvoi,
    };
  });
}

/** Réception d'un seul colis (compatibilité) : renvoie le colis créé. */
export async function receptionner(req, b) {
  return (await receptionnerEnvoi(req, { ...b, colis: undefined })).colis[0];
}

/** Tous les colis d'un même envoi. */
export function envoi(req, numero) {
  return Colis.find({ envoi: codeScanne(numero), ...filtreDepot(req) }).sort({ numero: 1 }).lean();
}

/** Paiement complémentaire (partiel, ou encaissement à destination). */
export async function payer(req, numero, b) {
  const montantVerse = r2(b.montant);
  if (!(montantVerse > 0)) throw requete('Montant du paiement obligatoire');
  return transaction(async (session) => {
    const colis = await Colis.findOne({ numero: codeScanne(numero), ...filtreDepot(req) }).session(session);
    if (!colis) throw introuvable(`Colis ${numero} introuvable`);
    if (colis.statut === COLIS.ANNULE) throw conflit('Colis annulé');
    const mode = await verifierMode(b.mode, colis.depot);
    const avant = colis.paiement.statut;
    const recu = r2(colis.paiement.recu + montantVerse);
    if (recu > colis.montant + 0.005) throw requete(`Reste à payer : ${r2(colis.montant - colis.paiement.recu)}`);
    colis.paiement.recu = recu;
    colis.paiement.statut = statutPaiement(colis.montant, recu, colis.paiement.mode);
    colis.paiement.versements.push({ mode: mode.code, montant: montantVerse, reference: texte(b.reference), date: new Date(), par: req.user.nom });
    await colis.save({ session });
    await journaliser(req, session, 'PAIEMENT', evtColis(colis, { avant, apres: colis.paiement.statut, details: { mode: mode.code, montant: montantVerse } }));
    return colis.toObject();
  });
}

/** Annulation possible tant que le colis n'est pas chargé ; pas de suppression physique. */
/**
 * Colis seul (sans palette) en zone de départ : gros colis ou reliquat qu'on ne palettise pas.
 * Il pourra ensuite être chargé directement dans un conteneur depuis la zone.
 */
export async function versZoneDepart(req, numero) {
  return transaction(async (session) => {
    const colis = await Colis.findOne({ numero: codeScanne(numero), depot: req.depot.code }).session(session);
    if (!colis) throw introuvable(`Colis ${codeScanne(numero)} inconnu au dépôt ${req.depot.code}`);
    if (colis.paletteId) throw conflit(`Le colis ${colis.numero} est sur une palette : mettez la palette en zone de départ`, 'SUR_PALETTE');
    if (colis.conteneurId) throw conflit(`Le colis ${colis.numero} est déjà prévu dans un conteneur`, 'STATUT');
    if (![COLIS.RECU, COLIS.RELIQUAT].includes(colis.statut)) throw conflit(`Colis ${colis.numero} au statut ${colis.statut}`, 'STATUT');
    const avant = colis.statut;
    colis.statut = COLIS.ZONE_DEPART;
    await colis.save({ session });
    await journaliser(req, session, 'ZONE_DEPART', evtColis(colis, { avant, apres: COLIS.ZONE_DEPART, details: { sansPalette: true } }));
    return colis.toObject();
  });
}

/** Sortie de zone d'un colis seul : il redevient « en attente » (reliquat s'il l'était). */
export async function horsZoneDepart(req, numero, b = {}) {
  const motif = texte(b.motif) || 'Sortie de la zone de départ';
  return transaction(async (session) => {
    const colis = await Colis.findOne({ numero: codeScanne(numero), depot: req.depot.code }).session(session);
    if (!colis) throw introuvable(`Colis ${codeScanne(numero)} inconnu au dépôt ${req.depot.code}`);
    if (colis.statut !== COLIS.ZONE_DEPART || colis.paletteId) throw conflit(`Le colis ${colis.numero} n'est pas seul en zone de départ`, 'STATUT');
    if (colis.conteneurId) throw conflit(`Le colis ${colis.numero} est prévu dans un conteneur : retirez-le d'abord du conteneur`, 'DANS_CONTENEUR');
    colis.statut = colis.priorite > 0 ? COLIS.RELIQUAT : COLIS.RECU;
    await colis.save({ session });
    await journaliser(req, session, 'SORTIE_ZONE_DEPART', evtColis(colis, { avant: COLIS.ZONE_DEPART, apres: colis.statut, motif }));
    return colis.toObject();
  });
}

export async function annuler(req, numero, b) {
  const motif = texte(b.motif);
  if (!motif) throw requete('Motif obligatoire');
  return transaction(async (session) => {
    const colis = await Colis.findOne({ numero: codeScanne(numero), ...filtreDepot(req) }).session(session);
    if (!colis) throw introuvable(`Colis ${numero} introuvable`);
    if ([COLIS.CHARGE, COLIS.PARTI, COLIS.ANNULE].includes(colis.statut)) throw conflit(`Colis ${colis.statut} : annulation impossible`);
    if (colis.conteneurId) throw conflit('Colis prévu dans un conteneur : faites d\'abord un retour dépôt');
    if (colis.paletteId) await retirerDePalette(req, session, colis, motif);
    const avant = colis.statut;
    colis.statut = COLIS.ANNULE;
    colis.motifAnnulation = motif;
    await colis.save({ session });
    await journaliser(req, session, 'ANNULATION', evtColis(colis, { avant, apres: COLIS.ANNULE, motif }));
    return colis.toObject();
  });
}

export async function fiche(req, numero) {
  const colis = await Colis.findOne({ numero: codeScanne(numero), ...filtreDepot(req) })
    .populate('paletteId', 'numero statut').populate('conteneurId', 'numero numeroOfficiel statut').lean();
  if (!colis) throw introuvable(`Colis ${codeScanne(numero)} introuvable`);
  const [historique, envoi] = await Promise.all([
    Evenement.find({ entiteId: colis._id }).sort({ date: 1, _id: 1 }).lean(),
    colis.envoi ? Colis.find({ envoi: colis.envoi }, { numero: 1, statut: 1, poidsKg: 1 }).sort({ numero: 1 }).lean() : [],
  ]);
  return { ...colis, resteAPayer: r2(colis.montant - colis.paiement.recu), historique, colisEnvoi: envoi };
}

/** Liste triée priorité décroissante puis date de réception (FIFO). */
export function liste(req, q) {
  const filtre = { ...filtreDepot(req) };
  if (q.destination) filtre.destination = String(q.destination).toUpperCase();
  if (q.statut) filtre.statut = { $in: String(q.statut).split(',') };
  if (q.sansPalette === '1') filtre.paletteId = null;
  if (q.q) {
    const rx = { $regex: String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    filtre.$or = [{ numero: rx }, { 'destinataire.nom': rx }, { 'destinataire.tel': rx }, { 'expediteur.nom': rx }, { 'expediteur.tel': rx }];
  }
  // Période de réception (du / au : AAAA-MM-JJ, « au » inclus jusqu'à 23:59:59)
  const jour = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00`) : null);
  const du = jour(q.du);
  const au = jour(q.au);
  if (du || au) {
    filtre.dateReception = {};
    if (du) filtre.dateReception.$gte = du;
    if (au) filtre.dateReception.$lt = new Date(au.getTime() + 86400000);
  }
  // Par défaut : file de travail (reliquats d'abord, puis le plus ancien).
  // tri=recent : le dernier reçu en premier ; tri=ancien : le premier reçu en premier.
  const tri = q.tri === 'recent' ? { dateReception: -1, numero: -1 }
    : q.tri === 'ancien' ? { dateReception: 1, numero: 1 }
    : { priorite: -1, dateReception: 1 };
  const exporter = q.export === '1';
  const requete = Colis.find(filtre).sort(tri).limit(Math.min(Number(q.limite) || 300, exporter ? 5000 : 1000));
  // Export : numéros de palette et de conteneur en clair
  if (exporter) requete.populate('paletteId', 'numero').populate('conteneurId', 'numero');
  return requete.lean();
}

/** Recherche d'un client connu par téléphone (pour pré-remplir la réception). */
export async function clientParTelephone(tel) {
  const t = texte(tel);
  if (t.length < 4) return null;
  const c = await Colis.findOne({ $or: [{ 'expediteur.tel': t }, { 'destinataire.tel': t }] }).sort({ dateReception: -1 }).lean();
  if (!c) return null;
  return c.expediteur.tel === t
    ? { nom: c.expediteur.nom, tel: c.expediteur.tel, pieceIdentite: c.expediteur.pieceIdentite }
    : { nom: c.destinataire.nom, tel: c.destinataire.tel, adresse: c.destinataire.adresse };
}
