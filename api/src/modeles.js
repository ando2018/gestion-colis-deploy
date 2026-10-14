import mongoose from 'mongoose';
import { modeleEntreprise } from './locataire.js';

const { Schema, model } = mongoose;
const opts = { timestamps: true, versionKey: false };

// ───────────── Constantes métier ─────────────

/** CLIENT : compte de borne / tablette, n'accède qu'au formulaire client de son dépôt. */
export const ROLES = { ADMIN: 'ADMIN', RECEPTION: 'RECEPTION', CARISTE: 'CARISTE', CHEF_QUAI: 'CHEF_QUAI', CLIENT: 'CLIENT' };

export const COLIS = {
  RECU: 'RECU',
  SUR_PALETTE: 'SUR_PALETTE',
  ZONE_DEPART: 'ZONE_DEPART',
  CHARGE: 'CHARGE',
  PARTI: 'PARTI',
  RELIQUAT: 'RELIQUAT',
  ANNULE: 'ANNULE',
};
/** PARTIE : son conteneur est parti, avec tous les colis restés dessus. */
export const PALETTE = { OUVERTE: 'OUVERTE', FERMEE: 'FERMEE', ZONE_DEPART: 'ZONE_DEPART', CHARGEE: 'CHARGEE', PARTIE: 'PARTIE' };
export const CONTENEUR = { EN_CHARGEMENT: 'EN_CHARGEMENT', CHARGE: 'CHARGE', PARTI: 'PARTI', ARRIVE: 'ARRIVE' };
export const FORMULAIRE = { EN_ATTENTE: 'EN_ATTENTE', UTILISE: 'UTILISE', ANNULE: 'ANNULE' };
export const PAIEMENT = { PAYE: 'PAYE', PARTIEL: 'PARTIEL', A_DESTINATION: 'A_DESTINATION' };
export const MODE_A_DESTINATION = 'A_DESTINATION';

export const EVENEMENTS = [
  'RECEPTION', 'PAIEMENT', 'MODIFICATION_MONTANT', 'AJOUT_PALETTE', 'RETRAIT_PALETTE', 'CREATION_PALETTE',
  'PALETTE_FERMEE', 'PALETTE_ROUVERTE', 'SUPPRESSION_PALETTE', 'ZONE_DEPART', 'SORTIE_ZONE_DEPART', 'CREATION_CONTENEUR', 'PREVU_CONTENEUR', 'HORS_MANIFESTE',
  'CHARGE', 'DEROGATION', 'RETOUR_DEPOT', 'RETRAIT_CONTENEUR', 'CONTENEUR_PARTI', 'CONTENEUR_ARRIVE', 'ANNULATION', 'REIMPRESSION',
  'IMPRESSION', 'PARAMETRAGE',
];

// ───────────── Paramétrage ─────────────

export const DPI_POSSIBLES = [152, 203, 300, 600];
export const TYPES_IMPRIMANTE = ['ZEBRA', 'POS', 'A4'];
export const ETIQUETTES_PAR_PAGE = [1, 4];
export const LARGEURS_POS = [58, 80];
/** Code imprimé sur les étiquettes et affiché à l'écran : QR code ou code-barres (Code 128). */
export const TYPES_CODE = ['QR', 'CODE_BARRE'];
const Imprimante = new Schema(
  { hote: { type: String, default: '' }, port: { type: Number, default: 9100, min: 1, max: 65535 },
    largeurMm: { type: Number, default: 100, min: 20 }, hauteurMm: { type: Number, default: 150, min: 20 },
    dpi: { type: Number, default: 203, enum: DPI_POSSIBLES },
    // ZEBRA : étiquettes ZPL 100×150 mm ; POS : tickets thermiques ESC/POS sur rouleau de 58 ou 80 mm ;
    // A4 : imprimante standard, étiquettes imprimées par le navigateur sur feuilles A4.
    type: { type: String, enum: TYPES_IMPRIMANTE, default: 'ZEBRA' },
    largeurPapier: { type: Number, enum: LARGEURS_POS, default: 80 },
    // A4 : imprimante de bureau, étiquettes imprimées par le navigateur, 1 ou 4 par feuille.
    etiquettesParPage: { type: Number, enum: ETIQUETTES_PAR_PAGE, default: 4 } },
  { _id: false },
);

