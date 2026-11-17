// Lot 4 — battue et attribution (critères d'acceptation de la spécification).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, createTenant, east, env, point, square } from './helpers';

const P = 'pres_battue';
let tenant: string;
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });
const LAT = 44.8;
let territoryId: string;
const ids: Record<number, string> = {};
const HUNTERS = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ch7'];

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des battues');
  // Territoire, 13 postes, plans de l'exemple (5 et 6 chasseurs).
  territoryId = (await call('POST', '/api/territories', { name: 'Grand bois', geom: square(5.0, LAT, 0.01) })).body.territory.id;
  for (let n = 1; n <= 13; n++) {
    ids[n] = (await call('POST', `/api/territories/${territoryId}/posts`, { number: n, geom: point(east(4.992, LAT, n * 100), LAT) })).body.item.id;
  }
  await call('PUT', `/api/territories/${territoryId}/coverage-plans/5`, { post_ids: [1, 3, 6, 7, 12].map((n) => ids[n]) });
  await call('PUT', `/api/territories/${territoryId}/coverage-plans/6`, { post_ids: [1, 3, 5, 8, 10, 13].map((n) => ids[n]) });
  // 7 chasseurs membres + un responsable de battue.
  const inv = await call('POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
  const invR = await call('POST', '/api/invitations', { role: 'responsable', max_uses: 1 });
  await api('resp_battue', 'POST', `/api/invitation-links/${invR.body.invitation.url.split('/').pop()}/accept`);
});

const byNumber = (detail: any) => {
  const num = new Map(Object.entries(ids).map(([n, id]) => [id, Number(n)]));
  return (postIds: string[]) => postIds.map((id) => num.get(id)).sort((a, b) => a! - b!);
};

async function newHunt(user = 'resp_battue', convoke = HUNTERS) {
  const res = await as(user, 'POST', '/api/hunts', {
    territory_id: territoryId, date: '2026-12-05', meeting_time: '07:45', meeting_place: 'Cabane de chasse',
    briefing: 'Sanglier et chevreuil. Tir fichant uniquement.', participant_user_ids: convoke.map((u) => `dev_${u}`),
  });
  expect(res.status).toBe(201);
  return res.body.hunt.id as string;
}

describe('cycle de vie d’une battue', () => {
  it('brouillon invisible des chasseurs ; publiée : ils la voient et répondent ; démarrée : présents pré-cochés', async () => {
    const id = await newHunt();
    expect((await as('ch1', 'GET', '/api/hunts')).body.hunts.find((h: any) => h.id === id)).toBeUndefined();
    expect((await as('ch1', 'GET', `/api/hunts/${id}/sheet`)).status).toBe(404);
    expect((await as('ch1', 'POST', '/api/hunts', { territory_id: territoryId, date: '2026-12-06' })).status).toBe(403);

    expect((await as('resp_battue', 'POST', `/api/hunts/${id}/actions/publier`)).status).toBe(200);
    const list = await as('ch1', 'GET', '/api/hunts');
    expect(list.body.hunts.find((h: any) => h.id === id)).toMatchObject({ status: 'publiee', date: '2026-12-05', meeting_time: '07:45' });
    const r1 = await as('ch1', 'POST', `/api/hunts/${id}/respond`, { response: 'present' });
    expect(r1.body.sheet.me).toMatchObject({ response: 'present' });
    await as('ch2', 'POST', `/api/hunts/${id}/respond`, { response: 'absent' });
    // Un chasseur ne voit pas le détail de gestion.
    expect((await as('ch1', 'GET', `/api/hunts/${id}`)).status).toBe(403);

    const started = await as('resp_battue', 'POST', `/api/hunts/${id}/actions/demarrer`);
    const present = started.body.participants.filter((p: any) => p.present).map((p: any) => p.user_id);
    expect(present).toEqual(['dev_ch1']);
    // Transition interdite.
    expect((await as('resp_battue', 'POST', `/api/hunts/${id}/actions/annuler`)).status).toBe(422);
  });

  it('un chasseur ne voit que les battues auxquelles il est convoqué', async () => {
    const id = await newHunt('resp_battue', ['ch1']);
    await as('resp_battue', 'POST', `/api/hunts/${id}/actions/publier`);
    expect((await as('ch1', 'GET', '/api/hunts')).body.hunts.some((h: any) => h.id === id)).toBe(true);
    expect((await as('ch2', 'GET', '/api/hunts')).body.hunts.some((h: any) => h.id === id)).toBe(false);
    expect((await as('ch2', 'GET', `/api/hunts/${id}/sheet`)).status).toBe(404);
    expect((await as('ch2', 'POST', `/api/hunts/${id}/respond`, { response: 'present' })).status).toBe(403);
  });

  it('pas d’attribution hors de l’état « en cours »', async () => {
    const id = await newHunt();
    const res = await as('resp_battue', 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[1]] });
    expect(res.status).toBe(409);
  });
});

