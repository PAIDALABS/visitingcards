// Service Worker for NFC Card Admin PWA
// Enables background notifications and offline caching

var CACHE_NAME = 'nfc-card-v1';
var URLS_TO_CACHE = ['admin.html'];

// Cache admin page for offline access
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

// Serve cached admin page when offline
self.addEventListener('fetch', function(e) {
    e.respondWith(
        fetch(e.request).catch(function() {
            return caches.match(e.request);
        })
    );
});

// Handle notification clicks — focus the admin page
self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].url.indexOf('admin.html') !== -1) {
                    return list[i].focus();
                }
            }
            return clients.openWindow('admin.html');
        })
    );
});
