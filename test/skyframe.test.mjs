// Tests for the observer sky frame (src/skyframe.js) and the batched star
// rotation added to src/celestial.js.
//
// The strategy is cross-checking independent paths rather than pinning
// numbers this code produced:
//   - The scene->sky transform is hand-rolled ENU basis maths. satellite.js's
//     `ecfToLookAngles` computes the same look angles by an entirely separate
//     route, and visibility.js already wraps it — so the two must agree, and
//     any sign error or axis swap in the frame relabelling shows up instantly.
//   - The batched EQJ->HOR star rotation is checked against `starAltAz`
//     (airless), which is itself already tested against external invariants.
//   - The cardinal-direction mapping is asserted against the documented
//     convention, which is what stops the whole sky rendering mirrored.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';

import {
  altAzToVec, vecToAltAz, horVecToSky, makeSkyTransform, isSunlitScene,
} from '../src/skyframe.js';
import { starAltAz, starVectorEqj, eqjToHorRotation, rotateEqjToHor } from '../src/celestial.js';
import { computeVisibility } from '../src/visibility.js';
import { KM_PER_UNIT, EARTH_RADIUS } from '../src/constants.js';

const DATE = new Date('2026-08-05T22:00:00Z');

// The worker's ECEF -> scene-frame remap (worker.js), reproduced here so the
// test drives the transform through exactly the coordinates the renderer sees.
const ecefToScene = (e) => [e.x / KM_PER_UNIT, e.z / KM_PER_UNIT, -e.y / KM_PER_UNIT];

// Smallest angle between two bearings in degrees, wrapping across 0/360 so a
// 359.9° vs 0.1° comparison reads as 0.2° and not 359.8°.
const azDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------------------------------------------------------------------------
// Frame conventions
// ---------------------------------------------------------------------------

test('altAzToVec places the cardinal points on the documented axes', () => {
  const close = (v, x, y, z, msg) => {
    assert.ok(Math.abs(v.x - x) < 1e-12 && Math.abs(v.y - y) < 1e-12 && Math.abs(v.z - z) < 1e-12,
      `${msg}: got (${v.x}, ${v.y}, ${v.z})`);
  };
  close(altAzToVec(0, 0), 0, 0, -1, 'north is -Z');
  close(altAzToVec(0, 90), 1, 0, 0, 'east is +X');
  close(altAzToVec(0, 180), 0, 0, 1, 'south is +Z');
  close(altAzToVec(0, 270), -1, 0, 0, 'west is -X');
  close(altAzToVec(90, 0), 0, 1, 0, 'zenith is +Y');
  close(altAzToVec(-90, 0), 0, -1, 0, 'nadir is -Y');
});

test('altAzToVec scales onto the celestial sphere radius', () => {
  const v = altAzToVec(30, 210, 100);
  assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 100) < 1e-10);
});

test('altAz -> vector -> altAz round-trips', () => {
  for (const alt of [-80, -12, 0, 5, 37.5, 89]) {
    for (const az of [0, 17, 90, 183.25, 270, 359]) {
      const v = altAzToVec(alt, az);
      const back = vecToAltAz(v.x, v.y, v.z);
      assert.ok(Math.abs(back.altitude - alt) < 1e-9, `alt ${alt} -> ${back.altitude}`);
      assert.ok(Math.abs(back.azimuth - az) < 1e-9, `az ${az} -> ${back.azimuth}`);
    }
  }
});

test('horVecToSky relabels Astronomy Engine horizontal axes correctly', () => {
  // AE horizontal frame: x = north, y = west, z = zenith.
  const north = horVecToSky({ x: 1, y: 0, z: 0 });
  assert.deepEqual([north.x, north.y, north.z], [-0, 0, -1]); // north -> -Z
  const west = horVecToSky({ x: 0, y: 1, z: 0 });
  assert.deepEqual([west.x, west.y, west.z], [-1, 0, -0]);    // west  -> -X
  const zenith = horVecToSky({ x: 0, y: 0, z: 1 });
  assert.deepEqual([zenith.x, zenith.y, zenith.z], [-0, 1, -0]); // zenith -> +Y
});

