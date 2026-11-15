import { z } from 'zod';
import { AppError } from './errors';
import type { Tx } from './db';

// Validation structurelle des géométries GeoJSON reçues (WGS84, lon/lat).
// La validité topologique (auto-intersection…) est vérifiée par PostGIS.

const MAX_POLYGON_VERTICES = 10_000;
const MAX_LINE_VERTICES = 5_000;

const position = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .rest(z.number()) // altitude éventuelle (GPX), ignorée
  .transform((p) => [p[0], p[1]] as [number, number]);

const ring = z
  .array(position)
  .min(4, 'Un polygone doit avoir au moins 3 sommets.')
  .refine((r) => r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1], 'L’anneau doit être fermé.');

export const pointSchema = z.object({ type: z.literal('Point'), coordinates: position });

export const lineSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(position).min(2).max(MAX_LINE_VERTICES, 'Chemin trop détaillé.'),
});

export const polygonSchema = z
  .object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(100) })
  .refine((g) => g.coordinates.reduce((n, r) => n + r.length, 0) <= MAX_POLYGON_VERTICES, 'Polygone trop détaillé.');

/** Fragment SQL : GeoJSON → geometry 4326 (paramètre $n). */
export const geomParam = (n: number) => `ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)`;

/** Fragment SQL : geometry → GeoJSON (7 décimales ≈ 1 cm). */
export const geomOut = (col: string, alias = col) => `ST_AsGeoJSON(${col}, 7)::json AS ${alias}`;

/**
 * Refuse les polygones invalides (auto-intersection, anneau dégénéré…)
 * avec la raison donnée par PostGIS, avant toute écriture.
 */
export async function assertValidGeometry(tx: Tx, geojson: unknown, label: string): Promise<void> {
  const row = await tx.one<{ valid: boolean; reason: string }>(
    `SELECT ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM (SELECT ${geomParam(1)} AS g) s`,
    [JSON.stringify(geojson)],
  );
  if (!row.valid) {
    const selfIntersection = /self-intersection|ring self/i.test(row.reason);
    throw new AppError(
      422,
      'GEOMETRY_INVALID',
      selfIntersection
        ? `${label} : le tracé se recoupe lui-même. Corrigez les sommets qui se croisent.`
        : `${label} : géométrie invalide.`,
      { reason: row.reason },
    );
  }
}
