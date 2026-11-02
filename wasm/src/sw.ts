/// <reference lib="webworker" />

// Offline cache for the web player. Bump CACHE when the shell or the wasm
// modules change.
const CACHE = 'replayer-wasm-v5';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './bootstrap.js',
    './app.js',
    './tags.js',
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
    './engines/xmp.wasm',
    './engines/v2.wasm',
    './engines/gme.wasm',
];

const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('install', (event: ExtendableEvent) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => worker.skipWaiting())
    );
});

worker.addEventListener('activate', (event: ExtendableEvent) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => worker.clients.claim())
    );
});

worker.addEventListener('fetch', (event: FetchEvent) => {
    if (event.request.method !== 'GET')
        return;

    const url = new URL(event.request.url);
    if (url.origin !== worker.location.origin)
        return;

    event.respondWith((async () => {
        const cached = await caches.match(event.request);
        if (cached)
            return cached;

        try {
            const response = await fetch(event.request);
            if (response.ok) {
                const copy = response.clone();
                void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
        } catch (error) {
            if (event.request.mode === 'navigate') {
                const fallback = await caches.match('./index.html');
                if (fallback)
                    return fallback;
            }
            return new Response('Offline', { status: 503, statusText: 'Offline' });
        }
    })());
});
