// ---------------------------------------------------------------------------
// Global constants and configuration
// ---------------------------------------------------------------------------

// Scene scale: 1 three.js unit == 1000 km. Earth radius therefore ≈ 6.371.
export const KM_PER_UNIT = 1000;
export const EARTH_RADIUS_KM = 6371;
export const EARTH_RADIUS = EARTH_RADIUS_KM / KM_PER_UNIT; // ~6.371 units

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// GP data is only refetched every this many milliseconds. In between, SGP4
// propagation runs entirely in the browser — no further network calls.
export const GP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const GP_CACHE_PREFIX = 'orbit.gp.';

// The decaying set changes far faster than the general catalog (perigee drops
// by tens of km per day near reentry), so it is refetched more aggressively.
export const REENTRY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// CelesTrak general-perturbations endpoint. CORS-enabled, no key required.
// We request OMM in JSON: the legacy TLE format cannot represent the 6-digit
// catalog numbers CelesTrak began issuing in 2026 (5-digit space exhausted),
// so new objects are only available via OMM. See:
// https://celestrak.org/NORAD/documentation/gp-data-formats.php
export const CELESTRAK_URL = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=JSON`;

// The same endpoint also serves curated "special" data sets keyed by SPECIAL=.
// SPECIAL=DECAYING is CelesTrak's watch list of objects whose orbits are
// decaying toward atmospheric reentry — the source for the reentry mode.
export const CELESTRAK_SPECIAL_URL = (special) =>
  `https://celestrak.org/NORAD/elements/gp.php?SPECIAL=${special}&FORMAT=JSON`;

// Satellite layers. Each pulls one or more CelesTrak GROUPs and is drawn with
// its own colour. `priority` resolves duplicates (lower wins) when a catalog
// number appears in more than one group.
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
