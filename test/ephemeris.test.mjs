// Tests for the pure solar-ephemeris math (src/ephemeris.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { sunDirectionEci, dateToJulian } from '../src/ephemeris.js';

test('dateToJulian matches the J2000.0 epoch', () => {
  // 2000-01-01 12:00 TT ≈ JD 2451545.0 (to within the UTC/TT offset we ignore).
  const jd = dateToJulian(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)));
  assert.ok(Math.abs(jd - 2451545.0) < 1e-3, `jd ${jd}`);
});

test('sunDirectionEci returns a unit vector', () => {
  for (const iso of ['2026-03-20T00:00:00Z', '2026-06-21T00:00:00Z', '2026-12-21T00:00:00Z']) {
    const s = sunDirectionEci(new Date(iso));
    const mag = Math.hypot(s.x, s.y, s.z);
    assert.ok(Math.abs(mag - 1) < 1e-9, `|s| ${mag} at ${iso}`);
  }
});

test('sun crosses the equator near the March equinox (z ≈ 0)', () => {
  const s = sunDirectionEci(new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(s.z) < 0.03, `z ${s.z} should be near 0 at the equinox`);
});

test('sun is near maximum declination at the June solstice (z ≈ sin 23.44°)', () => {
  const s = sunDirectionEci(new Date('2026-06-21T12:00:00Z'));
  assert.ok(s.z > 0.38, `z ${s.z} should be near +0.398 at the solstice`);
});
