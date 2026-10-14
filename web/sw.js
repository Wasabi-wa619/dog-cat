/* Service worker: serves the app shell from cache so the app opens offline.
 * Bump VERSION whenever app files change so devices pick up the update. */
const VERSION = 'v4';
const CACHE = 'workspace-' + VERSION;
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'api.js', 'store.js', 'config.js',
  'vendor/firebase.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same-origin GETs: network first (so updates arrive), falling back to cache offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(hit => hit || caches.match('index.html')))
  );
});
