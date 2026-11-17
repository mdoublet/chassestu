// Lot 2 — règle des 150 m (critères d'acceptation de la spécification).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, asOwner, bdtopo, building, createTenant, east, point, square, wfsPage } from './helpers';

const P = 'pres_150m';
let tenant: string;
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });

const LAT = 43.5;
const EMPTY = wfsPage([]);

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des 150 m');
});
afterEach(() => {
  bdtopo.pages = [EMPTY];
  bdtopo.fail = false;
});

/** Territoire de ~1,6 × 2,2 km centré sur lon, avec une maison au centre (côté 10 m). */
async function territoryWithHouse(lon: number, extra: unknown[] = []) {
  bdtopo.pages = [wfsPage([building(`MAISON_${lon}`, lon, LAT), ...extra])];
  const res = await call('POST', '/api/territories', { name: `Bois ${lon}`, geom: square(lon, LAT, 0.01) });
  expect(res.status).toBe(201);
  return res.body;
}

// Distance au bord de la maison = décalage depuis le centre − 5 m.
const atDistance = (lon: number, meters: number) => point(east(lon, LAT, meters + 5), LAT);

describe('import des bâtiments BD TOPO', () => {
  it('importe à la création, y compris hors du territoire, et ignore les bâtiments trop loin', async () => {
    const lon = 2.3;
    const outsideNear = building('DEHORS_PROCHE', east(lon, LAT, 1000), LAT); // 1000 m du centre : ~200 m hors du bord
    const farAway = building('TRES_LOIN', east(lon, LAT, 3000), LAT);
    const created = await territoryWithHouse(lon, [outsideNear, farAway]);
    expect(created.import_error).toBeNull();
    expect(created.dwellings_import).toMatchObject({ total: 2, added: 2, missing: 0 });

    const detail = await call('GET', `/api/territories/${created.territory.id}`);
    expect(detail.body.dwellings.map((d: any) => d.source_id).sort()).toEqual(['DEHORS_PROCHE', `MAISON_${lon}`]);
    expect(detail.body.exclusion.needs_refresh).toBe(false);
    // Zone d'exclusion avec sa surface en hectares : disque de ~155 m ≈ 7,5 ha.
    expect(detail.body.exclusion.area_ha).toBeGreaterThan(6);
    expect(detail.body.exclusion.area_ha).toBeLessThan(9);
    expect(detail.body.exclusion.geom.type).toBe('MultiPolygon');
  });

  it('pré-signale les bâtiments probablement non habités, sans les ignorer', async () => {
    const lon = 2.35;
    const barn = building('HANGAR', east(lon, LAT, 600), LAT, { usage_1: 'Agricole', nombre_de_logements: null });
    const created = await territoryWithHouse(lon, [barn]);
    const detail = await call('GET', `/api/territories/${created.territory.id}`);
    const hangar = detail.body.dwellings.find((d: any) => d.source_id === 'HANGAR');
    expect(hangar).toMatchObject({ likely_non_residential: true, ignored: false, usage: 'Agricole' });
  });

  it('le territoire est créé même si le service IGN est indisponible', async () => {
    bdtopo.fail = true;
    const res = await call('POST', '/api/territories', { name: 'Hors ligne', geom: square(2.4, LAT, 0.01) });
    expect(res.status).toBe(201);
    expect(res.body.import_error).toMatch(/IGN/);
    const detail = await call('GET', `/api/territories/${res.body.territory.id}`);
    expect(detail.body.exclusion.needs_refresh).toBe(true);
  });
});

