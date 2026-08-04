// ---------------------------------------------------------------------------
// Observer-relative visibility (Tier 2/3).
//
// Given the selected satellite's ECI position, the observer's location and the
// Sun direction, work out: look angles (azimuth/elevation/range), apparent
// magnitude, whether the satellite is sunlit, the sky state at the observer,
// and an overall "can I see it right now" verdict.
//
// All pure functions — no DOM, no globals. satellite.js supplies the frame
// conversions the app already uses elsewhere.
// ---------------------------------------------------------------------------
import * as satellite from 'satellite.js';
import { DEG2RAD, RAD2DEG, EARTH_RADIUS_KM } from './constants.js';

const AU_KM = 1.495978707e8;

// Sun altitude at the observer (degrees) marking the end of civil twilight —
// the point at which the sky is dark enough for satellite spotting. Heavens-
// Above and N2YO both gate their pass lists at roughly this value, so matching
// it is what makes Orbit's output comparable with the trackers people cross-
// check against. Above it, only the very brightest objects (ISS, Iridium-class
// flares) are realistically findable, which is why `twilight` is reported as its
// own state rather than folded into either `visible` or `daylight`.
export const CIVIL_TWILIGHT_DEG = -6;

// Diffuse-sphere (Lambertian) phase function, normalised to 1 at full phase
// (beta = 0). beta is the Sun–satellite–observer angle in radians.
function phaseFn(beta) {
  return ((Math.PI - beta) * Math.cos(beta) + Math.sin(beta)) / Math.PI;
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

// Azimuth in degrees -> 16-point compass label.
export function compass(azDeg) {
  return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

// Compute visibility for one satellite at one instant.
//   satEci   : {x,y,z} ECI km        (satellite.propagate .position)
//   gmst     : number                (satellite.gstime(date))
//   observer : {lat, lon, altKm}     degrees / km
//   sunEci   : {x,y,z} unit ECI      (sunDirectionEci(date))
//   stdMag   : number | null         intrinsic magnitude, if known
// Returns { elevation, azimuth, rangeKm, magOffset, apparentMag, satSunlit,
//           sunAltDeg, sky, state }.
// `state` ∈ below-horizon | shadow | daylight | twilight | visible.
export function computeVisibility(satEci, gmst, observer, sunEci, stdMag) {
  const observerGd = {
    longitude: observer.lon * DEG2RAD,
    latitude: observer.lat * DEG2RAD,
    height: observer.altKm || 0,
  };

  // Look angles from observer to satellite (ECF frame).
  const satEcf = satellite.eciToEcf(satEci, gmst);
  const look = satellite.ecfToLookAngles(observerGd, satEcf);
  const elevation = look.elevation * RAD2DEG;
  const azimuth = (((look.azimuth * RAD2DEG) % 360) + 360) % 360;
  const rangeKm = look.rangeSat;

  // Sun elevation at the observer -> sky state (day / twilight / dark).
  const sunFar = { x: sunEci.x * AU_KM, y: sunEci.y * AU_KM, z: sunEci.z * AU_KM };
  const sunLook = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(sunFar, gmst));
  const sunAltDeg = sunLook.elevation * RAD2DEG;
  const sky = sunAltDeg > 0 ? 'day' : sunAltDeg > CIVIL_TWILIGHT_DEG ? 'twilight' : 'dark';

  // Is the satellite sunlit? Cylindrical Earth-shadow model in ECI: it is in
  // shadow only when it lies on the anti-sun side (proj < 0) and within one
  // Earth radius of the Sun–Earth line.
  const proj = satEci.x * sunEci.x + satEci.y * sunEci.y + satEci.z * sunEci.z;
  const perp = Math.hypot(
    satEci.x - proj * sunEci.x,
    satEci.y - proj * sunEci.y,
    satEci.z - proj * sunEci.z,
  );
  const satSunlit = !(proj < 0 && perp < EARTH_RADIUS_KM);

  // Apparent magnitude = intrinsic + range term + phase term.
  // stdMag (mmccants) is defined at 1000 km and FULL phase, and phaseFn is
  // normalised to 1 at full phase — so at the reference condition the phase term
  // is 0 and apparentMag == stdMag, no offset. (Normalising to 90°/half-phase
  // instead would systematically over-brighten by ~1.24 mag against this source.)
  //
  // The two geometric terms are returned separately as `magOffset`, because they
  // are known even when the intrinsic magnitude is not: a caller with no stdMag
  // can still ask "how bright would an object of assumed intrinsic magnitude M
  // be from here?" without duplicating the range/phase maths. `predictPasses`
  // uses exactly that to bound unknown objects. Computing it unconditionally
  // costs one extra frame conversion per call, which is noise next to SGP4.
  const obsEci = satellite.ecfToEci(satellite.geodeticToEcf(observerGd), gmst);
  const toObs = { x: obsEci.x - satEci.x, y: obsEci.y - satEci.y, z: obsEci.z - satEci.z };
  const toObsLen = Math.hypot(toObs.x, toObs.y, toObs.z) || 1;
  const cosBeta = (toObs.x * sunEci.x + toObs.y * sunEci.y + toObs.z * sunEci.z) / toObsLen;
  const beta = Math.acos(Math.max(-1, Math.min(1, cosBeta)));
  // Floors guard the logs: rangeKm is never really 0 (the observer is on the
  // surface, the satellite is not), and phaseFn -> 0 at exact back-lighting,
  // where the 1e-4 floor caps the penalty at +10 mag instead of +Infinity.
  const magOffset = 5 * Math.log10(Math.max(rangeKm, 1e-3) / 1000)
    - 2.5 * Math.log10(Math.max(phaseFn(beta), 1e-4));
  const apparentMag = stdMag != null ? stdMag + magOffset : null;

  // Sky brightness is a three-way gate, not two. Folding civil twilight in with
  // full daylight would be too harsh (the ISS is easy at Sun −4°) and folding it
  // in with darkness is what made Orbit list passes no other tracker shows, so
  // it gets its own state and callers decide how strict to be. `predictPasses`
  // requires `visible`; the live readout surfaces `twilight` as its own badge,
  // which keeps the panel and the pass list telling the same story.
  let state;
  if (elevation <= 0) state = 'below-horizon';
  else if (!satSunlit) state = 'shadow';
  else if (sky === 'day') state = 'daylight';
  else if (sky === 'twilight') state = 'twilight';
  else state = 'visible'; // above horizon, sunlit, observer's sky properly dark

  return { elevation, azimuth, rangeKm, magOffset, apparentMag, satSunlit, sunAltDeg, sky, state };
}
