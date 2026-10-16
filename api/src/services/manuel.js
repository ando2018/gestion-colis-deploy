// Manuel d'utilisation PDF propre à chaque entreprise : lien de connexion avec son identifiant, premiers pas,
// guide complet illustré (captures d'écran : api/manuel/captures, refaites par « npm run manuel:captures »).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Parametres, ROLES, Utilisateur } from '../modeles.js';
import { dansEntreprise } from '../locataire.js';
import { baseLiens, envoyer } from '../courriel.js';

const CAPTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../manuel/captures');
const BLEU = '#1f5fd1';
const NUIT = '#111827';
const GRIS = '#677085';
const TEXTE = '#1d2330';
const PALE = '#eef3fc';
const MARGE = 50;
const LARGEUR = 595.28 - 2 * MARGE; // A4

/** Guide complet : chapitres, sections, textes et captures. Le texte parle à l'administrateur de l'établissement. */
const GUIDE = [
  {
    titre: 'Se connecter',
    sections: [
      {
        titre: "1. L'identifiant de votre entreprise",
        texte: ["Ouvrez le lien de connexion indiqué en première page : il contient déjà l'identifiant de votre entreprise. Vous pouvez aussi ouvrir la page de connexion et saisir l'identifiant : les tirets s'ajoutent tout seuls, et il est mémorisé sur le poste."],
        image: '01-connexion-identifiant', legende: "Étape 1 : l'identifiant de l'entreprise (au format XXX-XXX-XXX-XXX)",
      },
      {
        titre: '2. Votre e-mail et votre code à 4 chiffres',
        texte: ["Saisissez votre e-mail, puis votre code sur le pavé numérique. Les chiffres changent de place à chaque affichage : la position des doigts ne trahit pas le code. Le clavier de l'ordinateur fonctionne aussi."],
        puces: ['Après 5 codes faux, le compte est bloqué 15 minutes (un administrateur peut le débloquer en réinitialisant le code).',
          "Sans activité pendant 2 heures, l'application vous déconnecte (un avertissement s'affiche 2 minutes avant)."],
        image: '02-connexion-code', legende: 'Étape 2 : e-mail et code à 4 chiffres',
      },
      {
        titre: '3. Choisir votre code personnel',
        texte: ['À la première connexion, vous utilisez le code provisoire reçu par e-mail. L\'application vous demande alors de choisir votre code personnel, saisi deux fois. Les codes trop simples (1111, 1234…) sont refusés. Vous pourrez le changer à tout moment avec le cadenas en bas du menu.'],
        image: '03-choix-du-code', legende: 'Choix du code personnel (saisi deux fois)',
      },
    ],
  },
  {
    titre: "Paramétrer l'application (administrateur)",
    intro: "Tout se règle dans Administration (menu de gauche). À faire une fois, avant que l'équipe commence : dépôts, destinations et tarifs, moyens de paiement, comptes, puis réglages.",
    sections: [
      {
        titre: 'Dépôts',
        texte: ["Créez chaque dépôt (lieu où les colis sont reçus), avec un code court (ex. PAR). Le dépôt de travail se choisit en haut du menu ; chaque compte n'a accès qu'à ses dépôts."],
        image: '10-admin-depots', legende: 'Administration › Dépôts',
      },
      {
        titre: "Imprimante de chaque dépôt",
        texte: ["Dans la fiche du dépôt, choisissez le type d'imprimante :"],
        puces: ['Zebra (étiquettes 100 × 150 mm) : indiquez son adresse IP sur le réseau du dépôt.',
          'Ticket thermique POS (58 ou 80 mm) : adresse IP, ou laissez vide pour une imprimante USB (impression par le navigateur).',
          'Imprimante standard A4 : étiquettes imprimées par le navigateur, 1 ou 4 par feuille.'],
        image: '17-admin-imprimante', legende: "Fiche d'un dépôt : type d'imprimante et réglages",
      },
      {
        titre: 'Destinations et tarifs',
        texte: ['Chaque destination a un code (ex. ABJ), un pays, une ville, un tarif au kilo et un délai indicatif. Le montant des colis est calculé à partir du tarif.'],
        image: '11-admin-destinations', legende: 'Administration › Destinations',
      },
      {
        titre: 'Moyens de paiement',
        texte: ['Les moyens de paiement usuels sont déjà créés (espèces, carte, virement, mobile money, paiement à destination). Activez ceux que vous utilisez, ou limitez-les à certains dépôts.'],
        image: '12-admin-paiements', legende: 'Administration › Modes de paiement',
      },
      {
        titre: "Comptes de l'équipe",
        texte: ['Créez un compte par personne, avec son profil et ses dépôts :'],
        puces: ['Réception : enregistre les colis et encaisse.', 'Cariste : pose les colis sur les palettes.',
          'Chef de quai : zone de départ, conteneurs, départs.', 'Client (borne) : formulaire en libre-service, rien d\'autre.',
          "Administrateur : tout, y compris l'Administration (un administrateur ne peut pas être désactivé)."],
        image: '13-admin-utilisateurs', legende: 'Administration › Utilisateurs : profil, dépôts, état du code',
      },
      {
        titre: 'Codes provisoires',
        texte: ["À la création d'un compte (ou avec « Réinitialiser le code »), un code provisoire est généré : il s'affiche une fois à l'écran et la personne le reçoit aussi par e-mail. Elle choisit son code personnel à la première connexion."],
        image: '14-admin-nouveau-compte', legende: "Nouveau compte : le code provisoire est généré à l'enregistrement",
      },
      {
        titre: 'Paramètres',
        texte: ["Nom de l'application (affiché partout, sur les reçus et les étiquettes), logo, code QR ou code-barres sur les étiquettes, poids maximum d'une palette, alertes de reliquat. Vous y retrouvez aussi l'identifiant de l'entreprise, le lien de connexion directe (à mettre en favori sur les postes) et l'état du jeton d'utilisation."],
        image: '15-admin-parametres', legende: 'Administration › Paramètres',
      },
    ],
  },
  {
    titre: 'Au quotidien : du dépôt au conteneur',
    intro: 'Chaque étape se fait au scan (douchette, caméra du téléphone ou saisie). Un colis ne change jamais d\'emplacement sans scan, et tout est tracé dans son historique.',
    sections: [
      {
        titre: '1. Réception',
        texte: ["Saisissez l'expéditeur et le destinataire (le téléphone retrouve un client connu), la destination et le poids de chaque colis. Le montant est calculé ; encaissez maintenant ou choisissez « Paiement à destination ». Un client peut aussi remplir son formulaire lui-même (« Formulaire client »)."],
        image: '20-reception', legende: 'Réception : expéditeur, destinataire, colis, paiement',
      },
      {
        titre: 'Étiquettes et reçu',
        texte: ["À la validation, les étiquettes s'impriment (une par pièce) sur l'imprimante du dépôt, et le reçu client est disponible (A4 ou ticket). Chaque étiquette porte un code court à 8 chiffres, facile à scanner."],
        image: '21-reception-etiquette', legende: 'Étiquette du colis et impression',
      },
      {
        titre: '2. Palettisation',
        texte: ["Ouvrez une palette (ou créez-en une), puis scannez les colis à poser. Le curseur reste dans le champ de scan : enchaînez à la douchette. « Retirer » enlève un colis (avec un motif). Fermez la palette quand elle est pleine : son étiquette s'imprime."],
        image: '22-palettisation', legende: 'Palettisation : palette ouverte et colis posés',
      },
      {
        titre: '3. Zone de départ',
        texte: ['Les palettes fermées (et, si besoin, des colis seuls) passent en zone de départ, classées par destination, prêtes à charger.'],
        image: '23-zone-depart', legende: 'Zone de départ',
      },
      {
        titre: '4. Chargement du conteneur',
        texte: ['Créez le conteneur, scannez les palettes ou les colis à charger (ou utilisez « + »). Validez le chargement, puis faites partir le conteneur : le manifeste s\'imprime et tous les colis passent « Partis ».'],
        image: '24-chargement', legende: 'Chargement : contenu du conteneur et éléments disponibles',
      },
      {
        titre: 'Recherche et suivi',
        texte: ["Retrouvez un colis, une palette ou un conteneur (numéro, téléphone, scan). L'arbre « conteneurs, palettes et colis » se filtre et s'exporte en PDF. Les paiements de reliquat et les annulations se font depuis la fiche du colis."],
        image: '30-suivi', legende: 'Recherche / suivi',
      },
      {
        titre: 'Écran Scan',
        texte: ["Scannez n'importe quelle étiquette : la fiche s'affiche avec les actions possibles (poser sur une palette, zone de départ, charger…)."],
        image: '31-scan', legende: 'Scan : fiche du colis et actions',
      },
      {
        titre: 'Douchette Bluetooth',
        texte: ["Appairez la douchette, testez-la et réglez le clavier (AZERTY / QWERTY) depuis cet écran. La caméra du téléphone peut remplacer la douchette sur tous les champs de scan."],
        image: '32-douchette', legende: 'Réglage et test de la douchette',
      },
    ],
  },
  {
    titre: 'Bon à savoir',
    sections: [
      {
        titre: "Jeton d'utilisation",
        texte: ["L'application est utilisable tant que le jeton d'utilisation de votre entreprise est valide. 7 jours avant l'échéance, un bandeau prévient ; une fois expiré, l'application passe en consultation seule (listes, suivi et statistiques restent visibles). Le bandeau propose « Demander le renouvellement »."],
      },
      {
        titre: "Contacter l'équipe de l'application",
        texte: ["L'onglet Contact envoie un message à l'équipe qui gère l'application (question, problème, renouvellement du jeton…). Vous retrouvez vos messages et leur état (envoyé, lu)."],
        image: '40-contact', legende: 'Contact',
      },
    ],
  },
];

