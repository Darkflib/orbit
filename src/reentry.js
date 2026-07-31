// ---------------------------------------------------------------------------
// Reentry prediction.
//
// CelesTrak's SPECIAL=DECAYING set lists objects whose orbits are decaying
// toward atmospheric reentry, but it only carries orbital elements — not a
// predicted time or place of reentry. In keeping with the rest of the app, we
// derive those in the browser: SGP4 is propagated forward until the object
// drops below a reentry altitude, and the sub-satellite point at that instant
// is taken as the estimated reentry location.
//
// These are rough estimates. Real reentry prediction models atmospheric drag,
// solar activity and attitude; a bare SGP4 extrapolation captures the trend but
// not the day-of accuracy, so everything here is presented as "estimated".
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import {
  EARTH_RADIUS, EARTH_RADIUS_KM, REENTRY_ALT_KM, REENTRY_HORIZON_DAYS, RAD2DEG,
} from './constants.js';
import { latLonToScene } from './utils.js';

const DAY_MS = 86400000;
const COARSE_MS = 2 * 60 * 60 * 1000; // 2 h scan step when searching for decay
const REFINE_ITERS = 20;             // binary-search steps once decay is bracketed
const DECAY_RADIUS_KM = EARTH_RADIUS_KM + REENTRY_ALT_KM;

// Geocentric radius (km) of a satrec at an epoch, or null when SGP4 cannot
// propagate it — for a low, decaying object that effectively means "gone".
function radiusKm(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  const p = pv && pv.position;
  if (!p) return null;
  const r = Math.hypot(p.x, p.y, p.z);
  return Number.isFinite(r) ? r : null;
}

// Sub-satellite geodetic point (deg) and altitude (km) at an epoch, or null.
function subPoint(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  const p = pv && pv.position;
  if (!p) return null;
  const geo = satellite.eciToGeodetic(p, satellite.gstime(date));
  return { lat: geo.latitude * RAD2DEG, lon: geo.longitude * RAD2DEG, altKm: geo.height };
}

// Binary-search the first instant in (loMs, hiMs] at which the object has
// dropped to the reentry altitude (or become un-propagatable).
function refineDecay(satrec, loMs, hiMs) {
  for (let i = 0; i < REFINE_ITERS; i++) {
    const mid = (loMs + hiMs) / 2;
    const r = radiusKm(satrec, new Date(mid));
    if (r == null || r <= DECAY_RADIUS_KM) hiMs = mid;
    else loMs = mid;
  }
  return hiMs;
}

// Estimate when and where a decaying object reenters.
// Returns { status, reentryMs, altKm, lat, lon } where:
//   status 'imminent'  — already at/below the reentry altitude
//          'predicted' — decay found within the search horizon
//          'beyond'    — still aloft after REENTRY_HORIZON_DAYS
//          'decayed'   — SGP4 cannot propagate it at the current epoch
// altKm is the object's altitude now; lat/lon locate the estimated reentry
// (null when unknown). Times are absolute epoch milliseconds.
export function estimateReentry(satrec, fromMs) {
  const start = subPoint(satrec, new Date(fromMs));
  if (!start) {
    return { status: 'decayed', reentryMs: null, altKm: null, lat: null, lon: null };
  }
  if (EARTH_RADIUS_KM + start.altKm <= DECAY_RADIUS_KM) {
    return {
      status: 'imminent', reentryMs: fromMs, altKm: start.altKm, lat: start.lat, lon: start.lon,
    };
  }

  const horizonMs = fromMs + REENTRY_HORIZON_DAYS * DAY_MS;
  let tPrev = fromMs;
  for (let t = fromMs + COARSE_MS; t <= horizonMs; t += COARSE_MS) {
    const r = radiusKm(satrec, new Date(t));
    if (r == null || r <= DECAY_RADIUS_KM) {
      const ms = refineDecay(satrec, tPrev, t);
      const at = subPoint(satrec, new Date(ms)) || subPoint(satrec, new Date(tPrev)) || start;
      return { status: 'predicted', reentryMs: ms, altKm: start.altKm, lat: at.lat, lon: at.lon };
    }
    tPrev = t;
  }
  return { status: 'beyond', reentryMs: null, altKm: start.altKm, lat: null, lon: null };
}

