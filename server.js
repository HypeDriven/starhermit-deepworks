/**
 * Deepworks — StarHermit authoritative script (spec §6).
 * Zero-dependency Node.js static file server + JSON API.
 *
 * Responsibilities:
 *  - serve the game distribution from the project directory
 *  - /api/v1 routes: time, replay-validated daily leaderboards, global board,
 *    idempotent achievements, telemetry sink, activity/presence no-ops
 *  - per-IP token-bucket rate limiting, structured {"error":"..."} responses
 *
 * Node v22, CommonJS. Only builtins: http, fs, path, crypto, url.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const DWContent = require('./js/content.js');
const DWSession = require('./js/session.js');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const ACH_FILE = path.join(DATA_DIR, 'achievements.json');

const MAX_BODY_BYTES = 1024 * 1024;   // 1 MB
const MAX_LOG_ENTRIES = 200000;
const MAX_NAME_LEN = 24;
const BOARD_SIZE = 100;

const ACHIEVEMENT_KEYS = new Set([
  'first_completion',
  'mechanic_mastery',
  'streak_7',
  'deep_milestone',
  'long_haul'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.opus': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8'
};

// ------------------------------------------------------------ persistence ---
// Lazily loaded, atomically written (tmp + rename). Flushed on shutdown.
const store = {
  scores: null,        // { days: { dayKey: [entry] } }
  achievements: null,  // { names: { name: { key: unlockedAt } } }
  dirty: { scores: false, achievements: false }
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function scores() {
  if (!store.scores) store.scores = loadJson(SCORES_FILE, { days: {} });
  return store.scores;
}
function achievements() {
  if (!store.achievements) store.achievements = loadJson(ACH_FILE, { names: {} });
  return store.achievements;
}
function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function flush() {
  if (store.dirty.scores && store.scores) {
    atomicWrite(SCORES_FILE, store.scores);
    store.dirty.scores = false;
  }
  if (store.dirty.achievements && store.achievements) {
    atomicWrite(ACH_FILE, store.achievements);
    store.dirty.achievements = false;
  }
}

// ------------------------------------------------------------ rate limit ---
// Per-IP token buckets: strict bucket for score posts, general bucket for
// everything else.
const buckets = new Map(); // key -> {tokens, last}
function allow(ip, kind) {
  const cap = kind === 'scores' ? 30 : 120;
  const windowMs = 10000;
  const key = kind + ':' + ip;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: cap, last: now }; buckets.set(key, b); }
  b.tokens = Math.min(cap, b.tokens + (now - b.last) * cap / windowMs);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// bound memory: prune stale buckets periodically
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 60000).unref();

// -------------------------------------------------------------- helpers ---
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function sendError(res, status, code) {
  sendJson(res, status, { error: code });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendError(res, 413, 'too-large');
    return null;
  }
  try {
    const parsed = JSON.parse(raw || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad');
    return parsed;
  } catch (e) {
    sendError(res, 400, 'bad-json');
    return null;
  }
}
function sanitizeName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const clean = v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME_LEN);
  return clean || fallback;
}

function validLog(log) {
  if (!Array.isArray(log) || log.length > MAX_LOG_ENTRIES) return false;
  for (const e of log) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
    if (e.type === 'advance') {
      if (!Number.isInteger(e.ms) || e.ms < 0) return false;
      continue;
    }
    if (typeof e.type !== 'string' || e.type.length > 40) return false;
  }
  return true;
}

// ------------------------------------------------------------- scoreboard ---
function dayBoard(dayKey) {
  const s = scores();
  if (!s.days[dayKey]) s.days[dayKey] = [];
  return s.days[dayKey];
}
function sortBoard(board) {
  board.sort((a, b) => b.score - a.score || a.durationSec - b.durationSec || a.when - b.when);
}
function submitScore(dayKey, entry) {
  const board = dayBoard(dayKey);
  const existing = board.findIndex((e) => e.name === entry.name);
  if (existing >= 0) {
    if (board[existing].score >= entry.score) {
      sortBoard(board);
      return board.findIndex((e) => e.name === entry.name) + 1;
    }
    board.splice(existing, 1);
  }
  board.push(entry);
  sortBoard(board);
  if (board.length > BOARD_SIZE) board.length = BOARD_SIZE;
  store.dirty.scores = true;
  const rank = board.findIndex((e) => e.name === entry.name && e.score === entry.score && e.when === entry.when) + 1;
  return rank;
}
function globalBoard() {
  const best = new Map(); // name -> best entry
  const s = scores();
  for (const dayKey of Object.keys(s.days)) {
    for (const e of s.days[dayKey]) {
      const cur = best.get(e.name);
      if (!cur || e.score > cur.score) best.set(e.name, e);
    }
  }
  const entries = Array.from(best.values());
  sortBoard(entries);
  return entries.slice(0, BOARD_SIZE);
}

// ----------------------------------------------------------------- routes ---
async function handleApi(req, res, url) {
  const p = url.pathname;
  const ip = req.socket.remoteAddress || 'unknown';

  if (p === '/api/v1/time' && req.method === 'GET') {
    if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
    return sendJson(res, 200, { now: Date.now() });
  }

  if (p === '/api/v1/scores/daily') {
    if (req.method === 'GET') {
      if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
      const day = url.searchParams.get('day');
      const key = day && /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? 'daily-' + day
        : DWContent.dailyInfo(new Date()).id;
      const board = scores().days[key] || [];
      return sendJson(res, 200, { entries: board, authoritative: true });
    }
    if (req.method === 'POST') {
      if (!allow(ip, 'scores')) return sendError(res, 429, 'rate-limited');
      const body = await readJsonBody(req, res);
      if (!body) return;
      return submitDailyScore(res, body);
    }
    return sendError(res, 405, 'method-not-allowed');
  }

  if (p === '/api/v1/scores/global' && req.method === 'GET') {
    if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
    return sendJson(res, 200, { entries: globalBoard(), authoritative: true });
  }

  const achMatch = p.match(/^\/api\/v1\/achievements\/([a-z0-9_]+)$/);
  if (achMatch && req.method === 'POST') {
    if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
    const key = achMatch[1];
    if (!ACHIEVEMENT_KEYS.has(key)) return sendError(res, 404, 'not-found');
    const body = await readJsonBody(req, res);
    if (!body) return;
    const name = sanitizeName(body.name, 'guest');
    const a = achievements();
    if (!a.names[name]) a.names[name] = {};
    const already = key in a.names[name];
    if (!already) {
      a.names[name][key] = Date.now();
      store.dirty.achievements = true;
    }
    return sendJson(res, 200, { ok: true, already: already });
  }

  if (p === '/api/v1/telemetry' && req.method === 'POST') {
    if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
    const body = await readJsonBody(req, res); // anonymous funnel sink: discard
    if (!body) return;
    return sendJson(res, 200, { ok: true });
  }

  if ((p === '/api/v1/activity/start' || p === '/api/v1/activity/end' ||
       p === '/api/v1/presence/heartbeat') && req.method === 'POST') {
    if (!allow(ip, 'general')) return sendError(res, 429, 'rate-limited');
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'not-found');
}

function submitDailyScore(res, body) {
  const dayKey = body.dayKey;
  if (typeof dayKey !== 'string' || !/^daily-\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return sendError(res, 400, 'bad-day-key');
  }
  if (body.contentVersion !== DWContent.CONTENT_VERSION) {
    return sendError(res, 409, 'stale-version');
  }
  const dateForDay = new Date(dayKey.replace('daily-', '') + 'T00:00:00Z');
  const content = DWContent.dailyInfo(dateForDay);
  if (content.id !== dayKey) {
    return sendError(res, 409, 'stale-version');
  }
  if (body.seed !== content.seed) {
    return sendError(res, 422, 'seed-mismatch');
  }
  if (!validLog(body.log)) {
    return sendError(res, 400, 'malformed-log');
  }
  const durationSec = Number(body.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 0 || durationSec > 86400) {
    return sendError(res, 422, 'implausible');
  }

  // Authoritative deterministic replay; the client-reported score is ignored.
  let replayRes;
  try {
    replayRes = DWSession.replay(content, body.log, { buildState: DWContent.buildState });
  } catch (e) {
    return sendError(res, 422, 'replay-mismatch');
  }
  if (!replayRes.ok || replayRes.hash !== body.clientHash) {
    return sendError(res, 422, 'replay-mismatch');
  }
  const score = replayRes.score.total;
  if (!(score >= 0)) {
    return sendError(res, 422, 'implausible');
  }

  const entry = {
    name: sanitizeName(body.name, 'Anonymous'),
    score: score,
    durationSec: durationSec,
    dayKey: dayKey,
    when: Date.now()
  };
  const rank = submitScore(dayKey, entry);
  return sendJson(res, 200, { ok: true, rank: rank, authoritative: true });
}

// ----------------------------------------------------------------- static ---
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return sendError(res, 403, 'forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, 'not-found');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html'
      ? 'no-cache'
      : filePath.startsWith(path.join(ROOT, 'vendor') + path.sep)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cache,
      'Content-Length': st.size
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ------------------------------------------------------------------ server ---
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendError(res, 400, 'bad-request');
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => sendError(res, 500, 'internal'));
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url);
  } else {
    sendError(res, 405, 'method-not-allowed');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deepworks server listening at http://0.0.0.0:${PORT}/`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down...');
  server.close(() => {
    flush();
    process.exit(0);
  });
  // hard exit if connections linger
  setTimeout(() => { flush(); process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
