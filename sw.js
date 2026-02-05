// Service Worker for NFC Card Admin PWA
// Handles background push notifications + offline caching

var CACHE_NAME = 'nfc-card-v2';
var URLS_TO_CACHE = ['admin.html'];

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(URLS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(e) {
    e.respondWith(
        fetch(e.request).catch(function() {
            return caches.match(e.request);
        })
    );
});

// Background push notification — works even when phone is locked
self.addEventListener('push', function(e) {
    var data = e.data ? e.data.json() : {};
    e.waitUntil(
        self.registration.showNotification(data.title || 'Someone tapped your card!', {
            body: data.body || 'Tap to select which card to share',
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%231B1464"/><text x="50" y="62" text-anchor="middle" fill="white" font-size="40" font-family="sans-serif" font-weight="bold">AG</text></svg>',
            badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="%231B1464"/></svg>',
            vibrate: [100, 50, 100, 50, 200],
            tag: 'nfc-tap',
            requireInteraction: true,
            renotify: true
        })
    );
});

// Focus admin page on notification tap
self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].url.indexOf('admin') !== -1) {
                    return list[i].focus();
                }
            }
            return clients.openWindow('admin.html');
        })
    );
});
