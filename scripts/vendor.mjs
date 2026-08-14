// ---------------------------------------------------------------------------
// Fetch the third-party runtime assets into vendor/.
//
// Orbit used to load three.js, satellite.js, astronomy-engine and the Earth
// textures straight from cdn.jsdelivr.net. That is fine for a page you always
// open online, and wrong for an installable app: a service worker cannot
// reliably pre-cache opaque cross-origin responses, so an offline launch came
// up to a blank globe. It also meant jsDelivr having a bad day took the whole
// app down, and it put third-party code inside the app's own origin at runtime.
//
// So the assets are vendored and committed. Note what this does *not* do: it is
// not a build step. A fresh clone still runs with `npm start` and nothing else —
// vendor/ is checked in, and this script only ever runs by hand when a pin
// moves. That is the whole reason the files are committed rather than fetched
// at deploy time.
//
//   node scripts/vendor.mjs                # refetch, verifying against VENDOR.json
//   node scripts/vendor.mjs --accept-new   # ...and trust bytes for changed pins
//   node scripts/vendor.mjs --check        # verify vendor/ matches VENDOR.json
//
// VENDOR.json records the source URL, version and sha256 of every file.
// test/vendor.test.mjs re-hashes the tree against it, so a truncated download
// or an edited-in-place library fails the suite rather than the browser.
// ---------------------------------------------------------------------------
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const VENDOR_DIR = join(REPO_ROOT, 'vendor');
export const MANIFEST_PATH = join(VENDOR_DIR, 'VENDOR.json');

// Pinned versions live here and nowhere else. The import map in index.html
// points at the vendored *paths*, which do not carry a version, so this file is
// the single source of truth for what is installed. Renovate updates it by
// matching the `version` fields below.
export const PINS = {
  three: '0.160.0',
  'satellite.js': '7.1.0',
  'astronomy-engine': '2.1.19',
  // The Earth textures ship in the three.js repository rather than the npm
  // package, so they are pinned to a git tag instead of a release version.
  'three-examples': 'r160',
};

const NPM = (pkg, version, path) =>
  `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;
const GH_THREE = (path) =>
  `https://cdn.jsdelivr.net/gh/mrdoob/three.js@${PINS['three-examples']}/${path}`;

// Every file that ends up in vendor/, with where it came from. `dest` is
// relative to vendor/ and is exactly what the import map and constants.js
// reference, so this table and those two files have to agree — the vendor test
// checks that they do.
export const ASSETS = [
  {
    dest: 'three/three.module.js',
    url: NPM('three', PINS.three, 'build/three.module.js'),
    pkg: 'three',
    version: PINS.three,
  },
  {
    dest: 'three/addons/controls/OrbitControls.js',
    url: NPM('three', PINS.three, 'examples/jsm/controls/OrbitControls.js'),
    pkg: 'three',
    version: PINS.three,
  },
  // The `+esm` bundles, not the package entry points: jsDelivr flattens each
  // package into one self-contained module with no relative sibling imports, so
  // vendoring is a single file rather than a dist/ tree to keep in step.
  {
    dest: 'satellite.js/satellite.js',
    url: NPM('satellite.js', PINS['satellite.js'], '+esm'),
    pkg: 'satellite.js',
    version: PINS['satellite.js'],
  },
  {
    dest: 'astronomy-engine/astronomy.js',
    url: NPM('astronomy-engine', PINS['astronomy-engine'], '+esm'),
    pkg: 'astronomy-engine',
    version: PINS['astronomy-engine'],
  },
  ...['earth_atmos_2048.jpg', 'earth_specular_2048.jpg',
    'earth_clouds_1024.png', 'earth_lights_2048.png'].map((file) => ({
    dest: `textures/${file}`,
    url: GH_THREE(`examples/textures/planets/${file}`),
    pkg: 'three-examples',
    version: PINS['three-examples'],
  })),
];

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // jsDelivr serves an HTML error page with a 200 for some bad paths, and a
  // truncated module fails much later and much less legibly than here.
  if (buf.length === 0) throw new Error(`empty response for ${url}`);
  return buf;
}

