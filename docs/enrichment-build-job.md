# Enrichment build job — spec

Companion to [`data-enrichment-schema.md`](./data-enrichment-schema.md). Specifies
the pipeline that fetches the external sources, applies the §3 precedence, and
emits the artifacts the client consumes. Written to be executed directly.

Status: **draft for confirmation.**

---

## 0. Principles

- **Fail safe, never deploy garbage.** A source that is unreachable or has
  changed shape must *not* silently produce an empty/wrong catalogue. The build
  validates output against sanity thresholds (§7) and aborts before deploy if they
  fail — the existing published site is left untouched.
- **Graceful per-source degradation.** Sources are independent adapters. If
  mmccants is down, the catalogue still builds from SATCAT + GCAT (records simply
  lack `stdMag`). Only SATCAT is load-bearing (it defines the base object set); a
  SATCAT failure aborts, the others degrade.
- **Deterministic output.** Same inputs → byte-identical output (stable key
  order, sorted records, no timestamps *inside* record files — the run time lives
  only in `manifest.json`). This is what makes change-detection (§6) meaningful.
- **Decoupled from the hot path.** Nothing here touches the 2 h GP fetch in
  [`src/gp.js`](../src/gp.js). Different cadence, different files.

---

## 1. Language & layout

**Recommendation: Node**, not Python/uv. The repo is pure ESM JavaScript with no
build step; the maintainer works in JS; CI already has Node available via
`actions/setup-node`. A Node script adds *zero* new runtime to the stack. (The
earlier chat floated Python/uv — viable, but it introduces a second toolchain for
no gain here. Flagged as the point to confirm.)

```
scripts/enrich/
  build.mjs            # entry point: orchestrates fetch → merge → write → validate
  sources/
    satcat.mjs         # adapter: CelesTrak SATCAT (CSV)
    gcat.mjs           # adapter: GCAT (TSV)
    mmccants.mjs       # adapter: mmccants standard magnitudes (fixed-width)
  merge.mjs            # precedence engine + _sources stamping + 12-mo decay filter
  write.mjs            # emits index + prefix buckets + manifest
  http.mjs             # conditional-GET helper (ETag/Last-Modified cache)
  validate.mjs         # sanity thresholds; throws to abort the run
.cache/enrich/         # gitignored: ETag/Last-Modified + last-good raw payloads
data/                  # OUTPUT (published)
  catalog-index.json
  manifest.json
  enrichment/<prefix>.json
SOURCES.md             # generated attribution (regenerated each run)
```

No new npm dependencies required — Node ≥18 has `fetch`; CSV/TSV/fixed-width
parsing is hand-rolled per adapter (the formats are simple and stable). Keeps the
"no build step / no deps" character of the repo intact.

---

## 2. Source adapters

Each adapter exports `async function load(http) → Map<key, Partial<Record>>` and
declares its `id`, canonical URL, join key, and licence string. **Endpoint URLs
and exact column layouts are pinned as constants at the top of each adapter and
must be verified live as step 0 of implementation** (these files evolve and
mmccants has changed hosts). The adapter parses by *column header where present*,
not fixed byte offsets, so a column reorder doesn't corrupt data silently.

### 2.1 `satcat.mjs` — CelesTrak SATCAT (load-bearing)

- **URL (pin/verify):** `https://celestrak.org/pub/satcat.csv`
- **Format:** CSV with header row. Send conditional GET.
- **Join key:** `NORAD_CAT_ID` → `norad`.
- **Fields extracted → schema:**
  | CSV column | schema field | mapping |
  |---|---|---|
  | `OBJECT_ID` | `cospar` | as-is |
  | `OBJECT_NAME` | `name` (fallback) | trimmed |
  | `OBJECT_TYPE` | `objectType` | `PAY→payload`, `R/B→rocket-body`, `DEB→debris`, `UNK→unknown` |
  | `OPS_STATUS_CODE` | `opsStatus` | `+→operational`, `P→partial`, `B/S→backup`, `-→nonoperational`, `X→extended`, `D→decayed`, `?→unknown` |
  | `OWNER` | `country` | registrant code |
  | `LAUNCH_DATE` | `launchDate` | ISO passthrough |
  | `DECAY_DATE` | `decayDate` | ISO or null |
  | `RCS` | `rcsSize` | `SMALL/MEDIUM/LARGE → small/medium/large` |
- **Role:** defines the **base object set**. Every enriched record starts from a
  SATCAT row; GCAT/mmccants only *augment*.

### 2.2 `gcat.mjs` — GCAT (Jonathan McDowell)

- **URL (pin/verify):** GCAT `satcat` TSV under
  `https://planet4589.org/space/gcat/tsv/cat/` — confirm exact filename + the
  column spec at `planet4589.org/space/gcat/web/cat/` at implementation time.
