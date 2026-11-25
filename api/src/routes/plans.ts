// Plans de chasse d'un territoire : la traque (départ, tracé, sortie) et, pour
// chacun, une grille de couverture par effectif (postes à pourvoir).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { geomOut, geomParam, lineSchema, pointSchema } from '../geo';

export const planRoutes = new Hono<AppEnv>();

export interface PlanRow {
  id: string;
  hunter_count: number;
  post_ids: string[];
  numbers: number[];
  invalid_numbers: number[];
  inactive_numbers: number[];
  updated_at: string;
}

/**
 * Grille d'un plan de chasse, avec la validité de chaque ligne calculée à la
 * lecture : valide si son nombre de postes égale l'effectif et qu'aucun de ses
 * postes n'est invalide (habitation) ou désactivé.
 */
export async function loadPlans(tx: Tx, huntPlanId: string | null) {
  if (!huntPlanId) return [];
  const rows = await tx.query<PlanRow>(
    `SELECT cp.id, cp.hunter_count, cp.updated_at,
            coalesce(array_agg(p.id ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL), '{}') AS post_ids,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL), '{}') AS numbers,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.invalid_reason IS NOT NULL), '{}') AS invalid_numbers,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL AND NOT p.active), '{}') AS inactive_numbers
       FROM coverage_plans cp
       LEFT JOIN coverage_plan_posts cpp ON cpp.plan_id = cp.id
       LEFT JOIN posts p ON p.id = cpp.post_id
      WHERE cp.hunt_plan_id = $1
      GROUP BY cp.id
      ORDER BY cp.hunter_count`,
    [huntPlanId],
  );
  return rows.map((r) => {
    const issues: string[] = [];
    if (r.numbers.length !== r.hunter_count) {
      issues.push(`${r.numbers.length} poste(s) pour ${r.hunter_count} chasseur(s) : un poste a été supprimé`);
    }
    if (r.invalid_numbers.length) issues.push(`poste(s) ${r.invalid_numbers.join(', ')} trop près d’une habitation`);
    if (r.inactive_numbers.length) issues.push(`poste(s) ${r.inactive_numbers.join(', ')} désactivé(s)`);
    return { ...r, valid: issues.length === 0, issues };
  });
}

const HUNT_PLAN_SELECT = `id, territory_id, name, notes, ${geomOut('start_point')}, ${geomOut('drive_path')}, ${geomOut('exit_point')},
  round(ST_Length(drive_path::geography))::int AS drive_length_m, wind_from_min, wind_from_max, updated_at,
  EXISTS (SELECT 1 FROM season_hunt_plans sp WHERE sp.hunt_plan_id = hunt_plans.id AND sp.season_id = app.current_season()) AS in_season`;

export async function loadHuntPlan(tx: Tx, id: string) {
  const hp = notFoundIfNull(await tx.maybeOne<Record<string, any>>(`SELECT ${HUNT_PLAN_SELECT} FROM hunt_plans WHERE id = $1`, [id]), 'Plan de chasse');
  return { ...hp, coverage: await loadPlans(tx, id) };
}

/** Plans de chasse d'un territoire, avec leur grille. */
export async function loadHuntPlans(tx: Tx, territoryId: string) {
  const list = await tx.query<{ id: string }>(`SELECT ${HUNT_PLAN_SELECT} FROM hunt_plans WHERE territory_id = $1 ORDER BY lower(name)`, [territoryId]);
  return Promise.all(list.map(async (hp) => ({ ...hp, coverage: await loadPlans(tx, hp.id) })));
}

/** Plan par défaut d'un territoire : le seul, ou le plus ancien (compatibilité). */
export async function defaultHuntPlanId(tx: Tx, territoryId: string): Promise<string | null> {
  const r = await tx.maybeOne<{ id: string }>('SELECT id FROM hunt_plans WHERE territory_id = $1 ORDER BY created_at, id LIMIT 1', [territoryId]);
  return r?.id ?? null;
}

function parseCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new AppError(400, 'VALIDATION', 'Effectif invalide (1 à 999).');
  return n;
}

const huntPlanFields = z.object({
  name: z.string().trim().min(1, 'Le nom du plan de chasse est obligatoire.').max(200),
  notes: z.string().max(2000),
  start_point: pointSchema.nullable(),
  drive_path: lineSchema.nullable(),
  exit_point: pointSchema.nullable(),
  // Vents favorables : d'où vient le vent, de min à max (sens horaire) ; null : tous vents.
  wind_from_min: z.number().int().min(0).max(359).nullable(),
  wind_from_max: z.number().int().min(0).max(359).nullable(),
});
const windPair = (b: { wind_from_min?: number | null; wind_from_max?: number | null }) =>
  (b.wind_from_min === undefined) === (b.wind_from_max === undefined) && (b.wind_from_min === null) === (b.wind_from_max === null);
const WIND_MSG = { message: 'Indiquez les deux bornes de la plage de vent (ou aucune).' };
const GEOMS = ['start_point', 'drive_path', 'exit_point'] as const;

function nameTaken(err: unknown): never {
  if ((err as any)?.code === '23505') throw new AppError(409, 'HUNT_PLAN_NAME_TAKEN', 'Un plan de chasse porte déjà ce nom sur ce territoire.');
  throw err;
}

