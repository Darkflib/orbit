// Tests for the GP fetch layer (gp.js), specifically the per-fetch timeout.
//
// The behaviour under test: a stalled CelesTrak request must not hang forever.
// It is aborted after the timeout, and the caller then either falls back to a
// stale cache (when one exists) or surfaces the failure — never blocks.
//
// gp.js is browser code, so it reaches for `localStorage` and the global
// `fetch`. Both are stubbed here; nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory localStorage so readCache/writeCache actually round-trip
// (in Node they otherwise hit `undefined` and silently no-op).
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
  clear() { this.store.clear(); },
};

const { fetchGroup } = await import('../src/gp.js');

// A fetch that never resolves on its own — it only settles when its
// AbortSignal fires. This is exactly the stall the timeout exists to break.
function hangingFetch() {
  return (url, { signal } = {}) => new Promise((_resolve, reject) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
}

// A fetch whose headers arrive (the promise resolves) but whose body never
// settles — res.json() only rejects when the abort signal fires. This is the
// header-in / body-stalled case: fetch() has already resolved, so a timeout
// that only guarded the headers would miss it.
function bodyStallFetch() {
  return async (url, { signal } = {}) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    }),
  });
}

// A fetch that returns a valid one-record OMM payload.
function okFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ([{
      OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, OBJECT_ID: '1998-067A',
      EPOCH: '2026-08-05T00:00:00', MEAN_MOTION: 15.5,
    }]),
  });
}

test('a stalled fetch aborts within the timeout instead of hanging (no cache)', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = hangingFetch();

  const started = Date.now();
  // No cache to fall back on, so the aborted fetch propagates as a rejection.
  await assert.rejects(
    () => fetchGroup('starlink', { timeoutMs: 30 }),
    (err) => err.name === 'AbortError' || /abort/i.test(err.message),
  );
  // It resolved via the timeout, not by waiting on the network.
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang');
});

test('a stalled response body (headers in, body hanging) also times out', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = bodyStallFetch();

  const started = Date.now();
  // The timeout must span res.json(), not just the headers — otherwise this
  // hangs forever. No cache, so it rejects.
  await assert.rejects(
    () => fetchGroup('gnss', { timeoutMs: 30 }),
    (err) => err.name === 'AbortError' || /abort/i.test(err.message),
  );
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang on the body');
});

test('a stalled fetch falls back to a stale cache when one exists', async () => {
  globalThis.localStorage.clear();

  // Seed the cache with a good fetch...
  globalThis.fetch = okFetch();
  const first = await fetchGroup('active', { timeoutMs: 1000 });
  assert.equal(first.records.length, 1);
  assert.equal(first.fromCache, false);

  // ...then force a refetch against a stalled network.
  globalThis.fetch = hangingFetch();
  const second = await fetchGroup('active', { force: true, timeoutMs: 30 });

  assert.equal(second.records.length, 1, 'served the cached record');
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, true, 'marked stale so the UI can flag it');
});
