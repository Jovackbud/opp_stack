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
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'OppTrack', {
      body:  data.body  || 'You have a new notification',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data:  data.data  || {},
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