export const Depot = modeleEntreprise('Depot', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  nom: { type: String, required: true, trim: true },
  adresse: { type: String, default: '' },
  prefixe: { type: String, uppercase: true, trim: true, default: '' }, // ancien préfixe de numérotation, conservé pour mémoire
  imprimante: { type: Imprimante, default: () => ({}) },
  actif: { type: Boolean, default: true },
}, opts), 'depots');

export const Destination = modeleEntreprise('Destination', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  pays: { type: String, required: true },
  ville: { type: String, required: true },
  tarifKg: { type: Number, required: true, min: 0 },
  delaiJours: { type: Number, default: 0 },
  actif: { type: Boolean, default: true },
}, opts), 'destinations');

export const ModePaiement = modeleEntreprise('ModePaiement', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  libelle: { type: String, required: true },
  depotsAutorises: { type: [String], default: [] }, // vide = tous les dépôts
  actif: { type: Boolean, default: true },
}, opts), 'modesPaiement');

/** Serveur d'envoi des e-mails (codes provisoires). Le mot de passe n'est jamais renvoyé à l'écran. */
const Smtp = new Schema({
  actif: { type: Boolean, default: false },
  hote: { type: String, default: '' },
  port: { type: Number, default: 587, min: 1, max: 65535 },
  securite: { type: String, enum: ['STARTTLS', 'SSL', 'AUCUNE'], default: 'STARTTLS' },
  utilisateur: { type: String, default: '' },
  motDePasse: { type: String, default: '', select: false },
  expediteur: { type: String, default: '' },
  expediteurNom: { type: String, default: '' },
  certificatNonVerifie: { type: Boolean, default: false },
}, { _id: false });

/** Document unique (_id « general ») : réglages globaux. */
export const Parametres = modeleEntreprise('Parametres', new Schema({
  _id: { type: String, default: 'general' },
  paletteMaxKg: { type: Number, default: 800 },
  typesConteneur: {
    type: [{ _id: false, code: String, poidsMaxKg: Number }],
    default: () => [
      { code: "20'", poidsMaxKg: 21700 },
      { code: "40'", poidsMaxKg: 26500 },
      { code: "40' HC", poidsMaxKg: 26000 },
    ],
  },
  reliquatAlerteReports: { type: Number, default: 2 },
  reliquatAlerteJours: { type: Number, default: 7 },
  bloquerPartielAuChargement: { type: Boolean, default: true },
  urlPublique: { type: String, default: 'http://localhost:3001' },
  typeCode: { type: String, enum: TYPES_CODE, default: 'QR' },
  /** Nom affiché sur toutes les pages, les reçus et les étiquettes (remplace « Gestion colis »). */
  nomApplication: { type: String, default: 'Gestion colis', trim: true, maxlength: 40 },
  /** Logo de l'entreprise (image en data URL), lu seulement par GET /api/logo/<entreprise> ; logoMaj sert de version. */
  logo: { type: String, default: '', select: false },
  logoMaj: { type: Date, default: null },
  /** SMTP propre à l'entreprise (sinon celui de la plateforme). */
  smtp: { type: Smtp, default: () => ({}) },
}, { ...opts, _id: false }), 'parametres');

/** Formulaire rempli par le client (expéditeur, destinataire), repris ensuite par la réception. */
export const Formulaire = modeleEntreprise('Formulaire', new Schema({
  numero: { type: String, required: true },
  depot: { type: String, required: true },
  expediteur: { nom: String, tel: String, email: { type: String, default: '' }, pieceIdentite: { type: String, default: '' } },
  destinataire: { nom: String, tel: String, adresse: { type: String, default: '' } },
  destination: { type: String, default: '' },
  description: { type: String, default: '' },
  statut: { type: String, enum: Object.values(FORMULAIRE), default: FORMULAIRE.EN_ATTENTE },
  creePar: String,
  envoi: { type: String, default: null },
  traitePar: String,
  traiteLe: Date,
}, { timestamps: true }).index({ depot: 1, statut: 1, createdAt: 1 }), 'formulaires');