describe('contrôle des postes', () => {
  it('un poste à 140 m d’une habitation est refusé ; à 170 m il est accepté avec avertissement', async () => {
    const lon = 2.45;
    const { territory } = await territoryWithHouse(lon);
    const refused = await call('POST', `/api/territories/${territory.id}/posts`, { geom: atDistance(lon, 140) });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('POST_IN_EXCLUSION');
    expect(refused.body.message).toMatch(/à 1(39|40) m d.une habitation \(minimum 150 m\)/);

    const accepted = await call('POST', `/api/territories/${territory.id}/posts`, { geom: atDistance(lon, 170) });
    expect(accepted.status).toBe(201);
    expect(accepted.body.item.invalid_reason).toBeNull();
    expect(accepted.body.item.nearest_dwelling_m).toBeGreaterThanOrEqual(168);
    expect(accepted.body.item.nearest_dwelling_m).toBeLessThan(200); // → avertissement côté client

    const far = await call('POST', `/api/territories/${territory.id}/posts`, { geom: atDistance(lon, 400) });
    expect(far.body.item.nearest_dwelling_m).toBeNull();

    // Déplacer un poste dans la zone est refusé aussi.
    const move = await call('PATCH', `/api/posts/${far.body.item.id}`, { geom: atDistance(lon, 100) });
    expect(move.status).toBe(422);
  });

  it('ignorer un bâtiment exige une raison, apparaît dans l’audit et libère la zone', async () => {
    const lon = 2.55;
    const { territory } = await territoryWithHouse(lon);
    const detail = await call('GET', `/api/territories/${territory.id}`);
    const house = detail.body.dwellings[0];

    const noReason = await call('PATCH', `/api/dwellings/${house.id}`, { ignored: true });
    expect(noReason.status).toBe(400);
    const ok = await call('PATCH', `/api/dwellings/${house.id}`, { ignored: true, ignored_reason: 'Ruine sans toit' });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ ignored: true, ignored_reason: 'Ruine sans toit' });
    expect(ok.body.item.ignored_at).not.toBeNull();

    const audit = await call('GET', '/api/audit?limit=5');
    expect(audit.body.entries.find((e: any) => e.entity === 'dwellings' && e.entity_id === house.id)).toMatchObject({
      action: 'update',
      diff: { ignored: { old: false, new: true }, ignored_reason: { old: null, new: 'Ruine sans toit' } },
    });

    const after = await call('GET', `/api/territories/${territory.id}`);
    expect(after.body.exclusion.geom).toBeNull();
    expect((await call('POST', `/api/territories/${territory.id}/posts`, { geom: atDistance(lon, 50) })).status).toBe(201);

    // Réactiver le bâtiment invalide le poste au lieu de le supprimer.
    await call('PATCH', `/api/dwellings/${house.id}`, { ignored: false });
    const posts = (await call('GET', `/api/territories/${territory.id}`)).body.posts;
    expect(posts[0].invalid_reason).toBe('EXCLUSION');
  });

  it('passer la distance de 150 à 200 m recalcule les zones et invalide les postes concernés', async () => {
    const lon = 2.65;
    const { territory } = await territoryWithHouse(lon);
    const post = await call('POST', `/api/territories/${territory.id}/posts`, { geom: atDistance(lon, 170) });
    const before = (await call('GET', `/api/territories/${territory.id}`)).body.exclusion.area_ha;

    expect((await call('PATCH', '/api/tenant', { buffer_distance_m: 200 })).status).toBe(200);
    const detail = (await call('GET', `/api/territories/${territory.id}`)).body;
    expect(detail.exclusion.buffer_distance_m).toBe(200);
    expect(detail.exclusion.area_ha).toBeGreaterThan(before * 1.6); // (205/155)² ≈ 1,75
    expect(detail.posts.find((p: any) => p.id === post.body.item.id).invalid_reason).toBe('EXCLUSION');

    // Un poste invalide reste modifiable (consignes), et redevient valide une fois déplacé.
    expect((await call('PATCH', `/api/posts/${post.body.item.id}`, { instructions: 'À déplacer' })).status).toBe(200);
    const moved = await call('PATCH', `/api/posts/${post.body.item.id}`, { geom: atDistance(lon, 260) });
    expect(moved.status).toBe(200);
    expect(moved.body.item.invalid_reason).toBeNull();

    await call('PATCH', '/api/tenant', { buffer_distance_m: 150 });
  });

  it('une habitation ajoutée à la main invalide un poste existant', async () => {
    const lon = 2.75;
    bdtopo.pages = [EMPTY];
    const { territory } = (await call('POST', '/api/territories', { name: 'Sans maison', geom: square(lon, LAT, 0.01) })).body;
    const post = await call('POST', `/api/territories/${territory.id}/posts`, { geom: point(lon, LAT) });
    expect(post.status).toBe(201);

    const caravan = await call('POST', `/api/territories/${territory.id}/dwellings`, { geom: atDistance(lon, 80), comment: 'Caravane habitée' });
    expect(caravan.status).toBe(201);
    const detail = (await call('GET', `/api/territories/${territory.id}`)).body;
    expect(detail.posts[0].invalid_reason).toBe('EXCLUSION');
    const audit = await asOwner(`SELECT action FROM audit_log WHERE entity = 'dwellings' AND entity_id = $1`, [caravan.body.item.id]);
    expect(audit).toEqual([{ action: 'insert' }]);

    // Supprimer l'ajout manuel rend le poste valide ; un bâtiment BD TOPO, lui, ne se supprime pas.
    expect((await call('DELETE', `/api/dwellings/${caravan.body.item.id}`)).status).toBe(200);
    expect((await call('GET', `/api/territories/${territory.id}`)).body.posts[0].invalid_reason).toBeNull();
  });
});