/** Battue en cours avec `n` postés présents (ch1…chn). */
async function runningHunt(n: number) {
  const id = await newHunt();
  await as('resp_battue', 'POST', `/api/hunts/${id}/actions/publier`);
  let detail = (await as('resp_battue', 'POST', `/api/hunts/${id}/actions/demarrer`)).body;
  for (const p of detail.participants.slice(0, n)) {
    detail = (await as('resp_battue', 'PATCH', `/api/hunts/${id}/participants/${p.id}`, { present: true })).body;
  }
  return { id, detail };
}

describe('proposition et attribution', () => {
  it('avec 6 postés présents, les postes 1, 3, 5, 8, 10 et 13 sont proposés', async () => {
    const { detail } = await runningHunt(6);
    expect(detail.proposal).toMatchObject({ kind: 'plan', plan_count: 6 });
    expect(byNumber(detail)(detail.proposal.post_ids)).toEqual([1, 3, 5, 8, 10, 13]);
  });

  it('avec 7 postés et aucun plan pour 7, le plan à 6 est proposé et le responsable ajoute un poste', async () => {
    const { id, detail } = await runningHunt(7);
    expect(detail.proposal).toMatchObject({ kind: 'lower_plan', plan_count: 6, missing: 1 });
    const chosen = [...detail.proposal.post_ids, ids[2]];
    const res = await as('resp_battue', 'PUT', `/api/hunts/${id}/posts`, { post_ids: chosen });
    expect(res.status).toBe(200);
    expect(byNumber(res.body)(res.body.day_post_ids)).toEqual([1, 2, 3, 5, 8, 10, 13]);
    // Le plan enregistré n'a pas changé.
    const plans = (await call('GET', `/api/territories/${territoryId}/coverage-plans`)).body.plans;
    expect(plans.find((p: any) => p.hunter_count === 6).numbers).toEqual([1, 3, 5, 8, 10, 13]);
  });

  it('le tirage au sort respecte les postes verrouillés', async () => {
    const { id, detail } = await runningHunt(6);
    await as('resp_battue', 'PUT', `/api/hunts/${id}/posts`, { post_ids: detail.proposal.post_ids });
    const ch1 = detail.participants.find((p: any) => p.user_id === 'dev_ch1');
    // ch1 (mobilité réduite) verrouillé sur le poste 13, près du parking.
    await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: ch1.id, post_id: ids[13], locked: true });
    for (let run = 0; run < 5; run++) {
      const drawn = await as('resp_battue', 'POST', `/api/hunts/${id}/draw`, {});
      expect(drawn.status).toBe(200);
      const posted = drawn.body.participants.filter((p: any) => p.present);
      expect(posted.find((p: any) => p.id === ch1.id)).toMatchObject({ post_id: ids[13], locked: true });
      expect(new Set(posted.map((p: any) => p.post_id)).size).toBe(6); // chacun son poste
      expect(drawn.body.unplaced).toBe(0);
    }
  });

  it('un absent ou un traqueur ne reçoit pas de poste ; deux chasseurs au plus par poste', async () => {
    const { id, detail } = await runningHunt(3);
    await as('resp_battue', 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[1], ids[2]] });
    const [a, b, c] = detail.participants.filter((p: any) => p.present);
    const absent = detail.participants.find((p: any) => !p.present);
    expect((await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: absent.id, post_id: ids[1] })).body.code).toBe('PARTICIPANT_NOT_POSTED');
    for (const p of [a, b]) await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: p.id, post_id: ids[1] });
    expect((await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: c.id, post_id: ids[1] })).body.code).toBe('POST_FULL');
    // Passer un posté en traqueur lui retire son poste.
    const after = await as('resp_battue', 'PATCH', `/api/hunts/${id}/participants/${a.id}`, { role: 'traqueur' });
    expect(after.body.participants.find((p: any) => p.id === a.id).post_id).toBeNull();
  });
});

