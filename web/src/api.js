import { getToken } from './auth.js';
import { state } from './state.js';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, path, body, { tenant = true, raw = false } = {}) {
  const headers = {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant && state.tenantId) headers['X-Tenant-Id'] = state.tenantId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Pas de réseau : réessayez quand la connexion revient.');
  }
  if (raw && res.ok) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'HTTP', data?.message ?? `Erreur ${res.status}`, data?.details);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body = {}, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  del: (path, opts) => request('DELETE', path, opts?.body, opts),
  raw: (path) => request('GET', path, undefined, { raw: true }),
};
