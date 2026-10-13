import { Colis, COLIS, CONTENEUR, Conteneur, Destination, Evenement, PAIEMENT, Palette, PALETTE, Parametres } from '../modeles.js';
import {
  codeCourt, codeScanne, jjmmaa, conflit, evtColis, evtConteneur, evtPalette, filtreDepot, introuvable, journaliser, pad, prochain, r2, requete,
  texte, transaction,
} from '../noyau.js';
import { recalculer } from './palettes.js';

/** Colis « prévus » : rattachés au conteneur mais pas encore validés. */
const prevus = (conteneurId) => ({ conteneurId, statut: { $nin: [COLIS.CHARGE, COLIS.PARTI] } });

async function conteneurDuDepot(req, numero, session) {
  const c = await Conteneur.findOne({ depot: req.depot.code, numero: codeScanne(numero) }).session(session ?? null);
  if (!c) throw introuvable(`Conteneur ${codeScanne(numero)} inconnu au dépôt ${req.depot.code}`);
  return c;
}

const enChargement = (c) => {
  if (c.statut !== CONTENEUR.EN_CHARGEMENT) throw conflit(`Le conteneur ${c.numero} est ${c.statut}`, 'CONTENEUR_STATUT');
};

async function poidsPrevu(conteneurId, session) {
  const [t] = await Colis.aggregate([{ $match: prevus(conteneurId) }, { $group: { _id: null, p: { $sum: '$poidsKg' }, n: { $sum: 1 } } }]).session(session);
  return { poids: r2(t?.p ?? 0), nb: t?.n ?? 0 };
}

export async function creer(req, b) {
  const destination = await Destination.findOne({ code: texte(b.destination).toUpperCase(), actif: true }).lean();
  if (!destination) throw requete('Destination inconnue ou inactive');
  const params = await Parametres.findById('general').lean();
  const type = params?.typesConteneur.find((t) => t.code === b.type);
  if (!type) throw requete(`Type de conteneur inconnu (${params?.typesConteneur.map((t) => t.code).join(', ')})`);
  return transaction(async (session) => {
    // CTN-ABJ-JJMMAA-0001 : destination comme pour les colis, compteur du jour par destination, commun à tous les dépôts.
    const jour = jjmmaa();
    const numero = `CTN-${destination.code}-${jour}-${pad(await prochain(`conteneur-${destination.code}-${jour}`, session))}`;
    const [c] = await Conteneur.create([{
      numero, code: await codeCourt('conteneur', session), depot: req.depot.code, destination: destination.code, type: type.code, poidsMaxKg: type.poidsMaxKg,
      numeroOfficiel: texte(b.numeroOfficiel).toUpperCase(), scelle: texte(b.scelle),
    }], { session });
    await journaliser(req, session, 'CREATION_CONTENEUR', evtConteneur(c, { apres: { destination: c.destination, type: c.type, numeroOfficiel: c.numeroOfficiel } }));
    return c.toObject();
  });
}

/**
 * Scan au chargement. Palette en zone de départ → tous ses colis « prévus » dans le conteneur.
 * Colis sans palette (reliquat, colis isolé) → prévu directement. Autre chose → alerte hors manifeste, tracée, non bloquante.
 */
