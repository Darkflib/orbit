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

// The whole policy, asserted as an allow-list rather than by pattern.
//
// An earlier version of this test only rejected sources matching
// `startsWith('http')`, which is a weaker check than it looks: CSP host-sources
// need no scheme at all (`cdn.example.com` is valid and would have passed),
// schemes match case-insensitively, and `//evil.example` is a valid source too.
// Enumerating what is permitted has no such gaps — anything new has to be added
// here deliberately, which is the review moment worth having.
const EXPECTED = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'worker-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'style-src': ["'self'"],
  'font-src': ["'self'"],
  'manifest-src': ["'self'"],
  'connect-src': ["'self'", 'https://orbit-data.mikepreston.org'],
};

test('every directive allows exactly what it is meant to and nothing more', () => {
  for (const [directive, allowed] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      directives[directive],
      allowed,
      `${directive} has drifted from its allow-list`,
    );
  }
});

test('script-src permits only this origin and the import-map hash', () => {
  // Handled separately because the hash changes whenever the import map does,
  // so it cannot be a literal in the table above.
  const sources = directives['script-src'] ?? [];
  const hashes = sources.filter((s) => /^'sha(256|384|512)-/.test(s));
  assert.equal(hashes.length, 1, 'expected exactly one inline-script hash');
  assert.deepEqual(
    sources.filter((s) => !hashes.includes(s)),
    ["'self'"],
    'script-src must be this origin plus the import-map hash, nothing else',
  );
});

// The CSP is the backstop for the fair-use decision recorded above
// ORBIT_DATA_ORIGIN in src/constants.js: browsers must never fetch elements
// from CelesTrak directly, because an uncoordinated fleet of tabs failing over
// to them is what got the project's mirror host firewalled. Code can regress;
// with the origin absent from connect-src, a reintroduced fetch is blocked by
// the browser rather than shipped.
// Matched on the parsed host rather than by searching the source text for
// 'celestrak.org'. A substring test answers the wrong question — it is true of
// `https://celestrak.org.example.com`, which is somebody else's host entirely,
// and false of nothing we care about. Parsing also means the wildcard form
// `*.celestrak.org` is caught by the suffix check below rather than by luck.
function hostOf(source) {
  // Keywords ('self', 'none'), hashes and nonces are quoted; scheme sources
  // like `data:` carry no host. None of them can name an origin.
  if (source.startsWith("'") || /^[a-z][a-z0-9+.-]*:$/i.test(source)) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `https://${source}`;
  try {
    return new URL(absolute).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// A guard that silently stops guarding is worse than no guard. `hostOf`
// returning null for everything would make the test below pass against a CSP
// that allowed CelesTrak outright, so pin the forms it has to recognise —
// and the near-miss host it must not confuse for one.
test('the celestrak.org host check recognises the forms it has to catch', () => {
  assert.equal(hostOf('https://celestrak.org'), 'celestrak.org');
  assert.equal(hostOf('celestrak.org'), 'celestrak.org');
  assert.equal(hostOf('https://CelesTrak.org'), 'celestrak.org');
  assert.equal(hostOf('*.celestrak.org'), '*.celestrak.org');
  assert.equal(hostOf('https://celestrak.org.example.com'), 'celestrak.org.example.com');
  assert.equal(hostOf("'self'"), null);
  assert.equal(hostOf('data:'), null);
  assert.equal(hostOf('https://orbit-data.mikepreston.org'), 'orbit-data.mikepreston.org');
});

test('no directive permits fetching from celestrak.org', () => {
  for (const [name, sources] of Object.entries(directives)) {
    const offending = sources.filter((source) => {
      const host = hostOf(source);
      return host === 'celestrak.org' || (host !== null && host.endsWith('.celestrak.org'));
    });
    assert.deepEqual(
      offending,
      [],
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

test('the policy names no directive we have not accounted for', () => {
  // A directive added without a matching expectation would otherwise sit here
  // completely unchecked.
  const known = new Set([...Object.keys(EXPECTED), 'script-src']);
  const unexpected = Object.keys(directives).filter((d) => !known.has(d));
  assert.deepEqual(unexpected, [], 'add these to the CSP test: ' + unexpected.join(', '));
});
