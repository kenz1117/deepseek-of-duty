/* =========================================================================
   Operator profile, run statistics and daily challenges.

   Everything here is localStorage-backed and framework-free so both the
   menu and the HUD can read it without importing the game loop. The online
   leaderboard lives in src/net/leaderboard.js; this module only produces the
   run payload and the "what did I achieve today" state.

   Storage keys
     dod.profile.v1     lifetime totals + best run per mode
     dod.callsign.v1    the name shown on the board
     dod.challenges.v1  { 'YYYY-MM-DD': { p: {}, done: {}, tier } }
   ========================================================================= */

export const PROFILE_KEY = 'dod.profile.v1';
export const CALLSIGN_KEY = 'dod.callsign.v1';
export const CHALLENGE_KEY = 'dod.challenges.v1';

/** kept local so this module never depends on the network layer */
export const RUN_MODES = ['rotation', 'survival', 'defend', 'extract'];

/* ------------------------------------------------------------------ utils */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
}

function int(v, d = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
}

/** local calendar day, not UTC: a challenge day should roll over at midnight */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** stable string → uint32 hash (FNV-1a) so a day always seeds the same goals */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------- profile */

function emptyProfile() {
  return {
    v: 1,
    totals: { kills: 0, headshots: 0, grenadeKills: 0, waves: 0, runs: 0, objectiveWins: 0, destructibles: 0, playMs: 0 },
    best: {},       // mode -> { score, kills, wave, ts, headshots, runId }
    lastRun: null,
  };
}

function sanitizeProfile(raw) {
  const p = emptyProfile();
  if (!raw || typeof raw !== 'object') return p;
  const t = raw.totals && typeof raw.totals === 'object' ? raw.totals : {};
  for (const k of Object.keys(p.totals)) p.totals[k] = Math.max(0, int(t[k]));
  if (raw.best && typeof raw.best === 'object') {
    for (const mode of RUN_MODES) {
      const b = raw.best[mode];
      if (!b || typeof b !== 'object') continue;
      p.best[mode] = {
        score: Math.max(0, int(b.score)),
        kills: Math.max(0, int(b.kills)),
        wave: Math.max(1, int(b.wave, 1)),
        headshots: Math.max(0, int(b.headshots)),
        ts: Math.max(0, int(b.ts)),
        runId: typeof b.runId === 'string' ? b.runId.slice(0, 64) : '',
      };
    }
  }
  if (raw.lastRun && typeof raw.lastRun === 'object') p.lastRun = raw.lastRun;
  return p;
}

export function loadProfile() {
  return sanitizeProfile(readJSON(PROFILE_KEY, null));
}

export function saveProfile(p) {
  return writeJSON(PROFILE_KEY, p);
}

export function bestFor(mode) {
  const p = loadProfile();
  return p.best[mode] || null;
}

/** Fold a finished run into lifetime totals and per-mode bests. */
export function recordRun(run, { mode = run.mode } = {}) {
  const p = loadProfile();
  const t = p.totals;
  t.kills += int(run.kills);
  t.headshots += int(run.headshots);
  t.grenadeKills += int(run.grenadeKills);
  t.waves += Math.max(0, int(run.wave) - 1);
  t.runs += 1;
  t.destructibles += int(run.destructibles);
  t.playMs += Math.max(0, int(run.durationMs));
  if (run.objectiveCleared) t.objectiveWins += 1;

  const prev = p.best[mode] || null;
  // a 0-score first run is not a "record"; only a real score can beat the board
  const isBest = int(run.score) > (prev ? prev.score : 0);
  if (isBest) {
    p.best[mode] = {
      score: Math.max(0, int(run.score)),
      kills: Math.max(0, int(run.kills)),
      wave: Math.max(1, int(run.wave, 1)),
      headshots: Math.max(0, int(run.headshots)),
      ts: Date.now(),
      runId: typeof run.runId === 'string' ? run.runId : '',
    };
  }
  p.lastRun = {
    mode, score: int(run.score), kills: int(run.kills),
    wave: int(run.wave, 1), ts: Date.now(),
  };
  saveProfile(p);
  return { isBest, prevBest: prev ? prev.score : 0, profile: p };
}

/* ------------------------------------------------------------- callsign */

const CALLSIGN_RE = /^[\p{L}\p{N} _.\-]{1,12}$/u;

export function defaultCallsign() {
  let cid = '';
  try { cid = localStorage.getItem('dod.cid.v1') || ''; } catch (e) { /* ignore */ }
  // keep the generated callsign inside the 12-character board limit
  const tail = (cid.replace(/[^a-z0-9]/gi, '').slice(-3) || '000').toUpperCase();
  return `OPERATOR-${tail}`;
}

export function loadCallsign() {
  try {
    const v = localStorage.getItem(CALLSIGN_KEY);
    return v && CALLSIGN_RE.test(v) ? v : defaultCallsign();
  } catch (e) {
    return 'OPERATOR';
  }
}

export function saveCallsign(name) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f<>{}]/g, '').trim();
  const value = CALLSIGN_RE.test(clean) ? clean : '';
  try {
    if (value) localStorage.setItem(CALLSIGN_KEY, value);
    return value;
  } catch (e) {
    return '';
  }
}

/* ------------------------------------------------------------- run stats */

/**
 * Mutable per-run counters. main.js owns one instance per run and reads it
 * when the operator dies; nothing in here touches the DOM.
 */