export async function scanner(req, numero, b) {
  const code = codeScanne(b.code);
  if (!code) throw requete('Code vide');
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    enChargement(c);
    const horsManifeste = async (message, colis) => {
      await journaliser(req, session, 'HORS_MANIFESTE', [
        evtConteneur(c, { details: { code }, motif: message }),
        ...(colis ? [evtColis(colis, { details: { conteneur: c.numero }, motif: message })] : []),
      ]);
      return { alerte: true, type: 'HORS_MANIFESTE', message: `Hors manifeste : ${message}` };
    };
    const verifierPoids = async (ajout) => {
      const { poids } = await poidsPrevu(c._id, session);
      if (r2(poids + ajout) > c.poidsMaxKg) throw conflit(`Charge utile dépassée : ${r2(poids + ajout)} > ${c.poidsMaxKg} kg`, 'POIDS_MAX');
    };

    const palette = await Palette.findOne({ depot: req.depot.code, numero: code }).session(session);
    if (palette) {
      if (palette.conteneurId?.equals(c._id)) return { type: 'palette', dejaPresent: true, message: `Palette ${code} déjà dans le conteneur` };
      if (palette.conteneurId) return horsManifeste(`palette ${code} déjà prévue dans un autre conteneur`);
      if (palette.statut !== PALETTE.ZONE_DEPART) return horsManifeste(`palette ${code} au statut ${palette.statut} (pas en zone de départ)`);
      if (palette.destination !== c.destination) return horsManifeste(`palette ${code} pour ${palette.destination}, conteneur pour ${c.destination}`);
      await verifierPoids(palette.poidsTotal);
      palette.conteneurId = c._id;
      await palette.save({ session });
      c.paletteIds.addToSet(palette._id);
      await c.save({ session });
      const colis = await Colis.find({ paletteId: palette._id }).session(session).lean();
      await Colis.updateMany({ paletteId: palette._id }, { $set: { conteneurId: c._id } }, { session });
      await journaliser(req, session, 'PREVU_CONTENEUR', [
        evtPalette(palette, { details: { conteneur: c.numero } }),
        ...colis.map((x) => evtColis(x, { details: { conteneur: c.numero, palette: palette.numero } })),
      ]);
      return { type: 'palette', nbColis: colis.length, message: `Palette ${code} : ${colis.length} colis prévus dans ${c.numero}` };
    }

    const colis = await Colis.findOne({ numero: code }).session(session);
    if (!colis) return horsManifeste(`code ${code} inconnu`);
    if (colis.conteneurId?.equals(c._id)) return { type: 'colis', dejaPresent: true, message: `Colis ${code} déjà prévu dans ce conteneur` };
    if (colis.depot !== c.depot) return horsManifeste(`colis ${code} du dépôt ${colis.depot}`, colis);
    if (colis.destination !== c.destination) return horsManifeste(`colis ${code} pour ${colis.destination}`, colis);
    if (colis.conteneurId) return horsManifeste(`colis ${code} prévu dans un autre conteneur`, colis);
    if (colis.paletteId) {
      const p = await Palette.findById(colis.paletteId).session(session).lean();
      return horsManifeste(`colis ${code} sur la palette ${p?.numero} (${p?.statut}) : scannez la palette`, colis);
    }
    if (![COLIS.RECU, COLIS.RELIQUAT, COLIS.ZONE_DEPART].includes(colis.statut)) return horsManifeste(`colis ${code} au statut ${colis.statut}`, colis);
    // Colis isolé (reliquat, ou colis seul mis en zone de départ) : chargé sans palette.
    await verifierPoids(colis.poidsKg);
    colis.conteneurId = c._id;
    await colis.save({ session });
    await journaliser(req, session, 'PREVU_CONTENEUR', evtColis(colis, { details: { conteneur: c.numero, sansPalette: true } }));
    return { type: 'colis', message: `Colis ${code}${colis.statut === COLIS.RELIQUAT ? ' (reliquat)' : ''} prévu sans palette dans ${c.numero}` };
  });
}

/**
 * Étape 4 — retour dépôt. Un reliquat est toujours un colis, jamais une palette : le colis scanné redevient
 * RELIQUAT prioritaire et quitte sa palette, qui reste dans le conteneur avec ses autres colis.
 * Une palette entière restée sur le quai se « retire » (correction) ou ses colis se retournent un par un.
 */
export async function retour(req, numero, b) {
  const code = codeScanne(b.code);
  const motif = texte(b.motif) || 'Non chargé';
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    enChargement(c);
    const reliquat = { statut: COLIS.RELIQUAT, priorite: 1, conteneurId: null };

    if (await Palette.exists({ depot: req.depot.code, numero: code }).session(session)) {
      throw requete(
        `${code} est une palette : le retour dépôt se fait colis par colis. Scannez chaque colis resté sur le quai, ou retirez la palette du conteneur.`,
        'RETOUR_COLIS',
      );
    }

    const colis = await Colis.findOne({ numero: code, ...prevus(c._id) }).session(session);
    if (!colis) throw introuvable(`${code} n'est pas prévu dans le conteneur ${c.numero}`);
    const avant = colis.statut;
    const paletteId = colis.paletteId;
    Object.assign(colis, reliquat, { paletteId: null, nbReports: colis.nbReports + 1 });
    await colis.save({ session });
    if (paletteId) await recalculer(paletteId, session);
    const p = paletteId ? await Palette.findById(paletteId).session(session).lean() : null;
    await journaliser(req, session, 'RETOUR_DEPOT', evtColis(colis, {
      avant, apres: COLIS.RELIQUAT, motif, details: { conteneur: c.numero, palette: p?.numero, nbReports: colis.nbReports },
    }));
    return { type: 'colis', message: `Colis ${code} retourne au dépôt (reliquat, ${colis.nbReports} report(s))` };
  });
}

