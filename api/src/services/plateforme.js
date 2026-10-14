// Gestion de la plateforme : création et suivi des entreprises clientes (page /plateforme, comptes dédiés).
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { AdminPlateforme, ParametresPlateforme, CODE_ENTREPRISE, Colis, Entreprise, normaliserCodeEntreprise, Parametres, ROLES, Utilisateur, Depot, Evenement } from '../modeles.js';
import { urlLogo } from './parametrage.js';
import { envoyerManuel, manuelPdf } from './manuel.js';
import { dansEntreprise, preparerBase } from '../locataire.js';
import { conflit, ErreurMetier, introuvable, lireJeton, oublierEntreprises, requete, signerPlateforme, texte } from '../noyau.js';
import { codeEntrepriseLibre, seedEntreprise } from '../seed.js';
import { changerAcces, codeProvisoire, poserCodeProvisoire, verifierAcces } from '../acces.js';
import { envoyerCodeProvisoire, normaliserSmtp, testerSmtp, vueSmtp } from '../courriel.js';
import { echeance, etatLicence, nouveauJeton } from '../licence.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const vueAdmin = (a) => ({ id: a._id, nom: a.nom, email: a.email, doitChangerMdp: !!a.mdpProvisoire });

export async function connexion(b) {
  const a = await AdminPlateforme.findOne({ email: texte(b?.email).toLowerCase(), actif: true }).select('+motDePasse');
  await verifierAcces(a, b?.motDePasse, 'E-mail ou mot de passe incorrect');
  return { jeton: signerPlateforme(a), administrateur: vueAdmin(a) };
}

// Mot de passe provisoire : seul le changement de mot de passe est permis.
const ACCES_PROVISOIRE = ['GET /moi', 'PUT /moi/mot-de-passe'];

