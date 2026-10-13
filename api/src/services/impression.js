import { Colis, Depot, Destination, Palette } from '../modeles.js';
import { codeScanne, evtColis, evtPalette, filtreDepot, introuvable, journaliser } from '../noyau.js';
import { parametres } from './parametrage.js';
import { envoyer, etiquettePalette, etiquettesColis } from '../zpl.js';
import { ticketPalette, ticketsColis } from '../escpos.js';

async function cible(req, type, numero) {
  const code = codeScanne(numero);
  if (type === 'colis') {
    const colis = await Colis.findOne({ numero: code, ...filtreDepot(req) }).lean();
    if (!colis) throw introuvable(`Colis ${code} introuvable`);
    const [depot, destination, params] = await Promise.all([
      Depot.findOne({ code: colis.depot }).lean(), Destination.findOne({ code: colis.destination }).lean(), parametres(),
    ]);
    const imp = depot?.imprimante;
    return {
      depot, evt: evtColis(colis),
      zpl: etiquettesColis(colis, destination, imp?.dpi, params.typeCode, params.nomApplication),
      pos: () => ticketsColis(colis, destination, { largeurMm: imp?.largeurPapier, typeCode: params.typeCode, nomApp: params.nomApplication }),
    };
  }
  const palette = await Palette.findOne({ numero: code, ...(req.depot ? { depot: req.depot.code } : filtreDepot(req)) }).lean();
  if (!palette) throw introuvable(`Palette ${code} introuvable`);
  const [depot, destination, params] = await Promise.all([
    Depot.findOne({ code: palette.depot }).lean(), Destination.findOne({ code: palette.destination }).lean(), parametres(),
  ]);
  const imp = depot?.imprimante;
  return {
    depot, evt: evtPalette(palette),
    zpl: etiquettePalette(palette, destination, params.urlPublique, imp?.dpi, params.typeCode, params.nomApplication),
    pos: () => ticketPalette(palette, destination, params.urlPublique, { largeurMm: imp?.largeurPapier, typeCode: params.typeCode, nomApp: params.nomApplication }),
  };
}

/** ZPL seul (aperçu, impression via Zebra Browser Print / QZ Tray sur le poste). */
export async function zpl(req, type, numero) {
  return (await cible(req, type, numero)).zpl;
}

/**
 * Envoie l'étiquette à l'imprimante réseau du dépôt. Toute impression est tracée ;
 * une réimpression garde toujours le même numéro.
 */
export async function imprimer(req, type, numero, { reimpression = false, navigateur = false } = {}) {
  const { depot, zpl: contenu, pos, evt } = await cible(req, type, numero);
  const imprimante = depot?.imprimante;
  const typeImprimante = imprimante?.type ?? 'ZEBRA';
  let envoye = false;
  let erreur = null;
  if (navigateur) {
    // Ticket POS imprimé par le navigateur du poste (imprimante USB) : on trace seulement l'impression.
    envoye = true;
  } else if (typeImprimante === 'A4') {
    // Imprimante de bureau : l'impression se fait par le navigateur du poste, jamais par le réseau.
    erreur = 'Imprimante A4 : impression par le navigateur';
  } else if (imprimante?.hote) {
    try {
      // Zebra : ZPL ; POS thermique : commandes ESC/POS, même port réseau 9100.
      await envoyer(typeImprimante === 'POS' ? pos() : contenu, imprimante);
      envoye = true;
    } catch (e) {
      erreur = e.message;
    }
  } else {
    erreur = `Aucune imprimante configurée pour le dépôt ${depot?.code}`;
  }
  if (process.env.ZPL_CONSOLE === '1') console.log(`\n── ZPL ${type} ${evt.numero} ──\n${contenu}`);
  await journaliser(req, null, reimpression ? 'REIMPRESSION' : 'IMPRESSION', { ...evt, details: { envoye, erreur, imprimante: typeImprimante, ...(navigateur ? { navigateur: true } : {}) } });
  return { envoye, erreur, zpl: contenu, typeImprimante };
}
