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
    deleteImage(id).catch(() => {});
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
  async setImage(p, img) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.buffer), img.width, img.height), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    await putImage(p.id, blob);
    p.image = { w: img.width, h: img.height, at: Date.now(), bytes: blob.size };
    const old = this.urls.get(p.id);
    if (old) URL.revokeObjectURL(old);
    this.urls.set(p.id, URL.createObjectURL(blob));
    this.save();
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
