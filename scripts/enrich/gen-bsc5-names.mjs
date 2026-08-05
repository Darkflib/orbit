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
// pull the ASCII name (column 1) and the "HR <n>" designation from each
// non-comment row. Columns are separated by two or more spaces, so the name is
// everything up to the first 2+-space gap — this preserves multi-word names
// ("Rigil Kentaurus", "Kaus Australis", "Deneb Algedi") rather than truncating
// them to a first token, which would also collide with single-word names (e.g.
// "Deneb Algedi" -> "Deneb", clashing with the real Deneb, HR 7924). Rows
// without an HR designation (exoplanet hosts, HD-only stars, etc.) are skipped —
// they aren't in BSC5.

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
  const col1 = line.match(/^(\S.*?)\s{2,}/); // column 1 up to the 2+-space gap
  if (!col1) continue;
  const name = col1[1].trim(); // Name/ASCII, multi-word preserved
  if (!name || name === '_') continue;
  names[hr[1]] = name;
  rows++;
}

// Deterministic output: keys sorted numerically by HR.
const sorted = {};
for (const k of Object.keys(names).sort((a, b) => Number(a) - Number(b))) sorted[k] = names[k];

await writeFile(OUT, JSON.stringify(sorted, null, 0) + '\n');
console.log(`[gen-bsc5-names] wrote ${rows} names → ${OUT}`);
