import { $, sleep, load, save, remove, esc, abortError, params } from './util.js';
import { Vision } from './vision.js';
import { Camera } from './camera.js';
import { Output } from './output.js';
import { calibrate } from './calibrate.js';
import { applyH, invertH, pointInQuad } from './geometry.js';
import { Light, LIGHT_DEFAULTS } from './light.js';
import { Paintings } from './paintings.js';
import { Voice } from './speech.js';
import { Performer, SegmentPerformer } from './perform.js';
import { SegmentLight, SEG_DEFAULTS } from './seglight.js';
import { generate, saveComposition, clearCompositions, usableSaved, savedCompositions, paintingHues, chromaPalettes } from './compose.js';

const VERSION = 'Segments · step 1';
const KEY_SETTINGS = 'gaze.settings';
const KEY_CALIB = 'gaze.calibration';
const KEY_READINGS = 'gaze.readings';
const VOICE_DEFAULTS = { voiceURI: null, rate: 0.95, pitch: 1, lang: 'en-US' };
const PERFORM_DEFAULTS = { kind: 'segments', movement: 'dissolve', pauseBetween: 4, speak: false };
const DEFAULTS = {
  v: 3, deviceId: null, camHeight: 1080, grid: '5x4', dotSize: 4, previewDim: 0.6,
  captureLight: 'black', light: { ...LIGHT_DEFAULTS },
  voice: { ...VOICE_DEFAULTS }, perform: { ...PERFORM_DEFAULTS }, links: {}, seg: { ...SEG_DEFAULTS },
};
const SEG_PARAMS = { k: 9, passes: 2, minFrac: 0.0012 };

const settings = { ...DEFAULTS, ...load(KEY_SETTINGS, {}) };
settings.light = { ...LIGHT_DEFAULTS, ...(settings.light || {}) };
settings.voice = { ...VOICE_DEFAULTS, ...(settings.voice || {}) };
settings.perform = { ...PERFORM_DEFAULTS, ...(settings.perform || {}) };
settings.links = { ...(settings.links || {}) };
settings.seg = { ...SEG_DEFAULTS, ...(settings.seg || {}) };
if ((settings.v || 1) < 2 && settings.dotSize === 2.5) settings.dotSize = DEFAULTS.dotSize; // old smaller default
settings.v = DEFAULTS.v;
const saveSettings = () => save(KEY_SETTINGS, settings);

const body = document.body;
const overlay = $('#overlay');
const output = new Output($('#out'));
const camera = new Camera($('#cam'));
const light = new Light($('#light'));
light.setParams(settings.light);
const paintings = new Paintings();
const voice = new Voice(settings.voice);
let readingsData = load(KEY_READINGS, null) || { files: [], paintings: [], readings: [] };
const performer = new Performer({
  light, voice, settings: settings.perform,
  regionFor: (stop) => paintingStopToScreen(stop),
  onStatus: (s) => renderPerfStatus(s),
});
const seglight = new SegmentLight($('#seg'));
const segPerformer = new SegmentPerformer({
  seglight, settings: settings.seg,
  makeNext: () => nextComposition(),
  onStatus: () => renderPerfStatus(),
});
let segState = null; // { entries, segAt } while segments are mapped onto the screen

// OpenCV.js runs in a background worker so its large download and start-up
// never freeze the page.
const vision = new Vision();
let visionState = 'loading';   // 'loading' | 'ready' | 'failed'

let calib = load(KEY_CALIB, null);   // the calibration in use
let lastResult = null;              // the latest attempt, shown on the result card
let mode = 'start';
let flashBack = 'camera';
let flashTimer = 0;
let abortCal = null;

// ------------------------------------------------------------------ modes

function setMode(m) {
  const prev = mode;
  mode = m;
  body.dataset.mode = m;
  if (m !== 'flash' && m !== 'capturing') output.black();
  if (PROJECTING.has(m)) { clearTimeout(toastTimer); $('#msg').classList.remove('show'); }
  if (prev === 'perform' && m !== 'perform') performer.stop({ quiet: true });
  if (prev === 'segments' && m !== 'segments') { segPerformer.stop({ quiet: true }); seglight.off(); }
  if (prev === 'segshow' && m !== 'segshow') seglight.off();
  if ((prev === 'light' || prev === 'perform') && m !== prev) light.off();
  if (m !== 'paintings') { edit.draft = []; edit.drag = null; edit.selected = null; }
  renderToolbar();
  renderStatus();
  renderCard();
  drawOverlay();
}

// ------------------------------------------------------------------ helpers

// Modes where the screen is the artwork: nothing else is ever drawn on it.
const PROJECTING = new Set(['perform', 'segments']);

let toastTimer = 0;
function toast(text, ms = 2800) {
  if (PROJECTING.has(mode)) return; // nothing is ever written on the wall during a performance
  const el = $('#msg');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function speak(text) {
  voice.speak(text);
}

function isFullscreen() {
  return !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches;
}

async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* not allowed here */ }
  try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ }
}

let wakeLock = null;
async function keepAwake() {
  try {
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* refused or unsupported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode !== 'start') keepAwake();
});

function cameraErrorText(e) {
  if (e?.name === 'NotAllowedError') return 'Camera permission was refused. Tap the icon left of the address bar, allow Camera, then reload.';
  if (e?.name === 'NotReadableError') return 'The camera is busy. Close other apps that use the camera and try again.';
  if (e?.name === 'InsecureContext') return e.message;
  return 'Could not open the camera: ' + (e?.message || e);
}