- **Format:** TSV, McDowell conventions (dates like `1998 Nov 20`; ranges/flags
  with `?`, `~`, `*`). Adapter normalises dates to ISO and strips uncertainty
  flags into plain values (dropping the flag; we don't surface GCAT uncertainty
  in v1).
- **Join key:** COSPAR **piece designator** → `intlDes`. **Not** GCAT's own
  number (see schema §1 caveat).
- **Fields extracted → schema:** `owner`/operator → `owner`; `State` → `country`
  (GCAT wins per precedence only where noted — see §3 of schema); `LDate` →
  `launchDate`; launch site → `launchSite`; launch vehicle → `launchVehicle`;
  `Mass`/`TotMass` → `massKg`; `Length`/`Diameter`/`Span` → `dimensions`;
  `Shape` → `shape`; `Status` → `status`; `DDate` → `decayDate`; orbit class →
  `orbitClass`; purpose/type class → `purpose`.
- **Degradation:** on failure, records keep SATCAT-level detail; launch
  site/vehicle/mass/dimensions/purpose simply absent.

### 2.3 `mmccants.mjs` — standard magnitudes

- **URL (pin/verify):** McCants' `qs.mag` / `qsmag.zip` (Quicksat standard
  magnitudes). Host has moved historically — **confirm the current canonical URL
  at implementation time**; if zipped, unzip in-adapter (Node `zlib` +
  minimal ZIP read, or fetch an unzipped mirror if available).
- **Format:** fixed-width text. The intrinsic magnitude is defined at **1000 km
  range, full phase** — McCants' quicksat.txt: "the maximum apparent brightness
  of the satellite when it is seen at full phase at a range of 1000 kilometers".
  Matches the schema's `stdMag`, so it maps directly with no photometric
  conversion. (The visibility calc's phase function is normalised to full phase
  to stay consistent with this reference.)
- **Join key:** catalog number → `norad`.
- **Fields → schema:** `stdMag` (numeric), `magSource: "mmccants"`.
- **Degradation:** on failure, records simply lack `stdMag`. **This is the
  Tier-1-critical source** — if it fails, the brightness badge has no data, so a
  mmccants failure should log a *prominent warning* (but still not abort the run;
  metadata catalogue is still worth publishing).

---

## 3. Merge & precedence (`merge.mjs`)

1. Seed one record per SATCAT row (base set), keyed by `norad`.
2. For each record, resolve `intlDes` and look up the GCAT row by COSPAR;
   look up mmccants by `norad`.
3. Apply the **per-field precedence table** from schema §3. For each populated
   field, write the winning value **and** record the winning source id in
   `_sources[field]`.
4. **Decay filter:** drop any record where `decayDate != null && decayDate <
   today − 12 months`. (Active + decayed-within-12-months, schema §4.)
5. Derive nothing that the client can derive live (period/inclination/apogee come
   from OMM at runtime — not stored here).

Output: `Map<norad, EnrichedRecord>`, deterministically sorted by numeric `norad`.

---

## 4. Output writers (`write.mjs`)

- **`data/catalog-index.json`** — array of the lean projection, sorted by norad:
  `[{ norad, name, objectType, country, opsStatus, stdMag }]`.
- **`data/enrichment/<prefix>.json`** — full records bucketed by **3-digit NORAD
  prefix** (`255.json` ⊇ 25500–25599), each an object keyed by norad. 6-digit ids
  bucket on their first 3 digits too; revisit width if buckets skew (schema §4).
- **`data/manifest.json`** — the *only* place run metadata lives:
  ```jsonc
  {
    "generatedAt": "2026-08-01T00:00:00Z",
    "counts": { "records": 0, "withGcat": 0, "withMag": 0 },
    "sources": { "satcat": { "fetchedAt": "...", "ok": true },
                 "gcat": { "ok": true }, "mmccants": { "ok": false } },
    "schemaVersion": 1
  }
  ```
- **`SOURCES.md`** — regenerated attribution block (GCAT CC-BY, CelesTrak, mmccants).

---

## 5. Change detection & conditional GET (`http.mjs`, §6 of schema)

- Persist each source's `ETag`/`Last-Modified` in `.cache/enrich/`. Send
  `If-None-Match` / `If-Modified-Since`; a `304` means "reuse last-good raw
  payload", saving the source's bandwidth.
- After writing, **diff the generated `data/` tree against what's already
  published/committed**. If byte-identical (ignoring `manifest.generatedAt`),
  **skip commit and skip deploy** — no churn, no redundant Pages build.

---

## 6. GitHub Actions workflow (`.github/workflows/enrich.yml`)

