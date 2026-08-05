// ---------------------------------------------------------------------------
// Visible-pass prediction (Tier 4).
//
// Walk SGP4 forward from a start time and find upcoming passes for the selected
// satellite over the observer: windows where it climbs above a minimum
// elevation, is sunlit, the observer's sky is dark, and it is (or could
// plausibly be) bright enough to see with the naked eye.
//
// One satellite over ~24 h at a 30 s step is a few thousand SGP4 evaluations —
// cheap enough to run synchronously on selection. Below the horizon (most of
// the time) only a lightweight elevation probe runs; the full visibility
// computation only kicks in once the object is actually up.
//
// Accuracy note: the scan samples on a fixed grid, but the reported window edges
// and culmination are then refined off it (bisection on window membership, a
// golden-section search for the peak) so they no longer carry the step's
// quantisation — the edges land ~sub-second and the peak well under 0.1° at the
// default 30 s.
// See docs/pass-validation-2026-08-04.md for the underlying validation: the
// propagation and geometry reproduce an independent implementation to metres and
// thousandths of a degree, so the refined events are as good as the physics.
// ---------------------------------------------------------------------------
import * as satellite from 'satellite.js';
import { DEG2RAD, RAD2DEG } from './constants.js';
import { sunDirectionEci } from './ephemeris.js';
import { computeVisibility } from './visibility.js';

// Intrinsic magnitude assumed for an object that has none on record, used only
// to *reject* implausible sightings — never to report a brightness.
//
// It is deliberately optimistic: mag 2.0 at 1000 km is around the bright end of
// the mmccants catalogue (a large spent rocket body; only a handful of objects,
// the ISS among them, beat it). So the test it powers is a bound rather than a
// guess — "even if this unknown object were as bright as almost anything in
// orbit, it would still be fainter than the naked-eye cutoff from here". With a
// 6.5 cutoff that bound only bites beyond ~7900 km slant range, which leaves
// every LEO pass eligible (the old, defensible behaviour) while suppressing the
// MEO/GEO fleet, where 94–98% of objects carry no magnitude at all and none is
// remotely naked-eye. The alternative — a pessimistic assumed magnitude — would
// silently drop real LEO sightings on missing data, which is the worse failure.
export const UNKNOWN_STD_MAG = 2.0;

