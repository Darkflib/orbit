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
// of `dragPx`. Derived from OrbitControls' own behaviour — it rotates by
// theta = 2*pi*rotateSpeed*dx/H — and a perspective projection, both written
// out here rather than reusing anything from the module under test.
function apparentSurfacePixels(dragPx, distance, speed, {
  viewportH = 900, fovDeg = CAMERA_FOV, radius = EARTH_RADIUS,
} = {}) {
  const theta = (2 * Math.PI * speed * dragPx) / viewportH;
  const arc = radius * theta;                       // world units the surface moves
  const eyeToSurface = distance - radius;
  const worldPerPixel = (2 * eyeToSurface * Math.tan((fovDeg * DEG2RAD) / 2)) / viewportH;
  return arc / worldPerPixel;
}

// The band over which the ideal speed is not clamped: 1.15 to 20 Earth radii,
// which covers everything between "nose against the surface" and "framing GEO".
const UNCLAMPED = [1.2, 1.5, 2, 3, 4.5, 7, 10, 14, 19].map((r) => EARTH_RADIUS * r);

test('a pixel of drag moves the surface about a pixel, at any zoom', () => {
  for (const distance of UNCLAMPED) {
    const speed = rotateSpeedForDistance(distance);
    const moved = apparentSurfacePixels(100, distance, speed);
    assert.ok(
      Math.abs(moved - 100) < 0.5,
      `at ${(distance / EARTH_RADIUS).toFixed(1)} Earth radii a 100px drag moved ${moved.toFixed(1)}px`,
    );
  }
});

test('the old fixed speed is what varied — by two orders of magnitude', () => {
  // Guards the regression rather than the fix: with rotateSpeed pinned at the
  // previous 0.55, the same drag produced wildly different apparent motion, so
  // any future change back to a constant fails here.
  const moved = UNCLAMPED.map((d) => apparentSurfacePixels(100, d, 0.55));
  const spread = Math.max(...moved) / Math.min(...moved);
  assert.ok(spread > 20, `expected the fixed speed to vary a lot, got ${spread.toFixed(1)}x`);

  const fixedNow = UNCLAMPED.map((d) => apparentSurfacePixels(100, d, rotateSpeedForDistance(d)));
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
