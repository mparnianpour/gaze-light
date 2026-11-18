// The OpenCV.js vision math. Runs inside the vision worker (vision-worker.js),
// so the 10 MB library never blocks the page. Plain script, not a module:
// it defines self.createVisionCore(cv).
(function (root) {
  root.createVisionCore = function createVisionCore(cv) {
    let ref = null;            // the "black" reference frame, grey
    let refN = 0;
    const diff = new cv.Mat();
    const blur = new cv.Mat();
    const empty = new cv.Mat();
    const ksize = new cv.Size(7, 7);

    function gray(frame) {
      const rgba = cv.matFromImageData({
        data: new Uint8ClampedArray(frame.buffer, 0, frame.width * frame.height * 4),
        width: frame.width,
        height: frame.height,
      });
      const g = new cv.Mat();
      cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
      rgba.delete();
      return g;
    }

    // Weighted centre of the bright blob around the peak (sub-pixel).
    function centroid(peak, px, py) {
      const w = blur.cols;
      const h = blur.rows;
      const d = blur.data;
      const R = Math.max(8, Math.round(w * 0.04));
      const x0 = Math.max(0, px - R), x1 = Math.min(w - 1, px + R);
      const y0 = Math.max(0, py - R), y1 = Math.min(h - 1, py + R);
      const t = peak * 0.4;
      let sw = 0, sx = 0, sy = 0, n = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        for (let x = x0; x <= x1; x++) {
          const v = d[row + x] - t;
          if (v > 0) { sw += v; sx += v * x; sy += v * y; n++; }
        }
      }
      if (!sw) return { cx: px, cy: py, fill: 0 };
      return { cx: sx / sw, cy: sy / sw, fill: n / ((x1 - x0 + 1) * (y1 - y0 + 1)) };
    }

    function toMat(arr) {
      return cv.matFromArray(arr.length / 2, 1, cv.CV_32FC2, arr);
    }

    const handlers = {
      refStart() {
        if (ref) ref.delete();
        ref = null;
        refN = 0;
        return true;
      },

      refAdd({ frame }) {
        const g = gray(frame);
        if (!ref) ref = g;
        else {
          cv.addWeighted(ref, refN / (refN + 1), g, 1 / (refN + 1), 0, ref);
          g.delete();
        }
        return ++refN;
      },

      // Brightest spot of (frame − black), after a little blur to ignore sensor noise.
      // With blendBelow, a frame whose peak is under that level is mixed into the
      // black reference, so slow drift in the picture is followed.
      measure({ frame, blendBelow = 0 }) {
        if (!ref) throw new Error('No black reference frame yet');
        const g = gray(frame);
        cv.subtract(g, ref, diff, empty, -1); // negatives clamp to 0
        cv.GaussianBlur(diff, blur, ksize, 0, 0, cv.BORDER_DEFAULT);
        const mm = cv.minMaxLoc(blur, empty);
        const res = { peak: mm.maxVal, x: mm.maxLoc.x, y: mm.maxLoc.y, w: blur.cols, h: blur.rows };
        Object.assign(res, centroid(res.peak, res.x, res.y));
        if (blendBelow && res.peak < blendBelow) {
          cv.addWeighted(ref, 0.5, g, 0.5, 0, ref);
          res.blended = true;
        }
        g.delete();
        return res;
      },

      // How much of the picture got brighter than the black reference, and where.
      // Used to find the projected area when the whole screen flashes white.
      area({ frame, thresh }) {
        if (!ref) throw new Error('No black reference frame yet');
        const g = gray(frame);
        cv.subtract(g, ref, diff, empty, -1);
        cv.GaussianBlur(diff, blur, ksize, 0, 0, cv.BORDER_DEFAULT);
        g.delete();
        const w = blur.cols;
        const h = blur.rows;
        const d = blur.data;
        const cols = new Uint32Array(w);
        const rows = new Uint32Array(h);
        let n = 0, sum = 0, total = 0, peak = 0;
        for (let y = 0; y < h; y += 2) {
          const row = y * w;
          for (let x = 0; x < w; x += 2) {
            const v = d[row + x];
            sum += v;
            total++;
            if (v > peak) peak = v;
            if (v >= thresh) { n++; cols[x]++; rows[y]++; }
          }
        }
        // Robust extent: ignore the outermost 2% of bright pixels (stray reflections).
        const range = (hist, len) => {
          const lo = n * 0.02, hi = n * 0.98;
          let acc = 0, a = 0, b = len - 1;
          for (let i = 0; i < len; i++) { acc += hist[i]; if (acc > lo) { a = i; break; } }
          acc = 0;
          for (let i = 0; i < len; i++) { acc += hist[i]; if (acc >= hi) { b = i; break; } }
          return [a, b + 1];
        };
        let bbox = null;
        if (n) {
          const [x0, x1] = range(cols, w);
          const [y0, y1] = range(rows, h);
          bbox = [x0 / w, y0 / h, x1 / w, y1 / h];
        }
        return { frac: n / total, mean: sum / total, peak, bbox, w, h };
      },

      // Warp each painting flat. quads: [{ corners: [[x,y]×4 in frame pixels,
      // TL TR BR BL], w, h }] → [{ width, height, buffer (RGBA) }].
      warp({ frame, quads }) {
        const src = cv.matFromImageData({
          data: new Uint8ClampedArray(frame.buffer, 0, frame.width * frame.height * 4),
          width: frame.width,
          height: frame.height,
        });
        const out = quads.map((q) => {
          const S = toMat(q.corners.flat());
          const D = toMat([0, 0, q.w, 0, q.w, q.h, 0, q.h]);
          const M = cv.getPerspectiveTransform(S, D);
          const dst = new cv.Mat();
          cv.warpPerspective(src, dst, M, new cv.Size(q.w, q.h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
          const buffer = new Uint8ClampedArray(dst.data).buffer;
          S.delete(); D.delete(); M.delete(); dst.delete();
          return { width: q.w, height: q.h, buffer };
        });
        src.delete();
        return out;
      },

      // Homography from src points to dst points: RANSAC to drop outliers,
      // then a least-squares refit on the inliers.
      fit({ src, dst, ransac }) {
        const n = src.length / 2;
        const S = toMat(src);
        const D = toMat(dst);
        const mask = new cv.Mat();
        const Hr = cv.findHomography(S, D, cv.RANSAC, ransac, mask);
        let H = null;
        let keep = [];
        if (!Hr.empty()) {
          keep = Array.from(mask.data.slice(0, n), (v) => (v ? 1 : 0));
          const idx = [];
          keep.forEach((k, i) => { if (k) idx.push(i); });
          if (idx.length >= 4) {
            const S2 = toMat(idx.flatMap((i) => [src[2 * i], src[2 * i + 1]]));
            const D2 = toMat(idx.flatMap((i) => [dst[2 * i], dst[2 * i + 1]]));
            const m2 = new cv.Mat();
            const H2 = cv.findHomography(S2, D2, 0, 3, m2);
            if (!H2.empty()) H = Array.from(H2.data64F);
            H2.delete(); S2.delete(); D2.delete(); m2.delete();
          }
        }
        Hr.delete(); S.delete(); D.delete(); mask.delete();
        if (H) { const k = H[8]; H = H.map((v) => v / k); }
        return { H, mask: keep };
      },
    };

    return {
      handle(type, msg) {
        const h = handlers[type];
        if (!h) throw new Error('Unknown vision command: ' + type);
        return h(msg || {});
      },
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
