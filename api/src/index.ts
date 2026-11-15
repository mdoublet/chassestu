// Point d'entrée Cloudflare Worker.
import { Pool } from '@neondatabase/serverless';
import { createApp } from './app';

// Un pool par requête : dans Workers, une connexion WebSocket ne peut pas
// survivre d'une requête à l'autre.
const app = createApp((env) => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return { pool, dispose: () => pool.end() };
});

export default app;
