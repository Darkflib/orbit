# Worklog — data enrichment & visibility

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
