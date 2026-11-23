// Lot 0 — critère : « Un utilisateur du tenant A ne lit ni n'écrit aucune
// ligne du tenant B, sur chaque table. »
// La liste des tables est lue dans le catalogue : toute nouvelle table portant
// tenant_id est testée automatiquement, et le test échoue si elle n'a pas de
// données de test (pour ne pas réussir à vide).
import { beforeAll, describe, expect, it } from 'vitest';
import { api, asApp, asOwner, createTenant, point, square } from './helpers';

let tenantA: string;
let tenantB: string;
let tenantTables: string[];

async function seedCartography(user: string, tenant: string, lon: number) {
  const t = await api(user, 'POST', '/api/territories', { tenant, body: { name: 'Bois', geom: square(lon, 43, 0.02) } });
  expect(t.status).toBe(201);
  const id = t.body.territory.id;
  const r = await api(user, 'POST', `/api/territories/${id}/reserves`, { tenant, body: { name: 'Réserve', geom: square(lon + 0.01, 43.01, 0.002) } });
  expect(r.status).toBe(201);
  const p = await api(user, 'POST', `/api/territories/${id}/parkings`, { tenant, body: { name: 'Route', geom: point(lon - 0.015, 43) } });
  expect(p.status).toBe(201);
  const post = await api(user, 'POST', `/api/territories/${id}/posts`, {
    tenant,
    body: { geom: point(lon - 0.01, 43), parking_id: p.body.item.id, access_path: { type: 'LineString', coordinates: [[lon - 0.015, 43], [lon - 0.01, 43]] } },
  });
  expect(post.status).toBe(201);
  const line = await api(user, 'POST', `/api/territories/${id}/lines`, { tenant, body: { name: 'Ligne' } });
  expect(line.status).toBe(201);
  const plan = await api(user, 'PUT', `/api/territories/${id}/coverage-plans/1`, { tenant, body: { post_ids: [post.body.item.id] } });
  expect(plan.status).toBe(200);
  // Journée en cours et battue avec le président posté sur le poste (lot 4).
  const day = await api(user, 'POST', '/api/days', { tenant, body: { date: '2026-12-01', participant_user_ids: [`dev_${user}`] } });
  expect(day.status).toBe(201);
  const dayId = day.body.day.id;
  await api(user, 'POST', `/api/days/${dayId}/actions/convoquer`, { tenant });
  await api(user, 'POST', `/api/days/${dayId}/respond`, { tenant, body: { response: 'present' } });
  await api(user, 'POST', `/api/days/${dayId}/actions/demarrer`, { tenant });
  const battue = await api(user, 'POST', `/api/days/${dayId}/battues`, { tenant, body: { territory_id: id } });
  expect(battue.status).toBe(201);
  const huntId = battue.body.hunt_id;
  const me = (await api(user, 'GET', `/api/hunts/${huntId}`, { tenant })).body.participants[0];
  await api(user, 'PUT', `/api/hunts/${huntId}/posts`, { tenant, body: { post_ids: [post.body.item.id] } });
  const assigned = await api(user, 'PUT', `/api/hunts/${huntId}/assignments`, { tenant, body: { participant_id: me.id, post_id: post.body.item.id } });
  expect(assigned.status).toBe(200);
  await api(user, 'PUT', `/api/hunts/${huntId}/species`, { tenant, body: { species: [{ species: 'Sanglier', quota: 3 }] } });
  const harvest = await api(user, 'POST', `/api/hunts/${huntId}/harvests`, { tenant, body: { species: 'Sanglier', category: 'male' } });
  expect(harvest.status).toBe(201);
  expect((await api(user, 'PUT', `/api/days/${dayId}/position-sharing`, { tenant, body: { share: true } })).status).toBe(200);
  expect((await api(user, 'POST', `/api/hunts/${huntId}/position`, { tenant, body: { lon: lon - 0.01, lat: 43, accuracy: 8 } })).status).toBe(204);
  expect((await api(user, 'POST', '/api/places', { tenant, body: { name: 'Cabane', kind: 'cabane', geom: point(lon, 43.01) } })).status).toBe(201);
  const inv = await api(user, 'POST', '/api/invitations', { tenant, body: {} });
  expect(inv.status).toBe(201);
  const dwelling = await api(user, 'POST', `/api/territories/${id}/dwellings`, { tenant, body: { geom: point(lon + 0.015, 43.015), comment: 'Cabane' } });
  expect(dwelling.status).toBe(201);
}

