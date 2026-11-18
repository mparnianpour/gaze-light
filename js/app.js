import { $, $$, sleep, load, save, remove, esc, abortError, params } from './util.js';
import { Vision } from './vision.js';
import { Camera } from './camera.js';
import { Output } from './output.js';
import { calibrate, applyH } from './calibrate.js';

const VERSION = 'Milestone 1';
const KEY_SETTINGS = 'gaze.settings';
const KEY_CALIB = 'gaze.calibration';
const DEFAULTS = { v: 2, deviceId: null, camHeight: 1080, grid: '5x4', dotSize: 4, previewDim: 0.6 };

const settings = { ...DEFAULTS, ...load(KEY_SETTINGS, {}) };
if ((settings.v || 1) < 2) {
  // The first version used smaller dots by default.
  if (settings.dotSize === 2.5) settings.dotSize = DEFAULTS.dotSize;
  settings.v = 2;
}
const saveSettings = () => save(KEY_SETTINGS, settings);

const body = document.body;
const overlay = $('#overlay');
const output = new Output($('#out'));
const camera = new Camera($('#cam'));

let calib = load(KEY_CALIB, null);   // the calibration in use
let lastResult = null;              // the latest attempt, shown on the result card
let mode = 'start';
let flashBack = 'camera';
let flashTimer = 0;
let abortCal = null;

// OpenCV.js runs in a background worker so its large download and start-up
// never freeze the page.
const vision = new Vision();
let visionState = 'loading';   // 'loading' | 'ready' | 'failed'

// ------------------------------------------------------------------ modes

function setMode(m) {
  mode = m;
  body.dataset.mode = m;
  if (m !== 'flash') output.black();
  renderStatus();
  renderCard();
  drawOverlay();
}

// ------------------------------------------------------------------ helpers

let toastTimer = 0;
function toast(text, ms = 2800) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  } catch { /* no voice available */ }
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

function camToView(u, v) {
  const r = videoRect();
  return [r.x + u * r.w, r.y + v * r.h];
}

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

// ------------------------------------------------------------------ rendering

function renderStatus() {
  const chips = [];
  if (!calib) chips.push(['Not calibrated', 'warn']);
  else {
    const issues = calibIssues(calib);
    if (issues.length) chips.push([`Calibration may be off: ${issues.join(', ')}`, 'bad']);
    else chips.push([`Calibrated · ${calib.rms.toFixed(1)} px`, 'ok']);
  }
  if (camera.locks) chips.push(...lockText(camera.locks));
  if (!isFullscreen()) chips.push(['Not fullscreen', 'warn']);
  if (camera.sim) chips.push(['Test mode: simulated camera', 'warn']);
  if (calib && !calibIssues(calib).length) chips.push(['Tap the view to project a cross there', '']);
  $('#status').innerHTML = chips.map(([t, k]) => `<span class="chip ${k}">${esc(t)}</span>`).join('');

  $('#calStatus').textContent = calib
    ? `In use: ${timeText(calib.date)}, ${calib.inliers} dots, error ${calib.rms.toFixed(1)} px` +
      (calibIssues(calib).length ? ` (may be off: ${calibIssues(calib).join(', ')})` : '')
    : 'No calibration yet.';
  $('#screenInfo').textContent = `Screen ${output.w} × ${output.h} (×${output.dpr})` + (isFullscreen() ? ', fullscreen' : ', not fullscreen');
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
  // Numbers that help diagnose a failed calibration.
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
  if (mode !== 'camera' && mode !== 'result') return;

  const c = mode === 'result' && lastResult ? lastResult : calib;
  if (!c) return;

  // Without a fit yet: show where the camera saw the projector's white flash.
  if (mode === 'result' && !c.Hinv && c.flash?.bbox) {
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
  if (c.Hinv) {
    const corners = [[0, 0], [c.screen.w, 0], [c.screen.w, c.screen.h], [0, c.screen.h]]
      .map(([x, y]) => applyH(c.Hinv, x, y))
      .map(([u, v]) => camToView(u, v));
    g.setLineDash([8, 6]);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(236, 214, 171, 0.9)';
    g.beginPath();
    corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.stroke();
    g.setLineDash([]);
  }
  if (mode !== 'result' || !c.points) return;

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

// ------------------------------------------------------------------ calibration

async function runCalibration() {
  if (mode === 'calibrating') return;
  closePanel();
  try {
    if (visionState !== 'ready') toast('Loading the vision library…', 90000);
    await vision.ready;
  } catch {
    toast('The vision library (OpenCV.js) did not load. Check the internet and reload.', 6000);
    return;
  }
  $('#msg').classList.remove('show');
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

// ------------------------------------------------------------------ tap check

function flashCross(x, y) {
  if (mode !== 'flash') flashBack = mode;
  setMode('flash');
  output.cross(x, y);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setMode(flashBack), 2500);
}

overlay.addEventListener('pointerdown', (e) => {
  if (mode !== 'camera' && mode !== 'result') return;
  const c = mode === 'result' && lastResult?.ok ? lastResult : calib;
  if (!c?.H) { toast('Calibrate first, then tap the view to test it.'); return; }
  const r = videoRect();
  const u = (e.clientX - r.x) / r.w;
  const v = (e.clientY - r.y) / r.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const [x, y] = applyH(c.H, u, v);
  if (x < 0 || y < 0 || x > output.w || y > output.h) {
    toast('That spot is outside what the projector can reach.');
    return;
  }
  flashCross(x, y);
});

$('#out').addEventListener('pointerdown', () => {
  if (mode === 'calibrating') abortCal?.abort();
  else if (mode === 'flash') { clearTimeout(flashTimer); setMode(flashBack); }
});

// ------------------------------------------------------------------ menu

function openPanel() { $('#panel').hidden = false; renderStatus(); renderCamInfo(); }
function closePanel() { $('#panel').hidden = true; }
$('#hotspot').addEventListener('click', () => ($('#panel').hidden ? openPanel() : closePanel()));

const actions = {
  calibrate: runCalibration,
  camera: () => { closePanel(); setMode('camera'); },
  black: () => { closePanel(); setMode('black'); toast('Tap the top-right corner for the menu.', 2000); },
  forget: () => {
    if (!calib) return;
    if (!confirm('Forget the saved calibration?')) return;
    calib = null;
    remove(KEY_CALIB);
    renderStatus();
    drawOverlay();
  },
  fullscreen: async () => { await enterFullscreen(); renderStatus(); },
  voicetest: () => speak('This is the narration voice. If you can hear me, sound is working.'),
  reload: () => location.reload(),
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) actions[b.dataset.act]();
});

function bindSettings() {
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

// For testing from the browser console.
window.gaze = {
  settings, camera, output, vision,
  get calib() { return calib; },
  get lastResult() { return lastResult; },
  get mode() { return mode; },
  get visionState() { return visionState; },
  runCalibration, setMode,
};
