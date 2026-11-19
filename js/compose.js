// Compositions: which segments of each painting are filled, and with which
// colour. Groups of colour grow across neighbouring segments, so the fills
// become larger shapes that still follow the painting's own forms.
import { load, save } from './util.js';

export const PALETTES = [
  ['#8c1f2c', '#e3a33a', '#2c9c98', '#f3ede2', '#2c2a2b'],
  ['#3b5bd6', '#6a2b63', '#e8772b', '#f3ede2', '#a7b1c8'],
  ['#5a3a26', '#c2452f', '#f1d36b', '#2f6f6b', '#efe6d6'],
  ['#1f2b4a', '#d8b26a', '#9b2e5f', '#e9e4da', '#5c6b3e'],
  ['#2a2a2a', '#d8d1c2', '#8a2432', '#6d8fbf', '#c98a3a'],
  ['#e07a5f', '#3d405b', '#81b29a', '#f2cc8f', '#f4f1de'],
  ['#f28c28', '#2b2d42', '#ef233c', '#edf2f4', '#8d99ae'],
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
];

// ---- colour: OKLCH (lightness, chroma, hue) ----
// Chroma is given as a share of the most saturated colour sRGB can show at
// that lightness and hue, so "70% chroma" looks equally strong for every hue.

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklch(r, g, b) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360];
}

function oklchToLinear(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

export function maxChroma(L, h) {
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid; }
  return lo;
}

export function oklchHex(L, C, h) {
  const rgb = oklchToLinear(L, C, h).map((v) => Math.round(Math.min(1, Math.max(0, toSrgb(Math.min(1, Math.max(0, v))))) * 255));
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// The main hues of a painting: a chroma-weighted hue histogram, its peaks,
// and the typical lightness of each. imageData: ImageData (any size).
// White balance: the bright, nearly neutral pixels (canvas ground, white paint)
// are taken as white, and every colour is corrected by the same factors. This
// undoes a warm or cool cast from the photo or the camera.
export function whiteBalance(imageData) {
  const d = imageData.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const [L, C] = rgbToOklch(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    if (L > 0.62 && C < 0.08) { r += toLin(d[i] / 255); g += toLin(d[i + 1] / 255); b += toLin(d[i + 2] / 255); n++; }
  }
  if (n < 50) return [1, 1, 1];
  const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n;
  return [y / (r / n), y / (g / n), y / (b / n)];
}

const balanced = (v, f) => toSrgb(Math.min(1, toLin(v / 255) * f));

export function paintingHues(imageData, { minChroma = 0.035, bins = 36, max = 7, balance = true } = {}) {
  const d = imageData.data;
  const wb = balance ? whiteBalance(imageData) : [1, 1, 1];
  const w = new Float64Array(bins), lsum = new Float64Array(bins), hsx = new Float64Array(bins), hsy = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < d.length; i += 16) { // every 4th pixel is plenty
    const [L, C, h] = rgbToOklch(balanced(d[i], wb[0]), balanced(d[i + 1], wb[1]), balanced(d[i + 2], wb[2]));
    if (C < minChroma) continue; // skip near-neutral colours (canvas, greys)
    const k = Math.floor((h / 360) * bins) % bins;
    const wt = C * Math.sqrt(C); // vivid colours count more than dull ones
    w[k] += wt; lsum[k] += L * wt; total += wt;
    hsx[k] += Math.cos((h * Math.PI) / 180) * wt; hsy[k] += Math.sin((h * Math.PI) / 180) * wt;
  }
  if (!total) return [];
  const sm = Array.from(w, (_, k) => w[(k + bins - 1) % bins] * 0.25 + w[k] * 0.5 + w[(k + 1) % bins] * 0.25);
  const peaks = [];
  for (let k = 0; k < bins; k++) {
    if (sm[k] >= sm[(k + bins - 1) % bins] && sm[k] > sm[(k + 1) % bins] && sm[k] > total * 0.015) {
      const ks = [(k + bins - 1) % bins, k, (k + 1) % bins];
      const x = ks.reduce((a, j) => a + hsx[j], 0), y = ks.reduce((a, j) => a + hsy[j], 0);
      const wt = ks.reduce((a, j) => a + w[j], 0);
      peaks.push({ hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, L: ks.reduce((a, j) => a + lsum[j], 0) / wt, weight: wt / total });
    }
  }
  return peaks.sort((a, b) => b.weight - a.weight).slice(0, max);
}

