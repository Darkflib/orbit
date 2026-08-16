# Worklog — data enrichment & visibility

## 2026-08-16 — Globe-view dots rendered out of focus on 1x displays

Reported from a Qubes OS box running Firefox: in Sky view the dots are fine, in
Globe view they are blurry — and still blurry with the software renderer, which
ruled out the GPU driver the reporter reasonably suspected first.

Both views share one renderer and one canvas, so anything about the canvas
itself would have blurred them equally. The difference was entirely in the point
material. `gl_PointSize` is measured in **framebuffer** pixels; the globe's
shader wrote `clamp(260 / depth, 0, 14)` straight into it with no reference to
`devicePixelRatio`. That is not a fixed-size dot — it is a dot whose *apparent*
size is inversely proportional to the display's pixel ratio, so a size that
looked right on the 2x display it was tuned on came out twice as wide on an
ordinary 1x screen. `makePointsMaterial` in `skyview.js` had multiplied by the
ratio since the harness caught the same mistake there (it is the first entry in
`scripts/dev/README.md`), which is exactly why Sky view looked correct on the
same machine. Globe view was simply never fixed.

Two things then compounded, both consequences of the doubling rather than
separate faults. At 14px the glow sprite was mostly halo: its gradient was
already below 0.35 alpha just past half the radius, so a dot that was legible
small became a smudge with no solid centre. And 14px is the *clamp* — at the
default camera framing every near-side satellite sat on it, so the field lost
its size variation too and read as one uniform blanket of blobs. Both are
visible in the reporter's photo.

### Measured, on the real app in a real browser
An ad-hoc driver (per `scripts/dev/README.md` — measure the claim, do not
eyeball the screenshot) screenshots the globe at each pixel ratio, finds the
dots drawn against empty sky beyond the limb, and reports their width in CSS
pixels and the share of each blob at ≥50% of its own peak brightness:

| | before | after |
|---|---|---|
| 1x display | 11.0px wide, 34% core | 6.0px wide, 53% core |
| 2x display | 5.5px wide, 36% core | 6.0px wide, 52% core |

The before row is the bug stated numerically: the same build, the same scene,
twice the apparent size on one display than the other. The after row is the
property that was missing — apparent size no longer depends on the display.
(The 1x "before" run also *found* less than half as many dots, because at 11px
neighbours merge into each other and the detector discards them. That is the
smudging showing up in the measurement rather than in a photograph.)

### What landed
- **`src/constants.js`** — `globeDotSizePx(depth)` states the sizing law in CSS
  pixels, with `GLOBE_DOT_SCALE` / `GLOBE_DOT_MIN_PX` / `GLOBE_DOT_MAX_PX`; the
  shader applies the identical clamp from the same constants and multiplies by
  the ratio last. `renderPixelRatio(dpr)` is now the one place the ratio is
  read, replacing three near-copies — one of which was
  `Math.min(window.devicePixelRatio, 2)`, i.e. `NaN` on a browser that reports
  no `devicePixelRatio`, which would have sized the drawing buffer to nothing.
- **Sizes** — the ceiling is 7 CSS px, which is what a 2x display already drew,
  so nothing changes on the display the old value was tuned for. New is the
  1.5px floor: an unclamped `1/depth` is sub-pixel at full zoom-out, and a
  satellite tracker that hides satellites has failed.
- **`src/satellites.js`** — the glow sprite keeps a solid core out to 40% of its
  radius before falling off. Its mipmaps are also off: the sprite is only ever
  minified, the LOD a driver picks comes from derivatives of `gl_PointCoord`
  (which point sprites are a shaky case for, software rasterizers especially),
  and a smooth radial ramp has nothing that would alias without them.
- **Staleness** — `devicePixelRatio` changes under browser zoom and when a
  window moves to a differently-scaled display, and a resize is the only
  notification either gives. The renderer now re-applies it there (a drawing
  buffer sized for the old ratio is stretched by the compositor, which blurs
  *everything*), and both views refresh their uniforms.
- **`test/dot-size.test.mjs`** — asserts the apparent size is identical across
  pixel ratios, that the old law was ~2x oversized at 1x, and that degenerate
  depths cannot yield a `NaN` point size — some drivers drop the entire draw
  call for one.

### Testing the shader without a GL context
Review (CodeRabbit) pointed out that the first draft only checked the shader's
*text*: that a `uPixelRatio` appeared in the `gl_PointSize` assignment. Fair —
that leaves the order unchecked, and the order is the whole bug. Clamping the
framebuffer size instead, `clamp(uSize / depth * uPixelRatio, …)`, reads like
the same line and puts the ceiling at 7 *framebuffer* pixels: 3.5 CSS px on a 2x
display, 7 on a 1x one. Exactly what was just fixed, one level down.

