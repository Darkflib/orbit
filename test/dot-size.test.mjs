// Tests for globe-view dot sizing (src/constants.js) and for the shader that
// consumes it (src/satellites.js).
//
// The bug: gl_PointSize is measured in framebuffer pixels, and the globe's point
// shader wrote a raw number into it. That is not a fixed-size dot — it is a dot
// whose apparent size is inversely proportional to devicePixelRatio, so a size
// tuned on a 2x display came out twice as wide on an ordinary 1x screen, past
// the point where the glow sprite's soft falloff swamps its core. Reported as
// "in sky view the dots are okay, in globe view they're out of focus": sky view
// scales by the ratio and so looked identical on both machines, which is the
// asymmetry these tests pin down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  globeDotSizePx, renderPixelRatio,
  GLOBE_DOT_SCALE, GLOBE_DOT_MIN_PX, GLOBE_DOT_MAX_PX, MAX_PIXEL_RATIO,
  EARTH_RADIUS, ZOOM_MIN_RADII, ZOOM_MAX_RADII,
} from '../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const satellitesJs = await readFile(join(here, '..', 'src', 'satellites.js'), 'utf8');

// What the shader ultimately writes into gl_PointSize, for a satellite `depth`
// scene units from the eye on a display of the given ratio.
const framebufferPx = (depth, dpr) => globeDotSizePx(depth) * renderPixelRatio(dpr);
// What the eye actually sees, which is framebuffer pixels divided back down.
const apparentPx = (depth, dpr) => framebufferPx(depth, dpr) / renderPixelRatio(dpr);

// The depth range a satellite can actually be seen at: from the closest dolly
// (camera 1.08 Earth radii out, near-side LEO almost against the lens) to the
// furthest (24 radii, framing GEO).
const NEAR_DEPTH = EARTH_RADIUS * ZOOM_MIN_RADII * 0.1;
const FAR_DEPTH = EARTH_RADIUS * ZOOM_MAX_RADII;

test('a dot is the same apparent size on any display', () => {
  // The whole bug in one assertion. Before the fix this held only by accident on
  // whichever display the size was tuned for.
  for (const depth of [NEAR_DEPTH, 5, 15, 22, 60, FAR_DEPTH]) {
    const sizes = [1, 1.25, 1.5, 2, 3].map((dpr) => apparentPx(depth, dpr));
    const spread = Math.max(...sizes) / Math.min(...sizes);
    assert.equal(spread, 1, `apparent size varied with pixel ratio at depth ${depth}: ${sizes}`);
  }
});

test('the shader converts CSS pixels to framebuffer pixels', () => {
  // Guards the regression itself: the sizing law is only honest if the shader
  // that applies it also applies the ratio. A gl_PointSize assignment with no
  // uPixelRatio factor is the exact shape of the original bug.
  const assignment = satellitesJs.match(/gl_PointSize\s*=([^;]*);/);
  assert.ok(assignment, 'satellites.js should assign gl_PointSize');
  assert.match(assignment[1], /uPixelRatio/,
    'gl_PointSize must be scaled by the pixel ratio, or dots resize with the display');
  // And the clamp must come from the shared constants rather than a literal, so
  // the tests below describe the shipped sizes and not a stale copy of them.
  assert.match(satellitesJs, /uSizeRange:\s*{\s*value:\s*new THREE\.Vector2\(GLOBE_DOT_MIN_PX, GLOBE_DOT_MAX_PX\)/);
  assert.match(satellitesJs, /uSize:\s*{\s*value:\s*GLOBE_DOT_SCALE\s*}/);
});

test('dots stay in a legible band across the whole zoom range', () => {
  // Too small and the field vanishes when zoomed out; too large and a dot is
  // more halo than core, which is what "out of focus" was describing. 8px is a
  // generous ceiling — sky view's satellites sit at 5.5px for comparison.
  for (const depth of [NEAR_DEPTH, 1, 5, 15, 22, 60, FAR_DEPTH, 1e4]) {
    const px = globeDotSizePx(depth);
    assert.ok(px >= 1 && px <= 8, `dot at depth ${depth} is ${px}px`);
  }
  assert.equal(globeDotSizePx(NEAR_DEPTH), GLOBE_DOT_MAX_PX);
  assert.equal(globeDotSizePx(FAR_DEPTH), GLOBE_DOT_MIN_PX);
});

test('the old shader was twice the intended size on a 1x display', () => {
  // The previous law, verbatim: min(14, 260 / depth) written straight into
  // gl_PointSize with no ratio applied. On the 2x display it was tuned on it
  // agreed with the fix; on a 1x display every dot doubled.
  const old = (depth) => Math.min(14, 260 / Math.max(depth, 0.001));

  for (const depth of [NEAR_DEPTH, 5, 15, 22]) {
    assert.ok(Math.abs(old(depth) / 2 - globeDotSizePx(depth)) < 1e-9,
      `the fix should match the old 2x appearance at depth ${depth}`);
    assert.ok(old(depth) / globeDotSizePx(depth) > 1.9,
      `on a 1x display the old size should be ~2x too large at depth ${depth}`);
  }

  // At the default camera framing, near-side satellites all sat on the old 14px
  // clamp — one uniform blob size across the visible field, which is why the
  // screenshot showed no size variation at all.
  const defaultDepth = EARTH_RADIUS * 3.49 - EARTH_RADIUS;
  assert.equal(old(defaultDepth), 14);
  assert.equal(globeDotSizePx(defaultDepth), GLOBE_DOT_MAX_PX);
});

test('size falls off with distance and never inverts', () => {
  const depths = [1, 3, 8, 15, 25, 40, 80, 160];
  const sizes = depths.map((d) => globeDotSizePx(d));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] <= sizes[i - 1], `size grew with distance at index ${i}`);
  }
  // Unclamped in the middle of the range, i.e. the 1/depth term is doing real
  // work rather than everything sitting on a limit.
  const mid = globeDotSizePx(40);
  assert.ok(mid > GLOBE_DOT_MIN_PX && mid < GLOBE_DOT_MAX_PX, `expected an unclamped size, got ${mid}`);
  assert.ok(Math.abs(mid - GLOBE_DOT_SCALE / 40) < 1e-9);
});

test('degenerate depths cannot produce a NaN or negative point size', () => {
  // A satellite exactly at the near plane, or numerically behind the eye, must
  // still yield a finite size — an unclamped 1/depth would be Infinity, and a
  // NaN gl_PointSize drops the whole draw call on some drivers.
  for (const depth of [0, -0, 1e-12, -5]) {
    const px = globeDotSizePx(depth);
    assert.ok(Number.isFinite(px) && px > 0, `bad size at depth ${depth}: ${px}`);
    assert.ok(px <= GLOBE_DOT_MAX_PX);
  }
});

test('the pixel ratio is clamped, floored, and never NaN', () => {
  assert.equal(renderPixelRatio(1), 1);
  assert.equal(renderPixelRatio(1.25), 1.25);
  assert.equal(renderPixelRatio(3), MAX_PIXEL_RATIO);

  // The old expression was Math.min(window.devicePixelRatio, 2), which on a
  // browser reporting no devicePixelRatio evaluates to NaN — and a NaN handed to
  // setPixelRatio sizes the drawing buffer to nothing.
  for (const bad of [undefined, null, NaN, 0, -1, Infinity, '2']) {
    assert.equal(renderPixelRatio(bad), 1, `expected the 1x fallback for ${String(bad)}`);
  }
});
