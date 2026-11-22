// Serveur de développement Node (hors Workers), branché sur PostgreSQL via
// node-postgres : permet de travailler sur une base locale sans Neon.
// Usage : npm run dev:api:node (lit DATABASE_URL dans le .env racine)
import { serve } from '@hono/node-server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from './app';
import type { Env } from './env';

// Charge le .env à la racine du dépôt s'il existe (DATABASE_URL…).
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  /* pas de .env : variables d'environnement du shell */
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant : créez le fichier .env à la racine (voir .env.example).');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(() => ({ pool }));

const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  ENVIRONMENT: process.env.ENVIRONMENT ?? 'development',
  AUTH_MODE: process.env.AUTH_MODE ?? 'dev',
  APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
  CLERK_AUTHORIZED_PARTIES: process.env.CLERK_AUTHORIZED_PARTIES,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_ENDPOINT_URL_S3: process.env.AWS_ENDPOINT_URL_S3,
  AWS_REGION: process.env.AWS_REGION,
  STORAGE_BUCKET: process.env.STORAGE_BUCKET,
};

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => app.fetch(req, env), port }, () => console.log(`API sur http://localhost:${port}`));
