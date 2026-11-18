// Journées de chasse et battues : convocation, présents, battues successives
// avec volontaires, proposition et tirage au sort (marche), invités,
// regroupement (critères du lot 4, réorganisés autour de la journée).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, app, createTenant, east, env, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_battue';
const R = 'resp_battue';
let tenant: string;
const call = (method: string, path: string, body?: unknown) => api(P, method, path, { tenant, body });
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });
const LAT = 44.8;
let territoryId: string;
let territory2: string;
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
  territory2 = (await call('POST', '/api/territories', { name: 'Petit bois', geom: square(5.05, LAT, 0.005) })).body.territory.id;
  // 7 chasseurs membres + un responsable de battue.
  const inv = await call('POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
  const invR = await call('POST', '/api/invitations', { role: 'responsable', max_uses: 1 });
  await api(R, 'POST', `/api/invitation-links/${invR.body.invitation.url.split('/').pop()}/accept`);
});

const numbers = (postIds: string[]) => {
  const num = new Map(Object.entries(ids).map(([n, id]) => [id, Number(n)]));
  return postIds.map((id) => num.get(id)).sort((a, b) => a! - b!);
};
const dp = (detail: any, user: string) => detail.participants.find((p: any) => p.user_id === `dev_${user}`);

describe('journée de chasse : convocation et réponses', () => {
  it('brouillon invisible ; convoquée : réponse et déjeuner ; démarrée : présents pré-cochés', async () => {
    const created = await as(R, 'POST', '/api/days', {
      date: '2026-12-12', meeting_time: '07:45', meeting_place: 'Cabane de chasse', lunch_offered: true, lunch_info: 'Salle des fêtes, 15 €',
      participant_user_ids: HUNTERS.map((u) => `dev_${u}`),
    });
    expect(created.status).toBe(201);
    const id = created.body.day.id;
    expect((await as('ch1', 'GET', '/api/days')).body.days.find((d: any) => d.id === id)).toBeUndefined();
    expect((await as('ch1', 'POST', '/api/days', { date: '2026-12-13' })).status).toBe(403);

    expect((await as(R, 'POST', `/api/days/${id}/actions/convoquer`)).status).toBe(200);
    expect((await as('ch1', 'GET', '/api/days')).body.days.find((d: any) => d.id === id)).toMatchObject({ status: 'convoquee', meeting_time: '07:45' });
    const r1 = await as('ch1', 'POST', `/api/days/${id}/respond`, { response: 'present', lunch: true });
    expect(r1.body.view.me).toMatchObject({ response: 'present', lunch: true });
    expect(r1.body.view.day).toMatchObject({ lunch_offered: true, lunch_info: 'Salle des fêtes, 15 €', lunch_count: 1 });
    // Absent : pas de déjeuner.
    expect((await as('ch2', 'POST', `/api/days/${id}/respond`, { response: 'absent', lunch: true })).body.view.me.lunch).toBe(false);
    expect((await as('ch1', 'GET', `/api/days/${id}`)).status).toBe(403);

    const started = await as(R, 'POST', `/api/days/${id}/actions/demarrer`);
    expect(started.body.participants.filter((p: any) => p.present).map((p: any) => p.user_id)).toEqual(['dev_ch1']);
    // Plus de réponse après le début : l'organisateur ajuste les présents.
    expect((await as('ch3', 'POST', `/api/days/${id}/respond`, { response: 'present' })).status).toBe(422);
    const adjusted = await as(R, 'PATCH', `/api/days/${id}/participants/${dp(started.body, 'ch3').id}`, { present: true });
    expect(dp(adjusted.body, 'ch3').present).toBe(true);
    expect((await as(R, 'POST', `/api/days/${id}/actions/annuler`)).status).toBe(422);
  });

  it('l’heure, le lieu et le déjeuner de la dernière journée sont repris', async () => {
    await as(R, 'POST', '/api/days', { date: '2026-12-19', meeting_time: '08:15', meeting_place: 'Croix du Loup', lunch_offered: true, lunch_info: 'Chez Odette' });
    expect((await as(R, 'GET', '/api/days/defaults')).body).toMatchObject({ meeting_time: '08:15', meeting_place: 'Croix du Loup', lunch_offered: true });
    const next = await as(R, 'POST', '/api/days', { date: '2026-12-26' });
    expect(next.body.day).toMatchObject({ meeting_time: '08:15', meeting_place: 'Croix du Loup', lunch_offered: true, lunch_info: 'Chez Odette' });
  });

  it('un chasseur ne voit que les journées auxquelles il est convoqué', async () => {
    const { dayId } = await runningDay(as, R, ['ch1']);
    expect((await as('ch1', 'GET', '/api/days')).body.days.some((d: any) => d.id === dayId)).toBe(true);
    expect((await as('ch2', 'GET', '/api/days')).body.days.some((d: any) => d.id === dayId)).toBe(false);
    expect((await as('ch2', 'GET', `/api/days/${dayId}/view`)).status).toBe(404);
  });
});

