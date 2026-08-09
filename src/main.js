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
import { createSkyView } from './skyview.js';

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
// Sky mode's scene shares this renderer and canvas — see skyview.js.
const skyView = createSkyView(renderer, canvas);
// Sky artifacts are tracked separately so a failure in one can be retried
// without discarding the other (see ensureSkyCatalogues).
const skyCatalogueReady = { stars: false, figures: false };
let skyLoadInFlight = false;

// Reused every frame so the render loop allocates nothing.
const sunDirScratch = new THREE.Vector3();
const ORIGIN = new THREE.Vector3(0, 0, 0);

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
// 'sky'     — the observer's local sky: stars, Sun/Moon/planets and the
//             satellites currently above their horizon (skyview.js).
let mode = 'tracker';
let reentryEstimates = [];        // per field-index estimate (reentry mode only)
let loadedDataset = null;         // which catalogue the field currently holds
// Declared here, not down beside setMode: the boot sequence below calls
// setMode('tracker') immediately, and a const declared later in the file would
// still be in its temporal dead zone at that point — the same trap OBSERVER_KEY
// carries a warning about above, which this hit for real.
const MODE_TITLES = { tracker: 'Layers', reentry: 'Reentry watch', sky: 'Sky' };

// Same reason as MODE_TITLES above: wireControls() runs in the boot block below
// and reaches both of these (via applySheetDefaults), so a `const`/`let`
// declared further down the file would still be in its temporal dead zone.
const MOBILE_MQ = window.matchMedia('(max-width: 720px)');
const isMobile = () => MOBILE_MQ.matches;
let satCount = 0;   // remembered so the stats pill can be re-rendered on resize

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
    buildSearchIndex();
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
// Which catalogue a mode needs. Tracker and Sky both plot the full satellite
// field — Sky just looks at it from the ground — so switching between them must
// not refetch ~12k element sets.
function datasetFor(m) {
  return m === 'reentry' ? 'reentry' : 'tracker';
}

function setMode(next) {
  mode = next;
  const reentry = next === 'reentry';
  const sky = next === 'sky';

  for (const id of ['tracker', 'reentry', 'sky']) {
    const on = next === id;
    document.body.classList.toggle(`mode-${id}`, on);
    $(`mode-${id}`).classList.toggle('active', on);
    $(`mode-${id}`).setAttribute('aria-selected', String(on));
  }
  $('panel-left-title').textContent = MODE_TITLES[next];

  // Sky mode drives its own camera from the same canvas, so the Earth view's
  // OrbitControls has to let go — otherwise one drag turns both cameras.
  controls.enabled = !sky;
  skyView.setActive(sky);
  if (sky) {
    skyView.setObserver(observer);
    skyView.setSelected(-1); // deselect() below clears the field's selection too
    ensureSkyCatalogues();
    updateSkyPanel();
  }
  // Both directions: entering sky mode must show the button in its real state,
  // and leaving it must reflect the sensor release setActive() just performed.
  syncSensorButton();

  deselect();
  reentryMarkers.setActive(reentry);
  if (!reentry) reentryEstimates = [];

  const dataset = datasetFor(next);
  if (dataset !== loadedDataset) {
    loadedDataset = dataset;
    if (reentry) loadReentry();
    else loadData(activeLayers);
  }
}

// ---- Sky mode ---------------------------------------------------------------
// The sky artifacts total ~100 KB and only Sky mode needs them, so they are
// fetched on first entry rather than at boot. Neither is fatal: the Sun, Moon,
// planets and satellites are computed live and still render without them, and
// the two are fetched independently so a missing figure file still leaves stars.
async function ensureSkyCatalogues() {
  if (skyLoadInFlight) return;

  // Tracked per artifact, not as one shared flag: they fail independently, and
  // a single flag would let a successful star load mark the whole thing done —
  // stranding the constellation lines as permanently missing with no retry.
  const wanted = [
    ['stars', './data/sky/stars.json', (d) => skyView.setStars(d), 'Star catalogue'],
    ['figures', './data/sky/constellations.json', (d) => skyView.setConstellations(d), 'Constellation lines'],
  ].filter(([key]) => !skyCatalogueReady[key]);
  if (!wanted.length) return;

  skyLoadInFlight = true;
  try {
    await Promise.all(wanted.map(async ([key, path, apply, what]) => {
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apply(await res.json());
        skyCatalogueReady[key] = true;
      } catch (err) {
        // Left false so the next entry into Sky mode tries this one again.
        console.warn(`${what} failed to load:`, err);
      }
    }));
  } finally {
    skyLoadInFlight = false;
  }

  if (!skyCatalogueReady.stars) {
    toast('Star catalogue unavailable — showing Sun, Moon, planets and satellites only.');
  }
  if (skyCatalogueReady.figures) {
    // Only meaningful once the figures exist; the checkbox starts checked.
    skyView.setConstellationsVisible($('sky-constellations').checked);
  }
}

