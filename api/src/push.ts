// Notifications push (Web Push, RFC 8291 / 8292) via @block65/webcrypto-web-push.
//
// Les clés VAPID sont générées au premier usage et conservées en base
// (app_secrets) : aucune configuration à faire dans Cloudflare.
// Les envois ont lieu APRÈS la validation de la transaction (file d'attente
// traitée par le middleware), en arrière-plan dans un Worker.
import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { Tx } from './db';
import type { Env } from './env';

export interface VapidPair {
  publicKey: string; // point P-256 non compressé, base64url (pour le navigateur)
  privateKey: string; // composante « d » de la clé, base64url
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  title: string;
  body: string;
  url: string;
}

export interface PushResult {
  endpoint: string;
  ok: boolean;
  gone: boolean;
  status: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const b64url = (bytes: ArrayBuffer) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function generateVapidKeys(): Promise<VapidPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKey: b64url(raw), privateKey: jwk.d! };
}

/** Clés VAPID de la plateforme (créées au premier appel). */
export async function getVapidKeys(tx: Tx): Promise<VapidPair> {
  const read = async () => tx.maybeOne<{ public_key: string | null; private_key: string | null }>('SELECT * FROM app.vapid_keys()');
  let row = await read();
  if (!row?.public_key) {
    const fresh = await generateVapidKeys();
    await tx.query('SELECT app.init_vapid_keys($1, $2)', [fresh.publicKey, fresh.privateKey]);
    row = await read(); // une autre instance a pu les créer entre-temps : on relit
  }
  return { publicKey: row!.public_key!, privateKey: row!.private_key! };
}

/** « Sujet » VAPID : URL du site (exigée par les services push, Apple compris). */
export function vapidSubject(env: Env): string {
  const origin = (env.APP_ORIGIN ?? '').split(',')[0].trim();
  return origin.startsWith('https://') ? origin : 'https://chassestu.pages.dev';
}

export async function sendPushes(targets: PushTarget[], vapid: VapidPair, subject: string, fetchImpl: FetchLike = fetch): Promise<PushResult[]> {
  return Promise.all(
    targets.map(async (t) => {
      try {
        const payload = await buildPushPayload(
          {
            data: JSON.stringify({ title: t.title, body: t.body, url: t.url }),
            options: { ttl: 12 * 3600, urgency: 'high' },
          },
          { endpoint: t.endpoint, expirationTime: null, keys: { p256dh: t.p256dh, auth: t.auth } },
          { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        );
        const res = await fetchImpl(t.endpoint, payload as RequestInit);
        // 404 / 410 : l'appareil s'est désabonné (application désinstallée, autorisation retirée).
        return { endpoint: t.endpoint, ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
      } catch (err) {
        console.warn('Push en échec :', (err as Error).message);
        return { endpoint: t.endpoint, ok: false, gone: false, status: 0 };
      }
    }),
  );
}
