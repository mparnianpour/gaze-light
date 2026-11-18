// The projector output: a full-screen canvas. Everything is drawn in CSS
// pixels of the viewport; calibration maps camera points into this space.

export class Output {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onresize = null;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth;
    const h = innerHeight;
    const changed = w !== this.w || h !== this.h || dpr !== this.dpr;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.black();
    if (changed) this.onresize?.();
  }

  black() {
    const g = this.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  white() {
    const g = this.ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  dot(x, y, r) {
    this.black();
    const g = this.ctx;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // A crosshair used to check the calibration: it should land on the spot
  // that was tapped in the camera view.
  cross(x, y) {
    this.black();
    const g = this.ctx;
    const s = Math.max(16, Math.min(this.w, this.h) * 0.07);
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, s * 0.08);
    g.beginPath();
    g.moveTo(x - s, y); g.lineTo(x - s * 0.3, y);
    g.moveTo(x + s * 0.3, y); g.lineTo(x + s, y);
    g.moveTo(x, y - s); g.lineTo(x, y - s * 0.3);
    g.moveTo(x, y + s * 0.3); g.lineTo(x, y + s);
    g.stroke();
    g.beginPath();
    g.arc(x, y, s * 0.55, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, Math.max(2, s * 0.06), 0, Math.PI * 2);
    g.fill();
  }

  message(title, sub = '') {
    this.black();
    const g = this.ctx;
    const base = Math.min(this.w, this.h);
    g.fillStyle = '#ddd';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `500 ${Math.round(base * 0.09)}px system-ui, sans-serif`;
    g.fillText(title, this.w / 2, this.h / 2 - base * 0.04);
    if (sub) {
      g.fillStyle = '#999';
      g.font = `${Math.round(base * 0.045)}px system-ui, sans-serif`;
      g.fillText(sub, this.w / 2, this.h / 2 + base * 0.07);
    }
  }
}
