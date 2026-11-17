// Migrations appliquées par l'API elle-même, à la première requête après un
// déploiement : le code et le schéma qu'il attend arrivent ensemble, sans
// étape manuelle dans la console Neon.
//
// * Une seule instance applique les migrations (verrou consultatif PostgreSQL).
// * Chaque migration s'exécute dans une vraie transaction : tout ou rien.
// * Une migration déjà appliquée dont le fichier a changé bloque le démarrage
//   (comme db/migrate.mjs) : on ne modifie jamais une migration publiée.
// * Le contrôle n'a lieu qu'une fois par instance (quelques ms).
import type { DbPool } from './db';
import { AppError } from './errors';
import { MIGRATIONS, type Migration } from './migrations.generated';

const LOCK_KEY = 727274; // « chasse »

let ready: Promise<void> | null = null;

export function ensureMigrated(pool: DbPool, migrations: Migration[] = MIGRATIONS): Promise<void> {
  if (!ready) {
    ready = migrate(pool, migrations).catch((err) => {
      ready = null; // nouvelle tentative à la requête suivante
      throw err;
    });
  }
  return ready;
}

/** Pour les tests : oublier que les migrations ont été vérifiées. */
export function resetMigrationState() {
  ready = null;
}

async function migrate(pool: DbPool, migrations: Migration[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Chemin rapide : tout est déjà appliqué (cas normal).
    let applied = await readApplied(client);
    if (migrations.every((m) => applied.get(m.name) === m.checksum)) return;

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      applied = await readApplied(client); // une autre instance a peut-être migré entre-temps
      for (const m of migrations) {
        const sum = applied.get(m.name);
        if (sum === m.checksum) continue;
        if (sum !== undefined) {
          throw new AppError(503, 'MIGRATION_CHECKSUM', `La migration ${m.name} a été modifiée après application.`);
        }
        try {
          await client.query('BEGIN');
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
          await client.query('COMMIT');
          console.log(`Migration appliquée : ${m.name}`);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error(`Migration ${m.name} en échec :`, err);
          throw new AppError(503, 'MIGRATION_FAILED', `Mise à jour de la base impossible (${m.name}) : ${(err as Error).message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function readApplied(client: Awaited<ReturnType<DbPool['connect']>>) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  return new Map<string, string>(rows.map((r: { name: string; checksum: string }) => [r.name, r.checksum]));
}
