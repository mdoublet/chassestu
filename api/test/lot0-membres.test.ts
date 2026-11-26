// Lot 0 — invitations, rôles, bascule entre tenants.
import { beforeAll, describe, expect, it } from 'vitest';
import { api, asApp, createTenant, square, uniq } from './helpers';

let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  tenantA = await createTenant('pres_a', 'ACCA de Aval');
  tenantB = await createTenant('pres_b', 'Société de Bmont');
});

async function invite(president: string, tenant: string, body: object = {}) {
  const res = await api(president, 'POST', '/api/invitations', { tenant, body });
  expect(res.status).toBe(201);
  return res.body.invitation.url.split('/').pop() as string;
}

describe('invitations', () => {
  it('un nouvel utilisateur qui ouvre le lien devient Chasseur du tenant', async () => {
    const token = await invite('pres_a', tenantA);
    const user = uniq('chasseur');

    const preview = await api(user, 'GET', `/api/invitation-links/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invitation).toMatchObject({ tenant_name: 'ACCA de Aval', role: 'chasseur', valid: true });

    const accepted = await api(user, 'POST', `/api/invitation-links/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.membership).toEqual({ tenant_id: tenantA, role: 'chasseur' });

    const me = await api(user, 'GET', '/api/me');
    expect(me.body.tenants).toEqual([expect.objectContaining({ id: tenantA, role: 'chasseur' })]);
  });

  it('le même lien sert à plusieurs chasseurs (lien partagé dans un groupe)', async () => {
    const token = await invite('pres_a', tenantA);
    for (const u of [uniq('c'), uniq('c')]) {
      expect((await api(u, 'POST', `/api/invitation-links/${token}/accept`)).status).toBe(200);
    }
  });

  it('un lien à usage unique, révoqué ou inconnu est refusé', async () => {
    const single = await invite('pres_a', tenantA, { max_uses: 1 });
    expect((await api(uniq('c'), 'POST', `/api/invitation-links/${single}/accept`)).status).toBe(200);
    expect((await api(uniq('c'), 'POST', `/api/invitation-links/${single}/accept`)).status).toBe(410);

    const res = await api('pres_a', 'POST', '/api/invitations', { tenant: tenantA, body: {} });
    const revokedToken = res.body.invitation.url.split('/').pop();
    expect((await api('pres_a', 'DELETE', `/api/invitations/${res.body.invitation.id}`, { tenant: tenantA })).status).toBe(204);
    expect((await api(uniq('c'), 'POST', `/api/invitation-links/${revokedToken}/accept`)).status).toBe(410);

    expect((await api(uniq('c'), 'POST', `/api/invitation-links/${'x'.repeat(43)}/accept`)).status).toBe(404);
  });

  it('un chasseur ne peut pas créer d’invitation', async () => {
    const token = await invite('pres_a', tenantA);
    const u = uniq('c');
    await api(u, 'POST', `/api/invitation-links/${token}/accept`);
    const res = await api(u, 'POST', '/api/invitations', { tenant: tenantA, body: {} });
    expect(res.status).toBe(403);
  });

  it('accepter une invitation de rang inférieur ne rétrograde pas', async () => {
    const token = await invite('pres_a', tenantA);
    const res = await api('pres_a', 'POST', `/api/invitation-links/${token}/accept`);
    expect(res.body.membership.role).toBe('president');
  });
});

describe('plusieurs tenants', () => {
  it('un membre de deux tenants bascule de l’un à l’autre', async () => {
    const u = uniq('multi');
    await api(u, 'POST', `/api/invitation-links/${await invite('pres_a', tenantA)}/accept`);
    await api(u, 'POST', `/api/invitation-links/${await invite('pres_b', tenantB, { role: 'responsable' })}/accept`);

    const me = await api(u, 'GET', '/api/me');
    expect(me.body.tenants.map((t: any) => [t.name, t.role])).toEqual([
      ['ACCA de Aval', 'chasseur'],
      ['Société de Bmont', 'responsable'],
    ]);

    await api('pres_a', 'POST', '/api/territories', { tenant: tenantA, body: { name: 'Terr A', geom: square(2, 44) } });
    await api('pres_b', 'POST', '/api/territories', { tenant: tenantB, body: { name: 'Terr B', geom: square(3, 44) } });

    const inA = await api(u, 'GET', '/api/territories', { tenant: tenantA });
    const inB = await api(u, 'GET', '/api/territories', { tenant: tenantB });
    expect(inA.body.territories.map((t: any) => t.name)).toEqual(['Terr A']);
    expect(inB.body.territories.map((t: any) => t.name)).toEqual(['Terr B']);

    expect((await api(u, 'GET', '/api/tenant', { tenant: tenantA })).body.role).toBe('chasseur');
    expect((await api(u, 'GET', '/api/tenant', { tenant: tenantB })).body.role).toBe('responsable');
  });
});

describe('rôles', () => {
  it('seul le président écrit la cartographie (API et RLS)', async () => {
    const u = uniq('resp');
    await api(u, 'POST', `/api/invitation-links/${await invite('pres_a', tenantA, { role: 'responsable' })}/accept`);
    const res = await api(u, 'POST', '/api/territories', { tenant: tenantA, body: { name: 'X', geom: square(2, 45) } });
    expect(res.status).toBe(403);

    // Même en contournant le contrôle de l'API, la RLS refuse.
    await expect(
      asApp(u, tenantA, (tx) =>
        tx.query(`INSERT INTO territories (name, geom) VALUES ('X', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326))`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('le dernier président ne peut ni partir ni être rétrogradé', async () => {
    const leave = await api('pres_b', 'DELETE', '/api/members/dev_pres_b', { tenant: tenantB });
    expect(leave.status).toBe(409);
    const demote = await api('pres_b', 'PATCH', '/api/members/dev_pres_b', { tenant: tenantB, body: { role: 'chasseur' } });
    expect(demote.status).toBe(409);
    const del = await api('pres_b', 'DELETE', '/api/me');
    expect(del.status).toBe(409);
  });

  it('un chasseur peut quitter l’association', async () => {
    const u = uniq('c');
    await api(u, 'POST', `/api/invitation-links/${await invite('pres_a', tenantA)}/accept`);
    expect((await api(u, 'DELETE', `/api/members/dev_${u}`, { tenant: tenantA })).status).toBe(204);
    expect((await api(u, 'GET', '/api/me')).body.tenants).toEqual([]);
  });

  it('le président modifie les paramètres du tenant ; pas les autres', async () => {
    const ok = await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { buffer_distance_m: 200 } });
    expect(ok.status).toBe(200);
    expect(ok.body.tenant.buffer_distance_m).toBe(200);
    const bad = await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { is_super_admin: true } });
    expect(bad.status).toBe(400);
  });

  it('page d’informations : https seulement, visible des membres, effaçable', async () => {
    const url = 'https://exemple.org/chasse';
    expect((await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { info_url: 'http://exemple.org' } })).status).toBe(400);
    expect((await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { info_url: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { info_url: url } })).body.tenant.info_url).toBe(url);
    expect((await api('pres_a', 'GET', '/api/me')).body.tenants.find((t: any) => t.id === tenantA).info_url).toBe(url);
    expect((await api('pres_a', 'PATCH', '/api/tenant', { tenant: tenantA, body: { info_url: '' } })).body.tenant.info_url).toBeNull();
  });

  it('seul un super-admin crée un tenant', async () => {
    const res = await api('pres_a', 'POST', '/api/admin/tenants', { body: { name: 'Pirate' } });
    expect(res.status).toBe(403);
  });
});
