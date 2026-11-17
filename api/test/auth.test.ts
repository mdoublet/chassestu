import { describe, expect, it } from 'vitest';
import { app } from './helpers';

const clerkEnv = {
  DATABASE_URL: '',
  ENVIRONMENT: 'production',
  AUTH_MODE: 'clerk',
  APP_ORIGIN: 'https://app.test',
  CLERK_SECRET_KEY: 'sk_test_inutilise',
};

describe('authentification Clerk', () => {
  it('un jeton mal formé donne 401, pas une erreur interne', async () => {
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer faux.jeton.test' } }, clerkEnv);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('le mode dev est refusé en production', async () => {
    const res = await app.request('/api/me', { headers: { Authorization: 'Bearer dev:marc' } }, { ...clerkEnv, AUTH_MODE: 'dev' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe('MISCONFIGURED');
  });
});
