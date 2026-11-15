// Applique les migrations SQL de db/migrations dans l'ordre, une seule fois chacune.
// Usage : DATABASE_URL=postgresql://... node db/migrate.mjs [--status]
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
/** Applique les migrations en attente avec un client `pg` connecté. */
export async function migrate(client, { statusOnly = false, log = console.log } = {}) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`${file} a été modifiée après application : créez une nouvelle migration.`);
      }
      log(`= ${file}`);
      continue;
    }
    if (statusOnly) {
      log(`… ${file} (en attente)`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      log(`+ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${file} : ${err.message}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL manquant (voir .env.example).');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, { statusOnly: process.argv.includes('--status') });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
