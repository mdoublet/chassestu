// Rotation des postes d'une battue à l'autre (historique des placements).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, east, newBattue, point, runningDay, square } from './helpers';

const P = 'pres_rot';
let tenant: string;
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });
const HUNTERS = ['rot1', 'rot2', 'rot3'];

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA tournante');
  const inv = await as(P, 'POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of HUNTERS) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

describe('rotation des postes', () => {
  it('battue après battue, chacun change de poste (journées successives comprises)', async () => {
    const t = (await as(P, 'POST', '/api/territories', { name: 'Bois tournant', geom: square(3.9, 44.1, 0.01) })).body.territory.id;
    const posts: string[] = [];
    for (let n = 1; n <= 3; n++) posts.push((await as(P, 'POST', `/api/territories/${t}/posts`, { number: n, geom: point(east(3.892, 44.1, n * 150), 44.1) })).body.item.id);
    const placed = (d: any) => Object.fromEntries(d.participants.filter((p: any) => p.post_id).map((p: any) => [p.user_id, p.post_id]));
    const history: Record<string, string[]> = {};

    for (const date of ['2026-12-05', '2026-12-12']) {
      const { dayId } = await runningDay(as, P, HUNTERS, { date });
      for (let b = 0; b < (date === '2026-12-05' ? 2 : 1); b++) {
        const ids = (await as(P, 'GET', `/api/days/${dayId}`)).body.participants.filter((p: any) => p.user_id !== `dev_${P}`).map((p: any) => p.id);
        const { huntId } = await newBattue(as, P, dayId, t, ids);
        await as(P, 'PUT', `/api/hunts/${huntId}/posts`, { post_ids: posts });
        const d = (await as(P, 'POST', `/api/hunts/${huntId}/draw`, {})).body;
        await as(P, 'POST', `/api/hunts/${huntId}/publish-assignments`);
        for (const [u, post] of Object.entries(placed(d))) (history[u] ??= []).push(post as string);
        await as(P, 'POST', `/api/hunts/${huntId}/actions/fin`);
      }
      await as(P, 'POST', `/api/days/${dayId}/actions/terminer`);
    }
    // 3 chasseurs, 3 postes, 3 battues : chacun a occupé les 3 postes.
    for (const u of HUNTERS) expect(new Set(history[`dev_${u}`])).toHaveProperty('size', 3);
  });
});