// ---------------------------------------------------------------------------
// The scene -> sky transform, cross-checked against satellite.js look angles
// ---------------------------------------------------------------------------

test('scene->sky look angles match visibility.js (independent code paths)', () => {
  const gmst = satellite.gstime(DATE);
  const observers = [
    { lat: 52.8306, lon: -1.2833, altKm: 0 },   // Kegworth, the project's reference site
    { lat: 0, lon: 0, altKm: 0 },
    { lat: -33.87, lon: 151.21, altKm: 0.058 }, // southern hemisphere, east of Greenwich
    { lat: 78.22, lon: 15.65, altKm: 0 },       // high Arctic
  ];
  // A spread of ECI positions so the check covers all quadrants and both
  // above- and below-horizon geometry, not just one lucky bearing.
  const sats = [
    { x: 6871, y: 0, z: 0 },
    { x: -2000, y: 6000, z: 3000 },
    { x: 1500, y: -3200, z: 6100 },
    { x: -4200, y: -4200, z: -2000 },
    { x: 26600, y: 12000, z: -8000 }, // MEO-ish, well beyond LEO ranges
  ];

  let checked = 0;
  for (const obs of observers) {
    const toSky = makeSkyTransform(obs);
    const out = {};
    for (const eci of sats) {
      const [sx, sy, sz] = ecefToScene(satellite.eciToEcf(eci, gmst));
      toSky(sx, sy, sz, out);

      const v = computeVisibility(eci, gmst, obs, { x: 1, y: 0, z: 0 }, null);

      assert.ok(Math.abs(out.altitude - v.elevation) < 1e-6,
        `altitude ${out.altitude} vs elevation ${v.elevation}`);
      // Azimuth is meaningless at the exact zenith; everything here is well off it.
      assert.ok(azDiff(out.azimuth, v.azimuth) < 1e-6,
        `azimuth ${out.azimuth} vs ${v.azimuth}`);
      assert.ok(Math.abs(out.rangeKm - v.rangeKm) < 1e-6,
        `range ${out.rangeKm} vs ${v.rangeKm}`);
      checked++;
    }
  }
  assert.equal(checked, observers.length * sats.length);
});

test('scene->sky returns a unit direction consistent with its own alt/az', () => {
  const toSky = makeSkyTransform({ lat: 52.8306, lon: -1.2833, altKm: 0 });
  const out = {};
  const [sx, sy, sz] = ecefToScene(satellite.eciToEcf({ x: 1500, y: -3200, z: 6100 }, satellite.gstime(DATE)));
  toSky(sx, sy, sz, out);

  assert.ok(Math.abs(Math.hypot(out.x, out.y, out.z) - 1) < 1e-12, 'direction is a unit vector');
  const round = vecToAltAz(out.x, out.y, out.z);
  assert.ok(Math.abs(round.altitude - out.altitude) < 1e-9);
  assert.ok(Math.abs(round.azimuth - out.azimuth) < 1e-9);
});

test('a satellite directly overhead sits at the zenith', () => {
  const obs = { lat: 40, lon: 25, altKm: 0 };
  const toSky = makeSkyTransform(obs);
  // 500 km straight up from the observer, built in ECEF then pushed through the
  // scene remap — geodetic vs geocentric "up" differ, so allow a little slack.
  const up = satellite.geodeticToEcf({
    longitude: obs.lon * (Math.PI / 180),
    latitude: obs.lat * (Math.PI / 180),
    height: 500,
  });
  const out = {};
  toSky(...ecefToScene(up), out);
  assert.ok(out.altitude > 89.99, `altitude ${out.altitude}`);
  assert.ok(Math.abs(out.rangeKm - 500) < 1, `range ${out.rangeKm}`);
  assert.ok(out.y > 0.9999, 'points at +Y');
});

// ---------------------------------------------------------------------------
// Earth-shadow test in the scene frame
// ---------------------------------------------------------------------------

