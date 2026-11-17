// Positions GPS en direct : consentement, battue en cours, visibilité, purge.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, asOwner, createTenant, east, point, square } from './helpers';
import { positionStatus } from '../src/routes/hunts';

const P = 'pres_pos';
let tenant: string;
let territoryId: string;
const posts: string[] = [];
const as = (u: string, method: string, path: string, body?: unknown) => api(u, method, path, { tenant, body });
const LAT = 45.0;
const postLon = (n: number) => east(4.995, LAT, n * 200);

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des positions');
  territoryId = (await as(P, 'POST', '/api/territories', { name: 'Bois suivi', geom: square(5.0, LAT, 0.01) })).body.territory.id;
  for (let n = 1; n <= 2; n++) posts.push((await as(P, 'POST', `/api/territories/${territoryId}/posts`, { geom: point(postLon(n), LAT) })).body.item.id);
  const inv = await as(P, 'POST', '/api/invitations', {});
  for (const u of ['g_ch1', 'g_ch2', 'g_autre']) await api(u, 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
});

async function hunt(start = true) {
  const id = (await as(P, 'POST', '/api/hunts', { territory_id: territoryId, date: '2026-12-21', participant_user_ids: ['dev_g_ch1', 'dev_g_ch2'] })).body.hunt.id;
  await as(P, 'POST', `/api/hunts/${id}/actions/publier`);
  if (!start) return id;
  let d = (await as(P, 'POST', `/api/hunts/${id}/actions/demarrer`)).body;
  for (const p of d.participants) d = (await as(P, 'PATCH', `/api/hunts/${id}/participants/${p.id}`, { present: true })).body;
  await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: posts });
  const pid = (u: string) => d.participants.find((p: any) => p.user_id === u).id;
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: pid('dev_g_ch1'), post_id: posts[0] });
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: pid('dev_g_ch2'), post_id: posts[1] });
  return id;
}

describe('positions en direct', () => {
  it('statut calculé : sur le poste, en route, imprécise, sans signal, non partagé', () => {
    const base = { shared: true, age_s: 20, accuracy_m: 10, distance_m: 12 };
    expect(positionStatus(base, 30)).toBe('sur_poste');
    expect(positionStatus({ ...base, distance_m: 80 }, 30)).toBe('en_route');
    expect(positionStatus({ ...base, accuracy_m: 61 }, 30)).toBe('imprecise');
    expect(positionStatus({ ...base, age_s: 400 }, 30)).toBe('sans_signal');
    expect(positionStatus({ ...base, age_s: null }, 30)).toBe('sans_signal');
    expect(positionStatus({ ...base, shared: false }, 30)).toBe('non_partage');
    expect(positionStatus({ ...base, distance_m: null }, 30)).toBe('localise');
  });

  it('rien avant la battue, rien sans consentement', async () => {
    const before = await hunt(false);
    expect((await as('g_ch1', 'PUT', `/api/hunts/${before}/position-sharing`, { share: true })).status).toBe(422);
    expect((await as('g_ch1', 'POST', `/api/hunts/${before}/position`, { lon: 5, lat: LAT, accuracy: 5 })).status).toBe(422);
    const id = await hunt();
    const r = await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: 5, lat: LAT, accuracy: 5 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('POSITION_NOT_SHARED');
    expect((await as('g_autre', 'PUT', `/api/hunts/${id}/position-sharing`, { share: true })).status).toBe(403); // non convoqué
  });

  it('le responsable voit tout le monde avec un statut ; un chasseur ne voit que lui', async () => {
    const id = await hunt();
    for (const u of ['g_ch1', 'g_ch2']) expect((await as(u, 'PUT', `/api/hunts/${id}/position-sharing`, { share: true })).status).toBe(200);
    expect((await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: east(postLon(1), LAT, 10), lat: LAT, accuracy: 8 })).status).toBe(204);
    expect((await as('g_ch2', 'POST', `/api/hunts/${id}/position`, { lon: east(postLon(2), LAT, -150), lat: LAT, accuracy: 12 })).status).toBe(204);

    const boss = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body;
    expect(boss.tolerance_m).toBe(30);
    const by = (n: string) => boss.participants.find((p: any) => p.name.includes(n));
    expect(by('g_ch1')).toMatchObject({ status: 'sur_poste', post_number: 1, shared: true });
    expect(by('g_ch1').distance_m).toBeLessThanOrEqual(11);
    expect(by('g_ch2')).toMatchObject({ status: 'en_route', post_number: 2 });

    const ch1 = (await as('g_ch1', 'GET', `/api/hunts/${id}/positions`)).body;
    expect(ch1.sharing).toBe(true);
    expect(ch1.participants.map((p: any) => p.name)).toEqual([by('g_ch1').name]);
    // Même en lisant la table directement, la RLS ne laisse voir que la sienne.
    expect((await as('g_autre', 'GET', `/api/hunts/${id}/positions`)).status).toBe(404);
  });

  it('une position plus ancienne ne remplace pas la plus récente ; retirer son accord efface', async () => {
    const id = await hunt();
    await as('g_ch1', 'PUT', `/api/hunts/${id}/position-sharing`, { share: true });
    await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: postLon(1), lat: LAT, accuracy: 5 });
    await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: 5.009, lat: LAT, accuracy: 5, recorded_at: new Date(Date.now() - 60_000).toISOString() });
    let me = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants.find((p: any) => p.name.includes('g_ch1'));
    expect(me.status).toBe('sur_poste');
    expect((await as('g_ch1', 'PUT', `/api/hunts/${id}/position-sharing`, { share: false })).status).toBe(200);
    me = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants.find((p: any) => p.name.includes('g_ch1'));
    expect(me).toMatchObject({ status: 'non_partage', lon: null });
    const left = await asOwner('SELECT count(*)::int AS n FROM hunt_positions WHERE hunt_id = $1', [id]);
    expect(left[0].n).toBe(0);
  });

  it('plus rien après la fin de battue ; purge selon la durée de conservation ; pas de journal', async () => {
    const id = await hunt();
    await as('g_ch2', 'PUT', `/api/hunts/${id}/position-sharing`, { share: true });
    await as('g_ch2', 'POST', `/api/hunts/${id}/position`, { lon: postLon(2), lat: LAT, accuracy: 5 });
    await as(P, 'POST', `/api/hunts/${id}/actions/fin`);
    expect((await as('g_ch2', 'POST', `/api/hunts/${id}/position`, { lon: postLon(2), lat: LAT, accuracy: 5 })).status).toBe(422);

    await asOwner(`UPDATE hunt_positions SET recorded_at = now() - interval '25 hours' WHERE hunt_id = $1`, [id]);
    await asOwner('SELECT app.purge_positions()');
    expect((await asOwner('SELECT count(*)::int AS n FROM hunt_positions WHERE hunt_id = $1', [id]))[0].n).toBe(0);
    expect((await asOwner(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'hunt_positions'`))[0].n).toBe(0);
  });

  it('la purge n’est pas appelable par le rôle applicatif', async () => {
    const r = await asOwner(`SELECT has_function_privilege('app_rls', 'app.purge_positions()', 'EXECUTE') AS ok`);
    expect(r[0].ok).toBe(false);
  });
});