describe('actualisation des bâtiments', () => {
  it('conserve les choix « ignoré », signale les nouveaux et les disparus', async () => {
    const lon = 2.85;
    const barn = building('GRANGE', east(lon, LAT, 600), LAT, { usage_1: 'Agricole' });
    const { territory } = await territoryWithHouse(lon, [barn]);
    const dwellings = (await call('GET', `/api/territories/${territory.id}`)).body.dwellings;
    const grange = dwellings.find((d: any) => d.source_id === 'GRANGE');
    await call('PATCH', `/api/dwellings/${grange.id}`, { ignored: true, ignored_reason: 'Hangar sans logement' });

    // Nouvel import : la maison a disparu, un nouveau bâtiment est apparu.
    bdtopo.pages = [wfsPage([barn, building('NEUVE', east(lon, LAT, -600), LAT)])];
    const refresh = await call('POST', `/api/territories/${territory.id}/dwellings/refresh`);
    expect(refresh.status).toBe(200);
    expect(refresh.body.report).toMatchObject({ total: 2, added: 1, missing: 1 });

    const after = (await call('GET', `/api/territories/${territory.id}`)).body.dwellings;
    expect(after.find((d: any) => d.source_id === 'GRANGE')).toMatchObject({ ignored: true, ignored_reason: 'Hangar sans logement' });
    // Prudence : un bâtiment disparu reste compté tant que le président ne l'ignore pas.
    expect(after.find((d: any) => d.source_id === `MAISON_${lon}`)).toMatchObject({ ignored: false });
    expect(after.find((d: any) => d.source_id === `MAISON_${lon}`).missing_since).not.toBeNull();

    const del = await call('DELETE', `/api/dwellings/${grange.id}`);
    expect(del.status).toBe(409);
  });

  it('service IGN indisponible : erreur claire, rien n’est modifié', async () => {
    const lon = 2.95;
    const { territory } = await territoryWithHouse(lon);
    bdtopo.fail = true;
    const res = await call('POST', `/api/territories/${territory.id}/dwellings/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('BDTOPO_UNAVAILABLE');
    expect((await call('GET', `/api/territories/${territory.id}`)).body.dwellings).toHaveLength(1);
  });

  it('un chasseur ne peut ni actualiser ni ignorer', async () => {
    const lon = 3.05;
    const { territory } = await territoryWithHouse(lon);
    const inv = await call('POST', '/api/invitations', {});
    const token = inv.body.invitation.url.split('/').pop();
    await api('chasseur_150', 'POST', `/api/invitation-links/${token}/accept`);
    const r = await api('chasseur_150', 'POST', `/api/territories/${territory.id}/dwellings/refresh`, { tenant });
    expect(r.status).toBe(403);
    const view = await api('chasseur_150', 'GET', `/api/territories/${territory.id}`, { tenant });
    expect(view.status).toBe(200);
    expect(view.body.exclusion.area_ha).toBeGreaterThan(0);
  });
});
