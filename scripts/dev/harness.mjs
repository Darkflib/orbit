// ---------------------------------------------------------------------------
// Browser harness for driving the app in a real engine.
//
// The app has no build step and most of it is DOM, WebGL and pointer
// behaviour, so a large class of defect is invisible to `node --test` and to
// reading a diff. Ones this harness has caught: points rendered at half size on
// 2x displays, labels that grew without bound on zoom, a native <datalist> that
// renders no suggestion UI at all on iOS, a swipe that selected instead of
// scrolling, 87% of a phone viewport covered by chrome, and two boot failures
// where a const was reached from the boot path while still in its temporal dead
// zone. None of those show up in a unit test.
//
// This is dev tooling, not CI: `node --test` will not pick these files up (they
// are not *.test.mjs and not under test/), and Playwright is deliberately NOT a
// devDependency so `npm ci` stays small. See scripts/dev/README.md.
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
const NODE_MODULES = join(REPO_ROOT, 'node_modules');

export const DEFAULT_ORIGIN = 'http://127.0.0.1:8080';

// 1x1 transparent PNG, standing in for the Earth textures when they cannot be
// fetched. The globe renders an odd colour without them; that is expected and
// says nothing about the code under test.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Pinned dependency versions are read from the page's own import map rather
// than duplicated here, so bumping a version in index.html cannot silently
// leave the harness mapping a URL the app no longer requests.
export async function readImportMap() {
  const html = await readFile(join(REPO_ROOT, 'index.html'), 'utf8');
  const block = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!block) throw new Error('no import map found in index.html');
  return JSON.parse(block[1]).imports;
}

// Where each import-map entry lives inside node_modules. Keyed by bare
// specifier so a version bump needs no change here either.
const LOCAL_EQUIVALENT = {
  'three': 'three/build/three.module.js',
  'three/addons/': 'three/examples/jsm/',
  'satellite.js': 'satellite.js/dist/index.js',
  'astronomy-engine': 'astronomy-engine/esm/astronomy.js',
};

// The installed package must be the *pinned* version, not merely present.
//
// Learned the hard way: `npm install --no-save three` pulls the current
// release, whose build layout differs from the pinned 0.160.0 — three.module.js
// now re-exports from a sibling three.core.js, which the import map knows
// nothing about, so the route returned 404 and the page hung on the loading
// overlay with no clue as to why. Fail loudly here instead.
async function assertVersionsMatchImportMap(imports) {
  const wrong = [];
  for (const specifier of Object.keys(LOCAL_EQUIVALENT)) {
    const cdnUrl = imports[specifier];
    if (!cdnUrl) continue;
    const pinned = cdnUrl.match(/\/npm\/(?:@[^/]+\/)?[^@/]+@([^/]+)/)?.[1];
    if (!pinned) continue;
    const pkg = specifier.replace(/\/$/, '').split('/')[0];
    let installed;
    try {
      installed = JSON.parse(
        await readFile(join(NODE_MODULES, pkg, 'package.json'), 'utf8'),
      ).version;
    } catch {
      continue; // the existence check above already reports this case
    }
    if (installed !== pinned) wrong.push({ pkg, pinned, installed });
  }
  if (wrong.length) {
    throw new Error(
      'offline CDN mode needs the versions index.html pins, but node_modules has:\n'
      + wrong.map((w) => `  ${w.pkg}: ${w.installed} installed, ${w.pinned} pinned`).join('\n')
      + '\nInstall the pinned ones:\n'
      + wrong.map((w) => `  npm install --no-save ${w.pkg}@${w.pinned}`).join('\n'),
    );
  }
}

