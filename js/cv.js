// Loads OpenCV.js once and resolves with the ready `cv` object.
// Official builds differ: some expose `cv` as a Promise, others as a Module
// that fills in after the WebAssembly runtime starts. This handles both.

// Pinned to one version (about 10 MB, cached by the browser after the first load).
const SOURCES = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.10.0/opencv.js',
];

let ready = null;

function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
}

async function settle() {
  const t0 = performance.now();
  for (;;) {
    let cv = window.cv;
    if (cv instanceof Promise) {
      cv = await cv;
      window.cv = cv;
    }
    if (cv && typeof cv.Mat === 'function') return cv;
    if (performance.now() - t0 > 60000) throw new Error('OpenCV.js did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function loadOpenCV() {
  if (ready) return ready;
  ready = (async () => {
    let lastError;
    for (const src of SOURCES) {
      try {
        await addScript(src);
        return await settle();
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  })();
  return ready;
}
