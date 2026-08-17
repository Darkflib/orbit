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

node scripts/dev/smoke.mjs       # boots, renders, responds to input
node scripts/dev/offline.mjs     # installs the worker, cuts the network, reloads
```

Environment:

| Variable | Purpose |
|---|---|
| `ORBIT_ORIGIN` | Where the app is served. Default `http://127.0.0.1:8080`. |
| `ORBIT_CHROMIUM` | Explicit Chromium path, for sandboxes that pre-install it outside Playwright's cache. |

There used to be an `ORBIT_OFFLINE_CDN=1` mode that routed the import-map
modules to `node_modules`, for runners with no path to jsDelivr. It is gone:
the libraries and Earth textures are vendored under `vendor/` and served from
the app's own origin, so every run is already offline in that sense — and,
unlike the old mode, exercises the real CSP rather than stripping it.

## Service workers and request interception

`context.route()` does **not** intercept requests a service worker makes on the
page's behalf. This matters more than it sounds:

- `smoke.mjs` stubs the element sources with `stubElementSources`, so it sets
  `serviceWorkers: 'block'`. Without that the stubs are bypassed, the run boots
  against the real network, and the symptom is `0 satellites` plus three opaque
  `ERR_FAILED`s with nothing pointing at the worker.
- `offline.mjs` sets `serviceWorkers: 'allow'`, because there the worker *is*
  the subject. It does not stub anything, so GP data is legitimately
  unavailable once the network is cut; what it asserts is that the shell, the
  vendored module graph and the textures all resolve from the pre-cache.

## Writing your own

`harness.mjs` is the reusable part; `smoke.mjs` is one driver built on it.

```js
import {
  DEFAULT_ORIGIN, stubElementSources,
  seedObserver, collectErrors, makeRecords, REFERENCE_OBSERVER,
} from './harness.mjs';
```

`stubElementSources` serves deterministic OMM records from the static mirror —
the only origin the app fetches elements from — so a run is fast and unaffected
by the mirror being down. It also routes `celestrak.org` to an aborted request
rather than to stub data, so a regression that reintroduced a direct upstream
fetch shows up as an error instead of passing silently.
`seedObserver` writes the Kegworth reference location into
`localStorage` before any script runs, which Sky mode needs.

Ad-hoc drivers are worth writing for anything visual — measure the thing you
are claiming, rather than eyeballing a screenshot. Every layout claim in the
worklog came from a driver that asserted geometry (edges aligned, widths equal,
coverage percentages) rather than from looking at a picture.
