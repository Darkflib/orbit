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
const mainJs = await readFile(join(here, '..', 'src', 'main.js'), 'utf8');
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
  assert.deepEqual(
    directives['connect-src'],
    [
      "'self'",
      'https://cdn.jsdelivr.net',
      'https://orbit-data.mikepreston.org',
    ],
    'connect-src must allow the data mirror and jsDelivr source maps',
  );
});

// The CSP is the backstop for the fair-use decision recorded above
// ORBIT_DATA_ORIGIN in src/constants.js: browsers must never fetch elements
// from CelesTrak directly, because an uncoordinated fleet of tabs failing over
// to them is what got the project's mirror host firewalled. Code can regress;
// with the origin absent from connect-src, a reintroduced fetch is blocked by
// the browser rather than shipped.
test('no directive permits fetching from celestrak.org', () => {
  for (const [name, sources] of Object.entries(directives)) {
    assert.ok(
      !sources.some((source) => source.includes('celestrak.org')),
      `${name} must not allow celestrak.org — the browser fetches GP data only ` +
        'from the Orbit Data mirror',
    );
  }
});

// …but the info panel's "CelesTrak" link must keep working. A link click is a
// navigation, which connect-src (and default-src) do not govern, so removing
// the origin above cannot break it. The one directive that *would* is
// `navigate-to`, so assert it stays absent.
test('the satcat link is a navigation the CSP does not restrict', () => {
  assert.ok(
    /<a id="link-celestrak"/.test(html),
    'the info panel should still link to CelesTrak for the selected object',
  );
  assert.match(
    mainJs,
    /link-celestrak'\)\.href = `https:\/\/celestrak\.org\/satcat\/records\.php/,
    'the link href is an <a> href built in main.js — a navigation, not a fetch',
  );
  assert.equal(
    directives['navigate-to'],
    undefined,
    'a navigate-to directive would start policing link targets',
  );
});
