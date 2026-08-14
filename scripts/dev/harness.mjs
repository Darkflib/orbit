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
//
// One trap worth knowing before you write a driver: a registered service worker
// makes the page's fetches on its behalf, and those do NOT pass through
// `context.route()`. Any driver relying on `stubElementSources` therefore needs
// `serviceWorkers: 'block'` on the context, or the stubs are silently bypassed
// and the run quietly boots against the real network. smoke.mjs blocks;
// offline.mjs allows, because there the worker is the thing under test.
// ---------------------------------------------------------------------------
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');

export const DEFAULT_ORIGIN = 'http://127.0.0.1:8080';

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
