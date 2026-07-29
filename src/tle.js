// ---------------------------------------------------------------------------
// TLE fetching, parsing and caching.
//
// TLE (Two-Line Element) sets are fetched from CelesTrak at most once every two
// hours and cached in localStorage. Between fetches, satellite.js propagates
// positions locally, so the "real-time" motion costs no network traffic.
// ---------------------------------------------------------------------------
import { CELESTRAK_URL, TLE_CACHE_PREFIX, TLE_MAX_AGE_MS } from './constants.js';

// Parse raw 3-line TLE text into records. Each satellite is a name line
// followed by "1 ..." and "2 ..." element lines.
export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (l1 && l2 && l1.startsWith('1 ') && l2.startsWith('2 ')) {
      out.push({
        name: name.trim() || `NORAD ${l1.slice(2, 7).trim()}`,
        l1,
        l2,
        norad: l1.slice(2, 7).trim(),
      });
      i += 2;
    }
  }
  return out;
}

function cacheKey(group) {
  return TLE_CACHE_PREFIX + group;
}

function readCache(group) {
  try {
    const raw = localStorage.getItem(cacheKey(group));
    if (!raw) return null;
    const { fetchedAt, text } = JSON.parse(raw);
    return { fetchedAt, text };
  } catch {
    return null;
  }
}

function writeCache(group, text) {
  try {
    localStorage.setItem(
      cacheKey(group),
      JSON.stringify({ fetchedAt: Date.now(), text }),
    );
  } catch {
    // Storage may be full or blocked (private mode) — non-fatal.
  }
}

// Fetch one CelesTrak group, using the cache when it is still fresh.
// Returns { records, fetchedAt, fromCache }.
export async function fetchGroup(group, { force = false } = {}) {
  const cached = readCache(group);
  const fresh = cached && Date.now() - cached.fetchedAt < TLE_MAX_AGE_MS;

  if (cached && fresh && !force) {
    return { records: parseTle(cached.text), fetchedAt: cached.fetchedAt, fromCache: true };
  }

  try {
    const res = await fetch(CELESTRAK_URL(group), { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const records = parseTle(text);
    if (records.length === 0) throw new Error('no elements returned');
    writeCache(group, text);
    return { records, fetchedAt: Date.now(), fromCache: false };
  } catch (err) {
    // Network/CORS failure — fall back to a stale cache if we have one.
    if (cached) {
      return { records: parseTle(cached.text), fetchedAt: cached.fetchedAt, fromCache: true, stale: true };
    }
    throw err;
  }
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