async function vendorAll({ acceptNew = false } = {}) {
  // Read the committed lockfile *before* the tree is cleared. This is what
  // makes re-vendoring a verification rather than an act of faith: for a pin
  // that has not moved, the bytes must hash to what is already recorded.
  //
  // Without it the digest is derived from the very download it is supposed to
  // vouch for, so an altered or truncated response would simply be recorded as
  // the new truth and would then pass `--check` and the test suite for ever
  // after. The recorded hash would only ever catch later local edits.
  let previous = null;
  try {
    previous = await readManifest();
  } catch {
    // No lockfile yet — the first ever vendoring run.
  }

  const unverifiable = [];
  const downloads = [];
  for (const asset of ASSETS) {
    const buf = await download(asset.url);
    const digest = sha256(buf);
    const known = previous?.files?.[asset.dest];
    // A recorded digest is only authoritative for the same pinned version;
    // a version bump is expected to change the bytes.
    const expected = known && known.version === asset.version ? known.sha256 : null;

    if (expected && expected !== digest) {
      throw new Error(
        `integrity check failed for ${asset.dest}\n`
        + `  pinned:   ${asset.pkg}@${asset.version} (unchanged)\n`
        + `  expected: ${expected}\n`
        + `  received: ${digest}\n`
        + `  from:     ${asset.url}\n`
        + 'The pin has not moved, so these bytes should be identical. Nothing has\n'
        + 'been written. Investigate before re-running: either upstream republished\n'
        + 'the same version, or the response was tampered with in transit.',
      );
    }
    if (!expected) unverifiable.push(`${asset.dest} (${asset.pkg}@${asset.version})`);
    downloads.push({ asset, buf, digest });
  }

  // Adopting bytes with no digest to check them against is a real trust
  // decision — a pin bump, or a first run — so it is made explicitly rather
  // than as a side effect of running the script.
  if (unverifiable.length && !acceptNew) {
    throw new Error(
      `no recorded digest to verify against for:\n  ${unverifiable.join('\n  ')}\n\n`
      + 'This is expected when a pin has changed or on a first run. Nothing has been\n'
      + 'written. Re-run with --accept-new to trust and record these bytes, and treat\n'
      + 'the resulting VENDOR.json diff as part of the review.',
    );
  }

  // Only now, with every download either verified or explicitly accepted, is
  // anything written to disk.
  await rm(VENDOR_DIR, { recursive: true, force: true });
  const files = {};
  for (const { asset, buf, digest } of downloads) {
    const out = join(VENDOR_DIR, asset.dest);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, buf);
    files[asset.dest] = {
      url: asset.url,
      package: asset.pkg,
      version: asset.version,
      bytes: buf.length,
      sha256: digest,
    };
    console.log(`  ${asset.dest}  ${(buf.length / 1024).toFixed(1)} KiB`);
  }
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ pins: PINS, files }, null, 2)}\n`,
  );
  const total = Object.values(files).reduce((n, f) => n + f.bytes, 0);
  console.log(`\nvendored ${ASSETS.length} files, ${(total / 1024 / 1024).toFixed(2)} MiB`);
}

async function check() {
  const { files } = await readManifest();
  const bad = [];
  for (const [dest, meta] of Object.entries(files)) {
    let buf;
    try {
      buf = await readFile(join(VENDOR_DIR, dest));
    } catch {
      bad.push(`${dest}: missing`);
      continue;
    }
    const got = sha256(buf);
    if (got !== meta.sha256) bad.push(`${dest}: sha256 ${got} != ${meta.sha256}`);
  }
  if (bad.length) {
    console.error(`vendor/ does not match VENDOR.json:\n  ${bad.join('\n  ')}`);
    console.error('\nRe-run `npm run vendor` to restore it.');
    process.exit(1);
  }
  console.log(`vendor/ matches VENDOR.json (${Object.keys(files).length} files)`);
}

// pathToFileURL rather than a `file://` template: the concatenated form is
// wrong for paths containing spaces or non-ASCII characters, and for Windows
// drive letters — the guard silently fails and the script does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) await check();
  else await vendorAll({ acceptNew: process.argv.includes('--accept-new') });
}
