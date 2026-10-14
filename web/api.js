/* In-browser implementation of the workspace API.
 *
 * The UI calls api(method, path, body) exactly as it did against the old local
 * Python server; here every route runs against the storage backend instead, so
 * the app keeps working offline.
 */

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const nowIso = () => {
  const d = new Date();
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const MAX_FILE = 20 * 1024 * 1024;

const SCHEMA = {
  tasks: { title: 's', notes: 's', due: 's', priority: 'i', project: 's', done: 'i', repeat: 's' },
  events: { title: 's', start: 's', end: 's', all_day: 'i', location: 's', notes: 's', remind_min: 'n' },
  notes: { title: 's', body: 's', tags: 's', pinned: 'i' },
  templates: { name: 's', subject: 's', body: 's' },
  sheets: { name: 's', data: 's' },
  decks: { name: 's', data: 's' },
};
const DEFAULTS = {
  tasks: { notes: '', due: '', priority: 1, project: '', done: 0, repeat: '' },
  events: { end: '', all_day: 0, location: '', notes: '', remind_min: null },
  notes: { title: '', body: '', tags: '', pinned: 0 },
  templates: { subject: '', body: '' },
  sheets: { data: '[]' },
  decks: { data: '{}' },
};
const REQUIRED = { tasks: 'title', events: 'title', templates: 'name', sheets: 'name', decks: 'name' };

export const DEFAULT_SETTINGS = {
  file_rules: [
    { folder: '画像', ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'] },
    { folder: 'PDF', ext: ['pdf'] },
    { folder: '文書', ext: ['doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages'] },
    { folder: '表計算', ext: ['xls', 'xlsx', 'csv', 'ods', 'numbers'] },
    { folder: 'スライド', ext: ['ppt', 'pptx', 'key', 'odp'] },
    { folder: '圧縮', ext: ['zip', '7z', 'rar', 'tar', 'gz'] },
  ],
  file_name_prefix_date: true,
  mail_from_name: '',
};

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function clean(table, data, partial) {
  const out = {};
  for (const [col, typ] of Object.entries(SCHEMA[table])) {
    if (!(col in data)) continue;
    const v = data[col];
    if (typ === 's') out[col] = v == null ? '' : String(v);
    else if (v === '' || v == null) out[col] = typ === 'n' ? null : 0;
    else {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) throw new ApiError(400, `invalid value for ${col}`);
      out[col] = n;
    }
  }
  if (!partial && REQUIRED[table] && !String(out[REQUIRED[table]] || '').trim()) {
    throw new ApiError(400, `${REQUIRED[table]} is required`);
  }
  return out;
}

export function nextDue(due, repeat) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly' || repeat === 'yearly') {
    const y = d.getFullYear() + (repeat === 'yearly' ? 1 : (d.getMonth() === 11 ? 1 : 0));
    const mo = repeat === 'yearly' ? d.getMonth() : (d.getMonth() + 1) % 12;
    const last = new Date(y, mo + 1, 0).getDate();
    return isoDate(new Date(y, mo, Math.min(d.getDate(), last)));
  } else return null;
  return isoDate(d);
}

// ---- CSV ------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

// ---------------------------------------------------------------------------

