// ---------------------------------------------------------------------------
// Orbit — application entry point.
// Wires together the 3D scene, the satellite field, GP/OMM loading, the simulation
// clock, and the UI.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { createScene } from './scene.js';
import { SatelliteField } from './satellites.js';
import { fetchLayers, fetchDecaying } from './gp.js';
import { LAYERS, LAYER_BY_ID, SPEEDS, TIME_SKIPS, EARTH_RADIUS } from './constants.js';
import { sunDirectionScene, sunDirectionEci, fmtClock, fmtDuration } from './utils.js';
import { computeVisibility, compass } from './visibility.js';
import { predictPasses } from './passes.js';
import {
  estimateReentry, reentryStatusLabel, fmtReentryEta, fmtReentryLoc,
  fmtUncertaintyWindow, ReentryMarkers, ReentryCorridor,
} from './reentry.js';
import {
  getEnrichment, loadIndex, loadManifest, brightnessClass,
} from './enrichment.js';

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
  skip(ms) { this.simTime += ms; },
  jumpTo(ms) { this.simTime = ms; },
};

// ---- Boot -----------------------------------------------------------------
const { renderer, scene, camera, controls, setSunDirection } = createScene(canvas);
const field = new SatelliteField(scene);
const reentryMarkers = new ReentryMarkers(scene);
const reentryCorridor = new ReentryCorridor(scene);
const raycaster = new THREE.Raycaster();

let activeLayers = LAYERS.filter((l) => l.default);
let followSelected = false;
let gpFetchedAt = 0;
let frames = 0;
let fpsAnchor = performance.now();

// Enrichment / Catalogue state. Declared here (not beside their functions lower
// in the file) because deselect() runs during boot, before those lines would
// otherwise initialise — a temporal-dead-zone trap.
let enrichReqNorad = null;   // guards the in-flight selection-panel enrichment fetch
let catReqNorad = null;      // guards the in-flight catalogue detail fetch
let catalogueOpen = false;
let catIndex = null;
let selectedEnrichment = null; // enrichment record of the selected sat (for stdMag)
// OBSERVER_KEY must be declared before loadObserver() runs on this line — it is
// a const referenced inside loadObserver(), so a later declaration would sit in
// the temporal dead zone, throw, and silently yield null (persisted location
// then ignored until re-saved).
const OBSERVER_KEY = 'orbit.observer';
let observer = loadObserver(); // { lat, lon, altKm } or null — observer location

// ---- View mode ------------------------------------------------------------
// 'tracker' — the full satellite catalogue (default).
// 'reentry' — CelesTrak's decaying-object watch list, with SGP4-estimated
//             reentry times and locations.
let mode = 'tracker';
let reentryEstimates = [];        // per field-index estimate (reentry mode only)

buildLayerToggles();
buildSpeedButtons();
buildSkipButtons();
wireControls();
animate();
setMode('tracker'); // loads the default catalogue

// ---- Data loading ---------------------------------------------------------
async function loadData(layers, opts = {}) {
  showLoading('Fetching orbital elements from CelesTrak…');
  const priorityById = Object.fromEntries(LAYERS.map((l) => [l.id, l.priority]));
  try {
    const { records, fetchedAt, stale, errors } = await fetchLayers(layers, priorityById, opts);
    if (records.length === 0) {
      throw new Error(errors[0] || 'No satellites returned.');
    }
    gpFetchedAt = fetchedAt;
    showLoading(`Initialising SGP4 for ${records.length.toLocaleString()} satellites…`);
    const n = field.load(records);
    updateStats(n);
    updateLayerCounts();
    buildSearchList();
    if (stale) {
      toast('Using cached GP data (CelesTrak unreachable — showing last known elements).');
    } else if (errors.length) {
      toast(`Some layers failed to load: ${errors.slice(0, 2).join('; ')}`);
    }
    hideLoading();
  } catch (err) {
    hideLoading();
    toast(
      `Could not load GP data: ${err.message}. CelesTrak may be unreachable, or the ` +
      `page is opened from file:// (serve it over http and retry).`,
      true,
    );
    console.error(err);
  }
}

