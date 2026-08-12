// ---------------------------------------------------------------------------
// Enrichment data access (Tier 1).
//
// The enrichment catalogue is a slowly-changing side dataset served by the
// Orbit Data mirror, with the bundled data/ snapshot as a fallback. It is joined to a
// satellite lazily, by NORAD id, only when needed — so it never touches the
// 2-hour GP hot path in gp.js.
//
//   - catalog-index.json : lean list for the Catalogue browser (loaded once).
//   - enrichment/<b>.json : full records, bucketed by NORAD/1000, fetched on
//                           demand and memoised (one small file per selection).
//   - manifest.json       : build metadata (data age, per-source status).
// ---------------------------------------------------------------------------

import { fetchDataJson } from './data.js';

// Bucket a NORAD id the same way the build job does (write.mjs bucketOf).
function bucketOf(norad) {
  return Math.floor(parseInt(norad, 10) / 1000);
}

const bucketCache = new Map(); // bucket id -> Promise<Record<norad, rec>>
let indexPromise = null;
let manifestPromise = null;

// Full enrichment record for one NORAD id, or null if we have none. Never
// throws — a missing bucket / failed fetch just means "no enrichment", which
// the UI treats as additive-and-absent.
export async function getEnrichment(norad) {
  const b = bucketOf(norad);
  if (Number.isNaN(b)) return null;
  if (!bucketCache.has(b)) {
    bucketCache.set(b, fetchDataJson(`enrichment/${b}.json`)
      .catch(() => ({})));
  }
  const bucket = await bucketCache.get(b);
  return bucket[String(norad)] || null;
}

// The lean catalogue index (array), loaded once. Returns [] on failure.
export async function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchDataJson('catalog-index.json')
      .catch(() => []);
  }
  return indexPromise;
}

// Build manifest (data age / per-source status), or null on failure.
export async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetchDataJson('manifest.json')
      .catch(() => null);
  }
  return manifestPromise;
}

// ---- Brightness ----------------------------------------------------------
// Bucket an intrinsic (standard) magnitude — max brightness at full phase,
// 1000 km range — into an observability class. Actual apparent magnitude on a
// given pass can be brighter (closer range) or fainter (unfavourable phase);
// this is the intrinsic guide, not a live prediction (that arrives in Tier 2).
// Lower magnitude = brighter.
export function brightnessClass(stdMag) {
  if (stdMag == null || Number.isNaN(stdMag)) return null;
  if (stdMag <= 3.5) return { key: 'naked-eye', label: 'Naked eye' };
  if (stdMag <= 6.0) return { key: 'dark-sky', label: 'Naked eye (dark sky)' };
  if (stdMag <= 10.0) return { key: 'binoculars', label: 'Binoculars' };
  return { key: 'telescope', label: 'Telescope' };
}

// ---- Objects with no element set -----------------------------------------
// A catalogued object does not necessarily have orbital elements. CelesTrak's
// SATCAT lists 975 on-orbit objects with a DATA_STATUS_CODE instead of a GP
// record, and orbit-data passes that through as `dataStatus`. Two genuinely
// different situations hide behind it, and the UI must not conflate them:
//
//   - 734 Earth-orbiting objects (overwhelmingly classified US payloads) whose
//     elements are withheld. USA 224 — NORAD 37348, COSPAR 2011-002A — is the
//     canonical one: a real, ordinary sun-synchronous orbit that CelesTrak has
//     never published a TLE or OMM for, and never will. Nothing is broken; the
//     data simply is not published.
//   - 241 deep-space probes (Pioneer, Mariner, Ranger …) orbiting the Sun or
//     another body. For those, "no TLE" is a category error rather than a
//     restriction: there is no Earth orbit for an element set to describe.
//
// `dataStatus`, `orbitCenter` and `approximateOrbit` are additive fields, so a
// tree published before orbit-data shipped them carries none of the three.
// Everything here treats them as optional and returns null when absent, which
// is exactly the pre-existing behaviour.

