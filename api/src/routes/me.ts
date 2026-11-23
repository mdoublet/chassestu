import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { userTx } from '../context';
import { AppError } from '../errors';

export const meRoutes = new Hono<AppEnv>();

/**
 * Profil + associations de l'utilisateur. Crée la ligne users au premier appel :
 * le front l'appelle juste après la connexion.
 */
meRoutes.get('/me', (c) =>
  userTx(c, async (tx) => {
    const u = c.get('user');
    await tx.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, coalesce($2, ''), $3)
       ON CONFLICT (id) DO UPDATE SET
         email = coalesce(EXCLUDED.email, users.email),
         display_name = CASE WHEN users.display_name = '' THEN EXCLUDED.display_name ELSE users.display_name END`,
      [u.id, u.name ?? null, u.email ?? null],
    );
    const user = await tx.one(
      'SELECT id, display_name, email, phone, is_super_admin, walking_ability, has_car, car_seats, nav_app FROM users WHERE id = $1',
      [u.id],
    );
    const tenants = await tx.query(
      `SELECT t.id, t.name, t.kind, t.buffer_distance_m, app.effective_role(m.role, m.deputy_until) AS role,
              CASE WHEN m.role <> 'president' AND m.deputy_until > now() THEN m.deputy_until END AS deputy_until
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY t.name`,
      [u.id],
    );
    return c.json({ user, tenants });
  }),
);

const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  // Mobilité et voiture : pour proposer des postes accessibles et le covoiturage.
  walking_ability: z.number().int().min(1).max(5).nullable().optional(),
  has_car: z.boolean().nullable().optional(),
  car_seats: z.number().int().min(0).max(8).nullable().optional(),
  // Application de navigation préférée (boutons « y aller »).
  nav_app: z.enum(['google', 'waze', 'apple']).nullable().optional(),
}).strict();

meRoutes.patch('/me', async (c) => {
  const body = profileSchema.parse(await c.req.json());
  return userTx(c, async (tx) => {
    const user = await tx.one(
      `UPDATE users SET display_name = coalesce($2, display_name),
                        phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                        walking_ability = CASE WHEN $5::boolean THEN $6::smallint ELSE walking_ability END,
                        has_car = CASE WHEN $7::boolean THEN $8::boolean ELSE has_car END,
                        car_seats = CASE WHEN $9::boolean THEN $10::smallint ELSE car_seats END,
                        nav_app = CASE WHEN $11::boolean THEN $12 ELSE nav_app END
        WHERE id = $1
        RETURNING id, display_name, email, phone, is_super_admin, walking_ability, has_car, car_seats, nav_app`,
      [c.get('user').id, body.display_name ?? null, body.phone !== undefined, body.phone ?? null,
       body.walking_ability !== undefined, body.walking_ability ?? null,
       body.has_car !== undefined, body.has_car ?? null,
       body.car_seats !== undefined, body.car_seats ?? null,
       body.nav_app !== undefined, body.nav_app ?? null],
    );
    return c.json({ user });
  });
});

/** Droit à l'effacement : supprime le compte et toutes ses appartenances. */
meRoutes.delete('/me', (c) =>
  userTx(c, async (tx) => {
    const sole = await tx.query('SELECT app.sole_president_tenants() AS id');
    if (sole.length > 0) {
      throw new AppError(409, 'SOLE_PRESIDENT', 'Désignez un autre président avant de supprimer votre compte.');
    }
    await tx.execute('DELETE FROM users WHERE id = $1', [c.get('user').id]);
    return c.body(null, 204);
  }),
);
