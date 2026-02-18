// Service Worker — push notifications + offline fallback

var OFFLINE_CACHE = 'cardflow-offline-v1';
var OFFLINE_URL = '/offline.html';

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(OFFLINE_CACHE).then(function(cache) {
            return cache.addAll([OFFLINE_URL]);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k) { return k !== OFFLINE_CACHE; }).map(function(k) { return caches.delete(k); }));
        }).then(function() { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function(e) {
    if (e.request.mode !== 'navigate') return;
    e.respondWith(
        fetch(e.request).catch(function() {
            return caches.match(OFFLINE_URL);
        })
    );
});

self.addEventListener('push', function(e) {
    var d;
    try { d = e.data ? e.data.json() : {}; } catch(err) { d = { title: 'New notification', body: '' }; }
    e.waitUntil(self.registration.showNotification(d.title || 'NFC Tap!', {
        body: d.body || 'Someone tapped your card',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [100,50,100,50,200],
        tag: 'nfc-tap',
        requireInteraction: true,
        renotify: true
    }));
});

self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    e.waitUntil(
        clients.matchAll({type:'window',includeUncontrolled:true}).then(function(list) {
            for (var i = 0; i < list.length; i++) {
                if (list[i].url.indexOf('dashboard') !== -1) return list[i].focus();
            }
            return clients.openWindow('/dashboard');
        })
    );
});
