// История на телефоне: IndexedDB, без сервера. Хранятся числа результата; миниатюра — только по согласию.

const DB = 'hemavision-lite', STORE = 'history', VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

export const addRecord = (rec) => tx('readwrite', (s) => s.add(rec));
export const listRecords = () => tx('readonly', (s) => s.getAll());
export const clearRecords = () => tx('readwrite', (s) => s.clear());
