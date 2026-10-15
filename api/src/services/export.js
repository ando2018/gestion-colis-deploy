// Export détaillé (Administration → Export) : chaque colis avec sa palette et son conteneur, poids, personnes, dates…
// Prix de chaque colis : montant calculé, options (avec leur prix), offre de réduction (code promo), montant à payer, payé et reste.
// Formats : CSV (Excel français : « ; », virgule décimale), Excel (.xlsx : colis, palettes, conteneurs), PDF (paysage).
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Colis, COLIS, Conteneur, Destination, Evenement, Palette, Parametres } from '../modeles.js';
import { filtreDepot, r2, requete, texte } from '../noyau.js';

const MAX = 20000;
const LIBELLES_STATUT = {
  RECU: 'Reçu', SUR_PALETTE: 'Sur palette', ZONE_DEPART: 'Zone de départ', CHARGE: 'Chargé', PARTI: 'Parti', RELIQUAT: 'Reliquat',
  ANNULE: 'Annulé', OUVERTE: 'Ouverte', FERMEE: 'Fermée', CHARGEE: 'Chargée', PARTIE: 'Partie', EN_CHARGEMENT: 'En chargement', ARRIVE: 'Arrivé',
};
const LIBELLES_PAIEMENT = { PAYE: 'Payé', PARTIEL: 'Partiel', A_DESTINATION: 'À destination' };
const statut = (s) => LIBELLES_STATUT[s] ?? s ?? '';
const euros = (n) => `${(Number(n) || 0).toFixed(2).replace('.', ',')} €`;
const jour = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? new Date(`${v}T00:00:00`) : null);

/** Colonnes de l'export : clé, titre, largeur Excel, type (texte, nombre, montant, date). */
export const COLONNES = [
  ['numero', 'N° colis', 22], ['code', 'Code-barres', 11], ['envoi', 'Envoi', 22], ['rang', 'Colis (rang)', 9],
  ['depot', 'Dépôt', 8], ['destination', 'Destination', 9], ['ville', 'Ville', 14], ['statut', 'Statut', 13],
  ['description', 'Description', 22], ['poidsKg', 'Poids (kg)', 10, 'nombre'], ['nbPieces', 'Pièces', 7, 'nombre'],
  ['dimensions', 'Dimensions', 12], ['options', 'Options', 28], ['montantCalcule', 'Prix calculé (€)', 12, 'montant'],
  ['codePromo', 'Offre (code promo)', 14], ['pourcentageRemise', 'Réduction (%)', 10, 'nombre'], ['remise', 'Réduction (€)', 11, 'montant'],
  ['montant', 'Montant (€)', 11, 'montant'], ['montantPaye', 'Payé (€)', 11, 'montant'], ['reste', 'Reste (€)', 11, 'montant'],
  ['statutPaiement', 'Statut paiement', 13],
  ['expediteur', 'Expéditeur', 20], ['expediteurTel', 'Tél. expéditeur', 15], ['pieceIdentite', 'Pièce d\'identité', 15],
  ['destinataire', 'Destinataire', 20], ['destinataireTel', 'Tél. destinataire', 16], ['destinataireAdresse', 'Adresse destinataire', 24],
  ['palette', 'Palette', 22], ['paletteStatut', 'Statut palette', 13],
  ['conteneur', 'Conteneur', 22], ['numeroOfficiel', 'N° officiel', 14], ['scelle', 'Scellé', 12], ['conteneurStatut', 'Statut conteneur', 14],
  ['dateReception', 'Enregistré le', 17, 'date'], ['enregistrePar', 'Enregistré par', 16],
  ['dateChargement', 'Chargé le', 17, 'date'], ['dateDepart', 'Départ le', 17, 'date'], ['dateArrivee', 'Arrivé le', 17, 'date'],
  ['nbReports', 'Reports', 8, 'nombre'], ['motifAnnulation', 'Motif annulation', 18],
];

