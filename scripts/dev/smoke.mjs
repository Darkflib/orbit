// ---------------------------------------------------------------------------
// End-to-end smoke run: boots the real app in a real browser and checks the
// things unit tests structurally cannot — that it starts, renders, and responds
// to pointer input on both a desktop and a phone viewport.
//
//   node scripts/dev/smoke.mjs                 # against a locally served app
//   ORBIT_OFFLINE_CDN=1 node scripts/dev/smoke.mjs   # no route to jsDelivr
//
// Needs the app served first (`npm start`) and Playwright available; see
// scripts/dev/README.md. Exits non-zero if any check fails, so it can be wired
// into a pre-release step later if that ever seems worth it.
// ---------------------------------------------------------------------------
import {
  DEFAULT_ORIGIN, installOfflineCdn, stripCsp, stubElementSources,
  seedObserver, collectErrors, makeRecords,
} from './harness.mjs';

const ORIGIN = process.env.ORBIT_ORIGIN || DEFAULT_ORIGIN;
const OFFLINE = process.env.ORBIT_OFFLINE_CDN === '1';

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

// Sandboxes that pre-install Chromium outside the Playwright cache, or pin a
// version other than the one this Playwright expects, can point at it directly.
const browser = await chromium.launch(
  process.env.ORBIT_CHROMIUM ? { executablePath: process.env.ORBIT_CHROMIUM } : {},
);

async function newSession({ viewport, isMobile = false }) {
  const context = await browser.newContext(
    isMobile
      ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport },
  );
  if (OFFLINE) {
    await installOfflineCdn(context);
    await stripCsp(context, ORIGIN);
  }
  await stubElementSources(context, makeRecords(600, { named: ['ISS (ZARYA)'] }));
  const page = await context.newPage();
  const errors = collectErrors(page);
  await seedObserver(page);
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForSelector('#loading.gone', { timeout: 30000 });
  await page.waitForTimeout(2000);
  return { context, page, errors };
}

// --- Desktop ---------------------------------------------------------------
console.log(`\nDesktop 1400x900${OFFLINE ? '  (offline CDN)' : ''}`);
{
  const { context, page, errors } = await newSession({ viewport: { width: 1400, height: 900 } });

  const sats = (await page.locator('#stat-sats').textContent()).trim();
  check('catalogue loads and renders', /[1-9]/.test(sats), sats);

  // Search -> suggestion -> selection. This whole path was a native <datalist>
  // that silently did nothing on iOS, so it is worth exercising every run.
  await page.click('#search');
  await page.type('#search', 'ISS', { delay: 30 });
  await page.waitForTimeout(400);
  const suggestions = await page.locator('#search-results .search-opt').count();
  check('search offers suggestions', suggestions > 0, `${suggestions} shown`);
  if (suggestions) {
    await page.locator('#search-results .search-opt').first().click();
    await page.waitForTimeout(800);
    const name = (await page.locator('#sel-name').textContent()).trim();
    check('selecting a suggestion selects the satellite', name === 'ISS (ZARYA)', name);
  }

  // Sky mode: the star catalogue is fetched lazily on first entry.
  await page.click('#mode-sky');
  await page.waitForTimeout(2500);
  const where = (await page.locator('#sky-where').textContent()).trim();
  check('sky mode anchors to the observer', /\d/.test(where), where);
  const facing = (await page.locator('#sky-facing').textContent()).trim();
  check('sky mode reports a look direction', /\d/.test(facing), facing);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

// --- Mobile ----------------------------------------------------------------
console.log('\nMobile 412x839 (touch)');
{
  const { context, page, errors } = await newSession({
    viewport: { width: 412, height: 839 }, isMobile: true,
  });
  await page.click('#mode-sky');
  await page.waitForTimeout(2000);

  // Chrome coverage as a share of the viewport. This regressed to 87% once,
  // leaving 13% for the thing the app exists to show, so it is pinned.
  const uiPct = await page.evaluate(() => {
    const boxes = ['#topbar', '#panel-left', '#panel-right', '#timebar']
      .map((s) => document.querySelector(s))
      .filter((e) => e && getComputedStyle(e).display !== 'none' && !e.classList.contains('hidden'))
      .map((e) => e.getBoundingClientRect());
    let covered = 0;
    let total = 0;
    for (let y = 0; y < innerHeight; y += 4) {
      for (let x = 0; x < innerWidth; x += 4) {
        total++;
        if (boxes.some((b) => x >= b.left && x < b.right && y >= b.top && y < b.bottom)) covered++;
      }
    }
    return Math.round((covered / total) * 100);
  });
  check('chrome leaves most of the screen for the sky', uiPct < 35, `${uiPct}% chrome at rest`);

  const topbarFits = await page.evaluate(
    () => document.getElementById('topbar').scrollWidth <= innerWidth,
  );
  check('topbar fits the viewport', topbarFits);

  // Sheets start collapsed; the header is the handle.
  await page.locator('#panel-left .panel-header').tap();
  await page.waitForTimeout(500);
  const opened = await page.evaluate(
    () => !document.getElementById('panel-left').classList.contains('collapsed'),
  );
  check('tapping a sheet header expands it', opened);

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
