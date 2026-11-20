// Logique de la grille des plans de couverture (sans DOM, testée).

/** Effectif le plus proche en dessous de `count` parmi `counts`, ou null. */
export function previousCount(counts, count) {
  let best = null;
  for (const c of counts) if (c < count && (best === null || c > best)) best = c;
  return best;
}

/**
 * État d'une ligne : nombre de postes cochés, conformité à l'effectif,
 * libellé du compteur (« 4 / 5 »).
 */
export function rowStatus(count, selected) {
  const n = selected.size;
  return { n, exact: n === count, label: `${n} / ${count}` };
}

/** Deux ensembles d'identifiants identiques ? */
export function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Un poste peut-il être coché (actif et valide) ? */
export const selectable = (post) => post.active && !post.invalid_reason;

/** Effectifs encore libres (1 … nombre de postes disponibles), hors effectifs déjà définis. */
export function freeCounts(counts, available) {
  const used = new Set(counts);
  const out = [];
  for (let n = 1; n <= Math.min(available, 999); n++) if (!used.has(n)) out.push(n);
  return out;
}
