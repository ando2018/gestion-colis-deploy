import { Colis, COLIS, Destination, Palette, PALETTE, Parametres, ROLES } from '../modeles.js';
import {
  codeCourt, codeScanne, jjmmaa, conflit, evtColis, evtPalette, filtreDepot, interdit, introuvable, journaliser, pad, prochain, r2, requete, texte,
  transaction,
} from '../noyau.js';

const estChefDeQuai = (req) => [ROLES.CHEF_QUAI, ROLES.ADMIN].includes(req.user.role);

/** Recalcule la copie d'affichage de la palette depuis colis.paletteId (qui fait foi). */
export async function recalculer(paletteId, session) {
  const [t] = await Colis.aggregate([
    { $match: { paletteId } },
    { $group: { _id: null, ids: { $push: '$_id' }, nb: { $sum: 1 }, poids: { $sum: '$poidsKg' }, prio: { $max: '$priorite' }, min: { $min: '$dateReception' } } },
  ]).session(session);
  await Palette.updateOne({ _id: paletteId }, {
    $set: { colisIds: t?.ids ?? [], nbColis: t?.nb ?? 0, poidsTotal: r2(t?.poids ?? 0), priorite: t?.prio ?? 0, dateReceptionMin: t?.min ?? null },
  }, { session });
}

async function paletteDuDepot(req, numero, session) {
  const p = await Palette.findOne({ depot: req.depot.code, numero: codeScanne(numero) }).session(session ?? null);
  if (!p) throw introuvable(`Palette ${codeScanne(numero)} inconnue au dépôt ${req.depot.code}`);
  return p;
}

export async function creer(req, b) {
  const destination = await Destination.findOne({ code: texte(b.destination).toUpperCase(), actif: true }).lean();
  if (!destination) throw requete('Destination inconnue ou inactive');
  const { paletteMaxKg } = (await Parametres.findById('general').lean()) ?? { paletteMaxKg: 800 };
  return transaction(async (session) => {
    // PAL-ABJ-JJMMAA-0001 : destination comme pour les colis, compteur du jour par destination, commun à tous les dépôts.
    const jour = jjmmaa();
    const numero = `PAL-${destination.code}-${jour}-${pad(await prochain(`palette-${destination.code}-${jour}`, session))}`;
    const [p] = await Palette.create([{
      numero, code: await codeCourt('palette', session), depot: req.depot.code, destination: destination.code, poidsMaxKg: Number(b.poidsMaxKg) || paletteMaxKg,
    }], { session });
    await journaliser(req, session, 'CREATION_PALETTE', evtPalette(p, { apres: { destination: p.destination } }));
    return p.toObject();
  });
}

/**
 * Sort un colis de sa palette (dans une transaction ouverte). Une palette fermée ou en zone de départ
 * n'est modifiable que par le chef de quai et repasse OUVERTE.
 */
export async function retirerDePalette(req, session, colis, motif) {
  const palette = await Palette.findById(colis.paletteId).session(session);
  if (palette) {
    if (palette.conteneurId || [PALETTE.CHARGEE, PALETTE.PARTIE].includes(palette.statut)) {
      throw conflit(`La palette ${palette.numero} est dans un conteneur : utilisez « Retours dépôt »`);
    }
    // En zone de départ, la palette est prête à charger : on la sort de la zone, on la rouvre (motif tracé), puis on retire.
    if (palette.statut === PALETTE.ZONE_DEPART) {
      throw conflit(`La palette ${palette.numero} est en zone de départ : sortez-la de la zone puis rouvrez-la pour retirer un colis`, 'PALETTE_EN_ZONE');
    }
    if (palette.statut !== PALETTE.OUVERTE) {
      if (!estChefDeQuai(req)) throw interdit(`Palette ${palette.numero} ${palette.statut} : retrait réservé au chef de quai`);
      const avant = palette.statut;
      palette.statut = PALETTE.OUVERTE;
      await palette.save({ session });
      await journaliser(req, session, 'PALETTE_ROUVERTE', evtPalette(palette, { avant, apres: PALETTE.OUVERTE, motif }));
    }
  }
  const avant = colis.statut;
  colis.paletteId = null;
  colis.statut = colis.priorite > 0 ? COLIS.RELIQUAT : COLIS.RECU;
  await colis.save({ session });
  if (palette) await recalculer(palette._id, session);
  await journaliser(req, session, 'RETRAIT_PALETTE', evtColis(colis, {
    avant, apres: colis.statut, motif, details: { palette: palette?.numero },
  }));
}

