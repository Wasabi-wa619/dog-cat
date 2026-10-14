/* Data storage backends.
 *
 * Both backends keep every collection in memory (`cache`) so the UI can query
 * synchronously-fast, and persist changes in the background:
 *   - LocalBackend:    IndexedDB in this browser only (no account, no sync)
 *   - FirebaseBackend: Firestore with offline persistence. Edits made offline
 *                      are queued on the device and uploaded automatically.
 */

export const COLLECTIONS = ['tasks', 'events', 'notes', 'templates', 'sheets', 'files', 'meta'];
export const CHUNK = 700 * 1024; // bytes per file chunk (Firestore docs max out at 1 MiB)

const stable = v => JSON.stringify(v, Object.keys(v || {}).sort());

class BaseBackend {
  constructor() {
    this.cache = Object.fromEntries(COLLECTIONS.map(c => [c, new Map()]));
    this.listeners = new Set();     // called with (collection) on remote changes
    this.statusListeners = new Set();
    this.status = 'synced';
  }
  onRemoteChange(fn) { this.listeners.add(fn); }
  onStatus(fn) { this.statusListeners.add(fn); fn(this.status); }
  setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    this.statusListeners.forEach(fn => fn(s));
  }
  newId() {
    const a = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  }
  all(col) { return Array.from(this.cache[col].values()); }
  get(col, id) { const v = this.cache[col].get(id); return v ? { ...v } : null; }
  // Apply a snapshot coming from storage; returns true if the data changed.
  applyIncoming(col, id, data) {
    const cur = this.cache[col].get(id);
    if (data && data._deleted) data = null;
    if (data) { data = { ...data }; delete data._mt; }
    if (data === null) {
      if (!cur) return false;
      this.cache[col].delete(id);
      return true;
    }
    const next = { ...data, id };
    if (cur && stable(cur) === stable(next)) return false;
    this.cache[col].set(id, next);
    return true;
  }
}

// ---------------------------------------------------------------------------

export class LocalBackend extends BaseBackend {
  constructor(name = 'myworkspace-local') {
    super();
    this.name = name;
    this.kind = 'local';
    this.label = 'この端末のみ（同期なし）';
  }
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        for (const c of [...COLLECTIONS, 'blobs']) req.result.createObjectStore(c);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async start() {
    this.db = await this.open();
    await Promise.all(COLLECTIONS.map(col => new Promise((resolve, reject) => {
      const tx = this.db.transaction(col);
      const req = tx.objectStore(col).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        this.cache[col].set(cur.key, { ...cur.value, id: cur.key });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    })));
  }
  tx(store, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, 'readwrite');
      fn(t.objectStore(store));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
  put(col, id, data) {
    const rec = { ...data };
    delete rec.id;
    this.cache[col].set(id, { ...rec, id });
    return this.tx(col, s => s.put(rec, id));
  }
  patch(col, id, fields) {
    const cur = this.cache[col].get(id);
    if (!cur) return Promise.resolve();
    return this.put(col, id, { ...cur, ...fields });
  }
  remove(col, id) {
    this.cache[col].delete(id);
    return this.tx(col, s => s.delete(id));
  }
  putBlob(fileId, bytes) { return this.tx('blobs', s => s.put(bytes, fileId)); }
  removeBlob(fileId) { return this.tx('blobs', s => s.delete(fileId)); }
  getBlob(fileId) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('blobs').objectStore('blobs').get(fileId);
      req.onsuccess = () => resolve(req.result || new Uint8Array());
      req.onerror = () => reject(req.error);
    });
  }
  async wipe() {
    for (const c of [...COLLECTIONS, 'blobs']) await this.tx(c, s => s.clear());
    COLLECTIONS.forEach(c => this.cache[c].clear());
  }
}

// ---------------------------------------------------------------------------

export class FirebaseBackend extends BaseBackend {
  constructor(fb, firestore, user) {
    super();
    this.fb = fb;          // the vendored firebase module
    this.fs = firestore;
    this.user = user;
    this.kind = 'firebase';
    this.label = user.email || 'アカウント';
    this.pending = new Map();  // collection -> hasPendingWrites
    this.unsubs = [];
  }
  ref(col, id) { return this.fb.doc(this.fs, 'users', this.user.uid, col, id); }
  colRef(col) { return this.fb.collection(this.fs, 'users', this.user.uid, col); }

