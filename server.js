// ABS Car — servidor único: web del coche, vinculación por código y proxy a Audiobookshelf.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuración ----------
const PORT = Number(process.env.PORT || 3000);
const ABS_URL = (process.env.ABS_URL || 'http://audiobookshelf:80').replace(/\/+$/, '');
const BASE = ('/' + (process.env.BASE_PATH ?? '/car').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // p.ej. https://audiobookshelf.example.com
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const PAIR_TTL_MS = 10 * 60 * 1000;
const DEVICE_COOKIE = 'abs_car_device';
const PAIR_COOKIE = 'abs_car_pair';
const DEVICE_MAX_AGE = 365 * 24 * 3600;

const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
// Sello del contenido de public/: va en las URLs de los estáticos (?v=…) para que ninguna caché
// intermedia (p. ej. un CDN que ignore no-cache) sirva un app.js nuevo con un i18n.js viejo
const ASSET_V = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(path.join(__dirname, 'public')).sort()) h.update(f).update(fs.readFileSync(path.join(__dirname, 'public', f)));
  return h.digest('hex').slice(0, 10);
})();
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// ---------- Almacenamiento (JSON en volumen) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
// Aviso claro si la carpeta de datos no admite escritura (p. ej. creada por Docker como root): sin esto
// las vinculaciones y contadores solo vivirían en memoria y se perderían al reiniciar
try {
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch {
  console.error(`[store] ¡${DATA_DIR} no admite escritura! Las vinculaciones no se guardarán. Da la carpeta al usuario del contenedor (uid 1000): chown -R 1000:1000 <carpeta-de-datos>`);
}
let store = { devices: {} };
try {
  store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  store.devices ||= {};
} catch {}

let saveChain = Promise.resolve();
function saveStore() {
  saveChain = saveChain.then(async () => {
    const tmp = STORE_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, STORE_FILE);
  }).catch((e) => console.error('[store] error guardando:', e));
  return saveChain;
}

// ---------- Datos enviados a cada coche (bytes reales que salen de este servidor) ----------
// device.usage = { day, today, month, thisMonth, total }
const localDay = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD en la zona horaria del contenedor (TZ)
let usageDirty = false;

function addUsage(device, bytes) {
  if (!bytes) return;
  const u = (device.usage ||= { day: '', today: 0, month: '', thisMonth: 0, total: 0 });
  const day = localDay(), month = day.slice(0, 7);
  if (u.day !== day) { u.day = day; u.today = 0; }
  if (u.month !== month) { u.month = month; u.thisMonth = 0; }
  u.today += bytes;
  u.thisMonth += bytes;
  u.total += bytes;
  usageDirty = true;
}

function usageOf(device) {
  const u = device.usage || {};
  const day = localDay();
  return {
    today: u.day === day ? u.today : 0,
    month: u.month === day.slice(0, 7) ? u.thisMonth : 0,
    total: u.total || 0,
  };
}

// Cuenta lo que se escribe en la respuesta (incluido lo que llega por pipe desde Audiobookshelf)
function countResponse(res, device) {
  const { write, end } = res;
  const size = (chunk, enc) => (chunk ? (typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk.length) : 0);
  res.write = function (chunk, enc, cb) { addUsage(device, size(chunk, enc)); return write.call(this, chunk, enc, cb); };
  res.end = function (chunk, enc, cb) { if (typeof chunk !== 'function') addUsage(device, size(chunk, enc)); return end.call(this, chunk, enc, cb); };
}

// Guardar los contadores como mucho cada 30 s (no en cada trozo de audio)
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  saveStore();
}, 30_000).unref();

// ---------- Registro de escuchas con ubicación (solo en este servidor) ----------
// Un «tramo» es una escucha continua: empieza al dar a play y termina al pausar (una pausa corta en el
// mismo libro continúa el tramo). Guarda el libro, horas, posiciones y, si el coche tiene la
// ubicación activada, puntos de la ruta cada ~30 s. Un fichero por usuario en DATA_DIR/logs/.
const LOG_DIR = path.join(DATA_DIR, 'logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.error(`[log] no se puede crear ${LOG_DIR} (${e.code}): el registro de escuchas no se guardará en disco`);
}
const LOG_MAX_SEGMENTS = 2000;
const LOG_MAX_POINTS = 3000; // por tramo (~25 h a un punto cada 30 s)
const logs = new Map(); // usuario de Audiobookshelf → [tramos]
const logDirty = new Set();

