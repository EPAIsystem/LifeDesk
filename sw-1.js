// LifeDesk Service Worker — Offline Mode
const CACHE = 'lifedesk-v1';
const ASSETS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Nunito:wght@400;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Network first for API calls, cache first for assets
  if(e.request.url.includes('/api/') || e.request.url.includes('firestore') || e.request.url.includes('googleapis.com/identitytoolkit')) {
    e.respondWith(fetch(e.request).catch(function(){ return new Response(JSON.stringify({error:{message:'You are offline. Please reconnect to ask questions.'}}),{headers:{'Content-Type':'application/json'}}); }));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(res) {
        if(res && res.status === 200 && e.request.method === 'GET') {
          var clone = res.clone();
          caches.open(CACHE).then(function(cache){ cache.put(e.request, clone); });
        }
        return res;
      });
    }).catch(function(){ return caches.match('/index.html'); })
  );
});
