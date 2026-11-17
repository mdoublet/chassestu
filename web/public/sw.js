// Service worker de Chasses-tu ? : réception des notifications push.
// (La mise en cache hors ligne arrivera au lot 6.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const url = data.url || '/#/';
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Chasses-tu ?', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: url, // une seule notification affichée par battue et par étape
      renotify: true,
      data: { url },
    });
    // Pages ouvertes : mettre à jour la cloche.
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'notification' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        client.postMessage({ type: 'open', url: target });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