// Palettes from a painting's hues, every colour at `chroma` (0..1) of the
// most saturated colour possible at its lightness and hue.
export function chromaPalettes(hues, { chroma = 0.7, count = 10, seed = 7 } = {}) {
  if (!hues.length) return [];
  const r = rng(seed);
  const levels = [0.38, 0.52, 0.66, 0.8];
  const colour = (hue, L) => oklchHex(L, chroma * maxChroma(L, hue), hue);
  const out = [];
  for (let p = 0; p < count; p++) {
    const n = Math.min(hues.length, 3 + Math.floor(r() * 2));
    const pick = [...hues].sort(() => r() - 0.5).slice(0, n);
    const pal = pick.map((h, i) => colour(h.hue, i === 0 ? Math.min(0.85, Math.max(0.35, h.L)) : levels[Math.floor(r() * levels.length)]));
    // one more of the first hue, lighter or darker, so a palette has a light and a dark
    pal.push(colour(pick[0].hue, pick[0].L > 0.6 ? 0.42 : 0.8));
    out.push(pal);
  }
  return out;
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Area and neighbours of every segment (needed to grow colour groups).
export function analyze(seg) {
  if (seg.area) return seg;
  const { w, h, ids, n } = seg;
  const area = new Int32Array(n);
  const adj = Array.from({ length: n }, () => new Map());
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = ids[i];
      area[a]++;
      if (x + 1 < w && ids[i + 1] !== a) { const b = ids[i + 1]; adj[a].set(b, (adj[a].get(b) || 0) + 1); adj[b].set(a, (adj[b].get(a) || 0) + 1); }
      if (y + 1 < h && ids[i + w] !== a) { const b = ids[i + w]; adj[a].set(b, (adj[a].get(b) || 0) + 1); adj[b].set(a, (adj[b].get(a) || 0) + 1); }
    }
  }
  seg.area = area;
  seg.adj = adj;
  return seg;
}

// segs: [{ pid, seg }] → { seed, palette, fills: { [pid]: number[] (colour index or -1 per segment) } }
export function generate(segs, { cover = 0.5, seed = (Math.random() * 2 ** 31) | 0, avoid = null, palettes = PALETTES } = {}) {
  const r = rng(seed);
  const PAL = palettes && palettes.length ? palettes : PALETTES;
  let pi = Math.floor(r() * PAL.length);
  // Never the same palette twice in a row.
  if (avoid && PAL.length > 1 && PAL[pi].join() === avoid.join()) pi = (pi + 1 + Math.floor(r() * (PAL.length - 1))) % PAL.length;
  const palette = PAL[pi];
  const fills = {};
  for (const { pid, seg } of segs) {
    analyze(seg);
    const N = seg.w * seg.h;
    const fill = new Array(seg.n).fill(-1);
    const target = Math.min(0.9, Math.max(0.1, cover + (r() - 0.5) * 0.2)) * N;
    const groups = 8 + Math.floor(r() * 6);
    const seeds = [...Array(seg.n).keys()].filter((i) => seg.area[i] > N * 0.002);
    for (let i = seeds.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [seeds[i], seeds[j]] = [seeds[j], seeds[i]]; }
    let covered = 0;
    for (let gi = 0; gi < groups * 3 && covered < target && seeds.length; gi++) {
      const s0 = seeds.pop();
      if (fill[s0] >= 0) continue;
      const col = Math.floor(r() * palette.length);
      const goal = (target / groups) * (0.4 + r() * 1.2);
      const queue = [s0];
      let got = 0;
      while (queue.length && got < goal) {
        const s = queue.shift();
        if (fill[s] >= 0) continue;
        fill[s] = col;
        got += seg.area[s];
        covered += seg.area[s];
        const nb = [...seg.adj[s].entries()].filter(([b]) => fill[b] < 0).sort((a, b) => b[1] - a[1]);
        for (const [b] of nb) if (r() < 0.7) queue.push(b);
      }
    }
    fills[pid] = fill;
  }
  return { seed, palette, fills };
}

// ---- saved compositions (on the phone) ----

const KEY = 'gaze.compositions';

export function savedCompositions() { return load(KEY, []); }

// segAt: { [pid]: segmentation timestamp } so a composition is only used with
// the segments it was made for.
export function saveComposition(comp, segAt) {
  const list = savedCompositions();
  if (list.some((c) => c.seed === comp.seed && JSON.stringify(c.segAt) === JSON.stringify(segAt))) return list.length;
  list.push({ id: 'c' + Date.now().toString(36), at: Date.now(), seed: comp.seed, palette: comp.palette, fills: comp.fills, segAt });
  save(KEY, list);
  return list.length;
}

export function clearCompositions() { save(KEY, []); }

export function usableSaved(segAt) {
  return savedCompositions().filter((c) => Object.keys(segAt).every((pid) => c.segAt?.[pid] === segAt[pid]));
}