// Where the camera picture sits on screen (object-fit: contain).
function videoRect() {
  const vw = camera.width || 16;
  const vh = camera.height || 9;
  const s = Math.min(innerWidth / vw, innerHeight / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
}
const camToView = (u, v) => { const r = videoRect(); return [r.x + u * r.w, r.y + v * r.h]; };
const viewToCam = (x, y) => { const r = videoRect(); return [(x - r.x) / r.w, (y - r.y) / r.h]; };
const camAspect = () => (camera.width && camera.height ? camera.width / camera.height : 16 / 9);

// Why a saved calibration might not match the current setup.
function calibIssues(c) {
  if (!c) return [];
  const out = [];
  if (Math.abs(c.screen.w - output.w) > 2 || Math.abs(c.screen.h - output.h) > 2) {
    out.push(isFullscreen() ? 'screen size changed' : 'not fullscreen');
  }
  if (camera.running && !camera.sim) {
    if (c.cam.deviceId && camera.deviceId && c.cam.deviceId !== camera.deviceId) out.push('different camera');
    else if (Math.abs(c.cam.w / c.cam.h - camera.width / camera.height) > 0.02) out.push('camera shape changed');
  }
  return out;
}

function lockText(locks) {
  if (!locks) return [];
  const names = { exposure: 'Exposure', whiteBalance: 'White balance', focus: 'Focus' };
  return Object.entries(locks).map(([k, v]) => {
    if (v === 'locked') return [`${names[k]} locked`, 'ok'];
    if (v === 'failed') return [`${names[k]} would not lock`, 'warn'];
    return [`${names[k]} can't be locked`, 'warn'];
  });
}

function timeText(ms) {
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A region of the camera picture (centre u,v; radius as a fraction of the
// frame height) → an ellipse on the phone screen, through the calibration.
function cameraRegionToScreen(u, v, rv) {
  const H = calib.H;
  const s0 = applyH(H, u, v);
  const s1 = applyH(H, u + rv / camAspect(), v);
  const s2 = applyH(H, u, v + rv);
  return { center: s0, ax: [s1[0] - s0[0], s1[1] - s0[1]], ay: [s2[0] - s0[0], s2[1] - s0[1]] };
}

// A stop of a reading (painting coordinates) → an ellipse on the phone screen:
// painting → camera through the painting's corners, camera → screen through
// the calibration.
function paintingAspect(key, p) {
  const rp = readingsData.paintings.find((q) => q.key === key);
  if (rp?.aspect) return rp.aspect;
  if (p.image?.w) return p.image.w / p.image.h;
  const [w, h] = paintings.flatSize(p, camera.width || 1920, camera.height || 1080);
  return w / h;
}

function linkedPainting(key) {
  const id = settings.links[key];
  return id ? paintings.get(id) : null;
}

function paintingStopToScreen(stop) {
  const p = linkedPainting(stop.painting);
  if (!p || !calib?.H) return null;
  const P = paintings.toCamera(p);
  const A = paintingAspect(stop.painting, p);
  const toScreen = (x, y) => { const [u, v] = applyH(P, x, y); return applyH(calib.H, u, v); };
  const a = ((stop.angle || 0) * Math.PI) / 180;
  // A little randomness, so a reading never lands exactly the same way twice.
  const cx = stop.x + (Math.random() - 0.5) * 0.04 * stop.w;
  const cy = stop.y + (Math.random() - 0.5) * 0.04 * stop.h;
  const c = toScreen(cx, cy);
  const e1 = toScreen(cx + (Math.cos(a) * stop.w) / 2, cy + (Math.sin(a) * stop.w * A) / 2);
  const e2 = toScreen(cx - (Math.sin(a) * stop.h) / (2 * A), cy + (Math.cos(a) * stop.h) / 2);
  return { center: c, ax: [e1[0] - c[0], e1[1] - c[1]], ay: [e2[0] - c[0], e2[1] - c[1]] };
}

// ------------------------------------------------------------------ readings

async function loadReadings() {
  try {
    const idx = await (await fetch('readings/index.json', { cache: 'no-cache' })).json();
    const all = { files: idx.files || [], paintings: [], readings: [] };
    for (const f of all.files) {
      const j = await (await fetch(`readings/${f}`, { cache: 'no-cache' })).json();
      all.paintings.push(...(j.paintings || []));
      all.readings.push(...(j.readings || []));
    }
    readingsData = all;
    save(KEY_READINGS, all); // kept on the phone in case the network is down at the show
  } catch (e) {
    console.warn('Readings not loaded, using the saved copy', e);
  }
  autoLink();
  renderLinks();
  renderPerfStatus();
  startNote();
}

// Link each painting named in the readings to one of the phone's paintings:
// by name, or automatically when there is only one of each.
function autoLink() {
  let changed = false;
  for (const rp of readingsData.paintings) {
    if (linkedPainting(rp.key)) continue;
    const byName = paintings.list.find((p) => p.name.trim().toLowerCase() === String(rp.title || rp.key).toLowerCase());
    const only = paintings.list.length === 1 && readingsData.paintings.length === 1 ? paintings.list[0] : null;
    const pick = byName || only;
    if (pick) { settings.links[rp.key] = pick.id; changed = true; }
  }
  if (changed) saveSettings();
}

function renderLinks() {
  $('#readingsInfo').textContent = readingsData.readings.length
    ? `${readingsData.readings.length} readings loaded (${readingsData.files.join(', ')}). Link each painting below to one you marked on this phone.`
    : 'No readings loaded.';
  $('#links').innerHTML = readingsData.paintings.map((rp) => `
    <div class="link"><span>${esc(rp.title || rp.key)} →</span>
      <select data-link="${esc(rp.key)}">
        <option value="">(not linked)</option>
        ${paintings.list.map((p) => `<option value="${esc(p.id)}" ${settings.links[rp.key] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></div>`).join('');
}

function renderPerfStatus(s = { state: performer.state, ...(performer.now || {}) }) {
  const el = $('#perfStatus');
  if (!el) return;
  const kind = settings.perform.kind;
  $('#segControls').hidden = kind !== 'segments';
  $('#gazeControls').hidden = kind !== 'gaze';
  if (segPerformer.running) {
    const p = segPerformer.state === 'paused';
    el.textContent = `${p ? 'Paused · ' : ''}Composition ${segPerformer.count}${segPerformer.current?.at ? ' (saved)' : ''}.`;
    $('#pauseBtn').textContent = p ? 'Resume' : 'Pause';
    return;
  }
  if (s.state === 'stopped') el.textContent = 'Not playing.';
  else if (s.between) el.textContent = `${s.state === 'paused' ? 'Paused · ' : ''}Dark pause between readings.`;
  else if (s.title) el.textContent = `${s.state === 'paused' ? 'Paused · ' : ''}“${s.title}”, stop ${s.stop} of ${s.total}.`;
  else el.textContent = s.state === 'paused' ? 'Paused.' : 'Playing.';
  $('#pauseBtn').textContent = s.state === 'paused' ? 'Resume' : 'Pause';
}

async function startPerformance() {
  closePanel();
  if (!calib?.H) { toast('Calibrate first, so the light can find the wall.', 4000); return; }
  autoLink();
  const playable = readingsData.readings
    .map((r) => ({ ...r, stops: r.stops.filter((s) => linkedPainting(s.painting)) }))
    .filter((r) => r.stops.length >= 3);
  if (!playable.length) {
    toast(readingsData.readings.length
      ? 'Link the readings to a painting first: menu → Performance → Readings.'
      : 'No readings are loaded yet.', 5000);
    openPanel();
    return;
  }
  setMode('perform');
  camera.stop(); // not needed while performing; saves battery and heat
  renderCamInfo();
  performer.start(playable);
}

// ------------------------------------------------------------------ segments

// Cut one painting's image into segments (in the vision worker) and keep them.
async function findSegments(p) {
  if (!(await visionReady())) return null;
  const img = await paintings.imageData(p, 500);
  if (!img) return null;
  const r = await vision.withFrame('segment', img, SEG_PARAMS);
  await paintings.saveSegments(p, { w: r.w, h: r.h, n: r.n, ids: new Uint16Array(r.ids) }, SEG_PARAMS);
  return paintings.loadSegments(p);
}

// Every painting with an image, with its segments (found now if missing),
// mapped onto the phone screen through the calibration.
async function prepareSegments() {
  if (!calib?.Hinv) { toast('Calibrate first, so the colours can find the paintings.', 4000); return null; }
  const withImage = paintings.list.filter((p) => p.image);
  if (!withImage.length) { toast('Capture the paintings first: Paintings → Capture images.', 5000); return null; }
  const entries = [];
  for (const p of withImage) {
    let seg = await paintings.loadSegments(p);
    if (!seg) {
      toast(`Finding the segments of ${p.name}…`, 30000);
      seg = await findSegments(p);
    }
    if (seg) entries.push({ pid: p.id, seg, Pinv: invertH(paintings.toCamera(p)) });
  }
  $('#msg').classList.remove('show');
  if (!entries.length) { toast('Could not find segments. Try Capture images again.', 5000); return null; }
  seglight.buildMap(entries, calib.Hinv, output.w, output.h);
  const segAt = Object.fromEntries(entries.map((e) => [e.pid, e.seg.at]));
  segState = { entries, segAt, hues: [], palettes: null };
  await updatePalettes();
  return segState;
}

// Colours from the paintings' own hues (white-balanced) at the chosen chroma.
async function updatePalettes() {
  if (!segState) return;
  if (settings.seg.colours !== 'painting') { segState.palettes = null; return; }
  if (!segState.hues.length) {
    const hues = [];
    for (const e of segState.entries) {
      const img = await paintings.imageData(paintings.get(e.pid), 400);
      if (img) hues.push(...paintingHues(img));
    }
    // keep the strongest few, at least 20° apart
    hues.sort((a, b) => b.weight - a.weight);
    for (const h of hues) {
      if (segState.hues.length >= 7) break;
      if (segState.hues.every((k) => Math.min(Math.abs(k.hue - h.hue), 360 - Math.abs(k.hue - h.hue)) > 20)) segState.hues.push(h);
    }
  }
  let hues = segState.hues;
  if (hues.length === 1) {
    // One main hue: add its neighbours and its opposite, so there is still a palette.
    const h0 = hues[0];
    hues = [h0, { hue: (h0.hue + 35) % 360, L: h0.L }, { hue: (h0.hue + 325) % 360, L: h0.L }, { hue: (h0.hue + 180) % 360, L: 0.5 }];
  }
  segState.palettes = hues.length >= 2 ? chromaPalettes(hues, { chroma: settings.seg.chroma, count: 12, seed: Date.now() % 100000 }) : null;
}

function compositionPixels(comp) {
  return seglight.pixelsFor(comp, { neutral: settings.seg.neutral, strength: settings.seg.strength, neutralColor: settings.light.color });
}

let savedCursor = 0;
let lastPalette = null;
function nextComposition() {
  if (!segState) return null;
  const saved = usableSaved(segState.segAt);
  const src = settings.seg.source;
  let comp = null;
  if (saved.length && (src === 'saved' || (src === 'mix' && Math.random() < 0.35))) {
    comp = saved[savedCursor++ % saved.length];
  } else {
    comp = generate(segState.entries.map((e) => ({ pid: e.pid, seg: e.seg })), { cover: settings.seg.cover, avoid: lastPalette, palettes: segState.palettes });
  }
  lastPalette = comp.palette;
  return { comp, pixels: compositionPixels(comp) };
}

async function startSegments() {
  closePanel();
  const ok = await prepareSegments();
  if (!ok) return;
  setMode('segments');
  camera.stop();
  renderCamInfo();
  segPerformer.start();
}

// Project the segment outlines onto the paintings, to check how they sit.
async function showSegments() {
  closePanel();
  const ok = await prepareSegments();
  if (!ok) return;
  setMode('segshow');
  seglight.show(seglight.outlinePixels(), 0.6);
}

function renderSegStatus(msg = '') {
  const el = $('#segStatus');
  if (!el) return;
  const n = segState ? usableSaved(segState.segAt).length : savedCompositions().length;
  el.textContent = (msg ? msg + ' ' : '') + `${n} saved composition(s).`;
}

async function ensureCamera() {
  if (camera.running) return true;
  try { await startCamera(); return true; } catch (e) { toast(cameraErrorText(e), 6000); return false; }
}

// ------------------------------------------------------------------ rendering

const TOOLS = {
  camera: [['perform', 'Perform', 'primary'], ['calibrate', 'Calibrate'], ['paintings', 'Paintings'], ['testlight', 'Test light'], ['black', 'Black screen']],
  paintings: [['undo', 'Undo corner'], ['delete', 'Delete painting'], ['capture', 'Capture images', 'primary'], ['camera', 'Done']],
  testlight: [['paintings', 'Paintings'], ['camera', 'Done', 'primary']],
};

function renderToolbar() {
  const tools = (TOOLS[mode] || []).filter(([act]) => {
    if (act === 'undo') return edit.draft.length > 0;
    if (act === 'delete') return !!edit.selected;
    return true;
  });
  $('#tools').innerHTML = tools.map(([act, label, cls]) => `<button data-act="${act}" class="${cls || ''}">${esc(label)}</button>`).join('');
}

function renderStatus() {
  const chips = [];
  if (mode === 'paintings') {
    if (!edit.draft.length && !edit.selected) chips.push(['Tap the 4 corners of a painting · drag a corner to adjust', '']);
    else if (edit.draft.length) chips.push([`Corner ${edit.draft.length} of 4`, '']);
    else chips.push([`${paintings.get(edit.selected)?.name || 'Painting'} selected`, '']);
    const stale = paintings.list.filter((p) => !p.image || p.image.stale).length;
    if (paintings.list.length) chips.push([stale ? `${stale} painting(s) need Capture images` : 'Images captured', stale ? 'warn' : 'ok']);
  } else if (mode === 'testlight') {
    if (!calib) chips.push(['Calibrate first', 'bad']);
    chips.push(['Tap or drag on the view: the light appears there', '']);
  } else {
    if (!calib) chips.push(['Not calibrated', 'warn']);
    else {
      const issues = calibIssues(calib);
      if (issues.length) chips.push([`Calibration may be off: ${issues.join(', ')}`, 'bad']);
      else chips.push([`Calibrated · ${calib.rms.toFixed(1)} px`, 'ok']);
    }
    if (paintings.list.length) chips.push([`${paintings.list.length} painting(s)`, 'ok']);
    if (camera.locks) chips.push(...lockText(camera.locks));
    if (!isFullscreen()) chips.push(['Not fullscreen', 'warn']);
    if (camera.sim) chips.push(['Test mode: simulated camera', 'warn']);
  }
  $('#status').innerHTML = chips.map(([t, k]) => `<span class="chip ${k}">${esc(t)}</span>`).join('');

  $('#calStatus').textContent = calib
    ? `In use: ${timeText(calib.date)}, ${calib.inliers} dots, error ${calib.rms.toFixed(1)} px` +
      (calibIssues(calib).length ? ` (may be off: ${calibIssues(calib).join(', ')})` : '')
    : 'No calibration yet.';
  $('#screenInfo').textContent = `Screen ${output.w} × ${output.h} (×${output.dpr})` + (isFullscreen() ? ', fullscreen' : ', not fullscreen') + ` · light: ${light.mode}`;
}

function renderCamInfo() {
  if (!camera.running) { $('#camInfo').textContent = 'Camera is off.'; return; }
  const sup = camera.lockSupport();
  const can = Object.entries({ exposure: 'exposure', whiteBalance: 'white balance', focus: 'focus' })
    .map(([k, n]) => `${n} ${sup[k] ? '✓' : '✗'}`).join(', ');
  $('#camInfo').textContent = `${camera.label || 'Camera'} · ${camera.width} × ${camera.height}. Can lock: ${can}.`;
}

function renderCard() {
  const card = $('#card');
  if (mode !== 'result' || !lastResult) { card.innerHTML = ''; return; }
  const r = lastResult;
  const stats = [`Saw ${r.found ?? 0} of ${r.total ?? 0} dots`];
  if (r.rms != null) stats.push(`fit error ${r.rms.toFixed(1)} px`);
  if (r.checkErr != null) stats.push(`check error ${r.checkErr.toFixed(1)} px`);
  if (r.seconds != null) stats.push(`${Math.round(r.seconds)} s`);
  const locks = lockText(r.locks).map(([t, k]) => `<span class="chip ${k}">${esc(t)}</span>`).join('');
  const diag = [];
  if (r.flash?.seen) diag.push(`projector seen, delay ${(r.flash.latency / 1000).toFixed(2)} s, ${Math.round(r.flash.frac * 100)}% of view`);
  else if (r.flash) diag.push(`projector not seen (brightest change ${Math.round(r.flash.brightest)}, needed ${Math.round(r.flash.thresh)})`);
  if (r.brightest != null) diag.push(`brightest dot ${Math.round(r.brightest)} (needed ${Math.round(r.threshold)})`);
  if (r.noise != null) diag.push(`noise ${Math.round(r.noise)}`);
  if (r.dotR) diag.push(`dot radius ${Math.round(r.dotR)} px${r.dotAuto ? ' (enlarged for this camera)' : ''}`);
  if (r.cam) diag.push(`${r.cam.label || 'camera'} ${r.cam.w}×${r.cam.h}`);
  const lockInfo = r.lockInfo ? Object.entries(r.lockInfo).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
  card.innerHTML = `
    <div class="title ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ Calibrated' : '✗ Calibration failed'}</div>
    ${r.ok ? '' : `<p>${esc(r.reason || '')}</p>`}
    ${(r.hints || []).map((h) => `<p class="muted small">${esc(h)}</p>`).join('')}
    <p class="small">${esc(stats.join(' · '))}. <span class="muted">1 px is one phone-screen pixel, about ${(100 / output.w).toFixed(2)}% of the projected width.</span></p>
    ${r.warnings?.length ? `<ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${locks ? `<div class="chips" style="margin-top:6px">${locks}</div>` : ''}
    <details class="muted small" style="margin-top:6px" ${r.ok ? '' : 'open'}>
      <summary>Details</summary>
      ${esc(diag.join(' · '))}${lockInfo ? `<br>Camera controls: ${esc(lockInfo)}` : ''}
    </details>
    ${r.ok ? '<p class="small" style="margin-top:8px">Tap the camera view: a cross is projected onto that spot. Done shows the full view.</p>' : ''}
    ${!r.ok && calib ? '<p class="muted small">Your previous calibration is still in use.</p>' : ''}
    <div class="row">
      <button data-act="calibrate" class="${r.ok ? '' : 'primary'}">Redo</button>
      <button data-act="camera" class="${r.ok ? 'primary' : ''}">Done</button>
    </div>`;
}

async function renderReview(lightUsed) {
  const items = await Promise.all(paintings.list.map(async (p) => ({ p, url: await paintings.imageURL(p) })));
  const other = lightUsed === 'white' ? 'black' : 'white';
  $('#review').innerHTML = `
    <div class="title">Captured ${items.filter((i) => i.url).length} painting(s)</div>
    <p class="muted small">Flattened from one camera frame, taken with ${lightUsed === 'white' ? 'the projector lighting the paintings' : 'the projector black'}. These are what Claude will look at. You can rename them here.</p>
    <div class="thumbs">
      ${items.map(({ p, url }) => `
        <div class="thumb">
          ${url ? `<img src="${url}" alt="">` : '<div class="muted small">No image</div>'}
          <input data-rename="${esc(p.id)}" value="${esc(p.name)}" aria-label="Name">
          <span class="muted small">${p.image ? `${p.image.w} × ${p.image.h}` : ''}</span>
        </div>`).join('')}
    </div>
    <div class="row">
      <button data-act="capture">Retake</button>
      <button data-act="capture-${other}">Retake with ${other === 'white' ? 'projector light' : 'room light'}</button>
      <button data-act="testlight">Test light</button>
      <button data-act="camera" class="primary">Done</button>
    </div>`;
}

async function renderPaintList() {
  const el = $('#paintList');
  if (!paintings.list.length) { el.innerHTML = '<p class="muted small">No paintings yet.</p>'; return; }
  const items = await Promise.all(paintings.list.map(async (p) => ({ p, url: await paintings.imageURL(p) })));
  el.innerHTML = items.map(({ p, url }) => `
    <div class="item">
      ${url ? `<img src="${url}" alt="">` : '<img alt="">'}
      <div class="grow">
        <div>${esc(p.name)}</div>
        <div class="muted small">${!p.image ? 'no image yet' : p.image.stale ? 'corners changed: capture again' : `${p.image.source === 'photo' ? 'your photo' : 'camera'} ${p.image.w} × ${p.image.h}`}${p.seg ? ` · ${p.seg.n} segments` : ''}</div>
        <div class="segs">
          <button data-findseg="${esc(p.id)}" ${p.image ? '' : 'disabled'}>${p.seg ? 'Find segments again' : 'Find segments'}</button>
          <button data-photo="${esc(p.id)}">Use my photo</button>
        </div>
      </div>
      <button data-del="${esc(p.id)}">Delete</button>
    </div>`).join('');
}

function drawQuad(g, quad, { stroke, width = 2, dash = null }) {
  const pts = quad.map(([u, v]) => camToView(u, v));
  g.setLineDash(dash || []);
  g.lineWidth = width;
  g.strokeStyle = stroke;
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.stroke();
  g.setLineDash([]);
  return pts;
}

function drawLabel(g, text, x, y) {
  g.font = '600 13px system-ui, sans-serif';
  const w = g.measureText(text).width + 12;
  g.fillStyle = 'rgba(0, 0, 0, 0.6)';
  g.fillRect(x - w / 2, y - 11, w, 22);
  g.fillStyle = '#ecd6ab';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
  g.textAlign = 'start';
  g.textBaseline = 'alphabetic';
}

function drawLoupe(g, x, y) {
  const video = $('#cam');
  if (!camera.width) return;
  const R = 56;
  const Z = 3;
  const r = videoRect();
  const s = r.w / camera.width;
  const [u, v] = viewToCam(x, y);
  const half = R / (s * Z);
  let lx = x;
  let ly = y - 110;
  if (ly - R < 4) ly = y + 110;
  lx = Math.min(innerWidth - R - 4, Math.max(R + 4, lx));
  g.save();
  g.beginPath();
  g.arc(lx, ly, R, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#000';
  g.fillRect(lx - R, ly - R, R * 2, R * 2);
  g.drawImage(video, u * camera.width - half, v * camera.height - half, half * 2, half * 2, lx - R, ly - R, R * 2, R * 2);
  g.restore();
  g.strokeStyle = '#ecd6ab';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(lx, ly, R, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(lx - 10, ly); g.lineTo(lx + 10, ly);
  g.moveTo(lx, ly - 10); g.lineTo(lx, ly + 10);
  g.stroke();
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
    overlay.width = Math.round(W * dpr);
    overlay.height = Math.round(H * dpr);
  }
  const g = overlay.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!['camera', 'result', 'paintings', 'testlight'].includes(mode)) return;

  const c = mode === 'result' && lastResult ? lastResult : calib;

  // Without a fit yet: show where the camera saw the projector's white flash.
  if (mode === 'result' && c && !c.Hinv && c.flash?.bbox) {
    const [u0, v0, u1, v1] = c.flash.bbox;
    const [x0, y0] = camToView(u0, v0);
    const [x1, y1] = camToView(u1, v1);
    g.setLineDash([8, 6]);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(236, 214, 171, 0.9)';
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
    g.fillStyle = 'rgba(236, 214, 171, 0.95)';
    g.font = '13px system-ui, sans-serif';
    g.fillText('projector light seen here', x0 + 6, Math.max(14, y0 - 6));
  }

  // Outline of what the projector can reach, as seen by the camera.
  if (c?.Hinv && mode !== 'paintings') {
    const corners = [[0, 0], [c.screen.w, 0], [c.screen.w, c.screen.h], [0, c.screen.h]].map(([x, y]) => applyH(c.Hinv, x, y));
    drawQuad(g, corners, { stroke: 'rgba(236, 214, 171, 0.75)', dash: [8, 6] });
  }

  // Paintings.
  if (mode !== 'result') {
    for (const p of paintings.list) {
      const selected = mode === 'paintings' && edit.selected === p.id;
      const pts = drawQuad(g, p.corners, { stroke: selected ? '#ffffff' : 'rgba(255, 214, 140, 0.95)', width: selected ? 3 : 2 });
      const cx = pts.reduce((a, q) => a + q[0], 0) / 4;
      const cy = pts.reduce((a, q) => a + q[1], 0) / 4;
      drawLabel(g, p.name, cx, cy);
      if (mode === 'paintings') {
        for (const [x, y] of pts) {
          g.fillStyle = 'rgba(0, 0, 0, 0.5)';
          g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#ffd68c'; g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
        }
      }
    }
  }

  if (mode === 'paintings' && edit.draft.length) {
    const pts = edit.draft.map(([u, v]) => camToView(u, v));
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    g.setLineDash([]);
    pts.forEach(([x, y], i) => {
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000';
      g.font = '600 10px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y);
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    });
  }

  if (mode === 'paintings' && edit.drag) drawLoupe(g, edit.drag.x, edit.drag.y);

  if (mode === 'testlight' && test.down) {
    const { x, y, r } = test.down;
    g.strokeStyle = 'rgba(255, 241, 220, 0.9)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, Math.max(6, r), 0, Math.PI * 2); g.stroke();
  }

  if (mode !== 'result' || !c?.points) return;
  for (const p of c.points) {
    if (p.c) {
      const [x, y] = camToView(p.c[0], p.c[1]);
      g.lineWidth = 2.5;
      g.strokeStyle = p.inlier || !c.H ? '#67d184' : '#f07366';
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.stroke();
    } else if (c.Hinv) {
      const [u, v] = applyH(c.Hinv, p.s[0], p.s[1]);
      const [x, y] = camToView(u, v);
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(200, 200, 200, 0.7)';
      g.beginPath();
      g.moveTo(x - 5, y - 5); g.lineTo(x + 5, y + 5);
      g.moveTo(x + 5, y - 5); g.lineTo(x - 5, y + 5);
      g.stroke();
    }
  }
  for (const p of c.checks || []) {
    if (!p.c) continue;
    const [x, y] = camToView(p.c[0], p.c[1]);
    g.fillStyle = '#ecd6ab';
    g.fillRect(x - 4, y - 4, 8, 8);
  }
}

// ------------------------------------------------------------------ camera

async function fillDevices() {
  const sel = $('#setDevice');
  let devices = [];
  try { devices = await camera.listDevices(); } catch { /* ignore */ }
  sel.innerHTML = devices.map((d, i) =>
    `<option value="${esc(d.deviceId)}">${esc(d.label || `Camera ${i + 1}`)}</option>`).join('');
  sel.value = camera.deviceId || '';
}

async function startCamera() {
  await camera.start({ deviceId: settings.deviceId, height: settings.camHeight });
  if (!camera.sim && camera.deviceId) { settings.deviceId = camera.deviceId; saveSettings(); }
  await fillDevices();
  renderCamInfo();
  renderStatus();
  drawOverlay();
}

camera.onended = () => {
  toast('The camera stopped. Open the menu and pick the camera again.', 5000);
  renderCamInfo();
};
$('#cam').addEventListener('resize', () => { drawOverlay(); renderStatus(); renderCamInfo(); });

async function visionReady() {
  try {
    if (visionState !== 'ready') toast('Loading the vision library…', 90000);
    await vision.ready;
    $('#msg').classList.remove('show');
    return true;
  } catch {
    toast('The vision library (OpenCV.js) did not load. Check the internet and reload.', 6000);
    return false;
  }
}

// ------------------------------------------------------------------ calibration

async function runCalibration() {
  if (mode === 'calibrating') return;
  closePanel();
  if (!(await visionReady())) return;
  if (!camera.running) {
    try { await startCamera(); } catch (e) { toast(cameraErrorText(e), 6000); return; }
  }

  abortCal = new AbortController();
  const { signal } = abortCal;
  setMode('calibrating');
  try {
    for (let i = 3; i > 0; i--) {
      output.message(`Calibrating in ${i}`, 'Step out of the camera’s view · tap to cancel');
      await sleep(1000);
      if (signal.aborted) throw abortError();
    }
    output.black();
    // Let the camera settle on the dark scene, then freeze it.
    await camera.unlock();
    await sleep(1500);
    if (signal.aborted) throw abortError();
    await camera.lock();
    await sleep(500);
    const [cols, rows] = settings.grid.split('x').map(Number);
    const dotR = (settings.dotSize / 100) * Math.min(output.w, output.h);
    lastResult = await calibrate({ vision, camera, output, cols, rows, dotR, signal });
    lastResult.locks = camera.locks;
    lastResult.lockValues = camera.lockedValues;
    lastResult.lockInfo = camera.lockInfo;
  } catch (e) {
    abortCal = null;
    if (e.name === 'AbortError') {
      setMode('camera');
      toast('Calibration cancelled.');
      return;
    }
    console.error(e);
    lastResult = { ok: false, reason: 'Something went wrong: ' + e.message, found: 0, total: 0 };
  }
  abortCal = null;
  if (lastResult.ok) {
    calib = lastResult;
    save(KEY_CALIB, calib);
  }
  speak(lastResult.ok ? 'Calibration complete.' : 'Calibration failed.');
  setMode('result');
}

// ------------------------------------------------------------------ paintings: corner editing

const edit = { draft: [], drag: null, selected: null };
const HIT = 26; // px, how close a tap must be to grab a corner

function hitCorner(x, y) {
  let best = null;
  let bestD = HIT;
  for (const p of paintings.list) {
    p.corners.forEach(([u, v], i) => {
      const [cx, cy] = camToView(u, v);
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestD) { bestD = d; best = { painting: p, index: i }; }
    });
  }
  edit.draft.forEach(([u, v], i) => {
    const [cx, cy] = camToView(u, v);
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD) { bestD = d; best = { draft: true, index: i }; }
  });
  return best;
}

function clampCam([u, v]) { return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))]; }

function editDown(e) {
  const x = e.clientX;
  const y = e.clientY;
  const r = videoRect();
  if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;
  const hit = hitCorner(x, y);
  if (hit) {
    edit.drag = { ...hit, x, y, id: e.pointerId };
  } else if (!edit.draft.length) {
    const cam = viewToCam(x, y);
    const inside = paintings.list.find((p) => pointInQuad(cam, p.corners));
    if (inside) { edit.selected = inside.id; renderToolbar(); renderStatus(); drawOverlay(); return; }
    if (edit.selected) { edit.selected = null; renderToolbar(); renderStatus(); drawOverlay(); return; }
    edit.draft.push(clampCam(cam));
    edit.drag = { draft: true, index: edit.draft.length - 1, x, y, id: e.pointerId };
  } else {
    edit.draft.push(clampCam(viewToCam(x, y)));
    edit.drag = { draft: true, index: edit.draft.length - 1, x, y, id: e.pointerId };
  }
  overlay.setPointerCapture?.(e.pointerId);
  renderToolbar();
  renderStatus();
  drawOverlay();
}

function editMove(e) {
  if (!edit.drag || e.pointerId !== edit.drag.id) return;
  edit.drag.x = e.clientX;
  edit.drag.y = e.clientY;
  const cam = clampCam(viewToCam(e.clientX, e.clientY));
  if (edit.drag.draft) edit.draft[edit.drag.index] = cam;
  else edit.drag.painting.corners[edit.drag.index] = cam;
  drawOverlay();
}

function editUp(e) {
  if (!edit.drag || e.pointerId !== edit.drag.id) return;
  const d = edit.drag;
  edit.drag = null;
  if (!d.draft) paintings.cornersChanged(d.painting, camAspect());
  if (edit.draft.length === 4) {
    const p = paintings.add(edit.draft, camAspect());
    edit.draft = [];
    toast(`${p.name} added. Tap 4 more corners for another painting, or Capture images.`, 3500);
  }
  renderToolbar();
  renderStatus();
  drawOverlay();
}

// ------------------------------------------------------------------ paintings: capture

async function captureImages(lightUsed = settings.captureLight) {
  closePanel();
  if (!paintings.list.length) { toast('Tap the 4 corners of a painting first.'); setMode('paintings'); return; }
  if (!(await visionReady())) return;
  if (!camera.running) {
    try { await startCamera(); } catch (e) { toast(cameraErrorText(e), 6000); return; }
  }
  setMode('capturing');
  if (lightUsed === 'white') output.fill(settings.light.color || '#fff1dc');
  else output.black();
  // Give the projector time to change and the camera time to expose for the paintings.
  await camera.unlock();
  await sleep(2200);
  await camera.nextFrame();
  const img = camera.grab(4096);
  const quads = paintings.list.map((p) => {
    const [w, h] = paintings.flatSize(p, img.width, img.height);
    return { corners: p.corners.map(([u, v]) => [u * img.width, v * img.height]), w, h };
  });
  try {
    const flat = await vision.withFrame('warp', img, { quads });
    for (let i = 0; i < flat.length; i++) await paintings.setImage(paintings.list[i], flat[i]);
  } catch (e) {
    console.error(e);
    toast('Could not flatten the paintings: ' + e.message, 6000);
    setMode('paintings');
    return;
  }
  output.black();
  await renderReview(lightUsed);
  setMode('review');
}

$('#review').addEventListener('change', (e) => {
  const id = e.target?.dataset?.rename;
  if (id) { paintings.rename(id, e.target.value); renderPaintList(); }
});

let photoFor = null;
$('#paintList').addEventListener('click', async (e) => {
  const d = e.target?.dataset || {};
  if (d.del) {
    const p = paintings.get(d.del);
    if (p && confirm(`Delete ${p.name}?`)) { paintings.remove(d.del); renderPaintList(); drawOverlay(); renderStatus(); }
  } else if (d.findseg) {
    const p = paintings.get(d.findseg);
    if (!p) return;
    e.target.disabled = true;
    e.target.textContent = 'Finding…';
    const seg = await findSegments(p);
    segState = null;
    renderPaintList();
    renderSegStatus(seg ? `${p.name}: ${seg.n} segments.` : 'Could not find segments.');
  } else if (d.photo) {
    photoFor = d.photo;
    $('#photoInput').click();
  }
});
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const p = photoFor && paintings.get(photoFor);
  e.target.value = '';
  if (!file || !p) return;
  try {
    await paintings.setPhoto(p, file);
    const seg = await findSegments(p);
    segState = null;
    renderPaintList();
    renderSegStatus(seg ? `${p.name}: your photo, ${seg.n} segments.` : '');
  } catch (err) {
    toast('Could not use that photo: ' + err.message, 5000);
  }
});

