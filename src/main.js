// ---------------------------------------------------------------------------
// Orbit — application entry point.
// Wires together the 3D scene, the satellite field, TLE loading, the simulation
// clock, and the UI.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { createScene } from './scene.js';
import { SatelliteField } from './satellites.js';
import { fetchLayers } from './tle.js';
import { LAYERS, LAYER_BY_ID, SPEEDS, EARTH_RADIUS } from './constants.js';
import { sunDirectionScene, fmtClock, fmtDuration } from './utils.js';

// ---- DOM handles ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('scene');

// ---- Simulation clock -----------------------------------------------------
const clock = {
  simTime: Date.now(),       // simulated epoch (ms)
  anchorReal: performance.now(),
  speed: 1,
  playing: true,
  tick() {
    const now = performance.now();
    if (this.playing) {
      this.simTime += (now - this.anchorReal) * this.speed;
    }
    this.anchorReal = now;
    return this.simTime;
  },
  toNow() { this.simTime = Date.now(); },
};

// ---- Boot -----------------------------------------------------------------
const { renderer, scene, camera, controls, setSunDirection } = createScene(canvas);
const field = new SatelliteField(scene);
const raycaster = new THREE.Raycaster();

let activeLayers = LAYERS.filter((l) => l.default);
let followSelected = false;
let tleFetchedAt = 0;
let frames = 0;
let fpsAnchor = performance.now();

buildLayerToggles();
buildSpeedButtons();
wireControls();
animate();
loadData(activeLayers);

// ---- Data loading ---------------------------------------------------------
async function loadData(layers, opts = {}) {
  showLoading('Fetching orbital elements from CelesTrak…');
  const priorityById = Object.fromEntries(LAYERS.map((l) => [l.id, l.priority]));
  try {
    const { records, fetchedAt, stale, errors } = await fetchLayers(layers, priorityById, opts);
    if (records.length === 0) {
      throw new Error(errors[0] || 'No satellites returned.');
    }
    tleFetchedAt = fetchedAt;
    showLoading(`Initialising SGP4 for ${records.length.toLocaleString()} satellites…`);
    const n = field.load(records);
    updateStats(n);
    updateLayerCounts();
    buildSearchList();
    if (stale) {
      toast('Using cached TLE data (CelesTrak unreachable — showing last known elements).');
    } else if (errors.length) {
      toast(`Some layers failed to load: ${errors.slice(0, 2).join('; ')}`);
    }
    hideLoading();
  } catch (err) {
    hideLoading();
    toast(
      `Could not load TLE data: ${err.message}. CelesTrak may be unreachable, or the ` +
      `page is opened from file:// (serve it over http and retry).`,
      true,
    );
    console.error(err);
  }
}

// ---- Render loop ----------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const simMs = clock.tick();
  const date = new Date(simMs);

  field.requestPropagate(simMs);
  setSunDirection(sunDirectionScene(date));

  // Selected-satellite readout + overlays.
  const sel = field.updateSelection(date);
  if (sel) updateReadout(sel);
  if (followSelected && sel) {
    controls.target.lerp(sel.scenePosition, 0.08);
  } else {
    controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
  }

  controls.update();
  renderer.render(scene, camera);

  // Clock + FPS.
  $('clock-utc').textContent = fmtClock(date);
  frames++;
  const nowp = performance.now();
  if (nowp - fpsAnchor > 500) {
    const fps = Math.round((frames * 1000) / (nowp - fpsAnchor));
    $('stat-fps').textContent = `${fps} fps`;
    frames = 0;
    fpsAnchor = nowp;
    updateCacheAge();
  }
}

// ---- UI construction ------------------------------------------------------
function buildLayerToggles() {
  const container = $('layers');
  container.innerHTML = '';
  for (const layer of LAYERS) {
    const row = document.createElement('label');
    row.className = 'layer' + (layer.default ? '' : ' off');
    row.dataset.id = layer.id;
    row.innerHTML = `
      <input type="checkbox" ${layer.default ? 'checked' : ''} />
      <span class="swatch" style="background:${layer.color};color:${layer.color}"></span>
      <span class="lname">${layer.label}</span>
      <span class="lcount" data-count>—</span>`;
    const input = row.querySelector('input');
    input.addEventListener('change', () => {
      row.classList.toggle('off', !input.checked);
      const l = LAYER_BY_ID[layer.id];
      if (input.checked && !activeLayers.includes(l)) {
        // Newly enabled on-demand layer needs its data.
        activeLayers = LAYERS.filter((x) =>
          document.querySelector(`.layer[data-id="${x.id}"] input`)?.checked);
        loadData(activeLayers);
      } else {
        field.setLayerVisible(layer.id, input.checked);
      }
    });
    container.appendChild(row);
  }
}

