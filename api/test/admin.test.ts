// Administration : liste et suppression des associations (super-administrateur).
import { describe, expect, it } from 'vitest';
import { api, asOwner, createTenant, square } from './helpers';
import { deleteClerkUsers } from '../src/clerk-admin';

const admin = (method: string, path: string, body?: unknown) => api('superadmin', method, path, { body });

async function invite(president: string, tenant: string, user: string) {
  const inv = await api(president, 'POST', '/api/invitations', { tenant, body: {} });
  await api(user, 'POST', `/api/invitation-links/${inv.body.invitation.url.split('/').pop()}/accept`);
}

describe('administration des associations', () => {
  it('liste les associations avec président, membres, territoires et battues ; réservé au super-admin', async () => {
    const t = await createTenant('adm_pres1', 'Assoc Liste');
    await api('adm_pres1', 'POST', '/api/territories', { tenant: t, body: { name: 'Bois', geom: square(1.1, 45, 0.01) } });
    const res = await admin('GET', '/api/admin/tenants');
    expect(res.status).toBe(200);
    expect(res.body.tenants.find((x: any) => x.id === t)).toMatchObject({ name: 'Assoc Liste', members: 1, presidents: 'adm_pres1', territories: 1, hunts: 0 });
    expect((await api('adm_pres1', 'GET', '/api/admin/tenants')).status).toBe(403);
    expect((await api('adm_pres1', 'POST', `/api/admin/tenants/${t}/delete`, { body: { delete_users: true, confirm_name: 'Assoc Liste' } })).status).toBe(403);
  });

  it('supprime l’association et ses seuls membres exclusifs ; conserve les membres d’autres associations', async () => {
    const a = await createTenant('adm_presA', 'Assoc A');
    const b = await createTenant('adm_presB', 'Assoc B');
    await invite('adm_presA', a, 'adm_seul');      // seulement dans A → supprimé
    await invite('adm_presA', a, 'adm_partage');   // dans A et B → conservé
    await invite('adm_presB', b, 'adm_partage');
    await api('adm_presA', 'POST', '/api/territories', { tenant: a, body: { name: 'Bois A', geom: square(1.2, 45, 0.01) } });

    // Bilan avant suppression.
    const members = (await admin('GET', `/api/admin/tenants/${a}/members`)).body.members;
    const by = (id: string) => members.find((m: any) => m.user_id === id);
    expect(by('dev_adm_seul')).toMatchObject({ deletable: true, other_tenants: 0 });
    expect(by('dev_adm_partage')).toMatchObject({ deletable: false, kept_reason: "membre d'une autre association" });
    expect(by('dev_adm_presA')).toMatchObject({ deletable: true });

    // Confirmation obligatoire.
    const wrong = await admin('POST', `/api/admin/tenants/${a}/delete`, { delete_users: true, confirm_name: 'Assoc' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('CONFIRMATION_MISMATCH');

    const res = await admin('POST', `/api/admin/tenants/${a}/delete`, { delete_users: true, confirm_name: 'Assoc A' });
    expect(res.status).toBe(200);
    expect(res.body.deleted_users).toBe(2); // adm_seul et le président de A
    expect(res.body.clerk).toMatchObject({ deleted: 0, skipped: 2, failed: [] }); // comptes de développement

    const users = (await asOwner(`SELECT id FROM users WHERE id LIKE 'dev_adm_%' ORDER BY id`)).map((r) => r.id);
    expect(users).toEqual(expect.arrayContaining(['dev_adm_partage', 'dev_adm_presB']));
    expect(users).not.toContain('dev_adm_seul');
    expect(users).not.toContain('dev_adm_presA');
    // Le membre partagé garde son appartenance à B ; plus rien de A.
    expect((await api('adm_partage', 'GET', '/api/me')).body.tenants.map((t: any) => t.name)).toEqual(['Assoc B']);
    expect(await asOwner('SELECT count(*)::int AS n FROM territories WHERE tenant_id = $1', [a])).toEqual([{ n: 0 }]);
    expect(await asOwner('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1', [a])).toEqual([{ n: 0 }]);
  });

  it('sans l’option, les utilisateurs sont conservés (sans association) ; le super-admin n’est jamais supprimé', async () => {
    const t = await createTenant('adm_presC', 'Assoc C');
    await invite('adm_presC', t, 'superadmin'); // le super-admin est aussi membre
    const members = (await admin('GET', `/api/admin/tenants/${t}/members`)).body.members;
    expect(members.find((m: any) => m.user_id === 'dev_superadmin')).toMatchObject({ deletable: false, kept_reason: 'vous-même' });

    const res = await admin('POST', `/api/admin/tenants/${t}/delete`, { delete_users: false, confirm_name: 'Assoc C' });
    expect(res.body.deleted_users).toBe(0);
    expect(await asOwner(`SELECT id FROM users WHERE id = 'dev_adm_presC'`)).toHaveLength(1);
    expect((await admin('GET', '/api/admin/tenants')).body.tenants.some((x: any) => x.id === t)).toBe(false);
  });

  it('comptes Clerk : supprimés (ou déjà absents), échecs signalés, comptes de dev ignorés', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url} ${(init?.headers as any).Authorization}`);
      if (url.endsWith('user_absent')) return new Response('', { status: 404 });
      if (url.endsWith('user_erreur')) return new Response('', { status: 500 });
      return new Response('{}', { status: 200 });
    };
    const res = await deleteClerkUsers(['user_ok', 'user_absent', 'user_erreur', 'dev_x'], 'sk_test_cle', fakeFetch);
    expect(res).toEqual({ deleted: 2, skipped: 1, failed: ['user_erreur'] });
    expect(calls[0]).toBe('DELETE https://api.clerk.com/v1/users/user_ok Bearer sk_test_cle');
    expect(await deleteClerkUsers(['user_ok'], undefined, fakeFetch)).toEqual({ deleted: 0, skipped: 1, failed: [] });
  });
});