// ---- View mode -------------------------------------------------------------
function setMode(next) {
  mode = next;
  const reentry = next === 'reentry';
  document.body.classList.toggle('mode-reentry', reentry);
  document.body.classList.toggle('mode-tracker', !reentry);
  $('mode-tracker').classList.toggle('active', !reentry);
  $('mode-reentry').classList.toggle('active', reentry);
  $('mode-tracker').setAttribute('aria-selected', String(!reentry));
  $('mode-reentry').setAttribute('aria-selected', String(reentry));
  $('panel-left-title').textContent = reentry ? 'Reentry watch' : 'Layers';

  deselect();
  reentryMarkers.setActive(reentry);
  if (reentry) {
    loadReentry();
  } else {
    reentryEstimates = [];
    loadData(activeLayers);
  }
}

// Load the decaying-object watch list and derive reentry estimates for it.
async function loadReentry(opts = {}) {
  showLoading('Fetching decaying objects from CelesTrak…');
  try {
    const { records, fetchedAt, stale } = await fetchDecaying(opts);
    if (!records.length) throw new Error('No decaying objects returned.');
    gpFetchedAt = fetchedAt;
    showLoading(`Estimating reentry for ${records.length} objects…`);
    // Let the status text paint before the synchronous SGP4 decay sweep.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const n = field.load(records);
    computeReentryEstimates();
    buildReentryList();
    updateStats(n);
    buildSearchList();
    if (stale) {
      toast('Using cached decay data (CelesTrak unreachable — showing last known elements).');
    }
    hideLoading();
  } catch (err) {
    hideLoading();
    toast(`Could not load decay data: ${err.message}. CelesTrak may be unreachable.`, true);
    console.error(err);
  }
}

// Forward-propagate every loaded object to its estimated reentry, aligned with
// the field's (validated) records, and hand the impact points to the markers.
function computeReentryEstimates() {
  const fromMs = Date.now();
  reentryEstimates = field.satrecs.map((sr) => estimateReentry(sr, fromMs));
  reentryMarkers.setData(reentryEstimates);
  reentryMarkers.setActive(mode === 'reentry');
}

// Reentry-status ordering for the list: soonest / most urgent first.
const REENTRY_ORDER = { imminent: 0, predicted: 1, beyond: 2, decayed: 3 };