export const Utilisateur = modeleEntreprise('Utilisateur', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  nom: { type: String, required: true, trim: true },
  motDePasse: { type: String, required: true, select: false }, // code à 4 chiffres (haché)
  /** Code provisoire (création, réinitialisation) : à changer à la prochaine connexion. */
  mdpProvisoire: { type: Boolean, default: false },
  echecs: { type: Number, default: 0 }, // échecs de connexion consécutifs
  bloqueJusqua: { type: Date, default: null }, // blocage après trop d'échecs
  role: { type: String, enum: Object.values(ROLES), required: true },
  depots: { type: [String], default: [] }, // codes des dépôts autorisés (ignoré pour l'admin)
  actif: { type: Boolean, default: true },
}, opts), 'utilisateurs');

// ───────────── Flux ─────────────

const Personne = { nom: { type: String, default: '' }, tel: { type: String, default: '' } };

export const Colis = modeleEntreprise('Colis', new Schema({
  numero: { type: String, required: true, unique: true },
  /** Code-barres : 8 chiffres (1 = colis, 2 = palette, 3 = conteneur), court donc imprimé avec des barres larges. */
  code: { type: String, unique: true, sparse: true },
  envoi: { type: String, default: null, index: true }, // numéro du premier colis de l'envoi (C1, C2… même expéditeur et destinataire)
  /** Place du colis dans son envoi : colis 1/2, 2/2… (étiquette, suivi). */
  rangEnvoi: { type: Number, default: 1 },
  nbEnvoi: { type: Number, default: 1 },
  depot: { type: String, required: true },
  destination: { type: String, required: true },
  expediteur: { ...Personne, pieceIdentite: { type: String, default: '' } },
  destinataire: { ...Personne, adresse: { type: String, default: '' } },
  description: { type: String, default: '' },
  nbPieces: { type: Number, default: 1, min: 1 },
  poidsKg: { type: Number, required: true, min: 0.01 },
  dimensions: { type: String, default: '' },
  valeurDeclaree: { type: Number, default: 0 },
  options: { type: [{ _id: false, libelle: String, montant: Number }], default: [] },
  montantCalcule: { type: Number, required: true },
  montant: { type: Number, required: true },
  motifMontant: { type: String, default: '' },
  paiement: {
    mode: String,
    statut: { type: String, enum: Object.values(PAIEMENT) },
    recu: { type: Number, default: 0 },
    reference: { type: String, default: '' },
    versements: { type: [{ _id: false, mode: String, montant: Number, reference: String, date: Date, par: String }], default: [] },
  },
  statut: { type: String, enum: Object.values(COLIS), default: COLIS.RECU },
  statutAvantChargement: String, // pour annuler une validation de chargement
  priorite: { type: Number, default: 0 },
  nbReports: { type: Number, default: 0 },
  paletteId: { type: Schema.Types.ObjectId, ref: 'Palette', default: null },
  conteneurId: { type: Schema.Types.ObjectId, ref: 'Conteneur', default: null },
  dateReception: { type: Date, default: Date.now },
  motifAnnulation: String,
}, opts).index({ destination: 1, statut: 1, priorite: -1, dateReception: 1 }).index({ depot: 1, statut: 1 })
  .index({ paletteId: 1 }).index({ conteneurId: 1 }).index({ 'destinataire.tel': 1 }).index({ 'expediteur.tel': 1 }), 'colis');

export const Palette = modeleEntreprise('Palette', new Schema({
  numero: { type: String, required: true },
  /** Code-barres : 8 chiffres (1 = colis, 2 = palette, 3 = conteneur), court donc imprimé avec des barres larges. */
  code: { type: String, unique: true, sparse: true },
  depot: { type: String, required: true },
  destination: { type: String, required: true },
  statut: { type: String, enum: Object.values(PALETTE), default: PALETTE.OUVERTE },
  poidsMaxKg: { type: Number, required: true },
  colisIds: { type: [Schema.Types.ObjectId], default: [] }, // copie d'affichage ; colis.paletteId fait foi
  poidsTotal: { type: Number, default: 0 },
  nbColis: { type: Number, default: 0 },
  priorite: { type: Number, default: 0 }, // max des priorités de ses colis
  dateReceptionMin: Date, // plus ancien colis : tri FIFO
  conteneurId: { type: Schema.Types.ObjectId, ref: 'Conteneur', default: null },
}, opts).index({ depot: 1, numero: 1 }, { unique: true }).index({ destination: 1, statut: 1 }), 'palettes');

