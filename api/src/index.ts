// Point d'entrée Cloudflare Worker.
import { Pool } from '@neondatabase/serverless';
import { createApp } from './app';
import type { Env } from './env';
import { ensureMigrated } from './migrate';

// Un pool par requête : dans Workers, une connexion WebSocket ne peut pas
// survivre d'une requête à l'autre.
const app = createApp((env) => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return { pool, dispose: () => pool.end() };
});

export default {
  fetch: app.fetch,
  /** Tâche planifiée (wrangler.toml, [triggers]) : purge des positions GPS. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    ctx.waitUntil(
      (async () => {
        try {
          await ensureMigrated(pool);
          const { rows } = await pool.query('SELECT app.purge_positions() AS n');
          if (rows[0].n) console.log(`Positions purgées : ${rows[0].n}`);
        } finally {
          await pool.end();
        }
      })(),
    );
  },
};
