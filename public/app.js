'use strict';

const BASE = window.BASE || '';
const ABS = BASE + '/abs';
const SKIP_OPTIONS = [10, 15, 30, 60];
const SKIP_DEFAULTS = { back: 15, fwd: 30 };
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

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const coverUrl = (id) => `${ABS}/api/items/${id}/cover?width=600`;
const metaOf = (item) => item?.media?.metadata || {};
const authorOf = (item) => {
  const m = metaOf(item);
  return m.authorName || (m.authors || []).map((a) => a.name).join(', ');
};

class RelinkError extends Error {}

async function api(path, { method = 'GET', body, onResponse } = {}) {
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
  onResponse?.(res);
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

// ---------- Datos consumidos (bytes reales que el servidor ha enviado a este coche) ----------
function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  const num = i < 2 ? Math.round(n) : Math.round(n * 10) / 10; // B y KB enteros; MB y GB con un decimal
  return `${num.toLocaleString(getLang())} ${units[i]}`;
}

async function renderSettingsUsage() {
  let u = { today: 0, month: 0, total: 0 };
  try {
    const d = await (await fetch(BASE + '/me')).json();
    if (d.usage) u = d.usage;
  } catch {}
  $('s-usage').innerHTML = [['usage.today', u.today], ['usage.month', u.month], ['usage.total', u.total]]
    .map(([k, n]) => `<span>${escapeHtml(t(k))}</span><b>${escapeHtml(fmtBytes(n))}</b>`).join('');
}

// ---------- Audio descargado por adelantado (dato real del reproductor del navegador) ----------
const showBuffer = () => store('bufferShow') !== false; // visible por defecto
let bufferPaintedAt = 0;

// Segundos de escucha ya descargados por delante (a la velocidad actual), dentro de la pista actual.
// Con MP4/M4B el navegador informa a veces de lo descargado en tramos separados por huecos de pocos
// segundos justo delante de la posición: se tratan como continuos.
const BUFFER_GAP_S = 30;
function bufferedAhead() {
  const now = audio.currentTime, b = audio.buffered;
  let end = -1;
  for (let i = 0; i < b.length; i++) {
    if (end < 0) {
      if (b.start(i) <= now + 0.5 && now <= b.end(i)) end = b.end(i);
    } else if (b.start(i) - end <= BUFFER_GAP_S) end = Math.max(end, b.end(i));
    else break;
  }
  return end < 0 ? 0 : (end - now) / (audio.playbackRate || 1);
}

// Franja más clara en la barra del capítulo: desde el inicio hasta donde llega lo ya descargado
function paintBuffer(force) {
  if (!force && Date.now() - bufferPaintedAt < 1000) return; // como mucho una vez por segundo
  bufferPaintedAt = Date.now();
  const el = $('p-seek-buffer');
  const ch = P.chapters.length ? P.chapters[chapterIndexAt(currentTime())] : null;
  if (!showBuffer() || !P.itemId || audio.readyState === 0) return void (el.style.width = '0');
  const start = ch ? ch.start : 0, end = ch ? ch.end : P.duration;
  const loadedTo = currentTime() + bufferedAhead() * (audio.playbackRate || 1); // en tiempo del libro
  const frac = Math.min(1, Math.max(0, (loadedTo - start) / (end - start || 1)));
  el.style.width = (frac * 100).toFixed(2) + '%';
}

function renderBufferPicker() {
  document.querySelectorAll('[data-buffer-show]').forEach((b) => b.classList.toggle('active', (b.dataset.bufferShow === 'on') === showBuffer()));
}

// ---------- Datos de escucha del libro en «Continuar» ----------
const showHeroStats = () => store('heroStats') !== false; // visible por defecto
const STAT_ICONS = {
  started: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V10h14v10Z',
  sessions: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9Z',
  listened: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.5 5v5.25l4.5 2.67-.75 1.23L11 13V7h1.5Z',
};
let heroStats = { id: null, data: null };

function fmtDay(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return t('stats.today');
  if (diff === 1) return t('stats.yesterday');
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return d.toLocaleDateString(getLang(), opts).replace('.', '');
}

