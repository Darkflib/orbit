// Tests for the catalogue-record helpers in src/enrichment.js — specifically
// the "this object has no element set" path.
//
// The case that prompted them: USA 224 (NORAD 37348, COSPAR 2011-002A) is a
// classified US payload. CelesTrak's SATCAT lists it, flags it
// DATA_STATUS_CODE = NEA, and has never published a TLE or OMM for it. Orbit
// had no way to say that, so an object with no elements rendered exactly like a
// failed fetch — and was reported as a missing satellite.
//
// The three fields these read (`dataStatus`, `orbitCenter`, `approximateOrbit`)
// are additive, so a published tree from before orbit-data shipped them carries
// none of them. Every assertion about "absent" below is therefore a live
// property of the deployed data, not a hypothetical.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elementStatus, approximateOrbitRows, orbitCenterName, APPROXIMATE_ORBIT_NOTE,
} from '../src/enrichment.js';

// The real record, as orbit-data publishes it.
const USA_224 = {
  norad: '37348',
  name: 'USA 224',
  cospar: '2011-002A',
  objectType: 'payload',
  opsStatus: 'operational',
  country: 'US',
  dataStatus: 'no-elements-available',
  orbitCenter: 'earth',
  approximateOrbit: {
    periodMinutes: 96.7, inclinationDeg: 97.94, apogeeKm: 948, perigeeKm: 258,
  },
};

test('an ordinary record has no element-status notice', () => {
  assert.equal(elementStatus({ norad: '25544', name: 'ISS (ZARYA)' }), null);
  assert.equal(elementStatus({ norad: '25544', dataStatus: null }), null);
  assert.equal(elementStatus(null), null);
  assert.equal(elementStatus(undefined), null);
});

test('USA 224 is explained as withheld data, not as a failure', () => {
  const st = elementStatus(USA_224);
  assert.equal(st.key, 'no-elements-available');
  assert.equal(st.label, 'No public element set');
  assert.match(st.detail, /not published/);
  // Nothing here may read as breakage, and nothing may speculate about why the
  // elements are withheld.
  assert.doesNotMatch(st.detail, /error|failed|unavailable|classified|secret/i);
});

test('an Earth-orbiting object keeps its approximate orbit', () => {
  const st = elementStatus(USA_224);
  assert.deepEqual(st.approximateOrbit, USA_224.approximateOrbit);
  assert.deepEqual(approximateOrbitRows(st.approximateOrbit), [
    ['Period', '96.7 min'],
    ['Inclination', '97.94°'],
    ['Apogee', '948 km'],
    ['Perigee', '258 km'],
  ]);
  assert.match(APPROXIMATE_ORBIT_NOTE, /not suitable for pointing or pass prediction/);
});

test('the other two Earth-orbit codes each say something different', () => {
  const current = elementStatus({ ...USA_224, dataStatus: 'no-current-elements' });
  assert.equal(current.label, 'No current element set');
  assert.match(current.detail, /^Current orbital data/);

  const initial = elementStatus({ ...USA_224, dataStatus: 'no-initial-elements' });
  assert.equal(initial.label, 'No initial element set');
  assert.match(initial.detail, /since launch/);
});

test('a deep-space probe is not described as withheld data', () => {
  const st = elementStatus({
    norad: '2843', name: 'PIONEER 6',
    dataStatus: 'no-elements-available', orbitCenter: 'sun',
  });
  assert.equal(st.key, 'not-earth-orbit');
  assert.equal(st.label, 'Not in Earth orbit');
  assert.match(st.detail, /orbits the Sun, not Earth/);
  assert.doesNotMatch(st.detail, /not published/);
  // An Earth-orbit period/apogee for a heliocentric probe would be nonsense, so
  // it is dropped even when the record carries one.
  assert.equal(
    elementStatus({ ...USA_224, orbitCenter: 'sun' }).approximateOrbit,
    null,
  );
});

