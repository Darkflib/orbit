# Browser harness

Dev tooling for driving the app in a real browser engine. **Not part of CI** —
`node --test` does not pick these files up, and Playwright is deliberately not a
dependency so `npm ci` stays small.

## Why this exists

The app has no build step, and most of it is DOM, WebGL and pointer behaviour.
A large class of defect is therefore invisible both to `node --test` and to
reading a diff. Real examples this harness caught, none of which a unit test
could have:

- `gl_PointSize` is in framebuffer pixels, so every star and satellite rendered
  at **half size on a 2× display**.
- World-scaled text labels **grew without bound on zoom** until one star name
  filled the screen.
- A native `<datalist>` renders **no suggestion UI at all on iOS**, so the
  search box silently did nothing on a phone.
- Committing a suggestion on `pointerdown` made the results list **impossible to
  scroll on touch** — the first touch of a swipe selected whatever was under the
  finger.
- Panels and bars covered **87% of a phone viewport**.
- Two boot failures where a `const` was reached from the boot path while still
  in its temporal dead zone — the page died before first paint.

## Running it

```bash
npm start                        # serve the app on :8080
npm install --no-save playwright # not a dependency; install when you need it

node scripts/dev/smoke.mjs
```

Environment:

| Variable | Purpose |
|---|---|
| `ORBIT_ORIGIN` | Where the app is served. Default `http://127.0.0.1:8080`. |
| `ORBIT_OFFLINE_CDN=1` | Serve the import-map modules from `node_modules` instead of jsDelivr. |
| `ORBIT_CHROMIUM` | Explicit Chromium path, for sandboxes that pre-install it outside Playwright's cache. |

## Offline mode

Only needed where `cdn.jsdelivr.net` is unreachable — a locked-down runner or
sandbox — in which case the page cannot boot at all. It maps each import-map
entry to its `node_modules` equivalent, reading the pinned versions **from
`index.html` itself** so bumping a version cannot leave the harness mapping a
URL the app no longer requests.

```bash
# satellite.js and astronomy-engine are already devDeps at the pinned versions.
npm install --no-save playwright three@0.160.0
ORBIT_OFFLINE_CDN=1 node scripts/dev/smoke.mjs
```

Two things about that install line, both learned by tripping over them:

- **Install everything in one command.** `npm install --no-save` reconciles the
  tree against `package.json` afterwards, so a second `--no-save` install prunes
  whatever the first one added. Installing Playwright on its own silently
  removed `three`.
- **The version must be the pinned one**, not just `three`. Current releases
  split `three.module.js` into a sibling `three.core.js` that the import map
  knows nothing about, so the route 404s and the page hangs on the loading
  overlay with nothing in the console to explain it. `installOfflineCdn` now
  compares `node_modules` against the import map and fails with the exact
  install command instead.

Two caveats, both deliberate:

- Offline mode also **strips the page CSP**. The propagation worker imports
  satellite.js straight from the CDN, and a route-fulfilled response in a worker
  context is refused under the page policy — the worker never starts and every
  satellite sits at the origin. So offline runs do *not* exercise the real CSP;
  the default run does, which is why it is the default.
- Earth textures are replaced with a blank pixel, so the globe renders an odd
  flat colour. That is expected and says nothing about the code.

## Writing your own

`harness.mjs` is the reusable part; `smoke.mjs` is one driver built on it.

```js
import {
  installOfflineCdn, stripCsp, stubElementSources,
  seedObserver, collectErrors, makeRecords, REFERENCE_OBSERVER,
} from './harness.mjs';
```

`stubElementSources` serves deterministic OMM records from both the static
mirror and the CelesTrak fallback, so a run is fast and unaffected by either
being down. `seedObserver` writes the Kegworth reference location into
`localStorage` before any script runs, which Sky mode needs.

Ad-hoc drivers are worth writing for anything visual — measure the thing you
are claiming, rather than eyeballing a screenshot. Every layout claim in the
worklog came from a driver that asserted geometry (edges aligned, widths equal,
coverage percentages) rather than from looking at a picture.
