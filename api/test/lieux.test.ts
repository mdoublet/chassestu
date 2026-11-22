// Lieux de l'association (rendez-vous, regroupement) et parkings.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, createTenant, env, photoStore, point, pool, square } from './helpers';

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
    // Type saisi par le président : accepté et reproposé.
    expect((await as(P, 'PATCH', `/api/places/${c.body.place.id}`, { kind: 'Salle des fêtes' })).body.place.kind).toBe('Salle des fêtes');
    expect((await as(P, 'GET', '/api/places')).body.kinds).toEqual(['Salle des fêtes']);
    expect((await as(P, 'PATCH', `/api/places/${c.body.place.id}`, { kind: 'x'.repeat(41) })).status).toBe(400);
    expect((await as(P, 'DELETE', `/api/places/${c.body.place.id}`)).status).toBe(204);
  });
});

describe('photos encore en base', () => {
  it('recopiées dans le stockage à la première lecture, par un simple membre', async () => {
    const place = (await as(P, 'POST', '/api/places', { name: 'Ancienne photo', geom: point(3.5, 44.05) })).body.place;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await pool.query(`UPDATE places SET photo = decode($2, 'base64'), photo_type = 'image/png', photo_updated_at = now() WHERE id = $1`, [place.id, png]);
    const read = () => app.request(`/api/places/${place.id}/photo`, { headers: { Authorization: 'Bearer dev:l_ch:Chasseur', 'X-Tenant-Id': tenant } }, env);
    const first = await read();
    expect(Buffer.from(await first.arrayBuffer()).toString('base64')).toBe(png);
    const row = (await pool.query('SELECT photo_key, photo IS NULL AS moved FROM places WHERE id = $1', [place.id])).rows[0];
    expect(row.moved).toBe(true);
    expect(photoStore.objects.has(row.photo_key)).toBe(true);
    expect(Buffer.from(await (await read()).arrayBuffer()).toString('base64')).toBe(png);
    expect((await as(P, 'DELETE', `/api/places/${place.id}`)).status).toBe(204);
    expect(photoStore.objects.has(row.photo_key)).toBe(false);
  });
});

describe('lieux des chasseurs', () => {
  it('un chasseur crée ses lieux privés ; le président les voit et les rend publics', async () => {
    const inv = await as(P, 'POST', '/api/invitations', {});
    await api('l_ch2', 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
    const mine = await as('l_ch', 'POST', '/api/places', { name: 'Mon affût', kind: 'Affût', geom: point(3.5, 44.03) });
    expect(mine.status).toBe(201);
    expect(mine.body.place).toMatchObject({ visibility: 'private', mine: true });
    const id = mine.body.place.id;
    // Un autre chasseur ne le voit pas ; il peut prendre le même nom pour lui.
    expect((await as('l_ch2', 'GET', '/api/places')).body.places.some((p: any) => p.id === id)).toBe(false);
    expect((await as('l_ch2', 'POST', '/api/places', { name: 'Mon affût', geom: point(3.5, 44.04) })).status).toBe(201);
    expect((await as('l_ch2', 'PATCH', `/api/places/${id}`, { notes: 'x' })).status).toBe(404);
    // L'auteur modifie, ajoute une photo, mais ne publie pas lui-même.
    expect((await as('l_ch', 'PATCH', `/api/places/${id}`, { notes: 'derrière le chêne' })).body.place.notes).toBe('derrière le chêne');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    expect((await as('l_ch', 'PUT', `/api/places/${id}/photo`, { type: 'image/png', data: png })).body.place.has_photo).toBe(true);
    expect((await as('l_ch', 'PATCH', `/api/places/${id}`, { visibility: 'public' })).status).toBe(403);
    // Le président le voit, avec son auteur, et le publie.
    const seen = (await as(P, 'GET', '/api/places')).body.places.find((p: any) => p.id === id);
    expect(seen).toMatchObject({ visibility: 'private', mine: false, author: expect.any(String) });
    expect((await as(P, 'PATCH', `/api/places/${id}`, { visibility: 'public' })).body.place.visibility).toBe('public');
    // Public : visible de tous, plus modifiable par son auteur.
    expect((await as('l_ch2', 'GET', '/api/places')).body.places.some((p: any) => p.id === id)).toBe(true);
    expect((await as('l_ch', 'PATCH', `/api/places/${id}`, { notes: 'y' })).status).toBe(403);
    expect((await as('l_ch', 'DELETE', `/api/places/${id}`)).status).toBe(403);
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
    // Rangée dans le stockage d'objets, pas en base.
    const key = (await pool.query('SELECT photo_key, photo IS NULL AS no_bytes FROM places WHERE id = $1', [place.id])).rows[0];
    expect(key.no_bytes).toBe(true);
    expect(key.photo_key).toMatch(new RegExp(`^${tenant}/places/${place.id}/\\w+\\.png$`));
    expect(photoStore.objects.has(key.photo_key)).toBe(true);
    expect((await as(P, 'DELETE', `/api/places/${place.id}/photo`)).status).toBe(204);
    expect(photoStore.objects.has(key.photo_key)).toBe(false);
    expect((await app.request(`/api/places/${place.id}/photo`, { headers: { Authorization: 'Bearer dev:l_ch:Chasseur', 'X-Tenant-Id': tenant } }, env)).status).toBe(404);

    expect((await api('l_ch', 'PATCH', '/api/me', { body: { nav_app: 'waze' } })).body.user.nav_app).toBe('waze');
    expect((await api('l_ch', 'GET', '/api/me')).body.user.nav_app).toBe('waze');
    expect((await api('l_ch', 'PATCH', '/api/me', { body: { nav_app: 'bing' } })).status).toBe(400);
  });
});
