// ---------------------------------------------------------------------------
// Visible-pass prediction (Tier 4).
//
// Walk SGP4 forward from a start time and find upcoming passes for the selected
// satellite over the observer: windows where it climbs above a minimum
// elevation, is sunlit, the observer's sky is dark/twilit, and (when a
// magnitude is known) it is bright enough to see with the naked eye.
//
// One satellite over ~24 h at a 30 s step is a few thousand SGP4 evaluations —
// cheap enough to run synchronously on selection. Below the horizon (most of
// the time) only a lightweight elevation probe runs; the full visibility
// computation only kicks in once the object is actually up.
// ---------------------------------------------------------------------------
import * as satellite from 'satellite.js';
import { DEG2RAD, RAD2DEG } from './constants.js';
import { sunDirectionEci } from './ephemeris.js';
import { computeVisibility } from './visibility.js';

// Predict visible passes.
//   satrec   : SGP4 record
//   observer : { lat, lon, altKm }
//   fromMs   : start epoch (ms) — use real Date.now() for "tonight"
//   stdMag   : intrinsic magnitude or null
// Options: hours, stepSec, minElevationDeg, maxMag (naked-eye cutoff), maxPasses.
// Returns { passes, total, geomVisible }:
//   passes      — visible & bright-enough passes (up to maxPasses)
//   total       — count of above-horizon passes scanned
//   geomVisible — count of passes that were sunlit + dark sky (pre-magnitude)
export function predictPasses(satrec, observer, fromMs, stdMag, {
  hours = 24, stepSec = 30, minElevationDeg = 10, maxMag = 6.5, maxPasses = 4,
} = {}) {
  const observerGd = {
    longitude: observer.lon * DEG2RAD,
    latitude: observer.lat * DEG2RAD,
    height: observer.altKm || 0,
  };
  const endMs = fromMs + hours * 3600e3;
  const passes = [];
  let total = 0;
  let geomVisible = 0;
  let inPass = false;
  let samples = [];

  const finalize = () => {
    if (samples.length) {
      total++;
      if (samples.some((s) => s.v.state === 'visible')) geomVisible++;

      // A single geometric pass can hold several separate visible windows (it can
      // dip into Earth's shadow and re-emerge). Emit one record per *contiguous*
      // run of samples that are both visible and naked-eye bright, and derive the
      // window's peak/brightness from that run only — never from shadowed or
      // too-faint samples on either side.
      const shows = (s) => s.v.state === 'visible'
        && (s.v.apparentMag == null || s.v.apparentMag <= maxMag);
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

  for (let t = fromMs; t <= endMs; t += stepSec * 1000) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) { if (inPass) { finalize(); inPass = false; } continue; }
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
      if (passes.length >= maxPasses) break;
    }
  }
  if (inPass) finalize();

  return { passes, total, geomVisible };
}
