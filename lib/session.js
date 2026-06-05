// Shared IDB session — DB 'physiq' v3, store 'session', key 'active'
const SESSION_TTL = 24 * 60 * 60 * 1000;

function openSessionDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('physiq', 3);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('audio'))   db.createObjectStore('audio');
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function readSession() {
  return openSessionDB().then(db => new Promise(resolve => {
    const tx  = db.transaction('session', 'readonly');
    const get = tx.objectStore('session').get('active');
    get.onsuccess = () => {
      const s = get.result;
      if (!s || Date.now() - s.createdAt > SESSION_TTL) return resolve(null);
      resolve(s);
    };
    get.onerror = () => resolve(null);
  })).catch(() => null);
}

function writeSession(patch) {
  return openSessionDB().then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction('session', 'readwrite');
    const store = tx.objectStore('session');
    const get   = store.get('active');
    get.onsuccess = () => {
      const now  = Date.now();
      const prev = get.result;
      const base = prev && (now - prev.createdAt <= SESSION_TTL) ? prev : null;
      const next = base
        ? { ...base, ...patch, updatedAt: now }
        : { sessionId: now, createdAt: now, updatedAt: now, patient: '', date: '', rom: null, assessment: null, force: null, ...patch };
      store.put(next, 'active');
      tx.oncomplete = () => resolve(next);
      tx.onerror    = () => reject();
    };
    get.onerror = () => reject();
  })).catch(() => null);
}

function clearSession() {
  return openSessionDB().then(db => new Promise(resolve => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').delete('active');
    tx.oncomplete = () => resolve();
    tx.onerror    = () => resolve();
  })).catch(() => null);
}
