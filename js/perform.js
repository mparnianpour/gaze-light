// The performance: plays readings with the light and the voice.
// Nothing is written on the wall; the narration is only spoken.
//
// For each stop the light moves there (dissolve or glide), the voice speaks
// as it arrives, and the light lingers at least as long as the speech and the
// stop's dwell time. Between readings the light fades to dark for a breath.
import { sleep } from './util.js';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Performer {
  // regionFor(stop) → screen region or null; settings: { movement, pauseBetween }
  constructor({ light, voice, regionFor, settings, onStatus }) {
    Object.assign(this, { light, voice, regionFor, settings, onStatus });
    this.state = 'stopped';     // 'stopped' | 'playing' | 'paused'
    this.token = null;
    this.skip = null;           // 'stop' | 'reading'
    this.now = null;            // { title, stop, total } or { between: true }
    this.queue = [];
  }

  get running() { return this.state !== 'stopped'; }

  start(readings) {
    this.stop({ quiet: true });
    this.readings = readings;
    this.queue = [];
    this.lastIndex = -1;
    this.lastRegion = null;
    this.state = 'playing';
    const token = (this.token = {});
    this.loop(token).catch((e) => { console.error(e); this.stop(); });
    this.status();
  }

  stop({ quiet = false } = {}) {
    this.state = 'stopped';
    this.token = null;
    this.now = null;
    this.voice.cancel();
    if (!quiet) this.light.clear({ transition: 1.5 });
    this.status();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.voice.cancel();
    this.status();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.status();
  }

  nextStop() { if (this.running) { this.skip = 'stop'; this.voice.cancel(); } }
  nextReading() { if (this.running) { this.skip = 'reading'; this.voice.cancel(); } }

  status() { this.onStatus?.({ state: this.state, ...(this.now || {}) }); }

  // Wait that stands still while paused and ends early on skip or stop.
  async wait(seconds, token) {
    let left = seconds * 1000;
    while (left > 0) {
      if (token !== this.token || this.skip) return false;
      const step = Math.min(100, left);
      await sleep(step);
      if (this.state === 'playing') left -= step;
    }
    return token === this.token && !this.skip;
  }

  // Speak; if paused mid-sentence, say it again after resuming.
  async say(text, token) {
    for (;;) {
      while (this.state === 'paused') {
        await sleep(150);
        if (token !== this.token) return;
      }
      if (token !== this.token || this.skip) return;
      await this.voice.speak(text);
      if (token !== this.token || this.skip) return;
      if (this.state !== 'paused') return;
    }
  }

  pickReading() {
    if (!this.queue.length) {
      this.queue = shuffle(this.readings.map((_, i) => i));
      if (this.queue.length > 1 && this.queue[0] === this.lastIndex) this.queue.push(this.queue.shift());
    }
    this.lastIndex = this.queue.shift();
    return this.readings[this.lastIndex];
  }

  movementFor(region) {
    const m = this.settings.movement || 'dissolve';
    if (!this.lastRegion || !this.light.active) return 'dissolve';
    if (m === 'mixed') {
      const d = Math.hypot(region.center[0] - this.lastRegion.center[0], region.center[1] - this.lastRegion.center[1]) / innerWidth;
      return d > 0.22 ? 'dissolve' : 'glide';
    }
    return m === 'glide' ? 'glide' : 'dissolve';
  }

  async loop(token) {
    while (token === this.token) {
      const reading = this.pickReading();
      for (let i = 0; i < reading.stops.length; i++) {
        if (token !== this.token) return;
        if (this.skip === 'reading') break;
        this.skip = null;
        const stop = reading.stops[i];
        const region = this.regionFor(stop);
        if (!region) continue;
        this.now = { title: reading.title, stop: i + 1, total: reading.stops.length };
        this.status();

        const T = this.light.params.transition * (0.9 + Math.random() * 0.2);
        const move = this.movementFor(region);
        if (move === 'glide') this.light.moveTo(region, { transition: T });
        else this.light.show(region, { transition: T });
        this.lastRegion = region;

        // The voice starts as the light arrives.
        const arrive = move === 'glide' ? 0.85 * T : 0.45 * T;
        if (!(await this.wait(arrive, token))) { if (this.skip === 'stop') continue; if (this.skip === 'reading') break; return; }
        const t0 = performance.now();
        await this.say(stop.say, token);
        if (token !== this.token) return;
        if (this.skip === 'stop') continue;
        if (this.skip === 'reading') break;

        // Linger: at least the stop's dwell (a little randomness), and a breath after the words.
        const spoke = (performance.now() - t0) / 1000;
        const dwell = (stop.dwell || 10) * (0.92 + Math.random() * 0.16);
        const rest = Math.max(1.2, dwell - spoke - (move === 'glide' ? 0 : 0.15 * T));
        if (!(await this.wait(rest, token))) { if (this.skip === 'stop') continue; if (this.skip === 'reading') break; return; }
      }
      if (token !== this.token) return;
      this.skip = null;
      // A dark breath between readings.
      this.light.clear({ transition: 2.5 });
      this.lastRegion = null;
      this.now = { between: true };
      this.status();
      await this.wait(2.5 + (this.settings.pauseBetween ?? 4), token);
      this.skip = null;
    }
  }
}
