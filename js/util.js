export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const params = new URLSearchParams(location.search);

export function load(key, fallback = null) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

export function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function waitFor(test, timeout = 5000, every = 50) {
  const t0 = performance.now();
  while (!test()) {
    if (performance.now() - t0 > timeout) return false;
    await sleep(every);
  }
  return true;
}
