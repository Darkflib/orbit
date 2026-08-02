// ---------------------------------------------------------------------------
// Pure solar-ephemeris / time math.
//
// Dependency-free (only DEG2RAD) so the physics modules — visibility.js,
// passes.js — can use it without pulling in three.js. Kept out of utils.js,
// which imports the renderer for its scene-space helpers.
// ---------------------------------------------------------------------------
import { DEG2RAD } from './constants.js';

// Julian Date from a JS Date.
export function dateToJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Geocentric direction to the Sun as a unit vector in ECI. Good to a fraction
// of a degree — ample for terminator lighting and visibility geometry. Shared
// by the scene lighting (sunDirectionScene) and the visibility calculation.
export function sunDirectionEci(date) {
  const jd = dateToJulian(date);
  const n = jd - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) * DEG2RAD; // mean longitude
  const g = (357.528 + 0.9856003 * n) * DEG2RAD; // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG2RAD; // ecliptic long.
  const epsilon = 23.439 * DEG2RAD; // obliquity
  return {
    x: Math.cos(lambda),
    y: Math.cos(epsilon) * Math.sin(lambda),
    z: Math.sin(epsilon) * Math.sin(lambda),
  };
}
