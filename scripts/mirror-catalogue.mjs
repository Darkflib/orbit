// ---------------------------------------------------------------------------
// Mirror the published enrichment catalogue into data/.
//
//   node scripts/mirror-catalogue.mjs
//
// The catalogue is built and published by the orbit-data service
// (https://github.com/Darkflib/orbit-data), which merges SATCAT, GCAT and the
// vendored magnitude/sky sources behind its own validation gates. This script
// does not rebuild any of that — it copies the published tree into the repo so
// GitHub Pages keeps serving a usable catalogue when the mirror is unreachable.
//
// Why a copy rather than a second implementation: src/data.js only falls back
// to the bundled data/ when the mirror *throws* — a network failure or a
// non-OK status. A successful-but-wrong response is used as-is. So an
// independent rebuild here would defend against a failure mode the client can
// never reach, at the cost of a second merge implementation and a second copy
// of the vendored sources to keep in sync. What genuinely buys resilience is
// the copy living in a different failure domain (GitHub's infrastructure), and
// that is exactly what this produces.
//
// The gates below are therefore integrity gates, not a recomputation: they
// establish that what we fetched is a complete, self-consistent, not-older
// catalogue before it is allowed to replace a known-good one.
// ---------------------------------------------------------------------------

import { mkdir, rm, rename, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const ORIGIN = process.env.ORBIT_DATA_ORIGIN ?? 'https://orbit-data.mikepreston.org';
const BASE = `${ORIGIN}/v1/data`;

// The shape src/enrichment.js and src/skyview.js parse. A bump upstream is a
// breaking change for the app, so it must stop the mirror rather than quietly
// ship a tree the client cannot read.
export const SCHEMA_VERSION = 1;

// Floors and drop limits mirror orbit-data's own publication gates, so a
// truncated or partially-merged upstream release cannot overwrite a good seed.
export const MIN_RECORDS = 30000;
export const MAX_RECORD_DROP_FRACTION = 0.2;
export const MIN_STARS = 800;
export const MIN_CONSTELLATIONS = 80;

const FETCH_TIMEOUT_MS = 30000;
const FETCH_ATTEMPTS = 3;
const CONCURRENCY = 8;

class MirrorError extends Error {}

// ---- fetching -------------------------------------------------------------

// One resource, as raw bytes plus its parsed form. The bytes are what gets
// written: re-serializing would produce diffs that track this script's JSON
// formatting rather than actual catalogue changes.
async function fetchJson(path) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE}/${path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      lastError = error;
      // A weekly job has no deadline pressure; a transient blip should not
      // leave the fallback a week staler than it needs to be.
      if (attempt < FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new MirrorError(`cannot fetch ${path}: ${lastError.message}`);
}

// Bounded parallelism: 71 bucket files is enough to be worth overlapping and
// few enough that a small pool keeps the load on the mirror unremarkable.
async function fetchAll(paths) {
  const results = new Map();
  const queue = [...paths];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      results.set(path, await fetchJson(path));
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- validation -----------------------------------------------------------

function fail(message) {
  throw new MirrorError(message);
}

// Bucket a NORAD id exactly as src/enrichment.js does at runtime.
export function bucketOf(norad) {
  return Math.floor(Number.parseInt(norad, 10) / 1000);
}

// The set of bucket files to fetch, derived from the index.
//
// There is no directory listing, and the ids are sparse rather than a 0..N
// range: 6-digit NORAD numbers (issued since 2026, once the 5-digit space was
// exhausted) sit in bucket 100 while buckets 70-99 do not exist at all. Walking
// a range would 404 on the gaps and silently miss the newest objects. Deriving
// the set from the index is exact, and cross-checks against manifest.buckets.
export function bucketsFromIndex(index) {
  if (!Array.isArray(index) || index.length === 0) fail('catalog-index.json is not a non-empty array');
  const buckets = new Set();
  for (const record of index) {
    const bucket = bucketOf(record?.norad);
    if (!Number.isInteger(bucket) || bucket < 0) {
      fail(`catalog-index.json has a record with an unusable norad: ${JSON.stringify(record?.norad)}`);
    }
    buckets.add(bucket);
  }
  return [...buckets].sort((a, b) => a - b);
}

export function validateManifest(manifest, previous) {
  if (manifest?.schemaVersion !== SCHEMA_VERSION) {
    fail(`manifest schemaVersion is ${manifest?.schemaVersion}, expected ${SCHEMA_VERSION}`);
  }
  const records = manifest?.counts?.records;
  if (!Number.isInteger(records) || records < MIN_RECORDS) {
    fail(`manifest reports ${records} records, below the ${MIN_RECORDS} floor`);
  }

  // Parsed rather than compared as strings: orbit-data emits a "+00:00" offset
  // where the retired build job emitted "Z", and those two sort against each
  // other by suffix once the instants are close.
  const generatedAt = Date.parse(manifest?.generatedAt);
  if (Number.isNaN(generatedAt)) fail(`manifest generatedAt is unparseable: ${manifest?.generatedAt}`);

  if (!previous) return;

  const previousAt = Date.parse(previous?.generatedAt);
  // Strictly older only. An *equal* instant is the normal weekly outcome, not a
  // fault: the service republishes only when the normalized content changes, so
  // a healthy catalogue keeps the same generatedAt for as long as nothing moves.
  // Mirroring it again is a no-op the commit step reports as byte-identical —
  // and re-copying rather than skipping means hand-edited or corrupted files
  // repair themselves on the next run.
  if (!Number.isNaN(previousAt) && generatedAt < previousAt) {
    // Never walk the seed backwards: a rolled-back or restored-from-backup
    // mirror must not drag the independent fallback down with it.
    fail(
      `published catalogue (${manifest.generatedAt}) is older than the committed seed ` +
        `(${previous.generatedAt})`,
    );
  }

  const previousRecords = previous?.counts?.records;
  if (Number.isInteger(previousRecords)) {
    const floor = previousRecords * (1 - MAX_RECORD_DROP_FRACTION);
    if (records < floor) {
      fail(
        `published catalogue dropped from ${previousRecords} to ${records} records, ` +
          `more than ${MAX_RECORD_DROP_FRACTION * 100}%`,
      );
    }
  }
}

// Every id the Catalogue browser lists must resolve in the bucket the client
// will actually request. This is the one check that would catch a partially
// published tree, where the index and the buckets disagree.
export function validateBuckets(index, buckets, manifest) {
  if (buckets.size !== manifest.buckets) {
    fail(`fetched ${buckets.size} buckets but the manifest declares ${manifest.buckets}`);
  }
  for (const [bucket, records] of buckets) {
    if (records === null || typeof records !== 'object' || Array.isArray(records)) {
      fail(`enrichment/${bucket}.json is not an object`);
    }
    if (Object.keys(records).length === 0) fail(`enrichment/${bucket}.json is empty`);
  }
  for (const record of index) {
    const records = buckets.get(bucketOf(record.norad));
    if (!records || !(String(record.norad) in records)) {
      fail(`catalog-index.json lists NORAD ${record.norad} but enrichment/${bucketOf(record.norad)}.json does not`);
    }
  }
}

export function validateSky(stars, constellations) {
  for (const [name, document] of [['stars', stars], ['constellations', constellations]]) {
    if (document?.schemaVersion !== SCHEMA_VERSION) {
      fail(`sky/${name}.json schemaVersion is ${document?.schemaVersion}, expected ${SCHEMA_VERSION}`);
    }
  }
  if (!Array.isArray(stars.stars) || stars.stars.length < MIN_STARS) {
    fail(`sky/stars.json has ${stars.stars?.length} stars, below the ${MIN_STARS} floor`);
  }
  if (!Array.isArray(constellations.constellations) || constellations.constellations.length < MIN_CONSTELLATIONS) {
    fail(
      `sky/constellations.json has ${constellations.constellations?.length} figures, ` +
        `below the ${MIN_CONSTELLATIONS} floor`,
    );
  }
}

// ---- main -----------------------------------------------------------------

async function readCommittedManifest() {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, 'manifest.json'), 'utf8'));
  } catch {
    // First run, or a seed that was never committed. The absolute floors still
    // apply; only the relative ones (newer-than, drop fraction) are skipped.
    return null;
  }
}