// ------------------------------------------------------------------ test light

const test = { down: null, lastR: null };
let lightBack = 'testlight';

function testDown(e) {
  if (!calib?.H) { toast('Calibrate first, then the light can find the wall.'); return; }
  const r = videoRect();
  if (e.clientX < r.x || e.clientX > r.x + r.w || e.clientY < r.y || e.clientY > r.y + r.h) return;
  test.down = { x: e.clientX, y: e.clientY, r: 0, id: e.pointerId };
  overlay.setPointerCapture?.(e.pointerId);
  drawOverlay();
}

function testMove(e) {
  if (!test.down || e.pointerId !== test.down.id) return;
  test.down.r = Math.hypot(e.clientX - test.down.x, e.clientY - test.down.y);
  drawOverlay();
}

function testUp(e) {
  if (!test.down || e.pointerId !== test.down.id) return;
  const d = test.down;
  test.down = null;
  const r = videoRect();
  const [u, v] = viewToCam(d.x, d.y);
  const rv = d.r > 12 ? d.r / r.h : 0.06; // a plain tap gives a medium spot
  const region = cameraRegionToScreen(u, v, rv);
  const [sx, sy] = region.center;
  if (sx < -20 || sy < -20 || sx > output.w + 20 || sy > output.h + 20) {
    toast('That spot is outside what the projector can reach.');
    drawOverlay();
    return;
  }
  test.lastR = Math.sqrt(Math.hypot(...region.ax) * Math.hypot(...region.ay));
  showLight(region, 'testlight');
}

