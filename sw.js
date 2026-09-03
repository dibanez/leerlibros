/* LeerLibros service worker — app-shell offline cache */
const CACHE = 'leerlibros-v10';
const HTML_TIMEOUT = 3000; // on lie-fi, fall back to cache instead of hanging
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', e => {
  // 'reload' bypasses the browser's HTTP cache: without it a stale copy can be
  // baked into a fresh CACHE version, so bumping the version would change
  // nothing. Precaching must always come from the network.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function offlineResponse() {
  return new Response('Sin conexión', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// The whole app is one HTML file, so serving it cache-first meant a new
// version only showed up on the second load. Navigations now go to the
// network first and fall back to the cache when it is slow or unreachable.
// A late reply still refreshes the cache, so nothing is wasted.
function networkFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled) { settled = true; resolve(res); } };
    const fromCache = () => caches.match(req)
      .then(hit => hit || caches.match('./index.html'))
      .then(hit => done(hit || offlineResponse()));

    const timer = setTimeout(fromCache, HTML_TIMEOUT);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      done(res);
    }).catch(() => { clearTimeout(timer); fromCache(); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the lookup/translation APIs or analytics — they need the network.
  if (/dictionaryapi\.dev|mymemory\.translated\.net|googletagmanager\.com|google-analytics\.com/.test(url.host)) {
    return; // let the browser handle it normally
  }

  // The page itself: always try for a fresh copy.
  if (req.mode === 'navigate' || (url.origin === location.origin && url.pathname.endsWith('.html'))) {
    e.respondWith(networkFirst(req));
    return;
  }

  // Icons, manifest, JSZip: cache-first, fall back to network and store.
  // These only change with a new CACHE version, which wipes the old one.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && (url.origin === location.origin || /cdnjs\.cloudflare\.com/.test(url.host))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached || offlineResponse());
    })
  );
});