function buildSpeedButtons() {
  const container = $('speed-btns');
  container.innerHTML = '';
  for (const s of SPEEDS) {
    const b = document.createElement('button');
    b.className = 'sbtn' + (s === clock.speed ? ' active' : '');
    b.textContent = `${s}×`;
    b.addEventListener('click', () => {
      clock.speed = s;
      $('clock-mult').textContent = `${s}×`;
      container.querySelectorAll('.sbtn').forEach((el) => el.classList.remove('active'));
      b.classList.add('active');
    });
    container.appendChild(b);
  }
}

function buildSearchList() {
  const list = $('sat-list');
  list.innerHTML = '';
  // Cap options for responsiveness; the input still accepts any exact name.
  const names = field.records.map((r) => r.name).sort();
  const frag = document.createDocumentFragment();
  for (const name of names.slice(0, 4000)) {
    const opt = document.createElement('option');
    opt.value = name;
    frag.appendChild(opt);
  }
  list.appendChild(frag);
}

function wireControls() {
  // Selection via click (distinguish click from orbit-drag).
  let downPos = null;
  canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved > 6) return; // was a drag
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const idx = field.raycast(raycaster);
    if (idx >= 0) selectIndex(idx);
  });

  // Search box.
  $('search').addEventListener('change', (e) => {
    const idx = field.findByName(e.target.value);
    if (idx >= 0) selectIndex(idx, true);
  });

  // Time controls.
  $('btn-play').addEventListener('click', () => {
    clock.playing = !clock.playing;
    $('btn-play').textContent = clock.playing ? '❚❚' : '►';
  });
  $('btn-now').addEventListener('click', () => {
    clock.toNow();
    clock.speed = 1;
    buildSpeedButtons();
    $('clock-mult').textContent = '1×';
  });

  // Info panel controls.
  $('sel-close').addEventListener('click', deselect);
  $('opt-orbit').addEventListener('change', (e) => field.setOverlayOption('orbit', e.target.checked));
  $('opt-track').addEventListener('change', (e) => field.setOverlayOption('track', e.target.checked));
  $('opt-footprint').addEventListener('change', (e) => field.setOverlayOption('footprint', e.target.checked));
  $('opt-follow').addEventListener('change', (e) => { followSelected = e.target.checked; });

  // Buttons.
  $('load-all').addEventListener('click', () => {
    const row = document.querySelector('.layer[data-id="other"] input');
    if (row) { row.checked = true; row.dispatchEvent(new Event('change')); }
  });
  $('refresh-tle').addEventListener('click', () => loadData(activeLayers, { force: true }));

  // Collapse left panel.
  $('toggle-left').addEventListener('click', () => {
    $('panel-left').classList.toggle('collapsed');
  });
}

function selectIndex(idx, recenter = false) {
  const rec = field.select(idx);
  if (!rec) return;
  $('panel-right').classList.remove('hidden');
  $('sel-name').textContent = rec.name;
  if (recenter) {
    const pos = field.getScenePosition(idx);
    const dir = pos.clone().normalize();
    const dist = camera.position.length();
    camera.position.copy(dir.multiplyScalar(Math.max(dist, EARTH_RADIUS * 2.2)));
  }
}

function deselect() {
  field.deselect();
  $('panel-right').classList.add('hidden');
}

function updateReadout(sel) {
  $('sel-lat').textContent = sel.lat;
  $('sel-lon').textContent = sel.lon;
  $('sel-alt').textContent = sel.alt;
  $('sel-vel').textContent = sel.vel;
  $('sel-period').textContent = sel.period;
  $('sel-inc').textContent = sel.inc;
  $('sel-norad').textContent = sel.norad;
  const layer = LAYER_BY_ID[sel.layerId];
  $('sel-group').textContent = layer ? layer.label : sel.layerId;
}

function updateStats(n) {
  $('stat-sats').textContent = `${n.toLocaleString()} satellites`;
}

function updateLayerCounts() {
  for (const layer of LAYERS) {
    const el = document.querySelector(`.layer[data-id="${layer.id}"] [data-count]`);
    if (el) el.textContent = (field.layerCounts?.[layer.id] || 0).toLocaleString();
  }
}

function updateCacheAge() {
  if (!tleFetchedAt) return;
  $('stat-source').textContent = `TLE ${fmtDuration(Date.now() - tleFetchedAt)}`;
}

// ---- Loading / toast ------------------------------------------------------
function showLoading(msg) {
  $('loading').classList.remove('gone');
  $('loading-status').textContent = msg;
}
function hideLoading() {
  $('loading').classList.add('gone');
}
let toastTimer = null;
function toast(msg, sticky = false) {
  const el = $('error-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => el.classList.add('hidden'), 7000);
  el.onclick = () => el.classList.add('hidden');
}
