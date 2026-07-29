// ---------------------------------------------------------------------------
// Satellite field: the point cloud, the propagation worker, selection, and the
// orbit / ground-track / footprint overlays for a selected satellite.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import {
  EARTH_RADIUS, EARTH_RADIUS_KM, ORBIT_SAMPLES,
  LAYER_BY_ID, RAD2DEG,
} from './constants.js';
import { ecefKmToScene, latLonToScene, fmtLat, fmtLon, fmtAlt, fmtVel, fmtPeriod } from './utils.js';

export class SatelliteField {
  constructor(scene) {
    this.scene = scene;
    this.records = [];      // { name, norad, layerId, l1, l2 }
    this.satrecs = [];      // parallel SGP4 records (main thread, for selection maths)
    this.count = 0;
    this.selected = -1;
    this._lastOverlayUpdate = 0;
    this._pendingTime = null;
    this._workerBusy = false;

    this._buildPoints();
    this._buildOverlays();

    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorkerMessage(e);
  }

  // ---- Geometry / material for the point cloud -----------------------------
  _buildPoints() {
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: makeGlowSprite() },
        uSize: { value: 260.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aVisible;
        uniform float uSize;
        varying vec3 vColor;
        varying float vVisible;
        void main() {
          vColor = aColor;
          vVisible = aVisible;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aVisible * uSize / max(-mv.z, 0.001);
          gl_PointSize = clamp(gl_PointSize, 0.0, 14.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTexture;
        varying vec3 vColor;
        varying float vVisible;
        void main() {
          if (vVisible < 0.5) discard;
          vec4 tex = texture2D(uTexture, gl_PointCoord);
          if (tex.a < 0.05) discard;
          gl_FragColor = vec4(vColor, tex.a);
        }
      `,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  _buildOverlays() {
    // Orbit ellipse.
    this.orbitLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65 }),
    );
    this.orbitLine.visible = false;
    this.orbitLine.frustumCulled = false;

    // Ground track.
    this.trackLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x38f5c8, transparent: true, opacity: 0.7 }),
    );
    this.trackLine.visible = false;
    this.trackLine.frustumCulled = false;

    // Coverage footprint.
    this.footprintLine = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.8 }),
    );
    this.footprintLine.visible = false;
    this.footprintLine.frustumCulled = false;

    // Camera-facing marker highlighting the selected satellite.
    this.marker = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeRingSprite(),
        color: 0xffffff,
        transparent: true,
        depthTest: true,
      }),
    );
    this.marker.scale.setScalar(EARTH_RADIUS * 0.12);
    this.marker.visible = false;

    this.overlayOptions = { orbit: true, track: true, footprint: true };
    this.scene.add(this.orbitLine, this.trackLine, this.footprintLine, this.marker);
  }

  // ---- Loading -------------------------------------------------------------
  // Validate TLEs on the main thread (build satrecs, discard broken ones), fill
  // the geometry attributes, and hand the survivors to the worker.
  load(records) {
    const valid = [];
    const satrecs = [];
    for (const rec of records) {
      let sr;
      try {
        sr = satellite.twoline2satrec(rec.l1, rec.l2);
      } catch {
        continue;
      }
      if (!sr || sr.error) continue;
      // Sanity-check propagation at epoch.
      const pv = satellite.propagate(sr, new Date());
      if (!pv || !pv.position || Number.isNaN(pv.position.x)) continue;
      valid.push(rec);
      satrecs.push(sr);
    }

    this.records = valid;
    this.satrecs = satrecs;
    this.count = valid.length;

    const n = this.count;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const visible = new Float32Array(n);
    const c = new THREE.Color();
    this.layerCounts = {};

    for (let i = 0; i < n; i++) {
      const layer = LAYER_BY_ID[valid[i].layerId];
      c.set(layer ? layer.color : '#ffffff');
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      visible[i] = 1;
      this.layerCounts[valid[i].layerId] = (this.layerCounts[valid[i].layerId] || 0) + 1;
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('aVisible', new THREE.BufferAttribute(visible, 1));

    this.worker.postMessage({
      type: 'init',
      sats: valid.map((r) => ({ l1: r.l1, l2: r.l2 })),
    });

    this.deselect();
    return this.count;
  }

  // ---- Propagation ---------------------------------------------------------
  requestPropagate(timeMs) {
    this._pendingTime = timeMs;
    if (!this._workerBusy && this.count > 0) this._flush();
  }

  _flush() {
    if (this._pendingTime == null) return;
    const time = this._pendingTime;
    this._pendingTime = null;
    this._workerBusy = true;
    this.worker.postMessage({ type: 'propagate', time });
  }

  _onWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'positions') {
      const attr = this.geometry.getAttribute('position');
      if (attr && attr.array.length === msg.positions.length) {
        attr.array.set(msg.positions);
        attr.needsUpdate = true;
        this.geometry.computeBoundingSphere();
      }
      this._workerBusy = false;
      if (this._pendingTime != null) this._flush();
    }
  }

  // ---- Layer visibility ----------------------------------------------------
  setLayerVisible(layerId, visible) {
    const attr = this.geometry.getAttribute('aVisible');
    if (!attr) return;
    const arr = attr.array;
    for (let i = 0; i < this.count; i++) {
      if (this.records[i].layerId === layerId) arr[i] = visible ? 1 : 0;
    }
    attr.needsUpdate = true;
  }

  // ---- Selection -----------------------------------------------------------
  raycast(raycaster) {
    if (this.count === 0) return -1;
    raycaster.params.Points.threshold = this._pickThreshold(raycaster);
    const hits = raycaster.intersectObject(this.points, false);
    // Ignore hits on satellites whose layer is hidden.
    const vis = this.geometry.getAttribute('aVisible').array;
    for (const h of hits) {
      if (vis[h.index] > 0.5) return h.index;
    }
    return -1;
  }

  _pickThreshold(raycaster) {
    // Scale the pick radius with camera distance so far-away sats stay clickable.
    const d = raycaster.ray.origin.length();
    return THREE.MathUtils.clamp(d * 0.006, 0.03, 0.4);
  }

  select(index) {
    if (index < 0 || index >= this.count) return null;
    this.selected = index;
    this._lastOverlayUpdate = 0; // force overlay refresh
    return this.records[index];
  }

  deselect() {
    this.selected = -1;
    this.orbitLine.visible = false;
    this.trackLine.visible = false;
    this.footprintLine.visible = false;
    this.marker.visible = false;
  }

  findByName(name) {
    const idx = this.records.findIndex((r) => r.name === name);
    return idx;
  }

  getScenePosition(index, target = new THREE.Vector3()) {
    const attr = this.geometry.getAttribute('position');
    return target.fromBufferAttribute(attr, index);
  }

  // ---- Selected-satellite readout + overlays -------------------------------
  // Called every frame; heavy overlay maths are throttled internally.
  updateSelection(date) {
    if (this.selected < 0) return null;
    const i = this.selected;
    const satrec = this.satrecs[i];
    const rec = this.records[i];

    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const latDeg = geo.latitude * RAD2DEG;
    const lonDeg = geo.longitude * RAD2DEG;
    const altKm = geo.height;
    const speed = pv.velocity
      ? Math.sqrt(pv.velocity.x ** 2 + pv.velocity.y ** 2 + pv.velocity.z ** 2)
      : NaN;
    const periodMin = (2 * Math.PI) / satrec.no; // no = rad/min
    const incDeg = satrec.inclo * RAD2DEG;

    // Live marker position from the shared buffer.
    const pos = this.getScenePosition(i);
    this.marker.position.copy(pos);
    this.marker.visible = true;

    // Throttle the expensive orbit/track/footprint rebuild to ~3 Hz.
    if (date.getTime() - this._lastOverlayUpdate > 330) {
      this._lastOverlayUpdate = date.getTime();
      this._rebuildOrbit(satrec, date, periodMin);
      this._rebuildGroundTrack(satrec, date, periodMin);
      this._rebuildFootprint(latDeg, lonDeg, altKm);
    }
    this._applyOverlayVisibility();

    return {
      name: rec.name,
      norad: rec.norad,
      layerId: rec.layerId,
      lat: fmtLat(latDeg),
      lon: fmtLon(lonDeg),
      alt: fmtAlt(altKm),
      vel: fmtVel(speed),
      period: fmtPeriod(periodMin),
      inc: `${incDeg.toFixed(1)}°`,
      scenePosition: pos,
    };
  }

  _applyOverlayVisibility() {
    const sel = this.selected >= 0;
    this.orbitLine.visible = sel && this.overlayOptions.orbit;
    this.trackLine.visible = sel && this.overlayOptions.track;
    this.footprintLine.visible = sel && this.overlayOptions.footprint;
  }

  setOverlayOption(key, value) {
    this.overlayOptions[key] = value;
    this._applyOverlayVisibility();
  }

  // Closed orbit ellipse in the Earth-fixed frame at the current instant.
  _rebuildOrbit(satrec, date, periodMin) {
    const gmst = satellite.gstime(date);
    const pts = new Float32Array(ORBIT_SAMPLES * 3);
    const t0 = date.getTime();
    const v = new THREE.Vector3();
    for (let s = 0; s < ORBIT_SAMPLES; s++) {
      const t = new Date(t0 + (s / ORBIT_SAMPLES) * periodMin * 60000);
      const pv = satellite.propagate(satrec, t);
      if (!pv || !pv.position) continue;
      const ecef = satellite.eciToEcf(pv.position, gmst); // fixed gmst -> closed loop
      ecefKmToScene(ecef.x, ecef.y, ecef.z, v);
      pts[s * 3] = v.x; pts[s * 3 + 1] = v.y; pts[s * 3 + 2] = v.z;
    }
    this.orbitLine.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.orbitLine.geometry.computeBoundingSphere();
  }

  // Sub-satellite ground track over one period (accounts for Earth rotation).
  _rebuildGroundTrack(satrec, date, periodMin) {
    const pts = new Float32Array(ORBIT_SAMPLES * 3);
    const t0 = date.getTime();
    const r = EARTH_RADIUS * 1.002;
    const v = new THREE.Vector3();
    for (let s = 0; s < ORBIT_SAMPLES; s++) {
      const t = new Date(t0 + (s / ORBIT_SAMPLES) * periodMin * 60000);
      const pv = satellite.propagate(satrec, t);
      if (!pv || !pv.position) continue;
      const gmst = satellite.gstime(t);
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      latLonToScene(geo.latitude * RAD2DEG, geo.longitude * RAD2DEG, r, v);
      pts[s * 3] = v.x; pts[s * 3 + 1] = v.y; pts[s * 3 + 2] = v.z;
    }
    this.trackLine.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.trackLine.geometry.computeBoundingSphere();
  }

  // Circle of ground visibility for the current altitude.
  _rebuildFootprint(latDeg, lonDeg, altKm) {
    const Re = EARTH_RADIUS_KM;
    const ratio = Re / (Re + Math.max(altKm, 1));
    const central = Math.acos(THREE.MathUtils.clamp(ratio, -1, 1)); // half-angle (rad)

    const r = EARTH_RADIUS * 1.002;
    const center = latLonToScene(latDeg, lonDeg, 1, new THREE.Vector3()); // unit
    // Build an orthonormal basis around the centre direction.
    const up = Math.abs(center.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(center, up).normalize();
    const t2 = new THREE.Vector3().crossVectors(center, t1).normalize();

    const segs = 128;
    const pts = new Float32Array(segs * 3);
    const cosC = Math.cos(central);
    const sinC = Math.sin(central);
    const p = new THREE.Vector3();
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      p.copy(center).multiplyScalar(cosC)
        .addScaledVector(t1, sinC * Math.cos(a))
        .addScaledVector(t2, sinC * Math.sin(a))
        .multiplyScalar(r);
      pts[s * 3] = p.x; pts[s * 3 + 1] = p.y; pts[s * 3 + 2] = p.z;
    }
    this.footprintLine.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.footprintLine.geometry.computeBoundingSphere();
  }
}

// Soft radial-gradient sprite used for every satellite point.
function makeGlowSprite() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Hollow ring sprite used to highlight the selected satellite.
function makeRingSprite() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 12, 0, Math.PI * 2);
  ctx.stroke();
  // Four small ticks for a "reticle" feel.
  ctx.lineWidth = 4;
  for (let a = 0; a < 4; a++) {
    const ang = (a * Math.PI) / 2;
    const cx = size / 2, cy = size / 2, r0 = size / 2 - 6, r1 = size / 2 + 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
