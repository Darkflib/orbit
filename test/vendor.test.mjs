// Guards the vendored third-party tree.
//
// vendor/ is committed rather than fetched at deploy time, which buys a
// build-step-free clone at the cost of the tree being editable in place and
// silently divergent from what scripts/vendor.mjs would produce. These tests
// close that gap: every file matches the sha256 recorded when it was fetched,
// and everything the app actually references resolves to a file that exists.
// A missing texture is otherwise an untextured globe with no error, and a
// missing module is a page that hangs on the loading overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSETS, PINS, REPO_ROOT, VENDOR_DIR, readManifest, sha256,
} from '../scripts/vendor.mjs';

const manifest = await readManifest();
const html = await readFile(join(REPO_ROOT, 'index.html'), 'utf8');
const imports = JSON.parse(
  html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1],
).imports;

test('every vendored file matches the digest recorded when it was fetched', async () => {
  for (const [dest, meta] of Object.entries(manifest.files)) {
    const buf = await readFile(join(VENDOR_DIR, dest));
    assert.equal(
      sha256(buf),
      meta.sha256,
      `${dest} differs from VENDOR.json — re-run \`npm run vendor\``,
    );
    assert.equal(buf.length, meta.bytes, `${dest} is the wrong length`);
  }
});

test('VENDOR.json covers exactly the assets the vendor script fetches', () => {
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    ASSETS.map((a) => a.dest).sort(),
  );
  assert.deepEqual(manifest.pins, PINS, 'recorded pins are stale');
});

test('every import-map target resolves to a vendored file', () => {
  for (const [specifier, target] of Object.entries(imports)) {
    assert.ok(
      target.startsWith('./vendor/'),
      `"${specifier}" should point into vendor/, got ${target}`,
    );
    // A trailing-slash entry is a prefix mapping (three/addons/), so the
    // directory is what has to exist rather than a file.
    const path = join(REPO_ROOT, target.replace('./', ''));
    assert.ok(existsSync(path), `${target} (for "${specifier}") does not exist`);
  }
});

test('the propagation worker imports satellite.js from vendor/, not a CDN', async () => {
  const worker = await readFile(join(REPO_ROOT, 'src', 'worker.js'), 'utf8');
  // Module workers get no import map, so this one import is a literal path and
  // has to be checked separately from the map above.
  const match = worker.match(/^import .* from '(.+)';$/m);
  assert.ok(match, 'worker.js should import satellite.js');
  assert.equal(match[1], '../vendor/satellite.js/satellite.js');
  assert.ok(existsSync(join(REPO_ROOT, 'src', match[1])), 'worker import is dangling');
});

test('the Earth textures constants.js asks for are all vendored', async () => {
  const constants = await readFile(join(REPO_ROOT, 'src', 'constants.js'), 'utf8');
  const files = [...constants.matchAll(/'(earth_[a-z_0-9]+\.(?:jpg|png))'/g)].map((m) => m[1]);
  assert.equal(files.length, 4, 'expected four Earth textures');
  for (const file of files) {
    assert.ok(
      existsSync(join(VENDOR_DIR, 'textures', file)),
      `vendor/textures/${file} is referenced but missing`,
    );
  }
});
