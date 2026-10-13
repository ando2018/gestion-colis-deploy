import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Compteur, Depot, Entreprise, Evenement, normaliserCodeEntreprise, ROLES, Utilisateur } from './modeles.js';
import { dansEntreprise } from './locataire.js';
import { developper128 } from './code128.js';

// ───────────── Erreurs ─────────────

export class ErreurMetier extends Error {
  constructor(status, message, code, donnees) {
    super(message);
    this.status = status;
    this.code = code;
    this.donnees = donnees;
  }
}
export const requete = (m, code, d) => new ErreurMetier(400, m, code, d);
export const interdit = (m = 'Accès refusé') => new ErreurMetier(403, m, 'INTERDIT');
export const introuvable = (m) => new ErreurMetier(404, m, 'INTROUVABLE');
export const conflit = (m, code, d) => new ErreurMetier(409, m, code ?? 'CONFLIT', d);

// ───────────── Outils ─────────────

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const texte = (v) => (v == null ? '' : String(v).trim());

/** Touche QWERTY (US) → caractère obtenu sur un poste AZERTY. Même table que web/src/app/core/douchette.ts. */
const QWERTY_VERS_AZERTY = [
  ['1', '&'], ['2', 'é'], ['3', '"'], ['4', "'"], ['5', '('], ['6', '-'], ['7', 'è'], ['8', '_'], ['9', 'ç'], ['0', 'à'],
  ['-', ')'], ['q', 'a'], ['w', 'z'], ['a', 'q'], [';', 'm'], ['z', 'w'], ['m', ','], [',', ';'], ['.', ':'], ['/', '!'],
  ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'], ['^', '6'], ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
  ['_', '°'], ['Q', 'A'], ['W', 'Z'], ['A', 'Q'], ['Z', 'W'], [':', 'M'], ['M', '?'], ['<', '.'], ['>', '/'], ['?', '§'],
];
const RETOUR_QWERTY = new Map(QWERTY_VERS_AZERTY.map(([us, fr]) => [fr, us]));
const RETOUR_AZERTY = new Map(QWERTY_VERS_AZERTY);
const CODE_VALIDE = /^([123]\d{7}|P-\d+|C-\d+|(?:PAL|CTN)-(?:[A-Z0-9]{2,6}-)?\d{6}-\d{4}|(?:COL|PAL|CTN)[A-Z]{2,6}\d{10}|COL-[A-Z0-9]{2,6}-\d{6}-\d{4}(?:-\d+\/\d+)?|[A-Z0-9]{2,6}-\d{6}-\d{4}(-\d+\/\d+)?|https?:\/\/[^\s/]+\/p\/[^\s/]+\/[^\s/]+)$/i;

/**
 * Douchette et poste réglés sur des claviers différents (« P)àààé » ou « http.>>locqlhost… ») :
 * on garde la lecture qui donne un vrai code. Le front corrige déjà ; ceci couvre les autres clients.
 */
function clavierCorrige(c) {
  if (!c || CODE_VALIDE.test(c)) return c;
  for (const table of [RETOUR_QWERTY, RETOUR_AZERTY]) {
    const converti = [...c].map((x) => table.get(x) ?? x).join('');
    if (CODE_VALIDE.test(converti)) return converti;
  }
  return c;
}

/**
 * Normalise un code scanné : majuscules, suffixe de pièce retiré (« ABJ-261009-0042-2/3 »),
 * URL de QR palette ramenée au numéro (« https://…/p/PAR/PAL-ABJ-121026-0007 » → « PAL-ABJ-121026-0007 »).
 */
