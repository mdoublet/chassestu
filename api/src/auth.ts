import { verifyToken } from '@clerk/backend';
import { AppError } from './errors';
import type { AuthUser, Env } from './env';

/**
 * Vérifie le jeton porteur et renvoie l'utilisateur.
 *
 * Clerk sert UNIQUEMENT à l'identité (connexion par code e-mail). Le tenant
 * actif et le rôle viennent de notre base (table memberships, en-tête
 * X-Tenant-Id) : c'est ce que lisent les politiques RLS, et cela évite de
 * synchroniser deux sources de vérité.
 */
export async function authenticate(header: string | undefined, env: Env): Promise<AuthUser> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Connexion requise.');

  if (env.AUTH_MODE === 'dev') {
    if (env.ENVIRONMENT === 'production') {
      throw new AppError(500, 'MISCONFIGURED', 'AUTH_MODE=dev est interdit en production.');
    }
    // dev:<id>[:<nom>]
    const m = /^dev:([A-Za-z0-9_-]{1,64})(?::(.{1,120}))?$/.exec(token);
    if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'Jeton de développement invalide.');
    return { id: `dev_${m[1]}`, name: m[2] ? decodeURIComponent(m[2]) : undefined };
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    throw new AppError(500, 'MISCONFIGURED', 'Clerk n’est pas configuré (CLERK_JWT_KEY ou CLERK_SECRET_KEY).');
  }
  const result = await verifyToken(token, {
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY,
    authorizedParties: env.CLERK_AUTHORIZED_PARTIES?.split(',').map((s) => s.trim()).filter(Boolean),
  });
  const claims = (result.errors ? null : result.data) as Record<string, unknown> | null;
  if (!claims || typeof claims.sub !== 'string') {
    throw new AppError(401, 'UNAUTHENTICATED', 'Session expirée ou invalide.');
  }
  return {
    id: String(claims.sub),
    // Claims optionnels, à ajouter dans le modèle de jeton de session Clerk.
    name: typeof claims.name === 'string' ? claims.name : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
  };
}

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
