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

import { freeCounts, previousCount, rowStatus, sameSet, selectable } from '../src/lib/plans.js';
describe('grille des plans de couverture', () => {
  it('compteur « n / effectif » et ligne valide seulement si exacte', () => {
    expect(rowStatus(5, new Set(['a', 'b', 'c', 'd']))).toEqual({ n: 4, exact: false, label: '4 / 5' });
    expect(rowStatus(2, new Set(['a', 'b'])).exact).toBe(true);
  });
  it('« Dupliquer N-1 » prend l’effectif inférieur le plus proche (pas forcément N-1)', () => {
    expect(previousCount([5, 6, 9], 9)).toBe(6);
    expect(previousCount([5, 6], 5)).toBeNull();
    expect(freeCounts([2, 4], 5)).toEqual([1, 3, 5]);
    expect(freeCounts([], 0)).toEqual([]);
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
    expect(labels({ role: 'president', isSuperAdmin: true, hasTenant: true })).toEqual(['Journées', 'Territoires', 'Lieux', 'Membres', 'Paramètres', 'Mon profil', 'Administration']);
    expect(labels({ role: 'responsable', isSuperAdmin: false, hasTenant: true })).toEqual(['Journées', 'Territoires', 'Lieux', 'Membres', 'Mon profil']);
    expect(labels({ role: 'chasseur', isSuperAdmin: false, hasTenant: true })).toEqual(['Journées', 'Territoires', 'Lieux', 'Mon profil']);
    expect(labels({ role: null, isSuperAdmin: false, hasTenant: false })).toEqual(['Accueil', 'Mon profil']);
  });
  it('entrée active, y compris pour les sous-pages', () => {
    const items = navItems({ role: 'president', isSuperAdmin: false, hasTenant: true });
    expect(activeHref('#/', items)).toBeNull(); // plus d'accueil : redirigé vers les journées
    expect(activeHref('#/journees/3f2b0c3e-1111-2222-3333-444455556666', items)).toBe('#/journees');
    expect(activeHref('#/carte/3f2b0c3e-1111-2222-3333-444455556666', items)).toBe('#/territoires');
    expect(activeHref('#/plans/3f2b0c3e-1111-2222-3333-444455556666', items)).toBe('#/territoires');
    expect(activeHref('#/invitation/abc', items)).toBeNull();
  });
});

import { navigationLinks } from '../src/lib/hunts.js';

describe('isLive', () => {
  it('rythme rapide pendant la battue et le jour même', () => {
    expect(isLive('en_cours', '2026-11-10', '2026-11-17')).toBe(true);
    expect(isLive('publiee', '2026-11-17', '2026-11-17')).toBe(true);
    expect(isLive('convoquee', '2026-11-17', '2026-11-17')).toBe(true);
    expect(isLive('publiee', '2026-11-21', '2026-11-17')).toBe(false);
    expect(isLive('terminee', '2026-11-17', '2026-11-17')).toBe(false);
    expect(isLive('publiee', undefined, '2026-11-17')).toBe(false);
  });
});

import { shouldSend, ownStatus, formatAge, formatDistance } from '../src/lib/geoloc.js';
describe('positions GPS', () => {
  const at = 1_000_000;
  const fix = { lon: 2, lat: 43 };
  it('envoie la première position, puis toutes les 60 s à l’arrêt, 15 s en mouvement', () => {
    expect(shouldSend(null, fix, at)).toBe(true);
    const last = { ...fix, sentAt: at };
    expect(shouldSend(last, fix, at + 20_000)).toBe(false);          // immobile
    expect(shouldSend(last, fix, at + 60_000)).toBe(true);
    const moved = { lon: 2.0003, lat: 43 };                           // ~24 m
    expect(shouldSend(last, moved, at + 10_000)).toBe(false);         // trop tôt
    expect(shouldSend(last, moved, at + 15_000)).toBe(true);
  });
  it('statut : sur le poste dans la tolérance, imprécise si la précision est mauvaise', () => {
    expect(ownStatus({ lon: 2, lat: 43, accuracy: 10 }, [2.0002, 43], 30)).toBe('sur_poste');   // ~16 m
    expect(ownStatus({ lon: 2, lat: 43, accuracy: 10 }, [2.001, 43], 30)).toBe('en_route');     // ~81 m
    expect(ownStatus({ lon: 2, lat: 43, accuracy: 70 }, [2.0002, 43], 30)).toBe('imprecise');
    expect(ownStatus({ lon: 2, lat: 43, accuracy: 10 }, null, 30)).toBe('localise');
  });
  it('âge et distance lisibles', () => {
    expect(formatAge(3)).toBe('à l’instant');
    expect(formatAge(45)).toBe('il y a 45 s');
    expect(formatAge(200)).toBe('il y a 3 min');
    expect(formatDistance(84.4)).toBe('84 m');
    expect(formatDistance(1530)).toBe('1,5 km');
  });
});