/**
 * Correction avant validation (erreur de scan, mauvais colis) : on sort une palette ou un colis du conteneur
 * sans en faire un reliquat. La palette retourne en zone de départ ; un colis pris sur une palette la quitte et
 * redevient « en attente » (RECU, ou RELIQUAT s'il l'était déjà) ; un colis sans palette garde son statut.
 */
export async function retirer(req, numero, b) {
  const code = codeScanne(b.code);
  const motif = texte(b.motif) || 'Erreur de scan';
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    enChargement(c);

    const palette = await Palette.findOne({ depot: req.depot.code, numero: code, conteneurId: c._id }).session(session);
    if (palette) {
      const colis = await Colis.find({ paletteId: palette._id, ...prevus(c._id) }).session(session).lean();
      await Colis.updateMany({ _id: { $in: colis.map((x) => x._id) } }, { $set: { conteneurId: null } }, { session });
      palette.conteneurId = null;
      await palette.save({ session });
      c.paletteIds.pull(palette._id);
      await c.save({ session });
      await journaliser(req, session, 'RETRAIT_CONTENEUR', [
        evtPalette(palette, { motif, details: { conteneur: c.numero } }),
        ...colis.map((x) => evtColis(x, { motif, details: { conteneur: c.numero, palette: palette.numero } })),
      ]);
      return { type: 'palette', nbColis: colis.length, message: `Palette ${code} retirée du conteneur (${colis.length} colis), retour en zone de départ` };
    }

    const colis = await Colis.findOne({ numero: code, ...prevus(c._id) }).session(session);
    if (!colis) throw introuvable(`${code} n'est pas dans le conteneur ${c.numero}`);
    const avant = colis.statut;
    const paletteId = colis.paletteId;
    colis.conteneurId = null;
    if (paletteId) {
      colis.paletteId = null;
      colis.statut = colis.priorite > 0 ? COLIS.RELIQUAT : COLIS.RECU;
    }
    await colis.save({ session });
    if (paletteId) await recalculer(paletteId, session);
    const p = paletteId ? await Palette.findById(paletteId).session(session).lean() : null;
    await journaliser(req, session, 'RETRAIT_CONTENEUR', evtColis(colis, {
      avant, apres: colis.statut, motif, details: { conteneur: c.numero, palette: p?.numero },
    }));
    return { type: 'colis', message: `Colis ${code} retiré du conteneur${p ? ` et de la palette ${p.numero}` : ''}` };
  });
}

/** Chiffres affichés avant validation : X chargés, Y retours, paiements partiels, alertes. */
export async function recap(req, numero) {
  const c = await Conteneur.findOne({ ...filtreDepot(req), numero: codeScanne(numero) }).lean();
  if (!c) throw introuvable(`Conteneur ${codeScanne(numero)} introuvable`);
  const [colis, retours, horsManifeste, palettes] = await Promise.all([
    Colis.find(prevus(c._id)).sort({ numero: 1 }).lean(),
    Evenement.countDocuments({ type: 'RETOUR_DEPOT', entite: 'colis', 'details.conteneur': c.numero }),
    Evenement.countDocuments({ type: 'HORS_MANIFESTE', entite: 'conteneur', entiteId: c._id }),
    Palette.find({ conteneurId: c._id }).lean(),
  ]);
  return {
    conteneur: c,
    nbACharger: colis.length,
    poidsACharger: r2(colis.reduce((s, x) => s + x.poidsKg, 0)),
    nbRetours: retours,
    nbHorsManifeste: horsManifeste,
    palettes,
    sansPalette: colis.filter((x) => !x.paletteId),
    partiels: colis.filter((x) => x.paiement.statut === PAIEMENT.PARTIEL),
  };
}

