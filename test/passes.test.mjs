// Tests for visible-pass prediction (src/passes.js). Deterministic: a fixed ISS
// TLE and a fixed start time near its epoch (no network), scanned over a grid of
// observers. Assertions are on invariants that must hold for any output, so they
// don't depend on the exact pass times.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';

import { predictPasses } from '../src/passes.js';
import { RAD2DEG } from '../src/constants.js';

// ISS TLE from the satellite.js README — guaranteed to parse. Epoch 2019-06-05.
const L1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const L2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';
const satrec = satellite.twoline2satrec(L1, L2);
const FROM = Date.UTC(2019, 5, 5, 12, 0, 0); // near the TLE epoch — SGP4 valid

// Synthetic element sets for the two regimes the ISS can't exercise. Circular,
// with the mean motion set to an exact sidereal-day fraction: one geostationary
// (never sets), one GPS-like MEO (sets, but only ever seen at ~20 000 km).
const GEO = satellite.twoline2satrec(
  '1 99999U 26001A   26216.00000000  .00000000  00000-0  00000-0 0  9990',
  '2 99999   0.0100  90.0000 0001000   0.0000 180.0000  1.00270000    10',
);
const MEO = satellite.twoline2satrec(
  '1 99998U 26002A   26216.00000000  .00000000  00000-0  00000-0 0  9992',
  '2 99998  55.0000  90.0000 0001000   0.0000 180.0000  2.00560000    10',
);
const SYNTH_FROM = Date.UTC(2026, 7, 4, 22, 0, 0);

// Observer directly beneath a satellite at a given instant — the deterministic
// way to put a geostationary object permanently overhead without hard-coding a
// longitude that depends on the element set's epoch.
function subPointObserver(rec, whenMs) {
  const date = new Date(whenMs);
  const pv = satellite.propagate(rec, date);
  assert.ok(pv && pv.position, 'synthetic element set failed to propagate');
  const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  return { lat: gd.latitude * RAD2DEG, lon: gd.longitude * RAD2DEG, altKm: 0 };
}

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

// The unknown-magnitude bound (see UNKNOWN_STD_MAG) exists to stop GEO/MEO
// objects with no magnitude on record being offered as naked-eye sightings. Its
// whole design constraint is that it must not cost anything in LEO, where the
// permissive behaviour is defensible and most objects do have a magnitude.
test('the unknown-magnitude bound removes no LEO windows', () => {
  let bounded = 0;
  let unbounded = 0;
  for (const lat of [-50, -30, 0, 30, 50]) {
    for (let lon = -180; lon < 180; lon += 20) {
      const observer = { lat, lon, altKm: 0 };
      bounded += predictPasses(satrec, observer, FROM, null, { hours: 48 }).passes.length;
      // A wildly optimistic assumed magnitude can never suppress anything, so
      // this reproduces the pre-fix behaviour exactly.
      unbounded += predictPasses(satrec, observer, FROM, null, { hours: 48, unknownStdMag: -99 }).passes.length;
    }
  }
  assert.ok(bounded > 0, 'expected LEO windows for an unknown-magnitude object');
  assert.equal(bounded, unbounded, 'the bound must not drop LEO windows');
});

test('an unknown-magnitude object at MEO range is sunlit but not offered as visible', () => {
  const observer = { lat: 52.83, lon: -1.28, altKm: 0 }; // Kegworth, UK
  const r = predictPasses(MEO, observer, SYNTH_FROM, null, { hours: 24 });
  assert.equal(r.alwaysUp, false, 'a 12 h orbit does set');
  assert.ok(r.geomVisible > 0, 'expected sunlit, dark-sky passes to still be counted');
  assert.equal(r.passes.length, 0, 'no naked-eye pass may be claimed without a magnitude at 20 000 km');
  assert.equal(r.unknownBrightness, true, 'the UI needs to know why the list is empty');
  // Not an artefact of the assumed magnitude being pessimistic: an object that
  // really is mag 2.0 is not naked-eye from there either.
  assert.equal(predictPasses(MEO, observer, SYNTH_FROM, 2.0, { hours: 24 }).passes.length, 0);
});

test('a never-setting object is reported as standing, not as one 24 h pass', () => {
  const observer = subPointObserver(GEO, SYNTH_FROM);
  const r = predictPasses(GEO, observer, SYNTH_FROM, null, { hours: 24 });
  assert.equal(r.alwaysUp, true);
  assert.equal(r.passes.length, 0, 'a fixed point in the sky has no passes');
  assert.equal(r.total, 0, '"1 pass in 24 h" is the claim this branch exists to avoid');
  assert.ok(r.standing, 'expected a standing summary');
  assert.ok(r.standing.elevation > 80, `overhead observer, got ${r.standing.elevation}°`);
  assert.ok(r.standing.darkMs > 0, 'a GEO object is sunlit in a dark sky for part of the night');
  assert.ok(r.standing.darkMs <= 24 * 3600e3);
  assert.equal(r.standing.nakedEye, false, 'nothing at 36 000 km is a naked-eye object');
  // Even given a bright intrinsic magnitude, the range term keeps it invisible —
  // the standing summary must report the magnitude rather than a pass.
  const bright = predictPasses(GEO, observer, SYNTH_FROM, 1.0, { hours: 24 });
  assert.ok(bright.standing.brightestMag > 6.5, `mag ${bright.standing.brightestMag}`);
  assert.equal(bright.passes.length, 0);
});

test('"always up" is only claimed over a scan long enough to mean it', () => {
  const observer = subPointObserver(GEO, SYNTH_FROM);
  // Same permanently-up object, but a scan too short to distinguish it from a
  // pass in progress: it must degrade to a clipped pass, not claim it never sets.
  const r = predictPasses(GEO, observer, SYNTH_FROM, null, { hours: 1 });
  assert.equal(r.alwaysUp, false);
  assert.equal(r.standing, null);
  assert.equal(r.total, 1);
});

test('windows bounded by the scan, not by a rise or set, are flagged as clipped', () => {
  // A reference window long enough to be cut in half. Whole windows found by a
  // full scan have real rise/set times, so they must be flagged as neither.
  let observer = null;
  let ref = null;
  for (const lat of [-50, -30, 0, 30, 50]) {
    for (let lon = -180; lon < 180 && !ref; lon += 20) {
      const o = { lat, lon, altKm: 0 };
      for (const p of predictPasses(satrec, o, FROM, -2, { hours: 48 }).passes) {
        assert.equal(p.startClipped, false, 'a window found mid-scan has a real AOS');
        assert.equal(p.endClipped, false, 'a window found mid-scan has a real LOS');
        if (!ref && p.visibleEnd - p.visibleStart >= 120e3) { ref = p; observer = o; }
      }
    }
  }
  assert.ok(ref, 'expected at least one window of 2 min or more across the grid');

  // Re-scan starting inside that window: the first sample is already visible, so
  // the window it produces has no AOS of its own.
  const midPass = predictPasses(satrec, observer, ref.visibleStart, -2, { hours: 24 });
  assert.ok(midPass.passes.length > 0);
  assert.equal(midPass.passes[0].startClipped, true, 'window opened by the scan boundary');
  assert.equal(midPass.passes[0].visibleStart, ref.visibleStart);

  // And a scan that stops inside the window flags the other end.
  const truncated = predictPasses(satrec, observer, ref.visibleStart, -2, { hours: 60 / 3600 });
  assert.ok(truncated.passes.length > 0);
  assert.equal(truncated.passes[0].endClipped, true, 'window closed by the scan boundary');
  assert.ok(truncated.passes[0].visibleEnd < ref.visibleEnd, 'expected a truncated window');
});
