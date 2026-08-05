// Adapter: Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren).
//
// Provides the naked-eye star set for the observer / sky-dome view: position
// (RA/Dec, J2000, in degrees) + Johnson V magnitude + names. This is NOT
// satellite enrichment — it produces a standalone sky artifact
// (data/sky/stars.json), keyed by HR number, and is never joined to the
// NORAD-keyed satellite records.
//
// SOURCING NOTE: BSC5 is effectively frozen (5th ed. preliminary, 1991), so we
// read a VENDORED copy (scripts/enrich/vendor/bsc5.dat) rather than re-fetching
// a catalogue that never changes. Source: VizieR V/50 (CDS, Strasbourg).
// Licence: public-domain scientific catalogue, freely redistributable with
// attribution — same freeware tier as mmccants. If the vendored file is absent
// the build's soft-load reports zero stars (additive, non-fatal), exactly like
// a missing magnitude source.
//
// Proper names ("Sirius") are NOT in BSC5's designation field, so an optional
// vendored HR->name map (vendor/bsc5-names.json) supplies them. That map is
// generated from the IAU Catalog of Star Names (IAU WGSN, CC-BY 4.0) by
// scripts/enrich/gen-bsc5-names.mjs. Stars without a mapped name fall back to
// their Bayer/Flamsteed designation from the catalogue's Name field.
//
// Fixed-width format (1-indexed columns, per the VizieR V/50 ReadMe):
//   1-  4  HR (Harvard Revised) number
//   5- 14  Name  (Bayer / Flamsteed designation)
//  76- 77  RAh   78- 79  RAm   80- 83  RAs      (equinox J2000, epoch 2000.0)
//      84  DE sign
//  85- 86  DEd   87- 88  DEm   89- 90  DEs      (equinox J2000, epoch 2000.0)
// 103-107  Vmag  (Johnson V)
// Deleted / novae entries have blank position or magnitude fields and are
// skipped by the null guards below.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, '..', 'vendor', 'bsc5.dat');
const NAMES = join(HERE, '..', 'vendor', 'bsc5-names.json');

export const id = 'bsc5';
export const licence =
  'Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren) — public domain, via VizieR V/50 (CDS); ' +
  'proper names from the IAU Catalog of Star Names (IAU WGSN, CC-BY 4.0)';

const num = (s) => {
  const v = parseFloat(s);
  return Number.isNaN(v) ? null : v;
};

// Load and normalise BSC5 into a Map<hrString, starRecord>.
//   maxMag   — brightness cut. 4.5 -> ~500 stars / ~30 KB; 6.0 -> a fuller sky
//              (~5000); 3.0 -> just the brightest (~170).
//   path     — override the catalogue path (tests).
//   namesPath— override the HR->name map path (tests).
export async function load(_http, { path = VENDOR, namesPath = NAMES, maxMag = 4.5 } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { records: new Map(), meta: { ok: false, error: `bsc5.dat unreadable: ${err.message}` } };
  }

  let names = {};
  try {
    names = JSON.parse(await readFile(namesPath, 'utf8'));
  } catch {
    /* names map is optional — fall back to Bayer/Flamsteed designations */
  }

  const byHr = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 107) continue; // needs the full Vmag column present
    const hr = line.slice(0, 4).trim();
    if (!/^\d+$/.test(hr)) continue;

    const mag = num(line.slice(102, 107));
    if (mag === null || mag > maxMag) continue; // blank mag / too faint

    const rah = num(line.slice(75, 77));
    const ram = num(line.slice(77, 79));
    const ras = num(line.slice(79, 83));
    const sign = line[83] === '-' ? -1 : 1;
    const ded = num(line.slice(84, 86));
    const dem = num(line.slice(86, 88));
    const des = num(line.slice(88, 90));
    if ([rah, ram, ras, ded, dem, des].some((v) => v === null)) continue; // deleted entry

    const ra = 15 * (rah + ram / 60 + ras / 3600); // RA hours -> degrees
    const dec = sign * (ded + dem / 60 + des / 3600);
    const bayer = line.slice(4, 14).trim() || null;

    byHr.set(hr, {
      hr: Number(hr),
      name: names[hr] || bayer, // proper name if the map has one, else designation
      bayer,
      ra: +ra.toFixed(4),
      dec: +dec.toFixed(4),
      mag,
    });
  }

  return { records: byHr, meta: { ok: true, rows: byHr.size, vendored: true, maxMag } };
}
