// ---------------------------------------------------------------------------
// Observer sky view: the "stand at your location and look up" render mode.
//
// A second three.js scene that shares the Earth view's renderer and canvas —
// one WebGL context, one resize path, and the render loop simply picks which
// (scene, camera) pair to draw. The camera sits at the origin inside a
// celestial sphere; everything visible is painted onto that sphere in the local
// sky frame defined by skyframe.js (+X east, +Y zenith, -Z north).
//
// What gets drawn, and where each position comes from:
//   - stars     : data/sky/stars.json, rotated EQJ -> horizontal once per frame
//                 (celestial.js batch helpers — one matrix for the catalogue)
//   - Sun/Moon
//     /planets  : celestial.js `skyBodies`, seven full ephemeris calls a frame
//   - satellites: the propagation worker's existing scene-frame position buffer
//                 pushed through skyframe.js `makeSkyTransform` — a rotation per
//                 object, no extra SGP4
//   - horizon   : an opaque ground plane, so anything below the horizon is
//                 occluded by depth rather than by a per-object visibility test
//
// Camera orientation is deliberately kept behind `setOrientation`/`orientation`
// rather than an OrbitControls instance. Pointer drag is only one driver; the
// intended second one is `deviceorientation`, which reports in exactly this
// frame (gravity gives the zenith, the magnetometer gives north), so pointing
// the phone at the sky becomes another caller of the same seam.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { skyBodies, starVectorEqj, eqjToHorRotation, rotateEqjToHor } from './celestial.js';
import { altAzToVec, horVecToSky, makeSkyTransform, isSunlitScene } from './skyframe.js';
import { EARTH_RADIUS } from './constants.js';

// Radius of the celestial sphere in scene units. Arbitrary — nothing here has a
// real distance — but it wants to be comfortably inside the camera's far plane
// and large enough that sprite scales read as sensible fractions of it.
const SKY_RADIUS = 500;

const FOV_DEFAULT = 65;
const FOV_MIN = 12;   // ~5x zoom, enough to separate close pairs
const FOV_MAX = 100;

// Looking within a hair of the zenith makes an up-vector camera degenerate, so
// pitch stops just short of it. (A device-orientation quaternion driver will
// not have this restriction — it never goes through lookAt.)
const PITCH_LIMIT = 89.5;

const CARDINALS = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
  ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

// Sun and Moon are drawn oversize (~1.5° against their true ~0.5°) so they read
// as discs rather than dots at the default field of view; planets are given a
// smaller but still deliberately generous marker. This is the usual planetarium
// exaggeration — the alternative is an astronomically faithful Moon that is
// almost invisible on a phone.
const BODY_STYLE = {
  Sun:     { color: 0xffd24a, size: 15 },
  Moon:    { color: 0xe8eaf0, size: 13 },
  Mercury: { color: 0xb8b0a4, size: 6 },
  Venus:   { color: 0xfff3c4, size: 8 },
  Mars:    { color: 0xff7a56, size: 6.5 },
  Jupiter: { color: 0xffd9a0, size: 8 },
  Saturn:  { color: 0xffe6b0, size: 7 },
};

// Stars at or brighter than this get a name label. ~20 stars at mag 1.6, which
// is about as many as can be labelled before the sky turns into a word cloud.
const LABEL_MAG_LIMIT = 1.6;

