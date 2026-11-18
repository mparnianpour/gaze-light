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
export function generate(segs, { cover = 0.5, seed = (Math.random() * 2 ** 31) | 0 } = {}) {
  const r = rng(seed);
  const palette = PALETTES[Math.floor(r() * PALETTES.length)];
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
