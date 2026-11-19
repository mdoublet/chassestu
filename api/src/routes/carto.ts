import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { assertTerritorySize, assertValidGeometry, geomOut, geomParam, lineSchema, pointSchema, polygonSchema } from '../geo';
import { DWELLING_SELECT, importDwellings, type ImportReport } from './dwellings';

export const cartoRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Définition des objets cartographiques
// ---------------------------------------------------------------------------

type GeomKind = 'Polygon' | 'Point' | 'LineString';

interface FeatureKind {
  table: string;
  label: string;
  /** Colonnes géométriques et leur type. */
  geoms: Record<string, GeomKind>;
  /** Colonnes renvoyées (hors géométries). */
  columns: string[];
  extraSelect?: string;
  create: z.ZodType<Record<string, unknown>>;
  patch: z.ZodType<Record<string, unknown>>;
}

const name = z.string().trim().max(200);

const territoryFields = z.object({
  name: name.min(1, 'Le nom du territoire est obligatoire.'),
  notes: z.string().max(5000),
  geom: polygonSchema,
});

const reserveFields = z.object({
  name: name,
  reason: z.string().max(1000),
  geom: polygonSchema,
});

const parkingFields = z.object({
  name: name.min(1, 'Le nom du parking est obligatoire.'),
  geom: pointSchema,
});

const postFields = z.object({
  number: z.number().int().min(1).max(999),
  name: name,
  geom: pointSchema,
  parking_id: z.uuid().nullable(),
  access_path: lineSchema.nullable(),
  instructions: z.string().max(2000),
  active: z.boolean(),
  // Difficulté d'accès saisie par le président (1 facile … 5 escarpé) ; NULL : estimée.
  access_difficulty: z.number().int().min(1).max(5).nullable(),
});

const KINDS: Record<string, FeatureKind> = {
  reserves: {
    table: 'reserve_zones',
    label: 'Zone de réserve',
    geoms: { geom: 'Polygon' },
    columns: ['id', 'territory_id', 'name', 'reason', 'updated_at'],
    extraSelect: 'round((ST_Area(geom::geography) / 10000)::numeric, 2)::float AS area_ha',
    create: reserveFields.partial({ name: true, reason: true }).strict(),
    patch: reserveFields.partial().strict(),
  },
  parkings: {
    table: 'parkings',
    label: 'Parking',
    geoms: { geom: 'Point' },
    columns: ['id', 'territory_id', 'name', 'updated_at'],
    create: parkingFields.strict(),
    patch: parkingFields.partial().strict(),
  },
  posts: {
    table: 'posts',
    label: 'Poste',
    geoms: { geom: 'Point', access_path: 'LineString' },
    columns: ['id', 'territory_id', 'number', 'name', 'parking_id', 'instructions', 'active', 'invalid_reason', 'access_difficulty', 'updated_at'],
    // nearest_dwelling_m : renseigné si une habitation est à moins de distance + 50 m
    // (bande d'avertissement : tir interdit en direction de l'habitation).
    extraSelect: `round(ST_Length(access_path::geography))::int AS access_path_length_m,
      app.post_difficulty(access_difficulty, access_path) AS difficulty,
      floor(app.nearest_dwelling_m(territory_id, geom,
        (SELECT buffer_distance_m + app.warning_margin_m() FROM tenants WHERE id = posts.tenant_id)))::int AS nearest_dwelling_m,
      coalesce((SELECT array_agg(cp.hunter_count ORDER BY cp.hunter_count)
                  FROM coverage_plan_posts cpp JOIN coverage_plans cp ON cp.id = cpp.plan_id
                 WHERE cpp.post_id = posts.id), '{}') AS plan_counts`,
    create: postFields.partial({ number: true, name: true, parking_id: true, access_path: true, instructions: true, active: true, access_difficulty: true }).strict(),
    patch: postFields.partial().strict(),
  },
};

function selectList(kind: FeatureKind): string {
  return [...kind.columns, ...Object.keys(kind.geoms).map((g) => geomOut(g)), kind.extraSelect]
    .filter(Boolean)
    .join(', ');
}