function showLight(region, back) {
  lightBack = back;
  if (mode !== 'light') {
    setMode('light');
    toast('Tap to move the light · double-tap to go back', 2500);
  }
  light.show(region);
}

// In light mode the phone screen is the projection: tap where the light should go.
let lastTap = null;
let tapTimer = 0;
$('#light').addEventListener('pointerup', (e) => {
  if (mode !== 'light') return;
  const now = performance.now();
  if (lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 50) {
    clearTimeout(tapTimer);
    lastTap = null;
    light.clear({ transition: 0.8 });
    setTimeout(() => { if (mode === 'light') setMode(lightBack); }, 850);
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  const { clientX: x, clientY: y } = e;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    const R = test.lastR || Math.min(output.w, output.h) * 0.09;
    light.show({ center: [x, y], ax: [R, 0], ay: [0, R] });
  }, 330);
});

// ------------------------------------------------------------------ tap check (cross)

function flashCross(x, y) {
  if (mode !== 'flash') flashBack = mode;
  setMode('flash');
  output.cross(x, y);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setMode(flashBack), 2500);
}

function crossDown(e) {
  const c = mode === 'result' && lastResult?.ok ? lastResult : calib;
  if (!c?.H) { toast('Calibrate first, then tap the view to test it.'); return; }
  const [u, v] = viewToCam(e.clientX, e.clientY);
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const [x, y] = applyH(c.H, u, v);
  if (x < 0 || y < 0 || x > output.w || y > output.h) {
    toast('That spot is outside what the projector can reach.');
    return;
  }
  flashCross(x, y);
}