import { pathProgress, bearing, onPostStatus, zoneAt, headingFromOrientation } from '../src/lib/guidance.js';
describe('guidage à pied', () => {
  // Chemin en L : parking (2, 43) → 100 m vers l'est → 100 m vers le nord = poste.
  const m = 1 / 111_195;
  const k = 1 / Math.cos((43 * Math.PI) / 180);
  const P = (east, north) => [2 + east * m * k, 43 + north * m];
  const path = [P(0, 0), P(100, 0), P(100, 100)];
  const post = P(100, 100);
  it('la distance restante le long du chemin diminue en marchant (trace simulée)', () => {
    const trace = [P(0, 0), P(30, 2), P(60, -3), P(100, 10), P(98, 50), P(100, 90)];
    const rem = trace.map((p) => pathProgress(path, p, post).remaining);
    for (let i = 1; i < rem.length; i++) expect(rem[i]).toBeLessThan(rem[i - 1]);
    expect(rem[0]).toBeCloseTo(200, -0.5);
    expect(rem[3]).toBeCloseTo(90, -0.5);
    const first = pathProgress(path, P(0, 0), post);
    expect(first.direct).toBeCloseTo(141.4, -0.5);       // à vol d'oiseau
    expect(pathProgress(path, P(60, 20), post).offPath).toBeCloseTo(20, -0.5);
  });
  it('le chemin est orienté vers le poste même s’il a été tracé à l’envers', () => {
    expect(pathProgress([...path].reverse(), P(0, 0), post).remaining).toBeCloseTo(200, -0.5);
  });
  it('cap vers le poste', () => {
    expect(bearing(P(0, 0), P(0, 100))).toBeCloseTo(0, 0);
    expect(bearing(P(0, 0), P(100, 0))).toBeCloseTo(90, 0);
    expect(bearing(P(0, 0), P(-100, -100))).toBeCloseTo(225, 0);
  });
  it('« sur le poste » après 10 s dans le rayon ; imprécise si la précision est mauvaise', () => {
    let s = onPostStatus(null, { distance: 12, accuracy: 10, toleranceM: 30, now: 0 });
    expect(s.status).toBe('en_route');
    s = onPostStatus(s, { distance: 20, accuracy: 10, toleranceM: 30, now: 9_000 });
    expect(s.status).toBe('en_route');
    s = onPostStatus(s, { distance: 18, accuracy: 10, toleranceM: 30, now: 10_000 });
    expect(s.status).toBe('sur_poste');
    expect(onPostStatus(s, { distance: 18, accuracy: 61, toleranceM: 30, now: 11_000 }).status).toBe('imprecise');
    s = onPostStatus(s, { distance: 45, accuracy: 10, toleranceM: 30, now: 12_000 });
    expect(s).toEqual({ status: 'en_route', since: null });
  });
  it('détecte réserve et zone d’exclusion', () => {
    const sq = (e, n, d) => ({ type: 'Polygon', coordinates: [[P(e, n), P(e + d, n), P(e + d, n + d), P(e, n + d), P(e, n)]] });
    const zones = { reserves: [sq(0, 0, 50)], exclusion: { type: 'MultiPolygon', coordinates: [sq(200, 0, 50).coordinates] } };
    expect(zoneAt(P(10, 10), zones)).toBe('reserve');
    expect(zoneAt(P(220, 10), zones)).toBe('exclusion');
    expect(zoneAt(P(100, 100), zones)).toBe(null);
  });
  it('cap de l’appareil : iPhone (boussole) et Android (absolu)', () => {
    expect(headingFromOrientation({ webkitCompassHeading: 90 })).toBe(90);
    expect(headingFromOrientation({ absolute: true, alpha: 90 })).toBe(270);
    expect(headingFromOrientation({ absolute: false, alpha: 90 })).toBe(null);
  });
});

