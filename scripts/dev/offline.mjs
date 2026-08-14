// ---------------------------------------------------------------------------
// Offline boot check: install the service worker, take the server away, reload,
// and assert the app still comes up.
//
//   npm install --no-save playwright
//   node scripts/dev/offline.mjs        # starts and stops its own server
//
// This is the one claim the whole PWA change rests on, and it is not checkable
// any other way — `node --test` can assert the pre-cache list is complete but
// not that the browser serves from it, and reading sw.js tells you nothing
// about whether three.js resolves with the radio off.
//
// This driver owns its server, which is the entire point and was learned the
// hard way. Two mechanisms that look like they simulate offline do not:
//
//   - `context.setOffline(true)` applies to the page's network stack, not the
//     service worker's. The worker's own `fetch()` kept reaching the server, so
//     an earlier version of this file reported 6/6 while the app was fully
//     online and the pre-cache was never read at all.
//   - Chromium's HTTP cache will happily serve the modules and textures even
//     when the page is "offline", covering for a worker that returns nothing.
//
// Stopping the server removes both. Nothing can serve the app but Cache
// Storage, which is what the claim actually is.
//
// Note also that smoke.mjs deliberately runs with `serviceWorkers: 'block'`:
// its element-set stubs are installed with context.route(), which a worker
// bypasses for the same underlying reason. Here the worker is the subject, so
// nothing is stubbed and GP data is legitimately unavailable once the server
// is gone.
// ---------------------------------------------------------------------------
import { createOrbitServer } from '../../serve.mjs';
import { REPO_ROOT, collectErrors, seedObserver } from './harness.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. It is deliberately not a dependency:\n'
    + '  npm install --no-save playwright');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Port 0: let the OS pick, so a run never collides with a dev server the
// operator already has on 8080 (and never accidentally tests against it).
// The port is reused when the server comes back for the kill-switch phase, so
// the origin — and therefore the registration and its caches — stays the same.
async function startServer(port = 0) {
  const server = createOrbitServer(REPO_ROOT);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

async function stopServer(server) {
  // closeAllConnections is what makes this immediate — close() alone stops new
  // connections and leaves keep-alive sockets perfectly usable.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

let server = await startServer();
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch(
  process.env.ORBIT_CHROMIUM ? { executablePath: process.env.ORBIT_CHROMIUM } : {},
);

// A phone viewport, since installing is a phone-shaped thing to do.
const context = await browser.newContext({
  viewport: { width: 412, height: 839 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  serviceWorkers: 'allow',
});
const page = await context.newPage();
await seedObserver(page);

console.log(`Online (${ORIGIN}): first load, worker installs and pre-caches`);
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });

// `ready` resolves once a worker is active, and install's waitUntil holds
// activation until cache.addAll() has resolved — so an active worker means the
// pre-cache is populated, with no polling needed.
const activated = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return Boolean(reg.active);
});
check('service worker activates', activated);

const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const shell = names.find((n) => n.startsWith('orbit-shell-'));
  if (!shell) return 0;
  return (await (await caches.open(shell)).keys()).length;
});
check('shell cache is populated', cached > 25, `${cached} entries`);

console.log('\nOffline: server stopped, HTTP cache disabled, reload');
// Belt and braces. Stopping the server is what makes this real, but disabling
// the HTTP cache means a pass cannot be credited to a warm disk cache either.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await stopServer(server);

const errors = collectErrors(page);
const failedUrls = [];
page.on('requestfailed', (r) => failedUrls.push(r.url()));
await page.reload({ waitUntil: 'load' }).catch(() => {});

// The loading overlay only clears once GP data resolves, which offline it
// cannot — so wait on the UI main.js builds instead. Checking the canvas is not
// enough: a canvas exists in the HTML whether or not any script ran, and
// getContext() will happily create a context on a blank one, so both "pass" on
// a page where nothing booted.
const booted = await page
  .waitForFunction(
    () => document.querySelectorAll('#speed-btns *').length > 0
      && document.querySelectorAll('#layers *').length > 0,
    null,
    { timeout: 20000 },
  )
  .then(() => true)
  .catch(() => false);
