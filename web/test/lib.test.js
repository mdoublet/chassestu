import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { distanceMeters, lineLengthMeters, simplifyMeters } from '../src/lib/simplify.js';
import { parseGeoFile } from '../src/lib/importer.js';
import { checkPost, selfIntersects } from '../src/lib/checks.js';
import { History } from '../src/lib/history.js';

// 1 m ≈ 0,0000090 ° de latitude
const M = 1 / 111195;

describe('simplifyMeters (Douglas-Peucker, tolérance en mètres)', () => {
  it('supprime le bruit inférieur à 3 m et garde les vrais virages', () => {
    const coords = [];
    // 200 m vers l'est avec ±1 m de bruit GPS, puis 100 m vers le nord
    for (let i = 0; i <= 100; i++) coords.push([2 + (i * 2 * M) / Math.cos((43 * Math.PI) / 180), 43 + (i % 2 ? 1 : -1) * M]);
    const corner = coords.at(-1);
    for (let i = 1; i <= 50; i++) coords.push([corner[0], corner[1] + i * 2 * M]);
    const out = simplifyMeters(coords, 3);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[0]).toEqual(coords[0]);
    expect(out.at(-1)).toEqual(coords.at(-1));
    expect(Math.abs(lineLengthMeters(out) - 300)).toBeLessThan(5);
  });

  it('garde un écart de 5 m (au-dessus de la tolérance)', () => {
    const coords = [[2, 43], [2.0005, 43 + 5 * M], [2.001, 43]];
    expect(simplifyMeters(coords, 3)).toHaveLength(3);
    expect(simplifyMeters(coords, 6)).toHaveLength(2);
  });

  it('distance haversine', () => {
    expect(distanceMeters([2, 43], [2, 43 + 1000 * M])).toBeCloseTo(1000, 0);
  });
});

describe('import de fichiers', () => {
  it('GPX : trace et waypoints', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="43.1" lon="2.1"><name>Poste 4</name></wpt>
      <wpt lat="43.2" lon="2.2"><name>Parking du col</name></wpt>
      <trk><name>Chemin</name><trkseg><trkpt lat="43.1" lon="2.1"><ele>300</ele></trkpt><trkpt lat="43.11" lon="2.11"/></trkseg></trk>
    </gpx>`;
    const items = parseGeoFile('sortie.gpx', gpx, DOMParser);
    expect(items.map((i) => [i.geometry.type, i.kind, i.label])).toEqual(
      expect.arrayContaining([
        ['Point', 'post', 'Poste 4'],
        ['Point', 'parking', 'Parking du col'],
        ['LineString', 'path', 'Chemin'],
      ]),
    );
    const track = items.find((i) => i.geometry.type === 'LineString');
    expect(track.geometry.coordinates[0]).toEqual([2.1, 43.1]); // altitude retirée
  });

  it('KML : polygone', () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Bois</name>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>2,43,0 2.01,43,0 2.01,43.01,0 2,43,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark></Document></kml>`;
    const [item] = parseGeoFile('bois.kml', kml, DOMParser);
    expect(item.geometry).toEqual({ type: 'Polygon', coordinates: [[[2, 43], [2.01, 43], [2.01, 43.01], [2, 43]]] });
  });

  it('GeoJSON exporté par l’application : types reconnus, multi-géométries éclatées', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { kind: 'territoire', name: 'T' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { type: 'Feature', properties: { kind: 'parking' }, geometry: { type: 'Point', coordinates: [0.5, 0.2] } },
        { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates: [[0.1, 0.1], [0.2, 0.1]] } },
      ],
    };
    const items = parseGeoFile('x.geojson', JSON.stringify(fc));
    expect(items.map((i) => i.kind)).toEqual(['territory', 'parking', 'post', 'post']);
  });

  it('refuse un format inconnu', () => {
    expect(() => parseGeoFile('carte.shp', '')).toThrow(/Format/);
  });
});

describe('contrôles des postes', () => {
  const territory = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const reserve = { type: 'Polygon', coordinates: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]] };
  it('dans le territoire, hors réserve, dans la réserve, hors territoire', () => {
    expect(checkPost([0.1, 0.1], territory, [reserve]).ok).toBe(true);
    expect(checkPost([0.5, 0.5], territory, [reserve]).code).toBe('POST_IN_RESERVE');
    expect(checkPost([2, 2], territory, [reserve]).code).toBe('POST_OUTSIDE_TERRITORY');
  });
  it('détecte un polygone auto-intersectant', () => {
    expect(selfIntersects({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] })).toBe(true);
    expect(selfIntersects(territory)).toBe(false);
  });
});

describe('historique d’annulation', () => {
  it('annule dans l’ordre inverse et garde au moins 20 pas', async () => {
    const h = new History(50);
    const done = [];
    for (let i = 0; i < 25; i++) h.push({ label: `op${i}`, undo: async () => done.push(i) });
    for (let i = 0; i < 25; i++) await h.undo();
    expect(done).toEqual([...Array(25).keys()].reverse());
    expect(await h.undo()).toBeNull();
  });
  it('suit les identifiants recréés', () => {
    const h = new History();
    h.alias('a', 'b');
    h.alias('b', 'c');
    expect(h.resolve('a')).toBe('c');
    expect(h.resolve('x')).toBe('x');
  });
});
