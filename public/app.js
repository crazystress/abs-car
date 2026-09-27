'use strict';

const BASE = window.BASE || '';
const ABS = BASE + '/abs';
const SKIP_BACK = 15;
const SKIP_FWD = 30;
const SYNC_EVERY_MS = 15_000;
const DEFAULT_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
const LONG_PRESS_MS = 700;
const PAGE_SIZE = 30;

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ---------- Utilidades ----------
function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLong(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const speedLabel = (r) => (Number.isInteger(Math.round(r * 100) / 10) ? r.toFixed(1) : r.toFixed(2)) + '×';

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
}

const coverUrl = (id) => `${ABS}/api/items/${id}/cover?width=600`;
const metaOf = (item) => item?.media?.metadata || {};
const authorOf = (item) => {
  const m = metaOf(item);
  return m.authorName || (m.authors || []).map((a) => a.name).join(', ');
};

class RelinkError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(ABS + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.error === 'relink') {
      startPairing();
      throw new RelinkError();
    }
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

// ---------- Vinculación ----------
let pairTimer;
async function startPairing() {
  clearInterval(pairTimer);
  if (!audio.paused) audio.pause();
  $('sync-status').hidden = true;
  show('pair');
  try {
    const res = await fetch(BASE + '/pair/start', { method: 'POST' });
    const { code, expiresAt, pairUrl } = await res.json();
    $('pair-code').textContent = code;
    $('pair-url').textContent = pairUrl.replace(/^https?:\/\//, '');
    $('pair-qr').src = `${BASE}/pair/qr.svg?code=${code}&lang=${getLang()}`;
    pairTimer = setInterval(async () => {
      const left = expiresAt - Date.now();
      $('pair-expire').textContent = left > 0 ? t('pair.expires', { min: Math.ceil(left / 60000) }) : '';
      try {
        const st = await (await fetch(BASE + '/pair/status')).json();
        if (st.status === 'approved') {
          clearInterval(pairTimer);
          toast(t('pair.done'));
          init();
        } else if (st.status === 'expired') {
          clearInterval(pairTimer);
          startPairing();
        }
      } catch {}
    }, 2000);
  } catch {
    $('pair-code').textContent = '····';
    $('pair-expire').textContent = t('pair.serverOffline');
    pairTimer = setTimeout(startPairing, 5000);
  }
}

// ---------- Inicio ----------
let me = null;
let progressById = {};

async function init() {
  show('loading');
  try {
    me = await (await fetch(BASE + '/me')).json();
  } catch {
    $('view-loading').querySelector('.center-msg').textContent = t('offlineRetry');
    return setTimeout(init, 5000);
  }
  if (!me.paired) return startPairing();
  show(P.itemId ? 'player' : 'home');
  loadHome();
}

async function loadProgress() {
  const user = await api('/api/me');
  progressById = {};
  for (const p of user.mediaProgress || []) if (!p.episodeId) progressById[p.libraryItemId] = p;
}

// Icono de check (capítulos escuchados, libros terminados)
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

// Barra de progreso + % escuchado, solo para libros empezados
function progressRow(progress) {
  const pct = Math.min(100, Math.max(0, (progress || 0) * 100));
  return `<div class="prog-row"><div class="bar"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div><span class="prog-pct">${Math.floor(pct)}%</span></div>`;
}

function card(item, { seq } = {}) {
  const el = document.createElement('button');
  el.className = 'card';
  const prog = progressById[item.id];
  el.innerHTML = `
    <div class="card-cover">
      <img loading="lazy" alt="">
      ${seq ? '<span class="seq-badge"></span>' : ''}
      ${prog?.isFinished ? `<span class="finished-tag">${CHECK_ICON}<span></span></span>` : ''}
    </div>
    ${prog && !prog.isFinished ? progressRow(prog.progress) : ''}
    <div class="card-title"></div>
    <div class="card-author"></div>`;
  el.querySelector('img').src = coverUrl(item.id);
  el.querySelector('.card-title').textContent = metaOf(item).title || t('untitled');
  el.querySelector('.finished-tag span')?.replaceChildren(t('book.finishedTag'));
  el.querySelector('.seq-badge')?.replaceChildren(`#${seq}`);
  el.querySelector('.card-author').textContent = authorOf(item);
  el.onclick = () => openItem(item.id, { title: metaOf(item).title, author: authorOf(item) });
  return el;
}

async function loadHome() {
  try {
    await loadProgress();
    const { libraryItems = [] } = await api('/api/me/items-in-progress');
    const books = libraryItems.filter((i) => i.mediaType === 'book');
    const [first, ...rest] = books;

    $('hero').hidden = !first;
    if (first) {
      $('hero-cover').src = coverUrl(first.id);
      $('hero-title').textContent = metaOf(first).title;
      $('hero-author').textContent = authorOf(first);
      $('hero-progress').innerHTML = progressRow(progressById[first.id]?.progress);
      $('hero').onclick = () => openItem(first.id, { title: metaOf(first).title, author: authorOf(first) });
    }
    $('continue-grid').replaceChildren(...rest.map(card));
    $('continue-empty').hidden = books.length > 0;
  } catch (e) {
    if (!(e instanceof RelinkError)) toast(t('err.continue'));
  }
}

// ---------- Biblioteca ----------
// Vistas: «Library» (libros), «Series», «Authors» y «Narrators».
const lib = {
  libraries: [], current: null, loaded: false,
  mode: 'library',   // library | series | authors | narrators
  series: null,      // serie abierta
  seriesByLib: {},   // caché de series por biblioteca
  author: null,      // autor abierto (ficha)
  narrator: null,    // narrador abierto: { name, numBooks }
  narratorsByLib: {},// caché de narradores por biblioteca
  authorData: null,  // respuesta de /api/authors/:id del autor abierto
  authorsByLib: {},  // caché de autores por biblioteca
  listScroll: 0,     // posición en la lista de autores, para volver al mismo sitio
  query: '',
  page: 0, total: 0, loading: false,
  req: 0, // cada carga nueva invalida las respuestas anteriores aún en camino
};

function centerMsg(text) {
  const p = document.createElement('p');
  p.className = 'center-msg';
  p.textContent = text;
  return p;
}

async function loadLibraries() {
  const { libraries = [] } = await api('/api/libraries');
  lib.libraries = libraries.filter((l) => l.mediaType === 'book');
  const saved = store('library');
  lib.current = lib.libraries.find((l) => l.id === saved) || lib.libraries[0] || null;
  const chips = $('library-chips');
  chips.replaceChildren();
  if (lib.libraries.length > 1) {
    for (const l of lib.libraries) {
      const b = document.createElement('button');
      b.className = 'chip' + (l === lib.current ? ' active' : '');
      b.textContent = l.name;
      b.onclick = () => {
        lib.current = l;
        lib.author = null;
        lib.narrator = null;
        lib.series = null;
        store('library', l.id);
        chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
        showLibrary();
      };
      chips.append(b);
    }
  }
  lib.loaded = true;
}

// Pinta la biblioteca según la vista: libros (todos o buscados), lista de autores o ficha de un autor
async function showLibrary() {
  setLibBarHidden(false);
  const input = $('search-input');
  input.dataset.i18nPlaceholder = `search.${lib.mode}`;
  input.placeholder = t(`search.${lib.mode}`);
  document.querySelectorAll('#lib-modes [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === lib.mode));
  const inDetail = (lib.mode === 'authors' && !!lib.author) || (lib.mode === 'narrators' && !!lib.narrator) || (lib.mode === 'series' && !!lib.series);
  $('detail-upnext').hidden = true;
  $('detail-avatar').classList.toggle('square', lib.mode === 'series');
  $('detail').hidden = !inDetail;
  $('library-grid').hidden = inDetail;
  $('library-grid').classList.toggle('list-mode', lib.mode === 'narrators'); // narradores: filas, no cuadrícula
  try {
    if (!lib.current) {
      $('library-more').hidden = true;
      $('library-grid').replaceChildren(centerMsg(t('library.none')));
    } else if (lib.mode === 'authors') await (lib.author ? showAuthor() : showAuthors());
    else if (lib.mode === 'narrators') await (lib.narrator ? showNarrator() : showNarrators());
    else if (lib.mode === 'series') await (lib.series ? showSeries() : showSeriesList());
    else await (lib.query ? runSearch(lib.query) : loadLibraryPage(true));
  } catch (e) {
    if (!(e instanceof RelinkError)) toast(t('err.library'));
  }
}

// ---------- Autores ----------
const BOOK_ICON = '<svg viewBox="0 0 24 24"><path d="M19 2H6c-1.21 0-2 .99-2 2v16c0 1.1.9 2 2 2h13v-2H6v-2h13V2Zm-2 14H6V4h11v12Z"/></svg>';
const norm = (str) => String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // sin tildes
const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const countLabel = (n) => t(n === 1 ? 'count.book' : 'count.books', { n });

function fillAvatar(box, a) {
  const initials = () => {
    box.innerHTML = '<span class="author-initials"></span>';
    box.firstChild.textContent = initialsOf(a.name);
  };
  if (!a.imagePath) return initials();
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.onerror = initials;
  img.src = `${ABS}/api/authors/${a.id}/image?width=400${a.updatedAt ? `&ts=${a.updatedAt}` : ''}`;
  box.replaceChildren(img);
}

async function showAuthors(restoreScroll = false) {
  const libId = lib.current.id;
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  if (!lib.authorsByLib[libId]) $('library-grid').replaceChildren(centerMsg(t('loading')));
  try {
    if (!lib.authorsByLib[libId]) {
      const d = await api(`/api/libraries/${libId}/authors`);
      lib.authorsByLib[libId] = (d.authors || []).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
    }
    if (req !== lib.req) return;
    renderAuthors();
    $('tab-library').scrollTop = restoreScroll ? lib.listScroll : 0;
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

// El buscador filtra la lista en local, sin tildes ni mayúsculas
function renderAuthors() {
  const all = lib.authorsByLib[lib.current.id] || [];
  const q = norm(lib.query);
  const shown = q ? all.filter((a) => norm(a.name).includes(q)) : all;
  $('library-grid').replaceChildren(
    ...(shown.length ? shown.map(authorTile) : [centerMsg(all.length ? t('list.noResults', { q: lib.query }) : t('authors.none'))]),
  );
}

function authorTile(a) {
  const el = document.createElement('button');
  el.className = 'author-tile';
  el.innerHTML = `
    <div class="author-wrap">
      <div class="author-avatar"></div>
      ${a.numBooks ? `<span class="author-badge">${BOOK_ICON}<span></span></span>` : ''}
    </div>
    <div class="card-title"></div>`;
  fillAvatar(el.querySelector('.author-avatar'), a);
  el.querySelector('.author-badge span')?.replaceChildren(String(a.numBooks));
  el.querySelector('.card-title').textContent = a.name;
  el.onclick = () => {
    lib.listScroll = $('tab-library').scrollTop;
    lib.author = a;
    showLibrary();
  };
  return el;
}

async function showAuthor() {
  const a = lib.author;
  const req = ++lib.req;
  lib.loading = true;
  lib.authorData = null;
  $('library-more').hidden = true;
  $('detail-back').textContent = '‹ ' + t('mode.authors');
  $('detail-name').textContent = a.name;
  $('detail-count').textContent = a.numBooks ? countLabel(a.numBooks) : '';
  fillAvatar($('detail-avatar'), a);
  $('detail-desc').hidden = true;
  $('detail-sections').replaceChildren(centerMsg(t('loading')));
  $('tab-library').scrollTop = 0;
  try {
    const d = await api(`/api/authors/${a.id}?${new URLSearchParams({ include: 'items,series', library: lib.current.id })}`);
    if (req !== lib.req) return;
    lib.authorData = d;
    if (d.description) {
      $('detail-desc').textContent = d.description;
      $('detail-desc').classList.remove('open');
      $('detail-desc').hidden = false;
    }
    renderAuthorSections();
  } catch (e) {
    if (req === lib.req && !(e instanceof RelinkError)) {
      $('detail-sections').replaceChildren();
      toast(t('err.author'));
    }
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

// Número del libro en una serie: de metadata.series (lista u objeto), del propio item o de «Serie #N»
function seqFor(item, group) {
  const meta = item.media?.metadata || {};
  const list = Array.isArray(meta.series) ? meta.series : meta.series ? [meta.series] : [];
  const hit = list.find((s) => s.id === group.id || norm(s.name) === norm(group.name));
  const seq = hit?.sequence ?? item.sequence;
  if (seq != null && String(seq).trim()) return String(seq).trim();
  for (const part of String(meta.seriesName || '').split(',')) {
    const m = part.trim().match(/^(.*?)\s*#\s*([\d.]+)$/);
    if (m && norm(m[1]) === norm(group.name)) return m[2];
  }
  return null;
}

// Libros del autor agrupados por serie (en orden de lectura) y, al final, los independientes
function renderAuthorSections() {
  const d = lib.authorData;
  if (!d) return;
  const books = d.libraryItems || [];
  const byTitle = (x, y) => (metaOf(x.item).title || '').localeCompare(metaOf(y.item).title || '', undefined, { numeric: true });
  const seqNum = (s) => (s == null || isNaN(parseFloat(s)) ? Infinity : parseFloat(s));
  const grouped = new Set();
  const sections = [];
  for (const g of d.series || []) {
    const items = (g.items || []).filter((i) => i?.id);
    if (!g.name || !items.length) continue;
    items.forEach((i) => grouped.add(i.id));
    const entries = items.map((item) => ({ item, seq: seqFor(item, g) })).sort((x, y) => seqNum(x.seq) - seqNum(y.seq) || byTitle(x, y));
    sections.push({ label: g.name, entries });
  }
  sections.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
  const standalone = books.filter((b) => !grouped.has(b.id)).map((item) => ({ item })).sort(byTitle);
  if (standalone.length) sections.push({ label: sections.length ? t('author.standalone') : null, entries: standalone });

  const total = new Set([...books.map((b) => b.id), ...grouped]).size || lib.author.numBooks || 0;
  $('detail-count').textContent = total ? countLabel(total) : '';

  const out = [];
  for (const s of sections) {
    if (s.label) {
      const h = document.createElement('h3');
      h.className = 'section-title';
      h.textContent = s.label;
      out.push(h);
    }
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...s.entries.map((e) => card(e.item, { seq: e.seq })));
    out.push(grid);
  }
  $('detail-sections').replaceChildren(...(out.length ? out : [centerMsg(t('continue.empty'))]));
}

$('detail-back').onclick = () => {
  const back = { narrators: showNarrators, series: showSeriesList, authors: showAuthors }[lib.mode];
  lib.author = null;
  lib.authorData = null;
  lib.narrator = null;
  lib.series = null;
  $('detail').hidden = true;
  $('library-grid').hidden = false;
  back(true).catch(() => toast(t('err.library')));
};

// ---------- Series ----------
async function showSeriesList(restoreScroll = false) {
  const libId = lib.current.id;
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  if (!lib.seriesByLib[libId]) $('library-grid').replaceChildren(centerMsg(t('loading')));
  try {
    if (!lib.seriesByLib[libId]) {
      // Añadidas recientemente primero
      const qs = new URLSearchParams({ limit: 1000, page: 0, sort: 'addedAt', desc: 1, minified: 1 });
      const d = await api(`/api/libraries/${libId}/series?${qs}`);
      lib.seriesByLib[libId] = (d.results || []).filter((s) => s?.id && s.name);
    }
    if (req !== lib.req) return;
    renderSeriesList();
    $('tab-library').scrollTop = restoreScroll ? lib.listScroll : 0;
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

function renderSeriesList() {
  const all = lib.seriesByLib[lib.current.id] || [];
  const q = norm(lib.query);
  const shown = q ? all.filter((s) => norm(s.name).includes(q)) : all;
  $('library-grid').replaceChildren(
    ...(shown.length ? shown.map(seriesTile) : [centerMsg(all.length ? t('list.noResults', { q: lib.query }) : t('series.none'))]),
  );
}

// Libros de la serie en orden de lectura (según lo que venga en la lista de series)
function seriesBooksSorted(s) {
  const books = (s.books || []).filter((b) => b?.id);
  const seqNum = (b) => {
    const n = parseFloat(seqFor(b, s) ?? b.sequence);
    return isNaN(n) ? Infinity : n;
  };
  return books.slice().sort((a, b) => seqNum(a) - seqNum(b));
}

function seriesTile(s) {
  const books = seriesBooksSorted(s);
  const ids = books.length ? books.map((b) => b.id) : s.libraryItemIds || [];
  const total = books.length || s.numBooks || ids.length;
  const finished = ids.filter((id) => progressById[id]?.isFinished).length;
  const progress = ids.length ? ids.reduce((sum, id) => sum + (progressById[id]?.isFinished ? 1 : progressById[id]?.progress || 0), 0) / ids.length : 0;
  const covers = ids.slice(0, 3);
  const el = document.createElement('button');
  el.className = 'series-tile';
  el.innerHTML = `
    <div class="series-stack n${covers.length}">
      ${covers.map((_, i) => `<div class="sc sc-${i}"><img loading="lazy" alt=""></div>`).join('')}
      <span class="author-badge">${BOOK_ICON}<span></span></span>
    </div>
    <div class="card-title"></div>
    <div class="card-author"></div>`;
  el.querySelectorAll('.sc img').forEach((img, i) => (img.src = coverUrl(covers[i])));
  el.querySelector('.author-badge span').textContent = finished > 0 && finished < total ? `${finished}/${total}` : String(total);
  // Progreso de la serie sobre la carátula de delante: ámbar si va a medias, verde si está terminada
  const front = el.querySelector('.sc-0');
  if (front && total && finished >= total) front.insertAdjacentHTML('beforeend', '<div class="series-bar done"><div></div></div>');
  else if (front && progress > 0) front.insertAdjacentHTML('beforeend', `<div class="series-bar"><div style="width:${(progress * 100).toFixed(1)}%"></div></div>`);
  el.querySelector('.card-title').textContent = s.name;
  el.querySelector('.card-author').textContent = books[0] ? authorOf(books[0]) : '';
  el.onclick = () => {
    lib.listScroll = $('tab-library').scrollTop;
    lib.series = s;
    showLibrary();
  };
  return el;
}

// Ficha de la serie: carátula, autor, «Siguiente» y libros en orden de lectura con su número
async function showSeries() {
  const s = lib.series;
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  const first = seriesBooksSorted(s)[0];
  $('detail-back').textContent = '‹ ' + t('mode.series');
  $('detail-name').textContent = s.name;
  $('detail-count').textContent = '';
  const avatar = $('detail-avatar');
  if (first) {
    avatar.innerHTML = '<img alt="">';
    avatar.firstChild.src = coverUrl(first.id);
  } else avatar.innerHTML = `<span class="author-initials">${BOOK_ICON}</span>`;
  $('detail-desc').hidden = true;
  $('detail-sections').replaceChildren(centerMsg(t('loading')));
  $('tab-library').scrollTop = 0;
  try {
    const qs = new URLSearchParams({ filter: `series.${b64(s.id)}`, sort: 'media.metadata.series.sequence', limit: 200, collapseseries: 0, minified: 1 });
    const d = await api(`/api/libraries/${lib.current.id}/items?${qs}`);
    if (req !== lib.req) return;
    const seqNum = (x) => (x.seq == null || isNaN(parseFloat(x.seq)) ? Infinity : parseFloat(x.seq));
    const entries = (d.results || []).map((item) => ({ item, seq: seqFor(item, s) }))
      .sort((a, b) => seqNum(a) - seqNum(b) || (metaOf(a.item).title || '').localeCompare(metaOf(b.item).title || '', undefined, { numeric: true }));
    lib.seriesEntries = entries;
    renderSeriesDetail();
  } catch (e) {
    if (req === lib.req && !(e instanceof RelinkError)) {
      $('detail-sections').replaceChildren();
      toast(t('err.series'));
    }
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

function renderSeriesDetail() {
  const entries = lib.seriesEntries || [];
  const author = entries[0] ? authorOf(entries[0].item) : '';
  $('detail-count').textContent = [author, countLabel(entries.length)].filter(Boolean).join('  ·  ');

  // «Siguiente»: primer libro sin terminar, en orden de lectura
  const next = entries.find((e) => !progressById[e.item.id]?.isFinished);
  const up = $('detail-upnext');
  up.hidden = !next;
  if (next) {
    const prog = progressById[next.item.id]?.progress || 0;
    const pct = Math.floor(prog * 100);
    up.innerHTML = `<span class="un-fill" style="width:${(prog * 100).toFixed(1)}%"></span>
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><span class="un-text"></span>${pct > 0 ? `<span class="un-pct">${pct}%</span>` : ''}`;
    up.querySelector('.un-text').textContent = `${t('series.upNext')}${next.seq ? `  #${next.seq}` : ''}  ·  ${metaOf(next.item).title || ''}`;
    up.onclick = () => openItem(next.item.id, { title: metaOf(next.item).title, author: authorOf(next.item) });
  }

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(...entries.map((e) => card(e.item, { seq: e.seq })));
  $('detail-sections').replaceChildren(entries.length ? grid : centerMsg(t('continue.empty')));
}

// ---------- Narradores: filas con micrófono, nombre y nº de libros ----------
const MIC_ICON = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5.3-3a5.3 5.3 0 0 1-10.6 0H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7Z"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';

async function showNarrators(restoreScroll = false) {
  const libId = lib.current.id;
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  if (!lib.narratorsByLib[libId]) $('library-grid').replaceChildren(centerMsg(t('loading')));
  try {
    if (!lib.narratorsByLib[libId]) {
      const d = await api(`/api/libraries/${libId}/narrators`);
      lib.narratorsByLib[libId] = (d.narrators || [])
        .filter((n) => n?.name)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    if (req !== lib.req) return;
    renderNarrators();
    $('tab-library').scrollTop = restoreScroll ? lib.listScroll : 0;
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

function renderNarrators() {
  const all = lib.narratorsByLib[lib.current.id] || [];
  const q = norm(lib.query);
  const shown = q ? all.filter((n) => norm(n.name).includes(q)) : all;
  $('library-grid').replaceChildren(
    ...(shown.length ? shown.map(narratorRow) : [centerMsg(all.length ? t('list.noResults', { q: lib.query }) : t('narrators.none'))]),
  );
}

function narratorRow(n) {
  const el = document.createElement('button');
  el.className = 'narrator-row';
  el.innerHTML = `<span class="nr-mic">${MIC_ICON}</span><span class="nr-name"></span><span class="nr-count"></span><span class="nr-chevron">${CHEVRON_ICON}</span>`;
  el.querySelector('.nr-name').textContent = n.name;
  el.querySelector('.nr-count').textContent = n.numBooks != null ? countLabel(n.numBooks) : '';
  el.onclick = () => {
    lib.listScroll = $('tab-library').scrollTop;
    lib.narrator = n;
    showLibrary();
  };
  return el;
}

// Libros del narrador, ordenados por título (filtro de Audiobookshelf: narrators.<base64(nombre)>)
async function showNarrator() {
  const n = lib.narrator;
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  $('detail-back').textContent = '‹ ' + t('mode.narrators');
  $('detail-name').textContent = n.name;
  $('detail-count').textContent = n.numBooks != null ? countLabel(n.numBooks) : '';
  $('detail-avatar').innerHTML = `<span class="author-initials narrator-mic">${MIC_ICON}</span>`;
  $('detail-desc').hidden = true;
  $('detail-sections').replaceChildren(centerMsg(t('loading')));
  $('tab-library').scrollTop = 0;
  try {
    const qs = new URLSearchParams({ filter: `narrators.${b64(n.name)}`, sort: 'media.metadata.title', limit: 200, minified: '1' });
    const d = await api(`/api/libraries/${lib.current.id}/items?${qs}`);
    if (req !== lib.req) return;
    const items = (d.results || []).sort((a, b) => (metaOf(a).title || '').localeCompare(metaOf(b).title || '', undefined, { numeric: true }));
    $('detail-count').textContent = countLabel(d.total ?? items.length);
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...items.map((item) => card(item)));
    $('detail-sections').replaceChildren(items.length ? grid : centerMsg(t('continue.empty')));
  } catch (e) {
    if (req === lib.req && !(e instanceof RelinkError)) {
      $('detail-sections').replaceChildren();
      toast(t('err.narrator'));
    }
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}
$('detail-desc').onclick = () => $('detail-desc').classList.toggle('open');

async function loadLibraryPage(reset) {
  if (!lib.current) return;
  if (!reset && lib.loading) return; // ya hay una página en camino
  if (reset) {
    lib.page = 0;
    $('library-grid').replaceChildren();
    $('tab-library').scrollTop = 0;
  }
  const req = ++lib.req;
  lib.loading = true;
  try {
    const qs = new URLSearchParams({ sort: 'addedAt', desc: '1', limit: PAGE_SIZE, page: lib.page, minified: '1' });
    const data = await api(`/api/libraries/${lib.current.id}/items?${qs}`);
    if (req !== lib.req) return;
    lib.total = data.total || 0;
    $('library-grid').append(...(data.results || []).map(card));
    lib.page++;
    $('library-more').hidden = lib.page * PAGE_SIZE >= lib.total;
  } finally {
    if (req === lib.req) lib.loading = false;
  }
  if (req === lib.req) setTimeout(autoloadIfNear, 0);
}

const AUTOLOAD_MARGIN = 800; // px antes del final en los que ya se pide la siguiente página

// Carga la siguiente página al acercarse al final (y si tras cargar el final sigue a la vista, otra más)
function autoloadIfNear() {
  const more = $('library-more');
  const panel = $('tab-library');
  if (more.hidden || lib.loading || !panel.classList.contains('active')) return;
  if (more.getBoundingClientRect().top - panel.getBoundingClientRect().bottom < AUTOLOAD_MARGIN) {
    loadLibraryPage(false).catch(() => toast(t('err.more')));
  }
}

const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))); // valores de filtro de Audiobookshelf
const SEARCH_MAX_AUTHORS = 5;

// Búsqueda de libros por título y autor.
// Audiobookshelf devuelve en `book` solo las coincidencias por título; los autores que coinciden
// vienen aparte (`authors`), así que pedimos sus libros filtrando la biblioteca por cada autor.
async function runSearch(q) {
  const req = ++lib.req;
  lib.loading = true;
  $('library-more').hidden = true;
  try {
    const libId = lib.current.id;
    const data = await api(`/api/libraries/${libId}/search?${new URLSearchParams({ q, limit: 100 })}`);
    if (req !== lib.req) return;
    const items = (data.book || []).map((b) => b.libraryItem).filter(Boolean);
    const authors = (data.authors || []).filter((a) => a?.id).slice(0, SEARCH_MAX_AUTHORS);
    if (authors.length) {
      const byAuthor = await Promise.all(
        authors.map((a) =>
          api(`/api/libraries/${libId}/items?${new URLSearchParams({ filter: `authors.${b64(a.id)}`, sort: 'media.metadata.title', limit: 100, minified: '1' })}`)
            .then((d) => d.results || [])
            .catch(() => []),
        ),
      );
      if (req !== lib.req) return;
      const seen = new Set(items.map((i) => i.id));
      for (const list of byAuthor) for (const it of list) if (!seen.has(it.id)) (seen.add(it.id), items.push(it));
    }
    $('library-grid').replaceChildren(...(items.length ? items.map(card) : [centerMsg(t('library.noResults', { q }))]));
    $('tab-library').scrollTop = 0;
  } catch (e) {
    if (req === lib.req && !(e instanceof RelinkError)) toast(t('err.search'));
  } finally {
    if (req === lib.req) lib.loading = false;
  }
}

{
  const input = $('search-input');
  let timer;
  const apply = () => {
    lib.query = input.value.trim();
    lib.author = null; // en Series / Autores / Narradores, buscar vuelve a la lista
    lib.narrator = null;
    lib.series = null;
    showLibrary();
  };
  input.addEventListener('input', () => {
    $('search-clear').hidden = !input.value;
    clearTimeout(timer);
    // libros: espera a que dejes de teclear (busca en el servidor); series/autores/narradores: casi al instante (filtro local)
    timer = setTimeout(apply, lib.mode === 'library' ? 350 : 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      apply();
      input.blur(); // oculta el teclado
    }
  });
  $('search-clear').onclick = () => {
    clearTimeout(timer);
    input.value = '';
    $('search-clear').hidden = true;
    lib.query = '';
    lib.author = null;
    lib.narrator = null;
    lib.series = null;
    showLibrary();
  };
}

// Botones de vista (Library / Authors; los desactivados no responden)
document.querySelectorAll('#lib-modes [data-mode]').forEach((b) => {
  b.onclick = () => {
    if (b.disabled || (lib.mode === b.dataset.mode && !lib.author && !lib.narrator && !lib.series)) return;
    lib.mode = b.dataset.mode;
    lib.author = null;
    lib.narrator = null;
    lib.series = null;
    lib.query = '';
    $('search-input').value = '';
    $('search-clear').hidden = true;
    showLibrary();
  };
});

$('tab-library').addEventListener('scroll', autoloadIfNear, { passive: true });

// Buscador + secciones: se ocultan al bajar y reaparecen al subir.
// Se acumula el desplazamiento en cada sentido para no parpadear con movimientos pequeños.
const BAR_HIDE_AFTER = 40; // px seguidos hacia abajo para ocultar
const BAR_SHOW_AFTER = 20; // px seguidos hacia arriba para mostrar
let barLastTop = 0;
let barRun = 0; // >0 bajando, <0 subiendo

function setLibBarHidden(hidden) {
  $('tab-library').querySelector('.lib-bar').classList.toggle('bar-hidden', hidden);
  $('lib-nav').classList.toggle('bar-hidden', hidden);
  updateMiniOffset();
}

// El mini reproductor sube por encima de la barra de secciones cuando esta se ve
function updateMiniOffset() {
  const nav = $('lib-nav');
  const on = $('tab-library').classList.contains('active') && !nav.classList.contains('bar-hidden');
  if (on) document.body.style.setProperty('--lib-nav-h', nav.offsetHeight + 'px');
  document.body.classList.toggle('lib-nav-on', on);
}
window.addEventListener('resize', updateMiniOffset);

function onLibScroll() {
  const panel = $('tab-library');
  const top = panel.scrollTop;
  const delta = top - barLastTop;
  barLastTop = top;
  if (!delta) return;
  const bar = panel.querySelector('.lib-bar');
  // Cerca del principio, o escribiendo en el buscador: siempre visible
  if (top < bar.offsetHeight || document.activeElement === $('search-input')) {
    barRun = 0;
    return setLibBarHidden(false);
  }
  barRun = Math.sign(delta) === Math.sign(barRun) ? barRun + delta : delta;
  if (barRun > BAR_HIDE_AFTER) setLibBarHidden(true);
  else if (barRun < -BAR_SHOW_AFTER) setLibBarHidden(false);
}
$('tab-library').addEventListener('scroll', onLibScroll, { passive: true });
$('search-input').addEventListener('focus', () => setLibBarHidden(false));

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = async () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
    updateMiniOffset();
    try {
      if (tab.dataset.tab === 'library' && !lib.loaded) {
        await loadLibraries();
        await showLibrary();
      }
      if (tab.dataset.tab === 'continue') loadHome();
    } catch (e) {
      if (!(e instanceof RelinkError)) toast(t('err.library'));
    }
  };
});
$('library-more').onclick = () => loadLibraryPage(false).catch(() => toast(t('err.more')));

// ---------- Reproductor ----------
const P = {
  itemId: null,
  sessionId: null,
  tracks: [],
  trackIdx: 0,
  chapters: [],
  duration: 0,
  title: '',
  author: '',
  listened: 0, // segundos reales escuchados desde la última sincronización
  lastTick: 0,
  lastSync: 0,
  syncing: false,
};

function currentTime() {
  const t = P.tracks[P.trackIdx];
  return t ? t.startOffset + (audio.currentTime || 0) : 0;
}

function chapterIndexAt(t) {
  const c = P.chapters;
  for (let i = c.length - 1; i >= 0; i--) if (t >= c[i].start - 0.5) return i;
  return 0;
}

function trackUrl(contentUrl) {
  const u = new URL(contentUrl, location.origin); // por si Audiobookshelf devuelve URL absoluta
  return ABS + u.pathname + u.search;
}

// Spinner en el botón de play mientras se espera al servidor (abrir libro, cargar pista, buffering)
function setLoading(on) {
  document.body.classList.toggle('loading', on);
  $('c-play').setAttribute('aria-busy', on ? 'true' : 'false');
}

function loadTrack(idx, offset, autoplay) {
  P.trackIdx = idx;
  setLoading(true);
  audio.src = trackUrl(P.tracks[idx].contentUrl);
  audio.addEventListener('loadedmetadata', function once() {
    audio.removeEventListener('loadedmetadata', once);
    audio.currentTime = Math.max(0, offset);
    if (autoplay) play(); // el spinner sigue hasta que suene de verdad ('playing')
    else setLoading(false);
  });
  audio.load();
}

function seekTo(t) {
  t = Math.max(0, Math.min(t, P.duration - 0.5));
  const idx = P.tracks.findIndex((tr) => t >= tr.startOffset && t < tr.startOffset + tr.duration);
  const target = idx === -1 ? P.tracks.length - 1 : idx;
  if (target === P.trackIdx && audio.readyState > 0) audio.currentTime = t - P.tracks[target].startOffset;
  else loadTrack(target, t - P.tracks[target].startOffset, !audio.paused);
  savePosLocal(t, true);
  render();
}

function play() {
  audio.play().catch(() => {
    setLoading(false);
    toast(t('tapToPlay'));
  });
}

// Posición local del libro: { t, pending, synced }
//   pending → hay escucha sin subir al servidor (p. ej. sin cobertura)
//   synced  → última posición que el servidor confirmó para este coche
// Comparando `synced` con lo que dice el servidor sabemos si OTRO dispositivo movió el libro,
// sin depender de que el reloj del coche y el del servidor coincidan.
function savePosLocal(t, pending) {
  if (!P.itemId) return;
  const prev = store('pos:' + P.itemId) || {};
  store('pos:' + P.itemId, { t, pending, synced: pending ? prev.synced : t, ts: Date.now() });
}

const MOVED_ELSEWHERE_S = 3; // diferencia a partir de la cual consideramos que el progreso cambió en otro dispositivo

// ¿Usar la posición local pendiente en vez de la del servidor?
// Solo si el servidor sigue donde lo dejamos nosotros (nadie más lo ha movido).
function preferLocalPosition(local, serverTime) {
  return !!(local?.pending && typeof local.t === 'number' && typeof local.synced === 'number'
    && Math.abs((serverTime || 0) - local.synced) < MOVED_ELSEWHERE_S);
}

// Con el libro ya cargado y en pausa: si en otro dispositivo se ha avanzado, ir a esa posición
async function adoptServerProgress() {
  if (!P.itemId || !P.sessionId || !audio.paused) return;
  const itemId = P.itemId;
  let mp;
  try {
    mp = await api(`/api/me/progress/${itemId}`);
  } catch {
    return; // sin progreso en el servidor o sin conexión: seguimos con lo local
  }
  if (P.itemId !== itemId || !audio.paused || typeof mp?.currentTime !== 'number') return;
  const local = store('pos:' + itemId);
  if (preferLocalPosition(local, mp.currentTime)) return;
  if (Math.abs(mp.currentTime - currentTime()) < MOVED_ELSEWHERE_S) return;
  seekTo(mp.currentTime);
  savePosLocal(mp.currentTime, false);
}

// Fondo difuminado del reproductor: se muestra con un fundido cuando la imagen ya ha cargado
function setPlayerBackground(itemId) {
  const bg = $('p-bg');
  bg.classList.remove('ready');
  const url = `${ABS}/api/items/${itemId}/cover?width=200`;
  const img = new Image();
  img.onload = () => {
    if (P.itemId !== itemId) return; // se cambió de libro mientras cargaba
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.add('ready');
  };
  img.src = url;
}

async function openItem(itemId, hint = {}) {
  if (P.itemId === itemId && P.sessionId) {
    show('player');
    if (audio.paused) {
      await adoptServerProgress();
      play();
    }
    return;
  }
  await closeSession();

  P.itemId = itemId;
  P.title = hint.title || '';
  P.author = hint.author || '';
  $('p-cover').src = $('p-thumb').src = coverUrl(itemId);
  setPlayerBackground(itemId);
  $('p-title').textContent = P.title;
  $('p-author').textContent = P.author;
  setChapterLabel('');
  show('player');
  setLoading(true); // hasta que responda el servidor y el audio esté listo

  try {
    await startSession(true);
  } catch (e) {
    setLoading(false);
    if (e instanceof RelinkError) return;
    toast(t('err.openBook'));
    P.itemId = null;
    show('home');
  }
}

async function startSession(autoplay) {
  const s = await api(`/api/items/${P.itemId}/play`, {
    method: 'POST',
    body: {
      forceDirectPlay: true,
      forceTranscode: false,
      mediaPlayer: 'html5',
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/x-m4b', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/wav'],
    },
  });
  P.sessionId = s.id;
  P.tracks = (s.audioTracks || []).slice().sort((a, b) => a.index - b.index);
  P.chapters = s.chapters || [];
  P.duration = s.duration || P.tracks.reduce((sum, t) => sum + t.duration, 0);
  P.title = s.displayTitle || P.title;
  P.author = s.displayAuthor || P.author;
  P.listened = 0;
  P.lastSync = Date.now();
  if (!P.tracks.length) throw new Error('sin pistas');

  // Posición del servidor, salvo que tengamos escucha local sin subir y nadie más haya movido el libro
  let start = s.currentTime || 0;
  const local = store('pos:' + P.itemId);
  if (preferLocalPosition(local, s.currentTime)) start = local.t;
  savePosLocal(start, preferLocalPosition(local, s.currentTime)); // punto de partida conocido
  if (start >= P.duration - 5) start = 0; // libro terminado: empezar de nuevo

  $('p-title').textContent = P.title;
  $('p-author').textContent = P.author;
  renderChapters();
  setupMediaSession();

  const idx = Math.max(0, P.tracks.findIndex((t) => start >= t.startOffset && start < t.startOffset + t.duration));
  loadTrack(idx, start - P.tracks[idx].startOffset, autoplay);
  setSpeed(store('speed') || 1);
}

// ---------- Indicador de sincronización ----------
const SYNC_FAIL_DEFAULT = 4;
let syncFailures = 0;
let syncStatusTimer;

function syncFailThreshold() {
  const n = Math.round(Number(store('syncFailThreshold')));
  return n >= 1 && n <= 60 ? n : SYNC_FAIL_DEFAULT;
}

function setSyncFailThreshold(n) {
  n = Math.min(60, Math.max(1, Math.round(n)));
  store('syncFailThreshold', n);
  $('fail-value').textContent = n;
  // Si ya llevamos más fallos que el nuevo límite, avisar ya
  if (syncFailures >= n) showSyncStatus('fail');
}

function showSyncStatus(kind) {
  const el = $('sync-status');
  clearTimeout(syncStatusTimer);
  el.classList.remove('ok', 'fail', 'fading');
  el.classList.add(kind);
  el.hidden = false;
  if (kind === 'ok') {
    const now = new Date();
    $('sync-text').textContent = t('sync.ok', { time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
    // Visible 1 s y se desvanece
    syncStatusTimer = setTimeout(() => {
      el.classList.add('fading');
      syncStatusTimer = setTimeout(() => (el.hidden = true), 250);
    }, 1000);
  } else {
    $('sync-text').textContent = t('sync.fail'); // se queda hasta que vuelva a funcionar
  }
}

function syncSucceeded() {
  syncFailures = 0;
  showSyncStatus('ok');
}

function syncFailed() {
  syncFailures++;
  if (syncFailures >= syncFailThreshold()) showSyncStatus('fail');
}

async function syncNow() {
  if (!P.sessionId || P.syncing) return;
  const t = currentTime();
  const listened = Math.round(P.listened);
  P.syncing = true;
  P.lastSync = Date.now(); // el siguiente intento periódico será dentro de 15 s, falle o no
  try {
    await api(`/api/session/${P.sessionId}/sync`, {
      method: 'POST',
      body: { currentTime: t, timeListened: listened, duration: P.duration },
    });
    P.listened = Math.max(0, P.listened - listened);
    P.lastSync = Date.now();
    savePosLocal(t, false);
    flushBookmarks();
    syncSucceeded();
  } catch (e) {
    savePosLocal(t, true);
    if (!(e instanceof RelinkError)) syncFailed();
    // Sesión perdida en el servidor (reinicio, caducidad): abrir otra y seguir.
    if (e.status === 404) {
      try {
        const wasPlaying = !audio.paused;
        savePosLocal(t, true); // conserva la última posición confirmada por el servidor
        await startSession(wasPlaying);
      } catch {}
    }
  } finally {
    P.syncing = false;
  }
}

// Último envío al salir del navegador. Solo si hay algo nuevo que subir: si estamos en pausa y el
// servidor ya tiene nuestra posición, no enviamos nada para no pisar lo avanzado en otro dispositivo.
function syncBeacon() {
  if (!P.sessionId) return;
  const t = currentTime();
  const local = store('pos:' + P.itemId) || {};
  const nothingNew = audio.paused && P.listened < 1 && typeof local.synced === 'number' && Math.abs(t - local.synced) < 1;
  if (nothingNew) return;
  savePosLocal(t, true);
  const body = JSON.stringify({ currentTime: t, timeListened: Math.round(P.listened), duration: P.duration });
  if (navigator.sendBeacon(`${ABS}/api/session/${P.sessionId}/sync`, new Blob([body], { type: 'application/json' }))) {
    P.listened = 0;
  }
}

async function closeSession() {
  if (!P.sessionId) return;
  audio.pause();
  await syncNow();
  const id = P.sessionId;
  P.sessionId = null;
  api(`/api/session/${id}/close`, { method: 'POST' }).catch(() => {});
}

// Barra de progreso del capítulo (con el nombre del capítulo dentro)
function setSeekFill(frac) {
  const pct = Math.min(1, Math.max(0, frac)) * 100;
  $('p-seek-fill').style.clipPath = `inset(0 ${(100 - pct).toFixed(2)}% 0 0)`;
}

const TICKER_SPEED = 35; // px por segundo: ritmo tranquilo

function setChapterLabel(text) {
  P.chapterLabel = text;
  updateTicker();
}

// Si el nombre del capítulo no cabe en la barra, lo convierte en un ticker.
function updateTicker() {
  const track = document.querySelector('.seek-track');
  const labels = document.querySelectorAll('.chapter-text');
  const text = P.chapterLabel || '';
  const fill = (el, copies) => {
    el.replaceChildren(...Array.from({ length: copies }, (_, i) => {
      const s = document.createElement('span');
      s.textContent = text;
      if (i) s.setAttribute('aria-hidden', 'true');
      return s;
    }));
  };

  track.classList.remove('ticking');
  labels.forEach((el) => fill(el, 1));
  const label = labels[0].parentElement;
  const pad = parseFloat(getComputedStyle(label).paddingLeft) * 2;
  if (!text || labels[0].scrollWidth <= label.clientWidth - pad) return;

  labels.forEach((el) => fill(el, 2));
  track.classList.add('ticking'); // las dos capas empiezan la animación a la vez
  const dist = labels[0].firstElementChild.offsetWidth; // texto + hueco
  track.style.setProperty('--ticker-dist', `-${dist}px`);
  track.style.setProperty('--ticker-dur', `${(dist / TICKER_SPEED / 0.82).toFixed(1)}s`);
}

if (window.ResizeObserver) {
  let lastWidth = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== lastWidth) {
      lastWidth = w;
      updateTicker();
    }
  }).observe(document.querySelector('.seek-track'));
}

// Pintar estado
function render() {
  if (!P.itemId) return;
  const pos = currentTime();
  const ci = chapterIndexAt(pos);
  const ch = P.chapters[ci];
  const start = ch ? ch.start : 0;
  const end = ch ? ch.end : P.duration;
  const len = Math.max(1, end - start);
  const rate = audio.playbackRate || 1;

  setSeekFill((pos - start) / len);
  $('p-elapsed').textContent = fmt(pos - start);
  $('p-remaining').textContent = '-' + fmt((end - pos) / rate);
  const bookPct = P.duration ? Math.min(100, Math.max(0, (pos / P.duration) * 100)) : 0;
  document.querySelectorAll('.book-progress').forEach((bp) => {
    bp.querySelector('.bp-fill').style.width = bookPct.toFixed(2) + '%';
    bp.querySelector('.bp-pct').textContent = Math.floor(bookPct) + '%';
    bp.querySelector('.bp-done').textContent = fmt(pos); // reproducido
    bp.querySelector('.bp-left').textContent = '-' + fmt((P.duration - pos) / rate); // lo que queda, a tu velocidad
  });

  const chTitle = ch ? `${ch.title || t('chapter.untitled', { n: ci + 1 })}  ·  ${t('chapter.position', { i: ci + 1, n: P.chapters.length })}` : '';
  if (P.chapterLabel !== chTitle) {
    setChapterLabel(chTitle);
    $('mini-chapter').textContent = ch ? ch.title : P.author;
    updateMediaMetadata(ch);
  }

  $('mini').hidden = false;
  $('mini-title').textContent = P.title;
  if ($('mini-cover').dataset.id !== P.itemId) {
    $('mini-cover').dataset.id = P.itemId;
    $('mini-cover').src = coverUrl(P.itemId);
  }
}

// Lista de capítulos:
// nº (✓ si ya está escuchado) · título · % del libro al acabar · duración a la velocidad actual

function renderChapters() {
  const list = $('chapter-list');
  list.replaceChildren(
    ...P.chapters.map((c, i) => {
      const row = document.createElement('button');
      row.className = 'chapter-row';
      row.dataset.i = i;
      row.innerHTML = '<span class="ch-num"></span><span class="ch-title"></span><span class="ch-pct"></span><span class="ch-dur"></span>';
      row.querySelector('.ch-title').textContent = c.title || t('chapter.untitled', { n: i + 1 });
      row.querySelector('.ch-pct').textContent = P.duration ? Math.round((c.end / P.duration) * 100) + '%' : '';
      row.onclick = () => {
        seekTo(c.start);
        $('sheet-chapters').hidden = true;
      };
      return row;
    }),
  );
  $('chapters-title').textContent = t('chapters.count', { n: P.chapters.length });
  $('c-chapters').hidden = P.chapters.length < 2;
}

function refreshChapterRows() {
  const t = currentTime();
  const ci = chapterIndexAt(t);
  const rate = audio.playbackRate || 1;
  $('chapter-list').querySelectorAll('.chapter-row').forEach((row) => {
    const i = Number(row.dataset.i);
    const c = P.chapters[i];
    const finished = i < ci;
    row.classList.toggle('current', i === ci);
    row.classList.toggle('finished', finished);
    const num = row.querySelector('.ch-num');
    if (finished) num.innerHTML = CHECK_ICON;
    else num.textContent = i + 1;
    row.querySelector('.ch-dur').textContent = fmt((c.end - c.start) / rate);
  });
}

// Eventos de audio
audio.addEventListener('play', () => {
  document.body.classList.add('playing');
  P.lastTick = Date.now();
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  document.body.classList.remove('playing');
  if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
  syncNow();
});
audio.addEventListener('timeupdate', render);
audio.addEventListener('ended', () => {
  if (P.trackIdx < P.tracks.length - 1) {
    loadTrack(P.trackIdx + 1, 0, true);
  } else {
    syncNow();
    toast(t('book.finished'));
  }
});
audio.addEventListener('waiting', () => setLoading(true)); // sin datos suficientes (buffering)
audio.addEventListener('playing', () => setLoading(false));
audio.addEventListener('pause', () => setLoading(false));
audio.addEventListener('error', () => {
  setLoading(false);
  if (P.itemId) toast(t('err.audio'));
});

// Tiempo real escuchado + sincronización periódica
setInterval(() => {
  const now = Date.now();
  if (!audio.paused && P.lastTick) P.listened += Math.min(5, (now - P.lastTick) / 1000);
  P.lastTick = now;
  if (!audio.paused && now - P.lastSync >= SYNC_EVERY_MS) syncNow();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return syncBeacon();
  // De vuelta al navegador: puede que se haya escuchado en otro dispositivo mientras tanto
  adoptServerProgress();
  if ($('view-home').classList.contains('active')) loadHome();
});
window.addEventListener('pagehide', syncBeacon);

// Controles
const LONG_PAUSE_MS = 60_000;
let pausedAt = 0;
audio.addEventListener('pause', () => (pausedAt = Date.now()));
$('c-play').onclick = async () => {
  if (!audio.paused) return audio.pause();
  if (pausedAt && Date.now() - pausedAt > LONG_PAUSE_MS) await adoptServerProgress();
  play();
};
$('c-back').onclick = () => seekTo(currentTime() - SKIP_BACK);
$('c-fwd').onclick = () => seekTo(currentTime() + SKIP_FWD);
$('c-prev').onclick = prevChapter;
$('c-next').onclick = nextChapter;

function prevChapter() {
  if (!P.chapters.length) return seekTo(0);
  const t = currentTime();
  const ci = chapterIndexAt(t);
  const ch = P.chapters[ci];
  seekTo(t - ch.start > 3 || ci === 0 ? ch.start : P.chapters[ci - 1].start);
}

function nextChapter() {
  const ci = chapterIndexAt(currentTime());
  if (ci < P.chapters.length - 1) seekTo(P.chapters[ci + 1].start);
}

// ---------- Marcadores ----------
// Se guardan en Audiobookshelf (los ven sus apps y la web). Sin pedir nombre: vamos conduciendo.
// Si no hay conexión, quedan pendientes y se suben en la siguiente sincronización.
function pendingBookmarks() {
  return store('pendingBookmarks') || [];
}

async function pushBookmark(b) {
  try {
    await api(`/api/me/item/${b.itemId}/bookmark`, { method: 'POST', body: { time: b.time, title: b.title } });
    return true;
  } catch (e) {
    // 4xx (p. ej. ya existe uno en ese segundo): no tiene sentido reintentar
    return e.status >= 400 && e.status < 500;
  }
}

async function flushBookmarks() {
  const pending = pendingBookmarks();
  if (!pending.length) return;
  const left = [];
  for (const b of pending) if (!(await pushBookmark(b))) left.push(b);
  store('pendingBookmarks', left.length ? left : null);
}

$('c-bookmark').onclick = async () => {
  if (!P.itemId || !P.tracks.length) return;
  const b = { itemId: P.itemId, time: Math.floor(currentTime()), title: t('bookmark.title', { name: me?.name || t('link.defaultName') }) };
  const btn = $('c-bookmark');
  btn.classList.add('saved');
  setTimeout(() => btn.classList.remove('saved'), 1200);
  if (await pushBookmark(b)) {
    toast(t('bookmark.added', { time: fmt(b.time) }));
  } else {
    store('pendingBookmarks', [...pendingBookmarks(), b]);
    toast(t('bookmark.offline'));
  }
};

// ---------- Velocidad ----------
const roundSpeed = (r) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(r * 20) / 20));
const sameSpeed = (a, b) => Math.abs(a - b) < 0.001;

function speedPresets() {
  const saved = store('speedPresets');
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_SPEEDS.slice();
}

function saveSpeedPresets(list) {
  store('speedPresets', [...new Set(list.map(roundSpeed))].sort((a, b) => a - b));
  renderSpeedChips();
}

function setSpeed(r) {
  r = roundSpeed(r);
  audio.playbackRate = r;
  store('speed', r);
  $('c-speed').textContent = speedLabel(r);
  $('speed-value').textContent = speedLabel(r);
  const slider = $('speed-slider');
  slider.value = r;
  slider.style.setProperty('--fill', ((r - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100 + '%');
  $('speed-chips').querySelectorAll('.speed-chip[data-speed]').forEach((c) => c.classList.toggle('active', sameSpeed(+c.dataset.speed, r)));
  render();
}

function renderSpeedChips() {
  const presets = speedPresets();
  const chips = presets.map((s) => {
    const b = document.createElement('button');
    b.className = 'speed-chip';
    b.dataset.speed = s;
    b.innerHTML = '<span></span>';
    b.firstChild.textContent = speedLabel(s);
    b.classList.toggle('active', sameSpeed(s, audio.playbackRate));
    onPressOrHold(b, () => setSpeed(s), presets.length > 1 ? () => {
      saveSpeedPresets(speedPresets().filter((p) => !sameSpeed(p, s)));
      toast(t('speed.removed', { s: speedLabel(s) }));
    } : null);
    return b;
  });
  const add = document.createElement('button');
  add.className = 'speed-chip add';
  add.setAttribute('aria-label', t('aria.saveSpeed'));
  add.innerHTML = '<span>+</span>';
  add.onclick = () => {
    const r = roundSpeed(audio.playbackRate);
    if (speedPresets().some((p) => sameSpeed(p, r))) return toast(t('speed.exists', { s: speedLabel(r) }));
    saveSpeedPresets([...speedPresets(), r]);
    toast(t('speed.saved', { s: speedLabel(r) }));
  };
  $('speed-chips').replaceChildren(...chips, add);
}

// Toque = acción normal; mantener pulsado = acción larga (con relleno rojo de aviso)
function onPressOrHold(el, onPress, onHold) {
  let timer = null;
  let held = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    el.classList.remove('holding');
  };
  el.style.setProperty('--hold-ms', LONG_PRESS_MS + 'ms');
  el.addEventListener('pointerdown', () => {
    held = false;
    if (!onHold) return;
    el.classList.add('holding');
    timer = setTimeout(() => {
      held = true;
      cancel();
      onHold();
    }, LONG_PRESS_MS);
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    if (!held) onPress();
    held = false;
  });
}

$('c-speed').onclick = () => {
  renderSpeedChips();
  setSpeed(audio.playbackRate);
  $('sheet-speed').hidden = false;
};
$('speed-slider').addEventListener('input', (e) => setSpeed(+e.target.value));
$('speed-minus').onclick = () => setSpeed(audio.playbackRate - 0.05);
$('speed-plus').onclick = () => setSpeed(audio.playbackRate + 0.05);

// Barra de progreso del capítulo: toca o arrastra
(function setupSeekBar() {
  const bar = $('p-seek');
  let dragging = false;
  const toTime = (x) => {
    const r = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (x - r.left) / r.width));
    const ch = P.chapters[chapterIndexAt(currentTime())];
    const start = ch ? ch.start : 0;
    const end = ch ? ch.end : P.duration;
    return start + frac * (end - start);
  };
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    const r = bar.getBoundingClientRect();
    setSeekFill((e.clientX - r.left) / r.width);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = bar.getBoundingClientRect();
    setSeekFill((e.clientX - r.left) / r.width);
  });
  bar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    seekTo(toTime(e.clientX));
  });
})();

