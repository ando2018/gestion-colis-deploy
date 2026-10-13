/**
 * Code 128 : découpage du texte en jeu B (lettres, tirets…) et jeu C (paires de chiffres, deux fois plus compact),
 * comme le mode automatique des imprimantes. Sert à calculer la largeur réelle du code-barres pour choisir
 * l'épaisseur des barres et garder la zone blanche (10 modules) de chaque côté : sans elle, la douchette ne lit pas.
 */
export function segments128(texte) {
  const t = String(texte ?? '');
  const segments = [];
  let i = 0;
  const ajouter = (jeu, valeur) => {
    const dernier = segments.at(-1);
    if (dernier?.jeu === jeu) dernier.valeur += valeur; else segments.push({ jeu, valeur });
  };
  while (i < t.length) {
    const chiffres = t.slice(i).match(/^\d+/)?.[0].length ?? 0;
    if (chiffres >= 4) {
      const pair = chiffres - (chiffres % 2);
      ajouter('C', t.slice(i, i + pair));
      i += pair;
    } else {
      ajouter('B', t[i]);
      i += 1;
    }
  }
  return segments;
}

/**
 * Contenu du code-barres : le numéro sans tirets ni numéro de pièce (COL-ABJ-121026-0001-2/3 → COLABJ1210260001).
 * Plus court, il s'imprime avec des barres plus épaisses, donc plus faciles à lire ; le texte imprimé garde les tirets,
 * et codeScanne() les remet au scan. Les anciens numéros (P-0001, ABJ-261012-0001…) restent tels quels.
 */
export function contenuCode128(numero) {
  const m = String(numero ?? '').toUpperCase().match(/^(COL|PAL|CTN)-([A-Z]{2,6})-(\d{6})-(\d{4})(?:-\d+\/\d+)?$/);
  return m ? `${m[1]}${m[2]}${m[3]}${m[4]}` : String(numero ?? '');
}

/** Code-barres compact lu par la douchette → numéro avec tirets (COLABJ1210260001 → COL-ABJ-121026-0001). */
export function developper128(code) {
  const m = String(code ?? '').toUpperCase().match(/^(COL|PAL|CTN)([A-Z]{2,6})(\d{6})(\d{4})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : code;
}

/** Nombre de modules (barre la plus fine) : départ, symboles, changements de jeu, contrôle, arrêt. */
export function modules128(texte) {
  const s = segments128(texte);
  const symboles = s.reduce((n, x) => n + (x.jeu === 'C' ? x.valeur.length / 2 : x.valeur.length), 0) + Math.max(0, s.length - 1);
  return 11 + symboles * 11 + 11 + 13;
}

/**
 * Épaisseur de barre (en points) la plus large qui tient dans la place disponible, zones blanches comprises.
 * null si même 2 points ne tiennent pas (le code-barres ne serait pas lisible).
 */
export function epaisseur128(texte, pointsDisponibles, max = 4) {
  const m = modules128(texte) + 20; // + 10 modules de zone blanche de chaque côté
  for (let e = max; e >= 2; e--) if (m * e <= pointsDisponibles) return e;
  return null;
}