beforeAll(async () => {
  tenantA = await createTenant('alice');
  tenantB = await createTenant('bob');
  await seedCartography('alice', tenantA, 2.0);
  await seedCartography('bob', tenantB, 3.0);

  tenantTables = (
    await asOwner<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
        ORDER BY 1`,
    )
  ).map((r) => r.table_name);
});

describe('isolation entre tenants (RLS)', () => {
  it('toutes les tables accessibles au rôle applicatif ont la RLS activée', async () => {
    const rows = await asOwner<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (has_table_privilege('app_rls', c.oid, 'SELECT')
               OR has_table_privilege('app_rls', c.oid, 'INSERT')
               OR has_table_privilege('app_rls', c.oid, 'UPDATE')
               OR has_table_privilege('app_rls', c.oid, 'DELETE'))
          AND c.relname <> 'spatial_ref_sys'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it('couvre bien les tables métier attendues', () => {
    for (const t of ['memberships', 'invitations', 'audit_log', 'territories', 'reserve_zones', 'posts', 'dwellings', 'exclusion_zones', 'coverage_plans', 'coverage_plan_posts', 'hunts', 'hunt_participants', 'hunt_posts', 'hunt_assignments', 'hunt_species', 'hunt_harvests', 'hunt_positions', 'hunt_days', 'day_participants', 'places']) {
      expect(tenantTables).toContain(t);
    }
  });

  it('A voit ses propres lignes sur chaque table (le test ne réussit pas à vide)', async () => {
    for (const table of tenantTables) {
      const [row] = await asApp('alice', tenantA, (tx) =>
        tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantA]),
      );
      expect(row.n, `${table} : aucune donnée de test pour A`).toBeGreaterThan(0);
    }
  });

  it('A ne lit aucune ligne de B, sur chaque table', async () => {
    for (const table of tenantTables) {
      const [row] = await asApp('alice', tenantA, (tx) =>
        tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantB]),
      );
      expect(row.n, `${table} : fuite de lecture`).toBe(0);
    }
    const tenants = await asApp('alice', tenantA, (tx) => tx.query('SELECT id FROM tenants WHERE id = $1', [tenantB]));
    expect(tenants).toEqual([]);
    const users = await asApp('alice', tenantA, (tx) => tx.query(`SELECT id FROM users WHERE id = 'dev_bob'`));
    expect(users).toEqual([]);
  });

  it('A ne modifie ni ne supprime aucune ligne de B, sur chaque table', async () => {
    for (const table of tenantTables) {
      for (const sql of [
        `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
        `DELETE FROM ${table} WHERE tenant_id = $1`,
      ]) {
        try {
          const n = await asApp('alice', tenantA, (tx) => tx.execute(sql, [tenantB]));
          expect(n, `${table} : ${sql.split(' ')[0]} a touché des lignes de B`).toBe(0);
        } catch (err: any) {
          expect(err.code, `${table} : erreur inattendue ${err.message}`).toBe('42501'); // privilège refusé
        }
      }
    }
    const tenantsUpdated = await asApp('alice', tenantA, (tx) =>
      tx.execute(`UPDATE tenants SET name = 'piraté' WHERE id = $1`, [tenantB]),
    );
    expect(tenantsUpdated).toBe(0);
  });

  it('A ne peut insérer aucune ligne dans B, sur chaque table', async () => {
    for (const table of tenantTables) {
      // Copie d'une ligne de A, réattribuée à B.
      const [sample] = await asOwner(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE tenant_id = $1 LIMIT 1`, [tenantA]);
      const row = { ...sample.j, tenant_id: tenantB };
      const identity = await asOwner(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_identity = 'YES'`,
        [table],
      );
      for (const { column_name } of identity) delete row[column_name];
      if ('id' in row && typeof row.id === 'string') row.id = crypto.randomUUID();
      if ('token_hash' in row) row.token_hash = `x${Date.now()}`;
      if ('number' in row) row.number = 900;
      // Le parking (lieu de A) serait refusé par le contrôle du poste avant la RLS.
      if (table === 'posts') Object.assign(row, { parking_id: null, access_path: null });
      const cols = Object.keys(row);
      await expect(
        asApp('alice', tenantA, (tx) =>
          tx.query(
            `INSERT INTO ${table} (${cols.join(', ')})
             SELECT ${cols.join(', ')} FROM jsonb_populate_record(NULL::${table}, $1)`,
            [JSON.stringify(row)],
          ),
        ),
        `${table} : insertion dans B acceptée`,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('un tenant_id forgé (sans appartenance) ne donne accès à rien', async () => {
    for (const table of tenantTables) {
      const [row] = await asApp('alice', tenantB, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantB]),
      );
      expect(row.n, `${table} visible avec un tenant forgé`).toBe(0);
    }
    const res = await api('alice', 'GET', '/api/territories', { tenant: tenantB });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_MEMBER');
  });
});
