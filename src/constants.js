// ---------------------------------------------------------------------------
// Global constants and configuration
// ---------------------------------------------------------------------------

// Scene scale: 1 three.js unit == 1000 km. Earth radius therefore ≈ 6.371.
export const KM_PER_UNIT = 1000;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS = EARTH_RADIUS_KM / KM_PER_UNIT; // ~6.371 units

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Camera feel
// ---------------------------------------------------------------------------

// Vertical field of view of the Earth-view camera, in degrees. Shared rather
// than hard-coded in scene.js so the drag-speed maths below cannot drift from
// the camera it describes.
export const CAMERA_FOV = 45;

// OrbitControls turns a drag into a fixed *angle* — theta = 2*pi*rotateSpeed*dx
// / viewportHeight — with no reference to how far the camera is from what it
// orbits. The apparent speed therefore depends entirely on zoom: close in, the
// globe fills the screen and a few degrees sweep half the visible surface;
// zoomed out it is a marble and the same drag barely moves it. Reported as
// "spins quickly zoomed in, crawls zoomed out".
//
// The fix is to derive the speed from the distance so a pixel of drag moves the
// surface under the cursor by roughly a pixel, at any zoom. A surface point
// sits (distance - radius) from the eye and projects to
//
//     pixels = radius * theta * H / (2 * (distance - radius) * tan(fov/2))
//
// Substituting theta and solving pixels = dx gives the expression below; the
// viewport height cancels, which is why this needs no DOM.
export const ROTATE_SPEED_MIN = 0.02;
export const ROTATE_SPEED_MAX = 2.5;

// Dolly limits, in Earth radii. Shared with the tests so an assertion about
// "the app's actual zoom range" cannot quietly drift from what scene.js sets.
// The far limit frames a full geostationary orbit (radius ~42,164 km ≈ 6.6
// Earth radii) pole-on within the FOV, and comfortably contains HEO/Molniya
// apogees.
export const ZOOM_MIN_RADII = 1.08;
export const ZOOM_MAX_RADII = 24;

export function rotateSpeedForDistance(distance, {
  fovDeg = CAMERA_FOV,
  radius = EARTH_RADIUS,
  min = ROTATE_SPEED_MIN,
  max = ROTATE_SPEED_MAX,
} = {}) {
  // Floored: the camera can be parked a hair above the surface, and at exactly
  // the surface the 1:1 speed is zero — which would freeze rotation entirely.
  const eyeToSurface = Math.max(distance - radius, radius * 0.01);
  const ideal = (eyeToSurface * Math.tan((fovDeg * DEG2RAD) / 2)) / (Math.PI * radius);
  // Clamped at both ends: 1:1 is the right *feel* but not a law worth obeying
  // into absurdity. Fully zoomed out the globe is ~90px across, so a literal
  // 1:1 drag would spin it several times in one gesture.
  return Math.min(max, Math.max(min, ideal));
}

// GP data is only refetched every this many milliseconds. In between, SGP4
// propagation runs entirely in the browser — no further network calls.
export const GP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const GP_CACHE_PREFIX = 'orbit.gp.';

// Static first-party data mirror. This is the *only* origin the browser fetches
// orbital data from — there is no direct-to-CelesTrak fallback, and one must not
// be re-added.
//
// CelesTrak (Dr T.S. Kelso) firewalled this project's mirror host on 2026-08-10
// for breaching their 100 MB/day limit: it requested the bandwidth-heavy JSON
// format, which is three times the size of CSV, and asked for the `active`
// GROUP *alongside* eleven groups that are subsets of `active`, which sent the
// same elements down the wire twice. The mirror now fetches `active` once, in
// CSV, and derives the subsets locally. The policy is at
// https://celestrak.org/usage-policy.php and the daily limit is documented at
// https://celestrak.org/NORAD/documentation/gp-data-formats.php#update — read
// both before adding any request to an upstream provider. See also the
// 2026-08-15 worklog entry.
//
// The frontend had the identical anti-pattern, from every visitor's browser: on
// any mirror hiccup — a deploy, a DNS blip — every open tab would fail over to
// CelesTrak at once and stampede them with the same duplicated JSON. A browser
// fleet cannot be rate-limited from here, cannot share a bandwidth ledger and
// cannot be told to stop when a 403 arrives, so the fallback was not fixable the
// way the server was; it was removed instead. A mirror outage now degrades to
// the stale localStorage copy in gp.js, and then to the catalogue bundled with
// the app — both offline, both costing CelesTrak nothing.
export const ORBIT_DATA_ORIGIN = 'https://orbit-data.mikepreston.org';
export const ORBIT_DATA_GP_URL = (dataset) =>
  `${ORBIT_DATA_ORIGIN}/v1/gp/${dataset}.json`;
