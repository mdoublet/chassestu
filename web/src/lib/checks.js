// Contrôles côté client (retour visuel immédiat pendant le glisser-déposer).
// La base reste la source de vérité : ces règles reproduisent celles des
// déclencheurs PostGIS (qui, eux, mesurent la distance exacte).
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import kinks from '@turf/kinks';

/**
 * @param {[number, number]} point [lon, lat]
 * @param {object} territoryGeom Polygon GeoJSON
 * @param {object[]} reserveGeoms Polygons GeoJSON
 * @param {{ exclusion?: object|null, warning?: object|null, bufferM?: number, warningM?: number,
 *           postArea?: object|null, maxOutsideM?: number }} [zones]
 *   zone d'exclusion, bande d'avertissement et zone des postes (territoire + marge),
 *   calculées par le serveur
 * @returns {{ ok: boolean, code?: string, message?: string, warning?: string }}
 */
export function checkPost(point, territoryGeom, reserveGeoms = [], zones = {}) {
  const inside = Boolean(territoryGeom) && booleanPointInPolygon(point, territoryGeom);
  if (!inside) {
    // Hors du territoire : autorisé dans la « zone des postes » (territoire + marge).
    const max = zones.maxOutsideM ?? 0;
    if (!territoryGeom || max <= 0 || !zones.postArea) {
      return { ok: false, code: 'POST_OUTSIDE_TERRITORY', message: 'Hors du territoire' };
    }
    if (!booleanPointInPolygon(point, zones.postArea)) {
      return { ok: false, code: 'POST_TOO_FAR_OUTSIDE', message: `À plus de ${max} m du territoire` };
    }
  }
  if (reserveGeoms.some((r) => booleanPointInPolygon(point, r))) {
    return { ok: false, code: 'POST_IN_RESERVE', message: 'Dans une zone de réserve' };
  }
  const buffer = zones.bufferM ?? 150;
  if (zones.exclusion && booleanPointInPolygon(point, zones.exclusion)) {
    return { ok: false, code: 'POST_IN_EXCLUSION', message: `À moins de ${buffer} m d’une habitation` };
  }
  const outsideNote = inside ? null : 'Hors du territoire : vérifiez que vous avez le droit de chasse à cet endroit';
  if (zones.warning && booleanPointInPolygon(point, zones.warning)) {
    const upTo = buffer + (zones.warningM ?? 50);
    const w = `Entre ${buffer} et ${upTo} m d’une habitation : ne pas tirer en direction de l’habitation`;
    return { ok: true, warning: outsideNote ? `${w}. ${outsideNote}` : w, outside: !inside };
  }
  return outsideNote ? { ok: true, warning: outsideNote, outside: true } : { ok: true };
}

/** true si le polygone se recoupe lui-même. */
export function selfIntersects(polygon) {
  return kinks(polygon).features.length > 0;
}
