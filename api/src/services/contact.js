// Contact : messages des établissements (entreprises clientes) vers l'administrateur de la plateforme,
// avec notification par e-mail. Les messages sont gardés dans la base de la plateforme.
import mongoose from 'mongoose';
import { AdminPlateforme, MessageContact, Parametres, ParametresPlateforme, ROLES } from '../modeles.js';
import { envoyer } from '../courriel.js';
import { introuvable, requete, texte } from '../noyau.js';

export const CATEGORIES = {
  question: 'Question',
  probleme: 'Problème / anomalie',
  licence: "Renouvellement du jeton d'utilisation",
  evolution: "Demande d'évolution",
  autre: 'Autre',
};
const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Coordonnées de l'éditeur (affichées sur la page Contact) et adresse de notification. */
export async function reglagesContact() {
  const p = await ParametresPlateforme.findById('plateforme').lean();
  return { editeur: { nom: '', email: '', tel: '', horaires: '', ...p?.editeur }, emailNotification: p?.emailNotification ?? '' };
}

export async function modifierReglagesContact(b) {
  const editeur = {
    nom: texte(b?.editeur?.nom).slice(0, 80), email: texte(b?.editeur?.email).toLowerCase(),
    tel: texte(b?.editeur?.tel).slice(0, 40), horaires: texte(b?.editeur?.horaires).slice(0, 120),
  };
  const emailNotification = texte(b?.emailNotification).toLowerCase();
  if (emailNotification && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNotification)) throw requete('Adresse de notification invalide');
  await ParametresPlateforme.updateOne({ _id: 'plateforme' }, { $set: { editeur, emailNotification } }, { upsert: true });
  return reglagesContact();
}

/** Adresses prévenues d'un nouveau message : adresse de notification, sinon les comptes actifs de la plateforme. */
async function destinatairesNotification() {
  const { emailNotification } = await reglagesContact();
  if (emailNotification) return [emailNotification];
  return (await AdminPlateforme.find({ actif: true }, { email: 1 }).lean()).map((a) => a.email);
}

/** Serveur d'envoi de la notification : celui de la plateforme, sinon celui de l'entreprise. */
async function smtpNotification() {
  const pf = await ParametresPlateforme.findById('plateforme').select('+smtp.motDePasse').lean();
  if (pf?.smtp?.actif && pf.smtp.hote) return pf.smtp;
  const p = await Parametres.findById('general').select('+smtp.motDePasse').lean();
  return p?.smtp?.actif && p.smtp.hote ? p.smtp : null;
}

/** Nouveau message d'un utilisateur de l'entreprise courante vers la plateforme, puis notification par e-mail. */
export async function envoyerMessage(req, b, origine) {
  const categorie = Object.hasOwn(CATEGORIES, b?.categorie) ? b.categorie : 'question';
  const sujet = texte(b?.sujet).slice(0, 150);
  const message = texte(b?.message);
  if (!sujet) throw requete('Objet obligatoire');
  if (message.length < 10) throw requete('Message trop court (10 caractères au moins)');
  if (message.length > 5000) throw requete('Message trop long (5 000 caractères au plus)');
  const params = await Parametres.findById('general').lean();
  const m = await MessageContact.create({
    entrepriseCode: req.entreprise.code, entrepriseNom: req.entreprise.nom, application: params?.nomApplication || '',
    auteur: { id: req.user.id, nom: req.user.nom, email: req.user.email, role: req.user.role },
    telephone: texte(b?.telephone).slice(0, 40), depot: req.depot?.code ?? '',
    categorie, sujet, message,
  });

  const a = await destinatairesNotification();
  const lien = `${origine}/plateforme`;
  const titre = `Nouveau message de ${req.entreprise.nom} (${req.entreprise.code})`;
  const lignes = [
    ['Établissement', `${req.entreprise.nom} — ${req.entreprise.code}`], ['De', `${req.user.nom} <${req.user.email}>`],
    ['Profil', req.user.role], ...(m.telephone ? [['Téléphone', m.telephone]] : []), ...(m.depot ? [['Dépôt', m.depot]] : []),
    ['Catégorie', CATEGORIES[categorie]], ['Objet', sujet],
  ];
  const texteMail = `${titre}\n\n${lignes.map(([l, v]) => `${l} : ${v}`).join('\n')}\n\n${message}\n\nÀ retrouver sur ${lien} (Messages des établissements).`;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7ef">
<tr><td style="background:#111827;color:#fff;padding:16px 24px;font-size:17px;font-weight:700">${echapper(titre)}</td></tr>
<tr><td style="padding:22px 24px"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:16px">
${lignes.map(([l, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#677085;white-space:nowrap">${echapper(l)}</td><td style="padding:3px 0;font-weight:600">${echapper(v)}</td></tr>`).join('')}
</table><div style="white-space:pre-wrap;line-height:1.55;padding:14px 16px;border-radius:10px;background:#f6f8fc;border:1px solid #e3e7ef">${echapper(message)}</div>
<p style="text-align:center;margin:20px 0 0"><a href="${echapper(lien)}" style="display:inline-block;background:#1f5fd1;color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:10px">Voir les messages</a></p>
</td></tr></table></td></tr></table></body></html>`;
  let mail = { envoye: false, a: '', erreur: 'Aucune adresse de notification' };
  if (a.length) {
    const smtp = await smtpNotification();
    mail = smtp ? await envoyer({ a: a.join(', '), sujet: `[Contact] ${titre} — ${sujet}`, texte: texteMail, html }, smtp)
      : { envoye: false, a: a.join(', '), erreur: 'Envoi d’e-mails non configuré (serveur SMTP)' };
  }
  await MessageContact.updateOne({ _id: m._id }, { $set: { notification: { envoyee: mail.envoye, a: mail.a, erreur: mail.erreur ?? '' } } });
  return { message: { ...m.toObject(), notification: { envoyee: mail.envoye } }, mail };
}

/** Messages de l'entreprise courante : tous pour l'admin, les siens pour les autres profils. */
export async function messagesEntreprise(req) {
  const filtre = { entrepriseCode: req.entreprise.code };
  if (req.user.role !== ROLES.ADMIN) filtre['auteur.id'] = req.user.id;
  return MessageContact.find(filtre, { notification: 0 }).sort({ date: -1 }).limit(200).lean();
}

// ───────────── Plateforme ─────────────

export async function messagesPlateforme(q) {
  const filtre = {};
  if (texte(q?.entreprise)) filtre.entrepriseCode = texte(q.entreprise).toUpperCase();
  if (q?.nonLus === '1') filtre.lu = false;
  const [messages, nonLus] = await Promise.all([
    MessageContact.find(filtre).sort({ date: -1 }).limit(500).lean(),
    MessageContact.countDocuments({ lu: false }),
  ]);
  return { messages, nonLus };
}

export async function marquerLu(id, lu) {
  if (!mongoose.isValidObjectId(id)) throw introuvable('Message introuvable');
  const m = await MessageContact.findByIdAndUpdate(id, { $set: { lu: lu !== false, luLe: lu !== false ? new Date() : null } }, { returnDocument: 'after' }).lean();
  if (!m) throw introuvable('Message introuvable');
  return m;
}
