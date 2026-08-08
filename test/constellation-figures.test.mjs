// Tests for the constellation-figure adapter (scripts/enrich/sources/
// constellation-figures.mjs) and the artifact it produces.
//
// The case that matters is Serpens: it is the one constellation split into two
// disjoint halves (Caput and Cauda), and the source carries it as two GeoJSON
// Features sharing `id: "Ser"`. The first draft assigned rather than merged, so
// half of Serpens vanished from the artifact while the segment tally still
// counted it — silent, and invisible unless you knew to look at that one
// constellation. These tests pin the merge and the RA convention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load, id, licence } from '../scripts/enrich/sources/constellation-figures.mjs';

const VENDOR = new URL('../scripts/enrich/vendor/constellation-lines.json', import.meta.url);
const ARTIFACT = new URL('../data/sky/constellations.json', import.meta.url);

// Build a GeoJSON FeatureCollection from [id, ...polylines] tuples.
const geo = (...features) => ({
  type: 'FeatureCollection',
  features: features.map(([fid, ...coordinates]) => ({
    type: 'Feature', id: fid, geometry: { type: 'MultiLineString', coordinates },
  })),
});

async function loadFixture(obj) {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  const path = join(dir, 'fixture.json');
  await writeFile(path, JSON.stringify(obj));
  return load(null, { path });
}

test('adapter declares an id and a licence for SOURCES.md', () => {
  assert.equal(id, 'constellation-figures');
  assert.match(licence, /BSD-3-Clause/);
});

test('features sharing an id are merged, not overwritten', async () => {
  const { records } = await loadFixture(geo(
    ['Ser', [[10, 10], [11, 11]]],
    ['Aql', [[20, 20], [21, 21]]],
    ['Ser', [[30, 30], [31, 31], [32, 32]]],
  ));

  assert.equal(records.size, 2, 'the duplicate id must not create a second record');
  const ser = records.get('Ser');
  assert.equal(ser.lines.length, 2, 'both halves of Serpens survive');
  assert.deepEqual(ser.lines[0], [10, 10, 11, 11]);
  assert.deepEqual(ser.lines[1], [30, 30, 31, 31, 32, 32]);
});

test('negative RA is normalised to 0..360 to match stars.json', async () => {
  const { records } = await loadFixture(geo(['And', [[-5.4658, 43.2681], [2.0969, 29.0904]]]));
  const [ra1, dec1, ra2, dec2] = records.get('And').lines[0];
  assert.ok(Math.abs(ra1 - 354.5342) < 1e-9, `ra ${ra1}`);
  assert.ok(Math.abs(dec1 - 43.2681) < 1e-9);
  assert.ok(Math.abs(ra2 - 2.0969) < 1e-9, 'already-positive RA is left alone');
  assert.ok(Math.abs(dec2 - 29.0904) < 1e-9);
});

test('degenerate and malformed polylines are dropped', async () => {
  const { records } = await loadFixture(geo(
    ['Aaa', [[1, 1]]],                       // single point draws nothing
    ['Bbb', [[1, 1], [null, 2]]],            // non-finite -> too short to keep
    ['Ccc', [[1, 1], [2, 2]]],               // valid
  ));
  assert.equal(records.has('Aaa'), false);
  assert.equal(records.has('Bbb'), false);
  assert.deepEqual(records.get('Ccc').lines, [[1, 1, 2, 2]]);
});

test('a missing vendored file is non-fatal', async () => {
  const { records, meta } = await load(null, { path: '/nonexistent/constellations.json' });
  assert.equal(records.size, 0);
  assert.equal(meta.ok, false);
});

test('the committed artifact matches a fresh build of the vendored source', async () => {
  const { records } = await load(null);
  const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

  const fresh = Array.from(records.values()).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    artifact.constellations, fresh,
    'data/sky/constellations.json is stale — re-run the constellation writer',
  );
});

test('every vendored feature id survives into the artifact', async () => {
  const vendored = JSON.parse(await readFile(VENDOR, 'utf8'));
  const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));

  const sourceIds = new Set(vendored.features.map((f) => f.id));
  const builtIds = new Set(artifact.constellations.map((c) => c.id));
  for (const sid of sourceIds) {
    assert.ok(builtIds.has(sid), `constellation ${sid} missing from the artifact`);
  }

  // Serpens specifically: two source Features, one record, both halves kept.
  const serFeatures = vendored.features.filter((f) => f.id === 'Ser');
  assert.equal(serFeatures.length, 2, 'fixture assumption: Serpens is split in the source');
  const serLines = artifact.constellations.find((c) => c.id === 'Ser').lines.length;
  const sourceLines = serFeatures.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  assert.equal(serLines, sourceLines, 'both halves of Serpens are in the artifact');
});