$('c-chapters').onclick = () => {
  refreshChapterRows();
  $('sheet-chapters').hidden = false;
  $('chapter-list').querySelector('.current')?.scrollIntoView({ block: 'center' });
};

// Miniatura cuadrada con el alto de título + autor + capítulo (pantallas estrechas)
if (window.ResizeObserver) {
  const thumb = document.querySelector('.p-thumb');
  new ResizeObserver(([entry]) => {
    thumb.style.width = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight) + 'px';
  }).observe(document.querySelector('.p-meta'));
}

// Botones de velocidad/marcador/capítulos: bajo la carátula en pantalla ancha,
// bajo los controles en pantalla estrecha (mismo punto de corte que el CSS).
(function placePlayerFoot() {
  const narrow = window.matchMedia('(max-width: 1100px)');
  const foot = document.querySelector('.player-foot');
  const place = () => (narrow.matches ? document.querySelector('.player-main') : document.querySelector('.player-side')).append(foot);
  place();
  narrow.addEventListener ? narrow.addEventListener('change', place) : narrow.addListener(place);
})();

$('p-back').onclick = () => {
  show('home');
  loadHome();
};
$('mini').onclick = () => show('player');

// Media Session (pantalla del sistema / botones del volante, si el coche los pasa al navegador)
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => play(),
    pause: () => audio.pause(),
    seekbackward: () => seekTo(currentTime() - SKIP_BACK),
    seekforward: () => seekTo(currentTime() + SKIP_FWD),
    previoustrack: prevChapter,
    nexttrack: nextChapter,
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch {}
  }
  updateMediaMetadata(P.chapters[0]);
}

