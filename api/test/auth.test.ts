import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner } from './helpers';

// Vérification de bout en bout d'un vrai jeton RS256, avec une clé publique
// fournie comme CLERK_JWT_KEY (vérification hors ligne, comme en production).
const ORIGIN = 'https://app.test';
let privateKey: CryptoKey;
let clerkEnv: Record<string, string>;

const b64u = (b: ArrayBuffer | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString('base64url');

// En-tête « cat » : catégorie « jeton de session » exigée par @clerk/backend.
async function sign(payload: Record<string, unknown>) {
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'ins_test', typ: 'JWT', cat: 'cl_B7d4PD111AAA' }));
  const body = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64u(sig)}`;
}

function claims(extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub: 'user_clerk_test', azp: ORIGIN, iss: 'https://test.clerk.accounts.dev', iat: now, nbf: now - 5, exp: now + 60, sid: 'sess_1', ...extra };
}

const me = (token: string) => app.request('/api/me', { headers: { Authorization: `Bearer ${token}` } }, clerkEnv);

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
  clerkEnv = {
    DATABASE_URL: '',
    ENVIRONMENT: 'production',
    AUTH_MODE: 'clerk',
    APP_ORIGIN: ORIGIN,
    CLERK_JWT_KEY: pem,
    CLERK_AUTHORIZED_PARTIES: ORIGIN,
  };
});

describe('authentification Clerk', () => {
  it('un jeton valide est accepté et crée l’utilisateur', async () => {
    const res = await me(await sign(claims()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe('user_clerk_test');
    expect(await asOwner(`SELECT id FROM users WHERE id = 'user_clerk_test'`)).toHaveLength(1);
  });

  it('un jeton expiré, d’une autre origine ou mal signé est refusé avec sa raison', async () => {
    const cases: Array<[string, string]> = [
      [await sign(claims({ exp: Math.floor(Date.now() / 1000) - 3600 })), 'token-expired'],
      [await sign(claims({ azp: 'https://pirate.test' })), 'token-invalid-authorized-parties'],
      [(await sign(claims())).slice(0, -6) + 'AAAAAA', 'token-invalid-signature'],
    ];
    for (const [token, reason] of cases) {
      const res = await me(token);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe(reason);
    }
  });

  it('un jeton mal formé donne 401, pas une erreur interne', async () => {
    const res = await me('faux.jeton.test');
    expect(res.status).toBe(401);
  });

  it('le mode dev est refusé en production', async () => {
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer dev:marc' } }, { ...clerkEnv, AUTH_MODE: 'dev' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe('MISCONFIGURED');
  });
});
