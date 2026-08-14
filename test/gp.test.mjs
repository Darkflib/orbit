// Tests for the GP fetch layer (gp.js): mirror-first fetching, CelesTrak
// failover, browser-cache fallback, and the per-fetch timeout.
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

test('the Orbit Data mirror is used without contacting CelesTrak when healthy', async () => {
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

test('CelesTrak is used only after the mirror fails', async () => {
  globalThis.localStorage.clear();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === 'https://orbit-data.mikepreston.org/v1/gp/stations.json') {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return okResponse();
  };

  const result = await fetchGroup('stations');

  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'https://orbit-data.mikepreston.org/v1/gp/stations.json');
  assert.match(calls[1], /^https:\/\/celestrak\.org\//);
  assert.equal(result.source, 'celestrak');
});

test('a nonempty malformed mirror payload also falls back to CelesTrak', async () => {
  globalThis.localStorage.clear();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ...okResponse(), json: async () => [{}] };
    return okResponse();
  };

  const result = await fetchGroup('geo');

  assert.equal(calls, 2);
  assert.equal(result.source, 'celestrak');
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
    /orbit-data: aborted.*celestrak: aborted/i,
  );
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang');
});

test('a stalled response body (headers in, body hanging) also times out', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = bodyStallFetch();

  const started = Date.now();
  await assert.rejects(
    () => fetchGroup('gnss', { timeoutMs: 30 }),
    /orbit-data: aborted.*celestrak: aborted/i,
  );
  assert.ok(Date.now() - started < 2000, 'should reject promptly, not hang on the body');
});

test('both remote failures fall back to stale browser data', async () => {
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

// Offline behaviour. Measured before this short-circuit existed: an installed
// app launched with no signal spent 21.6 seconds on "Fetching orbital
// elements…" — two doomed fetches timing out in series — before falling back to
// exactly the cache it could have read immediately.
// `globalThis.navigator` is a getter-only accessor from Node 21 on, so a plain
// assignment throws. Swap the descriptor and put the original back afterwards.
async function asOffline(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false },
    configurable: true,
  });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

test('offline, cached elements are served without attempting the network', async () => {
  globalThis.localStorage.clear();

  globalThis.fetch = okFetch();
  await fetchGroup('active', { timeoutMs: 1000 });

  let attempted = false;
  globalThis.fetch = () => { attempted = true; return hangingFetch()(); };
  await asOffline(async () => {
    const offline = await fetchGroup('active', { force: true, timeoutMs: 30 });
    assert.equal(attempted, false, 'must not wait on a fetch that cannot succeed');
    assert.equal(offline.records.length, 1);
    assert.equal(offline.source, 'browser-cache');
    assert.equal(offline.stale, true);
  });
});

test('offline with nothing cached fails fast and says why', async () => {
  globalThis.localStorage.clear();
  globalThis.fetch = hangingFetch();

  await asOffline(async () => {
    await assert.rejects(
      fetchGroup('active', { timeoutMs: 30 }),
      // The message reaches the user through the boot toast, so it has to read
      // as a state of the world rather than as a fetch failure.
      /offline, and no orbital elements have been cached yet/,
    );
  });
});
