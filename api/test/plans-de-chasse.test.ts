// Plans de chasse : plusieurs traques par territoire (départ, tracé, sortie),
// chacune avec sa grille par effectif ; la battue choisit son plan de chasse,
// qui donne les postes proposés.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, east, point, runningDay, square } from './helpers';

const P = 'pres_pdc';
let tenant: string;
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });
const LAT = 44.6;
const LON = 3.3;
let territoryId: string;
let otherTerritory: string;
const ids: Record<number, string> = {};
const HUNTERS = ['pdc1', 'pdc2', 'pdc3'];

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des traques');
  territoryId = (await call('POST', '/api/territories', { name: 'Bois des traques', geom: square(LON, LAT, 0.01) })).body.territory.id;
  otherTerritory = (await call('POST', '/api/territories', { name: 'Autre bois', geom: square(LON + 0.05, LAT, 0.005) })).body.territory.id;
  for (let n = 1; n <= 6; n++) {
    ids[n] = (await call('POST', `/api/territories/${territoryId}/posts`, { number: n, geom: point(east(LON - 0.008, LAT, n * 150), LAT) })).body.item.id;
  }
  const inv = await call('POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

const line = { type: 'LineString', coordinates: [[LON - 0.005, LAT - 0.004], [LON, LAT], [LON + 0.005, LAT + 0.004]] };

describe('plans de chasse', () => {
  let nord: string;
  let sud: string;

  it('création avec traque, nom unique par territoire, modification', async () => {
    const a = await call('POST', `/api/territories/${territoryId}/hunt-plans`, {
      name: 'Traque nord', start_point: { type: 'Point', coordinates: line.coordinates[0] }, drive_path: line, exit_point: { type: 'Point', coordinates: line.coordinates[2] },
    });
    expect(a.status).toBe(201);
    expect(a.body.hunt_plan).toMatchObject({ name: 'Traque nord', coverage: [] });
    expect(a.body.hunt_plan.drive_path.type).toBe('LineString');
    expect(a.body.hunt_plan.drive_length_m).toBeGreaterThan(1000);
    nord = a.body.hunt_plan.id;
    expect((await call('POST', `/api/territories/${territoryId}/hunt-plans`, { name: 'Traque nord' })).status).toBe(409);
    sud = (await call('POST', `/api/territories/${territoryId}/hunt-plans`, { name: 'Traque sud' })).body.hunt_plan.id;
    const p = await call('PATCH', `/api/hunt-plans/${sud}`, { notes: 'Chiens lâchés au ruisseau', exit_point: { type: 'Point', coordinates: [LON, LAT] } });
    expect(p.body.hunt_plan).toMatchObject({ notes: 'Chiens lâchés au ruisseau', exit_point: { type: 'Point' }, drive_path: null });
    // Le chasseur lit, ne modifie pas.
    expect((await api('pdc1', 'GET', `/api/territories/${territoryId}/hunt-plans`, { tenant })).body.hunt_plans.map((x: any) => x.name)).toEqual(['Traque nord', 'Traque sud']);
    expect((await api('pdc1', 'PATCH', `/api/hunt-plans/${sud}`, { tenant, body: { name: 'x' } })).status).toBe(403);
  });

  it('une grille par plan de chasse : mêmes effectifs, postes différents', async () => {
    expect((await call('PUT', `/api/hunt-plans/${nord}/coverage/3`, { post_ids: [ids[1], ids[2], ids[3]] })).body.plan.numbers).toEqual([1, 2, 3]);
    expect((await call('PUT', `/api/hunt-plans/${sud}/coverage/3`, { post_ids: [ids[4], ids[5], ids[6]] })).body.plan.numbers).toEqual([4, 5, 6]);
    const list = (await call('GET', `/api/territories/${territoryId}/hunt-plans`)).body.hunt_plans;
    expect(list.map((x: any) => [x.name, x.coverage.map((c: any) => c.numbers)])).toEqual([['Traque nord', [[1, 2, 3]]], ['Traque sud', [[4, 5, 6]]]]);
    const posts = (await call('GET', `/api/territories/${territoryId}`)).body.posts;
    expect(posts.find((x: any) => x.number === 4).plan_uses).toEqual(['Traque sud à 3']);
    const t = (await call('GET', '/api/territories')).body.territories.find((x: any) => x.id === territoryId);
    expect(t.plans_count).toBe(2);
    expect((await call('DELETE', `/api/hunt-plans/${sud}/coverage/3`)).status).toBe(204);
    expect((await call('DELETE', `/api/hunt-plans/${sud}/coverage/3`)).status).toBe(404);
    await call('PUT', `/api/hunt-plans/${sud}/coverage/3`, { post_ids: [ids[4], ids[5], ids[6]] });
  });

  it('la battue suit le plan de chasse choisi (proposition), modifiable avant le début', async () => {
    const { dayId } = await runningDay((u, m, path, body) => api(u, m, path, { tenant, body }), P, HUNTERS);
    // Plan d'un autre territoire : refusé.
    const otherPlan = (await call('POST', `/api/territories/${otherTerritory}/hunt-plans`, { name: 'Ailleurs' })).body.hunt_plan.id;
    expect((await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId, hunt_plan_id: otherPlan })).status).toBe(422);

    const res = await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId, hunt_plan_id: sud });
    expect(res.status).toBe(201);
    expect(res.body.battues.at(-1)).toMatchObject({ hunt_plan_name: 'Traque sud' });
    let detail = (await call('GET', `/api/hunts/${res.body.hunt_id}`)).body;
    expect(detail.hunt).toMatchObject({ hunt_plan_id: sud, hunt_plan_name: 'Traque sud' });
    expect(detail.hunt_plan).toMatchObject({ name: 'Traque sud', notes: 'Chiens lâchés au ruisseau' });
    const num = (pids: string[]) => pids.map((id) => Number(Object.keys(ids).find((n) => ids[Number(n)] === id))).sort();
    expect(detail.proposal).toMatchObject({ kind: 'plan', hunters: 3 });
    expect(num(detail.proposal.post_ids)).toEqual([4, 5, 6]);

    detail = (await call('PATCH', `/api/hunts/${res.body.hunt_id}`, { hunt_plan_id: nord })).body;
    expect(num(detail.proposal.post_ids)).toEqual([1, 2, 3]);
    // Sans plan : choix à la main.
    detail = (await call('PATCH', `/api/hunts/${res.body.hunt_id}`, { hunt_plan_id: null })).body;
    expect(detail.proposal.kind).toBe('manual');
    expect(detail.hunt_plan).toBeNull();
  });

  it('vent : plage favorable par plan ; vent prévu gardé avec la battue', async () => {
    const hp = (await call('POST', `/api/territories/${territoryId}/hunt-plans`, { name: 'Vent d’ouest', wind_from_min: 248, wind_from_max: 315 })).body.hunt_plan;
    expect(hp).toMatchObject({ wind_from_min: 248, wind_from_max: 315 });
    // Les deux bornes, ou aucune.
    expect((await call('PATCH', `/api/hunt-plans/${hp.id}`, { wind_from_min: 10 })).status).toBe(400);
    expect((await call('PATCH', `/api/hunt-plans/${hp.id}`, { wind_from_min: 315, wind_from_max: 45 })).body.hunt_plan).toMatchObject({ wind_from_min: 315, wind_from_max: 45 });
    expect((await call('PATCH', `/api/hunt-plans/${hp.id}`, { wind_from_min: null, wind_from_max: null })).body.hunt_plan.wind_from_min).toBeNull();
    expect((await call('PATCH', `/api/hunt-plans/${hp.id}`, { wind_from_min: 400, wind_from_max: 10 })).status).toBe(400);

    const { dayId } = await runningDay((u, m, path, body) => api(u, m, path, { tenant, body }), P, HUNTERS, { date: '2026-12-12' });
    const res = await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId, hunt_plan_id: hp.id, wind: { from_deg: 270, speed_kmh: 18, gust_kmh: 35 } });
    expect(res.status).toBe(201);
    expect((await call('GET', `/api/hunts/${res.body.hunt_id}`)).body.hunt).toMatchObject({ wind_from_deg: 270, wind_speed_kmh: 18, wind_gust_kmh: 35 });
    expect(res.body.battues.at(-1)).toMatchObject({ wind_from_deg: 270, wind_speed_kmh: 18 });
    expect((await call('DELETE', `/api/hunt-plans/${hp.id}`)).status).toBe(204);
  });

  it('supprimer un plan de chasse : sa grille disparaît, la battue passe sans plan', async () => {
    const tmp = (await call('POST', `/api/territories/${territoryId}/hunt-plans`, { name: 'Éphémère' })).body.hunt_plan.id;
    await call('PUT', `/api/hunt-plans/${tmp}/coverage/1`, { post_ids: [ids[1]] });
    expect((await call('DELETE', `/api/hunt-plans/${tmp}`)).status).toBe(204);
    expect((await call('GET', `/api/territories/${territoryId}/hunt-plans`)).body.hunt_plans.map((x: any) => x.name)).toEqual(['Traque nord', 'Traque sud']);
    expect((await call('DELETE', `/api/hunt-plans/${tmp}`)).status).toBe(404);
  });
});
