// CardFlow Service Worker v2
// Strategies: app shell cached on install, network-first for navigation,
// stale-while-revalidate for static assets, network-only for API calls.

var CACHE_VERSION = 'cardflow-v15';
var OFFLINE_URL = '/offline.html';

// App shell: resources cached on install for instant loads + offline
var APP_SHELL = [
    OFFLINE_URL,
    '/dashboard',
    '/dashboard.css',
    '/common.js',
    '/cardflow_logo_icon.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    '/manifest.json'
];

// ── Install: cache app shell ──
self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_VERSION).then(function(cache) {
            return cache.addAll(APP_SHELL);
        })
    );
});

// ── Activate: delete old caches, claim clients ──
self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(
                keys.filter(function(k) { return k !== CACHE_VERSION; })
                    .map(function(k) { return caches.delete(k); })
            );
        }).then(function() { return self.clients.claim(); })
    );
});

// ── Message: handle SKIP_WAITING from client ──
self.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ── Fetch strategies ──
self.addEventListener('fetch', function(e) {
    var url = new URL(e.request.url);

    // Skip non-GET, cross-origin, chrome-extension, etc.
    if (e.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    // API calls: network only (never cache authenticated data)
    if (url.pathname.startsWith('/api/')) return;

    // Navigation requests: network first, fall back to cache, then offline page
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request).then(function(response) {
                // Cache successful navigation responses for offline use
                if (response.ok) {
                    var clone = response.clone();
                    caches.open(CACHE_VERSION).then(function(cache) {
                        cache.put(e.request, clone);
                    });
                }
                return response;
            }).catch(function() {
                return caches.match(e.request).then(function(cached) {
                    return cached || caches.match(OFFLINE_URL);
                });
            })
        );
        return;
    }

    // Static assets (CSS, JS, images, fonts): stale-while-revalidate
    e.respondWith(
        caches.match(e.request).then(function(cached) {
            var networkFetch = fetch(e.request).then(function(response) {
                if (response.ok) {
                    var clone = response.clone();
                    caches.open(CACHE_VERSION).then(function(cache) {
                        cache.put(e.request, clone);
                    });
                }
                return response;
            }).catch(function() {
                return cached;
            });
            return cached || networkFetch;
        })
    );
});

// ── Push notifications ──
self.addEventListener('push', function(e) {
    var d;
    try { d = e.data ? e.data.json() : {}; } catch(err) { d = { title: 'New notification', body: '' }; }
    var tag = d.tag || 'cardflow-' + Date.now();
    e.waitUntil(self.registration.showNotification(d.title || 'NFC Tap!', {
        body: d.body || 'Someone tapped your card',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [100, 50, 100, 50, 200],
        tag: tag,
        data: d.data || {},
        requireInteraction: true,
        renotify: true
    }));
});

// ── Notification click: focus or open dashboard ──
self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    var path = (e.notification.data && e.notification.data.url) || '/dashboard';
    var targetUrl = path.startsWith('http') ? path : (self.location.origin + path);
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
            for (var i = 0; i < list.length; i++) {
                var client = list[i];
                if (client.url.indexOf('/dashboard') !== -1) {
                    return client.focus().then(function(focused) {
                        return focused || clients.openWindow(targetUrl);
                    }).catch(function() {
                        return clients.openWindow(targetUrl);
                    });
                }
            }
            return clients.openWindow(targetUrl);
        })
    );
});
