// Offres commerciales : base des clients qui acceptent de recevoir des offres, codes promo (pourcentage de réduction,
// durée de validité, nombre d'utilisations) et envoi d'une offre par e-mail (liste de diffusion avec lien de désinscription).
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Campagne, Client, CodePromo, Parametres } from '../modeles.js';
import { baseLiens, envoyer } from '../courriel.js';
import { entrepriseCourante } from '../locataire.js';
import { conflit, introuvable, journaliser, r2, requete, texte } from '../noyau.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^[A-Z0-9-]{3,20}$/;
const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const finDeJour = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const debutDeJour = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dateFr = (d) => new Date(d).toLocaleDateString('fr-FR', { timeZone: process.env.FUSEAU ?? 'Europe/Paris' });

// ───────────── Base clients ─────────────

/**
 * Enregistre (ou met à jour) le contact d'un client qui accepte de recevoir des offres.
 * Sans e-mail valide ou sans consentement : rien n'est enregistré.
 */
export async function enregistrerConsentement({ nom, tel, email, depot, source, session = null }) {
  const e = texte(email).toLowerCase();
  if (!EMAIL.test(e)) return null;
  return Client.findOneAndUpdate(
    { email: e },
    {
      $set: { nom: texte(nom), tel: texte(tel), consentementOffres: true, consentementLe: new Date(), desinscritLe: null, depot: depot ?? '', source },
      $setOnInsert: { email: e },
    },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
}

export async function clients(q) {
  const filtre = {};
  if (q?.offres === '1') filtre.consentementOffres = true;
  const t = texte(q?.q);
  if (t) {
    const r = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filtre.$or = [{ nom: r }, { email: r }, { tel: r }];
  }
  const [liste, total, abonnes] = await Promise.all([
    Client.find(filtre).sort({ consentementLe: -1 }).limit(1000).lean(),
    Client.countDocuments({}),
    Client.countDocuments({ consentementOffres: true }),
  ]);
  return { clients: liste, total, abonnes };
}

/** Désinscription (ou réinscription) d'un client, par l'admin. */
export async function modifierClient(req, id, b) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Client introuvable');
  const offres = b?.consentementOffres !== false;
  const c = await Client.findByIdAndUpdate(id, { $set: { consentementOffres: offres, ...(offres ? { consentementLe: new Date(), desinscritLe: null } : { desinscritLe: new Date() }) } }, { returnDocument: 'after' }).lean();
  if (!c) throw introuvable('Client introuvable');
  return c;
}

/** Suppression définitive du contact (droit à l'effacement). */
export async function supprimerClient(id) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Client introuvable');
  await Client.deleteOne({ _id: id });
  return { ok: true };
}

// ───────────── Désinscription par lien ─────────────

const secret = () => process.env.JWT_SECRET ?? 'dev-secret-a-changer';
export const jetonDesinscription = (entreprise, id) =>
  crypto.createHmac('sha256', secret()).update(`${entreprise}:${id}`).digest('base64url').slice(0, 24);

/** Lien de désinscription d'un client (dans chaque e-mail d'offre). */
export const lienDesinscription = (base, entreprise, id) => `${base}/desinscription/${entreprise}/${id}/${jetonDesinscription(entreprise, id)}`;

/** Désinscription depuis le lien de l'e-mail ; renvoie le client ou null si le lien n'est pas valide. */
export async function desinscrire(entreprise, id, jeton) {
  if (!mongoose.isValidObjectId(id)) return null;
  const attendu = jetonDesinscription(entreprise, id);
  if (String(jeton ?? '').length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(String(jeton)), Buffer.from(attendu))) return null;
  return Client.findByIdAndUpdate(id, { $set: { consentementOffres: false, desinscritLe: new Date() } }, { returnDocument: 'after' }).lean();
}

// ───────────── Codes promo ─────────────

const vueCode = (c) => {
  const maintenant = new Date();
  const etat = !c.actif ? 'desactive' : maintenant < c.debut ? 'a-venir' : maintenant > c.fin ? 'expire'
    : c.utilisationsMax && c.nbUtilisations >= c.utilisationsMax ? 'epuise' : 'valide';
  return { ...c, etat };
};

export async function codesPromo() {
  return (await CodePromo.find().sort({ createdAt: -1 }).lean()).map(vueCode);
}