function buildReentryList() {
  const list = $('reentry-list');
  list.innerHTML = '';
  const rows = reentryEstimates
    .map((est, i) => ({ est, i, rec: field.records[i] }))
    .sort((a, b) => {
      const d = (REENTRY_ORDER[a.est.status] ?? 9) - (REENTRY_ORDER[b.est.status] ?? 9);
      if (d !== 0) return d;
      return (a.est.reentryMs ?? Infinity) - (b.est.reentryMs ?? Infinity);
    });

  $('reentry-count').textContent = `${rows.length} object${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    list.innerHTML = '<li class="reentry-empty">No decaying objects right now.</li>';
    return;
  }

  const now = Date.now();
  const frag = document.createDocumentFragment();
  for (const { est, i, rec } of rows) {
    const li = document.createElement('li');
    li.className = est.status;
    li.dataset.index = String(i);
    const eta = est.reentryMs != null
      ? fmtReentryEta(est.reentryMs - now)
      : reentryStatusLabel(est.status);
    li.innerHTML =
      `<span class="re-name">${escapeHtml(rec.name)}</span>` +
      `<span class="re-eta">${eta}</span>`;
    li.addEventListener('click', () => selectIndex(i, true));
    frag.appendChild(li);
  }
  list.appendChild(frag);
  markSelectedRow();
}

// Refresh list countdowns against sim time (keeps them live under time-warp).
function refreshReentryEtas() {
  const t = clock.simTime;
  $('reentry-list').querySelectorAll('li[data-index]').forEach((li) => {
    const est = reentryEstimates[Number(li.dataset.index)];
    const eta = li.querySelector('.re-eta');
    if (!est || !eta) return;
    eta.textContent = est.reentryMs != null
      ? fmtReentryEta(est.reentryMs - t)
      : reentryStatusLabel(est.status);
  });
}

function markSelectedRow() {
  const sel = field.selected;
  $('reentry-list').querySelectorAll('li[data-index]').forEach((li) => {
    li.classList.toggle('selected', Number(li.dataset.index) === sel);
  });
}

// Fill (or hide) the reentry estimate block in the selection panel.
function updateReentryInfo(idx) {
  const info = $('reentry-info');
  const est = mode === 'reentry' ? reentryEstimates[idx] : null;
  if (!est) { info.classList.add('hidden'); return; }
  info.classList.remove('hidden');
  $('re-status').textContent = reentryStatusLabel(est.status);
  $('re-when').textContent = est.reentryMs != null ? fmtClock(new Date(est.reentryMs)) : '—';
  $('re-loc').textContent = fmtReentryLoc(est.lat, est.lon);
  $('re-window').textContent = est.reentryMs != null
    ? fmtUncertaintyWindow(est.reentryMs - Date.now()) : '—';
  $('re-alt').textContent = est.altKm != null ? `${est.altKm.toFixed(0)} km` : '—';
  // Jumping only makes sense when there's a concrete predicted time.
  $('re-jump').disabled = est.reentryMs == null;
  updateReentryCountdown();
}

function updateReentryCountdown() {
  if (mode !== 'reentry' || field.selected < 0) return;
  const est = reentryEstimates[field.selected];
  if (!est) return;
  const past = est.reentryMs != null && clock.simTime > est.reentryMs;
  $('re-eta').textContent = est.reentryMs != null
    ? fmtReentryEta(est.reentryMs - clock.simTime)
    : reentryStatusLabel(est.status);
  $('re-past').classList.toggle('hidden', !past);
  reentryMarkers.setPast(past);
}

// Build the shaded impact corridor for the selected object, anchored to the
// current (real-time) lead until its estimate.
function updateReentryCorridor(idx) {
  const est = reentryEstimates[idx];
  if (est && est.reentryMs != null) {
    reentryCorridor.show(field.satrecs[idx], est.reentryMs, Date.now());
  } else {
    reentryCorridor.hide();
  }
}

// Point the external-reference links at the selected object's NORAD catalog id.
function updateInfoLinks(rec) {
  const id = encodeURIComponent(rec.norad);
  $('link-n2yo').href = `https://www.n2yo.com/satellite/?s=${id}`;
  $('link-celestrak').href = `https://celestrak.org/satcat/records.php?CATNR=${id}`;
  $('link-heavens').href = `https://www.heavens-above.com/orbit.aspx?satid=${id}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  if (mode === 'reentry') updateReentryCountdown();
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
    if (mode === 'reentry') refreshReentryEtas();
    if (sel && observer) updateVisibility(sel, date);
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

function buildSkipButtons() {
  const container = $('skip-btns');
  container.innerHTML = '';
  for (const s of TIME_SKIPS) {
    const b = document.createElement('button');
    b.className = 'sbtn';
    b.textContent = s.label;
    b.title = `Skip ${s.label} of simulated time`;
    b.addEventListener('click', () => clock.skip(s.ms));
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

  // Jump the sim clock to the selected object's estimated reentry. Pause first:
  // if playback stayed on, the next frame would advance simTime past the exact
  // estimate, and updateReentryCountdown() would immediately flag it "past" —
  // greying the reticle and showing the stale-elements warning on arrival.
  $('re-jump').addEventListener('click', () => {
    if (mode !== 'reentry' || field.selected < 0) return;
    const est = reentryEstimates[field.selected];
    if (!est || est.reentryMs == null) return;
    clock.playing = false;
    $('btn-play').textContent = '►';
    clock.jumpTo(est.reentryMs);
    clock.speed = 1;
    buildSpeedButtons();
    $('clock-mult').textContent = '1×';
    updateReentryCountdown();
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

  // Mode switch (tracker catalogue ↔ reentry watch list).
  $('mode-tracker').addEventListener('click', () => { if (mode !== 'tracker') setMode('tracker'); });
  $('mode-reentry').addEventListener('click', () => { if (mode !== 'reentry') setMode('reentry'); });
  $('reentry-refresh').addEventListener('click', () => loadReentry({ force: true }));

  // Catalogue browser (overlay dialog; independent of the tracker/reentry mode).
  $('mode-catalogue').addEventListener('click', () => (catalogueOpen ? closeCatalogue() : openCatalogue()));
  $('cat-close').addEventListener('click', closeCatalogue);
  $('cat-search').addEventListener('input', () => renderCatList());
  $('cat-type').addEventListener('change', () => renderCatList());
  $('cat-bright').addEventListener('change', () => renderCatList());
  document.addEventListener('keydown', (e) => {
    const settingsOpen = !$('settings').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (catalogueOpen) closeCatalogue();
      if (settingsOpen) closeSettings();
    } else if (e.key === 'Tab' && settingsOpen) {
      trapTab(e, $('settings')); // keep focus within the modal dialog
    }
  });

  // Settings / observer location (Tier 2/3).
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('set-geo').addEventListener('click', useGeolocation);
  $('set-save').addEventListener('click', saveSettings);
  $('set-clear').addEventListener('click', clearSettings);
  $('vis-set-loc').addEventListener('click', openSettings);

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
  updateInfoLinks(rec);
  showEnrichment(rec.norad);
  updateVisibilitySection();
  updateReentryInfo(idx);
  if (mode === 'reentry') {
    reentryMarkers.highlight(idx);
    updateReentryCorridor(idx);
    markSelectedRow();
  }
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
  $('sel-enrich').classList.add('hidden');
  enrichReqNorad = null;
  selectedEnrichment = null;
  updateVisibilitySection();
  $('reentry-info').classList.add('hidden');
  $('re-past').classList.add('hidden');
  reentryMarkers.highlight(-1);
  reentryCorridor.hide();
  markSelectedRow();
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
  if (!gpFetchedAt) return;
  $('stat-source').textContent = `GP ${fmtDuration(Date.now() - gpFetchedAt)}`;
}

// ---- Catalogue enrichment -------------------------------------------------
// Shared rendering for the enrichment detail shown both in the selection panel
// and in the Catalogue browser's detail pane.

const SRC_LABEL = { satcat: 'CelesTrak', gcat: 'GCAT', mmccants: 'McCants' };
const TYPE_SHORT = { payload: 'Payload', 'rocket-body': 'R/B', debris: 'Debris', unknown: '?' };

function titleCase(s) {
  return String(s).replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function fmtDims(d) {
  if (!d) return null;
  const parts = [];
  if (d.length_m != null) parts.push(`L ${d.length_m} m`);
  if (d.diameter_m != null) parts.push(`Ø ${d.diameter_m} m`);
  if (d.span_m != null) parts.push(`span ${d.span_m} m`);
  return parts.length ? parts.join(' · ') : null;
}

// Ordered [label, value] rows for an enrichment record (skips absent fields).
function enrichRows(rec) {
  const rows = [];
  const add = (label, val) => { if (val != null && val !== '') rows.push([label, val]); };
  add('Type', rec.objectType && titleCase(rec.objectType));
  add('Status', rec.status && titleCase(rec.status));
  add('Op. status', rec.opsStatus && titleCase(rec.opsStatus));
  add('Operator', rec.owner);
  add('Country', rec.country);
  add('COSPAR', rec.cospar);
  add('Launched', rec.launchDate);
  add('Launch site', rec.launchSite);
  add('Mass', rec.massKg != null ? `${rec.massKg.toLocaleString()} kg` : null);
  add('Size (RCS)', rec.rcsSize
    ? titleCase(rec.rcsSize) + (rec.rcsValue_m2 != null ? ` · ${rec.rcsValue_m2.toFixed(2)} m²` : '')
    : null);
  add('Dimensions', fmtDims(rec.dimensions));
  add('Orbit class', rec.orbitClass);
  if (rec.stdMag != null) {
    const est = rec.magSource === 'estimate';
    add(
      est ? 'Est. magnitude' : 'Std. magnitude',
      est
        ? `~${rec.stdMag.toFixed(1)} (est. · ${rec.magBasis || 'constellation'})`
        : `${rec.stdMag.toFixed(1)} (intrinsic)`,
    );
  }
  return rows;
}

function renderEnrich(rec, { readoutEl, badgeEl, sourcesEl }) {
  readoutEl.innerHTML = enrichRows(rec)
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`)
    .join('');
  if (badgeEl) {
    const b = brightnessClass(rec.stdMag);
    if (b) {
      const est = rec.magSource === 'estimate';
      badgeEl.textContent = (est ? '~' : '') + b.label;
      badgeEl.className = `badge bright-${b.key}` + (est ? ' badge-est' : '');
      if (est) badgeEl.title = `Estimated from ${rec.magBasis || 'constellation'} — no individual measurement`;
      else badgeEl.removeAttribute('title');
    } else {
      badgeEl.className = 'badge hidden';
    }
  }
  if (sourcesEl) {
    const srcs = [...new Set(Object.values(rec._sources || {}).map((s) => s.split(':')[0]))];
    sourcesEl.textContent = srcs.length
      ? `Sources: ${srcs.map((s) => SRC_LABEL[s] || s).join(' · ')}`
      : '';
  }
}

