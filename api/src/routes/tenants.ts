import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { assertNotDeputy, notFoundIfNull, parseId, tenantTx, userTx } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../auth';
import { invitationUrl } from './invitations';
import { deleteClerkUsers } from '../clerk-admin';

export const tenantRoutes = new Hono<AppEnv>();

const TENANT_COLUMNS = `id, name, kind, departement, buffer_distance_m, gps_tolerance_m,
  position_retention_h, show_all_posts, post_max_outside_m, hunters_per_car, created_at`;

const tenantCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['acca', 'societe', 'autre']).default('acca'),
  departement: z.string().regex(/^([0-9]{2}|2A|2B|97[1-6])$/, 'Département invalide.').nullable().optional(),
});

/**
 * Super-admin : crée une association et renvoie le lien d'invitation du
 * premier président (usage unique, 14 jours).
 */
tenantRoutes.post('/admin/tenants', async (c) => {
  const body = tenantCreateSchema.parse(await c.req.json());
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  return userTx(c, async (tx) => {
    const row = await tx.one<{ id: string }>(
      `SELECT app.create_tenant($1, $2, $3, $4, now() + interval '14 days') AS id`,
      [body.name, body.kind, body.departement ?? null, tokenHash],
    );
    return c.json({ id: row.id, president_invitation_url: invitationUrl(c.env, token) }, 201);
  });
});

// ---------------------------------------------------------------------------
// Administration de la plateforme (super-administrateur)
// ---------------------------------------------------------------------------

tenantRoutes.get('/admin/tenants', (c) =>
  userTx(c, async (tx) => c.json({ tenants: await tx.query('SELECT * FROM app.admin_list_tenants()') })),
);

/** Membres d'une association et ce que deviendrait chacun en cas de suppression. */
tenantRoutes.get('/admin/tenants/:id/members', (c) => {
  const id = parseId(c.req.param('id'));
  return userTx(c, async (tx) => c.json({ members: await tx.query('SELECT * FROM app.admin_tenant_members($1)', [id]) }));
});

const deleteSchema = z.object({ delete_users: z.boolean(), confirm_name: z.string() }).strict();

/**
 * Supprime une association (et toutes ses données). Avec delete_users, supprime
 * aussi les utilisateurs qui n'appartiennent à aucune autre association, y
 * compris leur compte de connexion Clerk. Le nom de l'association doit être
 * retapé (confirm_name) : action irréversible.
 */
tenantRoutes.post('/admin/tenants/:id/delete', async (c) => {
  const id = parseId(c.req.param('id'));
  const body = deleteSchema.parse(await c.req.json());
  const deletedUsers = await userTx(c, async (tx) => {
    const t = await tx.maybeOne<{ name: string }>('SELECT name FROM app.admin_list_tenants() WHERE id = $1', [id]);
    if (!t) throw new AppError(404, 'NOT_FOUND', 'Association introuvable.');
    if (body.confirm_name.trim() !== t.name) {
      throw new AppError(422, 'CONFIRMATION_MISMATCH', 'Le nom saisi ne correspond pas à celui de l’association.');
    }
    const row = await tx.one<{ users: string[] }>('SELECT app.admin_delete_tenant($1, $2) AS users', [id, body.delete_users]);
    console.log(`Administration : association « ${t.name} » supprimée par ${c.get('user').id} ; ${row.users.length} utilisateur(s) supprimé(s).`);
    return row.users;
  });
  // Après validation en base : comptes de connexion chez Clerk.
  const clerk = await deleteClerkUsers(deletedUsers, c.env.CLERK_SECRET_KEY);
  if (clerk.failed.length) console.error('Comptes Clerk non supprimés :', clerk.failed);
  return c.json({ deleted_users: deletedUsers.length, clerk });
});

tenantRoutes.get('/tenant', (c) =>
  tenantTx(c, null, async (tx, { tenantId, role }) => {
    const tenant = await tx.one(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [tenantId]);
    return c.json({ tenant, role });
  }),
);

const tenantPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['acca', 'societe', 'autre']),
    departement: z.string().regex(/^([0-9]{2}|2A|2B|97[1-6])$/).nullable(),
    buffer_distance_m: z.number().int().min(50).max(1000),
    gps_tolerance_m: z.number().int().min(5).max(200),
    position_retention_h: z.number().int().min(1).max(720),
    show_all_posts: z.boolean(),
    post_max_outside_m: z.number().int().min(0).max(500),
    hunters_per_car: z.number().int().min(2).max(9),
  })
  .partial()
  .strict();

tenantRoutes.patch('/tenant', async (c) => {
  const body = tenantPatchSchema.parse(await c.req.json());
  const entries = Object.entries(body);
  if (entries.length === 0) throw new AppError(400, 'VALIDATION', 'Aucune modification.');
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    // Les noms de colonnes viennent du schéma .strict() ci-dessus, jamais du client.
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const tenant = await tx.one(
      `UPDATE tenants SET ${sets} WHERE id = $1 RETURNING ${TENANT_COLUMNS}`,
      [tenantId, ...entries.map(([, v]) => v)],
    );
    return c.json({ tenant });
  });
});

