// Lot 1 — éditeur cartographique (côté API).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, point, square } from './helpers';

let tenant: string;
const P = 'pres_carto';
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA Carto');
});

async function newTerritory(lon = 2.3, lat = 43.2, d = 0.01) {
  const res = await call('POST', '/api/territories', { name: 'Bois des Fourches', notes: 'Accès par la D12', geom: square(lon, lat, d) });
  expect(res.status).toBe(201);
  return res.body.territory;
}

describe('territoires', () => {
  it('crée, modifie, lit et supprime un territoire', async () => {
    const t = await newTerritory();
    expect(t.area_ha).toBeGreaterThan(100); // ≈ 2,2 km × 1,6 km
    expect(t.geom.type).toBe('Polygon');

    const renamed = await call('PATCH', `/api/territories/${t.id}`, { name: 'Bois Neuf', geom: square(2.3, 43.2, 0.012) });
    expect(renamed.status).toBe(200);
    expect(renamed.body.territory.name).toBe('Bois Neuf');
    expect(renamed.body.territory.area_ha).toBeGreaterThan(t.area_ha);

    const list = await call('GET', '/api/territories');
    expect(list.body.territories.some((x: any) => x.id === t.id)).toBe(true);

    expect((await call('DELETE', `/api/territories/${t.id}`)).status).toBe(204);
    expect((await call('GET', `/api/territories/${t.id}`)).status).toBe(404);
  });

  it('refuse un polygone auto-intersectant (nœud papillon)', async () => {
    const bowtie = { type: 'Polygon', coordinates: [[[2, 43], [2.01, 43.01], [2.01, 43], [2, 43.01], [2, 43]]] };
    const res = await call('POST', '/api/territories', { name: 'Papillon', geom: bowtie });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GEOMETRY_INVALID');
    expect(res.body.message).toMatch(/se recoupe/);
  });

  it('refuse les géométries mal formées ou du mauvais type', async () => {
    const open = { type: 'Polygon', coordinates: [[[2, 43], [2.01, 43], [2.01, 43.01], [2, 43.02]]] };
    expect((await call('POST', '/api/territories', { name: 'Ouvert', geom: open })).status).toBe(400);
    expect((await call('POST', '/api/territories', { name: 'Point', geom: point(2, 43) })).status).toBe(400);
    expect((await call('POST', '/api/territories', { name: 'Hors bornes', geom: square(200, 43) })).status).toBe(400);
  });
});