// Lazily fill the selection panel's enrichment block. Guarded against a
// selection changing while the bucket fetch is in flight (enrichReqNorad,
// declared with the module state near the top).
async function showEnrichment(norad) {
  const box = $('sel-enrich');
  box.classList.add('hidden');
  enrichReqNorad = norad;
  selectedEnrichment = null;
  const rec = await getEnrichment(norad);
  if (enrichReqNorad !== norad) return; // superseded by a newer selection
  selectedEnrichment = rec; // feeds apparent-magnitude in the visibility panel
  updatePasses();           // recompute passes now that the magnitude is known
  if (!rec) return;
  renderEnrich(rec, {
    readoutEl: $('enrich-readout'), badgeEl: $('enrich-badge'), sourcesEl: $('enrich-sources'),
  });
  box.classList.remove('hidden');
}

// ---- Catalogue browser ----------------------------------------------------
// (catalogueOpen / catIndex declared with the module state near the top.)
const CAT_CAP = 400; // max rows rendered at once; count shows the full match total

async function openCatalogue() {
  catalogueOpen = true;
  $('catalogue').classList.remove('hidden');
  $('mode-catalogue').classList.add('active');
  $('mode-catalogue').setAttribute('aria-selected', 'true');
  if (!catIndex) {
    $('cat-count').textContent = 'Loading…';
    catIndex = await loadIndex();
    const man = await loadManifest();
    if (man) {
      const age = man.generatedAt ? fmtDuration(Date.now() - Date.parse(man.generatedAt)) : 'unknown';
      const est = man.counts.withMagEst ? ` (+${man.counts.withMagEst.toLocaleString()} estimated)` : '';
      $('cat-foot').textContent =
        `${man.counts.records.toLocaleString()} objects · ` +
        `magnitudes for ${man.counts.withMag.toLocaleString()}${est} · updated ${age}`;
    }
  }
  renderCatList();
  $('cat-search').focus();
}

