// ---------------------------------------------------------------------------
// Orbit service worker — offline launch for the installed app.
//
// The governing constraint here is not "cache as much as possible", it is
// "never wedge a user on a build we cannot replace". Orbit is hosted on GitHub
// Pages, which cannot set response headers, so there is no Cache-Control lever
// to pull if this file misbehaves; the only recovery is a corrected deploy that
// clients pick up on their own schedule. Everything below is shaped by that:
//
//   - The navigation request is NEVER served cache-first. A deploy is visible
//     on the next online load, and a broken cache cannot outlive one reload.
//   - Static assets are stale-while-revalidate, so they self-heal one load
//     later rather than needing a version bump to expire.
//   - The new worker does not take over mid-session. It waits, the page offers
//     a reload, and the swap happens between loads — never swapping modules
//     under a running app.
//   - There is an explicit kill switch (see KILL below, and ?sw=off in
//     main.js) that unregisters and clears everything.
//
// Bump VERSION to force every client to discard its caches on next activate.
// That is the big hammer for a bad deploy; routine changes do not need it,
// because no strategy here can serve stale content indefinitely.
// ---------------------------------------------------------------------------
const VERSION = 'v1';
const SHELL_CACHE = `orbit-shell-${VERSION}`;
const ASSET_CACHE = `orbit-assets-${VERSION}`;
const DATA_CACHE = `orbit-data-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, ASSET_CACHE, DATA_CACHE]);

// How long to wait for the network on a navigation before falling back to the
// cached page. Short, because the failure this guards against is not "offline"
// (which rejects immediately) but a captive portal or a dead cell edge that
// accepts the connection and then never answers.
const NAV_TIMEOUT_MS = 4000;

// The app shell: everything needed to boot to an interactive globe with no
// network at all. Element sets are deliberately not here — they are fetched at
// runtime and cached as they arrive, because a two-hour-old catalogue is the
// app working normally and a precached one would just be stale.
//
// test/sw.test.mjs asserts every path exists AND that no module under src/ or
// styles/ is missing from this list, so adding a module without listing it
// fails the suite rather than quietly breaking the offline boot.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './src/celestial.js',
  './src/constants.js',
  './src/data.js',
  './src/enrichment.js',
  './src/ephemeris.js',
  './src/gp.js',
  './src/main.js',
  './src/passes.js',
  './src/pwa.js',
  './src/reentry.js',
  './src/satellites.js',
  './src/scene.js',
  './src/search.js',
  './src/skyframe.js',
  './src/skyview.js',
  './src/utils.js',
  './src/visibility.js',
  './src/wakelock.js',
  './src/worker.js',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/satellite.js/satellite.js',
  './vendor/astronomy-engine/astronomy.js',
  './vendor/textures/earth_atmos_2048.jpg',
  './vendor/textures/earth_specular_2048.jpg',
  './vendor/textures/earth_clouds_1024.png',
  './vendor/textures/earth_lights_2048.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Same-origin paths whose freshness matters more than their latency: the
// fallback catalogue and the sky artifacts. Network first, cache as a backstop.
const DATA_PATHS = ['/data/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // `no-cache` rather than `reload`: both defeat a stale HTTP-cached copy
    // being baked into the precache, but `no-cache` revalidates instead of
    // refetching, so a first visit does not download the 3 MB of libraries and
    // textures a second time just to store them.
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'no-cache' })));
    // Deliberately no skipWaiting() here — see the header. The page asks.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('orbit-') && !CURRENT.has(n))
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Both messages below are privileged: one swaps the version the app is
  // running, the other destroys every cache and unregisters the worker. In
  // practice a cross-origin page cannot reach this registration at all —
  // `navigator.serviceWorker` is same-origin — so this check is defence in
  // depth rather than a hole being closed. It is cheap, and inheriting a
  // security property from the platform without stating it is how it gets
  // quietly lost later.
  // CodeQL's missing-origin-check query flags this handler whichever way the
  // comparison is written — `self.location.origin` and the unqualified
  // `location.origin` were both tried, and the alert is unchanged. The query
  // appears to want a check against a specific expected origin rather than
  // against the worker's own, which is not a thing that exists here: a service
  // worker is reachable only from its own origin in the first place. The check
  // stays because it is correct and free; the alert is a standing false
  // positive to be dismissed rather than coded around.
  if (event.origin !== location.origin) return;

  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    // The page has told the user an update is ready and they accepted it, so
    // swapping now is safe: a reload follows immediately.
    self.skipWaiting();
    return;
  }
  if (type === 'KILL') {
    // Last-resort recovery, reachable from ?sw=off. Clears every cache this
    // worker owns and unregisters itself, so the next load is a plain network
    // fetch with no worker in the way.
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('orbit-')).map((n) => caches.delete(n)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })());
  }
});

// Cache a response only if it is one we can actually replay later. An opaque
// response (status 0, from a no-cors request) is unusable as a fallback: we
// cannot tell success from a 404, so caching one risks pinning a failure.
function isCacheable(res) {
  return res && res.ok && res.type !== 'opaque';
}

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = timeoutMs
      ? await Promise.race([
        fetch(request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ])
      : await fetch(request);
    if (isCacheable(res)) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    throw new Error(`offline and uncached: ${request.url}`);
  }
}

// Serve from cache immediately, refresh in the background. One load behind at
// worst, and it converges without any version bump.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  // Two caches, checked in this order, and the order is not arbitrary.
  //
  // Everything the app needs to boot is written to SHELL_CACHE at install time,
  // by a worker whose page was not yet controlled — so on a first offline
  // launch ASSET_CACHE is still empty and consulting it alone finds nothing:
  // the navigation falls back to the cached HTML and then every module, style
  // and texture behind it fails. ASSET_CACHE comes first because it holds the
  // revalidated copy, which is the fresher of the two whenever both exist.
  const cached = (await cache.match(request))
    ?? (await caches.match(request, { cacheName: SHELL_CACHE }));
  const network = fetch(request)
    .then((res) => {
      if (isCacheable(res)) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  throw new Error(`offline and uncached: ${request.url}`);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and a range request served a full cached body is a
  // correctness bug rather than an optimisation.
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // The escape hatch has to work even when the worker is misbehaving, so it is
  // checked before any caching logic and simply gets out of the way.
  if (sameOrigin && url.searchParams.get('sw') === 'off') return;

  // Element sets from the mirror and the CelesTrak fallback. Both send
  // permissive CORS headers, so these are real (non-opaque) responses and can
  // serve as an offline fallback — a stale catalogue still propagates, which is
  // far better than an empty globe.
  if (!sameOrigin) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Navigations: always try the network first, so a deploy lands on the next
  // online load and no cache can outlive one reload.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await networkFirst(request, SHELL_CACHE, NAV_TIMEOUT_MS);
      } catch {
        const shell = await caches.open(SHELL_CACHE);
        return (await shell.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  if (DATA_PATHS.some((p) => url.pathname.includes(p))) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});
