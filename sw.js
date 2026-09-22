// LifeDesk Service Worker v69 — MAJOR: built full block/report framework for Community Questions. Users can now block another user (their posts disappear immediately, permanently) and report a post with a reason. Reports go to an admin review queue in the Admin Dashboard, where a verified admin can remove the post or dismiss the report.
const CACHE = 'lifedesk-v69';
const ASSETS = ['/', '/index.html'];

// ── PUSH NOTIFICATIONS (background) ──────────────────────
// Handles a push notification arriving while the app is closed or in the
// background. Foreground notifications (app open) are handled separately,
// in index.html, as an in-app toast instead.
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyBZ8QfJpAu2sUyasGV60bWti_WNCln8t3g",
  authDomain: "lifedesk-5587c.firebaseapp.com",
  projectId: "lifedesk-5587c",
  storageBucket: "lifedesk-5587c.firebasestorage.app",
  messagingSenderId: "401661349678",
  appId: "1:401661349678:web:92e94fffe8a3cb09a334bf"
});
try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(function(payload) {
    var title = (payload.notification && payload.notification.title) || 'LifeDesk';
    var options = {
      body: (payload.notification && payload.notification.body) || '',
      icon: '/icon-192.png',
      badge: '/icon-96.png',
    };
    self.registration.showNotification(title, options);
  });
} catch (e) {
  console.warn('SW: Firebase Messaging init failed', e);
}


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