  start() {
    const { onSnapshot } = this.fb;
    const firstLoads = COLLECTIONS.map(col => new Promise(resolve => {
      let first = true;
      const unsub = onSnapshot(this.colRef(col), { includeMetadataChanges: true }, snap => {
        let changed = false;
        for (const ch of snap.docChanges({ includeMetadataChanges: false })) {
          const data = ch.type === 'removed' ? null : ch.doc.data();
          if (this.applyIncoming(col, ch.doc.id, data)) changed = true;
        }
        this.pending.set(col, snap.metadata.hasPendingWrites);
        this.refreshStatus(snap.metadata.fromCache);
        if (first) { first = false; resolve(); } else if (changed) this.listeners.forEach(fn => fn(col));
      }, err => {
        console.error(col, err);
        this.setStatus('error');
        if (first) { first = false; resolve(); }
      });
      this.unsubs.push(unsub);
    }));
    const onNet = () => this.refreshStatus();
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
    this.unsubs.push(() => { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); });
    return Promise.all(firstLoads);
  }
  refreshStatus() {
    if (this.status === 'error' && navigator.onLine) return;
    const pending = Array.from(this.pending.values()).some(Boolean);
    if (!navigator.onLine) this.setStatus(pending ? 'offline-pending' : 'offline');
    else this.setStatus(pending ? 'pending' : 'synced');
  }
  stop() { this.unsubs.forEach(u => u()); this.unsubs = []; }

  // Writes resolve only once the server acknowledges them, which never happens
  // while offline. We update the cache immediately and let them settle later.
  track(promise) {
    promise.catch(err => {
      console.error(err);
      window.dispatchEvent(new CustomEvent('store-error', { detail: err }));
    });
    return Promise.resolve();
  }
  put(col, id, data) {
    const rec = { ...data };
    delete rec.id;
    this.cache[col].set(id, { ...rec, id });
    this.pending.set(col, true);
    this.refreshStatus();
    return this.track(this.fb.setDoc(this.ref(col, id), { ...rec, _mt: this.fb.serverTimestamp() }));
  }
  patch(col, id, fields) {
    const cur = this.cache[col].get(id);
    if (!cur) return Promise.resolve();
    const rec = { ...fields };
    delete rec.id;
    this.cache[col].set(id, { ...cur, ...rec });
    this.pending.set(col, true);
    this.refreshStatus();
    return this.track(this.fb.setDoc(this.ref(col, id), { ...rec, _mt: this.fb.serverTimestamp() }, { merge: true }));
  }
  remove(col, id) {
    this.cache[col].delete(id);
    this.pending.set(col, true);
    this.refreshStatus();
    // A tombstone (not a real delete) so other devices, including the local
    // PC version which only fetches changed documents, learn about it.
    return this.track(this.fb.setDoc(this.ref(col, id), { _deleted: true, _mt: this.fb.serverTimestamp() }));
  }
  async putBlob(fileId, bytes) {
    const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let i = 0; i < n; i++) {
      const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      this.track(this.fb.setDoc(this.ref('chunks', `${fileId}_${i}`), { file: fileId, i, data: this.fb.Bytes.fromUint8Array(part) }));
    }
    return n;
  }
  async getBlob(fileId, chunks) {
    const parts = [];
    for (let i = 0; i < chunks; i++) {
      const snap = await this.fb.getDoc(this.ref('chunks', `${fileId}_${i}`));
      if (!snap.exists()) throw new Error('ファイルのデータがまだこの端末に届いていません（オンラインで再試行してください）');
      parts.push(snap.data().data.toUint8Array());
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  removeBlob(fileId, chunks) {
    for (let i = 0; i < chunks; i++) this.track(this.fb.deleteDoc(this.ref('chunks', `${fileId}_${i}`)));
    return Promise.resolve();
  }
}