function updateMediaMetadata(ch) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ch?.title || P.title,
    artist: P.author,
    album: P.title,
    artwork: [{ src: new URL(coverUrl(P.itemId), location.href).href, sizes: '600x600', type: 'image/jpeg' }],
  });
}

// ---------- Ajustes ----------
$('btn-settings').onclick = () => {
  $('settings-info').textContent = t('settings.info', { name: me?.name || t('link.defaultName'), user: me?.username || '?' });
  $('fail-value').textContent = syncFailThreshold();
  $('sheet-settings').hidden = false;
};
// ---------- Tema: auto (sigue al coche) | light | dark ----------
function currentTheme() {
  const t = store('theme');
  return ['auto', 'light', 'dark'].includes(t) ? t : 'auto';
}

function applyTheme() {
  const mode = currentTheme();
  document.documentElement.dataset.theme = mode;
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.classList.toggle('active', b.dataset.themeOpt === mode));
  // Color de la barra del navegador, según el tema efectivo
  const light = mode === 'light' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f2f2f5' : '#0b0b0d');
}

document.querySelectorAll('[data-theme-opt]').forEach((b) => {
  b.onclick = () => {
    store('theme', b.dataset.themeOpt);
    applyTheme();
  };
});
{
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener ? mq.addEventListener('change', applyTheme) : mq.addListener(applyTheme);
}
applyTheme();

