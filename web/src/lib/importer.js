// Import GeoJSON / KML / GPX → liste de géométries simples (Polygon, Point,
// LineString), chacune avec une proposition de type d'objet.
import { gpx, kml } from '@tmcw/togeojson';
import { simplifyMeters } from './simplify.js';

const MAX_LINE_POINTS = 5000;

/**
 * @param {string} filename
 * @param {string} text contenu du fichier
 * @param {typeof DOMParser} [Parser] (injectable pour les tests Node)
 */
export function parseGeoFile(filename, text, Parser = globalThis.DOMParser) {
  const ext = filename.toLowerCase().split('.').pop();
  let fc;
  if (ext === 'kml' || ext === 'gpx') {
    const doc = new Parser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Fichier XML illisible.');
    fc = ext === 'kml' ? kml(doc) : gpx(doc);
  } else if (ext === 'geojson' || ext === 'json') {
    try {
      fc = JSON.parse(text);
    } catch {
      throw new Error('Fichier GeoJSON illisible.');
    }
  } else {
    throw new Error('Format non pris en charge (GeoJSON, KML ou GPX).');
  }
  return explode(fc);
}

function explode(input) {
  const features =
    input.type === 'FeatureCollection' ? input.features
    : input.type === 'Feature' ? [input]
    : [{ type: 'Feature', geometry: input, properties: {} }];

  const items = [];
  for (const f of features) {
    if (!f?.geometry) continue;
    const props = f.properties ?? {};
    const label = props.name ?? props.nom ?? props.title ?? '';
    for (const geometry of flatten(f.geometry)) {
      items.push({ geometry, properties: props, label: String(label), kind: suggestKind(geometry, props) });
    }
  }
  return items;
}

function stripZ(c) {
  return [c[0], c[1]];
}

function flatten(g) {
  switch (g.type) {
    case 'Point':
      return [{ type: 'Point', coordinates: stripZ(g.coordinates) }];
    case 'MultiPoint':
      return g.coordinates.map((c) => ({ type: 'Point', coordinates: stripZ(c) }));
    case 'LineString':
      return [line(g.coordinates)];
    case 'MultiLineString':
      return g.coordinates.map(line);
    case 'Polygon':
      return [{ type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(stripZ)) }];
    case 'MultiPolygon':
      return g.coordinates.map((p) => ({ type: 'Polygon', coordinates: p.map((r) => r.map(stripZ)) }));
    case 'GeometryCollection':
      return g.geometries.flatMap(flatten);
    default:
      return [];
  }
}

function line(coords) {
  let c = coords.map(stripZ);
  // Une trace GPX brute compte souvent des milliers de points : on simplifie à 3 m.
  if (c.length > MAX_LINE_POINTS / 2) c = simplifyMeters(c, 3);
  return { type: 'LineString', coordinates: c };
}

/** Propose un type d'objet ; l'export de l'application porte `kind`. */
function suggestKind(geometry, props) {
  const k = String(props.kind ?? '').toLowerCase();
  // Données calculées par l'application : ne pas les réimporter comme des objets dessinés.
  if (k === 'zone_non_chassable') return 'ignore';
  if (geometry.type === 'Polygon') return k === 'reserve' ? 'reserve' : k === 'territoire' ? 'territory' : 'reserve';
  if (geometry.type === 'Point') return k === 'parking' || /parking|^p\b/i.test(props.name ?? '') ? 'parking' : 'post';
  if (geometry.type === 'LineString') return 'path';
  return 'ignore';
}
