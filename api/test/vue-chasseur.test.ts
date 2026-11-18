// Vue chasseur pour tous, numéro de version, espèces et prélèvements.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, asOwner, createTenant, east, env, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_vue';
let tenant: string;
let territoryId: string;
const posts: string[] = [];
const as = (u: string, method: string, path: string, body?: unknown) => api(u, method, path, { tenant, body });

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA de la vue');
  territoryId = (await as(P, 'POST', '/api/territories', { name: 'Bois vu', geom: square(6.0, 46.0, 0.01) })).body.territory.id;
  for (let n = 1; n <= 3; n++) posts.push((await as(P, 'POST', `/api/territories/${territoryId}/posts`, { geom: point(east(5.995, 46.0, n * 150), 46.0) })).body.item.id);
  const inv = await as(P, 'POST', '/api/invitations', {});
  for (const u of ['v_ch1', 'v_ch2', 'v_ch3']) await api(u, 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
  const invR = await as(P, 'POST', '/api/invitations', { role: 'responsable', max_uses: 1 });
  await api('v_resp', 'POST', `/api/invitation-links/${invR.body.invitation.url.split('/').pop()}/accept`);
});

/** Battue en cours : ch1 (poste 1), ch2 (poste 2), invité (poste 3) ; postes publiés. */
async function runningHunt() {
  const { dayId } = await runningDay(as, P, ['v_ch1', 'v_ch2']);
  const g = await as(P, 'POST', `/api/days/${dayId}/guests`, { name: 'Invité Jo' });
  const guestToken = g.body.guest_link.url.split('/').pop() as string;
  const { huntId: id, detail: d } = await newBattue(as, P, dayId, territoryId);
  await as(P, 'PUT', `/api/hunts/${id}/species`, { species: [{ species: 'Sanglier', quota: 4 }, { species: 'Chevreuil', quota: 2 }, { species: 'Renard', quota: null }] });
  await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: posts });
  const by = (key: string) => d.participants.find((p: any) => p.user_id === key || p.name === key);
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('dev_v_ch1').id, post_id: posts[0] });
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('dev_v_ch2').id, post_id: posts[1] });
  await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('Invité Jo').id, post_id: posts[2] });
  await as(P, 'POST', `/api/hunts/${id}/publish-assignments`);
  return { id, dayId, guestToken, guestId: by('Invité Jo').id };
}
const view = async (u: string, dayId: string) => (await as(u, 'GET', `/api/days/${dayId}/view`)).body.view?.current;

describe('mises à jour automatiques', () => {
  it('le numéro de version change à chaque modification ; un convoqué peut le lire, pas un autre', async () => {
    const { id, dayId } = await runningHunt();
    const rev = async (u: string) => (await as(u, 'GET', `/api/days/${dayId}/revision`)).body;
    const r0 = await rev('v_ch1');
    expect(r0.status).toBe('en_cours');
    await as(P, 'POST', `/api/hunts/${id}/actions/debut`);
    const r1 = await rev('v_ch1');
    expect(r1.revision).toBeGreaterThan(r0.revision);
    await as('v_ch2', 'POST', `/api/hunts/${id}/harvests`, { species: 'Sanglier' });
    expect((await rev('v_ch1')).revision).toBeGreaterThan(r1.revision);
    expect((await as('v_ch3', 'GET', `/api/days/${dayId}/revision`)).status).toBe(404); // non convoqué
    // Le numéro de version n'encombre pas le journal d'audit.
    const audits = await asOwner(`SELECT diff FROM audit_log WHERE entity = 'hunts' AND entity_id = $1 AND action = 'update'`, [id]);
    expect(audits.every((a) => !('revision' in a.diff))).toBe(true);
  });
});

