// ---------------------------------------------------------------------------
// The observer's local sky frame (observer view).
//
// One place that fixes what "up" and "north" mean for the sky-dome render mode,
// plus the transforms into that frame. Like ephemeris.js / visibility.js /
// celestial.js this pulls in no renderer, so it unit-tests in Node; skyview.js
// is the only thing that draws.
//
// The frame is right-handed with the observer at the origin:
//
//     +X = east        +Y = zenith (up)        -Z = north
//
// so azimuth 0 (north) points along -Z and azimuth 90 (east) along +X — i.e.
// azimuth increases clockwise seen from the zenith looking down, matching the
// convention visibility.js and celestial.js already report in. Y-up also
// matches the Earth scene in scene.js, so one renderer and one canvas serve
// both modes.
//
// Making the *horizontal* frame the native one (rather than plotting in an
// equatorial frame and rotating at the end) is deliberate: it is exactly the
// frame a phone reports orientation in — gravity fixes the zenith, the
// magnetometer fixes north — so a device-orientation camera driver becomes a
// quaternion handed to the camera, with no change of basis anywhere else.
// ---------------------------------------------------------------------------
import * as satellite from 'satellite.js';
import { DEG2RAD, RAD2DEG, KM_PER_UNIT } from './constants.js';

// Altitude/azimuth (degrees) -> unit vector in the sky frame.
// `radius` scales the result onto the celestial sphere the renderer draws on.
export function altAzToVec(altDeg, azDeg, radius = 1, out = { x: 0, y: 0, z: 0 }) {
  const alt = altDeg * DEG2RAD;
  const az = azDeg * DEG2RAD;
  const horiz = Math.cos(alt) * radius;
  out.x = horiz * Math.sin(az);   // east
  out.y = Math.sin(alt) * radius; // zenith
  out.z = -horiz * Math.cos(az);  // north is -Z
  return out;
}

// Sky-frame vector -> { altitude, azimuth } in degrees. Azimuth is normalised
// to [0, 360). The vector need not be a unit vector.
export function vecToAltAz(x, y, z) {
  const horiz = Math.hypot(x, z);
  const altitude = Math.atan2(y, horiz) * RAD2DEG;
  // atan2(east, north): north is -z, so the north component is -z.
  const azimuth = ((Math.atan2(x, -z) * RAD2DEG) % 360 + 360) % 360;
  return { altitude, azimuth };
}

// Astronomy Engine's horizontal frame (HOR) is x = north, y = west,
// z = zenith. Ours is x = east, y = zenith, z = -north. That makes the change
// of basis a pure relabelling of axes with two sign flips — no trig, no matrix:
//
//     skyX = -horY   (east  = -west)
//     skyY =  horZ   (up    =  zenith)
//     skyZ = -horX   (-north)
//
// Kept here rather than in celestial.js so every definition of the sky frame
// lives in one file.
export function horVecToSky(hor, radius = 1, out = { x: 0, y: 0, z: 0 }) {
  out.x = -hor.y * radius;
  out.y = hor.z * radius;
  out.z = -hor.x * radius;
  return out;
}

// Build the transform from the app's scene frame (what the propagation worker
// writes: ECEF remapped to Y-up and divided by KM_PER_UNIT) into this
// observer's sky frame.
//
// The observer's ECEF position comes from satellite.js `geodeticToEcf`, the
// same call visibility.js makes, so the sky view and the selection panel's look
// angles are derived from an identical geodetic model — if they disagreed by
// even a fraction of a degree the view and the readout would be telling
// different stories about the same satellite.
//
// Returns a function (sceneX, sceneY, sceneZ, out) -> out, filling
// { x, y, z, rangeKm, altitude, azimuth } where x/y/z is a *unit* direction in
// the sky frame. It writes into a caller-supplied object because the render
// loop runs it over every satellite every frame and must not allocate.
export function makeSkyTransform(observer) {
  const lat = observer.lat * DEG2RAD;
  const lon = observer.lon * DEG2RAD;

  const origin = satellite.geodeticToEcf({
    longitude: lon,
    latitude: lat,
    height: observer.altKm || 0,
  });

  // Local ENU basis expressed in ECEF.
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const eX = -sinLon, eY = cosLon, eZ = 0;
  const nX = -sinLat * cosLon, nY = -sinLat * sinLon, nZ = cosLat;
  const uX = cosLat * cosLon, uY = cosLat * sinLon, uZ = sinLat;

  return function sceneToSky(sceneX, sceneY, sceneZ, out) {
    // Scene frame -> ECEF km. The worker writes
    //   sceneX = ecefX/KM_PER_UNIT, sceneY = ecefZ/KM_PER_UNIT, sceneZ = -ecefY/KM_PER_UNIT
    // (see worker.js), so this is that mapping inverted.
    const dx = sceneX * KM_PER_UNIT - origin.x;
    const dy = -sceneZ * KM_PER_UNIT - origin.y;
    const dz = sceneY * KM_PER_UNIT - origin.z;

    const e = dx * eX + dy * eY + dz * eZ;
    const n = dx * nX + dy * nY + dz * nZ;
    const u = dx * uX + dy * uY + dz * uZ;

    // A satellite can never actually coincide with the observer, but a decayed
    // object parked at the scene origin by the worker would sit one Earth
    // radius away, not zero — the floor is only here so a degenerate record can
    // never divide by zero and poison the whole position buffer with NaN.
    const range = Math.hypot(e, n, u) || 1e-9;

    out.x = e / range;
    out.y = u / range;
    out.z = -n / range;
    out.rangeKm = range;
    out.altitude = Math.asin(u / range) * RAD2DEG;
    out.azimuth = ((Math.atan2(e, n) * RAD2DEG) % 360 + 360) % 360;
    return out;
  };
}