/** Lignes de l'export, filtrées (période d'enregistrement, dépôt, destination, statut). */
export async function lignes(req, q) {
  const filtre = { ...filtreDepot(req) };
  if (texte(q?.depot)) filtre.depot = texte(q.depot).toUpperCase();
  if (texte(q?.destination)) filtre.destination = texte(q.destination).toUpperCase();
  if (texte(q?.statut)) filtre.statut = { $in: texte(q.statut).split(',').filter((s) => Object.values(COLIS).includes(s)) };
  const du = jour(q?.du);
  const au = jour(q?.au);
  if (du || au) filtre.dateReception = { ...(du ? { $gte: du } : {}), ...(au ? { $lt: new Date(au.getTime() + 86400000) } : {}) };
  if (du && au && au < du) throw requete('Période invalide : la date de fin précède la date de début');

  const colis = await Colis.find(filtre)
    .populate('paletteId', 'numero statut')
    .populate('conteneurId', 'numero numeroOfficiel scelle statut dateChargement dateDepart dateArrivee')
    .sort({ dateReception: 1, numero: 1 }).limit(MAX).lean();
  const [destinations, receptions] = await Promise.all([
    Destination.find({}, { code: 1, ville: 1 }).lean(),
    Evenement.find({ type: 'RECEPTION', entiteId: { $in: colis.map((c) => c._id) } }, { entiteId: 1, utilisateurNom: 1 }).lean(),
  ]);
  const ville = new Map(destinations.map((d) => [d.code, d.ville]));
  const auteur = new Map(receptions.map((e) => [String(e.entiteId), e.utilisateurNom]));
  return colis.map((c) => {
    const k = c.conteneurId;
    return {
      numero: c.numero, code: c.code ?? '', envoi: c.envoi ?? c.numero, rang: `${c.rangEnvoi ?? 1}/${c.nbEnvoi ?? 1}`,
      depot: c.depot, destination: c.destination, ville: ville.get(c.destination) ?? '', statut: statut(c.statut),
      description: c.description ?? '', poidsKg: c.poidsKg, nbPieces: c.nbPieces ?? 1, dimensions: c.dimensions ?? '',
      options: (c.options ?? []).map((o) => `${o.libelle} (${euros(o.montant ?? 0)})`).join(', '),
      optionsDetail: (c.options ?? []).map((o) => ({ libelle: o.libelle, montant: o.montant ?? 0 })),
      offre: c.codePromo ? `${c.codePromo} -${c.pourcentageRemise ?? 0}% (-${euros(c.remise)})` : '',
      codePromo: c.codePromo ?? '', pourcentageRemise: c.codePromo ? c.pourcentageRemise ?? 0 : null, remise: c.codePromo ? c.remise ?? 0 : null,
      montantCalcule: c.montantCalcule ?? c.montant ?? 0, montant: c.montant ?? 0, montantPaye: c.paiement?.recu ?? 0,
      reste: r2(Math.max(0, (c.montant ?? 0) - (c.paiement?.recu ?? 0))),
      statutPaiement: LIBELLES_PAIEMENT[c.paiement?.statut] ?? c.paiement?.statut ?? '',
      expediteur: c.expediteur?.nom ?? '', expediteurTel: c.expediteur?.tel ?? '', pieceIdentite: c.expediteur?.pieceIdentite ?? '',
      destinataire: c.destinataire?.nom ?? '', destinataireTel: c.destinataire?.tel ?? '', destinataireAdresse: c.destinataire?.adresse ?? '',
      palette: c.paletteId?.numero ?? '', paletteStatut: statut(c.paletteId?.statut),
      conteneur: k?.numero ?? '', numeroOfficiel: k?.numeroOfficiel ?? '', scelle: k?.scelle ?? '', conteneurStatut: statut(k?.statut),
      dateReception: c.dateReception ?? c.createdAt ?? null, enregistrePar: auteur.get(String(c._id)) ?? '',
      dateChargement: k?.dateChargement ?? null, dateDepart: k?.dateDepart ?? null, dateArrivee: k?.dateArrivee ?? null,
      nbReports: c.nbReports ?? 0, motifAnnulation: c.motifAnnulation ?? '',
    };
  });
}

