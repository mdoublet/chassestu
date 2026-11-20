import type { Context } from 'hono';
import { z } from 'zod';
import { withTx, type Tx } from './db';
import type { AppEnv } from './env';
import { AppError } from './errors';

export type Role = 'president' | 'responsable' | 'chasseur';

// ---------------------------------------------------------------------------
// Aides partagées par les routes
// ---------------------------------------------------------------------------

const uuid = z.uuid();

/** Transaction sans tenant (profil, sélecteur de tenant, invitations). */
export function userTx<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(c.get('pool'), { userId: c.get('user').id, tenantId: null }, fn);
}

/**
 * Transaction dans le tenant de l'en-tête X-Tenant-Id. Vérifie l'appartenance
 * (et le rôle si `roles` est fourni) ; la RLS reste le garde-fou final.
 */
export function tenantTx<T>(
  c: Context<AppEnv>,
  roles: Role[] | null,
  fn: (tx: Tx, ctx: { tenantId: string; role: Role }) => Promise<T>,
): Promise<T> {
  const header = c.req.header('X-Tenant-Id');
  const parsed = uuid.safeParse(header);
  if (!parsed.success) throw new AppError(400, 'TENANT_REQUIRED', 'En-tête X-Tenant-Id manquant ou invalide.');
  const tenantId = parsed.data;
  return withTx(c.get('pool'), { userId: c.get('user').id, tenantId }, async (tx) => {
    const row = await tx.one<{ role: Role | null }>('SELECT app.current_member_role() AS role');
    if (!row.role) throw new AppError(403, 'NOT_MEMBER', 'Vous n’êtes pas membre de cette association.');
    if (roles && !roles.includes(row.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Votre rôle ne permet pas cette action.');
    }
    return fn(tx, { tenantId, role: row.role });
  });
}

export function parseId(value: string): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw new AppError(404, 'NOT_FOUND', 'Introuvable.');
  return r.data;
}

export function notFoundIfNull<T>(row: T | null | undefined, what = 'Élément'): NonNullable<T> {
  if (row === null || row === undefined) throw new AppError(404, 'NOT_FOUND', `${what} introuvable.`);
  return row as NonNullable<T>;
}

/** Les droits des autres (rôles, retraits, mandats) : président en titre seulement. */
export async function assertNotDeputy(tx: Tx, message = 'Un président adjoint ne peut pas modifier les droits des membres.') {
  if ((await tx.one<{ d: boolean }>('SELECT app.is_deputy() AS d')).d) throw new AppError(403, 'DEPUTY_FORBIDDEN', message);
}
