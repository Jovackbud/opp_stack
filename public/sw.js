const CACHE = 'opptrack-v1';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
);

self.addEventListener('fetch', e => {
  // Cache-first for shell, network-first for Firestore/API
  if (e.request.url.includes('firestore') || e.request.url.includes('anthropic')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Handle background push notifications
self.addEventListener('push', e => {
  const data = parsePushPayload(e);
  const notification = data.notification || {};
  const meta = data.data || {};
  e.waitUntil(
    self.registration.showNotification(notification.title || meta.title || data.title || 'OppTrack', {
      body:  notification.body || meta.body || data.body || 'You have a new notification',
      icon:  '/icons/icon.svg',
      badge: '/icons/badge.svg',
      data:  meta,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const oppId = e.notification.data?.opp_id;
  const url = oppId ? `/?opp=${encodeURIComponent(oppId)}` : '/';
  e.waitUntil(clients.openWindow(url));
});

function parsePushPayload(e) {
  if (!e.data) return {};
  try { return e.data.json(); }
  catch (err) {
    try { return JSON.parse(e.data.text()); }
    catch (err2) { return { body: e.data.text() }; }
  }
}
