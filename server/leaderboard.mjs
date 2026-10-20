#!/usr/bin/env node
/**
 * Zero-dependency leaderboard service for deepseek-of-duty.
 *
 * Scope / honesty notes:
 * - This is a small JSON-file service, not a game authority. It can reject
 *   malformed/implausible runs and slow down scripts, but a modified browser
 *   client can still submit fabricated (yet internally consistent) numbers.
 * - There is no server-side simulation and no real anti-cheat here.
 *
 * Only Node built-in modules are used.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = '1.0.0';
const MODES = Object.freeze(['rotation', 'survival', 'defend', 'extract']);
const STORE_VERSION = 1;

const TOP_PER_MODE = 100;
const POST_TOP_LIMIT = 10;
const BOARD_DEFAULT_LIMIT = 20;
const BOARD_MAX_LIMIT = 50;

const MAX_BODY_BYTES = 8 * 1024;
const TICKET_TTL_MS = 150_000;
const TICKET_MAX = 5_000;

const MAX_SCORE = 2_000_000;
const MAX_KILLS = 5_000;
const MAX_WAVE = 200;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 21_600_000;
const MAX_SHOTS = 20_000;
const MAX_CHALLENGES = 10_000;

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const DEFAULT_ORIGINS = 'https://dod.goodpoint.top,http://127.0.0.1:5173,http://localhost:5173';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parsePort(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (raw !== undefined) {
    console.warn(`[leaderboard] invalid PORT=${raw}, falling back to 8787`);
  }
  return 8787;
}

const PORT = parsePort(process.env.PORT);

function parseOrigins(raw) {
  const set = new Set();
  for (const item of String(raw ?? '').split(',')) {
    const origin = item.trim();
    if (origin) set.add(origin);
  }
  return set;
}

const ORIGINS = parseOrigins(process.env.LB_ORIGINS ?? DEFAULT_ORIGINS);
const ALLOW_UNSIGNED = process.env.LB_ALLOW_UNSIGNED === '1';

const DATA_DIR = process.env.LB_DATA_DIR && process.env.LB_DATA_DIR.trim()
  ? path.resolve(process.cwd(), process.env.LB_DATA_DIR.trim())
  : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'leaderboard.json');

let SECRET;
let SECRET_IS_EPHEMERAL = false;
if (process.env.LB_SECRET && process.env.LB_SECRET.trim()) {
  SECRET = Buffer.from(process.env.LB_SECRET.trim(), 'utf8');
} else {
  SECRET = crypto.randomBytes(32);
  SECRET_IS_EPHEMERAL = true;
  console.warn(
    '[leaderboard] LB_SECRET is not set; generated an ephemeral secret. ' +
    'Outstanding tickets become invalid after restart.'
  );
}
if (ALLOW_UNSIGNED) {
  console.warn('[leaderboard] LB_ALLOW_UNSIGNED=1: submissions without a ticket are accepted (development only).');
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const startedAt = Date.now();

/**
 * mode -> { updatedAt: string|null, entries: Entry[] }
 * Entry: { mode, cid, runId, name, score, kills, wave, ts }
 */
const modes = new Map(MODES.map((mode) => [mode, { updatedAt: null, entries: [] }]));
const runIndex = new Map(); // `${cid}\0${runId}` -> Entry (global per-client idempotency)
let storeUpdatedAt = null;

const tickets = new Map(); // ticket -> issuedAt (insertion order = issue order)

/** ip -> { read?: Bucket, submit?: Bucket } */
const buckets = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function headerValue(req, name) {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
  return typeof raw === 'string' ? raw : '';
}

function getClientIp(req) {
  // When deployed behind nginx, X-Forwarded-For is normally appended by the proxy.
  // The first hop is used deliberately; see README for the trust boundary.
  const xff = headerValue(req, 'x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first.slice(0, 100);
  }
  const realIp = headerValue(req, 'x-real-ip').trim();
  if (realIp) return realIp.slice(0, 100);
  const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  return socketIp.replace(/^::ffff:/, '').slice(0, 100);
}

function sanitizeClientId(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!CLIENT_ID_RE.test(value)) return null;
  return value;
}

