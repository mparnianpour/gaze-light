// The narration voice: the phone's own text-to-speech (Web Speech API).
// Nothing is shown on screen; it is only spoken.

export class Voice {
  constructor(settings) {
    this.s = settings;           // { voiceURI, rate, pitch, lang }
    this.voices = [];
    this.onvoices = null;
    this.current = null;
    if ('speechSynthesis' in window) {
      const load = () => {
        this.voices = speechSynthesis.getVoices();
        this.onvoices?.(this.voices);
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  get available() { return 'speechSynthesis' in window; }

  // Voices for the chosen language first, then the rest.
  list() {
    const lang = (this.s.lang || 'en').slice(0, 2).toLowerCase();
    const mine = this.voices.filter((v) => v.lang?.toLowerCase().startsWith(lang));
    return mine.length ? mine : this.voices;
  }

  pick() {
    const all = this.list();
    return all.find((v) => v.voiceURI === this.s.voiceURI)
      || all.find((v) => v.lang === this.s.lang && v.default)
      || all.find((v) => v.lang === this.s.lang)
      || all[0] || null;
  }

  // Speak and resolve when finished (or cancelled). Android does not always
  // fire 'end', so a time estimate backs it up.
  speak(text) {
    if (!this.available || !text) return Promise.resolve({ ok: false, seconds: 0 });
    this.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pick();
      if (v) u.voice = v;
      u.lang = v?.lang || this.s.lang || 'en-US';
      u.rate = this.s.rate ?? 0.95;
      u.pitch = this.s.pitch ?? 1;
      const t0 = performance.now();
      const words = text.split(/\s+/).length;
      const estimate = (words / 2.6) / (u.rate || 1) + 1.5;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.current === u) this.current = null;
        resolve({ ok, seconds: (performance.now() - t0) / 1000, estimate });
      };
      const timer = setTimeout(() => finish(false), (estimate * 1.35 + 2) * 1000);
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      u.cancelled = () => finish(false);
      this.current = u;
      speechSynthesis.speak(u);
    });
  }

  cancel() {
    if (!this.available) return;
    const u = this.current;
    this.current = null;
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    u?.cancelled?.();
  }
}