// ------------------------------------------------------------------ pointer routing

overlay.addEventListener('pointerdown', (e) => {
  if (mode === 'paintings') editDown(e);
  else if (mode === 'testlight') testDown(e);
  else if (mode === 'camera' || mode === 'result') crossDown(e);
});
overlay.addEventListener('pointermove', (e) => {
  if (mode === 'paintings') editMove(e);
  else if (mode === 'testlight') testMove(e);
});
overlay.addEventListener('pointerup', (e) => {
  if (mode === 'paintings') editUp(e);
  else if (mode === 'testlight') testUp(e);
});
overlay.addEventListener('pointercancel', (e) => {
  if (mode === 'paintings') editUp(e);
  test.down = null;
});

// Tap the projected segment outlines to go back.
$('#seg').addEventListener('pointerup', () => {
  if (mode === 'segshow') { setMode('camera'); ensureCamera(); }
});

$('#out').addEventListener('pointerdown', () => {
  if (mode === 'calibrating') abortCal?.abort();
  else if (mode === 'flash') { clearTimeout(flashTimer); setMode(flashBack); }
});

// ------------------------------------------------------------------ menu

function openPanel() {
  $('#panel').hidden = false;
  autoLink();
  renderStatus(); renderCamInfo(); renderPaintList(); renderLinks(); renderPerfStatus(); fillVoices(); renderSegStatus();
}
function closePanel() { $('#panel').hidden = true; }
$('#hotspot').addEventListener('click', () => ($('#panel').hidden ? openPanel() : closePanel()));

