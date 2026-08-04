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
// Accuracy note: event times and the reported peak are quantised to the scan
// step. At the default 30 s that costs ±30 s on the window edges and up to ~9°
// on the culmination of a fast near-zenith LEO pass. See
// docs/pass-validation-2026-08-04.md — the propagation and geometry underneath
// validate to metres and thousandths of a degree; the step is the whole error
// budget. Refining the edges and the peak is a deliberate follow-up.
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

  // Brightness gate for one sample. A measured magnitude is a straight
  // comparison; without one we fall back to the optimistic bound above, and
  // remember that we did so, so the UI can say "brightness unknown" rather than
  // quoting a cutoff it never actually tested the object against.
  const brightEnough = (v) => {
    if (v.apparentMag != null) return v.apparentMag <= maxMag;
    if (unknownStdMag + v.magOffset <= maxMag) return true;
    unknownBrightness = true;
    return false;
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
          let peak = run[0];
          let bright = null;
          for (const s of run) {
            if (s.v.elevation > peak.v.elevation) peak = s;
            if (s.v.apparentMag != null && (bright === null || s.v.apparentMag < bright.v.apparentMag)) bright = s;
          }
          passes.push({
            visibleStart: run[0].t,
            visibleEnd: run[run.length - 1].t,
            peakTime: peak.t,
            peakElevation: peak.v.elevation,
            peakAzimuth: peak.v.azimuth,
            peakMag: bright ? bright.v.apparentMag : null,
            // Clipped edges are not rise/set times. Reporting the scan boundary
            // as an AOS ("visible from 22:00") claims precision the scan never
            // had; the UI renders these two cases differently.
            startClipped: run[0].t <= fromMs,
            endClipped: run[run.length - 1].t >= lastGridMs,
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