function closeCatalogue() {
  catalogueOpen = false;
  $('catalogue').classList.add('hidden');
  $('mode-catalogue').classList.remove('active');
  $('mode-catalogue').setAttribute('aria-selected', 'false');
}

function renderCatList() {
  const q = $('cat-search').value.trim().toLowerCase();
  const type = $('cat-type').value;
  const bright = $('cat-bright').value;
  const rows = [];
  let matched = 0;
  for (const r of catIndex) {
    if (type && r.objectType !== type) continue;
    if (bright === 'any' && r.stdMag == null) continue;
    if (bright === 'naked' && !(r.stdMag != null && r.stdMag <= 6.0)) continue;
    if (q && !(r.name || '').toLowerCase().includes(q) && !r.norad.startsWith(q)) continue;
    matched++;
    if (rows.length < CAT_CAP) rows.push(r);
  }
  $('cat-count').textContent = `${matched.toLocaleString()} object${matched === 1 ? '' : 's'}` +
    (matched > rows.length ? ` · showing first ${rows.length}` : '');

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'cat-row';
    li.dataset.norad = r.norad;
    li.setAttribute('role', 'option');
    const b = brightnessClass(r.stdMag);
    li.innerHTML =
      `<span class="cat-name">${escapeHtml(r.name || `NORAD ${r.norad}`)}</span>` +
      `<span class="cat-meta">${escapeHtml(r.norad)}` +
      `${r.objectType ? ` · ${escapeHtml(TYPE_SHORT[r.objectType] || r.objectType)}` : ''}` +
      `${r.country ? ` · ${escapeHtml(r.country)}` : ''}</span>` +
      (b
        ? `<span class="badge tiny bright-${b.key}${r.magEst ? ' badge-est' : ''}"` +
          `${r.magEst ? ' title="Estimated (constellation typical)"' : ''}>` +
          `${r.magEst ? '~' : ''}${b.label}</span>`
        : '');
    li.addEventListener('click', () => selectCatRow(r.norad, li));
    frag.appendChild(li);
  }
  const list = $('cat-list');
  list.innerHTML = '';
  list.appendChild(frag);
}

