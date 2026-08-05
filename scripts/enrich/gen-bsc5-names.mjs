// Generate the BSC5 proper-name map from the IAU Catalog of Star Names (IAU-CSN).
//
//   node scripts/enrich/gen-bsc5-names.mjs
//
// Reads the vendored IAU-CSN.txt (IAU WGSN, CC-BY 4.0) and writes
// vendor/bsc5-names.json — an { "<HR>": "<ASCII name>" } map keyed by Harvard
// Revised number. The bsc5 adapter merges this over the catalogue's Bayer
// designations so the sky view can label "Sirius" instead of "9Alp CMa".
//
// This is a one-shot generator (like a refresh script), not part of the hot
// enrichment build. Re-run it only when refreshing the vendored IAU-CSN.txt.
//
// IAU-CSN is a fixed-column table; rather than depend on exact byte offsets we
// pull the ASCII name (first token) and the "HR <n>" designation from each
// non-comment row. Rows without an HR designation (exoplanet hosts, HD-only
// stars, etc.) are skipped — they aren't in BSC5.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'vendor', 'IAU-CSN.txt');
const OUT = join(HERE, 'vendor', 'bsc5-names.json');

const text = await readFile(SRC, 'utf8');
const names = {};
let rows = 0;

for (const line of text.split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('#') || line.startsWith('$')) continue;
  const hr = line.match(/\bHR\s+(\d+)\b/);
  if (!hr) continue; // not a Bright Star Catalogue object
  const name = line.trim().split(/\s+/)[0]; // column 1: Name/ASCII (single token)
  if (!name || name === '_') continue;
  names[hr[1]] = name;
  rows++;
}

// Deterministic output: keys sorted numerically by HR.
const sorted = {};
for (const k of Object.keys(names).sort((a, b) => Number(a) - Number(b))) sorted[k] = names[k];

await writeFile(OUT, JSON.stringify(sorted, null, 0) + '\n');
console.log(`[gen-bsc5-names] wrote ${rows} names → ${OUT}`);