const fuseau = () => process.env.FUSEAU ?? 'Europe/Paris';
const dateFr = (d) => (d ? new Date(d).toLocaleString('fr-FR', { timeZone: fuseau(), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const nombreFr = (n) => (n == null || n === '' ? '' : String(n).replace('.', ','));
const montantFr = (n) => (n == null || n === '' ? '' : Number(n).toFixed(2).replace('.', ','));
/** Valeur d'une cellule CSV / PDF selon le type de colonne. */
const formate = (v, type) => (type === 'date' ? dateFr(v) : type === 'montant' ? montantFr(v) : type ? nombreFr(v) : v);

const somme = (l, k) => r2(l.reduce((s, x) => s + (x[k] || 0), 0));

/** Totaux pour l'aperçu, l'en-tête du PDF et la feuille Résumé. */
function totaux(l) {
  return {
    colis: l.length, poids: r2(l.reduce((s, x) => s + (x.poidsKg || 0), 0)),
    palettes: new Set(l.map((x) => x.palette).filter(Boolean)).size, conteneurs: new Set(l.map((x) => x.conteneur).filter(Boolean)).size,
    montant: somme(l, 'montant'), paye: somme(l, 'montantPaye'), reste: somme(l, 'reste'), remises: somme(l, 'remise'),
  };
}

const descriptionFiltres = (q) => [
  q?.du || q?.au ? `Enregistrés ${q.du ? `du ${q.du.split('-').reverse().join('/')}` : ''} ${q.au ? `au ${q.au.split('-').reverse().join('/')}` : ''}`.replace(/\s+/g, ' ').trim() : 'Toutes les dates',
  q?.depot ? `dépôt ${q.depot}` : 'tous les dépôts', q?.destination ? `destination ${q.destination}` : 'toutes destinations',
  q?.statut ? `statut ${q.statut.split(',').map(statut).join(', ')}` : 'tous statuts',
].join(' · ');

// ───────────── CSV ─────────────

export function csv(l) {
  const champ = (v) => {
    const t = String(v ?? '');
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const valeur = (ligne, [cle, , , type]) => formate(ligne[cle], type);
  const corps = [COLONNES.map(([, t]) => t), ...l.map((x) => COLONNES.map((c) => valeur(x, c)))].map((r) => r.map(champ).join(';')).join('\r\n');
  return `﻿${corps}\r\n`; // BOM : accents corrects à l'ouverture dans Excel
}

// ───────────── Excel ─────────────

export async function xlsx(req, l, q) {
  const params = await Parametres.findById('general').lean();
  const wb = new ExcelJS.Workbook();
  wb.creator = params?.nomApplication || 'Gestion colis';
  wb.created = new Date();
  const entete = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5FD1' } };
    r.alignment = { vertical: 'middle', wrapText: true };
    r.height = 30;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  };

  const wsR = wb.addWorksheet('Résumé'); // première feuille, remplie à la fin
  // Feuille Colis : toutes les colonnes
  const wsC = wb.addWorksheet('Colis');
  wsC.columns = COLONNES.map(([key, header, width, type]) => ({
    key, header, width,
    style: type === 'montant' ? { numFmt: '#,##0.00 "€"' } : type === 'nombre' ? { numFmt: '#,##0.##' } : type === 'date' ? { numFmt: 'dd/mm/yyyy hh:mm' } : {},
  }));
  for (const x of l) wsC.addRow({ ...x, ...Object.fromEntries(COLONNES.filter((c) => c[3] === 'date').map(([k]) => [k, x[k] ? new Date(x[k]) : null])) });
  entete(wsC);

  // Feuille Palettes : une ligne par palette des colis exportés
  const numerosPal = [...new Set(l.map((x) => x.palette).filter(Boolean))];
  const palettes = numerosPal.length ? await Palette.find({ numero: { $in: numerosPal } }).populate('conteneurId', 'numero').lean() : [];
  const wsP = wb.addWorksheet('Palettes');
  wsP.columns = [
    { key: 'numero', header: 'Palette', width: 22 }, { key: 'depot', header: 'Dépôt', width: 8 }, { key: 'destination', header: 'Destination', width: 10 },
    { key: 'statut', header: 'Statut', width: 14 }, { key: 'nbColis', header: 'Colis', width: 8 }, { key: 'poidsTotal', header: 'Poids (kg)', width: 11, style: { numFmt: '#,##0.##' } },
    { key: 'poidsMaxKg', header: 'Poids max (kg)', width: 13 }, { key: 'conteneur', header: 'Conteneur', width: 22 },
    { key: 'creeLe', header: 'Créée le', width: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ];
  for (const p of palettes) wsP.addRow({ ...p, statut: statut(p.statut), conteneur: p.conteneurId?.numero ?? '', creeLe: p.createdAt ? new Date(p.createdAt) : null });
  entete(wsP);

  // Feuille Conteneurs
  const numerosCtn = [...new Set(l.map((x) => x.conteneur).filter(Boolean))];
  const conteneurs = numerosCtn.length ? await Conteneur.find({ numero: { $in: numerosCtn } }).lean() : [];
  const wsK = wb.addWorksheet('Conteneurs');
  const d = (v) => (v ? new Date(v) : null);
  wsK.columns = [
    { key: 'numero', header: 'Conteneur', width: 22 }, { key: 'numeroOfficiel', header: 'N° officiel', width: 14 }, { key: 'scelle', header: 'Scellé', width: 12 },
    { key: 'depot', header: 'Dépôt', width: 8 }, { key: 'destination', header: 'Destination', width: 10 }, { key: 'type', header: 'Type', width: 8 },
    { key: 'statut', header: 'Statut', width: 14 }, { key: 'nbColis', header: 'Colis', width: 8 }, { key: 'poidsTotal', header: 'Poids (kg)', width: 11, style: { numFmt: '#,##0.##' } },
    { key: 'creeLe', header: 'Créé le', width: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { key: 'dateChargement', header: 'Chargé le', width: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
    { key: 'dateDepart', header: 'Départ le', width: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } }, { key: 'dateArrivee', header: 'Arrivé le', width: 17, style: { numFmt: 'dd/mm/yyyy hh:mm' } },
  ];
  for (const k of conteneurs) {
    const sesColis = l.filter((x) => x.conteneur === k.numero);
    wsK.addRow({
      ...k, statut: statut(k.statut), nbColis: k.nbColis || sesColis.length, poidsTotal: k.poidsTotal || r2(sesColis.reduce((s, x) => s + x.poidsKg, 0)),
      creeLe: d(k.createdAt), dateChargement: d(k.dateChargement), dateDepart: d(k.dateDepart), dateArrivee: d(k.dateArrivee),
    });
  }
  entete(wsK);

  // Feuille Résumé
  const t = totaux(l);
  wsR.columns = [{ width: 28 }, { width: 50 }];
  [['Export', `${params?.nomApplication || 'Gestion colis'} — ${req.entreprise?.nom ?? ''}`], ['Établi le', dateFr(new Date())], ['Filtres', descriptionFiltres(q)],
    ['Colis', t.colis], ['Poids total (kg)', t.poids], ['Palettes', t.palettes], ['Conteneurs', t.conteneurs],
    ['Montant total (€)', t.montant], ['Payé (€)', t.paye], ['Reste à payer (€)', t.reste], ['Réductions accordées (€)', t.remises]].forEach(([a, b]) => { const r = wsR.addRow([a, b]); r.getCell(1).font = { bold: true }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────── PDF ─────────────

/** Colonnes du PDF (paysage) : l'essentiel de chaque colis ; le détail complet est dans le CSV et l'Excel. */
const COLONNES_PDF = [
  ['numero', 'Colis', 92], ['rang', 'Rang', 30], ['destination', 'Dest.', 34], ['statut', 'Statut', 56], ['expediteur', 'Expéditeur', 78],
  ['destinataire', 'Destinataire', 84], ['poidsKg', 'Kg', 32, 'nombre'], ['options', 'Options', 80], ['offre', 'Offre', 62],
  ['montant', 'Montant €', 44, 'montant'], ['montantPaye', 'Payé €', 44, 'montant'], ['statutPaiement', 'Paiement', 52],
  ['palette', 'Palette', 92], ['conteneur', 'Conteneur', 92], ['dateReception', 'Enregistré', 58, 'date'], ['dateDepart', 'Départ', 58, 'date'],
];

export async function pdf(req, l, q) {
  const params = await Parametres.findById('general').lean();
  const application = params?.nomApplication || 'Gestion colis';
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true, info: { Title: `${application} — export des colis` } });
  const morceaux = [];
  doc.on('data', (c) => morceaux.push(c));
  const fini = new Promise((ok) => doc.on('end', () => ok(Buffer.concat(morceaux))));
  const largeur = doc.page.width - 56;
  const t = totaux(l);
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#111827').text(`${application} — export détaillé des colis`, 28, 28);
  doc.font('Helvetica').fontSize(9).fillColor('#677085').text(`${req.entreprise?.nom ?? ''} · ${descriptionFiltres(q)} · établi le ${dateFr(new Date())}`);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1d2330')
    .text(`${t.colis} colis · ${nombreFr(t.poids)} kg · ${t.palettes} palette(s) · ${t.conteneurs} conteneur(s) · montant ${euros(t.montant)} · payé ${euros(t.paye)} · reste ${euros(t.reste)}${t.remises ? ` · réductions ${euros(t.remises)}` : ''}`);
  doc.moveDown(0.6);
  const somme = COLONNES_PDF.reduce((s, c) => s + c[2], 0);
  const echelle = largeur / somme;
  const cols = COLONNES_PDF.map(([k, titre, w, type]) => ({ k, titre, w: w * echelle, type }));
  const ligneEntete = () => {
    const y = doc.y;
    doc.rect(28, y, largeur, 16).fill('#1f5fd1');
    let x = 28;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
    for (const c of cols) { doc.text(c.titre, x + 3, y + 4.5, { width: c.w - 6, lineBreak: false, ellipsis: true, align: c.type && c.type !== 'date' ? 'right' : 'left' }); x += c.w; }
    doc.y = y + 16;
  };
  const valeur = (x, c) => (c.type === 'date' ? dateFr(x[c.k]).slice(0, 10) : String(formate(x[c.k], c.type) ?? ''));
  ligneEntete();
  l.forEach((x, i) => {
    // Hauteur de la ligne selon le texte le plus long (un nom long passe sur 2 lignes sans chevaucher la suivante)
    doc.font('Helvetica').fontSize(7.2);
    const textes = cols.map((c) => valeur(x, c));
    const h = Math.max(14, ...cols.map((c, j) => doc.heightOfString(textes[j] || ' ', { width: c.w - 6, lineGap: 1 }) + 7));
    if (doc.y + h > doc.page.height - 36) { doc.addPage(); doc.y = 28; ligneEntete(); }
    const y = doc.y;
    if (i % 2) doc.rect(28, y, largeur, h).fill('#f3f6fb');
    let cx = 28;
    doc.font('Helvetica').fontSize(7.2).fillColor('#1d2330');
    cols.forEach((c, j) => {
      doc.text(textes[j], cx + 3, y + 4, { width: c.w - 6, lineGap: 1, align: c.type && c.type !== 'date' ? 'right' : 'left' });
      cx += c.w;
    });
    doc.y = y + h;
  });
  if (!l.length) doc.font('Helvetica-Oblique').fontSize(10).fillColor('#677085').text('Aucun colis pour ces critères.', 28, doc.y + 10);
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const marge = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#677085').text(`${application} — export des colis · page ${i + 1} / ${count}`, 28, doc.page.height - 22, { width: largeur, align: 'right', lineBreak: false });
    doc.page.margins.bottom = marge;
  }
  doc.end();
  return fini;
}

/** Aperçu avant téléchargement : nombre de colis et totaux. */
/** Nombre de colis montrés dans l'aperçu (l'export, lui, contient tous les colis). */
const APERCU_MAX = 500;
const CHAMPS_APERCU = ['numero', 'rang', 'depot', 'destination', 'ville', 'statut', 'description', 'poidsKg', 'expediteur', 'destinataire',
  'optionsDetail', 'codePromo', 'pourcentageRemise', 'remise', 'montant', 'montantPaye', 'statutPaiement', 'palette', 'conteneur', 'dateReception', 'dateDepart'];

/** Aperçu avant téléchargement : totaux et liste des colis qui seront exportés (500 premiers). */
export async function apercu(req, q) {
  const l = await lignes(req, q);
  return { ...totaux(l), lignes: l.slice(0, APERCU_MAX).map((x) => Object.fromEntries(CHAMPS_APERCU.map((k) => [k, x[k]]))) };
}

/** Fichier d'export dans le format demandé. */
export async function fichier(req, q) {
  const l = await lignes(req, q);
  const nom = `export-colis-${new Date().toISOString().slice(0, 10)}`;
  if (q?.format === 'csv') return { nom: `${nom}.csv`, type: 'text/csv; charset=utf-8', contenu: Buffer.from(csv(l), 'utf8') };
  if (q?.format === 'pdf') return { nom: `${nom}.pdf`, type: 'application/pdf', contenu: await pdf(req, l, q) };
  if (q?.format === 'xlsx') return { nom: `${nom}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contenu: await xlsx(req, l, q) };
  throw requete('Format attendu : csv, xlsx ou pdf');
}
