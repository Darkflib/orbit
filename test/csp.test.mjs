// Guards the Content-Security-Policy against drift. The inline import map in
// index.html is allow-listed in the CSP by a sha256 hash; if the import map is
// edited without recomputing that hash, the entry module silently fails to load
// in browsers that enforce the policy. This test recomputes the digest from the
// actual <script type="importmap"> text and asserts it matches the CSP value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, '..', 'index.html'), 'utf8');
const cspMatch = html.match(
  /http-equiv="Content-Security-Policy"[\s\S]*?content="([\s\S]*?)"/,
);
assert.ok(cspMatch, 'index.html should contain a CSP meta tag');

const directives = Object.fromEntries(
  cspMatch[1]
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
    .map(([name, ...sources]) => [name, sources]),
);

test('the CSP sha256 allow-list matches the inline import map', () => {
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(map, 'index.html should contain an <script type="importmap"> block');
  const digest = createHash('sha256').update(map[1], 'utf8').digest('base64');
  const expected = `sha256-${digest}`;

  assert.ok(
    cspMatch[1].includes(`'${expected}'`),
    `CSP script-src must allow-list the import map hash ${expected}. ` +
      `If you edited the import map, update the CSP hash to match.`,
  );
});

test('the CSP permits the CDN-backed module worker and its source maps', () => {
  assert.deepEqual(
    directives['worker-src'],
    ["'self'", 'https://cdn.jsdelivr.net'],
    'worker-src must allow the satellite.js import used by the module worker',
  );
  assert.ok(
    directives['connect-src'].includes('https://cdn.jsdelivr.net'),
    'connect-src must allow developer tools to fetch jsDelivr source maps',
  );
});
