// Guidage à pied jusqu'au poste (sans DOM, testé) : distance restante le
// long du chemin, cap, statut « sur le poste » avec maintien de 10 s,
// détection des réserves et de la zone d'exclusion.
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { distanceMeters } from './simplify.js';

const R = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Projection locale en mètres autour de `origin` (suffisante sur quelques km). */
function local(origin) {
  const k = Math.cos(rad(origin[1]));
  return ([lon, lat]) => [rad(lon - origin[0]) * k * R, rad(lat - origin[1]) * R];
}

/**
 * Progression sur le chemin d'accès (orienté automatiquement vers le poste).
 * @param {number[][]} path coordonnées [lon, lat] du chemin
 * @param {number[]} here [lon, lat] du chasseur
 * @param {number[]} post [lon, lat] du poste
 * @returns {{ remaining: number, offPath: number, direct: number }} mètres
 */
export function pathProgress(path, here, post) {
  const direct = distanceMeters(here, post);
  if (!path || path.length < 2) return { remaining: direct, offPath: 0, direct };
  const pts = distanceMeters(path[0], post) < distanceMeters(path[path.length - 1], post) ? [...path].reverse() : path;
  const toXY = local(here);
  const xy = pts.map(toXY);
  const seg = xy.slice(1).map((b, i) => Math.hypot(b[0] - xy[i][0], b[1] - xy[i][1]));
  // Distance cumulée depuis chaque sommet jusqu'à la fin du chemin.
  const tail = new Array(xy.length).fill(0);
  for (let i = xy.length - 2; i >= 0; i--) tail[i] = tail[i + 1] + seg[i];
  let best = { d: Infinity, remaining: 0 };
  for (let i = 0; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[i + 1];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, (-ax * (bx - ax) - ay * (by - ay)) / len2)) : 0;
    const px = ax + t * (bx - ax);
    const py = ay + t * (by - ay);
    const d = Math.hypot(px, py); // le chasseur est à l'origine
    if (d < best.d) best = { d, remaining: (1 - t) * seg[i] + tail[i + 1] };
  }
  const endToPost = distanceMeters(pts[pts.length - 1], post);
  return { remaining: best.remaining + endToPost, offPath: best.d, direct };
}

/** Cap (degrés, 0 = nord, sens horaire) de `from` vers `to`. */
export function bearing(from, to) {
  const [l1, p1] = [rad(from[0]), rad(from[1])];
  const [l2, p2] = [rad(to[0]), rad(to[1])];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Cap de l'appareil (degrés) depuis un événement d'orientation, ou null. */
export function headingFromOrientation(e, screenAngle = 0) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iPhone
  else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;      // Android
  return h === null ? null : (h + screenAngle + 360) % 360;
}

export const ON_POST_HOLD_MS = 10_000;

/**
 * Statut du chasseur (spécification) : « sur le poste » quand il est dans le
 * rayon de tolérance depuis 10 s avec une précision < 2 × tolérance ;
 * « position imprécise » si la précision est mauvaise ; sinon « en route ».
 * @param {{ since: number|null }} prev état précédent (depuis quand dans le rayon)
 */
export function onPostStatus(prev, { distance, accuracy, toleranceM, now }) {
  if (accuracy > 2 * toleranceM) return { status: 'imprecise', since: null };
  if (distance > toleranceM) return { status: 'en_route', since: null };
  const since = prev?.since ?? now;
  return { status: now - since >= ON_POST_HOLD_MS ? 'sur_poste' : 'en_route', since };
}

/**
 * Zone sensible où se trouve le chasseur : 'reserve', 'exclusion' (bande de
 * sécurité autour des habitations) ou null.
 */
export function zoneAt(here, { reserves = [], exclusion = null } = {}) {
  const pt = { type: 'Point', coordinates: here };
  if (reserves.some((g) => g && booleanPointInPolygon(pt, g))) return 'reserve';
  if (exclusion && booleanPointInPolygon(pt, exclusion)) return 'exclusion';
  return null;
}
