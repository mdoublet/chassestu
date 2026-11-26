// Battues préparées d'avance : la suivante se prépare pendant la battue en
// cours (plan, volontaires, postes, placement), invisible des chasseurs ;
// publier ses postes l'ouvre, une fois la précédente terminée.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, east, point, runningDay, square } from './helpers';

const P = 'pres_prep';
let tenant: string;
const as = (u: string, m: string, path: string, body?: unknown) => api(u, m, path, { tenant, body });
const call = (m: string, path: string, body?: unknown) => as(P, m, path, body);
const HUNTERS = ['prep1', 'prep2'];
const LAT = 44.9;
const LON = 3.7;
let territoryId: string;
let postIds: string[] = [];

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des préparatifs');
  territoryId = (await call('POST', '/api/territories', { name: 'Bois préparé', geom: square(LON, LAT, 0.01) })).body.territory.id;
  for (let n = 1; n <= 3; n++) {
    postIds.push((await call('POST', `/api/territories/${territoryId}/posts`, { number: n, geom: point(east(LON - 0.006, LAT, n * 200), LAT) })).body.item.id);
  }
  const inv = await call('POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

describe('battues préparées d’avance', () => {
  it('préparer pendant la battue en cours, publier après la fin', async () => {
    const { dayId } = await runningDay(as, P, HUNTERS);
    const first = (await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId })).body.hunt_id;
    // Sans « prepare », une seconde battue reste refusée pendant la première.
    expect((await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId })).status).toBe(409);
    // Un chef de ligne dans la battue n° 1…
    const p1 = (await call('GET', `/api/hunts/${first}`)).body.participants[0];
    expect((await call('PATCH', `/api/hunts/${first}/participants/${p1.id}`, { role: 'chef_de_ligne' })).status).toBe(200);
    const prep = await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId, prepare: true });
    expect(prep.status).toBe(201);
    const second = prep.body.hunt_id;
    // … redevient posté (chasseur) dans la suivante.
    expect((await call('GET', `/api/hunts/${second}`)).body.participants.map((p: any) => p.role)).toEqual(['poste', 'poste']);
    expect(prep.body.battues.find((b: any) => b.id === second)).toMatchObject({ number: 2, status: 'brouillon' });

    // Préparation complète : postes, tirage, espèces.
    expect((await call('PUT', `/api/hunts/${second}/posts`, { post_ids: postIds })).status).toBe(200);
    const drawn = await call('POST', `/api/hunts/${second}/draw`, {});
    expect(drawn.status).toBe(200);
    expect(drawn.body.participants.filter((p: any) => p.post_id).length).toBeGreaterThan(0);
    // Pas de lancement ni de prélèvement sur une battue préparée.
    expect((await call('POST', `/api/hunts/${second}/actions/debut`)).status).toBe(409);

    // Invisible des chasseurs : leur journée montre la battue n° 1.
    const seen = (await as(HUNTERS[0], 'GET', `/api/days/${dayId}/view`)).body;
    const view = seen.view ?? seen;
    expect(view.battues.map((b: any) => b.number)).toEqual([1]);
    expect((await as(HUNTERS[0], 'GET', '/api/days')).body.days.find((d: any) => d.id === dayId).current_battue.number).toBe(1);

    // Publier tant que la n° 1 tourne : refusé.
    expect((await call('POST', `/api/hunts/${second}/publish-assignments`)).status).toBe(409);
    // Fin de la n° 1 (publiée, lancée, terminée), puis publication de la n° 2.
    await call('PUT', `/api/hunts/${first}/posts`, { post_ids: postIds });
    await call('POST', `/api/hunts/${first}/draw`, {});
    await call('POST', `/api/hunts/${first}/publish-assignments`);
    await call('POST', `/api/hunts/${first}/actions/debut`);
    await call('POST', `/api/hunts/${first}/actions/fin`);
    const pub = await call('POST', `/api/hunts/${second}/publish-assignments`);
    expect(pub.status).toBe(200);
    expect(pub.body.hunt).toMatchObject({ status: 'en_cours' });
    expect(pub.body.hunt.assignments_published_at).toBeTruthy();
    const after = (await as(HUNTERS[0], 'GET', `/api/days/${dayId}/view`)).body;
    expect((after.view ?? after).battues.map((b: any) => b.number)).toEqual([1, 2]);
  });

  it('les battues préparées non publiées disparaissent à la fin de la journée', async () => {
    const { dayId } = await runningDay(as, P, HUNTERS, { date: '2026-12-19' });
    await call('POST', `/api/days/${dayId}/battues`, { territory_id: territoryId, prepare: true });
    const end = await call('POST', `/api/days/${dayId}/actions/terminer`);
    expect(end.status).toBe(200);
    expect(end.body.battues).toEqual([]);
  });
});