const TERRITORY_SELECT = `id, name, notes, ${geomOut('geom')},
  round((ST_Area(geom::geography) / 10000)::numeric, 2)::float AS area_ha, created_at, updated_at`;

function getKind(slug: string): FeatureKind {
  const k = KINDS[slug];
  if (!k) throw new AppError(404, 'NOT_FOUND', 'Route inconnue.');
  return k;
}

/** Valide les polygones et lignes (auto-intersection…) via PostGIS. */
async function validateGeoms(tx: Tx, geoms: Record<string, GeomKind>, body: Record<string, unknown>, label: string) {
  for (const [col, type] of Object.entries(geoms)) {
    if (body[col] != null && type !== 'Point') await assertValidGeometry(tx, body[col], label);
  }
}

/** Construit les fragments SQL d'un INSERT/UPDATE à partir d'un corps validé. */
function sqlValues(body: Record<string, unknown>, geoms: Record<string, GeomKind>, offset: number) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [col, value] of Object.entries(body)) {
    if (value === undefined) continue;
    params.push(col in geoms && value !== null ? JSON.stringify(value) : value);
    const n = offset + params.length;
    cols.push(col);
    exprs.push(col in geoms && value !== null ? geomParam(n) : `$${n}`);
  }
  return { cols, exprs, params };
}

// ---------------------------------------------------------------------------
// Territoires
// ---------------------------------------------------------------------------

cartoRoutes.get('/territories', (c) =>
  tenantTx(c, null, async (tx) => {
    const territories = await tx.query(
      `SELECT ${TERRITORY_SELECT},
              (SELECT count(*)::int FROM posts p WHERE p.territory_id = t.id) AS posts_count,
              (SELECT count(*)::int FROM posts p WHERE p.territory_id = t.id AND p.parking_id IS NULL) AS posts_without_parking,
              (SELECT count(*)::int FROM posts p WHERE p.territory_id = t.id AND p.invalid_reason IS NOT NULL) AS invalid_posts,
              (SELECT count(*)::int FROM parkings x WHERE x.territory_id = t.id) AS parkings_count,
              (SELECT count(*)::int FROM reserve_zones x WHERE x.territory_id = t.id) AS reserves_count,
              (SELECT count(*)::int FROM coverage_plans x WHERE x.territory_id = t.id) AS plans_count
         FROM territories t ORDER BY name`,
    );
    return c.json({ territories });
  }),
);

/**
 * Vue d'ensemble de tous les territoires du tenant, en une requête par type
 * d'objet (et non une par territoire) : contours, réserves, postes, zones
 * non chassables. Lecture seule, pour l'affichage simultané.
 * Déclarée avant /territories/:id, qui capturerait « overview ».
 */
cartoRoutes.get('/territories/overview', (c) =>
  tenantTx(c, null, async (tx) => {
    const [territories, reserves, posts, exclusions] = await Promise.all([
      tx.query(`SELECT id, name, ${geomOut('geom')} FROM territories ORDER BY name`),
      tx.query(`SELECT territory_id, name, ${geomOut('geom')} FROM reserve_zones`),
      tx.query(`SELECT id, territory_id, number, name, active, invalid_reason, ${geomOut('geom')} FROM posts ORDER BY number`),
      tx.query(`SELECT territory_id, ${geomOut('geom')} FROM exclusion_zones WHERE geom IS NOT NULL`),
    ]);
    return c.json({ territories, reserves, posts, exclusions });
  }),
);