function lireCode(b, actuel = {}) {
  const pourcentage = Number(b?.pourcentage ?? actuel.pourcentage);
  if (!(pourcentage > 0 && pourcentage <= 100)) throw requete('Réduction : un pourcentage entre 1 et 100');
  const debut = b?.debut ? debutDeJour(b.debut) : actuel.debut ?? debutDeJour(new Date());
  const fin = b?.fin ? finDeJour(b.fin) : actuel.fin;
  if (!fin || Number.isNaN(new Date(fin).getTime())) throw requete('Date de fin de validité obligatoire');
  if (fin < debut) throw requete('La fin de validité précède le début');
  const max = b?.utilisationsMax === '' || b?.utilisationsMax == null ? (b && 'utilisationsMax' in b ? 0 : actuel.utilisationsMax ?? 0) : Math.max(0, parseInt(b.utilisationsMax, 10) || 0);
  return {
    description: texte(b?.description ?? actuel.description).slice(0, 200), pourcentage: r2(pourcentage), debut, fin, utilisationsMax: max,
    actif: typeof b?.actif === 'boolean' ? b.actif : actuel.actif ?? true,
  };
}

/** Code promo aléatoire et libre (ex. PROMO-7KQ2). */
async function codeLibre() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const c = `PROMO-${Array.from({ length: 4 }, () => a[crypto.randomInt(a.length)]).join('')}`;
    if (!(await CodePromo.exists({ code: c }))) return c;
  }
}

export async function creerCode(req, b) {
  const code = texte(b?.code).toUpperCase() || await codeLibre();
  if (!CODE.test(code)) throw requete('Code : 3 à 20 lettres, chiffres ou tirets');
  if (await CodePromo.exists({ code })) throw conflit(`Le code ${code} existe déjà`, 'CODE_PRIS');
  const c = await CodePromo.create({ code, ...lireCode(b), creePar: req.user.nom });
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `promo:${code}`, apres: { code, pourcentage: c.pourcentage, fin: c.fin } });
  return vueCode(c.toObject());
}

export async function modifierCode(req, id, b) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Code promo introuvable');
  const actuel = await CodePromo.findById(id).lean();
  if (!actuel) throw introuvable('Code promo introuvable');
  const c = await CodePromo.findByIdAndUpdate(id, { $set: lireCode(b, actuel) }, { returnDocument: 'after' }).lean();
  await journaliser(req, null, 'PARAMETRAGE', { entite: 'parametrage', numero: `promo:${c.code}`, avant: actuel, apres: c });
  return vueCode(c);
}

/** Code utilisable maintenant (actif, dans sa période, utilisations restantes) ; sinon erreur explicite. */
export async function verifierCode(code) {
  const c = await CodePromo.findOne({ code: texte(code).toUpperCase() }).lean();
  if (!c) throw requete(`Code promo ${texte(code).toUpperCase()} inconnu`, 'PROMO_INVALIDE');
  const v = vueCode(c);
  const raisons = { desactive: 'désactivé', 'a-venir': `valable à partir du ${dateFr(c.debut)}`, expire: `expiré depuis le ${dateFr(c.fin)}`, epuise: 'déjà utilisé le nombre de fois prévu' };
  if (v.etat !== 'valide') throw requete(`Code promo ${c.code} ${raisons[v.etat]}`, 'PROMO_INVALIDE');
  return { code: c.code, pourcentage: c.pourcentage, fin: c.fin, description: c.description };
}

/** Compte une utilisation (dans la transaction de l'envoi), en refusant un code épuisé entre-temps. */
export async function utiliserCode(code, session) {
  const maintenant = new Date();
  const c = await CodePromo.findOneAndUpdate(
    { code, actif: true, debut: { $lte: maintenant }, fin: { $gte: maintenant },
      $or: [{ utilisationsMax: 0 }, { $expr: { $lt: ['$nbUtilisations', '$utilisationsMax'] } }] },
    { $inc: { nbUtilisations: 1 } },
    { returnDocument: 'after', session },
  ).lean();
  if (!c) throw requete(`Code promo ${code} n'est plus utilisable`, 'PROMO_INVALIDE');
  return c;
}

// ───────────── Envoi d'une offre (liste de diffusion) ─────────────

