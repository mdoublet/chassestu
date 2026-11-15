// Simplification de Douglas-Peucker en MÈTRES (et non en degrés) :
// les points sont projetés localement (équirectangulaire autour du premier
// point), ce qui est exact à quelques mm près sur quelques kilomètres.

const R = 6371008.8; // rayon terrestre moyen (m)
const rad = (d) => (d * Math.PI) / 180;

function projector(origin) {
  const [lon0, lat0] = origin;
  const k = Math.cos(rad(lat0));
  return ([lon, lat]) => [rad(lon - lon0) * k * R, rad(lat - lat0) * R];
}

function segDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * @param {Array<[number, number]>} coords [lon, lat]
 * @param {number} toleranceM tolérance en mètres (3 m par défaut, cf. spécification)
 */
export function simplifyMeters(coords, toleranceM = 3) {
  if (coords.length <= 2) return coords.slice();
  const project = projector(coords[0]);
  const pts = coords.map(project);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDistance(pts[i], pts[first], pts[last]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > toleranceM && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Distance géodésique approchée (haversine), en mètres. */
export function distanceMeters(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lineLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distanceMeters(coords[i - 1], coords[i]);
  return total;
}
