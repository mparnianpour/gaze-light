// Camera → projector calibration.
//
// The projector shows one bright dot at a time at a known screen position.
// The camera finds it by subtracting a frame taken while the screen was black,
// so the paintings, the wall and any room light cancel out. With enough
// dot pairs, OpenCV fits a homography: a mapping from camera image to phone
// screen that holds for any point on the (flat) wall.
//
// Coordinates:
//   camera  — normalised to the camera frame, u,v in 0..1 (independent of resolution)
//   screen  — CSS pixels of the full-screen output canvas
import { sleep, throwIfAborted } from './util.js';

// ---------- small 3×3 helpers (used everywhere the light is mapped) ----------

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

// ---------- dot detection ----------

class DotDetector {
  constructor(cv, camera, procW) {
    this.cv = cv;
    this.camera = camera;
    this.procW = procW;
    this.ref = null;               // the "black" reference frame (grey)
    this.diff = new cv.Mat();
    this.blur = new cv.Mat();
    this.empty = new cv.Mat();
    this.ksize = new cv.Size(7, 7);
    this.thresh = 20;
    this.latencies = [];
  }

  dispose() {
    for (const m of [this.ref, this.diff, this.blur, this.empty]) m?.delete();
    this.ref = null;
  }

  async gray() {
    await this.camera.nextFrame();
    const img = this.camera.grab(this.procW);
    const rgba = this.cv.matFromImageData(img);
    const g = new this.cv.Mat();
    this.cv.cvtColor(rgba, g, this.cv.COLOR_RGBA2GRAY);
    rgba.delete();
    return g;
  }

  async captureRef(n = 4) {
    const cv = this.cv;
    let acc = null;
    for (let i = 0; i < n; i++) {
      const g = await this.gray();
      if (!acc) acc = g;
      else { cv.addWeighted(acc, i / (i + 1), g, 1 / (i + 1), 0, acc); g.delete(); }
    }
    this.ref?.delete();
    this.ref = acc;
  }

  // Brightest spot of (frame − black), after a little blur to ignore sensor noise.
  measure(g) {
    const cv = this.cv;
    cv.subtract(g, this.ref, this.diff, this.empty, -1); // negative values clamp to 0
    cv.GaussianBlur(this.diff, this.blur, this.ksize, 0, 0, cv.BORDER_DEFAULT);
    const m = cv.minMaxLoc(this.blur, this.empty);
    return { peak: m.maxVal, x: m.maxLoc.x, y: m.maxLoc.y };
  }

  // How bright "nothing" looks, so the dot threshold adapts to the room.
  async measureNoise(n = 4) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const g = await this.gray();
      worst = Math.max(worst, this.measure(g).peak);
      g.delete();
    }
    this.noise = worst;
    this.thresh = Math.max(18, worst * 2 + 10);
  }

  // Weighted centre of the bright blob around the peak (sub-pixel).
  centroid(m) {
    const w = this.blur.cols;
    const h = this.blur.rows;
    const d = this.blur.data;
    const R = Math.max(8, Math.round(w * 0.04));
    const x0 = Math.max(0, m.x - R), x1 = Math.min(w - 1, m.x + R);
    const y0 = Math.max(0, m.y - R), y1 = Math.min(h - 1, m.y + R);
    const t = m.peak * 0.4;
    let sw = 0, sx = 0, sy = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const v = d[row + x] - t;
        if (v > 0) { sw += v; sx += v * x; sy += v * y; n++; }
      }
    }
    const box = (x1 - x0 + 1) * (y1 - y0 + 1);
    return { x: sx / sw, y: sy / sw, fill: n / box, peak: m.peak };
  }

  get timeout() {
    if (this.latencies.length < 3) return 3000;
    const s = [...this.latencies].sort((a, b) => a - b);
    const med = s[s.length >> 1];
    return Math.min(3000, Math.max(1200, med * 3 + 500));
  }

  // Show a dot, wait until the camera sees it steadily, then hide it and wait
  // until it's gone again. Returns the camera position or null if never seen.
  async findDot(show, hide, signal) {
    const timeout = this.timeout;
    show();
    const t0 = performance.now();
    let run = [];
    let found = null;
    while (performance.now() - t0 < timeout) {
      throwIfAborted(signal);
      const g = await this.gray();
      const m = this.measure(g);
      g.delete();
      if (m.peak < this.thresh) { run = []; continue; }
      const c = this.centroid(m);
      if (c.fill > 0.6) { run = []; continue; } // a big area changed: not a dot
      const last = run[run.length - 1];
      if (last && Math.hypot(c.x - last.x, c.y - last.y) < 2.5 && c.peak >= last.peak * 0.85) run.push(c);
      else run = [c];
      if (run.length >= 3) {
        const a = run[run.length - 1], b = run[run.length - 2];
        found = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, peak: a.peak };
        this.latencies.push(performance.now() - t0);
        break;
      }
    }
    hide();
    const w = this.blur.cols, h = this.blur.rows;
    const t1 = performance.now();
    while (performance.now() - t1 < timeout) {
      throwIfAborted(signal);
      const g = await this.gray();
      const m = this.measure(g);
      if (m.peak < this.thresh * 0.5) {
        // Dot is gone. Blend this frame into the black reference to follow slow drift.
        this.cv.addWeighted(this.ref, 0.5, g, 0.5, 0, this.ref);
        g.delete();
        break;
      }
      g.delete();
    }
    if (!found) return null;
    return { u: (found.x + 0.5) / w, v: (found.y + 0.5) / h, peak: found.peak };
  }
}