// ---------------------------------------------------------------------------
// Membres
// ---------------------------------------------------------------------------

tenantRoutes.get('/members', (c) =>
  tenantTx(c, ['president', 'responsable'], async (tx, { tenantId }) => {
    const members = await tx.query(
      `SELECT u.id, u.display_name, u.email, u.phone, m.role, m.created_at, u.walking_ability, u.has_car, u.car_seats,
              CASE WHEN m.deputy_until > now() THEN m.deputy_until END AS deputy_until
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY m.role, u.display_name`,
      [tenantId],
    );
    return c.json({ members });
  }),
);

const roleSchema = z.object({ role: z.enum(['president', 'responsable', 'chasseur']) });


async function assertNotLastPresident(tx: import('../db').Tx, tenantId: string, userId: string) {
  const row = await tx.one<{ others: number; is_president: boolean }>(
    `SELECT count(*) FILTER (WHERE role = 'president' AND user_id <> $2)::int AS others,
            bool_or(role = 'president' AND user_id = $2) AS is_president
       FROM memberships WHERE tenant_id = $1`,
    [tenantId, userId],
  );
  if (row.is_president && row.others === 0) {
    throw new AppError(409, 'SOLE_PRESIDENT', 'L’association doit garder au moins un président.');
  }
}

tenantRoutes.patch('/members/:userId', async (c) => {
  const { role } = roleSchema.parse(await c.req.json());
  const userId = c.req.param('userId');
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    await assertNotDeputy(tx);
    if (role !== 'president') await assertNotLastPresident(tx, tenantId, userId);
    const member = notFoundIfNull(
      await tx.maybeOne(
        'UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id, role',
        [tenantId, userId, role],
      ),
      'Membre',
    );
    return c.json({ member });
  });
});

/** Marche, voiture et places d'un membre (président, responsable). */
tenantRoutes.patch('/members/:userId/mobility', async (c) => {
  const body = z.object({
    walking_ability: z.number().int().min(1).max(5).nullable(),
    has_car: z.boolean().nullable(),
    car_seats: z.number().int().min(0).max(8).nullable(),
  }).partial().strict().parse(await c.req.json());
  const userId = c.req.param('userId');
  return tenantTx(c, ['president', 'responsable'], async (tx) => {
    await tx.query('SELECT app.set_member_mobility($1, $2, $3, $4, $5, $6, $7)', [
      userId, 'walking_ability' in body, body.walking_ability ?? null, 'has_car' in body, body.has_car ?? null,
      'car_seats' in body, body.car_seats ?? null,
    ]);
    return c.json({ ok: true });
  });
});

/**
 * Mandat de président adjoint (président en titre) : jusqu'au soir de la date
 * donnée (heure de Paris) ; `until: null` retire le mandat.
 */
tenantRoutes.put('/members/:userId/deputy', async (c) => {
  const { until } = z.object({ until: z.iso.date().nullable() }).strict().parse(await c.req.json());
  const userId = c.req.param('userId');
  return tenantTx(c, ['president'], async (tx, { tenantId }) => {
    await assertNotDeputy(tx);
    if (until) {
      const ok = await tx.one<{ ok: boolean }>(`SELECT $1::date >= (now() AT TIME ZONE 'Europe/Paris')::date AND $1::date <= (now() + interval '1 year')::date AS ok`, [until]);
      if (!ok.ok) throw new AppError(422, 'VALIDATION', 'Date de fin du mandat : aujourd’hui au plus tôt, dans un an au plus tard.');
    }
    const m = notFoundIfNull(await tx.maybeOne<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]), 'Membre');
    if (m.role === 'president') throw new AppError(422, 'ALREADY_PRESIDENT', 'Ce membre est déjà président.');
    const member = await tx.one(
      `UPDATE memberships SET deputy_until = CASE WHEN $3::date IS NULL THEN NULL
                ELSE (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Paris') END
        WHERE tenant_id = $1 AND user_id = $2
        RETURNING user_id, role, CASE WHEN deputy_until > now() THEN deputy_until END AS deputy_until`,
      [tenantId, userId, until],
    );
    return c.json({ member });
  });
});

/** Retirer un membre (président) ou quitter l'association (soi-même). */
tenantRoutes.delete('/members/:userId', (c) => {
  const userId = c.req.param('userId');
  return tenantTx(c, null, async (tx, { tenantId, role }) => {
    if (userId !== c.get('user').id) {
      if (role !== 'president') throw new AppError(403, 'FORBIDDEN', 'Seul le président peut retirer un membre.');
      await assertNotDeputy(tx);
    }
    await assertNotLastPresident(tx, tenantId, userId);
    const n = await tx.execute('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    if (n === 0) throw new AppError(404, 'NOT_FOUND', 'Membre introuvable.');
    return c.body(null, 204);
  });
});

tenantRoutes.get('/audit', (c) =>
  tenantTx(c, ['president'], async (tx, { tenantId }) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const entries = await tx.query(
      `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action, a.entity, a.entity_id, a.at, a.diff
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.tenant_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT $2`,
      [tenantId, limit],
    );
    return c.json({ entries });
  }),
);