/**
 * Remove control/injection characters, collapse whitespace, trim and cap at
 * 12 code points. Empty names become OPERATOR.
 */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'OPERATOR';
  let value = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029]/g, '')
    .replace(/[<>{}[\]\\"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(value);
  if (chars.length > 12) value = chars.slice(0, 12).join('').trim();
  return value.length > 0 ? value : 'OPERATOR';
}

function hmacHex(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.kills !== a.kills) return b.kills - a.kills;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

function publicEntry(entry) {
  return {
    name: entry.name,
    score: entry.score,
    kills: entry.kills,
    wave: entry.wave,
    ts: entry.ts,
    runId: entry.runId,
  };
}

/** Slice a sorted mode list into a page and attach 1-based global ranks. */
function rankedPage(entries, offset, limit) {
  return entries
    .slice(offset, offset + limit)
    .map((entry, index) => ({ ...publicEntry(entry), rank: offset + index + 1 }));
}

function indexKey(cid, runId) {
  return `${cid}\u0000${runId}`;
}

function rankOf(entry) {
  const state = modes.get(entry.mode);
  if (!state) return null;
  const index = state.entries.indexOf(entry);
  return index >= 0 ? index + 1 : null;
}

function personalBest(mode, cid) {
  if (!cid) return null;
  const state = modes.get(mode);
  if (!state) return null;
  for (const entry of state.entries) {
    if (entry.cid === cid) return entry; // entries are sorted best-first
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence: single JSON file, 200 ms debounced atomic write
// ---------------------------------------------------------------------------

let dirty = false;
let saveTimer = null;
let saveChain = Promise.resolve();
let shuttingDown = false;

function serializeStore() {
  const outModes = {};
  for (const mode of MODES) {
    const state = modes.get(mode);
    outModes[mode] = {
      updatedAt: state.updatedAt,
      entries: state.entries.map((entry) => ({
        runId: entry.runId,
        cid: entry.cid,
        name: entry.name,
        score: entry.score,
        kills: entry.kills,
        wave: entry.wave,
        ts: entry.ts,
      })),
    };
  }
  return JSON.stringify({
    version: STORE_VERSION,
    updatedAt: storeUpdatedAt,
    modes: outModes,
  });
}

function scheduleSave() {
  dirty = true;
  if (shuttingDown || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 200);
}

function flushSave() {
  saveChain = saveChain
    .then(async () => {
      if (!dirty) return;
      dirty = false;
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmpFile = `${STORE_FILE}.tmp`;
      await fsp.writeFile(tmpFile, serializeStore(), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmpFile, STORE_FILE);
    })
    .catch((error) => {
      dirty = true;
      console.error(`[leaderboard] failed to persist store: ${error && error.message ? error.message : error}`);
    });
  return saveChain;
}

function backupCorruptStore(reason) {
  const stamp = Date.now();
  const backup = `${STORE_FILE}.corrupt.${stamp}`;
  try {
    fs.renameSync(STORE_FILE, backup);
    console.error(`[leaderboard] store is corrupt (${reason}); backed up to ${backup}`);
  } catch (error) {
    console.error(`[leaderboard] store is corrupt (${reason}) and backup failed: ${error.message}`);
  }
}

function restoreEntry(mode, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  if (!RUN_ID_RE.test(runId)) return null;
  const cid = sanitizeClientId(raw.cid) || 'anon';
  const score = raw.score;
  const kills = raw.kills;
  const wave = raw.wave;
  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) return null;
  if (!Number.isInteger(kills) || kills < 0 || kills > MAX_KILLS) return null;
  if (!Number.isInteger(wave) || wave < 1 || wave > MAX_WAVE) return null;
  const ts = Number.isFinite(raw.ts) && raw.ts >= 0 ? Math.floor(raw.ts) : Date.now();
  return {
    mode,
    cid,
    runId,
    name: sanitizeName(raw.name),
    score,
    kills,
    wave,
    ts,
  };
}

function loadStore() {
  let text;
  try {
    text = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log(`[leaderboard] no store yet at ${STORE_FILE}; starting empty`);
      return;
    }
    console.error(`[leaderboard] cannot read store: ${error.message}; starting empty`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    backupCorruptStore(`invalid JSON: ${error.message}`);
    return;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.modes || typeof parsed.modes !== 'object') {
    backupCorruptStore('missing modes object');
    return;
  }

  let loaded = 0;
  for (const mode of MODES) {
    const rawState = parsed.modes[mode];
    const rawEntries = rawState && Array.isArray(rawState.entries) ? rawState.entries : [];
    const state = modes.get(mode);
    state.updatedAt = typeof rawState?.updatedAt === 'string' ? rawState.updatedAt : null;

    for (const rawEntry of rawEntries) {
      const entry = restoreEntry(mode, rawEntry);
      if (!entry) continue;
      const key = indexKey(entry.cid, entry.runId);
      if (runIndex.has(key)) continue; // duplicate record on disk
      state.entries.push(entry);
      runIndex.set(key, entry);
      loaded += 1;
    }

    state.entries.sort(compareEntries);
    if (state.entries.length > TOP_PER_MODE) {
      const removed = state.entries.splice(TOP_PER_MODE);
      for (const entry of removed) {
        const key = indexKey(entry.cid, entry.runId);
        if (runIndex.get(key) === entry) runIndex.delete(key);
      }
    }
  }

  storeUpdatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
  console.log(`[leaderboard] loaded ${loaded} entries from ${STORE_FILE}`);
}

// ---------------------------------------------------------------------------
// Leaderboard mutations
// ---------------------------------------------------------------------------

function sortAndTrim(mode) {
  const state = modes.get(mode);
  state.entries.sort(compareEntries);
  if (state.entries.length > TOP_PER_MODE) {
    const removed = state.entries.splice(TOP_PER_MODE);
    for (const entry of removed) {
      const key = indexKey(entry.cid, entry.runId);
      if (runIndex.get(key) === entry) runIndex.delete(key);
    }
  }
}

/**
 * Idempotent upsert keyed by (cid, runId). The same pair from a different mode
 * is treated as a replay and updates the original entry in place, so a run is
 * never counted twice.
 */
function upsertRun(mode, cid, name, run) {
  const key = indexKey(cid, run.runId);
  const now = Date.now();
  let entry = runIndex.get(key);
  let duplicate = false;

  if (entry) {
    duplicate = true;
    entry.name = name;
    entry.score = run.score;
    entry.kills = run.kills;
    entry.wave = run.wave;
    entry.ts = now;
  } else {
    entry = {
      mode,
      cid,
      runId: run.runId,
      name,
      score: run.score,
      kills: run.kills,
      wave: run.wave,
      ts: now,
    };
    runIndex.set(key, entry);
    modes.get(mode).entries.push(entry);
  }

  sortAndTrim(entry.mode);

  const updatedAt = new Date(now).toISOString();
  const state = modes.get(entry.mode);
  state.updatedAt = updatedAt;
  storeUpdatedAt = updatedAt;
  scheduleSave();

  return { entry, rank: rankOf(entry), duplicate };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function pruneTickets(now) {
  // Map iteration order matches issue order, so expired tickets are at the front.
  for (const [ticket, issuedAt] of tickets) {
    if (now - issuedAt <= TICKET_TTL_MS) break;
    tickets.delete(ticket);
  }
}

function issueTicket() {
  const now = Date.now();
  pruneTickets(now);
  while (tickets.size >= TICKET_MAX) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, now);
  return { ticket, issuedAt: now, sig: hmacHex(`${ticket}.${now}`) };
}

/**
 * Verify and consume a ticket. A ticket is single-use only after a valid
 * signature; a bad signature does not burn the legitimate holder's ticket.
 */
function verifyTicket(body) {
  const hasTicket = body.ticket !== undefined && body.ticket !== null && body.ticket !== '';
  const hasIssuedAt = body.issuedAt !== undefined && body.issuedAt !== null;
  const hasSig = body.sig !== undefined && body.sig !== null && body.sig !== '';

  if (!hasTicket && !hasIssuedAt && !hasSig) {
    if (ALLOW_UNSIGNED) return { ok: true };
    return { ok: false, error: 'missing_ticket', message: '缺少 ticket，请先请求 /api/ticket' };
  }

  if (
    typeof body.ticket !== 'string' ||
    !Number.isInteger(body.issuedAt) ||
    typeof body.sig !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.sig)
  ) {
    return { ok: false, error: 'bad_ticket', message: 'ticket 字段格式不正确' };
  }

  const issuedAt = tickets.get(body.ticket);
  if (issuedAt === undefined) {
    return { ok: false, error: 'bad_ticket', message: 'ticket 不存在或已使用' };
  }
  if (body.issuedAt !== issuedAt) {
    return { ok: false, error: 'bad_ticket', message: 'ticket 与 issuedAt 不匹配' };
  }

  const now = Date.now();
  if (now - issuedAt > TICKET_TTL_MS) {
    tickets.delete(body.ticket);
    return { ok: false, error: 'ticket_expired', message: 'ticket 已过期' };
  }
  if (issuedAt - now > 5000) {
    return { ok: false, error: 'bad_ticket', message: 'ticket 时间戳异常' };
  }

  const expected = hmacHex(`${body.ticket}.${issuedAt}`);
  if (!safeEqualHex(body.sig, expected)) {
    return { ok: false, error: 'bad_signature', message: 'ticket 签名校验失败' };
  }

  tickets.delete(body.ticket); // single use
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Run validation
// ---------------------------------------------------------------------------

function validateRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'bad_run', message: 'run 必须是对象' };
  }
  if (typeof raw.mode !== 'string' || !MODES.includes(raw.mode)) {
    return { ok: false, error: 'bad_mode', message: 'mode 必须是 rotation/survival/defend/extract' };
  }
  if (typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) {
    return { ok: false, error: 'bad_run_id', message: 'runId 需为 8-64 位字母、数字、下划线或连字符' };
  }

  const numericRules = [
    ['score', 0, MAX_SCORE, 'bad_score'],
    ['kills', 0, MAX_KILLS, 'bad_kills'],
    ['wave', 1, MAX_WAVE, 'bad_wave'],
    ['durationMs', MIN_DURATION_MS, MAX_DURATION_MS, 'bad_duration'],
    ['headshots', 0, MAX_KILLS, 'bad_headshots'],
    ['shots', 0, MAX_SHOTS, 'bad_shots'],
    ['hits', 0, MAX_SHOTS, 'bad_hits'],
    ['challengesDone', 0, MAX_CHALLENGES, 'bad_challenges'],
  ];

  for (const [field, min, max, code] of numericRules) {
    const value = raw[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      return {
        ok: false,
        error: code,
        message: `${field} 必须是 ${min} 到 ${max} 之间的整数`,
      };
    }
  }

  if (raw.headshots > raw.kills) {
    return { ok: false, error: 'bad_headshots', message: 'headshots 不能大于 kills' };
  }
  if (raw.hits > raw.shots) {
    return { ok: false, error: 'bad_hits', message: 'hits 不能大于 shots' };
  }

  // Consistency rules: cheap plausibility checks, not a proof of legitimacy.
  if (raw.kills * 50 > raw.score + 250) {
    return { ok: false, error: 'inconsistent_run', message: 'kills 与 score 不一致（击杀数相对分数过高）' };
  }
  if (raw.score > raw.kills * 300 + raw.wave * 250 + 5000) {
    return { ok: false, error: 'inconsistent_run', message: 'score 与 kills/wave 不一致（分数相对进度过高）' };
  }
  if (raw.wave > raw.kills + 3) {
    return { ok: false, error: 'inconsistent_run', message: 'wave 与 kills 不一致（波次相对击杀过高）' };
  }
  // Softer duration floor: a wave can be cleared quickly, but a run still needs
  // at least 5 seconds overall and roughly 6 seconds per additional wave.
  const minDuration = Math.max(MIN_DURATION_MS, (raw.wave - 1) * 6000);
  if (raw.durationMs < minDuration) {
    return {
      ok: false,
      error: 'inconsistent_run',
      message: `durationMs 与 wave 不一致（wave ${raw.wave} 至少需要 ${minDuration}ms）`,
    };
  }

  // Cross-field rate caps. Generous on purpose: they must never reject a real
  // run (fastest weapon is ~14 rounds/s, pellets included), only catch scripts
  // that submit impossible throughput.
  if (raw.kills > raw.shots) {
    return { ok: false, error: 'inconsistent_run', message: 'kills 不能大于 shots（每杀至少消耗一发）' };
  }
  const killRateCap = Math.floor(raw.durationMs / 1000) * 4 + 8;
  if (raw.kills > killRateCap) {
    return {
      ok: false,
      error: 'inconsistent_run',
      message: `kills 相对时长过高（${raw.kills} 杀 > 上限 ${killRateCap}）`,
    };
  }
  const shotRateCap = Math.floor(raw.durationMs / 1000) * 20 + 40;
  if (raw.shots > shotRateCap) {
    return {
      ok: false,
      error: 'inconsistent_run',
      message: `shots 相对时长过高（${raw.shots} 发 > 上限 ${shotRateCap}）`,
    };
  }

  return {
    ok: true,
    mode: raw.mode,
    run: {
      runId: raw.runId,
      mode: raw.mode,
      score: raw.score,
      kills: raw.kills,
      wave: raw.wave,
      durationMs: raw.durationMs,
      headshots: raw.headshots,
      shots: raw.shots,
      hits: raw.hits,
      challengesDone: raw.challengesDone,
    },
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory token buckets)
// ---------------------------------------------------------------------------

