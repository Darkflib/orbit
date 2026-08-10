// Tests for the zoom-aware drag speed (src/constants.js).
//
// The bug: OrbitControls converts a drag into a fixed *angle*, so the same
// gesture spun the globe quickly when zoomed in and barely moved it when zoomed
// out. The property that was broken is not "the speed constant is right" but
// "a pixel of drag moves the surface under the cursor by about a pixel,
// whatever the zoom" — so that is what these assert, by reimplementing the
// projection independently of the formula under test and checking the round
// trip lands back on 1:1.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rotateSpeedForDistance, CAMERA_FOV, EARTH_RADIUS,
  ROTATE_SPEED_MIN, ROTATE_SPEED_MAX, DEG2RAD,
} from '../src/constants.js';

// How far the surface under the cursor appears to move, in pixels, for a drag
// of `dragPx`.
//
// This is a *geometric* oracle, not the module's algebra rearranged: it takes
// OrbitControls' own drag-to-azimuth conversion (theta = 2*pi*speed*dx/H), spins
// an actual point around an actual sphere, and projects it through an actual
// perspective divide. Nothing here assumes a small angle or a flat surface,
// which is exactly what the module's closed form does assume — so agreement
// between the two is a real result rather than a tautology.
//
// Camera on +Z looking at the origin; the point under the cursor starts at the
// sub-camera point (0, 0, radius) and the drag swings it round the globe.
function apparentSurfacePixels(dragPx, distance, speed, {
  viewportH = 900, fovDeg = CAMERA_FOV, radius = EARTH_RADIUS,
} = {}) {
  const theta = (2 * Math.PI * speed * dragPx) / viewportH;
  const x = radius * Math.sin(theta);
  const z = radius * Math.cos(theta);
  // Divide by the point's own depth, which shortens as it rounds the limb.
  const depth = distance - z;
  return (x / depth) * ((viewportH / 2) / Math.tan((fovDeg * DEG2RAD) / 2));
}

// The band over which the ideal speed is not clamped: 1.15 to 20 Earth radii,
// which covers everything between "nose against the surface" and "framing GEO".
const UNCLAMPED = [1.2, 1.5, 2, 3, 4.5, 7, 10, 14, 19].map((r) => EARTH_RADIUS * r);

// The claimed property is a *rate* — the surface keeps up with the cursor as the
// drag starts. Over a long sweep it cannot: the point genuinely curves away
// round the limb and its projected motion slows, which the oracle above models
// and the module's linear form does not. Probing with a small drag measures the
// rate and nothing else. (`travelsLessThanTheCursorOverALongDrag` below pins
// that the oracle really does diverge, i.e. that it is not the same equation.)
const PROBE_PX = 1;

test('a pixel of drag moves the surface about a pixel, at any zoom', () => {
  for (const distance of UNCLAMPED) {
    const speed = rotateSpeedForDistance(distance);
    const moved = apparentSurfacePixels(PROBE_PX, distance, speed);
    assert.ok(
      Math.abs(moved - PROBE_PX) < 0.01,
      `at ${(distance / EARTH_RADIUS).toFixed(1)} Earth radii a ${PROBE_PX}px drag moved ${moved.toFixed(4)}px`,
    );
  }
});

test('the oracle is a projection, not the formula under test', () => {
  // If apparentSurfacePixels were the module's linear equation rearranged, a
  // 100px drag would come back as exactly 100px too and the test above would be
  // circular. It does not: zoomed out the point rounds the limb and falls well
  // short of the cursor, which is the curvature the closed form ignores.
  const far = EARTH_RADIUS * 19;
  const moved = apparentSurfacePixels(100, far, rotateSpeedForDistance(far));
  assert.ok(moved < 70, `expected the long drag to fall behind the cursor, got ${moved.toFixed(1)}px`);
});

test('the old fixed speed is what varied — by two orders of magnitude', () => {
  // Guards the regression rather than the fix: with rotateSpeed pinned at the
  // previous 0.55, the same drag produced wildly different apparent motion, so
  // any future change back to a constant fails here.
  const moved = UNCLAMPED.map((d) => apparentSurfacePixels(PROBE_PX, d, 0.55));
  const spread = Math.max(...moved) / Math.min(...moved);
  assert.ok(spread > 20, `expected the fixed speed to vary a lot, got ${spread.toFixed(1)}x`);

  const fixedNow = UNCLAMPED.map(
    (d) => apparentSurfacePixels(PROBE_PX, d, rotateSpeedForDistance(d)),
  );
  const spreadNow = Math.max(...fixedNow) / Math.min(...fixedNow);
  assert.ok(spreadNow < 1.02, `expected near-constant motion, got ${spreadNow.toFixed(3)}x`);
});

test('speed rises with distance, which is the direction of the complaint', () => {
  // Zoomed in was too fast and zoomed out too slow, so the correction must be
  // monotonically increasing in distance.
  const speeds = UNCLAMPED.map((d) => rotateSpeedForDistance(d));
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i] > speeds[i - 1], `not monotonic at index ${i}`);
  }
  // And it must straddle the old constant, otherwise it only fixed one end.
  assert.ok(speeds[0] < 0.55, 'closest zoom should now be slower than the old 0.55');
  assert.ok(speeds[speeds.length - 1] > 0.55, 'furthest zoom should now be faster than the old 0.55');
});

test('clamped at both ends, and never zero or negative', () => {
  // Right against the surface the ideal speed tends to zero, which would freeze
  // rotation; beyond the far limit it grows without bound.
  assert.equal(rotateSpeedForDistance(EARTH_RADIUS), ROTATE_SPEED_MIN);
  assert.equal(rotateSpeedForDistance(EARTH_RADIUS * 1.001), ROTATE_SPEED_MIN);
  assert.equal(rotateSpeedForDistance(EARTH_RADIUS * 1000), ROTATE_SPEED_MAX);

  for (const d of [0, EARTH_RADIUS * 0.5, EARTH_RADIUS * 1.08, EARTH_RADIUS * 24]) {
    const s = rotateSpeedForDistance(d);
    assert.ok(s >= ROTATE_SPEED_MIN && s <= ROTATE_SPEED_MAX && Number.isFinite(s),
      `speed out of bounds at distance ${d}: ${s}`);
  }
});

test('the app\'s actual zoom range stays inside sane bounds', () => {
  // minDistance / maxDistance as set in scene.js.
  const atMinZoom = rotateSpeedForDistance(EARTH_RADIUS * 1.08);
  const atMaxZoom = rotateSpeedForDistance(EARTH_RADIUS * 24);
  assert.ok(atMinZoom < 0.05, `closest zoom too fast: ${atMinZoom}`);
  assert.ok(atMaxZoom > 1.5, `furthest zoom still too slow: ${atMaxZoom}`);
});
