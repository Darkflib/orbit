// ---------------------------------------------------------------------------
// Service worker lifecycle.
//
// Registration is the easy half; the update handshake is the half worth being
// careful about. A new worker is never allowed to take over a running page —
// swapping modules under a live app is how you get a half-updated scene and an
// unreproducible bug report. Instead the new worker installs, waits, and the
// caller is handed a function to apply it. The swap then happens against a
// reload, which is the only moment it is safe.
//
// `?sw=off` is the escape hatch. Because Orbit is served from GitHub Pages —
// no response headers, so no Cache-Control lever — a bad worker would
// otherwise be very awkward to recover from. Loading the app once with that
// query string tears the whole thing down: caches cleared, worker
// unregistered, next load served straight from the network.
// ---------------------------------------------------------------------------

// Guards the reload triggered by `controllerchange`. Without it, a worker that
// calls skipWaiting() on activate can bounce the page in a loop.
let reloading = false;

async function nukeServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;

  // Only ever Orbit's own registration. `getRegistrations()` returns every
  // registration for the *origin*, and on GitHub Pages the origin is shared by
  // every project a user publishes — `darkflib.github.io/orbit/`,
  // `.../something-else/`. Unregistering all of them would take another
  // project's offline support down as a side effect of recovering this one.
  // Resolved against the document, not this module: `register('./sw.js')` below
  // is document-relative, so resolving against import.meta.url would look for
  // /src/sw.js and match nothing — leaving the escape hatch quietly inert.
  const ourScript = new URL('./sw.js', document.baseURI).href;
  const regs = (await navigator.serviceWorker.getRegistrations()).filter((reg) => {
    const worker = reg.active ?? reg.waiting ?? reg.installing;
    return worker?.scriptURL === ourScript;
  });

  // Ask the active worker to clean up its own caches first — it owns them and
  // knows their names. Unregistering alone leaves the Cache Storage behind.
  for (const reg of regs) {
    (reg.active ?? reg.waiting ?? reg.installing)?.postMessage({ type: 'KILL' });
  }
  await Promise.all(regs.map((reg) => reg.unregister()));
  // Belt and braces: if the worker was already dead it never got the message,
  // so clear anything of ours still sitting in Cache Storage.
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('orbit-')).map((n) => caches.delete(n)));
  }
}

/**
 * Register the service worker.
 *
 * @param {object} opts
 * @param {(apply: () => void) => void} [opts.onUpdateReady] Called when a new
 *   version has installed and is waiting. Receives the function that applies
 *   it; until that is called the running page keeps the version it booted with.
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
export async function registerServiceWorker({ onUpdateReady } = {}) {
  if (!('serviceWorker' in navigator)) return null;

  if (new URLSearchParams(location.search).get('sw') === 'off') {
    await nukeServiceWorkers();
    return null;
  }

  // A file:// or otherwise insecure context cannot register one, and the
  // resulting exception is noise rather than signal.
  if (!window.isSecureContext) return null;

  let reg;
  try {
    // Relative, so the scope is whatever directory the app is deployed under —
    // an absolute '/sw.js' would 404 on a GitHub Pages project subpath.
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch {
    // Registration failing is not fatal: the app works, it just will not work
    // offline. Nothing here should stop the globe from rendering.
    return null;
  }
  // Not the same case as the throw above. Where service workers are disabled
  // rather than unsupported — enterprise policy, Firefox private browsing, or a
  // Playwright context with `serviceWorkers: 'block'` — `register()` resolves
  // with undefined instead of rejecting, and reading `.waiting` off it throws
  // an uncaught error at boot.
  if (!reg) return null;

  // Whether this page was already under a worker when it loaded. On a first
  // ever visit it is not, and the worker's `clients.claim()` then fires
  // `controllerchange` for the initial hand-off — which is not an update, and
  // reloading on it bounces every new visitor once for no reason.
  const hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  const notify = (worker) => {
    // `controller` is null on the very first load, when the worker is
    // populating its cache for the first time rather than replacing anything.
    // Telling a first-time visitor an update is available would be a lie.
    if (!navigator.serviceWorker.controller) return;
    onUpdateReady?.(() => worker.postMessage({ type: 'SKIP_WAITING' }));
  };

  if (reg.waiting) notify(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') notify(installing);
    });
  });

  return reg;
}
