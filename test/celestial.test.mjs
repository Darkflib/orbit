// Tests for the topocentric alt/az maths (src/celestial.js).
//
// The strategy avoids checking Astronomy Engine against itself:
//   - Polaris altitude ≈ observer latitude is an external, textbook invariant.
//   - Angular separation is frame-independent, so a correct transform must
//     preserve it — a rotation isometry check that needs no reference values.
//   - The Sun path is cross-checked against the project's own independent solar
//     model in ephemeris.js (a different algorithm entirely).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Astronomy from 'astronomy-engine';

import { starAltAz, bodyAltAz, skyBodies, SKY_BODIES } from '../src/celestial.js';
import { sunDirectionEci } from '../src/ephemeris.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// A fixed instant so every assertion is deterministic.
const DATE = new Date('2026-08-05T22:00:00Z');

// Angle between two horizontal positions, via their unit vectors (degrees).
function separation(a, b) {
  const vec = ({ altitude, azimuth }) => {
    const alt = altitude * DEG2RAD;
    const az = azimuth * DEG2RAD;
    return [Math.cos(alt) * Math.cos(az), Math.cos(alt) * Math.sin(az), Math.sin(alt)];
  };
  const [x1, y1, z1] = vec(a);
  const [x2, y2, z2] = vec(b);
  return Math.acos(Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2))) * RAD2DEG;
}

// Great-circle angle between two catalogue positions, RA/Dec in degrees.
function separationRaDec(ra1, dec1, ra2, dec2) {
  const [r1, d1, r2, d2] = [ra1, dec1, ra2, dec2].map((v) => v * DEG2RAD);
  const cos = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * RAD2DEG;
}

// Catalogue J2000 positions (degrees) used across the tests.
const POLARIS = { ra: 37.9546, dec: 89.2641 };
const SIRIUS = { ra: 101.2871, dec: -16.7161 };
const VEGA = { ra: 279.2347, dec: 38.7837 };

test('Polaris altitude ≈ observer latitude, independent of longitude', () => {
  // The celestial pole sits at altitude = latitude; Polaris is ~0.7° off the
  // pole, so its altitude tracks the latitude to within about a degree at any
  // longitude/time. This is external ground truth, not an Astronomy Engine value.
  for (const lat of [51.5, 30, 60]) {
    for (const lon of [-0.12, 139.7]) {
      const { altitude } = starAltAz(POLARIS.ra, POLARIS.dec, { lat, lon, altKm: 0 }, DATE);
      assert.ok(
        Math.abs(altitude - lat) < 1.5,
        `Polaris altitude ${altitude.toFixed(2)}° should be ≈ latitude ${lat}° (lon ${lon})`,
      );
    }
  }
});

test('angular separation is preserved by the star transform (rotation isometry)', () => {
  // Precession + horizontal projection is a rigid rotation, so the airless
  // separation between two stars must equal their catalogue separation. Any
  // arithmetic slip in the transform shows up here as a mismatch.
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  const opts = { refraction: 'airless' };
  const a = starAltAz(SIRIUS.ra, SIRIUS.dec, observer, DATE, opts);
  const b = starAltAz(VEGA.ra, VEGA.dec, observer, DATE, opts);
  const horiz = separation(a, b);
  const catalog = separationRaDec(SIRIUS.ra, SIRIUS.dec, VEGA.ra, VEGA.dec);
  assert.ok(
    Math.abs(horiz - catalog) < 0.01,
    `horizontal separation ${horiz.toFixed(4)}° should match catalogue ${catalog.toFixed(4)}°`,
  );
});

test('apparent refraction lifts a low star above its airless altitude', () => {
  // Atmospheric refraction only ever raises an object, and most strongly near
  // the horizon. Whichever star happens to be lowest, apparent ≥ airless.
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  for (const s of [SIRIUS, VEGA, POLARIS]) {
    const apparent = starAltAz(s.ra, s.dec, observer, DATE, { refraction: 'apparent' }).altitude;
    const airless = starAltAz(s.ra, s.dec, observer, DATE, { refraction: 'airless' }).altitude;
    assert.ok(apparent >= airless - 1e-9, `apparent ${apparent} should be ≥ airless ${airless}`);
  }
});

test('the Sun path agrees with the independent solar model in ephemeris.js', () => {
  // bodyAltAz derives the Sun from Astronomy Engine's VSOP87 ephemeris.
  // sunDirectionEci is the project's own low-order solar series. Feeding the
  // latter through the same Horizon step must land within a fraction of a degree
  // of the former — validating the body → equatorial → horizontal wiring against
  // a genuinely separate ephemeris.
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  const mine = bodyAltAz('Sun', observer, DATE);

  const s = sunDirectionEci(DATE);
  const raHours = (((Math.atan2(s.y, s.x) * RAD2DEG + 360) % 360)) / 15;
  const decDeg = Math.asin(s.z) * RAD2DEG;
  const time = Astronomy.MakeTime(DATE);
  const ref = Astronomy.Horizon(time, new Astronomy.Observer(51.5, -0.12, 0), raHours, decDeg, 'normal');

  assert.ok(Math.abs(mine.altitude - ref.altitude) < 0.5, `Sun altitude ${mine.altitude} vs ${ref.altitude}`);
  // Compare azimuth on the circle so the 0/360 wrap can't trip a near-north Sun.
  const dAz = Math.abs(((mine.azimuth - ref.azimuth + 540) % 360) - 180);
  assert.ok(dAz < 0.5, `Sun azimuth ${mine.azimuth} vs ${ref.azimuth} (Δ ${dAz})`);
});

test('bodyAltAz returns well-formed angles for the Moon and planets', () => {
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  for (const body of ['Moon', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const { altitude, azimuth, distanceAu } = bodyAltAz(body, observer, DATE);
    assert.ok(Number.isFinite(altitude) && altitude >= -90 && altitude <= 90, `${body} altitude ${altitude}`);
    assert.ok(Number.isFinite(azimuth) && azimuth >= 0 && azimuth < 360, `${body} azimuth ${azimuth}`);
    assert.ok(distanceAu > 0, `${body} distance ${distanceAu} AU should be positive`);
  }
});

test('skyBodies returns one entry per SKY_BODIES member', () => {
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  const rows = skyBodies(observer, DATE);
  assert.equal(rows.length, SKY_BODIES.length);
  assert.deepEqual(rows.map((r) => r.name), SKY_BODIES);
  for (const r of rows) {
    assert.ok(Number.isFinite(r.altitude) && Number.isFinite(r.azimuth), `${r.name} finite alt/az`);
  }
});

test('an unknown refraction mode is rejected', () => {
  const observer = { lat: 51.5, lon: -0.12, altKm: 0 };
  assert.throws(
    () => starAltAz(SIRIUS.ra, SIRIUS.dec, observer, DATE, { refraction: 'sometimes' }),
    /unknown refraction mode/,
  );
});
