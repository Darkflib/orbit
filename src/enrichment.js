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
