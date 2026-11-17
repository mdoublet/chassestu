import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';

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
 * Plans d'un territoire avec leur validité, calculée à la lecture :
 * un plan est valide si son nombre de postes égale l'effectif et qu'aucun de
 * ses postes n'est invalide (habitation) ou désactivé.
 */
export async function loadPlans(tx: Tx, territoryId: string) {
  const rows = await tx.query<PlanRow>(
    `SELECT cp.id, cp.hunter_count, cp.updated_at,
            coalesce(array_agg(p.id ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL), '{}') AS post_ids,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL), '{}') AS numbers,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.invalid_reason IS NOT NULL), '{}') AS invalid_numbers,
            coalesce(array_agg(p.number ORDER BY p.number) FILTER (WHERE p.id IS NOT NULL AND NOT p.active), '{}') AS inactive_numbers
       FROM coverage_plans cp
       LEFT JOIN coverage_plan_posts cpp ON cpp.plan_id = cp.id
       LEFT JOIN posts p ON p.id = cpp.post_id
      WHERE cp.territory_id = $1
      GROUP BY cp.id
      ORDER BY cp.hunter_count`,
    [territoryId],
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

planRoutes.get('/territories/:id/coverage-plans', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM territories WHERE id = $1', [id]), 'Territoire');
    return c.json({ plans: await loadPlans(tx, id) });
  });
});

function parseCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new AppError(400, 'VALIDATION', 'Effectif invalide (1 à 999).');
  return n;
}

const planSchema = z.object({ post_ids: z.array(z.uuid()).max(999) }).strict();

/** Enregistre le plan complet pour un effectif (crée ou remplace). */
planRoutes.put('/territories/:id/coverage-plans/:count', async (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  const { post_ids } = planSchema.parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    await tx.query('SELECT app.save_coverage_plan($1, $2, $3::uuid[])', [id, count, post_ids]);
    const plan = (await loadPlans(tx, id)).find((p) => p.hunter_count === count);
    return c.json({ plan });
  });
});

planRoutes.delete('/territories/:id/coverage-plans/:count', (c) => {
  const id = parseId(c.req.param('id'));
  const count = parseCount(c.req.param('count'));
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    const plan = notFoundIfNull(
      await tx.maybeOne<{ id: string }>('DELETE FROM coverage_plans WHERE territory_id = $1 AND hunter_count = $2 RETURNING id', [id, count]),
      'Plan',
    );
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, entity, entity_id, diff)
       VALUES ($1, app.current_user_id(), 'delete', 'coverage_plans', $2, $3)`,
      [tenantId, plan.id, JSON.stringify({ hunter_count: count })],
    );
    return c.body(null, 204);
  });
});
