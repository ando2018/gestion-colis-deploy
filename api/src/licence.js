// Jeton d'utilisation d'une entreprise (créé par la plateforme) : tant qu'il est valide, l'application est complète ;
// 7 jours avant l'échéance, l'application prévient ; une fois expiré, elle passe en consultation seule.
import crypto from 'node:crypto';
import { requete } from './noyau.js';

/** Jours avant l'échéance à partir desquels l'application demande le renouvellement. */
export const ALERTE_JOURS = 7;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Jeton aléatoire : LIC-XXXX-XXXX-XXXX-XXXX. */
export function nouveauJeton() {
  const t = new Uint32Array(16);
  crypto.getRandomValues(t);
  const c = [...t].map((v) => ALPHABET[v % ALPHABET.length]).join('');
  return `LIC-${c.match(/.{4}/g).join('-')}`;
}

/** Fin de journée (23:59:59) du jour donné. */
const finDeJour = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

/**
 * Échéance d'un nouveau jeton : date choisie (fin de journée), ou durée en mois à partir de l'échéance en cours
 * si elle n'est pas passée (renouvellement anticipé : rien n'est perdu), sinon d'aujourd'hui.
 */
export function echeance({ mois, expireLe }, actuelle) {
  if (expireLe) {
    const d = new Date(expireLe);
    if (Number.isNaN(d.getTime())) throw requete("Date d'échéance invalide");
    return finDeJour(d);
  }
  const n = Number(mois);
  if (!Number.isInteger(n) || n < 1 || n > 60) throw requete('Durée du jeton : de 1 à 60 mois');
  const depart = actuelle && new Date(actuelle) > new Date() ? new Date(actuelle) : new Date();
  const d = new Date(depart);
  d.setMonth(d.getMonth() + n);
  return finDeJour(d);
}

/** État d'un jeton : valide, bientôt expiré (moins de 7 jours), expiré ou absent, et jours restants. */
export function etatLicence(licence, maintenant = new Date()) {
  if (!licence?.expireLe) return { etat: 'absente', joursRestants: 0, expireLe: null };
  const ms = new Date(licence.expireLe) - maintenant;
  const joursRestants = Math.max(0, Math.ceil(ms / 86400000));
  const etat = ms <= 0 ? 'expiree' : joursRestants <= ALERTE_JOURS ? 'bientot' : 'valide';
  return { etat, joursRestants, expireLe: licence.expireLe };
}

export const licenceUtilisable = (licence) => ['valide', 'bientot'].includes(etatLicence(licence).etat);