planRoutes.get('/territories/:id/hunt-plans', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM territories WHERE id = $1', [id]), 'Territoire');
    return c.json({ hunt_plans: await loadHuntPlans(tx, id) });
  });
});

planRoutes.post('/territories/:id/hunt-plans', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = huntPlanFields.partial({ notes: true, start_point: true, drive_path: true, exit_point: true, wind_from_min: true, wind_from_max: true }).strict()
    .refine(windPair, WIND_MSG).parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM territories WHERE id = $1', [id]), 'Territoire');
    const g = (k: (typeof GEOMS)[number]) => (body[k] ? JSON.stringify(body[k]) : null);
    const { id: hpId } = await tx
      .one<{ id: string }>(
        `INSERT INTO hunt_plans (territory_id, name, notes, wind_from_min, wind_from_max, start_point, drive_path, exit_point)
         VALUES ($1, $2, $3, $7, $8,
                 CASE WHEN $4::text IS NULL THEN NULL ELSE ${geomParam(4)} END,
                 CASE WHEN $5::text IS NULL THEN NULL ELSE ${geomParam(5)} END,
                 CASE WHEN $6::text IS NULL THEN NULL ELSE ${geomParam(6)} END)
         RETURNING id`,
        [id, body.name, body.notes ?? '', g('start_point'), g('drive_path'), g('exit_point'), body.wind_from_min ?? null, body.wind_from_max ?? null],
      )
      .catch(nameTaken);
    return c.json({ hunt_plan: await loadHuntPlan(tx, hpId) }, 201);
  });
});

planRoutes.patch('/hunt-plans/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = huntPlanFields.partial().strict().refine(windPair, WIND_MSG).parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(body)) {
      params.push(v === null ? null : (GEOMS as readonly string[]).includes(k) ? JSON.stringify(v) : v);
      const n = params.length;
      sets.push((GEOMS as readonly string[]).includes(k) ? `${k} = CASE WHEN $${n}::text IS NULL THEN NULL ELSE ${geomParam(n)} END` : `${k} = $${n}`);
    }
    if (sets.length) {
      const r = await tx.maybeOne(`UPDATE hunt_plans SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params).catch(nameTaken);
      notFoundIfNull(r, 'Plan de chasse');
    }
    return c.json({ hunt_plan: await loadHuntPlan(tx, id) });
  });
});

planRoutes.delete('/hunt-plans/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    notFoundIfNull(await tx.maybeOne('DELETE FROM hunt_plans WHERE id = $1 RETURNING id', [id]), 'Plan de chasse');
    return c.body(null, 204);
  });
});

const coverageSchema = z.object({ post_ids: z.array(z.uuid()).max(999) }).strict();

async function saveCoverage(tx: Tx, huntPlanId: string, count: number, postIds: string[]) {
  await tx.query('SELECT app.save_coverage_plan($1, $2, $3::uuid[])', [huntPlanId, count, postIds]);
  return (await loadPlans(tx, huntPlanId)).find((p) => p.hunter_count === count);
}

async function deleteCoverage(tx: Tx, tenantId: string, huntPlanId: string | null, count: number) {
  const plan = notFoundIfNull(
    huntPlanId ? await tx.maybeOne<{ id: string }>('DELETE FROM coverage_plans WHERE hunt_plan_id = $1 AND hunter_count = $2 RETURNING id', [huntPlanId, count]) : null,
    'Plan',
  );
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
     VALUES ($1, app.current_user_id(), 'delete', 'coverage_plans', $2, $3)`,
    [tenantId, plan.id, JSON.stringify({ hunt_plan_id: huntPlanId, hunter_count: count })],
  );
}

/** Ligne de la grille d'un plan de chasse pour un effectif (crée ou remplace). */
planRoutes.put('/hunt-plans/:id/coverage/:count', async (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  const { post_ids } = coverageSchema.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => c.json({ plan: await saveCoverage(tx, id, count, post_ids) }));
});

planRoutes.delete('/hunt-plans/:id/coverage/:count', (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    await deleteCoverage(tx, tenantId, id, count);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Compatibilité : grille « du territoire » = celle de son premier plan de
// chasse (créé à la volée, « Plan principal », au premier enregistrement).
// ---------------------------------------------------------------------------

planRoutes.get('/territories/:id/coverage-plans', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM territories WHERE id = $1', [id]), 'Territoire');
    return c.json({ plans: await loadPlans(tx, await defaultHuntPlanId(tx, id)) });
  });
});

planRoutes.put('/territories/:id/coverage-plans/:count', async (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  const { post_ids } = coverageSchema.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM territories WHERE id = $1', [id]), 'Territoire');
    const hp = (await defaultHuntPlanId(tx, id))
      ?? (await tx.one<{ id: string }>(`INSERT INTO hunt_plans (territory_id, name) VALUES ($1, 'Plan principal') RETURNING id`, [id])).id;
    return c.json({ plan: await saveCoverage(tx, hp, count, post_ids) });
  });
});

planRoutes.delete('/territories/:id/coverage-plans/:count', (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    await deleteCoverage(tx, tenantId, await defaultHuntPlanId(tx, id), count);
    return c.body(null, 204);
  });
});
