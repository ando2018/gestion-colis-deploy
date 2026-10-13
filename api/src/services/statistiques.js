import { Colis, COLIS } from '../modeles.js';
import { filtreDepot, r2, requete } from '../noyau.js';

const FUSEAU = 'Europe/Paris';
const JOUR = 86400000;
const FORMATS = { jour: '%Y-%m-%d', semaine: '%G-S%V', mois: '%Y-%m' };

/** Date (AAAA-MM-JJ) dans le fuseau du dépôt. */
const jourLocal = (d) => new Intl.DateTimeFormat('fr-CA', { timeZone: FUSEAU }).format(d);

/** Clé de période identique à $dateToString (semaine ISO : %G-S%V). */
function cle(jour, granularite) {
  if (granularite === 'mois') return jour.slice(0, 7);
  if (granularite === 'jour') return jour;
  const d = new Date(`${jour}T00:00:00Z`);
  const j = (d.getUTCDay() + 6) % 7; // lundi = 0
  d.setUTCDate(d.getUTCDate() - j + 3); // jeudi de la semaine
  const annee = d.getUTCFullYear();
  const premierJeudi = new Date(Date.UTC(annee, 0, 4));
  const semaine = 1 + Math.round(((d - premierJeudi) / JOUR - 3 + ((premierJeudi.getUTCDay() + 6) % 7)) / 7);
  return `${annee}-S${String(semaine).padStart(2, '0')}`;
}

/** Toutes les périodes entre du et au, pour des graphiques sans trous. */
function periodes(du, au, granularite) {
  const cles = [];
  for (let t = du.getTime(); t <= au.getTime(); t += JOUR) {
    const k = cle(jourLocal(new Date(t)), granularite);
    if (cles.at(-1) !== k) cles.push(k);
  }
  const fin = cle(jourLocal(au), granularite);
  if (cles.at(-1) !== fin) cles.push(fin);
  return cles;
}

const groupeMontants = { colis: { $sum: 1 }, pieces: { $sum: '$nbPieces' }, poids: { $sum: '$poidsKg' }, ca: { $sum: '$montant' }, encaisse: { $sum: '$paiement.recu' } };
const arrondir = (o) => ({ ...o, poids: r2(o.poids ?? 0), ca: r2(o.ca ?? 0), encaisse: r2(o.encaisse ?? 0) });
const vide = { colis: 0, pieces: 0, poids: 0, ca: 0, encaisse: 0 };

/**
 * Statistiques et chiffre d'affaires sur une période (colis reçus, hors annulés) :
 * totaux et comparaison avec la période précédente de même durée, évolution par jour / semaine / mois,
 * répartition par destination, dépôt, statut et mode de paiement (versements encaissés sur la période).
 */
export async function statistiques(req, q) {
  const au = q.au ? new Date(`${q.au}T23:59:59.999`) : new Date();
  const du = q.du ? new Date(`${q.du}T00:00:00`) : new Date(au.getTime() - 29 * JOUR);
  if (Number.isNaN(du.getTime()) || Number.isNaN(au.getTime()) || du > au) throw requete('Période invalide');
  const nbJours = Math.max(1, Math.round((au - du) / JOUR));
  const granularite = FORMATS[q.granularite] ? q.granularite : nbJours <= 62 ? 'jour' : nbJours <= 190 ? 'semaine' : 'mois';
  const f = { ...filtreDepot(req), statut: { $ne: COLIS.ANNULE } };
  const surPeriode = { ...f, dateReception: { $gte: du, $lte: au } };
  const avant = { ...f, dateReception: { $gte: new Date(du.getTime() - (au - du)), $lt: du } };

  const [[res], [prec], modes] = await Promise.all([
    Colis.aggregate([
      { $match: surPeriode },
      {
        $facet: {
          totaux: [{ $group: { _id: null, ...groupeMontants } }],
          serie: [{ $group: { _id: { $dateToString: { format: FORMATS[granularite], date: '$dateReception', timezone: FUSEAU } }, ...groupeMontants } }],
          destinations: [{ $group: { _id: '$destination', ...groupeMontants } }, { $sort: { ca: -1 } }],
          depots: [{ $group: { _id: '$depot', ...groupeMontants } }, { $sort: { ca: -1 } }],
          statuts: [{ $group: { _id: '$statut', n: { $sum: 1 } } }],
        },
      },
    ]),
    Colis.aggregate([{ $match: avant }, { $group: { _id: null, ...groupeMontants } }]),
    // Encaissements de la période, par mode (un paiement fractionné compte dans chaque mode utilisé).
    Colis.aggregate([
      { $match: f },
      { $unwind: '$paiement.versements' },
      { $match: { 'paiement.versements.date': { $gte: du, $lte: au } } },
      { $group: { _id: '$paiement.versements.mode', montant: { $sum: '$paiement.versements.montant' }, n: { $sum: 1 } } },
      { $sort: { montant: -1 } },
    ]),
  ]);

  const parCle = new Map(res.serie.map((s) => [s._id, s]));
  const totaux = arrondir(res.totaux[0] ?? vide);
  return {
    du: jourLocal(du), au: jourLocal(au), granularite,
    totaux: { ...totaux, reste: r2(totaux.ca - totaux.encaisse), panierMoyen: totaux.colis ? r2(totaux.ca / totaux.colis) : 0 },
    precedent: arrondir(prec ?? vide),
    serie: periodes(du, au, granularite).map((k) => ({ periode: k, ...arrondir(parCle.get(k) ?? vide) })),
    destinations: res.destinations.map(({ _id, ...v }) => ({ code: _id, ...arrondir(v) })),
    depots: res.depots.map(({ _id, ...v }) => ({ code: _id, ...arrondir(v) })),
    statuts: Object.fromEntries(res.statuts.map((s) => [s._id, s.n])),
    modes: modes.map((m) => ({ mode: m._id ?? 'INCONNU', montant: r2(m.montant), n: m.n })),
  };
}