import { dayPhase } from '../src/lib/hunts.js';
describe('vue chasseur : phase de la journée', () => {
  const day = { date: '2026-12-05', meeting_time: '07:45', meeting_place: 'Cabane', status: 'convoquee', lunch_offered: true, regroup: null };
  const me = { response: null, present: false, lunch: false };
  const battue = (status, extra = {}) => ({ number: 1, territory_name: 'Grand bois', status, ...extra });
  const current = (hunt, post = { number: 4 }, role = 'poste') => ({ hunt: { assignments_published: false, started_at: null, ...hunt }, me: { role }, post });
  it('avant la journée : répondre, puis rendez-vous et déjeuner', () => {
    expect(dayPhase({ day, me }).phase).toBe('reponse');
    expect(dayPhase({ day, me: { ...me, response: 'present', lunch: true } }).text).toBe('À 7h45, Cabane. Vous êtes inscrit au déjeuner.');
    expect(dayPhase({ day, me: { ...me, response: 'absent' } }).phase).toBe('absent');
  });
  it('jour J : de l’attente à la traque, puis regroupement', () => {
    const run = { ...day, status: 'en_cours' };
    const here = { ...me, response: 'present', present: true };
    expect(dayPhase({ day: run, me: { ...here, present: false }, battues: [] }).phase).toBe('non_present');
    expect(dayPhase({ day: run, me: here, battues: [] }).phase).toBe('attente_battue');
    expect(dayPhase({ day: run, me: here, battues: [battue('en_cours')], current: null }).phase).toBe('non_volontaire');
    expect(dayPhase({ day: run, me: here, battues: [battue('en_cours')], current: current({}) }).phase).toBe('preparation');
    const go = dayPhase({ day: run, me: here, battues: [battue('en_cours')], current: current({ assignments_published: true }) });
    expect(go).toMatchObject({ phase: 'rejoindre', title: 'Rejoignez votre poste n° 4' });
    expect(dayPhase({ day: run, me: here, battues: [battue('en_cours')], current: current({ assignments_published: true, started_at: 'x' }) }).title).toBe('Battue en cours — poste 4');
    expect(dayPhase({ day: run, me: here, battues: [battue('terminee')], current: current({ status: 'terminee' }) }).phase).toBe('fin');
    const rg = dayPhase({ day: { ...run, regroup: { place: 'Croix du Loup', time: '11:30' } }, me: here, battues: [battue('terminee')] });
    expect(rg).toMatchObject({ phase: 'regroupement', text: 'Rendez-vous Croix du Loup à 11h30.' });
  });
});

describe('itinéraires en voiture', () => {
  it('latitude puis longitude, et format unifié d’Apple (pas l’ancien daddr)', () => {
    const l = navigationLinks([2.150123, 43.420234]);
    expect(l.google).toBe('https://www.google.com/maps/dir/?api=1&destination=43.420234,2.150123&travelmode=driving');
    expect(l.waze).toBe('https://waze.com/ul?ll=43.420234,2.150123&navigate=yes');
    expect(l.apple).toBe('https://maps.apple.com/directions?destination=43.420234,2.150123&mode=driving');
  });
});

describe('vue chasseur : une fois en place', () => {
  it('le bandeau dit d’attendre le début de battue', () => {
    const step = dayPhase({
      day: { date: '2026-12-05', meeting_time: '07:45', meeting_place: '', status: 'en_cours' },
      me: { present: true },
      battues: [{ number: 1, territory_name: 'Bois', status: 'en_cours' }],
      current: { hunt: { assignments_published: true, started_at: null }, me: { role: 'poste', in_place: true }, post: { number: 2 } },
    });
    expect(step).toMatchObject({ phase: 'rejoindre', title: 'En place au poste n° 2' });
  });
});

