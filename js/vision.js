// Talks to the vision worker. Each call sends one command and resolves with
// the worker's answer. Camera frames are transferred, not copied.

export class Vision {
  constructor() {
    this.worker = new Worker(new URL('./vision-worker.js', import.meta.url));
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'The vision worker failed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.ready = this.call('init');
  }

  call(type, payload = {}, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  // Send a camera frame (ImageData) with a command; the pixel buffer moves to the worker.
  withFrame(type, img, extra = {}) {
    const frame = { width: img.width, height: img.height, buffer: img.data.buffer };
    return this.call(type, { frame, ...extra }, [frame.buffer]);
  }
}
