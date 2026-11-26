// Saisons : création (avec reprise de la précédente), saison en cours,
// espèces et quotas, récapitulatif des prélèvements, rattachements.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { regulationsSchema } from '../regulations';

export const seasonRoutes = new Hono<AppEnv>();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).');
const SEASON_SELECT = `s.id, s.name, to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
  s.id = app.current_season() AS current,
  (SELECT count(*)::int FROM hunt_days d WHERE d.season_id = s.id) AS days_count`;

const nameTaken = (err: unknown): never => {
  if ((err as any)?.code === '23505') throw new AppError(409, 'SEASON_NAME_TAKEN', 'Une saison porte déjà ce nom.');
  throw err;
};

/** Espèces d'une saison avec quotas et prélèvements de la saison. */
export async function seasonSpecies(tx: Tx, seasonId: string | null) {
  if (!seasonId) return [];
  return tx.query(
    `SELECT ss.species, ss.season_quota, ss.battue_quota,
            (SELECT count(*)::int FROM hunt_harvests hh JOIN hunts h ON h.id = hh.hunt_id JOIN hunt_days d ON d.id = h.day_id
              WHERE d.season_id = ss.season_id AND hh.species = ss.species AND hh.outcome = 'tue') AS harvested
       FROM season_species ss WHERE ss.season_id = $1 ORDER BY ss.position, ss.species`,
    [seasonId],
  );
}

/** Récapitulatif des prélèvements de la saison : par espèce et catégorie. */
async function recap(tx: Tx, seasonId: string) {
  const rows = await tx.query<{ species: string; category: string; n: number }>(
    `SELECT hh.species, hh.category, count(*)::int AS n
       FROM hunt_harvests hh JOIN hunts h ON h.id = hh.hunt_id JOIN hunt_days d ON d.id = h.day_id
      WHERE d.season_id = $1 AND hh.outcome = 'tue' GROUP BY 1, 2`,
    [seasonId],
  );
  const wounded = new Map((await tx.query<{ species: string; n: number }>(
    `SELECT hh.species, count(*)::int AS n FROM hunt_harvests hh JOIN hunts h ON h.id = hh.hunt_id JOIN hunt_days d ON d.id = h.day_id
      WHERE d.season_id = $1 AND hh.outcome = 'blesse' GROUP BY 1`, [seasonId])).map((r) => [r.species, r.n]));
  const species = await seasonSpecies(tx, seasonId);
  const names = [...new Set([...species.map((s: any) => s.species as string), ...rows.map((r) => r.species), ...wounded.keys()])];
  const days = await tx.one<{ days: number; battues: number }>(
    `SELECT count(DISTINCT d.id)::int AS days, count(h.id)::int AS battues
       FROM hunt_days d LEFT JOIN hunts h ON h.day_id = d.id WHERE d.season_id = $1 AND d.status <> 'annulee'`,
    [seasonId],
  );
  return {
    ...days,
    species: names.map((name) => {
      const sp: any = species.find((s: any) => s.species === name);
      const by = Object.fromEntries(rows.filter((r) => r.species === name).map((r) => [r.category, r.n]));
      const total = Object.values(by).reduce((a: number, b: any) => a + b, 0);
      return { species: name, season_quota: sp?.season_quota ?? null, total, by_category: by, wounded: wounded.get(name) ?? 0 };
    }),
  };
}

seasonRoutes.get('/seasons', (c) =>
  tenantTx(c, null, async (tx) => {
    const seasons = await tx.query(`SELECT ${SEASON_SELECT} FROM seasons s ORDER BY s.starts_on DESC`);
    const current = (seasons as any[]).find((s) => s.current) ?? null;
    return c.json({ seasons, current, species: await seasonSpecies(tx, current?.id ?? null) });
  }),
);

seasonRoutes.post('/seasons', async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(50), starts_on: date, ends_on: date, copy_from: z.uuid().nullable().optional(), make_current: z.boolean().optional() })
    .strict().parse(await c.req.json());
  if (body.ends_on <= body.starts_on) throw new AppError(422, 'VALIDATION', 'La fin de saison doit suivre son début.');
  return tenantTx(c, ['president'], async (tx) => {
    const { id } = await tx.one<{ id: string }>('SELECT app.create_season($1, $2, $3, $4) AS id', [body.name, body.starts_on, body.ends_on, body.copy_from ?? null]).catch(nameTaken);
    // Infos de chasse reprises de la saison d'origine (à mettre à jour : dates, battues…).
    await tx.execute(
      `UPDATE seasons s SET regulations = f.regulations FROM seasons f
        WHERE s.id = $1 AND f.id = coalesce($2::uuid, (SELECT current_season_id FROM tenants WHERE id = app.current_tenant_id()))`,
      [id, body.copy_from ?? null]);
    if (body.make_current) await tx.query('SELECT app.set_current_season($1)', [id]);
    return c.json({ season: await tx.one(`SELECT ${SEASON_SELECT} FROM seasons s WHERE s.id = $1`, [id]) }, 201);
  });
});

seasonRoutes.patch('/seasons/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = z.object({ name: z.string().trim().min(1).max(50), starts_on: date, ends_on: date }).partial().strict().parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    const s = notFoundIfNull(await tx.maybeOne(
      `UPDATE seasons SET name = coalesce($2, name), starts_on = coalesce($3::date, starts_on), ends_on = coalesce($4::date, ends_on)
        WHERE id = $1 RETURNING id`, [id, body.name ?? null, body.starts_on ?? null, body.ends_on ?? null]).catch(nameTaken), 'Saison');
    return c.json({ season: await tx.one(`SELECT ${SEASON_SELECT} FROM seasons s WHERE s.id = $1`, [s.id]) });
  });
});