export const Conteneur = modeleEntreprise('Conteneur', new Schema({
  numero: { type: String, required: true, unique: true },
  /** Code-barres : 8 chiffres (1 = colis, 2 = palette, 3 = conteneur), court donc imprimé avec des barres larges. */
  code: { type: String, unique: true, sparse: true },
  numeroOfficiel: { type: String, default: '' },
  scelle: { type: String, default: '' },
  depot: { type: String, required: true },
  destination: { type: String, required: true },
  type: { type: String, required: true },
  poidsMaxKg: { type: Number, required: true },
  statut: { type: String, enum: Object.values(CONTENEUR), default: CONTENEUR.EN_CHARGEMENT },
  paletteIds: { type: [Schema.Types.ObjectId], default: [] },
  nbColis: { type: Number, default: 0 },
  poidsTotal: { type: Number, default: 0 },
  dateChargement: Date,
  dateDepart: Date,
  dateArrivee: Date,
}, opts).index({ depot: 1, statut: 1 }), 'conteneurs');

/** E-mails envoyés (ou tentés) par l'application : copie exacte du message, onglet Administration → Messages. */
export const Message = modeleEntreprise('Message', new Schema({
  date: { type: Date, default: Date.now },
  a: { type: String, required: true },
  destinataireNom: { type: String, default: '' },
  sujet: { type: String, default: '' },
  texte: { type: String, default: '' },
  html: { type: String, default: '' },
  motif: { type: String, enum: ['creation', 'reinitialisation', 'test', 'manuel'], required: true },
  piecesJointes: { type: [String], default: [] },
  envoye: { type: Boolean, default: false },
  erreur: { type: String, default: '' },
  par: { type: String, default: '' }, // qui a déclenché l'envoi (admin de l'entreprise ou plateforme)
  serveur: { type: String, default: '' }, // SMTP utilisé (hôte:port)
}, { versionKey: false }).index({ date: -1 }).index({ a: 1, date: -1 }), 'messages');

/** Historique en écriture seule : jamais modifié ni supprimé. */
export const Evenement = modeleEntreprise('Evenement', new Schema({
  type: { type: String, enum: EVENEMENTS, required: true },
  entite: { type: String, enum: ['colis', 'palette', 'conteneur', 'parametrage'], required: true },
  entiteId: { type: Schema.Types.ObjectId, default: null },
  numero: String,
  utilisateurId: Schema.Types.ObjectId,
  utilisateurNom: String,
  utilisateurRole: String, // profil au moment de l'action
  depot: String,
  avant: Schema.Types.Mixed,
  apres: Schema.Types.Mixed,
  motif: String,
  details: Schema.Types.Mixed,
  date: { type: Date, default: Date.now },
}, { versionKey: false }).index({ entiteId: 1, date: 1 }).index({ type: 1, date: -1 }).index({ depot: 1, date: -1 }), 'evenements');

export const Compteur = modeleEntreprise('Compteur', new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false }), 'compteurs');

// ───────────── Plateforme (base principale, commune à toutes les entreprises) ─────────────

const JetonLicence = new Schema({
  jeton: { type: String, required: true },
  debut: { type: Date, required: true },
  expireLe: { type: Date, required: true },
  creeLe: { type: Date, default: Date.now },
  par: { type: String, default: '' }, // compte de la plateforme qui l'a créé
}, { _id: false });