describe('réserves, parkings, postes, chemins', () => {
  it('dessine un territoire complet et l’exporte en GeoJSON', async () => {
    const t = await newTerritory(2.5, 43.5);
    const reserve = await call('POST', `/api/territories/${t.id}/reserves`, { name: 'Remise', reason: 'Zone de quiétude', geom: square(2.505, 43.505, 0.002) });
    expect(reserve.status).toBe(201);
    expect(reserve.body.item.area_ha).toBeGreaterThan(0);

    const parking = await call('POST', `/api/territories/${t.id}/parkings`, { name: 'Carrefour D12', geom: point(2.489, 43.5) });
    expect(parking.status).toBe(201);

    const path = { type: 'LineString', coordinates: [[2.489, 43.5], [2.492, 43.501], [2.495, 43.5]] };
    const p1 = await call('POST', `/api/territories/${t.id}/posts`, { name: 'Le chêne', geom: point(2.495, 43.5), parking_id: parking.body.item.id, access_path: path, instructions: 'Tir uniquement vers le nord' });
    expect(p1.status).toBe(201);
    expect(p1.body.item.number).toBe(1); // numéro proposé automatiquement
    expect(p1.body.item.access_path_length_m).toBeGreaterThan(400);
    const p2 = await call('POST', `/api/territories/${t.id}/posts`, { geom: point(2.496, 43.498) });
    expect(p2.body.item.number).toBe(2);

    // Déplacement du poste et modification du chemin
    const moved = await call('PATCH', `/api/posts/${p2.body.item.id}`, { geom: point(2.497, 43.497), name: 'La souche' });
    expect(moved.status).toBe(200);
    expect(moved.body.item.geom.coordinates).toEqual([2.497, 43.497]);

    const detail = await call('GET', `/api/territories/${t.id}`);
    expect(detail.body.reserves).toHaveLength(1);
    expect(detail.body.parkings).toHaveLength(1);
    expect(detail.body.posts.map((p: any) => p.number)).toEqual([1, 2]);

    const exp = await call('GET', `/api/territories/${t.id}/export`);
    expect(exp.status).toBe(200);
    const kinds = exp.body.features.map((f: any) => f.properties.kind);
    expect(kinds).toEqual(['territoire', 'reserve', 'parking', 'poste', 'poste', 'chemin']);

    // Suppression : l'élément supprimé est renvoyé (annulation côté éditeur)
    const del = await call('DELETE', `/api/posts/${p2.body.item.id}`);
    expect(del.status).toBe(200);
    expect(del.body.item.number).toBe(2);
    expect((await call('DELETE', `/api/parkings/${parking.body.item.id}`)).status).toBe(200);
    const after = await call('GET', `/api/territories/${t.id}`);
    expect(after.body.posts[0].parking_id).toBeNull(); // ON DELETE SET NULL
    expect((await call('DELETE', `/api/reserves/${reserve.body.item.id}`)).status).toBe(200);
  });

  it('refuse un poste hors du territoire ou dans une réserve', async () => {
    const t = await newTerritory(2.7, 43.7);
    await call('POST', `/api/territories/${t.id}/reserves`, { geom: square(2.705, 43.705, 0.002) });

    const outside = await call('POST', `/api/territories/${t.id}/posts`, { geom: point(2.75, 43.7) });
    expect(outside.status).toBe(422);
    expect(outside.body.code).toBe('POST_OUTSIDE_TERRITORY');

    const inReserve = await call('POST', `/api/territories/${t.id}/posts`, { geom: point(2.705, 43.705) });
    expect(inReserve.status).toBe(422);
    expect(inReserve.body.code).toBe('POST_IN_RESERVE');

    const ok = await call('POST', `/api/territories/${t.id}/posts`, { geom: point(2.695, 43.695) });
    expect(ok.status).toBe(201);
    const moveOut = await call('PATCH', `/api/posts/${ok.body.item.id}`, { geom: point(2.8, 43.7) });
    expect(moveOut.status).toBe(422);
  });

  it('refuse une réserve qui engloberait un poste, ou un territoire réduit qui exclurait un poste', async () => {
    const t = await newTerritory(2.9, 43.9);
    const post = await call('POST', `/api/territories/${t.id}/posts`, { number: 7, geom: point(2.908, 43.9) });
    expect(post.status).toBe(201);

    const res = await call('POST', `/api/territories/${t.id}/reserves`, { geom: square(2.908, 43.9, 0.001) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RESERVE_CONTAINS_POSTS');

    const shrink = await call('PATCH', `/api/territories/${t.id}`, { geom: square(2.9, 43.9, 0.005) });
    expect(shrink.status).toBe(422);
    expect(shrink.body.code).toBe('TERRITORY_EXCLUDES_POSTS');
    expect(shrink.body.message).toMatch(/7/);

    const outside = await call('POST', `/api/territories/${t.id}/reserves`, { geom: square(3.5, 43.9, 0.001) });
    expect(outside.status).toBe(422);
  });

  it('refuse un numéro de poste déjà utilisé', async () => {
    const t = await newTerritory(3.1, 44.1);
    await call('POST', `/api/territories/${t.id}/posts`, { number: 3, geom: point(3.1, 44.1) });
    const dup = await call('POST', `/api/territories/${t.id}/posts`, { number: 3, geom: point(3.101, 44.1) });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('POST_NUMBER_TAKEN');
  });

  it('trace les modifications de cartographie dans le journal d’audit', async () => {
    const t = await newTerritory(3.3, 44.3);
    await call('PATCH', `/api/territories/${t.id}`, { name: 'Renommé' });
    const audit = await call('GET', '/api/audit?limit=5');
    expect(audit.status).toBe(200);
    const [last] = audit.body.entries;
    expect(last).toMatchObject({ action: 'update', entity: 'territories', entity_id: t.id, actor_id: `dev_${P}` });
    expect(last.diff.name).toEqual({ old: 'Bois des Fourches', new: 'Renommé' });
  });
});
