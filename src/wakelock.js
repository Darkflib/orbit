// ---------------------------------------------------------------------------
// Screen wake lock.
//
// Orbit is a thing you watch rather than a thing you type into, so the OS idle
// timer fires while the app is doing exactly what it is meant to. On a phone
// that is worst in Sky mode: you hold the handset up to find a satellite, look
// away to check the sky itself, and by the time you look back the screen is
// off. Nothing about the app is broken and it feels broken.
//
// Two things make this fiddlier than one API call. A lock is released
// automatically whenever the page is hidden, so it has to be reacquired on
// visibilitychange rather than taken once at boot. And the request rejects
// outright without a recent user gesture on some engines, so failures are
// routine and must stay silent — this is a comfort feature, not a
// prerequisite, and it should never surface an error.
// ---------------------------------------------------------------------------

export function createWakeLock() {
  const supported = 'wakeLock' in navigator;
  let sentinel = null;
  // Whether the app *wants* the screen awake. Tracked separately from whether
  // it currently holds a lock, because the two diverge every time the page is
  // backgrounded and the OS drops the lock underneath us.
  let wanted = false;

  async function acquire() {
    if (!supported || !wanted || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      // The OS can drop the lock for reasons of its own (battery saver, a call
      // coming in). Clearing the handle means the next visibilitychange tries
      // again rather than believing it still holds one.
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // No gesture yet, policy refusal, or unsupported in this context.
      sentinel = null;
    }
  }

  async function drop() {
    const held = sentinel;
    sentinel = null;
    try {
      await held?.release();
    } catch {
      // Already released — the OS got there first.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
    else drop();
  });

  // Engines that gate the request behind a user gesture reject the one made at
  // boot. Retrying on the first interaction costs nothing and converts those
  // into a held lock; once one is held this stops firing.
  document.addEventListener('pointerdown', () => {
    if (wanted && !sentinel) acquire();
  }, { passive: true });

  return {
    supported,
    /** Ask for the screen to stay awake, and keep asking across backgrounding. */
    enable() {
      wanted = true;
      acquire();
    },
    /** Stop wanting it, and release any lock currently held. */
    disable() {
      wanted = false;
      drop();
    },
    get active() {
      return sentinel !== null;
    },
  };
}