function fmtListened(sec) {
  const min = Math.floor(sec / 60);
  if (min < 1) return '< 1 min';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

function paintHeroStats() {
  const el = $('hero-stats');
  const { id, data } = heroStats;
  const startedAt = progressById[id]?.startedAt || data?.firstStartedAt;
  const parts = [];
  const bold = (v) => `<b>${escapeHtml(v)}</b>`;
  if (startedAt) parts.push(['started', t('stats.started', { date: bold(fmtDay(startedAt)) })]);
  if (data?.sessions) parts.push(['sessions', t(data.sessions === 1 ? 'stats.sessions.one' : 'stats.sessions', { n: bold(String(data.sessions)) })]);
  if (data?.listened >= 60) parts.push(['listened', t('stats.listened', { time: bold(fmtListened(data.listened)) })]);
  el.innerHTML = parts.map(([k, html]) => `<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAT_ICONS[k]}"/></svg>${html}</span>`).join('');
  el.hidden = !showHeroStats() || !parts.length;
}

async function renderHeroStats(id) {
  if (heroStats.id !== id) heroStats = { id, data: null };
  paintHeroStats(); // la fecha de inicio ya viene con el progreso; sesiones y tiempo llegan después
  if (!showHeroStats()) return;
  try {
    const res = await fetch(`${BASE}/stats/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (heroStats.id !== id) return; // cambió el libro mientras tanto
    heroStats.data = data;
    paintHeroStats();
  } catch {}
}

function renderHeroStatsPicker() {
  document.querySelectorAll('[data-hero-stats]').forEach((b) => b.classList.toggle('active', (b.dataset.heroStats === 'on') === showHeroStats()));
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
      renderHeroStats(first.id);
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

// Precarga del siguiente archivo (libros en varios archivos): unos 30 s antes de que acabe el actual,
// un reproductor oculto empieza a descargarlo. El navegador comparte lo descargado entre reproductores
// de la misma página, así que al cambiar de pista suena antes (menos tiempo con el spinner).
const PREFETCH_BEFORE_S = 30;
let prefetch = null; // { idx, el }

function prefetchNextTrack() {
  const next = P.trackIdx + 1;
  if (!P.tracks || next >= P.tracks.length || prefetch?.idx === next || audio.paused) return;
  const left = (audio.duration || P.tracks[P.trackIdx].duration) - audio.currentTime;
  if (!(left < PREFETCH_BEFORE_S)) return;
  dropPrefetch();
  const el = new Audio();
  el.preload = 'auto';
  el.muted = true;
  el.src = trackUrl(P.tracks[next].contentUrl);
  el.load();
  prefetch = { idx: next, el };
}

function dropPrefetch() {
  if (!prefetch) return;
  prefetch.el.removeAttribute('src');
  prefetch.el.load(); // libera la conexión
  prefetch = null;
}

function loadTrack(idx, offset, autoplay) {
  P.trackIdx = idx;
  setLoading(true);
  audio.src = trackUrl(P.tracks[idx].contentUrl);
  audio.addEventListener('loadedmetadata', function once() {
    audio.removeEventListener('loadedmetadata', once);
    audio.currentTime = Math.max(0, offset);
    audio.playbackRate = store('speed') || 1; // la velocidad elegida también en la pista nueva
    if (prefetch?.idx === idx) setTimeout(dropPrefetch, 5000); // ya la está usando el reproductor principal
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
  if (audio.paused) pausedAt = 0; // posición elegida a mano: no retroceder al reanudar
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
    if (audio.paused) await resume({ checkServer: true });
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

let lastSyncOk = 0; // hora de la última sincronización correcta (se muestra en Ajustes)
function syncSucceeded() {
  syncFailures = 0;
  lastSyncOk = Date.now();
  showSyncStatus('ok');
  if ($('view-settings').classList.contains('active')) renderLastSync();
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
  dropPrefetch();
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
audio.addEventListener('timeupdate', prefetchNextTrack);
audio.addEventListener('timeupdate', () => paintBuffer());
for (const ev of ['progress', 'seeked', 'pause', 'play', 'ratechange', 'loadedmetadata', 'emptied']) audio.addEventListener(ev, () => paintBuffer(true));
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

// ---------- Saltos y retroceso al reanudar ----------
function skipSeconds(dir) {
  const n = store('skip:' + dir);
  return SKIP_OPTIONS.includes(n) ? n : SKIP_DEFAULTS[dir];
}

function renderSkipButtons() {
  for (const dir of ['back', 'fwd']) {
    const n = skipSeconds(dir);
    const btn = $(dir === 'back' ? 'c-back' : 'c-fwd');
    btn.querySelector('.ctrl-num').textContent = n;
    btn.setAttribute('aria-label', t(dir === 'back' ? 'aria.back' : 'aria.fwd', { n }));
    document.querySelectorAll(`[data-skip-${dir}]`).forEach((b) => b.classList.toggle('active', Number(b.dataset[dir === 'back' ? 'skipBack' : 'skipFwd']) === n));
  }
}

const rewindOnResume = () => store('rewindOnResume') !== false; // activado por defecto

// Cuánto retroceder según lo que duró la pausa, para retomar el hilo
function rewindFor(pausedMs) {
  if (pausedMs < 10_000) return 0;
  if (pausedMs < 60_000) return 3;
  if (pausedMs < 10 * 60_000) return 10;
  if (pausedMs < 60 * 60_000) return 20;
  return 30;
}

// Reanudar tras una pausa: mira si se avanzó en otro dispositivo y retrocede unos segundos
async function resume({ checkServer = false } = {}) {
  if (!P.itemId) return;
  const pausedMs = pausedAt ? Date.now() - pausedAt : 0;
  pausedAt = 0;
  const before = currentTime();
  if (checkServer || pausedMs > LONG_PAUSE_MS) await adoptServerProgress();
  const back = rewindOnResume() ? rewindFor(pausedMs) : 0;
  // Si se ha saltado a la posición de otro dispositivo, no retroceder sobre ella
  if (back && Math.abs(currentTime() - before) < 1) seekTo(before - back);
  play();
}

// Controles
const LONG_PAUSE_MS = 60_000;
let pausedAt = 0;
audio.addEventListener('pause', () => (pausedAt = Date.now()));
$('c-play').onclick = () => (audio.paused ? resume() : audio.pause());
$('c-back').onclick = () => seekTo(currentTime() - skipSeconds('back'));
$('c-fwd').onclick = () => seekTo(currentTime() + skipSeconds('fwd'));
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
  audio.defaultPlaybackRate = r; // al cargar otro archivo (siguiente pista) el navegador vuelve a esta velocidad
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
    play: () => resume(),
    pause: () => audio.pause(),
    seekbackward: () => seekTo(currentTime() - skipSeconds('back')),
    seekforward: () => seekTo(currentTime() + skipSeconds('fwd')),
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

// ---------- Ubicación y registro de escuchas ----------
// Cada escucha continua es un «tramo» (play → pausa; una pausa corta en el mismo libro lo continúa).
// Se envía al servidor de ABS Car con la ruta (un punto cada ~30 s) si la ubicación está activada.
const geoAvailable = () => window.isSecureContext && 'geolocation' in navigator;
const geoEnabled = () => geoAvailable() && store('geoEnabled') === true;
const GEO_EVERY_MS = 30_000;
const SEGMENT_RESUME_MS = 3 * 60_000; // pausa más corta que esto en el mismo libro: mismo tramo
const SEGMENT_SEND_MS = 30_000;
const GEO = { watchId: null, last: null, error: null };
let seg = null; // tramo en curso: { id, itemId, title, author, startedAt, endedAt, startPos, endPos, listened, playingSince, points }
let segTimer = null;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

function startGeo() {
  if (!geoEnabled() || GEO.watchId !== null) return;
  GEO.watchId = navigator.geolocation.watchPosition(onGeoPosition, (e) => {
    GEO.error = e.code === e.PERMISSION_DENIED ? 'denied' : 'error';
    if ($('view-settings').classList.contains('active')) renderGeoSettings();
  }, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 60_000 });
}

function stopGeo() {
  if (GEO.watchId !== null) navigator.geolocation.clearWatch(GEO.watchId);
  GEO.watchId = null;
}

function onGeoPosition(pos) {
  GEO.error = null;
  GEO.last = { t: Date.now(), lat: +pos.coords.latitude.toFixed(5), lon: +pos.coords.longitude.toFixed(5), acc: Math.round(pos.coords.accuracy) };
  if (seg && !audio.paused) addSegPoint(false);
}

// Añade la última posición al tramo (como mucho una cada 30 s, salvo al empezar y al terminar)
function addSegPoint(force) {
  const p = GEO.last;
  if (!seg || !p || Date.now() - p.t > 60_000) return;
  const prev = seg.points[seg.points.length - 1] || seg.lastSent;
  if (!force && prev && p.t - prev.t < GEO_EVERY_MS) return;
  if (prev && prev.t === p.t) return;
  seg.points.push(p);
}

function segListened() {
  return Math.round(seg.listened + (seg.playingSince ? (Date.now() - seg.playingSince) / 1000 : 0));
}

function segPayload(final) {
  return {
    id: seg.id, itemId: seg.itemId, title: seg.title, author: seg.author, startedAt: seg.startedAt,
    endedAt: seg.playingSince ? Date.now() : seg.endedAt, startPos: seg.startPos, endPos: seg.endPos ?? currentTime(),
    listened: segListened(), points: seg.points, final, lang: getLang(),
  };
}

async function sendSegment(final) {
  if (!seg) return;
  const body = segPayload(final);
  const sent = body.points.length;
  try {
    const res = await fetch(BASE + '/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok && seg && seg.id === body.id) {
      if (sent) seg.lastSent = seg.points[sent - 1];
      seg.points.splice(0, sent); // los ya enviados; si falla, se reintentan en el siguiente envío
    }
  } catch {}
}

function onSegmentPlay() {
  if (!P.itemId) return;
  const now = Date.now();
  if (!(seg && seg.itemId === P.itemId && now - seg.endedAt < SEGMENT_RESUME_MS)) {
    seg = { id: newId(), itemId: P.itemId, title: P.title, author: P.author, startedAt: now, endedAt: now,
      startPos: currentTime(), endPos: null, listened: 0, playingSince: 0, points: [], lastSent: null };
  }
  seg.playingSince = now;
  seg.endPos = null;
  startGeo();
  addSegPoint(true);
  clearInterval(segTimer);
  segTimer = setInterval(() => {
    addSegPoint(false);
    sendSegment(false);
  }, SEGMENT_SEND_MS);
}

function onSegmentPause() {
  if (!seg || !seg.playingSince) return;
  seg.listened += (Date.now() - seg.playingSince) / 1000;
  seg.playingSince = 0;
  seg.endedAt = Date.now();
  seg.endPos = currentTime();
  clearInterval(segTimer);
  addSegPoint(true);
  stopGeo();
  sendSegment(true);
}

audio.addEventListener('play', onSegmentPlay);
audio.addEventListener('pause', onSegmentPause);
window.addEventListener('pagehide', () => {
  if (!seg) return;
  const body = JSON.stringify(segPayload(true));
  navigator.sendBeacon?.(BASE + '/log', new Blob([body], { type: 'application/json' }));
});

// Ajustes → Ubicación
function renderGeoSettings() {
  const secure = window.isSecureContext, supported = 'geolocation' in navigator;
  $('geo-insecure').hidden = secure;
  $('geo-unsupported').hidden = !secure || supported;
  const on = geoEnabled();
  document.querySelectorAll('[data-geo]').forEach((b) => {
    b.classList.toggle('active', (b.dataset.geo === 'on') === on);
    b.disabled = !geoAvailable();
  });
  let status = t('geo.off');
  if (!geoAvailable()) status = t('geo.unavailable');
  else if (GEO.error === 'denied') status = t('geo.denied');
  else if (on && GEO.last) status = t('geo.lastFix', { ago: Math.max(0, Math.round((Date.now() - GEO.last.t) / 1000)), acc: GEO.last.acc });
  else if (on) status = t('geo.waiting');
  $('geo-status').textContent = status;
}

document.querySelectorAll('[data-geo]').forEach((b) => {
  b.onclick = () => {
    if (!geoAvailable()) return;
    if (b.dataset.geo === 'off') {
      store('geoEnabled', false);
      stopGeo();
      return renderGeoSettings();
    }
    // Pedir permiso ya, con el usuario delante (el navegador muestra su aviso)
    navigator.geolocation.getCurrentPosition((pos) => {
      store('geoEnabled', true);
      onGeoPosition(pos);
      if (!audio.paused) startGeo();
      renderGeoSettings();
    }, (e) => {
      GEO.error = e.code === e.PERMISSION_DENIED ? 'denied' : 'error';
      store('geoEnabled', false);
      toast(t(e.code === e.PERMISSION_DENIED ? 'geo.denied' : 'geo.failed'));
      renderGeoSettings();
    }, { enableHighAccuracy: true, timeout: 20_000 });
  };
});

$('btn-log-clear').onclick = async () => {
  if (!confirm(t('geo.clearConfirm'))) return;
  try {
    const res = await fetch(BASE + '/log', { method: 'DELETE' });
    if (!res.ok) throw new Error();
    seg = null;
    toast(t('geo.cleared'));
  } catch {
    toast(t('err.generic'));
  }
};

// ---------- Estadísticas ----------
const stats = { from: 'home' };
const ROUTE_ICON = 'M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z';
const fmtKm = (m) => `${(m / 1000).toLocaleString(getLang(), { maximumFractionDigits: m < 10_000 ? 1 : 0 })} km`;
const fmtKmh = (m, s) => (s > 0 ? `${Math.round((m / s) * 3.6)} km/h` : '—');
const fmtClock = (ms) => new Date(ms).toTimeString().slice(0, 5);

async function openStats() {
  stats.from = document.querySelector('.view.active')?.id.replace('view-', '') || 'home';
  $('st-back').textContent = '‹ ' + t('settings.back');
  $('st-geo-off').hidden = geoEnabled();
  $('st-tiles').replaceChildren(centerMsg(t('loading')));
  $('st-books').replaceChildren();
  $('st-log').replaceChildren();
  show('stats');
  if (seg) await sendSegment(false); // que el tramo en curso salga ya en la lista
  try {
    const res = await fetch(BASE + '/log?limit=60');
    if (!res.ok) throw new Error();
    renderStats(await res.json());
  } catch {
    $('st-tiles').replaceChildren(centerMsg(t('err.generic')));
  }
}

function renderStats({ totals, books, segments }) {
  const tile = (value, label) => `<div class="st-tile"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
  const total = totals.moving + totals.stopped;
  $('st-tiles').innerHTML = [
    tile(fmtKm(totals.distance), t('stats.km')),
    tile(fmtListened(totals.listened), t('stats.listenedTotal')),
    tile(fmtKmh(totals.distance, totals.moving), t('stats.avgSpeed')),
    tile(total ? `${Math.round((totals.stopped / total) * 100)} %` : '—', t('stats.stopped')),
  ].join('');

  const max = Math.max(1, ...books.map((b) => b.distance));
  $('st-books').innerHTML = books.length
    ? books.map((b) => `<div class="st-book"><span class="t">${escapeHtml(b.title)}</span><span class="v">${escapeHtml(fmtKm(b.distance))}</span>
        <div class="bar"><div class="bar-fill" style="width:${((b.distance / max) * 100).toFixed(1)}%"></div></div></div>`).join('')
    : `<p class="st-empty">${escapeHtml(t('stats.noKm'))}</p>`;

  const severalCars = new Set(segments.map((sg) => sg.car).filter(Boolean)).size > 1; // solo si hay más de un coche
  $('st-log').innerHTML = segments.length
    ? segments.map((sg) => {
        const meta = [`<b>${escapeHtml(fmtListened(sg.listened))}</b>`];
        if (sg.distance) meta.push(`<b>${escapeHtml(fmtKm(sg.distance))}</b>`, escapeHtml(fmtKmh(sg.distance, sg.moving)));
        if (sg.stopped >= 60) meta.push(escapeHtml(t('stats.stoppedFor', { time: fmtListened(sg.stopped) })));
        const route = sg.from || sg.to
          ? `<div class="route"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ROUTE_ICON}"/></svg>${escapeHtml(sg.from || '?')} → ${escapeHtml(sg.to || '?')}</div>`
          : '';
        return `<div class="st-seg"><div class="when">${escapeHtml(fmtDay(sg.startedAt))} · ${fmtClock(sg.startedAt)} → ${fmtClock(sg.endedAt)}${severalCars && sg.car ? ` · ${escapeHtml(sg.car)}` : ''}</div>
          <div class="book">${escapeHtml(sg.title || '—')}</div><div class="meta">${meta.join('<span>·</span>')}</div>${route}</div>`;
      }).join('')
    : `<p class="st-empty">${escapeHtml(t('stats.empty'))}</p>`;
}

$('btn-stats').onclick = openStats;
$('st-back').onclick = () => show(stats.from);

// ---------- Ajustes: página con secciones ----------
const SETTINGS_SECTIONS = ['playback', 'appearance', 'sync', 'location', 'car', 'about'];
const settingsNarrow = window.matchMedia('(max-width: 900px)'); // menú y sección en pantallas separadas
const settings = { from: 'home', open: false };

function currentSection() {
  const s = store('settingsSection');
  return SETTINGS_SECTIONS.includes(s) ? s : 'playback';
}

function openSettings() {
  settings.from = document.querySelector('.view.active')?.id.replace('view-', '') || 'home';
  // En pantalla estrecha se entra por la lista de secciones; en ancha, directo a la última usada
  settings.open = !settingsNarrow.matches;
  renderSettings();
  show('settings');
}

function selectSection(sec) {
  store('settingsSection', sec);
  settings.open = true;
  renderSettings();
  $('s-layout').querySelector('.s-panels').scrollTop = 0;
}

function renderSettings() {
  const sec = currentSection();
  document.querySelectorAll('.s-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  document.querySelectorAll('.s-panel').forEach((el) => (el.hidden = el.dataset.panel !== sec));
  const detail = settingsNarrow.matches && settings.open;
  $('s-layout').classList.toggle('narrow', settingsNarrow.matches);
  $('s-layout').classList.toggle('detail', detail);
  $('s-back').textContent = '‹ ' + t(detail ? 'settings.title' : 'settings.back');
  $('fail-value').textContent = syncFailThreshold();
  $('s-user').textContent = me?.username || '?';
  if (document.activeElement !== $('s-name')) $('s-name').value = me?.name || '';
  updateNameSave();
  renderLastSync();
  if (sec === 'sync') renderSettingsUsage();
  if (sec === 'location') renderGeoSettings();
}

function renderLastSync() {
  $('s-last-sync').textContent = lastSyncOk ? new Date(lastSyncOk).toTimeString().slice(0, 5) : t('settings.never');
}

function updateNameSave() {
  const v = $('s-name').value.trim();
  $('s-name-save').disabled = !v || v === me?.name;
}

$('btn-settings').onclick = openSettings;
$('s-back').onclick = () => {
  if (settingsNarrow.matches && settings.open) {
    settings.open = false;
    renderSettings();
  } else show(settings.from);
};
document.querySelectorAll('.s-nav-item').forEach((b) => (b.onclick = () => selectSection(b.dataset.sec)));
{
  const onResize = () => $('view-settings').classList.contains('active') && renderSettings();
  settingsNarrow.addEventListener ? settingsNarrow.addEventListener('change', onResize) : settingsNarrow.addListener(onResize);
}

// Nombre del coche: se guarda en el servidor (aparece en las sesiones y marcadores de Audiobookshelf)
$('s-name').addEventListener('input', updateNameSave);
$('s-name-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('s-name').value.trim();
  if (!name || name === me?.name) return;
  $('s-name-save').disabled = true;
  try {
    const res = await fetch(BASE + '/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (me) me.name = data.name;
    $('s-name').value = data.name;
    $('s-name').blur();
    toast(t('settings.saved'));
  } catch {
    toast(t('settings.saveError'));
  }
  updateNameSave();
};
// ---------- Tamaño de las carátulas (ancho mínimo de columna en las cuadrículas) ----------
const COVER_MIN = 170, COVER_MAX = 350, COVER_STEP = 20, COVER_DEFAULT = 230;

function coverSize() {
  const n = Number(store('coverSize'));
  return n >= COVER_MIN && n <= COVER_MAX ? n : COVER_DEFAULT;
}

function applyCoverSize() {
  const n = coverSize();
  document.documentElement.style.setProperty('--cover-min', n + 'px');
  // Letra de las tarjetas: crece y mengua con la carátula, algo amortiguada para que no quede ni diminuta ni enorme
  document.documentElement.style.setProperty('--cover-scale', (1 + (n / COVER_DEFAULT - 1) * 0.7).toFixed(3));
  $('cover-value').textContent = n;
  $('cover-minus').disabled = n <= COVER_MIN;
  $('cover-plus').disabled = n >= COVER_MAX;
  // Cuántas caben por fila en esta pantalla (cuadrícula con 28 px de margen lateral y de hueco)
  const perRow = Math.max(1, Math.floor((window.innerWidth - 56 + 28) / (n + 28)));
  $('s-cover-hint').textContent = t('settings.coverSizeHint', { n: perRow });
}

$('cover-minus').onclick = () => { store('coverSize', Math.max(COVER_MIN, coverSize() - COVER_STEP)); applyCoverSize(); };
$('cover-plus').onclick = () => { store('coverSize', Math.min(COVER_MAX, coverSize() + COVER_STEP)); applyCoverSize(); };
window.addEventListener('resize', applyCoverSize);
document.addEventListener('langchange', applyCoverSize);
applyCoverSize();

// ---------- Tema: auto (sigue al coche) | light | dark ----------
function currentTheme() {
  const t = store('theme');
  return ['auto', 'light', 'dark', 'black'].includes(t) ? t : 'auto';
}

function applyTheme() {
  const mode = currentTheme();
  document.documentElement.dataset.theme = mode;
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.classList.toggle('active', b.dataset.themeOpt === mode));
  // Color de la barra del navegador, según el tema efectivo
  const light = mode === 'light' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f2f2f5' : mode === 'black' ? '#000000' : '#0b0b0d');
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

// Fondo del reproductor: carátula difuminada (por defecto) o liso, del color del tema
const playerBgPlain = () => store('playerBg') === 'plain';
function applyPlayerBg() {
  document.body.classList.toggle('plain-bg', playerBgPlain());
  document.querySelectorAll('[data-player-bg]').forEach((b) => b.classList.toggle('active', (b.dataset.playerBg === 'plain') === playerBgPlain()));
}
document.querySelectorAll('[data-player-bg]').forEach((b) => {
  b.onclick = () => {
    store('playerBg', b.dataset.playerBg);
    applyPlayerBg();
  };
});
applyPlayerBg();

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

document.querySelectorAll('[data-skip-back], [data-skip-fwd]').forEach((b) => {
  b.onclick = () => {
    const dir = 'skipBack' in b.dataset ? 'back' : 'fwd';
    store('skip:' + dir, Number(b.dataset[dir === 'back' ? 'skipBack' : 'skipFwd']));
    renderSkipButtons();
  };
});
function renderRewindPicker() {
  document.querySelectorAll('[data-rewind]').forEach((b) => b.classList.toggle('active', (b.dataset.rewind === 'on') === rewindOnResume()));
}
document.querySelectorAll('[data-rewind]').forEach((b) => {
  b.onclick = () => {
    store('rewindOnResume', b.dataset.rewind === 'on');
    renderRewindPicker();
  };
});
document.querySelectorAll('[data-hero-stats]').forEach((b) => {
  b.onclick = () => {
    store('heroStats', b.dataset.heroStats === 'on');
    renderHeroStatsPicker();
    if (heroStats.id) renderHeroStats(heroStats.id);
  };
});
document.querySelectorAll('[data-buffer-show]').forEach((b) => {
  b.onclick = () => {
    store('bufferShow', b.dataset.bufferShow === 'on');
    renderBufferPicker();
    paintBuffer(true);
  };
});
renderBufferPicker();
renderHeroStatsPicker();
renderSkipButtons();
renderRewindPicker();
document.addEventListener('langchange', renderSkipButtons);

$('fail-minus').onclick = () => setSyncFailThreshold(syncFailThreshold() - 1);
$('fail-plus').onclick = () => setSyncFailThreshold(syncFailThreshold() + 1);
$('btn-reload').onclick = () => location.reload();
$('btn-unlink').onclick = async () => {
  if (!confirm(t('unlink.confirm'))) return;
  await closeSession();
  await fetch(BASE + '/logout', { method: 'POST' });
  P.itemId = null;
  $('mini').hidden = true;
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
    if ($('view-settings').classList.contains('active')) renderSettings();
    if (heroStats.id) paintHeroStats();
    if (!$('sync-status').hidden) $('sync-text').textContent = t($('sync-status').classList.contains('fail') ? 'sync.fail' : 'sync.ok', { time: new Date().toTimeString().slice(0, 5) });
  });
})();

applyI18n();
init();
