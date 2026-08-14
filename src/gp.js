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
  GP_FETCH_TIMEOUT_MS, GP_REMOTE_STALE_MS, ORBIT_DATA_FETCH_TIMEOUT_MS,
  ORBIT_DATA_GP_URL, REENTRY_LAYER, REENTRY_MAX_AGE_MS,
} from './constants.js';

// fetch() + JSON parse under a single hard timeout. A stalled request aborts
// after `timeoutMs` instead of hanging forever; the abort surfaces as a
// rejection, which the callers below turn into a stale-cache fallback or a
// normal fetch error.
//
// The deadline deliberately spans the body read as well as the headers: fetch()
// resolves as soon as the response headers arrive, so a server that then stalls
// or trickles the JSON body would slip past a timeout that only guarded the
// headers. Keeping the timer armed until `res.json()` settles (it is cleared in
// `finally`, after the parse) means a stalled body is aborted too.
async function fetchJsonWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const receivedAt = Date.now();
    const lastModified = res.headers?.get?.('last-modified');
    const parsedLastModified = lastModified ? Date.parse(lastModified) : NaN;
    return {
      data,
      fetchedAt: Number.isNaN(parsedLastModified)
        ? receivedAt
        : Math.min(parsedLastModified, receivedAt),
    };
  } finally {
    clearTimeout(timer);
  }
}

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

const OMM_NUMERIC_FIELDS = [
  'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT', 'EPHEMERIS_TYPE', 'ELEMENT_SET_NO',
];

function validOmmNumber(value) {
  return value !== '' && value != null && Number.isFinite(Number(value));
}

// Keep a malformed mirror response from bypassing the upstream fallback and
// poisoning localStorage. The server performs stricter whole-dataset checks;
// this browser-side gate covers the fields and physical ranges json2satrec
// needs for an individual record.
function isUsableOmm(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (!OMM_FIELDS.every((field) => Object.hasOwn(o, field))) return false;
  if (!OMM_NUMERIC_FIELDS.every((field) => validOmmNumber(o[field]))) return false;

  const norad = Number(o.NORAD_CAT_ID);
  if (!Number.isInteger(norad) || norad < 1 || norad > 999999999) return false;
  if (typeof o.EPOCH !== 'string' || Number.isNaN(Date.parse(o.EPOCH))) return false;
  if (typeof o.CLASSIFICATION_TYPE !== 'string' || !o.CLASSIFICATION_TYPE) return false;

  const meanMotion = Number(o.MEAN_MOTION);
  const eccentricity = Number(o.ECCENTRICITY);
  const inclination = Number(o.INCLINATION);
  if (!(meanMotion > 0 && meanMotion < 20)) return false;
  if (!(eccentricity >= 0 && eccentricity < 1)) return false;
  if (!(inclination >= 0 && inclination <= 180)) return false;
  return ['RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY']
    .every((field) => Number(o[field]) >= 0 && Number(o[field]) <= 360);
}

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

function writeCache(group, records, fetchedAt) {
  try {
    localStorage.setItem(
      cacheKey(group),
      JSON.stringify({ fetchedAt, rows: records.map(recordToRow) }),
    );
  } catch {
    // Storage may be full (large group over quota) or blocked (private mode).
    // Non-fatal: we simply refetch next time rather than serving from cache.
  }
}

// Shared fetch-and-cache core. The static mirror is always preferred; direct
// CelesTrak access is an emergency fallback, followed by stale localStorage.
// Returns { records, fetchedAt, fromCache, source, stale? }.
async function fetchElements(
  cacheName,
  mirrorUrl,
  upstreamUrl,
  maxAge,
  force,
  timeoutMs,
) {
  const cached = readCache(cacheName);
  const fresh = cached && Date.now() - cached.fetchedAt < maxAge;

  if (cached && fresh && !force) {
    return {
      records: cached.records,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
      source: 'browser-cache',
    };
  }

  const staleCache = () => ({
    records: cached.records,
    fetchedAt: cached.fetchedAt,
    fromCache: true,
    source: 'browser-cache',
    stale: true,
  });

  // With no network the two attempts below can only time out, in series —
  // measured at 21.6s of "Fetching orbital elements…" before the app gives up.
  // That was tolerable when this was a page you opened online; it is not once
  // the app is installed and launching out of signal is routine.
  //
  // `navigator.onLine` is only trusted in this one direction. It can wrongly
  // report true behind a captive portal, which is why it never *stops* a fetch
  // that might have worked — but a false is a real answer, and all it does here
  // is skip ahead to the fallback the code would have reached anyway.
  // `typeof` guarded because this module is also imported by the Node test
  // suite, and `navigator` is only a global from Node 21 — CI runs 20, where a
  // bare reference is a ReferenceError rather than an undefined.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (cached) return staleCache();
    throw new Error('offline, and no orbital elements have been cached yet');
  }

  const attempts = [
    {
      source: 'orbit-data',
      url: mirrorUrl,
      timeout: timeoutMs ?? ORBIT_DATA_FETCH_TIMEOUT_MS,
    },
    {
      source: 'celestrak',
      url: upstreamUrl,
      timeout: timeoutMs ?? GP_FETCH_TIMEOUT_MS,
    },
  ];
  const failures = [];

  for (const attempt of attempts) {
    try {
      const { data, fetchedAt } = await fetchJsonWithTimeout(
        attempt.url,
        { mode: 'cors' },
        attempt.timeout,
      );
      if (!Array.isArray(data) || data.length === 0) throw new Error('no elements returned');
      const records = data.filter(isUsableOmm).map(ommToRecord);
      if (records.length === 0) throw new Error('no usable elements returned');
      writeCache(cacheName, records, fetchedAt);
      return {
        records,
        fetchedAt,
        fromCache: false,
        source: attempt.source,
        stale: Date.now() - fetchedAt >= GP_REMOTE_STALE_MS,
      };
    } catch (error) {
      failures.push(`${attempt.source}: ${error.message}`);
    }
  }

  if (cached) return staleCache();
  throw new Error(`GP data unavailable (${failures.join('; ')})`);
}

// Fetch one CelesTrak group, using the cache when it is still fresh.
// Returns { records, fetchedAt, fromCache }.
export async function fetchGroup(group, { force = false, timeoutMs } = {}) {
  return fetchElements(
    group,
    ORBIT_DATA_GP_URL(group),
    CELESTRAK_URL(group),
    GP_MAX_AGE_MS,
    force,
    timeoutMs,
  );
}

// Fetch CelesTrak's decaying-objects watch list (SPECIAL=DECAYING). Records are
// tagged with the reentry layer so the shared satellite field colours them as
// reentry candidates. It follows the same two-hour mirror publication cadence.
export async function fetchDecaying({ force = false, timeoutMs } = {}) {
  const r = await fetchElements(
    'special.decaying',
    ORBIT_DATA_GP_URL('special-decaying'),
    CELESTRAK_SPECIAL_URL(REENTRY_LAYER.special),
    REENTRY_MAX_AGE_MS,
    force,
    timeoutMs,
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
