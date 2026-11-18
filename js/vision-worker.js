// Background worker that owns OpenCV.js. Loading and starting the library
// takes several seconds on a phone; here it can't freeze the page.
/* global importScripts, createVisionCore */

// Pinned to one version (about 10 MB, cached by the browser after the first load).
const OPENCV_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.10.0/opencv.js',
];

importScripts('vision-core.js');

let core = null;
let starting = null;

function start() {
  if (starting) return starting;
  starting = (async () => {
    const t0 = Date.now();
    let lastError = null;
    let loaded = false;
    for (const src of OPENCV_SOURCES) {
      try {
        importScripts(src);
        loaded = true;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!loaded) throw new Error('Could not download OpenCV.js' + (lastError ? ' (' + lastError.message + ')' : ''));
    let cv = self.cv;
    if (cv instanceof Promise) cv = await cv;
    while (!(cv && typeof cv.Mat === 'function')) {
      if (Date.now() - t0 > 90000) throw new Error('OpenCV.js did not start');
      await new Promise((r) => setTimeout(r, 50));
      cv = self.cv instanceof Promise ? await self.cv : self.cv;
    }
    core = createVisionCore(cv);
    return { ms: Date.now() - t0 };
  })();
  return starting;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const ready = await start();
    const result = type === 'init' ? ready : core.handle(type, e.data);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

start().catch(() => { /* reported on the first message */ });
