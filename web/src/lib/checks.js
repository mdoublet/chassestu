// Contrôles côté client (retour visuel immédiat). La base reste la source de
// vérité : ces règles reproduisent celles des déclencheurs PostGIS.
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import kinks from '@turf/kinks';

/**
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function checkPost(point, territoryGeom, reserveGeoms = []) {
  if (!territoryGeom || !booleanPointInPolygon(point, territoryGeom)) {
    return { ok: false, code: 'POST_OUTSIDE_TERRITORY', message: 'Hors du territoire' };
  }
  if (reserveGeoms.some((r) => booleanPointInPolygon(point, r))) {
    return { ok: false, code: 'POST_IN_RESERVE', message: 'Dans une zone de réserve' };
  }
  return { ok: true };
}

/** true si le polygone se recoupe lui-même. */
export function selfIntersects(polygon) {
  return kinks(polygon).features.length > 0;
}