/** Changer la saison en cours. */
seasonRoutes.put('/seasons/current', async (c) => {
  const { season_id } = z.object({ season_id: z.uuid() }).strict().parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    await tx.query('SELECT app.set_current_season($1)', [season_id]);
    return c.json({ ok: true });
  });
});

/** Supprimer une saison sans journée (créée par erreur) ; jamais la saison en cours. */
seasonRoutes.delete('/seasons/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const s = notFoundIfNull(await tx.maybeOne<{ current: boolean; days_count: number }>(`SELECT ${SEASON_SELECT} FROM seasons s WHERE s.id = $1`, [id]), 'Saison');
    if (s.current) throw new AppError(409, 'SEASON_CURRENT', 'Choisissez d’abord une autre saison en cours.');
    if (s.days_count) throw new AppError(409, 'SEASON_HAS_DAYS', 'Cette saison a des journées de chasse : elle ne peut pas être supprimée.');
    await tx.execute('DELETE FROM seasons WHERE id = $1', [id]);
    return c.body(null, 204);
  });
});

seasonRoutes.get('/seasons/:id/recap', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM seasons WHERE id = $1', [id]), 'Saison');
    return c.json(await recap(tx, id));
  });
});

/** Espèces de la saison (liste complète remplacée). */
seasonRoutes.put('/seasons/:id/species', async (c) => {
  const id = parseId(c.req.param('id'));
  const { species } = z.object({
    species: z.array(z.object({
      species: z.string().trim().min(1).max(60),
      season_quota: z.number().int().min(0).max(9999).nullable(),
      battue_quota: z.number().int().min(0).max(999).nullable(),
    }).strict()).max(50),
  }).strict().parse(await c.req.json());
  const names = species.map((s) => s.species.toLowerCase());
  if (new Set(names).size !== names.length) throw new AppError(422, 'VALIDATION', 'Une espèce est en double.');
  return tenantTx(c, ['president'], async (tx) => {
    notFoundIfNull(await tx.maybeOne('SELECT id FROM seasons WHERE id = $1', [id]), 'Saison');
    await tx.execute('DELETE FROM season_species WHERE season_id = $1', [id]);
    for (const [i, s] of species.entries()) {
      await tx.execute('INSERT INTO season_species (season_id, species, season_quota, battue_quota, position) VALUES ($1, $2, $3, $4, $5)',
        [id, s.species, s.season_quota, s.battue_quota, i]);
    }
    return c.json({ species: await seasonSpecies(tx, id) });
  });
});

// Rattacher / détacher un territoire, un plan de chasse, un lieu ou un membre.
const LINKS: Record<string, { table: string; col: string }> = {
  territories: { table: 'season_territories', col: 'territory_id' },
  'hunt-plans': { table: 'season_hunt_plans', col: 'hunt_plan_id' },
  places: { table: 'season_places', col: 'place_id' },
  members: { table: 'season_members', col: 'user_id' },
};

seasonRoutes.put('/seasons/:id/:kind{territories|hunt-plans|places|members}/:eid', (c) => {
  const id = parseId(c.req.param('id'));
  const link = LINKS[c.req.param('kind')];
  const eid = link.col === 'user_id' ? c.req.param('eid') : parseId(c.req.param('eid'));
  return tenantTx(c, ['president'], async (tx) => {
    try {
      await tx.execute(`INSERT INTO ${link.table} (season_id, ${link.col}) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, eid]);
    } catch (err) {
      if ((err as any)?.code === '23503') throw new AppError(404, 'NOT_FOUND', 'Élément ou saison introuvable.');
      throw err;
    }
    return c.json({ ok: true });
  });
});

seasonRoutes.delete('/seasons/:id/:kind{territories|hunt-plans|places|members}/:eid', (c) => {
  const id = parseId(c.req.param('id'));
  const link = LINKS[c.req.param('kind')];
  const eid = link.col === 'user_id' ? c.req.param('eid') : parseId(c.req.param('eid'));
  return tenantTx(c, ['president'], async (tx) => {
    await tx.execute(`DELETE FROM ${link.table} WHERE season_id = $1 AND ${link.col} = $2`, [id, eid]);
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Infos de chasse de la saison (onglet « Infos »)
// ---------------------------------------------------------------------------

/** Infos de la saison en cours (tout membre). */
seasonRoutes.get('/seasons/current/regulations', (c) =>
  tenantTx(c, null, async (tx) => {
    const row = await tx.maybeOne<{ id: string; name: string; regulations: unknown }>(
      'SELECT id, name, regulations FROM seasons WHERE id = app.current_season()');
    return c.json({ season: row ? { id: row.id, name: row.name } : null, regulations: row?.regulations ?? null });
  }),
);

/** Remplace les infos d'une saison (président) ; null pour les effacer. */
seasonRoutes.put('/seasons/:id/regulations', async (c) => {
  const id = parseId(c.req.param('id'));
  const raw = await c.req.json();
  const body = z.object({ regulations: z.unknown() }).strict().parse(raw);
  const regulations = body.regulations === null ? null : regulationsSchema.parse(body.regulations);
  return tenantTx(c, ['president'], async (tx) => {
    notFoundIfNull(await tx.maybeOne('UPDATE seasons SET regulations = $2 WHERE id = $1 RETURNING id', [id, regulations === null ? null : JSON.stringify(regulations)]), 'Saison');
    return c.json({ regulations });
  });
});
