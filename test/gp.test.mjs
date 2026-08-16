// Tests for the GP fetch layer (gp.js): mirror-only fetching, browser-cache
// fallback, and the per-fetch timeout.
//
// The contract these assert is deliberately narrow: the Orbit Data mirror is
// the *only* origin the browser contacts for elements, and every failure mode
// degrades to the localStorage copy or to a clean error rather than to
// CelesTrak. Direct upstream fetches from the browser are what got the
// project's mirror host firewalled for breaching CelesTrak's fair-use policy,
// so "no second origin is ever tried" is the property under test, not an
// implementation detail.
//
// gp.js is browser code, so it reaches for `localStorage` and the global
// `fetch`. Both are stubbed here; nothing touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
  clear() { this.store.clear(); },
};

const { fetchDecaying, fetchGroup } = await import('../src/gp.js');

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

function okResponse({ lastModified } = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name.toLowerCase() === 'last-modified' ? lastModified ?? null : null;
      },
    },
    json: async () => ([{
      OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544, OBJECT_ID: '1998-067A',
      EPOCH: '2026-08-05T00:00:00', MEAN_MOTION: 15.5,
      ECCENTRICITY: 0.0004, INCLINATION: 51.64, RA_OF_ASC_NODE: 210.1,
      ARG_OF_PERICENTER: 85.2, MEAN_ANOMALY: 12.3, BSTAR: 0.0001,
      MEAN_MOTION_DOT: 0.0002, MEAN_MOTION_DDOT: 0,
      EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 999,
    }]),
  };
}

function okFetch(options) {
  return async () => okResponse(options);
}

test('a healthy fetch reads the Orbit Data mirror and nothing else', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return okResponse();
  };

  const result = await fetchGroup('stations');

  assert.deepEqual(calls, ['https://orbit-data.mikepreston.org/v1/gp/stations.json']);
  assert.equal(result.records.length, 1);
  assert.equal(result.source, 'orbit-data');
  assert.equal(result.fromCache, false);
});

test('a mirror error is not retried against CelesTrak', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: false, status: 503, json: async () => ({}) };
  };

  await assert.rejects(
    () => fetchGroup('stations'),
    /GP data unavailable \(orbit-data: HTTP 503\)/,
  );

  assert.deepEqual(calls, ['https://orbit-data.mikepreston.org/v1/gp/stations.json']);
});

test('a nonempty malformed mirror payload is not retried against CelesTrak', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ...okResponse(), json: async () => [{}] };
  };

  await assert.rejects(
    () => fetchGroup('geo'),
    /GP data unavailable \(orbit-data: no usable elements returned\)/,
  );

  assert.deepEqual(calls, ['https://orbit-data.mikepreston.org/v1/gp/geo.json']);
});

test('no fetch path leaves the mirror origin, for groups or the decaying set', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: false, status: 500, json: async () => ({}) };
  };

  await assert.rejects(() => fetchGroup('active'));
  await assert.rejects(() => fetchDecaying());

  assert.equal(calls.length, 2, 'one attempt per call, no failover');
  for (const url of calls) {
    assert.ok(
      url.startsWith('https://orbit-data.mikepreston.org/'),
      `requested ${url}, which is not the mirror`,
    );
  }
});

test('the decaying watch list uses the special-decaying mirror artifact', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return okResponse();
  };

  const result = await fetchDecaying();

  assert.deepEqual(calls, [
    'https://orbit-data.mikepreston.org/v1/gp/special-decaying.json',
  ]);
  assert.equal(result.source, 'orbit-data');
  assert.equal(result.records[0].layerId, 'reentry');
});

test('Last-Modified records mirrored data age and flags old elements', async () => {
  globalThis.localStorage.clear();
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  globalThis.fetch = okFetch({ lastModified: old.toUTCString() });

  const result = await fetchGroup('stations');

  assert.equal(result.fetchedAt, old.setMilliseconds(0));
  assert.equal(result.stale, true);
});

test('a future Last-Modified value is clamped to local receipt time', async () => {
  globalThis.localStorage.clear();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  globalThis.fetch = okFetch({ lastModified: future.toUTCString() });
  const before = Date.now();

  const result = await fetchGroup('stations');
  const after = Date.now();

  assert.ok(result.fetchedAt >= before);
  assert.ok(result.fetchedAt <= after);
});

test('a stalled fetch aborts within the timeout instead of hanging (no cache)', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = hangingFetch();

  const started = Date.now();
  await assert.rejects(
    () => fetchGroup('starlink', { timeoutMs: 30 }),
    /^Error: GP data unavailable \(orbit-data: aborted\)$/,
  );
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang');
});

test('a stalled response body (headers in, body hanging) also times out', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = bodyStallFetch();

  const started = Date.now();
  await assert.rejects(
    () => fetchGroup('gnss', { timeoutMs: 30 }),
    /^Error: GP data unavailable \(orbit-data: aborted\)$/,
  );
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang on the body');
});

test('a mirror failure falls back to stale browser data', async () => {
  globalThis.localStorage.clear();

  globalThis.fetch = okFetch();
  const first = await fetchGroup('active', { timeoutMs: 1000 });
  assert.equal(first.records.length, 1);
  assert.equal(first.fromCache, false);

  globalThis.fetch = hangingFetch();
  const second = await fetchGroup('active', { force: true, timeoutMs: 30 });

  assert.equal(second.records.length, 1, 'served the cached record');
  assert.equal(second.fromCache, true);
  assert.equal(second.source, 'browser-cache');
  assert.equal(second.stale, true, 'marked stale so the UI can flag it');
});
