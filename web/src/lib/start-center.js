// Où centrer la carte pour dessiner un nouveau territoire (sans DOM, testé).

/**
 * Point de départ pour dessiner un nouveau territoire : la cabane de chasse,
 * sinon un autre lieu, un parking, ou le centre d'un territoire existant.
 * @returns {[number, number] | null} [lat, lon]
 */
export function startCenter({ places = [], parkings = [], territories = [] }) {
  const at = (geom) => [geom.coordinates[1], geom.coordinates[0]];
  const cabane = places.find((p) => p.kind === 'cabane');
  if (cabane) return at(cabane.geom);
  if (places.length) return at(places[0].geom);
  if (parkings.length) return at(parkings[0].geom);
  const t = territories[0];
  if (!t) return null;
  const ring = t.geom.coordinates[0];
  return [ring.reduce((a, c) => a + c[1], 0) / ring.length, ring.reduce((a, c) => a + c[0], 0) / ring.length];
}