// El historial es del usuario de Audiobookshelf, no del coche: sobrevive a volver a vincular, a borrar
// los datos del navegador y a cambiar de coche (cada tramo guarda desde qué coche se escuchó)
const logKey = (device) => String(device.userId || device.username || device.id).replace(/[^\w-]/g, '_');

function readLogFile(name) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(LOG_DIR, name + '.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function logOf(device) {
  const key = logKey(device);
  if (!logs.has(key)) {
    const list = readLogFile(key);
    // Migración: historiales antiguos guardados por coche pasan al del usuario
    for (const d of Object.values(store.devices)) {
      if (logKey(d) !== key || d.id === key) continue;
      const old = readLogFile(d.id);
      if (!old.length) continue;
      const ids = new Set(list.map((sg) => sg.id));
      for (const sg of old) if (!ids.has(sg.id)) list.push({ car: d.name, ...sg });
      try { fs.renameSync(path.join(LOG_DIR, d.id + '.json'), path.join(LOG_DIR, d.id + '.json.migrated')); } catch {}
      logDirty.add(key);
    }
    list.sort((a, b) => a.startedAt - b.startedAt);
    logs.set(key, list);
  }
  return logs.get(key);
}

async function saveLogs() {
  for (const id of [...logDirty]) {
    logDirty.delete(id);
    const file = path.join(LOG_DIR, id + '.json');
    try {
      await fsp.writeFile(file + '.tmp', JSON.stringify(logs.get(id) || []), { mode: 0o600 });
      await fsp.rename(file + '.tmp', file);
    } catch (e) { console.error('[log] error guardando:', e.message); }
  }
}
setInterval(saveLogs, 20_000).unref();

// Distancia en metros entre dos puntos (fórmula del haversine)
function meters(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Kilómetros, tiempo en marcha y parado a partir de los puntos. Se ignoran puntos poco precisos y
// los saltos entre puntos muy separados en el tiempo (pausas largas sin datos).
const STOPPED_MPS = 1.4; // por debajo de ~5 km/h cuenta como parado (atasco, semáforo)
function routeStats(points) {
  const pts = points.filter((p) => !(p.acc > 100));
  let distance = 0, moving = 0, stopped = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0 || dt > 180) continue;
    const d = meters(pts[i - 1], pts[i]);
    if (d / dt < STOPPED_MPS) stopped += dt;
    else { moving += dt; distance += d; }
  }
  return { distance: Math.round(distance), moving: Math.round(moving), stopped: Math.round(stopped) };
}

// Nombres de lugar con OpenStreetMap (Nominatim): como mucho una consulta por segundo, con caché
// por coordenadas redondeadas (~100 m). Solo salen las coordenadas, nada más del coche ni del usuario.
const placeCache = new Map();
let geocodeChain = Promise.resolve();
function placeName(lat, lon, lang) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${lang}`;
  if (placeCache.has(key)) return Promise.resolve(placeCache.get(key));
  const job = geocodeChain.then(async () => {
    if (placeCache.has(key)) return placeCache.get(key);
    let name = null;
    try {
      const qs = new URLSearchParams({ format: 'jsonv2', lat, lon, zoom: 14, 'accept-language': lang || 'en' });
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?${qs}`, {
        headers: { 'User-Agent': `ABS-Car/${VERSION} (+https://github.com/crazystress/abs-car)` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const a = (await r.json()).address || {};
        const local = a.suburb || a.neighbourhood || a.quarter || a.city_district;
        const town = a.city || a.town || a.village || a.municipality || a.county;
        name = [local, town].filter((x, i, arr) => x && arr.indexOf(x) === i).join(', ') || null;
      }
    } catch {}
    placeCache.set(key, name);
    await new Promise((res) => setTimeout(res, 1100)); // política de uso de Nominatim: 1 consulta/s
    return name;
  });
  geocodeChain = job.catch(() => {});
  return job;
}