/** Ajout d'un colis scanné : contrôles statut, destination, palette unique, poids max. */
export async function ajouterColis(req, numeroPalette, b) {
  return transaction(async (session) => {
    const palette = await paletteDuDepot(req, numeroPalette, session);
    if (palette.statut !== PALETTE.OUVERTE) throw conflit(`La palette ${palette.numero} est ${palette.statut}`, 'PALETTE_NON_OUVERTE');
    const colis = await Colis.findOne({ numero: codeScanne(b.numero), depot: req.depot.code }).session(session);
    if (!colis) throw introuvable(`Colis ${codeScanne(b.numero)} inconnu au dépôt ${req.depot.code}`);
    if (colis.paletteId?.equals(palette._id)) return { colis: colis.toObject(), palette: palette.toObject(), dejaPresent: true };
    if (colis.destination !== palette.destination) {
      throw conflit(`Destination ${colis.destination} ≠ ${palette.destination}`, 'DESTINATION');
    }
    if (colis.paletteId) {
      const ancienne = await Palette.findById(colis.paletteId).session(session).lean();
      if (!b.transfert) {
        throw conflit(`Colis déjà sur la palette ${ancienne?.numero}`, 'TRANSFERT_POSSIBLE', { palette: ancienne?.numero });
      }
      await retirerDePalette(req, session, colis, `Transfert vers ${palette.numero}`);
    }
    if (![COLIS.RECU, COLIS.RELIQUAT].includes(colis.statut)) throw conflit(`Colis au statut ${colis.statut}`, 'STATUT');
    if (colis.conteneurId) throw conflit('Colis prévu dans un conteneur', 'STATUT');
    if (r2(palette.poidsTotal + colis.poidsKg) > palette.poidsMaxKg) {
      throw conflit(
        `Poids max dépassé : ${palette.poidsTotal} + ${colis.poidsKg} > ${palette.poidsMaxKg} kg — créez une nouvelle palette`,
        'POIDS_MAX',
      );
    }
    const avant = colis.statut;
    colis.paletteId = palette._id;
    colis.statut = COLIS.SUR_PALETTE;
    await colis.save({ session });
    await recalculer(palette._id, session);
    await journaliser(req, session, 'AJOUT_PALETTE', evtColis(colis, { avant, apres: COLIS.SUR_PALETTE, details: { palette: palette.numero } }));
    return { colis: colis.toObject(), palette: (await Palette.findById(palette._id).session(session).lean()) };
  });
}

export async function retirerColis(req, numeroPalette, numeroColis, b) {
  const motif = texte(b?.motif);
  if (!motif) throw requete('Motif obligatoire');
  return transaction(async (session) => {
    const palette = await paletteDuDepot(req, numeroPalette, session);
    const colis = await Colis.findOne({ numero: codeScanne(numeroColis), paletteId: palette._id }).session(session);
    if (!colis) throw introuvable(`Le colis ${codeScanne(numeroColis)} n'est pas sur la palette ${palette.numero}`);
    await retirerDePalette(req, session, colis, motif);
    return colis.toObject();
  });
}

export async function fermer(req, numero) {
  return transaction(async (session) => {
    const p = await paletteDuDepot(req, numero, session);
    if (p.statut !== PALETTE.OUVERTE) throw conflit(`La palette ${p.numero} est ${p.statut}`);
    if (!p.nbColis) throw requete(`La palette ${p.numero} est vide`);
    p.statut = PALETTE.FERMEE;
    await p.save({ session });
    await journaliser(req, session, 'PALETTE_FERMEE', evtPalette(p, { avant: PALETTE.OUVERTE, apres: PALETTE.FERMEE, details: { nbColis: p.nbColis, poidsTotal: p.poidsTotal } }));
    return p.toObject();
  });
}

/**
 * Rouvre une palette fermée pour y ajouter ou retirer des colis, avec un motif obligatoire (tracé dans l'historique).
 * Une palette en zone de départ doit d'abord en être sortie (elle redevient « Fermée ») ; impossible dans un conteneur.
 */
export async function rouvrir(req, numero, b = {}) {
  const motif = texte(b.motif);
  if (!motif) throw requete('Indiquez le motif de la réouverture');
  return transaction(async (session) => {
    const p = await paletteDuDepot(req, numero, session);
    if (p.conteneurId || [PALETTE.CHARGEE, PALETTE.PARTIE].includes(p.statut)) {
      throw conflit(`La palette ${p.numero} est dans un conteneur : retirez-la d'abord du conteneur`, 'DANS_CONTENEUR');
    }
    if (p.statut === PALETTE.OUVERTE) throw conflit(`La palette ${p.numero} est déjà ouverte`);
    if (p.statut === PALETTE.ZONE_DEPART) {
      throw conflit(`La palette ${p.numero} est en zone de départ : sortez-la d'abord de la zone pour pouvoir la rouvrir`, 'PALETTE_EN_ZONE');
    }
    p.statut = PALETTE.OUVERTE;
    await p.save({ session });
    await journaliser(req, session, 'PALETTE_ROUVERTE', evtPalette(p, { avant: PALETTE.FERMEE, apres: PALETTE.OUVERTE, motif }));
    return p.toObject();
  });
}

