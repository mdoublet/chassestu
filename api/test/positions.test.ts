// Positions GPS en direct : consentement, battue en cours, visibilité, purge.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, asOwner, createTenant, east, newBattue, point, runningDay, square } from './helpers';
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
  for (let n = 1; n <= 3; n++) posts.push((await as(P, 'POST', `/api/territories/${territoryId}/posts`, { geom: point(postLon(n), LAT) })).body.item.id);
  const inv = await as(P, 'POST', '/api/invitations', {});
  for (const u of ['g_ch1', 'g_ch2', 'g_autre']) await api(u, 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
});

const dayOf = new Map<string, string>();
const share = (u: string, huntId: string, value: boolean) => as(u, 'PUT', `/api/days/${dayOf.get(huntId)}/position-sharing`, { share: value });

/** Battue en cours (postes 1 et 2 attribués à ch1 et ch2). */
async function hunt() {
  const { dayId } = await runningDay(as, P, ['g_ch1', 'g_ch2'], { date: '2026-12-21' });
  const { huntId: id, detail: d } = await newBattue(as, P, dayId, territoryId);
  dayOf.set(id, dayId);
  await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: posts.slice(0, 2) });
  const pid = (u: string) => d.participants.find((p: any) => p.user_id === u).id;
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: pid('dev_g_ch1'), post_id: posts[0] });
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: pid('dev_g_ch2'), post_id: posts[1] });
  return id;
}

/** Journée convoquée, pas encore commencée. */
async function dayNotStarted() {
  const created = await as(P, 'POST', '/api/days', { date: '2026-12-22', participant_user_ids: ['dev_g_ch1'] });
  await as(P, 'POST', `/api/days/${created.body.day.id}/actions/convoquer`);
  return created.body.day.id as string;
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
    const before = await dayNotStarted();
    expect((await as('g_ch1', 'PUT', `/api/days/${before}/position-sharing`, { share: true })).status).toBe(422);
    const id = await hunt();
    const r = await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: 5, lat: LAT, accuracy: 5 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('POSITION_NOT_SHARED');
    expect((await share('g_autre', id, true)).status).toBe(403); // non convoqué
    // Battue terminée : plus aucune position.
    await share('g_ch1', id, true);
    await as(P, 'POST', `/api/hunts/${id}/actions/fin`);
    expect((await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: 5, lat: LAT, accuracy: 5 })).status).toBe(422);
  });

  it('le responsable voit tout le monde avec un statut ; un chasseur ne voit que lui', async () => {
    const id = await hunt();
    for (const u of ['g_ch1', 'g_ch2']) expect((await share(u, id, true)).status).toBe(200);
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
    await share('g_ch1', id, true);
    await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: postLon(1), lat: LAT, accuracy: 5 });
    await as('g_ch1', 'POST', `/api/hunts/${id}/position`, { lon: 5.009, lat: LAT, accuracy: 5, recorded_at: new Date(Date.now() - 60_000).toISOString() });
    let me = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants.find((p: any) => p.name.includes('g_ch1'));
    expect(me.status).toBe('sur_poste');
    expect((await share('g_ch1', id, false)).status).toBe(200);
    me = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants.find((p: any) => p.name.includes('g_ch1'));
    expect(me).toMatchObject({ status: 'non_partage', lon: null });
    const left = await asOwner('SELECT count(*)::int AS n FROM hunt_positions WHERE hunt_id = $1', [id]);
    expect(left[0].n).toBe(0);
  });

  it('plus rien après la fin de battue ; purge selon la durée de conservation ; pas de journal', async () => {
    const id = await hunt();
    await share('g_ch2', id, true);
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

describe('« Je suis en place »', () => {
  it('confirmé : visible du responsable même sans partage GPS ; annulé si le poste change', async () => {
    const id = await hunt();
    expect((await as('g_ch1', 'PUT', `/api/hunts/${id}/in-place`, { in_place: true })).status).toBe(200);
    const status = async (n: string) => (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants.find((p: any) => p.name.includes(n)).status;
    expect(await status('g_ch1')).toBe('confirme');
    expect(await status('g_ch2')).toBe('non_partage');
    const sheet = (await as('g_ch1', 'GET', `/api/days/${dayOf.get(id)}/view`)).body.view.current;
    expect(sheet.me.in_place).toBe(true);
    expect(sheet.gps_tolerance_m).toBe(30);
    // Le responsable l'envoie sur un autre poste : la confirmation tombe.
    const detail = (await as(P, 'GET', `/api/hunts/${id}`)).body;
    const ch1 = detail.participants.find((p: any) => p.user_id === 'dev_g_ch1');
    expect(ch1.in_place_at).not.toBeNull();
    await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: posts });
    await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: ch1.id, post_id: posts[2] });
    expect(await status('g_ch1')).toBe('non_partage');
    expect((await as('g_autre', 'PUT', `/api/hunts/${id}/in-place`, { in_place: true })).status).toBe(403);
  });

  it('sans poste attribué : refusé', async () => {
    const id = await hunt();
    const ch2 = (await as(P, 'GET', `/api/hunts/${id}`)).body.participants.find((p: any) => p.user_id === 'dev_g_ch2');
    await as(P, 'DELETE', `/api/hunts/${id}/assignments/${ch2.id}`);
    const r = await as('g_ch2', 'PUT', `/api/hunts/${id}/in-place`, { in_place: true });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NO_POST');
  });

  it('un invité confirme par son lien', async () => {
    const { dayId } = await runningDay(as, P, ['g_ch1'], { date: '2026-12-23' });
    const token = (await as(P, 'POST', `/api/days/${dayId}/guests`, { name: 'Invité Max' })).body.guest_link.url.split('/').pop();
    // Avant toute battue : rien à confirmer.
    expect((await api('x', 'PUT', `/api/guest/${token}/in-place`, { body: { in_place: true } })).body.code).toBe('NO_POST');
    const { huntId: id, detail: d } = await newBattue(as, P, dayId, territoryId);
    const guest = d.participants.find((p: any) => p.name === 'Invité Max');
    await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: posts });
    await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: guest.id, post_id: posts[2] });
    await as(P, 'POST', `/api/hunts/${id}/publish-assignments`);
    const r = await api('x', 'PUT', `/api/guest/${token}/in-place`, { body: { in_place: true } });
    expect(r.status).toBe(200);
    const g = (await api('x', 'GET', `/api/guest/${token}`, {})).body.view.current;
    expect(g.me.in_place).toBe(true);
    const list = (await as(P, 'GET', `/api/hunts/${id}/positions`)).body.participants;
    expect(list.find((p: any) => p.name === 'Invité Max').status).toBe('confirme');
    expect((await api('x', 'PUT', '/api/guest/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/in-place', { body: { in_place: true } })).status).toBe(410);
  });
});

describe('sécurité des fiches', () => {
  it('la fiche brute n’est pas appelable par le rôle applicatif (pas de contrôle d’association)', async () => {
    const rows = await asOwner(`SELECT has_function_privilege('app_rls', 'app.hunt_view(uuid, uuid)', 'EXECUTE') AS a,
                                       has_function_privilege('app_rls', 'app.hunt_view_base(uuid, uuid)', 'EXECUTE') AS b,
                                       has_function_privilege('app_rls', 'app.day_view_base(uuid, uuid, boolean)', 'EXECUTE') AS c,
                                       has_function_privilege('app_rls', 'app.view_day(uuid)', 'EXECUTE') AS d`);
    expect(rows[0]).toEqual({ a: false, b: false, c: false, d: true });
  });
});