// ---------- homography fit ----------

function fit(cv, pts, ransacPx) {
  const toMats = (list) => [
    cv.matFromArray(list.length, 1, cv.CV_32FC2, list.flatMap((p) => [p.c.u, p.c.v])),
    cv.matFromArray(list.length, 1, cv.CV_32FC2, list.flatMap((p) => p.s)),
  ];
  const [src, dst] = toMats(pts);
  const mask = new cv.Mat();
  const Hr = cv.findHomography(src, dst, cv.RANSAC, ransacPx, mask);
  let H = null;
  let inliers = [];
  if (!Hr.empty()) {
    inliers = pts.filter((_, i) => mask.data[i]);
    if (inliers.length >= 4) {
      // Refine with a plain least-squares fit on the inliers only.
      const [s2, d2] = toMats(inliers);
      const m2 = new cv.Mat();
      const H2 = cv.findHomography(s2, d2, 0, 3, m2);
      if (!H2.empty()) H = Array.from(H2.data64F);
      H2.delete(); s2.delete(); d2.delete(); m2.delete();
    }
  }
  Hr.delete(); src.delete(); dst.delete(); mask.delete();
  if (H) H = H.map((v) => v / H[8]);
  return { H, inliers };
}

// ---------- main entry ----------

export async function calibrate({ cv, camera, output, cols = 5, rows = 4, dotR, procW = 1280, signal, onProgress }) {
  const W = output.w;
  const Hs = output.h;
  const r = Math.max(4, dotR || Math.min(W, Hs) * 0.025);
  const mx = Math.max(r * 2, W * 0.05);
  const my = Math.max(r * 2, Hs * 0.06);

  const grid = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      grid.push({ s: [mx + ((W - 2 * mx) * i) / (cols - 1), my + ((Hs - 2 * my) * j) / (rows - 1)], c: null });
    }
  }
  // Extra dots between the grid points, used only to check the result.
  const checks = [[0.37, 0.41], [0.63, 0.33], [0.53, 0.69], [0.27, 0.71]].map(([a, b]) => ({ s: [W * a, Hs * b], c: null }));

  const det = new DotDetector(cv, camera, Math.min(procW, camera.width));
  const t0 = performance.now();
  const base = {
    ok: false,
    screen: { w: W, h: Hs },
    cam: { w: camera.width, h: camera.height, deviceId: camera.deviceId, label: camera.label },
    total: grid.length,
    dotR: r,
    date: Date.now(),
  };

  try {
    output.black();
    await sleep(300);
    await det.captureRef(4);
    await det.measureNoise(3);

    for (const [k, p] of grid.entries()) {
      throwIfAborted(signal);
      onProgress?.(k, grid.length);
      p.c = await det.findDot(() => output.dot(p.s[0], p.s[1], r), () => output.black(), signal);
      // Nothing seen at all after 5 dots: the projector is probably off or aimed elsewhere.
      if (k === 4 && !grid.slice(0, 5).some((q) => q.c)) break;
    }

    const seen = grid.filter((p) => p.c);
    const result = {
      ...base,
      found: seen.length,
      noise: det.noise,
      threshold: det.thresh,
      points: grid.map((p) => ({ s: p.s, c: p.c ? [p.c.u, p.c.v] : null, inlier: false })),
    };
    const done = (extra) => ({ ...result, ...extra, seconds: (performance.now() - t0) / 1000 });

    if (seen.length < 6) {
      return done({
        reason: `The camera saw only ${seen.length} of ${grid.length} dots.`,
        hints: [
          'Is Smart View connected, and does the projector light the area the camera sees?',
          'Make the room darker, or make the dots bigger in the menu.',
        ],
      });
    }

    const { H, inliers } = fit(cv, seen, Math.max(4, W * 0.012));
    if (!H || inliers.length < 6) {
      return done({
        reason: 'The dots did not fit one flat surface.',
        hints: ['Check that the camera and projector stayed still, and that nothing shiny is reflecting the dots.'],
      });
    }
    for (const p of inliers) p.inlier = true;
    result.points = grid.map((p) => ({ s: p.s, c: p.c ? [p.c.u, p.c.v] : null, inlier: !!p.inlier }));

    const errs = inliers.map((p) => {
      const [x, y] = applyH(H, p.c.u, p.c.v);
      return Math.hypot(x - p.s[0], y - p.s[1]);
    });
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of inliers) {
      minX = Math.min(minX, p.s[0]); maxX = Math.max(maxX, p.s[0]);
      minY = Math.min(minY, p.s[1]); maxY = Math.max(maxY, p.s[1]);
    }
    const coverage = ((maxX - minX) * (maxY - minY)) / (W * Hs);

    // Check pass: dots the fit has never seen.
    for (const p of checks) {
      throwIfAborted(signal);
      p.c = await det.findDot(() => output.dot(p.s[0], p.s[1], r), () => output.black(), signal);
    }
    const checkErrs = checks.filter((p) => p.c).map((p) => {
      const [x, y] = applyH(H, p.c.u, p.c.v);
      return Math.hypot(x - p.s[0], y - p.s[1]);
    }).sort((a, b) => a - b);
    const checkErr = checkErrs.length ? checkErrs[checkErrs.length >> 1] : null;

    const out = done({
      H,
      Hinv: invertH(H),
      inliers: inliers.length,
      rms,
      coverage,
      checkErr,
      checks: checks.map((p) => ({ s: p.s, c: p.c ? [p.c.u, p.c.v] : null })),
      warnings: [],
    });

    const tooBig = Math.max(3, W * 0.01);
    if (rms > tooBig) {
      return { ...out, reason: `The dots line up poorly (error ${rms.toFixed(1)} px).`, hints: ['Something may have moved during calibration. Keep the tripod and projector still and try again.'] };
    }
    if (checkErr != null && checkErrs.length >= 2 && checkErr > Math.max(5, W * 0.015)) {
      return { ...out, reason: `The check dots landed ${checkErr.toFixed(1)} px away from where they should.`, hints: ['Something probably moved during calibration. Try again.'] };
    }
    if (coverage < 0.08) {
      return { ...out, reason: 'The dots the camera saw cover too little of the projection.', hints: ['Point the camera so it sees more of the projected area.'] };
    }
    if (inliers.length < seen.length) out.warnings.push(`${seen.length - inliers.length} dot(s) were ignored as reflections or mistakes.`);
    if (seen.length < grid.length) out.warnings.push(`${grid.length - seen.length} dot(s) were outside the camera view or too dim.`);
    if (coverage < 0.25) out.warnings.push(`The dots seen cover only ${Math.round(coverage * 100)}% of the projection; the light may be less accurate outside that area.`);
    out.ok = true;
    return out;
  } finally {
    det.dispose();
    output.black();
  }
}