async function main() {
  const previous = await readCommittedManifest();

  const manifest = await fetchJson('manifest.json');
  validateManifest(manifest.value, previous);

  const index = await fetchJson('catalog-index.json');
  const bucketIds = bucketsFromIndex(index.value);
  console.log(
    `mirroring ${manifest.value.counts.records} records in ${bucketIds.length} buckets ` +
      `(generated ${manifest.value.generatedAt})`,
  );

  const [sky, buckets] = await Promise.all([
    fetchAll(['sky/stars.json', 'sky/constellations.json']),
    fetchAll(bucketIds.map((bucket) => `enrichment/${bucket}.json`)),
  ]);

  validateSky(sky.get('sky/stars.json').value, sky.get('sky/constellations.json').value);
  validateBuckets(
    index.value,
    new Map(bucketIds.map((bucket) => [bucket, buckets.get(`enrichment/${bucket}.json`).value])),
    manifest.value,
  );

  // Stage the whole tree before swapping it in: a fetch that dies partway
  // through must not leave data/ half-replaced for `git add -A` to commit.
  const staging = `${DATA_DIR}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'enrichment'), { recursive: true });
  await mkdir(join(staging, 'sky'), { recursive: true });

  const files = [
    ['manifest.json', manifest.bytes],
    ['catalog-index.json', index.bytes],
    ...[...sky].map(([path, resource]) => [path, resource.bytes]),
    ...bucketIds.map((bucket) => [
      `enrichment/${bucket}.json`,
      buckets.get(`enrichment/${bucket}.json`).bytes,
    ]),
  ];
  for (const [path, bytes] of files) {
    await writeFile(join(staging, path), bytes);
  }

  await rm(DATA_DIR, { recursive: true, force: true });
  await rename(staging, DATA_DIR);
  console.log(`wrote ${files.length} files to data/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof MirrorError ? `mirror aborted: ${error.message}` : error);
    process.exit(1);
  });
}
