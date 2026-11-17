// Alertes dans l'application (cloche) et abonnements push des appareils.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import type { Tx } from '../db';
import { withTx } from '../db';
import { userTx } from '../context';
import { getVapidKeys, sendPushes, vapidSubject, type PushTarget } from '../push';

export const notificationRoutes = new Hono<AppEnv>();

/**
 * Crée les alertes d'une battue (une par destinataire) et met en file les
 * notifications push de leurs appareils (envoyées après validation).
 */
export async function notifyUsers(
  c: Context<AppEnv>,
  tx: Tx,
  huntId: string,
  kind: string,
  items: { user_id: string; title: string; body: string }[],
) {
  if (!items.length) return 0;
  const url = `#/battues/${huntId}`;
  // Ouverture depuis la notification : la page bascule sur la bonne association.
  const tenantId = c.req.header('X-Tenant-Id') ?? '';
  const openUrl = `/?tenant=${encodeURIComponent(tenantId)}${url}`;
  const rows = await tx.query<{ user_id: string; title: string; body: string; endpoint: string | null; p256dh: string; auth: string }>(
    'SELECT * FROM app.notify_users($1, $2, $3, $4)',
    [huntId, kind, url, JSON.stringify(items)],
  );
  for (const r of rows) {
    if (r.endpoint) c.get('pushQueue').push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, title: r.title, body: r.body, url: openUrl });
  }
  return new Set(rows.map((r) => r.user_id)).size;
}

/** Envoie les notifications push en file et note le résultat par appareil. */
export async function flushPushQueue(c: Context<AppEnv>, queue: PushTarget[]) {
  const ctx = { userId: c.get('user')?.id ?? null, tenantId: null };
  const vapid = await withTx(c.get('pool'), ctx, (tx) => getVapidKeys(tx));
  const results = await sendPushes(queue, vapid, vapidSubject(c.env), c.get('pushFetch'));
  await withTx(c.get('pool'), ctx, async (tx) => {
    for (const r of results) await tx.query('SELECT app.push_result($1, $2, $3)', [r.endpoint, r.ok, r.gone]);
  });
  return results;
}

// ---------------------------------------------------------------------------
// Abonnement push d'un appareil
// ---------------------------------------------------------------------------

notificationRoutes.get('/push/key', (c) =>
  userTx(c, async (tx) => c.json({ public_key: (await getVapidKeys(tx)).publicKey })),
);

const subscriptionSchema = z.object({
  endpoint: z.url().startsWith('https://').max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

notificationRoutes.post('/push/subscriptions', async (c) => {
  const body = subscriptionSchema.parse(await c.req.json());
  return userTx(c, async (tx) => {
    await tx.query('SELECT app.save_push_subscription($1, $2, $3, $4)', [
      body.endpoint, body.keys.p256dh, body.keys.auth, c.req.header('User-Agent') ?? null,
    ]);
    return c.json({ ok: true }, 201);
  });
});

notificationRoutes.delete('/push/subscriptions', async (c) => {
  const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(await c.req.json());
  return userTx(c, async (tx) => {
    await tx.execute('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    return c.body(null, 204);
  });
});

/** Notification d'essai vers ses propres appareils. */
notificationRoutes.post('/push/test', (c) =>
  userTx(c, async (tx) => {
    const subs = await tx.query<{ endpoint: string; p256dh: string; auth: string }>('SELECT endpoint, p256dh, auth FROM push_subscriptions');
    for (const s of subs) {
      c.get('pushQueue').push({ ...s, title: 'Chasses-tu\u202f? — essai', body: 'Les notifications fonctionnent sur cet appareil.', url: '/#/notifications' });
    }
    return c.json({ devices: subs.length });
  }),
);

// ---------------------------------------------------------------------------
// Alertes (cloche)
// ---------------------------------------------------------------------------

/** Compteur de la cloche (interrogé régulièrement par le site). */
notificationRoutes.get('/notifications/unread', (c) =>
  userTx(c, async (tx) => c.json(await tx.one('SELECT count(*)::int AS unread FROM notifications WHERE read_at IS NULL'))),
);

notificationRoutes.get('/notifications', (c) =>
  userTx(c, async (tx) => {
    const notifications = await tx.query(
      `SELECT n.id, n.tenant_id, t.name AS tenant_name, n.kind, n.title, n.body, n.url, n.created_at, n.read_at
         FROM notifications n LEFT JOIN tenants t ON t.id = n.tenant_id
        ORDER BY n.created_at DESC LIMIT 50`,
    );
    const { unread } = await tx.one<{ unread: number }>('SELECT count(*)::int AS unread FROM notifications WHERE read_at IS NULL');
    return c.json({ notifications, unread });
  }),
);

notificationRoutes.post('/notifications/read', async (c) => {
  const { ids } = z.object({ ids: z.array(z.uuid()).max(200).optional() }).parse(await c.req.json().catch(() => ({})));
  return userTx(c, async (tx) => {
    if (ids?.length) await tx.execute('UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND id = ANY($1)', [ids]);
    else await tx.execute('UPDATE notifications SET read_at = now() WHERE read_at IS NULL');
    return c.body(null, 204);
  });
});
