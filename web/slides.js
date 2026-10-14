/* Slides: a small presentation editor shared by the web and local versions.
 *
 * Classic script (no modules) so both apps can load it; it exposes
 * window.Slides.route(view, args, deps). A deck is stored as a record
 * {name, data} where data is the JSON of:
 *   { version, theme, slides: [{ id, bg, transition, notes, elements: [...] }] }
 * Elements live on a 1280x720 canvas:
 *   { id, type: 'text'|'shape'|'image', x, y, w, h, text, ph, src,
 *     style: { shape, fontSize, bold, italic, color, align, valign, bullets, fill, stroke, strokeWidth },
 *     anim: { effect, start: 'click'|'with'|'after', dur, seq } | null }
 * Export: PPTX (editable, with transitions and entrance animations), PDF, PNG, text.
 */
(function () {
  'use strict';

  const W = 1280, H = 720;
  const EMU = 9525; // EMU per canvas pixel (12192000 / 1280)
  const MAX_BYTES = 900 * 1024; // keep decks under Firestore's 1 MiB document limit

  const THEMES = {
    simple: { name: 'シンプル', bg: '#ffffff', fg: '#1d2330', accent: '#3b6ef5', font: 'sans' },
    dark: { name: 'ダーク', bg: '#1d2027', fg: '#f2f4f8', accent: '#6b91ff', font: 'sans' },
    navy: { name: 'ネイビー', bg: '#0f2a4a', fg: '#ffffff', accent: '#ffb547', font: 'sans' },
    warm: { name: 'ウォーム', bg: '#fbf6ee', fg: '#3a2e25', accent: '#d9653b', font: 'serif' },
    green: { name: 'グリーン', bg: '#f1f7f2', fg: '#1f3326', accent: '#2e9b5f', font: 'sans' },
    mono: { name: 'モノクロ', bg: '#f4f4f4', fg: '#111111', accent: '#111111', font: 'sans' },
  };
  const FONTS = {
    sans: { css: '"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",system-ui,sans-serif', latin: 'Arial', ea: 'Meiryo' },
    serif: { css: '"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho","MS Mincho",serif', latin: 'Georgia', ea: 'Yu Mincho' },
  };
  const EFFECTS = { none: 'なし', fade: 'フェード', rise: '下から', left: '右から', zoom: 'ズーム', wipe: 'ワイプ' };
  const STARTS = { click: 'クリック時', with: '直前と同時', after: '直前の後' };
  const TRANSITIONS = { none: 'なし', fade: 'フェード', slide: 'スライド', zoom: 'ズーム' };
  const SHAPES = { rect: '四角形', roundRect: '角丸四角形', ellipse: '楕円', triangle: '三角形', arrow: '矢印', line: '線' };
  const LAYOUTS = { title: 'タイトル', titleBody: 'タイトルと本文', twoCol: '2段組み', section: 'セクション見出し', blank: '白紙' };

  // ---------------------------------------------------------------------------
  // Model helpers
  // ---------------------------------------------------------------------------

  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = o => JSON.parse(JSON.stringify(o));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function el(type, x, y, w, h, style = {}, extra = {}) {
    return {
      id: uid(), type, x, y, w, h, text: '', ph: '',
      style: { shape: 'rect', fontSize: 28, bold: false, italic: false, color: null, align: 'left', valign: 'top', bullets: false, fill: null, stroke: null, strokeWidth: 3, ...style },
      anim: null, ...extra,
    };
  }

  function layoutElements(layout) {
    switch (layout) {
      case 'title': return [
        el('text', 100, 220, 1080, 150, { fontSize: 64, bold: true, align: 'center', valign: 'bottom' }, { ph: 'タイトルを入力' }),
        el('text', 100, 390, 1080, 90, { fontSize: 30, align: 'center' }, { ph: 'サブタイトルを入力' }),
      ];
      case 'titleBody': return [
        el('text', 80, 40, 1120, 110, { fontSize: 46, bold: true, valign: 'bottom' }, { ph: 'タイトルを入力' }),
        el('text', 80, 170, 1120, 500, { fontSize: 30, bullets: true }, { ph: '本文を入力' }),
      ];
      case 'twoCol': return [
        el('text', 80, 40, 1120, 110, { fontSize: 46, bold: true, valign: 'bottom' }, { ph: 'タイトルを入力' }),
        el('text', 80, 170, 540, 500, { fontSize: 28, bullets: true }, { ph: '左の本文' }),
        el('text', 660, 170, 540, 500, { fontSize: 28, bullets: true }, { ph: '右の本文' }),
      ];
      case 'section': return [
        el('shape', 100, 330, 160, 10, { shape: 'rect', fill: null }),
        el('text', 100, 200, 1080, 120, { fontSize: 56, bold: true, valign: 'bottom' }, { ph: 'セクション名' }),
        el('text', 100, 360, 1080, 80, { fontSize: 26 }, { ph: '補足' }),
      ];
      default: return [];
    }
  }

  const newSlide = layout => ({ id: uid(), layout, bg: null, transition: 'none', notes: '', elements: layoutElements(layout) });
  const newDeck = () => ({ version: 1, theme: 'simple', slides: [newSlide('title')] });

  function parseDeck(json) {
    let d;
    try { d = JSON.parse(json || '{}'); } catch (e) { d = {}; }
    if (!d.slides || !d.slides.length) d = { ...newDeck(), ...d, slides: newDeck().slides };
    d.theme = THEMES[d.theme] ? d.theme : 'simple';
    for (const s of d.slides) {
      s.elements = s.elements || [];
      s.transition = s.transition || 'none';
      s.notes = s.notes || '';
      for (const e of s.elements) e.style = { ...el('text', 0, 0, 0, 0).style, ...(e.style || {}) };
    }
    return d;
  }

  const themeOf = deck => THEMES[deck.theme] || THEMES.simple;
  const fontOf = theme => FONTS[theme.font] || FONTS.sans;
  function fillOf(e, theme) {
    const f = e.style.fill;
    if (f === 'none') return null;
    if (f) return f;
    return e.type === 'shape' && e.style.shape !== 'line' ? theme.accent : null;
  }
  function colorOf(e, theme) {
    if (e.style.color) return e.style.color;
    return e.type === 'shape' && fillOf(e, theme) ? '#ffffff' : theme.fg;
  }
  const lineColorOf = (e, theme) => e.style.stroke || (e.style.fill && e.style.fill !== 'none' ? e.style.fill : theme.accent);
  const bgOf = (slide, theme) => slide.bg || theme.bg;

  function animated(slide) {
    return slide.elements.filter(e => e.anim && e.anim.effect && e.anim.effect !== 'none')
      .sort((a, b) => (a.anim.seq || 0) - (b.anim.seq || 0));
  }

  // Group animations into steps (one per click). Leading with/after effects play
  // automatically when the slide appears. Each item gets a delay in seconds.
  function buildSteps(slide) {
    const groups = [];
    for (const e of animated(slide)) {
      const dur = +e.anim.dur || 0.5;
      if (e.anim.start === 'click') {
        groups.push({ auto: false, items: [{ e, delay: 0 }], lastStart: 0, end: dur });
        continue;
      }
      if (!groups.length) groups.push({ auto: true, items: [], lastStart: 0, end: 0 });
      const g = groups[groups.length - 1];
      const delay = e.anim.start === 'with' ? g.lastStart : g.end;
      g.items.push({ e, delay });
      g.lastStart = delay;
      g.end = Math.max(g.end, delay + dur);
    }
    return groups;
  }

  // ---------------------------------------------------------------------------
  // DOM rendering (editor, thumbnails, presenter)
  // ---------------------------------------------------------------------------

  function shapeSvg(e, theme) {
    const { w, h } = e;
    const s = e.style;
    const shape = e.type === 'text' ? 'rect' : s.shape;
    if (shape === 'line') {
      const sw = Math.max(1, +s.strokeWidth || 3);
      return `<svg class="sl-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${lineColorOf(e, theme)}" stroke-width="${sw}"/></svg>`;
    }
    const fill = fillOf(e, theme);
    const stroke = s.stroke && s.stroke !== 'none' ? s.stroke : null;
    if (!fill && !stroke) return '';
    const sw = stroke ? +s.strokeWidth || 3 : 0;
    const paint = `fill="${fill || 'none'}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ''}`;
    const i = sw / 2;
    let body;
    if (shape === 'ellipse') body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - i)}" ry="${Math.max(0, h / 2 - i)}" ${paint}/>`;
    else if (shape === 'triangle') body = `<polygon points="${w / 2},${i} ${w - i},${h - i} ${i},${h - i}" ${paint}/>`;
    else if (shape === 'arrow') body = `<polygon points="${arrowPoints(w, h).map(p => p.join(',')).join(' ')}" ${paint}/>`;
    else {
      const r = shape === 'roundRect' ? Math.min(w, h) * 0.15 : 0;
      body = `<rect x="${i}" y="${i}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${r}" ${paint}/>`;
    }
    return `<svg class="sl-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${body}</svg>`;
  }
  const arrowPoints = (w, h) => {
    const head = Math.min(w * 0.45, h * 0.5 * 1.2);
    return [[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]];
  };

  function textHtml(e, editing) {
    if (!e.text) return editing && e.ph ? `<span class="sl-ph">${esc(e.ph)}</span>` : '';
    if (!e.style.bullets) return esc(e.text);
    return e.text.split('\n').map(l => `<div class="sl-li">${l.trim() ? '<span class="sl-bu">•</span>' : ''}<span>${esc(l) || '<br>'}</span></div>`).join('');
  }

  function elementHtml(e, theme, opts = {}) {
    const s = e.style;
    const font = fontOf(theme);
    const va = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.valign] || 'flex-start';
    const textStyle = `font-family:${font.css.replace(/"/g, "'")};font-size:${s.fontSize}px;color:${colorOf(e, theme)};` +
      `font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};text-align:${s.align};justify-content:${va}`;
    const inner = e.type === 'image'
      ? `<img class="sl-img" src="${esc(e.src)}" alt="" draggable="false">`
      : shapeSvg(e, theme) + (e.style.shape === 'line' && e.type === 'shape' ? '' : `<div class="sl-text" style="${textStyle}">${textHtml(e, opts.editing)}</div>`);
    const badge = opts.editing && e.anim && e.anim.effect !== 'none' && opts.order ? `<span class="sl-badge">${opts.order}</span>` : '';
    return `<div class="sl-el${opts.selected ? ' sel' : ''}" data-id="${e.id}" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px">${inner}${badge}</div>`;
  }

  function slideHtml(slide, theme, opts = {}) {
    const order = new Map(animated(slide).map((e, i) => [e.id, i + 1]));
    return slide.elements.map(e => elementHtml(e, theme, { ...opts, selected: opts.selected === e.id, order: order.get(e.id) })).join('');
  }

  // ---------------------------------------------------------------------------
  // Canvas rendering (PNG / PDF)
  // ---------------------------------------------------------------------------

  function loadImages(deck) {
    const srcs = new Set();
    deck.slides.forEach(s => s.elements.forEach(e => { if (e.type === 'image' && e.src) srcs.add(e.src); }));
    const map = new Map();
    return Promise.all(Array.from(srcs).map(src => new Promise(res => {
      const img = new Image();
      img.onload = () => { map.set(src, img); res(); };
      img.onerror = () => res();
      img.src = src;
    }))).then(() => map);
  }

  function wrapText(ctx, text, maxW, bullets) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      const bullet = bullets && para.trim();
      let line = '';
      let first = true;
      const push = l => { lines.push({ text: l, bullet: bullet && first }); first = false; };
      for (const ch of Array.from(para)) {
        if (line && ctx.measureText(line + ch).width > maxW) {
          const sp = line.lastIndexOf(' ');
          if (/[A-Za-z0-9]/.test(ch) && sp > 0 && /^[\x20-\x7e]+$/.test(line.slice(sp + 1))) {
            push(line.slice(0, sp));
            line = line.slice(sp + 1) + ch;
          } else {
            push(line);
            line = ch === ' ' ? '' : ch;
          }
        } else line += ch;
      }
      push(line);
    }
    return lines;
  }

  function pathFor(ctx, e) {
    const { x, y, w, h } = e;
    const shape = e.type === 'text' ? 'rect' : e.style.shape;
    ctx.beginPath();
    if (shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (shape === 'triangle') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
    else if (shape === 'arrow') { arrowPoints(w, h).forEach(([px, py], i) => (i ? ctx.lineTo(x + px, y + py) : ctx.moveTo(x + px, y + py))); ctx.closePath(); }
    else if (shape === 'roundRect' && ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.15);
    else ctx.rect(x, y, w, h);
  }

  function drawSlide(ctx, slide, theme, images, scale) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = bgOf(slide, theme);
    ctx.fillRect(0, 0, W, H);
    const font = fontOf(theme);
    for (const e of slide.elements) {
      const s = e.style;
      if (e.type === 'image') {
        const img = images.get(e.src);
        if (img) ctx.drawImage(img, e.x, e.y, e.w, e.h);
        continue;
      }
      if (e.type === 'shape' && s.shape === 'line') {
        ctx.strokeStyle = lineColorOf(e, theme);
        ctx.lineWidth = Math.max(1, +s.strokeWidth || 3);
        ctx.beginPath();
        ctx.moveTo(e.x, e.y + e.h / 2);
        ctx.lineTo(e.x + e.w, e.y + e.h / 2);
        ctx.stroke();
        continue;
      }
      const fill = fillOf(e, theme);
      const stroke = s.stroke && s.stroke !== 'none' ? s.stroke : null;
      if (fill || stroke) {
        pathFor(ctx, e);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = +s.strokeWidth || 3; ctx.stroke(); }
      }
      if (!e.text) continue;
      ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${s.fontSize}px ${font.css}`;
      ctx.fillStyle = colorOf(e, theme);
      ctx.textBaseline = 'top';
      const pad = 8, lh = s.fontSize * 1.3;
      const bulletW = s.bullets ? ctx.measureText('• ').width : 0;
      const lines = wrapText(ctx, e.text, e.w - pad * 2 - bulletW, s.bullets);
      const total = lines.length * lh;
      let ty = e.y + pad;
      if (s.valign === 'middle') ty = e.y + (e.h - total) / 2;
      else if (s.valign === 'bottom') ty = e.y + e.h - pad - total;
      ctx.save();
      ctx.beginPath();
      ctx.rect(e.x, e.y, e.w, e.h);
      ctx.clip();
      for (const l of lines) {
        const tw = ctx.measureText(l.text).width + bulletW;
        let tx = e.x + pad;
        if (s.align === 'center') tx = e.x + (e.w - tw) / 2;
        else if (s.align === 'right') tx = e.x + e.w - pad - tw;
        if (l.bullet) ctx.fillText('•', tx, ty + (lh - s.fontSize) / 2);
        ctx.fillText(l.text, tx + bulletW, ty + (lh - s.fontSize) / 2);
        ty += lh;
      }
      ctx.restore();
    }
    ctx.restore();
  }

  async function renderCanvas(deck, slide, scale, images) {
    const c = document.createElement('canvas');
    c.width = Math.round(W * scale);
    c.height = Math.round(H * scale);
    drawSlide(c.getContext('2d'), slide, themeOf(deck), images || await loadImages(deck), scale);
    return c;
  }
  const canvasBlob = (c, type, q) => new Promise(res => c.toBlob(res, type, q));

  // ---------------------------------------------------------------------------
  // ZIP (stored, no compression) — used for PPTX and multi-PNG export
  // ---------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = s => new TextEncoder().encode(s);

  function zip(files) { // files: [{name, data: Uint8Array|string}]
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = utf8(f.name);
      const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true);      // stored
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
  }

  // ---------------------------------------------------------------------------
  // PPTX export
  // ---------------------------------------------------------------------------

  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const x = s => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex = c => String(c || '#000000').replace('#', '').toUpperCase().slice(0, 6);
  const emu = v => Math.round(v * EMU);
  const solid = c => `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>`;
  const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = list => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`;

  function dataUrlBytes(url) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(url || '');
    if (!m) return null;
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { type: m[1], bytes };
  }

  function txBody(e, theme) {
    const s = e.style;
    const font = fontOf(theme);
    const pad = emu(8);
    const anchor = { top: 't', middle: 'ctr', bottom: 'b' }[s.valign] || 't';
    const algn = { left: 'l', center: 'ctr', right: 'r' }[s.align] || 'l';
    const rpr = `<a:rPr lang="ja-JP" altLang="en-US" sz="${Math.round(s.fontSize * 75)}" b="${s.bold ? 1 : 0}" i="${s.italic ? 1 : 0}" dirty="0">${solid(colorOf(e, theme))}<a:latin typeface="${font.latin}"/><a:ea typeface="${font.ea}"/></a:rPr>`;
    const paras = (e.text || '').split('\n').map(line => {
      const bu = s.bullets && line.trim()
        ? `<a:pPr marL="${emu(s.fontSize * 1.1)}" indent="-${emu(s.fontSize * 1.1)}" algn="${algn}"><a:lnSpc><a:spcPct val="110000"/></a:lnSpc><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`
        : `<a:pPr algn="${algn}"><a:lnSpc><a:spcPct val="110000"/></a:lnSpc><a:buNone/></a:pPr>`;
      return `<a:p>${bu}${line ? `<a:r>${rpr}<a:t>${x(line)}</a:t></a:r>` : ''}<a:endParaRPr lang="ja-JP" sz="${Math.round(s.fontSize * 75)}" dirty="0"/></a:p>`;
    }).join('');
    return `<p:txBody><a:bodyPr wrap="square" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`;
  }

  function spXml(e, spid, theme) {
    const s = e.style;
    const xfrm = (oy = e.y, h = e.h) => `<a:xfrm><a:off x="${emu(e.x)}" y="${emu(oy)}"/><a:ext cx="${emu(e.w)}" cy="${emu(h)}"/></a:xfrm>`;
    if (e.type === 'shape' && s.shape === 'line') {
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${spid}" name="Line ${spid}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(e.y + e.h / 2, 0)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${emu(Math.max(1, +s.strokeWidth || 3))}">${solid(lineColorOf(e, theme))}</a:ln></p:spPr></p:cxnSp>`;
    }
    const shape = e.type === 'text' ? 'rect' : s.shape;
    const prst = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', arrow: 'rightArrow' }[shape] || 'rect';
    let av = '<a:avLst/>';
    if (prst === 'roundRect') av = '<a:avLst><a:gd name="adj" fmla="val 15000"/></a:avLst>';
    if (prst === 'rightArrow') {
      const head = Math.min(e.w * 0.45, e.h * 0.6);
      av = `<a:avLst><a:gd name="adj1" fmla="val 50000"/><a:gd name="adj2" fmla="val ${Math.round(head / e.h * 100000)}"/></a:avLst>`;
    }
    const fill = fillOf(e, theme);
    const stroke = s.stroke && s.stroke !== 'none' ? s.stroke : null;
    const ln = stroke ? `<a:ln w="${emu(+s.strokeWidth || 3)}">${solid(stroke)}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${spid}" name="${e.type === 'text' ? 'TextBox' : 'Shape'} ${spid}"/><p:cNvSpPr${e.type === 'text' ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr>${xfrm()}<a:prstGeom prst="${prst}">${av}</a:prstGeom>${fill ? solid(fill) : '<a:noFill/>'}${ln}</p:spPr>${txBody(e, theme)}</p:sp>`;
  }

  // Entrance animations, in PowerPoint's timing tree format.
  function timingXml(slide, spids) {
    const groups = buildSteps(slide);
    if (!groups.length) return '';
    let id = 3;
    const tgt = spid => `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
    const anim = (spid, dur, attr, from, to) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id++}" dur="${dur}" fill="hold"/>${tgt(spid)}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
    const filter = (spid, dur, f) => `<p:animEffect transition="in" filter="${f}"><p:cBhvr><p:cTn id="${id++}" dur="${dur}"/>${tgt(spid)}</p:cBhvr></p:animEffect>`;
    const PRESET = { fade: [10, 0], rise: [2, 4], left: [2, 2], zoom: [53, 16], wipe: [22, 8] };
    const effect = (item, nodeType) => {
      const e = item.e, spid = spids.get(e.id), dur = Math.round((+e.anim.dur || 0.5) * 1000);
      const [preset, sub] = PRESET[e.anim.effect] || PRESET.fade;
      let body = `<p:set><p:cBhvr><p:cTn id="${id++}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt(spid)}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
      if (e.anim.effect === 'rise') body += anim(spid, dur, 'ppt_x', '#ppt_x', '#ppt_x') + anim(spid, dur, 'ppt_y', '1+#ppt_h/2', '#ppt_y');
      else if (e.anim.effect === 'left') body += anim(spid, dur, 'ppt_x', '1+#ppt_w/2', '#ppt_x') + anim(spid, dur, 'ppt_y', '#ppt_y', '#ppt_y');
      else if (e.anim.effect === 'zoom') body += anim(spid, dur, 'ppt_w', '0', '#ppt_w') + anim(spid, dur, 'ppt_h', '0', '#ppt_h') + filter(spid, dur, 'fade');
      else if (e.anim.effect === 'wipe') body += filter(spid, dur, 'wipe(left)');
      else body += filter(spid, dur, 'fade');
      return `<p:par><p:cTn id="${id++}" presetID="${preset}" presetClass="entr" presetSubtype="${sub}" fill="hold" grpId="0" nodeType="${nodeType}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${body}</p:childTnLst></p:cTn></p:par>`;
    };
    const steps = groups.map(g => {
      const byDelay = new Map();
      g.items.forEach((it, i) => {
        const k = Math.round(it.delay * 1000);
        if (!byDelay.has(k)) byDelay.set(k, []);
        byDelay.get(k).push({ it, nodeType: i === 0 && !g.auto ? 'clickEffect' : it.e.anim.start === 'after' ? 'afterEffect' : 'withEffect' });
      });
      const outerId = id++;
      const inner = Array.from(byDelay.entries()).sort((a, b) => a[0] - b[0]).map(([delay, list]) => {
        const pid = id++;
        return `<p:par><p:cTn id="${pid}" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${list.map(l => effect(l.it, l.nodeType)).join('')}</p:childTnLst></p:cTn></p:par>`;
      }).join('');
      const cond = g.auto ? '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : '<p:cond delay="indefinite"/>';
      return `<p:par><p:cTn id="${outerId}" fill="hold"><p:stCondLst>${cond}</p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>`;
    }).join('');
    const bld = animated(slide).filter(e => e.type !== 'image' && !(e.type === 'shape' && e.style.shape === 'line'))
      .map(e => `<p:bldP spid="${spids.get(e.id)}" grpId="0" animBg="1"/>`).join('');
    return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${steps}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${bld ? `<p:bldLst>${bld}</p:bldLst>` : ''}</p:timing>`;
  }

  const THEME_XML = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Workspace"><a:themeElements><a:clrScheme name="Workspace"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1D2330"/></a:dk2><a:lt2><a:srgbClr val="F5F6F8"/></a:lt2><a:accent1><a:srgbClr val="3B6EF5"/></a:accent1><a:accent2><a:srgbClr val="2E9B5F"/></a:accent2><a:accent3><a:srgbClr val="D9653B"/></a:accent3><a:accent4><a:srgbClr val="FFB547"/></a:accent4><a:accent5><a:srgbClr val="6B91FF"/></a:accent5><a:accent6><a:srgbClr val="D64545"/></a:accent6><a:hlink><a:srgbClr val="3B6EF5"/></a:hlink><a:folHlink><a:srgbClr val="7A5AF8"/></a:folHlink></a:clrScheme><a:fontScheme name="Workspace"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Meiryo"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Meiryo"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Workspace"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

  function buildPptx(deck, title) {
    const theme = themeOf(deck);
    const files = [];
    const media = [];
    const slideFiles = deck.slides.map((slide, si) => {
      const spids = new Map();
      const relList = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
      const shapes = slide.elements.map((e, i) => {
        const spid = i + 2;
        spids.set(e.id, spid);
        if (e.type === 'image') {
          const img = dataUrlBytes(e.src);
          if (!img) return '';
          const ext = /png/.test(img.type) ? 'png' : /gif/.test(img.type) ? 'gif' : 'jpeg';
          const name = `image${media.length + 1}.${ext}`;
          media.push({ name, bytes: img.bytes });
          const rid = `rId${relList.length + 1}`;
          relList.push([rid, 'image', `../media/${name}`]);
          return `<p:pic><p:nvPicPr><p:cNvPr id="${spid}" name="Picture ${spid}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(e.w)}" cy="${emu(e.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
        }
        return spXml(e, spid, theme);
      }).join('');
      const tr = { fade: '<p:fade/>', slide: '<p:push dir="l"/>', zoom: '<p:zoom/>' }[slide.transition];
      const xml = `${XML}<p:sld ${NS}><p:cSld><p:bg><p:bgPr>${solid(bgOf(slide, theme))}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${tr ? `<p:transition spd="med">${tr}</p:transition>` : ''}${timingXml(slide, spids)}</p:sld>`;
      files.push({ name: `ppt/slides/slide${si + 1}.xml`, data: xml });
      files.push({ name: `ppt/slides/_rels/slide${si + 1}.xml.rels`, data: rels(relList) });
      return si + 1;
    });
    const n = slideFiles.length;
    const ct = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      slideFiles.map(i => `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>' +
      '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>' +
      '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const head = [
      { name: '[Content_Types].xml', data: ct },
      { name: '_rels/.rels', data: rels([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], ['rId3', 'extended-properties', 'docProps/app.xml']]) },
      { name: 'docProps/core.xml', data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>My Workspace</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
      { name: 'docProps/app.xml', data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>My Workspace</Application><Slides>${n}</Slides></Properties>` },
      { name: 'ppt/presentation.xml', data: `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideFiles.map(i => `<p:sldId id="${255 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
      { name: 'ppt/_rels/presentation.xml.rels', data: rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slideFiles.map(i => [`rId${i + 1}`, 'slide', `slides/slide${i}.xml`]), [`rId${n + 2}`, 'presProps', 'presProps.xml'], [`rId${n + 3}`, 'viewProps', 'viewProps.xml'], [`rId${n + 4}`, 'theme', 'theme/theme1.xml'], [`rId${n + 5}`, 'tableStyles', 'tableStyles.xml']]) },
      { name: 'ppt/presProps.xml', data: `${XML}<p:presentationPr ${NS}/>` },
      { name: 'ppt/viewProps.xml', data: `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
      { name: 'ppt/tableStyles.xml', data: `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
      { name: 'ppt/theme/theme1.xml', data: THEME_XML },
      { name: 'ppt/slideMasters/slideMaster1.xml', data: `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>` },
      { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
      { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) },
    ];
    return zip([...head, ...files, ...media.map(m => ({ name: `ppt/media/${m.name}`, data: m.bytes }))]);
  }

  // ---------------------------------------------------------------------------
  // PDF export (one JPEG image per page, 16:9)
  // ---------------------------------------------------------------------------

  async function buildPdf(deck, title) {
    const images = await loadImages(deck);
    const pages = [];
    for (const s of deck.slides) {
      const c = await renderCanvas(deck, s, 1.5, images);
      pages.push({ w: c.width, h: c.height, jpg: new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.92)).arrayBuffer()) });
    }
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const add = d => { const b = typeof d === 'string' ? utf8(d) : d; chunks.push(b); pos += b.length; };
    const obj = (n, body) => { offsets[n] = pos; add(`${n} 0 obj\n`); body.forEach(add); add('\nendobj\n'); };
    const utf16 = s => 'FEFF' + Array.from(String(s)).map(ch => {
      const cp = ch.codePointAt(0);
      if (cp < 0x10000) return cp.toString(16).padStart(4, '0');
      const v = cp - 0x10000;
      return ((v >> 10) + 0xd800).toString(16) + ((v & 0x3ff) + 0xdc00).toString(16);
    }).join('').toUpperCase();
    add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    const n = pages.length;
    const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`]);
    obj(3, [`<< /Title <${utf16(title)}> /Producer (My Workspace) >>`]);
    pages.forEach((p, i) => {
      const pn = 4 + i * 3;
      const content = 'q 960 0 0 540 0 0 cm /Im0 Do Q';
      obj(pn, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /XObject << /Im0 ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>`]);
      obj(pn + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
      obj(pn + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>\nstream\n`, p.jpg, '\nendstream']);
    });
    const xref = pos;
    const count = 4 + n * 3;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    add(table + `trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function buildText(deck, title) {
    const out = [`${title}`, ''];
    deck.slides.forEach((s, i) => {
      out.push(`■ スライド ${i + 1}`);
      const texts = s.elements.filter(e => e.text && e.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
      for (const e of texts) {
        out.push(e.style.bullets ? e.text.split('\n').filter(l => l.trim()).map(l => '・' + l.trim()).join('\n') : e.text.trim());
      }
      if (s.notes && s.notes.trim()) out.push('', '（ノート）', s.notes.trim());
      out.push('');
    });
    return new Blob(['﻿' + out.join('\n')], { type: 'text/plain;charset=utf-8' });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const safeFile = s => String(s || 'スライド').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  // ---------------------------------------------------------------------------
  // Styles (injected once)
  // ---------------------------------------------------------------------------

  const CSS = `
  .sl-stage{position:relative;width:${W}px;height:${H}px;transform-origin:0 0;overflow:hidden;user-select:none}
  .sl-el{position:absolute;box-sizing:border-box}
  .sl-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
  .sl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}
  .sl-text{position:absolute;inset:0;padding:8px;display:flex;flex-direction:column;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.3;outline:none}
  .sl-li{display:flex;gap:.35em}.sl-bu{flex:none}
  .sl-ph{opacity:.38}
  .sl-badge{position:absolute;left:-12px;top:-12px;background:#ffb547;color:#000;font:600 18px/26px system-ui;width:26px;height:26px;border-radius:13px;text-align:center}
  .sl-editor{display:grid;grid-template-columns:170px minmax(0,1fr) 250px;gap:14px;align-items:start}
  .sl-thumbs{display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 170px);overflow:auto;padding:2px}
  .sl-thumb{position:relative;border:2px solid var(--line);border-radius:6px;overflow:hidden;cursor:pointer;flex:none;background:#fff}
  .sl-thumb.on{border-color:var(--accent)}
  .sl-thumb .n{position:absolute;left:4px;bottom:2px;font-size:11px;color:#888;background:rgba(255,255,255,.8);padding:0 4px;border-radius:3px}
  .sl-thumb.drop{outline:2px dashed var(--accent)}
  .sl-thumbs .sl-stage{pointer-events:none}
  .sl-main{min-width:0}
  .sl-wrap{position:relative;background:var(--bg);border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.15)}
  .sl-wrap .sl-el{cursor:move}
  .sl-wrap .sl-el.sel{outline:2px solid var(--accent);outline-offset:1px}
  .sl-wrap .sl-el.editing{cursor:text}
  .sl-h{position:absolute;width:14px;height:14px;background:#fff;border:2px solid var(--accent);border-radius:3px;z-index:5}
  .sl-guide{position:absolute;background:#ff3d7f;z-index:6;pointer-events:none}
  .sl-panel{display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 170px);overflow:auto}
  .sl-panel .card{padding:12px}
  .sl-panel h3{font-size:13px;margin:0 0 8px}
  .sl-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
  .sl-row label{font-size:12px;color:var(--muted);display:flex;gap:4px;align-items:center}
  .sl-row input[type=number]{width:64px}
  .sl-row input[type=color]{width:34px;height:30px;padding:2px}
  .sl-tb{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .sl-tb select{max-width:150px}
  .btn.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
  .sl-anims{list-style:none;margin:0;padding:0;font-size:12px}
  .sl-anims li{display:flex;gap:4px;align-items:center;padding:4px;border-radius:6px;cursor:pointer}
  .sl-anims li.on{background:var(--accent-soft)}
  .sl-anims li span.g{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sl-notes{margin-top:10px}
  .sl-decks{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .sl-deck{cursor:pointer}
  .sl-deck .sl-thumb{border-width:1px}
  .sl-present{position:fixed;inset:0;background:#000;z-index:100;display:flex;align-items:center;justify-content:center;cursor:none}
  .sl-present.cursor{cursor:default}
  .sl-present .sl-frame{position:relative;overflow:hidden}
  .sl-present .sl-ph{display:none}
  .sl-present .sl-count{position:fixed;right:14px;bottom:10px;color:rgba(255,255,255,.45);font:13px system-ui}
  .sl-present .sl-exit{position:fixed;right:12px;top:10px;color:#fff;background:rgba(255,255,255,.15);border:none;border-radius:8px;padding:6px 12px;font:14px system-ui;opacity:0;transition:opacity .3s}
  .sl-present.cursor .sl-exit{opacity:1}
  .sl-present.black .sl-frame{visibility:hidden}
  .sl-hidden{visibility:hidden}
  @keyframes sl-fade{from{opacity:0}to{opacity:1}}
  @keyframes sl-rise{from{opacity:0;transform:translateY(90px)}to{opacity:1;transform:none}}
  @keyframes sl-left{from{opacity:0;transform:translateX(160px)}to{opacity:1;transform:none}}
  @keyframes sl-zoom{from{opacity:0;transform:scale(.2)}to{opacity:1;transform:none}}
  @keyframes sl-wipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
  @keyframes tr-fade{from{opacity:0}to{opacity:1}}
  @keyframes tr-slide{from{transform:translateX(100%)}to{transform:none}}
  @keyframes tr-zoom{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
  @media (max-width:900px){
    .sl-editor{grid-template-columns:1fr}
    .sl-thumbs{flex-direction:row;max-height:none;overflow-x:auto;align-items:flex-start}
    .sl-thumbs>div{flex:none}
    .sl-thumbs .sl-row{flex-wrap:nowrap;margin:0!important;align-self:center}
    .sl-panel{max-height:none}
  }`;
  function injectCss() {
    if (document.getElementById('sl-css')) return;
    const st = document.createElement('style');
    st.id = 'sl-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function stageHtml(slide, theme, scale, opts = {}) {
    return `<div class="sl-stage" style="transform:scale(${scale});background:${bgOf(slide, theme)}">${slideHtml(slide, theme, opts)}</div>`;
  }
  function thumbHtml(slide, theme, width, label) {
    const sc = width / W;
    return `<div class="sl-thumb" style="width:${width}px;height:${Math.round(H * sc)}px">${stageHtml(slide, theme, sc, { editing: true })}${label ? `<span class="n">${label}</span>` : ''}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Presenter (slideshow with animations and transitions)
  // ---------------------------------------------------------------------------

  function present(deck, startIndex, onExit) {
    const theme = themeOf(deck);
    const root = document.createElement('div');
    root.className = 'sl-present';
    root.innerHTML = '<div class="sl-frame"></div><span class="sl-count"></span><button class="sl-exit">終了 (Esc)</button>';
    document.body.appendChild(root);
    const frame = root.querySelector('.sl-frame');
    let index = startIndex, step = 0, groups = [], scale = 1, timers = [];

    const fit = () => {
      scale = Math.min(window.innerWidth / W, window.innerHeight / H);
      frame.style.width = W * scale + 'px';
      frame.style.height = H * scale + 'px';
      const st = frame.querySelector('.sl-stage');
      if (st) st.style.transform = `scale(${scale})`;
    };
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

    function show(i, { revealAll = false, transition = true } = {}) {
      clearTimers();
      index = i;
      const slide = deck.slides[i];
      groups = buildSteps(slide);
      frame.innerHTML = stageHtml(slide, theme, scale);
      const animIds = new Set(animated(slide).map(e => e.id));
      if (!revealAll) animIds.forEach(id => { const n = frame.querySelector(`[data-id="${id}"]`); if (n) n.classList.add('sl-hidden'); });
      step = revealAll ? groups.length : 0;
      if (transition && slide.transition && slide.transition !== 'none') {
        // animate a wrapper so the stage keeps its scale transform
        const st = frame.querySelector('.sl-stage');
        const wrap = document.createElement('div');
        wrap.style.animation = `tr-${slide.transition} .6s ease both`;
        frame.insertBefore(wrap, st);
        wrap.appendChild(st);
      }
      root.querySelector('.sl-count').textContent = `${i + 1} / ${deck.slides.length}`;
      if (!revealAll && groups[0] && groups[0].auto) play();
    }

    function play() {
      const g = groups[step++];
      for (const { e, delay } of g.items) {
        timers.push(setTimeout(() => {
          const n = frame.querySelector(`[data-id="${e.id}"]`);
          if (!n) return;
          n.classList.remove('sl-hidden');
          n.style.animation = `sl-${e.anim.effect} ${+e.anim.dur || 0.5}s ease both`;
        }, delay * 1000));
      }
    }
    function next() {
      if (step < groups.length) return play();
      if (index < deck.slides.length - 1) show(index + 1);
      else exit();
    }
    function prev() {
      if (index > 0) show(index - 1, { revealAll: true, transition: false });
      else show(0, { transition: false });
    }
    function exit() {
      clearTimers();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      root.remove();
      onExit && onExit(index);
    }
    function onKey(e) {
      e.stopPropagation();
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key)) { e.preventDefault(); next(); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') { e.preventDefault(); exit(); }
      else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(deck.slides.length - 1, { revealAll: true });
      else if (e.key === 'b' || e.key === '.') root.classList.toggle('black');
    }
    const onResize = () => fit();
    const onFs = () => { if (!document.fullscreenElement) exit(); };
    let hideTimer;
    root.addEventListener('mousemove', () => {
      root.classList.add('cursor');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => root.classList.remove('cursor'), 1500);
    });
    root.addEventListener('click', e => {
      if (e.target.closest('.sl-exit')) return exit();
      if (e.clientX < window.innerWidth * 0.25) prev(); else next();
    });
    root.addEventListener('contextmenu', e => { e.preventDefault(); prev(); });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    if (root.requestFullscreen) {
      root.requestFullscreen().then(() => document.addEventListener('fullscreenchange', onFs)).catch(() => {});
    }
    fit();
    show(index);
  }

  // ---------------------------------------------------------------------------
  // Deck list
  // ---------------------------------------------------------------------------

  async function listPage(view, deps) {
    const decks = await deps.GET('decks');
    view.innerHTML = `
      <div class="page-head"><h1>スライド</h1><button class="btn primary" id="newDeck">＋ 新規プレゼンテーション</button></div>
      ${decks.length ? `<div class="sl-decks">${decks.map(d => `
        <div class="card sl-deck" data-id="${esc(d.id)}">
          <div style="font-weight:600;margin-bottom:4px">▭ ${esc(d.name)}</div>
          <div class="muted small">更新 ${esc(String(d.updated || '').replace('T', ' ').slice(0, 16))}</div>
        </div>`).join('')}</div>` : '<div class="card empty">プレゼンテーションはまだありません。「新規プレゼンテーション」から作成できます。</div>'}`;
    view.querySelector('#newDeck').onclick = async () => {
      const name = prompt('プレゼンテーション名', '新しいプレゼンテーション');
      if (!name) return;
      try {
        const d = await deps.api('POST', 'decks', { name, data: JSON.stringify(newDeck()) });
        deps.go('#/slides/' + d.id);
      } catch (e) { deps.fail(e); }
    };
    view.querySelectorAll('.sl-deck').forEach(c => { c.onclick = () => deps.go('#/slides/' + c.dataset.id); });
  }

  // ---------------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------------

  async function editor(view, id, deps) {
    const rec = await deps.GET('decks/' + id);
    const deck = parseDeck(rec.data);
    let name = rec.name;
    let cur = 0;            // current slide index
    let selId = null;       // selected element id
    let editingId = null;   // element whose text is being edited
    let clipboard = null;
    const undo = [], redo = [];
    let lastSnap = 0;
    let scale = 0.5;
    const off = [];         // cleanup callbacks
    const on = (target, ev, fn, opt) => { target.addEventListener(ev, fn, opt); off.push(() => target.removeEventListener(ev, fn, opt)); };

    const slide = () => deck.slides[cur];
    const theme = () => themeOf(deck);
    const selected = () => (selId ? slide().elements.find(e => e.id === selId) : null);

    view.innerHTML = `
      <div class="page-head"><h1 id="slName" title="クリックで名前変更" style="cursor:pointer">${esc(name)}</h1>
        <span class="muted small" id="slSave"></span>
        <button class="btn primary" id="slPlay" title="最初から発表 (F5)">▶ 最初から</button>
        <button class="btn" id="slPlayHere" title="現在のスライドから発表 (Shift+F5)">▶ 現在から</button>
        <select id="slExport"><option value="">書き出し ▾</option><option value="pptx">PowerPoint (.pptx)</option><option value="pdf">PDF</option><option value="png">PNG（このスライド）</option><option value="pngs">PNG（全スライド・ZIP）</option><option value="txt">テキスト (.txt)</option></select>
        <button class="btn danger" id="slDelete">削除</button>
        <a class="btn" href="#/slides">一覧へ</a>
      </div>
      <div class="sl-tb">
        <select id="slAddSlide"><option value="">＋ スライド ▾</option>${Object.entries(LAYOUTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn" id="slAddText">T テキスト</button>
        <select id="slAddShape"><option value="">◆ 図形 ▾</option>${Object.entries(SHAPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <label class="btn">▧ 画像<input type="file" id="slAddImage" accept="image/*" hidden></label>
        <button class="btn" id="slUndo" title="元に戻す (Ctrl+Z)">↶</button>
        <button class="btn" id="slRedo" title="やり直し (Ctrl+Y)">↷</button>
        <select id="slTheme" title="テーマ">${Object.entries(THEMES).map(([k, t]) => `<option value="${k}" ${deck.theme === k ? 'selected' : ''}>テーマ: ${t.name}</option>`).join('')}</select>
      </div>
      <div class="sl-editor">
        <div class="sl-thumbs" id="slThumbs"></div>
        <div class="sl-main">
          <div class="sl-wrap" id="slWrap" tabindex="0"></div>
          <textarea class="sl-notes" id="slNotes" rows="3" placeholder="発表者ノート（テキスト書き出しに含まれます）"></textarea>
        </div>
        <div class="sl-panel" id="slPanel"></div>
      </div>`;

    const $ = s => view.querySelector(s);
    const wrap = $('#slWrap');

    // ---- persistence / history ----
    const save = debounce(async () => {
      const data = JSON.stringify(deck);
      if (data.length > MAX_BYTES * 1.33) {
        $('#slSave').textContent = '大きすぎて保存できません（画像を減らしてください）';
        return;
      }
      try {
        await deps.api('PUT', 'decks/' + id, { data });
        const s = $('#slSave');
        if (s) s.textContent = '保存済み';
      } catch (e) { deps.fail(e); }
    }, 700);
    function changed() {
      const s = $('#slSave');
      if (s) s.textContent = '編集中…';
      save();
    }
    function snap(coalesce = false) {
      const now = Date.now();
      if (coalesce && now - lastSnap < 900) { lastSnap = now; return; }
      lastSnap = now;
      undo.push(JSON.stringify({ deck, cur }));
      if (undo.length > 80) undo.shift();
      redo.length = 0;
    }
    function restore(stackFrom, stackTo) {
      if (!stackFrom.length) return;
      stackTo.push(JSON.stringify({ deck, cur }));
      const st = JSON.parse(stackFrom.pop());
      Object.assign(deck, st.deck);
      cur = clamp(st.cur, 0, deck.slides.length - 1);
      selId = null;
      lastSnap = 0;
      renderAll();
      changed();
    }

    // ---- rendering ----
    function fit() {
      const avail = $('.sl-main').clientWidth;
      scale = Math.max(0.15, Math.min(avail / W, (window.innerHeight - 260) / H));
      wrap.style.width = W * scale + 'px';
      wrap.style.height = H * scale + 'px';
    }
    function renderThumbs() {
      const t = theme();
      $('#slThumbs').innerHTML = deck.slides.map((s, i) => `<div data-i="${i}" draggable="true">${thumbHtml(s, t, 150, i + 1).replace('sl-thumb"', `sl-thumb${i === cur ? ' on' : ''}"`)}</div>`).join('') +
        '<div class="sl-row" style="margin-top:4px"><button class="btn sm" id="slUp" title="上へ">↑</button><button class="btn sm" id="slDown" title="下へ">↓</button><button class="btn sm" id="slDup" title="複製">複製</button><button class="btn sm danger" id="slDel" title="スライドを削除">削除</button></div>';
      $('#slUp').onclick = () => moveSlide(-1);
      $('#slDown').onclick = () => moveSlide(1);
      $('#slDup').onclick = () => { snap(); const c = clone(slide()); c.id = uid(); c.elements.forEach(e => { e.id = uid(); }); deck.slides.splice(cur + 1, 0, c); cur++; selId = null; renderAll(); changed(); };
      $('#slDel').onclick = () => {
        if (deck.slides.length === 1) return deps.toast('最後の1枚は削除できません');
        snap(); deck.slides.splice(cur, 1); cur = Math.min(cur, deck.slides.length - 1); selId = null; renderAll(); changed();
      };
    }
    function renderStage() {
      const s = slide();
      wrap.innerHTML = stageHtml(s, theme(), scale, { editing: true, selected: selId }) + handlesHtml();
      wrap.style.background = bgOf(s, theme());
      if (editingId) startTextEdit(editingId, false);
    }
    function handlesHtml() {
      const e = selected();
      if (!e || editingId) return '';
      const pts = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
      const cursors = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
      return Object.entries(pts).map(([k, [px, py]]) => `<div class="sl-h" data-h="${k}" style="left:${(e.x + e.w * px) * scale - 7}px;top:${(e.y + e.h * py) * scale - 7}px;cursor:${cursors[k]}-resize"></div>`).join('');
    }
    function renderPanel() {
      const e = selected();
      const s = slide();
      const anims = animated(s);
      const t = theme();
      const colorVal = c => (c && c !== 'none' ? c : '#000000');
      const animList = `<div class="card"><h3>アニメーションの順番</h3>${anims.length ? `<ul class="sl-anims">${anims.map((a, i) => `<li data-id="${a.id}" class="${a.id === selId ? 'on' : ''}"><b>${i + 1}</b><span class="g">${esc(labelOf(a))}</span><span class="muted">${EFFECTS[a.anim.effect]}・${STARTS[a.anim.start]}</span><button class="btn sm" data-mv="-1" title="前へ">↑</button><button class="btn sm" data-mv="1" title="後へ">↓</button></li>`).join('')}</ul>
        <div class="sl-row" style="margin-top:8px"><button class="btn sm" id="slPreview">▶ プレビュー</button></div>` : '<p class="muted small" style="margin:0">要素を選んで「アニメーション」を設定できます。</p>'}</div>`;
      if (!e) {
        $('#slPanel').innerHTML = `
          <div class="card"><h3>スライド ${cur + 1}</h3>
            <div class="sl-row"><label>背景 <input type="color" id="pBg" value="${colorVal(s.bg || t.bg)}"></label><button class="btn sm" id="pBgReset">テーマに戻す</button></div>
            <div class="sl-row"><label>切り替え効果 <select id="pTrans">${Object.entries(TRANSITIONS).map(([k, v]) => `<option value="${k}" ${s.transition === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
            <div class="sl-row"><button class="btn sm" id="pTransAll">全スライドに適用</button></div>
          </div>${animList}
          <div class="card small muted">ダブルクリックで文字を編集。Delete で削除、矢印で移動（Shift で10px）、Ctrl+C / V / D でコピー・貼り付け・複製、画像は貼り付けでも追加できます。</div>`;
        $('#pBg').oninput = ev => { snap(true); s.bg = ev.target.value; renderStage(); renderThumbs(); changed(); };
        $('#pBgReset').onclick = () => { snap(); s.bg = null; renderAll(); changed(); };
        $('#pTrans').onchange = ev => { snap(); s.transition = ev.target.value; changed(); renderThumbs(); };
        $('#pTransAll').onclick = () => { snap(); deck.slides.forEach(x => { x.transition = s.transition; }); changed(); deps.toast('すべてのスライドに適用しました'); };
      } else {
        const st = e.style;
        const isText = e.type !== 'image' && !(e.type === 'shape' && st.shape === 'line');
        const a = e.anim || { effect: 'none', start: 'click', dur: 0.5 };
        $('#slPanel').innerHTML = `
          <div class="card"><h3>${e.type === 'image' ? '画像' : e.type === 'shape' ? SHAPES[st.shape] || '図形' : 'テキスト'}</h3>
            ${isText ? `
            <div class="sl-row"><label>サイズ <input type="number" id="pSize" min="8" max="300" value="${st.fontSize}"></label>
              <label>文字色 <input type="color" id="pColor" value="${colorVal(colorOf(e, t))}"></label></div>
            <div class="sl-row">
              <button class="btn sm ${st.bold ? 'on' : ''}" id="pBold" title="太字 (Ctrl+B)"><b>B</b></button>
              <button class="btn sm ${st.italic ? 'on' : ''}" id="pItalic" title="斜体 (Ctrl+I)"><i>I</i></button>
              <button class="btn sm ${st.bullets ? 'on' : ''}" id="pBullets" title="箇条書き">• 箇条書き</button>
            </div>
            <div class="sl-row">${[['left', '左'], ['center', '中央'], ['right', '右']].map(([k, v]) => `<button class="btn sm ${st.align === k ? 'on' : ''}" data-align="${k}">${v}</button>`).join('')}
              <span style="width:6px"></span>${[['top', '上'], ['middle', '中'], ['bottom', '下']].map(([k, v]) => `<button class="btn sm ${st.valign === k ? 'on' : ''}" data-valign="${k}">${v}</button>`).join('')}</div>` : ''}
            ${e.type !== 'image' ? `
            <div class="sl-row">${st.shape === 'line' && e.type === 'shape' ? '' : `<label>塗り <input type="color" id="pFill" value="${colorVal(fillOf(e, t))}"></label><button class="btn sm" id="pNoFill">なし</button>`}
              <label>線 <input type="color" id="pStroke" value="${colorVal(e.type === 'shape' && st.shape === 'line' ? lineColorOf(e, t) : st.stroke)}"></label>${st.shape === 'line' && e.type === 'shape' ? '' : '<button class="btn sm" id="pNoStroke">なし</button>'}
              <label>太さ <input type="number" id="pSw" min="1" max="40" value="${st.strokeWidth}"></label></div>
            ${e.type === 'shape' ? `<div class="sl-row"><label>形 <select id="pShape">${Object.entries(SHAPES).map(([k, v]) => `<option value="${k}" ${st.shape === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>` : ''}` : ''}
            <div class="sl-row"><label>X <input type="number" id="pX" value="${Math.round(e.x)}"></label><label>Y <input type="number" id="pY" value="${Math.round(e.y)}"></label></div>
            <div class="sl-row"><label>幅 <input type="number" id="pW" value="${Math.round(e.w)}"></label><label>高さ <input type="number" id="pH" value="${Math.round(e.h)}"></label></div>
            <div class="sl-row">
              <button class="btn sm" id="pFront" title="最前面へ">最前面</button><button class="btn sm" id="pBack" title="最背面へ">最背面</button>
              <button class="btn sm" id="pDup">複製</button><button class="btn sm danger" id="pDel">削除</button>
            </div>
            <div class="sl-row"><button class="btn sm" data-alignslide="h">左右中央</button><button class="btn sm" data-alignslide="v">上下中央</button></div>
          </div>
          <div class="card"><h3>アニメーション</h3>
            <div class="sl-row"><label>効果 <select id="pEffect">${Object.entries(EFFECTS).map(([k, v]) => `<option value="${k}" ${a.effect === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
            <div class="sl-row"><label>開始 <select id="pStart">${Object.entries(STARTS).map(([k, v]) => `<option value="${k}" ${a.start === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
              <label>秒 <input type="number" id="pDur" min="0.1" max="10" step="0.1" value="${a.dur}"></label></div>
          </div>${animList}`;
        const upd = (fn, coalesce) => { snap(coalesce); fn(); renderStage(); renderThumbs(); changed(); };
        const bindNum = (sel, fn) => { const n = $(sel); if (n) n.oninput = ev => { const v = parseFloat(ev.target.value); if (!Number.isNaN(v)) upd(() => fn(v), true); }; };
        bindNum('#pSize', v => { st.fontSize = clamp(v, 4, 400); });
        bindNum('#pSw', v => { st.strokeWidth = clamp(v, 1, 80); });
        bindNum('#pX', v => { e.x = v; });
        bindNum('#pY', v => { e.y = v; });
        bindNum('#pW', v => { e.w = Math.max(5, v); });
        bindNum('#pH', v => { e.h = Math.max(2, v); });
        const bindColor = (sel, fn) => { const n = $(sel); if (n) n.oninput = ev => upd(() => fn(ev.target.value), true); };
        bindColor('#pColor', v => { st.color = v; });
        bindColor('#pFill', v => { st.fill = v; });
        bindColor('#pStroke', v => { st.stroke = v; });
        const click = (sel, fn) => { const n = $(sel); if (n) n.onclick = () => { upd(fn); renderPanel(); }; };
        click('#pBold', () => { st.bold = !st.bold; });
        click('#pItalic', () => { st.italic = !st.italic; });
        click('#pBullets', () => { st.bullets = !st.bullets; });
        click('#pNoFill', () => { st.fill = 'none'; });
        click('#pNoStroke', () => { st.stroke = null; });
        click('#pFront', () => { const els = slide().elements; els.push(els.splice(els.indexOf(e), 1)[0]); });
        click('#pBack', () => { const els = slide().elements; els.unshift(els.splice(els.indexOf(e), 1)[0]); });
        view.querySelectorAll('[data-align]').forEach(b => { b.onclick = () => { upd(() => { st.align = b.dataset.align; }); renderPanel(); }; });
        view.querySelectorAll('[data-valign]').forEach(b => { b.onclick = () => { upd(() => { st.valign = b.dataset.valign; }); renderPanel(); }; });
        view.querySelectorAll('[data-alignslide]').forEach(b => { b.onclick = () => { upd(() => { if (b.dataset.alignslide === 'h') e.x = (W - e.w) / 2; else e.y = (H - e.h) / 2; }); renderPanel(); }; });
        const sh = $('#pShape');
        if (sh) sh.onchange = () => { upd(() => { st.shape = sh.value; }); renderPanel(); };
        $('#pDup').onclick = duplicate;
        $('#pDel').onclick = removeSelected;
        const setAnim = () => {
          const effect = $('#pEffect').value;
          upd(() => {
            if (effect === 'none') { e.anim = null; return; }
            const seq = e.anim && e.anim.effect !== 'none' ? e.anim.seq : Math.max(0, ...animated(slide()).map(x => x.anim.seq || 0)) + 1;
            e.anim = { effect, start: $('#pStart').value, dur: clamp(parseFloat($('#pDur').value) || 0.5, 0.1, 10), seq };
          });
          renderPanel();
          if (effect !== 'none') previewOne(e);
        };
        $('#pEffect').onchange = setAnim;
        $('#pStart').onchange = setAnim;
        $('#pDur').onchange = setAnim;
      }
      // shared: animation order list
      view.querySelectorAll('.sl-anims li').forEach(li => {
        li.onclick = ev => {
          const mv = ev.target.dataset.mv;
          if (mv) {
            const list = animated(slide());
            const i = list.findIndex(x => x.id === li.dataset.id);
            const j = i + +mv;
            if (j < 0 || j >= list.length) return;
            snap();
            [list[i], list[j]] = [list[j], list[i]];
            list.forEach((x, k) => { x.anim.seq = k + 1; });
            renderAll();
            changed();
            return;
          }
          selId = li.dataset.id;
          renderStage();
          renderPanel();
        };
      });
      const pv = $('#slPreview');
      if (pv) pv.onclick = previewSlide;
    }
    function renderAll() {
      fit();
      renderThumbs();
      renderStage();
      renderPanel();
      $('#slNotes').value = slide().notes || '';
    }
    const labelOf = e => (e.type === 'image' ? '画像' : (e.text || e.ph || SHAPES[e.style.shape] || 'テキスト').split('\n')[0].slice(0, 20));

    // ---- animation preview in the editor ----
    function previewOne(e) {
      const n = wrap.querySelector(`.sl-el[data-id="${e.id}"]`);
      if (!n) return;
      n.style.animation = 'none';
      void n.offsetWidth;
      n.style.animation = `sl-${e.anim.effect} ${e.anim.dur}s ease both`;
    }
    function previewSlide() {
      const groups = buildSteps(slide());
      const nodes = id => wrap.querySelector(`.sl-el[data-id="${id}"]`);
      animated(slide()).forEach(e => { const n = nodes(e.id); if (n) n.classList.add('sl-hidden'); });
      let t = 300;
      for (const g of groups) {
        for (const { e, delay } of g.items) {
          setTimeout(() => {
            const n = nodes(e.id);
            if (!n) return;
            n.classList.remove('sl-hidden');
            n.style.animation = 'none';
            void n.offsetWidth;
            n.style.animation = `sl-${e.anim.effect} ${e.anim.dur}s ease both`;
          }, t + delay * 1000);
        }
        t += g.end * 1000 + 600;
      }
    }

    // ---- element operations ----
    function addElement(e) {
      snap();
      slide().elements.push(e);
      selId = e.id;
      renderAll();
      changed();
    }
    function duplicate() {
      const e = selected();
      if (!e) return;
      const c = clone(e);
      c.id = uid();
      c.x += 24; c.y += 24;
      if (c.anim) c.anim.seq = Math.max(0, ...animated(slide()).map(x => x.anim.seq || 0)) + 1;
      addElement(c);
    }
    function removeSelected() {
      const e = selected();
      if (!e) return;
      snap();
      slide().elements = slide().elements.filter(x => x.id !== e.id);
      selId = null;
      renderAll();
      changed();
    }
    function moveSlide(d) {
      const j = cur + d;
      if (j < 0 || j >= deck.slides.length) return;
      snap();
      [deck.slides[cur], deck.slides[j]] = [deck.slides[j], deck.slides[cur]];
      cur = j;
      renderAll();
      changed();
    }
    async function addImage(file) {
      if (!file || !/^image\//.test(file.type)) return;
      try {
        const src = await shrinkImage(file);
        if (JSON.stringify(deck).length + src.length > MAX_BYTES * 1.33) {
          return deps.toast('画像が大きすぎるか、スライド全体の容量を超えます', true);
        }
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        const sc = Math.min(640 / img.width, 480 / img.height, 1);
        const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
        addElement(el('image', (W - w) / 2, (H - h) / 2, w, h, {}, { src }));
      } catch (e) { deps.fail(e); }
    }

    // ---- text editing ----
    function startTextEdit(eid, selectAll = true) {
      const e = slide().elements.find(x => x.id === eid);
      if (!e || e.type === 'image' || (e.type === 'shape' && e.style.shape === 'line')) return;
      editingId = eid;
      const node = wrap.querySelector(`.sl-el[data-id="${eid}"]`);
      if (!node) return;
      node.classList.add('editing');
      wrap.querySelectorAll('.sl-h').forEach(h => h.remove());
      const t = node.querySelector('.sl-text');
      t.textContent = e.text;
      try { t.contentEditable = 'plaintext-only'; } catch (err) { t.contentEditable = 'true'; }
      if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
      t.focus();
      const r = document.createRange();
      r.selectNodeContents(t);
      if (!selectAll) r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      t.onblur = () => endTextEdit();
      t.onkeydown = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); t.blur(); }
        ev.stopPropagation();
      };
      t.oninput = () => {
        // live update thumbnail text without re-rendering the editor node
        snap(true);
        e.text = t.innerText.replace(/\n$/, '');
        changed();
      };
    }
    function endTextEdit() {
      if (!editingId) return;
      const e = slide().elements.find(x => x.id === editingId);
      const node = wrap.querySelector(`.sl-el[data-id="${editingId}"] .sl-text`);
      if (e && node) e.text = node.innerText.replace(/\n$/, '');
      editingId = null;
      renderStage();
      renderThumbs();
      renderPanel();
      changed();
    }

    // ---- pointer interactions (move / resize with snapping) ----
    let drag = null;
    const toStage = ev => {
      const r = wrap.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
    };
    function snapValue(v, targets, tol) {
      let best = null;
      for (const t of targets) if (Math.abs(v - t) <= tol && (best === null || Math.abs(v - t) < Math.abs(v - best))) best = t;
      return best;
    }
    function showGuides(gx, gy) {
      wrap.querySelectorAll('.sl-guide').forEach(g => g.remove());
      if (gx !== null) wrap.insertAdjacentHTML('beforeend', `<div class="sl-guide" style="left:${gx * scale}px;top:0;width:1px;height:100%"></div>`);
      if (gy !== null) wrap.insertAdjacentHTML('beforeend', `<div class="sl-guide" style="top:${gy * scale}px;left:0;height:1px;width:100%"></div>`);
    }
    on(wrap, 'pointerdown', ev => {
      if (ev.button !== 0) return;
      const handle = ev.target.closest('.sl-h');
      const node = ev.target.closest('.sl-el');
      if (editingId) {
        if (node && node.dataset.id === editingId) return; // clicking inside the text being edited
        endTextEdit();
      }
      const p = toStage(ev);
      if (handle) {
        const e = selected();
        drag = { mode: 'resize', h: handle.dataset.h, e, start: p, orig: { x: e.x, y: e.y, w: e.w, h: e.h }, moved: false };
      } else if (node) {
        const changedSel = selId !== node.dataset.id;
        selId = node.dataset.id;
        const e = selected();
        drag = { mode: 'move', e, start: p, orig: { x: e.x, y: e.y }, moved: false };
        if (changedSel) { renderStage(); renderPanel(); }
      } else {
        if (selId) { selId = null; renderStage(); renderPanel(); }
        // The clicked node may have been re-rendered away; stop the browser from
        // moving focus to <body> so the editor keeps its keyboard shortcuts.
        ev.preventDefault();
        wrap.focus({ preventScroll: true });
        return;
      }
      wrap.setPointerCapture(ev.pointerId);
      wrap.focus({ preventScroll: true });
      ev.preventDefault();
    });
    on(wrap, 'pointermove', ev => {
      if (!drag) return;
      const p = toStage(ev);
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!drag.moved) { snap(); drag.moved = true; }
      const e = drag.e, o = drag.orig;
      const tol = 6 / scale;
      let gx = null, gy = null;
      if (drag.mode === 'move') {
        let nx = o.x + dx, ny = o.y + dy;
        if (!ev.altKey) {
          const others = slide().elements.filter(x => x.id !== e.id);
          const xs = [0, W / 2, W, ...others.flatMap(x => [x.x, x.x + x.w / 2, x.x + x.w])];
          const ys = [0, H / 2, H, ...others.flatMap(x => [x.y, x.y + x.h / 2, x.y + x.h])];
          for (const off of [0, e.w / 2, e.w]) {
            const s = snapValue(nx + off, xs, tol);
            if (s !== null && gx === null) { nx = s - off; gx = s; }
          }
          for (const off of [0, e.h / 2, e.h]) {
            const s = snapValue(ny + off, ys, tol);
            if (s !== null && gy === null) { ny = s - off; gy = s; }
          }
        }
        e.x = Math.round(nx);
        e.y = Math.round(ny);
      } else {
        const h = drag.h;
        let { x: nx, y: ny, w: nw, h: nh } = o;
        if (h.includes('e')) nw = o.w + dx;
        if (h.includes('s')) nh = o.h + dy;
        if (h.includes('w')) { nw = o.w - dx; nx = o.x + dx; }
        if (h.includes('n')) { nh = o.h - dy; ny = o.y + dy; }
        const keep = (e.type === 'image') !== ev.shiftKey && h.length === 2;
        if (keep) {
          const ratio = o.w / o.h;
          if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
          if (h.includes('w')) nx = o.x + o.w - nw;
          if (h.includes('n')) ny = o.y + o.h - nh;
        }
        const minH = e.type === 'shape' && e.style.shape === 'line' ? 4 : 16;
        if (nw < 16) { if (h.includes('w')) nx -= 16 - nw; nw = 16; }
        if (nh < minH) { if (h.includes('n')) ny -= minH - nh; nh = minH; }
        Object.assign(e, { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) });
      }
      const n = wrap.querySelector(`.sl-el[data-id="${e.id}"]`);
      if (drag.mode === 'resize') {
        // re-render the element (SVG geometry depends on size)
        n.outerHTML = elementHtml(e, theme(), { editing: true, selected: true, order: animated(slide()).findIndex(x => x.id === e.id) + 1 || null });
      } else {
        n.style.left = e.x + 'px';
        n.style.top = e.y + 'px';
      }
      wrap.querySelectorAll('.sl-h').forEach(x => x.remove());
      wrap.insertAdjacentHTML('beforeend', handlesHtml());
      showGuides(gx, gy);
    });
    const endDrag = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      showGuides(null, null);
      if (moved) { renderThumbs(); renderPanel(); changed(); }
    };
    on(wrap, 'pointerup', endDrag);
    on(wrap, 'pointercancel', endDrag);
    on(wrap, 'dblclick', ev => {
      const node = ev.target.closest('.sl-el');
      const eid = node ? node.dataset.id : selId; // the node may have been re-rendered by the first click
      if (eid) { selId = eid; startTextEdit(eid); }
    });

    // ---- keyboard / clipboard ----
    const typing = () => {
      const a = document.activeElement;
      return editingId || (a && (['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) || a.isContentEditable));
    };
    on(document, 'keydown', ev => {
      if (!document.body.contains(wrap) || document.querySelector('.sl-present')) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (ev.key === 'F5') { ev.preventDefault(); startShow(ev.shiftKey ? cur : 0); return; }
      if (typing()) return;
      if (!document.getElementById('modal').hidden) return;
      const e = selected();
      if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? restore(redo, undo) : restore(undo, redo); return; }
      if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); restore(redo, undo); return; }
      if (mod && ev.key.toLowerCase() === 'c' && e) { ev.preventDefault(); clipboard = clone(e); return; }
      if (mod && ev.key.toLowerCase() === 'x' && e) { ev.preventDefault(); clipboard = clone(e); removeSelected(); return; }
      if (mod && ev.key.toLowerCase() === 'v' && clipboard) {
        ev.preventDefault();
        const c = clone(clipboard);
        c.id = uid();
        if (slide().elements.some(x => x.x === c.x && x.y === c.y)) { c.x += 24; c.y += 24; }
        if (c.anim) c.anim.seq = Math.max(0, ...animated(slide()).map(x => x.anim.seq || 0)) + 1;
        addElement(c);
        return;
      }
      if (mod && ev.key.toLowerCase() === 'd' && e) { ev.preventDefault(); duplicate(); return; }
      if (mod && ev.key.toLowerCase() === 'b' && e) { ev.preventDefault(); snap(); e.style.bold = !e.style.bold; renderAll(); changed(); return; }
      if (mod && ev.key.toLowerCase() === 'i' && e) { ev.preventDefault(); snap(); e.style.italic = !e.style.italic; renderAll(); changed(); return; }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && e) { ev.preventDefault(); removeSelected(); return; }
      if (ev.key === 'Escape' && e) { selId = null; renderStage(); renderPanel(); return; }
      if (ev.key === 'Enter' && e) { ev.preventDefault(); startTextEdit(e.id); return; }
      const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (mv && e) {
        ev.preventDefault();
        snap(true);
        const k = ev.shiftKey ? 10 : 1;
        e.x += mv[0] * k;
        e.y += mv[1] * k;
        renderStage();
        renderThumbs();
        changed();
      } else if (mv && !e && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && document.activeElement !== document.getElementById('searchInput')) {
        ev.preventDefault();
        cur = clamp(cur + mv[1], 0, deck.slides.length - 1);
        renderAll();
      }
    }, true);
    on(document, 'paste', ev => {
      if (!document.body.contains(wrap) || typing()) return;
      const items = Array.from(ev.clipboardData ? ev.clipboardData.items : []);
      const img = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (img) { ev.preventDefault(); addImage(img.getAsFile()); return; }
      if (clipboard) return; // handled by keydown
      const text = ev.clipboardData && ev.clipboardData.getData('text/plain');
      if (text && text.trim()) {
        ev.preventDefault();
        const t = el('text', 240, 260, 800, 200, { fontSize: 28 });
        t.text = text.trim();
        addElement(t);
      }
    });

    // ---- toolbar ----
    $('#slAddSlide').onchange = ev => {
      const layout = ev.target.value;
      ev.target.value = '';
      if (!layout) return;
      snap();
      deck.slides.splice(cur + 1, 0, newSlide(layout));
      cur++;
      selId = null;
      renderAll();
      changed();
    };
    $('#slAddText').onclick = () => {
      const t = el('text', 340, 290, 600, 120, { fontSize: 32 }, { ph: 'テキストを入力' });
      addElement(t);
      startTextEdit(t.id);
    };
    $('#slAddShape').onchange = ev => {
      const shape = ev.target.value;
      ev.target.value = '';
      if (!shape) return;
      const dims = shape === 'line' ? [440, 330, 400, 20] : shape === 'arrow' ? [490, 290, 300, 140] : [540, 260, 200, 200];
      addElement(el('shape', ...dims, { shape, fontSize: 24, align: 'center', valign: 'middle', strokeWidth: shape === 'line' ? 4 : 3 }));
    };
    $('#slAddImage').onchange = ev => { addImage(ev.target.files[0]); ev.target.value = ''; };
    $('#slUndo').onclick = () => restore(undo, redo);
    $('#slRedo').onclick = () => restore(redo, undo);
    $('#slTheme').onchange = ev => { snap(); deck.theme = ev.target.value; renderAll(); changed(); };
    $('#slNotes').oninput = ev => { snap(true); slide().notes = ev.target.value; changed(); };
    $('#slName').onclick = async () => {
      const n = prompt('プレゼンテーション名', name);
      if (!n) return;
      try { await deps.api('PUT', 'decks/' + id, { name: n }); name = n; $('#slName').textContent = n; } catch (e) { deps.fail(e); }
    };
    $('#slDelete').onclick = async () => {
      if (!confirm(`「${name}」を削除しますか？`)) return;
      save.cancel();
      try { await deps.api('DELETE', 'decks/' + id); deps.go('#/slides'); } catch (e) { deps.fail(e); }
    };
    const startShow = i => { if (editingId) endTextEdit(); present(deck, i, last => { cur = last; selId = null; renderAll(); }); };
    $('#slPlay').onclick = () => startShow(0);
    $('#slPlayHere').onclick = () => startShow(cur);
    $('#slExport').onchange = async ev => {
      const kind = ev.target.value;
      ev.target.value = '';
      if (!kind) return;
      if (editingId) endTextEdit();
      const base = safeFile(name);
      try {
        deps.toast('書き出し中…');
        if (kind === 'pptx') download(buildPptx(deck, name), base + '.pptx');
        else if (kind === 'pdf') download(await buildPdf(deck, name), base + '.pdf');
        else if (kind === 'txt') download(buildText(deck, name), base + '.txt');
        else if (kind === 'png') download(await canvasBlob(await renderCanvas(deck, slide(), 1.5), 'image/png'), `${base}_${cur + 1}.png`);
        else if (kind === 'pngs') {
          const images = await loadImages(deck);
          const files = [];
          for (let i = 0; i < deck.slides.length; i++) {
            const b = await canvasBlob(await renderCanvas(deck, deck.slides[i], 1.5, images), 'image/png');
            files.push({ name: `${base}_${String(i + 1).padStart(2, '0')}.png`, data: new Uint8Array(await b.arrayBuffer()) });
          }
          download(zip(files), base + '_png.zip');
        }
      } catch (e) { deps.fail(e); }
    };

    // ---- thumbnails: select + drag to reorder ----
    let dragFrom = null;
    on($('#slThumbs'), 'click', ev => {
      const t = ev.target.closest('[data-i]');
      if (!t) return;
      if (editingId) endTextEdit();
      cur = +t.dataset.i;
      selId = null;
      renderAll();
    });
    on($('#slThumbs'), 'dragstart', ev => { const t = ev.target.closest('[data-i]'); if (t) dragFrom = +t.dataset.i; });
    on($('#slThumbs'), 'dragover', ev => {
      const t = ev.target.closest('[data-i]');
      if (!t || dragFrom === null) return;
      ev.preventDefault();
      view.querySelectorAll('.sl-thumb.drop').forEach(x => x.classList.remove('drop'));
      t.querySelector('.sl-thumb').classList.add('drop');
    });
    on($('#slThumbs'), 'drop', ev => {
      const t = ev.target.closest('[data-i]');
      if (!t || dragFrom === null) return;
      ev.preventDefault();
      const to = +t.dataset.i;
      if (to !== dragFrom) {
        snap();
        const [s] = deck.slides.splice(dragFrom, 1);
        deck.slides.splice(to, 0, s);
        cur = to;
        renderAll();
        changed();
      }
      dragFrom = null;
    });
    on($('#slThumbs'), 'dragend', () => { dragFrom = null; view.querySelectorAll('.sl-thumb.drop').forEach(x => x.classList.remove('drop')); });

    const ro = new ResizeObserver(() => { fit(); renderStage(); });
    ro.observe($('.sl-main'));
    off.push(() => ro.disconnect());

    deps.setCleanup(() => {
      if (editingId) endTextEdit();
      save.flush();
      off.forEach(f => f());
    });
    renderAll();
  }

  function debounce(fn, ms) {
    let t, pending = false;
    const d = (...a) => { pending = true; clearTimeout(t); t = setTimeout(() => { pending = false; fn(...a); }, ms); };
    d.flush = () => { if (pending) { clearTimeout(t); pending = false; fn(); } };
    d.cancel = () => { clearTimeout(t); pending = false; };
    return d;
  }

  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めません')); i.src = url; });
      const maxSide = 1600;
      let sc = Math.min(1, maxSide / Math.max(img.width, img.height));
      const isPng = file.type === 'image/png' || file.type === 'image/gif';
      for (let attempt = 0; attempt < 4; attempt++) {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const out = isPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
        if (out.length < 350 * 1024 || attempt === 3) {
          if (isPng && out.length >= 350 * 1024) return c.toDataURL('image/jpeg', 0.85);
          return out;
        }
        sc *= 0.7;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  window.Slides = {
    async route(view, args, deps) {
      injectCss();
      if (args[0]) return editor(view, args[0], deps);
      return listPage(view, deps);
    },
    // exported for tests / other modules
    _internal: { parseDeck, newDeck, buildPptx, buildPdf, buildText, buildSteps, renderCanvas, zip, crc32 },
  };
})();
