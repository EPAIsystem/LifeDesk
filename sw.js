// LifeDesk Service Worker v2
const CACHE = 'lifedesk-v2';
const ASSETS = ['/', '/index.html'];

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
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if(e.request.url.includes('/api/') || 
     e.request.url.includes('firestore') || 
     e.request.url.includes('googleapis.com') ||
     e.request.url.includes('gstatic.com') ||
     e.request.url.includes('paystack')) {
    return; // Never cache API/Firebase/Paystack calls
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