const actions = {
  calibrate: runCalibration,
  camera: () => { closePanel(); setMode('camera'); ensureCamera(); },
  black: () => { closePanel(); setMode('black'); toast('Tap the top-right corner for the menu.', 2000); },
  paintings: () => { closePanel(); setMode('paintings'); ensureCamera(); },
  testlight: () => { closePanel(); setMode('testlight'); ensureCamera(); },
  perform: () => (settings.perform.kind === 'gaze' ? startPerformance() : startSegments()),
  pause: () => {
    const p = segPerformer.running ? segPerformer : performer;
    if (p.state === 'paused') p.resume(); else p.pause();
  },
  next: () => (segPerformer.running ? segPerformer.next() : performer.nextStop()),
  nextstop: () => performer.nextStop(),
  nextreading: () => performer.nextReading(),
  stopperform: () => {
    const wasSeg = segPerformer.running;
    performer.stop();
    segPerformer.stop();
    closePanel();
    setTimeout(() => { if (PROJECTING.has(mode)) { setMode('camera'); ensureCamera(); } }, wasSeg ? 300 : 1600);
  },
  savecomp: () => {
    if (!segPerformer.running || !segPerformer.current || !segState) { renderSegStatus('Start a Segments performance first.'); return; }
    saveComposition(segPerformer.current, segState.segAt);
    renderSegStatus('Saved ♥.');
  },
  clearcomps: () => { if (confirm('Delete all saved compositions?')) { clearCompositions(); renderSegStatus('Cleared.'); } },
  showsegs: showSegments,
  reloadreadings: () => loadReadings().then(() => toast(`${readingsData.readings.length} readings loaded.`)),
  capture: () => captureImages(),
  'capture-white': () => { settings.captureLight = 'white'; saveSettings(); $('#setCapLight').value = 'white'; captureImages('white'); },
  'capture-black': () => { settings.captureLight = 'black'; saveSettings(); $('#setCapLight').value = 'black'; captureImages('black'); },
  undo: () => { edit.draft.pop(); renderToolbar(); renderStatus(); drawOverlay(); },
  delete: () => {
    const p = paintings.get(edit.selected);
    if (p && confirm(`Delete ${p.name}?`)) { paintings.remove(p.id); edit.selected = null; renderToolbar(); renderStatus(); drawOverlay(); }
  },
  forget: () => {
    if (!calib) return;
    if (!confirm('Forget the saved calibration?')) return;
    calib = null;
    remove(KEY_CALIB);
    renderStatus();
    drawOverlay();
  },
  warmwhite: () => setLight({ color: LIGHT_DEFAULTS.color }),
  fullscreen: async () => { await enterFullscreen(); renderStatus(); },
  voicetest: () => speak('This is the narration voice. If you can hear me, sound is working.'),
  reload: () => location.reload(),
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) actions[b.dataset.act]();
});

