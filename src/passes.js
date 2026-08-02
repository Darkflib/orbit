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
import { sunDirectionEci } from './utils.js';
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
      let peak = samples[0];
      for (const s of samples) if (s.v.elevation > peak.v.elevation) peak = s;

      const vis = samples.filter((s) => s.v.state === 'visible');
      if (vis.length) {
        geomVisible++;
        // Brightest (lowest-magnitude) sample in the visible window.
        let bright = null;
        for (const s of vis) {
          if (s.v.apparentMag != null && (bright === null || s.v.apparentMag < bright.v.apparentMag)) bright = s;
        }
        const peakMag = bright ? bright.v.apparentMag : null;
        // Keep it if bright enough (or if magnitude is unknown — can't rule out).
        if ((peakMag == null || peakMag <= maxMag) && passes.length < maxPasses) {
          passes.push({
            visibleStart: vis[0].t,
            visibleEnd: vis[vis.length - 1].t,
            peakTime: peak.t,
            peakElevation: peak.v.elevation,
            peakAzimuth: peak.v.azimuth,
            peakMag,
          });
        }
      }
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