export const ORBIT_DATA_CATALOG_URL = (path) =>
  `${ORBIT_DATA_ORIGIN}/v1/data/${path}`;

// Per-fetch network timeout. Without it a single stalled group holds the
// `Promise.allSettled` in `fetchLayers` open indefinitely and the app sits on
// the loading screen. On timeout the request is aborted and falls back to a
// stale cache when one exists (otherwise it surfaces as a normal fetch error).
// Kept short: the mirror serves pre-generated static files, so a response that
// has not started within five seconds is not coming.
export const ORBIT_DATA_FETCH_TIMEOUT_MS = 5 * 1000; // 5 seconds

// A last-known-good mirror response remains usable indefinitely, but data this
// old is called out in the UI so users know propagation accuracy is degrading.
export const GP_REMOTE_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

// The decaying set changes quickly, but the upstream minimum interval and the
// mirror's atomic publication cadence are two hours for every GP dataset.
export const REENTRY_MAX_AGE_MS = GP_MAX_AGE_MS;

// The mirror republishes each set as OMM in JSON, keyed by the CelesTrak GROUP
// (or SPECIAL) name it came from — hence the group names below. OMM rather than
// the legacy TLE format because TLE cannot represent the 6-digit catalog
// numbers CelesTrak began issuing in 2026 (5-digit space exhausted), so new
// objects are only available via OMM. See:
// https://celestrak.org/NORAD/documentation/gp-data-formats.php

// Satellite layers. Each pulls one or more GROUPs and is drawn with its own
// colour. `priority` resolves duplicates (lower wins) when a catalog number
// appears in more than one group.
export const LAYERS = [
  {
    // CelesTrak's "stations" group is the ISS and CSS complexes plus their
    // modules, visiting crew/cargo craft, and co-orbiting smallsats/debris —
    // not ~2 standalone stations. Label it for what it actually contains.
    id: 'stations',
    label: 'Stations & crewed craft',
    color: '#ef4444',
    groups: ['stations'],
    priority: 0,
    default: true,
  },
  {
    id: 'gnss',
    label: 'GNSS (GPS · Galileo · …)',
    color: '#facc15',
    groups: ['gps-ops', 'galileo', 'glo-ops', 'beidou'],
    priority: 1,
    default: true,
  },
  {
    id: 'geo',
    label: 'Geostationary',
    color: '#a855f7',
    groups: ['geo'],
    priority: 2,
    default: true,
  },
  {
    id: 'oneweb',
    label: 'OneWeb',
    color: '#fb923c',
    groups: ['oneweb'],
    priority: 3,
    default: true,
  },
  {
    id: 'starlink',
    label: 'Starlink',
    color: '#38bdf8',
    groups: ['starlink'],
    priority: 4,
    default: true,
  },
  {
    // Amazon's Kuiper LEO broadband constellation.
    id: 'kuiper',
    label: 'Kuiper',
    color: '#34d399',
    groups: ['kuiper'],
    priority: 5,
    default: true,
  },
  {
    // Qianfan (千帆) — "Thousand Sails" / G60, a Chinese LEO broadband network.
    id: 'qianfan',
    label: 'Qianfan (Thousand Sails)',
    color: '#f472b6',
    groups: ['qianfan'],
    priority: 6,
    default: true,
  },
  {
    // Guowang (国网) / GW — China SatNet's LEO network. CelesTrak files it under
    // the "hulianwang" (Hulianwang Digui) group.
    id: 'guowang',
    label: 'Guowang (GW)',
    color: '#818cf8',
    groups: ['hulianwang'],
    priority: 7,
    default: true,
  },
  {
    // Everything else in the active catalogue, loaded on demand via the "Load
    // all active" button. Priority is highest so the constellation layers above
    // claim their own satellites out of this catch-all first.
    id: 'other',
    label: 'Other active',
    color: '#94a3b8',
    groups: ['active'],
    priority: 9,
    default: false,
    onDemand: true,
  },
];

