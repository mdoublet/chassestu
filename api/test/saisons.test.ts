// Saisons : saison initiale, espèces et quotas, rattachements, nouvelle saison
// reprenant la précédente, journées de la saison, récapitulatif.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_saison';
let tenant: string;
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des saisons');
  const inv = await as(P, 'POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of ['sai1', 'sai2']) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

describe('saisons', () => {
  let first: string;
  let territory: string;

  it('saison initiale en cours, espèces par défaut, éléments créés rattachés', async () => {
    const s = (await as(P, 'GET', '/api/seasons')).body;
    expect(s.current).toMatchObject({ current: true });
    expect(s.current.name).toMatch(/^\d{4}-\d{4}$/);
    expect(s.species.map((x: any) => x.species)).toEqual(['Sanglier', 'Chevreuil']);
    first = s.current.id;
    territory = (await as(P, 'POST', '/api/territories', { name: 'Bois saison', geom: square(4.9, 44.9, 0.005) })).body.territory.id;
    expect((await as(P, 'GET', '/api/territories')).body.territories.find((t: any) => t.id === territory).in_season).toBe(true);
    const place = (await as(P, 'POST', '/api/places', { name: 'Cabane', kind: 'cabane', geom: point(4.9, 44.9) })).body.place;
    expect((await as(P, 'GET', '/api/places')).body.places.find((x: any) => x.id === place.id).in_season).toBe(true);
    expect((await as(P, 'GET', '/api/members')).body.members.every((m: any) => m.in_season)).toBe(true);
    // Chasseur : lecture seule.
    expect((await as('sai1', 'PUT', `/api/seasons/${first}/species`, { species: [] })).status).toBe(403);
  });

  it('espèces et quotas ; la première battue reprend le nombre par battue ; récapitulatif', async () => {
    const put = await as(P, 'PUT', `/api/seasons/${first}/species`, { species: [
      { species: 'Sanglier', season_quota: 40, battue_quota: 3 },
      { species: 'Chevreuil', season_quota: 12, battue_quota: null },
    ] });
    expect(put.body.species).toMatchObject([{ species: 'Sanglier', season_quota: 40, battue_quota: 3, harvested: 0 }, { species: 'Chevreuil', season_quota: 12 }]);
    expect((await as(P, 'PUT', `/api/seasons/${first}/species`, { species: [{ species: 'Cerf', season_quota: 1, battue_quota: 1 }, { species: 'cerf', season_quota: 1, battue_quota: 1 }] })).status).toBe(422);

    const { dayId } = await runningDay(as, P, ['sai1', 'sai2'], { date: '2026-12-05' });
    const { huntId, detail } = await newBattue(as, P, dayId, territory);
    expect(detail.species).toEqual(expect.arrayContaining([{ species: 'Sanglier', quota: 3 }, { species: 'Chevreuil', quota: null }]));
    const shooter = detail.participants[0].id;
    expect((await as(P, 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Sanglier', category: 'male', participant_id: shooter })).status).toBe(201);
    await as(P, 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Sanglier', category: 'femelle', participant_id: shooter });
    await as(P, 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Renard', category: 'indetermine', participant_id: shooter });
    expect((await as(P, 'GET', `/api/hunts/${huntId}`)).body.season_species.find((x: any) => x.species === 'Sanglier')).toMatchObject({ season_quota: 40, harvested: 2 });
    const recap = (await as('sai1', 'GET', `/api/seasons/${first}/recap`)).body;
    expect(recap).toMatchObject({ days: 1, battues: 1 });
    expect(recap.species).toEqual(expect.arrayContaining([
      { species: 'Sanglier', season_quota: 40, total: 2, by_category: { male: 1, femelle: 1 }, wounded: 0 },
      { species: 'Chevreuil', season_quota: 12, total: 0, by_category: {}, wounded: 0 },
      { species: 'Renard', season_quota: null, total: 1, by_category: { indetermine: 1 }, wounded: 0 },
    ]));
    expect((await as(P, 'GET', '/api/days')).body.days.find((d: any) => d.id === dayId)).toMatchObject({ season_id: first, in_season: true });
  });

  it('nouvelle saison : reprend espèces et rattachements ; détacher ; changer de saison en cours', async () => {
    // Un membre retiré de la saison actuelle n'est pas repris.
    expect((await as(P, 'DELETE', `/api/seasons/${first}/members/dev_sai2`)).status).toBe(204);
    const created = await as(P, 'POST', '/api/seasons', { name: '2099-2100', starts_on: '2099-07-01', ends_on: '2100-06-30' });
    expect(created.status).toBe(201);
    expect(created.body.season).toMatchObject({ current: false, days_count: 0 });
    expect((await as(P, 'POST', '/api/seasons', { name: '2099-2100', starts_on: '2099-07-01', ends_on: '2100-06-30' })).status).toBe(409);
    const next = created.body.season.id;
    expect((await as(P, 'PUT', '/api/seasons/current', { season_id: next })).status).toBe(200);
    const s = (await as(P, 'GET', '/api/seasons')).body;
    expect(s.current.id).toBe(next);
    expect(s.species.map((x: any) => [x.species, x.season_quota, x.battue_quota, x.harvested])).toEqual([['Sanglier', 40, 3, 0], ['Chevreuil', 12, null, 0]]);
    expect((await as(P, 'GET', '/api/territories')).body.territories.find((t: any) => t.id === territory).in_season).toBe(true);
    const members = (await as(P, 'GET', '/api/members')).body.members;
    expect(members.find((m: any) => m.id === 'dev_sai2').in_season).toBe(false);
    expect(members.find((m: any) => m.id === 'dev_sai1').in_season).toBe(true);
    // Journées de l'ancienne saison : hors saison en cours.
    expect((await as(P, 'GET', '/api/days')).body.days.every((d: any) => !d.in_season)).toBe(true);
    // Détacher / rattacher un territoire.
    expect((await as(P, 'DELETE', `/api/seasons/${next}/territories/${territory}`)).status).toBe(204);
    expect((await as(P, 'GET', '/api/territories')).body.territories.find((t: any) => t.id === territory).in_season).toBe(false);
    expect((await as(P, 'PUT', `/api/seasons/${next}/territories/${territory}`)).status).toBe(200);
    // Suppression : ni la saison en cours, ni une saison avec journées.
    expect((await as(P, 'DELETE', `/api/seasons/${next}`)).status).toBe(409);
    expect((await as(P, 'DELETE', `/api/seasons/${first}`)).status).toBe(409);
    expect((await as('sai1', 'PUT', '/api/seasons/current', { season_id: first })).status).toBe(403);
  });
});

describe('animal tué, blessé, vu', () => {
  it('blessé et vu : alerte aux participants, non comptés dans les prélèvements', async () => {
    const t = (await as(P, 'POST', '/api/territories', { name: 'Bois des alertes', geom: square(4.95, 44.95, 0.005) })).body.territory.id;
    const { dayId } = await runningDay(as, P, ['sai1'], { date: '2027-01-09' });
    const { huntId } = await newBattue(as, P, dayId, t);
    const before = (await as('sai1', 'GET', '/api/notifications')).body.notifications.length;
    // Le chasseur déclare lui-même : il n'est pas alerté de sa propre déclaration ; le président (responsable) l'est.
    expect((await as('sai1', 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Sanglier', category: 'male', outcome: 'blesse' })).status).toBe(201);
    const v = (await as('sai1', 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Chevreuil', outcome: 'vu' })).body.view;
    expect(v.current.harvests.map((x: any) => x.outcome).sort()).toEqual(['blesse', 'vu']);
    expect((await as('sai1', 'GET', '/api/notifications')).body.notifications.length).toBe(before);
    const bell = (await as(P, 'GET', '/api/notifications')).body.notifications;
    expect(bell.find((n: any) => n.kind === 'animal' && n.title === '⚠ Sanglier blessé (mâle)')).toBeTruthy();
    expect(bell.find((n: any) => n.kind === 'animal' && n.title === 'Chevreuil vu')).toBeTruthy();
    const sp = (await as(P, 'GET', `/api/hunts/${huntId}`)).body.season_species.find((x: any) => x.species === 'Sanglier');
    const recap = (await as(P, 'GET', `/api/seasons/${sp ? (await as(P, 'GET', '/api/seasons')).body.current.id : ''}/recap`)).body;
    expect(recap.species.find((x: any) => x.species === 'Sanglier').wounded).toBe(1);
    expect((await as(P, 'POST', `/api/hunts/${huntId}/harvests`, { species: 'Sanglier', outcome: 'perdu' })).status).toBe(400);
  });
});
