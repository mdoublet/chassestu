// Migrations appliquées par l'API (api/src/migrate.ts).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureMigrated, resetMigrationState } from '../src/migrate';
import { MIGRATIONS } from '../src/migrations.generated';
import { TEST_DATABASE_URL } from './global-setup';

const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
const url = new URL(TEST_DATABASE_URL);
const dbName = `${decodeURIComponent(url.pathname.slice(1))}_migrate`;
const admin = new URL(url);
admin.pathname = '/postgres';
const target = new URL(url);
target.pathname = `/${dbName}`;
let pool: pg.Pool;

beforeAll(async () => {
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${dbName}" TEMPLATE "${process.env.TEST_TEMPLATE_DB ?? 'postgis_template'}"`);
  await c.end();
  pool = new pg.Pool({ connectionString: target.toString(), max: 3 });
});
afterAll(async () => {
  await pool.end();
  resetMigrationState();
});

describe('migrations embarquées', () => {
  it('sont à jour avec db/migrations (npm run db:bundle)', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    for (const m of MIGRATIONS) {
      const sql = readFileSync(path.join(dir, m.name), 'utf8');
      expect(m.sql).toBe(sql);
      expect(m.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
    }
  });

  it('appliquent seulement ce qui manque, une fois, et s’enregistrent', async () => {
    // Base existante au niveau 0004 (comme la production avant le lot 3).
    resetMigrationState();
    await ensureMigrated(pool, MIGRATIONS.slice(0, 4));
    expect((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name)).toHaveLength(4);
    expect((await pool.query(`SELECT to_regclass('public.coverage_plans') AS t`)).rows[0].t).toBeNull();

    resetMigrationState();
    await ensureMigrated(pool);
    const names = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    expect(names).toEqual(MIGRATIONS.map((m) => m.name));
    expect((await pool.query(`SELECT to_regclass('public.coverage_plans') AS t`)).rows[0].t).toBe('coverage_plans');

    // Deuxième passage : rien à faire (pas d'erreur « already exists »).
    resetMigrationState();
    await expect(ensureMigrated(pool)).resolves.toBeUndefined();
  });

  it('une migration en échec est annulée entièrement et retentée à la requête suivante', async () => {
    resetMigrationState();
    const broken = [...MIGRATIONS, { name: '9999_casse.sql', checksum: 'x', sql: 'CREATE TABLE zz_temp (id int); SELECT 1/0;' }];
    await expect(ensureMigrated(pool, broken)).rejects.toMatchObject({ code: 'MIGRATION_FAILED', status: 503 });
    expect((await pool.query(`SELECT to_regclass('public.zz_temp') AS t`)).rows[0].t).toBeNull(); // tout ou rien
    // L'échec n'est pas mémorisé : la version corrigée passe ensuite.
    await expect(ensureMigrated(pool, MIGRATIONS)).resolves.toBeUndefined();
  });

  it('refuse une migration déjà appliquée dont le fichier a changé', async () => {
    resetMigrationState();
    const tampered = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: 'modifiee' } : m));
    await expect(ensureMigrated(pool, tampered)).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM' });
    resetMigrationState();
  });
});