describe('battues successives avec volontaires', () => {
  it('volontaires parmi les présents ; une battue à la fois ; numéro et espèces reprises', async () => {
    const { dayId, detail } = await runningDay(as, R, HUNTERS, { present: ['ch1', 'ch2', 'ch3', 'ch4'] });
    const volunteers = ['ch1', 'ch2', 'ch3'].map((u) => dp(detail, u).id);
    const b1 = await newBattue(as, R, dayId, territoryId, volunteers);
    expect(b1.detail.hunt).toMatchObject({ number: 1, status: 'en_cours', territory_name: 'Grand bois' });
    expect(b1.detail.participants.map((p: any) => p.user_id).sort()).toEqual(['dev_ch1', 'dev_ch2', 'dev_ch3']);
    // Un absent ne peut pas être volontaire.
    expect((await as(R, 'PUT', `/api/hunts/${b1.huntId}/selection`, { day_participant_ids: [...volunteers, dp(detail, 'ch5').id] })).body.code).toBe('NOT_PRESENT');
    // ch4 (non volontaire) voit la journée mais pas la battue.
    const v4 = (await as('ch4', 'GET', `/api/days/${dayId}/view`)).body.view;
    expect(v4.battues).toMatchObject([{ number: 1, selected: false }]);
    expect(v4.current).toBeNull();
    expect((await as('ch1', 'GET', `/api/days/${dayId}/view`)).body.view.current.me).toMatchObject({ role: 'poste' });

    await as(R, 'PUT', `/api/hunts/${b1.huntId}/species`, { species: [{ species: 'Sanglier', quota: 2 }] });
    expect((await as(R, 'POST', `/api/days/${dayId}/battues`, { territory_id: territory2 })).body.code).toBe('BATTUE_RUNNING');
    await as(R, 'POST', `/api/hunts/${b1.huntId}/actions/fin`);
    const b2 = await newBattue(as, R, dayId, territory2);
    expect(b2.detail.hunt.number).toBe(2);
    expect(b2.detail.participants).toHaveLength(4); // tous les présents par défaut
    expect(b2.detail.species).toEqual([{ species: 'Sanglier', quota: 2 }]);
    // La journée ne se termine pas pendant une battue.
    expect((await as(R, 'POST', `/api/days/${dayId}/actions/terminer`)).body.code).toBe('BATTUE_RUNNING');
    // Battue créée par erreur : supprimable avant son début.
    expect((await as(R, 'DELETE', `/api/hunts/${b2.huntId}`)).status).toBe(204);
    expect((await as(R, 'POST', `/api/days/${dayId}/actions/terminer`)).body.day.status).toBe('terminee');
  });

  it('pas de battue avant le jour J', async () => {
    const created = await as(R, 'POST', '/api/days', { date: '2027-01-02', participant_user_ids: ['dev_ch1'] });
    expect((await as(R, 'POST', `/api/days/${created.body.day.id}/battues`, { territory_id: territoryId })).status).toBe(409);
  });
});

/** Battue en cours avec `n` postés (ch1…chn). */
async function runningHunt(n: number) {
  const { dayId, detail: day } = await runningDay(as, R, HUNTERS.slice(0, n));
  const { huntId, detail } = await newBattue(as, R, dayId, territoryId);
  return { id: huntId, dayId, day, detail };
}