export function createSkyView(renderer, canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070e);

  const camera = new THREE.PerspectiveCamera(
    FOV_DEFAULT,
    window.innerWidth / window.innerHeight,
    0.1,
    SKY_RADIUS * 3,
  );
  camera.position.set(0, 0, 0);

  let active = false;
  let observer = null;
  let toSky = null;          // scene-frame -> sky-frame transform for this observer
  let starData = null;       // { eqj: Float32Array, count, positions, sizes }
  let satCount = 0;

  // Where the camera looks, in the same alt/az the rest of the app speaks.
  // South at a comfortable elevation is the default — it is where most of the
  // interesting sky is from the northern mid-latitudes the project defaults to,
  // and it puts the horizon in frame so the view is immediately legible.
  const orientation = { azimuth: 180, altitude: 30 };

  // --- Scene furniture -------------------------------------------------------
  // One soft-dot texture shared by both point clouds and every body sprite.
  const dot = makeDotTexture();

  scene.add(makeGround());
  scene.add(makeHorizonRing());

  // Text sprites live in world space (so they sort and orient with everything
  // else) but must hold a constant *screen* size — a world-scaled label grows
  // with every zoom step until one star name fills the view. Their scale is
  // therefore recomputed from the field of view whenever it changes.
  const labels = [];

  function scaleLabel(s) {
    const h = s.userData.frac * 2 * SKY_RADIUS * Math.tan(camera.fov * Math.PI / 360);
    s.scale.set(h * s.userData.aspect, h, 1);
    s.userData.worldHeight = h;
  }

  function addLabel(text, color, frac) {
    const s = makeTextSprite(text, color, frac);
    labels.push(s);
    scaleLabel(s);
    return s;
  }

  for (const [text, az] of CARDINALS) {
    const primary = text.length === 1;
    const s = addLabel(text, primary ? '#9fd0ff' : '#5d7fa8', primary ? 0.022 : 0.016);
    const v = altAzToVec(2.5, az, SKY_RADIUS * 0.985);
    s.position.set(v.x, v.y, v.z);
    scene.add(s);
  }

  const stars = makeStarPoints(dot);
  scene.add(stars.points);

  const starLabels = new THREE.Group();
  scene.add(starLabels);

  const bodies = makeBodySprites(dot, addLabel);
  bodies.forEach((b) => scene.add(b.sprite, b.label));

  const sats = makeSatPoints(dot);
  scene.add(sats.points);

  applyOrientation();

  // --- Star catalogue --------------------------------------------------------
  // Called once when data/sky/stars.json arrives. Each star's J2000 unit vector
  // is cached here so the per-frame cost is nine multiplies and a write.
  function setStars(catalogue) {
    const list = catalogue.stars;
    const count = list.length;
    const eqj = new Float32Array(count * 3);
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    const v = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < count; i++) {
      const s = list[i];
      starVectorEqj(s.ra, s.dec, v);
      eqj[i * 3] = v.x; eqj[i * 3 + 1] = v.y; eqj[i * 3 + 2] = v.z;
      sizes[i] = magToSize(s.mag);
    }

    starData = { eqj, positions, count };
    stars.setBuffers(positions, sizes, count);

    // Name labels for the brightest handful, parented to a group so they can be
    // repositioned in the same pass as the stars themselves.
    starLabels.clear();
    for (let i = 0; i < count; i++) {
      const s = list[i];
      if (s.mag > LABEL_MAG_LIMIT || !s.name) continue;
      const label = addLabel(s.name, '#8fb6d8', 0.014);
      label.userData.starIndex = i;
      starLabels.add(label);
    }
  }

  // --- Observer --------------------------------------------------------------
  function setObserver(next) {
    observer = next;
    toSky = next ? makeSkyTransform(next) : null;
  }

  // --- Camera orientation ----------------------------------------------------
  // The single seam every orientation driver goes through. Pointer drag calls it
  // today; a `deviceorientation` handler is meant to call it tomorrow.
  function setOrientation({ azimuth, altitude }) {
    if (azimuth != null) orientation.azimuth = ((azimuth % 360) + 360) % 360;
    if (altitude != null) {
      orientation.altitude = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, altitude));
    }
    applyOrientation();
  }

  function applyOrientation() {
    const v = altAzToVec(orientation.altitude, orientation.azimuth, SKY_RADIUS);
    camera.lookAt(v.x, v.y, v.z);
  }

  function setFov(next) {
    camera.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, next));
    camera.updateProjectionMatrix();
    labels.forEach(scaleLabel); // keep label screen size constant across zoom
  }

  // --- Per-frame update ------------------------------------------------------
  // `field` is the SatelliteField; `sunSceneDir` is the unit Sun direction in the
  // Earth scene frame (utils.js `sunDirectionScene`), reused here for the
  // shadow test so the sky view and the Earth view agree on what is lit.
  function update(date, field, sunSceneDir) {
    if (!active || !observer) return;
    updateStars(date);
    updateBodies(date);
    updateSats(field, sunSceneDir);
  }

  function updateStars(date) {
    if (!starData) return;
    const m = eqjToHorRotation(observer, date);
    const { eqj, positions, count } = starData;
    const hor = { x: 0, y: 0, z: 0 };
    const sky = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < count; i++) {
      const j = i * 3;
      rotateEqjToHor(m, eqj[j], eqj[j + 1], eqj[j + 2], hor);
      horVecToSky(hor, SKY_RADIUS, sky);
      positions[j] = sky.x; positions[j + 1] = sky.y; positions[j + 2] = sky.z;
    }
    stars.commit();

    // Labels ride slightly inside the sphere so they never z-fight their star,
    // and sit one label-height above it — an offset that has to track the label
    // scale, or the gap drifts as the view zooms.
    for (const label of starLabels.children) {
      const j = label.userData.starIndex * 3;
      label.position.set(
        positions[j] * 0.985,
        positions[j + 1] * 0.985 + label.userData.worldHeight,
        positions[j + 2] * 0.985,
      );
      label.visible = positions[j + 1] > 0;
    }
  }

  function updateBodies(date) {
    const list = skyBodies(observer, date);
    for (const b of bodies) {
      const found = list.find((x) => x.name === b.name);
      if (!found) continue;
      const v = altAzToVec(found.altitude, found.azimuth, SKY_RADIUS * 0.97);
      b.sprite.position.set(v.x, v.y, v.z);
      b.label.position.set(
        v.x,
        v.y + BODY_STYLE[b.name].size * 0.8 + b.label.userData.worldHeight,
        v.z,
      );
      // Below the horizon they are behind the opaque ground anyway; hiding them
      // explicitly also drops their labels, which the ground would not occlude
      // (labels sit inside the sphere, not on it).
      const up = found.altitude > 0;
      b.sprite.visible = up;
      b.label.visible = up;
    }
  }

  function updateSats(field, sunSceneDir) {
    if (!field || !field.count || !toSky) { sats.setCount(0); return; }

    const src = field.geometry.getAttribute('position');
    const colAttr = field.geometry.getAttribute('aColor');
    const visAttr = field.geometry.getAttribute('aVisible');
    if (!src || !colAttr || !visAttr) { sats.setCount(0); return; }

    if (satCount !== field.count) {
      satCount = field.count;
      sats.resize(satCount);
    }

    const pos = src.array;
    const col = colAttr.array;
    const vis = visAttr.array;
    const out = { x: 0, y: 0, z: 0, rangeKm: 0, altitude: 0, azimuth: 0 };

    const dst = sats.positions;
    const dstCol = sats.colors;
    const dstSize = sats.sizes;

    for (let i = 0; i < satCount; i++) {
      const j = i * 3;
      // A satellite hidden by the layer toggles, or below the horizon, gets zero
      // size — the shader discards it. Cheaper than rebuilding the buffer.
      if (vis[i] < 0.5) { dstSize[i] = 0; continue; }

      toSky(pos[j], pos[j + 1], pos[j + 2], out);
      if (out.altitude <= 0) { dstSize[i] = 0; continue; }

      dst[j] = out.x * SKY_RADIUS * 0.96;
      dst[j + 1] = out.y * SKY_RADIUS * 0.96;
      dst[j + 2] = out.z * SKY_RADIUS * 0.96;

      // Sunlit objects are the ones actually worth looking for; eclipsed ones
      // are still plotted, but dimmed and shrunk so the eye skips them.
      const lit = sunSceneDir
        ? isSunlitScene(pos[j], pos[j + 1], pos[j + 2], sunSceneDir, EARTH_RADIUS)
        : true;
      const k = lit ? 1 : 0.32;
      dstCol[j] = col[j] * k;
      dstCol[j + 1] = col[j + 1] * k;
      dstCol[j + 2] = col[j + 2] * k;
      dstSize[i] = lit ? 5.5 : 3;
    }

    sats.commit();
  }

  // --- Pointer / wheel input -------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e) {
    if (!active) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    if (!active || !dragging) return;
    // Degrees per pixel tracks the field of view, so a drag moves the same
    // *angular* amount whether zoomed in or out — which is what makes zoomed-in
    // panning feel controllable rather than frantic.
    const perPx = camera.fov / window.innerHeight;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Drag moves the sky with the pointer, so the camera turns against it.
    setOrientation({
      azimuth: orientation.azimuth - dx * perPx,
      altitude: orientation.altitude + dy * perPx,
    });
  }

  function onPointerUp(e) {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }

  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    setFov(camera.fov * (e.deltaY > 0 ? 1.1 : 1 / 1.1));
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  return {
    orientation,
    setStars,
    setObserver,
    setOrientation,
    setFov,
    update,
    setActive: (v) => { active = v; dragging = false; },
    render: () => renderer.render(scene, camera),
  };
}

