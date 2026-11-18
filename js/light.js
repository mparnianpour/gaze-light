// The light: a soft, brush-painted glow on a black screen.
//
// Each spot is built from ~48 overlapping soft round dabs scattered inside
// the chosen region, whose outline wobbles slightly so the edge is organic.
// The dabs are added up in a floating-point buffer, so overlaps never clip or
// step. One more pass turns that "paint density" into light: full brightness
// in the middle, a smooth fade to nothing beyond the edge, warm white by
// default, plus a touch of noise (dither) so the fade shows no bands on the
// projector.
//
// A region is an ellipse in screen CSS pixels: center + a·ax + b·ay, a²+b² ≤ 1.
// When a new spot is shown, the old one fades out slowly while the new one
// blooms in from its middle outwards, like paint spreading.

export const LIGHT_DEFAULTS = {
  brightness: 1,     // 0..1
  size: 1,           // scales every region
  softness: 0.6,     // 0 = firm edge, 1 = long gentle fade
  falloff: 0.5,      // how far the glow reaches beyond the region (× region radius)
  color: '#fff1dc',  // warm white
  transition: 3,     // seconds for fade-out / bloom-in
};

const DABS = 48;
const D0 = 3;        // paint density at a spot's centre
const MAX_DABS = 512;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const ramp = (a, b, x) => smooth((x - a) / (b - a));

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xfff1dc;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function makeDabs(seed) {
  const r = rng(seed);
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
  const wobble = (th) => 1 + 0.08 * Math.sin(3 * th + ph[0]) + 0.05 * Math.sin(5 * th + ph[1]) + 0.03 * Math.sin(8 * th + ph[2]);
  const dabs = [];
  for (let i = 0; i < DABS; i++) {
    const th = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * wobble(th);
    dabs.push({
      a: Math.cos(th) * rad,
      b: Math.sin(th) * rad,
      s: 0.75 + r() * 0.5,                     // size variation
      w: 0.7 + r() * 0.6,                      // paint amount
      delay: Math.min(1, rad) * 0.65 + r() * 0.3, // outer dabs arrive later: spreading
    });
  }
  return dabs;
}

const VS_DAB = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aDab;
uniform vec2 uView;
out vec2 vLocal;
out float vW;
void main() {
  vLocal = aCorner;
  vW = aDab.w;
  vec2 p = aDab.xy + aCorner * aDab.z;
  vec2 ndc = p / uView * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

const FS_DAB = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vW;
out vec4 o;
void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 >= 1.0) discard;
  float k = 1.0 - r2;
  o = vec4(k * k * k * vW, 0.0, 0.0, 1.0);
}`;

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

const FS_LIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uAcc;
uniform float uK;
uniform float uBoost;
uniform float uBright;
uniform float uScale;
uniform float uFrame;
uniform vec3 uColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  // Density relative to the centre → light. Full in the core, then a smooth
  // shoulder (shape set by softness) down to a tail that follows the paint.
  float x = min(1.0, texture(uAcc, vUv).r * uScale / ${D0.toFixed(1)} * uBoost);
  float L = 1.0 - pow(1.0 - x, uK);
  vec3 c = uColor * (L * uBright);
  vec2 p = gl_FragCoord.xy + vec2(mod(uFrame, 64.0) * 5.588238, mod(uFrame, 64.0) * 3.17);
  float n = ign(p) + ign(p + vec2(17.0, 59.0)) - 1.0;
  c += n * smoothstep(0.0, 0.01, L) / 255.0;
  o = vec4(max(c, 0.0), 1.0);
}`;

