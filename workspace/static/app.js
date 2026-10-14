/* My Workspace - front-end (vanilla JS, no build step). */
'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.slice(0, 10) + 'T00:00');
  const t = today();
  if (iso.slice(0, 10) === t) return '今日';
  if (iso.slice(0, 10) === addDays(t, 1)) return '明日';
  if (iso.slice(0, 10) === addDays(t, -1)) return '昨日';
  const y = d.getFullYear() !== new Date().getFullYear() ? d.getFullYear() + '/' : '';
  return `${y}${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}
const fmtTime = iso => (iso && iso.length > 10 ? iso.slice(11, 16) : '');
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}
// Status label that tolerates the page having been navigated away from.
function setStatus(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

async function api(method, path, body) {
  const opt = { method, headers: { 'X-Workspace': '1' } };
  if (body !== undefined) {
    if (body instanceof Blob) {
      opt.body = body;
    } else {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
  }
  const res = await fetch('/api/' + path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const GET = p => api('GET', p);

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2200);
}
const fail = e => toast(e.message || String(e), true);

// Modal: returns the box element. Closes on Esc / backdrop click.
function openModal(html, wide = false) {
  const m = $('#modal');
  m.innerHTML = `<div class="box${wide ? ' wide' : ''}">${html}</div>`;
  m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  const first = $('input:not([type=checkbox]),textarea,select', m);
  if (first) setTimeout(() => first.focus(), 0);
  return $('.box', m);
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown (small, safe subset)
// ---------------------------------------------------------------------------

function mdInline(s) {
  s = esc(s);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) { html += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${markdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => mdInline(c.trim()));
      html += '<table><tr>' + cells(line).map(c => `<th>${c}</th>`).join('') + '</tr>';
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) html += '<tr>' + cells(lines[i++]).map(c => `<td>${c}</td>`).join('') + '</tr>';
      html += '</table>';
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      html += ordered ? '<ol>' : '<ul>';
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '');
        let box = '';
        if ((m = item.match(/^\[([ xX])\]\s*(.*)/))) {
          box = `<input type="checkbox" disabled ${m[1] !== ' ' ? 'checked' : ''}> `;
          item = m[2];
        }
        html += `<li>${box}${mdInline(item)}</li>`;
      }
      html += ordered ? '</ol>' : '</ul>';
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|>|\s*([-*]|\d+\.)\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    html += `<p>${buf.map(mdInline).join('<br>')}</p>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {};
let cleanup = null;