const remplacer = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

/** Image du logo (PNG ou JPEG, formats lus par le PDF), ou null. */
function logoPdf(dataUrl) {
  const m = String(dataUrl ?? '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
  return m ? Buffer.from(m[2], 'base64') : null;
}

/**
 * Manuel PDF : couverture (accès : lien avec l'identifiant, QR code, administrateurs), premiers pas, guide illustré.
 * Renvoie un Buffer.
 */
export async function genererManuel({ entreprise, application, lien, admins = [], logo = null }) {
  const qr = await QRCode.toBuffer(lien, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: 'A4', margin: MARGE, bufferPages: true, info: { Title: `${application} — Manuel d'utilisation`, Author: application, Subject: entreprise.nom } });
  const morceaux = [];
  doc.on('data', (c) => morceaux.push(c));
  const fini = new Promise((ok) => doc.on('end', () => ok(Buffer.concat(morceaux))));
  const bas = () => doc.page.height - MARGE - 20;
  const assurer = (h) => { if (doc.y + h > bas()) doc.addPage(); };
  const paragraphe = (t, o = {}) => { doc.font('Helvetica').fontSize(10.5).fillColor(TEXTE).text(t, MARGE, doc.y, { width: LARGEUR, lineGap: 2.5, ...o }); doc.moveDown(0.5); };
  const puces = (l) => {
    for (const p of l) {
      assurer(30);
      const y = doc.y;
      doc.circle(MARGE + 4, y + 6, 2).fill(BLEU);
      doc.font('Helvetica').fontSize(10.5).fillColor(TEXTE).text(p, MARGE + 14, y, { width: LARGEUR - 14, lineGap: 2 });
      doc.moveDown(0.25);
    }
    doc.moveDown(0.3);
  };
  const images = new Map();
  /** Capture ouverte une seule fois, et sa taille dans la page (255 pt de haut au plus : deux sections par page). */
  const capture = (nom) => {
    if (images.has(nom)) return images.get(nom);
    const f = path.join(CAPTURES, `${nom}.png`);
    let v = null;
    if (fs.existsSync(f)) {
      const img = doc.openImage(f);
      let w = LARGEUR;
      let h = (img.height / img.width) * w;
      if (h > 255) { h = 255; w = (img.width / img.height) * h; }
      v = { img, w, h };
    }
    images.set(nom, v);
    return v;
  };
  const image = (nom, legende) => {
    const c = capture(nom);
    if (!c) return;
    const { img, w, h } = c;
    assurer(h + 30);
    const x = MARGE + (LARGEUR - w) / 2;
    const y = doc.y + 2;
    doc.save().roundedRect(x - 1, y - 1, w + 2, h + 2, 6).lineWidth(0.8).strokeColor('#d5dbe6').stroke().restore();
    doc.image(img, x, y, { width: w, height: h });
    doc.y = y + h + 5;
    if (legende) doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRIS).text(legende, MARGE, doc.y, { width: LARGEUR, align: 'center' });
    doc.moveDown(1);
  };

  // ── Couverture ──
  doc.rect(0, 0, doc.page.width, 200).fill(NUIT);
  let yLogo = 52;
  if (logo) {
    try { doc.image(logo, MARGE, 40, { fit: [90, 56] }); yLogo = 108; } catch { /* logo illisible : ignoré */ }
  }
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#ffffff').text(application, MARGE, yLogo, { width: LARGEUR });
  doc.font('Helvetica').fontSize(15).fillColor('#c9d3e8').text("Manuel d'utilisation", MARGE, doc.y + 4, { width: LARGEUR });
  doc.y = 230;
  doc.font('Helvetica').fontSize(11).fillColor(GRIS).text('Établissement', MARGE, doc.y);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(TEXTE).text(entreprise.nom, MARGE, doc.y + 2, { width: LARGEUR });
  doc.moveDown(1.2);

  // Encadré des accès
  const yAcces = doc.y;
  const hAcces = 210;
  doc.roundedRect(MARGE, yAcces, LARGEUR, hAcces, 12).fill(PALE);
  doc.image(qr, MARGE + LARGEUR - 170, yAcces + 20, { width: 150 });
  doc.font('Helvetica').fontSize(8.5).fillColor(GRIS).text('Scannez pour ouvrir la connexion', MARGE + LARGEUR - 175, yAcces + 174, { width: 160, align: 'center' });
  const xa = MARGE + 22;
  const la = LARGEUR - 220;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BLEU).text('Vos accès', xa, yAcces + 20);
  doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text('Lien de connexion', xa, yAcces + 46);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BLEU).text(lien, xa, doc.y + 2, { width: la, link: lien, underline: true });
  doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text("Identifiant de l'entreprise", xa, doc.y + 10);
  doc.font('Courier-Bold').fontSize(20).fillColor(TEXTE).text(entreprise.code, xa, doc.y + 2, { width: la, characterSpacing: 1 });
  // Manuel public (page de connexion) : sans les e-mails des administrateurs
  if (admins.length) {
    doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text(admins.length > 1 ? 'Administrateurs' : 'Administrateur', xa, doc.y + 10);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TEXTE).text(admins.join(', '), xa, doc.y + 2, { width: la });
  }
  doc.y = yAcces + hAcces + 14;
  paragraphe("Le code provisoire de connexion vous est envoyé dans un e-mail séparé : il n'est jamais écrit dans ce document. Conservez ce manuel : il reste valable, seul votre code personnel est secret.", { align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor(GRIS).text(`Document établi le ${new Date().toLocaleDateString('fr-FR')} pour ${entreprise.nom} (${entreprise.code}).`, MARGE, bas() - 10, { width: LARGEUR });

  // ── Premiers pas ──
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(20).fillColor(TEXTE).text('Démarrer en 5 étapes', MARGE, MARGE);
  doc.moveDown(0.6);
  const etapes = [
    ['Ouvrir le lien de connexion', `${lien}\nMettez-le en favori sur chaque poste (l'identifiant ${entreprise.code} y est déjà).`],
    ['Se connecter', "Votre e-mail et le code provisoire reçu par e-mail, saisi sur le pavé numérique."],
    ['Choisir votre code personnel', 'Un code à 4 chiffres, saisi deux fois. Il remplace le code provisoire.'],
    ["Paramétrer l'application", "Administration : dépôts (et leur imprimante), destinations et tarifs, moyens de paiement, puis Paramètres (nom de l'application, logo)."],
    ["Créer les comptes de l'équipe", 'Administration › Utilisateurs : un compte par personne, avec son profil et ses dépôts. Chacun reçoit son code provisoire.'],
  ];
  etapes.forEach(([titre, detail], i) => {
    assurer(70);
    const y = doc.y;
    doc.circle(MARGE + 15, y + 14, 15).fill(BLEU);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text(String(i + 1), MARGE, y + 6, { width: 30, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(12.5).fillColor(TEXTE).text(titre, MARGE + 44, y + 2, { width: LARGEUR - 44 });
    doc.font('Helvetica').fontSize(10.5).fillColor(TEXTE).text(detail, MARGE + 44, doc.y + 3, { width: LARGEUR - 44, lineGap: 2 });
    doc.y = Math.max(doc.y, y + 34) + 14;
  });
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(TEXTE).text('Sommaire', MARGE, doc.y);
  doc.moveDown(0.4);
  GUIDE.forEach((c, i) => {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLEU).text(`${i + 1}. ${c.titre}`, MARGE, doc.y);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text(c.sections.map((s) => s.titre.replace(/^\d+\.\s*/, '')).join(' · '), MARGE + 14, doc.y + 1, { width: LARGEUR - 14 });
    doc.moveDown(0.5);
  });

  // ── Guide complet ──
  const valeurs = { entreprise: entreprise.nom, code: entreprise.code, lien, application };
  GUIDE.forEach((c, i) => {
    doc.addPage();
    doc.rect(MARGE, MARGE, 5, 26).fill(BLEU);
    doc.font('Helvetica-Bold').fontSize(19).fillColor(TEXTE).text(`${i + 1}. ${c.titre}`, MARGE + 14, MARGE + 2, { width: LARGEUR - 14 });
    doc.moveDown(0.8);
    if (c.intro) paragraphe(remplacer(c.intro, valeurs));
    for (const s of c.sections) {
      // Titre, texte et capture d'une section sur la même page quand elle y tient (pas de titre seul en bas de page)
      doc.font('Helvetica').fontSize(10.5);
      const hTexte = (s.texte ?? []).reduce((h, t) => h + doc.heightOfString(remplacer(t, valeurs), { width: LARGEUR, lineGap: 2.5 }) + 7, 0)
        + (s.puces ?? []).reduce((h, t) => h + doc.heightOfString(t, { width: LARGEUR - 14, lineGap: 2 }) + 5, 0);
      const hImage = s.image && capture(s.image) ? capture(s.image).h + 32 : 0;
      const total = 28 + hTexte + hImage;
      assurer(total <= bas() - MARGE ? total : 28 + hTexte + 40);
      doc.font('Helvetica-Bold').fontSize(13.5).fillColor(BLEU).text(s.titre, MARGE, doc.y, { width: LARGEUR });
      doc.moveDown(0.35);
      for (const t of s.texte ?? []) paragraphe(remplacer(t, valeurs));
      if (s.puces) puces(s.puces);
      if (s.image) image(s.image, s.legende);
      else doc.moveDown(0.6);
    }
  });

  // ── Pied de page numéroté ──
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    if (i === 0) continue;
    // Écrire sous la marge basse sans que pdfkit crée une nouvelle page
    const marge = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8.5).fillColor(GRIS)
      .text(`${application} — Manuel d'utilisation · ${entreprise.nom}`, MARGE, doc.page.height - MARGE + 8, { width: LARGEUR - 60, lineBreak: false });
    doc.text(`${i + 1} / ${count}`, MARGE + LARGEUR - 60, doc.page.height - MARGE + 8, { width: 60, align: 'right', lineBreak: false });
    doc.page.margins.bottom = marge;
  }
  doc.end();
  return fini;
}

