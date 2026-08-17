// ---------------------------------------------------------------------------
// Propagation worker.
//
// Holds the SGP4 satellite records and, on request, propagates every satellite
// to a given time — returning ECEF positions (km) as a transferable Float32Array.
// Running this off the main thread keeps rendering and interaction at 60fps
// even with many thousands of satellites.
// ---------------------------------------------------------------------------
// Resolved relative to this file, not through the page's import map: module
// workers do not get one. The worker is constructed from `new URL('./worker.js',
// import.meta.url)`, so this path is relative to src/.
import * as satellite from '../vendor/satellite.js/satellite.js';

// Keep in sync with constants.js (worker cannot use the page's import map).
const KM_PER_UNIT = 1000;

let satrecs = [];

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    // msg.sats: [omm, ...] — OMM objects already validated on the main thread.
    satrecs = msg.sats.map((omm) => {
      try {
        return satellite.json2satrec(omm);
      } catch {
        return null;
      }
    });
    self.postMessage({ type: 'ready', count: satrecs.length });
    return;
  }

  if (msg.type === 'propagate') {
    const date = new Date(msg.time);
    const gmst = satellite.gstime(date);
    const n = satrecs.length;
    const positions = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const sr = satrecs[i];
      if (!sr) continue;
      const pv = satellite.propagate(sr, date);
      const p = pv && pv.position;
      if (!p) {
        // Decayed / propagation error — park it at the origin (hidden inside Earth).
        continue;
      }
      // ECI -> ECEF so positions align with a fixed Earth texture, then remap
      // to the scene frame (Y-up, scaled to units) so the main thread can copy
      // the buffer straight into the geometry with no per-point maths.
      const ecef = satellite.eciToEcf(p, gmst);
      positions[i * 3] = ecef.x / KM_PER_UNIT;
      positions[i * 3 + 1] = ecef.z / KM_PER_UNIT;
      positions[i * 3 + 2] = -ecef.y / KM_PER_UNIT;
    }

    self.postMessage({ type: 'positions', time: msg.time, positions }, [positions.buffer]);
  }
};