export function createRunStats(mode = 'rotation') {
  return {
    mode,
    startedAt: Date.now(),
    kills: 0,
    headshots: 0,
    grenadeKills: 0,
    shots: 0,
    hits: 0,
    damageDealt: 0,
    wavesCleared: 0,
    flawlessWaves: 0,
    destructibles: 0,
    objectiveCleared: false,
    damagedThisWave: false,
    destroyedIds: new Set(),
    runId: makeRunId(),
  };
}

export function makeRunId() {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Snapshot the counters into the shape the leaderboard accepts. */
export function runPayload(stats, overrides = {}) {
  // the board refuses sub-5s runs; a fast death is still a real run, so floor it
  const durationMs = Math.max(5000, Date.now() - stats.startedAt);
  return {
    runId: stats.runId,
    mode: overrides.mode || stats.mode,
    score: Math.max(0, int(overrides.score)),
    kills: Math.max(0, int(stats.kills)),
    wave: Math.max(1, int(overrides.wave, 1)),
    durationMs,
    headshots: Math.max(0, int(stats.headshots)),
    grenadeKills: Math.max(0, int(stats.grenadeKills)),
    shots: Math.max(0, int(stats.shots)),
    hits: Math.max(0, int(stats.hits)),
    challengesDone: Math.max(0, int(overrides.challengesDone)),
    // Daily-claim binding. The server only honours the daily bonus when the
    // claimed day is the server's current day in `dailyTzMin`; otherwise it
    // voids the bonus and falls back to `scoreBase` (the score without the
    // daily multiplier). A changed system clock therefore buys nothing.
    dailyDate: typeof overrides.dailyDate === 'string' ? overrides.dailyDate : undefined,
    dailyTzMin: Number.isInteger(overrides.dailyTzMin) ? overrides.dailyTzMin : undefined,
    scoreBase: Number.isInteger(overrides.scoreBase) ? Math.max(0, overrides.scoreBase) : undefined,
  };
}

/* -------------------------------------------------------- daily challenges */

const POOL = [
  { id: 'headshots',    stat: 'headshots',    mode: 'sum', goal: 12, title: '精准打击', desc: '累计爆头 12 次' },
  { id: 'grenade',      stat: 'grenadeKills', mode: 'sum', goal: 5,  title: '投掷专家', desc: '用手雷击杀 5 名敌人' },
  { id: 'flawless',     stat: 'flawlessWaves',mode: 'sum', goal: 3,  title: '零失误',   desc: '无伤清空 3 个波次' },
  { id: 'kills',        stat: 'kills',        mode: 'sum', goal: 45, title: '清剿行动', desc: '累计击杀 45 名敌人' },
  { id: 'score',        stat: 'score',        mode: 'max', goal: 9000, title: '高分行动', desc: '单局得分达到 9000' },
  { id: 'objective',    stat: 'objectiveWins',mode: 'sum', goal: 2,  title: '目标至上', desc: '完成 2 次目标模式' },
  { id: 'demolition',   stat: 'destructibles',mode: 'sum', goal: 4,  title: '拆除作业', desc: '摧毁 4 个可破坏掩体' },
];

/** Deterministic 3-goal set per local day. */
export function dailyDefs(dateKey = todayKey()) {
  const rnd = rngFrom(hashString(dateKey));
  const pool = POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3).map((c) => ({ ...c }));
}

function sanitizeDaily(raw, defs) {
  const out = { p: {}, done: {}, tier: 0 };
  if (raw && typeof raw === 'object') {
    for (const def of defs) {
      const value = int(raw.p && raw.p[def.id]);
      out.p[def.id] = Math.max(0, Math.min(def.mode === 'max' ? 1e9 : 1e6, value));
      out.done[def.id] = !!(raw.done && raw.done[def.id]) || out.p[def.id] >= def.goal;
    }
    out.tier = Math.max(0, Math.min(3, int(raw.tier)));
  }
  return out;
}

export function loadDaily(dateKey = todayKey()) {
  const all = readJSON(CHALLENGE_KEY, {});
  const defs = dailyDefs(dateKey);
  const state = sanitizeDaily(all[dateKey], defs);
  return { date: dateKey, defs, ...state };
}

function persistDaily(state) {
  const all = readJSON(CHALLENGE_KEY, {});
  all[state.date] = { p: state.p, done: state.done, tier: state.tier };
  // keep a week of history so a rollback of the clock cannot grow forever
  const keys = Object.keys(all).sort();
  while (keys.length > 8) delete all[keys.shift()];
  writeJSON(CHALLENGE_KEY, all);
}

/** Add run progress; returns { state, completed:[ids] } for toasts/UI. */
export function applyDailyProgress(state, runStats) {
  const completed = [];
  for (const def of state.defs) {
    const add = int(runStats[def.stat]);
    if (!add) continue;
    const before = state.p[def.id] || 0;
    const value = def.mode === 'max' ? Math.max(before, add) : before + add;
    state.p[def.id] = Math.min(value, def.goal);
    if (!state.done[def.id] && state.p[def.id] >= def.goal) {
      state.done[def.id] = true;
      completed.push(def.id);
    }
  }
  state.tier = Object.values(state.done).filter(Boolean).length;
  persistDaily(state);
  return { state, completed };
}

export function dailySummary(state) {
  const total = state.defs.length;
  const done = state.defs.filter((d) => state.done[d.id]).length;
  return { total, done, tier: Math.min(3, done) };
}

/** Perks applied at the start of a run, earned by clearing goals today. */
export function dailyPerks(dateKey = todayKey()) {
  const state = loadDaily(dateKey);
  const { done } = dailySummary(state);
  return {
    grenades: done >= 1 ? 1 : 0,
    armor: done >= 2 ? 20 : 0,
    scoreMult: done >= 3 ? 1.1 : 1,
    done,
  };
}
