/**
 * Browser-side leaderboard client for deepseek-of-duty.
 *
 * Design notes:
 * - Pure ESM, no dependencies, never throws: every failure resolves to
 *   `{ ok: false, ... }` so the game loop can degrade gracefully.
 * - The server is the source of truth when reachable. A localStorage mirror
 *   (up to 100 loaded entries, pages merged by runId) and an outbox (up to 20
 *   pending submissions) keep the feature usable offline.
 * - This module does NOT make the game cheat-proof. It only talks to the
 *   server described in server/README.md; the server itself is also not an
 *   authority on gameplay.
 */

export const LB_VERSION = 1;
export const LB_MODES = ['rotation', 'survival', 'defend', 'extract'];

const LS_CID = 'dod.cid.v1';
const LS_OUTBOX = 'dod.outbox.v1';
const LS_BOARD_PREFIX = 'dod.board.v1:';

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const MAX_SCORE = 2_000_000;
const MAX_KILLS = 5_000;
const MAX_WAVE = 200;
const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 21_600_000;
const MAX_SHOTS = 20_000;
const MAX_CHALLENGES = 10_000;

const OUTBOX_LIMIT = 20;
const CACHE_LIMIT = 100;

// Errors the server returns for a deterministic validation failure. Such a run
// is not retried, because retrying cannot make it valid.
const PERMANENT_REJECTIONS = new Set([
  'bad_mode',
  'bad_run',
  'bad_run_id',
  'bad_score',
  'bad_kills',
  'bad_wave',
  'bad_duration',
  'bad_headshots',
  'bad_shots',
  'bad_hits',
  'bad_challenges',
  'inconsistent_run',
  'bad_json',
  'invalid_body',
  'body_too_large',
  'bad_ticket',
  'bad_signature',
  'missing_ticket',
  'ticket_expired',
  'origin_not_allowed',
]);

// Ticket problems worth one fresh-ticket retry.
const TICKET_RETRY_ERRORS = new Set(['bad_ticket', 'ticket_expired']);

// ---------------------------------------------------------------------------
// Storage helpers (all best-effort; private mode / disabled storage must not
// break the game)
// ---------------------------------------------------------------------------

function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access can throw in some privacy modes */
  }
  return null;
}

function readJson(key, fallback) {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function resolveClientId(explicit) {
  if (typeof explicit === 'string') {
    const trimmed = explicit.trim();
    if (CLIENT_ID_RE.test(trimmed)) return trimmed;
  }

  const stored = readStoredClientId();
  if (stored) return stored;

  const generated = randomId().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  const safe = generated.length > 0 ? generated : `c-${Date.now().toString(36)}`;
  const store = storage();
  if (store) {
    try {
      store.setItem(LS_CID, safe); // raw string, not JSON
    } catch {
      /* storage may be unavailable */
    }
  }
  return safe;
}

function readStoredClientId() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(LS_CID);
    if (!raw) return null;
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      /* raw value was written by an older build */
    }
    const trimmed = String(value).trim();
    return CLIENT_ID_RE.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Field normalization
// ---------------------------------------------------------------------------

function normalizeMode(mode) {
  if (typeof mode !== 'string') return null;
  const value = mode.trim().toLowerCase();
  return LB_MODES.includes(value) ? value : null;
}

function clampLimit(limit) {
  const value = Math.trunc(Number(limit));
  if (!Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, value));
}

function clampOffset(offset) {
  const value = Number.parseInt(offset, 10);
  if (!Number.isInteger(value) || value < 0 || value > 500) return 0;
  return value;
}

function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

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

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const runId = typeof raw.runId === 'string' && RUN_ID_RE.test(raw.runId) ? raw.runId : null;
  if (!runId) return null;

  const score = raw.score;
  const kills = raw.kills;
  const wave = raw.wave;
  if (!isIntInRange(score, 0, MAX_SCORE)) return null;
  if (!isIntInRange(kills, 0, MAX_KILLS)) return null;
  if (!isIntInRange(wave, 1, MAX_WAVE)) return null;

  const tsNumber = Number(raw.ts);
  const ts = Number.isFinite(tsNumber) && tsNumber >= 0 ? Math.floor(tsNumber) : 0;
  const rank = isIntInRange(raw.rank, 1, Number.MAX_SAFE_INTEGER) ? raw.rank : null;

  return {
    name: sanitizeName(raw.name),
    score,
    kills,
    wave,
    ts,
    runId,
    rank,
  };
}

