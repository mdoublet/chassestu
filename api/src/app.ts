import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { authenticate } from './auth';
import type { DbPool } from './db';
import type { AppEnv, Env } from './env';
import { AppError, fromPgError } from './errors';
import { meRoutes } from './routes/me';
import { tenantRoutes } from './routes/tenants';
import { invitationRoutes } from './routes/invitations';
import { cartoRoutes } from './routes/carto';
import { dwellingRoutes } from './routes/dwellings';
import { planRoutes } from './routes/plans';
import { seasonRoutes } from './routes/seasons';
import { huntRoutes } from './routes/hunts';
import { dayRoutes } from './routes/days';
import { placeRoutes } from './routes/places';
import { fetchBuildingPages, type Bbox } from './bdtopo';
import { objectStore, type ObjectStore } from './storage';
import { ensureMigrated } from './migrate';
import { flushPushQueue } from './routes/notifications';
import { notificationRoutes } from './routes/notifications';

export interface PoolProvider {
  /** Fournit un pool pour la requête ; `dispose` est appelé à la fin. */
  (env: Env): { pool: DbPool; dispose?: () => Promise<void> };
}

export interface AppOptions {
  fetchBuildingPages?: (bbox: Bbox) => Promise<string[]>;
  /** fetch pour les envois push (tests). */
  pushFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Ne pas appliquer les migrations embarquées (tests qui gèrent leur base). */
  skipMigrations?: boolean;
  /** Stockage d'objets (tests) ; par défaut, d'après les variables AWS_*. */
  objectStore?: ObjectStore | null;
}

export function createApp(getPool: PoolProvider, options: AppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.use('/api/*', async (c, next) => {
    const origin = c.env.APP_ORIGIN;
    return cors({
      origin: origin ? origin.split(',').map((s) => s.trim()) : '*',
      allowHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })(c, next);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    // Lien invité d'une battue : pas de compte, le jeton du lien fait foi.
    if (!c.req.path.startsWith('/api/guest/')) {
      c.set('user', await authenticate(c.req.header('Authorization'), c.env));
    }
    const { pool, dispose } = getPool(c.env);
    c.set('pool', pool);
    c.set('fetchBuildingPages', options.fetchBuildingPages ?? ((bbox) => fetchBuildingPages(bbox)));
    c.set('pushQueue', []);
    c.set('objectStore', options.objectStore !== undefined ? options.objectStore : objectStore(c.env));
    c.set('pushFetch', options.pushFetch ?? ((input, init) => fetch(input, init)));
    try {
      // Schéma à jour avant de servir (migrations embarquées, une fois par instance).
      if (!options.skipMigrations) await ensureMigrated(pool);
      await next();
    } finally {
      // Notifications push en file : envoyées après la réponse (arrière-plan), puis
      // fermeture de la connexion.
      const queue = c.get('pushQueue');
      const work = (queue.length ? flushPushQueue(c, queue).catch((err) => console.error('Envoi push :', err)) : Promise.resolve())
        .then(() => dispose?.());
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        await work; // hors Workers (tests)
      }
    }
  });

  app.route('/api', meRoutes);
  app.route('/api', tenantRoutes);
  app.route('/api', invitationRoutes);
  app.route('/api', cartoRoutes);
  app.route('/api', dwellingRoutes);
  app.route('/api', planRoutes);
  app.route('/api', seasonRoutes);
  app.route('/api', dayRoutes);
  app.route('/api', placeRoutes);
  app.route('/api', huntRoutes);
  app.route('/api', notificationRoutes);

  app.notFound((c) => c.json({ code: 'NOT_FOUND', message: 'Route inconnue.' }, 404));

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ code: 'VALIDATION', message: err.issues[0]?.message ?? 'Données invalides.', details: err.issues }, 400);
    }
    const appErr = err instanceof AppError ? err : fromPgError(err);
    if (appErr) {
      return c.json({ code: appErr.code, message: appErr.message, details: appErr.details }, appErr.status);
    }
    console.error(err);
    return c.json({ code: 'INTERNAL', message: 'Erreur interne.' }, 500);
  });

  return app;
}
