/* =============================================================================
 * LunaDesk service worker
 *
 * Deliberately minimal. It exists to do the two things a page cannot do while
 * it is closed:
 *   1. receive a Web Push message from the `send-reminders` job and display a
 *      notification,
 *   2. focus (or open) the right route when that notification is clicked.
 *
 * It does NOT cache the app shell. A static host already caches hashed assets,
 * and cache-first HTML is how people end up running last month's build against
 * this month's schema. The fetch handler is a pass-through (Chrome requires one
 * for the app to be installable).
 *
 * Honest limitation: nothing here can force a sound. The OS owns notification
 * behaviour, and a closed browser may never receive the push at all.
 * ========================================================================== */

const VERSION = 'v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from earlier versions of this worker.
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Network only; simply keeping the handler present makes the app installable.
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'LunaDesk reminder', body: 'A scheduled reminder is due.', url: '/#/reminders', tag: undefined };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      // `renotify` keeps the alert fresh when the same tag fires again, but the
      // OS is free to ignore both flags.
      renotify: Boolean(payload.tag),
      requireInteraction: Boolean(payload.requireInteraction),
      icon: new URL('./favicon.svg', self.location).href,
      badge: new URL('./favicon.svg', self.location).href,
      data: { url: payload.url ?? '/#/reminders' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/#/reminders', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      const existing = windows[0];
      if (existing && 'focus' in existing) {
        await existing.focus();
        return existing.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});