async function nameSegmentPlaces(seg, lang) {
  const pts = seg.points.filter((p) => !(p.acc > 100));
  if (!pts.length) return;
  if (!seg.from) seg.from = await placeName(pts[0].lat, pts[0].lon, lang);
  seg.to = await placeName(pts[pts.length - 1].lat, pts[pts.length - 1].lon, lang);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
function upsertSegment(device, body) {
  const id = String(body.id || '').slice(0, 64);
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  const list = logOf(device);
  let seg = list.find((s) => s.id === id);
  if (!seg) {
    seg = { id, car: device.name, itemId: String(body.itemId || '').slice(0, 64), title: String(body.title || '').slice(0, 300),
      author: String(body.author || '').slice(0, 200), startedAt: num(body.startedAt) || Date.now(), startPos: num(body.startPos) || 0, points: [] };
    list.push(seg);
    if (list.length > LOG_MAX_SEGMENTS) list.splice(0, list.length - LOG_MAX_SEGMENTS);
  }
  seg.endedAt = num(body.endedAt) || Date.now();
  seg.endPos = num(body.endPos) ?? seg.endPos;
  seg.listened = Math.max(seg.listened || 0, num(body.listened) || 0);
  for (const p of Array.isArray(body.points) ? body.points : []) {
    const pt = { t: num(p.t), lat: num(p.lat), lon: num(p.lon), acc: num(p.acc) };
    if (!pt.t || pt.lat === undefined || pt.lon === undefined || Math.abs(pt.lat) > 90 || Math.abs(pt.lon) > 180) continue;
    if (seg.points.length && pt.t <= seg.points[seg.points.length - 1].t) continue;
    if (seg.points.length < LOG_MAX_POINTS) seg.points.push(pt);
  }
  Object.assign(seg, routeStats(seg.points));
  logDirty.add(logKey(device));
  if (body.final) nameSegmentPlaces(seg, String(body.lang || 'en').slice(0, 5)).then(() => logDirty.add(logKey(device)));
  return seg;
}

// Resumen para la pantalla de estadísticas (sin los puntos de la ruta, que no hacen falta allí)
function logSummary(device, limit) {
  const list = logOf(device).filter((s) => (s.listened || 0) >= 30);
  const totals = { listened: 0, distance: 0, moving: 0, stopped: 0, segments: list.length };
  const books = new Map();
  for (const s of list) {
    totals.listened += s.listened || 0;
    totals.distance += s.distance || 0;
    totals.moving += s.moving || 0;
    totals.stopped += s.stopped || 0;
    if (s.distance) {
      const b = books.get(s.itemId) || { itemId: s.itemId, title: s.title, distance: 0, moving: 0 };
      b.distance += s.distance;
      b.moving += s.moving || 0;
      books.set(s.itemId, b);
    }
  }
  const strip = ({ points, ...rest }) => ({ ...rest, hasRoute: points.length > 1 });
  return {
    totals,
    books: [...books.values()].sort((a, b) => b.distance - a.distance).slice(0, 10),
    segments: list.slice(-limit).reverse().map(strip),
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function findDeviceByToken(token) {
  if (!token) return null;
  const hash = sha256(token);
  return Object.values(store.devices).find((d) => d.tokenHash === hash) || null;
}

// ---------- Vinculaciones pendientes (en memoria) ----------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O, 1/I/L
const pending = new Map(); // code -> { code, pollHash, expiresAt, deviceToken? }

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!pending.has(code)) return code;
  }
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pending) if (p.expiresAt < now) pending.delete(code);
  for (const [ip, r] of rateLimits) if (r.reset < now) rateLimits.delete(ip);
}, 60_000).unref();

// Límite de intentos de vinculación por IP
const rateLimits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let r = rateLimits.get(ip);
  if (!r || r.reset < now) rateLimits.set(ip, (r = { count: 0, reset: now + 15 * 60_000 }));
  return ++r.count > 10;
}

