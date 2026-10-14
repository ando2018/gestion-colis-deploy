import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { AdminPlateforme, CODE_ENTREPRISE, Colis, CONTENEUR, Conteneur, Depot, Destination, Entreprise, ModePaiement, normaliserCodeEntreprise, Palette, PALETTE, Parametres, ROLES, Utilisateur } from './modeles.js';
import { dansEntreprise, preparerBase } from './locataire.js';
import { codeCourt } from './noyau.js';
import { CODE_DEMO, codeProvisoire } from './acces.js';
import { echeance, nouveauJeton } from './licence.js';

/** Identifiant de l'entreprise des données existantes (base principale), au format XXX-XXX-XXX-XXX. */
export const ENTREPRISE_DEFAUT = () => normaliserCodeEntreprise(process.env.ENTREPRISE_DEFAUT ?? 'DEM-000-000-001');

const MODES_PAIEMENT = [
  ['ESPECES', 'Espèces'], ['CARTE', 'Carte'], ['VIREMENT', 'Virement'], ['MOBILE_MONEY', 'Mobile money'], ['A_DESTINATION', 'Paiement à destination'],
];

/**
 * Démarrage : compte de gestion de la plateforme, entreprise par défaut (elle garde la base principale, donc les
 * données d'avant le multi-entreprise), puis pour chaque entreprise ses index, ses rattrapages et son premier admin.
 * Avec demo, l'entreprise par défaut reçoit le paramétrage d'exemple du scénario.
 */
export async function seed({ demo = false } = {}) {
  if (!(await AdminPlateforme.exists({}))) {
    const email = (process.env.PLATEFORME_EMAIL ?? 'plateforme@colis.local').toLowerCase();
    const motDePasse = process.env.PLATEFORME_MOT_DE_PASSE ?? 'Colis2026!';
    // Hors démo : mot de passe initial provisoire, à changer à la première connexion.
    await AdminPlateforme.create({ email, nom: 'Gestion de la plateforme', motDePasse: await bcrypt.hash(motDePasse, 10), mdpProvisoire: !demo });
    console.log(`Plateforme : compte ${email} — mot de passe ${motDePasse}${demo ? '' : ' (provisoire)'} (page /plateforme)`);
  }
  if (!(await Entreprise.exists({ parDefaut: true }))) {
    const code = ENTREPRISE_DEFAUT();
    const base = mongoose.connection.name;
    await Entreprise.updateOne({ code }, { $setOnInsert: { code, nom: demo ? 'Entreprise démo' : code, base, parDefaut: true } }, { upsert: true });
    console.log(`Entreprise par défaut : ${code} (base ${base})`);
  }
  // Rattrapage : identifiants d'avant le format XXX-XXX-XXX-XXX (ex. DEMO). L'ancien reste accepté (sessions, QR imprimés).
  for (const e of await Entreprise.find({ code: { $not: CODE_ENTREPRISE } }).lean()) {
    const code = e.parDefaut && !(await Entreprise.exists({ code: ENTREPRISE_DEFAUT() })) ? ENTREPRISE_DEFAUT() : await codeEntrepriseLibre();
    await Entreprise.updateOne({ _id: e._id }, { $set: { code, ancienCode: e.code } });
    console.log(`Entreprise ${e.code} : nouvel identifiant ${code}`);
  }
  // Rattrapage : entreprises d'avant les jetons d'utilisation → jeton de 12 mois (pas de blocage surprise).
  for (const e of await Entreprise.find({ licence: null }, { code: 1 }).lean()) {
    const expireLe = echeance({ mois: 12 });
    await Entreprise.updateOne({ _id: e._id }, { $set: { licence: { jeton: nouveauJeton(), debut: new Date(), expireLe, creeLe: new Date(), par: 'démarrage' } } });
    console.log(`Entreprise ${e.code} : jeton d'utilisation jusqu'au ${expireLe.toLocaleDateString('fr-FR')}`);
  }
  for (const e of await Entreprise.find().lean()) {
    await preparerBase(e.base);
    await dansEntreprise({ code: e.code, nom: e.nom, base: e.base }, () => seedEntreprise({ demo: demo && e.parDefaut }));
  }
}

/** Caractères des identifiants générés : sans O/0 ni I/1, faciles à lire et à dicter. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Identifiant d'entreprise aléatoire et libre, au format XXX-XXX-XXX-XXX. */
export async function codeEntrepriseLibre() {
  for (;;) {
    const c = Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('').match(/.{3}/g).join('-');
    if (!(await Entreprise.exists({ $or: [{ code: c }, { ancienCode: c }] }))) return c;
  }
}

/**
 * Pour l'entreprise courante : réglages, rattrapages de données, premier admin (celui fourni à la création
 * de l'entreprise, sinon ADMIN_EMAIL) et, avec demo, le paramétrage d'exemple du scénario.
 */
