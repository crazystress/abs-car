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
    return sendJson(res, 200, { paired: true, name: device.name, username: device.username, deviceId: device.id });
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
    await saveChain;
    process.exit(0);
  });
}
