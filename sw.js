var CACHE = 'nfc-card-v15';
var ASSETS = ['admin.html','icon-192.png','icon-512.png','apple-touch-icon.png'];

self.addEventListener('install', function(e) {
    e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }));
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
        }).then(function(){ return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function(e) {
    e.respondWith(fetch(e.request).catch(function(){ return caches.match(e.request); }));
});

self.addEventListener('push', function(e) {
    var d = e.data ? e.data.json() : {};
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
                if (list[i].url.indexOf('admin') !== -1) return list[i].focus();
            }
            return clients.openWindow('admin.html');
        })
    );
});