async function render() {
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, query = ''] = hash.split('?');
  const [name, ...args] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  $$('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  $('#sidebar').classList.remove('open');
  const fn = routes[name] || routes.dashboard;
  view.innerHTML = '<div class="muted">読み込み中…</div>';
  try {
    await fn(args, params);
  } catch (e) {
    view.innerHTML = `<div class="card">エラー: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
const go = h => { if (location.hash === h) render(); else location.hash = h; };

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function dueLabel(due) {
  if (!due) return '';
  const t = today();
  const cls = due < t ? 'over' : due === t ? 'today' : '';
  return `<span class="due ${cls}">${due < t ? '期限切れ ' : ''}${fmtDate(due)}</span>`;
}

function taskLi(t) {
  return `<li class="task-row prio${t.priority}" data-id="${t.id}">
    <input type="checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''}>
    <span class="grow ${t.done ? 'done-text' : ''}">${esc(t.title)}${t.repeat ? ' <span class="muted small">↻</span>' : ''}</span>
    ${t.project ? `<span class="tag">${esc(t.project)}</span>` : ''}
    ${dueLabel(t.due)}
  </li>`;
}

function eventLi(e, showDate = false) {
  const time = e.all_day ? '終日' : fmtTime(e.start) + (e.end && fmtTime(e.end) ? '–' + fmtTime(e.end) : '');
  return `<li data-event="${e.id}" style="cursor:pointer">
    <span class="due" style="min-width:${showDate ? 120 : 80}px">${showDate ? fmtDate(e.start) + ' ' : ''}${time}</span>
    <span class="grow">${esc(e.title)}</span>
    ${e.location ? `<span class="muted small">${esc(e.location)}</span>` : ''}
  </li>`;
}

// Wire task checkboxes / rows and event rows inside a container.
function bindItems(root, refresh) {
  root.addEventListener('click', async e => {
    const done = e.target.closest('[data-done]');
    if (done) {
      e.stopPropagation();
      try {
        await api('PUT', 'tasks/' + done.dataset.done, { done: done.checked ? 1 : 0 });
        if (done.checked) toast('完了しました');
        refresh();
      } catch (err) { fail(err); }
      return;
    }
    const row = e.target.closest('.task-row');
    if (row) return editTask(+row.dataset.id, refresh);
    const ev = e.target.closest('[data-event]');
    if (ev) return editEvent(+ev.dataset.event, null, refresh);
  });
}

routes.dashboard = async () => {
  const d = await GET('dashboard?today=' + today());
  const now = new Date();
  const hello = now.getHours() < 11 ? 'おはようございます' : now.getHours() < 18 ? 'こんにちは' : 'お疲れさまです';
  const overdue = d.tasks.filter(t => t.due && t.due < d.today).length;
  view.innerHTML = `
    <div class="page-head"><h1>${hello}</h1><span class="muted">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日(${WEEK[now.getDay()]})</span></div>
    <div class="stat">
      <div><span class="muted small">今日やること</span><b>${d.tasks.length}</b></div>
      <div><span class="muted small">期限切れ</span><b style="color:${overdue ? 'var(--danger)' : 'inherit'}">${overdue}</b></div>
      <div><span class="muted small">今日の予定</span><b>${d.events_today.length}</b></div>
      <div><span class="muted small">今日完了</span><b style="color:var(--ok)">${d.done_today}</b></div>
    </div>
    <div class="grid">
      <section class="card"><h2>今日のタスク</h2>
        <ul class="list">${d.tasks.map(taskLi).join('') || '<li class="empty">今日のタスクはありません 🎉</li>'}</ul>
        <form id="dashTask" class="task-add" style="margin:10px 0 0"><input name="title" placeholder="今日のタスクを追加…"></form>
      </section>
      <section class="card"><h2>今日の予定</h2>
        <ul class="list">${d.events_today.map(e => eventLi(e)).join('') || '<li class="empty">予定はありません</li>'}</ul>
        <h2 style="margin-top:16px">今後7日間</h2>
        <ul class="list">${d.events_week.map(e => eventLi(e, true)).join('') || '<li class="empty">予定はありません</li>'}</ul>
      </section>
      <section class="card"><h2>今後のタスク</h2>
        <ul class="list">${d.upcoming_tasks.map(taskLi).join('') || '<li class="empty">ありません</li>'}</ul>
      </section>
      <section class="card"><h2>メモ</h2>
        <ul class="list">${d.notes.map(n => `<li><a class="grow" href="#/notes/${n.id}">${n.pinned ? '📌 ' : ''}${esc(n.title || '無題')}</a><span class="due">${fmtDate(n.updated)}</span></li>`).join('') || '<li class="empty">メモはありません</li>'}</ul>
      </section>
    </div>`;
  bindItems(view, render);
  $('#dashTask').addEventListener('submit', async e => {
    e.preventDefault();
    const title = e.target.title.value.trim();
    if (!title) return;
    const q = parseQuickTask(title);
    try { await api('POST', 'tasks', { ...q, due: q.due || today() }); render(); } catch (err) { fail(err); }
  });
};

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// "資料作成 明日 !" -> {title: "資料作成", due: <tomorrow>, priority: 2}
function parseQuickTask(text) {
  let title = text.trim(), due = '', priority = 1, project = '';
  const words = { '今日': 0, 'きょう': 0, '明日': 1, 'あした': 1, '明後日': 2, 'あさって': 2 };
  for (const [w, n] of Object.entries(words)) {
    const re = new RegExp(`(^|\\s)${w}(?=\\s|$)`);
    if (re.test(title)) { due = addDays(today(), n); title = title.replace(re, ' '); }
  }
  let m = title.match(/(^|\s)(\d{1,2})\/(\d{1,2})(?=\s|$)/);
  if (m) {
    const y = new Date().getFullYear();
    let d = `${y}-${pad(m[2])}-${pad(m[3])}`;
    if (d < today()) d = `${y + 1}-${pad(m[2])}-${pad(m[3])}`;
    due = d;
    title = title.replace(m[0], ' ');
  }
  m = title.match(/(^|\s)#(\S+)/);
  if (m) { project = m[2]; title = title.replace(m[0], ' '); }
  if (/(^|\s)!(?=\s|$)/.test(title)) { priority = 2; title = title.replace(/(^|\s)!(?=\s|$)/, ' '); }
  return { title: title.replace(/\s+/g, ' ').trim() || text.trim(), due, priority, project };
}

const taskState = { status: 'open', project: '' };

routes.tasks = async () => {
  const qs = new URLSearchParams({ status: taskState.status, project: taskState.project });
  const [tasks, projects] = await Promise.all([GET('tasks?' + qs), GET('projects')]);
  const t = today();
  const groups = taskState.status === 'done'
    ? [['完了済み', tasks]]
    : [
      ['期限切れ', tasks.filter(x => !x.done && x.due && x.due < t)],
      ['今日', tasks.filter(x => !x.done && x.due === t)],
      ['今後', tasks.filter(x => !x.done && x.due > t)],
      ['期限なし', tasks.filter(x => !x.done && !x.due)],
      ['完了済み', tasks.filter(x => x.done)],
    ];
  view.innerHTML = `
    <div class="page-head"><h1>タスク</h1>
      <select id="projFilter"><option value="">すべてのプロジェクト</option>${projects.map(p => `<option ${p === taskState.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <div class="seg" id="statusSeg">${[['open', '未完了'], ['done', '完了'], ['all', 'すべて']].map(([k, l]) => `<button data-s="${k}" class="${taskState.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <form id="taskAdd" class="task-add card" style="padding:10px">
      <input name="title" placeholder="タスクを追加（例: 見積書送付 明日 #営業 !）" autocomplete="off">
      <input name="due" type="date" title="期限">
      <select name="priority"><option value="1">優先度: 普通</option><option value="2">優先度: 高</option><option value="0">優先度: 低</option></select>
      <input name="project" list="projList" placeholder="プロジェクト" style="width:140px" value="${esc(taskState.project)}">
      <datalist id="projList">${projects.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
      <button class="btn primary">追加</button>
    </form>
    ${groups.filter(([, l]) => l.length).map(([name, list]) => `
      <section class="card" style="margin-bottom:14px"><h2>${name} <span class="muted small">${list.length}</span></h2>
      <ul class="list">${list.map(taskLi).join('')}</ul></section>`).join('') || '<div class="empty card">タスクはありません</div>'}
  `;
  bindItems(view, render);
  $('#statusSeg').onclick = e => { const b = e.target.closest('button'); if (b) { taskState.status = b.dataset.s; render(); } };
  $('#projFilter').onchange = e => { taskState.project = e.target.value; render(); };
  $('#taskAdd').addEventListener('submit', async e => {
    e.preventDefault();
    const f = formData(e.target);
    if (!f.title.trim()) return;
    const q = parseQuickTask(f.title);
    try {
      await api('POST', 'tasks', { title: q.title, due: f.due || q.due, priority: q.priority === 2 ? 2 : f.priority, project: q.project || f.project });
      render();
      setTimeout(() => $('#taskAdd [name=title]')?.focus(), 50);
    } catch (err) { fail(err); }
  });
  $('#taskAdd [name=title]').focus();
};

async function editTask(id, refresh, preset = {}) {
  const t = id ? await GET('tasks/' + id) : { title: '', notes: '', due: '', priority: 1, project: '', repeat: '', ...preset };
  const projects = await GET('projects');
  const box = openModal(`
    <form class="form">
      <h2>${id ? 'タスクを編集' : '新しいタスク'}</h2>
      <label>タイトル<input name="title" value="${esc(t.title)}" required></label>
      <div class="row">
        <label>期限<input name="due" type="date" value="${esc(t.due)}"></label>
        <label>優先度<select name="priority">${[[2, '高'], [1, '普通'], [0, '低']].map(([v, l]) => `<option value="${v}" ${t.priority == v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label>プロジェクト<input name="project" list="pl" value="${esc(t.project)}"><datalist id="pl">${projects.map(p => `<option value="${esc(p)}">`).join('')}</datalist></label>
        <label>繰り返し<select name="repeat">${[['', 'なし'], ['daily', '毎日'], ['weekdays', '平日'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']].map(([v, l]) => `<option value="${v}" ${t.repeat === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label>メモ<textarea name="notes" rows="5">${esc(t.notes)}</textarea></label>
      <div class="actions">
        ${id ? '<button type="button" class="btn danger left" data-del>削除</button>' : ''}
        <button type="button" class="btn" data-close>キャンセル</button>
        <button class="btn primary">保存</button>
      </div>
    </form>`);
  const form = $('form', box);
  $('[data-close]', box).onclick = closeModal;
  const del = $('[data-del]', box);
  if (del) del.onclick = async () => {
    if (!confirm('このタスクを削除しますか？')) return;
    try { await api('DELETE', 'tasks/' + id); closeModal(); refresh && refresh(); } catch (e) { fail(e); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api(id ? 'PUT' : 'POST', id ? 'tasks/' + id : 'tasks', formData(form));
      closeModal();
      toast('保存しました');
      refresh && refresh();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const calState = { month: today().slice(0, 7) };

routes.calendar = async (args, params) => {
  if (params.m) calState.month = params.m;
  const [y, m] = calState.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const days = [];
  for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(isoDate(d)); }
  const [events, tasks] = await Promise.all([
    GET(`events?from=${days[0]}&to=${days[41]}`),
    GET('tasks?status=open'),
  ]);
  const t = today();
  const evOn = day => events.filter(e => e.start.slice(0, 10) <= day && (e.end || e.start).slice(0, 10) >= day);
  const shift = n => { const d = new Date(y, m - 1 + n, 1); calState.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; render(); };
  view.innerHTML = `
    <div class="page-head"><h1>${y}年${m}月</h1>
      <button class="btn" id="prevM">◀</button><button class="btn" id="todayM">今日</button><button class="btn" id="nextM">▶</button>
      <button class="btn primary" id="newEv">＋ 予定</button>
    </div>
    <div class="cal">
      ${WEEK.map((w, i) => `<div class="dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
      ${days.map((day, i) => `
        <div class="day ${day.slice(0, 7) !== calState.month ? 'other' : ''} ${day === t ? 'today' : ''}" data-day="${day}">
          <span class="num ${i % 7 === 0 ? 'sun' : i % 7 === 6 ? 'sat' : ''}">${+day.slice(8)}</span>
          ${evOn(day).map(e => `<div class="ev" data-event="${e.id}" title="${esc(e.title)}">${e.all_day ? '' : fmtTime(e.start) + ' '}${esc(e.title)}</div>`).join('')}
          ${tasks.filter(x => x.due === day).map(x => `<div class="ev task" data-task="${x.id}" title="${esc(x.title)}">☐ ${esc(x.title)}</div>`).join('')}
        </div>`).join('')}
    </div>`;
  $('#prevM').onclick = () => shift(-1);
  $('#nextM').onclick = () => shift(1);
  $('#todayM').onclick = () => { calState.month = t.slice(0, 7); render(); };
  $('#newEv').onclick = () => editEvent(null, t, render);
  $('.cal').onclick = e => {
    const ev = e.target.closest('[data-event]');
    if (ev) return editEvent(+ev.dataset.event, null, render);
    const tk = e.target.closest('[data-task]');
    if (tk) return editTask(+tk.dataset.task, render);
    const day = e.target.closest('[data-day]');
    if (day) editEvent(null, day.dataset.day, render);
  };
};

async function editEvent(id, day, refresh) {
  const e = id ? await GET('events/' + id) : { title: '', start: day + 'T09:00', end: day + 'T10:00', all_day: 0, location: '', notes: '', remind_min: 10 };
  const sd = e.start.slice(0, 10), st = fmtTime(e.start) || '09:00';
  const ed = (e.end || e.start).slice(0, 10), et = fmtTime(e.end) || '';
  const box = openModal(`
    <form class="form">
      <h2>${id ? '予定を編集' : '新しい予定'}</h2>
      <label>タイトル<input name="title" value="${esc(e.title)}" required></label>
      <label style="display:flex;flex-direction:row;gap:8px;align-items:center"><input type="checkbox" name="all_day" ${e.all_day ? 'checked' : ''}> 終日</label>
      <div class="row"><label>開始日<input type="date" name="sd" value="${sd}" required></label><label class="tm">開始時刻<input type="time" name="st" value="${st}"></label></div>
      <div class="row"><label>終了日<input type="date" name="ed" value="${ed}"></label><label class="tm">終了時刻<input type="time" name="et" value="${et}"></label></div>
      <div class="row">
        <label>場所<input name="location" value="${esc(e.location)}"></label>
        <label>通知<select name="remind_min">${[['', 'なし'], [0, '開始時'], [5, '5分前'], [10, '10分前'], [30, '30分前'], [60, '1時間前'], [1440, '前日']].map(([v, l]) => `<option value="${v}" ${String(e.remind_min ?? '') === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label>メモ<textarea name="notes" rows="4">${esc(e.notes)}</textarea></label>
      <div class="actions">
        ${id ? '<button type="button" class="btn danger left" data-del>削除</button>' : ''}
        <button type="button" class="btn" data-close>キャンセル</button>
        <button class="btn primary">保存</button>
      </div>
    </form>`);
  const form = $('form', box);
  const syncAllDay = () => $$('.tm', box).forEach(l => { l.style.visibility = form.all_day.checked ? 'hidden' : ''; });
  form.all_day.onchange = syncAllDay;
  syncAllDay();
  form.sd.onchange = () => { if (!form.ed.value || form.ed.value < form.sd.value) form.ed.value = form.sd.value; };
  $('[data-close]', box).onclick = closeModal;
  const del = $('[data-del]', box);
  if (del) del.onclick = async () => {
    if (!confirm('この予定を削除しますか？')) return;
    try { await api('DELETE', 'events/' + id); closeModal(); refresh && refresh(); } catch (err) { fail(err); }
  };
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = formData(form);
    const allDay = !!f.all_day;
    const body = {
      title: f.title, location: f.location, notes: f.notes, remind_min: f.remind_min, all_day: allDay ? 1 : 0,
      start: allDay ? f.sd : `${f.sd}T${f.st || '00:00'}`,
      end: allDay ? (f.ed && f.ed !== f.sd ? f.ed : '') : (f.et ? `${f.ed || f.sd}T${f.et}` : ''),
    };
    if (body.end && body.end < body.start) return toast('終了が開始より前です', true);
    try {
      await api(id ? 'PUT' : 'POST', id ? 'events/' + id : 'events', body);
      closeModal();
      toast('保存しました');
      refresh && refresh();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const noteState = { q: '', mode: 'edit' };

routes.notes = async (args) => {
  const notes = await GET('notes?q=' + encodeURIComponent(noteState.q));
  let current = args[0] ? +args[0] : (notes[0] && notes[0].id);
  view.innerHTML = `
    <div class="page-head"><h1>メモ</h1><button class="btn primary" id="newNote">＋ 新規メモ</button></div>
    <div class="split">
      <div class="side">
        <input id="noteQ" type="search" placeholder="メモを検索" value="${esc(noteState.q)}" style="width:100%;margin-bottom:8px">
        <div id="noteList">${notes.map(n => `
          <div class="note-item ${n.id === current ? 'on' : ''}" data-id="${n.id}">
            <div class="t">${n.pinned ? '📌 ' : ''}${esc(n.title || '無題')}</div>
            <div class="p">${fmtDate(n.updated)} ${esc(n.body.slice(0, 60))}</div>
            ${n.tags ? `<div>${n.tags.split(',').filter(Boolean).map(t => `<span class="tag">${esc(t.trim())}</span>`).join('')}</div>` : ''}
          </div>`).join('') || '<div class="empty">メモはありません</div>'}</div>
      </div>
      <div class="editor" id="noteEditor"></div>
    </div>`;
  $('#noteQ').oninput = debounce(e => { noteState.q = e.target.value; render().then(() => { const q = $('#noteQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300);
  $('#noteList').onclick = e => { const it = e.target.closest('[data-id]'); if (it) go('#/notes/' + it.dataset.id); };
  $('#newNote').onclick = async () => {
    try { const n = await api('POST', 'notes', { title: '', body: '' }); noteState.mode = 'edit'; go('#/notes/' + n.id); } catch (e) { fail(e); }
  };
  if (current) await noteEditor(current);
  else $('#noteEditor').innerHTML = '<div class="empty">左上の「新規メモ」から作成できます</div>';
};

async function noteEditor(id) {
  const n = await GET('notes/' + id);
  const ed = $('#noteEditor');
  ed.innerHTML = `
    <div class="bar">
      <input name="title" placeholder="タイトル" value="${esc(n.title)}">
      <div class="seg" id="modeSeg"><button data-m="edit" class="${noteState.mode === 'edit' ? 'on' : ''}">編集</button><button data-m="view" class="${noteState.mode === 'view' ? 'on' : ''}">表示</button></div>
    </div>
    <div class="bar">
      <input name="tags" placeholder="タグ（カンマ区切り）" value="${esc(n.tags)}" style="flex:1">
      <label class="small"><input type="checkbox" name="pinned" ${n.pinned ? 'checked' : ''}> ピン留め</label>
      <button class="btn sm" id="noteToTask" title="未完了のチェック項目をタスクに登録">☐→タスク</button>
      <button class="btn sm danger" id="delNote">削除</button>
      <span class="muted small" id="saveState"></span>
    </div>
    <textarea name="body" placeholder="Markdown で書けます（# 見出し、- リスト、- [ ] チェック、**太字**）" ${noteState.mode === 'view' ? 'hidden' : ''}>${esc(n.body)}</textarea>
    <div class="md" ${noteState.mode === 'edit' ? 'hidden' : ''}>${markdown(n.body)}</div>`;
  const get = name => $(`[name=${name}]`, ed);
  const save = debounce(async () => {
    try {
      await api('PUT', 'notes/' + id, { title: get('title').value, body: get('body').value, tags: get('tags').value, pinned: get('pinned').checked ? 1 : 0 });
      setStatus('saveState', '保存済み');
      const item = $(`#noteList [data-id="${id}"] .t`);
      if (item) item.textContent = (get('pinned').checked ? '📌 ' : '') + (get('title').value || '無題');
    } catch (e) { setStatus('saveState', '保存失敗'); fail(e); }
  }, 700);
  ed.addEventListener('input', () => { setStatus('saveState', '編集中…'); save(); });
  ed.addEventListener('change', e => { if (e.target.name === 'pinned') save(); });
  get('body').addEventListener('keydown', e => {
    // Continue list items on Enter.
    if (e.key !== 'Enter' || e.isComposing) return;
    const ta = e.target, pos = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    const line = ta.value.slice(lineStart, pos);
    const m = line.match(/^(\s*)([-*]|\d+\.)\s(\[[ xX]\]\s)?/);
    if (!m) return;
    e.preventDefault();
    if (line.trim() === m[0].trim()) { ta.setRangeText('', lineStart, pos, 'end'); return save(); }
    const bullet = /\d+\./.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2];
    ta.setRangeText('\n' + m[1] + bullet + ' ' + (m[3] ? '[ ] ' : ''), pos, pos, 'end');
    save();
  });
  $('#modeSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    noteState.mode = b.dataset.m;
    $$('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
    get('body').hidden = noteState.mode === 'view';
    const md = $('.md', ed);
    md.hidden = noteState.mode === 'edit';
    md.innerHTML = markdown(get('body').value);
  };
  $('#delNote').onclick = async () => {
    if (!confirm('このメモを削除しますか？')) return;
    try { await api('DELETE', 'notes/' + id); go('#/notes'); } catch (e) { fail(e); }
  };
  $('#noteToTask').onclick = async () => {
    const items = get('body').value.split('\n').map(l => l.match(/^\s*[-*]\s\[ \]\s+(.+)/)).filter(Boolean).map(m => m[1].trim());
    if (!items.length) return toast('未完了のチェック項目（- [ ] ...）がありません');
    if (!confirm(`${items.length}件をタスクに登録しますか？`)) return;
    try {
      for (const it of items) await api('POST', 'tasks', { ...parseQuickTask(it), notes: 'メモ「' + (get('title').value || '無題') + '」より' });
      toast(`${items.length}件のタスクを登録しました`);
    } catch (e) { fail(e); }
  };
  cleanup = () => save.flush();
}

// ---------------------------------------------------------------------------
// Sheets (with a small formula engine)
// ---------------------------------------------------------------------------

const colName = c => { let s = ''; c++; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };
const colIndex = s => s.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

class FormulaError extends Error {}

function makeEvaluator(data) {
  const cache = new Map();
  const visiting = new Set();
  const raw = (r, c) => (data[r] && data[r][c] != null ? String(data[r][c]) : '');

  function value(r, c) {
    const key = r + ':' + c;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key)) throw new FormulaError('#循環');
    visiting.add(key);
    let v;
    try {
      const s = raw(r, c);
      if (s.startsWith('=')) v = evaluate(s.slice(1));
      else if (s.trim() !== '' && !isNaN(Number(s.replace(/,/g, '')))) v = Number(s.replace(/,/g, ''));
      else v = s;
    } catch (e) {
      v = new FormulaError(e instanceof FormulaError ? e.message : '#エラー');
    } finally {
      visiting.delete(key);
    }
    cache.set(key, v);
    return v;
  }

  function evaluate(src) {
    const tokens = src.match(/\s*("[^"]*"|\d+(?:\.\d+)?|[A-Za-z]+\d+(?::[A-Za-z]+\d+)?|[A-Za-z_]+|<>|<=|>=|[-+*/^&(),<>=%])/g);
    if (!tokens || tokens.join('').replace(/\s/g, '') !== src.replace(/\s/g, '')) throw new FormulaError('#構文');
    let i = 0;
    const peek = () => (tokens[i] || '').trim();
    const next = () => (tokens[i++] || '').trim();
    const num = v => {
      if (v instanceof FormulaError) throw v;
      if (Array.isArray(v)) throw new FormulaError('#値');
      if (v === '' || v == null) return 0;
      if (typeof v === 'boolean') return v ? 1 : 0;
      const n = Number(v);
      if (isNaN(n)) throw new FormulaError('#値');
      return n;
    };
    const flat = args => args.flat().filter(v => { if (v instanceof FormulaError) throw v; return true; });
    const nums = args => flat(args).filter(v => typeof v === 'number');
    const FN = {
      SUM: a => nums(a).reduce((x, y) => x + y, 0),
      AVERAGE: a => { const n = nums(a); if (!n.length) throw new FormulaError('#DIV/0'); return n.reduce((x, y) => x + y, 0) / n.length; },
      MIN: a => (nums(a).length ? Math.min(...nums(a)) : 0),
      MAX: a => (nums(a).length ? Math.max(...nums(a)) : 0),
      COUNT: a => nums(a).length,
      COUNTA: a => flat(a).filter(v => v !== '').length,
      ROUND: a => { const p = Math.pow(10, num(a[1] ?? 0)); return Math.round(num(a[0]) * p) / p; },
      ABS: a => Math.abs(num(a[0])),
      IF: a => (num(a[0]) ? a[1] : (a[2] ?? '')),
      CONCAT: a => flat(a).join(''),
      TODAY: () => today(),
    };

    function primary() {
      const t = next();
      if (t === '(') { const v = compare(); if (next() !== ')') throw new FormulaError('#構文'); return v; }
      if (t === '-') return -num(postfix());
      if (t === '+') return num(postfix());
      if (/^"/.test(t)) return t.slice(1, -1);
      if (/^\d/.test(t)) return Number(t);
      let m;
      if ((m = t.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/))) {
        const r1 = +m[2] - 1, c1 = colIndex(m[1]);
        if (!m[3]) return value(r1, c1);
        const r2 = +m[4] - 1, c2 = colIndex(m[3]);
        const out = [];
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
          for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) out.push(value(r, c));
        return out;
      }
      if (/^[A-Za-z_]+$/.test(t)) {
        const fn = FN[t.toUpperCase()];
        if (t.toUpperCase() === 'TRUE') return true;
        if (t.toUpperCase() === 'FALSE') return false;
        if (!fn || next() !== '(') throw new FormulaError('#名前?');
        const args = [];
        if (peek() !== ')') { do { args.push(compare()); } while (peek() === ',' && next()); }
        if (next() !== ')') throw new FormulaError('#構文');
        return fn(args);
      }
      throw new FormulaError('#構文');
    }
    function postfix() { let v = primary(); while (peek() === '%') { next(); v = num(v) / 100; } return v; }
    function power() { let v = postfix(); while (peek() === '^') { next(); v = Math.pow(num(v), num(postfix())); } return v; }
    function term() {
      let v = power();
      while (peek() === '*' || peek() === '/') {
        const op = next(), r = num(power());
        if (op === '/' && r === 0) throw new FormulaError('#DIV/0');
        v = op === '*' ? num(v) * r : num(v) / r;
      }
      return v;
    }
    function sum() { let v = term(); while (peek() === '+' || peek() === '-') { const op = next(); const r = num(term()); v = op === '+' ? num(v) + r : num(v) - r; } return v; }
    function concat() { let v = sum(); while (peek() === '&') { next(); v = String(v) + String(sum()); } return v; }
    function compare() {
      let v = concat();
      while (['=', '<>', '<', '>', '<=', '>='].includes(peek())) {
        const op = next(), r = concat();
        const a = typeof v === 'number' || typeof r === 'number' ? num(v) : v, b = typeof v === 'number' || typeof r === 'number' ? num(r) : r;
        v = { '=': a === b, '<>': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[op];
      }
      return v;
    }
    const result = compare();
    if (i < tokens.length) throw new FormulaError('#構文');
    if (Array.isArray(result)) throw new FormulaError('#値');
    return result;
  }

  return { value };
}

function displayValue(v) {
  if (v instanceof FormulaError) return { text: v.message, cls: 'err' };
  if (typeof v === 'number') return { text: Number.isInteger(v) ? v.toLocaleString('ja-JP') : (+v.toFixed(10)).toLocaleString('ja-JP', { maximumFractionDigits: 10 }), cls: 'num' };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', cls: 'num' };
  return { text: String(v), cls: '' };
}

routes.sheets = async (args) => {
  if (args[0]) return sheetEditor(+args[0]);
  const sheets = await GET('sheets');
  view.innerHTML = `
    <div class="page-head"><h1>シート</h1>
      <label class="btn">CSV取り込み<input type="file" id="csvIn" accept=".csv,text/csv" hidden></label>
      <button class="btn primary" id="newSheet">＋ 新規シート</button>
    </div>
    <div class="card"><ul class="list">${sheets.map(s => `<li><a class="grow" href="#/sheets/${s.id}">▤ ${esc(s.name)}</a><span class="due">更新 ${fmtDate(s.updated)} ${fmtTime(s.updated)}</span></li>`).join('') || '<li class="empty">シートはありません</li>'}</ul></div>`;
  $('#newSheet').onclick = async () => {
    const name = prompt('シート名', '新しいシート');
    if (!name) return;
    try { const s = await api('POST', 'sheets', { name, data: '[]' }); go('#/sheets/' + s.id); } catch (e) { fail(e); }
  };
  $('#csvIn').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf); // Excel 由来の CSV
    try { const s = await api('POST', 'sheets/import', { name: f.name.replace(/\.csv$/i, ''), csv: text }); go('#/sheets/' + s.id); } catch (err) { fail(err); }
  };
};

async function sheetEditor(id) {
  const sheet = await GET('sheets/' + id);
  let data = [];
  try { data = JSON.parse(sheet.data || '[]'); } catch (e) { data = []; }
  let rows = Math.max(30, data.length + 5), cols = Math.max(10, ...data.map(r => r.length + 1), 0);
  let sel = { r: 0, c: 0 }, editing = false;

  view.innerHTML = `
    <div class="page-head"><h1 id="sheetName" title="クリックで名前変更" style="cursor:pointer">${esc(sheet.name)}</h1>
      <span class="muted small" id="sheetSave"></span>
      <button class="btn" id="addRow">＋ 行</button><button class="btn" id="addCol">＋ 列</button>
      <a class="btn" href="/api/sheets/${id}/csv">CSV出力</a>
      <button class="btn danger" id="delSheet">削除</button>
      <a class="btn" href="#/sheets">一覧へ</a>
    </div>
    <div class="formula-bar"><span class="ref" id="cellRef">A1</span><input id="fx" placeholder="値または =SUM(A1:A10) などの数式"></div>
    <div class="sheet-wrap" tabindex="0" id="sheetWrap"><table class="sheet" id="grid"></table></div>
    <p class="muted small">数式: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, CONCAT, TODAY / 演算子: + - * / ^ % &amp; = &lt;&gt; &lt; &gt;。矢印キーで移動、Enter・入力で編集、Delete で消去、Ctrl+C / Ctrl+V 対応（Excel からの貼り付け可）。</p>`;

  const grid = $('#grid'), fx = $('#fx'), wrap = $('#sheetWrap');
  const get = (r, c) => (data[r] && data[r][c] != null ? String(data[r][c]) : '');
  const set = (r, c, v) => { while (data.length <= r) data.push([]); while (data[r].length <= c) data[r].push(''); data[r][c] = v; };
  const trim = () => {
    const out = data.map(r => { const x = [...r]; while (x.length && x[x.length - 1] === '') x.pop(); return x; });
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  };
  const save = debounce(async () => {
    try { await api('PUT', 'sheets/' + id, { data: JSON.stringify(trim()) }); setStatus('sheetSave', '保存済み'); } catch (e) { fail(e); }
  }, 600);
  const changed = () => { setStatus('sheetSave', '編集中…'); save(); };

  function draw() {
    const ev = makeEvaluator(data);
    let html = '<tr><th class="rh"></th>' + Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join('') + '</tr>';
    for (let r = 0; r < rows; r++) {
      html += `<tr><th class="rh">${r + 1}</th>`;
      for (let c = 0; c < cols; c++) {
        const d = displayValue(ev.value(r, c));
        html += `<td data-r="${r}" data-c="${c}" class="${r === sel.r && c === sel.c ? 'sel' : ''}"><div class="c ${d.cls}">${esc(d.text)}</div></td>`;
      }
      html += '</tr>';
    }
    grid.innerHTML = html;
    updateBar();
  }
  function updateBar() {
    $('#cellRef').textContent = colName(sel.c) + (sel.r + 1);
    if (document.activeElement !== fx) fx.value = get(sel.r, sel.c);
  }
  function cell(r, c) { return $(`td[data-r="${r}"][data-c="${c}"]`, grid); }
  function select(r, c) {
    r = Math.max(0, r); c = Math.max(0, c);
    if (r >= rows) { rows = r + 1; } if (c >= cols) { cols = c + 1; }
    const old = cell(sel.r, sel.c);
    sel = { r, c };
    if (!cell(r, c)) draw();
    if (old) old.classList.remove('sel');
    const td = cell(r, c);
    td.classList.add('sel');
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateBar();
  }
  function startEdit(initial) {
    const td = cell(sel.r, sel.c);
    editing = true;
    td.innerHTML = `<input value="${esc(initial ?? get(sel.r, sel.c))}">`;
    const inp = $('input', td);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.oninput = () => { fx.value = inp.value; };
    inp.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(inp.value); e.key === 'Tab' ? select(sel.r, sel.c + (e.shiftKey ? -1 : 1)) : select(sel.r + (e.shiftKey ? -1 : 1), sel.c); }
      else if (e.key === 'Escape') { editing = false; draw(); wrap.focus(); }
    };
    inp.onblur = () => { if (editing) commit(inp.value); };
  }
  function commit(v) {
    editing = false;
    if (v !== get(sel.r, sel.c)) { set(sel.r, sel.c, v); changed(); }
    draw();
    wrap.focus({ preventScroll: true });
  }

  grid.onclick = e => { const td = e.target.closest('td'); if (td && !editing) { select(+td.dataset.r, +td.dataset.c); wrap.focus({ preventScroll: true }); } };
  grid.ondblclick = e => { const td = e.target.closest('td'); if (td) { select(+td.dataset.r, +td.dataset.c); startEdit(); } };
  wrap.addEventListener('keydown', e => {
    if (editing || e.target !== wrap || e.isComposing) return;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, e.shiftKey ? -1 : 1] }[e.key];
    if (mv) { e.preventDefault(); return select(sel.r + mv[0], sel.c + mv[1]); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); set(sel.r, sel.c, ''); changed(); return draw(); }
    if (e.key === 'F2') { e.preventDefault(); return startEdit(); }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(e.key); }
    // IME (e.g. Japanese) input starts: open the editor and let the IME continue there.
    else if (e.key === 'Process' || e.keyCode === 229) startEdit('');
  });
  wrap.addEventListener('copy', e => { if (editing) return; e.preventDefault(); e.clipboardData.setData('text/plain', get(sel.r, sel.c)); });
  wrap.addEventListener('paste', e => {
    if (editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r/g, '').replace(/\n$/, '');
    text.split('\n').forEach((line, dr) => line.split('\t').forEach((v, dc) => set(sel.r + dr, sel.c + dc, v)));
    rows = Math.max(rows, data.length + 1);
    cols = Math.max(cols, ...data.map(r => r.length));
    changed();
    draw();
  });
  fx.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); set(sel.r, sel.c, fx.value); changed(); draw(); select(sel.r + 1, sel.c); wrap.focus(); } };
  fx.onchange = () => { set(sel.r, sel.c, fx.value); changed(); draw(); };
  $('#addRow').onclick = () => { rows += 10; draw(); };
  $('#addCol').onclick = () => { cols += 1; draw(); };
  $('#sheetName').onclick = async () => {
    const name = prompt('シート名', sheet.name);
    if (!name) return;
    try { await api('PUT', 'sheets/' + id, { name }); sheet.name = name; $('#sheetName').textContent = name; } catch (e) { fail(e); }
  };
  $('#delSheet').onclick = async () => {
    if (!confirm('このシートを削除しますか？')) return;
    save.flush = () => {};
    try { await api('DELETE', 'sheets/' + id); go('#/sheets'); } catch (e) { fail(e); }
  };
  cleanup = () => save.flush();
  draw();
  wrap.focus();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