function updateSkyPanel() {
  const has = !!observer;
  $('sky-prompt').classList.toggle('hidden', has);
  $('sky-body').classList.toggle('hidden', !has);
  if (!has) return;
  $('sky-where').textContent = fmtLatLon(observer);
  const { azimuth, altitude } = skyView.orientation;
  $('sky-facing').textContent = `${compass(azimuth)} ${Math.round(azimuth)}°`;
  $('sky-alt').textContent = `${Math.round(altitude)}°`;
  // Only offer the sensor control where the API exists at all — on a desktop
  // browser the button would be a dead end.
  $('sky-compass').classList.toggle('hidden', !skyView.deviceOrientationSupported);
}

// Reflect whether the sensors are currently driving the camera.
function syncSensorButton() {
  const on = skyView.isSensorDriven();
  $('sky-compass').classList.toggle('active', on);
  $('sky-compass').textContent = on ? 'Stop using device' : 'Point with device';
  $('sky-compass-note').classList.toggle('hidden', !on);
  // Drag is disabled while the sensors are in charge, so say so.
  $('sky-reset').disabled = on;
}

async function toggleDeviceOrientation() {
  if (skyView.isSensorDriven()) {
    skyView.disableDeviceOrientation();
  } else if (!await skyView.enableDeviceOrientation()) {
    // Three ways to land here: permission refused, no sensor, or the browser
    // only offers orientation relative to where the device started — which is
    // useless for aiming at the sky, so it is declined rather than faked.
    toast('Device orientation unavailable — permission refused, no compass, or this '
      + 'browser only reports relative orientation.');
  }
  syncSensorButton();
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
    buildSearchIndex();
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
  const sunDir = sunDirectionScene(date, sunDirScratch);
  setSunDirection(sunDir);

  // Selected-satellite readout + overlays.
  const sel = field.updateSelection(date);
  if (sel) updateReadout(sel);
  if (mode === 'reentry') updateReentryCountdown();

  if (mode === 'sky') {
    // The sky scene has no orbit target to follow and no Earth to frame; it
    // reads the field's live position buffer and draws from the ground.
    skyView.update(date, field, sunDir);
    skyView.render();
  } else {
    if (followSelected && sel) {
      controls.target.lerp(sel.scenePosition, 0.08);
    } else {
      controls.target.lerp(ORIGIN, 0.05);
    }
    controls.update();
    renderer.render(scene, camera);
  }

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
    if (mode === 'sky') updateSkyPanel();
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
      <span class="swatch"></span>
      <span class="lname">${layer.label}</span>
      <span class="lcount" data-count>—</span>`;
    // Set the swatch colour via CSSOM rather than an inline style attribute:
    // the page's CSP uses `style-src 'self'`, which blocks `style="…"` in markup
    // but permits DOM style assignment. `color` drives the currentColor glow.
    const swatch = row.querySelector('.swatch');
    swatch.style.background = layer.color;
    swatch.style.color = layer.color;
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

// ---- Satellite search -------------------------------------------------------
// A hand-rolled combobox, replacing a native <datalist>. The datalist looked
// fine on desktop Chrome and failed elsewhere: iOS Safari renders no suggestion
// UI for one at all, so on a phone the field silently did nothing, and where the
// popup did appear the browser anchored it itself — with `backdrop-filter` on
// the panel establishing a containing block, it landed well away from the input.
// A list the app renders and positions behaves identically everywhere, and can
// rank matches rather than relying on the browser's prefix matching.
//
// It also drops the old 4000-name cap: matching runs over the whole catalogue
// and only the top few results are built into DOM.
const SEARCH_LIMIT = 40;
// How far a pointer may travel between down and up and still count as a tap
// rather than a scroll. Matches the 6px the canvas click/drag test uses, with a
// little more slack for a thumb.
const TAP_SLOP = 10;
let searchNames = [];      // lower-cased names, parallel to field.records
let searchMatches = [];    // field indices currently offered
let searchActive = -1;     // index into searchMatches, or -1 for none
let searchPointer = null;  // { id, x, y } of an in-progress press on an option

// Lower-casing ~12k names on every keystroke is the one thing here that would
// actually cost something, so it happens once per catalogue load instead.
function buildSearchIndex() {
  searchNames = field.records.map((r) => r.name.toLowerCase());
  closeSearchResults();
}

// Prefix matches first, then matches anywhere in the name; alphabetical within
// each tier. Typing "iss" should offer ISS (ZARYA) before CASSIOPEIA.
function searchCandidates(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix = [];
  const anywhere = [];
  for (let i = 0; i < searchNames.length; i++) {
    const at = searchNames[i].indexOf(q);
    if (at === 0) prefix.push(i);
    else if (at > 0) anywhere.push(i);
  }
  const byName = (a, b) => searchNames[a].localeCompare(searchNames[b]);
  prefix.sort(byName);
  anywhere.sort(byName);
  return prefix.concat(anywhere).slice(0, SEARCH_LIMIT);
}

function renderSearchResults() {
  const list = $('search-results');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  searchMatches.forEach((recIdx, i) => {
    const li = document.createElement('li');
    li.id = `search-opt-${i}`;
    li.className = 'search-opt';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === searchActive));
    li.textContent = field.records[recIdx].name;
    // Commit on pointer *up*, and only if the pointer barely moved. Committing
    // on pointerdown (the obvious way to beat the blur that closes the list)
    // makes the list impossible to scroll on a phone: the first touch of a
    // swipe selects whatever is under the finger, so with 40 matches in a
    // 260px box most of them cannot be reached at all. Focus is instead held
    // by the mousedown handler in wireControls, which leaves the native scroll
    // gesture alone.
    li.addEventListener('pointerdown', (e) => {
      searchPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    li.addEventListener('pointerup', (e) => {
      const start = searchPointer;
      searchPointer = null;
      if (!start || start.id !== e.pointerId) return;
      // Moved too far to be a tap — that was a scroll, not a choice.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) return;
      commitSearch(i);
    });
    frag.appendChild(li);
  });
  list.appendChild(frag);
  syncSearchActive();
}

function syncSearchActive() {
  const list = $('search-results');
  [...list.children].forEach((li, i) => {
    const on = i === searchActive;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', String(on));
    if (on) li.scrollIntoView({ block: 'nearest' });
  });
  $('search').setAttribute(
    'aria-activedescendant', searchActive >= 0 ? `search-opt-${searchActive}` : '',
  );
}

// Anchor the list to the input's current rect. Fixed positioning against the
// viewport, so panel scrolling and clipping are irrelevant.
function positionSearchResults() {
  const r = $('search').getBoundingClientRect();
  const list = $('search-results');
  const below = window.innerHeight - r.bottom;
  list.style.left = `${r.left}px`;
  list.style.width = `${r.width}px`;
  // Flip above the field when there is more room there — on a phone in
  // landscape, or with the keyboard up, "below" can be a few pixels.
  if (below < 140 && r.top > below) {
    list.style.top = 'auto';
    list.style.bottom = `${window.innerHeight - r.top + 4}px`;
    list.style.maxHeight = `${Math.min(260, r.top - 8)}px`;
  } else {
    list.style.bottom = 'auto';
    list.style.top = `${r.bottom + 4}px`;
    list.style.maxHeight = `${Math.min(260, below - 8)}px`;
  }
}

function openSearchResults() {
  if (!searchMatches.length) return closeSearchResults();
  $('search-results').classList.remove('hidden');
  $('search').setAttribute('aria-expanded', 'true');
  positionSearchResults();
}

function closeSearchResults() {
  searchActive = -1;
  $('search-results').classList.add('hidden');
  $('search').setAttribute('aria-expanded', 'false');
  $('search').setAttribute('aria-activedescendant', '');
}

// Select the match at `i` (defaulting to the highlighted one, or the best one if
// the user just pressed Enter without arrowing).
function commitSearch(i = searchActive < 0 ? 0 : searchActive) {
  const recIdx = searchMatches[i];
  if (recIdx == null) return;
  $('search').value = field.records[recIdx].name;
  closeSearchResults();
  $('search').blur(); // on a phone, dismiss the keyboard so the sky is visible
  selectIndex(recIdx, true);
}

function onSearchInput() {
  searchMatches = searchCandidates($('search').value);
  searchActive = -1;
  renderSearchResults();
  openSearchResults();
}

function onSearchKeydown(e) {
  const open = !$('search-results').classList.contains('hidden');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) { onSearchInput(); return; }
    e.preventDefault();
    const n = searchMatches.length;
    // From "nothing highlighted", Down goes to the first and Up to the last.
    searchActive = e.key === 'ArrowDown'
      ? (searchActive >= n - 1 ? 0 : searchActive + 1)
      : (searchActive <= 0 ? n - 1 : searchActive - 1);
    syncSearchActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && searchMatches.length) commitSearch();
  } else if (e.key === 'Escape') {
    closeSearchResults();
  }
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
    // Sky mode has its own camera and point cloud, so it does its own raycast —
    // the Earth-scene one below would select whatever sat under the cursor in
    // the view that isn't on screen.
    if (mode === 'sky') {
      const hit = skyView.pick(e.clientX, e.clientY);
      if (hit >= 0) selectIndex(hit);
      else deselect();
      return;
    }
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const idx = field.raycast(raycaster);
    if (idx >= 0) selectIndex(idx);
  });

  // Search box.
  $('search').addEventListener('input', onSearchInput);
  $('search').addEventListener('keydown', onSearchKeydown);
  $('search').addEventListener('focus', () => { if ($('search').value) onSearchInput(); });
  $('search').addEventListener('blur', () => setTimeout(closeSearchResults, 0));
  // Hold focus in the input while a suggestion is being pressed, so the blur
  // above does not close the list out from under the press. `mousedown` is the
  // event that moves focus, and on a touch device it is a compatibility event
  // fired only after touchend — so preventing it keeps focus on desktop without
  // suppressing the native scroll gesture, which preventing `pointerdown` would.
  $('search-results').addEventListener('mousedown', (e) => e.preventDefault());
  // A cancelled press (the browser taking over for a scroll) is not a tap.
  $('search-results').addEventListener('pointercancel', () => { searchPointer = null; });
  // The list is anchored to the input's rect, so anything that moves the input
  // has to move the list. `true` catches scrolling inside the panel too.
  window.addEventListener('resize', () => {
    if (!$('search-results').classList.contains('hidden')) positionSearchResults();
  });
  window.addEventListener('scroll', () => {
    if (!$('search-results').classList.contains('hidden')) positionSearchResults();
  }, true);

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
  $('mode-sky').addEventListener('click', () => { if (mode !== 'sky') setMode('sky'); });
  $('sky-reset').addEventListener('click', () => {
    skyView.setOrientation({ azimuth: 180, altitude: 30 });
    skyView.setFov(65);
    updateSkyPanel();
  });
  $('sky-constellations').addEventListener('change', (e) => {
    skyView.setConstellationsVisible(e.target.checked);
  });
  $('sky-compass').addEventListener('click', toggleDeviceOrientation);
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

  // Panels collapse to a header. On a phone that header is the bottom-sheet
  // handle, so the whole thing is the tap target — a 24px button is a poor one
  // on a touch screen. The buttons inside keep their own meaning (× deselects
  // rather than collapsing), hence the guard.
  $('toggle-left').addEventListener('click', () => toggleSheet('panel-left'));
  $('toggle-right').addEventListener('click', () => toggleSheet('panel-right'));
  for (const id of ['panel-left', 'panel-right']) {
    $(id).querySelector('.panel-header').addEventListener('click', (e) => {
      // Mobile only. On desktop the header is a title bar, and swallowing
      // clicks on it — including on the satellite name in the selection
      // panel — would be a behaviour change this work is meant to avoid.
      // Keyboard users get the same control through the buttons above, which
      // is why the header is a convenience rather than the only route.
      if (!isMobile() || e.target.closest('button')) return;
      toggleSheet(id);
    });
  }
  MOBILE_MQ.addEventListener('change', applySheetDefaults);
  applySheetDefaults();
}

// ---- Bottom sheets (mobile) -------------------------------------------------
// Below the breakpoint the two panels dock to the bottom of the screen and only
// one is expanded at a time; above it they are the old floating cards and
// nothing here applies. See the mobile block in styles/main.css.
// (MOBILE_MQ / isMobile are declared with the boot-time state near the top.)

// The single place a sheet's collapsed state changes, so the toggle button's
// `aria-expanded` can never drift from what is actually on screen.
//
// The panel -> button mapping is derived inline rather than held in a
// module-level const: this runs during boot (wireControls -> applySheetDefaults),
// where anything declared further down the file is still in its temporal dead
// zone. That trap has now bitten this file four times.
function setSheetCollapsed(id, collapsed) {
  $(id).classList.toggle('collapsed', collapsed);
  const btn = $(id === 'panel-left' ? 'toggle-left' : 'toggle-right');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Expand' : 'Collapse';
  // Lets the mobile CSS lift the other handle clear of an expanded sheet.
  document.body.classList.toggle(
    'sheet-expanded',
    ['panel-left', 'panel-right'].some(
      (p) => !$(p).classList.contains('collapsed') && !$(p).classList.contains('hidden'),
    ),
  );
}

function openSheet(id) {
  setSheetCollapsed(id, false);
  // One at a time: the whole point of the change is that two open panels left
  // 13% of the viewport showing the sky.
  if (isMobile()) setSheetCollapsed(id === 'panel-left' ? 'panel-right' : 'panel-left', true);
}

function toggleSheet(id) {
  if ($(id).classList.contains('collapsed')) openSheet(id);
  else setSheetCollapsed(id, true);
}

// Called at boot and whenever the breakpoint is crossed (rotation, resize), so
// a phone starts with the sky visible and a desktop never inherits a collapsed
// panel from a narrow window.
function applySheetDefaults() {
  const mobile = isMobile();
  setSheetCollapsed('panel-left', mobile);
  setSheetCollapsed('panel-right', mobile);
  updateStats(satCount); // the pill uses a shorter form when space is tight
}

function selectIndex(idx, recenter = false) {
  const rec = field.select(idx);
  if (!rec) return;
  skyView.setSelected(idx); // ring the same object in the sky view
  $('panel-right').classList.remove('hidden');
  // Lets the mobile CSS stack the layers sheet above the selection sheet.
  document.body.classList.add('has-selection');
  // Selecting something is a request to see it, so open that sheet — which
  // collapses the other one.
  openSheet('panel-right');
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
  skyView.setSelected(-1);
  $('panel-right').classList.add('hidden');
  document.body.classList.remove('has-selection');
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
  satCount = n;
  // "13,080 satellites" is 110px of a 412px topbar. The short form keeps the
  // count on screen rather than dropping the pill entirely on a phone.
  if (!isMobile()) {
    $('stat-sats').textContent = `${n.toLocaleString()} satellites`;
  } else {
    $('stat-sats').textContent = n >= 1000
      ? `${(n / 1000).toFixed(1)}k sats`
      : `${n} sats`;
  }
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
  updatePasses();           // refresh for the new sat now (no-magnitude) so the
                            // panel never shows the previous sat's passes while
                            // the enrichment bucket is still being fetched
  const rec = await getEnrichment(norad);
  if (enrichReqNorad !== norad) return; // superseded by a newer selection
  selectedEnrichment = rec; // feeds apparent-magnitude in the visibility panel
  updatePasses();           // recompute now that the magnitude is known
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
  updatePasses();      // location changed — recompute upcoming passes
  skyView.setObserver(o); // ...and re-anchor the sky view's horizon
  if (mode === 'sky') updateSkyPanel();
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
  const result = predictPasses(satrec, observer, Date.now(), stdMag, { hours: 24 });
  renderPasses(result, est, stdMag != null);
  box.classList.remove('hidden');
}

function dayPrefix(d) {
  const now = new Date();
  const today = now.toDateString();
  // Advance by a calendar day (setDate), not +24h — the latter mislabels dates
  // across a daylight-saving transition.
  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  const tomorrow = tmr.toDateString();
  if (d.toDateString() === today) return '';
  if (d.toDateString() === tomorrow) return 'Tomorrow ';
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} `;
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// When a window's label is a real rise/set time, show the range. When it ran
// into a scan boundary, say so instead: the scan starts at "now", so a
// start-clipped window means the object is up and lit right now, and an
// end-clipped one continues past the 24 h horizon. Printing the boundary as an
// AOS/LOS would invent an event that never happened.
function passWhen(p) {
  // Clipped at both ends means the window covered every sample scanned, so the
  // only truthful statement is that it never ended within the horizon.
  if (p.startClipped && p.endClipped) return 'Now, and throughout the next 24 h';
  if (p.startClipped) return `Now – ${hhmm(p.visibleEnd)}`;
  const from = `${dayPrefix(new Date(p.visibleStart))}${hhmm(p.visibleStart)}`;
  if (p.endClipped) return `${from} onwards`;
  // A single-sample window (start === end) is a brief culmination/shadow-edge
  // sighting — show the one time rather than a "21:14–21:14" range. A genuine
  // two-sample (30 s) window keeps its range.
  if (p.visibleEnd === p.visibleStart) return `${dayPrefix(new Date(p.peakTime))}${hhmm(p.peakTime)}`;
  return `${from}–${hhmm(p.visibleEnd)}`;
}

// A permanently-above-the-horizon object (every GEO, some MEO/HEO) has no
// passes to list — only a fixed place in the sky and a question of whether it is
// ever lit against a dark sky. Say that, rather than dressing it up as a pass.
function standingNote(st, est) {
  const where = `${st.elevation.toFixed(0)}° ${compass(st.azimuth)}`;
  const head = `Always above the horizon, at ${where}`;
  if (!(st.darkMs > 0)) return `${head}. Never sunlit in a dark sky in the next 24 h.`;
  const hrs = (st.darkMs / 3600e3).toFixed(1);
  const lit = `${head} · sunlit in a dark sky for ${hrs} h in the next 24 h`;
  if (st.brightestMag != null) {
    return st.nakedEye
      ? `${lit}, at mag ${st.brightestMag.toFixed(1)}${est ? ' (est.)' : ''}.`
      : `${lit}, but too faint to see (mag ${st.brightestMag.toFixed(1)}${est ? ' est.' : ''}).`;
  }
  return st.nakedEye
    ? `${lit}. Brightness unknown.`
    : `${lit}, but too distant for a naked-eye sighting (no magnitude on record).`;
}

function renderPasses({ passes, total, geomVisible, unknownBrightness, alwaysUp, standing }, est, haveMag) {
  const list = $('passes-list');
  const note = $('passes-note');
  list.innerHTML = '';
  if (alwaysUp && standing) {
    note.textContent = standingNote(standing, est);
    return;
  }
  if (passes.length) {
    for (const p of passes) {
      const li = document.createElement('li');
      li.className = 'pass-row';
      const mag = p.peakMag != null
        ? ` · mag ${p.peakMag.toFixed(1)}${est ? ' (est.)' : ''}`
        : '';
      li.innerHTML =
        `<span class="pass-when">${escapeHtml(passWhen(p))}</span>` +
        `<span class="pass-meta">max ${p.peakElevation.toFixed(0)}° ${compass(p.peakAzimuth)}${mag}</span>`;
      list.appendChild(li);
    }
    note.textContent = 'Times in your local timezone · next 24 h.';
  } else {
    let msg;
    if (geomVisible > 0) {
      const n = `${geomVisible} sunlit pass${geomVisible === 1 ? '' : 'es'} in 24 h`;
      // Three distinct reasons, and only the first is a statement about a
      // magnitude we actually have. Claiming "too faint (mag > 6.5)" for an
      // object with no magnitude on record would be inventing the measurement.
      if (haveMag) msg = `${n}, but too faint to see (mag > 6.5).`;
      else if (unknownBrightness) msg = `${n}, but brightness unknown and too distant for a naked-eye sighting.`;
      else msg = `${n}, brightness unknown.`;
    } else if (total > 0) {
      msg = `${total} pass${total === 1 ? '' : 'es'} in 24 h, but none visible (daylight, twilight, or Earth's shadow).`;
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
  // Civil twilight: sunlit and up, but the sky is still bright enough that only
  // the brightest objects show. The pass list won't offer these windows, so the
  // badge shouldn't promise them either.
  twilight: { label: 'Twilight — only bright objects', cls: 'vis-twilight' },
  'below-horizon': { label: 'Below the horizon', cls: 'vis-below' },
};
const VIS_UNKNOWN = { label: 'Unknown', cls: 'vis-below' };

// Compute and render observer-relative visibility for the selected satellite.
function updateVisibility(sel, date) {
  if (!observer || !sel || !sel.eci) return;
  const sun = sunDirectionEci(date);
  const stdMag = selectedEnrichment && selectedEnrichment.stdMag != null ? selectedEnrichment.stdMag : null;
  const est = selectedEnrichment && selectedEnrichment.magSource === 'estimate';
  const v = computeVisibility(sel.eci, sel.gmst, observer, sun, stdMag);

  // Fall back rather than throw if computeVisibility ever gains a state the UI
  // doesn't know about — a missing badge shouldn't take the whole panel down.
  const s = VIS_STATE[v.state] || VIS_UNKNOWN;
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
