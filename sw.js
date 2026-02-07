// Service Worker — push notifications only (no asset caching)

self.addEventListener('install', function(e) {
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    // Clean up any old caches from previous versions
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(k) { return caches.delete(k); }));
        }).then(function() { return self.clients.claim(); })
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