function normalizeEntries(rawList) {
  if (!Array.isArray(rawList)) return [];
  const entries = [];
  for (const raw of rawList) {
    const entry = normalizeEntry(raw);
    if (entry) entries.push(entry);
  }
  entries.sort(compareEntries);
  return entries;
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.kills !== a.kills) return b.kills - a.kills;
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

function dedupeByRunId(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.runId)) continue;
    seen.add(entry.runId);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local mirror and outbox
// ---------------------------------------------------------------------------

function boardKey(mode) {
  return `${LS_BOARD_PREFIX}${mode}`;
}

function readCache(mode) {
  const normalized = normalizeMode(mode);
  if (!normalized) return [];
  const raw = readJson(boardKey(normalized), []);
  return normalizeEntries(raw).slice(0, CACHE_LIMIT);
}

function writeCache(mode, entries) {
  const normalized = normalizeMode(mode);
  if (!normalized) return;
  writeJson(boardKey(normalized), normalizeEntries(entries).slice(0, CACHE_LIMIT));
}

function mergeCache(mode, freshEntries) {
  const normalized = normalizeMode(mode);
  if (!normalized) return;
  const merged = dedupeByRunId(
    normalizeEntries([...normalizeEntries(freshEntries), ...readCache(normalized)])
  );
  writeCache(normalized, merged.slice(0, CACHE_LIMIT));
}

function normalizeQueuedItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prepared = prepareRun(raw.run, raw.name, { allowGenerateRunId: false });
  if (!prepared.ok) return null;
  return prepared.value;
}

function readOutbox() {
  const raw = readJson(LS_OUTBOX, []);
  if (!Array.isArray(raw)) return [];
  const items = [];
  const seen = new Set();
  for (const candidate of raw) {
    const item = normalizeQueuedItem(candidate);
    if (!item) continue;
    if (seen.has(item.run.runId)) continue;
    seen.add(item.run.runId);
    items.push(item);
    if (items.length >= OUTBOX_LIMIT) break;
  }
  return items;
}

function writeOutbox(items) {
  const trimmed = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || seen.has(item.run.runId)) continue;
    seen.add(item.run.runId);
    trimmed.push(item);
  }
  while (trimmed.length > OUTBOX_LIMIT) trimmed.shift();
  writeJson(LS_OUTBOX, trimmed);
}

function enqueue(item) {
  const items = readOutbox();
  const index = items.findIndex((existing) => existing.run.runId === item.run.runId);
  if (index >= 0) items[index] = item;
  else items.push(item);
  writeOutbox(items);
}

function dequeue(runId) {
  writeOutbox(readOutbox().filter((item) => item.run.runId !== runId));
}

// ---------------------------------------------------------------------------
// Run preparation / validation (mirrors the server's rules to fail fast)
// ---------------------------------------------------------------------------