async function selectCatRow(norad, li) {
  $('cat-list').querySelectorAll('.cat-row.active').forEach((el) => el.classList.remove('active'));
  if (li) li.classList.add('active');
  const detail = $('cat-detail');
  detail.innerHTML = '<p class="subtle">Loading…</p>';
  catReqNorad = norad;
  const rec = await getEnrichment(norad);
  if (catReqNorad !== norad) return; // superseded by a newer row selection
  if (!rec) { detail.innerHTML = '<p class="subtle">No catalogue record for this object.</p>'; return; }

  detail.innerHTML =
    `<h3>${escapeHtml(rec.name || `NORAD ${norad}`)}</h3>` +
    '<div class="enrich-head"><span id="cat-detail-badge" class="badge hidden"></span></div>' +
    '<dl class="readout" id="cat-detail-readout"></dl>' +
    '<p id="cat-detail-sources" class="enrich-sources"></p>' +
    '<div class="cat-detail-actions"></div>';
  renderEnrich(rec, {
    readoutEl: $('cat-detail-readout'),
    badgeEl: $('cat-detail-badge'),
    sourcesEl: $('cat-detail-sources'),
  });

  // Offer a jump into the 3D view only when the object is in the loaded field.
  const fieldIdx = field.records.findIndex((x) => x.norad === String(norad));
  const btn = document.createElement('button');
  if (fieldIdx >= 0) {
    btn.className = 'wide-btn';
    btn.textContent = 'Show in 3D';
    btn.addEventListener('click', () => { closeCatalogue(); selectIndex(fieldIdx, true); });
  } else {
    btn.className = 'wide-btn ghost';
    btn.textContent = 'Not in current view';
    btn.disabled = true;
    btn.title = 'Enable its layer (or “Load all active”) to view it in 3D.';
  }
  detail.querySelector('.cat-detail-actions').appendChild(btn);
}

// ---- Observer location & visibility (Tier 2/3) ----------------------------
// OBSERVER_KEY is declared with the module state near the top (it must exist
// before the boot-time loadObserver() call).

function loadObserver() {
  try {
    const v = JSON.parse(localStorage.getItem(OBSERVER_KEY));
    return v && typeof v.lat === 'number' && typeof v.lon === 'number' ? v : null;
  } catch { return null; }
}