// Diagnóstico: ¿el navegador del coche expone el tema claro/oscuro? (prefers-color-scheme)
(function themeDiagnostic() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const light = window.matchMedia('(prefers-color-scheme: light)');
  const log = []; // [{ time, state }]; el texto se traduce al pintar
  const current = () => (dark.matches ? 'dark' : light.matches ? 'light' : 'none');
  const label = (state) => t(state === 'none' ? 'diag.none' : `theme.${state}`);
  const hhmm = () => new Date().toTimeString().slice(0, 5);
  const paint = () => {
    $('diag-theme').textContent = label(current());
    $('diag-theme-log').textContent = log.length
      ? `${t('diag.changes')} ${log.map((e) => `${e.time} → ${label(e.state)}`).join(' · ')}`
      : t('diag.noChanges');
  };
  let last = current();
  const onChange = () => {
    if (current() === last) return; // los dos media queries avisan del mismo cambio
    last = current();
    log.push({ time: hhmm(), state: last });
    if (log.length > 5) log.shift();
    paint();
  };
  document.addEventListener('langchange', paint);
  for (const mq of [dark, light]) mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
  $('diag-ua').textContent = navigator.userAgent;
  paint();
})();

$('fail-minus').onclick = () => setSyncFailThreshold(syncFailThreshold() - 1);
$('fail-plus').onclick = () => setSyncFailThreshold(syncFailThreshold() + 1);
$('btn-reload').onclick = () => location.reload();
$('btn-unlink').onclick = async () => {
  if (!confirm(t('unlink.confirm'))) return;
  await closeSession();
  await fetch(BASE + '/logout', { method: 'POST' });
  P.itemId = null;
  $('mini').hidden = true;
  $('sheet-settings').hidden = true;
  startPairing();
};
document.querySelectorAll('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) sheet.hidden = true;
  });
});

