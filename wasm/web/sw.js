// Offline cache for the web player. Bump CACHE when the shell or the wasm
// modules change.
const CACHE = 'replayer-wasm-v1';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './processor.js',
    './manifest.webmanifest',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './core.wasm',
    './engines/wav.wasm',
    './engines/flac.wasm',
    './engines/mp3.wasm',
    './engines/pretracker.wasm',
    './engines/hively.wasm',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET')
        return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin)
        return;

    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
            if (response && response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
        }).catch(() => {
            if (event.request.mode === 'navigate')
                return caches.match('./index.html');
            throw new Error('offline');
        }))
    );
});
