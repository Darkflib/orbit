// Tests for the hardened development server (serve.mjs).
//
// Covers the two security-relevant behaviours:
//   - path containment: a sibling directory sharing the root's name prefix
//     (…/orbit-secret) must not be reachable via traversal;
//   - dotfile / VCS-metadata refusal: /.git/config and friends return 403.
// Plus the happy path (index served) and unknown paths (404).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createOrbitServer } from '../serve.mjs';

// Issue a request WITHOUT client-side URL normalisation, so literal `..` and
// dot segments reach the server exactly as written (a browser/fetch would
// collapse them before they ever left).
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(root, fn) {
  const server = createOrbitServer(root);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('serves files under the root and 404s the unknown', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orbit-'));
  const root = join(base, 'orbit');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html>hi');
  try {
    await withServer(root, async (port) => {
      const home = await rawGet(port, '/');
      assert.equal(home.status, 200);
      assert.equal(home.body, '<!doctype html>hi');

      const missing = await rawGet(port, '/nope.txt');
      assert.equal(missing.status, 404);
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('refuses dotfiles and VCS metadata (.git/config)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orbit-'));
  const root = join(base, 'orbit');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), 'SECRET');
  try {
    await withServer(root, async (port) => {
      const res = await rawGet(port, '/.git/config');
      assert.equal(res.status, 403);
      assert.notEqual(res.body, 'SECRET');
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a sibling dir sharing the name prefix is not reachable by traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orbit-'));
  const root = join(base, 'orbit');
  const sibling = join(base, 'orbit-secret');
  await mkdir(root, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, 'secret.txt'), 'SECRET');
  try {
    await withServer(root, async (port) => {
      // Resolves to <base>/orbit-secret/secret.txt — a startsWith(root) check
      // would leak it; the root+separator check must reject with 403.
      const res = await rawGet(port, '/../orbit-secret/secret.txt');
      assert.equal(res.status, 403);
      assert.notEqual(res.body, 'SECRET');
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