async function loadTerritory(tx: Tx, id: string) {
  const territory = notFoundIfNull(
    await tx.maybeOne<Record<string, any>>(`SELECT ${TERRITORY_SELECT} FROM territories WHERE id = $1`, [id]),
    'Territoire',
  );
  const [reserves, parkings, posts] = await Promise.all(
    (['reserves', 'parkings', 'posts'] as const).map((slug) =>
      tx.query(
        `SELECT ${selectList(KINDS[slug])} FROM ${KINDS[slug].table} WHERE territory_id = $1
          ORDER BY ${slug === 'posts' ? 'number' : 'name'}`,
        [id],
      ),
    ),
  );
  const dwellings = await tx.query(`SELECT ${DWELLING_SELECT} FROM dwellings WHERE territory_id = $1 ORDER BY created_at`, [id]);
  // needs_refresh : bâtiments jamais importés, ou zone d'import trop petite
  // (territoire agrandi, distance ou marge hors territoire augmentée).
  // post_area : zone où un poste peut être placé (territoire + marge).
  const exclusion = await tx.maybeOne(
    `SELECT ${geomOut('z.geom', 'geom')}, ${geomOut('z.warning_geom', 'warning_geom')},
            round(z.area_ha::numeric, 2)::float AS area_ha, z.buffer_distance_m,
            app.warning_margin_m() AS warning_margin_m, z.computed_at, z.dwellings_refreshed_at,
            ${geomOut('z.post_area', 'post_area')}, tn.post_max_outside_m,
            (z.dwellings_refreshed_at IS NULL OR z.dwellings_extent IS NULL OR NOT ST_Covers(z.dwellings_extent,
               ST_Buffer(t.geom::geography, tn.post_max_outside_m + z.buffer_distance_m + app.warning_margin_m())::geometry)) AS needs_refresh
       FROM exclusion_zones z JOIN territories t ON t.id = z.territory_id JOIN tenants tn ON tn.id = t.tenant_id
      WHERE z.territory_id = $1`,
    [id],
  );
  return { territory, reserves, parkings, posts, dwellings, exclusion };
}

/** Importe les bâtiments si besoin, sans faire échouer l'action en cours (service IGN capricieux). */
/**
 * Les bâtiments couvrent-ils l'emprise utile du territoire ? L'import lui-même
 * se fait dans une requête séparée (POST …/dwellings/refresh, lancée par
 * l'éditeur) : s'il échoue ou dure, le territoire est déjà enregistré.
 */
async function needsImport(c: Parameters<typeof tenantTx>[0], territoryId: string) {
  const row = await tenantTx(c, null, (tx) =>
    tx.maybeOne<{ needs: boolean }>(
      `SELECT (z.dwellings_extent IS NULL OR NOT ST_Covers(z.dwellings_extent,
                ST_Buffer(t.geom::geography, tn.post_max_outside_m + z.buffer_distance_m + app.warning_margin_m())::geometry)) AS needs
         FROM exclusion_zones z JOIN territories t ON t.id = z.territory_id JOIN tenants tn ON tn.id = t.tenant_id
        WHERE z.territory_id = $1`,
      [territoryId],
    ),
  );
  return row?.needs ?? true;
}

cartoRoutes.get('/territories/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => c.json(await loadTerritory(tx, id)));
});

cartoRoutes.post('/territories', async (c) => {
  const body = territoryFields.partial({ notes: true }).strict().parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    await assertValidGeometry(tx, body.geom, 'Territoire');
    await assertTerritorySize(tx, body.geom);
    const { cols, exprs, params } = sqlValues(body, { geom: 'Polygon' }, 0);
    const territory = await tx.one(
      `INSERT INTO territories (${cols.join(', ')}) VALUES (${exprs.join(', ')}) RETURNING ${TERRITORY_SELECT}`,
      params,
    );
    return territory;
  }).then((territory) =>
    // Bâtiments : importés ensuite par l'éditeur (requête séparée).
    c.json({ territory, import_needed: true }, 201));
});

cartoRoutes.patch('/territories/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = territoryFields.partial().strict().parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    if (body.geom) {
      await assertValidGeometry(tx, body.geom, 'Territoire');
      await assertTerritorySize(tx, body.geom);
    }
    const { cols, exprs, params } = sqlValues(body, { geom: 'Polygon' }, 1);
    if (cols.length === 0) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
    const territory = notFoundIfNull(
      await tx.maybeOne(
        `UPDATE territories SET ${cols.map((col, i) => `${col} = ${exprs[i]}`).join(', ')}
          WHERE id = $1 RETURNING ${TERRITORY_SELECT}`,
        [id, ...params],
      ),
      'Territoire',
    );
    return territory;
  }).then(async (territory) =>
    // Contour agrandi au-delà de la zone importée : l'éditeur relance l'import.
    c.json({ territory, import_needed: body.geom ? await needsImport(c, id) : false }));
});

