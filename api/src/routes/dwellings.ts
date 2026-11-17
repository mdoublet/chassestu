import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { assertValidGeometry, geomOut, geomParam, pointSchema, polygonSchema } from '../geo';

export const dwellingRoutes = new Hono<AppEnv>();

export const DWELLING_SELECT = `id, territory_id, source, source_id, ${geomOut('geom')}, usage,
  likely_non_residential, comment, ignored, ignored_reason, ignored_at, missing_since`;

export interface ImportReport {
  total: number;
  added: number;
  missing: number;
  refreshed_at: string;
}

/**
 * Importe (ou réimporte) les bâtiments BD TOPO autour d'un territoire.
 * Les choix « ignoré » sont conservés par identifiant BD TOPO ; les bâtiments
 * disparus de la BD TOPO sont signalés (missing_since), pas supprimés.
 * Deux transactions : l'appel à l'IGN (plusieurs secondes) se fait hors transaction.
 */
export async function importDwellings(c: Context<AppEnv>, territoryId: string): Promise<ImportReport> {
  const box = await tenantTx(c, ['president'], async (tx) => {
    const row = notFoundIfNull(
      await tx.maybeOne<{ minlon: number; minlat: number; maxlon: number; maxlat: number; radius: number }>(
        // Rayon d'import (app.import_radius_m) : marge des postes hors territoire
        // + distance + bande d'avertissement, 300 m au moins.
        `SELECT ST_XMin(e) AS minlon, ST_YMin(e) AS minlat, ST_XMax(e) AS maxlon, ST_YMax(e) AS maxlat, r AS radius
           FROM (SELECT ST_Envelope(ST_Buffer(t.geom::geography, r)::geometry) AS e, r
                   FROM territories t,
                        LATERAL (SELECT app.import_radius_m(t.tenant_id) AS r) x
                  WHERE t.id = $1) s`,
        [territoryId],
      ),
      'Territoire',
    );
    return row;
  });

  const pages = await c.get('fetchBuildingPages')({
    minLon: box.minlon,
    minLat: box.minlat,
    maxLon: box.maxlon,
    maxLat: box.maxlat,
  });

  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    const report = await tx.one<{ total: number; added: number }>(
      `WITH src AS (
         SELECT DISTINCT ON (f->'properties'->>'cleabs')
                f->'properties'->>'cleabs' AS source_id,
                ST_Multi(ST_CollectionExtract(ST_MakeValid(
                  ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326))), 3)) AS geom,
                f->'properties' AS p
           FROM jsonb_array_elements($2::jsonb) page,
                jsonb_array_elements(page->'features') f
          WHERE jsonb_typeof(f->'geometry') = 'object' AND f->'properties'->>'cleabs' IS NOT NULL
       ),
       kept AS (
         SELECT src.* FROM src, territories t
          WHERE t.id = $1 AND NOT ST_IsEmpty(src.geom)
            AND ST_DWithin(src.geom::geography, t.geom::geography, $3)
       ),
       up AS (
         INSERT INTO dwellings (territory_id, source, source_id, geom, usage, likely_non_residential)
         SELECT $1, 'bdtopo', source_id, geom,
                left(concat_ws(' · ',
                  nullif(concat_ws(' / ', nullif(p->>'usage_1', ''), nullif(p->>'usage_2', '')), ''),
                  CASE WHEN coalesce(p->>'etat_de_l_objet', 'En service') <> 'En service' THEN p->>'etat_de_l_objet' END), 200),
                -- coalesce partout : un attribut absent (NULL) ne doit pas rendre le résultat NULL.
                NOT (coalesce(p->>'usage_1', 'Indifférencié') IN ('Résidentiel', 'Indifférencié')
                     OR coalesce(p->>'usage_2', '') = 'Résidentiel'
                     OR coalesce((p->>'nombre_de_logements')::int, 0) > 0)
                  OR coalesce(p->>'etat_de_l_objet', '') IN ('Ruine', 'En projet')
           FROM kept
         ON CONFLICT (territory_id, source_id) DO UPDATE
            SET geom = EXCLUDED.geom, usage = EXCLUDED.usage,
                likely_non_residential = EXCLUDED.likely_non_residential, missing_since = NULL
         RETURNING (xmax = 0) AS inserted, source_id
       )
       SELECT count(*)::int AS total, count(*) FILTER (WHERE inserted)::int AS added FROM up`,
      [territoryId, `[${pages.join(',')}]`, box.radius],
    );
    const missing = await tx.execute(
      `UPDATE dwellings d SET missing_since = now()
        WHERE d.territory_id = $1 AND d.source = 'bdtopo' AND d.missing_since IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements($2::jsonb) page, jsonb_array_elements(page->'features') f
             WHERE f->'properties'->>'cleabs' = d.source_id)`,
      [territoryId, `[${pages.join(',')}]`],
    );
    await tx.query('SELECT app.mark_dwellings_imported($1, $2)', [territoryId, box.radius]);
    const result = { total: report.total, added: report.added, missing, refreshed_at: new Date().toISOString() };
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
       VALUES ($1, app.current_user_id(), 'import', 'dwellings', $2, $3)`,
      [tenantId, territoryId, JSON.stringify(result)],
    );
    return result;
  });
}

dwellingRoutes.post('/territories/:id/dwellings/refresh', async (c) => {
  const id = parseId(c.req.param('id'));
  const report = await importDwellings(c, id);
  return c.json({ report });
});

const manualSchema = z
  .object({
    geom: z.union([pointSchema, polygonSchema]),
    comment: z.string().trim().max(1000).default(''),
  })
  .strict();

/** Habitation manquante (construction récente, caravane habitée…). */
dwellingRoutes.post('/territories/:id/dwellings', async (c) => {
  const territoryId = parseId(c.req.param('id'));
  const body = manualSchema.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    if (body.geom.type === 'Polygon') await assertValidGeometry(tx, body.geom, 'Habitation');
    const item = await tx.one(
      `INSERT INTO dwellings (territory_id, source, geom, comment, usage)
       VALUES ($1, 'manuel', ${geomParam(2)}, $3, 'Ajout manuel') RETURNING ${DWELLING_SELECT}`,
      [territoryId, JSON.stringify(body.geom), body.comment],
    );
    return c.json({ item }, 201);
  });
});

const patchSchema = z
  .object({
    ignored: z.boolean(),
    ignored_reason: z.string().trim().max(500).nullable(),
    comment: z.string().trim().max(1000),
  })
  .partial()
  .strict()
  .refine((b) => !b.ignored || (b.ignored_reason?.length ?? 0) >= 3, {
    message: 'Indiquez pourquoi ce bâtiment n’est pas une habitation (ex. hangar sans logement, ruine).',
  });

dwellingRoutes.patch('/dwellings/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = patchSchema.parse(await c.req.json());
  const entries = Object.entries(body);
  if (entries.length === 0) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
  return tenantTx(c, ['president'], async (tx) => {
    // Colonnes issues du schéma .strict() ci-dessus, jamais du client.
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const item = notFoundIfNull(
      await tx.maybeOne(`UPDATE dwellings SET ${sets} WHERE id = $1 RETURNING ${DWELLING_SELECT}`, [id, ...entries.map(([, v]) => v)]),
      'Bâtiment',
    );
    return c.json({ item });
  });
});

/** Seules les habitations ajoutées à la main se suppriment ; un bâtiment BD TOPO s'ignore. */
dwellingRoutes.delete('/dwellings/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const row = notFoundIfNull(await tx.maybeOne<{ source: string }>('SELECT source FROM dwellings WHERE id = $1', [id]), 'Bâtiment');
    if (row.source !== 'manuel') {
      throw new AppError(409, 'DWELLING_FROM_BDTOPO', 'Un bâtiment de la BD TOPO ne se supprime pas : marquez-le « ignoré » avec une raison.');
    }
    const item = await tx.one(`DELETE FROM dwellings WHERE id = $1 RETURNING ${DWELLING_SELECT}`, [id]);
    return c.json({ item });
  });
});
