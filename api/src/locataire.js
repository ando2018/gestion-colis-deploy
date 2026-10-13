// Multi-entreprise : chaque entreprise a sa propre base MongoDB (isolation complète des données).
// L'entreprise de la requête est portée par un contexte asynchrone ; les modèles exportés par modeles.js
// (Colis, Palette…) pointent automatiquement vers la base de l'entreprise courante.
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

const contexte = new AsyncLocalStorage();
const schemas = new Map(); // nom du modèle → { schema, collection }

/** Exécute fn pour une entreprise ({ code, nom, base }) : tous les modèles visent sa base. */
export const dansEntreprise = (entreprise, fn) => contexte.run(entreprise, fn);
export const entrepriseCourante = () => contexte.getStore() ?? null;

/** Connexion à la base d'une entreprise (même client MongoDB : les transactions restent possibles), modèles enregistrés. */
export function connexionDe(base) {
  const c = mongoose.connection.useDb(base, { useCache: true });
  for (const [nom, { schema, collection }] of schemas) if (!c.models[nom]) c.model(nom, schema, collection);
  return c;
}

/** Crée collections et index d'une base d'entreprise (avant les premières transactions). */
export async function preparerBase(base) {
  const c = connexionDe(base);
  await Promise.all(Object.values(c.models).map((m) => m.createCollection().catch(() => {}).then(() => m.init())));
}

function modeleCourant(nom) {
  const e = contexte.getStore();
  if (!e) throw new Error(`Aucune entreprise active pour le modèle ${nom}`);
  return connexionDe(e.base).model(nom);
}

/**
 * Déclare un modèle propre à chaque entreprise. L'objet renvoyé s'utilise comme un modèle Mongoose
 * (Colis.find(), Colis.create()…) et vise la base de l'entreprise de la requête en cours.
 */
export function modeleEntreprise(nom, schema, collection) {
  schemas.set(nom, { schema, collection });
  return new Proxy(function () {}, {
    get(_, prop) {
      const m = modeleCourant(nom);
      const v = Reflect.get(m, prop, m);
      return typeof v === 'function' ? v.bind(m) : v;
    },
    construct(_, args) {
      return new (modeleCourant(nom))(...args);
    },
  });
}

/** Segment d'adresse publique d'une palette : <entreprise>.<dépôt> (QR des palettes : /p/<entreprise>.<dépôt>/<numéro>). */
export function segmentPublic(depot) {
  const e = contexte.getStore();
  return e ? `${e.code}.${depot}` : depot;
}