// Serve the CDN modules from node_modules.
//
// Only needed where cdn.jsdelivr.net is unreachable — a locked-down CI runner
// or sandbox — in which case the page cannot boot at all. On a normal machine
// leave this off: exercising the real CDN and the real CSP is the more faithful
// test, and stripping the CSP (which this mode has to do, see below) would hide
// CSP regressions.
export async function installOfflineCdn(context) {
  const imports = await readImportMap();
  const missing = [];

  // Map a requested CDN URL back to a file, via whichever import-map entry it
  // came from.
  const resolve = (url) => {
    for (const [specifier, cdnUrl] of Object.entries(imports)) {
      const local = LOCAL_EQUIVALENT[specifier];
      if (!local) continue;
      if (specifier.endsWith('/')) {
        // Directory mapping (three/addons/ -> examples/jsm/): keep the tail.
        if (url.startsWith(cdnUrl)) return join(NODE_MODULES, local, url.slice(cdnUrl.length));
      } else if (url === cdnUrl) {
        return join(NODE_MODULES, local);
      }
    }
    // satellite.js's ESM entry has relative imports to siblings, which resolve
    // against the CDN URL and so come back here as separate requests.
    const sat = url.match(/satellite\.js@[^/]+\/(.+)$/);
    if (sat && !sat[1].startsWith('+')) return join(NODE_MODULES, 'satellite.js/dist', sat[1]);
    return null;
  };

  for (const [specifier, local] of Object.entries(LOCAL_EQUIVALENT)) {
    if (!existsSync(join(NODE_MODULES, local))) missing.push(specifier);
  }
  if (missing.length) {
    throw new Error(
      `offline CDN mode needs these installed locally: ${missing.join(', ')}\n`
      + '  npm install --no-save three@<pinned version>\n'
      + '(satellite.js and astronomy-engine are already devDependencies)',
    );
  }
  await assertVersionsMatchImportMap(imports);

  await context.route('**cdn.jsdelivr.net/**', async (route) => {
    const url = route.request().url();
    if (/\.(png|jpe?g|webp)(\?|$)/i.test(url)) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG });
    }
    const file = resolve(url);
    if (!file) return route.fulfill({ status: 404, body: `unmapped: ${url}` });
    try {
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
        body: await readFile(file, 'utf8'),
      });
    } catch (err) {
      return route.fulfill({ status: 404, body: `unreadable ${file}: ${err.message}` });
    }
  });
}

// Offline mode also has to drop the page's CSP. The propagation worker imports
// satellite.js straight from the CDN, and a route-fulfilled response in a worker
// context is refused under the page policy — the worker never starts and every
// satellite sits at the origin. Only ever paired with installOfflineCdn, so the
// default run still exercises the real policy.
export async function stripCsp(context, origin = DEFAULT_ORIGIN) {
  await context.route(`${origin}/`, async (route) => {
    const res = await route.fetch();
    const html = (await res.text())
      .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
}

// Deterministic OMM records. Real element sets would make every run depend on
// the network and on whatever is in orbit today; these are shaped like the real
// thing and spread over enough inclinations and RAANs that a useful number sit
// above any given horizon.
export function makeRecords(count = 600, { named = [] } = {}) {
  const epoch = new Date().toISOString().replace('Z', '');
  return Array.from({ length: count }, (_, i) => ({
    OBJECT_NAME: named[i] ?? `TESTSAT-${i}`,
    NORAD_CAT_ID: 90000 + i,
    OBJECT_ID: `2026-${String(i).padStart(3, '0')}A`,
    EPOCH: epoch,
    MEAN_MOTION: 15.5 - (i % 7) * 0.35,
    ECCENTRICITY: 0.0004 + (i % 5) * 0.0002,
    INCLINATION: [51.6, 53.0, 70.0, 86.4, 97.6][i % 5],
    RA_OF_ASC_NODE: (i * 13.7) % 360,
    ARG_OF_PERICENTER: (i * 37.1) % 360,
    MEAN_ANOMALY: (i * 53.3) % 360,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    ELEMENT_SET_NO: 999,
  }));
}

// Serve the element sets from both the static mirror and the CelesTrak
// fallback, so a run is fast, deterministic and unaffected by either being down.
export async function stubElementSources(context, records = makeRecords()) {
  const body = JSON.stringify(records);
  for (const pattern of ['**orbit-data.mikepreston.org/**', '**celestrak.org/**']) {
    await context.route(pattern, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body,
    }));
  }
}

// Kegworth — the observer the project's pass validation uses throughout.
export const REFERENCE_OBSERVER = { lat: 52.8306, lon: -1.2833, altKm: 0 };

export async function seedObserver(page, observer = REFERENCE_OBSERVER) {
  await page.addInitScript((o) => {
    localStorage.setItem('orbit.observer', JSON.stringify(o));
  }, observer);
}

// Collects page errors and console errors for assertion at the end of a run.
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}