export class Light {
  constructor(canvas) {
    this.canvas = canvas;
    this.params = { ...LIGHT_DEFAULTS };
    this.spots = [];
    this.seed = 1;
    this.frame = 0;
    this.running = false;
    this.inst = new Float32Array(MAX_DABS * 4);
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (this.gl) {
      this.initGL();
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
      canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.initGL(); this.resize(); });
    } else {
      this.ctx = canvas.getContext('2d');
    }
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  get mode() { return this.gl ? (this.floatOK ? 'webgl2-float' : 'webgl2-8bit') : 'canvas2d'; }
  get active() { return this.spots.length > 0; }

  setParams(p) {
    Object.assign(this.params, p);
    if (!this.running) this.render();
  }

  // ---------------------------------------------------------------- setup

  initGL() {
    const gl = this.gl;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const prog = (vs, fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    this.pDab = prog(VS_DAB, FS_DAB);
    this.pLight = prog(VS_QUAD, FS_LIGHT);
    this.u = {
      view: gl.getUniformLocation(this.pDab, 'uView'),
      acc: gl.getUniformLocation(this.pLight, 'uAcc'),
      k: gl.getUniformLocation(this.pLight, 'uK'),
      boost: gl.getUniformLocation(this.pLight, 'uBoost'),
      bright: gl.getUniformLocation(this.pLight, 'uBright'),
      scale: gl.getUniformLocation(this.pLight, 'uScale'),
      frame: gl.getUniformLocation(this.pLight, 'uFrame'),
      color: gl.getUniformLocation(this.pLight, 'uColor'),
    };
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);

    this.vaoDab = gl.createVertexArray();
    gl.bindVertexArray(this.vaoDab);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.vaoQuad = gl.createVertexArray();
    gl.bindVertexArray(this.vaoQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.fbo = gl.createFramebuffer();
    this.acc = gl.createTexture();
    this.accW = this.accH = 0;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    if (this.gl && !this.lost) {
      const gl = this.gl;
      // The density field is smooth, so half resolution is plenty; the final
      // pass (with dither) runs at full resolution.
      const aw = Math.max(1, Math.round(this.canvas.width / 2));
      const ah = Math.max(1, Math.round(this.canvas.height / 2));
      if (aw !== this.accW || ah !== this.accH) {
        this.accW = aw;
        this.accH = ah;
        gl.bindTexture(gl.TEXTURE_2D, this.acc);
        if (this.floatOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, aw, ah, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, aw, ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.acc, 0);
        if (this.floatOK && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          this.floatOK = false;
          this.accW = 0;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          this.resize();
          return;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }
    if (!this.running) this.render();
  }

  // ---------------------------------------------------------------- spots

  // Show light on `region`; anything already lit fades out meanwhile.
  show(region, { transition = this.params.transition } = {}) {
    const now = performance.now() / 1000;
    for (const s of this.spots) if (s.out == null) { s.out = now; s.outDur = transition; }
    const spot = {
      region,
      dabs: makeDabs(this.seed++ * 7919 + 13),
      phase: Math.random() * 100,
      in: now + transition * 0.12,
      inDur: transition,
      out: null,
      outDur: transition,
    };
    this.spots.push(spot);
    this.start();
    return spot;
  }

  // Fade everything out.
  clear({ transition = this.params.transition * 0.6 } = {}) {
    const now = performance.now() / 1000;
    for (const s of this.spots) if (s.out == null) { s.out = now; s.outDur = transition; }
    this.start();
  }

  // Remove all light immediately.
  off() {
    this.spots = [];
    this.render();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.render();
      if (this.spots.length) requestAnimationFrame(tick);
      else { this.running = false; this.render(); }
    };
    requestAnimationFrame(tick);
  }

  // Turn a spot into dab instances (x, y, radius, weight) in CSS pixels.
  pushDabs(out, n, spot, t, alpha, grow) {
    const P = this.params;
    const { center, ax, ay } = spot.region;
    const unit = Math.sqrt(Math.hypot(ax[0], ax[1]) * Math.hypot(ay[0], ay[1])) * P.size;
    if (!(unit > 0)) return n;
    // Tuned so the light is full out to about half the region, half-bright
    // near its edge, and gone at about (1.15 + 0.9 × falloff) × the region.
    const spread = (0.78 - 0.15 * Math.min(1, P.falloff)) * P.size;
    const rho = unit * (0.45 + 1.4 * P.falloff);
    // Normalise the paint so the centre always reaches the same density.
    let dens = 0;
    for (const d of spot.dabs) {
      const ox = (d.a * ax[0] + d.b * ay[0]) * spread;
      const oy = (d.a * ax[1] + d.b * ay[1]) * spread;
      const q = Math.hypot(ox, oy) / (rho * d.s);
      if (q < 1) { const k = 1 - q * q; dens += d.w * k * k * k; }
    }
    const norm = dens > 0 ? D0 / dens : 1;
    // Breathing and a slight drift while it lingers.
    const ph = spot.phase;
    const breath = 1 + 0.025 * Math.sin(t * 1.1 + ph);
    const dx = (Math.sin(t * 0.31 + ph) * 0.012 + Math.sin(t * 0.83 + ph * 2) * 0.006) * unit;
    const dy = (Math.cos(t * 0.27 + ph) * 0.012 + Math.sin(t * 0.61 + ph * 3) * 0.005) * unit;
    for (const d of spot.dabs) {
      if (n >= MAX_DABS) break;
      let q = 1;
      if (grow < 1) q = ramp(d.delay * 0.55, d.delay * 0.55 + 0.45, grow);
      const wgt = d.w * norm * alpha * q;
      if (wgt <= 1e-4) continue;
      const ox = (d.a * ax[0] + d.b * ay[0]) * spread * breath;
      const oy = (d.a * ax[1] + d.b * ay[1]) * spread * breath;
      const k = n * 4;
      out[k] = center[0] + dx + ox;
      out[k + 1] = center[1] + dy + oy;
      out[k + 2] = rho * d.s * breath * (0.7 + 0.3 * q);
      out[k + 3] = wgt;
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- drawing

  render() {
    const now = performance.now() / 1000;
    this.spots = this.spots.filter((s) => s.out == null || now - s.out < s.outDur);
    let n = 0;
    for (const s of this.spots) {
      const alpha = s.out == null ? 1 : 1 - smooth((now - s.out) / s.outDur);
      const grow = Math.min(1, Math.max(0, (now - s.in) / s.inDur));
      n = this.pushDabs(this.inst, n, s, now, alpha, grow);
    }
    this.frame++;
    if (this.gl) this.drawGL(n);
    else this.draw2D(n);
  }

  // Softness sets the shoulder: 0 → firm (k 2.6), 1 → very gradual (k 1).
  curve() {
    return { k: 2.6 - 1.6 * this.params.softness, boost: 1.15 };
  }

  drawGL(n) {
    const gl = this.gl;
    if (this.lost) return;
    const scale = this.floatOK ? 1 : 8; // 8-bit fallback stores density / 8
    // Pass 1: add up the dabs.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.accW, this.accH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n) {
      if (scale !== 1) for (let i = 0; i < n; i++) this.inst[i * 4 + 3] /= scale;
      gl.useProgram(this.pDab);
      gl.uniform2f(this.u.view, this.w, this.h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, n * 4);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.vaoDab);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    }
    // Pass 2: density → light.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.pLight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.acc);
    gl.uniform1i(this.u.acc, 0);
    const { k, boost } = this.curve();
    gl.uniform1f(this.u.k, k);
    gl.uniform1f(this.u.boost, boost);
    gl.uniform1f(this.u.bright, this.params.brightness);
    gl.uniform1f(this.u.scale, scale);
    gl.uniform1f(this.u.frame, this.frame);
    gl.uniform3fv(this.u.color, hexToRgb(this.params.color));
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // Fallback without WebGL 2: radial gradients (may show slight banding).
  draw2D(n) {
    const g = this.ctx;
    const dpr = this.canvas.width / this.w;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!n) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'lighter';
    const [r, gg, b] = hexToRgb(this.params.color).map((v) => Math.round(v * 255 * this.params.brightness));
    for (let i = 0; i < n; i++) {
      const [x, y, rad, w] = this.inst.subarray(i * 4, i * 4 + 4);
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const a = Math.min(1, w * 0.3);
      grad.addColorStop(0, `rgba(${r},${gg},${b},${a})`);
      grad.addColorStop(0.5, `rgba(${r},${gg},${b},${a * 0.42})`);
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.globalCompositeOperation = 'source-over';
  }
}
