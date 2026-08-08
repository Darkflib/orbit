# Worklog — data enrichment & visibility

## 2026-08-08 — Sky mode follow-ups: device orientation, constellations, picking

The three follow-ups the sky view left open, closed together.

### Device orientation — the reason the view is 3D
`setOrientation` was built as the single seam every camera driver goes through;
this adds the second driver. It sets the camera quaternion **directly** rather
than going through `lookAt`, which matters twice over: it carries roll (tilt the
phone and the sky tilts with it), and it is free of the ±89.5° pitch clamp an
up-vector camera needs — pointing straight up is the whole gesture, so it must
not hit a stop.

The rotation composition lives in `skyframe.js` as **plain arithmetic, not
three.js Quaternions**, specifically so the frame convention is unit-testable in
Node. A sign error here points the entire sky the wrong way and the only symptom
is that it looks subtly wrong on a phone — not something to debug on hardware.
The tests state the convention physically: *hold the device like this, you must
be looking there*.

- `deviceorientationabsolute` where available (Earth-referenced); plain
  `deviceorientation` only where it proves to be absolute. **Whether the plain
  event is Earth-referenced cannot be feature-detected** — it can only be read
  off an actual event (`webkitCompassHeading`, or the spec's `absolute` flag) —
  so enabling now waits for one real event and declines if it turns out to be
  relative. Committing without that check is worse than not offering the
  feature: a relative alpha anchors the sky to whichever way the phone happened
  to face when the listener attached, while the UI claims the compass is live
  and drag is disabled. Silently wrong, with nothing to tell the user.
  (Caught in review by Codex on PR #21 — the first draft documented this
  intent in the worklog but only implemented the `deviceorientationabsolute`
  half, so every non-absolute browser would have taken the bad path.)
- iOS 13+ permission is requested from the click handler, since it needs a user
  gesture.
- Drag is inert while the sensors drive, and leaving Sky mode releases the
  listener.
- **Not corrected: magnetic declination.** These APIs report magnetic north —
  under 2° off in the UK, 20°+ at high latitudes. Fixing it needs a geomagnetic
  model (WMM/IGRF). The panel says so rather than quietly being wrong.

### Constellation figures — a correction to the earlier plan
The previous entry called this "data already in the enrichment pipeline". **That
was wrong**, and worth recording: `scripts/enrich/constellations.mjs` is about
*satellite* constellations (Starlink, GNSS magnitude fallback). The star
catalogue's Bayer field ("9Alp CMa") gives constellation *membership* but says
nothing about which star joins which.

Figure lines are a human convention with no authoritative catalogue — the IAU
standardised constellation *boundaries* (Delporte, 1930), never the stick
figures — so they had to come from a source that made an editorial choice.
Vendored from **d3-celestial (Olaf Frohn), BSD-3-Clause**, which is compatible
with this project's MIT licence; the licence text is vendored beside the data
and attribution is in `SOURCES.md`.

Wired through the existing pipeline exactly as BSC5 was: vendored file →
`sources/constellation-figures.mjs` → `writeConstellations` →
`data/sky/constellations.json` (88 constellations, 743 segments, 17 KB). Drawn
as a single `LineSegments` sharing the stars' per-frame rotation matrix, so the
lines cannot drift off the stars they connect. Toggleable, and faint by design.

### Picking
Sky mode now raycasts against its own point cloud instead of declining to guess.
The sky vertices are index-parallel with the satellite field, so a hit index is
a field index. Two details that matter: hidden points keep their last position
in the buffer, so the size flag decides what is really on screen; and since
everything sits on one sphere, ray distance barely separates candidates —
angular distance from the ray is the meaningful sort. A ring marks the selection,
matching the Earth view's marker.

### Verified
Suite **61** (was 57), all passing. New tests cover the device-orientation
convention (compass bearings, pitch, screen rotation not moving the view, and
the quaternion being a unit rotation).

Driven in Chromium again, which is where the end-to-end behaviour was confirmed:
- Synthesised sensor events map exactly as specified — α=0→N, 90→**W**, 180→S,
  270→**E** (alpha runs counter-clockwise, azimuth clockwise), β=175 reaching
  85° where drag mode would clamp.
- Drag verified inert while sensor-driven, and working again after release.
- A click 245 px left and 25 px above centre while facing S 180°/30° selected a
  satellite the panel independently placed at **SSE 159°, elevation 30°** —
  matching the projected direction to a couple of degrees, which is the real
  test that the pick and the physics agree.
- Constellation figures land on their stars (Altair on Aquila, Fomalhaut on
  Piscis Austrinus) and the toggle clears them.

### Follow-ups
- **Magnetic declination** (above) — the one known inaccuracy in the sensor path.
- **Smoothing.** Raw sensor output is jittery on real hardware; a low-pass filter
  on the quaternion is likely wanted, but is better tuned against a real device
  than guessed at.
- **Star colour.** `stars.json` still carries no B−V, so every star is white.

## 2026-08-08 — Sky mode: the observer view, in 3D

The renderer the previous three PRs were building toward. A third view mode
beside Tracker and Reentry that stands the camera at the observer's location and
looks up: stars, the Sun/Moon/planets, and every satellite currently above the
horizon, all moving with the simulation clock.

### 3D, not a 2D all-sky chart — and why that decision drove the frame
A flat alt/az chart would have been less work, but the intent is to drive the
camera from **phone orientation sensors** later (Google Sky Map style). That
makes the native coordinate frame the important choice, not the projection:
`deviceorientation` reports against gravity and magnetic north, which *is* the
horizontal frame. Building the scene in alt/az means the sensor driver becomes a
quaternion handed to the camera, with no change of basis anywhere. A chart would
have had to be torn up to get there.

Every camera driver therefore goes through one seam — `setOrientation` — which
pointer-drag calls today and a sensor handler is meant to call tomorrow.

### What landed
- **`src/skyframe.js` — the local sky frame, render-free.** Fixes the
  convention (+X east, +Y zenith, −Z north; azimuth clockwise from north,
  matching `visibility.js`) and provides `altAzToVec` / `vecToAltAz`, the
  Astronomy-Engine-horizontal relabelling, a scene→sky transform for satellites,
  and a scene-frame Earth-shadow test. No three.js, so it unit-tests in Node
  alongside the rest of the physics.
- **`src/celestial.js` — batched star transform.** `starAltAz` recomputes
  precession + nutation per star, which depends only on the instant. The new
  `starVectorEqj` / `eqjToHorRotation` / `rotateEqjToHor` hoist that out: one
  matrix per frame, nine multiplies per star, so the ~900-star catalogue moves
  every frame for nothing. This path is airless by construction — noted in the
  source, since refraction only matters within a degree of the horizon.
- **`src/skyview.js` — the scene.** Shares the Earth view's renderer and canvas
  (one WebGL context); the render loop just picks which scene/camera pair to
  draw. Stars sized by magnitude, Sun/Moon/planets as sprites, an **opaque
  ground plane** so below-horizon objects are occluded by depth rather than by
  per-object tests, horizon ring, cardinal markers, and constant-screen-size
  labels.
- **Satellites cost almost nothing.** The propagation worker already publishes
  scene-frame ECEF for the whole field each tick, so the overlay is one rotation
  per object — no extra SGP4. Objects in Earth's shadow are dimmed rather than
  hidden, because "which of these could I actually see" is the point of the view.
- **Tracker and Sky share a dataset**, so switching between them no longer
  refetches ~12k element sets (`datasetFor`).

No new dependencies and **no CSP change** — three and astronomy-engine were
already in the import map, so the `test/csp.test.mjs` hash guard still passes.

### Verified — `test/skyframe.test.mjs` (11 new tests, suite now 57)
Cross-checks between independent paths, not values this code produced:
- **Scene→sky look angles vs `visibility.js`** over four observers × five
  satellite positions: the hand-rolled ENU basis and satellite.js's
  `ecfToLookAngles` agree on altitude, azimuth and range to **< 1e-6**. This is
  what catches an axis swap or sign flip in the frame relabelling.
- **Batched EQJ→HOR vs `starAltAz`** (airless) across three observers and five
  stars, to < 1e-6; plus a rigid-rotation check (Sirius–Vega separation
  preserved to 1e-12).
- **`isSunlitScene` vs `visibility.js` `satSunlit`** — same shadow model in the
  other frame, so this validates the frame conversion.
- Cardinal axis mapping, alt/az round-trips, zenith placement, unit directions.

### Verified in a browser
Driven headless with Playwright (CDN and CelesTrak stubbed — neither is
reachable from the dev sandbox). Beyond "no console errors", the sky was checked
for astronomical sense at 52.83 N:
- **2026-08-08 ~11:52 UTC** (near local noon): Sun high in the south with
  **Regulus** beside it — correct for August — and Mercury close by.
- **~23:57 UTC**: **Fomalhaut** low in the south (dec −29.6°, culminates ~7.6°
  from this latitude) and **Altair + Vega** high overhead — the Summer Triangle.

Three defects were found only by looking at it, and fixed: labels scaled in
world space grew without bound on zoom (now constant screen size, recomputed
from the field of view); stars were too faint; and `gl_PointSize` is in
framebuffer pixels, so every point would have rendered at half size on a 2x
display.

### Follow-ups
- **Device orientation.** The reason for 3D. `setOrientation` is the seam; a
  sensor driver wants a quaternion path that bypasses `lookAt` (and so the
  ±89.5° pitch clamp the up-vector camera needs).
- **Constellation lines.** The data already flows through the enrichment
  pipeline and is never drawn — the thinnest remaining piece of the sky view.
- **Picking in sky mode.** Clicking currently does nothing there: the existing
  raycast is against the Earth scene's camera and point cloud, so it would
  select whatever sat under the cursor in the hidden view. It is explicitly
  skipped rather than left to guess; sky picking needs its own raycast.
- **Star colour.** `stars.json` carries no B−V, so every star renders white.
## 2026-08-05 — Deploy race: `static.yml` was overwriting fresh enrichment data

`static.yml` uploads the whole tree (`path: '.'`) on every push to `main`, and
`enrich.yml` never commits its freshly built `data/` back to `main` — it deploys
it and publishes a copy to the orphan `enrichment-data` branch. The committed
`data/` was therefore a permanently stale seed, and *any* code or docs push
re-deployed it over the live site, rolling the catalogue back until the next
daily enrich run.

The shared `concurrency: pages` group made the two deploys serialise, which is
why this looked handled. Ordering was never the problem: whenever `static.yml`
ran it shipped stale data, regardless of when it ran relative to enrich.

### What landed
- **`static.yml` overlays `data/` from `enrichment-data` before uploading**, so a
  code-only deploy carries the newest published catalogue instead of the seed. It
  falls back to the committed seed when the branch is absent or carries no
  `data/manifest.json`, and only drops the seed once the replacement tree is
  confirmed present — a first deploy or a broken branch still ships working data
  rather than none.
- **`enrich.yml` no longer reports a failed push as "no enrichment change".** The
  old `commit && push || echo` swallowed push failures as a clean no-op. That was
  tolerable when the branch was just a history log; now that it feeds static
  deploys, the step tests the staged diff so a genuine no-op and a failed push are
  distinguishable in the log. It stays `continue-on-error` — getting fresh data
  onto the site matters more than recording it, and the next run repairs the branch.
- **`sync-data-seed.yml` (new) fast-forwards the committed seed monthly** from
  `enrichment-data`. The seed still matters for local dev (`node serve.mjs` on a
  fresh clone) and as `static.yml`'s fallback, so letting it drift forever was the
  remaining weakness. It refuses to move the seed backwards (ISO-timestamp compare,
  so a rolled-back or force-pushed branch can't regress `main`), commits with
  `[skip ci]` because the site already serves exactly those bytes, and rebases
  rather than forces if a push lands on `main` mid-run.

### Why monthly is affordable
`write.mjs` emits `data/` deterministically — sorted keys and records, no per-run
timestamp outside `manifest.json` — so consecutive snapshots delta well. Measured
on the real tree: a history carrying two complete 26 MB `data/` trees packs to
~2.5 MB, and adding a snapshot moved the pack by less than repack noise. Daily
commits would still be needless churn on `main`; monthly bounds the drift without it.

## 2026-08-05 — Topocentric alt/az for the observer sky (stars, Sun, Moon, planets)

The maths layer the observer / sky-dome view will draw from. `data/sky/stars.json`
(the vendored BSC5 + IAU names from the prior PRs) gives fixed-star positions;
this turns those — plus the wandering bodies — into altitude/azimuth for an
observer and instant. No renderer yet; that's the next PR.

### What landed
- **`src/celestial.js` — a pure alt/az module** built on
  [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT), chosen over
  a hand-rolled Keplerian series for the Sun/Moon/planets so the wandering bodies
  are accurate to well under the naked-eye resolution the mag ≤ 4.5 star layer
  works at. Like `ephemeris.js` / `visibility.js` it pulls in no renderer.
  - `starAltAz(raDeg, decDeg, observer, date)` — catalogue J2000 RA/Dec →
    horizontal. The J2000 vector is rotated EQJ→EQD (precession + nutation)
    before `Horizon`, which does not precess its inputs; skipping this would sit
    the whole sky ~0.3° off for 2026 epochs.
  - `bodyAltAz(body, observer, date)` and `skyBodies()` — Sun, Moon and the five
    classical naked-eye planets, of-date and aberration-corrected.
  - Azimuth is degrees clockwise from north, matching `visibility.js` so its
    `compass()` labels these directly. Refraction is selectable
    (`'apparent'` default / `'airless'`).
- **`index.html` — `astronomy-engine` added to the import map**, CSP hash
  recomputed (the `test/csp.test.mjs` guard re-passes), and pinned as a dev
  dependency so the Node test suite exercises the same library the browser loads.

### Verified — `test/celestial.test.mjs`, no library-checks-itself circularity
- **Polaris altitude ≈ observer latitude** (≤ 1.5°) across latitudes and
  longitudes — external textbook invariant, not an Astronomy Engine value.
- **Angular separation preserved** between Sirius and Vega to < 0.01° (airless):
  the transform is a rigid rotation, so catalogue separation must survive it.
- **Sun path cross-checked** against the project's own independent solar series
  (`ephemeris.js`): altitude and azimuth agree to < 0.5°.
- Moon/planet smoke (finite alt ∈ [−90, 90], az ∈ [0, 360), distance > 0) and
  refraction monotonicity (apparent ≥ airless).

## 2026-08-05 — Pass event-time & culmination refinement (worklog follow-up)

The deferred fix from 2026-08-04: the 30 s scan step was the whole remaining
error budget — ±30 s on the window edges and up to **8.97°** understated at a
near-zenith culmination, with the compass bearing flipping on half the ISS
passes checked. `src/passes.js` now refines both off the grid. Full write-up in
[docs/pass-refinement-2026-08-05.md](docs/pass-refinement-2026-08-05.md).

### What landed
- **`src/passes.js` — window edges are bisected off the grid.** Each non-clipped
  edge is refined by bisecting *window membership* (above the 10° gate AND sunlit
  AND dark sky AND bright enough), so the edge lands on whatever transition
  actually bounds the window — the gate on a pass that rises and sets in
  darkness, or the shadow / twilight / brightness edge on one that doesn't — with
  no special-casing. Clipped edges are scan boundaries, not transitions, and stay
  as reported.
- **`src/passes.js` — the culmination is found by golden-section search.**
  Elevation over a single visible window is unimodal, so a golden-section search
  across the refined window finds the true maximum whether it falls in the
  interior or on an edge (a pass still climbing when it enters Earth's shadow
  peaks at the shadow entry, not at an interior point). The elevation curve near
  the zenith is far too sharp to read off a parabola through 30 s samples, which
  is why it's a search, not an interpolation. The look angles — elevation and the
  compass azimuth — are read back at that instant.
- **`src/passes.js` — `brightEnough` split into a pure `isBright`** so the edge
  refinement can reuse the brightness test without tripping the
  `unknownBrightness` side effect.

### Verified — refined 30 s vs a 1 s scan
The 1 s scan is the established stand-in for the independent Skyfield/DE421
reference (2026-08-04: Orbit at `stepSec: 1` reproduces it to ~1 s and ~0.1°).
Fixed ISS element set over a 45-observer grid, 59 matched passes:

| Quantity | Raw 30 s grid | Refined 30 s vs 1 s |
|---|---|---|
| AOS | ≤ 29.8 s | **≤ 78 ms** |
| LOS | ≤ 29.0 s | **≤ 109 ms** |
| Peak elevation | ≤ **8.97°** | **≤ 0.065°** |
| Peak azimuth (el < 85°) | up to a compass point | **≤ 0.61°** |

The highest pass in the grid, near-zenith: raw grid sample maxes at 86.10°, the
refinement lifts it to 89.69°, a 1 s scan agrees at 89.69° — a 3.59° correction,
matched to 0.001°. ~4.7 ms per 24 h scan, up from ~2 ms; only emitted passes are
refined, so the cost stays bounded. Suite now **33 tests**, all passing (was 31):
two new in `test/passes-refinement.test.mjs` — the grid consistency and the
near-zenith recovery — and the existing invariants still hold.

### Still to confirm before merge
- **Re-run the external Heavens-Above cross-check** against the refined output.
  The 1 s agreement predicts the shipped 30 s should now match Heavens-Above to
  ~1 s / ~0.2° with all four compass bearings right (raw 30 s read the 71° pass
  as 68° and flipped two of four bearings), but that external check predates this
  change and is the last confirmation.

## 2026-08-05 — GP fetch timeout (worklog follow-up)

Closed the standing "no per-fetch timeout" follow-up (first noted 2026-08-01,
observed live when CelesTrak 403'd Starlink under repeated fetches).

### What landed
- `src/gp.js` — a `fetchJsonWithTimeout` wrapper puts a hard `AbortController`
  deadline on every CelesTrak request. Previously a single stalled group left
  the `Promise.allSettled` in `fetchLayers` open indefinitely and the app sat on
  the loading screen forever. A timeout now aborts the request; the abort falls
  through the existing `catch` to a stale-cache fallback when one exists, or
  surfaces as a normal fetch error otherwise. The deadline deliberately spans the
  body read (`res.json()`), not just the headers: `fetch()` resolves once headers
  arrive, so a server that then stalls or trickles the body would slip past a
  headers-only timeout. Threaded a `timeoutMs` option through
  `fetchGroup`/`fetchDecaying` (default `GP_FETCH_TIMEOUT_MS`) so it is
  injectable for tests.
- `src/constants.js` — `GP_FETCH_TIMEOUT_MS = 15 s`.
- `test/gp.test.mjs` — three tests over stubbed `fetch`/`localStorage`: a stalled
  fetch aborts promptly instead of hanging (no cache → rejects), a stalled
  *response body* (headers in, body hanging) also times out, and a stalled fetch
  falls back to a stale cache (marked `stale`) when one exists.

### Verified
- Suite now **31 tests**, all passing (was 28).

## 2026-08-04 — Pass-prediction validation & fixes

Validated `src/passes.js` / `src/visibility.js` against an independent
Skyfield/DE421/Vallado-SGP4 reference and against Heavens-Above, then fixed the
three behavioural issues the exercise turned up. Full write-up, with the
reproduction scripts, in `docs/pass-validation-2026-08-04.md`.

The physics came out clean — every disagreement traces to the 30 s scan step or
to a reporting convention, not to the maths.

### What landed
- **README — an `Accuracy` section.** States plainly that passes are scanned on
  a fixed 30 s grid, what that costs (±30 s on rise/set, peak elevation
  understated by up to ~9° on fast near-zenith LEO passes, sometimes one compass
  point), and what is *not* the cause — the propagation and geometry reproduce an
  independent implementation and Heavens-Above to ~1 s and ~0.2° when the same
  code runs at a 1 s step.
- **`src/visibility.js` — the −6° twilight boundary is now actually used.** `sky`
  was computed with a civil-twilight boundary and then ignored: `state` only
  became `daylight` above the *geometric* horizon, so Orbit listed passes with
  the Sun at −0.0°, which no other tracker does. Civil twilight is now its own
  `state` (`twilight`), exported boundary `CIVIL_TWILIGHT_DEG`, and
  `predictPasses` requires `visible`.
  - The live "can I see it right now" badge changed with it, deliberately: it
    now reads *Twilight — only bright objects* instead of *Visible now*. Leaving
    the badge on the old boundary would have had the panel promise a sighting the
    pass list underneath it refuses to offer. One threshold, one story.
- **`src/visibility.js` — `magOffset` is returned unconditionally.** The range +
  phase terms are geometry and are known even when the intrinsic magnitude is
  not; `apparentMag` is now literally `stdMag + magOffset`. This is what lets the
  pass filter reason about an object with no magnitude without duplicating the
  photometry.
- **`src/passes.js` — a null magnitude no longer means "bright enough".** It now
  bounds the object instead: assume `UNKNOWN_STD_MAG = 2.0` (the bright end of
  the mmccants catalogue — a large spent rocket body) and ask whether even *that*
  would clear the naked-eye cutoff at this range and phase. It is a bound, not a
  guess, and it is deliberately optimistic so missing data never costs a real
  LEO sighting. `unknownBrightness` is returned so the UI can say why.
- **`src/passes.js` — never-setting objects are no longer one 24 h "pass".** An
  object that holds above the elevation gate for the whole scan now returns
  `alwaysUp` plus a `standing` summary (representative look angles, how long it
  is sunlit in a dark sky, brightest magnitude) instead of `total: 1` with a
  meaningless `peakTime`. Only claimed over a scan of ≥ 12 h, past the ~8 h an
  MEO object can hold above 10°, so a short scan degrades to a clipped pass
  rather than asserting something it didn't watch long enough to know.
- **`src/passes.js` — scan boundaries are no longer reported as rise/set times.**
  Windows carry `startClipped` / `endClipped`; the UI renders those as
  "Now – 22:14" and "21:50 onwards" rather than inventing an AOS/LOS.
- **`src/passes.js` — `satellite.propagate` is wrapped.** It throws on some
  deep-decay element sets rather than returning a falsy position; one bad sample
  now closes the open pass and the scan continues instead of taking out the whole
  prediction.
- **`src/main.js` — `renderPasses` takes the result object** and covers the new
  cases: the standing summary, and a third empty-list reason. It previously
  branched on `geomVisible > 0 && haveMag` and would have said "too faint to see
  (mag > 6.5)" for an object whose magnitude it never had. It now distinguishes
  *too faint* (measured), *brightness unknown and too distant* (bounded), and
  *no sunlit passes at all*. Unknown-state badges fall back rather than throw.
- `styles/main.css` — a `vis-twilight` badge colour, sitting between the
  "visible" green and the "daylight" yellow, as does its hue.

### Verified
- **Layer by layer** (440 samples, 11 objects), Orbit vs the independent
  reference: SGP4 position **7.8 m**, velocity 8.8 mm/s, look-angle elevation
  **0.0015°**, azimuth 0.0029°, slant range 29 m, Sun altitude at the observer
  **0.0015°**. GMST differs by a constant 1.20 arcsec, which is DUT1 (`gstime`
  treats UTC as UT1) and ignorable.
- **End to end**, 51 objects: pass counts identical. AOS ≤ 29.8 s, LOS ≤ 29.0 s,
  peak time ≤ 14.4 s, peak magnitude ≤ 0.03 — all inside one 30 s step, the
  signature of quantisation. Peak elevation ≤ **8.97°**, the one bound that is
  not (STARLINK-34970 reported 81°, true culmination 89.7°).
- **Heavens-Above, ISS, four passes**, same site and element set: HA reports four
  daylight passes and zero visible; Orbit reports exactly that. At `stepSec: 1`
  Orbit reproduces HA to +1…+2 s and 0.2°, with all four compass bearings
  matching; at the shipped 30 s the 71° pass reads 68° and 2 of 4 bearings flip.
- **Twilight gate**, ISS at mag −1.8 over a 45-observer grid: 140 → **116**
  windows (−17%) and 436 → 340 minutes of listed window time (−22%). That is the
  bright-twilight listing other trackers don't show, now gone.
- **Unknown-magnitude bound** costs nothing in LEO: same ISS grid, unknown
  magnitude, **116 windows before and after**; only the faint edges are trimmed
  (339.5 → 288.0 minutes). Beyond ~7900 km slant range it bites, which is where
  it is meant to: a synthetic GPS-like MEO from Kegworth still reports 2 sunlit
  passes but claims **0** naked-eye ones — and so does the same object given a
  genuine stdMag of 2.0, so the bound is not merely pessimism.
- **Never-setting**: a synthetic geostationary object overhead now returns
  `alwaysUp` with 11.2 h sunlit in a dark sky, rather than "1 pass". Even at an
  implausible stdMag of 1.0 it works out at apparent mag 8.8 — nothing at
  36 000 km is a naked-eye object, which is the whole point.
- Suite now **28 tests**, all passing (was 21). Seven new: the twilight state and
  its boundary, `magOffset` consistency, the LEO no-loss guarantee, MEO
  suppression, the standing summary, the ≥ 12 h guard, and clipped windows.

### Follow-ups
- **Refine event times and the culmination — the deferred fix.** The 30 s step
  is the entire remaining error budget: ±30 s on the window edges and up to
  **8.97°** understated at the peak (STARLINK-34970: 81° reported for an 89.7°
  overhead pass, rendered as a wrong integer next to a compass bearing that is
  also wrong on half the ISS passes checked). The fix is bisection on the two
  10°-crossing samples and golden-section (or a parabola through the three
  samples around the maximum) on the culmination — roughly **4 extra SGP4
  evaluations per pass**, which collapses AOS/LOS to ~±1 s and the peak to well
  under 0.1°. Left out here deliberately: it changes every reported number, so it
  wants its own change and its own comparison against Heavens-Above.
- `UNKNOWN_STD_MAG` is one global constant. If enrichment ever carries an RCS or
  a size class, a per-object bound would be sharper than "as bright as a rocket
  body" — but only that: a bound, never a reported magnitude.
- The Earth-shadow model stays cylindrical against a spherical Earth. The
  reference uses a conical umbra/penumbra against WGS84 and the pass counts
  agreed anyway, so this only matters for grading brightness through the
  penumbra, which the app doesn't do.
- `standing.darkMs` is quantised to the scan step (one step per qualifying
  sample), so it is a ±30 s figure reported to 0.1 h. Fine for "best seen when
  dark"; it would need the same refinement as above to be better.
- `gstime` treating UTC as UT1 costs 1.20 arcsec of Earth rotation (~37 m).
  Measured, accepted, not worth a DUT1 feed.

## 2026-08-03 — Security review remediation

Verified and fixed the findings from a security review of the app, dev server,
and CI.

### What landed
- `serve.mjs` — hardened the local dev server:
  - **Binds to loopback (`127.0.0.1`) by default** instead of all interfaces,
    so the working tree (incl. `.git/`) is no longer exposed on the LAN. Opt in
    to a wider bind with `HOST=0.0.0.0`.
  - **Fixed path containment**: the old `startsWith(root)` check let a sibling
    directory sharing the name prefix (`…/orbit-secret`) be reached by traversal.
    Now requires an exact match or `root + separator`.
  - **Refuses dotfiles / VCS metadata** (`.git/config`, `.env`, …) anywhere below
    the root, checking only the path *below* root so a project cloned inside a
    hidden parent still serves.
  - Refactored to export `createOrbitServer(root)` (listens only when run
    directly) so it's testable.
- `index.html` — added a restrictive **Content-Security-Policy** meta tag:
  `default-src 'self'`, scripts/images limited to `cdn.jsdelivr.net`, connections
  to `celestrak.org`, `object-src 'none'`, `base-uri 'self'`. The inline import
  map is allow-listed by sha256 hash. Verified in a real browser: app loads with
  zero CSP violations.
- CI hardening:
  - **Pinned every GitHub Action to a full commit SHA** (tag kept in a trailing
    comment) across `test.yml`, `static.yml`, `enrich.yml` — mutable tags can no
    longer silently change what runs.
  - `test.yml` — added `permissions: contents: read` (least privilege) and an
    `npm audit --audit-level=high` dependency gate.
  - New `.github/workflows/codeql.yml` — CodeQL static analysis
    (`security-extended`) on push/PR + weekly cron.
- `test/serve.test.mjs` — new tests locking in the server hardening: index
  served, unknown → 404, `.git/config` → 403, sibling-prefix traversal → 403,
  symlink-escape → 403.
- `test/csp.test.mjs` — recomputes the import-map sha256 and asserts it matches
  the CSP allow-list, so the two can't silently drift apart.

### Follow-ups from automated review
- `serve.mjs` — reject `..`/NUL in the request path up front (also clears a
  CodeQL `js/path-injection` alert on `readFile`), and canonicalise with
  `realpath` so a symlink inside the root can't resolve to a file outside it.
- `src/main.js` — the layer-swatch colour was set via an inline `style="…"`
  attribute, which `style-src 'self'` blocks; now assigned via CSSOM
  (`swatch.style.…`), which the CSP permits. Verified: no CSP violations.
- Suite now 21 tests, all passing.

### Not changed (accepted)
- The app still loads three.js / satellite.js from a CDN by design (no build
  step); the CSP constrains *where* from and the import map pins exact versions.
  Subresource-integrity on import-mapped modules isn't broadly supported yet.

## 2026-08-02 — Test harness for the physics

Added unit tests for the visibility/pass/ephemeris math, on Node's built-in
runner (`node --test`) — 16 tests, all pure (no browser, no network).

### What landed
- `test/visibility.test.mjs` — `compass()`; all four `computeVisibility` states
  (visible / daylight / shadow / below-horizon) via controlled geometry; sky
  day/twilight/dark; null-magnitude; closer-range-is-brighter.
- `test/passes.test.mjs` — a fixed ISS TLE + fixed epoch (deterministic) scanned
  over an observer grid; asserts the invariants the PR #10 review established:
  peak always within `[visibleStart, visibleEnd]`, peak elevation ≥ gate, window
  magnitude ≤ cutoff, faint object → 0 naked-eye passes (but sunlit count kept),
  unknown-magnitude not excluded, `maxPasses` respected.
- `test/ephemeris.test.mjs` — J2000 epoch, unit-vector sun direction, equinox
  z≈0, solstice declination.
- `package.json`: `test` script + one dev-only dependency (`satellite.js@7.1.0`,
  matching the CDN import map); `package-lock.json` committed for `npm ci`.
- `.github/workflows/test.yml` — runs `npm ci && npm test` on push + PR.

### Small refactor (enabling)
- Extracted the pure solar-ephemeris math (`sunDirectionEci`, `dateToJulian`)
  into a new dependency-free `src/ephemeris.js`. `utils.js` re-exports them (it
  keeps the three.js scene helpers); `passes.js` imports from there. Now the
  physics modules (`visibility.js`, `passes.js`) don't transitively pull in
  three.js, so tests need only `satellite.js`. App verified unchanged in-browser.



## 2026-08-02 — Tier 4 built (visible-pass predictions)

Adds "when's the next time I can see this?" — upcoming visible passes for the
selected satellite from the observer's location.

### What landed
- `src/passes.js` — `predictPasses(satrec, observer, fromMs, stdMag, opts)`: walks
  SGP4 forward (24 h, 30 s step) from **real wall-clock time** (independent of the
  sim clock), reusing `computeVisibility`. Detects above-horizon passes, keeps the
  ones that are sunlit + dark-sky, and (when a magnitude is known) bright enough
  for the naked eye (mag ≤ 6.5). A cheap elevation probe runs while the object is
  down; the full visibility calc only kicks in during a pass. **~2 ms per 24 h scan.**
- `src/main.js` + `index.html` + CSS: a **Next visible passes** section in the
  selection panel — up to 4 passes as local-time window + peak elevation/compass +
  peak magnitude. Recomputes on selection and on location change. Falls back to a
  reason line when nothing's visible ("6 passes in 24 h, but none visible
  (daylight or Earth's shadow)"). Single-sample (culmination/shadow-edge) sightings
  show a single time, not a degenerate range.

### Bug fixed (shipped in PR #8, surfaced here)
- **TDZ in observer persistence.** `let observer = loadObserver()` runs at boot but
  `loadObserver()` reads `const OBSERVER_KEY`, which was declared ~700 lines later —
  in the temporal dead zone. It threw, got swallowed by the try/catch, and returned
  null, so a **persisted location was ignored on reload until re-saved**. Hoisted
  the const above the boot call. (Same class as the earlier `enrichReqNorad` trap.)

### Verified
`predictPasses` timed at ~2 ms/24 h; happy path produces real passes (peak 81°
NNE, mag 1.0; 19:07–19:09 max 13°, mag −1.5). Reload-with-persisted-location now
shows visibility + passes on first selection without a re-save. Confirmed in-browser.

### Notes / limits
- 30 s scan resolution (rise/set to ±30 s — fine for a minute-level display); 24 h
  horizon; naked-eye cutoff mag 6.5. SGP4 accuracy degrades for high-drag decaying
  objects far ahead. No pass direction-of-travel arrow yet.



## 2026-08-01 — Tier 2/3 built (observer location + visibility + look direction)

Adds "can I see it right now, and where do I look?" on top of the Tier 1
magnitude data. Built after Tier 1 shipped in PR #7.

### What landed
- `src/visibility.js` — pure physics: look angles (az/el/range via satellite.js),
  apparent magnitude (intrinsic + range + diffuse-sphere phase term), cylindrical
  Earth-shadow sunlit test, observer sky state (day/twilight/dark), and a
  `state` verdict (below-horizon | shadow | daylight | visible). Plus a 16-point
  `compass()`.
- `src/utils.js` — extracted `sunDirectionEci()` (shared by scene lighting and
  visibility) from `sunDirectionScene()`.
- `src/satellites.js` — `updateSelection()` now also returns the selected sat's
  ECI position + gmst.
- `src/main.js` + `index.html` + CSS:
  - **Settings dialog** (topbar "⚙ Location"): manual lat/lon + "Use my current
    location" (Geolocation opt-in), persisted in localStorage, **never sent
    anywhere**. No permission prompt on load.
  - **Visibility section** in the selection panel, updated live (~2 Hz) in the
    render loop: state badge, look direction (compass + elevation), range,
    apparent magnitude (only when sunlit; carries the Tier-1 "est." flag),
    sat sunlit/shadow, and observer sky.

### Verified (deterministic geometry tests, not just eyeballing)

| Scenario | state | sky | sunlit | el | mag |
|---|---|---|---|---|---|
| overhead, dusk | visible | dark | ✓ | 90° | −2.3 |
| overhead, midday | daylight | day | ✓ | 90° | −0.4 |
| overhead, midnight | shadow | dark | ✗ | 90° | — |
| London, now | below-horizon | day | ✓ | −21° | — |

Range 493 km overhead; compass 0°→N, 157°→SSE, 340°→NNW; apparent magnitude
fainter at higher sun (phase term working). Settings dialog + persistence + live
panel confirmed in-browser.

### Notes
- Model is intrinsic-magnitude based; no atmospheric extinction near the horizon
  and a simple cylindrical (no-penumbra) shadow — fine for "roughly, can I see
  it." Pass predictions ("next visible pass tonight") are Tier 4, not built.

## 2026-08-01 — Tier 1 built (enrichment pipeline + Catalogue + brightness)

Built the enrichment catalogue end-to-end per [docs/data-enrichment-schema.md](docs/data-enrichment-schema.md)
and [docs/enrichment-build-job.md](docs/enrichment-build-job.md). Verified in-browser.

### What landed

**Build pipeline** (`scripts/enrich/`, Node, zero deps):
- `sources/satcat.mjs` — CelesTrak SATCAT CSV (load-bearing base set).
- `sources/gcat.mjs` — GCAT TSV (mass, dims, shape, orbit class, operator, status).
- `sources/mmccants.mjs` — Quicksat `qs.mag` intrinsic magnitudes (vendored).
- `merge.mjs` — per-field precedence + `_sources` stamping + 12-month decay window.
- `write.mjs` — `catalog-index.json` + NORAD-bucketed `enrichment/<b>.json` + `manifest.json` + `SOURCES.md`.
- `validate.mjs` — fail-safe gate (aborts before deploy on broken input).
- `build.mjs` — orchestrator. Run: `node scripts/enrich/build.mjs` (~20 s).

**Client** (Tier 1 UI):
- `src/enrichment.js` — lazy bucket fetch, index/manifest load, brightness bucketing.
- Selection panel gains a **Catalogue** section + **brightness badge** + source line.
- New **Catalogue** browser (third topbar tab): search + type/brightness filters over
  36k objects, click-through detail, "Show in 3D" when the object is in the loaded field.

**Deploy**: `.github/workflows/enrich.yml` (daily cron) builds fresh data and redeploys
the whole tree, sharing `static.yml`'s `pages` concurrency group. Committed `data/` is
the seed `static.yml` serves between runs. Bumped `static.yml` checkout v4 → v6.

### First real build (verified)
```
satcat 70,177 rows · gcat 69,376 · mmccants 4,156
merged 36,174 records (dropped 34,003 decayed >12mo)
  GCAT join 98.3% · magnitudes 3,015 (8.3%)
index 4.8 MB → 276 KB gzip · buckets 71 · per-selection ~19 KB gzip
```
ISS (25544) renders full: mass 20,351 kg, dims, LEO, mag −2.5 "Naked eye", sources
GCAT · CelesTrak · McCants. Starlink degrades cleanly (metadata, no magnitude).

### Findings & decisions made during the run (please sanity-check)

1. **GCAT join key changed from COSPAR to the NORAD number.** GCAT's `satcat.tsv`
   carries a `Satcat` column that *is* the NORAD id, so we join on it directly and
   skip converting GCAT's old-style Piece designators (`1957 ALP 1`). Result: 98.3%
   join, far cleaner than a COSPAR-designator join would have been.

2. **Decay filter uses SATCAT `DECAY_DATE` only, not GCAT `DDate`.** GCAT's `DDate`
   also marks *assembly/renaming* — Zarya's DDate is 1998 (when it became the ISS),
   which wrongly dropped the still-orbiting ISS. SATCAT's DECAY_DATE is the
   authoritative atmospheric-reentry date. (Caught in testing — ISS was missing.)

3. **Magnitude is sparse, and the upstream source is half-broken.** The standalone
   `qsmag.zip` URL 404s; the copy inside `quicksat.zip` is a stale 2010 build with no
   modern objects. We **vendored** the 2020 `qs.mag` (recovered from the Wayback
   Machine; McCants licences it "freeware, no restrictions") into
   `scripts/enrich/vendor/`. Even so, only ~8% of objects have a magnitude — good for
   classic bright objects (ISS, rocket bodies, NOSS), sparse for modern LEO
   constellations. This is astronomically honest (a lone Starlink ~mag 5 is a marginal
   naked-eye target), but it means the brightness badge is blank for most Starlink.
   **Resolved (2026-08-01):** added a per-constellation magnitude fallback
   (`scripts/enrich/constellations.mjs`), applied only when there's no measured
   value and always labelled estimated (magSource `estimate`, dashed badge, "~"
   prefix, "est." in the readout, "estimate" in the sources line). Covers 12,842
   objects (11,381 Starlink). Starlink is launch-date-split: pre-visor v0.9/v1.0
   (before 2020-06, 179 still active) get the brighter ~4.5; coated sats ~5.5.

4. **Bucketing is NORAD/1000** (`enrichment/25.json` = 25000–25999), not the 3-digit
   prefix the doc first sketched — length-independent, handles 6-digit ids. Client and
   build agree (`write.mjs bucketOf` ↔ `enrichment.js bucketOf`).

5. **UCS dropped** (as agreed) — GCAT covers its fields with a clean CC-BY.

### Not in this run (later tiers)
- Settings dialog, observer location, live apparent magnitude, look direction, passes
  (Tiers 2–4).
- The orphan `enrichment-data` history branch is wired in `enrich.yml` but only
  materialises on the first cron/dispatch run.

### Observed, not changed (out of scope)
- The GP loader (`gp.js` via `fetchLayers`) has no per-fetch timeout: if a CelesTrak
  group stalls, `Promise.allSettled` waits indefinitely and the app sits on the loading
  screen. Surfaced while testing (CelesTrak 403'd Starlink under my repeated fetches).
  Not introduced here; worth an AbortController timeout later.

### How to run locally
```
node scripts/enrich/build.mjs     # generates data/
node serve.mjs                    # http://localhost:8080 — open the Catalogue tab
```