// ---------------------------------------------------------------------------
// Geometry / material helpers
// ---------------------------------------------------------------------------

// Apparent size ramp. True brightness runs as 10^(-0.4 mag), which over the
// catalogue's -1.5..4.5 range is a factor of ~250 — far too wide to map onto
// point sizes. The gentler exponent here keeps Sirius clearly dominant while
// leaving the mag 4.5 floor still visible, which is the compression every star
// atlas applies for the same reason.
function magToSize(mag) {
  return Math.max(1.8, Math.min(11.0, 5.6 * Math.pow(10, -0.13 * mag)));
}

// Points material shared by the star and satellite clouds: a round soft dot,
// per-vertex colour and size, with size doubling as the discard flag.
function makePointsMaterial(texture, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture },
      uOpacity: { value: opacity },
      // gl_PointSize is in framebuffer pixels, so without this every point
      // would render at half size on a 2x display.
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vSize;
      void main() {
        vColor = aColor;
        vSize = aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Sized in pixels rather than by distance: everything sits on the same
        // sphere, so a 1/-mv.z term would only make points shrink as the camera
        // pitches away from them. Stars are point sources — constant apparent
        // size under zoom is the physically honest choice too.
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTexture;
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vSize;
      void main() {
        if (vSize < 0.5) discard;
        vec4 tex = texture2D(uTexture, gl_PointCoord);
        if (tex.a < 0.03) discard;
        gl_FragColor = vec4(vColor, tex.a * uOpacity);
      }
    `,
  });
}

function makeStarPoints(texture) {
  const geometry = new THREE.BufferGeometry();
  const material = makePointsMaterial(texture, 1.0);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  let positionAttr = null;

  return {
    points,
    setBuffers(positions, sizes, count) {
      // Stars are white; a colour attribute is still supplied so the star and
      // satellite clouds can share one material definition.
      const colors = new Float32Array(count * 3).fill(1);
      positionAttr = new THREE.BufferAttribute(positions, 3);
      positionAttr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', positionAttr);
      geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
      geometry.setDrawRange(0, count);
    },
    commit() {
      if (positionAttr) positionAttr.needsUpdate = true;
    },
  };
}

function makeSatPoints(texture) {
  const geometry = new THREE.BufferGeometry();
  const material = makePointsMaterial(texture, 0.95);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  const state = {
    points,
    positions: new Float32Array(0),
    colors: new Float32Array(0),
    sizes: new Float32Array(0),
    resize(count) {
      state.positions = new Float32Array(count * 3);
      state.colors = new Float32Array(count * 3);
      state.sizes = new Float32Array(count);
      const p = new THREE.BufferAttribute(state.positions, 3);
      const c = new THREE.BufferAttribute(state.colors, 3);
      const s = new THREE.BufferAttribute(state.sizes, 1);
      [p, c, s].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('position', p);
      geometry.setAttribute('aColor', c);
      geometry.setAttribute('aSize', s);
      geometry.setDrawRange(0, count);
    },
    setCount(count) {
      geometry.setDrawRange(0, count);
    },
    commit() {
      for (const name of ['position', 'aColor', 'aSize']) {
        const a = geometry.getAttribute(name);
        if (a) a.needsUpdate = true;
      }
    },
  };
  return state;
}

// Opaque ground disc through the observer. Being opaque (and depth-writing) is
// what hides everything below the horizon — cheaper and more correct than
// culling each object, and it gives satellites a hard horizon to rise over.
// The radius overshoots the celestial sphere so no gap opens at the edge.
function makeGround() {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(SKY_RADIUS * 1.6, 96),
    new THREE.MeshBasicMaterial({ color: 0x0a0f18, side: THREE.DoubleSide }),
  );
  mesh.rotation.x = -Math.PI / 2;
  // A touch below the horizon so objects sitting exactly at altitude 0 are not
  // caught in z-fighting with the ground they are supposed to be rising from.
  mesh.position.y = -0.5;
  return mesh;
}

function makeHorizonRing() {
  const pts = [];
  for (let deg = 0; deg <= 360; deg += 2) {
    const v = altAzToVec(0, deg, SKY_RADIUS * 0.99);
    pts.push(new THREE.Vector3(v.x, v.y, v.z));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x2b4a66, transparent: true, opacity: 0.75 }),
  );
}

function makeBodySprites(texture, addLabel) {
  return Object.keys(BODY_STYLE).map((name) => {
    const style = BODY_STYLE[name];
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      color: style.color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    sprite.scale.setScalar(style.size);
    sprite.visible = false;

    const label = addLabel(name, '#c3d4e6', 0.016);
    label.visible = false;
    return { name, sprite, label };
  });
}

// Soft round dot used by both point clouds and the body sprites.
function makeDotTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Text label as a camera-facing sprite. `frac` is the share of the viewport
// height the label should occupy; the caller turns that into a world scale from
// the current field of view (see `scaleLabel`), which is what keeps labels a
// fixed size on screen at every zoom level. The texture is rasterised at a
// fixed, generous size so the glyphs stay crisp when zoomed in.
const LABEL_RASTER_PX = 64;

function makeTextSprite(text, color, frac) {
  const pad = 10;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 ${LABEL_RASTER_PX}px ui-sans-serif, system-ui, sans-serif`;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const height = LABEL_RASTER_PX + pad * 2;
  canvas.width = width;
  canvas.height = height;

  // Resizing the canvas resets the context, so the font has to be set again.
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }));
  sprite.userData.aspect = width / height;
  sprite.userData.frac = frac;
  return sprite;
}