// The reentry watch layer is not part of the normal layer list (it has no
// toggle in the tracker) — it is loaded on its own when the user switches to
// reentry mode. It is still registered in LAYER_BY_ID so the shared satellite
// field can colour its points.
export const REENTRY_LAYER = {
  id: 'reentry',
  label: 'Reentry watch',
  color: '#ff4d4d',
  // Provenance only, no longer used to build a URL: the mirror's
  // `special-decaying` artifact is CelesTrak's SPECIAL=DECAYING watch list of
  // objects whose orbits are decaying toward atmospheric reentry.
  special: 'DECAYING',
  priority: 0,
};

export const LAYER_BY_ID = Object.fromEntries(
  [...LAYERS, REENTRY_LAYER].map((l) => [l.id, l]),
);

// ---- Reentry estimation ---------------------------------------------------
// Geocentric altitude (km) at or below which an object is treated as having
// reentered. Real reentry heating peaks around 80 km; we stop a little higher
// because SGP4 is not valid deep in the atmosphere and the sub-satellite point
// barely moves over the last few km anyway.
export const REENTRY_ALT_KM = 100;
// How far ahead SGP4 is propagated when searching for the decay epoch. Objects
// still above the atmosphere after this horizon are reported as "beyond" —
// their decay is too far out for a meaningful point estimate.
export const REENTRY_HORIZON_DAYS = 30;

// Reentry-time uncertainty grows with how far ahead the prediction reaches. A
// common rule of thumb is that the error in the predicted reentry epoch is
// roughly a fixed fraction of the remaining lead time (≈10–20%). We turn that
// timing spread into an *along-track* corridor: the object walks its ground
// track, so a ±Δt timing error becomes a ±(track distance covered in Δt) spread
// in where it comes down. INNER/OUTER are the two fractions we shade.
export const REENTRY_UNCERT_INNER = 0.10;
export const REENTRY_UNCERT_OUTER = 0.20;
// Even an "imminent" object gets a small corridor so the band is always visible.
export const REENTRY_CORRIDOR_MIN_MS = 3 * 60 * 1000;
// Cross-track spread is far smaller than along-track; drawn as a fixed-width
// band (km, half-width) purely so the lozenge reads as a filled area, not a line.
export const REENTRY_CORRIDOR_INNER_KM = 190;
export const REENTRY_CORRIDOR_OUTER_KM = 320;

// Quick time-jump steps offered in the time bar (label + signed milliseconds).
// Handy for reaching a reentry that is days out even at the top time-warp.
export const TIME_SKIPS = [
  { label: '−1d', ms: -86400000 },
  { label: '−6h', ms: -21600000 },
  { label: '−1h', ms: -3600000 },
  { label: '+1h', ms: 3600000 },
  { label: '+6h', ms: 21600000 },
  { label: '+1d', ms: 86400000 },
];

// Time-warp multipliers offered in the UI.
export const SPEEDS = [1, 10, 60, 300, 1500];

// Number of samples used to draw a selected satellite's orbit / ground track.
export const ORBIT_SAMPLES = 240;

// Earth textures (equirectangular), from the three.js example assets.
const TEX_BASE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/';
export const TEXTURES = {
  day: TEX_BASE + 'earth_atmos_2048.jpg',
  specular: TEX_BASE + 'earth_specular_2048.jpg',
  clouds: TEX_BASE + 'earth_clouds_1024.png',
  night: TEX_BASE + 'earth_lights_2048.png',
};
