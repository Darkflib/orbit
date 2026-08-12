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
//     another body, sitting at a Lagrange point, or — Pioneer 10 — leaving the
//     solar system entirely. For those, "no TLE" is a category error rather
//     than a restriction: there is no Earth orbit for an element set to
//     describe.
//
// `orbitCenter` is not always a body. SATCAT's published values cover bodies,
// Earth-system places (Lagrange points, the Earth–Moon barycentre), the escape
// case, and — for a docked object — the host object's NORAD catalog number.
// The last of those is still Earth orbit, and is classified as such below.
//
// `dataStatus`, `orbitCenter` and `approximateOrbit` are additive fields, so a
// tree published before orbit-data shipped them carries none of the three.
// Everything here treats them as optional and returns null when absent, which
// is exactly the pre-existing behaviour.

// Bodies an object can orbit. The sentence built from these reads
// "orbits <name>, not Earth", so the article belongs in the name.
const ORBIT_CENTER_BODIES = {
  sun: 'the Sun', moon: 'the Moon', mercury: 'Mercury', venus: 'Venus',
  mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus',
  neptune: 'Neptune', pluto: 'Pluto', asteroid: 'an asteroid', comet: 'a comet',
};

// Centres that are not bodies: a place in the Earth–Sun or Earth–Moon system,
// or no centre at all. "Orbits X" is wrong for every one of these — Pioneer 10
// does not orbit its escape trajectory — so each carries its own clause.
const ORBIT_CENTER_PLACES = {
  'earth-lagrange': {
    name: 'an Earth-system Lagrange point',
    clause: 'is at an Earth-system Lagrange point',
  },
  'earth-sun-l1': { name: 'the Earth–Sun L1 point', clause: 'is at the Earth–Sun L1 point' },
  'earth-sun-l2': { name: 'the Earth–Sun L2 point', clause: 'is at the Earth–Sun L2 point' },
  'earth-sun-l3': { name: 'the Earth–Sun L3 point', clause: 'is at the Earth–Sun L3 point' },
  'earth-sun-l4': { name: 'the Earth–Sun L4 point', clause: 'is at the Earth–Sun L4 point' },
  'earth-sun-l5': { name: 'the Earth–Sun L5 point', clause: 'is at the Earth–Sun L5 point' },
  'earth-moon-barycenter': {
    name: 'the Earth–Moon barycentre',
    clause: 'is at the Earth–Moon barycentre',
  },
  'solar-system-escape': {
    name: 'a solar-system escape trajectory',
    clause: 'is on an escape trajectory out of the solar system',
  },
};

// A numeric centre is not a body at all: SATCAT puts the *host object's* NORAD
// catalog number there for something docked to it. A module docked to the ISS
// is very much in Earth orbit, so this must never fall through to the "not in
// Earth orbit" wording. (Latent, not live: no row currently carries both a
// numeric centre and a dataStatus.)
const DOCKED_RE = /^\d+$/;

// Classify a centre. `earth` and an absent value are the common cases; `ea` is
// SATCAT's own raw code for Earth and is accepted so that a raw code can never
// be read as "not in Earth orbit". An unrecognised value is reported as
// unknown rather than guessed at, because claiming an object orbits a string we
// do not understand is worse than saying we do not know what it orbits.
function orbitCenterInfo(orbitCenter) {
  if (!orbitCenter) return { kind: 'earth', name: 'Earth' };
  const raw = String(orbitCenter).trim();
  const key = raw.toLowerCase();
  if (key === 'earth' || key === 'ea') return { kind: 'earth', name: 'Earth' };
  if (DOCKED_RE.test(key)) return { kind: 'docked', name: `NORAD ${raw}`, host: raw };
  if (ORBIT_CENTER_BODIES[key]) return { kind: 'body', name: ORBIT_CENTER_BODIES[key] };
  const place = ORBIT_CENTER_PLACES[key];
  if (place) return { kind: 'place', name: place.name, clause: place.clause };
  return { kind: 'unknown', name: raw };
}

// Display name for what an object orbits, or null when we have none.
export function orbitCenterName(orbitCenter) {
  return orbitCenter ? orbitCenterInfo(orbitCenter).name : null;
}

// Earth orbit covers the plain centre, an absent one, and a docked object,
// whose centre names its host rather than a body.
function isEarthOrbit(orbitCenter) {
  const kind = orbitCenterInfo(orbitCenter).kind;
  return kind === 'earth' || kind === 'docked';
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
  const centre = orbitCenterInfo(rec.orbitCenter);

  if (centre.kind !== 'earth' && centre.kind !== 'docked') {
    // One sentence per kind of centre, because "orbits X" is only true of a
    // body: a probe at Earth–Sun L2 orbits nothing, and one on a solar-system
    // escape trajectory is not bound to anything at all.
    const where = centre.kind === 'body'
      ? `This object orbits ${centre.name}, not Earth.`
      : centre.kind === 'place'
        ? `This object ${centre.clause}, not in Earth orbit.`
        : `This object is not in Earth orbit (catalogue centre: ${centre.name}).`;
    return {
      key: 'not-earth-orbit',
      label: 'Not in Earth orbit',
      // An approximate *Earth* orbit is meaningless out here, so it is dropped
      // even if the record carries one.
      detail: `${where} It has no Earth-orbit element set, and no position, `
        + 'ground track or passes to show.',
      approximateOrbit: null,
    };
  }

  const detail = NO_ELEMENT_DETAILS[status] || UNKNOWN_STATUS.detail;
  return {
    key: status,
    label: NO_ELEMENT_LABELS[status] || UNKNOWN_STATUS.label,
    // A docked object's centre names its host, which is worth saying: it is in
    // Earth orbit, attached to something else that has its own catalogue entry.
    detail: centre.kind === 'docked' ? `${detail} It is docked to ${centre.name}.` : detail,
    dockedTo: centre.kind === 'docked' ? centre.host : null,
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
