// Tests for the Bright Star Catalogue adapter (scripts/enrich/sources/bsc5.mjs).
//
// BSC5 is fixed-width, so the whole adapter hinges on reading the right byte
// columns. Rather than vendor the full catalogue here, we synthesise a handful
// of lines by placing each field at its documented 1-indexed column and assert
// the parser recovers known values (Sirius, Vega), applies the magnitude cut,
// and skips deleted/blank entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load } from '../scripts/enrich/sources/bsc5.mjs';

// Place `str` at 1-indexed column `col` within a fixed-width line buffer.
function put(buf, col, str) {
  const start = col - 1;
  for (let i = 0; i < str.length; i++) buf[start + i] = str[i];
}

// Build one BSC5-format line from named J2000 fields. Column map per VizieR V/50.
function line({ hr, name = '', rah, ram, ras, sign = '+', ded, dem, des, vmag }) {
  const buf = Array(200).fill(' ');
  put(buf, 1, String(hr).padStart(4)); //   1-  4 HR
  put(buf, 5, name.padEnd(10).slice(0, 10)); //   5- 14 Name
  put(buf, 76, rah); //  76- 77 RAh
  put(buf, 78, ram); //  78- 79 RAm
  put(buf, 80, ras); //  80- 83 RAs
  put(buf, 84, sign); //      84 DE sign
  put(buf, 85, ded); //  85- 86 DEd
  put(buf, 87, dem); //  87- 88 DEm
  put(buf, 89, des); //  89- 90 DEs
  put(buf, 103, String(vmag).padStart(5)); // 103-107 Vmag
  return buf.join('');
}

const FIXTURE = [
  // Sirius — HR 2491, RA 06 45 08.9, Dec -16 42 58, V -1.46
  line({ hr: 2491, name: '9Alp CMa', rah: '06', ram: '45', ras: '08.9', sign: '-', ded: '16', dem: '42', des: '58', vmag: '-1.46' }),
  // Vega — HR 7001, RA 18 36 56.3, Dec +38 47 01, V 0.03
  line({ hr: 7001, name: '3Alp Lyr', rah: '18', ram: '36', ras: '56.3', sign: '+', ded: '38', dem: '47', des: '01', vmag: ' 0.03' }),
  // A faint star, above the default mag cut — must be dropped.
  line({ hr: 9000, name: 'faint', rah: '00', ram: '00', ras: '00.0', sign: '+', ded: '00', dem: '00', des: '00', vmag: ' 6.50' }),
  // A deleted entry: blank position fields — must be skipped.
  line({ hr: 92, name: 'deleted', rah: '  ', ram: '  ', ras: '    ', sign: ' ', ded: '  ', dem: '  ', des: '  ', vmag: ' 5.00' }),
].join('\n') + '\n';

async function withFixture(fn, { names } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bsc5-'));
  const path = join(dir, 'bsc5.dat');
  await writeFile(path, FIXTURE);
  let namesPath = join(dir, 'nope.json');
  if (names) {
    namesPath = join(dir, 'names.json');
    await writeFile(namesPath, JSON.stringify(names));
  }
  try {
    return await fn({ path, namesPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parses J2000 RA/Dec into degrees and reads Vmag at the right columns', async () => {
  await withFixture(async ({ path, namesPath }) => {
    const { records, meta } = await load(null, { path, namesPath });
    assert.equal(meta.ok, true);

    const sirius = records.get('2491');
    assert.ok(sirius, 'Sirius (HR 2491) should be parsed');
    assert.ok(Math.abs(sirius.ra - 101.2871) < 1e-3, `Sirius RA ${sirius.ra}`);
    assert.ok(Math.abs(sirius.dec - -16.7161) < 1e-3, `Sirius Dec ${sirius.dec}`);
    assert.equal(sirius.mag, -1.46);
    assert.equal(sirius.bayer, '9Alp CMa');

    const vega = records.get('7001');
    assert.ok(Math.abs(vega.ra - 279.2346) < 1e-3, `Vega RA ${vega.ra}`);
    assert.ok(Math.abs(vega.dec - 38.7836) < 1e-3, `Vega Dec ${vega.dec}`);
    assert.equal(vega.mag, 0.03);
  });
});

test('applies the magnitude cut and skips deleted (blank-position) entries', async () => {
  await withFixture(async ({ path, namesPath }) => {
    const { records } = await load(null, { path, namesPath, maxMag: 4.5 });
    assert.equal(records.size, 2, 'only Sirius and Vega survive the mag 4.5 cut');
    assert.ok(!records.has('9000'), 'the mag 6.5 star is excluded');
    assert.ok(!records.has('92'), 'the deleted entry is excluded');
  });
});

test('a higher magnitude cut admits fainter stars', async () => {
  await withFixture(async ({ path, namesPath }) => {
    const { records } = await load(null, { path, namesPath, maxMag: 7.0 });
    assert.ok(records.has('9000'), 'the mag 6.5 star is admitted at maxMag 7.0');
  });
});

test('a proper-name map overrides the Bayer designation', async () => {
  await withFixture(async ({ path, namesPath }) => {
    const { records } = await load(null, { path, namesPath });
    assert.equal(records.get('2491').name, 'Sirius');
    assert.equal(records.get('2491').bayer, '9Alp CMa', 'bayer designation is preserved');
  }, { names: { 2491: 'Sirius' } });
});

test('a missing catalogue file is non-fatal', async () => {
  const { records, meta } = await load(null, { path: '/no/such/bsc5.dat' });
  assert.equal(meta.ok, false);
  assert.equal(records.size, 0);
});