describe('vue chasseur', () => {
  it('chacun a sa vue : convoqué (son poste, ses voisins) ; responsable non convoqué (toute la ligne)', async () => {
    const { dayId } = await runningHunt();
    const ch1 = await view('v_ch1', dayId);
    expect(ch1.me).toMatchObject({ role: 'poste', present: true });
    expect(ch1.post.number).toBe(1);
    expect(ch1.neighbors.map((n: any) => [n.number, n.side])).toEqual([[2, 'droite']]);
    expect(ch1.hunt).toMatchObject({ status: 'en_cours', assignments_published: true, posted_count: 3 });

    const resp = await view('v_resp', dayId);
    expect(resp.me).toBeNull();
    expect(resp.post).toBeNull();
    expect(resp.neighbors.map((n: any) => [n.number, n.occupant])).toEqual([[1, 'v_ch1'], [2, 'v_ch2'], [3, 'Invité Jo']]);
    expect((await as('v_ch3', 'GET', `/api/days/${dayId}/view`)).status).toBe(404);
  });

  it('espèces avec quota et prélèvements : déclarés par les chasseurs, visibles par tous, invité compris', async () => {
    const { id, dayId, guestToken, guestId } = await runningHunt();
    const decl = await as('v_ch1', 'POST', `/api/hunts/${id}/harvests`, { species: 'Sanglier', category: 'male', notes: 'Coulée du ruisseau' });
    expect(decl.status).toBe(201);
    await as('v_ch2', 'POST', `/api/hunts/${id}/harvests`, { species: 'Chevreuil', category: 'femelle' });
    // Le responsable saisit pour l'invité (sans compte).
    expect((await as(P, 'POST', `/api/hunts/${id}/harvests`, { species: 'Sanglier', category: 'jeune', participant_id: guestId })).status).toBe(201);

    const v2 = await view('v_ch2', dayId);
    expect(v2.species).toEqual([
      { s: 'Chevreuil', quota: 2, taken: 1 },
      { s: 'Renard', quota: null, taken: 0 },
      { s: 'Sanglier', quota: 4, taken: 2 },
    ]);
    const first = v2.harvests.find((h: any) => h.shooter === 'v_ch1');
    expect(first).toMatchObject({ species: 'Sanglier', category: 'male', post_number: 1, mine: false, notes: 'Coulée du ruisseau' });
    expect(v2.harvests.find((h: any) => h.shooter === 'Invité Jo')).toMatchObject({ post_number: 3 });

    const guest = await app.request(`/api/guest/${guestToken}`, {}, env);
    expect(((await guest.json()) as any).view.current.species.find((x: any) => x.s === 'Sanglier').taken).toBe(2);

    // Retrait : seulement sa propre déclaration.
    const mine = (await view('v_ch1', dayId)).harvests.find((h: any) => h.mine);
    expect((await as('v_ch2', 'DELETE', `/api/hunts/${id}/harvests/${mine.id}`)).status).toBe(404);
    expect((await as('v_ch1', 'DELETE', `/api/hunts/${id}/harvests/${mine.id}`)).status).toBe(200);
    expect((await view('v_ch1', dayId)).species.find((x: any) => x.s === 'Sanglier').taken).toBe(1);

    // Après la fin : plus de déclaration par les chasseurs ; le responsable corrige encore.
    await as(P, 'POST', `/api/hunts/${id}/actions/fin`);
    expect((await as('v_ch2', 'POST', `/api/hunts/${id}/harvests`, { species: 'Renard' })).status).toBe(422);
    expect((await as(P, 'POST', `/api/hunts/${id}/harvests`, { species: 'Renard', participant_id: null })).status).toBe(201);
    // Journal d'audit des prélèvements.
    expect((await asOwner(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'hunt_harvests' AND tenant_id = $1`, [tenant]))[0].n).toBeGreaterThan(0);
  });

  it('espèces : saisie par le responsable seulement, sans doublon', async () => {
    const { dayId } = await runningDay(as, P, ['v_ch1'], { date: '2026-12-27' });
    const { huntId: id } = await newBattue(as, P, dayId, territoryId);
    expect((await as('v_ch1', 'PUT', `/api/hunts/${id}/species`, { species: [] })).status).toBe(403);
    expect((await as(P, 'PUT', `/api/hunts/${id}/species`, { species: [{ species: 'Sanglier', quota: 1 }, { species: 'sanglier', quota: 2 }] })).status).toBe(422);
    const ok = await as('v_resp', 'PUT', `/api/hunts/${id}/species`, { species: [{ species: 'Cerf élaphe', quota: 1 }] });
    expect(ok.body.species).toEqual([{ species: 'Cerf élaphe', quota: 1 }]);
  });
});