/** Étape 3a — la palette part en zone de départ : événement sur la palette et sur chacun de ses colis. */
export async function versZoneDepart(req, numero) {
  return transaction(async (session) => {
    const p = await paletteDuDepot(req, numero, session);
    if (p.statut !== PALETTE.FERMEE) throw conflit(`La palette ${p.numero} doit être FERMEE (actuellement ${p.statut})`);
    p.statut = PALETTE.ZONE_DEPART;
    await p.save({ session });
    const colis = await Colis.find({ paletteId: p._id }).session(session).lean();
    await Colis.updateMany({ paletteId: p._id }, { $set: { statut: COLIS.ZONE_DEPART } }, { session });
    await journaliser(req, session, 'ZONE_DEPART', [
      evtPalette(p, { avant: PALETTE.FERMEE, apres: PALETTE.ZONE_DEPART }),
      ...colis.map((c) => evtColis(c, { avant: c.statut, apres: COLIS.ZONE_DEPART, details: { palette: p.numero } })),
    ]);
    return p.toObject();
  });
}

/**
 * Sortie de la zone de départ (palette déplacée par erreur, ou qui ne part pas tout de suite) :
 * la palette redevient FERMEE et ses colis SUR_PALETTE. Impossible si elle est déjà prévue dans un conteneur.
 */
export async function horsZoneDepart(req, numero, b = {}) {
  const motif = texte(b.motif) || 'Sortie de la zone de départ';
  return transaction(async (session) => {
    const p = await paletteDuDepot(req, numero, session);
    if (p.statut !== PALETTE.ZONE_DEPART) throw conflit(`La palette ${p.numero} n'est pas en zone de départ (${p.statut})`);
    if (p.conteneurId) throw conflit(`La palette ${p.numero} est prévue dans un conteneur : retirez-la d'abord du conteneur`, 'DANS_CONTENEUR');
    p.statut = PALETTE.FERMEE;
    await p.save({ session });
    const colis = await Colis.find({ paletteId: p._id, statut: COLIS.ZONE_DEPART }).session(session).lean();
    await Colis.updateMany({ _id: { $in: colis.map((c) => c._id) } }, { $set: { statut: COLIS.SUR_PALETTE } }, { session });
    await journaliser(req, session, 'SORTIE_ZONE_DEPART', [
      evtPalette(p, { avant: PALETTE.ZONE_DEPART, apres: PALETTE.FERMEE, motif }),
      ...colis.map((c) => evtColis(c, { avant: COLIS.ZONE_DEPART, apres: COLIS.SUR_PALETTE, motif, details: { palette: p.numero } })),
    ]);
    return p.toObject();
  });
}

/**
 * Suppression d'une palette vide (créée par erreur, ou vidée par des retraits) : refusée tant qu'elle porte
 * un colis ou qu'elle est prévue dans un conteneur. La suppression reste tracée dans le journal.
 */
export async function supprimer(req, numero) {
  return transaction(async (session) => {
    const p = await paletteDuDepot(req, numero, session);
    if (p.conteneurId || [PALETTE.CHARGEE, PALETTE.PARTIE].includes(p.statut)) throw conflit(`La palette ${p.numero} est dans un conteneur`, 'DANS_CONTENEUR');
    const n = await Colis.countDocuments({ paletteId: p._id }).session(session);
    if (n) throw conflit(`La palette ${p.numero} contient ${n} colis : retirez-les d'abord`, 'PALETTE_NON_VIDE');
    await Palette.deleteOne({ _id: p._id }, { session });
    await journaliser(req, session, 'SUPPRESSION_PALETTE', evtPalette(p, { avant: p.statut, details: { destination: p.destination } }));
    return { supprime: true, numero: p.numero };
  });
}

/** File d'attente de la zone de départ : palettes FERMEE, priorité puis plus ancien colis. */
export function fileZoneDepart(req, destination) {
  return Palette.find({
    ...filtreDepot(req), statut: PALETTE.FERMEE, ...(destination ? { destination: String(destination).toUpperCase() } : {}),
  }).sort({ priorite: -1, dateReceptionMin: 1 }).lean();
}

export function liste(req, q) {
  const filtre = { ...filtreDepot(req) };
  if (q.statut) filtre.statut = { $in: String(q.statut).split(',') };
  if (q.destination) filtre.destination = String(q.destination).toUpperCase();
  return Palette.find(filtre).sort({ priorite: -1, dateReceptionMin: 1, createdAt: -1 }).limit(300).lean();
}

export async function detail(req, numero) {
  const filtre = { ...filtreDepot(req), numero: codeScanne(numero) };
  const p = await Palette.findOne(filtre).populate('conteneurId', 'numero statut').lean();
  if (!p) throw introuvable(`Palette ${codeScanne(numero)} introuvable`);
  const colis = await Colis.find({ paletteId: p._id }).sort({ priorite: -1, dateReception: 1 }).lean();
  return { ...p, colis };
}

/** Page publique du QR palette : numéros et statuts seulement, sans données personnelles. */
export async function pagePublique(depot, numero) {
  const p = await Palette.findOne({ depot: String(depot).toUpperCase(), numero: String(numero).toUpperCase() }).lean();
  if (!p) return null;
  const colis = await Colis.find({ paletteId: p._id }, { numero: 1, nbPieces: 1, poidsKg: 1, statut: 1 }).sort({ numero: 1 }).lean();
  return { palette: p, colis };
}
