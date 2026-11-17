import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { distanceMeters, lineLengthMeters, simplifyMeters } from '../src/lib/simplify.js';
import { parseGeoFile } from '../src/lib/importer.js';
import { checkPost, selfIntersects } from '../src/lib/checks.js';
import { isLive } from '../src/lib/live.js';
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

describe('règle des habitations (côté client)', () => {
  const territory = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const exclusion = { type: 'MultiPolygon', coordinates: [[[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]]] };
  const warning = { type: 'MultiPolygon', coordinates: [[[[0.3, 0.3], [0.7, 0.3], [0.7, 0.4], [0.3, 0.4], [0.3, 0.3]]]] };
  const zones = { exclusion, warning, bufferM: 200, warningM: 50 };
  it('refuse dans la zone d’exclusion, avertit dans la bande, accepte ailleurs', () => {
    expect(checkPost([0.5, 0.5], territory, [], zones)).toMatchObject({ ok: false, code: 'POST_IN_EXCLUSION', message: 'À moins de 200 m d’une habitation' });
    const w = checkPost([0.5, 0.35], territory, [], zones);
    expect(w.ok).toBe(true);
    expect(w.warning).toMatch(/Entre 200 et 250 m/);
    expect(checkPost([0.1, 0.1], territory, [], zones)).toEqual({ ok: true });
    expect(checkPost([0.5, 0.5], territory, [], {}).ok).toBe(true); // pas encore de zone
  });
  it('une zone non chassable exportée n’est pas réimportée', () => {
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { kind: 'zone_non_chassable' }, geometry: exclusion }] };
    expect(parseGeoFile('x.geojson', JSON.stringify(fc)).map((i) => i.kind)).toEqual(['ignore']);
  });
});

describe('postes hors du territoire (côté client)', () => {
  const territory = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const postArea = { type: 'Polygon', coordinates: [[[-0.1, -0.1], [1.1, -0.1], [1.1, 1.1], [-0.1, 1.1], [-0.1, -0.1]]] };
  const exclusion = { type: 'MultiPolygon', coordinates: [[[[1.02, 0.4], [1.1, 0.4], [1.1, 0.6], [1.02, 0.6], [1.02, 0.4]]]] };
  it('accepte à la lisière avec un rappel, refuse trop loin ou dans une zone non chassable', () => {
    const zones = { postArea, maxOutsideM: 200, exclusion };
    const edge = checkPost([1.05, 0.2], territory, [], zones);
    expect(edge).toMatchObject({ ok: true, outside: true });
    expect(edge.warning).toMatch(/droit de chasse/);
    expect(checkPost([1.5, 0.5], territory, [], zones)).toMatchObject({ ok: false, code: 'POST_TOO_FAR_OUTSIDE', message: 'À plus de 200 m du territoire' });
    expect(checkPost([1.05, 0.5], territory, [], zones)).toMatchObject({ ok: false, code: 'POST_IN_EXCLUSION' });
  });
  it('marge à 0 : hors du territoire refusé', () => {
    expect(checkPost([1.05, 0.2], territory, [], { postArea, maxOutsideM: 0 }).code).toBe('POST_OUTSIDE_TERRITORY');
  });
});

import { previousCount, rowStatus, sameSet, selectable } from '../src/lib/plans.js';
describe('grille des plans de couverture', () => {
  it('compteur « n / effectif » et ligne valide seulement si exacte', () => {
    expect(rowStatus(5, new Set(['a', 'b', 'c', 'd']))).toEqual({ n: 4, exact: false, label: '4 / 5' });
    expect(rowStatus(2, new Set(['a', 'b'])).exact).toBe(true);
  });
  it('« Dupliquer N-1 » prend l’effectif inférieur le plus proche (pas forcément N-1)', () => {
    expect(previousCount([5, 6, 9], 9)).toBe(6);
    expect(previousCount([5, 6], 5)).toBeNull();
  });
  it('ensembles et postes sélectionnables', () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(selectable({ active: true, invalid_reason: null })).toBe(true);
    expect(selectable({ active: true, invalid_reason: 'EXCLUSION' })).toBe(false);
    expect(selectable({ active: false, invalid_reason: null })).toBe(false);
  });
});