// ---------- Tokens de Audiobookshelf ----------
function parseTokens(body) {
  const u = body?.user || {};
  return {
    accessToken: u.accessToken || body?.accessToken || null,
    refreshToken: u.refreshToken || body?.refreshToken || null,
    legacyToken: u.token || null,
  };
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function absLogin(username, password) {
  const res = await fetch(`${ABS_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = await res.json();
  const t = parseTokens(body);
  if (!t.accessToken && !t.legacyToken) return { ok: false, status: 500 };
  return { ok: true, user: body.user, tokens: t };
}

const refreshing = new Map(); // deviceId -> Promise<boolean>
function refreshDevice(device) {
  if (!device.refreshToken) return Promise.resolve(false);
  if (refreshing.has(device.id)) return refreshing.get(device.id);
  const p = (async () => {
    try {
      const res = await fetch(`${ABS_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'x-refresh-token': device.refreshToken },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[auth] refresh falló para ${device.name} (${res.status})`);
        if (res.status === 401 || res.status === 403) {
          device.invalid = true;
          await saveStore();
        }
        return false;
      }
      const t = parseTokens(await res.json());
      if (!t.accessToken) return false;
      device.accessToken = t.accessToken;
      if (t.refreshToken) device.refreshToken = t.refreshToken;
      await saveStore();
      return true;
    } catch (e) {
      console.warn('[auth] refresh error:', e.message);
      return false;
    } finally {
      refreshing.delete(device.id);
    }
  })();
  refreshing.set(device.id, p);
  return p;
}

async function bearerFor(device) {
  if (device.legacyToken && !device.accessToken) return device.legacyToken;
  const exp = jwtExp(device.accessToken);
  if (exp && exp - Date.now() < 60_000) await refreshDevice(device);
  return device.accessToken;
}

async function absFetch(device, absPath, { method = 'GET', headers = {}, body, signal } = {}) {
  const doFetch = async () =>
    fetch(ABS_URL + absPath, {
      method,
      headers: { ...headers, Authorization: `Bearer ${await bearerFor(device)}` },
      body,
      signal,
      redirect: 'manual',
    });
  let res = await doFetch();
  if (res.status === 401 && device.refreshToken && (await refreshDevice(device))) {
    res.body?.cancel().catch(() => {});
    res = await doFetch();
  }
  return res;
}

// ---------- Utilidades HTTP ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${BASE || '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    COOKIE_SECURE ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString() || '{}');
  } catch {
    return {};
  }
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL + BASE;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${BASE}`;
}

// ---------- Ficheros estáticos ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

async function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
  try {
    let data = await fsp.readFile(full);
    if (/\.(html|webmanifest)$/.test(file)) data = Buffer.from(data.toString().replaceAll('__BASE__', BASE).replaceAll('__VERSION__', VERSION).replaceAll('__ASSET_V__', ASSET_V));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

// ---------- Proxy hacia Audiobookshelf ----------
// Solo lo que necesita la app del coche.
const PROXY_ALLOW = [
  ['GET', /^\/api\/me(\/items-in-progress|\/progress\/[\w-]+(\/[\w-]+)?)?$/],
  ['GET', /^\/api\/libraries(\/[\w-]+(\/items|\/personalized|\/search|\/authors|\/narrators|\/series)?)?$/],
  ['GET', /^\/api\/authors\/[\w-]+(\/image)?$/],
  ['GET', /^\/api\/items\/[\w-]+(\/cover|\/file\/[\w-]+)?$/],
  ['GET', /^\/(s|hls)\/.+$/],
  ['POST', /^\/api\/items\/[\w-]+\/play(\/[\w-]+)?$/],
  ['POST', /^\/api\/session\/[\w-]+\/(sync|close)$/],
  ['POST', /^\/api\/me\/item\/[\w-]+\/bookmark$/],
];
const FORWARD_REQ_HEADERS = ['range', 'content-type', 'accept', 'if-none-match', 'if-modified-since'];
const FORWARD_RES_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

async function proxy(req, res, device, absPath, search) {
  if (!PROXY_ALLOW.some(([m, re]) => m === req.method && re.test(absPath))) {
    return sendJson(res, 403, { error: 'route_not_allowed' });
  }
  const headers = {};
  for (const h of FORWARD_REQ_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];

  let body;
  if (req.method === 'POST') {
    body = await readBody(req);
    // Identificar el coche en las sesiones de escucha de Audiobookshelf
    if (/\/play(\/[\w-]+)?$/.test(absPath)) {
      let json = {};
      try { json = JSON.parse(body.toString() || '{}'); } catch {}
      json.deviceInfo = {
        ...(json.deviceInfo || {}),
        deviceId: device.id,
        clientName: 'ABS Car',
        clientVersion: VERSION,
        model: device.name,
      };
      body = JSON.stringify(json);
      headers['content-type'] = 'application/json';
    }
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let upstream;
  try {
    upstream = await absFetch(device, absPath + search, { method: req.method, headers, body, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    console.warn('[proxy] error:', e.message);
    return sendJson(res, 502, { error: 'abs_unreachable' });
  }

  if (upstream.status === 401 && (device.invalid || !device.refreshToken)) {
    return sendJson(res, 401, { error: 'relink' });
  }

  const outHeaders = {};
  for (const h of FORWARD_RES_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

// ---------- Rutas ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;

  if (p === '/healthz' || p === `${BASE}/healthz`) return sendJson(res, 200, { ok: true });
  if (BASE && p === BASE) {
    res.writeHead(301, { Location: BASE + '/' });
    return res.end();
  }
  if (BASE && !p.startsWith(BASE + '/')) return sendJson(res, 404, { error: 'not found' });
  p = p.slice(BASE.length);

  const cookies = parseCookies(req);
  const device = findDeviceByToken(cookies[DEVICE_COOKIE]);
  if (device && !device.invalid) countResponse(res, device);

  // Páginas
  if (req.method === 'GET' && p === '/') return serveFile(res, 'index.html');
  if (req.method === 'GET' && (p === '/pair' || p === '/pair/')) return serveFile(res, 'pair.html');
  // Ruta antigua (en español): redirige conservando ?code= y ?lang= de QR ya mostrados
  if (req.method === 'GET' && (p === '/vincular' || p === '/vincular/')) {
    res.writeHead(301, { Location: `${BASE}/pair${url.search}` });
    return res.end();
  }
  if (req.method === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice('/static/'.length));

  // Estado del coche
  if (req.method === 'GET' && p === '/me') {
    if (!device || device.invalid) return sendJson(res, 200, { paired: false });
    if (Date.now() - (device.lastSeen || 0) > 3600_000) {
      device.lastSeen = Date.now();
      saveStore();
    }
    return sendJson(res, 200, { paired: true, name: device.name, username: device.username, deviceId: device.id, usage: usageOf(device) });
  }

  // Coche: cambiar su propio nombre (solo con su cookie; JSON para evitar envíos desde formularios ajenos)
  if (req.method === 'POST' && p === '/me') {
    if (!device || device.invalid) return sendJson(res, 401, { error: 'not_paired' });
    if (!String(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'invalid_name' });
    const { name } = await readJson(req);
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) return sendJson(res, 400, { error: 'invalid_name' });
    if (clean !== device.name) {
      console.log(`[me] "${device.name}" renombrado a "${clean}"`);
      device.name = clean;
      await saveStore();
    }
    return sendJson(res, 200, { ok: true, name: device.name });
  }

  // Coche: pedir un código
  if (req.method === 'POST' && p === '/pair/start') {
    const pollToken = cookies[PAIR_COOKIE];
    if (pollToken) {
      const existing = [...pending.values()].find((x) => x.pollHash === sha256(pollToken) && x.expiresAt > Date.now());
      if (existing) return sendJson(res, 200, { code: existing.code, expiresAt: existing.expiresAt, pairUrl: `${publicBase(req)}/pair` });
    }
    const code = newCode();
    const poll = randomToken();
    const expiresAt = Date.now() + PAIR_TTL_MS;
    pending.set(code, { code, pollHash: sha256(poll), expiresAt });
    return sendJson(res, 200, { code, expiresAt, pairUrl: `${publicBase(req)}/pair` }, {
      'Set-Cookie': cookie(PAIR_COOKIE, poll, PAIR_TTL_MS / 1000),
    });
  }

  // Coche: ¿ya me han aprobado?
  if (req.method === 'GET' && p === '/pair/status') {
    const pollToken = cookies[PAIR_COOKIE];
    const entry = pollToken && [...pending.values()].find((x) => x.pollHash === sha256(pollToken));
    if (!entry || entry.expiresAt < Date.now()) return sendJson(res, 200, { status: 'expired' });
    if (!entry.deviceToken) return sendJson(res, 200, { status: 'pending' });
    pending.delete(entry.code);
    res.setHeader('Set-Cookie', [cookie(DEVICE_COOKIE, entry.deviceToken, DEVICE_MAX_AGE), cookie(PAIR_COOKIE, '', 0)]);
    return sendJson(res, 200, { status: 'approved' });
  }

  // QR con el enlace de vinculación y el código ya relleno
  if (req.method === 'GET' && p === '/pair/qr.svg') {
    const code = normalizeCode(url.searchParams.get('code'));
    const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? `&lang=${url.searchParams.get('lang')}` : '';
    const svg = await QRCode.toString(`${publicBase(req)}/pair?code=${code}${lang}`, {
      type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' },
    });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  // Móvil: aprobar un código con usuario y contraseña de Audiobookshelf.
  // Los errores van como códigos (err.<código> en public/i18n.js) para traducirlos en el móvil.
  if (req.method === 'POST' && p === '/pair/approve') {
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
    const { code, username, password, name } = await readJson(req);
    const entry = pending.get(normalizeCode(code));
    if (!entry || entry.expiresAt < Date.now() || entry.deviceToken) {
      return sendJson(res, 400, { error: 'invalid_code' });
    }
    if (!username || !password) return sendJson(res, 400, { error: 'missing_credentials' });

    let login;
    try {
      login = await absLogin(String(username), String(password));
    } catch (e) {
      console.warn('[pair] login error:', e.message);
      return sendJson(res, 502, { error: 'abs_unreachable' });
    }
    if (!login.ok) {
      return sendJson(res, login.status === 401 ? 401 : 502, { error: login.status === 401 ? 'bad_credentials' : 'abs_error' });
    }

    const deviceToken = randomToken();
    const id = crypto.randomUUID();
    store.devices[id] = {
      id,
      name: String(name || 'Car').slice(0, 40),
      tokenHash: sha256(deviceToken),
      userId: login.user?.id,
      username: login.user?.username,
      accessToken: login.tokens.accessToken,
      refreshToken: login.tokens.refreshToken,
      legacyToken: login.tokens.legacyToken,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    await saveStore();
    entry.deviceToken = deviceToken;
    console.log(`[pair] vinculado "${store.devices[id].name}" para ${login.user?.username}`);
    return sendJson(res, 200, { ok: true, name: store.devices[id].name });
  }

  // Coche: desvincular
  if (req.method === 'POST' && p === '/logout') {
    if (device) {
      if (device.refreshToken) {
        fetch(`${ABS_URL}/logout`, { method: 'POST', headers: { 'x-refresh-token': device.refreshToken } }).catch(() => {});
      }
      delete store.devices[device.id];
      await saveStore();
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(DEVICE_COOKIE, '', 0) });
  }

  // Registro de escuchas: el coche envía sus tramos; Stats pide el resumen; Ajustes puede borrarlo
  if (p === '/log' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
    if (!device || device.invalid) return sendJson(res, 401, { error: 'relink' });
    if (req.method === 'GET') return sendJson(res, 200, logSummary(device, Math.min(200, Number(url.searchParams.get('limit')) || 60)));
    if (req.method === 'DELETE') {
      logs.set(logKey(device), []);
      logDirty.add(logKey(device));
      await saveLogs();
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req).catch(() => null);
    const seg = body && upsertSegment(device, body);
    return seg ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: 'invalid_segment' });
  }

  // Estadísticas de escucha de un libro: el servidor suma las sesiones para no mandar al coche
  // la lista entera (cada sesión de Audiobookshelf trae muchos datos)
  const statsMatch = req.method === 'GET' && p.match(/^\/stats\/([\w-]+)$/);
  if (statsMatch) {
    if (!device || device.invalid) return sendJson(res, 401, { error: 'relink' });
    const r = await absFetch(device, `/api/me/item/listening-sessions/${statsMatch[1]}?itemsPerPage=100000`);
    if (!r.ok) return sendJson(res, r.status === 404 ? 404 : 502, { error: 'abs_error' });
    const { total, sessions = [] } = await r.json();
    let listened = 0, firstStartedAt = 0;
    for (const sess of sessions) {
      listened += Number(sess.timeListening) || 0;
      if (sess.startedAt && (!firstStartedAt || sess.startedAt < firstStartedAt)) firstStartedAt = sess.startedAt;
    }
    return sendJson(res, 200, { sessions: total ?? sessions.length, listened: Math.round(listened), firstStartedAt: firstStartedAt || null });
  }

  // Proxy a Audiobookshelf
  if (p.startsWith('/abs/')) {
    if (!device || device.invalid) return sendJson(res, 401, { error: 'relink' });
    return proxy(req, res, device, p.slice('/abs'.length), url.search);
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  handle(req, res).catch((e) => {
    console.error('[server]', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`ABS Car escuchando en :${PORT}${BASE}/  →  Audiobookshelf en ${ABS_URL}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await (usageDirty ? saveStore() : saveChain); // no perder los últimos contadores de datos
    await saveLogs();
    process.exit(0);
  });
}