export async function seedEntreprise({ demo = false, admin = null, nomApplication = null } = {}) {
  // Comptes de démonstration : code connu (1234). Sinon code provisoire, à changer à la première connexion.
  const compte = async (email, nom, role, depots = [], code = demo ? CODE_DEMO() : codeProvisoire()) => {
    if (await Utilisateur.exists({ email })) return;
    await Utilisateur.create({ email, nom, role, depots, motDePasse: await bcrypt.hash(code, 10), mdpProvisoire: !demo });
    if (!admin) console.log(`Compte ${email} (${role}) — code ${code}${demo ? '' : ' (provisoire)'}`);
  };
  await Parametres.updateOne({ _id: 'general' }, { $setOnInsert: { _id: 'general', ...(nomApplication ? { nomApplication } : {}) } }, { upsert: true });
  // Rattrapage : palettes restées « Chargée » alors que leur conteneur est déjà parti (avant le statut PARTIE).
  const partis = await Conteneur.find({ statut: { $in: [CONTENEUR.PARTI, CONTENEUR.ARRIVE] } }, { _id: 1 }).lean();
  if (partis.length) {
    const r = await Palette.updateMany({ conteneurId: { $in: partis.map((c) => c._id) }, statut: PALETTE.CHARGEE }, { $set: { statut: PALETTE.PARTIE } });
    if (r.modifiedCount) console.log(`${r.modifiedCount} palette(s) passée(s) en « Partie »`);
  }
  // Rattrapage : code-barres numérique pour les colis, palettes et conteneurs créés avant son introduction.
  for (const [modele, type] of [[Colis, 'colis'], [Palette, 'palette'], [Conteneur, 'conteneur']]) {
    const sansCode = await modele.find({ code: { $in: [null, ''] } }, { _id: 1 }).sort({ createdAt: 1, _id: 1 }).lean();
    for (const x of sansCode) await modele.updateOne({ _id: x._id }, { $set: { code: await codeCourt(type) } });
    if (sansCode.length) console.log(`${sansCode.length} ${type} : code-barres numérique attribué`);
  }
  // Rattrapage : place de chaque colis dans son envoi (colis 1/2, 2/2…) pour les colis d'avant ce champ
  const envois = await Colis.distinct('envoi', { nbEnvoi: { $exists: false }, envoi: { $ne: null } });
  for (const envoi of envois) {
    const liste = await Colis.find({ envoi }, { _id: 1 }).sort({ numero: 1 }).lean();
    await Colis.bulkWrite(liste.map((c, i) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { rangEnvoi: i + 1, nbEnvoi: liste.length } } } })));
  }
  if (envois.length) console.log(`${envois.length} envoi(s) : place des colis renseignée`);
  const upsert = (modele, code, valeurs) => modele.updateOne({ code }, { $setOnInsert: { code, ...valeurs } }, { upsert: true });
  if (admin) {
    // Nouvelle entreprise : son administrateur et les modes de paiement usuels (modifiables dans Administration).
    await compte(admin.email.toLowerCase().trim(), admin.nom || 'Administrateur', ROLES.ADMIN, [], admin.code);
    for (const [code, libelle] of MODES_PAIEMENT) await upsert(ModePaiement, code, { libelle });
  } else if (!(await Utilisateur.exists({ role: ROLES.ADMIN }))) {
    await compte(process.env.ADMIN_EMAIL ?? 'admin@colis.local', 'Administrateur', ROLES.ADMIN);
  }
  if (!demo) return;

  await upsert(Depot, 'PAR', { nom: 'Dépôt Paris', adresse: 'Choisy-le-Roi', prefixe: 'PAR', imprimante: { port: 9100, largeurMm: 100, hauteurMm: 150, dpi: 203 } });
  await upsert(Destination, 'ABJ', { pays: "Côte d'Ivoire", ville: 'Abidjan', tarifKg: 3.6, delaiJours: 35 });
  await upsert(Destination, 'DKR', { pays: 'Sénégal', ville: 'Dakar', tarifKg: 3.2, delaiJours: 25 });
  for (const [code, libelle] of MODES_PAIEMENT) await upsert(ModePaiement, code, { libelle });
  await compte('reception@colis.local', 'Agent réception', ROLES.RECEPTION, ['PAR']);
  await compte('cariste@colis.local', 'Cariste', ROLES.CARISTE, ['PAR']);
  await compte('quai@colis.local', 'Chef de quai', ROLES.CHEF_QUAI, ['PAR']);
  await compte('client@colis.local', 'Borne client', ROLES.CLIENT, ['PAR']);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/gestion-colis?replicaSet=rs0');
  await mongoose.syncIndexes();
  await seed({ demo: process.argv.includes('--demo') });
  await mongoose.disconnect();
}
