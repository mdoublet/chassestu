// Lieux de l'association (rendez-vous, regroupement) et parkings.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, point, square } from './helpers';

const P = 'pres_lieux';
let tenant: string;
const as = (u: string, method: string, path: string, body?: unknown) => api(u, method, path, { tenant, body });

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des lieux');
  const t = (await as(P, 'POST', '/api/territories', { name: 'Bois des lieux', geom: square(3.5, 44, 0.01) })).body.territory.id;
  await as(P, 'POST', `/api/territories/${t}/parkings`, { name: 'Col', geom: point(3.49, 44) });
  const inv = await as(P, 'POST', '/api/invitations', {});
  await api('l_ch', 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
});

describe('lieux', () => {
  it('le président crée, modifie et supprime ; les membres voient lieux et parkings', async () => {
    const c = await as(P, 'POST', '/api/places', { name: 'Cabane du Lampy', kind: 'cabane', geom: point(3.5, 44.01) });
    expect(c.status).toBe(201);
    expect(c.body.place).toMatchObject({ name: 'Cabane du Lampy', kind: 'cabane', geom: { type: 'Point' } });
    expect((await as(P, 'POST', '/api/places', { name: 'Cabane du Lampy', geom: point(3.5, 44) })).status).toBe(409); // nom en double
    expect((await as(P, 'PATCH', `/api/places/${c.body.place.id}`, { kind: 'restaurant', name: 'Chez Odette' })).body.place).toMatchObject({ kind: 'restaurant', name: 'Chez Odette' });
    const seen = (await as('l_ch', 'GET', '/api/places')).body;
    expect(seen.places.map((p: any) => p.name)).toEqual(['Chez Odette']);
    expect(seen.parkings).toMatchObject([{ name: 'Col', territory_name: 'Bois des lieux' }]);
    expect((await as('l_ch', 'POST', '/api/places', { name: 'X', geom: point(3.5, 44) })).status).toBe(403);
    expect((await as(P, 'DELETE', `/api/places/${c.body.place.id}`)).status).toBe(204);
  });
});

describe('marche et voiture des membres', () => {
  it('le président renseigne un membre de son association ; un chasseur ne peut pas', async () => {
    expect((await as(P, 'PATCH', '/api/members/dev_l_ch/mobility', { walking_ability: 2, has_car: true, car_seats: 3 })).status).toBe(200);
    const m = (await as(P, 'GET', '/api/members')).body.members.find((x: any) => x.id === 'dev_l_ch');
    expect(m).toMatchObject({ walking_ability: 2, has_car: true, car_seats: 3 });
    expect((await as(P, 'PATCH', '/api/members/dev_l_ch/mobility', { car_seats: null })).status).toBe(200);
    expect((await as(P, 'GET', '/api/members')).body.members.find((x: any) => x.id === 'dev_l_ch')).toMatchObject({ walking_ability: 2, car_seats: null });
    expect((await as('l_ch', 'PATCH', `/api/members/dev_${P}/mobility`, { has_car: false })).status).toBe(403);
    expect((await as(P, 'PATCH', '/api/members/dev_inconnu/mobility', { has_car: false })).status).toBe(404);
  });
});
