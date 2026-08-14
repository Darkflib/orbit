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
  'connect-src': ["'self'", 'https://orbit-data.mikepreston.org', 'https://celestrak.org'],
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

test('the policy names no directive we have not accounted for', () => {
  // A directive added without a matching expectation would otherwise sit here
  // completely unchecked.
  const known = new Set([...Object.keys(EXPECTED), 'script-src']);
  const unexpected = Object.keys(directives).filter((d) => !known.has(d));
  assert.deepEqual(unexpected, [], 'add these to the CSP test: ' + unexpected.join(', '));
});
