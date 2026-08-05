// Enrichment build entry point.
//
//   node scripts/enrich/build.mjs
//
// Fetches SATCAT (load-bearing) + GCAT + mmccants magnitudes, merges them with
// per-field precedence, validates, and writes data/ (catalog-index, prefix
// buckets, manifest) plus SOURCES.md. Fail-safe: SATCAT failure or a failed
// validation gate aborts with a non-zero exit BEFORE anything is written, so a
// broken upstream never replaces good published data. GCAT / mmccants failures
// degrade gracefully (their fields simply go missing).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getText } from './http.mjs';
import * as satcat from './sources/satcat.mjs';
import * as gcat from './sources/gcat.mjs';
import * as mmccants from './sources/mmccants.mjs';
import * as bsc5 from './sources/bsc5.mjs';
import { merge } from './merge.mjs';
import { validate } from './validate.mjs';
import { writeOutputs, writeStars, writeSources } from './write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA = join(REPO, 'data');

const http = { getText };
const log = (...a) => console.log('[enrich]', ...a);

// Load an augmenting source; never fatal — return an empty map on failure.
async function soft(mod, label) {
  try {
    const r = await mod.load(http);
    log(`${label}: ${r.records.size} rows`, r.meta.fromCache ? '(304 cache)' : '');
    return r;
  } catch (err) {
    log(`WARN ${label} failed: ${err.message} — continuing without it`);
    return { records: new Map(), meta: { ok: false, error: err.message } };
  }
}

async function main() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // SATCAT is load-bearing — a failure here must abort (throws out of main).
  let base;
  try {
    base = await satcat.load(http);
    log(`satcat: ${base.records.size} rows`, base.meta.fromCache ? '(304 cache)' : '');
  } catch (err) {
    throw new Error(`SATCAT (load-bearing) failed: ${err.message}`);
  }

  const g = await soft(gcat, 'gcat');
  const m = await soft(mmccants, 'mmccants');
  // Stars are a separate sky artifact, not satellite enrichment — they don't
  // enter the merge below. Soft-loaded: a missing catalogue just yields no sky.
  const s = await soft(bsc5, 'bsc5');

  const { records, counts } = merge(
    { satcat: base.records, gcat: g.records, mmccants: m.records },
    today,
  );
  log('merged:', JSON.stringify(counts));

  const { warnings } = validate({ satcatRows: base.records.size, counts });
  for (const w of warnings) log('WARN', w);

  const sourceMeta = {
    satcat: { ok: base.meta.ok, fetchedAt: base.meta.fetchedAt ?? null, rows: base.records.size },
    gcat: { ok: g.meta.ok, fetchedAt: g.meta.fetchedAt ?? null, rows: g.records.size },
    mmccants: { ok: m.meta.ok, rows: m.records.size, vendored: !!m.meta.vendored },
  };

  const written = await writeOutputs(DATA, records, { generatedAt: now, counts }, sourceMeta);
  const nStars = await writeStars(DATA, s.records, { generatedAt: now, maxMag: s.meta.maxMag });
  await writeSources(
    REPO,
    [satcat, gcat, mmccants, bsc5].map((src) => ({ id: src.id, licence: src.licence })),
  );

  log(`wrote ${written.records} records across ${written.buckets} buckets → data/`);
  log(`wrote ${nStars} stars → data/sky/stars.json`);
  log('done.');
}

main().catch((err) => {
  console.error('[enrich] FATAL:', err.message);
  process.exit(1);
});
