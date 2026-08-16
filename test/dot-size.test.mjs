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

// The globe's vertex shader, as source text. GLSL cannot be imported, and a
// headless GL context is far more machinery than this needs — but the shader is
// a short arithmetic expression over uniforms, so it can be read out of the file
// and evaluated directly (see shaderSizeExpression below). That is worth more
// than matching its text with a regex: a transcription test passes whenever the
// characters are unchanged, which is not the property anyone cares about and
// breaks on every harmless reformat.
const vertexShader = satellitesJs.match(/vertexShader:[^`]*`([\s\S]*?)`/)?.[1] ?? '';

// The shader's gl_PointSize computation, as a callable. Only the scalar path is
// translated: `float x = …;` declarations become `let`, the gl_PointSize
// assignment becomes the return, and the vector lines (which JS has no business
// evaluating) are skipped. That covers the whole GLSL subset the sizing maths
// uses — clamp, max, arithmetic and uniform reads — and it leaves the shader
// free to hoist locals or reformat, which matching its text would not.
//
// `mv` is supplied rather than derived: mv.z is view-space depth by definition,
// which is the seam this stops at. `-mv.z` then comes out right on its own.
function compileShaderPointSize(glsl) {
  const body = (glsl.match(/void main\(\)\s*{([\s\S]*)}/)?.[1] ?? '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Split on statements rather than lines: a declaration is free to wrap.
  const lines = [];
  for (const raw of body.split(';')) {
    const stmt = raw.trim().replace(/\s+/g, ' ');
    const decl = stmt.match(/^float\s+(\w+\s*=.*)$/);
    if (decl) { lines.push(`let ${decl[1]};`); continue; }
    const assign = stmt.match(/^gl_PointSize\s*=(.*)$/);
    if (assign) lines.push(`return ${assign[1]};`);
  }
  assert.ok(lines.some((l) => l.startsWith('return ')),
    'could not find a scalar gl_PointSize assignment in the vertex shader');

  const fn = new Function(
    'uSize', 'uSizeRange', 'uPixelRatio', 'aVisible', 'mv', 'max', 'min', 'clamp',
    lines.join('\n'),
  );
  return (depth, dpr) => fn(
    GLOBE_DOT_SCALE,
    { x: GLOBE_DOT_MIN_PX, y: GLOBE_DOT_MAX_PX },
    renderPixelRatio(dpr),
    1,
    { z: -depth },
    Math.max,
    Math.min,
    (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  );
}

const shaderPointSizePx = compileShaderPointSize(vertexShader);

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
  const assignment = vertexShader.match(/gl_PointSize\s*=([^;]*);/);
  assert.ok(assignment, 'the vertex shader should assign gl_PointSize');
  assert.match(assignment[1], /uPixelRatio/,
    'gl_PointSize must be scaled by the pixel ratio, or dots resize with the display');
  // And the sizes must come from the shared constants rather than literals, so
  // the tests below describe the shipped sizes and not a stale copy of them.
  assert.match(satellitesJs, /uSizeRange:\s*{\s*value:\s*new THREE\.Vector2\(GLOBE_DOT_MIN_PX, GLOBE_DOT_MAX_PX\)/);
  assert.match(satellitesJs, /uSize:\s*{\s*value:\s*GLOBE_DOT_SCALE\s*}/);
});

test('the shader writes exactly globeDotSizePx x the pixel ratio', () => {
  // The strongest form of the claim available without a GL context: run the
  // shader's own maths, with the uniforms the material supplies, and check it
  // against the law the rest of these tests are written against.
  //
  // Sweeping the ratio as well as the depth is what pins the *order*. Clamping
  // the framebuffer size instead — clamp(uSize / depth * uPixelRatio, …) —
  // reads like the same line and reintroduces the same bug somewhere subtler:
  // the ceiling would become 7 *framebuffer* pixels, i.e. 3.5 CSS px on a 2x
  // display and 7 on a 1x one. A drifted constant, a dropped clamp and an
  // inverted bound all fail here too.
  const depths = [NEAR_DEPTH, 0.5, 1, 5, 15, 22, 40, 60, FAR_DEPTH, 1e4,
    // Including the degenerate ones the shader guards with its own max().
    0, -0, 1e-12, -5];

  for (const dpr of [1, 1.25, 2, 3]) {
    for (const depth of depths) {
      assert.equal(
        shaderPointSizePx(depth, dpr),
        globeDotSizePx(depth) * renderPixelRatio(dpr),
        `shader and globeDotSizePx disagree at depth ${depth}, ratio ${dpr}`,
      );
    }
  }
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