describe('proposition et attribution', () => {
  it('avec 6 postés présents, les postes 1, 3, 5, 8, 10 et 13 sont proposés', async () => {
    const { detail } = await runningHunt(6);
    expect(detail.proposal).toMatchObject({ kind: 'plan', plan_count: 6 });
    expect(numbers(detail.proposal.post_ids)).toEqual([1, 3, 5, 8, 10, 13]);
  });

  it('avec 7 postés et aucun plan pour 7, le plan à 6 est proposé et le responsable ajoute un poste', async () => {
    const { id, detail } = await runningHunt(7);
    expect(detail.proposal).toMatchObject({ kind: 'lower_plan', plan_count: 6, missing: 1 });
    const res = await as(R, 'PUT', `/api/hunts/${id}/posts`, { post_ids: [...detail.proposal.post_ids, ids[2]] });
    expect(numbers(res.body.day_post_ids)).toEqual([1, 2, 3, 5, 8, 10, 13]);
    const plans = (await call('GET', `/api/territories/${territoryId}/coverage-plans`)).body.plans;
    expect(plans.find((p: any) => p.hunter_count === 6).numbers).toEqual([1, 3, 5, 8, 10, 13]);
  });

  it('le tirage au sort respecte les postes verrouillés', async () => {
    const { id, detail } = await runningHunt(6);
    await as(R, 'PUT', `/api/hunts/${id}/posts`, { post_ids: detail.proposal.post_ids });
    const ch1 = detail.participants.find((p: any) => p.user_id === 'dev_ch1');
    await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: ch1.id, post_id: ids[13], locked: true });
    for (let run = 0; run < 5; run++) {
      const drawn = await as(R, 'POST', `/api/hunts/${id}/draw`, {});
      const posted = drawn.body.participants;
      expect(posted.find((p: any) => p.id === ch1.id)).toMatchObject({ post_id: ids[13], locked: true });
      expect(new Set(posted.map((p: any) => p.post_id)).size).toBe(6);
      expect(drawn.body.unplaced).toBe(0);
    }
  });

  it('marche difficile : jamais un poste plus difficile que la capacité, et le plus facile', async () => {
    const { id, dayId, day, detail } = await runningHunt(3);
    // Difficulté des postes 1 à 3 : 5, 3, 1. ch1 marche peu (1), ch2 moyennement (3).
    for (const [n, d] of [[1, 5], [2, 3], [3, 1]]) await call('PATCH', `/api/posts/${ids[n]}`, { access_difficulty: d });
    await as(R, 'PATCH', `/api/days/${dayId}/participants/${dp(day, 'ch1').id}`, { walking_ability: 1 });
    await as('ch2', 'PATCH', '/api/me', { walking_ability: 3 }); // profil
    await as(R, 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[1], ids[2], ids[3]] });
    for (let run = 0; run < 10; run++) {
      const drawn = (await as(R, 'POST', `/api/hunts/${id}/draw`, {})).body;
      const at = (u: string) => numbers([drawn.participants.find((p: any) => p.user_id === `dev_${u}`).post_id])[0];
      expect(at('ch1')).toBe(3);
      expect(at('ch2')).toBe(2);
      expect(at('ch3')).toBe(1);
    }
    expect(detail.participants.find((p: any) => p.user_id === 'dev_ch1')).toBeTruthy();
    await as('ch2', 'PATCH', '/api/me', { walking_ability: null });
  });

  it('un traqueur ne reçoit pas de poste ; deux chasseurs au plus par poste', async () => {
    const { id, detail } = await runningHunt(3);
    await as(R, 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[4], ids[5]] });
    const [a, b, c] = detail.participants;
    for (const p of [a, b]) await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: p.id, post_id: ids[4] });
    expect((await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: c.id, post_id: ids[4] })).body.code).toBe('POST_FULL');
    const after = await as(R, 'PATCH', `/api/hunts/${id}/participants/${a.id}`, { role: 'traqueur' });
    expect(after.body.participants.find((p: any) => p.id === a.id).post_id).toBeNull();
    expect((await as(R, 'POST', `/api/hunts/${id}/actions/debut`)).body.code).toBe('ASSIGNMENTS_NOT_PUBLISHED');
  });
});

