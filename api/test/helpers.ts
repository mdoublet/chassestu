import pg from 'pg';
import { createApp } from '../src/app';
import { withTx, type Tx } from '../src/db';
import type { Env } from '../src/env';
import { TEST_DATABASE_URL } from './global-setup';

// Connexion avec le rôle propriétaire (comme neondb_owner sur Neon, qui a
// BYPASSRLS) : les tests prouvent donc que `SET LOCAL ROLE app_rls` suffit.
export const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

export const env: Env = {
  DATABASE_URL: TEST_DATABASE_URL,
  ENVIRONMENT: 'test',
  AUTH_MODE: 'dev',
  APP_ORIGIN: 'http://app.test',
};

export const app = createApp(() => ({ pool }));

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

/** Appelle l'API en tant que `user` (jeton dev), dans le tenant `tenant`. */
export async function api<T = any>(
  user: string,
  method: string,
  path: string,
  options: { body?: unknown; tenant?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer dev:${user}:${user}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.tenant) headers['X-Tenant-Id'] = options.tenant;
  const res = await app.request(
    path,
    { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined },
    env,
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Requête directe en tant que propriétaire (hors RLS), pour préparer les données. */
export async function asOwner<T = any>(text: string, params?: unknown[]): Promise<T[]> {
  return (await pool.query(text, params)).rows;
}

/** Transaction applicative (rôle app_rls) avec le contexte donné. */
export function asApp<T>(userId: string, tenantId: string | null, fn: (tx: Tx) => Promise<T>) {
  return withTx(pool, { userId: `dev_${userId}`, tenantId }, fn);
}

let seq = 0;
export function uniq(prefix: string) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

/** Crée un tenant via le super-admin et en fait accepter la présidence par `president`. */
export async function createTenant(president: string, name = uniq('Assoc ')): Promise<string> {
  await asOwner(
    `INSERT INTO users (id, display_name, is_super_admin) VALUES ('dev_superadmin', 'Admin', true)
     ON CONFLICT (id) DO NOTHING`,
  );
  await api('superadmin', 'GET', '/api/me');
  const created = await api('superadmin', 'POST', '/api/admin/tenants', { body: { name, kind: 'acca', departement: '11' } });
  if (created.status !== 201) throw new Error(`création tenant : ${JSON.stringify(created.body)}`);
  const token = created.body.president_invitation_url.split('/').pop();
  await api(president, 'GET', '/api/me');
  const accepted = await api(president, 'POST', `/api/invitation-links/${token}/accept`);
  if (accepted.status !== 200) throw new Error(`acceptation : ${JSON.stringify(accepted.body)}`);
  return created.body.id;
}

/** Carré autour de (lon, lat), côté ≈ 2·d degrés. */
export function square(lon: number, lat: number, d = 0.01) {
  return {
    type: 'Polygon',
    coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
  };
}

export const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] });