function setLight(p) {
  Object.assign(settings.light, p);
  light.setParams(settings.light);
  saveSettings();
  syncLightControls();
}

const LIGHT_FMT = {
  brightness: (v) => `${Math.round(v * 100)}%`,
  size: (v) => `${Math.round(v * 100)}%`,
  softness: (v) => `${Math.round(v * 100)}%`,
  falloff: (v) => `${Math.round(v * 100)}%`,
  transition: (v) => `${(+v).toFixed(1)} s`,
};

function syncLightControls() {
  for (const el of document.querySelectorAll('[data-light]')) {
    const k = el.dataset.light;
    el.value = settings.light[k];
    const o = $(`#o-${k}`);
    if (o) o.textContent = LIGHT_FMT[k](settings.light[k]);
  }
  $('#setColor').value = settings.light.color;
}

function fillVoices() {
  const sel = $('#setVoice');
  const list = voice.list();
  sel.innerHTML = list.length
    ? list.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('')
    : '<option value="">Phone default voice</option>';
  const cur = voice.pick();
  if (cur) sel.value = cur.voiceURI;
}
voice.onvoices = () => fillVoices();

function bindSettings() {
  // What to perform
  const kind = $('#setKind');
  kind.value = settings.perform.kind;
  kind.addEventListener('change', () => { settings.perform.kind = kind.value; saveSettings(); renderPerfStatus(); });
  const speak = $('#setSpeak');
  speak.checked = !!settings.perform.speak;
  speak.addEventListener('change', () => { settings.perform.speak = speak.checked; saveSettings(); });

  // Segments
  const SEG_FMT = {
    hold: (v) => `${Math.round(v)} s`, fade: (v) => `${(+v).toFixed(1)} s`,
    cover: (v) => `${Math.round(v * 100)}%`, neutral: (v) => `${Math.round(v * 100)}%`, strength: (v) => `${Math.round(v * 100)}%`,
  };
  for (const el of document.querySelectorAll('[data-seg]')) {
    const k = el.dataset.seg;
    const out = () => { $(`#o-${k}`).textContent = SEG_FMT[k](settings.seg[k]); };
    el.value = settings.seg[k];
    out();
    el.addEventListener('input', () => { settings.seg[k] = +el.value; out(); saveSettings(); });
    // Brightness changes show at once on the current composition.
    if (k === 'neutral' || k === 'strength') {
      el.addEventListener('change', () => { if (segPerformer.running && segPerformer.current) seglight.show(compositionPixels(segPerformer.current), 0.4); });
    }
  }
  const srcSel = $('#setSource');
  srcSel.value = settings.seg.source;
  srcSel.addEventListener('change', () => { settings.seg.source = srcSel.value; saveSettings(); });
  const colSel = $('#setColours');
  colSel.value = settings.seg.colours;
  colSel.addEventListener('change', () => { settings.seg.colours = colSel.value; saveSettings(); updatePalettes(); $('#chromaRow').hidden = colSel.value !== 'painting'; });
  $('#chromaRow').hidden = settings.seg.colours !== 'painting';
  const chroma = $('#setChroma');
  const chromaOut = () => { $('#o-chroma').textContent = `${Math.round(settings.seg.chroma * 100)}%`; };
  chroma.value = settings.seg.chroma;
  chromaOut();
  chroma.addEventListener('input', () => { settings.seg.chroma = +chroma.value; chromaOut(); saveSettings(); });
  chroma.addEventListener('change', () => updatePalettes());
  renderSegStatus();

  // Gaze
  const mv = $('#setMovement');
  mv.value = settings.perform.movement;
  mv.addEventListener('change', () => { settings.perform.movement = mv.value; saveSettings(); });
  const pb = $('#setPauseBetween');
  const pbOut = () => { $('#o-pauseBetween').textContent = `${settings.perform.pauseBetween} s`; };
  pb.value = settings.perform.pauseBetween;
  pbOut();
  pb.addEventListener('input', () => { settings.perform.pauseBetween = +pb.value; pbOut(); saveSettings(); });
  $('#links').addEventListener('change', (e) => {
    const k = e.target?.dataset?.link;
    if (k == null) return;
    settings.links[k] = e.target.value || null;
    saveSettings();
  });

  // Voice
  $('#setVoice').addEventListener('change', (e) => {
    const v = voice.list().find((x) => x.voiceURI === e.target.value);
    settings.voice.voiceURI = e.target.value || null;
    if (v) settings.voice.lang = v.lang;
    saveSettings();
  });
  for (const [id, key] of [['#setRate', 'rate'], ['#setPitch', 'pitch']]) {
    const el = $(id);
    const out = () => { $(`#o-${key}`).textContent = `${Math.round(settings.voice[key] * 100)}%`; };
    el.value = settings.voice[key];
    out();
    el.addEventListener('input', () => { settings.voice[key] = +el.value; out(); saveSettings(); });
  }
  fillVoices();

  for (const el of document.querySelectorAll('[data-light]')) {
    el.addEventListener('input', () => setLight({ [el.dataset.light]: +el.value }));
  }
  $('#setColor').addEventListener('input', (e) => setLight({ color: e.target.value }));
  syncLightControls();

  const cap = $('#setCapLight');
  cap.value = settings.captureLight;
  cap.addEventListener('change', () => { settings.captureLight = cap.value; saveSettings(); });

  const grid = $('#setGrid');
  grid.value = settings.grid;
  grid.addEventListener('change', () => { settings.grid = grid.value; saveSettings(); });

  const dot = $('#setDot');
  const dotOut = $('#dotOut');
  dot.value = settings.dotSize;
  dotOut.textContent = `${settings.dotSize}%`;
  let previewTimer = 0;
  dot.addEventListener('input', () => {
    settings.dotSize = +dot.value;
    dotOut.textContent = `${settings.dotSize}%`;
    saveSettings();
    // Show the dot size on the wall for a moment.
    if (mode !== 'flash') flashBack = mode;
    body.dataset.mode = 'flash';
    output.dot(output.w / 2, output.h / 2, (settings.dotSize / 100) * Math.min(output.w, output.h));
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => setMode(flashBack), 900);
  });

  const dim = $('#setDim');
  const dimOut = $('#dimOut');
  const applyDim = () => {
    document.documentElement.style.setProperty('--dim', settings.previewDim);
    dimOut.textContent = `${Math.round(settings.previewDim * 100)}%`;
  };
  dim.value = settings.previewDim;
  applyDim();
  dim.addEventListener('input', () => { settings.previewDim = +dim.value; applyDim(); saveSettings(); });

  const res = $('#setRes');
  res.value = String(settings.camHeight);
  res.addEventListener('change', async () => {
    settings.camHeight = +res.value;
    saveSettings();
    try { await startCamera(); } catch (e) { toast(cameraErrorText(e), 6000); }
  });

  const dev = $('#setDevice');
  dev.addEventListener('change', async () => {
    settings.deviceId = dev.value || null;
    saveSettings();
    try { await startCamera(); } catch (e) { toast(cameraErrorText(e), 6000); }
    if (calib && calibIssues(calib).length) toast('This camera differs from the one used for calibration. Recalibrate.', 4000);
  });
}

