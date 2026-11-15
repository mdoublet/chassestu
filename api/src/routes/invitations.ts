import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { parseId, tenantTx, userTx } from '../context';
import { AppError } from '../errors';
import { randomToken, sha256Hex } from '../auth';

export const invitationRoutes = new Hono<AppEnv>();

export function invitationUrl(env: Env, token: string): string {
  const origin = (env.APP_ORIGIN ?? '').split(',')[0].trim().replace(/\/$/, '');
  return `${origin}/#/invitation/${token}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
function tokenParam(value: string): string {
  if (!TOKEN_RE.test(value)) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Lien d’invitation inconnu.');
  return value;
}

const createSchema = z.object({
  role: z.enum(['president', 'responsable', 'chasseur']).default('chasseur'),
  expires_in_days: z.number().int().min(1).max(365).default(30),
  max_uses: z.number().int().min(1).max(1000).nullable().default(null),
});

/** Président : crée un lien d'invitation à partager (WhatsApp, SMS…). */
invitationRoutes.post('/invitations', async (c) => {
  const body = createSchema.parse(await c.req.json().catch(() => ({})));
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  return tenantTx(c, ['president'], async (tx) => {
    const invitation = await tx.one(
      `INSERT INTO invitations (token_hash, role, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), app.current_user_id())
       RETURNING id, role, max_uses, use_count, expires_at, created_at`,
      [tokenHash, body.role, body.max_uses, body.expires_in_days],
    );
    // Le jeton n'est renvoyé qu'ici : seule son empreinte est stockée.
    return c.json({ invitation: { ...invitation, url: invitationUrl(c.env, token) } }, 201);
  });
});

invitationRoutes.get('/invitations', (c) =>
  tenantTx(c, ['president'], async (tx) => {
    const invitations = await tx.query(
      `SELECT id, role, max_uses, use_count, expires_at, created_at
         FROM invitations
        WHERE revoked_at IS NULL AND expires_at > now()
          AND (max_uses IS NULL OR use_count < max_uses)
        ORDER BY created_at DESC`,
    );
    return c.json({ invitations });
  }),
);

invitationRoutes.delete('/invitations/:id', (c) => {
  const id = parseId(c.req.param('id'));
  return tenantTx(c, ['president'], async (tx) => {
    const n = await tx.execute('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (n === 0) throw new AppError(404, 'NOT_FOUND', 'Invitation introuvable.');
    return c.body(null, 204);
  });
});

/** Aperçu avant acceptation (nom de l'association, rôle proposé). */
invitationRoutes.get('/invitation-links/:token', async (c) => {
  const hash = await sha256Hex(tokenParam(c.req.param('token')));
  return userTx(c, async (tx) => {
    const row = await tx.maybeOne('SELECT * FROM app.invitation_preview($1)', [hash]);
    if (!row) throw new AppError(404, 'INVITATION_NOT_FOUND', 'Lien d’invitation inconnu.');
    return c.json({ invitation: row });
  });
});

invitationRoutes.post('/invitation-links/:token/accept', async (c) => {
  const hash = await sha256Hex(tokenParam(c.req.param('token')));
  const u = c.get('user');
  return userTx(c, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, coalesce($2, ''), $3) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name ?? null, u.email ?? null],
    );
    const membership = await tx.one('SELECT * FROM app.accept_invitation($1)', [hash]);
    return c.json({ membership });
  });
});