Tightening the regex was the wrong answer to that — pinning the expression
character by character passes whenever the characters are unchanged, which is
not the property, and fails on every reformat. So the test compiles the shader
instead: the scalar path of `void main()` translates to JS almost verbatim
(`float x = …` to `let`, the `gl_PointSize` assignment to a `return`, vector
lines skipped, `clamp`/`max` supplied), and the result is checked against
`globeDotSizePx(depth) * ratio` over a sweep of depths *and* ratios. `mv` is
handed in rather than derived — `mv.z` is view-space depth by definition, and
that is where the translation stops.

Confirmed by mutation, since a test this indirect is worth distrusting: putting
the ratio inside the clamp, dropping the clamp, scaling `uSize`, swapping the
bounds, and restoring the original ratio-free line each fail it; hoisting a
local and re-wrapping the expression passes. The line-based first attempt at the
translation failed that last case — declarations are free to wrap, so it splits
on statements.

## 2026-08-15 — Removing the browser's direct CelesTrak fallback

CelesTrak (Dr T.S. Kelso) firewalled the data-mirror server's IP for excessive
bandwidth. The complaint had two parts, and both were fair: we requested the
bandwidth-heavy JSON format, and we requested the `active` GROUP *alongside*
eleven GROUPs that are subsets of `active` — so every satellite in a
constellation layer came down the wire twice. The mirror (a separate repo) was
fixed first: it now fetches `active` once per cycle and derives the subsets
locally.

The frontend still had the identical anti-pattern, only worse, because it ran
from every visitor's browser. `fetchElements` tried the mirror and then fell
back to `celestrak.org/NORAD/elements/gp.php?GROUP=…&FORMAT=JSON` for each of
the twelve GROUPs `LAYERS` names — `active` and eleven of its own subsets —
plus `SPECIAL=DECAYING`, on a two-hour refresh. A
mirror hiccup during a deploy is precisely the moment every open tab fails over
at once, so the failure mode was a synchronised stampede of duplicated JSON.

### Why it could not be fixed the way the server was
The server fix works because there is one process, with one bandwidth budget,
that can be taught to deduplicate and back off. A browser fleet has none of
that. It cannot share a ledger, cannot be rate-limited from here, and cannot
honour a 403 "stop" — each tab just sees one failed request and keeps its own
two-hour schedule. There is no version of the fallback that is polite, so it is
gone rather than tuned.

What remains covers the outage it was added for, and none of it touches
CelesTrak: the mirror, then the stale `localStorage` copy, served at any age and
flagged `stale` in the UI.

Worth being precise about the limit of that, because the first draft of this
entry was not. There is no third rung. A visitor arriving during a mirror
outage with an empty cache gets the GP error and no satellites — the snapshot
bundled in `data/` is catalogue metadata and sky files, which `src/data.js`
serves for enrichment and search, and it holds no element sets. Review caught
the overclaim in three places before it shipped.

### What landed
- **`src/gp.js`** — `fetchElements` is a single mirror attempt instead of an
  `attempts` list; the `upstreamUrl` parameter is gone from it and from both
  callers (`fetchGroup`, `fetchDecaying`). Degrade-to-stale-cache is unchanged.
  The total-failure message no longer joins per-source failures — with one
  source it reads `GP data unavailable (orbit-data: HTTP 503)`.
- **`src/constants.js`** — `CELESTRAK_URL`, `CELESTRAK_SPECIAL_URL` and the now
  unreferenced `GP_FETCH_TIMEOUT_MS` removed. The note above `ORBIT_DATA_ORIGIN`
  records the fair-use incident and says plainly not to re-add the fallback;
  without that, the next person to see a mirror outage rebuilds it.
- **`index.html`** — `celestrak.org` dropped from `connect-src`, so a
  reintroduced fetch is blocked by the browser rather than shipped. The info
  panel's CelesTrak satcat link (`src/main.js`) is a *navigation*, which
  `connect-src` does not govern, and keeps working.
- **`scripts/dev/harness.mjs`** — `stubElementSources` serves the mirror only,
  and routes `celestrak.org` to an aborted request so a regression fails the
  harness loudly instead of being handed stub data.
- **Docs** — README highlight and module list, `SECURITY.md`'s data-and-privacy
  paragraph (which still claimed the browser fetches CelesTrak directly).

### Superseding an earlier entry
The 2026-08-10 hand-off below says "`orbit-data.mikepreston.org` is primary,
CelesTrak is the fallback, the bundled snapshot is the last resort". The middle
term no longer exists; the sentence otherwise stands.

