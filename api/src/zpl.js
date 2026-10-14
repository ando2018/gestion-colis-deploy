import { segmentPublic } from './locataire.js';
import net from 'node:net';
import { contenuCode128, epaisseur128, modules128 } from './code128.js';

/**
 * Étiquettes ZPL 100×150 mm conçues en 203 dpi (8 points/mm) ;
 * mises à l'échelle pour une imprimante 300 dpi.
 */

// Retire les caractères de contrôle ZPL (^ et ~) des champs saisis.
const champ = (v) => String(v ?? '').replace(/[\^~]/g, ' ');
const euros = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} EUR`;

function echelle(zpl, dpi = 203) {
  if (dpi === 203) return zpl;
  const k = dpi / 203;
  // Coordonnées et tailles numériques après ^FO, ^A0N, ^BY, ^BCN, ^BQN
  return zpl
    .replace(/\^FO(\d+),(\d+)/g, (_, x, y) => `^FO${Math.round(x * k)},${Math.round(y * k)}`)
    .replace(/\^A0N,(\d+),(\d+)/g, (_, h, w) => `^A0N,${Math.round(h * k)},${Math.round(w * k)}`)
    .replace(/\^BY(\d+)/g, (_, w) => `^BY${Math.max(2, Math.round(w * k))}`)
    .replace(/\^GB(\d+),(\d+),(\d+)/g, (_, w, h, t) => `^GB${Math.round(w * k)},${Math.round(h * k)},${Math.round(t * k)}`)
    .replace(/\^FB(\d+)/g, (_, w) => `^FB${Math.round(w * k)}`)
    .replace(/\^BCN,(\d+)/g, (_, h) => `^BCN,${Math.round(h * k)}`)
    .replace(/\^BQN,2,(\d+)/g, (_, m) => `^BQN,2,${Math.min(10, Math.round(m * k))}`);
}

/**
 * Code-barres Code 128 centré sur l'étiquette (800 points de large) : barres de 3 points si le code tient,
 * sinon 2, toujours avec sa zone blanche ; mode automatique « A » (chiffres par paires, code plus court).
 */
function codeBarres(y, hauteur, numero, code) {
  const contenu = code || contenuCode128(numero);
  const e = epaisseur128(contenu, 760, 6) ?? 2;
  const x = Math.max(20, Math.round((800 - modules128(contenu) * e) / 2));
  // Barres sans texte automatique ; dessous, le numéro lisible avec ses tirets, centré.
  return `^FO${x},${y}^BY${e}^BCN,${hauteur},N,N,N,A^FD${champ(contenu)}^FS\n^FO0,${y + hauteur + 10}^FB800,1,0,C^A0N,30,30^FD${champ(numero)}^FS`;
}

/**
 * Texte en gras : la police A0 de la Zebra n'a pas de graisse, on imprime donc chaque texte deux fois,
 * décalé de 2 points à droite (lisible même avec une tête d'impression usée ou un papier thermique pâle).
 */
function gras(zpl) {
  return zpl.split('\n').flatMap((l) => {
    const t = l.match(/^\^FO(\d+),(\d+)(\^A0N,.*)$/);
    return t ? [l, `^FO${Number(t[1]) + 2},${t[2]}${t[3]}`] : [l];
  }).join('\n');
}

/** Téléphone anonymisé : seuls les 4 derniers chiffres (« **** 5678 »). */
export function telMasque(tel) {
  const chiffres = String(tel ?? '').replace(/\D/g, '');
  return chiffres.length >= 4 ? `**** ${chiffres.slice(-4)}` : '';
}
const coupe = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n - 1)}.` : t; };
const jour = (d) => new Date(d ?? Date.now()).toLocaleDateString('fr-FR');
const heure = (d) => new Date(d ?? Date.now()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Bandeau noir en haut : nom de l'application (texte blanc) et mention à droite. */
function bandeau(nom, droite) {
  return [
    '^FO0,0^GB800,100,100^FS',
    `^FO30,24^FR^A0N,58,54^FD${champ(coupe(nom, 22))}^FS`,
    `^FO0,34^FR^A0N,38,34^FB770,1,0,R^FD${champ(droite)}^FS`,
  ];
}

/** Taille approximative d'un QR (correction Q) pour le centrer : nombre de modules selon la longueur. */
function modulesQr(longueur) {
  const capacite = [[11, 21], [20, 25], [32, 29], [46, 33], [60, 37], [74, 41], [86, 45], [108, 49], [130, 53]];
  return (capacite.find(([c]) => longueur <= c) ?? [0, 57])[1];
}

/**
 * Étiquette colis 100×150 mm, façon transporteur : bandeau au nom de l'application, destination en très grand,
 * pièce et poids, destinataire (téléphone anonymisé), code-barres ou QR, encadré de paiement, pied de page.
 * Une étiquette par pièce (COL-ABJ-121026-0042-2/3…). L'aperçu web/src/app/shared/etiquette.ts reprend ces positions.
 */
export function etiquettesColis(colis, destination, dpi, typeCode = 'QR', nomApp = 'Gestion colis') {
  const reste = Math.max(0, colis.montant - (colis.paiement?.recu ?? 0));
  const ville = (destination?.ville ?? colis.destination).toUpperCase();
  const etiquettes = [];
  // Place dans l'envoi (colis 1/2, 2/2…) ; pièces en plus si le colis en compte plusieurs
  const rang = colis.rangEnvoi ?? 1;
  const total = colis.nbEnvoi ?? 1;
  for (let i = 1; i <= colis.nbPieces; i++) {
    const code = colis.nbPieces > 1 ? `${colis.numero}-${i}/${colis.nbPieces}` : colis.numero;
    const detail = `Colis ${rang} sur ${total}${colis.nbPieces > 1 ? ` - pièce ${i}/${colis.nbPieces}` : ''}`;
    const paiement = reste <= 0
      ? ['^FO30,965^GB420,110,4^FS', '^FO30,990^A0N,70,64^FB420,1,0,C^FDPAYÉ^FS']
      : ['^FO30,965^GB520,110,110^FS', '^FO30,977^FR^A0N,36,34^FB520,1,0,C^FDÀ PAYER À DESTINATION^FS',
        `^FO30,1020^FR^A0N,46,42^FB520,1,0,C^FD${champ(euros(reste))}^FS`];
    const zoneCode = typeCode === 'CODE_BARRE'
      ? [codeBarres(660, 200, code, colis.code)]
      : [`^FO40,650^BQN,2,9^FDQA,${champ(code)}^FS`,
        '^FO330,675^A0N,28,28^FDN° DE COLIS^FS', `^FO330,715^A0N,46,40^FD${champ(colis.numero)}^FS`,
        `^FO330,775^A0N,32,30^FD${champ(detail)}^FS`, `^FO330,820^A0N,28,26^FDCode ${champ(colis.code ?? '')}^FS`];
    etiquettes.push(echelle(gras([
      '^XA', '^CI28',
      ...bandeau(nomApp, jour(colis.dateReception)),
      // Destination | pièce et poids
      '^FO0,100^GB800,300,4^FS', '^FO440,100^GB4,300,4^FS',
      '^FO30,118^A0N,28,28^FDDESTINATION^FS',
      `^FO30,150^A0N,180,150^FD${champ(colis.destination)}^FS`,
      `^FO30,340^A0N,44,40^FD${champ(coupe(ville, 18))}^FS`,
      '^FO470,118^A0N,28,28^FDCOLIS^FS',
      `^FO470,150^A0N,120,104^FD${rang}/${total}^FS`,
      '^FO470,290^A0N,28,28^FDPOIDS^FS',
      `^FO470,330^A0N,52,48^FD${String(colis.poidsKg).replace('.', ',')} kg^FS`,
      // Destinataire (téléphone anonymisé)
      '^FO30,420^A0N,28,28^FDDESTINATAIRE^FS',
      `^FO30,458^A0N,54,48^FD${champ(coupe(colis.destinataire?.nom, 26))}^FS`,
      `^FO30,525^A0N,42,38^FDTél. ${champ(telMasque(colis.destinataire?.tel))}^FS`,
      colis.destinataire?.adresse ? `^FO30,578^A0N,30,28^FD${champ(coupe(colis.destinataire.adresse, 44))}^FS` : '',
      '^FO0,630^GB800,4,4^FS',
      ...zoneCode,
      '^FO0,945^GB800,4,4^FS',
      ...paiement,
      colis.priorite > 0 ? '^FO580,965^GB190,110,110^FS' : '',
      colis.priorite > 0 ? '^FO580,1000^FR^A0N,40,34^FB190,1,0,C^FDRELIQUAT^FS' : '',
      // Pied de page
      '^FO0,1100^GB800,3,3^FS',
      `^FO30,1122^A0N,28,26^FDDépôt ${champ(colis.depot)} · reçu le ${jour(colis.dateReception)} à ${heure(colis.dateReception)}^FS`,
      `^FO30,1158^A0N,26,24^FD${champ(colis.numero)}^FS`,
      `^FO0,1158^A0N,26,24^FB770,1,0,R^FD${champ(coupe(nomApp, 30))}^FS`,
      '^XZ',
    ].filter(Boolean).join('\n')), dpi));
  }
  return etiquettes.join('\n');
}

/**
 * Étiquette palette 100×150 mm : bandeau, destination en très grand, nombre de colis et poids,
 * numéro de palette, QR de l'adresse publique (ou code-barres), pied de page.
 */
export function etiquettePalette(palette, destination, urlPublique, dpi, typeCode = 'QR', nomApp = 'Gestion colis') {
  const ville = (destination?.ville ?? palette.destination).toUpperCase();
  const url = `${urlPublique}/p/${segmentPublic(palette.depot)}/${palette.numero}`;
  const tailleQr = modulesQr(url.length) * 9;
  return echelle(gras([
    '^XA', '^CI28',
    ...bandeau(nomApp, 'PALETTE'),
    '^FO0,100^GB800,320,4^FS', '^FO470,100^GB4,320,4^FS',
    '^FO30,118^A0N,28,28^FDDESTINATION^FS',
    `^FO30,150^A0N,190,160^FD${champ(palette.destination)}^FS`,
    `^FO30,355^A0N,46,42^FD${champ(coupe(ville, 16))}^FS`,
    '^FO500,118^A0N,28,28^FDCOLIS^FS',
    `^FO500,150^A0N,150,130^FD${palette.nbColis ?? 0}^FS`,
    '^FO500,310^A0N,28,28^FDPOIDS^FS',
    `^FO500,350^A0N,48,44^FD${String(palette.poidsTotal ?? 0).replace('.', ',')} kg^FS`,
    // Numéro de palette en grand, centré
    `^FO0,445^A0N,84,58^FB800,1,0,C^FD${champ(palette.numero)}^FS`,
    '^FO0,550^GB800,4,4^FS',
    typeCode === 'CODE_BARRE'
      ? codeBarres(590, 260, palette.numero, palette.code)
      : `^FO${Math.max(20, Math.round((800 - tailleQr) / 2))},575^BQN,2,9^FDQA,${champ(url)}^FS`,
    '^FO0,1100^GB800,3,3^FS',
    `^FO30,1122^A0N,28,26^FDDépôt ${champ(palette.depot)} · créée le ${jour(palette.createdAt)}^FS`,
    `^FO30,1158^A0N,26,24^FDCode ${champ(palette.code ?? '')}^FS`,
    `^FO0,1158^A0N,26,24^FB770,1,0,R^FD${champ(coupe(nomApp, 30))}^FS`,
    '^XZ',
  ].filter(Boolean).join('\n')), dpi);
}

/** Envoie le ZPL à l'imprimante réseau (port 9100). */
export function envoyer(zpl, { hote, port = 9100 }, delaiMs = 5000) {
  return new Promise((resoudre, rejeter) => {
    const socket = net.connect(port, hote, () => (Buffer.isBuffer(zpl) ? socket.end(zpl) : socket.end(zpl, 'utf8')));
    socket.setTimeout(delaiMs, () => socket.destroy(new Error(`Imprimante ${hote}:${port} injoignable`)));
    socket.on('close', (erreur) => (erreur ? null : resoudre()));
    socket.on('error', rejeter);
  });
}