describe('invités, vue chasseur, regroupement', () => {
  it('invité du jour : lien personnel, son poste et ses voisins ; le lien expire à la fin de la journée', async () => {
    const { dayId } = await runningDay(as, R, ['ch1', 'ch2']);
    const g = await as(R, 'POST', `/api/days/${dayId}/guests`, { name: 'Jean (invité)', has_car: false });
    expect(g.status).toBe(201);
    const url: string = g.body.guest_link.url;
    expect(url).toMatch(/^http:\/\/app\.test\/#\/journee-invite\//);
    const token = url.split('/').pop();
    const { id, detail } = await (async () => { const b = await newBattue(as, R, dayId, territoryId); return { id: b.huntId, detail: b.detail }; })();
    await as(R, 'PUT', `/api/hunts/${id}/posts`, { post_ids: [ids[4], ids[5], ids[6]] });
    const by = (n: string) => detail.participants.find((p: any) => p.name === n || p.user_id === `dev_${n}`);
    await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('ch1').id, post_id: ids[4] });
    await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('Jean (invité)').id, post_id: ids[5] });
    await as(R, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: by('ch2').id, post_id: ids[6] });
    // Avant publication : pas de poste visible.
    expect((await as('ch1', 'GET', `/api/days/${dayId}/view`)).body.view.current.post).toBeNull();
    await as(R, 'POST', `/api/hunts/${id}/publish-assignments`);

    const res = await app.request(`/api/guest/${token}`, {}, env);
    expect(res.status).toBe(200);
    const view = ((await res.json()) as any).view;
    expect(view.me).toMatchObject({ name: 'Jean (invité)', guest: true, present: true });
    expect(view.current.post).toMatchObject({ number: 5 });
    expect(view.current.neighbors.map((n: any) => [n.number, n.side])).toEqual([[4, 'gauche'], [6, 'droite']]);
    expect(view.day).toMatchObject({ meeting_place: 'Cabane de chasse', meeting_time: '07:45' });

    const mine = (await as('ch1', 'GET', `/api/days/${dayId}/view`)).body;
    expect(mine.view.current.post.number).toBe(4);
    expect(mine.carpool.cars.length).toBeGreaterThanOrEqual(0);

    // Fin de battue puis regroupement annoncé.
    await as(R, 'POST', `/api/hunts/${id}/actions/debut`);
    await as(R, 'POST', `/api/hunts/${id}/actions/fin`);
    const rg = await as(R, 'POST', `/api/days/${dayId}/regroup`, { place: 'Cabane du Lampy', point: point(5.0, LAT), time: '11:30' });
    expect(rg.status).toBe(200);
    expect(rg.body.notified).toBe(2);
    const after = (await as('ch2', 'GET', `/api/days/${dayId}/view`)).body.view;
    expect(after.day.regroup).toMatchObject({ place: 'Cabane du Lampy', time: '11:30' });
    expect(after.current.hunt.status).toBe('terminee');
    // Toujours valable entre deux battues ; expiré à la fin de la journée.
    expect((await app.request(`/api/guest/${token}`, {}, env)).status).toBe(200);
    await as(R, 'POST', `/api/days/${dayId}/actions/terminer`);
    expect((await app.request(`/api/guest/${token}`, {}, env)).status).toBe(410);
  });

  it('un lien invité régénéré remplace l’ancien', async () => {
    const { dayId } = await runningDay(as, R, ['ch1']);
    const g = (await as(R, 'POST', `/api/days/${dayId}/guests`, { name: 'Paul' })).body.guest_link;
    const second = (await as(R, 'POST', `/api/days/${dayId}/participants/${g.participant_id}/guest-link`)).body.url.split('/').pop();
    expect((await app.request(`/api/guest/${g.url.split('/').pop()}`, {}, env)).status).toBe(410);
    expect((await app.request(`/api/guest/${second}`, {}, env)).status).toBe(200);
  });
});