function saveObserver(o) {
  observer = o;
  try {
    if (o) localStorage.setItem(OBSERVER_KEY, JSON.stringify(o));
    else localStorage.removeItem(OBSERVER_KEY);
  } catch { /* private mode — session-only is fine */ }
  updateVisibilitySection();
  updatePasses(); // location changed — recompute upcoming passes
}

function fmtLatLon(o) {
  return `${o.lat.toFixed(3)}°, ${o.lon.toFixed(3)}°`;
}

let settingsReturnFocus = null;
function openSettings() {
  settingsReturnFocus = document.activeElement;
  $('settings').classList.remove('hidden');
  if (observer) { $('set-lat').value = observer.lat; $('set-lon').value = observer.lon; }
  $('set-status').textContent = observer ? `Current: ${fmtLatLon(observer)}` : 'No location set.';
  $('set-lat').focus(); // move focus into the dialog for keyboard/SR users
}
function closeSettings() {
  $('settings').classList.add('hidden');
  // Restore focus to whatever opened the dialog (usually the ⚙ Location button).
  const back = settingsReturnFocus && settingsReturnFocus.focus ? settingsReturnFocus : $('open-settings');
  settingsReturnFocus = null;
  back.focus();
}

// Keep Tab focus inside `container` while it is open (basic focus trap).
function trapTab(e, container) {
  const focusable = [...container.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function useGeolocation() {
  if (!navigator.geolocation) {
    $('set-status').textContent = 'Geolocation is not available in this browser.';
    return;
  }
  $('set-status').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('set-lat').value = pos.coords.latitude.toFixed(4);
      $('set-lon').value = pos.coords.longitude.toFixed(4);
      $('set-status').textContent = 'Location found — Save to apply.';
    },
    (err) => { $('set-status').textContent = `Couldn't get location: ${err.message}`; },
    { enableHighAccuracy: false, timeout: 10000 },
  );
}

function saveSettings() {
  const lat = parseFloat($('set-lat').value);
  const lon = parseFloat($('set-lon').value);
  if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    $('set-status').textContent = 'Enter a valid latitude (−90…90) and longitude (−180…180).';
    return;
  }
  saveObserver({ lat, lon, altKm: 0 });
  $('set-status').textContent = `Saved: ${fmtLatLon(observer)}`;
  closeSettings();
}

function clearSettings() {
  saveObserver(null);
  $('set-lat').value = '';
  $('set-lon').value = '';
  $('set-status').textContent = 'Location cleared.';
}

// Show the visibility block (or the "set location" prompt) for the current
// selection + observer state. The live values are filled by updateVisibility().
function updateVisibilitySection() {
  const selected = field.selected >= 0;
  $('sel-visibility').classList.toggle('hidden', !(selected && observer));
  $('vis-prompt').classList.toggle('hidden', !(selected && !observer));
  if (!(selected && observer)) $('sel-passes').classList.add('hidden');
}

// ---- Visible-pass predictions ---------------------------------------------
// Passes are predicted from real wall-clock time (a "when do I go out" question),
// independent of the sim clock, and re-run on selection / location change.
function updatePasses() {
  const box = $('sel-passes');
  if (field.selected < 0 || !observer) { box.classList.add('hidden'); return; }
  const satrec = field.satrecs[field.selected];
  if (!satrec) { box.classList.add('hidden'); return; }
  const stdMag = selectedEnrichment && selectedEnrichment.stdMag != null ? selectedEnrichment.stdMag : null;
  const est = !!(selectedEnrichment && selectedEnrichment.magSource === 'estimate');
  const { passes, total, geomVisible } = predictPasses(satrec, observer, Date.now(), stdMag, { hours: 24 });
  renderPasses(passes, total, geomVisible, est, stdMag != null);
  box.classList.remove('hidden');
}