describe('fiche « Ma battue » et invités', () => {
  it('un invité sans compte accède à son poste par lien ; le lien expire à la clôture', async () => {
    const { id, detail } = await runningHunt(2);
    const withGuest = await as('resp_battue', 'POST', `/api/hunts/${id}/guests`, { name: 'Jean (invité)' });
    const guest = withGuest.body.participants.find((p: any) => p.guest);
    await as('resp_battue', 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[4], ids[5], ids[6]] });
    const [m1, m2] = detail.participants.filter((p: any) => p.present);
    await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: m1.id, post_id: ids[4] });
    await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: guest.id, post_id: ids[5] });
    await as('resp_battue', 'PUT', `/api/hunts/${id}/assignments`, { participant_id: m2.id, post_id: ids[6] });

    // Avant publication : le chasseur ne voit pas encore son poste.
    expect((await as('ch1', 'GET', `/api/hunts/${id}/sheet`)).body.sheet.post).toBeNull();

    const published = await as('resp_battue', 'POST', `/api/hunts/${id}/publish-assignments`);
    expect(published.body.guest_links).toHaveLength(1);
    const url: string = published.body.guest_links[0].url;
    expect(url).toMatch(/^http:\/\/app\.test\/#\/battue-invite\//);
    const token = url.split('/').pop();

    // Lien invité : sans compte ni en-tête.
    const res = await app.request(`/api/guest/${token}`, {}, env);
    expect(res.status).toBe(200);
    const sheet = ((await res.json()) as any).sheet;
    expect(sheet.me).toMatchObject({ name: 'Jean (invité)', guest: true });
    expect(sheet.post).toMatchObject({ number: 5 });
    // Voisins gauche et droite avec leur occupant (information de sécurité).
    expect(sheet.neighbors.map((n: any) => [n.number, n.side])).toEqual([[4, 'gauche'], [6, 'droite']]);
    expect(sheet.neighbors[0].occupant).toBe('ch1'); // nom affiché du chasseur du poste 4
    expect(sheet.hunt).toMatchObject({ meeting_place: 'Cabane de chasse', meeting_time: '07:45' });

    // Fiche d'un membre.
    const mine = (await as('ch1', 'GET', `/api/hunts/${id}/sheet`)).body.sheet;
    expect(mine.post.number).toBe(4);
    expect(mine.neighbors.map((n: any) => n.number)).toEqual([5]);

    // Début puis fin de battue : le lien invité expire.
    expect((await as('resp_battue', 'POST', `/api/hunts/${id}/actions/debut`)).body.hunt.started_at).not.toBeNull();
    expect((await as('resp_battue', 'POST', `/api/hunts/${id}/actions/fin`)).body.hunt.status).toBe('terminee');
    const expired = await app.request(`/api/guest/${token}`, {}, env);
    expect(expired.status).toBe(410);
  });

  it('un lien invité régénéré remplace l’ancien (révocation)', async () => {
    const { id } = await runningHunt(1);
    const g = (await as('resp_battue', 'POST', `/api/hunts/${id}/guests`, { name: 'Paul' })).body.participants.find((p: any) => p.guest);
    const first = (await as('resp_battue', 'POST', `/api/hunts/${id}/participants/${g.id}/guest-link`)).body.url.split('/').pop();
    const second = (await as('resp_battue', 'POST', `/api/hunts/${id}/participants/${g.id}/guest-link`)).body.url.split('/').pop();
    expect((await app.request(`/api/guest/${first}`, {}, env)).status).toBe(410);
    expect((await app.request(`/api/guest/${second}`, {}, env)).status).toBe(200);
    await as('resp_battue', 'DELETE', `/api/hunts/${id}/participants/${g.id}/guest-link`);
    expect((await app.request(`/api/guest/${second}`, {}, env)).status).toBe(410);
  });

  it('le début de battue exige des attributions publiées', async () => {
    const { id } = await runningHunt(1);
    expect((await as('resp_battue', 'POST', `/api/hunts/${id}/actions/debut`)).body.code).toBe('ASSIGNMENTS_NOT_PUBLISHED');
  });
});
