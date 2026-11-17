// Contrôles côté client (retour visuel immédiat pendant le glisser-déposer).
// La base reste la source de vérité : ces règles reproduisent celles des
// déclencheurs PostGIS (qui, eux, mesurent la distance exacte).
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import kinks from '@turf/kinks';

/**
 * @param {[number, number]} point [lon, lat]
 * @param {object} territoryGeom Polygon GeoJSON
 * @param {object[]} reserveGeoms Polygons GeoJSON
 * @param {{ exclusion?: object|null, warning?: object|null, bufferM?: number, warningM?: number }} [zones]
 *   zone d'exclusion et bande d'avertissement (MultiPolygon) calculées par le serveur
 * @returns {{ ok: boolean, code?: string, message?: string, warning?: string }}
 */
export function checkPost(point, territoryGeom, reserveGeoms = [], zones = {}) {
  if (!territoryGeom || !booleanPointInPolygon(point, territoryGeom)) {
    return { ok: false, code: 'POST_OUTSIDE_TERRITORY', message: 'Hors du territoire' };
  }
  if (reserveGeoms.some((r) => booleanPointInPolygon(point, r))) {
    return { ok: false, code: 'POST_IN_RESERVE', message: 'Dans une zone de réserve' };
  }
  const buffer = zones.bufferM ?? 150;
  if (zones.exclusion && booleanPointInPolygon(point, zones.exclusion)) {
    return { ok: false, code: 'POST_IN_EXCLUSION', message: `À moins de ${buffer} m d’une habitation` };
  }
  if (zones.warning && booleanPointInPolygon(point, zones.warning)) {
    const upTo = buffer + (zones.warningM ?? 50);
    return { ok: true, warning: `Entre ${buffer} et ${upTo} m d’une habitation : ne pas tirer en direction de l’habitation` };
  }
  return { ok: true };
}

/** true si le polygone se recoupe lui-même. */
export function selfIntersects(polygon) {
  return kinks(polygon).features.length > 0;
}
