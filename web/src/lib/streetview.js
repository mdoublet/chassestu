// Liens Google Maps pour voir un bâtiment : Street View (panorama le plus
// proche du point, depuis la rue) et vue satellite en secours (zones sans
// Street View : on peut y déposer le bonhomme jaune). Sans clé ni API.

/** Centre approximatif d'une géométrie GeoJSON (moyenne des sommets du contour extérieur) : [lon, lat]. */
export function geomCenter(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  const sum = pts.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}

const f = (n) => Number(n).toFixed(6);

/** Street View : Google ouvre le panorama disponible le plus proche du point. */
export function streetViewUrl([lon, lat]) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${f(lat)},${f(lon)}`;
}

/** Vue satellite Google centrée sur le point (secours sans Street View). */
export function satelliteUrl([lon, lat]) {
  return `https://www.google.com/maps/@?api=1&map_action=map&center=${f(lat)},${f(lon)}&zoom=19&basemap=satellite`;
}
