// Original song audio (uploads, recordings, YouTube) lives in IndexedDB:
// it's far too large for localStorage. Every call fails soft.
const DB_NAME = "pianogiri";
const STORE = "songAudio";
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Storage aborted"));
      })
  );
}

export const audioStore = {
  put: (id, blob) => run("readwrite", (s) => s.put(blob, id)),
  get: (id) => run("readonly", (s) => s.get(id)).catch(() => null),
  remove: (id) => run("readwrite", (s) => s.delete(id)).catch(() => {}),
};