// ---- Formatting -----------------------------------------------------------

// Human label for an estimate status, used in list rows and the readout.
export function reentryStatusLabel(status) {
  switch (status) {
    case 'imminent': return 'Reentry imminent';
    case 'predicted': return 'Predicted';
    case 'beyond': return `Beyond ${REENTRY_HORIZON_DAYS} days`;
    case 'decayed': return 'Likely decayed';
    default: return status;
  }
}

// Time-to-reentry as a compact countdown (e.g. "3d 4h", "5h 20m", "12 min").
export function fmtReentryEta(msToGo) {
  if (msToGo == null) return '—';
  if (msToGo <= 0) return 'imminent';
  const mins = Math.floor(msToGo / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

// Estimated reentry location as a short "12.3° N, 45.6° W" string.
export function fmtReentryLoc(lat, lon) {
  if (lat == null || lon == null) return '—';
  const ns = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
  const ew = `${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`;
  return `${ns}, ${ew}`;
}

// ---------------------------------------------------------------------------
// Estimated-reentry-location markers drawn on the globe: a red target at every
// predicted impact point, plus a brighter reticle over the selected object's.
// ---------------------------------------------------------------------------
const MARKER_RADIUS = EARTH_RADIUS * 1.004;

export class ReentryMarkers {
  constructor(scene) {
    this.scene = scene;
    this.byIndex = new Map(); // field index -> scene position of its estimate

    this.points = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        map: makeTargetSprite(),
        color: 0xff4d4d,
        size: 22,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    this.points.visible = false;

    this.reticle = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeReticleSprite(),
        color: 0xffd1d1,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.reticle.scale.setScalar(EARTH_RADIUS * 0.16);
    this.reticle.visible = false;

    this.scene.add(this.points, this.reticle);
  }

  // Populate markers from estimates aligned with the satellite field indices.
  setData(estimates) {
    this.byIndex.clear();
    const coords = [];
    const v = new THREE.Vector3();
    estimates.forEach((est, i) => {
      if (!est || est.lat == null || est.lon == null) return;
      latLonToScene(est.lat, est.lon, MARKER_RADIUS, v);
      coords.push(v.x, v.y, v.z);
      this.byIndex.set(i, v.clone());
    });
    this.points.geometry.setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(coords), 3),
    );
    this.points.geometry.computeBoundingSphere();
  }

  setActive(active) {
    this.points.visible = active && this.points.geometry.getAttribute('position')?.count > 0;
    if (!active) this.reticle.visible = false;
  }

  // Move the reticle onto the selected object's estimated location, or hide it.
  highlight(index) {
    const pos = this.byIndex.get(index);
    if (pos && this.points.visible) {
      this.reticle.position.copy(pos);
      this.reticle.visible = true;
    } else {
      this.reticle.visible = false;
    }
  }
}

// A white ring-with-crosshair sprite, tinted red for reentry impact points.
function makeTargetSprite() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, c - 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c, 4); ctx.lineTo(c, size - 4);
  ctx.moveTo(4, c); ctx.lineTo(size - 4, c);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A larger dashed reticle used to mark the selected object's impact point.
function makeReticleSprite() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.strokeStyle = 'rgba(255,220,220,0.98)';
  ctx.lineWidth = 4;
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.arc(c, c, c - 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  for (let a = 0; a < 4; a++) {
    const ang = (a * Math.PI) / 2;
    const r0 = c - 22, r1 = c - 6;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(ang) * r0, c + Math.sin(ang) * r0);
    ctx.lineTo(c + Math.cos(ang) * r1, c + Math.sin(ang) * r1);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