/** Validation par exception : tous les colis prévus et non retournés passent CHARGE, en une transaction. */
export async function valider(req, numero, b = {}) {
  const params = await Parametres.findById('general').lean();
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    enChargement(c);
    const colis = await Colis.find(prevus(c._id)).session(session).lean();
    if (!colis.length) throw requete('Aucun colis à charger');
    const partiels = colis.filter((x) => x.paiement.statut === PAIEMENT.PARTIEL);
    if (partiels.length && params?.bloquerPartielAuChargement) {
      if (!b.derogation) {
        throw conflit(`${partiels.length} colis payé(s) partiellement : dérogation du chef de quai requise`, 'PAIEMENT_PARTIEL', {
          colis: partiels.map((x) => ({ numero: x.numero, reste: r2(x.montant - x.paiement.recu) })),
        });
      }
      if (!texte(b.motif)) throw requete('Motif de dérogation obligatoire');
      await journaliser(req, session, 'DEROGATION', partiels.map((x) => evtColis(x, { motif: texte(b.motif), details: { conteneur: c.numero } })));
    }

    const maintenant = new Date();
    await Colis.updateMany({ _id: { $in: colis.map((x) => x._id) } }, [
      { $set: { statutAvantChargement: '$statut', statut: COLIS.CHARGE, priorite: 0 } },
    ], { session, updatePipeline: true });
    // Palettes vidées par des retours : rouvertes et sorties du conteneur.
    const palettes = await Palette.find({ conteneurId: c._id }).session(session);
    for (const p of palettes) {
      await recalculer(p._id, session);
      const n = await Colis.countDocuments({ paletteId: p._id }).session(session);
      if (n) {
        p.statut = PALETTE.CHARGEE;
      } else {
        p.statut = PALETTE.OUVERTE;
        p.conteneurId = null;
        c.paletteIds.pull(p._id);
      }
      await p.save({ session });
    }
    Object.assign(c, {
      statut: CONTENEUR.CHARGE, nbColis: colis.length, poidsTotal: r2(colis.reduce((s, x) => s + x.poidsKg, 0)), dateChargement: maintenant,
    });
    await c.save({ session });
    await journaliser(req, session, 'CHARGE', [
      evtConteneur(c, { avant: CONTENEUR.EN_CHARGEMENT, apres: CONTENEUR.CHARGE, details: { nbColis: c.nbColis, poidsTotal: c.poidsTotal } }),
      ...colis.map((x) => evtColis(x, { avant: x.statut, apres: COLIS.CHARGE, details: { conteneur: c.numero } })),
    ]);
    return c.toObject();
  });
}

/** Annulation d'une validation par un admin tant que le conteneur n'est pas parti. */
export async function annulerValidation(req, numero, b) {
  const motif = texte(b?.motif);
  if (!motif) throw requete('Motif obligatoire');
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    if (c.statut !== CONTENEUR.CHARGE) throw conflit(`Le conteneur ${c.numero} est ${c.statut} : annulation impossible`);
    const colis = await Colis.find({ conteneurId: c._id, statut: COLIS.CHARGE }).session(session).lean();
    await Colis.updateMany({ _id: { $in: colis.map((x) => x._id) } }, [
      { $set: {
        statut: { $ifNull: ['$statutAvantChargement', COLIS.ZONE_DEPART] },
        priorite: { $cond: [{ $gt: ['$nbReports', 0] }, 1, 0] },
      } },
    ], { session, updatePipeline: true });
    await Palette.updateMany({ conteneurId: c._id, statut: PALETTE.CHARGEE }, { $set: { statut: PALETTE.ZONE_DEPART } }, { session });
    for (const p of c.paletteIds) await recalculer(p, session);
    Object.assign(c, { statut: CONTENEUR.EN_CHARGEMENT, dateChargement: null });
    await c.save({ session });
    await journaliser(req, session, 'ANNULATION', [
      evtConteneur(c, { avant: CONTENEUR.CHARGE, apres: CONTENEUR.EN_CHARGEMENT, motif }),
      ...colis.map((x) => evtColis(x, { avant: COLIS.CHARGE, apres: x.statutAvantChargement ?? COLIS.ZONE_DEPART, motif, details: { conteneur: c.numero } })),
    ]);
    return c.toObject();
  });
}

