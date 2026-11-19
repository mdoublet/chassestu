// Chemins d'accès : calcul d'itinéraire à pied (service IGN Géoplateforme) et
// mise à jour d'un chemin quand on déplace son poste ou son parking.
// Les fonctions pures sont testées ; seule `fetchRoute` appelle le réseau.
import { distanceMeters, simplifyMeters } from './simplify.js';

/** Au-delà de ce déplacement, le chemin est recalculé ; en deçà, seule l'extrémité bouge. */
export const RECOMPUTE_M = 50;

const ROUTE_URL = 'https://data.geopf.fr/navigation/itineraire';

/**
 * Itinéraire à pied entre deux points [lon, lat] sur le réseau BD TOPO (routes,
 * pistes, sentiers). Le service « accroche » départ et arrivée au réseau le plus
 * proche : il faut ensuite rejoindre les vrais points (voir `assemblePath`).
 * @returns {Promise<number[][] | null>} coordonnées, ou null si indisponible
 */
export async function fetchRoute(from, to, fetchImpl = fetch) {
  const params = new URLSearchParams({
    resource: 'bdtopo-osrm',
    profile: 'pedestrian',
    optimization: 'shortest',
    start: `${from[0].toFixed(6)},${from[1].toFixed(6)}`,
    end: `${to[0].toFixed(6)},${to[1].toFixed(6)}`,
    geometryFormat: 'geojson',
  });
  try {
    const res = await fetchImpl(`${ROUTE_URL}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const coords = data?.geometry?.coordinates;
    return Array.isArray(coords) && coords.length >= 2 ? coords : null;
  } catch {
    return null;
  }
}

/**
 * Chemin complet : parking → (réseau) → poste. Les raccords à vol d'oiseau
 * depuis le parking et jusqu'au poste sont ajoutés ; points superflus retirés.
 */
export function assemblePath(parking, route, post) {
  const pts = [parking, ...(route ?? []), post];
  const out = [];
  for (const p of pts) {
    if (!out.length || distanceMeters(out[out.length - 1], p) > 2) out.push(p);
  }
  if (out.length < 2) return [parking, post];
  return simplifyMeters(out, 3);
}

export function pathLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += distanceMeters(coords[i - 1], coords[i]);
  return m;
}

/** Le chemin finit-il au poste (sinon il a été tracé du poste vers le parking) ? */
export function endsAtPost(path, post) {
  return distanceMeters(path[path.length - 1], post) <= distanceMeters(path[0], post);
}

/**
 * Déplace l'extrémité « poste » ou « parking » d'un chemin, sans toucher au
 * reste (ajustement de quelques mètres).
 */
export function moveEnd(path, which, newPoint, post) {
  const out = path.slice();
  const postAtEnd = endsAtPost(path, post);
  const idx = (which === 'post') === postAtEnd ? out.length - 1 : 0;
  out[idx] = newPoint;
  return out;
}

/** Extrémité « parking » (départ) d'un chemin. */
export function pathStart(path, post) {
  return endsAtPost(path, post) ? path[0] : path[path.length - 1];
}

/**
 * Nouveau chemin après le déplacement d'une extrémité : petit déplacement →
 * l'extrémité suit ; grand déplacement → itinéraire recalculé.
 * @returns {Promise<{ coords: number[][], recomputed: boolean }>}
 */
export async function updatedPath(path, { which, from, to, post, route = fetchRoute }) {
  const newPost = which === 'post' ? to : post;
  if (distanceMeters(from, to) <= RECOMPUTE_M) return { coords: moveEnd(path, which, to, post), recomputed: false };
  const start = which === 'parking' ? to : pathStart(path, post);
  const r = await route(start, newPost);
  if (!r) return { coords: moveEnd(path, which, to, post), recomputed: false }; // service indisponible : on ajuste
  return { coords: assemblePath(start, r, newPost), recomputed: true };
}

/**
 * Meilleur chemin vers un poste depuis les parkings les plus proches (à vol
 * d'oiseau, les 2 premiers) : le plus court à pied.
 * @returns {Promise<{ parking, coords: number[][], length: number } | null>}
 */
export async function bestPathToPost(post, parkings, route = fetchRoute) {
  const near = parkings
    .map((pk) => ({ pk, d: distanceMeters(pk.geom.coordinates, post) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2);
  let best = null;
  for (const { pk } of near) {
    const r = await route(pk.geom.coordinates, post);
    const coords = assemblePath(pk.geom.coordinates, r, post);
    const length = pathLength(coords);
    if (!best || length < best.length) best = { parking: pk, coords, length, routed: !!r };
  }
  return best;
}