// Predict visible passes.
//   satrec   : SGP4 record
//   observer : { lat, lon, altKm }
//   fromMs   : start epoch (ms) — use real Date.now() for "tonight"
//   stdMag   : intrinsic magnitude or null
// Options: hours, stepSec, minElevationDeg, maxMag (naked-eye cutoff),
//          maxPasses, unknownStdMag, alwaysUpMinHours.
// Returns { passes, total, geomVisible, unknownBrightness, alwaysUp, standing }:
//   passes            — visible & bright-enough passes (up to maxPasses). Each
//                       carries startClipped/endClipped when the window ran into
//                       a scan boundary rather than a real rise/set.
//   total             — count of above-horizon passes scanned
//   geomVisible       — count of passes that were sunlit + dark sky (pre-magnitude)
//   unknownBrightness — true when at least one sunlit, dark-sky sample was
//                       dropped only because the object has no magnitude and is
//                       too distant for the bound above to clear the cutoff.
//                       Read it when `passes` is empty: that is the case where
//                       the UI must not claim a magnitude it never had.
//   alwaysUp          — true when the object never left the elevation gate for
//                       the whole scan (GEO, and some MEO/HEO): it has no passes
//   standing          — summary for an alwaysUp object, else null
export function predictPasses(satrec, observer, fromMs, stdMag, {
  hours = 24, stepSec = 30, minElevationDeg = 10, maxMag = 6.5, maxPasses = 4,
  unknownStdMag = UNKNOWN_STD_MAG, alwaysUpMinHours = 12,
} = {}) {
  const observerGd = {
    longitude: observer.lon * DEG2RAD,
    latitude: observer.lat * DEG2RAD,
    height: observer.altKm || 0,
  };
  const stepMs = stepSec * 1000;
  const endMs = fromMs + hours * 3600e3;
  // The last instant the loop will actually sample. Used to tell "the window
  // ended because the satellite set" from "the window ended because we stopped
  // looking" — only the first is a real LOS.
  const lastGridMs = fromMs + Math.floor((endMs - fromMs) / stepMs) * stepMs;

  // --- Sub-step refinement --------------------------------------------------
  // The scan samples on a fixed grid, so a window edge lands within one step of
  // the true transition and the reported culmination can read up to ~9° low on a
  // fast near-zenith pass (a 550 km object sweeps ~0.8°/s through the zenith, so
  // a 30 s grid can miss the peak by 15 s where the elevation curve is sharpest).
  // Both are recovered here with a handful of extra SGP4 evaluations per emitted
  // pass — bisection on the window-membership predicate for the edges, a
  // golden-section search for the peak — which collapses the edges to ~sub-second
  // and the peak to well under 0.1°. Only emitted passes (≤ maxPasses) are
  // refined, so the cost stays bounded.
  const REFINE_TOL_MS = 200;   // stop once the bracket is this tight
  const REFINE_MAX_ITERS = 24; // hard cap (one 30 s step -> well under the tol)
  const GOLDEN = (Math.sqrt(5) - 1) / 2;

  // Elevation (deg) at an arbitrary instant — the cheap probe, no sun/shadow.
  const elevationAt = (t) => {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(satrec, date); } catch { return null; }
    if (!pv || !pv.position) return null;
    const satEcf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    return satellite.ecfToLookAngles(observerGd, satEcf).elevation * RAD2DEG;
  };

  // Full visibility at an arbitrary instant — used to read off the look angles
  // (and magnitude) at a refined culmination time, and to test window membership.
  const visibilityAt = (t) => {
    const date = new Date(t);
    let pv;
    try { pv = satellite.propagate(satrec, date); } catch { return null; }
    if (!pv || !pv.position) return null;
    return computeVisibility(pv.position, satellite.gstime(date), observer, sunDirectionEci(date), stdMag);
  };

  // Is `t` inside a visible window? The same conjunction the scan uses to build a
  // run — above the gate, sunlit, dark sky, bright enough — so bisecting it finds
  // whichever transition actually bounds the window: the 10° gate on a pass that
  // rises and sets in darkness, or the shadow / twilight / brightness edge on one
  // that doesn't. Pure (no unknownBrightness side effect): refinement only
  // locates the boundary of a window the scan already decided to emit.
  const inWindow = (t) => {
    const v = visibilityAt(t);
    if (!v) return null;
    return v.elevation >= minElevationDeg && v.state === 'visible' && isBright(v);
  };

  // Bisect a window edge between a grid instant outside the window and one inside
  // it. Returns a time on the inside of the transition, so the reported edge
  // never claims visibility the object doesn't yet (or no longer) has. Null if a
  // probe failed to propagate, so the caller keeps the grid value.
  const refineEdge = (tOut, tIn) => {
    let out = tOut;
    let ins = tIn;
    for (let i = 0; i < REFINE_MAX_ITERS && Math.abs(ins - out) > REFINE_TOL_MS; i++) {
      const mid = (out + ins) / 2;
      const m = inWindow(mid);
      if (m == null) return null;
      if (m) ins = mid; else out = mid;
    }
    return ins;
  };

  // Golden-section search for the elevation maximum in [tA, tB]. The elevation
  // curve near the zenith is far too sharp to read off a parabola through 30 s
  // samples (it leaves ~1-2° on an overhead pass), so the peak is found by direct
  // maximisation instead. Returns the peak time, or null on a propagation failure.
  const goldenPeakTime = (tA, tB) => {
    let a = tA;
    let b = tB;
    let c = b - GOLDEN * (b - a);
    let d = a + GOLDEN * (b - a);
    let fc = elevationAt(c);
    let fd = elevationAt(d);
    if (fc == null || fd == null) return null;
    for (let i = 0; i < REFINE_MAX_ITERS && b - a > REFINE_TOL_MS; i++) {
      if (fc > fd) {
        b = d; d = c; fd = fc;
        c = b - GOLDEN * (b - a);
        fc = elevationAt(c);
        if (fc == null) return null;
      } else {
        a = c; c = d; fc = fd;
        d = a + GOLDEN * (b - a);
        fd = elevationAt(d);
        if (fd == null) return null;
      }
    }
    return (a + b) / 2;
  };

  const passes = [];
  let total = 0;
  let geomVisible = 0;
  let unknownBrightness = false;
  let inPass = false;
  let samples = [];
  // True once the object has been seen below the gate (or SGP4 has failed on it)
  // at any point during the scan — i.e. the run that is open at the end did not
  // start at the very first sample. Only a run spanning the entire scan counts
  // as "always up"; an object that rises mid-scan and is still up at the end is
  // a genuine (if clipped) pass.
  let everDown = false;

  // Pure brightness test for one sample: a measured magnitude is a straight
  // comparison; without one we fall back to the optimistic bound (see
  // UNKNOWN_STD_MAG). No side effects, so the refinement helpers can reuse it.
  const isBright = (v) => (
    v.apparentMag != null
      ? v.apparentMag <= maxMag
      : unknownStdMag + v.magOffset <= maxMag
  );

  // The scan's brightness gate wraps isBright and additionally remembers when an
  // unknown-magnitude sample was dropped only because it failed the bound, so the
  // UI can say "brightness unknown" rather than quoting a cutoff it never actually
  // tested the object against.
  const brightEnough = (v) => {
    const ok = isBright(v);
    if (!ok && v.apparentMag == null) unknownBrightness = true;
    return ok;
  };

  const finalize = () => {
    if (samples.length) {
      total++;
      if (samples.some((s) => s.v.state === 'visible')) geomVisible++;

      // A single geometric pass can hold several separate visible windows (it can
      // dip into Earth's shadow and re-emerge). Emit one record per *contiguous*
      // run of samples that are both visible and naked-eye bright, and derive the
      // window's peak/brightness from that run only — never from shadowed or
      // too-faint samples on either side.
      const shows = (s) => s.v.state === 'visible' && brightEnough(s.v);
      let run = [];
      const flush = () => {
        if (run.length && passes.length < maxPasses) {
          // Grid-sampled peak and brightest sample; both are then refined below.
          let peak = run[0];
          let bright = null;
          for (const s of run) {
            if (s.v.elevation > peak.v.elevation) peak = s;
            if (s.v.apparentMag != null && (bright === null || s.v.apparentMag < bright.v.apparentMag)) bright = s;
          }

          const startClipped = run[0].t <= fromMs;
          const endClipped = run[run.length - 1].t >= lastGridMs;

          let visibleStart = run[0].t;
          let visibleEnd = run[run.length - 1].t;
          let peakTime = peak.t;
          let peakElevation = peak.v.elevation;
          let peakAzimuth = peak.v.azimuth;

          // Refine the window edges first, by bisecting window-membership across
          // the grid step that straddles each transition. inWindow captures
          // whatever bounds the window — the 10° gate, or a shadow / twilight /
          // brightness edge — so this handles both without special-casing. A
          // clipped edge is a scan boundary rather than a transition, so it is
          // left as the reported boundary and not refined.
          if (!startClipped) {
            const e = refineEdge(run[0].t - stepMs, run[0].t);
            if (e != null) visibleStart = e;
          }
          if (!endClipped) {
            const e = refineEdge(run[run.length - 1].t + stepMs, run[run.length - 1].t);
            if (e != null) visibleEnd = e;
          }

          // Then refine the culmination over the refined window. Elevation over a
          // single visible window is unimodal (one culmination per pass), so a
          // golden-section search across the whole window finds the true maximum
          // whether it falls in the interior or — for a pass still climbing when
          // it enters Earth's shadow — on an edge, without the grid sampling ever
          // deciding which. Reading the look angles back there fixes both the
          // understated peak elevation and the compass bearing shown next to it.
          if (visibleEnd > visibleStart) {
            const tPk = goldenPeakTime(visibleStart, visibleEnd);
            if (tPk != null) {
              const rv = visibilityAt(tPk);
              if (rv && rv.elevation >= peakElevation) {
                peakTime = tPk;
                peakElevation = rv.elevation;
                peakAzimuth = rv.azimuth;
              }
            }
          }

          passes.push({
            visibleStart,
            visibleEnd,
            peakTime,
            peakElevation,
            peakAzimuth,
            peakMag: bright ? bright.v.apparentMag : null,
            // Clipped edges are not rise/set times. Reporting the scan boundary
            // as an AOS ("visible from 22:00") claims precision the scan never
            // had; the UI renders these two cases differently.
            startClipped,
            endClipped,
          });
        }
        run = [];
      };
      for (const s of samples) {
        if (shows(s)) run.push(s);
        else flush();
      }
      flush();
    }
    samples = [];
  };

  // Summarise an object that is above the elevation gate for the entire scan.
  // "1 pass, peak at 01:15" is the wrong shape for a body that is simply parked
  // in the sky: what an observer wants is where to look and whether it is ever
  // lit against a dark sky.
  const summariseStanding = (all) => {
    // Representative look angles: a permanently-up object moves very little
    // (a station-kept GEO traces a figure-of-eight well under a degree across),
    // so the mid-scan sample is as good as any — and, unlike the first sample,
    // is not an artefact of where the scan happened to start.
    const mid = all[Math.floor(all.length / 2)];
    let darkMs = 0;
    let brightestMag = null;
    let nakedEye = false;
    for (const s of all) {
      if (s.v.state !== 'visible') continue;
      darkMs += stepMs; // one step per qualifying sample: granular to stepSec
      if (s.v.apparentMag != null && (brightestMag === null || s.v.apparentMag < brightestMag)) {
        brightestMag = s.v.apparentMag;
      }
      if (brightEnough(s.v)) nakedEye = true;
    }
    return {
      elevation: mid.v.elevation,
      azimuth: mid.v.azimuth,
      darkMs,
      brightestMag,
      nakedEye,
    };
  };

  for (let t = fromMs; t <= endMs; t += stepMs) {
    const date = new Date(t);
    // satellite.js throws on some deep-decay / bad-element cases rather than
    // returning a falsy position, and one bad sample must not take out the whole
    // prediction. Treat a failure exactly like a gap in coverage: close any open
    // pass and carry on.
    let pv = null;
    try {
      pv = satellite.propagate(satrec, date);
    } catch {
      pv = null;
    }
    if (!pv || !pv.position) {
      if (inPass) { finalize(); inPass = false; }
      everDown = true;
      continue;
    }
    const gmst = satellite.gstime(date);

    // Cheap elevation probe (skips the sun/shadow/magnitude work when down).
    const satEcf = satellite.eciToEcf(pv.position, gmst);
    const elevation = satellite.ecfToLookAngles(observerGd, satEcf).elevation * RAD2DEG;

    if (elevation >= minElevationDeg) {
      if (!inPass) { inPass = true; samples = []; }
      const v = computeVisibility(pv.position, gmst, observer, sunDirectionEci(date), stdMag);
      samples.push({ t, v });
    } else if (inPass) {
      finalize();
      inPass = false;
      everDown = true;
      if (passes.length >= maxPasses) break;
    } else {
      everDown = true;
    }
  }

  // A run still open at the end of the scan is either a clipped pass or, if it
  // began at the first sample and was never interrupted, an object that never
  // sets at all. "Never sets" is necessarily relative to the scan, so only claim
  // it when the scan was long enough for the distinction to mean something: a
  // 12 h horizon is past the ~8 h an MEO object can hold above a 10° gate, so
  // nothing short of a quasi-stationary orbit can clear it, while a scan shorter
  // than that just yields a clipped pass instead.
  if (inPass && !everDown && samples.length && endMs - fromMs >= alwaysUpMinHours * 3600e3) {
    const standing = summariseStanding(samples);
    // total/geomVisible stay at zero: there were no passes to count, and
    // reporting "1 pass in 24 h" for a geostationary satellite is exactly the
    // claim this branch exists to avoid.
    return { passes: [], total: 0, geomVisible: 0, unknownBrightness, alwaysUp: true, standing };
  }
  if (inPass) finalize();

  return { passes, total, geomVisible, unknownBrightness, alwaysUp: false, standing: null };
}