const RATE_LIMITS = {
  read: { capacity: 120, refillPerSec: 120 / 60 },
  submit: { capacity: 6, refillPerSec: 6 / 60 },
};

function checkRate(ip, kind) {
  const limit = RATE_LIMITS[kind];
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = {};
    buckets.set(ip, bucket);
  }
  let state = bucket[kind];
  if (!state) {
    state = { tokens: limit.capacity, last: now };
    bucket[kind] = state;
  }

  const elapsed = Math.max(0, (now - state.last) / 1000);
  state.last = now;
  state.tokens = Math.min(limit.capacity, state.tokens + elapsed * limit.refillPerSec);

  if (state.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - state.tokens) / limit.refillPerSec));
    return { ok: false, retryAfter, remaining: 0 };
  }

  state.tokens -= 1;
  return { ok: true, remaining: Math.floor(state.tokens) };
}

const pruneBucketsTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    let last = 0;
    for (const kind of ['read', 'submit']) {
      if (bucket[kind] && bucket[kind].last > last) last = bucket[kind].last;
    }
    if (now - last > 10 * 60_000) buckets.delete(ip);
  }
}, 5 * 60_000);
if (typeof pruneBucketsTimer.unref === 'function') pruneBucketsTimer.unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function corsHeaders(origin) {
  if (!origin || !ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Id',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extraHeaders,
  });
  res.end(body);
}

