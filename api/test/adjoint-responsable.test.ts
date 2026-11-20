// Président adjoint (mandat temporaire) et responsable de battue désigné.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, east, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_adj';
let tenant: string;
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });
const MEMBERS = ['adj_a', 'adj_b', 'adj_c'];
const LAT = 44.4;
const LON = 3.6;

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des mandats');
  const inv = await as(P, 'POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of MEMBERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const roleIn = async (user: string) => (await api(user, 'GET', '/api/me')).body.tenants.find((t: any) => t.id === tenant);

describe('président adjoint', () => {
  it('a les droits du président pendant son mandat, sauf sur les droits des autres', async () => {
    expect((await as('adj_a', 'POST', '/api/territories', { name: 'Avant mandat', geom: square(LON, LAT, 0.005) })).status).toBe(403);
    const m = await as(P, 'PUT', '/api/members/dev_adj_a/deputy', { until: inDays(3) });
    expect(m.status).toBe(200);
    expect(m.body.member.deputy_until).toBeTruthy();
    expect(await roleIn('adj_a')).toMatchObject({ role: 'president' });
    expect((await roleIn('adj_a')).deputy_until).toBeTruthy();
    expect((await as(P, 'GET', '/api/members')).body.members.find((x: any) => x.id === 'dev_adj_a')).toMatchObject({ role: 'chasseur' });

    // Droits du président…
    expect((await as('adj_a', 'POST', '/api/territories', { name: 'Pendant mandat', geom: square(LON, LAT, 0.005) })).status).toBe(201);
    expect((await as('adj_a', 'POST', '/api/invitations', {})).status).toBe(201);
    // … sauf les droits des autres.
    expect((await as('adj_a', 'PATCH', '/api/members/dev_adj_b', { role: 'responsable' })).status).toBe(403);
    expect((await as('adj_a', 'DELETE', '/api/members/dev_adj_b')).status).toBe(403);
    expect((await as('adj_a', 'PUT', '/api/members/dev_adj_b/deputy', { until: inDays(2) })).status).toBe(403);
    expect((await as('adj_a', 'POST', '/api/invitations', { role: 'president' })).status).toBe(403);
    expect((await as('adj_a', 'POST', '/api/invitations', { role: 'responsable' })).status).toBe(403);

    // Fin du mandat.
    expect((await as(P, 'PUT', '/api/members/dev_adj_a/deputy', { until: null })).body.member.deputy_until).toBeNull();
    expect(await roleIn('adj_a')).toMatchObject({ role: 'chasseur', deputy_until: null });
    expect((await as('adj_a', 'POST', '/api/territories', { name: 'Après mandat', geom: square(LON + 0.05, LAT, 0.005) })).status).toBe(403);
  });

  it('dates refusées ; pas de mandat pour un président', async () => {
    expect((await as(P, 'PUT', '/api/members/dev_adj_b/deputy', { until: inDays(-2) })).status).toBe(422);
    expect((await as(P, 'PUT', '/api/members/dev_adj_b/deputy', { until: inDays(400) })).status).toBe(422);
    expect((await as(P, 'PUT', `/api/members/dev_${P}/deputy`, { until: inDays(2) })).status).toBe(422);
    expect((await as('adj_c', 'PUT', '/api/members/dev_adj_b/deputy', { until: inDays(2) })).status).toBe(403);
  });
});

describe('responsable de battue', () => {
  it('désigné par le président : voit la mise en place, lance et arrête la battue', async () => {
    const territoryId = (await as(P, 'POST', '/api/territories', { name: 'Bois du responsable', geom: square(LON + 0.1, LAT, 0.01) })).body.territory.id;
    const posts: string[] = [];
    for (let n = 1; n <= 3; n++) posts.push((await as(P, 'POST', `/api/territories/${territoryId}/posts`, { number: n, geom: point(east(LON + 0.092, LAT, n * 150), LAT) })).body.item.id);
    const { dayId } = await runningDay(as, P, MEMBERS);
    const { huntId, detail } = await newBattue(as, P, dayId, territoryId);
    expect(detail.hunt.leader_user_id).toBe(`dev_${P}`); // le président par défaut

    expect((await as(P, 'PATCH', `/api/hunts/${huntId}`, { leader_user_id: 'dev_inconnu' })).status).toBe(422);
    const set = await as(P, 'PATCH', `/api/hunts/${huntId}`, { leader_user_id: 'dev_adj_b' });
    expect(set.body.hunt).toMatchObject({ leader_user_id: 'dev_adj_b' });
    const bell = (await as('adj_b', 'GET', '/api/notifications')).body.notifications;
    expect(bell.find((n: any) => n.kind === 'responsable')).toMatchObject({ title: 'Responsable de battue' });

    // Autre chasseur : ni vue responsable, ni lancement.
    expect((await as('adj_c', 'GET', `/api/hunts/${huntId}/lead`)).body).toEqual({ lead: false });
    expect((await as('adj_c', 'POST', `/api/hunts/${huntId}/actions/debut`)).status).toBe(403);
    // Le responsable : pas de lancement avant publication.
    expect((await as('adj_b', 'POST', `/api/hunts/${huntId}/actions/debut`)).status).toBe(422);

    await as(P, 'PUT', `/api/hunts/${huntId}/posts`, { post_ids: posts });
    const people = detail.participants;
    for (let i = 0; i < 3; i++) await as(P, 'PUT', `/api/hunts/${huntId}/assignments`, { participant_id: people[i].id, post_id: posts[i] });
    await as(P, 'POST', `/api/hunts/${huntId}/publish-assignments`);

    const lead = (await as('adj_b', 'GET', `/api/hunts/${huntId}/lead`)).body;
    expect(lead.lead).toBe(true);
    expect(lead.readiness.map((r: any) => r.post_number)).toEqual([1, 2, 3]);
    expect(lead.readiness.every((r: any) => r.participant_name && r.in_place_at === null)).toBe(true);

    expect((await as('adj_b', 'POST', `/api/hunts/${huntId}/actions/debut`)).body).toEqual({ ok: true });
    expect((await as(P, 'GET', `/api/hunts/${huntId}`)).body.hunt.started_at).toBeTruthy();
    expect((await as('adj_b', 'POST', `/api/hunts/${huntId}/actions/fin`)).body).toEqual({ ok: true });
    expect((await as(P, 'GET', `/api/hunts/${huntId}`)).body.hunt.status).toBe('terminee');
    // Le président garde la main (battue suivante).
    const next = await newBattue(as, P, dayId, territoryId);
    await as(P, 'PATCH', `/api/hunts/${next.huntId}`, { leader_user_id: 'dev_adj_b' });
    expect((await as(P, 'POST', `/api/hunts/${next.huntId}/actions/fin`)).body.hunt.status).toBe('terminee');
  });
});