import { assemblePath, moveEnd, pathStart, updatedPath, bestPathToPost, pathLength, RECOMPUTE_M } from '../src/lib/routing.js';
describe('chemins d’accès', () => {
  const m = 1 / 111195;
  const k = 1 / Math.cos((45 * Math.PI) / 180);
  const P = (e, n) => [4 + e * m * k, 45 + n * m];
  const parking = P(0, 0);
  const post = P(300, 0);
  it('assemble parking → réseau → poste, avec les raccords à vol d’oiseau', () => {
    const c = assemblePath(parking, [P(5, 20), P(150, 40), P(290, 20)], post);
    expect(c[0]).toEqual(parking);
    expect(c[c.length - 1]).toEqual(post);
    expect(pathLength(c)).toBeGreaterThan(300);
  });
  it('petit déplacement : seule l’extrémité bouge, dans le bon sens du chemin', () => {
    const path = [parking, P(150, 30), post];
    expect(moveEnd(path, 'post', P(310, 5), post)).toEqual([parking, P(150, 30), P(310, 5)]);
    const reversed = [post, P(150, 30), parking]; // tracé du poste vers le parking
    expect(moveEnd(reversed, 'parking', P(-5, 3), post)).toEqual([post, P(150, 30), P(-5, 3)]);
    expect(pathStart(reversed, post)).toEqual(parking);
  });
  it('grand déplacement : itinéraire recalculé ; service indisponible : on ajuste', async () => {
    const path = [parking, P(150, 30), post];
    const route = async (a, b) => [a, P(200, 100), b];
    const small = await updatedPath(path, { which: 'post', from: post, to: P(300 + RECOMPUTE_M - 10, 0), post, route });
    expect(small.recomputed).toBe(false);
    const big = await updatedPath(path, { which: 'post', from: post, to: P(300, 200), post, route });
    expect(big.recomputed).toBe(true);
    expect(big.coords[0]).toEqual(parking);
    expect(big.coords.at(-1)).toEqual(P(300, 200));
    const down = await updatedPath(path, { which: 'parking', from: parking, to: P(-200, 0), post, route: async () => null });
    expect(down).toMatchObject({ recomputed: false });
    expect(down.coords[0]).toEqual(P(-200, 0));
  });
  it('meilleur chemin : le plus court à pied parmi les parkings proches', async () => {
    const pkA = { name: 'A', geom: { coordinates: P(0, 0) } };      // plus proche à vol d'oiseau…
    const pkB = { name: 'B', geom: { coordinates: P(0, 100) } };
    const route = async (from) => (from === pkA.geom.coordinates ? [from, P(0, -800), P(300, -800), post] : [from, post]); // …mais long détour
    const best = await bestPathToPost(post, [pkA, pkB], route);
    expect(best.parking.name).toBe('B');
  });
});

import { startCenter } from '../src/lib/start-center.js';
describe('création d’un territoire : centre de la carte', () => {
  const pt = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] });
  const terr = { geom: { coordinates: [[[2, 43], [2.02, 43], [2.02, 43.02], [2, 43.02], [2, 43]]] } };
  it('la cabane de chasse d’abord, puis un lieu (parking compris), un territoire', () => {
    const places = [{ kind: 'restaurant', geom: pt(1, 1) }, { kind: 'cabane', geom: pt(2.2, 43.4) }];
    expect(startCenter({ places, parkings: [{ geom: pt(3, 3) }], territories: [terr] })).toEqual([43.4, 2.2]);
    expect(startCenter({ places: [places[0]], parkings: [{ geom: pt(3, 3) }] })).toEqual([1, 1]);
    expect(startCenter({ places: [{ kind: 'parking', geom: pt(3, 3) }], territories: [terr] })).toEqual([3, 3]);
    const c = startCenter({ territories: [terr] });
    expect(c[0]).toBeCloseTo(43.008, 2);
    expect(startCenter({})).toBeNull();
  });
});

import { geomCenter, streetViewUrl, satelliteUrl } from '../src/lib/streetview.js';
describe('Street View d’un bâtiment', () => {
  it('centre du bâtiment et liens Google', () => {
    const sq = { type: 'Polygon', coordinates: [[[2, 43], [2.0002, 43], [2.0002, 43.0002], [2, 43.0002], [2, 43]]] };
    const close = (a, b) => { expect(a[0]).toBeCloseTo(b[0], 9); expect(a[1]).toBeCloseTo(b[1], 9); };
    close(geomCenter(sq), [2.0001, 43.0001]);
    expect(geomCenter({ type: 'Point', coordinates: [1, 2] })).toEqual([1, 2]);
    close(geomCenter({ type: 'MultiPolygon', coordinates: [sq.coordinates] }), [2.0001, 43.0001]);
    expect(streetViewUrl([2.0001, 43.0001])).toBe('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=43.000100,2.000100');
    expect(satelliteUrl([2, 43])).toContain('basemap=satellite');
  });
});