/** Fermeture : saisie du scellé, conteneur et colis PARTI. */
export async function partir(req, numero, b) {
  return transaction(async (session) => {
    const c = await conteneurDuDepot(req, numero, session);
    if (c.statut !== CONTENEUR.CHARGE) throw conflit(`Validez d'abord le chargement (statut ${c.statut})`);
    const scelle = texte(b?.scelle) || c.scelle;
    if (!scelle) throw requete('Numéro de scellé obligatoire');
    const colis = await Colis.find({ conteneurId: c._id, statut: COLIS.CHARGE }).session(session).lean();
    await Colis.updateMany({ _id: { $in: colis.map((x) => x._id) } }, { $set: { statut: COLIS.PARTI } }, { session });
    // Les palettes partent avec leurs colis (les reliquats en ont déjà été retirés).
    const palettes = await Palette.find({ conteneurId: c._id, statut: PALETTE.CHARGEE }).session(session).lean();
    await Palette.updateMany({ _id: { $in: palettes.map((p) => p._id) } }, { $set: { statut: PALETTE.PARTIE } }, { session });
    Object.assign(c, { statut: CONTENEUR.PARTI, scelle, dateDepart: new Date() });
    await c.save({ session });
    await journaliser(req, session, 'CONTENEUR_PARTI', [
      evtConteneur(c, { avant: CONTENEUR.CHARGE, apres: CONTENEUR.PARTI, details: { scelle } }),
      ...palettes.map((p) => evtPalette(p, { avant: PALETTE.CHARGEE, apres: PALETTE.PARTIE, details: { conteneur: c.numero } })),
      ...colis.map((x) => evtColis(x, { avant: COLIS.CHARGE, apres: COLIS.PARTI, details: { conteneur: c.numero } })),
    ]);
    return c.toObject();
  });
}

export async function arriver(req, numero) {
  return transaction(async (session) => {
    const c = await Conteneur.findOne({ ...filtreDepot(req), numero: codeScanne(numero) }).session(session);
    if (!c) throw introuvable(`Conteneur ${codeScanne(numero)} introuvable`);
    if (c.statut !== CONTENEUR.PARTI) throw conflit(`Le conteneur ${c.numero} est ${c.statut}`);
    Object.assign(c, { statut: CONTENEUR.ARRIVE, dateArrivee: new Date() });
    await c.save({ session });
    await journaliser(req, session, 'CONTENEUR_ARRIVE', evtConteneur(c, { avant: CONTENEUR.PARTI, apres: CONTENEUR.ARRIVE }));
    return c.toObject();
  });
}

export function liste(req, q) {
  const filtre = { ...filtreDepot(req) };
  if (q.statut) filtre.statut = { $in: String(q.statut).split(',') };
  if (q.destination) filtre.destination = String(q.destination).toUpperCase();
  return Conteneur.find(filtre).sort({ createdAt: -1 }).limit(200).lean();
}

/** Détail et manifeste : colis, poids, montants à encaisser à destination. */
export async function detail(req, numero) {
  const c = await Conteneur.findOne({ ...filtreDepot(req), numero: codeScanne(numero) }).lean();
  if (!c) throw introuvable(`Conteneur ${codeScanne(numero)} introuvable`);
  const [colis, palettes, destination] = await Promise.all([
    Colis.find({ conteneurId: c._id }).populate('paletteId', 'numero').sort({ numero: 1 }).lean(),
    Palette.find({ _id: { $in: c.paletteIds } }).lean(),
    Destination.findOne({ code: c.destination }).lean(),
  ]);
  const lignes = colis.map((x) => ({ ...x, palette: x.paletteId?.numero ?? null, resteAPayer: r2(x.montant - x.paiement.recu) }));
  return {
    ...c,
    destinationDetail: destination,
    palettes,
    colis: lignes,
    totalAEncaisser: r2(lignes.reduce((s, x) => s + x.resteAPayer, 0)),
  };
}
