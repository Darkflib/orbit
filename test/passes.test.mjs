// Tests for visible-pass prediction (src/passes.js). Deterministic: a fixed ISS
// TLE and a fixed start time near its epoch (no network), scanned over a grid of
// observers. Assertions are on invariants that must hold for any output, so they
// don't depend on the exact pass times.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';

import { predictPasses } from '../src/passes.js';

// ISS TLE from the satellite.js README — guaranteed to parse. Epoch 2019-06-05.
const L1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const L2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';
const satrec = satellite.twoline2satrec(L1, L2);
const FROM = Date.UTC(2019, 5, 5, 12, 0, 0); // near the TLE epoch — SGP4 valid

// Collect every pass across a grid of observers for a given intrinsic magnitude.
function scanGrid(stdMag, hours = 48) {
  const all = [];
  let geomVisible = 0;
  for (const lat of [-50, -30, 0, 30, 50]) {
    for (let lon = -180; lon < 180; lon += 20) {
      const r = predictPasses(satrec, { lat, lon, altKm: 0 }, FROM, stdMag, { hours });
      geomVisible += r.geomVisible;
      for (const p of r.passes) all.push(p);
    }
  }
  return { all, geomVisible };
}

test('every predicted pass is internally consistent (peak within its window)', () => {
  const { all } = scanGrid(-2);
  assert.ok(all.length > 0, 'expected at least one visible pass across the observer grid');
  for (const p of all) {
    assert.ok(p.visibleEnd >= p.visibleStart, 'window end before start');
    assert.ok(
      p.peakTime >= p.visibleStart && p.peakTime <= p.visibleEnd,
      `peak ${p.peakTime} outside [${p.visibleStart}, ${p.visibleEnd}]`,
    );
    // Every sample in a pass cleared the 10° elevation gate, so its peak must too.
    assert.ok(p.peakElevation >= 10, `peak elevation ${p.peakElevation} below gate`);
    // The window is bounded by the naked-eye cutoff, so the peak can't be fainter.
    if (p.peakMag != null) assert.ok(p.peakMag <= 6.5 + 1e-9, `peakMag ${p.peakMag} > cutoff`);
  }
});

test('a too-faint object yields no naked-eye passes but still counts sunlit ones', () => {
  const bright = scanGrid(-2);
  const faint = scanGrid(12); // far fainter than the 6.5 naked-eye cutoff
  assert.ok(bright.all.length > 0, 'bright object should have visible passes');
  assert.equal(faint.all.length, 0, 'mag-12 object should have no naked-eye passes');
  assert.ok(faint.geomVisible > 0, 'but its sunlit/dark passes should still be counted');
});

test('an object with unknown magnitude is not excluded by the cutoff', () => {
  // stdMag null → apparentMag null → cannot rule the pass out on brightness.
  const { all } = scanGrid(null);
  assert.ok(all.length > 0, 'unknown-magnitude object should still yield passes');
  for (const p of all) assert.equal(p.peakMag, null);
});

test('respects the maxPasses cap per call', () => {
  const r = predictPasses(satrec, { lat: -45, lon: -150, altKm: 0 }, FROM, -2, { hours: 72, maxPasses: 2 });
  assert.ok(r.passes.length <= 2, `got ${r.passes.length} passes`);
});