function fail(res, status, error, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error, message }, extraHeaders);
}

function methodNotAllowed(res, allow, cors) {
  sendJson(
    res,
    405,
    { ok: false, error: 'method_not_allowed', message: '不支持的请求方法' },
    { ...cors, Allow: allow }
  );
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      resolve({ tooLarge: false, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      if (!tooLarge) resolve({ tooLarge: false, text: '' });
    });
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const origin = headerValue(req, 'origin');
  const cors = corsHeaders(origin);

  // Reject browser requests from origins that are not on the allowlist. Requests
  // without an Origin header (curl, server-to-server) are not authenticated by
  // this check and must never be treated as trusted.
  if (origin && !ORIGINS.has(origin)) {
    fail(res, 403, 'origin_not_allowed', '请求来源不在允许列表中', { Vary: 'Origin' });
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    fail(res, 400, 'bad_request', '请求地址无法解析', cors);
    return;
  }
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      Vary: 'Origin',
      ...cors,
    });
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    if (method !== 'GET') {
      methodNotAllowed(res, 'GET', cors);
      return;
    }
    const rate = checkRate(getClientIp(req), 'read');
    if (!rate.ok) {
      fail(res, 429, 'rate_limited', '读取请求过于频繁，请稍后再试', {
        ...cors,
        'Retry-After': String(rate.retryAfter),
        'X-RateLimit-Limit': '120',
        'X-RateLimit-Remaining': '0',
      });
      return;
    }
    sendJson(
      res,
      200,
      {
        ok: true,
        version: VERSION,
        uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        modes: [...MODES],
      },
      cors
    );
    return;
  }

  if (pathname === '/api/ticket') {
    if (method !== 'GET') {
      methodNotAllowed(res, 'GET', cors);
      return;
    }
    const rate = checkRate(getClientIp(req), 'read');
    if (!rate.ok) {
      fail(res, 429, 'rate_limited', '读取请求过于频繁，请稍后再试', {
        ...cors,
        'Retry-After': String(rate.retryAfter),
        'X-RateLimit-Limit': '120',
        'X-RateLimit-Remaining': '0',
      });
      return;
    }
    sendJson(res, 200, issueTicket(), cors);
    return;
  }

  if (pathname === '/api/board') {
    if (method !== 'GET') {
      methodNotAllowed(res, 'GET', cors);
      return;
    }
    const rate = checkRate(getClientIp(req), 'read');
    if (!rate.ok) {
      fail(res, 429, 'rate_limited', '读取请求过于频繁，请稍后再试', {
        ...cors,
        'Retry-After': String(rate.retryAfter),
        'X-RateLimit-Limit': '120',
        'X-RateLimit-Remaining': '0',
      });
      return;
    }

    const mode = url.searchParams.get('mode') || 'rotation';
    if (!MODES.includes(mode)) {
      fail(res, 400, 'bad_mode', 'mode 必须是 rotation/survival/defend/extract', cors);
      return;
    }

    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isInteger(rawLimit)
      ? Math.min(BOARD_MAX_LIMIT, Math.max(1, rawLimit))
      : BOARD_DEFAULT_LIMIT;

    // Pagination: offset is 0-based, 0..500. Anything else falls back to 0.
    const rawOffset = Number.parseInt(url.searchParams.get('offset') || '', 10);
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 500
      ? rawOffset
      : 0;

    const state = modes.get(mode);
    // Personal rank is optional and never authentication: an explicit `cid`
    // query wins (useful for viewing a specific operator's rank), otherwise the
    // caller's own X-Client-Id is used.
    const cid =
      sanitizeClientId(url.searchParams.get('cid')) ||
      sanitizeClientId(headerValue(req, 'x-client-id'));
    let rank = null;
    if (cid) {
      for (let i = 0; i < state.entries.length; i += 1) {
        if (state.entries[i].cid === cid) {
          rank = i + 1;
          break;
        }
      }
    }

    const total = state.entries.length;
    const top = rankedPage(state.entries, offset, limit);
    const nextOffset = offset + top.length < total ? offset + top.length : null;

    sendJson(
      res,
      200,
      {
        ok: true,
        mode,
        updatedAt: state.updatedAt,
        total,
        top,
        nextOffset,
        hasMore: nextOffset !== null,
        best: total > 0 ? publicEntry(state.entries[0]) : null,
        rank,
      },
      cors
    );
    return;
  }

  if (pathname === '/api/runs') {
    if (method !== 'POST') {
      methodNotAllowed(res, 'POST', cors);
      return;
    }

    const rate = checkRate(getClientIp(req), 'submit');
    if (!rate.ok) {
      fail(res, 429, 'rate_limited', '提交过于频繁，请稍后再试', {
        ...cors,
        'Retry-After': String(rate.retryAfter),
        'X-RateLimit-Limit': '6',
        'X-RateLimit-Remaining': '0',
      });
      return;
    }

    const declaredLength = Number.parseInt(headerValue(req, 'content-length'), 10);
    if (Number.isInteger(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      fail(res, 413, 'body_too_large', '请求体超过 8KB 上限', {
        ...cors,
        Connection: 'close',
      });
      return;
    }

    const bodyResult = await readBody(req, MAX_BODY_BYTES);
    if (bodyResult.tooLarge) {
      fail(res, 413, 'body_too_large', '请求体超过 8KB 上限', {
        ...cors,
        Connection: 'close',
      });
      return;
    }

    let body;
    try {
      body = JSON.parse(bodyResult.text);
    } catch {
      fail(res, 400, 'bad_json', '请求体不是合法 JSON', cors);
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, 'invalid_body', '请求体必须是 JSON 对象', cors);
      return;
    }

    const validation = validateRun(body.run);
    if (!validation.ok) {
      fail(res, 400, validation.error, validation.message, cors);
      return;
    }

    const ticketCheck = verifyTicket(body);
    if (!ticketCheck.ok) {
      fail(res, 400, ticketCheck.error, ticketCheck.message, cors);
      return;
    }

    const cid = sanitizeClientId(headerValue(req, 'x-client-id')) || 'anon';
    const name = sanitizeName(body.name);

    const { entry, rank } = upsertRun(validation.mode, cid, name, validation.run);
    const state = modes.get(validation.mode);
    const best = personalBest(validation.mode, cid);

    sendJson(
      res,
      200,
      {
        ok: true,
        rank,
        best: best ? publicEntry(best) : null,
        // The submission response still exposes only the first 10; ranks are
        // included for consistency with GET /api/board pages.
        top: rankedPage(state.entries, 0, POST_TOP_LIMIT),
      },
      cors
    );
    return;
  }

  fail(res, 404, 'not_found', '接口不存在', cors);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadStore();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(`[leaderboard] unhandled request error: ${error && error.stack ? error.stack : error}`);
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    const origin = headerValue(req, 'origin');
    const cors = corsHeaders(origin);
    fail(res, 500, 'internal', '服务内部错误', cors);
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.on('error', (error) => {
  console.error(`[leaderboard] server error: ${error.message}`);
  process.exitCode = 1;
});

server.on('clientError', (error, socket) => {
  if (!socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

server.listen(PORT, () => {
  console.log(
    `[leaderboard] listening on :${PORT} (version ${VERSION}, data: ${STORE_FILE}, ` +
    `origins: ${[...ORIGINS].join(', ') || 'none'})`
  );
  if (SECRET_IS_EPHEMERAL) {
    console.log('[leaderboard] secret is ephemeral for this process (set LB_SECRET in production)');
  }
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`[leaderboard] received ${signal}, flushing store and exiting`);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await flushSave();
  } catch {
    /* flushSave already logs */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
