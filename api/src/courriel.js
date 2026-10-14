// Envoi d'e-mails (SMTP paramétrable) : codes provisoires à la création d'un compte et à la réinitialisation.
// Serveur SMTP commun de la plateforme (/plateforme → E-mails), pour toutes les entreprises.
import nodemailer from 'nodemailer';
import { Message, Parametres, ParametresPlateforme } from './modeles.js';
import { entrepriseCourante } from './locataire.js';
import { requete, texte } from './noyau.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SECURITES = ['STARTTLS', 'SSL', 'AUCUNE'];

/** Réglages SMTP lisibles par l'écran : jamais le mot de passe, seulement s'il est enregistré. */
export function vueSmtp(s) {
  const { motDePasse, ...reste } = s ?? {};
  return { actif: false, hote: '', port: 587, securite: 'STARTTLS', utilisateur: '', expediteur: '', expediteurNom: '', certificatNonVerifie: false, ...reste, motDePasseEnregistre: !!motDePasse };
}

/** Contrôle et normalise des réglages saisis ; le mot de passe vide garde l'ancien. */
export function normaliserSmtp(b, ancien = {}) {
  const s = {
    actif: !!b?.actif,
    hote: texte(b?.hote),
    port: Number(b?.port) || 587,
    securite: SECURITES.includes(b?.securite) ? b.securite : 'STARTTLS',
    utilisateur: texte(b?.utilisateur),
    motDePasse: texte(b?.motDePasse) ? String(b.motDePasse) : (b?.effacerMotDePasse ? '' : ancien.motDePasse ?? ''),
    expediteur: texte(b?.expediteur).toLowerCase(),
    expediteurNom: texte(b?.expediteurNom).slice(0, 80),
    certificatNonVerifie: !!b?.certificatNonVerifie,
  };
  if (s.port < 1 || s.port > 65535) throw requete('Port SMTP invalide');
  if (s.actif) {
    if (!s.hote) throw requete('Serveur SMTP obligatoire');
    if (!EMAIL.test(s.expediteur)) throw requete("Adresse d'expédition invalide");
  }
  return s;
}

const transport = (s) => nodemailer.createTransport({
  host: s.hote,
  port: s.port,
  secure: s.securite === 'SSL',
  requireTLS: s.securite === 'STARTTLS',
  ignoreTLS: s.securite === 'AUCUNE',
  auth: s.utilisateur ? { user: s.utilisateur, pass: s.motDePasse } : undefined,
  tls: s.certificatNonVerifie ? { rejectUnauthorized: false } : undefined,
  connectionTimeout: 10000,
  greetingTimeout: 8000,
  socketTimeout: 15000,
});

/** Réglages SMTP à utiliser : toujours le serveur commun de la plateforme (/plateforme → E-mails). */
async function smtpEffectif() {
  const pf = await ParametresPlateforme.findById('plateforme').select('+smtp.motDePasse').lean();
  return pf?.smtp?.actif && pf.smtp.hote ? pf.smtp : null;
}

/**
 * Envoie un message ; ne lève jamais : renvoie { envoye, a, erreur }.
 * journal : { motif, par, destinataireNom } → copie exacte gardée dans les messages de l'entreprise courante.
 */
export async function envoyer({ a, sujet, texte: corps, html, pieces = [] }, smtp = null, journal = null) {
  let s = null;
  let r;
  try {
    s = smtp ?? (await smtpEffectif());
    if (!s) r = { envoye: false, a, erreur: 'Envoi d’e-mails non configuré (serveur SMTP)' };
    else {
      await transport(s).sendMail({
        from: s.expediteurNom ? { name: s.expediteurNom, address: s.expediteur } : s.expediteur,
        to: a, subject: sujet, text: corps, html, attachments: pieces,
      });
      r = { envoye: true, a };
    }
  } catch (e) {
    r = { envoye: false, a, erreur: `E-mail non envoyé : ${e.message}` };
  }
  if (journal && entrepriseCourante()) {
    try {
      const m = await Message.create({
        a, sujet, texte: corps, html, motif: journal.motif, envoye: r.envoye, erreur: r.erreur ?? '',
        par: journal.par ?? '', destinataireNom: journal.destinataireNom ?? '', serveur: s ? `${s.hote}:${s.port}` : '',
        piecesJointes: pieces.map((p) => p.filename),
      });
      r.messageId = m._id;
    } catch { /* la copie ne doit jamais empêcher l'envoi */ }
  }
  return r;
}

const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Début des liens envoyés (e-mails, manuel) : adresse publique réglée, sinon l'adresse vue par la requête. */
export const baseLiens = (p, origine) =>
  (p?.urlPublique && !/localhost/.test(p.urlPublique) ? p.urlPublique : origine || p?.urlPublique || '').replace(/\/+$/, '');

/**
 * Message du code provisoire, au nom de l'application de l'entreprise (Administration → Paramètres).
 * motif : 'creation' (nouveau compte) ou 'reinitialisation'.
 */
