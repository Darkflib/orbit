// ---------------------------------------------------------------------------
// Topocentric alt/az for the fixed and wandering sky (observer view).
//
// Turns catalogue star positions (J2000 RA/Dec) and Solar-System bodies into
// horizontal coordinates — altitude above the horizon and azimuth clockwise
// from north — for a given observer and instant. This is the maths layer the
// sky-dome / observer render mode consumes; it draws nothing itself.
//
// Astronomy Engine (MIT) does the heavy lifting: precession + nutation for the
// star transform, and full VSOP87/ELP ephemerides for the Sun, Moon and
// planets. It is a pure ES module — no DOM, no three.js — so it sits alongside
// ephemeris.js / visibility.js without pulling the renderer into the physics.
//
// Azimuth convention matches visibility.js: degrees clockwise from north
// (N 0°, E 90°, S 180°, W 270°), so `compass()` there labels these directly.
// ---------------------------------------------------------------------------
import * as Astronomy from 'astronomy-engine';
import { DEG2RAD } from './constants.js';

// Naked-eye Solar-System bodies worth drawing on a sky map, in rough order of
// how often they matter to an observer. The Sun and Moon lead; the five classical
// naked-eye planets follow. Uranus/Neptune are omitted — below the mag 4.5 cut the
// star layer uses, so including them would be inconsistent with the rest of the sky.
export const SKY_BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

// Build the Astronomy Engine observer from the app's observer shape. Note the
// unit change: the app carries height as `altKm`; Astronomy.Observer wants metres.
function toAstroObserver(observer) {
  return new Astronomy.Observer(observer.lat, observer.lon, (observer.altKm || 0) * 1000);
}

// Refraction model passed to Astronomy.Horizon:
//   'apparent' -> 'normal'  : where the object appears, atmosphere included
//   'airless'  -> null      : the geometric (true) position, no bending
// Apparent is the default because a sky map should place objects where the eye
// actually finds them; airless is offered for geometry that must stay a rigid
// rotation (e.g. angular-separation checks), which refraction would distort.
function refractionArg(mode) {
  if (mode === 'airless') return null;
  if (mode === 'apparent') return 'normal';
  throw new Error(`unknown refraction mode: ${mode} (use 'apparent' or 'airless')`);
}

// Alt/az for a fixed star given its catalogue J2000 RA/Dec (both degrees).
//   raDeg, decDeg : J2000 equatorial position (as stored in stars.json)
//   observer      : { lat, lon, altKm }  degrees / km
//   date          : JS Date
//   opts.refraction : 'apparent' (default) | 'airless'
// Returns { altitude, azimuth, ra, dec } — altitude/azimuth in degrees, and the
// of-date ra (hours) / dec (degrees) the horizontal position was derived from.
//
// Stellar aberration (~20″) and annual parallax are not applied: both are far
// below the naked-eye sky map's resolution, and leaving them out keeps the
// transform a pure precession+nutation rotation of the catalogue position.
export function starAltAz(raDeg, decDeg, observer, date, { refraction = 'apparent' } = {}) {
  const time = Astronomy.MakeTime(date);
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;

  // J2000 (EQJ) unit vector, then rotate into the equator-of-date (EQD) frame
  // Astronomy.Horizon expects. Horizon does not precess its inputs, so the
  // rotation has to happen here or the sky would sit ~0.3° off for 2026 epochs.
  const vEqj = new Astronomy.Vector(
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
    time,
  );
  const vEqd = Astronomy.RotateVector(Astronomy.Rotation_EQJ_EQD(time), vEqj);
  const equ = Astronomy.EquatorFromVector(vEqd); // { ra: hours, dec: deg, dist }

  const hor = Astronomy.Horizon(time, toAstroObserver(observer), equ.ra, equ.dec, refractionArg(refraction));
  return { altitude: hor.altitude, azimuth: hor.azimuth, ra: equ.ra, dec: equ.dec };
}

// Alt/az for a Solar-System body (Sun, Moon or a planet).
//   body     : Astronomy.Body value or its name string ('Mars', 'Moon', …)
//   observer : { lat, lon, altKm }
//   date     : JS Date
//   opts.refraction : 'apparent' (default) | 'airless'
// Returns { altitude, azimuth, ra, dec, distanceAu } — the equatorial values are
// of-date and corrected for aberration, matching what Horizon plots.
export function bodyAltAz(body, observer, date, { refraction = 'apparent' } = {}) {
  const time = Astronomy.MakeTime(date);
  // ofdate = true, aberration = true: apparent equatorial coordinates for this
  // instant, which is what a horizontal projection should be built from.
  const equ = Astronomy.Equator(body, time, toAstroObserver(observer), true, true);
  const hor = Astronomy.Horizon(time, toAstroObserver(observer), equ.ra, equ.dec, refractionArg(refraction));
  return { altitude: hor.altitude, azimuth: hor.azimuth, ra: equ.ra, dec: equ.dec, distanceAu: equ.dist };
}

// Convenience: alt/az for every SKY_BODIES entry at one instant. Each result is
// { name, altitude, azimuth, ra, dec, distanceAu }; the render mode can filter to
// those above the horizon (altitude > 0) itself.
export function skyBodies(observer, date, opts) {
  return SKY_BODIES.map((name) => ({ name, ...bodyAltAz(name, observer, date, opts) }));
}