test('isSunlitScene agrees with visibility.js satSunlit', () => {
  const gmst = satellite.gstime(DATE);
  const sunEci = { x: 0.4, y: -0.85, z: 0.34 };
  const len = Math.hypot(sunEci.x, sunEci.y, sunEci.z);
  const sunUnit = { x: sunEci.x / len, y: sunEci.y / len, z: sunEci.z / len };
  const [ux, uy, uz] = ecefToScene(satellite.eciToEcf(sunUnit, gmst));
  const sunScene = { x: ux * KM_PER_UNIT, y: uy * KM_PER_UNIT, z: uz * KM_PER_UNIT };

  const sats = [
    { x: 6871, y: 0, z: 0 },
    { x: -2600, y: 5600, z: 3000 },
    // Deliberately deep in the anti-sun cylinder: ~7000 km along -sun.
    { x: -sunUnit.x * 7000, y: -sunUnit.y * 7000, z: -sunUnit.z * 7000 },
    { x: 1500, y: -3200, z: 6100 },
  ];

  for (const eci of sats) {
    const expected = computeVisibility(eci, gmst, { lat: 0, lon: 0, altKm: 0 }, sunUnit, null).satSunlit;
    const [sx, sy, sz] = ecefToScene(satellite.eciToEcf(eci, gmst));
    assert.equal(isSunlitScene(sx, sy, sz, sunScene, EARTH_RADIUS), expected,
      `sunlit disagreement for ${JSON.stringify(eci)}`);
  }
});

// ---------------------------------------------------------------------------
// Batched star rotation vs the per-star path
// ---------------------------------------------------------------------------

test('batched EQJ->HOR rotation matches starAltAz (airless)', () => {
  const observers = [
    { lat: 52.8306, lon: -1.2833, altKm: 0 },
    { lat: -33.87, lon: 151.21, altKm: 0 },
    { lat: 0, lon: 0, altKm: 0 },
  ];
  // Sirius, Vega, Polaris, Canopus, Betelgeuse — spread over both hemispheres.
  const stars = [
    [101.2871, -16.7161], [279.2347, 38.7837], [37.9529, 89.2641],
    [95.9879, -52.6958], [88.7929, 7.4071],
  ];

  for (const obs of observers) {
    const m = eqjToHorRotation(obs, DATE);
    for (const [ra, dec] of stars) {
      const v = starVectorEqj(ra, dec);
      const hor = rotateEqjToHor(m, v.x, v.y, v.z);
      const sky = horVecToSky(hor);
      const batched = vecToAltAz(sky.x, sky.y, sky.z);

      const single = starAltAz(ra, dec, obs, DATE, { refraction: 'airless' });

      assert.ok(Math.abs(batched.altitude - single.altitude) < 1e-6,
        `alt ${batched.altitude} vs ${single.altitude} (ra ${ra})`);
      assert.ok(azDiff(batched.azimuth, single.azimuth) < 1e-6,
        `az ${batched.azimuth} vs ${single.azimuth} (ra ${ra})`);
    }
  }
});

test('starVectorEqj returns unit vectors', () => {
  for (const [ra, dec] of [[0, 0], [101.2871, -16.7161], [279.23, 38.78], [37.95, 89.26]]) {
    const v = starVectorEqj(ra, dec);
    assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-12);
  }
});

test('the batched rotation is a rigid rotation (separations preserved)', () => {
  // Sirius/Vega separation is a catalogue invariant: a correct rotation cannot
  // change it, whatever the observer or instant.
  const m = eqjToHorRotation({ lat: 52.8306, lon: -1.2833, altKm: 0 }, DATE);
  const a = starVectorEqj(101.2871, -16.7161);
  const b = starVectorEqj(279.2347, 38.7837);
  const dotBefore = a.x * b.x + a.y * b.y + a.z * b.z;

  const ra = rotateEqjToHor(m, a.x, a.y, a.z);
  const rb = rotateEqjToHor(m, b.x, b.y, b.z);
  const dotAfter = ra.x * rb.x + ra.y * rb.y + ra.z * rb.z;

  assert.ok(Math.abs(dotBefore - dotAfter) < 1e-12, `${dotBefore} vs ${dotAfter}`);
});
