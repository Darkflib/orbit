# Data enrichment — schema & visibility roadmap

Status: **draft for review**. Defines the enriched-record schema, the per-field
source precedence, the two build artifacts, and the visibility feature the
magnitude data unlocks (including the observer-location / look-direction roadmap).

Nothing here changes the hot path: the 2 h OMM/GP fetch in [`src/gp.js`](../src/gp.js)
stays exactly as-is. Enrichment is a **separate, slowly-changing side artifact**,
joined lazily on selection.

---

## 1. Join keys (already present)

Every in-app record already carries both keys we need, so no crosswalk table:

- `norad` — OMM `NORAD_CAT_ID` ([`gp.js:38`](../src/gp.js#L38))
- `intlDes` — OMM `OBJECT_ID` / COSPAR designator ([`gp.js:39`](../src/gp.js#L39))

Join rule per source:

| Source | Join on | Note |
|---|---|---|
| CelesTrak SATCAT | `norad` | 1:1 |
| mmccants (qsmag/names) | `norad` | 1:1 |
| GCAT | `norad` (its `Satcat` column) | **Revised during build** (see [WORKLOG](../WORKLOG.md)): GCAT's `satcat.tsv` carries the NORAD id in its `Satcat` column, so we join on it directly — cleaner than converting GCAT's old-style Piece designators. Non-NORAD GCAT rows (blank/lettered `Satcat`) simply don't join. Achieved 98.3%. |
| ~~UCS DB~~ | — | dropped (§5) |

Canonical primary key for the enriched record: **`norad`** (string).

---

## 2. Enriched record schema

One object per catalogued NORAD id. All fields optional except `norad` — a
record is the union of whatever sources resolved.

```jsonc
{
  // ---- identity ----
  "norad": "25544",              // string, primary key
  "cospar": "1998-067A",         // intlDes / OBJECT_ID
  "name": "ISS (ZARYA)",         // canonical display name
  "altNames": ["ISS", "Zarya"],  // mmccants names, GCAT aliases
  "gcatId": "1998-067A",         // McDowell id, for deep-linking GCAT

  // ---- classification ----
  "objectType": "payload",       // payload | rocket-body | debris | unknown
  "opsStatus": "operational",    // operational | partial | backup | nonoperational | decayed | unknown
  "orbitClass": "LEO",           // LEO | MEO | GEO | HEO | other

  // ---- ownership & purpose ----
  "owner": "NASA/Roscosmos",     // operator/owner
  "country": "ISS",              // registrant / state
  "users": ["government"],       // civil | commercial | government | military
  "purpose": ["science", "human-spaceflight"],

  // ---- launch ----
  "launchDate": "1998-11-20",    // ISO date
  "launchSite": "Baikonur",
  "launchVehicle": "Proton-K",

  // ---- physical ----
  "massKg": 419725,              // launch/dry mass
  "dimensions": { "span_m": 109, "length_m": 73 },
  "shape": "complex",
  "rcsSize": "large",            // small | medium | large (SATCAT bucket)
  "rcsValue_m2": null,           // numeric if a source has it

  // ---- brightness / visibility (the hinge) ----
  "stdMag": -1.8,                // standard magnitude: 1000 km range, 50% illum (mmccants qsmag)
  "magSource": "mmccants",

  // ---- lifecycle ----
  "decayDate": null,             // ISO date if decayed/reentered
  "status": "in-orbit",          // in-orbit | decayed | landed | unknown (GCAT)

  // ---- provenance ----
  "_sources": {                  // which source won each field (attribution + trust)
    "owner": "gcat",
    "objectType": "satcat",
    "stdMag": "mmccants"
    // ... one entry per populated field, or grouped
  },
  "_updated": "2026-07-31T00:00:00Z"
}
```

### Concrete example — ISS (ZARYA), NORAD 25544

The object tracked as 25544 is the Zarya module; the record describes the ISS
complex. Values illustrative (build job fills them from live sources).

```jsonc
{
  "norad": "25544",
  "cospar": "1998-067A",
  "name": "ISS (ZARYA)",
  "altNames": ["ISS", "Zarya", "International Space Station"],
  "gcatId": "1998-067A",

  "objectType": "payload",
  "opsStatus": "operational",
  "orbitClass": "LEO",

  "owner": "Multinational (ISS partners)",
  "country": "ISS",
  "users": ["government"],
  "purpose": ["human-spaceflight", "science"],

  "launchDate": "1998-11-20",
  "launchSite": "Baikonur (Site 81/23)",
  "launchVehicle": "Proton-K",

  "massKg": 419725,
  "dimensions": { "span_m": 109, "length_m": 73 },
  "shape": "complex",
  "rcsSize": "large",
  "rcsValue_m2": null,          // SATCAT buckets only; ISS is ~hundreds of m²

  "stdMag": -1.8,               // mmccants qsmag: naked-eye, one of the brightest
  "magSource": "mmccants",

  "decayDate": null,
  "status": "in-orbit",

  "_sources": {
    "objectType": "satcat", "opsStatus": "gcat", "orbitClass": "gcat",
    "owner": "gcat", "country": "satcat", "purpose": "gcat",
    "launchDate": "gcat", "launchSite": "gcat", "launchVehicle": "gcat",
    "massKg": "gcat", "dimensions": "gcat", "shape": "gcat",
    "rcsSize": "satcat", "stdMag": "mmccants", "status": "gcat"
  },
  "_updated": "2026-08-01T00:00:00Z"
}
```

### Field → source map (what each source actually supplies)

UCS is **not adopted in v1** (see §5) — its column is kept only to show what we
would forgo. Every field below is covered without it.

| Field | GCAT | SATCAT | mmccants | ~~UCS~~ |
|---|:--:|:--:|:--:|:--:|
| name / altNames | ● | ● | ● | |
| objectType | ● | ● | | |
| opsStatus / status | ● | ● | | ○ |
| orbitClass | ● | | | ○ |
| owner | ● | | | ○ |
| country | ● | ● | | ○ |
| users / purpose | ● | | | ○ |
| launchDate/site/vehicle | ● | (date) | | |
| massKg | ● | | | ○ |
| dimensions / shape | ● | | | |
| rcsSize / rcsValue | | ● | | |
| **stdMag** | | | ● | |
| decayDate | ● | ● | | |

---

## 3. Per-field source precedence

Reuses the pattern already in the codebase: [`fetchLayers`](../src/gp.js#L158)
resolves NORAD collisions by a numeric `priority` (lower wins). Do the same
**per field** across sources. Sources genuinely disagree (mass, decay status),
so the winner is recorded in `_sources`.

| Field | Precedence (first wins) | Rationale |
|---|---|---|
| objectType | SATCAT → GCAT | SATCAT's PAY/R/B/DEB is the operational standard |
| opsStatus / status | GCAT → SATCAT | GCAT is most current on decay/landing |
| orbitClass | GCAT | |
| owner | GCAT → SATCAT | |
| country | SATCAT → GCAT | SATCAT registrant is canonical |
| users / purpose | GCAT | UCS deferred; GCAT classification only |
| launchDate/site/vehicle | GCAT → SATCAT | GCAT has site + vehicle, SATCAT only date |
| massKg | GCAT | sole source in v1 |
| dimensions / shape | GCAT | sole source |
| rcsSize / rcsValue | SATCAT | sole source |
| **stdMag** | mmccants | sole source |
| decayDate | **SATCAT only** | Revised during build: GCAT's `DDate` also marks assembly/renaming (Zarya's is 1998, when it became the ISS), so it can't drive the decay filter. SATCAT's DECAY_DATE is the authoritative reentry date. See [WORKLOG](../WORKLOG.md). |

---

## 4. Build artifacts

Two files, generated by an enrichment cron on its **own slow cadence**
(weekly-ish), fully decoupled from the 2 h orbital job.

**Coverage filter:** active catalogue **plus objects that decayed within the last
12 months**. One build-job predicate: `decayDate == null || decayDate >= today −
12 months`. Keeps a recently-watched reentry resolvable in the UI without
dragging the full historical catalogue in. (The live tracker still only plots
active objects — this window only affects which records have *enrichment*.)

1. **`data/catalog-index.json`** — lean, for the catalogue browse/filter list.
   `[{ norad, name, objectType, country, opsStatus, stdMag }]`.
   Small enough to load once; drives search/sort/filter without per-object fetches.

2. **`data/enrichment/<bucket>.json`** — the full records above, **bucketed by
   NORAD prefix**, fetched **lazily on selection**. Keeps the GP hot path lean —
   the GP dumps are already near the localStorage quota, which is why
   [`gp.js`](../src/gp.js#L44) uses compact positional rows. We do **not**
   pre-join enrichment into the GP files.

   **Bucketing (as built):** shard by `Math.floor(norad / 1000)` so a selection
   maps to exactly one file with no index lookup — `enrichment/25.json` holds
   25000–25999. Length-independent (handles 5- and 6-digit ids), ~1000 buckets
   max, ~19 KB gzip each. Client and build share the function (`enrichment.js`
   ↔ `write.mjs` `bucketOf`); a missing bucket just means no enrichment
   (additive, non-fatal). (The first draft sketched a 3-digit string prefix;
   NORAD/1000 is the same idea, length-safe.)

Client change is small: on select, fetch the shard for the chosen `norad`, merge
into the detail panel. Enrichment is additive — a missing shard just means the
panel shows what it shows today.

---

## 5. Licensing obligations (redistribution, not just linking)

Today the app only **links out** (N2YO / CelesTrak / Heavens-Above,
[`index.html:135`](../index.html#L135)) — zero redistribution. Committing these
sources as JSON makes us a redistributor, so:

| Source | License | Obligation |
|---|---|---|
| GCAT | CC-BY 4.0 | attribution + link, in repo and UI |
| CelesTrak SATCAT | Kelso terms | attribution |
| mmccants | amateur-community | attribution |
| ~~UCS DB~~ | CC-BY-**NC** | **not adopted** — the NC clause would put a permanent commercial-use asterisk on this MIT repo, and GCAT covers its fields with wider coverage and a clean licence |

Action: a `SOURCES.md`, plus the `_sources` provenance surfaced in the detail
panel (which doubles as the per-field attribution surface).

**Decision — UCS dropped from v1.** Revisit only if "filter by purpose/users"
becomes a headline catalogue feature *and* GCAT's classification proves too
coarse. Adopting it later is additive (new source id in the precedence table),
so nothing here forecloses it.

---

## 6. Visibility feature — "can I see it?"

This is what the magnitude data hinges toward. Build it in tiers so each stands
alone.

### Physics inputs (the app already has most of these)

Apparent magnitude of a sunlit satellite ≈

```
m_app ≈ stdMag + 5·log10(range_km / 1000) + phase_correction(phase_angle)
```

Inputs needed:

| Input | Source | Status in app |
|---|---|---|
| `stdMag` | mmccants | new (this schema) |
| slant range observer→sat | topocentric calc | needs observer location |
| phase angle (Sun–sat–observer) | Sun dir + positions | **Sun direction already computed** (terminator) |
| sat sunlit? (not eclipsed) | Sun dir + Earth shadow | derivable from existing Sun vector |
| observer in darkness? | Sun elevation at observer | needs observer location |

So the missing ingredient is almost entirely **the observer's location** — the
orbital and solar geometry is already in the scene.

### Tier 1 — static brightness badge (no location)
From `stdMag` alone, bucket each object: **naked-eye / binoculars / telescope /
invisible**. Show as a badge in the detail panel and a filter in the catalogue
("show naked-eye objects"). Zero new permissions.

### Tier 2 — observer location + live apparent magnitude
Detect or accept the observer's location, then compute live apparent magnitude
and visibility state ("sunlit + you're in darkness = potentially visible now").

- **Location:** captured through a new **Settings dialog** — manual lat/lon (or
  place) entry, with a "Use my location" button that requests the browser
  Geolocation permission on demand. No permission prompt fires on page load.
  Privacy: kept **client-side only, never sent anywhere** — matches the
  no-backend ethos. Persisted in localStorage next to the GP cache. The Settings
  dialog is a new, small UI surface (the app has no settings panel today) and can
  later host other preferences (units, default layers).
- satellite.js already provides the topocentric maths
  (`geodeticToEcf` + `ecfToLookAngles`), so slant range + az/el are a direct call.

### Tier 3 — look direction
For the selected satellite, surface **azimuth + elevation**: "Look **NNE, 34°
above the horizon**, mag 2.1, moving SE." A compass rose / horizon marker in the
detail panel. This is the payoff the user called out.

### Tier 4 — pass predictions
"Next visible pass tonight: 21:14–21:19, peaks 68° in the S, mag −1.2." Walk the
existing SGP4 propagation forward, filter to sunlit-sat + dark-observer +
above-horizon windows. Optionally an all-sky "what's visible right now" list.

---

## 7. Suggested roadmap order

1. **Schema + precedence** (this doc) — lock before wiring sources.
2. **Enrichment pipeline v1**: SATCAT + GCAT → `catalog-index.json` + shards.
   Detail panel gains identity/classification/ownership/launch/physical.
   Add **Catalogue** as a third mode beside Tracker/Reentry
   ([`index.html:40`](../index.html#L40) modeswitch pattern).
3. **mmccants magnitude** → `stdMag` + **Tier 1** brightness badge/filter.
4. **Tier 2–3**: observer location + live magnitude + look direction.
5. **Tier 4**: pass predictions / "visible now".

---

## Resolved decisions

- **UCS: dropped from v1** (§5) — CC-BY-NC vs. GCAT covering the same fields cleanly.
- **Catalogue scope: active + decayed-within-12-months** (§4) — recently-watched
  reentries stay resolvable; full history excluded.
- **Enrichment sharding: NORAD-prefix buckets** (§4) — `enrichment/<3-digit>.json`,
  one file per selection, no index lookup.
- **Location capture: Settings dialog** (§6) — manual entry primary, Geolocation
  an on-demand opt-in; no permission prompt on load.

## Open questions

_None blocking — schema is ready to build against._