export function messageCodeProvisoire({ nom, email, code, motif, application, entreprise, codeEntreprise, lien }) {
  const creation = motif === 'creation';
  const sujet = creation ? `${application} — votre compte a été créé` : `${application} — votre code de connexion a été réinitialisé`;
  const intro = creation
    ? `Un compte vient d'être créé pour vous sur ${application}${entreprise && entreprise !== application ? ` (${entreprise})` : ''}.`
    : `Votre code de connexion à ${application}${entreprise && entreprise !== application ? ` (${entreprise})` : ''} a été réinitialisé.`;
  const corps = [
    `Bonjour ${nom},`,
    '',
    intro,
    '',
    `Code provisoire : ${code}`,
    '',
    'Pour vous connecter :',
    `  • Adresse : ${lien}`,
    `  • Identifiant entreprise : ${codeEntreprise}`,
    `  • E-mail : ${email}`,
    `  • Code provisoire : ${code}`,
    '',
    'À la première connexion, vous choisirez votre code personnel à 4 chiffres (saisi deux fois). Le code provisoire ne servira plus ensuite.',
    '',
    creation ? "Si vous n'attendiez pas ce compte, ignorez ce message." : "Si vous n'êtes pas à l'origine de cette demande, prévenez votre administrateur.",
    '',
    `— ${application}`,
  ].join('\n');
  const ligne = (l, v) => `<tr><td style="padding:4px 12px 4px 0;color:#677085">${l}</td><td style="padding:4px 0;font-weight:600">${v}</td></tr>`;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7ef">
<tr><td style="background:#111827;color:#fff;padding:16px 24px;font-size:18px;font-weight:700">${echapper(application)}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px">Bonjour ${echapper(nom)},</p>
<p style="margin:0 0 18px;line-height:1.5">${echapper(intro)}</p>
<div style="text-align:center;margin:0 0 18px"><div style="font-size:13px;color:#677085;margin-bottom:6px">Code provisoire</div>
<div style="display:inline-block;font-family:Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;padding:10px 18px 10px 28px;border-radius:12px;background:#e8effc;color:#1a3f8f">${echapper(code)}</div></div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 18px">
${ligne('Identifiant entreprise', `<span style="font-family:Consolas,monospace">${echapper(codeEntreprise)}</span>`)}${ligne('E-mail', echapper(email))}</table>
<p style="text-align:center;margin:0 0 18px"><a href="${echapper(lien)}" style="display:inline-block;background:#1f5fd1;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Se connecter</a></p>
<p style="margin:0 0 12px;line-height:1.5;font-size:14px">À la première connexion, vous choisirez votre <b>code personnel à 4 chiffres</b> (saisi deux fois). Le code provisoire ne servira plus ensuite.</p>
<p style="margin:0;color:#677085;font-size:13px;line-height:1.5">${creation ? "Si vous n'attendiez pas ce compte, ignorez ce message." : "Si vous n'êtes pas à l'origine de cette demande, prévenez votre administrateur."}</p>
</td></tr><tr><td style="padding:12px 24px;background:#f8f9fb;color:#8a93a6;font-size:12px">${echapper(application)} · ${echapper(lien)}</td></tr>
</table></td></tr></table></body></html>`;
  return { sujet, texte: corps, html };
}

/**
 * Envoie le code provisoire à son titulaire, dans l'entreprise courante (nom de l'application, lien direct de connexion).
 * origine : adresse du site vue par la requête, si l'adresse publique n'est pas réglée.
 */
export async function envoyerCodeProvisoire({ email, nom, code, motif, origine, par = '' }) {
  const e = entrepriseCourante();
  const p = await Parametres.findById('general').lean();
  const application = p?.nomApplication || 'Gestion colis';
  const base = baseLiens(p, origine);
  const msg = messageCodeProvisoire({
    nom, email, code, motif, application, entreprise: e?.nom, codeEntreprise: e?.code ?? '', lien: `${base}/connexion/${e?.code ?? ''}`,
  });
  return envoyer({ a: email, ...msg }, null, { motif, par, destinataireNom: nom });
}

/** E-mail de test avec des réglages donnés (bouton « Envoyer un e-mail de test »). */
export async function testerSmtp(smtp, a, application, par = '') {
  if (!EMAIL.test(texte(a))) throw requete('Adresse de test invalide');
  if (!smtp?.hote) throw requete('Serveur SMTP obligatoire');
  return envoyer({
    a: texte(a),
    sujet: `${application} — e-mail de test`,
    texte: `Bonjour,\n\nCet e-mail confirme que l'envoi depuis ${application} fonctionne (serveur ${smtp.hote}:${smtp.port}).\n\n— ${application}`,
    html: `<p>Bonjour,</p><p>Cet e-mail confirme que l'envoi depuis <b>${echapper(application)}</b> fonctionne (serveur ${echapper(smtp.hote)}:${smtp.port}).</p><p>— ${echapper(application)}</p>`,
  }, smtp, { motif: 'test', par });
}

/** Adresse du site telle que vue par la requête (lien des e-mails si l'adresse publique n'est pas réglée). */
export const origineRequete = (req) => {
  const o = req.get('origin');
  return o && /^https?:\/\//.test(o) ? o : `${req.protocol}://${req.get('host')}`;
};
