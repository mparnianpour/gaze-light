// Camera → projector calibration.
//
// The projector shows one bright dot at a time at a known screen position.
// The camera finds it by subtracting a frame taken while the screen was black,
// so the paintings, the wall and any room light cancel out. With enough
// dot pairs, OpenCV fits a homography: a mapping from camera image to phone
// screen that holds for any point on the (flat) wall.
//
// The image work runs in the vision worker (vision-core.js); this file only
// decides what to show and when.
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
  constructor(vision, camera, procW) {
    this.vision = vision;
    this.camera = camera;
    this.procW = procW;
    this.thresh = 20;
    this.noise = 0;
    this.latencies = [];
    this.peaks = [];   // brightest change seen while each dot was shown (diagnostics)
  }

  // Flash the whole screen and see where (and whether) the camera picks it up.
  async findFlash(show, hide, signal) {
    const thresh = Math.max(this.thresh, 25);
    const area = async () => this.vision.withFrame('area', await this.grab(), { thresh });
    show();
    const t0 = performance.now();
    let best = null;
    let seenAt = 0;
    let brightest = 0;
    while (performance.now() - t0 < 3000) {
      throwIfAborted(signal);
      const a = await area();
      brightest = Math.max(brightest, a.peak);
      if (a.frac > 0.01) {
        if (!seenAt) seenAt = performance.now() - t0;
        if (!best || a.frac > best.frac) best = a;
        if (performance.now() - t0 > seenAt + 300) break;
      }
    }
    hide();
    const t1 = performance.now();
    while (performance.now() - t1 < 3000) {
      throwIfAborted(signal);
      if ((await area()).frac < 0.003) break;
    }
    if (!best) return { seen: false, brightest, thresh };
    this.latencies.push(seenAt);
    return { seen: true, latency: seenAt, bbox: best.bbox, frac: best.frac, w: best.w, h: best.h, brightest, thresh };
  }

  async grab() {
    await this.camera.nextFrame();
    return this.camera.grab(this.procW);
  }

  async captureRef(n = 4) {
    await this.vision.call('refStart');
    for (let i = 0; i < n; i++) await this.vision.withFrame('refAdd', await this.grab());
  }

  async measure(extra) {
    return this.vision.withFrame('measure', await this.grab(), extra);
  }

  // How bright "nothing" looks, so the dot threshold adapts to the room.
  async measureNoise(n = 4) {
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, (await this.measure()).peak);
    this.noise = worst;
    this.thresh = Math.max(18, worst * 2 + 10);
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
    let size = null;
    let brightest = 0;
    while (performance.now() - t0 < timeout) {
      throwIfAborted(signal);
      const m = await this.measure();
      size = m;
      brightest = Math.max(brightest, m.peak);
      if (m.peak < this.thresh) { run = []; continue; }
      if (m.fill > 0.6) { run = []; continue; } // a big area changed: not a dot
      const last = run[run.length - 1];
      if (last && Math.hypot(m.cx - last.cx, m.cy - last.cy) < 2.5 && m.peak >= last.peak * 0.85) run.push(m);
      else run = [m];
      if (run.length >= 3) {
        const a = run[run.length - 1];
        const b = run[run.length - 2];
        found = { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2, peak: a.peak };
        this.latencies.push(performance.now() - t0);
        break;
      }
    }
    hide();
    this.peaks.push(brightest);
    const t1 = performance.now();
    while (performance.now() - t1 < timeout) {
      throwIfAborted(signal);
      // Once the dot is gone, this frame is blended into the black reference.
      const m = await this.measure({ blendBelow: this.thresh * 0.5 });
      if (m.blended) break;
    }
    if (!found || !size) return null;
    return { u: (found.x + 0.5) / size.w, v: (found.y + 0.5) / size.h, peak: found.peak };
  }
}

// ---------- homography fit ----------

async function fit(vision, pts, ransacPx) {
  const { H, mask } = await vision.call('fit', {
    src: pts.flatMap((p) => [p.c.u, p.c.v]),
    dst: pts.flatMap((p) => p.s),
    ransac: ransacPx,
  });
  return { H, inliers: pts.filter((_, i) => mask[i]) };
}

// ---------- main entry ----------

