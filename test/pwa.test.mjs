// Guards the installable-app surface: the manifest, the icons and the service
// worker's pre-cache list.
//
// All three fail quietly in the browser when they drift. A manifest icon that
// 404s makes the app silently non-installable; a module missing from the
// service worker's SHELL list works perfectly until the first offline launch,
// which is exactly when nobody can read a console. So the checks here are
// mostly "does this path actually exist", which is dull and is the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { SIZES, renderIcon } from '../scripts/make-icons.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFile(join(REPO_ROOT, ...p), 'utf8');
const resolve = (url) => join(REPO_ROOT, url.replace(/^\.\//, ''));

const manifest = JSON.parse(await read('manifest.webmanifest'));
const html = await read('index.html');
const sw = await read('sw.js');

// The SHELL array is a plain literal, so reading it out of the source is both
// simpler and more honest than importing sw.js (which references `self` and a
// pile of service-worker globals Node does not have).
//
// Guarded, because this runs at import time: if the literal is ever reformatted
// the match returns null and `[1]` throws a TypeError, which aborts the whole
// file — every test in it vanishes rather than one failing with a reason.
const shellLiteral = sw.match(/const SHELL = \[([\s\S]*?)\];/);
assert.ok(shellLiteral, 'could not find the SHELL array literal in sw.js');
const SHELL = [...shellLiteral[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.ok(SHELL.length > 0, 'parsed an empty SHELL list out of sw.js');

test('every manifest icon exists and is declared at its real size', async () => {
  assert.ok(manifest.icons.length >= 2, 'need at least a 192 and a 512');
  for (const icon of manifest.icons) {
    const path = resolve(icon.src);
    assert.ok(existsSync(path), `${icon.src} is listed in the manifest but missing`);
    // Width and height live at bytes 16..24 of a PNG, right after the IHDR
    // length/type. Cheaper than a decoder and enough to catch a mislabelled size.
    const buf = await readFile(path);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is not ${icon.sizes}`);
  }
});

test('the manifest declares a maskable icon', () => {
  // Without one, Android crops the square art to its adaptive-icon shape and
  // clips the mark.
  const maskable = manifest.icons.filter((i) => (i.purpose ?? '').includes('maskable'));
  assert.ok(maskable.length >= 1, 'at least one icon must have purpose "maskable"');
});

test('manifest start_url and scope are relative', () => {
  // Absolute paths break the moment the app is served from a project subpath,
  // which is exactly how GitHub Pages serves it.
  for (const field of ['start_url', 'scope']) {
    assert.ok(
      manifest[field].startsWith('.'),
      `${field} must be relative, got ${manifest[field]}`,
    );
  }
});

test('index.html links the manifest and the iOS icon', () => {
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\.\/icons\/apple-touch-icon\.png"/);
  assert.ok(existsSync(join(REPO_ROOT, 'icons', 'apple-touch-icon.png')));
});

test('the viewport opts into the display cutout', () => {
  // env(safe-area-inset-*) reports 0 without viewport-fit=cover, so the padding
  // in main.css silently does nothing and the topbar sits under the notch.
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
});

// Pull the dimensions and the decompressed pixels back out of a PNG.
//
// Comparing the raw file bytes would be simpler and wrong: the pixels are
// deflated, and zlib's output for identical input is not guaranteed stable
// across Node or zlib versions. That would fail this test on a routine runtime
// upgrade while the rendered image was byte-identical — a false alarm about
// stale icons that sends someone hunting through the wrong file.
function decodePng(buf) {
  const idat = [];
  let width = 0;
  let height = 0;
  let offset = 8; // past the 8-byte signature
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    offset += 12 + length; // length + type + data + crc
  }
  return { width, height, pixels: inflateSync(Buffer.concat(idat)) };
}

test('the committed icons are what make-icons.mjs renders', async () => {
  // Regenerating is cheap, and this is the only thing standing between the
  // committed binaries and the geometry that is supposed to define them.
  for (const { file, size, maskable } of SIZES) {
    const expected = decodePng(renderIcon(size, maskable));
    const actual = decodePng(await readFile(join(REPO_ROOT, 'icons', file)));
    assert.equal(actual.width, expected.width, `${file} is the wrong width`);
    assert.equal(actual.height, expected.height, `${file} is the wrong height`);
    assert.ok(
      actual.pixels.equals(expected.pixels),
      `${file} does not match the current mark — re-run \`npm run icons\``,
    );
  }
});

test('every pre-cached path exists', () => {
  for (const url of SHELL) {
    if (url === './') continue; // the start URL, served as index.html
    assert.ok(existsSync(resolve(url)), `sw.js pre-caches ${url}, which does not exist`);
  }
});

test('no application module is missing from the pre-cache list', async () => {
  // The drift this catches: add a module, forget sw.js, and the app boots fine
  // online and fails on the first offline launch.
  const modules = (await readdir(join(REPO_ROOT, 'src')))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `./src/${f}`);
  const missing = modules.filter((m) => !SHELL.includes(m));
  assert.deepEqual(missing, [], `add these to SHELL in sw.js: ${missing.join(', ')}`);

  const styles = (await readdir(join(REPO_ROOT, 'styles')))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `./styles/${f}`);
  const missingStyles = styles.filter((s) => !SHELL.includes(s));
  assert.deepEqual(missingStyles, [], `add these to SHELL in sw.js: ${missingStyles.join(', ')}`);
});

test('the pre-cache list covers the vendored runtime', async () => {
  const { files } = JSON.parse(await read('vendor', 'VENDOR.json'));
  const missing = Object.keys(files)
    .map((dest) => `./vendor/${dest}`)
    .filter((url) => !SHELL.includes(url));
  assert.deepEqual(missing, [], `vendored files absent from SHELL: ${missing.join(', ')}`);
});

test('the service worker never serves a navigation from cache first', () => {
  // The single most important property in the file: it is what stops a bad
  // deploy outliving one reload on a host with no Cache-Control lever.
  const navBlock = sw.match(/request\.mode === 'navigate'[\s\S]*?\n {4}return;/);
  assert.ok(navBlock, 'expected a navigation branch in the fetch handler');
  assert.match(navBlock[0], /networkFirst\(/);
  assert.doesNotMatch(navBlock[0], /staleWhileRevalidate\(/);
});

test('the service worker does not skipWaiting on install', () => {
  // Taking over mid-session swaps modules under a running app. The page asks
  // the user first and posts SKIP_WAITING only once they accept.
  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/);
  assert.ok(install, 'expected an install handler');
  // Comments stripped first — the handler explains at length why it does *not*
  // call skipWaiting, and a naive match reads that prose as the call itself.
  const code = install[0].replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /skipWaiting/);
  assert.match(sw, /'SKIP_WAITING'/, 'the message-driven update path must exist');
  assert.match(sw, /'KILL'/, 'the kill switch must exist');
});
