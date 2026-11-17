// Notifications push côté navigateur : enregistrement du service worker,
// abonnement / désabonnement de l'appareil, état affichable.
import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone / iPad : le push n'existe que dans l'application installée sur l'écran d'accueil. */
export function iosNeedsInstall() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  return ios && !standalone;
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Service worker non enregistré :', err);
    return null;
  }
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * État pour l'affichage : 'unsupported' | 'ios-install' | 'denied' | 'enabled' | 'disabled'.
 */
export async function pushStatus() {
  if (iosNeedsInstall()) return 'ios-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'enabled' : 'disabled';
}

const toUint8 = (b64url) => {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications refusées : autorisez-les dans les réglages du navigateur.');
  const reg = await navigator.serviceWorker.ready;
  const { public_key } = await api.get('/push/key', { tenant: false });
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(public_key) });
  await api.post('/push/subscriptions', sub.toJSON(), { tenant: false });
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.del('/push/subscriptions', { tenant: false, body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** Après connexion : réenregistre l'abonnement existant (autre utilisateur, clé renouvelée). */
export async function refreshPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription().catch(() => null);
  if (sub) await api.post('/push/subscriptions', sub.toJSON(), { tenant: false }).catch(() => {});
}
