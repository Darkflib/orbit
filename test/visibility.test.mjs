// Tests for the observer-relative visibility physics (src/visibility.js).
// Uses controlled geometry (gmst = 0 so ECI ≈ ECF, observer at 0°N/0°E with
// local "up" = +X) so every state of the machine is exercised deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeVisibility, compass } from '../src/visibility.js';
import { DEG2RAD } from '../src/constants.js';

const OBS = { lat: 0, lon: 0, altKm: 0 };
const OVERHEAD = { x: 6871, y: 0, z: 0 }; // ~493 km straight up from the observer

// Sun as a unit ECI vector whose elevation at the observer (+X up) is `deg`.
const sunAtElevation = (deg) => ({ x: Math.sin(deg * DEG2RAD), y: Math.cos(deg * DEG2RAD), z: 0 });

test('compass maps bearings to 16-point labels (and normalises)', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(45), 'NE');
  assert.equal(compass(90), 'E');
  assert.equal(compass(157), 'SSE');
  assert.equal(compass(180), 'S');
  assert.equal(compass(270), 'W');
  assert.equal(compass(340), 'NNW');
  assert.equal(compass(360), 'N'); // wraps to N
  assert.equal(compass(-10), 'N'); // negative normalises (350° → N)
});

test('overhead + dusk sky + sunlit ⇒ visible', () => {
  const v = computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(-8), -1.8);
  assert.equal(v.state, 'visible');
  assert.equal(v.sky, 'dark');
  assert.equal(v.satSunlit, true);
  assert.ok(v.elevation > 89, `elevation ${v.elevation}`);
  assert.ok(Math.abs(v.rangeKm - 493) < 5, `range ${v.rangeKm}`);
  assert.ok(v.apparentMag != null && v.apparentMag < 0, `mag ${v.apparentMag}`);
});

test('overhead + daytime sky ⇒ daylight (sunlit but sky too bright)', () => {
  const v = computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(40), -1.8);
  assert.equal(v.state, 'daylight');
  assert.equal(v.sky, 'day');
  assert.equal(v.satSunlit, true);
});

test('overhead at local midnight ⇒ in Earth\'s shadow', () => {
  // Sun directly below the observer: the overhead satellite is eclipsed.
  const v = computeVisibility(OVERHEAD, 0, OBS, { x: -1, y: 0, z: 0 }, -1.8);
  assert.equal(v.satSunlit, false);
  assert.equal(v.sky, 'dark');
  assert.equal(v.state, 'shadow');
});

test('satellite below the horizon ⇒ below-horizon (regardless of light)', () => {
  const belowHorizon = { x: 0, y: 6871, z: 0 }; // 90° away → under the horizon
  const v = computeVisibility(belowHorizon, 0, OBS, sunAtElevation(-8), -1.8);
  assert.equal(v.state, 'below-horizon');
  assert.ok(v.elevation <= 0, `elevation ${v.elevation}`);
});

test('twilight sky is distinguished from day and dark', () => {
  assert.equal(computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(-3), -1.8).sky, 'twilight');
  assert.equal(computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(2), -1.8).sky, 'day');
  assert.equal(computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(-10), -1.8).sky, 'dark');
});

test('apparent magnitude is null when no intrinsic magnitude is known', () => {
  const v = computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(-8), null);
  assert.equal(v.apparentMag, null);
  assert.equal(v.state, 'visible'); // verdict is geometry-only, independent of magnitude
});

test('closer range yields a brighter (lower) apparent magnitude at equal phase', () => {
  const near = computeVisibility(OVERHEAD, 0, OBS, sunAtElevation(-8), -1.8).apparentMag;
  const far = computeVisibility({ x: 8371, y: 0, z: 0 }, 0, OBS, sunAtElevation(-8), -1.8).apparentMag;
  assert.ok(near < far, `near ${near} should be brighter than far ${far}`);
});