### Verified
- Suite **118 tests**, all passing (was 115). `test/gp.test.mjs` asserts the new
  contract rather than losing the coverage: a healthy fetch touches only the
  mirror; a mirror error, a malformed payload and a timeout each fail without a
  second request; a group fetch and a decaying fetch never leave the mirror
  origin; and a mirror failure with a cache present still degrades to stale
  browser data. `test/csp.test.mjs` asserts no directive permits `celestrak.org`
  *and* that the satcat link survives (no `navigate-to` directive).
- No request was made to celestrak.org at any point in this work.

## 2026-08-12 — "USA 224 is missing": objects with no element set

A user searched for USA 224 (NORAD 37348, COSPAR 2011-002A) and reported it as a
missing satellite. Nothing was broken. It is a classified NRO payload: CelesTrak
lists it in SATCAT with `DATA_STATUS_CODE = NEA` and has never published a TLE or
OMM for it. The app had no way to say so — the field search only knows objects
with elements, so the suggestion list came back empty and closed itself, which is
indistinguishable from a failed fetch.

### Two cases, not one
975 on-orbit objects have no element set, and lumping them together would be
wrong for half of them:

- **734 Earth-orbiting** (694 US, overwhelmingly classified military). A real
  orbit whose elements are simply not published. 411 of them still have an
  approximate orbit in SATCAT.
- **241 deep-space probes** (Pioneer, Mariner, Ranger …) orbiting the Sun or
  another body. "No TLE" is a category error there — there is no Earth orbit for
  an element set to describe, and an Earth-orbit period/apogee would be nonsense,
  so the approximation is dropped for them even when the record carries one.

### The data contract
`orbit-data` adds three additive fields to the enrichment records —`dataStatus`
(null, or one of `no-current-elements` / `no-initial-elements` /
`no-elements-available`), `orbitCenter` (friendly lower-case body name, or a raw
SATCAT code when unmapped) and `approximateOrbit` (`periodMinutes`,
`inclinationDeg`, `apogeeKm`, `perigeeKm`, each nullable). `schemaVersion` does
not change, so **the deployed tree carries none of them until orbit-data
republishes**. Every read treats all three as optional; with them absent the app
renders exactly as it did before, which was checked in a browser against the
committed snapshot rather than assumed.

One deliberate piece of paranoia: an unmapped `orbitCenter` arrives as its raw
SATCAT code, and misreading Earth's own code (`EA`) would tell a user their
satellite had left Earth orbit. `isEarthOrbit` therefore accepts `earth`, `ea`
and absent, and only then treats a centre as non-Earth.

### Follow-up, same day: the full `orbitCenter` set, and the docked case

The published centres turned out to be more than bodies, so "orbits X" was the
wrong sentence for a third of them. Now classified four ways:

- **Bodies** (`sun`, `moon`, the planets, `asteroid`, `comet`) — "orbits the
  Sun, not Earth".
- **Earth-system places** (`earth-lagrange`, `earth-sun-l1`…`l5`,
  `earth-moon-barycenter`) and `solar-system-escape` — "is at the Earth–Sun L2
  point, not in Earth orbit", "is on an escape trajectory out of the solar
  system". Nothing here is *orbited*: Pioneer 10 does not orbit its own
  trajectory.
- **A numeric centre is the host object's catalog number**, which SATCAT uses
  for a docked object — and a module docked to the ISS is very much in Earth
  orbit. The naive fallback would have rendered "orbits 25544, not Earth". It is
  now Earth-orbiting, keeps its approximate orbit, and reads "docked to NORAD
  25544". No SATCAT row currently carries both a numeric centre and a
  `dataStatus`, so this is a guard against a latent case, with a test so it
  cannot regress.
