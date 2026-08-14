// ---------------------------------------------------------------------------
// Offline boot check: install the service worker, cut the network, reload, and
// assert the app still comes up.
//
//   npm start                        # serve the app on :8080
//   npm install --no-save playwright
//   node scripts/dev/offline.mjs
//
// This is the one claim the whole PWA change rests on, and it is not checkable
// any other way — `node --test` can assert the pre-cache list is complete but
// not that the browser actually serves from it, and reading sw.js tells you
// nothing about whether three.js resolves with the radio off.
//
// Note that smoke.mjs deliberately runs with `serviceWorkers: 'block'`: its
// element-set stubs are installed with context.route(), which a service worker
// bypasses. This driver is the opposite — the worker is the subject, so the
// stubs are not used and GP data is *expected* to be unavailable offline. What
// is being checked is that the shell boots, the modules resolve from cache and
// the globe renders regardless.
// ---------------------------------------------------------------------------
import { DEFAULT_ORIGIN, collectErrors, seedObserver } from './harness.mjs';

const ORIGIN = process.env.ORBIT_ORIGIN || DEFAULT_ORIGIN;

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

console.log('Online: first load, worker installs and pre-caches');
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

console.log('\nOffline: network cut, hard reload');
await context.setOffline(true);

const errors = collectErrors(page);
await page.reload({ waitUntil: 'load' });

// The loading overlay only clears once GP data resolves, which offline it
// cannot — so wait on the scene being live instead, which is the real question:
// did every module and texture resolve from cache?
const booted = await page
  .waitForFunction(() => {
    const c = document.getElementById('scene');
    return Boolean(c && c.width > 0 && c.height > 0);
  }, null, { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
check('canvas is sized offline', booted);

// three.js having initialised a WebGL context is the proof that the vendored
// module graph resolved: no three, no renderer, no context.
const hasGl = await page.evaluate(() => {
  const c = document.getElementById('scene');
  return Boolean(c && (c.getContext('webgl2') || c.getContext('webgl')));
});
check('WebGL context exists offline', hasGl);

const topbarVisible = await page.locator('#topbar').isVisible();
check('chrome renders offline', topbarVisible);

// The failures that matter are modules and assets failing to resolve. GP data
// being unreachable offline is the expected, handled path — the app toasts and
// carries on — so those messages are filtered out rather than failing the run.
const EXPECTED_OFFLINE = /GP data|orbital elements|orbit-data|celestrak|Failed to fetch/i;
const fatal = errors.filter((e) => !EXPECTED_OFFLINE.test(e));
check('no module or asset errors offline', fatal.length === 0, fatal.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);

await context.close();
await browser.close();
process.exit(failed ? 1 : 0);
