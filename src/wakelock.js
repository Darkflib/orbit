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

  // Bumped by every drop(). A request that was already in flight when the state
  // changed compares the generation it started in against this and, if it has
  // moved, releases what it was handed instead of storing it.
  //
  // The race is real and easy to hit on a phone: tapping pause (or backgrounding
  // the app) while `navigator.wakeLock.request` is still pending resolves it
  // *after* drop() has run, so the lock gets stored when nothing wants it and
  // the screen then stays awake indefinitely — with `disable()` already called,
  // nothing is left to release it.
  let generation = 0;
  let pending = false;

  async function acquire() {
    if (!supported || !wanted || sentinel || pending) return;
    if (document.visibilityState !== 'visible') return;
    const mine = generation;
    pending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (mine !== generation || !wanted || document.visibilityState !== 'visible') {
        // The world moved while we were waiting. Hand it straight back.
        await lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      // The OS can drop the lock for reasons of its own (battery saver, a call
      // coming in). Clearing the handle means the next visibilitychange tries
      // again rather than believing it still holds one — but only if this is
      // still the current lock, so a stale release cannot blank a newer one.
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
    } catch {
      // No gesture yet, policy refusal, or unsupported in this context.
    } finally {
      pending = false;
      // A request that went stale has just handed its lock back, and the state
      // that superseded it may itself want one. Tapping pause and immediately
      // play does exactly this: disable() bumps the generation, the enable()
      // right behind it finds `pending` still true and returns, and without
      // this retry the in-flight request releases into a world that wants a
      // lock and nothing is left to ask for one — the screen sleeps mid-play.
      //
      // It cannot spin: the retry only fires when the generation moved *during*
      // the request, which takes a drop(), which takes a pause or a
      // backgrounding. Each retry re-reads the generation as its own baseline.
      if (mine !== generation && wanted && !sentinel
          && document.visibilityState === 'visible') {
        acquire();
      }
    }
  }

  async function drop() {
    generation++;
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
