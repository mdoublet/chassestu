// Stockage d'objets compatible S3 (Neon Object Storage) pour les photos.
// Requêtes signées (SigV4) avec aws4fetch : léger et compatible Workers.
// Sans identifiants configurés, les photos restent en base (repli).
import { AwsClient } from 'aws4fetch';
import type { Env } from './env';

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  /** null si l'objet n'existe pas. */
  get(key: string): Promise<{ bytes: ArrayBuffer; type: string } | null>;
  del(key: string): Promise<void>;
}

/** Client du bucket des téléversements, ou null si le stockage n'est pas configuré. */
export function objectStore(env: Env, fetchImpl: typeof fetch = fetch): ObjectStore | null {
  const { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_ENDPOINT_URL_S3: endpoint } = env;
  if (!id || !secret || !endpoint) return null;
  const aws = new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: 's3', region: env.AWS_REGION || 'auto' });
  // Adressage « par chemin », exigé par la passerelle Neon.
  const url = (key: string) => `${endpoint.replace(/\/$/, '')}/${env.STORAGE_BUCKET || 'uploads'}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const call = async (key: string, init: RequestInit) => {
    const req = await aws.sign(url(key), init);
    return fetchImpl(req);
  };
  return {
    async put(key, bytes, type) {
      const res = await call(key, { method: 'PUT', body: bytes, headers: { 'Content-Type': type } });
      if (!res.ok) throw new Error(`Stockage : envoi refusé (${res.status})`);
    },
    async get(key) {
      const res = await call(key, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Stockage : lecture refusée (${res.status})`);
      return { bytes: await res.arrayBuffer(), type: res.headers.get('Content-Type') ?? 'image/jpeg' };
    },
    async del(key) {
      const res = await call(key, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`Stockage : suppression refusée (${res.status})`);
    },
  };
}

/** Stockage en mémoire (tests). */
export function memoryStore(): ObjectStore & { objects: Map<string, { bytes: Uint8Array; type: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    objects,
    async put(key, bytes, type) { objects.set(key, { bytes: bytes.slice(), type }); },
    async get(key) {
      const o = objects.get(key);
      return o ? { bytes: o.bytes.slice().buffer, type: o.type } : null;
    },
    async del(key) { objects.delete(key); },
  };
}