cartoRoutes.delete('/territories/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const n = await tx.execute('DELETE FROM territories WHERE id = $1', [id]);
    if (n === 0) throw new AppError(404, 'NOT_FOUND', 'Territoire introuvable.');
    return c.body(null, 204);
  });
});

/** Export GeoJSON du territoire complet (territoire, réserves, parkings, postes, chemins). */
cartoRoutes.get('/territories/:id/export', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    const { territory, reserves, parkings, posts, exclusion } = await loadTerritory(tx, id);
    const feature = (geometry: unknown, properties: Record<string, unknown>) => ({ type: 'Feature', geometry, properties });
    const features = [
      feature(territory.geom, { kind: 'territoire', name: territory.name, notes: territory.notes, area_ha: territory.area_ha }),
      ...(exclusion?.geom
        ? [feature(exclusion.geom, { kind: 'zone_non_chassable', distance_m: exclusion.buffer_distance_m, area_ha: exclusion.area_ha })]
        : []),
      ...reserves.map((r) => feature(r.geom, { kind: 'reserve', name: r.name, reason: r.reason })),
      ...parkings.map((p) => feature(p.geom, { kind: 'parking', id: p.id, name: p.name })),
      ...posts.map((p) =>
        feature(p.geom, { kind: 'poste', number: p.number, name: p.name, parking_id: p.parking_id, instructions: p.instructions, active: p.active }),
      ),
      ...posts
        .filter((p) => p.access_path)
        .map((p) => feature(p.access_path, { kind: 'chemin', post_number: p.number, length_m: p.access_path_length_m })),
    ];
    const filename = `${String(territory.name).normalize('NFD').replace(/[^\w-]+/g, '_')}.geojson`;
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(JSON.stringify({ type: 'FeatureCollection', features }, null, 1), 200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
    });
  });
});

// ---------------------------------------------------------------------------
// Réserves, parkings, postes (et chemins d'accès, portés par le poste)
// ---------------------------------------------------------------------------

cartoRoutes.post('/territories/:id/:kind{reserves|parkings|posts}', async (c) => {
  const territoryId = parseId(c.req.param('id'));
  const kind = getKind(c.req.param('kind'));
  const body = kind.create.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    await validateGeoms(tx, kind.geoms, body, kind.label);
    const { cols, exprs, params } = sqlValues(body, kind.geoms, 1);
    cols.unshift('territory_id');
    exprs.unshift('$1');
    if (kind.table === 'posts' && body.number === undefined) {
      // Numéro proposé automatiquement : le suivant du territoire.
      cols.push('number');
      exprs.push('(SELECT coalesce(max(number), 0) + 1 FROM posts WHERE territory_id = $1)');
    }
    const item = await tx.one(
      `INSERT INTO ${kind.table} (${cols.join(', ')}) VALUES (${exprs.join(', ')}) RETURNING ${selectList(kind)}`,
      [territoryId, ...params],
    );
    return c.json({ item }, 201);
  });
});

cartoRoutes.patch('/:kind{reserves|parkings|posts}/:id', async (c) => {
  const kind = getKind(c.req.param('kind'));
  const id = parseId(c.req.param('id'));
  const body = kind.patch.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    await validateGeoms(tx, kind.geoms, body, kind.label);
    const { cols, exprs, params } = sqlValues(body, kind.geoms, 1);
    if (cols.length === 0) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
    const item = notFoundIfNull(
      await tx.maybeOne(
        `UPDATE ${kind.table} SET ${cols.map((col, i) => `${col} = ${exprs[i]}`).join(', ')}
          WHERE id = $1 RETURNING ${selectList(kind)}`,
        [id, ...params],
      ),
      kind.label,
    );
    return c.json({ item });
  });
});

cartoRoutes.delete('/:kind{reserves|parkings|posts}/:id', (c) => {
  const kind = getKind(c.req.param('kind'));
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const item = notFoundIfNull(
      await tx.maybeOne(`DELETE FROM ${kind.table} WHERE id = $1 RETURNING ${selectList(kind)}`, [id]),
      kind.label,
    );
    // L'élément supprimé est renvoyé pour permettre l'annulation côté éditeur.
    return c.json({ item });
  });
});