/** Message de l'offre, au nom de l'application de l'entreprise. */
function messageOffre({ application, nom, sujet, texte: corps, code, lien }) {
  const intro = `Bonjour ${nom || ''},`.replace(' ,', ',');
  const reduction = code ? `-${String(code.pourcentage).replace('.', ',')} %` : '';
  const valable = code ? `Valable jusqu'au ${dateFr(code.fin)}, sur votre prochain envoi de colis.` : '';
  const texteMail = [intro, '', corps, '', ...(code ? [`Code promo : ${code.code} (${reduction})`, valable, 'Présentez ce code au comptoir lors de votre prochain envoi.', ''] : []),
    `Pour ne plus recevoir nos offres : ${lien}`, '', `— ${application}`].join('\n');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7ef">
<tr><td style="background:#111827;color:#fff;padding:16px 24px;font-size:18px;font-weight:700">${echapper(application)}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 12px">${echapper(intro)}</p>
<div style="margin:0 0 18px;line-height:1.55;white-space:pre-wrap">${echapper(corps)}</div>
${code ? `<div style="text-align:center;margin:0 0 18px;padding:18px;border:2px dashed #1f5fd1;border-radius:14px;background:#eef3fc">
<div style="font-size:30px;font-weight:800;color:#1f5fd1">${echapper(reduction)}</div>
<div style="font-size:13px;color:#677085;margin:6px 0 4px">Votre code promo</div>
<div style="display:inline-block;font-family:Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:3px;padding:8px 16px;border-radius:10px;background:#fff;color:#1a3f8f">${echapper(code.code)}</div>
<div style="font-size:13px;color:#3c4456;margin-top:10px">${echapper(valable)}<br>Présentez ce code au comptoir lors de votre prochain envoi.</div></div>` : ''}
</td></tr><tr><td style="padding:12px 24px;background:#f8f9fb;color:#8a93a6;font-size:12px">${echapper(application)} · <a href="${echapper(lien)}" style="color:#8a93a6">Ne plus recevoir nos offres</a></td></tr>
</table></td></tr></table></body></html>`;
  return { sujet, texte: texteMail, html };
}

export async function campagnes() {
  return Campagne.find().sort({ date: -1 }).limit(100).lean();
}

/**
 * Envoie une offre aux clients abonnés (tous, ou ceux choisis), avec un code promo facultatif.
 * Chaque e-mail est personnel (prénom, lien de désinscription) et gardé dans les messages envoyés.
 */
export async function envoyerCampagne(req, b, origine) {
  const sujet = texte(b?.sujet).slice(0, 150);
  const corps = texte(b?.message);
  if (!sujet) throw requete('Objet de l\'offre obligatoire');
  if (corps.length < 10) throw requete('Message trop court');
  let code = null;
  if (texte(b?.codePromo)) code = await verifierCode(b.codePromo);
  const filtre = { consentementOffres: true };
  if (Array.isArray(b?.clients) && b.clients.length) filtre._id = { $in: b.clients.filter((x) => mongoose.isValidObjectId(x)) };
  const destinataires = await Client.find(filtre).lean();
  if (!destinataires.length) throw requete('Aucun client abonné aux offres à qui envoyer ce message');
  const p = await Parametres.findById('general').lean();
  const application = p?.nomApplication || 'Gestion colis';
  const base = baseLiens(p, origine);
  const entreprise = entrepriseCourante()?.code ?? '';
  let envoyes = 0;
  const echecs = [];
  for (const c of destinataires) {
    const msg = messageOffre({ application, nom: c.nom, sujet, texte: corps, code, lien: lienDesinscription(base, entreprise, String(c._id)) });
    const r = await envoyer({ a: c.email, ...msg }, null, { motif: 'offre', par: req.user.nom, destinataireNom: c.nom });
    if (r.envoye) envoyes++;
    else echecs.push({ a: c.email, erreur: r.erreur });
  }
  const camp = await Campagne.create({ sujet, message: corps, codePromo: code?.code ?? '', pourcentage: code?.pourcentage ?? 0, nbDestinataires: destinataires.length, nbEnvoyes: envoyes, nbEchecs: echecs.length, par: req.user.nom });
  return { campagne: camp.toObject(), envoyes, echecs };
}