routes.files = async (args, params) => {
  const path = params.path || '';
  const res = await GET('files?path=' + encodeURIComponent(path));
  const parts = path ? path.split('/') : [];
  const link = p => '#/files?path=' + encodeURIComponent(p);
  view.innerHTML = `
    <div class="page-head"><h1>ファイル</h1>
      <button class="btn" id="organize" title="このフォルダ直下のファイルを拡張子ごとのフォルダへ振り分け（設定で変更可）">自動整理</button>
      <button class="btn" id="mkdir">＋ フォルダ</button>
      <label class="btn primary">アップロード<input type="file" id="upIn" multiple hidden></label>
    </div>
    <div class="crumbs"><a href="${link('')}">🏠 ホーム</a>${parts.map((p, i) => ` / <a href="${link(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</div>
    <div class="drop" id="drop">ここにファイルをドラッグ＆ドロップ</div>
    <table class="files">
      <tr><th>名前</th><th>サイズ</th><th>更新日時</th><th></th></tr>
      ${res.items.map(it => `
        <tr data-path="${esc(it.path)}" data-dir="${it.dir ? 1 : 0}">
          <td class="nm">${it.dir ? '📁' : '📄'} ${esc(it.name)}</td>
          <td class="muted">${fmtSize(it.size)}</td>
          <td class="muted">${fmtDate(it.modified)} ${fmtTime(it.modified)}</td>
          <td style="text-align:right;white-space:nowrap">
            ${it.dir ? '' : `<a class="btn sm" href="/api/files/download?path=${encodeURIComponent(it.path)}">DL</a>`}
            <button class="btn sm" data-act="rename">名前変更</button>
            <button class="btn sm" data-act="move">移動</button>
            <button class="btn sm danger" data-act="delete">削除</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">空のフォルダです</td></tr>'}
    </table>
    <p class="muted small">保存先: data/files（削除したファイルは data/files/.trash に移動します）</p>`;

  async function upload(files) {
    let n = 0;
    for (const f of files) {
      toast(`アップロード中… ${f.name}`);
      try { await api('POST', `files/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(f.name)}`, f); n++; } catch (e) { fail(e); }
    }
    if (n) toast(`${n}件アップロードしました`);
    render();
  }
  $('#upIn').onchange = e => upload(e.target.files);
  const drop = $('#drop');
  view.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  view.ondragleave = e => { if (!view.contains(e.relatedTarget)) drop.classList.remove('over'); };
  view.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); };
  cleanup = () => { view.ondragover = view.ondragleave = view.ondrop = null; };

  $('#mkdir').onclick = async () => {
    const name = prompt('フォルダ名');
    if (!name) return;
    try { await api('POST', 'files/mkdir', { path, name }); render(); } catch (e) { fail(e); }
  };
  $('#organize').onclick = async () => {
    if (!confirm('このフォルダ直下のファイルを種類別フォルダに振り分けます。よろしいですか？')) return;
    try { const r = await api('POST', 'files/organize', { path }); toast(`${r.moved.length}件を整理しました`); render(); } catch (e) { fail(e); }
  };
  $('table.files').onclick = async e => {
    const tr = e.target.closest('tr[data-path]');
    if (!tr) return;
    const p = tr.dataset.path, isDir = tr.dataset.dir === '1';
    const act = e.target.dataset.act;
    try {
      if (act === 'rename') {
        const name = prompt('新しい名前', p.split('/').pop());
        if (name) { await api('POST', 'files/rename', { path: p, name }); render(); }
      } else if (act === 'move') {
        const to = prompt('移動先フォルダ（ホームからのパス。空欄＝ホーム）', path);
        if (to !== null) { await api('POST', 'files/move', { path: p, to }); render(); }
      } else if (act === 'delete') {
        if (confirm(`「${p.split('/').pop()}」を削除しますか？`)) { await api('DELETE', 'files?path=' + encodeURIComponent(p)); render(); }
      } else if (e.target.closest('.nm')) {
        if (isDir) go(link(p));
        else window.open('/api/files/view?path=' + encodeURIComponent(p), '_blank');
      }
    } catch (err) { fail(err); }
  };
};

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

