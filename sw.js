// Runway's service worker: alerts only. Nothing is cached here; the page keeps its
// own copy of the plan, so a phone offline still opens what it last saw.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let n = {};
  try { n = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(n.title || 'Runway', {
    body: n.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'runway',
    renotify: true,
    data: { url: n.url || null },
  }));
});

// Opens the app that is already running, or a new one at the scope (the page
// remembers its code), or at the link the alert carries. A link with a #screen
// takes a running app there too.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  const go = new URL(url).hash.slice(1);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (!open) return self.clients.openWindow(url);
    if (go) open.postMessage({ go });
    return open.focus();
  }));
});