// SATCAT orbit centres we can name. `orbitCenter` arrives friendly and
// lower-cased; an unmapped centre comes through as its raw SATCAT code.
const ORBIT_CENTER_NAMES = {
  earth: 'Earth', sun: 'the Sun', moon: 'the Moon',
  mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter',
  saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune', pluto: 'Pluto',
};

// Display name for the body an object orbits, or null when we have none.
export function orbitCenterName(orbitCenter) {
  if (!orbitCenter) return null;
  const key = String(orbitCenter).trim().toLowerCase();
  return ORBIT_CENTER_NAMES[key] || String(orbitCenter).trim();
}

// An absent centre means Earth (the field is additive, and everything with a
// GP record is Earth-orbiting). `ea` is SATCAT's own raw code for Earth, and is
// accepted too so an unmapped code can never be read as "not in Earth orbit".
function isEarthOrbit(orbitCenter) {
  if (!orbitCenter) return true;
  const key = String(orbitCenter).trim().toLowerCase();
  return key === 'earth' || key === 'ea';
}

const NO_ELEMENT_LABELS = {
  'no-elements-available': 'No public element set',
  'no-current-elements': 'No current element set',
  'no-initial-elements': 'No initial element set',
};

const NO_ELEMENT_DETAILS = {
  'no-elements-available':
    'Orbital data for this object is not published, so its position, ground '
    + 'track and passes cannot be computed.',
  'no-current-elements':
    'Current orbital data for this object is not published, so its position, '
    + 'ground track and passes cannot be computed.',
  'no-initial-elements':
    'No orbital data has been published for this object since launch, so its '
    + 'position, ground track and passes cannot be computed.',
};

const UNKNOWN_STATUS = {
  label: 'No element set',
  detail: 'Orbital data for this object is not published, so its position, '
    + 'ground track and passes cannot be computed.',
};

// What to say about an object's orbital elements, or null when it has them.
// A non-null result is a statement of fact about the published catalogue, not
// an error: the caller should render it as ordinary content.
export function elementStatus(rec) {
  const status = rec && rec.dataStatus;
  if (!status) return null;

  if (!isEarthOrbit(rec.orbitCenter)) {
    const body = orbitCenterName(rec.orbitCenter);
    return {
      key: 'not-earth-orbit',
      label: 'Not in Earth orbit',
      // An approximate *Earth* orbit is meaningless for a heliocentric probe,
      // so it is dropped here even if the record carries one.
      detail: `This object orbits ${body}, not Earth. It has no Earth-orbit `
        + 'element set, and no position, ground track or passes to show.',
      approximateOrbit: null,
    };
  }

  return {
    key: status,
    label: NO_ELEMENT_LABELS[status] || UNKNOWN_STATUS.label,
    detail: NO_ELEMENT_DETAILS[status] || UNKNOWN_STATUS.detail,
    approximateOrbit: rec.approximateOrbit || null,
  };
}

// Shown with every approximate orbit. SATCAT's period/inclination/apogee/
// perigee describe the orbit in the round; they are not an element set and
// carry no epoch, so nothing can be propagated from them.
export const APPROXIMATE_ORBIT_NOTE =
  'Approximate catalogue values, not an element set — not suitable for '
  + 'pointing or pass prediction.';

// Ordered [label, value] rows for an approximate orbit (skips absent fields),
// matching the enrichment readout's row shape.
export function approximateOrbitRows(approx) {
  if (!approx) return [];
  const rows = [];
  const add = (label, value, fmt) => {
    if (value != null && Number.isFinite(Number(value))) rows.push([label, fmt(Number(value))]);
  };
  add('Period', approx.periodMinutes, (v) => `${v.toFixed(1)} min`);
  add('Inclination', approx.inclinationDeg, (v) => `${v.toFixed(2)}°`);
  add('Apogee', approx.apogeeKm, (v) => `${Math.round(v).toLocaleString()} km`);
  add('Perigee', approx.perigeeKm, (v) => `${Math.round(v).toLocaleString()} km`);
  return rows;
}
