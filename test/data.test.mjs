import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchDataJson } from '../src/data.js';

const BASE_URI = 'https://app.example/orbit/';

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test('catalogue data comes from Orbit Data when the mirror is healthy', async () => {
  const calls = [];
  const data = { generatedAt: '2026-08-10T10:00:00Z' };
  const result = await fetchDataJson('manifest.json', {
    baseURI: BASE_URI,
    fetchImpl: async (url) => {
      calls.push(url);
      return response(data);
    },
  });

  assert.deepEqual(result, data);
  assert.deepEqual(calls, ['https://orbit-data.mikepreston.org/v1/data/manifest.json']);
});

test('catalogue data falls back to the bundled project-subpath snapshot', async () => {
  const calls = [];
  const bundled = [{ norad: '25544' }];
  const result = await fetchDataJson('catalog-index.json', {
    baseURI: BASE_URI,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('orbit-data.mikepreston.org')) {
        return response({}, { ok: false, status: 503 });
      }
      return response(bundled);
    },
  });

  assert.deepEqual(result, bundled);
  assert.deepEqual(calls, [
    'https://orbit-data.mikepreston.org/v1/data/catalog-index.json',
    'https://app.example/orbit/data/catalog-index.json',
  ]);
});

test('a stalled mirror times out before loading the bundled snapshot', async () => {
  const calls = [];
  const result = await fetchDataJson('manifest.json', {
    baseURI: BASE_URI,
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => {
      calls.push(url);
      if (!url.includes('orbit-data.mikepreston.org')) {
        return Promise.resolve(response({ bundled: true }));
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });

  assert.deepEqual(result, { bundled: true });
  assert.equal(calls.length, 2);
});

test('catalogue errors report both the mirror and bundled fallback', async () => {
  await assert.rejects(
    () => fetchDataJson('sky/stars.json', {
      baseURI: BASE_URI,
      fetchImpl: async () => response({}, { ok: false, status: 404 }),
    }),
    /orbit-data\.mikepreston\.org.*app\.example\/orbit\/data/s,
  );
});
