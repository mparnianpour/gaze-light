// Segment light: projects a composition onto the paintings. Filled segments
// get coloured light, the rest of each painting soft neutral light, and the
// wall around the paintings stays dark. One composition crossfades into the next.
//
// The phone screen is mapped once, pixel by pixel, to "which painting, which
// segment" (through the calibration and each painting's corners). A
// composition then only needs a colour per segment.
import { applyH } from './geometry.js';

export const SEG_DEFAULTS = {
  neutral: 0.55,   // brightness of the unfilled parts of the painting
  strength: 1,     // brightness of the coloured segments
  hold: 20,        // seconds each composition stays
  fade: 6,         // seconds of crossfade
  cover: 0.5,      // share of each painting filled with colour
  source: 'mix',   // 'mix' | 'saved' | 'new'
  colours: 'painting', // 'painting' (its own hues) | 'presets'
  chroma: 0.7,     // share of the most saturated colour possible, for painting colours
};

const hex = (h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16) / 255);

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUv;
void main() { vUv = aCorner * 0.5 + 0.5; gl_Position = vec4(aCorner, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uT;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float t = uT * uT * (3.0 - 2.0 * uT);
  o = vec4(mix(texture(uA, uv).rgb, texture(uB, uv).rgb, t), 1.0);
}`;

export class SegmentLight {
  constructor(canvas) {
    this.canvas = canvas;
    this.map = null;
    this.t = 1;
    this.fade = { t0: 0, dur: 1 };
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (this.gl) this.initGL();
    else this.ctx = canvas.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  initGL() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    this.prog = gl.createProgram();
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.uA = gl.getUniformLocation(this.prog, 'uA');
    this.uB = gl.getUniformLocation(this.prog, 'uB');
    this.uT = gl.getUniformLocation(this.prog, 'uT');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const tex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    };
    this.texA = tex();
    this.texB = tex();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.draw();
  }

  // entries: [{ pid, seg: { w, h, ids }, Pinv }] ; Hinv: screen CSS px → camera
  buildMap(entries, Hinv, w = innerWidth, h = innerHeight) {
    const paint = new Int8Array(w * h).fill(-1);
    const segId = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [u, v] = applyH(Hinv, x + 0.5, y + 0.5);
        for (let k = 0; k < entries.length; k++) {
          const e = entries[k];
          const [px, py] = applyH(e.Pinv, u, v);
          if (px >= 0 && px < 1 && py >= 0 && py < 1) {
            const i = y * w + x;
            paint[i] = k;
            segId[i] = e.seg.ids[Math.floor(py * e.seg.h) * e.seg.w + Math.floor(px * e.seg.w)];
            break;
          }
        }
      }
    }
    this.map = { w, h, paint, seg: segId, entries };
    return this.map;
  }

  // Colours for one composition → RGBA pixels at map size.
  pixelsFor(comp, { neutral, strength, neutralColor }) {
    const { w, h, paint, seg, entries } = this.map;
    const px = new Uint8Array(w * h * 4);
    const pal = comp.palette.map((c) => hex(c).map((v) => Math.round(v * strength * 255)));
    const neu = hex(neutralColor).map((v) => Math.round(v * neutral * 255));
    const fills = entries.map((e) => comp.fills[e.pid] || null);
    for (let i = 0; i < w * h; i++) {
      const k = paint[i];
      const o = i * 4;
      px[o + 3] = 255;
      if (k < 0) continue;
      const f = fills[k] ? fills[k][seg[i]] : -1;
      const c = f >= 0 ? pal[f] : neu;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
    }
    return px;
  }

  // Segment outlines in white on dark, to check they sit on the painting.
  outlinePixels(level = 0.9) {
    const { w, h, paint, seg } = this.map;
    const px = new Uint8Array(w * h * 4);
    const on = Math.round(level * 255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 4;
        px[o + 3] = 255;
        if (paint[i] < 0) continue;
        const edge = (x + 1 < w && (seg[i + 1] !== seg[i] || paint[i + 1] !== paint[i])) ||
          (y + 1 < h && (seg[i + w] !== seg[i] || paint[i + w] !== paint[i]));
        const v = edge ? on : 18;
        px[o] = v; px[o + 1] = v; px[o + 2] = v;
      }
    }
    return px;
  }

  // Crossfade from what is showing now to `pixels` over `fade` seconds.
  show(pixels, fade = 6) {
    const { w, h } = this.map;
    if (this.gl) {
      const gl = this.gl;
      if (this.t < 1) this.finish();
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } else {
      if (!this.cA) { this.cA = document.createElement('canvas'); this.cB = document.createElement('canvas'); }
      if (this.t < 1) this.finish();
      this.cB.width = w; this.cB.height = h;
      this.cB.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);
    }
    this.fade = { t0: performance.now(), dur: Math.max(0.05, fade) * 1000 };
    this.t = 0;
    const tick = () => {
      this.t = Math.min(1, (performance.now() - this.fade.t0) / this.fade.dur);
      this.draw();
      if (this.t < 1) requestAnimationFrame(tick);
      else this.finish();
    };
    requestAnimationFrame(tick);
  }

  finish() {
    if (this.gl) { [this.texA, this.texB] = [this.texB, this.texA]; }
    else if (this.cA) { [this.cA, this.cB] = [this.cB, this.cA]; }
    this.t = 1;
    this.draw();
  }

  off() {
    if (!this.map) return;
    this.show(new Uint8Array(this.map.w * this.map.h * 4).map((_, i) => (i % 4 === 3 ? 255 : 0)), 0.05);
  }

  draw() {
    if (this.gl) {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texA);
      gl.uniform1i(this.uA, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.uniform1i(this.uB, 1);
      gl.uniform1f(this.uT, this.t >= 1 ? 0 : this.t);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    } else if (this.ctx) {
      const g = this.ctx;
      g.fillStyle = '#000';
      g.fillRect(0, 0, this.canvas.width, this.canvas.height);
      g.imageSmoothingEnabled = true;
      if (this.cA) g.drawImage(this.cA, 0, 0, this.canvas.width, this.canvas.height);
      if (this.cB && this.t < 1) { g.globalAlpha = this.t; g.drawImage(this.cB, 0, 0, this.canvas.width, this.canvas.height); g.globalAlpha = 1; }
    }
  }
}