const mailState = { unread: false, list: null };

routes.mail = async (args, params) => {
  const settings = await GET('settings');
  if (!settings.mail.imap_host || !settings.mail.username) {
    view.innerHTML = `<div class="page-head"><h1>メール</h1></div>
      <div class="card">メールアカウントが未設定です。<a href="#/settings">設定</a> で IMAP / SMTP を入力してください。<br>
      <span class="muted small">Gmail の場合は「アプリ パスワード」を発行して使います（IMAP: imap.gmail.com:993 / SMTP: smtp.gmail.com:465）。</span>
      <div style="margin-top:12px"><button class="btn" id="tplBtn">テンプレート管理</button></div></div>`;
    $('#tplBtn').onclick = manageTemplates;
    return;
  }
  view.innerHTML = `
    <div class="page-head"><h1>メール</h1>
      <label class="small"><input type="checkbox" id="unreadOnly" ${mailState.unread ? 'checked' : ''}> 未読のみ</label>
      <button class="btn" id="reload">更新</button>
      <button class="btn" id="tplBtn">テンプレート</button>
      <button class="btn primary" id="compose">＋ 作成</button>
    </div>
    <div class="split">
      <div class="side card" style="padding:6px"><ul class="list mail-list" id="mailList"><li class="empty">受信中…</li></ul></div>
      <div class="card" id="mailView" style="overflow:auto"><div class="empty">メールを選択してください</div></div>
    </div>`;
  $('#compose').onclick = () => compose({});
  $('#tplBtn').onclick = manageTemplates;
  $('#reload').onclick = () => { mailState.list = null; render(); };
  $('#unreadOnly').onchange = e => { mailState.unread = e.target.checked; mailState.list = null; render(); };
  try {
    if (!mailState.list) mailState.list = await GET('mail/inbox?limit=40' + (mailState.unread ? '&unread=1' : ''));
  } catch (e) {
    $('#mailList').innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    return;
  }
  $('#mailList').innerHTML = mailState.list.map(m => `
    <li class="${m.unread ? 'unread' : ''}" data-uid="${m.uid}"><div class="grow">
      <div class="subj">${esc(m.subject)}</div>
      <div class="from">${esc(m.from)} · ${fmtDate(m.date)} ${fmtTime(m.date)}</div></div></li>`).join('') || '<li class="empty">メールはありません</li>';
  $('#mailList').onclick = async e => {
    const li = e.target.closest('[data-uid]');
    if (!li) return;
    $$('#mailList li').forEach(x => x.style.background = x === li ? 'var(--accent-soft)' : '');
    li.classList.remove('unread');
    const item = mailState.list.find(m => m.uid === li.dataset.uid);
    if (item) item.unread = false;
    $('#mailView').innerHTML = '<div class="muted">読み込み中…</div>';
    try {
      const m = await GET('mail/message?uid=' + li.dataset.uid);
      $('#mailView').innerHTML = `
        <h2>${esc(m.subject)}</h2>
        <div class="muted small">From: ${esc(m.from)}<br>To: ${esc(m.to)}${m.cc ? '<br>Cc: ' + esc(m.cc) : ''}<br>${esc(m.date.replace('T', ' '))}</div>
        ${m.attachments.length ? `<div class="small" style="margin-top:6px">📎 ${m.attachments.map(esc).join(', ')}</div>` : ''}
        <div style="display:flex;gap:8px;margin:12px 0">
          <button class="btn primary" id="reply">返信</button>
          <button class="btn" id="toTask">タスク化</button>
          <button class="btn" id="toNote">メモに保存</button>
        </div>
        <div class="mail-body">${esc(m.body)}</div>`;
      const addr = (m.from.match(/<([^>]+)>/) || [, m.from])[1];
      $('#reply').onclick = () => compose({
        to: addr, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, in_reply_to: m.message_id,
        quote: `\n\n${m.date.replace('T', ' ')} ${m.from}:\n` + m.body.split('\n').map(l => '> ' + l).join('\n'),
        vars: { name: m.from.replace(/<.*>/, '').replace(/"/g, '').trim() },
      });
      $('#toTask').onclick = () => editTask(null, null, { title: '返信: ' + m.subject, notes: `From: ${m.from}\n${m.date}\n\n${m.body.slice(0, 1000)}`, due: today() });
      $('#toNote').onclick = async () => {
        try {
          const n = await api('POST', 'notes', { title: m.subject, body: `From: ${m.from}\nDate: ${m.date}\n\n${m.body}`, tags: 'メール' });
          toast('メモに保存しました');
          go('#/notes/' + n.id);
        } catch (err) { fail(err); }
      };
    } catch (err) { $('#mailView').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
};

function fillTemplate(text, vars) {
  const d = new Date();
  const all = { date: `${d.getMonth() + 1}月${d.getDate()}日`, today: today(), ...vars };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (all[k] != null ? all[k] : m));
}

async function compose({ to = '', cc = '', subject = '', body = '', quote = '', in_reply_to = '', vars = {} }) {
  const templates = await GET('templates');
  const box = openModal(`
    <form class="form">
      <h2>メール作成</h2>
      <label>テンプレート<select name="tpl"><option value="">（使わない）</option>${templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
      <label>宛先<input name="to" value="${esc(to)}" required></label>
      <label>Cc<input name="cc" value="${esc(cc)}"></label>
      <label>件名<input name="subject" value="${esc(subject)}"></label>
      <label>本文<textarea name="body" rows="12">${esc(body + quote)}</textarea></label>
      <div class="actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">送信</button></div>
    </form>`, true);
  const form = $('form', box);
  $('[data-close]', box).onclick = closeModal;
  form.tpl.onchange = () => {
    const t = templates.find(x => String(x.id) === form.tpl.value);
    if (!t) return;
    if (t.subject && !in_reply_to) form.subject.value = fillTemplate(t.subject, vars);
    form.body.value = fillTemplate(t.body, vars) + quote;
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const f = formData(form);
    const btn = $('.primary', form);
    btn.disabled = true;
    btn.textContent = '送信中…';
    try {
      await api('POST', 'mail/send', { to: f.to, cc: f.cc, subject: f.subject, body: f.body, in_reply_to });
      closeModal();
      toast('送信しました');
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = '送信'; }
  };
}

async function manageTemplates() {
  const list = await GET('templates');
  const box = openModal(`
    <h2>メールテンプレート</h2>
    <p class="muted small">本文で {{name}}（返信相手の名前）、{{date}}（今日の日付）が使えます。</p>
    <ul class="list">${list.map(t => `<li><span class="grow">${esc(t.name)}</span><button class="btn sm" data-edit="${t.id}">編集</button><button class="btn sm danger" data-del="${t.id}">削除</button></li>`).join('') || '<li class="empty">テンプレートはありません</li>'}</ul>
    <div class="form"><div class="actions"><button class="btn" data-close>閉じる</button><button class="btn primary" data-new>＋ 追加</button></div></div>`, true);
  $('[data-close]', box).onclick = closeModal;
  box.onclick = async e => {
    const t = e.target;
    if (t.dataset.new !== undefined || t.dataset.edit) {
      const cur = t.dataset.edit ? list.find(x => x.id === +t.dataset.edit) : { name: '', subject: '', body: '{{name}} 様\n\nお世話になっております。\n\n\n' };
      const b2 = openModal(`
        <form class="form"><h2>テンプレート</h2>
          <label>名前<input name="name" value="${esc(cur.name)}" required></label>
          <label>件名<input name="subject" value="${esc(cur.subject)}"></label>
          <label>本文<textarea name="body" rows="10">${esc(cur.body)}</textarea></label>
          <div class="actions"><button type="button" class="btn" data-back>戻る</button><button class="btn primary">保存</button></div>
        </form>`, true);
      $('[data-back]', b2).onclick = manageTemplates;
      $('form', b2).onsubmit = async ev => {
        ev.preventDefault();
        try {
          await api(cur.id ? 'PUT' : 'POST', cur.id ? 'templates/' + cur.id : 'templates', formData(ev.target));
          manageTemplates();
        } catch (err) { fail(err); }
      };
    } else if (t.dataset.del) {
      if (!confirm('削除しますか？')) return;
      try { await api('DELETE', 'templates/' + t.dataset.del); manageTemplates(); } catch (err) { fail(err); }
    }
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

routes.settings = async () => {
  const s = await GET('settings');
  const m = s.mail;
  const theme = localStorage.getItem('theme') || '';
  view.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <div class="grid">
      <section class="card"><h2>メールアカウント</h2>
        <form class="form" id="mailForm">
          <div class="row"><label>IMAP サーバー<input name="imap_host" value="${esc(m.imap_host)}" placeholder="imap.gmail.com"></label><label>ポート<input name="imap_port" type="number" value="${esc(m.imap_port)}"></label></div>
          <div class="row"><label>SMTP サーバー<input name="smtp_host" value="${esc(m.smtp_host)}" placeholder="smtp.gmail.com"></label><label>ポート<input name="smtp_port" type="number" value="${esc(m.smtp_port)}"></label></div>
          <label>SMTP 暗号化<select name="smtp_security"><option value="ssl" ${m.smtp_security === 'ssl' ? 'selected' : ''}>SSL/TLS（465）</option><option value="starttls" ${m.smtp_security === 'starttls' ? 'selected' : ''}>STARTTLS（587）</option></select></label>
          <label>ユーザー名（メールアドレス）<input name="username" value="${esc(m.username)}" autocomplete="off"></label>
          <label>パスワード（アプリパスワード推奨）<input name="password" type="password" placeholder="${m.password_set ? '設定済み（変更する場合のみ入力）' : ''}" autocomplete="new-password"></label>
          <label>差出人名<input name="from_name" value="${esc(m.from_name)}"></label>
          <p class="muted small">パスワードはこの PC の data/workspace.db に保存されます。</p>
          <div class="actions"><button class="btn primary">保存</button></div>
        </form>
      </section>
      <section class="card"><h2>ファイル自動整理ルール</h2>
        <form class="form" id="ruleForm">
          <label>1行に「フォルダ名: 拡張子, 拡張子…」<textarea name="rules" rows="8">${esc(s.file_rules.map(r => `${r.folder}: ${r.ext.join(', ')}`).join('\n'))}</textarea></label>
          <label style="display:flex;flex-direction:row;gap:8px;align-items:center"><input type="checkbox" name="prefix" ${s.file_name_prefix_date ? 'checked' : ''}> 整理時にファイル名の先頭へ日付（YYYY-MM-DD_）を付ける</label>
          <div class="actions"><button class="btn primary">保存</button></div>
        </form>
      </section>
      <section class="card"><h2>表示・通知</h2>
        <div class="form">
          <label>テーマ<select id="themeSel"><option value="">システムに合わせる</option><option value="light" ${theme === 'light' ? 'selected' : ''}>ライト</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>ダーク</option></select></label>
          <div><button class="btn" id="notifBtn">デスクトップ通知を許可</button> <span class="muted small">現在: ${'Notification' in window ? Notification.permission : '非対応'}</span></div>
        </div>
        <h2 style="margin-top:18px">バックアップ</h2>
        <p class="muted small">データベースと全ファイルを ZIP でダウンロードします。</p>
        <a class="btn" href="/api/backup">バックアップをダウンロード</a>
        <p class="muted small" style="margin-top:10px">Web 版へ移行: 書き出したファイルを Web 版の「設定 → 読み込み」で取り込めます。</p>
        <a class="btn" href="/api/export">Web 版用に書き出し</a>
        <h2 style="margin-top:18px">ショートカット</h2>
        <p class="small muted">/ 検索 ・ N クイック追加 ・ G→H/T/C/M/S/F/E 各画面へ移動</p>
      </section>
    </div>`;
  $('#mailForm').onsubmit = async e => {
    e.preventDefault();
    const f = formData(e.target);
    f.imap_port = +f.imap_port || 993;
    f.smtp_port = +f.smtp_port || 465;
    try { await api('PUT', 'settings', { mail: f }); mailState.list = null; toast('保存しました'); render(); } catch (err) { fail(err); }
  };
  $('#ruleForm').onsubmit = async e => {
    e.preventDefault();
    const rules = e.target.rules.value.split('\n').map(l => l.split(/[:：]/)).filter(p => p.length >= 2 && p[0].trim())
      .map(([folder, ...rest]) => ({ folder: folder.trim(), ext: rest.join(':').split(/[,、\s]+/).map(x => x.trim().replace(/^\./, '')).filter(Boolean) }));
    try { await api('PUT', 'settings', { file_rules: rules, file_name_prefix_date: e.target.prefix.checked }); toast('保存しました'); } catch (err) { fail(err); }
  };
  $('#themeSel').onchange = e => { localStorage.setItem('theme', e.target.value); applyTheme(); };
  $('#notifBtn').onclick = async () => {
    if (!('Notification' in window)) return toast('このブラウザは通知に対応していません', true);
    await Notification.requestPermission();
    render();
  };
};

function applyTheme() {
  let t = '';
  try { t = localStorage.getItem('theme') || ''; } catch (e) { /* ignore */ }
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

routes.search = async (args, params) => {
  const q = params.q || '';
  $('#searchInput').value = q;
  const r = await GET('search?q=' + encodeURIComponent(q));
  const sec = (title, items, fn) => (items && items.length ? `<section class="card" style="margin-bottom:14px"><h2>${title} <span class="muted small">${items.length}</span></h2><ul class="list">${items.map(fn).join('')}</ul></section>` : '');
  const html = [
    sec('タスク', r.tasks, taskLi),
    sec('予定', r.events, e => eventLi(e, true)),
    sec('メモ', r.notes, n => `<li><a class="grow" href="#/notes/${n.id}">${esc(n.title || '無題')}</a><span class="due">${fmtDate(n.updated)}</span></li>`),
    sec('シート', r.sheets, s => `<li><a class="grow" href="#/sheets/${s.id}">${esc(s.name)}</a></li>`),
    sec('ファイル', r.files, f => `<li><a class="grow" href="${f.dir ? '#/files?path=' + encodeURIComponent(f.path) : '/api/files/view?path=' + encodeURIComponent(f.path)}" ${f.dir ? '' : 'target="_blank"'}>${f.dir ? '📁' : '📄'} ${esc(f.path)}</a></li>`),
  ].join('');
  view.innerHTML = `<div class="page-head"><h1>「${esc(q)}」の検索結果</h1></div>${html || '<div class="card empty">見つかりませんでした</div>'}`;
  bindItems(view, render);
};

// ---------------------------------------------------------------------------
// Quick add, shortcuts, reminders
// ---------------------------------------------------------------------------

function quickAdd() {
  const box = openModal(`
    <form class="form">
      <h2>クイック追加</h2>
      <div class="seg" id="qaType"><button type="button" data-t="task" class="on">タスク</button><button type="button" data-t="event">予定</button><button type="button" data-t="note">メモ</button></div>
      <input name="text" placeholder="例: 請求書を送る 明日 #経理 !" autocomplete="off">
      <p class="muted small" id="qaHint">「今日／明日／明後日／10/31」で期限、「#名前」でプロジェクト、「!」で優先度高</p>
      <div class="actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">追加</button></div>
    </form>`);
  let type = 'task';
  const hints = { task: '「今日／明日／明後日／10/31」で期限、「#名前」でプロジェクト、「!」で優先度高', event: '入力後に詳細画面が開きます（「明日」「10/31」で日付指定）', note: 'タイトルを入力してメモを作成' };
  $('#qaType', box).onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    type = b.dataset.t;
    $$('#qaType button', box).forEach(x => x.classList.toggle('on', x === b));
    $('#qaHint', box).textContent = hints[type];
    $('[name=text]', box).focus();
  };
  $('[data-close]', box).onclick = closeModal;
  $('form', box).onsubmit = async e => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    try {
      if (type === 'task') {
        await api('POST', 'tasks', parseQuickTask(text));
        closeModal();
        toast('タスクを追加しました');
        render();
      } else if (type === 'event') {
        const q = parseQuickTask(text);
        const ev = await api('POST', 'events', { title: q.title, start: (q.due || today()) + 'T09:00', end: (q.due || today()) + 'T10:00', remind_min: 10 });
        editEvent(ev.id, null, render);
      } else {
        const n = await api('POST', 'notes', { title: text, body: '' });
        closeModal();
        go('#/notes/' + n.id);
      }
    } catch (err) { fail(err); }
  };
}

const isTyping = el => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || el.id === 'sheetWrap');
let gPending = false;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); return; }
  if (isTyping(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || !$('#modal').hidden) return;
  if (gPending) {
    gPending = false;
    const dest = { h: 'dashboard', t: 'tasks', c: 'calendar', m: 'notes', s: 'sheets', f: 'files', e: 'mail' }[e.key.toLowerCase()];
    if (dest) { e.preventDefault(); go('#/' + dest); }
    return;
  }
  if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  else if (e.key.toLowerCase() === 'n') { e.preventDefault(); quickAdd(); }
  else if (e.key.toLowerCase() === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1200); }
});

$('#searchForm').onsubmit = e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) go('#/search?q=' + encodeURIComponent(q));
};
$('#quickAdd').onclick = quickAdd;
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

// Event reminders: checked every 30 seconds while the page is open.
function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body }); return; } catch (e) { /* fall through */ }
  }
  toast(`${title} — ${body}`);
}
async function checkReminders() {
  let sent = {};
  try { sent = JSON.parse(localStorage.getItem('reminded') || '{}'); } catch (e) { sent = {}; }
  const now = new Date();
  try {
    const events = await GET(`events?from=${today()}&to=${addDays(today(), 1)}`);
    for (const e of events) {
      if (e.remind_min == null || e.remind_min === '') continue;
      const start = new Date(e.all_day ? e.start.slice(0, 10) + 'T09:00' : e.start);
      const at = new Date(start.getTime() - e.remind_min * 60000);
      const key = e.id + '@' + e.start + '@' + e.remind_min;
      if (now >= at && now < new Date(start.getTime() + 15 * 60000) && !sent[key]) {
        sent[key] = Date.now();
        notify('予定: ' + e.title, (e.all_day ? '終日' : fmtTime(e.start) + ' 開始') + (e.location ? ' / ' + e.location : ''));
      }
    }
    for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 3 * 86400000) delete sent[k];
    localStorage.setItem('reminded', JSON.stringify(sent));
  } catch (e) { /* server may be stopped */ }
}

applyTheme();
render();
checkReminders();
setInterval(checkReminders, 30000);
