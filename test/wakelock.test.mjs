// Tests for the screen wake lock (wakelock.js).
//
// Everything worth testing here is a race, and every one of them needs the
// request to be *pending* across a state change — so the fake below hands back
// a promise the test resolves by hand, rather than resolving immediately. A
// version of these tests that awaited a resolved promise would pass against
// every bug they exist to catch.
//
// wakelock.js is browser code: it reaches for `navigator.wakeLock`, and for
// `document.visibilityState` and `document.addEventListener`. All three are
// stubbed. `navigator` is a getter-only accessor on globalThis from Node 21 on,
// so it is swapped with defineProperty and restored afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeSentinel {
  constructor() {
    this.released = 0;
    this.listeners = [];
  }

  addEventListener(type, fn) {
    if (type === 'release') this.listeners.push(fn);
  }

  async release() {
    this.released += 1;
    this.listeners.splice(0).forEach((fn) => fn());
  }
}

// A wakeLock whose requests stay pending until the test resolves them, which is
// the only way to get a state change to land *inside* an in-flight request.
function deferredWakeLock() {
  const pendingRequests = [];
  return {
    requests: pendingRequests,
    wakeLock: {
      request: () => new Promise((resolve) => { pendingRequests.push(resolve); }),
    },
    /** Resolve the nth outstanding request with a fresh sentinel. */
    settle(index = 0) {
      const sentinel = new FakeSentinel();
      pendingRequests[index](sentinel);
      return sentinel;
    },
  };
}

// Lets the microtask queue drain so the awaits inside acquire() run.
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

async function withStubs(fn, { visibility = 'visible' } = {}) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const lock = deferredWakeLock();
  const listeners = {};

  Object.defineProperty(globalThis, 'navigator', {
    value: { wakeLock: lock.wakeLock },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: {
      visibilityState: visibility,
      addEventListener(type, handler) { listeners[type] = handler; },
    },
    configurable: true,
  });

  // Imported fresh each time: createWakeLock closes over module-free state, but
  // the stubs have to exist before `'wakeLock' in navigator` is evaluated.
  const { createWakeLock } = await import(`../src/wakelock.js?t=${Math.random()}`);

  try {
    await fn({ lock, listeners, wakeLock: createWakeLock() });
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
}

test('a lock resolving after disable() is released, not stored', async () => {
  await withStubs(async ({ lock, wakeLock }) => {
    wakeLock.enable();
    await tick();
    assert.equal(lock.requests.length, 1, 'enable should have asked for a lock');

    // The user pauses while the request is still in flight.
    wakeLock.disable();
    const sentinel = lock.settle();
    await tick();

    assert.equal(sentinel.released, 1, 'the stale lock must be handed straight back');
    assert.equal(wakeLock.active, false, 'and never stored');
  });
});

test('pausing and immediately resuming still ends up holding a lock', async () => {
  // The regression this file exists for. disable() bumps the generation, the
  // enable() right behind it finds a request already pending and returns, and
  // the in-flight request then releases into a world that wants a lock. Without
  // a retry the screen sleeps mid-playback with nothing left to ask again.
  await withStubs(async ({ lock, wakeLock }) => {
    wakeLock.enable();
    await tick();

    wakeLock.disable();
    wakeLock.enable();          // pause then play, faster than the request
    lock.settle();              // the original request finally lands
    await tick();

    assert.equal(lock.requests.length, 2, 'the superseded request should be retried');
    lock.settle(1);
    await tick();

    assert.equal(wakeLock.active, true, 'the screen should be held awake again');
  });
});

test('a lock the OS drops is forgotten so the next attempt re-acquires', async () => {
  await withStubs(async ({ lock, wakeLock }) => {
    wakeLock.enable();
    await tick();
    const sentinel = lock.settle();
    await tick();
    assert.equal(wakeLock.active, true);

    // Battery saver, an incoming call: the OS releases it out from under us.
    await sentinel.release();
    assert.equal(wakeLock.active, false, 'the handle must not outlive the lock');
  });
});

test('a stale release cannot blank a newer lock', async () => {
  await withStubs(async ({ lock, wakeLock }) => {
    wakeLock.enable();
    await tick();
    const first = lock.settle();
    await tick();

    // Background and foreground: the first lock is dropped, a second requested.
    wakeLock.disable();
    await tick();
    wakeLock.enable();
    await tick();
    lock.settle(lock.requests.length - 1);
    await tick();
    assert.equal(wakeLock.active, true);

    // A late release event from the *first* sentinel must not clear the second.
    await first.release();
    assert.equal(wakeLock.active, true, 'the current lock survives a stale release');
  });
});

test('nothing is requested while the page is hidden', async () => {
  await withStubs(async ({ lock, wakeLock }) => {
    wakeLock.enable();
    await tick();
    assert.equal(lock.requests.length, 0, 'a hidden page cannot hold a wake lock');
  }, { visibility: 'hidden' });
});