/** Réservé aux comptes de la plateforme (un jeton d'entreprise ne passe pas). */
export async function authentifierPlateforme(req, _res, next) {
  try {
    const { sub, plateforme } = lireJeton(req);
    if (!plateforme) throw new ErreurMetier(401, 'Session expirée');
    const a = await AdminPlateforme.findOne({ _id: sub, actif: true }).lean();
    if (!a) throw new ErreurMetier(401, 'Compte inconnu ou désactivé');
    req.admin = vueAdmin(a);
    if (a.mdpProvisoire && !ACCES_PROVISOIRE.includes(`${req.method} ${req.path}`)) {
      throw new ErreurMetier(403, 'Choisissez d’abord votre mot de passe', 'MDP_A_CHANGER');
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Changement de son mot de passe : actuel, nouveau (8 caractères au moins) et confirmation. */
export async function changerMotDePasse(req, b) {
  const a = await AdminPlateforme.findById(req.admin.id).select('+motDePasse');
  await changerAcces(a, b, { pin: false });
  return { ok: true };
}

const contexte = (e) => ({ code: e.code, nom: e.nom, base: e.base });

/** Chiffres d'une entreprise, lus dans sa base. */
async function chiffres(e) {
  try {
    return await dansEntreprise(contexte(e), async () => {
      const [utilisateurs, admins, depots, colis, dernier, params] = await Promise.all([
        Utilisateur.countDocuments({ actif: true }), Utilisateur.countDocuments({ actif: true, role: ROLES.ADMIN }),
        Depot.countDocuments({ actif: true }), Colis.countDocuments({}), Evenement.findOne({}, { date: 1 }).sort({ date: -1 }).lean(),
        Parametres.findById('general', { logoMaj: 1 }).lean(),
      ]);
      return { utilisateurs, admins, depots, colis, derniereActivite: dernier?.date ?? null, logo: urlLogo(e.code, params?.logoMaj) };
    });
  } catch {
    return { utilisateurs: 0, admins: 0, depots: 0, colis: 0, derniereActivite: null, logo: null };
  }
}

const vueLicence = (l) => (l ? { jeton: l.jeton, debut: l.debut, expireLe: l.expireLe, creeLe: l.creeLe, par: l.par } : null);
const vue = async (e) => ({
  id: e._id, code: e.code, nom: e.nom, contact: e.contact, adresse: e.adresse, notes: e.notes, actif: e.actif,
  parDefaut: e.parDefaut, creeLe: e.createdAt, ...(await chiffres(e)),
  licence: e.licence ? { ...vueLicence(e.licence), ...etatLicence(e.licence) } : { ...etatLicence(null), jeton: null },
  licences: (e.licences ?? []).slice(0, 10).map(vueLicence),
});

/** Nouveau jeton d'une entreprise ; l'ancien passe dans l'historique. */
function poserLicence(e, b, admin) {
  const expireLe = echeance({ mois: b?.mois, expireLe: b?.expireLe }, e.licence?.expireLe);
  if (e.licence) e.licences = [e.licence, ...(e.licences ?? [])].slice(0, 50);
  e.licence = { jeton: nouveauJeton(), debut: new Date(), expireLe, creeLe: new Date(), par: admin?.email ?? '' };
}

/**
 * Nouveau jeton d'utilisation : durée en mois (prolonge l'échéance en cours si elle n'est pas passée)
 * ou date d'échéance précise (une date passée coupe l'accès complet tout de suite).
 */
export async function renouvelerLicence(id, b, admin) {
  const e = await trouver(id);
  poserLicence(e, b, admin);
  await e.save();
  oublierEntreprises();
  return vue(e.toObject());
}

export async function liste() {
  const l = await Entreprise.find().sort({ nom: 1 }).lean();
  return Promise.all(l.map(vue));
}

const champsLibres = (b) => ({
  nom: texte(b.nom),
  contact: { nom: texte(b.contact?.nom), email: texte(b.contact?.email).toLowerCase(), tel: texte(b.contact?.tel) },
  adresse: texte(b.adresse),
  notes: texte(b.notes),
});

function verifierAdmin(admin) {
  const email = texte(admin?.email).toLowerCase();
  if (!EMAIL.test(email)) throw requete("E-mail de l'administrateur invalide");
  return { email, nom: texte(admin?.nom) || 'Administrateur' };
}

/** Identifiant libre proposé pour une nouvelle entreprise. */
export const proposerCode = async () => ({ code: await codeEntrepriseLibre() });

/**
 * Nouvelle entreprise : identifiant unique XXX-XXX-XXX-XXX (généré s'il n'est pas fourni, sert à la connexion), base de données dédiée,
 * compte administrateur, réglages de départ (nom affiché = nom de l'entreprise) et modes de paiement usuels.
 */
export async function creer(b, origine, adminPf) {
  const code = texte(b?.code) ? normaliserCodeEntreprise(b.code) : await codeEntrepriseLibre();
  if (!CODE_ENTREPRISE.test(code)) throw requete('Identifiant invalide : format XXX-XXX-XXX-XXX (12 lettres ou chiffres, ex. 4K7-29Q-XM3-8PA)');
  const libres = champsLibres(b ?? {});
  if (!libres.nom) throw requete("Nom de l'entreprise obligatoire");
  const admin = { ...verifierAdmin(b?.admin), code: codeProvisoire() };
  if (await Entreprise.exists({ $or: [{ code }, { ancienCode: code }] })) throw conflit(`L'identifiant ${code} est déjà utilisé`, 'CODE_PRIS');
  const base = `gc_${code.toLowerCase().replace(/-/g, '_')}`;
  if ((await mongoose.connection.listDatabases().catch(() => ({ databases: [] }))).databases.some((d) => d.name === base) || (await Entreprise.exists({ base }))) {
    throw conflit(`Une base ${base} existe déjà : choisissez un autre identifiant`, 'CODE_PRIS');
  }
  // Jeton d'utilisation de départ (12 mois par défaut)
  const e = new Entreprise({ code, base, ...libres, actif: b?.actif !== false });
  poserLicence(e, { mois: b?.licenceMois ?? 12, expireLe: b?.licenceExpireLe }, adminPf);
  await e.save();
  try {
    await preparerBase(base);
    await dansEntreprise(contexte(e), () => seedEntreprise({ admin, nomApplication: libres.nom.slice(0, 40) }));
  } catch (err) {
    await Entreprise.deleteOne({ _id: e._id });
    await mongoose.connection.useDb(base).dropDatabase().catch(() => {});
    throw err;
  }
  oublierEntreprises();
  // Code provisoire de l'administrateur : envoyé par e-mail et renvoyé une seule fois (à transmettre si l'e-mail échoue).
  const mail = await dansEntreprise(contexte(e), () =>
    envoyerCodeProvisoire({ email: admin.email, nom: admin.nom, code: admin.code, motif: 'creation', origine, par: `Plateforme (${adminPf?.email ?? ''})` }));
  // Manuel d'utilisation PDF (lien avec l'identifiant, premiers pas, guide illustré) envoyé à l'administrateur
  const manuel = await envoyerManuel(e, { origine, par: `Plateforme (${adminPf?.email ?? ''})` });
  return { ...(await vue(e.toObject())), acces: { email: admin.email, codeProvisoire: admin.code, mail, manuel } };
}

async function trouver(id) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Entreprise introuvable');
  const e = await Entreprise.findById(id);
  if (!e) throw introuvable('Entreprise introuvable');
  return e;
}

/** Modification (l'identifiant ne change pas : il est imprimé dans les QR des palettes et connu des utilisateurs). */
export async function modifier(id, b) {
  const e = await trouver(id);
  const libres = champsLibres({ ...e.toObject(), ...b, contact: { ...e.contact, ...b?.contact } });
  if (!libres.nom) throw requete("Nom de l'entreprise obligatoire");
  Object.assign(e, libres);
  if (typeof b?.actif === 'boolean') e.actif = b.actif;
  await e.save();
  oublierEntreprises();
  return vue(e.toObject());
}

/** Crée un administrateur dans l'entreprise, ou réactive le compte et remplace son mot de passe s'il existe. */
export async function administrateur(id, b, origine) {
  const e = await trouver(id);
  const admin = verifierAdmin(b);
  return dansEntreprise(contexte(e), async () => {
    const existant = await Utilisateur.findOne({ email: admin.email }).select('+motDePasse');
    if (existant) {
      Object.assign(existant, { role: ROLES.ADMIN, depots: [], actif: true, ...(texte(b?.nom) ? { nom: admin.nom } : {}) });
      const code = await poserCodeProvisoire(existant);
      const mail = await envoyerCodeProvisoire({ email: admin.email, nom: existant.nom, code, motif: 'reinitialisation', origine, par: 'Plateforme' });
      return { email: admin.email, cree: false, codeProvisoire: code, mail };
    }
    const code = codeProvisoire();
    await Utilisateur.create({ email: admin.email, nom: admin.nom, role: ROLES.ADMIN, depots: [], motDePasse: await bcrypt.hash(code, 10), mdpProvisoire: true });
    const mail = await envoyerCodeProvisoire({ email: admin.email, nom: admin.nom, code, motif: 'creation', origine, par: 'Plateforme' });
    return { email: admin.email, cree: true, codeProvisoire: code, mail };
  });
}

/** Comptes de l'entreprise (lecture seule : ils se gèrent dans l'Administration de l'entreprise). */
export async function utilisateurs(id) {
  const e = await trouver(id);
  return dansEntreprise(contexte(e), () =>
    Utilisateur.find({}, { email: 1, nom: 1, role: 1, depots: 1, actif: 1, mdpProvisoire: 1, bloqueJusqua: 1 }).sort({ role: 1, email: 1 }).lean());
}

/** Code provisoire pour un compte de l'entreprise (réactivé et débloqué), à changer à sa prochaine connexion. */
export async function reinitialiserMotDePasse(id, uid, origine) {
  const e = await trouver(id);
  if (!mongoose.isValidObjectId(uid)) throw introuvable('Compte introuvable');
  return dansEntreprise(contexte(e), async () => {
    const u = await Utilisateur.findById(uid).select('+motDePasse');
    if (!u) throw introuvable('Compte introuvable');
    u.actif = true;
    const code = await poserCodeProvisoire(u);
    const mail = await envoyerCodeProvisoire({ email: u.email, nom: u.nom, code, motif: 'reinitialisation', origine, par: 'Plateforme' });
    return { email: u.email, nom: u.nom, role: u.role, codeProvisoire: code, mail };
  });
}

// ───────────── Serveur d'envoi des e-mails (commun à toutes les entreprises) ─────────────

export async function lireSmtp() {
  return vueSmtp((await ParametresPlateforme.findById('plateforme').lean())?.smtp);
}

export async function modifierSmtp(b) {
  const ancien = (await ParametresPlateforme.findById('plateforme').select('+smtp.motDePasse').lean())?.smtp ?? {};
  const smtp = normaliserSmtp(b, ancien);
  await ParametresPlateforme.updateOne({ _id: 'plateforme' }, { $set: { smtp } }, { upsert: true });
  return vueSmtp(smtp);
}

export async function testerSmtpPlateforme(b) {
  const ancien = (await ParametresPlateforme.findById('plateforme').select('+smtp.motDePasse').lean())?.smtp ?? {};
  return testerSmtp(normaliserSmtp({ ...b?.smtp, actif: true }, ancien), b?.a, 'Gestion des entreprises');
}

// ───────────── Manuel d'utilisation ─────────────

export async function telechargerManuel(id, origine) {
  return manuelPdf(await trouver(id), origine);
}

/** Renvoie le manuel PDF par e-mail (administrateurs de l'entreprise, ou adresses données). */
export async function renvoyerManuel(id, b, origine, adminPf) {
  return envoyerManuel(await trouver(id), { a: b?.a, origine, par: `Plateforme (${adminPf?.email ?? ''})` });
}
