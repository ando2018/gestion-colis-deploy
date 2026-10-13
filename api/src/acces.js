// Accès aux comptes : code à 4 chiffres (application), mot de passe (plateforme), codes provisoires,
// changement avec double saisie et blocage après plusieurs échecs.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { ErreurMetier, requete } from './noyau.js';

/** Code de connexion des comptes de l'application : 4 chiffres. */
export const CODE_PIN = /^\d{4}$/;
/** Échecs consécutifs avant blocage, et durée du blocage (un code à 4 chiffres ne résiste pas sans cela). */
export const ESSAIS_MAX = 5;
export const BLOCAGE_MINUTES = 15;
/** Code des comptes de démonstration (mode démo uniquement). */
export const CODE_DEMO = () => (CODE_PIN.test(process.env.CODE_DEMO ?? '') ? process.env.CODE_DEMO : '1234');

/** Code trop facile à deviner : 4 fois le même chiffre ou suite (1234, 9876…). */
export function codeFaible(c) {
  if (/^(\d)\1{3}$/.test(c)) return true;
  const d = [...c].map(Number);
  const pas = d[1] - d[0];
  return Math.abs(pas) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === pas);
}

/** Code provisoire aléatoire (4 chiffres, jamais un code faible), à changer à la première connexion. */
export function codeProvisoire() {
  for (;;) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!codeFaible(c)) return c;
  }
}

const heure = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.FUSEAU ?? 'Europe/Paris' });
const bloque = (d) => new ErreurMetier(429, `Trop d'essais : compte bloqué jusqu'à ${heure(d)}. Réessayez plus tard ou demandez une réinitialisation.`, 'COMPTE_BLOQUE');

/**
 * Vérifie le mot de passe d'un compte (document Mongoose chargé avec +motDePasse). Après ESSAIS_MAX échecs,
 * le compte est bloqué BLOCAGE_MINUTES minutes. Un succès remet le compteur à zéro.
 */
export async function verifierAcces(compte, motDePasse, messageEchec) {
  if (compte?.bloqueJusqua && compte.bloqueJusqua > new Date()) throw bloque(compte.bloqueJusqua);
  const ok = !!compte && (await bcrypt.compare(String(motDePasse ?? ''), compte.motDePasse));
  if (!ok) {
    if (!compte) throw new ErreurMetier(401, messageEchec);
    compte.echecs = (compte.echecs ?? 0) + 1;
    if (compte.echecs >= ESSAIS_MAX) {
      compte.echecs = 0;
      compte.bloqueJusqua = new Date(Date.now() + BLOCAGE_MINUTES * 60000);
      await compte.save();
      throw bloque(compte.bloqueJusqua);
    }
    await compte.save();
    const restants = ESSAIS_MAX - compte.echecs;
    throw new ErreurMetier(401, restants <= 2 ? `${messageEchec} — encore ${restants} essai(s) avant blocage` : messageEchec);
  }
  if (compte.echecs || compte.bloqueJusqua) {
    compte.echecs = 0;
    compte.bloqueJusqua = null;
    await compte.save();
  }
}

/**
 * Nouveau mot de passe choisi par le titulaire : actuel vérifié, double saisie identique, différent de l'actuel.
 * pin : code à 4 chiffres (application), sinon mot de passe de 8 caractères au moins (plateforme).
 */
export async function changerAcces(compte, b, { pin }) {
  if (!(await bcrypt.compare(String(b?.actuel ?? ''), compte.motDePasse))) {
    throw requete(pin ? 'Code actuel incorrect' : 'Mot de passe actuel incorrect', 'ACTUEL_INCORRECT');
  }
  const nouveau = String(b?.nouveau ?? '');
  if (pin) {
    if (!CODE_PIN.test(nouveau)) throw requete('Le code doit faire exactement 4 chiffres');
    if (codeFaible(nouveau)) throw requete('Code trop simple (1111, 1234…) : choisissez-en un autre', 'CODE_FAIBLE');
  } else if (nouveau.length < 8) {
    throw requete('Le mot de passe doit faire au moins 8 caractères');
  }
  if (nouveau !== String(b?.confirmation ?? '')) throw requete('La confirmation ne correspond pas', 'CONFIRMATION');
  if (await bcrypt.compare(nouveau, compte.motDePasse)) throw requete(pin ? 'Le nouveau code doit être différent de l’actuel' : 'Le nouveau mot de passe doit être différent de l’actuel');
  compte.motDePasse = await bcrypt.hash(nouveau, 10);
  compte.mdpProvisoire = false;
  compte.echecs = 0;
  compte.bloqueJusqua = null;
  await compte.save();
}

/** Remplace le mot de passe par un code provisoire (à changer à la prochaine connexion) et débloque le compte. */
export async function poserCodeProvisoire(compte) {
  const code = codeProvisoire();
  compte.motDePasse = await bcrypt.hash(code, 10);
  compte.mdpProvisoire = true;
  compte.echecs = 0;
  compte.bloqueJusqua = null;
  await compte.save();
  return code;
}