export async function calibrate({ vision, camera, output, cols = 5, rows = 4, dotR, procW = 1280, signal, onProgress }) {
  const W = output.w;
  const Hs = output.h;
  let r = Math.max(4, dotR || Math.min(W, Hs) * 0.04);

  const det = new DotDetector(vision, camera, Math.min(procW, camera.width));
  const t0 = performance.now();
  const base = {
    ok: false,
    screen: { w: W, h: Hs },
    cam: { w: camera.width, h: camera.height, deviceId: camera.deviceId, label: camera.label },
    total: cols * rows,
    dotR: r,
    date: Date.now(),
  };
  const elapsed = () => (performance.now() - t0) / 1000;

  try {
    output.black();
    await sleep(300);
    await det.captureRef(4);
    await det.measureNoise(3);

    // 1. Find the projector: flash the whole screen white once.
    const flash = await det.findFlash(() => output.white(), () => output.black(), signal);
    base.flash = flash;
    if (!flash.seen) {
      return {
        ...base, found: 0, noise: det.noise, threshold: det.thresh, seconds: elapsed(),
        reason: 'The camera did not see the projector at all.',
        hints: [
          'When the screen flashed white, nothing changed in the camera picture.',
          'Aim the camera at the projected area: in the camera view you should see the projection (a picture of the picture).',
          'Check that Smart View is casting and the projector is on.',
        ],
      };
    }
    // Let the camera recover from the flash, then take a fresh black reference.
    await sleep(900);
    throwIfAborted(signal);
    await det.captureRef(4);
    await det.measureNoise(3);

    // 2. Make the dots big enough for this camera: at least ~5 camera pixels in radius.
    const camPxPerScreenPx = ((flash.bbox[2] - flash.bbox[0]) * flash.w) / W;
    const minR = 5 / Math.max(camPxPerScreenPx, 1e-3);
    if (r < minR) {
      r = Math.min(minR, Math.min(W, Hs) * 0.08);
      base.dotAuto = true;
    }
    base.dotR = r;

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

    // 3. One dot at a time.
    for (const [k, p] of grid.entries()) {
      throwIfAborted(signal);
      onProgress?.(k, grid.length);
      p.c = await det.findDot(() => output.dot(p.s[0], p.s[1], r), () => output.black(), signal);
      // Nothing seen at all after 5 dots: the projector is probably off or aimed elsewhere.
      if (k === 4 && !grid.slice(0, 5).some((q) => q.c)) break;
    }

    const seen = grid.filter((p) => p.c);
    const pointList = () => grid.map((p) => ({ s: p.s, c: p.c ? [p.c.u, p.c.v] : null, inlier: !!p.inlier }));
    const result = {
      ...base, found: seen.length, noise: det.noise, threshold: det.thresh, points: pointList(),
      brightest: det.peaks.length ? Math.max(...det.peaks) : null,
    };
    const done = (extra) => ({ ...result, ...extra, seconds: elapsed() });

    if (seen.length < 6) {
      const faint = result.brightest != null && result.brightest < det.thresh;
      return done({
        reason: `The camera saw only ${seen.length} of ${grid.length} dots.`,
        hints: faint
          ? [
            'The camera sees the projector (outlined), but the dots looked too faint.',
            'Make the room darker, or make the dots bigger in the menu.',
          ]
          : [
            'Only part of the projection may be in the camera view (outlined). Aim the camera so it sees more of it.',
            'Keep people and moving things out of the view while it runs.',
          ],
      });
    }

    const { H, inliers } = await fit(vision, seen, Math.max(4, W * 0.012));
    if (!H || inliers.length < 6) {
      return done({
        reason: 'The dots did not fit one flat surface.',
        hints: ['Check that the camera and projector stayed still, and that nothing shiny is reflecting the dots.'],
      });
    }
    for (const p of inliers) p.inlier = true;
    result.points = pointList();

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
    // Is the phone screen's horizontal running up/down in the camera picture?
    // Usually that means Smart View is casting in portrait, so the projector
    // shows only a narrow, sideways strip.
    if (out.Hinv) {
      const aspect = camera.width / camera.height;
      const toCam = (x, y) => { const [u, v] = applyH(out.Hinv, x, y); return [u * aspect, v]; };
      const c0 = toCam(W / 2, Hs / 2);
      const cx = toCam(W * 0.75, Hs / 2);
      if (Math.abs(cx[1] - c0[1]) > Math.abs(cx[0] - c0[0])) {
        out.sideways = true;
        out.warnings.push('The projection looks turned sideways. If the projector shows a tall narrow strip, the phone is casting in portrait: turn on Auto rotate on the phone (or pick a full-screen option in Smart View), then calibrate again.');
      }
    }
    if (inliers.length < seen.length) out.warnings.push(`${seen.length - inliers.length} dot(s) were ignored as reflections or mistakes.`);
    if (seen.length < grid.length) out.warnings.push(`${grid.length - seen.length} dot(s) were outside the camera view or too dim.`);
    if (coverage < 0.25) out.warnings.push(`The dots seen cover only ${Math.round(coverage * 100)}% of the projection; the light may be less accurate outside that area.`);
    out.ok = true;
    return out;
  } finally {
    output.black();
  }
}
