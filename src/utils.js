// ---------------------------------------------------------------------------
// Coordinate / time / formatting helpers
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { DEG2RAD, KM_PER_UNIT, RAD2DEG } from './constants.js';

// Convert an Earth-Centred-Earth-Fixed position (km) into scene coordinates.
// ECEF axes: X -> (lat 0, lon 0), Y -> (lat 0, lon 90°E), Z -> north pole.
// Scene uses Y-up, so we remap to (x, z, -y) and scale km -> units.
export function ecefKmToScene(x, y, z, target = new THREE.Vector3()) {
  return target.set(x / KM_PER_UNIT, z / KM_PER_UNIT, -y / KM_PER_UNIT);
}

// Geodetic latitude/longitude (degrees) + radius (scene units) -> scene vector.
// Consistent with an un-rotated, equirectangular-textured sphere.
export function latLonToScene(latDeg, lonDeg, radius, target = new THREE.Vector3()) {
  const lat = latDeg * DEG2RAD;
  const lon = lonDeg * DEG2RAD;
  const cosLat = Math.cos(lat);
  return target.set(
    radius * cosLat * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * cosLat * Math.sin(lon),
  );
}

// Approximate geocentric direction to the Sun as a unit vector in scene space.
// Good to a fraction of a degree — ample for lighting the day/night terminator.
export function sunDirectionScene(date, target = new THREE.Vector3()) {
  const jd = dateToJulian(date);
  const n = jd - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) * DEG2RAD; // mean longitude
  const g = (357.528 + 0.9856003 * n) * DEG2RAD; // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG2RAD; // ecliptic long.
  const epsilon = 23.439 * DEG2RAD; // obliquity

  // Sun direction in ECI (unit vector).
  const xEci = Math.cos(lambda);
  const yEci = Math.cos(epsilon) * Math.sin(lambda);
  const zEci = Math.sin(epsilon) * Math.sin(lambda);

  // Rotate ECI -> ECEF by Greenwich mean sidereal time, then to scene space.
  const gmst = satellite.gstime(date);
  const cos = Math.cos(gmst);
  const sin = Math.sin(gmst);
  const xEcef = cos * xEci + sin * yEci;
  const yEcef = -sin * xEci + cos * yEci;
  const zEcef = zEci;
  return ecefKmToScene(xEcef, yEcef, zEcef, target).normalize();
}

export function dateToJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function fmtLat(deg) {
  return `${Math.abs(deg).toFixed(2)}° ${deg >= 0 ? 'N' : 'S'}`;
}
export function fmtLon(deg) {
  return `${Math.abs(deg).toFixed(2)}° ${deg >= 0 ? 'E' : 'W'}`;
}
export function fmtAlt(km) {
  return `${km.toFixed(0)} km`;
}
export function fmtVel(kms) {
  return `${kms.toFixed(2)} km/s`;
}
export function fmtPeriod(minutes) {
  if (!isFinite(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}
export function fmtDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}
export function fmtClock(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export { RAD2DEG };
