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

/** Pages WFS renvoyées par le faux service BD TOPO (modifiable par les tests). */
export const bdtopo = {
  pages: [JSON.stringify({ type: 'FeatureCollection', numberMatched: 0, features: [] })],
  fail: false,
  calls: 0,
};
/** Faux service push : enregistre les envois ; statut de réponse réglable. */
export const pushService = {
  calls: [] as { url: string; init: RequestInit }[],
  status: 201,
};
export const app = createApp(() => ({ pool }), {
  skipMigrations: true, // la base de test est migrée par global-setup
  pushFetch: async (url, init) => {
    pushService.calls.push({ url, init: init ?? {} });
    return new Response(null, { status: pushService.status });
  },
  fetchBuildingPages: async () => {
    bdtopo.calls += 1;
    if (bdtopo.fail) {
      const { AppError } = await import('../src/errors');
      throw new AppError(502, 'BDTOPO_UNAVAILABLE', 'Le service des bâtiments de l’IGN ne répond pas.');
    }
    return bdtopo.pages;
  },
});

/** Bâtiment carré de `side` mètres centré sur (lon, lat), au format d'une page WFS. */
export function building(cleabs: string, lon: number, lat: number, props: Record<string, unknown> = {}, side = 10) {
  const dLat = side / 2 / 111_195;
  const dLon = side / 2 / (111_195 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Feature',
    id: `batiment.${cleabs}`,
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[[lon - dLon, lat - dLat, 100], [lon + dLon, lat - dLat, 100], [lon + dLon, lat + dLat, 100], [lon - dLon, lat + dLat, 100], [lon - dLon, lat - dLat, 100]]]],
    },
    properties: { cleabs, nature: 'Indifférenciée', usage_1: 'Résidentiel', usage_2: null, etat_de_l_objet: 'En service', nombre_de_logements: 1, ...props },
  };
}

export function wfsPage(features: unknown[]) {
  return JSON.stringify({ type: 'FeatureCollection', numberMatched: features.length, features });
}

/** Décale un point de `meters` vers l'est. */
export const east = (lon: number, lat: number, meters: number) => lon + meters / (111_195 * Math.cos((lat * Math.PI) / 180));

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
