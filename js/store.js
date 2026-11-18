// Images (flattened paintings) are kept in IndexedDB: they are too big for
// localStorage. Everything stays on the phone.

const DB = 'gaze-light';
const STORE = 'images';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putImage = (key, blob) => run('readwrite', (s) => s.put(blob, key));
export const getImage = (key) => run('readonly', (s) => s.get(key));
export const deleteImage = (key) => run('readwrite', (s) => s.delete(key));
