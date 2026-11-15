// Serveur de développement Node (hors Workers), branché sur PostgreSQL via
// node-postgres : permet de travailler sur une base locale sans Neon.
// Usage : DATABASE_URL=postgresql://... npm run dev:node -w api
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app';
import type { Env } from './env';

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
};

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => app.fetch(req, env), port }, () => console.log(`API sur http://localhost:${port}`));
