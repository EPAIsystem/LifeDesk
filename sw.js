// LifeDesk Service Worker v26 — fixed answers being truncated to 500 chars in history (now full answer, up to 8000 chars), Home screen recent items now reopen the actual saved answer instead of a blank vertical, on-device answer cache is now actually used as an offline fallback with a visible consent toggle in Profile
const CACHE = 'lifedesk-v26';
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
     e.request.url.includes('googleapis') ||
     e.request.url.includes('gstatic') ||
     e.request.url.includes('paystack') ||
     e.request.url.includes('anthropic') ||
     e.request.url.includes('exchangerate')) {
    return; // Never cache API calls
  }
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(res) {
        if(res && res.status === 200 && e.request.method === 'GET') {
          var clone = res.clone();
          caches.open(CACHE).then(function(cache){
            cache.put(e.request, clone);
          });
        }
        return res;
      });
    }).catch(function(){
      return caches.match('/index.html');
    })
  );
});
