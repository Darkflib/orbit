// Adapter: constellation figure lines ("stick figures") for the sky view.
//
// Like bsc5.mjs this is NOT satellite enrichment — it produces a standalone sky
// artifact (data/sky/constellations.json) and is never joined to the
// NORAD-keyed satellite records.
//
// WHY A SEPARATE SOURCE: the star catalogue gives positions and a Bayer
// designation, so it says which constellation a star *belongs to* ("9Alp CMa"),
// but nothing about which star joins which. Figure lines are a human
// convention with no authoritative catalogue behind them — the IAU standardised
// constellation *boundaries* (Delporte, 1930), never the stick figures — so
// they have to come from somewhere that made an editorial choice.
//
// SOURCING NOTE: vendored rather than fetched (scripts/enrich/vendor/
// constellation-lines.json). The figures do not change, so re-fetching a static
// file on every build would only add a network dependency and a way to fail.
// Source: d3-celestial (Olaf Frohn), BSD-3-Clause — permissive and compatible
// with this project's MIT licence, with attribution recorded in SOURCES.md.
// A missing vendored file is non-fatal: the build reports zero constellations
// and the sky view simply draws no lines, exactly like a missing star
// catalogue.
//
// FORMAT: GeoJSON FeatureCollection, one Feature per constellation, geometry a
// MultiLineString of [ra, dec] pairs in degrees. RA is signed (-180..180) in
// the source and normalised to 0..360 here so it matches stars.json and what
// celestial.js `starVectorEqj` expects. Positions are J2000, the same equinox
// as the star catalogue — they have to be, or the lines would drift off their
// stars once precession is applied.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'vendor', 'constellation-lines.json');

export const id = 'constellation-figures';
export const licence =
  'Constellation figure lines © Olaf Frohn, from d3-celestial — BSD-3-Clause; ' +
  'positions J2000, consistent with the BSC5 star set';

// Four decimal places is ~0.36 arcsec, far finer than the lines are meaningful
// to, and it keeps the artifact small.
const round = (v) => Math.round(v * 1e4) / 1e4;

// A coordinate must already be a finite number. Deliberately not `Number(v)`:
// `Number(null)` is 0, so a null in the source would silently become RA 0° —
// a real point on the sky, in the wrong place, with nothing to flag it.
const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Load and normalise into a Map<constellationId, { id, lines }>, where `lines`
// is an array of polylines and each polyline is a flat [ra, dec, ra, dec, ...]
// run. Flat pairs rather than nested [ra, dec] tuples: the renderer walks them
// straight into a vertex buffer, and it roughly halves the JSON's punctuation.
export async function load(_http, { path = VENDOR } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { records: new Map(), meta: { ok: false, reason: err.message, vendored: true } };
  }

  let geo;
  try {
    geo = JSON.parse(text);
  } catch (err) {
    return { records: new Map(), meta: { ok: false, reason: `parse: ${err.message}`, vendored: true } };
  }

  const records = new Map();
  let segments = 0;

  for (const feature of geo.features ?? []) {
    const key = feature.id;
    const coords = feature.geometry?.coordinates;
    if (!key || !Array.isArray(coords)) continue;

    const lines = [];
    for (const polyline of coords) {
      // A single point draws nothing — drop it rather than emit a degenerate run.
      if (!Array.isArray(polyline) || polyline.length < 2) continue;
      const flat = [];
      let malformed = false;
      for (const point of polyline) {
        const ra = coord(point?.[0]);
        const dec = coord(point?.[1]);
        // Drop the whole polyline rather than skip the bad point: skipping would
        // join that point's neighbours with a segment that is not in the source,
        // inventing a line rather than losing one.
        if (ra === null || dec === null) { malformed = true; break; }
        flat.push(round(ra < 0 ? ra + 360 : ra), round(dec));
      }
      if (!malformed && flat.length >= 4) { // at least two points
        lines.push(flat);
        segments += flat.length / 2 - 1;
      }
    }

    // Serpens is the reason this merges rather than assigns: it is the one
    // constellation split into two disjoint halves (Caput and Cauda), and the
    // source carries it as two Features sharing `id: "Ser"`. A plain
    // `records.set` drops the first half while the segment count still counts
    // it — the artifact silently loses a constellation's worth of lines.
    if (lines.length) {
      const existing = records.get(key);
      if (existing) existing.lines.push(...lines);
      else records.set(key, { id: key, lines });
    }
  }

  return { records, meta: { ok: true, vendored: true, segments } };
}
