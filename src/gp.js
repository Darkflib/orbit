// ---------------------------------------------------------------------------
// GP (general-perturbations) data: fetching, parsing and caching.
//
// CelesTrak serves orbital data as OMM (Orbit Mean-Elements Message, CCSDS)
// records. We request the JSON format and build SGP4 records from it with
// satellite.js `json2satrec`. Unlike the legacy TLE format, OMM has no 5-digit
// catalog-number limit, so it can represent the 6-digit objects CelesTrak
// began issuing in 2026.
//
// Data is fetched at most once every two hours and cached in localStorage.
// Between fetches, satellite.js propagates positions locally, so the
// "real-time" motion costs no network traffic.
// ---------------------------------------------------------------------------
import {
  CELESTRAK_URL, CELESTRAK_SPECIAL_URL, GP_CACHE_PREFIX, GP_MAX_AGE_MS,
  REENTRY_LAYER, REENTRY_MAX_AGE_MS,
} from './constants.js';

// The OMM fields we keep. This is exactly what `json2satrec` needs plus the
// name and international designator for display. Verified sufficient: a satrec
// built from these propagates identically to one built from the full record.
// Order matters — it defines the positional cache encoding below.
const OMM_FIELDS = [
  'OBJECT_NAME', 'NORAD_CAT_ID', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION',
  'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER',
  'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
  'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'ELEMENT_SET_NO',
];

// Normalise a raw CelesTrak OMM object into our internal record. `omm` holds
// just the fields json2satrec consumes.
function ommToRecord(o) {
  const norad = String(o.NORAD_CAT_ID);
  const omm = {};
  for (const k of OMM_FIELDS) omm[k] = o[k];
  return {
    name: (o.OBJECT_NAME && o.OBJECT_NAME.trim()) || `NORAD ${norad}`,
    norad,
    intlDes: o.OBJECT_ID || '',
    omm,
  };
}

// Compact localStorage encoding: a positional array per record instead of a
// keyed object, which drops the repeated OMM key names (~60% smaller). Keeps
// large constellations (e.g. Starlink) comfortably within the storage quota.
function recordToRow(rec) {
  return OMM_FIELDS.map((k) => rec.omm[k]);
}
function rowToRecord(row) {
  const o = {};
  OMM_FIELDS.forEach((k, i) => { o[k] = row[i]; });
  return ommToRecord(o);
}

function cacheKey(group) {
  return GP_CACHE_PREFIX + group;
}

function readCache(group) {
  try {
    const raw = localStorage.getItem(cacheKey(group));
    if (!raw) return null;
    const { fetchedAt, rows } = JSON.parse(raw);
    if (!Array.isArray(rows)) return null;
    return { fetchedAt, records: rows.map(rowToRecord) };
  } catch {
    return null;
  }
}

function writeCache(group, records) {
  try {
    localStorage.setItem(
      cacheKey(group),
      JSON.stringify({ fetchedAt: Date.now(), rows: records.map(recordToRow) }),
    );
  } catch {
    // Storage may be full (large group over quota) or blocked (private mode).
    // Non-fatal: we simply refetch next time rather than serving from cache.
  }
}

// Shared fetch-and-cache core. `cacheName` keys the localStorage entry, `url`
// is the CelesTrak endpoint and `maxAge` how long a cache entry stays fresh.
// Returns { records, fetchedAt, fromCache, stale? }.
async function fetchElements(cacheName, url, maxAge, force) {
  const cached = readCache(cacheName);
  const fresh = cached && Date.now() - cached.fetchedAt < maxAge;

  if (cached && fresh && !force) {
    return { records: cached.records, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('no elements returned');
    const records = data.map(ommToRecord);
    writeCache(cacheName, records);
    return { records, fetchedAt: Date.now(), fromCache: false };
  } catch (err) {
    // Network/CORS/parse failure — fall back to a stale cache if we have one.
    if (cached) {
      return { records: cached.records, fetchedAt: cached.fetchedAt, fromCache: true, stale: true };
    }
    throw err;
  }
}

// Fetch one CelesTrak group, using the cache when it is still fresh.
// Returns { records, fetchedAt, fromCache }.
export async function fetchGroup(group, { force = false } = {}) {
  return fetchElements(group, CELESTRAK_URL(group), GP_MAX_AGE_MS, force);
}

// Fetch CelesTrak's decaying-objects watch list (SPECIAL=DECAYING). Records are
// tagged with the reentry layer so the shared satellite field colours them as
// reentry candidates. Uses a separate, shorter-lived cache than group data.
export async function fetchDecaying({ force = false } = {}) {
  const r = await fetchElements(
    'special.decaying',
    CELESTRAK_SPECIAL_URL(REENTRY_LAYER.special),
    REENTRY_MAX_AGE_MS,
    force,
  );
  return { ...r, records: r.records.map((rec) => ({ ...rec, layerId: REENTRY_LAYER.id })) };
}

// Fetch every group referenced by the given layers, in parallel, and return a
// flat de-duplicated list of records tagged with their winning layer id.
// `priorityById` maps layer id -> numeric priority (lower wins on conflict).
export async function fetchLayers(layers, priorityById, opts = {}) {
  const jobs = [];
  for (const layer of layers) {
    for (const group of layer.groups) {
      jobs.push(
        fetchGroup(group, opts).then((r) => ({ ...r, layerId: layer.id, group })),
      );
    }
  }
  const results = await Promise.allSettled(jobs);

  const byNorad = new Map();
  let newestFetch = 0;
  let anyStale = false;
  const errors = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      errors.push(r.reason?.message || String(r.reason));
      continue;
    }
    const { records, layerId, fetchedAt, stale } = r.value;
    newestFetch = Math.max(newestFetch, fetchedAt || 0);
    if (stale) anyStale = true;
    const prio = priorityById[layerId] ?? 99;
    for (const rec of records) {
      const existing = byNorad.get(rec.norad);
      if (!existing || prio < existing._prio) {
        byNorad.set(rec.norad, { ...rec, layerId, _prio: prio });
      }
    }
  }

  return {
    records: Array.from(byNorad.values()),
    fetchedAt: newestFetch,
    stale: anyStale,
    errors,
  };
}
