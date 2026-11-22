// Lieux de l'association (rendez-vous, regroupement) et parkings.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, createTenant, env, point, square } from './helpers';

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
    // Type saisi par le président : accepté et reproposé.
    expect((await as(P, 'PATCH', `/api/places/${c.body.place.id}`, { kind: 'Salle des fêtes' })).body.place.kind).toBe('Salle des fêtes');
    expect((await as(P, 'GET', '/api/places')).body.kinds).toEqual(['Salle des fêtes']);
    expect((await as(P, 'PATCH', `/api/places/${c.body.place.id}`, { kind: 'x'.repeat(41) })).status).toBe(400);
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

describe('photo d’un lieu et appli de navigation', () => {
  it('photo : envoi (président), lecture par un membre, suppression ; appli préférée dans le profil', async () => {
    const place = (await as(P, 'POST', '/api/places', { name: 'Cabane photo', kind: 'cabane', geom: point(3.5, 44.02) })).body.place;
    expect(place.has_photo).toBe(false);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    expect((await as('l_ch', 'PUT', `/api/places/${place.id}/photo`, { type: 'image/png', data: png })).status).toBe(403);
    const up = await as(P, 'PUT', `/api/places/${place.id}/photo`, { type: 'image/png', data: png });
    expect(up.body.place).toMatchObject({ has_photo: true });
    const res = await app.request(`/api/places/${place.id}/photo`, { headers: { Authorization: 'Bearer dev:l_ch:Chasseur', 'X-Tenant-Id': tenant } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).toString('base64')).toBe(png);
    expect((await as(P, 'DELETE', `/api/places/${place.id}/photo`)).status).toBe(204);
    expect((await app.request(`/api/places/${place.id}/photo`, { headers: { Authorization: 'Bearer dev:l_ch:Chasseur', 'X-Tenant-Id': tenant } }, env)).status).toBe(404);

    expect((await api('l_ch', 'PATCH', '/api/me', { body: { nav_app: 'waze' } })).body.user.nav_app).toBe('waze');
    expect((await api('l_ch', 'GET', '/api/me')).body.user.nav_app).toBe('waze');
    expect((await api('l_ch', 'PATCH', '/api/me', { body: { nav_app: 'bing' } })).status).toBe(400);
  });
});