// ---------- Idioma ----------
(function setupLanguage() {
  // Dos selectores: en Ajustes y en la pantalla de vinculación (Ajustes no es accesible sin vincular)
  const selects = [$('lang-select'), $('pair-lang')];
  for (const select of selects) {
    select.replaceChildren(...Object.entries(LANGS).map(([code, name]) => new Option(name, code)));
    select.value = getLang();
    select.onchange = () => setLang(select.value);
  }

  // Al cambiar de idioma, repintar lo que se genera desde JS
  document.addEventListener('langchange', () => {
    selects.forEach((s) => (s.value = getLang()));
    const qr = $('pair-qr');
    if (qr.src) qr.src = qr.src.replace(/lang=\w+/, `lang=${getLang()}`);
    if (P.chapters.length) {
      renderChapters();
      refreshChapterRows();
    }
    document.querySelectorAll('.finished-tag > span').forEach((el) => (el.textContent = t('book.finishedTag')));
    if (lib.loaded && lib.mode === 'authors' && lib.current) {
      if (lib.author) {
        $('detail-back').textContent = '‹ ' + t('mode.authors');
        renderAuthorSections();
      } else if (lib.authorsByLib[lib.current.id]) renderAuthors();
    }
    if (lib.loaded && lib.mode === 'series' && lib.current) {
      if (lib.series) {
        $('detail-back').textContent = '‹ ' + t('mode.series');
        renderSeriesDetail();
      } else if (lib.seriesByLib[lib.current.id]) renderSeriesList();
    }
    if (lib.loaded && lib.mode === 'narrators' && lib.current) {
      if (lib.narrator) {
        $('detail-back').textContent = '‹ ' + t('mode.narrators');
        $('detail-count').textContent = countLabel($('detail-sections').querySelectorAll('.card').length);
      } else if (lib.narratorsByLib[lib.current.id]) renderNarrators();
    }
    P.chapterLabel = null;
    render();
    if (!$('sheet-settings').hidden) {
      $('settings-info').textContent = t('settings.info', { name: me?.name || t('link.defaultName'), user: me?.username || '?' });
    }
    if (!$('sync-status').hidden) $('sync-text').textContent = t($('sync-status').classList.contains('fail') ? 'sync.fail' : 'sync.ok', { time: new Date().toTimeString().slice(0, 5) });
  });
})();

applyI18n();
init();
