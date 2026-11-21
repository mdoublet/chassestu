// Catégorie habituelle des membres (chasseur, traqueur, autre).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, createTenant, newBattue, runningDay, square } from './helpers';

const P = 'pres_cat';
let tenant: string;
const as = (user: string, method: string, path: string, body?: unknown) => api(user, method, path, { tenant, body });

beforeAll(async () => {
  tenant = await createTenant(P, 'ACCA des catégories');
  const inv = await as(P, 'POST', '/api/invitations', {});
  const token = inv.body.invitation.url.split('/').pop();
  for (const u of ['cat_a', 'cat_t']) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
});

describe('catégorie habituelle', () => {
  it('chasseur par défaut ; traqueur habituel = traqueur dans une nouvelle battue', async () => {
    expect((await as(P, 'GET', '/api/members')).body.members.every((m: any) => m.usual_role === 'chasseur')).toBe(true);
    expect((await as(P, 'PATCH', '/api/members/dev_cat_t/mobility', { usual_role: 'traqueur' })).status).toBe(200);
    expect((await as(P, 'PATCH', '/api/members/dev_cat_t/mobility', { usual_role: 'pilote' })).status).toBe(400);
    expect((await as('cat_a', 'PATCH', '/api/members/dev_cat_t/mobility', { usual_role: 'autre' })).status).toBe(403);
    expect((await as(P, 'GET', '/api/members')).body.members.find((m: any) => m.id === 'dev_cat_t').usual_role).toBe('traqueur');

    const t = (await as(P, 'POST', '/api/territories', { name: 'Bois', geom: square(4.6, 44.6, 0.005) })).body.territory.id;
    const { dayId } = await runningDay(as, P, ['cat_a', 'cat_t']);
    const { detail } = await newBattue(as, P, dayId, t);
    const role = (u: string) => detail.participants.find((p: any) => p.user_id === `dev_${u}`).role;
    expect(role('cat_t')).toBe('traqueur');
    expect(role('cat_a')).toBe('poste');
  });
});
