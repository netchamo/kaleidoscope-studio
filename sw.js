// Offline cache for the app shell. Bump VERSION on every release.
const VERSION = 'k-1';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'js/app.js', 'js/gl.js', 'js/luts.js', 'js/media.js',
  'js/audio.js', 'js/export.js', 'js/state.js', 'js/timeline.js', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // network first so updates arrive; cache as offline fallback
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