/** Données du manuel pour l'entreprise courante (dans son contexte) : nom de l'application, lien, administrateurs, logo. */
async function donnees(entreprise, origine) {
  const p = await Parametres.findById('general').select('+logo').lean();
  const admins = (await Utilisateur.find({ role: ROLES.ADMIN, actif: true }, { email: 1 }).sort({ createdAt: 1 }).lean()).map((u) => u.email);
  return {
    entreprise, application: p?.nomApplication || 'Gestion colis', admins, logo: logoPdf(p?.logo),
    lien: `${baseLiens(p, origine)}/connexion/${entreprise.code}`,
  };
}

const contexte = (e) => ({ code: e.code, nom: e.nom, base: e.base });
const nomFichier = (e) => `manuel-${e.code}.pdf`;

/** PDF du manuel d'une entreprise (téléchargement depuis la plateforme). */
export function manuelPdf(e, origine) {
  return dansEntreprise(contexte(e), async () => ({ nom: nomFichier(e), pdf: await genererManuel(await donnees(e, origine)) }));
}

/** PDF du manuel téléchargé depuis la page de connexion (déjà dans le contexte de l'entreprise) : sans les e-mails des administrateurs. */
export async function manuelPublic(e, origine) {
  return { nom: nomFichier(e), pdf: await genererManuel({ ...(await donnees(e, origine)), admins: [] }) };
}

