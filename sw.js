/* LeerLibros service worker — app-shell offline cache */
const CACHE = 'leerlibros-v18';
const HTML_TIMEOUT = 3000; // on lie-fi, fall back to cache instead of hanging
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './analytics.js',
  './gtm.js',
  './vendor/jszip.min.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon.png'
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
function networkFirst(req, isPage) {
  return new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled) { settled = true; resolve(res); } };
    // only a navigation may fall back to the shell; answering a script request
    // with index.html would be worse than failing
    const fromCache = () => caches.match(req)
      .then(hit => hit || (isPage ? caches.match('./index.html') : null))
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

  const isPage = req.mode === 'navigate' ||
                 (url.origin === location.origin && url.pathname.endsWith('.html'));
  // The app's own code travels with the page. Serving it cache-first meant a
  // deploy could hand out new markup with old logic whenever the CACHE version
  // was not bumped by hand; going to the network keeps the two in step.
  const isOwnCode = url.origin === location.origin &&
                    /\.(js|css)$/.test(url.pathname) &&
                    !url.pathname.includes('/vendor/');

  if (isPage || isOwnCode) {
    e.respondWith(networkFirst(req, isPage));
    return;
  }

  // Icons, manifest and the pinned JSZip never change without a new name, so
  // they are served from the cache and only fetched when missing.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached || offlineResponse());
    })
  );
});
