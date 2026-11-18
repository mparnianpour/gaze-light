// Rear camera: open it, list cameras, grab frames, and freeze exposure,
// white balance and focus where Chrome allows it.
import { params, sleep, waitFor } from './util.js';

const LOCKABLE = [
  // [result key, mode constraint, value constraint]
  ['exposure', 'exposureMode', 'exposureTime'],
  ['whiteBalance', 'whiteBalanceMode', 'colorTemperature'],
  ['focus', 'focusMode', 'focusDistance'],
];

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.sim = params.has('sim');
    this.locks = null;          // result of the last lock(): { exposure: 'locked' | 'failed' | 'unsupported', ... }
    this.lockedValues = {};     // e.g. { exposureTime, colorTemperature, focusDistance }
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.onended = null;
  }

  get running() { return !!this.track && this.track.readyState === 'live'; }
  get width() { return this.video.videoWidth; }
  get height() { return this.video.videoHeight; }

  async start({ deviceId = null, height = 1080 } = {}) {
    this.stop();
    if (this.sim) {
      const { startSim } = await import('./sim.js');
      this.stream = await startSim();
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        const e = new Error('This browser cannot open the camera here. The page has to be opened over https.');
        e.name = 'InsecureContext';
        throw e;
      }
      const video = {
        width: { ideal: Math.round((height * 16) / 9) },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      };
      if (deviceId) video.deviceId = { exact: deviceId };
      else video.facingMode = { ideal: 'environment' };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
        delete video.deviceId;
        video.facingMode = { ideal: 'environment' };
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      }
    }
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => this.onended?.());
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await waitFor(() => this.video.videoWidth > 0, 8000);
    // On Android the extra camera controls show up a moment after the stream starts.
    await sleep(300);
    const s = this.settings();
    this.deviceId = this.sim ? 'sim' : (s.deviceId || deviceId);
    this.label = this.sim ? 'Simulated camera (test mode)' : this.track.label;
    this.locks = null;
    return this;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  async listDevices() {
    if (this.sim) return [{ deviceId: 'sim', label: 'Simulated camera (test mode)' }];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  capabilities() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  settings() {
    try { return this.track?.getSettings?.() || {}; } catch { return {}; }
  }

  // Which of exposure / white balance / focus this camera says it can lock.
  lockSupport() {
    const caps = this.capabilities();
    const out = {};
    for (const [key, mode] of LOCKABLE) out[key] = Array.isArray(caps[mode]) && caps[mode].includes('manual');
    return out;
  }

  // Hand control back to the camera's automatic modes.
  async unlock() {
    if (!this.track) return;
    const caps = this.capabilities();
    const c = {};
    for (const [, mode] of LOCKABLE) if (Array.isArray(caps[mode]) && caps[mode].includes('continuous')) c[mode] = 'continuous';
    if (Object.keys(c).length) {
      try { await this.track.applyConstraints({ advanced: [c] }); } catch { /* ignore */ }
    }
    this.locks = null;
  }

  // Freeze exposure, white balance and focus at their current automatic values,
  // so the picture does not shift while the projector flashes dots.
  // Chrome silently ignores what it can't do, so each lock is checked afterwards.
  async lock() {
    const out = { exposure: 'unsupported', whiteBalance: 'unsupported', focus: 'unsupported' };
    if (!this.track) return out;
    const caps = this.capabilities();
    this.lockedValues = {};
    for (const [key, mode, value] of LOCKABLE) {
      if (!Array.isArray(caps[mode]) || !caps[mode].includes('manual')) continue;
      const cur = this.settings();
      const c = { [mode]: 'manual' };
      if (caps[value] && cur[value] != null) c[value] = cur[value];
      try { await this.track.applyConstraints({ advanced: [c] }); } catch { /* checked below */ }
      const after = this.settings();
      out[key] = after[mode] === 'manual' ? 'locked' : 'failed';
      if (out[key] === 'locked' && after[value] != null) this.lockedValues[value] = after[value];
    }
    this.locks = out;
    return out;
  }

  // Resolves when the next camera frame is ready (or after a short wait).
  nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(finish);
      setTimeout(finish, 80);
    });
  }

  // Current frame as ImageData, scaled down to at most `maxW` pixels wide.
  grab(maxW = 1280) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const s = Math.min(1, maxW / vw);
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}