import { formatHuntDate, formatTime, whatsappMessage, postedSummary } from '../src/lib/hunts.js';
describe('battues : libellés et messages', () => {
  it('date et heure en français, sans décalage de fuseau', () => {
    expect(formatHuntDate('2026-12-05')).toBe('samedi 5 décembre 2026');
    expect(formatTime('07:45')).toBe('7h45');
    expect(formatTime('08:00')).toBe('8h');
    expect(formatTime('13:05')).toBe('13h05');
  });
  it('message de convocation pour WhatsApp avec le lien', () => {
    const msg = whatsappMessage('convocation', { date: '2026-12-05', meeting_time: '07:45', meeting_place: 'Cabane', territory_name: 'Grand bois' }, 'https://x/#/battues/1');
    expect(msg).toMatch(/Grand bois/);
    expect(msg).toMatch(/samedi 5 décembre 2026/);
    expect(msg).toMatch(/https:\/\/x\/#\/battues\/1/);
  });
  it('postés présents sans poste', () => {
    const s = postedSummary([
      { present: true, role: 'poste', post_id: 'a' },
      { present: true, role: 'poste', post_id: null, name: 'B' },
      { present: true, role: 'traqueur', post_id: null },
      { present: false, role: 'poste', post_id: null },
    ]);
    expect(s.posted).toBe(2);
    expect(s.unassigned.map((p) => p.name)).toEqual(['B']);
  });
});

import { APP_NAME, navItems, activeHref } from '../src/lib/nav.js';
describe('menu principal', () => {
  it('nom de l’application', () => {
    expect(APP_NAME).toBe('Chasses-tu ?');
  });
  it('entrées selon le rôle', () => {
    const labels = (who) => navItems(who).map((i) => i.label);
    expect(labels({ role: 'president', isSuperAdmin: true, hasTenant: true })).toEqual(['Accueil', 'Battues', 'Cartographie', 'Plans', 'Membres', 'Paramètres', 'Administration']);
    expect(labels({ role: 'responsable', isSuperAdmin: false, hasTenant: true })).toEqual(['Accueil', 'Battues', 'Carte', 'Plans', 'Membres']);
    expect(labels({ role: 'chasseur', isSuperAdmin: false, hasTenant: true })).toEqual(['Accueil', 'Battues', 'Carte']);
    expect(labels({ role: null, isSuperAdmin: false, hasTenant: false })).toEqual(['Accueil']);
  });
  it('entrée active, y compris pour les sous-pages', () => {
    const items = navItems({ role: 'president', isSuperAdmin: false, hasTenant: true });
    expect(activeHref('#/', items)).toBe('#/');
    expect(activeHref('', items)).toBe('#/');
    expect(activeHref('#/battues/3f2b0c3e-1111-2222-3333-444455556666', items)).toBe('#/battues');
    expect(activeHref('#/plans', items)).toBe('#/plans');
    expect(activeHref('#/invitation/abc', items)).toBeNull();
  });
});

import { hunterInstruction, navigationLinks } from '../src/lib/hunts.js';
describe('vue chasseur : quoi faire maintenant', () => {
  const base = { date: '2026-12-05', meeting_time: '07:45', meeting_place: 'Cabane', assignments_published: false, started_at: null, posted_count: 5, present_count: 7 };
  const sheet = (hunt, me = { role: 'poste', response: 'present' }, post = null) => ({ hunt: { ...base, ...hunt }, me, post });
  it('selon le statut, la publication des postes, le début de battue et le rôle', () => {
    expect(hunterInstruction(sheet({ status: 'publiee' }, { role: 'poste', response: null })).title).toBe('Serez-vous présent ?');
    expect(hunterInstruction(sheet({ status: 'en_cours' })).title).toBe('Rond du matin');
    expect(hunterInstruction(sheet({ status: 'en_cours', assignments_published: true }, undefined, { number: 5 }))).toMatchObject({ tone: 'warn', title: 'Rejoignez votre poste n° 5' });
    expect(hunterInstruction(sheet({ status: 'en_cours', assignments_published: true, started_at: 'x' }, undefined, { number: 5 }))).toMatchObject({ tone: 'go', title: 'Battue en cours — poste 5' });
    expect(hunterInstruction(sheet({ status: 'en_cours', assignments_published: true, started_at: 'x' }, { role: 'traqueur' })).title).toBe('Battue en cours : traque');
    expect(hunterInstruction(sheet({ status: 'terminee' })).tone).toBe('done');
    expect(hunterInstruction(sheet({ status: 'annulee' })).tone).toBe('danger');
    expect(hunterInstruction(sheet({ status: 'en_cours', started_at: 'x' }, null)).text).toBe('5 posté(s) sur 7 présent(s).');
  });
  it('liens d’itinéraire (Google Maps, Waze, Plans) vers latitude, longitude', () => {
    expect(navigationLinks([2.3456789, 43.2])).toEqual({
      google: 'https://www.google.com/maps/dir/?api=1&destination=43.200000,2.345679&travelmode=driving',
      waze: 'https://waze.com/ul?ll=43.200000,2.345679&navigate=yes',
      apple: 'https://maps.apple.com/?daddr=43.200000,2.345679',
    });
  });
});

describe('isLive', () => {
  it('rythme rapide pendant la battue et le jour même', () => {
    expect(isLive('en_cours', '2026-11-10', '2026-11-17')).toBe(true);
    expect(isLive('publiee', '2026-11-17', '2026-11-17')).toBe(true);
    expect(isLive('publiee', '2026-11-21', '2026-11-17')).toBe(false);
    expect(isLive('terminee', '2026-11-17', '2026-11-17')).toBe(false);
    expect(isLive('publiee', undefined, '2026-11-17')).toBe(false);
  });
});
