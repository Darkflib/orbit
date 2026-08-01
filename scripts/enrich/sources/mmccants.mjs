// Adapter: Mike McCants' Quicksat intrinsic-magnitude file (qs.mag).
//
// Provides `stdMag` — the intrinsic (standard) magnitude, defined as the max
// apparent brightness at full phase, 1000 km range — exactly our schema field,
// so it maps with no photometric conversion.
//
// SOURCING NOTE: the upstream standalone qsmag.zip URL is currently broken
// (404), and the copy bundled in quicksat.zip is a stale 2010 build with no
// modern objects. So we read a VENDORED copy (scripts/enrich/vendor/qs.mag,
// the 2020 file, recovered from the Wayback Machine). Refresh it with
// scripts/enrich/refresh-mmccants.sh when upstream hosting is fixed. Licence:
// McCants states the data is "freeware ... no restrictions on its distribution".
//
// COVERAGE: good for classic bright objects (ISS, rocket bodies, NOSS, geo);
// sparse for post-2020 LEO constellations. Records without a magnitude simply
// omit `stdMag` — the brightness badge is then not shown for that object.
//
// Fixed-width format (1-indexed cols, per quicksat.txt §5):
//   1-5  NORAD    7 class-letter    9-16 designation    19-32 name
//   34-37 intrinsic magnitude       size / rcs / comments follow

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'vendor', 'qs.mag');

export const id = 'mmccants';
export const licence = 'Quicksat standard magnitudes © Mike McCants (freeware) — mmccants.org';

export async function load(_http, { path = VENDOR } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { records: new Map(), meta: { ok: false, error: `qs.mag unreadable: ${err.message}` } };
  }

  const byNorad = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 37) continue;
    const cat = line.slice(0, 5).trim();
    if (!/^\d+$/.test(cat)) continue;
    const norad = String(parseInt(cat, 10));
    if (norad === '1' || norad === '99999') continue; // header / sentinel rows

    const magField = line.slice(33, 37).trim();
    if (!magField) continue; // entry has a name but no measured magnitude
    const mag = parseFloat(magField);
    if (Number.isNaN(mag)) continue;

    byNorad.set(norad, { stdMag: mag, magSource: 'mmccants' });
  }
  return { records: byNorad, meta: { ok: true, rows: byNorad.size, vendored: true } };
}