/** Envoie le manuel en pièce jointe aux administrateurs de l'entreprise (ou aux adresses données). */
export function envoyerManuel(e, { a = '', origine, par = '' } = {}) {
  return dansEntreprise(contexte(e), async () => {
    const d = await donnees(e, origine);
    const dest = String(a ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const destinataires = dest.length ? dest : d.admins;
    if (!destinataires.length) return { envoye: false, a: '', erreur: 'Aucun administrateur actif dans cette entreprise' };
    const pdf = await genererManuel(d);
    const echapper = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const texte = [
      'Bonjour,', '',
      `Vous trouverez ci-joint le manuel d'utilisation de ${d.application} pour ${e.nom}.`, '',
      `Lien de connexion : ${d.lien}`, `Identifiant de l'entreprise : ${e.code}`, '',
      "Le manuel explique la première connexion, le paramétrage (dépôts, destinations, comptes…) et l'utilisation au quotidien, avec des captures d'écran.",
      'Votre code provisoire de connexion vous est envoyé dans un e-mail séparé.', '', `— ${d.application}`,
    ].join('\n');
    const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e7ef">
<tr><td style="background:#111827;color:#fff;padding:16px 24px;font-size:18px;font-weight:700">${echapper(d.application)}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 12px">Bonjour,</p>
<p style="margin:0 0 16px;line-height:1.5">Vous trouverez ci-joint le <b>manuel d'utilisation</b> de ${echapper(d.application)} pour <b>${echapper(e.nom)}</b> : première connexion, paramétrage et utilisation au quotidien, avec des captures d'écran.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 18px">
<tr><td style="padding:3px 12px 3px 0;color:#677085">Identifiant</td><td style="font-family:Consolas,monospace;font-weight:700">${echapper(e.code)}</td></tr></table>
<p style="text-align:center;margin:0 0 18px"><a href="${echapper(d.lien)}" style="display:inline-block;background:#1f5fd1;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Se connecter</a></p>
<p style="margin:0;color:#677085;font-size:13px">Votre code provisoire de connexion vous est envoyé dans un e-mail séparé.</p>
</td></tr></table></td></tr></table></body></html>`;
    return envoyer({
      a: destinataires.join(', '), sujet: `${d.application} — manuel d'utilisation (${e.nom})`, texte, html,
      pieces: [{ filename: nomFichier(e), content: pdf, contentType: 'application/pdf' }],
    }, null, { motif: 'manuel', par, destinataireNom: e.nom });
  });
}
