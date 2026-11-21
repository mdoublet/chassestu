// Lieux de l'association (cabane, restaurant, autre) et, pour les choisir
// comme rendez-vous ou regroupement, les parkings de tous les territoires.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { geomOut, geomParam, pointSchema } from '../geo';

export const placeRoutes = new Hono<AppEnv>();

const PLACE_SELECT = `id, name, kind, notes, ${geomOut('geom')}`;
const placeFields = z.object({
  name: z.string().trim().min(1, 'Le nom du lieu est obligatoire.').max(200),
  kind: z.enum(['cabane', 'restaurant', 'autre']),
  geom: pointSchema,
  notes: z.string().trim().max(500),
});

/** Lieux et parkings (tous les membres). */
placeRoutes.get('/places', (c) =>
  tenantTx(c, null, async (tx) => {
    const places = await tx.query(`SELECT ${PLACE_SELECT},
        EXISTS (SELECT 1 FROM season_places sp WHERE sp.place_id = places.id AND sp.season_id = app.current_season()) AS in_season
      FROM places ORDER BY kind, lower(name)`);
    const parkings = await tx.query(
      `SELECT p.id, p.name, t.name AS territory_name, ${geomOut('p.geom', 'geom')}
         FROM parkings p JOIN territories t ON t.id = p.territory_id
        WHERE EXISTS (SELECT 1 FROM season_territories st WHERE st.territory_id = t.id AND st.season_id = app.current_season())
        ORDER BY lower(t.name), lower(p.name)`,
    );
    return c.json({ places, parkings });
  }),
);

placeRoutes.post('/places', async (c) => {
  const body = placeFields.partial({ kind: true, notes: true }).strict().parse(await c.req.json());
  return tenantTx(c, ['president'], async (tx) => {
    const place = await tx.one(
      `INSERT INTO places (name, kind, geom, notes) VALUES ($1, $2, ${geomParam(3)}, $4) RETURNING ${PLACE_SELECT}`,
      [body.name, body.kind ?? 'autre', JSON.stringify(body.geom), body.notes ?? ''],
    );
    return c.json({ place }, 201);
  });
});

placeRoutes.patch('/places/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = placeFields.partial().strict().parse(await c.req.json());
  if (!Object.keys(body).length) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
  return tenantTx(c, ['president'], async (tx) => {
    const place = notFoundIfNull(await tx.maybeOne(
      `UPDATE places SET name = coalesce($2, name), kind = coalesce($3, kind), notes = coalesce($5, notes),
              geom = CASE WHEN $4::text IS NULL THEN geom ELSE ${geomParam(4)} END
        WHERE id = $1 RETURNING ${PLACE_SELECT}`,
      [id, body.name ?? null, body.kind ?? null, body.geom ? JSON.stringify(body.geom) : null, body.notes ?? null],
    ), 'Lieu');
    return c.json({ place });
  });
});

placeRoutes.delete('/places/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const n = await tx.execute('DELETE FROM places WHERE id = $1', [id]);
    if (!n) throw new AppError(404, 'NOT_FOUND', 'Lieu introuvable.');
    return c.body(null, 204);
  });
});