function prepareRun(run, name, { allowGenerateRunId = true } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return { ok: false, error: 'bad_run' };
  }

  const mode = normalizeMode(run.mode);
  if (!mode) return { ok: false, error: 'bad_mode' };

  let runId;
  if (run.runId === undefined || run.runId === null || run.runId === '') {
    if (!allowGenerateRunId) return { ok: false, error: 'bad_run_id' };
    runId = randomId();
  } else if (typeof run.runId === 'string' && RUN_ID_RE.test(run.runId)) {
    runId = run.runId;
  } else {
    return { ok: false, error: 'bad_run_id' };
  }

  const score = run.score;
  const kills = run.kills;
  const wave = run.wave === undefined || run.wave === null ? 1 : run.wave;
  const durationMs = run.durationMs;
  const headshots = run.headshots === undefined || run.headshots === null ? 0 : run.headshots;
  const shots = run.shots === undefined || run.shots === null ? 0 : run.shots;
  const hits = run.hits === undefined || run.hits === null ? 0 : run.hits;
  const challengesDone = run.challengesDone === undefined || run.challengesDone === null
    ? 0
    : run.challengesDone;

  // Daily-claim binding: the server honours the daily bonus only when the
  // claimed day is the server's current day in the client's timezone. The
  // client states which day it claims; a changed system clock therefore
  // cannot buy a fresh daily pool.
  const dailyDate = typeof run.dailyDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(run.dailyDate)
    ? run.dailyDate
    : undefined;
  const dailyTzMin = Number.isInteger(run.dailyTzMin) && run.dailyTzMin >= -720 && run.dailyTzMin <= 840
    ? run.dailyTzMin
    : undefined;
  const scoreBase = Number.isInteger(run.scoreBase) && run.scoreBase >= 0 && run.scoreBase <= score
    ? run.scoreBase
    : undefined;

  if (!isIntInRange(score, 0, MAX_SCORE)) return { ok: false, error: 'bad_score' };
  if (!isIntInRange(kills, 0, MAX_KILLS)) return { ok: false, error: 'bad_kills' };
  if (!isIntInRange(wave, 1, MAX_WAVE)) return { ok: false, error: 'bad_wave' };
  if (!isIntInRange(durationMs, MIN_DURATION_MS, MAX_DURATION_MS)) {
    return { ok: false, error: 'bad_duration' };
  }
  if (!isIntInRange(headshots, 0, MAX_KILLS)) return { ok: false, error: 'bad_headshots' };
  if (!isIntInRange(shots, 0, MAX_SHOTS)) return { ok: false, error: 'bad_shots' };
  if (!isIntInRange(hits, 0, MAX_SHOTS)) return { ok: false, error: 'bad_hits' };
  if (!isIntInRange(challengesDone, 0, MAX_CHALLENGES)) {
    return { ok: false, error: 'bad_challenges' };
  }

  if (headshots > kills) return { ok: false, error: 'bad_headshots' };
  if (hits > shots) return { ok: false, error: 'bad_hits' };
  if (kills * 50 > score + 250) return { ok: false, error: 'inconsistent_run' };
  if (score > kills * 300 + wave * 250 + 5000) return { ok: false, error: 'inconsistent_run' };
  if (wave > kills + 3) return { ok: false, error: 'inconsistent_run' };
  const minDuration = Math.max(MIN_DURATION_MS, (wave - 1) * 6000);
  if (durationMs < minDuration) return { ok: false, error: 'inconsistent_run' };

  return {
    ok: true,
    value: {
      name: sanitizeName(name),
      run: {
        runId,
        mode,
        score,
        kills,
        wave,
        durationMs,
        headshots,
        shots,
        hits,
        challengesDone,
        dailyDate,
        dailyTzMin,
        scoreBase,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLeaderboard({ baseUrl = '/api', clientId, timeoutMs = 2500 } = {}) {
  const cid = resolveClientId(clientId);
  let netStatus = 'unknown'; // 'online' | 'offline' | 'unknown'
  let flushing = null;

  function isOffline() {
    try {
      return typeof navigator !== 'undefined' && navigator.onLine === false;
    } catch {
      return false;
    }
  }

  function joinUrl(base, path) {
    const left = String(base === undefined || base === null ? '' : base).replace(/\/+$/, '');
    const right = String(path || '').replace(/^\/+/, '');
    return left ? `${left}/${right}` : `/${right}`;
  }

  function setOffline() {
    netStatus = 'offline';
  }

  async function callApi(path, { method = 'GET', body = null } = {}) {
    if (isOffline()) {
      setOffline();
      return { ok: false, status: 0, error: 'offline' };
    }
    if (typeof fetch !== 'function') {
      return { ok: false, status: 0, error: 'no_fetch' };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const headers = {
        Accept: 'application/json',
        'X-Client-Id': cid,
      };
      if (body !== null) headers['Content-Type'] = 'application/json';

      const response = await fetch(joinUrl(baseUrl, path), {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        netStatus = 'online'; // the server answered, even if it rejected the call
        const code = data && typeof data.error === 'string' && data.error
          ? data.error
          : `http_${response.status}`;
        return { ok: false, status: response.status, error: code, data };
      }

      if (!data || typeof data !== 'object') {
        netStatus = 'online';
        return { ok: false, status: response.status, error: 'bad_response', data: null };
      }

      if (data.ok === false) {
        netStatus = 'online';
        return {
          ok: false,
          status: response.status,
          error: typeof data.error === 'string' && data.error ? data.error : 'server_error',
          data,
        };
      }

      netStatus = 'online';
      return { ok: true, status: response.status, error: null, data };
    } catch (error) {
      setOffline();
      const aborted = error && (error.name === 'AbortError' || error.code === 20);
      return { ok: false, status: 0, error: aborted ? 'timeout' : 'network' };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async function fetchBoard(mode, limit = 20, cid = null, offset = 0) {
    const normalized = normalizeMode(mode);
    const requested = clampLimit(limit);
    const safeOffset = clampOffset(offset);

    if (!normalized) {
      return {
        ok: false,
        source: 'local',
        entries: [],
        rank: null,
        updatedAt: null,
        total: 0,
        nextOffset: null,
        hasMore: false,
        error: 'bad_mode',
      };
    }

    const requestedCid = typeof cid === 'string' && CLIENT_ID_RE.test(cid.trim())
      ? cid.trim()
      : null;

    try {
      // The caller asks for one page. An explicit cid (or the X-Client-Id
      // header) lets the server attach the caller's personal rank; it is not
      // authentication.
      const cidQuery = requestedCid ? `&cid=${encodeURIComponent(requestedCid)}` : '';
      const response = await callApi(
        `board?mode=${encodeURIComponent(normalized)}` +
        `&limit=${requested}&offset=${safeOffset}${cidQuery}`
      );

      if (response.ok) {
        const entries = normalizeEntries(response.data.top).slice(0, requested);
        const updatedAt = typeof response.data.updatedAt === 'string'
          ? response.data.updatedAt
          : null;
        const rank = Number.isInteger(response.data.rank) ? response.data.rank : null;
        const total = Number.isInteger(response.data.total) && response.data.total >= 0
          ? response.data.total
          : safeOffset + entries.length;
        const nextOffset = Number.isInteger(response.data.nextOffset) &&
          response.data.nextOffset >= 0
          ? response.data.nextOffset
          : null;
        const hasMore = typeof response.data.hasMore === 'boolean'
          ? response.data.hasMore
          : nextOffset !== null;

        // First page replaces the mirror; later pages are merged so an offline
        // reload still shows every page the user has already scrolled through.
        if (safeOffset === 0) {
          writeCache(normalized, entries);
        } else if (entries.length > 0) {
          mergeCache(normalized, entries);
        }

        return {
          ok: true,
          source: 'online',
          entries,
          rank,
          updatedAt,
          total,
          nextOffset,
          hasMore,
          error: null,
        };
      }

      const cached = readCache(normalized);
      return {
        ok: false,
        source: cached.length > 0 ? 'cache' : 'local',
        entries: cached.slice(safeOffset, safeOffset + requested),
        rank: null,
        updatedAt: null,
        total: cached.length,
        nextOffset: null,
        hasMore: false,
        error: response.error || 'offline',
      };
    } catch {
      const cached = readCache(normalized);
      return {
        ok: false,
        source: cached.length > 0 ? 'cache' : 'local',
        entries: cached.slice(safeOffset, safeOffset + requested),
        rank: null,
        updatedAt: null,
        total: cached.length,
        nextOffset: null,
        hasMore: false,
        error: 'internal',
      };
    }
  }

  async function submitOnce(item) {
    const ticketResponse = await callApi('ticket');
    if (!ticketResponse.ok) {
      return {
        ok: false,
        status: ticketResponse.status || 0,
        error: ticketResponse.error || 'ticket_failed',
      };
    }

    const ticket = ticketResponse.data;
    if (
      !ticket ||
      typeof ticket.ticket !== 'string' ||
      !Number.isInteger(ticket.issuedAt) ||
      typeof ticket.sig !== 'string'
    ) {
      return { ok: false, status: 0, error: 'bad_ticket' };
    }

    const response = await callApi('runs', {
      method: 'POST',
      body: {
        ticket: ticket.ticket,
        issuedAt: ticket.issuedAt,
        sig: ticket.sig,
        name: item.name,
        run: item.run,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status || 0,
        error: response.error || 'submit_failed',
      };
    }

    return { ok: true, status: response.status, data: response.data, error: null };
  }

  function queueResult(item, error) {
    return {
      ok: false,
      source: 'local',
      rank: null,
      best: null,
      top: readCache(item.run.mode),
      error: error || 'offline',
    };
  }

  async function submitRun(run, name) {
    const prepared = prepareRun(run, name);
    if (!prepared.ok) {
      const mode = normalizeMode(run && run.mode);
      return {
        ok: false,
        source: 'local',
        rank: null,
        best: null,
        top: mode ? readCache(mode) : [],
        error: prepared.error,
      };
    }

    const item = prepared.value;

    try {
      if (isOffline()) {
        setOffline();
        enqueue(item);
        return queueResult(item, 'offline');
      }

      let response = await submitOnce(item);
      if (!response.ok && TICKET_RETRY_ERRORS.has(response.error)) {
        response = await submitOnce(item); // fresh ticket, same runId (idempotent)
      }

      if (response.ok) {
        dequeue(item.run.runId);
        const data = response.data || {};
        const top = normalizeEntries(data.top).slice(0, CACHE_LIMIT);
        const best = normalizeEntry(data.best);
        const rank = Number.isInteger(data.rank) ? data.rank : null;
        mergeCache(item.run.mode, top);
        return {
          ok: true,
          source: 'online',
          rank,
          best,
          top,
          error: null,
        };
      }

      // A deterministic validation/ticket rejection will never succeed on
      // retry, so it is reported immediately instead of poisoning the outbox.
      if (PERMANENT_REJECTIONS.has(response.error)) {
        dequeue(item.run.runId);
        return {
          ok: false,
          source: 'online',
          rank: null,
          best: null,
          top: readCache(item.run.mode),
          error: response.error,
        };
      }

      // Network failure, timeout, 5xx, 404 (API not deployed), 429, etc.
      enqueue(item);
      return queueResult(item, response.error || 'offline');
    } catch {
      try {
        enqueue(item);
      } catch {
        /* storage may be unavailable; still never throw */
      }
      return queueResult(item, 'internal');
    }
  }

  function getLocalBoard(mode) {
    try {
      return readCache(mode).map((entry) => ({ ...entry }));
    } catch {
      return [];
    }
  }

  async function flushOne(item) {
    let response = await submitOnce(item);
    if (!response.ok && TICKET_RETRY_ERRORS.has(response.error)) {
      response = await submitOnce(item);
    }
    return response;
  }

  function flushOutbox() {
    if (flushing) return flushing;

    flushing = (async () => {
      let sent = 0;
      let dropped = 0;
      try {
        if (isOffline()) {
          setOffline();
          return { sent, dropped };
        }

        const queue = readOutbox();
        for (const item of queue) {
          let response;
          try {
            response = await flushOne(item);
          } catch {
            break; // unexpected error: keep the remaining queue for next time
          }

          if (response.ok) {
            sent += 1;
            dequeue(item.run.runId);
            mergeCache(item.run.mode, normalizeEntries(response.data && response.data.top));
            continue;
          }

          if (PERMANENT_REJECTIONS.has(response.error)) {
            dropped += 1;
            dequeue(item.run.runId);
            continue;
          }

          // Network/timeout/429/5xx/404: stop early and keep the outbox.
          break;
        }
      } catch {
        // Storage may be unavailable or an unexpected error may occur. The
        // queue is left as-is; flushOutbox must never reject.
      }

      return { sent, dropped };
    })().finally(() => {
      flushing = null;
    });

    return flushing;
  }

  return {
    fetchBoard,
    submitRun,
    getLocalBoard,
    flushOutbox,
    get status() {
      if (isOffline()) return 'offline';
      return netStatus;
    },
    get clientId() {
      return cid;
    },
    /** submissions waiting for the API to come back (offline outbox) */
    get pending() {
      try { return readOutbox().length; } catch { return 0; }
    },
  };
}

// ---------------------------------------------------------------------------
// Utility export used by callers that want the same name rules locally
// ---------------------------------------------------------------------------

export function normalizeLeaderboardName(raw) {
  return sanitizeName(raw);
}
