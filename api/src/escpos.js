import { segmentPublic } from './locataire.js';
/**
 * Tickets pour imprimante thermique POS (commandes ESC/POS, rouleau de 58 ou 80 mm), envoyés sur le port 9100
 * comme le ZPL des Zebra. Même contenu que l'étiquette Zebra : numéro, QR code ou code-barres, destination, destinataire.
 */

import { contenuCode128, epaisseur128, segments128 } from './code128.js';

const ESC = 0x1b;
const GS = 0x1d;
const octets = (...l) => Buffer.from(l);

// Sans accents : les imprimantes POS n'ont pas toutes la bonne page de caractères (é → e, ç → c, € → EUR).
const texte = (v) => String(v ?? '').replace(/€/g, 'EUR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
const ligne = (v) => Buffer.from(`${texte(v)}\n`, 'latin1');

const INIT = octets(ESC, 0x40);
const centre = octets(ESC, 0x61, 1);
const gauche = octets(ESC, 0x61, 0);
const gras = (oui) => octets(ESC, 0x45, oui ? 1 : 0);
/** Taille du texte : largeur et hauteur de 1 à 8. */
const taille = (l, h) => octets(GS, 0x21, ((l - 1) << 4) | (h - 1));
const avance = (n) => octets(ESC, 0x64, n);
const coupe = octets(GS, 0x56, 0x42, 0x00);
const inverse = (oui) => octets(GS, 0x42, oui ? 1 : 0);
const telMasque = (tel) => { const c = String(tel ?? '').replace(/\D/g, ''); return c.length >= 4 ? `**** ${c.slice(-4)}` : ''; };

/** QR code natif (modèle 2, correction Q). */
function qr(donnees, module) {
  const d = Buffer.from(texte(donnees), 'latin1');
  const n = d.length + 3;
  return Buffer.concat([
    octets(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00), // modèle 2
    octets(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, module), // taille du module
    octets(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x32), // correction Q
    octets(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30), d, // données
    octets(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30), // impression
  ]);
}

/** Code 128 : jeu B pour les lettres, jeu C pour les suites de chiffres (2 par symbole), texte lisible dessous. */
function code128(donnees, largeurModule, hauteur) {
  const parties = segments128(texte(donnees)).map(({ jeu, valeur }) => (jeu === 'C'
    ? Buffer.concat([Buffer.from('{C', 'latin1'), Buffer.from(valeur.match(/\d\d/g).map(Number))])
    : Buffer.from(`{B${valeur}`, 'latin1')));
  const d = Buffer.concat(parties);
  return Buffer.concat([
    octets(GS, 0x68, hauteur), octets(GS, 0x77, largeurModule), octets(GS, 0x48, 0), octets(GS, 0x66, 0),
    octets(GS, 0x6b, 73, d.length), d,
  ]);
}

/**
 * Code-barres si le rouleau est assez large pour des barres d'au moins 2 points (zones blanches comprises),
 * sinon QR code : un code-barres trop serré ne serait pas lu par la douchette (fréquent en 58 mm).
 */
function codeLisible(donnees, largeurMm, hauteur, code) {
  const points = largeurMm >= 80 ? 576 : 384;
  const contenu = code || contenuCode128(donnees);
  const e = epaisseur128(contenu, points, 6);
  return e ? code128(contenu, e, hauteur) : qr(donnees, largeurMm >= 80 ? 8 : 6);
}

const separateur = (largeurMm) => ligne('-'.repeat(largeurMm >= 80 ? 48 : 32));
const euros = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} EUR`;

/** Un ticket par pièce : COL-ABJ-121026-0042-1/3, -2/3… */
export function ticketsColis(colis, destination, { largeurMm = 80, typeCode = 'QR', nomApp = 'Gestion colis' } = {}) {
  const large = largeurMm >= 80;
  const reste = Math.max(0, colis.montant - (colis.paiement?.recu ?? 0));
  const tickets = [];
  for (let i = 1; i <= colis.nbPieces; i++) {
    const code = colis.nbPieces > 1 ? `${colis.numero}-${i}/${colis.nbPieces}` : colis.numero;
    tickets.push(Buffer.concat([
      INIT, centre, gras(true), inverse(true), taille(1, 2), ligne(` ${nomApp} `), inverse(false), taille(1, 1), ligne(''),
      taille(3, 3), ligne(colis.destination), taille(1, 1), ligne((destination?.ville ?? colis.destination).toUpperCase()),
      taille(2, 2), ligne(`COLIS ${colis.rangEnvoi ?? 1}/${colis.nbEnvoi ?? 1}  ${String(colis.poidsKg).replace('.', ',')} kg`), taille(1, 1),
      ligne(colis.nbPieces > 1 ? `piece ${i}/${colis.nbPieces}` : ''),
      typeCode === 'CODE_BARRE' ? Buffer.concat([codeLisible(code, largeurMm, 120, colis.code), ligne(colis.numero)]) : qr(code, large ? 8 : 6), ligne(''),
      separateur(largeurMm), gauche,
      ligne('DESTINATAIRE'), taille(1, 2), ligne(colis.destinataire?.nom ?? ''), taille(1, 1), ligne(`Tel. ${telMasque(colis.destinataire?.tel)}`),
      ligne(`Depot ${colis.depot} - recu le ${new Date(colis.dateReception ?? Date.now()).toLocaleDateString('fr-FR')}`),
      separateur(largeurMm), centre, taille(2, 2), ...(reste <= 0 ? [ligne('PAYE')] : [inverse(true), ligne(` A PAYER ${euros(reste)} `), inverse(false)]), taille(1, 1),
      ...(colis.priorite > 0 ? [ligne('RELIQUAT')] : []), taille(1, 1), gras(false),
      avance(4), coupe,
    ]));
  }
  return Buffer.concat(tickets);
}

/** Ticket de palette : numéro en grand, destination, QR de l'adresse publique (ou code-barres du numéro). */
export function ticketPalette(palette, destination, urlPublique, { largeurMm = 80, typeCode = 'QR', nomApp = 'Gestion colis' } = {}) {
  const large = largeurMm >= 80;
  const date = new Date(palette.createdAt ?? Date.now()).toLocaleDateString('fr-FR');
  return Buffer.concat([
    INIT, centre, gras(true), inverse(true), taille(1, 2), ligne(` ${nomApp} - PALETTE `), inverse(false), taille(1, 1), ligne(''),
    taille(3, 3), ligne(palette.destination), taille(1, 1), ligne((destination?.ville ?? palette.destination).toUpperCase()),
    taille(2, 2), ligne(`${palette.nbColis ?? 0} COLIS - ${String(palette.poidsTotal ?? 0).replace('.', ',')} kg`), taille(1, 1),
    taille(1, 2), ligne(palette.numero), taille(1, 1), ligne(''),
    typeCode === 'CODE_BARRE' ? Buffer.concat([codeLisible(palette.numero, largeurMm, 140, palette.code), ligne(palette.numero)]) : qr(`${urlPublique}/p/${segmentPublic(palette.depot)}/${palette.numero}`, large ? 8 : 6),
    ligne(''),
    ligne(`Depot ${palette.depot} - creee le ${date}`), gras(false),
    avance(4), coupe,
  ]);
}
