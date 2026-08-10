// Tests for the catalogue mirror's integrity gates
// (scripts/mirror-catalogue.mjs). These gates are the only thing standing
// between a bad upstream publish and the fallback the app serves when the
// mirror is unreachable, so each one is pinned to the condition it rejects.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_RECORDS,
  bucketOf,
  bucketsFromIndex,
  validateBuckets,
  validateManifest,
  validateSky,
} from '../scripts/mirror-catalogue.mjs';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    buckets: 2,
    counts: { records: 36212 },
    generatedAt: '2026-08-10T00:15:40.014655+00:00',
    ...overrides,
  };
}

function seed(overrides = {}) {
  return {
    schemaVersion: 1,
    counts: { records: 36165 },
    generatedAt: '2026-08-05T07:14:01.414Z',
    ...overrides,
  };
}

function sky() {
  return [
    { schemaVersion: 1, stars: Array.from({ length: 904 }, (_, i) => i) },
    { schemaVersion: 1, constellations: Array.from({ length: 88 }, (_, i) => i) },
  ];
}

// ---- manifest -------------------------------------------------------------

test('a newer published catalogue passes', () => {
  assert.doesNotThrow(() => validateManifest(manifest(), seed()));
});

test('a first run with no committed seed skips the relative gates', () => {
  assert.doesNotThrow(() => validateManifest(manifest(), null));
});

test('a schemaVersion bump stops the mirror', () => {
  assert.throws(() => validateManifest(manifest({ schemaVersion: 2 }), seed()), /schemaVersion is 2/);
});

test('a truncated catalogue is rejected by the absolute floor', () => {
  assert.throws(
    () => validateManifest(manifest({ counts: { records: MIN_RECORDS - 1 } }), null),
    /below the 30000 floor/,
  );
});

test('the seed never moves backwards', () => {
  assert.throws(
    () => validateManifest(manifest({ generatedAt: '2026-08-01T00:00:00+00:00' }), seed()),
    /is older than the committed seed/,
  );
});

test('an unchanged catalogue is a no-op, not a failure', () => {
  // The service republishes only when the normalized content changes, so a
  // healthy weekly run routinely sees the instant it already mirrored. Failing
  // on that would turn the steady state into a permanent red build.
  assert.doesNotThrow(() => validateManifest(manifest({ generatedAt: seed().generatedAt }), seed()));
});

test('timestamps are compared as instants, not as strings', () => {
  // The seed was written with a "Z" suffix and the mirror writes "+00:00".
  // One minute later must read as newer despite sorting lower by suffix.
  assert.doesNotThrow(() =>
    validateManifest(
      manifest({ generatedAt: '2026-08-05T07:15:01.414000+00:00' }),
      seed({ generatedAt: '2026-08-05T07:14:01.414Z' }),
    ),
  );
});

test('an unparseable timestamp stops the mirror', () => {
  assert.throws(() => validateManifest(manifest({ generatedAt: 'yesterday' }), seed()), /unparseable/);
});

test('a large record drop is rejected even when the catalogue is newer', () => {
  assert.throws(
    () => validateManifest(manifest({ counts: { records: 30001 } }), seed({ counts: { records: 40000 } })),
    /dropped from 40000 to 30001 records/,
  );
});

test('a drop inside the tolerance is allowed', () => {
  assert.doesNotThrow(() =>
    validateManifest(manifest({ counts: { records: 36000 } }), seed({ counts: { records: 36165 } })),
  );
});

// ---- bucket derivation ----------------------------------------------------

test('buckets are derived from the index, including the sparse 6-digit range', () => {
  // Buckets 70-99 do not exist; 6-digit NORADs land in 100. A 0..N walk would
  // 404 on the gap and miss the newest objects entirely.
  const index = [{ norad: '5' }, { norad: '25544' }, { norad: '69000' }, { norad: '100001' }];

  assert.deepEqual(bucketsFromIndex(index), [0, 25, 69, 100]);
});

test('bucketOf matches the client', () => {
  assert.equal(bucketOf('25544'), 25);
  assert.equal(bucketOf(100001), 100);
});

test('an empty index stops the mirror', () => {
  assert.throws(() => bucketsFromIndex([]), /not a non-empty array/);
});

test('an index record without a usable norad stops the mirror', () => {
  assert.throws(() => bucketsFromIndex([{ norad: 'abc' }]), /unusable norad/);
});

// ---- bucket integrity -----------------------------------------------------

test('a complete tree passes', () => {
  const index = [{ norad: '5' }, { norad: '25544' }];
  const buckets = new Map([
    [0, { 5: { name: 'VANGUARD 1' } }],
    [25, { 25544: { name: 'ISS (ZARYA)' } }],
  ]);

  assert.doesNotThrow(() => validateBuckets(index, buckets, manifest()));
});

test('an index entry missing from its bucket stops the mirror', () => {
  // The signature of a partially published tree: the browser would list an
  // object whose detail fetch resolves to nothing.
  const index = [{ norad: '5' }, { norad: '25544' }];
  const buckets = new Map([
    [0, { 5: {} }],
    [25, { 25545: {} }],
  ]);

  assert.throws(() => validateBuckets(index, buckets, manifest()), /lists NORAD 25544/);
});

test('a bucket count disagreeing with the manifest stops the mirror', () => {
  const index = [{ norad: '5' }];
  const buckets = new Map([[0, { 5: {} }]]);

  assert.throws(() => validateBuckets(index, buckets, manifest({ buckets: 71 })), /declares 71/);
});

test('an empty bucket file stops the mirror', () => {
  const index = [{ norad: '5' }];
  const buckets = new Map([[0, {}]]);

  assert.throws(() => validateBuckets(index, buckets, manifest({ buckets: 1 })), /is empty/);
});

test('a bucket served as an array stops the mirror', () => {
  const index = [{ norad: '5' }];
  const buckets = new Map([[0, []]]);

  assert.throws(() => validateBuckets(index, buckets, manifest({ buckets: 1 })), /is not an object/);
});

// ---- sky ------------------------------------------------------------------

test('the published sky artifacts pass', () => {
  assert.doesNotThrow(() => validateSky(...sky()));
});

test('a thin star catalogue stops the mirror', () => {
  const [stars, constellations] = sky();
  stars.stars = stars.stars.slice(0, 799);

  assert.throws(() => validateSky(stars, constellations), /below the 800 floor/);
});

test('a thin constellation set stops the mirror', () => {
  const [stars, constellations] = sky();
  constellations.constellations = constellations.constellations.slice(0, 79);

  assert.throws(() => validateSky(stars, constellations), /below the 80 floor/);
});

test('a sky schemaVersion bump stops the mirror', () => {
  const [stars, constellations] = sky();
  stars.schemaVersion = 2;

  assert.throws(() => validateSky(stars, constellations), /sky\/stars.json schemaVersion is 2/);
});
