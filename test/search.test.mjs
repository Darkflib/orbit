// Tests for the search matching/ranking in src/search.js.
//
// The bug these exist for: the catalogue index was only consulted when the
// loaded 3D field produced no match at all. That is wrong, and wrong precisely
// for the object the feature was built for. With the default Starlink layer
// loaded, "37348" substring-matches the *name* STARLINK-37348 (NORAD 68737), so
// the field returns a match, the catalogue is never asked, and USA 224 (NORAD
// 37348) is silently absent while a different satellite is offered instead.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  catalogueCandidates, mergeCandidates, sortOptions, rankOption, normaliseQuery,
  CATALOGUE_SEARCH_MIN,
} from '../src/search.js';

const fieldOption = (norad, name) => ({ kind: 'field', fieldIndex: 0, norad, name });

// A field holding a Starlink whose *name* contains the digits of another
// object's catalog number, and a catalogue that holds the object itself.
const STARLINK_COLLISION = [fieldOption('68737', 'STARLINK-37348')];
const INDEX = [
  { norad: '37348', name: 'USA 224', dataStatus: 'no-elements-available' },
  { norad: '68737', name: 'STARLINK-37348' },
  { norad: '25544', name: 'ISS (ZARYA)' },
];

test('a catalog number offers the object itself, not a name that contains it', () => {
  const catalogue = catalogueCandidates(INDEX, '37348');
  const merged = mergeCandidates(STARLINK_COLLISION, catalogue, '37348');
  const byNorad = merged.map((o) => o.norad);

  // Both are offered — the field match is not suppressed...
  assert.ok(byNorad.includes('37348'), byNorad.join(','));
  assert.ok(byNorad.includes('68737'), byNorad.join(','));
  // ...but the exact catalog number the user typed comes first.
  assert.equal(merged[0].norad, '37348');
  assert.equal(merged[0].name, 'USA 224');
  assert.equal(merged[0].kind, 'catalogue');
  assert.equal(merged[0].dataStatus, 'no-elements-available');
});

test('the same object from both sources is offered once, as the field one', () => {
  // STARLINK-37348 is in the field and in the index. Only the field option can
  // be shown in 3D, so that is the one that survives.
  const merged = mergeCandidates(STARLINK_COLLISION, catalogueCandidates(INDEX, 'starlink'), 'starlink');
  assert.equal(merged.filter((o) => o.norad === '68737').length, 1);
  assert.equal(merged.find((o) => o.norad === '68737').kind, 'field');
});

test('ranking puts exact matches above loose substring hits', () => {
  assert.equal(rankOption({ norad: '37348', name: 'USA 224' }, '37348'), 0);
  assert.equal(rankOption({ norad: '25544', name: 'ISS (ZARYA)' }, 'iss (zarya)'), 1);
  assert.equal(rankOption({ norad: '25544', name: 'ISS (ZARYA)' }, 'iss'), 2);
  assert.equal(rankOption({ norad: '37348', name: 'USA 224' }, '373'), 3);
  assert.equal(rankOption({ norad: '68737', name: 'STARLINK-37348' }, '37348'), 4);

  const sorted = sortOptions([
    fieldOption('68737', 'STARLINK-37348'),
    fieldOption('99999', 'ISS DEB (37348)'),
    { kind: 'catalogue', norad: '37348', name: 'USA 224' },
  ], '37348');
  assert.deepEqual(sorted.map((o) => o.norad), ['37348', '99999', '68737']);
});

test('a name prefix still beats a match in the middle of a name', () => {
  // The property the original combobox had, and which the merge must keep:
  // typing "iss" offers ISS (ZARYA) before CASSIOPEIA.
  const sorted = sortOptions([
    fieldOption('1', 'CASSIOPEIA'),
    fieldOption('2', 'ISS (ZARYA)'),
  ], 'iss');
  assert.deepEqual(sorted.map((o) => o.name), ['ISS (ZARYA)', 'CASSIOPEIA']);
});

test('catalogue matching covers names and catalog-number prefixes', () => {
  assert.deepEqual(catalogueCandidates(INDEX, 'usa').map((o) => o.norad), ['37348']);
  assert.deepEqual(catalogueCandidates(INDEX, '255').map((o) => o.norad), ['25544']);
  assert.deepEqual(catalogueCandidates(INDEX, 'nothing here'), []);
  // dataStatus is sparse in the index: absent for ordinary objects, and absent
  // for every object on a tree published before the field shipped.
  assert.equal(catalogueCandidates(INDEX, '255')[0].dataStatus, null);
});

test('a short query is not worth the index fetch', () => {
  assert.equal(CATALOGUE_SEARCH_MIN, 3);
  assert.deepEqual(catalogueCandidates(INDEX, 'us'), []);
  assert.deepEqual(catalogueCandidates(INDEX, ''), []);
});

test('a malformed or missing index degrades to no match', () => {
  // The index is fetched; a bad one must not throw in a keystroke handler.
  assert.deepEqual(catalogueCandidates(null, 'usa'), []);
  assert.deepEqual(catalogueCandidates(undefined, 'usa'), []);
  assert.deepEqual(catalogueCandidates({ not: 'an array' }, 'usa'), []);
  assert.deepEqual(catalogueCandidates([null, undefined, {}, { norad: 5 }], 'usa'), []);
  // A row with no name is offered under its catalog number rather than dropped.
  assert.deepEqual(
    catalogueCandidates([{ norad: 37348 }], '37348').map((o) => o.name),
    ['NORAD 37348'],
  );
  // A catalogue row with no usable id cannot be merged (nothing to open).
  assert.deepEqual(mergeCandidates([], [{ kind: 'catalogue', norad: '', name: 'X' }], 'x'), []);
});

test('the merged list is capped', () => {
  const many = Array.from({ length: 60 }, (_, i) => fieldOption(String(i), `SAT-${i}`));
  assert.equal(mergeCandidates(many, [], 'sat').length, 40);
  assert.equal(mergeCandidates(many, [], 'sat', 5).length, 5);
});

test('queries are normalised the same way everywhere', () => {
  assert.equal(normaliseQuery('  USA 224 '), 'usa 224');
  assert.equal(normaliseQuery(null), '');
  assert.deepEqual(
    catalogueCandidates(INDEX, '  USA  ').map((o) => o.norad),
    catalogueCandidates(INDEX, 'usa').map((o) => o.norad),
  );
});