// ------------------------------------------------------------------ start

output.onresize = () => {
  if (mode === 'calibrating') abortCal?.abort();
  renderStatus();
  drawOverlay();
};

let startExtra = params.has('sim') ? 'Test mode: the camera is simulated.' : '';
function startNote(extra = startExtra) {
  startExtra = extra;
  const parts = [];
  if (visionState === 'loading') parts.push('Loading the vision library…');
  if (visionState === 'ready') parts.push('Vision library ready.');
  if (visionState === 'failed') parts.push('The vision library did not load. Check the internet and reload.');
  if (calib) parts.push(`Saved calibration from ${timeText(calib.date)}.`);
  if (paintings.list.length) parts.push(`${paintings.list.length} painting(s) saved.`);
  if (readingsData.readings.length) parts.push(`${readingsData.readings.length} readings ready.`);
  if (extra) parts.push(extra);
  $('#startNote').textContent = parts.join(' ');
}

vision.ready.then(
  (info) => { visionState = 'ready'; console.info('OpenCV ready in', info?.ms, 'ms'); startNote(); },
  (e) => { visionState = 'failed'; console.error(e); startNote(); },
);

$('#startBtn').addEventListener('click', async () => {
  // Speech needs a first call inside a tap before it works later on Android.
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* no speech */ }
  $('#startBtn').disabled = true;
  await enterFullscreen();
  keepAwake();
  try {
    await startCamera();
  } catch (e) {
    $('#startBtn').disabled = false;
    startNote(cameraErrorText(e));
    return;
  }
  setMode('camera');
});

$('#ver').textContent = VERSION;
bindSettings();
startNote();
setMode('start');
loadReadings();

// For testing from the browser console.
window.gaze = {
  settings, camera, output, vision, light, paintings, voice, performer,
  get calib() { return calib; },
  get lastResult() { return lastResult; },
  get mode() { return mode; },
  get visionState() { return visionState; },
  get readings() { return readingsData; },
  get segState() { return segState; },
  seglight, segPerformer,
  runCalibration, setMode, captureImages, cameraRegionToScreen, showLight,
  startPerformance, paintingStopToScreen, loadReadings, startSegments, showSegments, findSegments,
};