- **Anything unrecognised** is reported rather than guessed at ("not in Earth
  orbit (catalogue centre: XX)") — claiming an object orbits a string we do not
  understand is worse than admitting we do not know.

`dataStatus` also lands in `catalog-index.json`, sparse in the same idiom as
`magEst` (written only when non-null), so ~978 of 36,205 rows carry it and the
client keeps treating the key as optional.

### What landed
- **`src/enrichment.js`** — `elementStatus()` (the null-or-explanation decision,
  including the Earth/deep-space split), `orbitCenterName()`,
  `approximateOrbitRows()`, `APPROXIMATE_ORBIT_NOTE`. Pure and unit-tested.
- **`src/main.js`** — the search falls back to the catalogue index when the
  loaded field has no match, so USA 224 is findable from the box the user
  actually used; choosing a catalogue-only result opens its catalogue record
  instead of trying to select something in 3D. A query that matches nothing at
  all now says so rather than closing the list silently. The catalogue detail
  pane renders the explanation and the approximate orbit, and its 3D button
  reads "Cannot be shown in 3D" rather than implying another layer would help.
- **Deliberately not in the selection panel.** Everything in the 3D field
  propagated from a real element set to get there, so a "not published" notice
  under a live position readout could only contradict it. `renderEnrich` takes
  `statusEl` as optional and the selection panel omits it.
- Neutral grey styling, not a warning colour: this is a normal catalogue entry,
  not an error state.

### Review follow-up: the field having *a* match is not the same as the right one

The first cut only consulted the catalogue when the field search returned
nothing. Two reviewers found the same hole independently, and it defeats the
feature for exactly the object it was built for: with the default Starlink layer
loaded, `37348` substring-matches the **name** STARLINK-37348 (NORAD 68737), so
the field is non-empty, the catalogue is never asked, and USA 224 is silently
absent while a different satellite is offered in its place. A cheap-looking
guard turned into a wrong answer that looks like a right one.

Both sets are now always searched and merged, de-duplicated by NORAD (the field
copy wins — only it can be shown in 3D) and ranked together: exact catalog
number, exact name, name prefix, catalog-number prefix, then anywhere in the
name. The ranking is the point of the merge, not a detail of it, so it moved
into a new pure `src/search.js` with the collision case pinned by a test. Field
results still render immediately and the catalogue merges in when it lands, so
the common case never waits on the fetch.

The same review caught a second real bug: dismissing the list with Escape (or by
blurring the input) while the index request was in flight did not invalidate it,
so the popup reappeared when the response landed. `closeSearchResults` now bumps
the sequence counter that guards the handler, which covers Escape, blur, commit
and a catalogue reload alike. That one is DOM timing with no seam a `node --test`
can reach; it is checked in the browser driver instead.

### Verified
`npm test` — 115 tests, 115 pass (11 in `test/enrichment.test.mjs`, 9 in
`test/search.test.mjs`). Throwaway Playwright drivers on top of
`scripts/dev/harness.mjs`, because most of this defect was a UI absence a unit
test cannot see: one with the new fields stubbed in (21/21 — search offers USA
224 *and* ranks it above the colliding Starlink name, the record explains
itself, the approximate orbit renders with its caveat, a heliocentric probe and
an escape trajectory read differently, a docked object stays in Earth orbit, an
Escape keypress mid-fetch stays dismissed, an ordinary search still selects in
3D, no console errors), one against the *current* published snapshot with none
of the new fields (search still finds it, no half-rendered notice, old wording
intact).

### Not done
Nothing propagates for these objects — they never enter `field.records`, because
`gp.js` only ever sees objects CelesTrak publishes elements for, and
`SatelliteField.load` discards anything `json2satrec` cannot build. So there was
no propagation path to guard, only paths not to add.

## 2026-08-10 — Retiring the enrichment pipeline: one catalogue, mirrored

`orbit-data` now produces the same catalogue this repo's `scripts/enrich/` build
job produced, so the daily rebuild here was a second implementation of the same
merge — with its own byte-identical copies of the vendored sources, and its own
orphan branch and deploy-time overlay to get the output onto the site. The
question was whether that independence was worth the duplication.

### The argument that settled it
`src/data.js` falls back to the bundled `data/` only when the mirror **throws** —
a network failure or a non-OK status. A successful-but-*wrong* response is
returned to the app as-is. So an independent recompute here defends against a
failure mode the client can never reach. What actually buys resilience is the
fallback living in a **different failure domain** (GitHub's infrastructure, not
one self-hosted box). That argues for keeping the copy and dropping the rebuild.

### Parity, measured before deleting anything
Live `orbit-data` vs the committed seed, five days apart:
- `catalog-index.json` and the enrichment buckets carry **identical key sets**.
- Bucket 25: **428/428 records common**, 4 field differences across ~5,000
  comparisons — all in `status` / `decayDate` / `opsStatus`, i.e. real drift, not
  schema divergence.
- The vendored sources (`qs.mag`, `bsc5.dat`, `bsc5-names.json`,
  `constellation-lines.json`) hash byte-identical in both repos.
- `sky/stars.json` and `sky/constellations.json` have identical key sets and
  counts (904 stars, 88 figures).

One genuine difference: the figures come out in a **different order** — Python's
codepoint sort puts `CMa` before `Cae`, `localeCompare` does the reverse.
Contents are equal id-for-id, and `skyview.setConstellations` flattens every
figure into one vertex buffer, so order is not observable. This is what failed
`constellation-figures.test.mjs`'s "committed artifact matches a fresh build"
assertion — that test went with the adapter it covered.

### What landed
- **`scripts/mirror-catalogue.mjs` (new)** copies the published tree into
  `data/`. It writes the **raw fetched bytes**, so committed files stay
  byte-identical to what the mirror serves and diffs track catalogue changes
  rather than this script's JSON formatting.
- **Buckets are derived from the index, not from a range.** There is no
  directory listing, and the ids are sparse: 6-digit NORADs (issued since 2026,
  after the 5-digit space was exhausted) sit in bucket **100** while buckets
  70–99 do not exist. A `0..N` walk would 404 on the gap and silently miss the
  newest objects. Derived count cross-checks against `manifest.buckets` (71).
- **Integrity gates, not a recomputation**: `schemaVersion`, a 30,000-record
  floor, a 20% drop limit against the committed seed, never-move-backwards on
  `generatedAt`, star/figure floors, and — the one that catches a partially
  published tree — **every NORAD in the index must resolve in the bucket the
  client will request**. 23 unit tests, one per rejected condition.
- **Timestamps compare as instants, not strings.** `orbit-data` emits `+00:00`
  where the retired job emitted `Z`; those sort against each other by suffix once
  the instants are close, so `Date.parse` does the comparison.
- **Deleted**: `scripts/enrich/` (1,008 LOC + 2.1 MB vendored), `enrich.yml`,
  `sync-data-seed.yml`, `static.yml`'s overlay step, and the two adapter test
  files. The orphan `enrichment-data` branch is now unreferenced.
- **Weekly, not daily** (`mirror-catalogue.yml`): the catalogue moves slowly and
  the copy is only ever read during an outage.
- **No `[skip ci]`** on the mirror commit, unlike the retired seed sync. That
  flag was correct when `static.yml` overlaid the data branch at deploy time —
  the site already served those bytes. With the overlay gone, this commit is the
  only thing that refreshes the fallback the live site ships.

### End-to-end
Ran against the live service: 36,212 records, 71 buckets, 75 files, 2.1 s.

## 2026-08-10 — Hand-off: state of play

Written at the end of the observer/sky-view run, for whoever picks this up in a
fresh session.

### Done and verified
- **Sky mode** — 3D observer view sharing the Earth renderer, opaque ground
  plane for horizon occlusion, constellation figures, star/satellite picking,
  device-orientation control gated on the orientation actually being absolute.
- **Mobile** — panels are bottom sheets, one open at a time. Chrome coverage on
  a 412×839 viewport went from **87% to 19%**, measured, not eyeballed.
- **Data mirror** — `orbit-data.mikepreston.org` is primary, CelesTrak is the
  fallback, the bundled snapshot is the last resort (`src/data.js`,
  `constants.js`). **Failover is confirmed working in the browser**: the owner
  ran the code before the DNS record existed and watched it fall through to
  CelesTrak in the console. That is the real test — the mirror being *down* is
  the case the fallback exists for, and it was exercised for free.
- **Drag speed** now scales with zoom (this run's other entry).
- **Browser harness** in `scripts/dev/`, 10/10 smoke checks.

### Known, deliberate, not bugs
- The harness is **not** in CI. `node --test` does not pick it up and Playwright
  is not a devDependency, so `npm ci` stays small. Wire it into a pre-release
  step if that ever seems worth it.
- `ORBIT_OFFLINE_CDN=1` **strips the page CSP** — the propagation worker imports
  satellite.js from the CDN and a route-fulfilled response is refused in a
  worker context under the page policy. Offline runs therefore do not exercise
  the real CSP; the default run does, which is why it is the default.
- `ROTATE_SPEED_MIN = 0.02` is the correct 1:1 value at the closest zoom but a
  large change from the old muscle memory. Easy to tune if it feels wrong in
  use.

### The lesson worth carrying forward
Nearly every real defect in this run came from **running or measuring** the app,
not from reading a diff. The count that makes the point: four separate boot
failures where a `const` was reached from the boot path while still in its
temporal dead zone. Each one killed the page before first paint, each one read
as perfectly good code, and each was caught only because the loading overlay
never cleared in a real browser. If a change touches module top-level order,
DOM, WebGL or pointers, drive it — `scripts/dev/` exists so that is cheap.

## 2026-08-10 — Drag-to-rotate now scales with zoom

Reported: click-and-drag spins the globe quickly when zoomed in and at a crawl
when zoomed out, the same pixels-to-degrees either way.

### Why
`OrbitControls` converts a drag into a fixed *angle* — `theta = 2π ·
rotateSpeed · dx / viewportHeight` — with no reference to how far the camera is
from what it orbits. The apparent speed therefore depends entirely on zoom:
close in, the globe fills the screen and a few degrees sweep half the visible
surface; zoomed out it is a marble and the same drag barely moves it. With
`rotateSpeed` pinned at 0.55, a 100 px drag moved the surface under the cursor:

| zoom (Earth radii) | before | after |
|---|---|---|
| 1.08 (closest) | 5214 px | 190 px |
| 1.5 | 834 px | 100 px |
| 3.49 (default) | 168 px | 100 px |
| 8 | 60 px | 100 px |
| 16 | 28 px | 100 px |
| 24 (furthest) | 18 px | 82 px |

A 290× swing across the zoom range, which is exactly the reported symptom in
both directions.

### What landed
`rotateSpeedForDistance` in `constants.js` derives the speed from the camera
distance so a pixel of drag moves the surface about a pixel at any zoom. A
surface point sits `distance − radius` from the eye and projects to
`radius · theta · H / (2 · (distance − radius) · tan(fov/2))`; substituting
theta and solving for 1:1 gives the expression. The viewport height cancels,
which is why the helper needs no DOM and unit-tests in Node.

Clamped at both ends: at the surface the ideal speed tends to zero, which would
freeze rotation, and fully zoomed out the globe is ~90 px across so a literal
1:1 drag would spin it several times in one gesture. `scene.js` recomputes on
the controls' `change` event, which covers the dolly, damping settling after it,
and `main.js` lerping the orbit target onto a followed satellite. The camera FOV
moved into `constants.js` so the maths cannot drift from the camera it
describes.

### Verified — `test/camera-feel.test.mjs`, suite now 85
The tests assert the property that was broken rather than the constant that
fixed it, and the oracle is deliberately *not* the shipped algebra rearranged:
it spins a real point around a real sphere and divides by that point's own
depth, assuming neither a small angle nor a flat surface. Agreement is therefore
a result rather than a tautology, and one test pins the divergence — a 100 px
sweep at 19 Earth radii comes back as **57 px**, because the point genuinely
rounds the limb, which the closed form ignores.

The claim being made is a *rate*, so it is probed with a 1 px drag: the surface
keeps up with the cursor to within **0.01 px** across 1.2–19 Earth radii.
Apparent motion varies by **1.02×** over that band where the old fixed speed
varied by **more than 20×** — a regression guard, so reverting to any constant
fails it. Plus monotonicity, that the new curve straddles the old 0.55
(otherwise it would only have fixed one end), and clamping behaviour including
distances at or inside the surface. Driven in Chromium to confirm the `change`
wiring: a 100 px drag changes the frame at both zoom extremes, no console
errors.

### Review fixes on #26
- **Follow mode.** The speed is measured from the Earth's centre, not from
  `controls.target`. In follow mode `main.js` lerps the target onto the selected
  satellite, and the distance to *that* says nothing about how large the Earth
  is on screen — orbiting a GEO satellite at the minimum distance would select
  the lower clamp even though the Earth is several radii away, making a
  full-viewport drag rotate about 7°. The Earth is what the eye tracks while
  dragging, so it is what the speed follows. Identical whenever nothing is being
  followed, since the target is then the origin.
- **Zoom limits** moved to `ZOOM_MIN_RADII` / `ZOOM_MAX_RADII` in
  `constants.js`, so the test asserting "the app's actual zoom range" cannot
  drift from what `scene.js` sets.

### Note
The CelesTrak mirror follow-up recorded on 2026-08-09 is **done** — PRs #24
and #25 landed `orbit-data.mikepreston.org`, `src/data.js` with a fallback to the
bundled snapshot, and the CSP `connect-src` entry. Nothing further needed here.

## 2026-08-10 — Browser harness moves into the repo

Every session so far has rebuilt an ad-hoc Playwright script in `/tmp`, used it
to find something a unit test structurally could not, and thrown it away.
`scripts/dev/` keeps the reusable half.

### Why it is worth keeping
The app has no build step and most of it is DOM, WebGL and pointer behaviour, so
a large class of defect is invisible both to `node --test` and to reading a
diff. Every one of these was caught by driving a real browser, and none of them
could have been caught otherwise: `gl_PointSize` is in framebuffer pixels, so
stars and satellites rendered at half size on 2× displays; world-scaled labels
grew without bound on zoom; a native `<datalist>` renders no suggestion UI at
all on iOS, so search silently did nothing on a phone; committing a suggestion
on `pointerdown` made the results list impossible to scroll on touch; chrome
covered 87% of a phone viewport; and four boot failures where a `const` was
reached from the boot path while still in its temporal dead zone, killing the
page before first paint.

The standing lesson from this feature: nearly every real defect came from
*running or measuring* the app, not from reading a diff.

### What landed
`harness.mjs` is the reusable part — offline CDN routing, CSP stripping,
deterministic OMM stubs for both the mirror and the CelesTrak fallback, observer
seeding, error collection. `smoke.mjs` is one driver on top of it, checking boot,
search, Sky mode and mobile chrome coverage on desktop and phone viewports;
10/10 passing. Deliberately **not CI**: `node --test` does not pick these files
up and Playwright is not a devDependency, so `npm ci` stays small.

Pinned versions are read from `index.html`'s own import map rather than
duplicated, and `installOfflineCdn` now checks `node_modules` *matches* those
pins. That check exists because it did not: `npm install --no-save three` pulls
the current release, which splits `three.module.js` into a sibling
`three.core.js` the import map knows nothing about — the route 404'd and the
page hung on the loading overlay with nothing in the console. A second trap is
documented alongside it: `--no-save` prunes the tree against `package.json`
afterwards, so installing Playwright on its own silently removes `three`.

## 2026-08-09 — Mobile: panels become bottom sheets

Reported after testing Sky mode on a phone: the UI is very cramped. Measured on
a 412×839 viewport with a satellite selected, it was worse than "cramped" —
**87% of the screen was chrome**, leaving 13% for the thing the app exists to
show. The two floating cards stacked vertically and, together with the topbar
and timebar, filled the viewport from y=56 to y=823.

### What landed
- **Both panels dock to the bottom as sheets**, collapsed to their header by
  default, with the standard grabber affordance. The existing
  `.panel.collapsed` rule already hides the body and sections, so a collapsed
  panel *is* the handle — no second mechanism was needed, and desktop keeps the
  identical collapse behaviour it always had.
- **One expands at a time** (`openSheet`). Selecting a satellite opens its sheet
  and collapses the other, since selecting something is a request to see it.
  The whole header is the tap target, not the 24px button — the buttons inside
  keep their own meaning, so `×` still deselects rather than collapsing.
- **The layers sheet stacks above the selection sheet** (`body.has-selection`),
  and when a sheet is *expanded* the other's handle lifts clear of it
  (`body.sheet-expanded`) rather than being covered — so switching sheets stays
  one tap instead of collapse-then-open. The lift and the sheet height are both
  driven by `--sheet-max`, so they cannot drift apart.
- **Keyboard parity.** The header tap is a mobile convenience, not the only
  route: `#toggle-left` already existed and `#toggle-right` is new, so both
  sheets have a focusable control with `aria-expanded` kept in sync by the one
  function that changes collapsed state.
- **Topbar trimmed** from 616px of content in a 412px viewport to exactly 412:
  brand hidden (the mode tabs identify the app), fps and cache pills dropped,
  the settings label reduced to its icon, and the satellite count switched to a
  short form ("13.1k sats") so it stays visible instead of being dropped.
- **Timebar** becomes a full-width dock instead of a floating pill, with play,
  NOW and the clock pinned to the front via flex `order` — previously the clock
  was pushed off the right edge — and the skip/speed clusters scrolling.

### Measured, on a Pixel 7 (412×839)
UI coverage as a share of the viewport, by union of the chrome rects:

| state | before | after |
|---|---|---|
| at rest | 87% | **19%** |
| satellite selected, sheet open | 87% | 71% |
| selected, sheet collapsed | — | **25%** |

So the sky goes from 13% to 81% at rest, and any expanded sheet is one tap from
75%. Desktop is unchanged: panel geometry, brand, fps pill, full-length count
and the no-mutual-collapse behaviour all verified identical.

### Two bugs found while building it, both self-inflicted
- **CSS specificity.** The first version set `top: auto` on `.panel`, but
  `#panel-left { top: 64px }` is an id selector and wins — so the sheets stayed
  stretched from the topbar to the bottom, i.e. full height, the exact opposite
  of the intent. Measured 71% and looked wrong; fixed by addressing the ids.
- **Temporal dead zone, again — twice.** `wireControls()` runs in the boot block
  and reaches `MOBILE_MQ` and `satCount` through `applySheetDefaults`, so
  declaring them beside their functions lower in the file threw at startup.
  Then the review fix reintroduced it with a `SHEET_TOGGLE` lookup const, which
  broke boot a second time. That is the third and fourth time this file's boot
  order has caught something, so the panel→button mapping is now derived inline
  rather than held in a module-level const that could sit in the dead zone.

### From review (CodeRabbit and Codex, both landing on the same two points)
- **The header listener ran at every breakpoint**, so on desktop clicking a
  panel header — including the satellite name in the selection panel — collapsed
  it. A real behaviour change, and against this change's own stated goal of
  leaving desktop alone: the desktop check verified geometry but never clicked a
  header. Now gated to mobile, and the check clicks both headers.
- **No keyboard route to expand the selection sheet.** `#panel-right` had only
  `×` (deselect), so a keyboard or switch user who collapsed it could not
  reopen it without deselecting and reselecting. Hence `#toggle-right`.
- **An expanded sheet covered the other handle** — addressed with the lift
  above, rather than by retracting the claim that both stay reachable.

### Follow-up
- **CelesTrak mirror.** After the outage on the 8th. The mirror itself will be a
  separate service the maintainer runs, so nothing is needed here beyond a
  configurable mirror origin, a fallback when the CelesTrak fetch fails (with a
  shorter timeout so the failover is not a 15 s stall), and a `connect-src`
  entry for it in the CSP.

## 2026-08-08 — Search suggestions: replace the native `<datalist>`

Reported from testing the sky view: on mobile the search box offered no
suggestions at all, "as if the result box is missing" — and on desktop the
suggestion list had previously been seen appearing well away from the field.
Both are the same root cause.

### Why a `<datalist>` could not work here
The suggestion popup for `<input list=…>` is drawn and positioned by the
*browser*, and the app has no say in either:

- **Mobile.** iOS Safari renders no datalist suggestion UI. The markup is valid,
  the options were there, and nothing appeared — exactly the reported symptom.
- **Desktop placement.** The popup is anchored by the browser to the input. The
  left panel sets `backdrop-filter`, which establishes a containing block and a
  stacking context, and that is a well-known way to have the anchor computed
  against the wrong box. Hence the misplacement seen earlier.
- The panel also sets `overflow: hidden` and is `max-height: 40vh` on phones, so
  a dropdown nested beside the input would simply be clipped.

None of this is fixable while the browser owns the widget, so the widget had to go.

### What landed
- **A hand-rolled combobox.** `#search-results` is a direct child of `<body>` —
  deliberately, so neither the panel's clipping nor its `backdrop-filter` can
  reach it — positioned `fixed` from the input's `getBoundingClientRect()` and
  repositioned on resize and on scroll (capturing, so panel scrolling counts).
  It flips above the field when there is more room there, which is the common
  case on a phone with the keyboard up.
- **Options commit on pointer *up*, and only if the pointer barely moved.** The
  first attempt committed on `pointerdown` — the obvious way to beat the blur
  that closes the list — and that was wrong in a way desktop testing could not
  show: on a phone the first touch of a *swipe* selects whatever is under the
  finger, so the list cannot be scrolled at all. With 40 matches in a 260 px box
  that left roughly two-thirds of the results unreachable. (Caught in review by
  Codex on PR #22; reproduced with synthetic touch events before fixing —
  a swipe selected the item under the finger and scrolled nothing.)
  Focus is instead held by a `mousedown` handler on the list that calls
  `preventDefault()`: `mousedown` is the event that moves focus, and on touch it
  is a compatibility event fired only after `touchend`, so preventing it holds
  focus on desktop without suppressing the native scroll gesture the way
  preventing `pointerdown` does.
- **Ranked matching over the whole catalogue.** Prefix matches first, then
  matches anywhere in the name, alphabetical within each tier — so "iss" offers
  ISS (ZARYA) before something that merely contains the letters. Names are
  lower-cased once per catalogue load rather than per keystroke.
- **The 4000-name cap is gone.** The old code built up to 4000 `<option>`
  elements; matching now scans all ~12k records and only the top 40 reach the
  DOM.
- Keyboard support (↑/↓/Enter/Escape) and combobox ARIA, neither of which the
  datalist gave us any control over. `findByName` (exact match only, and the
  reason a partial name did nothing even on desktop) is now unused and removed.

### Verified
Driven in Chromium at desktop (1400×900) and as an emulated iPhone 13 with touch:
- Mobile: suggestions open on tap, and **tapping one selects the satellite** —
  the interaction that previously did nothing.
- Placement asserted rather than eyeballed, since misplacement was the bug:
  left edges aligned, widths equal, 4 px below the field, fully on screen, on
  both viewports.
- Prefix-before-substring ranking, case-insensitivity, keyboard navigation,
  Escape, and close-on-commit all confirmed.
- **Touch scrolling**: a swipe over a 20-result list now scrolls it (and selects
  nothing) where it previously selected the item under the finger.
- **Outside presses**: checked because review suggested a document-level
  handler was needed. It is not — pressing the scene canvas already blurs the
  input to `BODY` and closes the list, under both mouse and touch.

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
