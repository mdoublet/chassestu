// Notifications : chiffrement Web Push vérifié de bout en bout, alertes
// créées à chaque étape d'une battue, envoi aux appareils, confidentialité.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateVapidKeys, sendPushes } from '../src/push';
import { api, asOwner, createTenant, east, newBattue, point, pushService, runningDay, square } from './helpers';

const b64u = (b: Buffer) => b.toString('base64url');

/** Un « téléphone » : clés de réception Web Push (P-256 + secret d'authentification). */
function fakeDevice(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { endpoint: `https://push.example.test/${name}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
  };
}

/** Déchiffrement côté appareil (RFC 8291, aes128gcm). */
function decrypt(device: ReturnType<typeof fakeDevice>, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const senderPub = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const secret = device.ecdh.computeSecret(senderPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), senderPub]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, device.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const end = plain.lastIndexOf(2); // délimiteur du dernier enregistrement, suivi du bourrage
  return plain.subarray(0, end).toString('utf8');
}

async function bodyOf(init: RequestInit): Promise<Buffer> {
  return Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
}

describe('chiffrement des notifications push', () => {
  it('un appareil déchiffre le message ; la signature VAPID est valide pour le service push', async () => {
    const vapid = await generateVapidKeys();
    const device = fakeDevice('a');
    const calls: { url: string; init: RequestInit }[] = [];
    const [res] = await sendPushes(
      [{ ...device.subscription, ...device.subscription.keys, title: 'Votre poste : 5', body: 'Grand bois', url: '#/battues/1' }],
      vapid,
      'https://chassestu.pages.dev',
      async (url, init) => { calls.push({ url, init: init! }); return new Response(null, { status: 201 }); },
    );
    expect(res).toMatchObject({ ok: true, gone: false });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(Number(headers.get('ttl'))).toBe(12 * 3600);

    expect(JSON.parse(decrypt(device, await bodyOf(calls[0].init)))).toEqual({ title: 'Votre poste : 5', body: 'Grand bois', url: '#/battues/1' });

    // Authorization: vapid t=<JWT>, k=<clé publique> ; JWT ES256 signé, aud = origine du service push.
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get('authorization')!);
    expect(m![2]).toBe(vapid.publicKey);
    const [h, p, sig] = m![1].split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'https://push.example.test', sub: 'https://chassestu.pages.dev' });
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});

describe('alertes des battues', () => {
  const P = 'pres_notif';
  let tenant: string;
  let territoryId: string;
  let postId: string;
  const as = (u: string, method: string, path: string, body?: unknown) => api(u, method, path, { tenant, body });
  const ch1 = fakeDevice('ch1');

  beforeAll(async () => {
    tenant = await createTenant(P, 'ACCA des alertes');
    territoryId = (await as(P, 'POST', '/api/territories', { name: 'Bois sonore', geom: square(5.5, 45.5, 0.01) })).body.territory.id;
    postId = (await as(P, 'POST', `/api/territories/${territoryId}/posts`, { name: 'Le hêtre', geom: point(east(5.5, 45.5, 50), 45.5) })).body.item.id;
    const inv = await as(P, 'POST', '/api/invitations', {});
    const token = inv.body.invitation.url.split('/').pop();
    for (const u of ['n_ch1', 'n_ch2', 'n_ch3']) await api(u, 'POST', `/api/invitation-links/${token}/accept`);
    expect((await api('n_ch1', 'POST', '/api/push/subscriptions', { body: ch1.subscription })).status).toBe(201);
  });
  beforeEach(() => {
    pushService.calls = [];
    pushService.status = 201;
  });

  it('publication : chaque convoqué reçoit une alerte (cloche) et une notification sur ses appareils', async () => {
    const day = await as(P, 'POST', '/api/days', { date: '2026-12-12', meeting_time: '07:30', meeting_place: 'Cabane', lunch_offered: true, participant_user_ids: ['dev_n_ch1', 'dev_n_ch2'] });
    const id = day.body.day.id;
    await as(P, 'POST', `/api/days/${id}/actions/convoquer`);

    const bell = await api('n_ch1', 'GET', '/api/notifications');
    expect(bell.body.unread).toBe(1);
    expect(bell.body.notifications[0]).toMatchObject({ title: 'Journée de chasse le samedi 12 décembre', kind: 'convocation', url: `#/journees/${id}`, tenant_name: 'ACCA des alertes' });
    expect(bell.body.notifications[0].body).toMatch(/RDV 7h30, Cabane\. Répondez présent ou absent et dites si vous restez déjeuner/);
    expect((await api('n_ch3', 'GET', '/api/notifications')).body.unread).toBe(0); // non convoqué

    // Seul n_ch1 a un appareil : un envoi, déchiffrable par son téléphone.
    expect(pushService.calls).toHaveLength(1);
    expect(pushService.calls[0].url).toBe(ch1.subscription.endpoint);
    const pushed = JSON.parse(decrypt(ch1, await bodyOf(pushService.calls[0].init)));
    expect(pushed).toMatchObject({ title: 'Journée de chasse le samedi 12 décembre', url: `/?tenant=${tenant}#/journees/${id}` });
    expect((await api('n_ch1', 'GET', '/api/notifications/unread')).body).toEqual({ unread: 1 });

    // Lu : le compteur retombe à zéro.
    await api('n_ch1', 'POST', '/api/notifications/read', { body: {} });
    expect((await api('n_ch1', 'GET', '/api/notifications')).body.unread).toBe(0);
  });

  it('attributions personnalisées, début et fin : seulement les présents', async () => {
    // n_ch2 présent à la journée mais pas volontaire pour cette battue.
    const { dayId, detail: day } = await runningDay(as, P, ['n_ch1', 'n_ch2'], { date: '2026-12-19' });
    const volunteer = day.participants.find((p: any) => p.user_id === 'dev_n_ch1').id;
    const { huntId: id, detail } = await newBattue(as, P, dayId, territoryId, [volunteer]);
    const p1 = detail.participants[0];
    await as(P, 'PUT', `/api/hunts/${id}/posts`, { post_ids: [postId] });
    await as(P, 'PUT', `/api/hunts/${id}/assignments`, { participant_id: p1.id, post_id: postId });
    pushService.calls = [];

    const pub = await as(P, 'POST', `/api/hunts/${id}/publish-assignments`);
    expect(pub.body.notified).toBe(1); // n_ch2 non volontaire : pas d'alerte
    const n1 = (await api('n_ch1', 'GET', '/api/notifications')).body.notifications[0];
    expect(n1).toMatchObject({ kind: 'attributions', title: 'Votre poste : 1 · Le hêtre' });
    expect(JSON.parse(decrypt(ch1, await bodyOf(pushService.calls[0].init))).title).toBe('Votre poste : 1 · Le hêtre');

    await as(P, 'POST', `/api/hunts/${id}/actions/debut`);
    await as(P, 'POST', `/api/hunts/${id}/actions/fin`);
    const titles = (await api('n_ch1', 'GET', '/api/notifications')).body.notifications.slice(0, 2).map((n: any) => n.title);
    expect(titles).toEqual(['Fin de battue', 'Début de battue']);
    expect((await api('n_ch2', 'GET', '/api/notifications')).body.notifications.map((n: any) => n.kind)).not.toContain('debut');
    // Regroupement : tous les présents de la journée, volontaires ou non.
    const rg = await as(P, 'POST', `/api/days/${dayId}/regroup`, { place: 'Cabane', time: '11:30' });
    expect(rg.body.notified).toBe(2);
    expect((await api('n_ch2', 'GET', '/api/notifications')).body.notifications[0]).toMatchObject({ kind: 'regroupement', body: 'Rendez-vous Cabane à 11h30. Itinéraire dans l’application.' });
  });

  it('un appareil désabonné (410) est supprimé ; les alertes restent dans la cloche', async () => {
    const dev = fakeDevice('ch3');
    await api('n_ch3', 'POST', '/api/push/subscriptions', { body: dev.subscription });
    pushService.status = 410;
    const day = await as(P, 'POST', '/api/days', { date: '2026-12-26', participant_user_ids: ['dev_n_ch3'] });
    await as(P, 'POST', `/api/days/${day.body.day.id}/actions/convoquer`);
    expect(pushService.calls.map((x) => x.url)).toEqual([dev.subscription.endpoint]);
    expect(await asOwner('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint = $1', [dev.subscription.endpoint])).toEqual([{ n: 0 }]);
    expect((await api('n_ch3', 'GET', '/api/notifications')).body.unread).toBe(1);
  });

  it('confidentialité : chacun ne voit que ses alertes et ses appareils ; notification d’essai', async () => {
    const mine = (await api('n_ch2', 'GET', '/api/notifications')).body.notifications;
    expect(mine.every((n: any) => n.kind)).toBe(true);
    const all = await asOwner(`SELECT count(*)::int AS n FROM notifications WHERE user_id = 'dev_n_ch1'`);
    expect(all[0].n).toBeGreaterThan(0);
    expect((await api('n_ch2', 'GET', '/api/notifications')).body.notifications.some((n: any) => n.title.startsWith('Votre poste'))).toBe(false);

    // Un téléphone qui change d'utilisateur passe au nouvel utilisateur.
    await api('n_ch2', 'POST', '/api/push/subscriptions', { body: ch1.subscription });
    expect(await asOwner('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [ch1.subscription.endpoint])).toEqual([{ user_id: 'dev_n_ch2' }]);
    const test = await api('n_ch2', 'POST', '/api/push/test');
    expect(test.body.devices).toBe(1);
    expect(JSON.parse(decrypt(ch1, await bodyOf(pushService.calls.at(-1)!.init))).body).toMatch(/fonctionnent/);
    expect((await api('n_ch1', 'POST', '/api/push/test')).body.devices).toBe(0);
  });
});