check('app boots from cache with no server', booted);

const built = await page.evaluate(() => ({
  layers: document.querySelectorAll('#layers *').length,
  speeds: document.querySelectorAll('#speed-btns *').length,
  buffer: `${document.getElementById('scene').width}x${document.getElementById('scene').height}`,
}));
check(
  'scene and controls are really constructed',
  built.speeds > 0 && built.layers > 0 && built.buffer !== '300x150',
  `${built.layers} layer nodes, ${built.speeds} speeds, ${built.buffer} buffer`,
);

// Only same-origin failures are interesting. The element-set fetches to the
// mirror and to CelesTrak are *expected* to fail with no network — that is the
// handled path — and they are cross-origin, so compare origins rather than
// pattern-matching paths, which quietly misfiled /v1/gp/*.json as our own.
const sameOriginFailures = failedUrls
  .filter((u) => u.startsWith(ORIGIN))
  .map((u) => new URL(u).pathname)
  .filter((p) => p !== '/');
check(
  'no same-origin request went unserved',
  sameOriginFailures.length === 0,
  sameOriginFailures.slice(0, 5).join(', '),
);

// GP data being unreachable is the expected, handled path — the app toasts and
// carries on — so those messages are filtered rather than failing the run.
//
// Deliberately narrow: an earlier version also excused a bare "Failed to fetch"
// and any "ERR_", which is exactly the text a *module* or *texture* failing to
// load produces. That would have excused the very failure this check exists to
// catch. Only messages naming a GP source are forgiven; the unserved-request
// check above is what covers same-origin assets, by URL rather than by message.
const EXPECTED_OFFLINE = /GP data|orbital elements|orbit-data|celestrak/i;
const fatal = errors.filter((e) => !EXPECTED_OFFLINE.test(e));
check('no module or asset errors offline', fatal.length === 0, fatal.slice(0, 3).join(' | '));

// The kill switch, exercised against the worker directly rather than through
// `?sw=off`. That route also clears caches and unregisters from the page side
// as belt and braces, so it would pass whether or not the worker honoured the
// message — which would hide a broken origin check in sw.js's message handler.
// The server comes back for this phase. The KILL handler finishes by navigating
// every window client, which tears down the execution context an in-page poll
// would be running in — so the poll has to survive a reload, and with no server
// the reload it triggers cannot complete at all. Restoring the origin first
// makes the observation stable and still exercises the real code path.
console.log('\nKill switch (server restored)');
server = await startServer(PORT);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
await page.reload({ waitUntil: 'load' });
await page.evaluate(() => navigator.serviceWorker.ready);

// Driven through `?sw=off`, which is the route a user in trouble is actually
// told to use, rather than by posting KILL at the worker directly.
//
// Posting directly looks like the purer unit test and is not: the handler ends
// by navigating its window clients back to `client.url`, and for a page loaded
// *without* `?sw=off` that reload re-runs registerServiceWorker, which installs
// a fresh worker and repopulates the caches within a second. The teardown is
// real; watching for it from the page just races the re-registration and reads
// as a failure. With the flag in the URL the reload takes the early-return path
// in pwa.js instead, so the torn-down state is the one that persists.
await page.goto(`${ORIGIN}/?sw=off`, { waitUntil: 'load' });

// Polled with a fresh evaluate each time, so the navigation the handler
// triggers cannot destroy the poll along with the page.
let killed = false;
for (let i = 0; i < 40 && !killed; i++) {
  killed = await page
    .evaluate(async () => {
      const names = await caches.keys();
      const regs = await navigator.serviceWorker.getRegistrations();
      return names.every((n) => !n.startsWith('orbit-')) && regs.length === 0;
    })
    .catch(() => false);
  if (!killed) await page.waitForTimeout(250);
}
check('?sw=off clears the caches and unregisters the worker', killed);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);

await context.close();
await browser.close();
await stopServer(server);
process.exit(failed ? 1 : 0);