**Deploy model — the one real gotcha.** `actions/deploy-pages` publishes an
uploaded artifact as the *entire* site, and this repo already has `static.yml`
deploying on push to `main`. Two deployers must not race, and neither may publish
a site missing `data/`. Resolution:

**Recommended architecture (history + always-fresh, no source-history bloat):**

1. **New `enrich.yml`** — `on: schedule` (daily; conditional-GET makes no-op runs
   free) + `workflow_dispatch`:
   - checkout `main` → setup-node → `node scripts/enrich/build.mjs`
   - `validate` gate (§7); abort before deploy on failure
   - if output changed: commit `data/` to an **orphan `enrichment-data` branch**
     (single force-pushed commit, or appended for history — keeps churn *off*
     `main`'s source history)
   - `upload-pages-artifact` of the **full tree** (app + freshly built `data/`)
     → `deploy-pages`
   - `concurrency: { group: "pages", cancel-in-progress: false }` — **same group
     as `static.yml`**, so the two serialise instead of racing.

2. **Modify `static.yml`** — before `upload-pages-artifact`, add a step that
   restores `data/` from the `enrichment-data` branch (`git fetch` + checkout that
   path). So a source push redeploys the app **with the latest enrichment**,
   without re-fetching external sources. One added step, no new race.

*Alternative (simpler, no history):* fold enrichment into `static.yml` — add
`schedule:` + a build step that runs the enrich script before upload. One
workflow, one deployer, but you lose the change-history diffing the first
discussion valued. Recommended path keeps history for a few lines more.

Pin action versions via the `current-github-action-versions` skill at
implementation time.

---

## 7. Validation gate (`validate.mjs`) — the fail-safe

Abort (non-zero exit, before any deploy) if **any** hold:

- SATCAT parsed `< 20 000` objects (sanity floor; real catalogue is far larger).
- `0` records survive the merge/decay filter.
- GCAT join resolved for `< 40 %` of active payloads (indicates a COSPAR-join
  regression) — **warn, don't abort** (metadata degraded but usable).
- `catalog-index.json` fails to `JSON.parse` round-trip.

Thresholds are constants, tuned against the first good run.

---

## 8. Client integration contract

So the client (Tier-1 work) and the data agree on shape:

- On satellite **select**, compute bucket = `norad.slice(0, 3)` (left-pad short
  ids as needed) → `fetch('data/enrichment/' + bucket + '.json')`, memoise the
  bucket in-memory, read `record[norad]`. Missing bucket / missing key →
  enrichment section simply not shown (additive, non-fatal).
- **Catalogue mode** loads `data/catalog-index.json` once for its
  list/search/filter; per-row detail lazy-loads the bucket on click.
- `manifest.json` drives a "data age" line and lets the UI flag a stale/failed
  enrichment run (e.g. `sources.mmccants.ok === false` → hide the brightness
  filter rather than show it empty).

---

## 9. Nap-run scope — what "Tier 1" actually includes

"Tier 1" (brightness badge/filter) transitively requires the whole pipeline.
Concretely, the autonomous run delivers:

**In scope**
1. `scripts/enrich/*` — all three adapters + merge + write + validate + http.
2. `enrich.yml` + the `static.yml` data-restore step (recommended architecture).
3. First data generation committed (index + buckets + manifest + SOURCES.md).
4. Client: lazy bucket fetch + **enrichment section** in the right panel
   ([`index.html:97`](../index.html#L97) `panel-body`), threading `intlDes`
   (currently dropped at [`satellites.js:290`](../src/satellites.js#L290)).
5. Client: **Tier-1 brightness badge** (naked-eye / binoculars / telescope /
   invisible from `stdMag`) in the detail panel.
6. Client: **Catalogue mode** — third tab beside Tracker/Reentry
   ([`index.html:40`](../index.html#L40)) with a list + text search + object-type
   and brightness filters over `catalog-index.json`.

**Out of scope (later tiers)**
- Settings dialog, observer location, live apparent magnitude, look direction,
  pass predictions (Tiers 2–4).
- UCS (dropped, schema §5).

**Known risk carried into the run:** external URLs/formats for GCAT & mmccants
can only be confirmed live. The build is designed **fail-safe** — if a source is
wrong/unreachable, validation aborts before deploy and the live site is
untouched; I report which source and stop rather than shipping a broken
catalogue. Verifying the three endpoints live is **step 0** of the run.

---

## 10. Open confirmations before running

1. **Node vs Python/uv** for the build script (recommend Node).
2. **Workflow architecture** — recommended (orphan `enrichment-data` branch +
   `static.yml` restore step) vs. simpler (fold into `static.yml`, no history).
3. **Enrichment cadence** — daily cron with conditional-GET (recommended) vs.
   weekly.
