import { FORMULAIRE, Formulaire, Destination } from '../modeles.js';
import { conflit, introuvable, pad, prochain, requete, texte } from '../noyau.js';

/**
 * Formulaires clients : le client saisit lui-même expéditeur et destinataire (borne, tablette, autre onglet),
 * puis la réception reprend ses informations et n'ajoute que les colis et le paiement.
 */
export async function creer(req, b) {
  const personne = (p, ...champs) => Object.fromEntries(champs.map((c) => [c, texte(p?.[c])]));
  const expediteur = personne(b.expediteur, 'nom', 'tel', 'email', 'pieceIdentite');
  const destinataire = personne(b.destinataire, 'nom', 'tel', 'adresse');
  const manque = [
    !expediteur.nom && 'votre nom', !expediteur.tel && 'votre téléphone',
    !destinataire.nom && 'le nom du destinataire', !destinataire.tel && 'le téléphone du destinataire',
  ].filter(Boolean);
  if (manque.length) throw requete(`Merci d'indiquer ${manque.join(', ')}`);
  let destination = texte(b.destination).toUpperCase();
  if (destination && !(await Destination.exists({ code: destination, actif: true }))) destination = '';
  // Numéro court à annoncer au comptoir, remis à zéro chaque jour et par dépôt (F-001, F-002…).
  const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const numero = `F-${pad(await prochain(`formulaire-${req.depot.code}-${jour}`), 3)}`;
  const f = await Formulaire.create({
    numero, depot: req.depot.code, expediteur, destinataire, destination, description: texte(b.description).slice(0, 300),
    creePar: req.user.nom,
  });
  return f.toObject();
}

/** Formulaires du dépôt, en attente par défaut (les plus anciens d'abord : ordre d'arrivée au comptoir). */
export function liste(req, q) {
  const statut = q.statut ? String(q.statut).split(',') : [FORMULAIRE.EN_ATTENTE];
  return Formulaire.find({ depot: req.depot.code, statut: { $in: statut } }).sort({ createdAt: 1 }).limit(100).lean();
}

export async function annuler(req, id) {
  const f = await Formulaire.findOneAndUpdate(
    { _id: id, depot: req.depot.code, statut: FORMULAIRE.EN_ATTENTE },
    { $set: { statut: FORMULAIRE.ANNULE, traitePar: req.user.nom, traiteLe: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!f) throw introuvable('Formulaire introuvable ou déjà traité');
  return f;
}

/** Appelé dans la transaction de réception : le formulaire est consommé par l'envoi. */
export async function utiliser(req, session, id, envoi) {
  if (!id) return;
  const f = await Formulaire.findOneAndUpdate(
    { _id: id, depot: req.depot.code, statut: FORMULAIRE.EN_ATTENTE },
    { $set: { statut: FORMULAIRE.UTILISE, envoi, traitePar: req.user.nom, traiteLe: new Date() } },
    { session },
  );
  if (!f) throw conflit('Ce formulaire client a déjà été utilisé ou annulé', 'FORMULAIRE_TRAITE');
}