// ---------------------------------------------------------------------------
// Device orientation -> camera orientation
//
// The reason the sky view is built in the horizontal frame at all: a phone's
// orientation sensors report against gravity and magnetic north, which is
// exactly this frame, so pointing the device at the sky needs no change of
// basis — only a change of units.
//
// The rotation composition is the one three.js shipped for years as
// DeviceOrientationControls (removed from the examples after r131): read the
// device Euler angles in YXZ order, tilt by -90 deg about X so that "phone held
// upright" looks at the horizon rather than at the observer's feet, then undo
// the screen rotation. It is written out here in plain arithmetic instead of
// with three.js Quaternions so the frame convention can be unit-tested in Node
// — a sign error here points the whole sky the wrong way, and that is not
// something to discover on a phone.
//
// Not corrected for: magnetic declination. `deviceorientationabsolute` (and
// iOS's webkitCompassHeading) are referenced to MAGNETIC north, which differs
// from true north by under 2 deg across the UK but by 20 deg or more at high
// latitudes. Correcting it needs a geomagnetic model (WMM/IGRF); until then the
// error is a bearing offset, not a distortion.
// ---------------------------------------------------------------------------

// Quaternion from Euler angles in three.js 'YXZ' order.
function quatFromEulerYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

// Hamilton product, three.js argument order (result = a * b).
function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// Rotate a vector by a quaternion.
export function applyQuat(q, vx, vy, vz, out = { x: 0, y: 0, z: 0 }) {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q_vec x v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

// -90 deg about X: without it, a phone held upright would look at the ground.
const TILT = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// Device orientation angles (degrees, as DeviceOrientationEvent reports them)
// -> a camera quaternion in the sky frame, as [x, y, z, w].
//   alpha  : rotation about the device z-axis, 0 when the top points to north
//   beta   : front-to-back tilt; 90 is upright
//   gamma  : left-to-right tilt
//   screen : the screen's own rotation (screen.orientation.angle)
export function deviceOrientationQuaternion(alpha, beta, gamma, screen = 0) {
  const q = quatMul(
    quatFromEulerYXZ(beta * DEG2RAD, alpha * DEG2RAD, -gamma * DEG2RAD),
    TILT,
  );
  const half = (-screen * DEG2RAD) / 2;
  return quatMul(q, [0, 0, Math.sin(half), Math.cos(half)]);
}

// Where a camera with that orientation is looking, as { altitude, azimuth }.
// The camera looks along its own -Z, as every three.js camera does.
export function quaternionLookAltAz(q) {
  const f = applyQuat(q, 0, 0, -1);
  return vecToAltAz(f.x, f.y, f.z);
}

// Is a satellite at ECEF-derived scene position lit by the Sun? Cylindrical
// Earth-shadow test, the same model visibility.js uses, but expressed in the
// scene frame so the sky view can run it over the whole field straight off the
// worker's position buffer without converting anything back to ECI.
//
// Both the position and the Sun direction are in the scene frame, and the test
// is a rotation-invariant dot/perpendicular pair, so it holds in either frame.
// `sunDir` must be a unit vector (utils.js `sunDirectionScene` returns one).
export function isSunlitScene(sceneX, sceneY, sceneZ, sunDir, earthRadiusUnits) {
  const proj = sceneX * sunDir.x + sceneY * sunDir.y + sceneZ * sunDir.z;
  if (proj >= 0) return true; // sunward hemisphere — never in shadow
  const perp = Math.hypot(
    sceneX - proj * sunDir.x,
    sceneY - proj * sunDir.y,
    sceneZ - proj * sunDir.z,
  );
  return perp >= earthRadiusUnits;
}