test('every published orbit centre gets a readable sentence', () => {
  // SATCAT's complete published ORBIT_CENTER set. A body is orbited; a
  // Lagrange point, the Earth–Moon barycentre and an escape trajectory are not,
  // so none of them may be described as being orbited.
  const bodies = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn',
    'uranus', 'neptune', 'pluto', 'asteroid', 'comet'];
  for (const centre of bodies) {
    const st = elementStatus({ ...USA_224, orbitCenter: centre });
    assert.equal(st.key, 'not-earth-orbit', centre);
    assert.match(st.detail, /^This object orbits .+, not Earth\./, centre);
    assert.doesNotMatch(st.detail, /undefined|\[object/, centre);
  }

  const places = ['earth-lagrange', 'earth-sun-l1', 'earth-sun-l2', 'earth-sun-l3',
    'earth-sun-l4', 'earth-sun-l5', 'earth-moon-barycenter', 'solar-system-escape'];
  for (const centre of places) {
    const st = elementStatus({ ...USA_224, orbitCenter: centre });
    assert.equal(st.key, 'not-earth-orbit', centre);
    assert.match(st.detail, /not in Earth orbit\./, centre);
    assert.doesNotMatch(st.detail, /orbits/, centre);
  }

  // Pioneer 10 is bound to nothing at all — it must not be said to orbit its
  // own escape trajectory.
  assert.match(
    elementStatus({ ...USA_224, orbitCenter: 'solar-system-escape' }).detail,
    /escape trajectory out of the solar system/,
  );
  assert.match(
    elementStatus({ ...USA_224, orbitCenter: 'earth-sun-l2' }).detail,
    /at the Earth–Sun L2 point/,
  );

  assert.equal(orbitCenterName('mars'), 'Mars');
  assert.equal(orbitCenterName('earth-moon-barycenter'), 'the Earth–Moon barycentre');
  assert.equal(orbitCenterName(null), null);
});

test('a docked object is still in Earth orbit', () => {
  // SATCAT puts the *host* object's catalog number in ORBIT_CENTER for a docked
  // object, so a numeric centre is not a body. Rendering "orbits 25544, not
  // Earth" for a module docked to the ISS would be plainly wrong. No SATCAT row
  // currently carries both a numeric centre and a dataStatus, so this guards a
  // latent case rather than a live one.
  const st = elementStatus({ ...USA_224, orbitCenter: '25544' });
  assert.equal(st.key, 'no-elements-available');
  assert.equal(st.dockedTo, '25544');
  assert.doesNotMatch(st.detail, /not in Earth orbit|not Earth/);
  assert.match(st.detail, /docked to NORAD 25544/);
  // Its approximate Earth orbit is still meaningful, unlike a probe's.
  assert.deepEqual(st.approximateOrbit, USA_224.approximateOrbit);
  assert.equal(orbitCenterName('25544'), 'NORAD 25544');
});

test('an unrecognised orbit centre is reported, not guessed at', () => {
  const st = elementStatus({ norad: '1', dataStatus: 'no-elements-available', orbitCenter: 'XX' });
  assert.equal(st.key, 'not-earth-orbit');
  assert.match(st.detail, /not in Earth orbit \(catalogue centre: XX\)/);
  assert.doesNotMatch(st.detail, /orbits/);
  assert.equal(orbitCenterName('XX'), 'XX');
});

test('SATCAT\'s raw Earth code is never read as "not in Earth orbit"', () => {
  // `orbitCenter` normally arrives friendly and lower-cased, but the contract
  // allows a raw SATCAT code through for an unmapped centre. Misreading Earth's
  // own code would tell a user their satellite left Earth orbit.
  for (const centre of ['earth', 'EA', 'ea', 'Earth', undefined, null, '']) {
    const st = elementStatus({ ...USA_224, orbitCenter: centre });
    assert.equal(st.key, 'no-elements-available', `orbitCenter=${String(centre)}`);
  }
});

test('an unrecognised status code still explains itself', () => {
  // Forward compatibility: a code this build has never seen must not fall back
  // to null, which the UI would render as an ordinary, unexplained record.
  const st = elementStatus({ ...USA_224, dataStatus: 'some-future-code' });
  assert.equal(st.key, 'some-future-code');
  assert.equal(st.label, 'No element set');
  assert.match(st.detail, /not published/);
});

test('approximate-orbit rows skip what the catalogue does not have', () => {
  assert.deepEqual(approximateOrbitRows(null), []);
  assert.deepEqual(approximateOrbitRows(undefined), []);
  assert.deepEqual(approximateOrbitRows({}), []);
  assert.deepEqual(
    approximateOrbitRows({
      periodMinutes: null, inclinationDeg: 63.4, apogeeKm: 39_000, perigeeKm: null,
    }),
    [['Inclination', '63.40°'], ['Apogee', (39_000).toLocaleString() + ' km']],
  );
  // A non-finite value from a malformed record is dropped, not printed as NaN.
  assert.deepEqual(approximateOrbitRows({ periodMinutes: 'n/a', apogeeKm: NaN }), []);
});