function dayPrefix(d) {
  const now = new Date();
  const today = now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400e3).toDateString();
  if (d.toDateString() === today) return '';
  if (d.toDateString() === tomorrow) return 'Tomorrow ';
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} `;
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function renderPasses(passes, total, geomVisible, est, haveMag) {
  const list = $('passes-list');
  const note = $('passes-note');
  list.innerHTML = '';
  if (passes.length) {
    for (const p of passes) {
      const li = document.createElement('li');
      li.className = 'pass-row';
      // A very short visible window (≤1 sample) is a brief culmination/shadow-edge
      // sighting — show the single peak time rather than a "21:14–21:14" range.
      const when = (p.visibleEnd - p.visibleStart) < 60e3
        ? `${dayPrefix(new Date(p.peakTime))}${hhmm(p.peakTime)}`
        : `${dayPrefix(new Date(p.visibleStart))}${hhmm(p.visibleStart)}–${hhmm(p.visibleEnd)}`;
      const mag = p.peakMag != null
        ? ` · mag ${p.peakMag.toFixed(1)}${est ? ' (est.)' : ''}`
        : '';
      li.innerHTML =
        `<span class="pass-when">${escapeHtml(when)}</span>` +
        `<span class="pass-meta">max ${p.peakElevation.toFixed(0)}° ${compass(p.peakAzimuth)}${mag}</span>`;
      list.appendChild(li);
    }
    note.textContent = 'Times in your local timezone · next 24 h.';
  } else {
    let msg;
    if (geomVisible > 0 && haveMag) {
      msg = `${geomVisible} sunlit pass${geomVisible === 1 ? '' : 'es'} in 24 h, but too faint to see (mag > 6.5).`;
    } else if (total > 0) {
      msg = `${total} pass${total === 1 ? '' : 'es'} in 24 h, but none visible (daylight or Earth's shadow).`;
    } else {
      msg = 'No passes above 10° in the next 24 h.';
    }
    note.textContent = msg;
  }
}

const VIS_STATE = {
  visible: { label: 'Visible now', cls: 'vis-visible' },
  shadow: { label: "In Earth's shadow", cls: 'vis-shadow' },
  daylight: { label: 'Daylight — too bright', cls: 'vis-day' },
  'below-horizon': { label: 'Below the horizon', cls: 'vis-below' },
};

// Compute and render observer-relative visibility for the selected satellite.
function updateVisibility(sel, date) {
  if (!observer || !sel || !sel.eci) return;
  const sun = sunDirectionEci(date);
  const stdMag = selectedEnrichment && selectedEnrichment.stdMag != null ? selectedEnrichment.stdMag : null;
  const est = selectedEnrichment && selectedEnrichment.magSource === 'estimate';
  const v = computeVisibility(sel.eci, sel.gmst, observer, sun, stdMag);

  const s = VIS_STATE[v.state];
  const badge = $('vis-state');
  badge.textContent = s.label;
  badge.className = `badge ${s.cls}`;

  const rows = [];
  if (v.elevation > 0) {
    rows.push(['Look toward', `${compass(v.azimuth)} · ${v.azimuth.toFixed(0)}°`]);
    rows.push(['Elevation', `${v.elevation.toFixed(0)}° above horizon`]);
  } else {
    rows.push(['Below horizon', `${Math.abs(v.elevation).toFixed(0)}° down`]);
  }
  rows.push(['Range', `${Math.round(v.rangeKm).toLocaleString()} km`]);
  // Apparent magnitude is only meaningful for a sunlit satellite — an eclipsed
  // one reflects no sunlight regardless of how intrinsically bright it is.
  if (v.apparentMag != null && v.satSunlit) {
    rows.push([est ? 'Est. brightness' : 'Brightness', `mag ${v.apparentMag.toFixed(1)}${est ? ' (est.)' : ''}`]);
  }
  rows.push(['Satellite', v.satSunlit ? 'Sunlit' : 'In shadow']);
  rows.push(['Your sky', v.sky === 'day' ? 'Daylight' : v.sky === 'twilight' ? 'Twilight' : 'Dark']);
  $('vis-readout').innerHTML = rows
    .map(([k, val]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(val)}</dd></div>`)
    .join('');
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
