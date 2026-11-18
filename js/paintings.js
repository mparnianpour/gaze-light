// The paintings: four corners each (in the camera picture), a name, and a
// flattened image. Corners live in localStorage, images in IndexedDB.
import { load, save } from './util.js';
import { putImage, getImage, deleteImage } from './store.js';
import { homography4, sortCorners } from './geometry.js';

const KEY = 'gaze.paintings';
const MAX_SIDE = 1568; // largest image side worth sending to Claude

export class Paintings {
  constructor() {
    this.list = load(KEY, []);
    this.urls = new Map();
  }

  save() { save(KEY, this.list); }

  get(id) { return this.list.find((p) => p.id === id); }

  // corners: four [u, v] camera-normalised points in any order.
  add(corners, aspect) {
    const used = new Set(this.list.map((p) => p.name));
    let n = this.list.length + 1;
    while (used.has(`Painting ${n}`)) n++;
    const p = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: `Painting ${n}`,
      corners: sortCorners(corners, aspect),
      image: null,
    };
    this.list.push(p);
    this.save();
    return p;
  }

  remove(id) {
    this.list = this.list.filter((p) => p.id !== id);
    this.save();
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.segCache?.delete(id);
    deleteImage(id).catch(() => {});
    deleteImage(`${id}:seg`).catch(() => {});
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p) return;
    p.name = name.trim() || p.name;
    this.save();
  }

  // After moving a corner, put the four back in TL, TR, BR, BL order.
  cornersChanged(p, aspect) {
    p.corners = sortCorners(p.corners, aspect);
    if (p.image) p.image.stale = true;
    this.save();
  }

  // Painting coordinates (0..1 across, 0..1 down) → camera-normalised.
  toCamera(p) {
    return homography4([[0, 0], [1, 0], [1, 1], [0, 1]], p.corners);
  }

  // Size of the flattened image, from the painting's size in the camera frame.
  flatSize(p, camW, camH) {
    const c = p.corners.map(([u, v]) => [u * camW, v * camH]);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(d(c[0], c[1]), d(c[3], c[2]));
    const h = Math.max(d(c[0], c[3]), d(c[1], c[2]));
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    return [Math.max(32, Math.round(w * s)), Math.max(32, Math.round(h * s))];
  }

  // Store a flattened image ({ width, height, buffer }) as JPEG.
  async setImage(p, img, source = 'camera') {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.buffer), img.width, img.height), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    await this.storeImage(p, blob, img.width, img.height, source);
  }

  async storeImage(p, blob, w, h, source) {
    await putImage(p.id, blob);
    p.image = { w, h, at: Date.now(), bytes: blob.size, source };
    const old = this.urls.get(p.id);
    if (old) URL.revokeObjectURL(old);
    this.urls.set(p.id, URL.createObjectURL(blob));
    // A new image means new segments.
    p.seg = null;
    this.segCache?.delete(p.id);
    deleteImage(`${p.id}:seg`).catch(() => {});
    this.save();
  }

  // Your own photo of the painting, cropped to the canvas edges. It is
  // stretched to the painting's proportions as seen through its corners.
  async setPhoto(p, file) {
    const bmp = await createImageBitmap(file);
    const [fw, fh] = this.flatSize(p, 1920, 1080);
    const aspect = fw / fh;
    let w = Math.min(MAX_SIDE, bmp.width);
    let h = Math.round(w / aspect);
    if (h > MAX_SIDE) { h = MAX_SIDE; w = Math.round(h * aspect); }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    await this.storeImage(p, blob, w, h, 'photo');
  }

  // The painting's image as ImageData, at most `maxSide` pixels on its long side.
  async imageData(p, maxSide = 500) {
    const blob = await this.imageBlob(p);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return g.getImageData(0, 0, w, h);
  }

  // ---- segments ----

  async saveSegments(p, seg, params) {
    await putImage(`${p.id}:seg`, new Blob([seg.ids.buffer]));
    p.seg = { w: seg.w, h: seg.h, n: seg.n, at: Date.now(), params };
    this.segCache = this.segCache || new Map();
    this.segCache.set(p.id, { ...seg, at: p.seg.at });
    this.save();
  }

  async loadSegments(p) {
    if (!p.seg) return null;
    this.segCache = this.segCache || new Map();
    const hit = this.segCache.get(p.id);
    if (hit && hit.at === p.seg.at) return hit;
    try {
      const blob = await getImage(`${p.id}:seg`);
      if (!blob) return null;
      const ids = new Uint16Array(await blob.arrayBuffer());
      if (ids.length !== p.seg.w * p.seg.h) return null;
      const seg = { w: p.seg.w, h: p.seg.h, n: p.seg.n, ids, at: p.seg.at };
      this.segCache.set(p.id, seg);
      return seg;
    } catch {
      return null;
    }
  }

  async imageURL(p) {
    if (!p.image) return null;
    if (this.urls.has(p.id)) return this.urls.get(p.id);
    try {
      const blob = await getImage(p.id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      this.urls.set(p.id, url);
      return url;
    } catch {
      return null;
    }
  }

  async imageBlob(p) {
    try { return p.image ? await getImage(p.id) : null; } catch { return null; }
  }
}
