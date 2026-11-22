// Lieux de l'association (cabane, restaurant, autre) et, pour les choisir
// comme rendez-vous ou regroupement, les parkings de tous les territoires.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { notFoundIfNull, parseId, tenantTx } from '../context';
import { AppError } from '../errors';
import { geomOut, geomParam, pointSchema } from '../geo';

export const placeRoutes = new Hono<AppEnv>();

const PLACE_SELECT = `id, name, kind, notes, ${geomOut('geom')}, photo IS NOT NULL AS has_photo, photo_updated_at,
  visibility, created_by IS NOT DISTINCT FROM app.current_user_id() AS mine,
  (SELECT display_name FROM users WHERE id = places.created_by) AS author`;

/**
 * Modifier un lieu : le président, ou son auteur tant qu'il est privé
 * (la RLS l'impose aussi ; ici, un message clair plutôt qu'un « introuvable »).
 */
async function assertCanEdit(tx: Tx, id: string, role: string) {
  if (role === 'president') return;
  const p = notFoundIfNull(await tx.maybeOne<{ mine: boolean; visibility: string }>(
    'SELECT created_by IS NOT DISTINCT FROM app.current_user_id() AS mine, visibility FROM places WHERE id = $1', [id]), 'Lieu');
  if (!p.mine || p.visibility !== 'private') {
    throw new AppError(403, 'FORBIDDEN', 'Seul le président modifie un lieu public ; vous pouvez modifier vos propres lieux.');
  }
}
const placeFields = z.object({
  name: z.string().trim().min(1, 'Le nom du lieu est obligatoire.').max(200),
  // Types usuels (cabane, restaurant, parking, autre) ou type saisi par le président.
  kind: z.string().trim().min(1).max(40),
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
    // Types déjà utilisés par l'association (proposés à côté des types usuels).
    const kinds = (await tx.query<{ kind: string }>('SELECT DISTINCT kind FROM places ORDER BY kind')).map((r) => r.kind);
    return c.json({ places, parkings, kinds });
  }),
);

/** Nouveau lieu : public pour le président ; privé (à proposer) pour un chasseur. */
placeRoutes.post('/places', async (c) => {
  const body = placeFields.partial({ kind: true, notes: true }).strict().parse(await c.req.json());
  return tenantTx(c, null, async (tx, { role }) => {
    const place = await tx.one(
      `INSERT INTO places (name, kind, geom, notes, created_by, visibility)
       VALUES ($1, $2, ${geomParam(3)}, $4, app.current_user_id(), $5) RETURNING ${PLACE_SELECT}`,
      [body.name, body.kind ?? 'autre', JSON.stringify(body.geom), body.notes ?? '', role === 'president' ? 'public' : 'private'],
    );
    return c.json({ place }, 201);
  });
});

placeRoutes.patch('/places/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = placeFields.extend({ visibility: z.enum(['public', 'private']) }).partial().strict().parse(await c.req.json());
  if (!Object.keys(body).length) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
  return tenantTx(c, null, async (tx, { role }) => {
    await assertCanEdit(tx, id, role);
    // Rendre public (ou privé) : le président seulement.
    if (body.visibility && role !== 'president') throw new AppError(403, 'FORBIDDEN', 'Seul le président rend un lieu public.');
    const place = notFoundIfNull(await tx.maybeOne(
      `UPDATE places SET name = coalesce($2, name), kind = coalesce($3, kind), notes = coalesce($5, notes),
              geom = CASE WHEN $4::text IS NULL THEN geom ELSE ${geomParam(4)} END,
              visibility = coalesce($6, visibility)
        WHERE id = $1 RETURNING ${PLACE_SELECT}`,
      [id, body.name ?? null, body.kind ?? null, body.geom ? JSON.stringify(body.geom) : null, body.notes ?? null, body.visibility ?? null],
    ), 'Lieu');
    return c.json({ place });
  });
});

placeRoutes.delete('/places/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx, { role }) => {
    await assertCanEdit(tx, id, role);
    const n = await tx.execute('DELETE FROM places WHERE id = $1', [id]);
    if (!n) throw new AppError(404, 'NOT_FOUND', 'Lieu introuvable.');
    return c.body(null, 204);
  });
});

// ---------------------------------------------------------------------------
// Photo d'un lieu (réduite par l'application : JPEG de quelques centaines de ko)
// ---------------------------------------------------------------------------

const photoSchema = z.object({
  type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().max(2_000_000), // base64
}).strict();

placeRoutes.put('/places/:id/photo', async (c) => {
  const id = parseId(c.req.param('id'));
  const { type, data } = photoSchema.parse(await c.req.json());
  const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  if (bytes.length > 1_500_000) throw new AppError(413, 'PHOTO_TOO_LARGE', 'Photo trop lourde (1,5 Mo au plus).');
  return tenantTx(c, null, async (tx, { role }) => {
    await assertCanEdit(tx, id, role);
    const place = notFoundIfNull(await tx.maybeOne(
      `UPDATE places SET photo = decode($2, 'base64'), photo_type = $3, photo_updated_at = now() WHERE id = $1 RETURNING ${PLACE_SELECT}`,
      [id, data, type]), 'Lieu');
    return c.json({ place });
  });
});

placeRoutes.delete('/places/:id/photo', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx, { role }) => {
    await assertCanEdit(tx, id, role);
    notFoundIfNull(await tx.maybeOne('UPDATE places SET photo = NULL, photo_type = NULL, photo_updated_at = NULL WHERE id = $1 RETURNING id', [id]), 'Lieu');
    return c.body(null, 204);
  });
});

/** Photo (tout membre) : l'application la charge avec son jeton, puis l'affiche. */
placeRoutes.get('/places/:id/photo', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, null, async (tx) => {
    // En base64 : même résultat quel que soit le pilote PostgreSQL (Node ou Neon).
    const p = notFoundIfNull(await tx.maybeOne<{ b64: string | null; photo_type: string | null }>(
      `SELECT encode(photo, 'base64') AS b64, photo_type FROM places WHERE id = $1`, [id]), 'Lieu');
    if (!p.b64) throw new AppError(404, 'NOT_FOUND', 'Pas de photo pour ce lieu.');
    const bytes = Uint8Array.from(atob(p.b64.replace(/\s/g, '')), (ch) => ch.charCodeAt(0));
    return c.body(bytes as any, 200, { 'Content-Type': p.photo_type ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  });
});
