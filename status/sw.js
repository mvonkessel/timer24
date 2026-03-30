const CACHE_NAME = 'status-v17';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Stale-while-revalidate for Firebase SDK, fonts, Google APIs
  if (url.hostname.includes('firebase') || url.hostname.includes('gstatic') || url.hostname.includes('googleapis')) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const fetching = fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetching;
        })
      )
    );
    return;
  }
  // Cache-first for app assets
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// Handle notification clicks
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});

// Handle FCM push messages for Wiebke
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch (err) {
    try { payload = { data: { title: 'Timer7', body: e.data.text() } }; } catch (e2) { return; }
  }
  const d = payload.data || payload.notification || payload;
  const title = d.title || 'Moritz Status';
  const body = d.body || '';
  const tag = d.tag || 'wiebke-push';
  let vibrate = [300, 80, 300];
  try { if (d.vibrate) vibrate = JSON.parse(d.vibrate); } catch (e) {}

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag,
      renotify: true,
      vibrate,
      silent: false,
      actions: [{ action: 'open', title: '\u25B6 \u00D6ffnen' }]
    })
  );
});