/** Entreprise cliente : son identifiant (code) sert à la connexion, ses données vivent dans sa propre base. */
/** Identifiant d'entreprise : XXX-XXX-XXX-XXX (12 lettres majuscules ou chiffres). */
export const CODE_ENTREPRISE = /^[A-Z0-9]{3}(?:-[A-Z0-9]{3}){3}$/;
/** Saisie libre (minuscules, espaces, sans tirets…) ramenée au format XXX-XXX-XXX-XXX ; autre chose reste tel quel. */
export function normaliserCodeEntreprise(v) {
  const brut = String(v ?? '').toUpperCase().trim();
  const c = brut.replace(/[^A-Z0-9]/g, '');
  return c.length === 12 ? c.match(/.{3}/g).join('-') : brut;
}
export const Entreprise = model('Entreprise', new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: CODE_ENTREPRISE },
  nom: { type: String, required: true, trim: true, maxlength: 80 },
  base: { type: String, required: true, unique: true }, // base MongoDB de l'entreprise
  ancienCode: { type: String, default: null }, // identifiant d'avant le format XXX-XXX-XXX-XXX (sessions et QR déjà imprimés)
  contact: { nom: { type: String, default: '' }, email: { type: String, default: '' }, tel: { type: String, default: '' } },
  adresse: { type: String, default: '' },
  notes: { type: String, default: '' },
  actif: { type: Boolean, default: true },
  parDefaut: { type: Boolean, default: false }, // entreprise des données existantes (anciennes adresses /p/<dépôt>/…)
  /** Jeton d'utilisation en cours : l'application est complète jusqu'à expireLe, en consultation seule ensuite. */
  licence: { type: JetonLicence, default: null },
  /** Jetons précédents (renouvellements), du plus récent au plus ancien. */
  licences: { type: [JetonLicence], default: [] },
}, opts), 'entreprises');

/** Compte de gestion de la plateforme (création et suivi des entreprises), distinct des comptes des entreprises. */
export const AdminPlateforme = model('AdminPlateforme', new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  nom: { type: String, required: true, trim: true },
  motDePasse: { type: String, required: true, select: false },
  /** Code provisoire (création, réinitialisation) : à changer à la prochaine connexion. */
  mdpProvisoire: { type: Boolean, default: false },
  echecs: { type: Number, default: 0 }, // échecs de connexion consécutifs
  bloqueJusqua: { type: Date, default: null }, // blocage après trop d'échecs
  actif: { type: Boolean, default: true },
}, opts), 'administrateursPlateforme');

/** Réglages de la plateforme (_id « plateforme ») : serveur SMTP commun à toutes les entreprises. */
export const ParametresPlateforme = model('ParametresPlateforme', new Schema({
  _id: { type: String, default: 'plateforme' },
  smtp: { type: Smtp, default: () => ({}) },
  /** Coordonnées de l'éditeur, affichées sur la page Contact de l'application. */
  editeur: { nom: { type: String, default: '' }, email: { type: String, default: '' }, tel: { type: String, default: '' }, horaires: { type: String, default: '' } },
  /** Adresse prévenue à chaque message d'un établissement (vide : comptes de la plateforme). */
  emailNotification: { type: String, default: '' },
}, { ...opts, _id: false }), 'parametresPlateforme');

/** Message d'un établissement (entreprise cliente) vers l'administrateur de la plateforme (page Contact). */
export const MessageContact = model('MessageContact', new Schema({
  date: { type: Date, default: Date.now },
  entrepriseCode: { type: String, required: true },
  entrepriseNom: { type: String, default: '' },
  application: { type: String, default: '' }, // nom de l'application de l'entreprise
  auteur: { id: Schema.Types.ObjectId, nom: String, email: String, role: String },
  telephone: { type: String, default: '' },
  depot: { type: String, default: '' },
  categorie: { type: String, enum: ['question', 'probleme', 'licence', 'evolution', 'autre'], default: 'question' },
  sujet: { type: String, required: true },
  message: { type: String, required: true },
  lu: { type: Boolean, default: false },
  luLe: { type: Date, default: null },
  notification: { envoyee: Boolean, a: String, erreur: String },
}, { versionKey: false }).index({ date: -1 }).index({ entrepriseCode: 1, date: -1 }).index({ lu: 1 }), 'messagesContact');