export function codeScanne(brut) {
  let c = clavierCorrige(texte(brut));
  const url = c.match(/\/p\/[^/]+\/([^/?#]+)/i);
  if (url) c = decodeURIComponent(url[1]);
  return developper128(c.toUpperCase().replace(/-\d+\/\d+$/, ''));
}

/** Exécute fn dans une transaction MongoDB (rejouée automatiquement en cas de conflit). */
export function transaction(fn) {
  return mongoose.connection.transaction((session) => fn(session));
}

// ───────────── Authentification ─────────────

const secret = () => process.env.JWT_SECRET ?? 'dev-secret-a-changer';

/** Jeton d'un compte d'entreprise : l'identifiant de l'entreprise y est inscrit (ent). */
export const signer = (u, entreprise) => jwt.sign({ sub: String(u._id), ent: entreprise.code }, secret(), { expiresIn: '12h' });
/** Jeton d'un compte de gestion de la plateforme. */
export const signerPlateforme = (a) => jwt.sign({ sub: String(a._id), plateforme: true }, secret(), { expiresIn: '12h' });
export const lireJeton = (req) => {
  const jeton = req.get('authorization')?.replace(/^Bearer /, '');
  if (!jeton) throw new ErreurMetier(401, 'Non connecté');
  try {
    return jwt.verify(jeton, secret());
  } catch {
    throw new ErreurMetier(401, 'Session expirée');
  }
};

// Entreprises actives, gardées quelques secondes (une lecture par requête sinon). Vidé à chaque modification.
const cacheEntreprises = new Map();
export const oublierEntreprises = () => cacheEntreprises.clear();
/** Entreprise active par son identifiant (code), ou null. */
export async function entrepriseActive(code) {
  const c = normaliserCodeEntreprise(code);
  if (!c) return null;
  const memo = cacheEntreprises.get(c);
  if (memo && memo.expire > Date.now()) return memo.e;
  const e = await Entreprise.findOne({ $or: [{ code: c }, { ancienCode: c }], actif: true }, { code: 1, nom: 1, base: 1, parDefaut: 1, licence: 1 }).lean();
  const v = e ? { id: e._id, code: e.code, nom: e.nom, base: e.base, parDefaut: !!e.parDefaut, licence: e.licence ?? null } : null;
  cacheEntreprises.set(c, { e: v, expire: Date.now() + 15000 });
  return v;
}

/**
 * Vérifie le jeton et fixe le dépôt de travail (req.depot) : l'en-tête X-Depot,
 * qui doit faire partie des dépôts autorisés (l'admin a accès à tous).
 * Un dépôt mémorisé par le navigateur qui n'existe plus (ou désactivé) ne bloque pas l'admin :
 * il continue en « tous les dépôts » et l'en-tête X-Depot-Invalide prévient le front.
 */
export async function authentifier(req, res, next) {
  try {
    const { sub, ent, plateforme } = lireJeton(req);
    if (plateforme || !ent) throw new ErreurMetier(401, 'Session expirée');
    const entreprise = await entrepriseActive(ent);
    if (!entreprise) throw new ErreurMetier(401, 'Entreprise inconnue ou désactivée');
    req.entreprise = entreprise;
    // La suite de la requête (et tous ses accès à la base) se déroule dans la base de l'entreprise.
    dansEntreprise(entreprise, () => suiteAuthentification(req, res, next, sub));
  } catch (e) {
    next(e);
  }
}

async function suiteAuthentification(req, res, next, sub) {
  try {
    const u = await Utilisateur.findOne({ _id: sub, actif: true }).lean();
    if (!u) throw new ErreurMetier(401, 'Compte inconnu ou désactivé');
    req.user = { id: u._id, nom: u.nom, email: u.email, role: u.role, depots: u.depots, doitChangerMdp: !!u.mdpProvisoire };

    const demande = texte(req.get('x-depot')).toUpperCase();
    const admin = u.role === ROLES.ADMIN;
    const code = demande || (!admin && u.depots.length === 1 ? u.depots[0] : '');
    if (code) {
      if (!admin && !u.depots.includes(code)) throw interdit(`Dépôt ${code} non autorisé pour ce compte`);
      req.depot = await Depot.findOne({ code, actif: true }).lean();
      if (!req.depot) {
        if (!admin) throw requete(`Dépôt ${code} inconnu ou inactif`, 'DEPOT_INCONNU');
        res.set('X-Depot-Invalide', code);
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Rôles autorisés (l'admin passe toujours). */
export const exiger = (...roles) => (req, _res, next) =>
  next(req.user.role === ROLES.ADMIN || roles.includes(req.user.role) ? undefined : interdit());

/** Les opérations de terrain se font dans un dépôt choisi. */
export const avecDepot = (req, _res, next) => next(req.depot ? undefined : requete('Choisissez un dépôt', 'DEPOT_REQUIS'));

/** Filtre de lecture : dépôt choisi, sinon dépôts autorisés (tous pour l'admin). */
export function filtreDepot(req) {
  if (req.depot) return { depot: req.depot.code };
  return req.user.role === ROLES.ADMIN ? {} : { depot: { $in: req.user.depots } };
}

// ───────────── Journal et numérotation ─────────────

/** Écrit un ou plusieurs événements (dans la transaction en cours si session). */
export function journaliser(req, session, type, evts) {
  const liste = (Array.isArray(evts) ? evts : [evts]).map((e) => ({
    type,
    utilisateurId: req.user.id,
    utilisateurNom: req.user.nom,
    utilisateurRole: req.user.role,
    depot: e.depot ?? req.depot?.code,
    date: new Date(),
    ...e,
  }));
  if (!liste.length) return;
  return Evenement.insertMany(liste, { session });
}

export const evtColis = (c, extra = {}) => ({ entite: 'colis', entiteId: c._id, numero: c.numero, depot: c.depot, ...extra });
export const evtPalette = (p, extra = {}) => ({ entite: 'palette', entiteId: p._id, numero: p.numero, depot: p.depot, ...extra });
export const evtConteneur = (c, extra = {}) => ({ entite: 'conteneur', entiteId: c._id, numero: c.numero, depot: c.depot, ...extra });

export async function prochain(cle, session) {
  const c = await Compteur.findOneAndUpdate({ _id: cle }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
  return c.seq;
}

export const pad = (n, l = 4) => String(n).padStart(l, '0');

/** Préfixe du code-barres numérique selon le type. */
export const TYPES_CODE_COURT = { colis: '1', palette: '2', conteneur: '3' };
/** Code-barres numérique court : 8 chiffres, le premier donne le type (10000001, 20000001, 30000001). */
export async function codeCourt(type, session) {
  return `${TYPES_CODE_COURT[type]}${pad(await prochain(`code-${type}`, session), 7)}`;
}
export const estCodeCourt = (v) => /^[123]\d{7}$/.test(String(v ?? '').trim());

/** AAMMJJ dans le fuseau du site (TZ, Europe/Paris par défaut). */
/** Date du jour en JJMMAA (numéros de palette et de conteneur : PAL-ABJ-121026-0001, CTN-ABJ-121026-0001). */
export function jjmmaa(d = new Date()) {
  const a = aammjj(d);
  return `${a.slice(4, 6)}${a.slice(2, 4)}${a.slice(0, 2)}`;
}

export function aammjj(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: process.env.FUSEAU ?? 'Europe/Paris', year: '2-digit', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}`;
}
