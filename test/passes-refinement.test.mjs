// Tests for the sub-step refinement in src/passes.js (event times + culmination).
//
// The scan samples elevation/visibility on a fixed grid; the reported window
// edges and peak are then refined off that grid. These tests lock in that the
// refinement actually removes the step quantisation, by the same yardstick the
// 2026-08-04 validation established: Orbit's own code run at a 1 s step
// reproduces the independent Skyfield/DE421 reference to ~1 s and ~0.1°, so the
// shipped 30 s output agreeing with a 1 s run is the self-contained proof that
// the refinement has recovered reference-grade numbers without the finer grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';

import { predictPasses } from '../src/passes.js';
import { RAD2DEG, DEG2RAD } from '../src/constants.js';

// Same fixed ISS TLE + epoch as passes.test.mjs (deterministic, no network).
const L1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const L2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';
const satrec = satellite.twoline2satrec(L1, L2);
const FROM = Date.UTC(2019, 5, 5, 12, 0, 0);

const OBSERVERS = [];
for (const lat of [-50, -30, 0, 30, 50]) {
  for (let lon = -180; lon < 180; lon += 20) OBSERVERS.push({ lat, lon, altKm: 0 });
}

// Pair each 30 s pass with the 1 s pass whose window it best overlaps (nearest
// visibleStart). Passes are ~90 min apart, so a 60 s match radius can't confuse
// one for another.
function matchedPairs(observer) {
  const coarse = predictPasses(satrec, observer, FROM, -2, { hours: 24, maxPasses: 20 }).passes;
  const fine = predictPasses(satrec, observer, FROM, -2, { hours: 24, stepSec: 1, maxPasses: 20 }).passes;
  const pairs = [];
  for (const c of coarse) {
    let best = null;
    let bestD = Infinity;
    for (const f of fine) {
      const d = Math.abs(f.visibleStart - c.visibleStart);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best && bestD < 60e3) pairs.push({ c, f: best });
  }
  return pairs;
}

test('refined 30 s events reproduce a 1 s scan across an observer grid', () => {
  let n = 0;
  for (const observer of OBSERVERS) {
    for (const { c, f } of matchedPairs(observer)) {
      n++;
      // Edges: compared only where both scans found a real rise/set (not a scan
      // boundary), since a clipped edge is intentionally left unrefined.
      if (!c.startClipped && !f.startClipped) {
        assert.ok(
          Math.abs(c.visibleStart - f.visibleStart) < 1500,
          `AOS off by ${Math.abs(c.visibleStart - f.visibleStart)} ms`,
        );
      }
      if (!c.endClipped && !f.endClipped) {
        assert.ok(
          Math.abs(c.visibleEnd - f.visibleEnd) < 1500,
          `LOS off by ${Math.abs(c.visibleEnd - f.visibleEnd)} ms`,
        );
      }
      // Peak elevation: the headline metric, understated by up to ~9° on the raw
      // grid. Refined, it must track the 1 s run to a fraction of a degree.
      assert.ok(
        Math.abs(c.peakElevation - f.peakElevation) < 0.3,
        `peak elevation off by ${Math.abs(c.peakElevation - f.peakElevation).toFixed(3)}°`,
      );
      // Peak azimuth (hence the compass bearing) — but only away from the zenith,
      // where azimuth genuinely sweeps ~180° through the overhead point and a
      // millisecond of peak-time difference is a large, meaningless azimuth swing.
      if (c.peakElevation < 85 && f.peakElevation < 85) {
        let dAz = Math.abs(c.peakAzimuth - f.peakAzimuth);
        if (dAz > 180) dAz = 360 - dAz;
        assert.ok(dAz < 3, `peak azimuth off by ${dAz.toFixed(2)}°`);
      }
    }
  }
  assert.ok(n >= 40, `expected a healthy sample of matched passes, got ${n}`);
});

// Raw grid-sample maximum elevation within a window — what the pre-refinement
// code reported (the highest sample on the FROM-aligned 30 s grid).
function rawGridPeak(observer, startMs, endMs) {
  const gd = { longitude: observer.lon * DEG2RAD, latitude: observer.lat * DEG2RAD, height: 0 };
  let max = 0;
  for (let t = FROM; t <= endMs; t += 30_000) {
    if (t < startMs) continue;
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    const el = satellite.ecfToLookAngles(gd, satellite.eciToEcf(pv.position, satellite.gstime(date)))
      .elevation * RAD2DEG;
    if (el > max) max = el;
  }
  return max;
}

test('a near-zenith pass is no longer understated by the grid', () => {
  // Highest pass across the grid — the case the 30 s grid hurts most.
  let best = null;
  let bestObs = null;
  for (const observer of OBSERVERS) {
    for (const p of predictPasses(satrec, observer, FROM, -2, { hours: 24, maxPasses: 20 }).passes) {
      if (!best || p.peakElevation > best.peakElevation) { best = p; bestObs = observer; }
    }
  }
  assert.ok(best.peakElevation > 88, `expected a near-zenith pass, got ${best.peakElevation.toFixed(1)}°`);

  // The raw grid would have understated this peak by several degrees; refinement
  // recovers it.
  const raw = rawGridPeak(bestObs, best.visibleStart, best.visibleEnd);
  assert.ok(
    best.peakElevation - raw > 1.5,
    `refinement should lift the peak well clear of the grid sample (raw ${raw.toFixed(2)}°, refined ${best.peakElevation.toFixed(2)}°)`,
  );

  // And it must land on the true culmination, per a 1 s scan.
  const fine = predictPasses(satrec, bestObs, FROM, -2, { hours: 24, stepSec: 1, maxPasses: 20 }).passes
    .reduce((a, p) => (Math.abs(p.visibleStart - best.visibleStart) < 60e3
      && (!a || p.peakElevation > a.peakElevation) ? p : a), null);
  assert.ok(Math.abs(best.peakElevation - fine.peakElevation) < 0.3, 'refined peak should match the 1 s culmination');
});