export function createApi(store) {
  const sortBy = (list, ...keys) => list.sort((a, b) => {
    for (const k of keys) {
      const r = k(a, b);
      if (r) return r;
    }
    return 0;
  });
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const like = (s, q) => String(s || '').toLowerCase().includes(q.toLowerCase());

  // ---- generic CRUD ----

  function create(table, data) {
    const rec = { ...DEFAULTS[table], ...clean(table, data, false) };
    rec.created = rec.updated = nowIso();
    const id = store.newId();
    store.put(table, id, rec);
    return { ...rec, id };
  }
  function update(table, id, data) {
    if (!store.get(table, id)) throw new ApiError(404, 'not found');
    const fields = clean(table, data, true);
    if (Object.keys(fields).length) {
      fields.updated = nowIso();
      store.patch(table, id, fields);
    }
    return store.get(table, id);
  }
  function remove(table, id) {
    if (!store.get(table, id)) throw new ApiError(404, 'not found');
    store.remove(table, id);
    return { ok: true };
  }

  // ---- tasks / events / notes ----

  function listTasks(q) {
    let list = store.all('tasks');
    const status = q.status || 'open';
    if (status === 'open') list = list.filter(t => !t.done);
    else if (status === 'done') list = list.filter(t => t.done);
    if (q.project) list = list.filter(t => t.project === q.project);
    if (q.q) list = list.filter(t => like(t.title, q.q) || like(t.notes, q.q));
    return sortBy(list, (a, b) => a.done - b.done, (a, b) => (!a.due) - (!b.due), (a, b) => cmp(a.due, b.due),
      (a, b) => b.priority - a.priority, (a, b) => cmp(b.created, a.created));
  }
  function updateTask(id, data) {
    const before = store.get('tasks', id);
    if (!before) throw new ApiError(404, 'not found');
    const task = update('tasks', id, data);
    if (task.done && !before.done && task.repeat) {
      const nxt = nextDue(task.due || isoDate(new Date()), task.repeat);
      if (nxt) create('tasks', { title: task.title, notes: task.notes, due: nxt, priority: task.priority, project: task.project, repeat: task.repeat });
    }
    return task;
  }
  const projects = () => Array.from(new Set(store.all('tasks').map(t => t.project).filter(Boolean))).sort();

  function listEvents(q) {
    const from = q.from || '0000', to = (q.to || '9999') + 'T99';
    return sortBy(store.all('events').filter(e => e.start <= to && (e.end || e.start) >= from), (a, b) => cmp(a.start, b.start));
  }
  function listNotes(q) {
    let list = store.all('notes');
    if (q.q) list = list.filter(n => like(n.title, q.q) || like(n.body, q.q) || like(n.tags, q.q));
    else if (q.tag) list = list.filter(n => n.tags.split(',').map(t => t.trim()).includes(q.tag));
    return sortBy(list, (a, b) => b.pinned - a.pinned, (a, b) => cmp(b.updated, a.updated));
  }

  // ---- settings ----

  function settings() {
    const s = store.get('meta', 'settings') || {};
    return { ...DEFAULT_SETTINGS, ...s, id: undefined };
  }
  function saveSettings(data) {
    const cur = store.get('meta', 'settings') || {};
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in data) next[k] = data[k];
    store.put('meta', 'settings', next);
    return settings();
  }

  // ---- files (tree of {name, parent, dir} records; content in blobs) ----

  const files = () => store.all('files');
  function pathOf(f) {
    const parts = [];
    let cur = f, guard = 0;
    while (cur && guard++ < 64) { parts.unshift(cur.name); cur = cur.parent ? store.get('files', cur.parent) : null; }
    return parts.join('/');
  }
  function resolve(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    let parent = '';
    let node = null;
    for (const p of parts) {
      node = files().find(f => f.parent === parent && f.name === p);
      if (!node) throw new ApiError(404, 'not found');
      parent = node.id;
    }
    return node; // null = root
  }
  function folderId(path) {
    const n = resolve(path);
    if (n && !n.dir) throw new ApiError(400, 'not a folder');
    return n ? n.id : '';
  }
  function safeName(name) {
    name = String(name || '').replace(/\\/g, '/').split('/').pop().trim().replace(/[\x00-\x1f<>:"|?*]/g, '_');
    if (!name || name === '.' || name === '..') throw new ApiError(400, 'invalid name');
    return name;
  }
  function uniqueName(parent, name) {
    const taken = new Set(files().filter(f => f.parent === parent).map(f => f.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
  }
  function listFiles(path) {
    const parent = folderId(path);
    const items = files().filter(f => f.parent === parent).map(f => ({
      name: f.name, path: pathOf(f), dir: !!f.dir, size: f.dir ? null : f.size, modified: f.modified,
    }));
    sortBy(items, (a, b) => b.dir - a.dir, (a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    return { path: parent ? pathOf(store.get('files', parent)) : '', items };
  }
  async function upload(path, name, blob) {
    if (blob.size > MAX_FILE) throw new ApiError(413, `ファイルは ${MAX_FILE / 1024 / 1024}MB までです`);
    const parent = folderId(path);
    const id = store.newId();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = await store.putBlob(id, bytes);
    const rec = { name: uniqueName(parent, safeName(name)), parent, dir: 0, size: bytes.length, type: blob.type || '', chunks: chunks || 1, modified: nowIso() };
    store.put('files', id, rec);
    return { path: pathOf({ ...rec, id }) };
  }
  function mkdir(path, name) {
    const parent = folderId(path);
    name = safeName(name);
    if (files().some(f => f.parent === parent && f.name === name)) throw new ApiError(409, '同じ名前が既に存在します');
    const id = store.newId();
    store.put('files', id, { name, parent, dir: 1, size: 0, type: '', chunks: 0, modified: nowIso() });
    return { path: pathOf(store.get('files', id)) };
  }
  function rename(path, name) {
    const f = resolve(path);
    if (!f) throw new ApiError(400, 'invalid path');
    name = safeName(name);
    if (files().some(x => x.parent === f.parent && x.name === name && x.id !== f.id)) throw new ApiError(409, '同じ名前が既に存在します');
    store.patch('files', f.id, { name, modified: nowIso() });
    return { path: pathOf(store.get('files', f.id)) };
  }
  function move(path, to) {
    const f = resolve(path);
    const dest = folderId(to);
    if (!f) throw new ApiError(400, 'invalid path');
    for (let cur = dest; cur; cur = (store.get('files', cur) || {}).parent) {
      if (cur === f.id) throw new ApiError(400, 'フォルダを自身の中には移動できません');
    }
    store.patch('files', f.id, { parent: dest, name: uniqueName(dest, f.name) });
    return { path: pathOf(store.get('files', f.id)) };
  }
  function deleteFile(path) {
    const f = resolve(path);
    if (!f) throw new ApiError(400, 'invalid path');
    const drop = node => {
      files().filter(x => x.parent === node.id).forEach(drop);
      if (!node.dir) store.removeBlob(node.id, node.chunks || 1);
      store.remove('files', node.id);
    };
    drop(f);
    return { ok: true };
  }
  function organize(path) {
    const s = settings();
    const parent = folderId(path);
    const moved = [];
    for (const f of files().filter(x => x.parent === parent && !x.dir).sort((a, b) => cmp(a.name, b.name))) {
      const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
      const rule = (s.file_rules || []).find(r => (r.ext || []).map(e => e.toLowerCase().replace(/^\./, '')).includes(ext));
      if (!rule) continue;
      const folderName = safeName(rule.folder);
      let folder = files().find(x => x.parent === parent && x.dir && x.name === folderName);
      if (!folder) { mkdir(path, folderName); folder = files().find(x => x.parent === parent && x.dir && x.name === folderName); }
      let name = f.name;
      if (s.file_name_prefix_date && !/^\d{4}-\d{2}-\d{2}_/.test(name)) name = (f.modified || nowIso()).slice(0, 10) + '_' + name;
      const from = pathOf(f);
      store.patch('files', f.id, { parent: folder.id, name: uniqueName(folder.id, name) });
      moved.push({ from, to: pathOf(store.get('files', f.id)) });
    }
    return { moved };
  }
  async function readFile(path) {
    const f = resolve(path);
    if (!f || f.dir) throw new ApiError(400, 'not a file');
    const bytes = await store.getBlob(f.id, f.chunks || 1);
    return { name: f.name, type: f.type, bytes };
  }

  // ---- dashboard / search ----

  function dashboard(today) {
    const week = (() => { const d = new Date(today + 'T00:00'); d.setDate(d.getDate() + 7); return isoDate(d); })();
    const open = store.all('tasks').filter(t => !t.done);
    const tasks = sortBy(open.filter(t => t.due && t.due <= today), (a, b) => cmp(a.due, b.due), (a, b) => b.priority - a.priority);
    const undated = sortBy(open.filter(t => !t.due && t.priority >= 2), (a, b) => cmp(b.created, a.created)).slice(0, 10);
    const upcoming = sortBy(open.filter(t => t.due > today && t.due <= week), (a, b) => cmp(a.due, b.due));
    return {
      today, tasks: tasks.concat(undated), upcoming_tasks: upcoming,
      events_today: listEvents({ from: today, to: today }),
      events_week: listEvents({ from: today, to: week }).filter(e => e.start.slice(0, 10) > today),
      notes: listNotes({}).slice(0, 6),
      done_today: store.all('tasks').filter(t => t.done && String(t.updated).startsWith(today)).length,
    };
  }
  function search(q) {
    if (!q.trim()) return {};
    return {
      tasks: store.all('tasks').filter(t => like(t.title, q) || like(t.notes, q)).slice(0, 20),
      events: sortBy(store.all('events').filter(e => like(e.title, q) || like(e.notes, q) || like(e.location, q)), (a, b) => cmp(b.start, a.start)).slice(0, 20),
      notes: listNotes({ q }).slice(0, 20),
      sheets: store.all('sheets').filter(s => like(s.name, q) || like(s.data, q)).slice(0, 20),
      decks: store.all('decks').filter(d => like(d.name, q) || like(d.data, q)).slice(0, 20).map(({ data, ...d }) => d),
      files: files().filter(f => like(f.name, q)).slice(0, 20).map(f => ({ name: f.name, path: pathOf(f), dir: !!f.dir })),
    };
  }

  // ---- backup ----

  async function exportAll() {
    const out = { format: 'myworkspace', version: 1, exported: nowIso(), collections: {}, settings: settings(), files: [] };
    for (const t of Object.keys(SCHEMA)) out.collections[t] = store.all(t);
    for (const f of files()) {
      const rec = { ...f };
      if (!f.dir) {
        try {
          const bytes = await store.getBlob(f.id, f.chunks || 1);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          rec.data = btoa(bin);
        } catch (e) { rec.data = null; rec.error = e.message; }
      }
      out.files.push(rec);
    }
    return out;
  }
  async function importAll(data) {
    if (!data || data.format !== 'myworkspace') throw new ApiError(400, 'My Workspace のバックアップ形式ではありません');
    let n = 0;
    for (const t of Object.keys(SCHEMA)) {
      for (const rec of (data.collections || {})[t] || []) {
        const id = String(rec.id || store.newId());
        const clean_ = { ...DEFAULTS[t], ...clean(t, rec, true), created: rec.created || nowIso(), updated: rec.updated || nowIso() };
        store.put(t, id, clean_);
        n++;
      }
    }
    if (data.settings) saveSettings(data.settings);
    for (const f of data.files || []) {
      const id = String(f.id);
      let chunks = 0;
      if (!f.dir && f.data != null) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        chunks = await store.putBlob(id, bytes);
      }
      store.put('files', id, { name: f.name, parent: String(f.parent || ''), dir: f.dir ? 1 : 0, size: f.size || 0, type: f.type || '', chunks: chunks || (f.dir ? 0 : 1), modified: f.modified || nowIso() });
      n++;
    }
    return { imported: n };
  }

  // ---- router ----

  const CRUD = ['tasks', 'events', 'notes', 'templates', 'sheets', 'decks'];

  async function route(method, path, body) {
    const [p, qs = ''] = path.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs));
    const parts = p.split('/').filter(Boolean);
    const [head, ...rest] = parts;

    if (CRUD.includes(head)) {
      if (head === 'sheets' && rest[0] === 'import' && method === 'POST') {
        return create('sheets', { name: body.name || 'インポート', data: JSON.stringify(parseCsv(body.csv || '')) });
      }
      if (!rest.length) {
        if (method === 'GET') {
          if (head === 'tasks') return listTasks(q);
          if (head === 'events') return listEvents(q);
          if (head === 'notes') return listNotes(q);
          const list = sortBy(store.all(head), (a, b) => cmp(b.updated, a.updated));
          return head === 'sheets' || head === 'decks' ? list.map(({ data, ...s }) => s) : list;
        }
        if (method === 'POST') return create(head, body || {});
        throw new ApiError(405, 'method not allowed');
      }
      const id = rest[0];
      if (method === 'GET') {
        const item = store.get(head, id);
        if (!item) throw new ApiError(404, 'not found');
        return item;
      }
      if (method === 'PUT') return head === 'tasks' ? updateTask(id, body || {}) : update(head, id, body || {});
      if (method === 'DELETE') return remove(head, id);
    }
    if (head === 'dashboard') return dashboard(q.today || isoDate(new Date()));
    if (head === 'projects') return projects();
    if (head === 'search') return search(q.q || '');
    if (head === 'settings') return method === 'PUT' ? saveSettings(body || {}) : settings();
    if (head === 'files') {
      const action = rest[0] || '';
      if (method === 'GET' && !action) return listFiles(q.path);
      if (method === 'POST' && action === 'upload') return upload(q.path, q.name, body);
      if (method === 'POST' && action === 'mkdir') return mkdir(body.path, body.name);
      if (method === 'POST' && action === 'rename') return rename(body.path, body.name);
      if (method === 'POST' && action === 'move') return move(body.path, body.to);
      if (method === 'POST' && action === 'organize') return organize(body.path);
      if (method === 'DELETE' && !action) return deleteFile(q.path);
    }
    throw new ApiError(404, 'not found');
  }

  return { route, readFile, exportAll, importAll, sheetCsv: id => toCsv(JSON.parse((store.get('sheets', id) || {}).data || '[]')) };
}
