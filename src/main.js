import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { GAME_VERSION } from './core/version.js';
import { createLevel } from './world/level.js';
import { createViewmodel } from './player/viewmodel.js';
import { createFX } from './fx/fx.js';
import { createAudio } from './core/audio.js';
import { createHUD } from './ui/hud.js';
import { createInput } from './core/input.js';
import { createController } from './player/controller.js';
import { Enemy } from './entities/enemy.js';
import { loadSettings, saveSettings, sanitizeSettings, tutorialDone, markTutorialDone, prestartSkipped, setPrestartSkipped, DEFAULT_SETTINGS } from './core/settings.js';
import { createRunStats, runPayload, recordRun, applyDailyProgress, loadDaily, dailySummary, dailyPerks, todayKey, loadCallsign, saveCallsign, bestFor } from './core/profile.js';
import { createPickups } from './world/pickups.js';
import { createStreaks } from './systems/streaks.js';
import { createMilestones, stepLabel } from './systems/milestones.js';
import { createZone } from './systems/zone.js';
import {
  createSpawnDirector, zonesWithinRect, pickNeutralSpawns,
  assignCoopRallySpot, SPAWN_RULES, makeRng, hashSeed,
} from './systems/spawn.js';
import { profileFor } from './systems/ai/profiles.js';
import { DIFF_TIERS, diffForWave, MAX_FIRING_CEILING } from './systems/ai/tiers.js';
import { WEAPONS } from './core/weapons.js';
import { segmentBlockedByColliders } from './systems/ai/geom.js';
import { createTeamBrain } from './systems/ai/teamBrain.js';
import { createInventory, ITEMS } from './systems/inventory.js';
import { createArtillery } from './systems/artillery.js';
import { createLeaderboard } from './net/leaderboard.js';
import { createNavGrid } from './systems/navgrid.js';
import { createLanLobby } from './ui/lanLobby.js';
import { createWorldLabels } from './ui/worldLabels.js';
import { createLanClient } from './net/lanClient.js';
import { createNetAvatar } from './entities/netRemote.js';
import { Perception } from './systems/ai/perception.js';
import { AIDirector } from './systems/ai/director.js';
import { createBarks } from './systems/barks.js';
import { createWeatherSystem, WEATHER_ORDER } from './systems/weather.js';
import { createEnemyEquipment } from './systems/ai/equipment.js';
import { createCinema } from './cinema.js';
import { createVoice } from './voice.js';
import { createVideoIntro } from './videointro.js';
import { createMinimap } from './ui/minimap.js';
import { createInteract } from './systems/interact.js';
import { renderControls } from './ui/controls.js';
import { CHARACTERS, INTEL, loadCodex, saveCodex, characterUnlocked } from './codex.js';
import { createIntel } from './systems/intel.js';
import { createMoth } from './entities/moth.js';
import { loadMothGlb, createMothFromGlb } from './entities/mothModel.js';
import { createResults, renderDailyList, renderMenuBoard } from './ui/results.js';
import {
  OPERATIONS, operationById, isUnlocked, loadCampaign, saveCampaign,
  completeOperation as markOperationDone,
  saveBeatCheckpoint, loadBeatCheckpoint, clearBeatCheckpoint,
} from './story.js';
import {
  beatForWave, beatMode, beatObjective, beatComplete, beatEnemyCount, operationWaves,
  BEAT_OBJECTIVE_TYPES,
} from './systems/beats.js';
import {
  createDownedRegistry, DOWN_BLEED_S, REVIVE_RANGE_M, REVIVE_HOLD_S, REVIVE_HP_FRAC, WIPE_RESPAWN_S,
} from './systems/medical.js';
import {
  createConquest, botRubberBand, pickRespawnPoint, CONQUEST,
} from './systems/conquest.js';
import { createFixedStepper } from './core/timing.js';
import { isNewerSnapshot, validFirePacket, validMovementPacket } from './net/guards.js';

/* =========================================================================
   DEEPSEEK OF DUTY — browser vertical slice.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const SHOT_MODE = params.get('shot') === '1';
const CINE_MODE = params.get('cine') === '1';
const POSE = params.get('pose') || 'hero';
const HIDE_HUD = params.get('hidehud') === '1';


/* Recoil pattern: the first shots kick hardest, then the climb settles into a
   small repeatable pattern with alternating horizontal drift. Values are camera
   degrees; controller.kick() takes an angular impulse, and DEG_TO_KICK was
   measured against the spring (190 / 17) so a value of 0.3 really is about
   0.3 degrees of climb. */
const RECOIL_UP = [0.26, 0.33, 0.37, 0.39, 0.40, 0.40, 0.39, 0.38];
const RECOIL_SIDE = [0.02, -0.05, 0.08, -0.10, 0.11, -0.11, 0.09, -0.08];
const RECOIL_RESET_MS = 320;
const DEG_TO_KICK = 0.50;
const ADS_RECOIL = 0.60;
const MOVE_SPREAD = 0.60;   // was 1.4 => 2.4x spread while moving, now 1.6x

const campaign = loadCampaign();

/* Playlist/LAN site rotation: free runs are not locked to the central street. */
const MAP_SITES = [
  {
    id: 'street', name: 'AL-MAZRAH 街区', en: 'STREET',
    x: 1.2, z: 33, yaw: -0.03,
    rect: { x0: -28, x1: 44, z0: -28, z1: 82 },
    zone: { x: 0, z: 14, r: 8 },
  },
  {
    id: 'souk', name: '老城集市', en: 'OLD SOUK',
    x: -96, z: 46, yaw: 1.7,
    rect: { x0: -116, x1: -40, z0: -42, z1: 72 },
    zone: { x: -74, z: 12, r: 6 },
  },
  {
    id: 'rail', name: '北站货场', en: 'RAIL DEPOT',
    x: 0, z: -165, yaw: Math.PI,
    rect: { x0: -38, x1: 42, z0: -194, z1: -106 },
    zone: { x: 4, z: -150, r: 7 },
  },
  {
    id: 'port', name: '东港集装箱场', en: 'CONTAINER YARD',
    x: 80, z: -80, yaw: 3.7,
    rect: { x0: 48, x1: 122, z0: -98, z1: 34 },
    zone: { x: 98, z: -44, r: 6 },
  },
];
let playlistSiteCursor = Math.floor(Math.random() * MAP_SITES.length);

function nextPlaylistSite() {
  const site = MAP_SITES[playlistSiteCursor % MAP_SITES.length];
  playlistSiteCursor = (playlistSiteCursor + 1) % MAP_SITES.length;
  return site;
}

function siteById(id) {
  return MAP_SITES.find((s) => s.id === id) || MAP_SITES[0];
}
let campaignActive = false;

const G = {
  state: 'loading',
  hp: 100, maxHp: 100, armor: 60, maxArmor: 60,
  score: 0, kills: 0, wave: 1, waveRemaining: 0, waveTotal: 0,
  spawnQueue: [], spawnTimer: 0, waveClearTimer: 0,
  time: 0, sinceDamage: 99,
  weaponIndex: 0, mag: 30, reserve: 180,
  weaponAmmo: [{ mag: 30, reserve: 180 }, { mag: 25, reserve: 150 }, { mag: 6, reserve: 30 }, { mag: 0, reserve: 0 }],
  lastWeapon: 1, switchT: 0, switchTo: 0, switchApplied: false, unlockedShotgun: false,
  fps: 60,
  reloadTimer: -1, reloadTransferred: false, reloadShells: 0,
  fireCooldown: 0, grenades: 2,
  firing: false, shotFired: false,
  recoilIndex: 0, lastShotAt: -1e9,
  tut: { reloads: 0, grenades: 0, swaps: 0, minimap: 0, interacts: 0, jumps: 0 },
  freezeEnemies: false, debugWaves: false, hitStop: 0, lockHint: false, debugAutoFire: false, flashA: 0,
  readyFrames: 0, ready: false,
  hurtTimer: 0,
  settings: { ...DEFAULT_SETTINGS },
  upgrades: { damage: 1, fireRate: 1, mag: 1, speed: 0, regen: 1, grenades: 0, health: 0 },
  upgradeCards: [], upgradeShown: false,
  tutorial: { active: false, step: 0, t: 0, stepT: 0, done: false, lastX: 0, lastZ: 0 },
  shotsFired: 0, regenRate: 26, atmosphere: 'dusk',
  mode: 'survival', objective: null, operation: null, boss: null,
  /** beat boss entered the field (beat-driven ops); gates boss-beat completion */
  bossBeatSpawned: false,
  // Versus master switch. false in co-op; when true, teams exist, friendly
  // fire is filtered, breach/equipment AI subsystems are disabled (their
  // single-target assumptions do not hold) and the safe zone runs. Turning it
  // off restores the PvE behaviour exactly.
  versusMode: false,
  versusGraceT: 0,
  versusGraceNotified: false,
  // Set by endVersusMatch: blocks scoring, respawns, AI fire and PvP damage
  // once the match is decided. Cleared by resetGame()/restartVersus*.
  versusOver: false,
  teamScores: [0, 0],
  ffaWinner: null, ffaResultShown: false,
  // Sprint D: run counters, streak rewards, UAV window, score multiplier
  stats: null, scoreMult: 1, uavUntil: 0, uavTick: 0,
  // Score WITHOUT the daily-challenge multiplier. The leaderboard server
  // falls back to this number when it voids a daily bonus (claimed day ≠ the
  // server's day), so a changed system clock cannot inflate the score.
  scoreBase: 0,
  // Phase 1 spawn: where the player last died (solo spawn picks far from it)
  lastDeathPos: null,
  // Phase 4a LAN co-op: seconds left on the local bleed-out clock ('downed')
  downedT: 0,
};

let engine, level, viewmodel, fx, audio, hud, input, controller, vmPass, nav, cinema, voice, videoIntro, minimap, interact, intelSys;

/** Award score. G.score carries the daily multiplier, G.scoreBase does not —
    the server needs the un-multiplied total to void a daily bonus cleanly. */
function addScore(amount) {
  const base = Math.round(amount);
  G.score += Math.round(base * G.scoreMult);
  G.scoreBase += base;
}
let weather = null;
let lanLobby = null, lanSession = null, worldLabels = null;
const net = {
  role: null, selfId: null, name: 'OPERATOR', hostId: null,
  team: undefined,               // 0 | 1 in versus; undefined in co-op
  remote: new Map(), enemies: new Map(),
  inputT: 0, snapT: 0, tick: 0, seq: 0, moveEpoch: 0,
  started: false, respawnT: 0, lastError: null, lastSnapshotTick: -1,
};
const fixedStepper = createFixedStepper();
/** Downed/revive state (LAN co-op only): bleed-out clock for the local
    player; the registry + per-ally revive prompts live on module scope. */
let coopDowned = null;
const coopReviveMarks = new Map();   // player id → interact record
function ensureCoopDowned() {
  if (!coopDowned) coopDowned = createDownedRegistry();
  return coopDowned;
}
let netEnemySeq = 1;
/** Client-side read-only mirror of the host's milestone chain. */
let netMilestoneMirror = null;
/** Host-authoritative safe zone; clients hold a read-only mirror. */
let zoneSys = null;
let netZoneMirror = null;
let perception = null, aiDirector = null, barks = null, equipment = null;
/** Phase 1 spawn system: semantic zones + per-mode generators (systems/spawn.js). */
let spawnDirector = null;
const spawnWaveMemory = { recent: [] };
/* ---- spawn reproducibility + audit ---------------------------------------
   A wave plan used to be impossible to replay: main.js called the
   generators without an rng, so they fell back to Math.random, and the
   plan was thrown away the moment it was placed. "The wave that killed me
   came from 140 m away" is not a bug report you can act on.

   Every wave now derives its own seed from (session seed, mode, wave), so
   the same session + wave always produces the same plan, and each plan is
   recorded in G.spawnAudit with its seed and its distances. Reproduce a
   report with ?seed=<n> (same URL => same waves). */
const SPAWN_SEED = (() => {
  const q = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isFinite(q) && q !== 0 ? (q >>> 0) : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
})();
/** Per-wave rng: deterministic for a given (mode, wave) under one session. */
function spawnRngFor(mode, wave) {
  return makeRng(hashSeed(SPAWN_SEED, mode, wave));
}
/** Rolling record of recent wave plans (newest last, capped). */
const SPAWN_AUDIT_MAX = 40;
function recordSpawnAudit(entry) {
  if (!G.spawnAudit) G.spawnAudit = [];
  G.spawnAudit.push(entry);
  while (G.spawnAudit.length > SPAWN_AUDIT_MAX) G.spawnAudit.shift();
}
let codex = { intel: [] };
let mothAlly = null;
let mothGltf = null, mothLoad = null;
let opsTab = 'missions';
let slotT = 0;
let pickups = null, leaderboard = null, results = null, streakSys = null, artillery = null;
let lastRunPayload = null;
const menuDailyList = document.getElementById('menu-daily-list');
const menuDailyCount = document.getElementById('menu-daily-count');
const deckTabs = Array.from(document.querySelectorAll('.deck-tab'));
const deckPanels = Array.from(document.querySelectorAll('.deck-panel'));
const menuBoardList = document.getElementById('menu-board-list');
const menuCallsign = document.getElementById('menu-callsign');
const menuCallsignInput = document.getElementById('menu-callsign-input');
const menuCallsignHint = document.getElementById('menu-callsign-hint');
const menuDeck = { tab: 'board', cache: new Map(), pages: new Map(), req: 0 };

/* ------------------------------------------------------- deploy flavor line */

const DEPLOY_FLAVOR = [
  '城市街区已失守 · 你是唯一还在推进的资产',
  '在连续波次中存活 · 清空每一波敌军',
  '保持移动 · 掩体不会救你两次',
  '弹药有限 · 每一发都要有去处',
  '屋顶有眼 · 别在开阔地停留',
  '撤离点不会等你 · 打完就撤',
  '侦察机失联 · 这一区没有支援',
  '天黑之前 · 清出一条生路',
];

function rollDeployFlavor() {
  const el = document.getElementById('deploy-flavor');
  if (el) el.textContent = DEPLOY_FLAVOR[(Math.random() * DEPLOY_FLAVOR.length) | 0];
}
rollDeployFlavor();

/* ------------------------------------------------------- full board modal */

const bmNum = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const boardModal = {
  open: false, entries: [], nextOffset: 0, done: false, loading: false,
  source: 'local', online: false, rank: 0, total: 0,
};

function isBoardModalOpen() { return boardModal.open; }

function renderBoardModalRows() {
  const list = document.getElementById('board-modal-list');
  if (!list) return;
  list.textContent = '';
  if (!boardModal.entries.length) {
    const li = document.createElement('li');
    li.className = 'mb-empty';
    li.textContent = boardModal.loading ? '正在同步排行榜…' : '暂无记录 · 成为第一个上榜的人';
    list.appendChild(li);
  }
  boardModal.entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const li = document.createElement('li');
    li.className = 'mb-row';
    const rank = bmNum(e.rank, i + 1);
    if (boardModal.rank > 0 && rank === boardModal.rank) {
      li.classList.add('is-you');
      li.setAttribute('aria-current', 'true');
    }
    const r = document.createElement('span'); r.className = 'mb-rank'; r.textContent = String(rank);
    const n = document.createElement('span'); n.className = 'mb-name'; n.textContent = String(e.name || 'UNKNOWN');
    n.title = n.textContent;
    const s = document.createElement('span'); s.className = 'mb-score'; s.textContent = bmNum(e.score, 0).toLocaleString('en-US');
    const w = document.createElement('span'); w.className = 'mb-wave'; w.textContent = String(bmNum(e.wave, 1));
    const k = document.createElement('span'); k.className = 'mb-kills'; k.textContent = String(bmNum(e.kills, 0));
    li.append(r, n, s, w, k);
    list.appendChild(li);
  });
  const total = Math.max(boardModal.total, boardModal.entries.length);
  const note = document.getElementById('board-modal-note');
  if (note) note.textContent = boardModal.entries.length ? `已显示 ${boardModal.entries.length} / ${total}` : 'TOP 100';
  const badge = document.getElementById('board-modal-source');
  if (badge) {
    const src = boardModal.source === 'online' ? 'online' : boardModal.source === 'cache' ? 'cache' : 'local';
    badge.textContent = src === 'online' ? 'ONLINE' : src === 'cache' ? 'CACHE' : 'LOCAL';
    badge.className = `bm-source ${src}`;
  }
  const more = document.getElementById('board-modal-more');
  if (more) {
    const atCap = boardModal.entries.length >= 100;
    const end = boardModal.done || boardModal.nextOffset === null || atCap;
    more.disabled = boardModal.loading || end;
    more.textContent = boardModal.loading
      ? '同步中…'
      : !end ? '加载更多'
        : !boardModal.online && boardModal.entries.length ? '离线 · 仅缓存'
          : atCap || total >= 100 ? '已到 TOP 100' : '已到底';
  }
}

function loadBoardModalPage(reset = false) {
  if (!leaderboard || boardModal.loading) return;
  if (!reset && (boardModal.done || boardModal.nextOffset === null)) return;
  const offset = reset ? 0 : boardModal.nextOffset;
  boardModal.loading = true;
  renderBoardModalRows();
  leaderboard.fetchBoard(G.settings.runMode, 50, leaderboard.clientId, offset).then((res) => {
    if (!boardModal.open) return;
    boardModal.loading = false;
    if (!res) { boardModal.done = true; renderBoardModalRows(); return; }
    // Offline pages come back as cache/local — keep the badge honest about it.
    boardModal.online = !!res.ok;
    boardModal.source = res.source || (res.ok ? 'online' : 'local');
    if (Number.isFinite(Number(res.rank))) boardModal.rank = Number(res.rank);
    if (Number.isFinite(Number(res.total))) boardModal.total = Math.max(boardModal.total, Number(res.total));
    const base = reset ? [] : boardModal.entries;
    const seen = new Set(base.map((e) => e && e.runId));
    const merged = base.slice();
    for (const e of res.entries || []) {
      if (e && !seen.has(e.runId)) { merged.push(e); seen.add(e.runId); }
    }
    boardModal.entries = merged.slice(0, 100);
    boardModal.total = Math.max(boardModal.total, boardModal.entries.length);
    boardModal.nextOffset = res.ok && Number.isInteger(res.nextOffset) ? res.nextOffset : null;
    boardModal.done = boardModal.nextOffset === null || boardModal.entries.length >= 100;
    renderBoardModalRows();
  }).catch(() => {
    if (!boardModal.open) return;
    boardModal.loading = false;
    boardModal.done = true;
    renderBoardModalRows();
  });
}

function openBoardModal() {
  const mode = G.settings.runMode;
  const state = boardPage(mode);
  boardModal.open = true;
  boardModal.entries = Array.isArray(state.entries) ? state.entries.slice(0, 100) : [];
  boardModal.source = state.source || 'local';
  boardModal.online = state.source === 'online';
  boardModal.rank = Number(state.rank) || 0;
  boardModal.total = Math.max(Number(state.total) || 0, boardModal.entries.length);
  boardModal.nextOffset = boardModal.entries.length >= 100
    ? null
    : (Number.isInteger(state.nextOffset) ? state.nextOffset : boardModal.entries.length);
  boardModal.done = boardModal.nextOffset === null;
  boardModal.loading = false;

  const modal = document.getElementById('board-modal');
  const modeEl = document.getElementById('board-modal-mode');
  const list = document.getElementById('board-modal-list');
  if (modeEl) modeEl.textContent = String(mode || 'campaign').toUpperCase();
  renderBoardModalRows();
  if (list) list.scrollTop = 0;
  modal?.classList.remove('hidden');
  modal?.setAttribute('aria-hidden', 'false');
  if (menuEl) { menuEl.setAttribute('aria-hidden', 'true'); menuEl.inert = true; }
  modal?.querySelector('.bm-panel')?.focus({ preventScroll: true });
  loadBoardModalPage(true);
}

function closeBoardModal() {
  if (!boardModal.open) return;
  boardModal.open = false;
  boardModal.loading = false;
  const modal = document.getElementById('board-modal');
  modal?.classList.add('hidden');
  modal?.setAttribute('aria-hidden', 'true');
  if (menuEl) { menuEl.removeAttribute('aria-hidden'); menuEl.inert = false; }
  document.getElementById('board-more')?.focus({ preventScroll: true });
}

document.getElementById('board-more')?.addEventListener('click', openBoardModal);
document.getElementById('board-modal-close')?.addEventListener('click', closeBoardModal);
document.getElementById('board-modal-more')?.addEventListener('click', () => loadBoardModalPage(false));
document.getElementById('board-modal')?.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'board-modal') closeBoardModal();
});
document.getElementById('board-modal-list')?.addEventListener('scroll', (e) => {
  const el = e.currentTarget;
  if (!boardModal.open || boardModal.loading || boardModal.done) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 56) loadBoardModalPage(false);
});
const BOARD_SYNC_KEY = 'dod.board.sync.v1';
const enemies = [];
const grenades = [];
let raycaster, clock;
let beacon = null;
let sunOccluded = false, sunOcclusionTimer = 0;
let stuckTimer = 0, stuckCooldown = 0;
const _sunRay = new THREE.Raycaster();
_sunRay.firstHitOnly = true;   // three-mesh-bvh: stop at the first hit per mesh
let lastTime = 0;

const loadingEl = document.getElementById('loading');
const loadFill = document.getElementById('load-fill');
const loadText = document.getElementById('load-text');
const menuEl = document.getElementById('menu');
const pauseEl = document.getElementById('pause');
const deathEl = document.getElementById('death');
const hudEl = document.getElementById('hud');
const prestartEl = document.getElementById('prestart');
const prestartGo = document.getElementById('prestart-go');
const prestartBack = document.getElementById('prestart-back');
const prestartSkip = document.getElementById('prestart-skip');
const tutorialOpen = document.getElementById('tutorial-open');

function setLoading(p, text) {
  if (loadFill) loadFill.style.width = `${p * 100}%`;
  if (loadText && text) loadText.textContent = text;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/* ------------------------------------------------------------------ boot */

/* =========================================================================
   Sprint: settings, wave upgrades, tutorial, atmosphere presets and
   archetype direction. All of this is plain state on G so the debug API can
   drive it from the headless screenshot harness.
   ========================================================================= */

const ATM_ORDER = ['dusk', 'noon', 'storm', 'bluehour', 'night'];

function magCap(w) {
  if (w && w.melee) return 0;
  return Math.max(1, Math.round(w.magSize * G.upgrades.mag));
}

function applyAtmosphereForWave(n) {
  const key = ATM_ORDER[(Math.max(1, n) - 1) % ATM_ORDER.length];
  G.atmosphere = key;
  if (!engine || !engine.applyAtmosphere) return;
  const label = engine.applyAtmosphere(key);
  applyWeatherForAtmo(key, n);
  if (hud && hud.setAtmosphere) hud.setAtmosphere(label);
}

/* 天色→默认天气的映射：天色只是光照氛围，天气独立叠加。
   波次编号 n 决定天气轮换（晴→风→雾→雨→暴风），与天色轮换解耦。 */
function weatherKeyForWave(n) {
  return WEATHER_ORDER[(Math.max(1, n) - 1) % WEATHER_ORDER.length];
}

function applyWeatherForAtmo(atmoKey, waveN) {
  if (!weather) return;
  weather.syncBase(); // 天色刚被重设，刷新大气基线，避免互相覆盖
  const wKey = weatherKeyForWave(waveN || 1);
  const wLabel = weather.set(wKey);
  G.weather = wKey;
  if (hud && hud.setWeather) hud.setWeather(wLabel);
}

/* Difficulty ladder — see systems/ai/tiers.js (single source of truth, with
   the maxFiring invariant enforced by tools/diff-tier-test.mjs). */

/* Aggression budget: N soldiers may open fire in the same window.
   Without it four riflemen can start a burst on the same frame and delete
   the player before the first tracer is readable.

   The budget is PER TARGET, not per match. A single global pool meant a
   four-player LAN squad shared ONE pool: only two enemies could ever open
   up at a time across the whole squad, so the co-op fight was strictly
   easier per player than the solo fight (the enemy damage does not scale
   with the player count either). One pool per player restores the promise
   "every player faces the solo threat level".

   Versus keeps a single global pool on purpose: the 1v7 / 4v4 bot balance
   was calibrated against that shared budget. */
const firingSlots = { max: 1, life: 1.15, pools: new Map() };
function firingPool(key) {
  let p = firingSlots.pools.get(key);
  if (!p) { p = { at: [] }; firingSlots.pools.set(key, p); }
  return p;
}
function tryEnemyFire(enemy) {
  const now = performance.now() / 1000;
  const key = (!G.versusMode && enemy && enemy.lastTargetId != null)
    ? String(enemy.lastTargetId)
    : 'all';
  const pool = firingPool(key);
  while (pool.at.length && now - pool.at[0] > firingSlots.life) pool.at.shift();
  if (pool.at.length >= firingSlots.max) return false;
  pool.at.push(now);
  return true;
}
function resetFiringSlots() {
  firingSlots.pools.clear();
}

function chooseArchetype(wave, index) {
  const r = Math.random();
  // specials unlock later: rusher 4, shield 9, sniper 9+ (roof snipers from 6)
  if (wave <= 3) return 'rifleman';
  if (wave <= 5) return r < 0.22 ? 'rusher' : 'rifleman';
  if (wave <= 8) {
    if (r < 0.12) return 'shield';
    if (r < 0.34) return 'rusher';
    return 'rifleman';
  }
  if (wave <= 11) {
    if (r < 0.10) return 'sniper';
    if (r < 0.26) return 'shield';
    if (r < 0.50) return 'rusher';
    return 'rifleman';
  }
  if (r < 0.14) return 'sniper';
  if (r < 0.34) return 'shield';
  if (r < 0.58) return 'rusher';
  return 'rifleman';
}

/* --------------------------------------------------------------- settings */
function applySettings(initial = false) {
  if (!input || !controller) return;
  input.sensitivity = G.settings.sensitivity;
  controller.adsSensitivity = G.settings.adsSens;
  controller.invertY = G.settings.invertY;
  controller.baseFov = G.settings.fov;
  controller.reduceMotion = G.settings.reduceMotion;
  if (audio && audio.ctx && audio.setMasterVolume) audio.setMasterVolume(G.settings.master);
  if (engine && engine.setFrameBudget) engine.setFrameBudget(G.settings.fpsCap);
  if (initial && engine) engine.setQuality(G.settings.quality);
  if (engine && engine.post && engine.post.setLensEffects) engine.post.setLensEffects(G.settings.lensEffects);
  document.documentElement.classList.toggle('high-contrast', !!G.settings.highContrast);
  if (cinema) cinema.setVoice(G.settings.voice !== false);
  if (voice) { voice.setEnabled(G.settings.voice !== false); if (voice.setVolume) voice.setVolume(G.settings.master); }
  syncQualityPills();
}

function onSettingChange(key, value) {
  G.settings[key] = value;
  Object.assign(G.settings, sanitizeSettings(G.settings));
  saveSettings(G.settings);
  if (key === 'quality' && engine) {
    engine.setQuality(G.settings.quality);
    onResize();
  }
  applySettings(false);
}

function syncQualityPills() {
  for (const b of document.querySelectorAll('.quality-pills button')) {
    b.classList.toggle('active', (b.dataset.q || b.dataset.pq) === G.settings.quality);
  }
}

function openSettings() {
  if (hud && hud.openSettings) hud.openSettings();
  if (G.state === 'playing') {
    G.state = 'paused';
    pauseEl.classList.remove('hidden');
    input.unlock();
  }
  if (audio && audio.ctx) audio.ui();
}

/* ---------------------------------------------------------------- upgrades */
const UPGRADE_POOL = [
  { id: 'damage',   title: '火力强化', desc: '武器伤害 +15%', icon: 'DMG', apply() { G.upgrades.damage += 0.15; } },
  { id: 'firerate', title: '高速循环', desc: '射速 +12%',     icon: 'RPM', apply() { G.upgrades.fireRate += 0.12; } },
  { id: 'mag',      title: '扩容弹匣', desc: '弹匣容量 +15%', icon: 'MAG', apply() { G.upgrades.mag += 0.15; } },
  { id: 'armor',    title: '护甲板',   desc: '护甲上限 +20，并补 20', icon: 'ARM', apply() { G.maxArmor += 20; G.armor = Math.min(G.maxArmor, G.armor + 20); } },
  { id: 'speed',    title: '轻装',     desc: '移动速度 +8%',  icon: 'SPD', apply() { G.upgrades.speed += 0.08; } },
  { id: 'regen',    title: '战地急救', desc: '回血速度 +35%', icon: 'MED', apply() { G.upgrades.regen += 0.35; } },
  { id: 'grenade',  title: '额外投掷物', desc: '手雷 +1',     icon: 'FRG', apply() { G.upgrades.grenades += 1; } },
  { id: 'health',   title: '强健体质', desc: '生命上限 +20，并回复 20', icon: 'HP', apply() { G.maxHp += 20; G.hp = Math.min(G.maxHp, G.hp + 20); } },
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function openUpgradeChoice(force = false) {
  if ((SHOT_MODE && !force) || !hud || !hud.showUpgrades) {
    startWave(G.wave + 1);
    return;
  }
  G.state = 'upgrade';
  G.upgradeT = 0;
  hideObjectiveUI();
  G.upgradeCards = shuffle(UPGRADE_POOL.slice()).slice(0, 3).map((u, i) => ({ ...u, key: String(i + 1) }));
  // LAN co-op: every player picks their own card from the same offer
  if (lanSession && net.role === 'host' && !G.versusMode) {
    lanSession.broadcastEvent('upoffer', { cards: G.upgradeCards.map((c) => c.id) });
  }
  hud.showUpgrades(G.upgradeCards, handleUpgradePick);
  input.unlock();
}

function handleUpgradePick(idOrIndex) {
  const idx = typeof idOrIndex === 'number'
    ? idOrIndex
    : G.upgradeCards.findIndex((c) => c.id === idOrIndex);
  if (idx >= 0) pickUpgrade(idx);
}

function pickUpgrade(index) {
  if (G.state !== 'upgrade') return;
  const card = G.upgradeCards[index];
  if (!card) return;
  card.apply();
  if (card.id === 'mag') {
    const w = currentWeapon();
    const cap = magCap(w);
    const add = Math.max(0, cap - G.mag);
    G.mag += add;
    G.weaponAmmo[G.weaponIndex] = { mag: G.mag, reserve: G.reserve };
    if (hud.setWeaponName) hud.setWeaponName(w.name, cap, w.mode);
    if (hud.setAmmo) hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  }
  if (card.id === 'armor' || card.id === 'health') hud.setHealth(G.hp, pipsFor(G.armor));
  if (card.id === 'grenade') hud.setGrenades(G.grenades);
  if (card.id === 'speed') applyMoveSpeedMult();
  if (card.id === 'regen') G.regenRate = 26 * G.upgrades.regen;
  G.upgradeCards = [];
  if (hud.hideUpgrades) hud.hideUpgrades();
  G.state = 'playing';
  if (audio && audio.ctx) audio.uiConfirm();
  // LAN clients apply the card and get back in: the HOST advances the wave
  if (net.role === 'client') {
    if (!SHOT_MODE) input.lock();
    return;
  }
  startWave(G.wave + 1);
  if (!SHOT_MODE) input.lock();
}

/* ---------------------------------------------------------------- tutorial */
const TUTORIAL_STEPS = [
  { key: 'WASD', text: 'WASD 移动 · SHIFT 冲刺', test: () => controller && controller.state.speed > 0.35 },
  { key: 'CTRL', text: 'CTRL / C 蹲伏 · SPACE 跳跃', test: () => !!(controller && (controller.state.crouching || G.tut.jumps > 0)) },
  { key: 'LMB', text: '鼠标左键射击', test: () => G.shotsFired >= 3 },
  { key: 'RMB', text: '鼠标右键瞄准（按住）', test: () => controller && controller.adsAmount > 0.6 },
  { key: 'R', text: 'R 换弹', test: () => G.tut.reloads > 0 },
  { key: 'G', text: 'G 投掷手雷', test: () => G.tut.grenades > 0 },
  { key: '1-3', text: '1 / 2 / 3 切枪 · Q 切回 · V 短刀', test: () => G.tut.swaps > 0 },
  { key: 'M', text: 'M 开关小地图', test: () => G.tut.minimap > 0 },
  { key: 'E', text: 'E 交互：破门 / 收集情报', test: () => G.tut.interacts > 0, timeout: 8 },
];

const MODE_BRIEFS = {
  rotation: {
    label: 'ROTATION', title: '标准轮换', op: 'ROTATION PROTOCOL',
    desc: '每 3 波进入防守，每 5 波进入撤离；其余为生存波次。目标区会在街区、后院、市场与南院车场之间轮换。',
    threat: 'HIGH', ao: 'URBAN', contact: '∞',
    objectives: ['生存波：清空所有敌人', '防守波：在目标区累计守住 60 秒', '撤离波：清空区域后进入撤离区按住 8 秒'],
    note: '敌军以波次持续增援，没有撤离窗口。保持移动，利用掩体，清空街区。',
  },
  campaign: {
    label: 'CAMPAIGN', title: '剧情推进', op: 'CAMPAIGN PROTOCOL',
    desc: '按 OP01 → OP14 推进战役：前十关在街区主线，OP11–14 转战老城/北站/港区。每关有独立简报、过场、目标与结局。',
    threat: 'STORY', ao: 'URBAN', contact: '14 OPS',
    objectives: ['在 OPS 里选择已解锁的任务', '完成关卡目标并存活', '结算后继续下一任务'],
    note: '剧情模式会按关卡推进；其他三个模式是独立玩法，不会改变战役进度。',
  },
  survival: {
    label: 'SURVIVAL', title: '无尽生存', op: 'LAST STAND PROTOCOL',
    desc: '没有防守与撤离目标，只有不断加码的波次。活到弹尽之前，把街区清空。',
    threat: 'HIGH', ao: 'URBAN', contact: '∞',
    objectives: ['清空每一波敌人', '利用街道、室内与后院掩体', '波间选择一项升级'],
    note: '无尽波次，没有撤离窗口。保持移动，优先处理盾兵与狙击手。',
  },
  defend: {
    label: 'DEFEND', title: '区域防守', op: 'HOLD THE LINE',
    desc: '每一波都要进入黄色目标区并累计守住 60 秒；离开区域会衰减。清空区域时敌军会补充增援。',
    threat: 'HIGH', ao: 'URBAN', contact: 'WAVES',
    objectives: ['进入目标区并累计守满 60 秒', '离开区域会衰减进度', '清空当前敌人后会有 2 名增援'],
    note: '防守区会在街心、左巷、市场与后院之间轮换。不要在开阔地停留。',
  },
  extract: {
    label: 'EXTRACT', title: '清场撤离', op: 'EXFILTRATION',
    desc: '先清空当前区域，再进入撤离区按住 8 秒。撤离区可能位于左巷、工坊或市场内部。',
    threat: 'HIGH', ao: 'URBAN', contact: 'FINITE',
    objectives: ['清空当前区域的所有敌人', '进入撤离区并按住 8 秒', '撤离完成后进入下一波'],
    note: '撤离区会随波次轮换。清场后留意 HUD 的距离提示。',
  },
};

/* The mode brief under the mode pills is always visible (the deck no longer has
   a BRIEFING tab), so it is the single source of truth for the mode copy; the
   pre-mission training dialog mirrors it below. */
function activeOperation() {
  return campaignActive ? operationById(campaign.selected) : null;
}

/** One source for the mode brief and the pre-mission dialog. */
function briefFor(mode = G.settings.runMode) {
  const op = activeOperation();
  if (op && G.settings.runMode === 'campaign') {
    return {
      label: 'CAMPAIGN',
      title: `${op.code} · ${op.name}`,
      op: op.en,
      desc: op.brief,
      threat: op.threat,
      ao: op.zoneLabel,
      contact: op.beats ? `${op.beats.length} BEATS` : `${op.waves} WAVES`,
      objectives: [
        op.beats
          ? op.beats.map((b) => b.text || b.name).join(' → ')
          : op.mode === 'survival' ? `清空 ${op.waves} 波敌人` : '完成区域目标',
        `区域：${op.zoneLabel}`,
        op.beats ? (op.beats.some((b) => b.type === 'boss') ? '击杀敌方指挥官' : '完成全部节拍')
          : op.bossWave ? '击杀敌方指挥官' : '活着完成任务',
      ],
      note: '',
    };
  }
  return MODE_BRIEFS[mode] || MODE_BRIEFS.rotation;
}

function updateBriefing(mode = G.settings.runMode) {
  const b = briefFor(mode);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const read = (id) => { const el = document.getElementById(id); return el ? el.textContent : ''; };
  const before = [read('mode-desc-label'), read('mode-desc-title'), read('mode-desc-text')].join('\u0001');
  set('mode-desc-label', b.label);
  set('mode-desc-title', b.title);
  set('mode-desc-text', b.desc);
  set('mode-desc-threat', b.threat);
  set('mode-desc-ao', b.ao);
  set('mode-desc-contact', b.contact);
  const th = document.getElementById('mode-desc-threat');
  if (th) th.classList.toggle('hot', b.threat !== 'LOW');
  const after = [read('mode-desc-label'), read('mode-desc-title'), read('mode-desc-text')].join('\u0001');
  const brief = document.getElementById('mode-desc');
  if (brief && before !== after) {
    brief.classList.remove('is-swap');
    void brief.offsetWidth;
    brief.classList.add('is-swap');
  }
  fillPrestart(mode);
}

function fillPrestart(mode = G.settings.runMode) {
  const b = briefFor(mode);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('prestart-mode', b.label);
  set('prestart-kicker', 'OPERATION BLACKOUT / ' + b.op);
  set('prestart-title', b.title);
  set('prestart-desc', b.desc);
  set('prestart-threat', b.threat);
  set('prestart-contact', b.contact);
  const th = document.getElementById('prestart-threat');
  if (th) th.classList.toggle('hot', b.threat !== 'LOW');
  const ul = document.getElementById('prestart-objectives');
  if (ul) ul.innerHTML = b.objectives.map((t) => `<li>${t}</li>`).join('');
}

function openPrestart() {
  updateBriefing(G.settings.runMode);
  if (!prestartEl) return;
  if (prestartSkip) prestartSkip.checked = prestartSkipped();
  prestartEl.classList.remove('hidden');
  prestartEl.setAttribute('aria-hidden', 'false');
  G.state = 'menu';
  if (input) input.unlock();
  if (audio && audio.ctx) audio.ui();
}

function requestGameFullscreen() {
  try {
    if (document.fullscreenElement) return;
    const el = document.documentElement;
    if (el && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } catch (e) { /* browsers may deny without a gesture */ }
}

function launchGame() {
  requestGameFullscreen();
  closePrestart();
  // tutorial state is owned by localStorage (see G.tutorial.done = tutorialDone()
  // at boot): first-time players get the 9-step in-game tutorial, returning
  // players do not. Do not force-mark it done here.
  audio.init();
  audio.setMasterVolume(G.settings.master);
  initAudioAmbience();
  startGame(true);
}

function onDeployClick() {
  audio.init();
  audio.setMasterVolume(G.settings.master);
  if (prestartSkipped()) launchGame();
  else openPrestart();
}

function closePrestart() {
  if (!prestartEl) return;
  prestartEl.classList.add('hidden');
  prestartEl.setAttribute('aria-hidden', 'true');
}

/* ------------------------------------------------- field manual (menu lore) */
const manualEl = document.getElementById('manual');

function renderManualArchive() {
  if (!manualEl || manualEl.dataset.filled) return;
  const mc = document.getElementById('manual-controls');
  if (mc && !mc.childElementCount) renderControls(mc);
  const chars = document.getElementById('manual-chars');
  const intel = document.getElementById('manual-intel');
  if (chars) {
    let prog = null;
    try { prog = loadCampaign(); } catch (e) { /* noop */ }
    chars.innerHTML = CHARACTERS.map((c) => {
      const unlocked = characterUnlocked(c, prog);
      return `<div class="arch-card${unlocked ? '' : ' locked'}">
        <h4>${unlocked ? c.name : '???'}<i>${unlocked ? c.role : '未解锁 · 通关 OP ' + String(c.mission).padStart(2, '0')}</i></h4>
        <p>${unlocked ? c.text : '档案在战役推进后解密。'}</p>
      </div>`;
    }).join('');
  }
  if (intel) {
    let codex = { intel: [] };
    try { codex = loadCodex(); } catch (e) { /* noop */ }
    intel.innerHTML = INTEL.map((it) => {
      const got = codex.intel.includes(it.id);
      return `<div class="arch-card${got ? '' : ' locked'}">
        <h4>${it.title}<i>${it.area}</i></h4>
        <p>${got ? it.text : '尚未收集——在该区域探索并按 E 拾取。'}</p>
      </div>`;
    }).join('');
  }
  manualEl.dataset.filled = '1';
}

function selectManualTab(name) {
  if (!manualEl) return;
  for (const b of manualEl.querySelectorAll('#manual-tabs button')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  for (const p of manualEl.querySelectorAll('.manual-page')) {
    p.classList.toggle('active', p.dataset.page === name);
  }
}

function openManual() {
  if (!manualEl) { openPrestart(); return; }
  renderManualArchive();
  // 同步 tab 高亮与页面显隐：story 按钮 hard-code 了 active，但内容区没有，
  // 不调用的话首次打开是空白（点其他 tab 再切回来才出现）
  selectManualTab('story');
  manualEl.classList.remove('hidden');
  manualEl.setAttribute('aria-hidden', 'false');
  G.state = 'menu';
  if (input) input.unlock();
  if (audio && audio.ctx) audio.ui();
}

function closeManual() {
  if (!manualEl || manualEl.classList.contains('hidden')) return;
  manualEl.classList.add('hidden');
  manualEl.setAttribute('aria-hidden', 'true');
}

function beginTutorial(force = false) {
  if (G.tutorial.done || (SHOT_MODE && !force)) return;
  G.tutorial.active = true;
  G.tutorial.step = 0;
  G.tutorial.stepT = 0;
  G.tutorial.lastX = controller.pos.x;
  G.tutorial.lastZ = controller.pos.z;
  if (hud.showTutorial) hud.showTutorial(TUTORIAL_STEPS[0].text, TUTORIAL_STEPS[0].key);
}

function updateTutorial(dt) {
  const t = G.tutorial;
  if (!t.active) return;
  t.t += dt;
  t.stepT += dt;
  const step = TUTORIAL_STEPS[t.step];
  if (!step) { finishTutorial(); return; }
  let done = false;
  try { done = !!(step.test && step.test()); } catch (e) { done = false; }
  // fallback so a step can never soft-lock the run
  if (!done && t.stepT > (step.timeout || 12)) done = true;
  if (done) {
    t.step++;
    t.stepT = 0;
    if (t.step >= TUTORIAL_STEPS.length) finishTutorial();
    else if (hud.showTutorial) hud.showTutorial(TUTORIAL_STEPS[t.step].text, TUTORIAL_STEPS[t.step].key);
  }
}

function finishTutorial() {
  G.tutorial.active = false;
  G.tutorial.done = true;
  markTutorialDone();
  if (hud.hideTutorial) hud.hideTutorial();
}


/* =========================================================================
   Sprint B: objective modes. Defend holds a zone for 60s while the director
   reinforces; Extract clears the wave then asks the player to reach the alley
   zone and hold for 8s. Both reuse the same wave/upgrade loop.
   ========================================================================= */

function modeForWave(n) {
  const pref = G.settings && G.settings.runMode;
  if (pref === 'campaign') {
    // beat-driven ops run one mode PER BEAT (infil/interact included);
    // legacy ops keep their single fixed mode
    const op = G.operation;
    const beat = op && op.beats ? beatForWave(op.beats, n) : null;
    if (beat) return beatMode(beat);
    return (op && op.mode) || 'survival';
  }
  if (!pref || pref === 'rotation') {
    // ROTATION: every 3rd wave is a defend, every 5th an extract, rest survival.
    if (n % 5 === 0) return 'extract';
    if (n % 3 === 0) return 'defend';
    return 'survival';
  }
  return pref;
}

function chooseCampaignOperation() {
  const next = OPERATIONS.find((o) => isUnlocked(campaign, o.id) && !campaign.done.includes(o.id));
  if (next) return next;
  const sel = operationById(campaign.selected);
  if (sel && isUnlocked(campaign, sel.id)) return sel;
  return OPERATIONS[OPERATIONS.length - 1];
}

function onModeSelect(mode) {
  const valid = ['campaign', 'rotation', 'survival', 'defend', 'extract'];
  G.settings.runMode = valid.includes(mode) ? mode : 'campaign';
  campaignActive = G.settings.runMode === 'campaign';
  if (campaignActive) {
    const op = chooseCampaignOperation();
    campaign.selected = op.id;
    saveCampaign(campaign);
  }
  saveSettings(G.settings);
  if (hud && hud.setModeSelect) hud.setModeSelect(G.settings.runMode);
  updateBriefing(G.settings.runMode);
  renderOps();
  syncOpsTab();
  refreshMenuBoard(true);
  if (audio && audio.ctx) audio.ui();
}

/* ---------------------------------------------------------------- operations */
function operationsDone() {
  return campaign.done.filter((n) => n > 0).length;
}

function renderArchive() {
  const done = campaign.done || [];
  const chars = document.getElementById('arc-characters');
  if (chars) {
    chars.textContent = '';
    for (const c of CHARACTERS) {
      const un = characterUnlocked(c, campaign);
      const row = document.createElement('div');
      row.className = 'arc-row' + (un ? '' : ' locked');
      const name = document.createElement('span');
      name.className = 'arc-name';
      name.textContent = un ? c.name : 'CLASSIFIED';
      const text = document.createElement('span');
      text.className = 'arc-text';
      text.textContent = un ? `${c.role} · ${c.text}` : '完成对应任务后解锁';
      row.append(name, text);
      chars.appendChild(row);
    }
  }
  const intelEl = document.getElementById('arc-intel');
  if (intelEl) {
    intelEl.textContent = '';
    for (const it of INTEL) {
      const got = codex.intel.includes(it.id);
      const row = document.createElement('div');
      row.className = 'arc-row' + (got ? '' : ' locked');
      const name = document.createElement('span');
      name.className = 'arc-name';
      name.textContent = got ? it.title : '未收集';
      const text = document.createElement('span');
      text.className = 'arc-text';
      text.textContent = got ? `${it.area} · ${it.text}` : `${it.area} · 靠近后按 E 收集`;
      row.append(name, text);
      intelEl.appendChild(row);
    }
    const count = document.getElementById('arc-intel-count');
    if (count) count.textContent = `${codex.intel.length}/${INTEL.length}`;
  }
  const log = document.getElementById('arc-log');
  if (log) {
    log.textContent = '';
    for (const op of OPERATIONS) {
      if (!done.includes(op.id)) continue;
      const row = document.createElement('div');
      row.className = 'arc-row';
      const name = document.createElement('span');
      name.className = 'arc-name';
      name.textContent = op.code;
      const text = document.createElement('span');
      text.className = 'arc-text';
      text.textContent = `${op.name} · ${op.debrief}`;
      row.append(name, text);
      log.appendChild(row);
    }
    if (!done.filter((n) => n > 0).length) {
      const row = document.createElement('div');
      row.className = 'arc-row locked';
      row.textContent = '暂无任务记录';
      log.appendChild(row);
    }
  }
}

function syncOpsTab() {
  const missions = document.getElementById('ops-missions');
  const archive = document.getElementById('ops-archive');
  const buttons = document.querySelectorAll('[data-ops-tab]');
  for (const b of buttons) b.classList.toggle('is-on', b.dataset.opsTab === opsTab);
  if (missions) missions.classList.toggle('hidden', opsTab !== 'missions');
  if (archive) archive.classList.toggle('hidden', opsTab !== 'archive');
  if (opsTab === 'archive') renderArchive();
}

function renderOps() {
  const list = document.getElementById('ops-list');
  const prog = document.getElementById('menu-ops-progress');
  const note = document.getElementById('ops-note');
  if (prog) prog.textContent = `${operationsDone()}/${OPERATIONS.length}`;
  if (!list) return;
  list.textContent = '';
  for (const op of OPERATIONS) {
    const unlocked = isUnlocked(campaign, op.id);
    const done = campaign.done.includes(op.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ops-row'
      + (campaignActive && op.id === campaign.selected ? ' is-active' : '')
      + (unlocked ? '' : ' is-locked');
    row.disabled = !unlocked;
    row.title = unlocked ? op.brief : '完成上一任务后解锁';
    const code = document.createElement('span');
    code.className = 'ops-code';
    code.textContent = op.code;
    const name = document.createElement('span');
    name.className = 'ops-name';
    name.textContent = `${op.name}${done ? ' ✓' : ''}`;
    const status = document.createElement('span');
    status.className = 'ops-status';
    status.textContent = !unlocked ? 'LOCKED' : (campaignActive && op.id === campaign.selected ? 'ACTIVE' : done ? 'DONE' : 'READY');
    row.append(code, name, status);
    row.addEventListener('click', () => selectOperation(op.id));
    list.appendChild(row);
  }
  if (note) {
    const op = activeOperation();
    if (G.settings.runMode !== 'campaign') {
      note.textContent = '自由玩法中 · 剧情任务只在 CAMPAIGN 模式推进；点击任务会自动切回剧情模式';
    } else {
      note.textContent = op
        ? `${op.code} ${op.name} · ${op.mode.toUpperCase()} · ${op.zoneLabel} · 按 START 部署`
        : '选择一个任务，然后按 START 部署';
    }
  }
  if (opsTab === 'archive') renderArchive();
}

function selectOperation(id) {
  const op = operationById(id);
  if (!isUnlocked(campaign, op.id)) return;
  campaign.selected = id;
  saveCampaign(campaign);
  campaignActive = true;
  G.settings.runMode = 'campaign';
  saveSettings(G.settings);
  if (hud && hud.setModeSelect) hud.setModeSelect('campaign');
  updateBriefing('campaign');
  renderOps();
  if (audio && audio.ctx) audio.ui();
}

/* Per-district objective alternates. The street table keeps the original
   interior rotation; the three expansion districts anchor on their site zone
   plus nearby open ground, so a district fight never teleports the beacon back
   to the old street. */
const OBJECTIVE_SPOTS = {
  street: {
    defend: [
      { x: 0, z: -16, r: 8.5 },
      { x: 0, z: 14, r: 8.0 },
      { x: -14, z: 2.5, r: 3.8 },
      { x: 0, z: 70, r: 8.0 },
      { x: 11.5, z: 68, r: 3.6 },
    ],
    extract: [
      { x: -19.2, z: 3.0, r: 3.5 },
      { x: -13.3, z: -2.5, r: 2.7 },
      { x: 13.3, z: -11.6, r: 3.0 },
      { x: 11.5, z: 68, r: 3.2 },
    ],
  },
  souk: {
    defend: [
      { x: -74, z: 12, r: 6.0 },
      { x: -96, z: 42, r: 5.0 },
      { x: -52, z: -6, r: 5.0 },
    ],
    extract: [
      { x: -74, z: 12, r: 5.0 },
      { x: -88, z: 30, r: 4.0 },
      { x: -48, z: 8, r: 4.0 },
    ],
  },
  rail: {
    defend: [
      { x: 4, z: -150, r: 7.0 },
      { x: 0, z: -180, r: 6.0 },
      { x: 28, z: -124, r: 5.0 },
    ],
    extract: [
      { x: 4, z: -150, r: 6.0 },
      { x: -16, z: -172, r: 4.5 },
      { x: 24, z: -132, r: 4.5 },
    ],
  },
  port: {
    defend: [
      { x: 98, z: -44, r: 6.0 },
      { x: 72, z: -60, r: 5.0 },
      { x: 104, z: -20, r: 5.0 },
    ],
    extract: [
      { x: 98, z: -44, r: 5.0 },
      { x: 84, z: -64, r: 4.5 },
      { x: 100, z: -12, r: 4.5 },
    ],
  },
};

function objectiveZone(kind) {
  const siteId = currentSiteId();
  const table = OBJECTIVE_SPOTS[siteId] || OBJECTIVE_SPOTS.street;
  const spots = table[kind] ? table[kind].slice() : [];
  const base = level && level.objectiveZones && level.objectiveZones[kind];
  // The legacy level zone is street geometry; only fold it in on the street.
  if (siteId === 'street' && base && typeof base.x === 'number') spots[0] = base;
  const market = level && level.cqbZones && level.cqbZones.find((z) => /market|yard|后院|市场/.test((z.id || '') + (z.name || '')));
  if (siteId === 'street' && market) spots.push({ x: market.center.x, z: market.center.z, r: Math.min(3.6, market.radius || 3.6) });
  if (siteId === 'street' && kind === 'defend' && level && level.objectiveZones && level.objectiveZones.backyard) spots.push(level.objectiveZones.backyard);
  const idx = kind === 'defend'
    ? Math.floor((G.wave || 1) / 3) % spots.length
    : Math.floor((G.wave || 1) / 5) % spots.length;
  return spots[idx];
}

function setupObjective(n) {
  const mode = modeForWave(n);
  G.mode = mode;
  G.objective = null;
  // beat-driven ops: the beat declares the objective (or none)
  const op = G.operation;
  const beat = op && op.beats ? beatForWave(op.beats, n) : null;
  if (beat) { setupBeatObjective(beat); return; }
  if (mode === 'survival') { hideObjectiveUI(); return; }
  const zone = (G.operation && G.operation.zone)
    ? { ...G.operation.zone }
    : (G.site ? { ...G.site.zone } : objectiveZone(mode === 'defend' ? 'defend' : 'extract'));
  G.objective = {
    type: mode,
    zone,
    need: mode === 'defend' ? ((G.operation && G.operation.hold) || 60) : 8,
    hold: 0,
    done: false,
    ready: mode === 'defend',
    inside: false,
  };
  if (hud && hud.setMode) hud.setMode(mode.toUpperCase(), mode === 'defend' ? 'HOLD THE ZONE' : 'CLEAR THE AREA, THEN EXTRACT');
  showBeacon(zone, mode);
}

/* ---- campaign beats (Phase 3) ----------------------------------------------
   One beat = one wave of the existing loop. systems/beats.js decides what a
   beat IS; this block mounts it: the objective zone (or interact target),
   the HUD copy, and the advance when the beat's goal is met. Objective-driven
   beats (defend/extract/infil/interact) advance from onObjectiveDone; clear-
   driven beats (survival/assault/boss) advance from updateWaves. ------------ */

let beatInteract = null;      // mounted interact target of an `interact` beat

/** A beat spot may be literal coords or 'site' = the active rotation site's
    zone centre (ops without a fixed start play on the rotated district). */
function resolveBeatSpot(spot) {
  if (spot === 'site') {
    const z = G.site ? G.site.zone : (objectiveZone('defend') || null);
    return z ? { x: z.x, z: z.z, r: 2.8 } : null;
  }
  return spot && Number.isFinite(spot.x) ? { x: spot.x, z: spot.z, r: spot.r || 2.8 } : null;
}

function setupBeatObjective(beat) {
  unmountBeatInteract();
  const defn = beatObjective(beat);
  const title = (beat.name || beat.type || 'WAVE').toUpperCase();
  if (!defn) {
    hideObjectiveUI();
    if (hud && hud.setMode) hud.setMode(title, beat.text || '');
    return;
  }
  const zone = defn.type === 'interact' ? resolveBeatSpot(defn.zone) : { ...defn.zone };
  if (!zone) { hideObjectiveUI(); return; }
  G.objective = {
    type: defn.type,
    zone,
    need: defn.need,
    hold: 0,
    done: false,
    // extract still has to clear the field first; everything else is live at once
    ready: defn.type !== 'extract',
    inside: false,
  };
  if (hud && hud.setMode) hud.setMode(title, beat.text || '');
  showBeacon(zone, defn.type === 'extract' || defn.type === 'infil' ? 'extract' : 'defend');
  if (defn.type === 'interact') mountBeatInteract(beat, zone);
}

function unmountBeatInteract() {
  if (beatInteract && interact) {
    try { interact.remove(beatInteract); } catch (e) { /* already gone */ }
  }
  beatInteract = null;
}

function mountBeatInteract(beat, spot) {
  unmountBeatInteract();
  if (!interact || !spot) return;
  beatInteract = interact.add({
    x: spot.x, z: spot.z, r: spot.r || 2.8,
    label: beat.label || '按住 E 交互',
    hold: 0.8,
    onUse: () => {
      const obj = G.objective;
      if (!obj || obj.done || obj.type !== 'interact') return;
      obj.hold = obj.need;
      onObjectiveDone();
    },
  });
}

/** The beat's goal is met: finish the op on the last beat, otherwise run
    the normal between-wave upgrade pick, whose confirm starts the next wave
    (= next beat). */
function advanceBeat() {
  const op = G.operation;
  if (!op || !op.beats || G.state !== 'playing') return;
  unmountBeatInteract();
  if (G.wave >= operationWaves(op)) { finishOperation(); return; }
  openUpgradeChoice();
}

/* ---- milestone chain ------------------------------------------------------
   Co-op used to run with G.operation = null, so the only thing the HUD could
   say was "clear hostiles" and players had no idea what to do. The chain gives
   every match a visible sequence of steps.

   The chain mixes reach / hold / collect / kill on purpose: a chain made only
   of kill goals would reproduce the exact problem it is meant to fix, so
   systems/milestones.js guarantees at least a third of the steps are
   non-lethal. ---------------------------------------------------------------- */

let milestones = null;
let milestoneTarget = null;   // the mounted interact target for a `collect` step

/** Collect candidate spots from the spots the level already defines, so the
    chain points at real playable geometry instead of arbitrary coordinates. */
function milestoneSpots() {
  const reach = [];
  const hold = [];
  const collect = [];
  const table = OBJECTIVE_SPOTS[currentSiteId()] || OBJECTIVE_SPOTS.street;
  if (table) {
    for (const s of table.defend || []) hold.push(s);
    for (const s of table.extract || []) reach.push(s);
  }
  if (level && level.objectiveZones) {
    for (const key of Object.keys(level.objectiveZones)) {
      const z = level.objectiveZones[key];
      if (z && Number.isFinite(z.x)) hold.push({ x: z.x, z: z.z, r: z.r });
    }
  }
  if (level && level.cqbZones) {
    for (const q of level.cqbZones) {
      if (q && q.center && Number.isFinite(q.center.x)) {
        hold.push({ x: q.center.x, z: q.center.z, r: Math.min(5, q.radius || 4) });
      }
    }
  }
  if (intelSys) {
    for (const t of intelSys.targetList()) collect.push({ x: t.x, z: t.z });
  }
  return { reach, hold, collect };
}

function unmountMilestoneTarget() {
  if (milestoneTarget && interact) {
    try { interact.remove(milestoneTarget); } catch (e) { /* already gone */ }
  }
  milestoneTarget = null;
}

/** Mount whatever world marker the newly active step needs. */
function mountMilestoneStep(step) {
  unmountMilestoneTarget();
  if (!step) return;
  if (step.kind === 'reach' || step.kind === 'hold') {
    showBeacon({ x: step.x, z: step.z, r: step.r }, step.kind === 'hold' ? 'defend' : 'extract');
    return;
  }
  if (step.kind === 'collect' && interact) {
    // The interact system already renders the prompt and drives the HUD, so a
    // collect step needs no new UI: press E at the marker.
    milestoneTarget = interact.add({
      x: step.x, z: step.z, r: step.r,
      label: '按住 E 搜集物资',
      hold: 0.8,
      onUse: () => { if (milestones) milestones.notifyCollect(step.id); },
    });
  }
}

function startMilestones() {
  unmountMilestoneTarget();
  const spots = milestoneSpots();
  milestones = createMilestones({
    reachSpots: spots.reach,
    holdSpots: spots.hold,
    collectSpots: spots.collect,
    origin: { x: controller.pos.x, z: controller.pos.z },
    onChainAdvance: (step) => mountMilestoneStep(step),
    onStep: (step) => {
      if (hud && hud.toast) hud.toast(`阶段完成 · ${stepLabel(step)}`, 2000);
      if (hud && hud.radio) hud.radio('VEGA', '阶段完成。推进到下一个目标。', 2600, 'stage_clear');
    },
    onAllDone: () => {
      if (hud && hud.toast) hud.toast('任务链完成 · 干得漂亮', 3200);
    },
  });
  // createMilestones announces the opening step via onChainAdvance, so the
  // first marker/target is already mounted here.
}

function stopMilestones() {
  unmountMilestoneTarget();
  milestones = null;
  if (hud && hud.hideMilestones) hud.hideMilestones();
}

/** Per-frame: advance hold/reach steps and repaint the HUD checklist. */
function updateMilestones(dt) {
  if (!milestones || milestones.isDone) {
    if (hud && hud.hideMilestones) hud.hideMilestones();
    return;
  }
  const step = milestones.current;
  let inside = false;
  if (step && (step.kind === 'reach' || step.kind === 'hold') && Number.isFinite(step.x)) {
    inside = Math.hypot(controller.pos.x - step.x, controller.pos.z - step.z) <= (step.r || 4);
    // Co-op is a SQUAD objective: any alive teammate standing in the zone
    // counts, not just the host (mirrored positions are host-authoritative).
    if (!inside && net.role === 'host') {
      for (const r of net.remote.values()) {
        if (!r.alive) continue;
        if (Math.hypot(r.x - step.x, r.z - step.z) <= (step.r || 4)) { inside = true; break; }
      }
    }
  }
  const before = milestones.state.index;
  milestones.update(dt, inside);

  if (milestones.state.index !== before) {
    if (hud && hud.setMode) {
      hud.setMode('OBJECTIVE', milestones.state.label);
    }
  }
  if (hud && hud.setMilestones) {
    const st = milestones.state;
    const upcoming = milestones.steps
      .slice(st.index + 1, st.index + 3)
      .map((s) => stepLabel(s));
    hud.setMilestones(milestones.serialize(), upcoming);
  }
  if (step && (step.kind === 'reach' || step.kind === 'hold') && hud && hud.setZoneDistance) {
    const d = Math.hypot(controller.pos.x - step.x, controller.pos.z - step.z);
    hud.setZoneDistance(inside ? null : d);
  }
}

/* ==========================================================================
   VERSUS MODE — two factions, AI fill, shrinking ring.
   Host-authoritative like everything else in LAN: the host simulates the
   zone, the fill bots and team scores; clients mirror via the snapshot.

   Honest limits (see docs/PROPOSAL-VERSUS-ZONE-MILESTONE.md §8):
   - Bots fight whoever is nearest — no squad coordination, no focus fire.
   - Bots do not path INTO the ring; outside damage eventually kills them.
   - Balance numbers (fill=4/side, 5s respawn, bot dps) are untested guesses.
   ========================================================================== */

const VERSUS_TEAM_SIZE = 4;
const VERSUS_KILL_TARGET = 40;
const VERSUS_RESPAWN_MS = 5000;
const VERSUS_GRACE_S = 20;   // no AI fire while the lobby spreads out

let versusBots = [];          // [{ e: Enemy, team, respawnAt }]
let zoneVisual = null;        // { wall, ringNext, ringNow }
let zonePlanes = [];          // active bombing-run flyovers
let zoneBombT = 6;            // seconds until the next gas airstrike
/** Per-faction squad coordination (shared intel / focus fire), host only. */
let teamBrains = [null, null];
let teamBrainAcc = 0;
/** Carry/use inventory: gear tiers + consumable pack (systems/inventory.js). */
let inventory = null;
let speedBoostT = 0;
/** One director per faction in versus — the PvE single instance scores one
    playerPos, which cannot serve two teams with different objectives. */
let teamDirectors = [null, null];
/** Round-based conquest (Phase 4b): host authority + client HUD mirror. */
let conquest = null;
let conquestMirror = null;
let conquestSyncT = 0;
let conquestBandT = 0;

/** Spawn point per team inside the site rect: team 0 at the site's objective
    zone, team 1 at the opposite end of the rect. */
/**
 * Spawn slot for one combatant: each faction owns one half of the site rect
 * and spreads its four members over a 2x2 grid inside that half, so a full
 * lobby covers the map instead of piling onto one point. `index` is the
 * combatant's slot within its team (humans first, then fill bots).
 */
const VERSUS_MAP_SPAWNS = [
  { x: 1, z: 33 },      // street
  { x: -96, z: 46 },    // old souk
  { x: 0, z: -165 },    // rail depot
  { x: 80, z: -80 },    // container yard
  { x: -190, z: 24 },   // west foothills
  { x: 130, z: -12 },   // dock
  { x: 98, z: -44 },    // port objective
  { x: -74, z: 12 },    // souk centre
];

/** Spawn across the whole playable map, not both teams at the same site. */
function versusSpawnSlot(team, index = 0, jitter = 2) {
  // Team 0 owns the first four map anchors; team 1 owns the other four and
  // never wraps onto the street anchor (solo 1v7 needs seven distinct points).
  // Conquest rounds swap the two halves every round (Phase 4b).
  const side = versusSideFor(team);
  const order = side === 0 ? [0, 1, 2, 3] : [4, 5, 6, 7, 1, 2, 3];
  const base = VERSUS_MAP_SPAWNS[order[index % order.length]];
  return {
    x: base.x + (Math.random() - 0.5) * jitter * 2,
    z: base.z + (Math.random() - 0.5) * jitter * 2,
    y: 0,
  };
}

/** Which map half `team` deploys on this round (conquest side swap). */
function versusSideFor(team) {
  const cs = conquestState();
  if (cs && cs.swap && (team === 0 || team === 1)) return 1 - team;
  return team === 1 ? 1 : 0;
}

/* ---- conquest rounds (Phase 4b, plan §5.2) ------------------------------------
   Round-based versus: 90 s or first to 25 points per round, best of 3 (max 5),
   sides swap each round, three control points pay hold income and act as
   forward respawns, a tied round goes to gas-forced sudden death. The host
   owns `conquest` as the authority; clients hold `conquestMirror` for the HUD
   and the spawn rule, synced by the `cquest` event every 2 s. ------------------ */

/** Three control points placed BETWEEN the two teams' spawn bands.

    Each faction deploys its four soldiers on anchors spread across the whole
    map, so "the middle" is not a line but a set of pinch regions where the
    two bands' anchors nearly touch. Those are the places the two sides can
    actually meet — and the only places a runner can reach inside one 90 s
    round (the old layout put points up to 78 m from a spawn, which no runner
    could cover before the clock ran out).

    Selection: the cheapest "between" candidate (a point equidistant from a
    blue-band and a red-band anchor), then the cheapest one at the opposite
    end of the map, then the cheapest one clear of both. On this map that
    yields two objectives costing BOTH bands exactly the same walk (~20 m)
    plus one neutral prize in between (~39 m) — the round stays a genuine
    contest whichever side a faction is on, and stays fair after the
    side swap. */
function conquestPointsBetweenSpawns() {
  const bandA = VERSUS_MAP_SPAWNS.slice(0, 4);   // side 0 anchors
  const bandB = VERSUS_MAP_SPAWNS.slice(4, 8);   // side 1 anchors
  const d = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
  const cands = [];
  for (const a of bandA) {
    for (const b of bandB) {
      const p = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const dA = Math.min(...bandA.map((q) => d(p, q)));
      const dB = Math.min(...bandB.map((q) => d(p, q)));
      cands.push({ x: p.x, z: p.z, dA, dB, cost: Math.max(dA, dB) });
    }
  }
  cands.sort((p, q) => p.cost - q.cost);
  const p0 = cands[0];
  const opposite = cands.find((c) => d(c, p0) >= 60) || cands[cands.length - 1];
  const middle = cands.find((c) => c !== p0 && c !== opposite
    && d(c, p0) >= 20 && d(c, opposite) >= 20) || cands[2];
  const chosen = [p0, opposite, middle].sort((a, b) => a.x - b.x);   // west → mid → east
  const names = ['west', 'mid', 'east'];
  const out = [];
  for (let i = 0; i < chosen.length; i += 1) {
    const c = chosen[i];
    // snap onto walkable ground — a point inside a wall can never be held
    const sp = nav ? resolveSpawn(c.x, c.z, 0) : null;
    let x = sp ? sp.x : c.x;
    let z = sp ? sp.z : c.z;
    // a snapped point must not land on top of another one
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 14)) { x = c.x; z = c.z; }
    out.push({ id: names[i], x, z, r: CONQUEST.CAP_RADIUS });
  }
  return out;
}

function conquestState() {
  if (conquest) return conquest.state;
  if (conquestMirror) return conquestMirror.state;
  return null;
}

function conquestHudLine(cs) {
  const mm = Math.floor(Math.max(0, cs.t) / 60);
  const ss = String(Math.floor(Math.max(0, cs.t) % 60)).padStart(2, '0');
  const own = cs.points.reduce((acc, p) => { if (p.owner === 0 || p.owner === 1) acc[p.owner] += 1; return acc; }, [0, 0]);
  const phase = cs.phase === 'over' ? '加时 · 先得分者胜' : cs.phase === 'inter' ? '回合结束' : `${mm}:${ss}`;
  return `R${cs.round} 蓝 ${cs.pts[0]} : ${cs.pts[1]} 红 · ${phase} · 点位 ${own[0]}-${own[1]} · 胜局 ${cs.wins[0]}-${cs.wins[1]}`;
}

function conquestHostInit() {
  conquest = createConquest({ points: conquestPointsBetweenSpawns() });
  conquestMirror = null;
  conquest.startRound();
}

function conquestClientInit(siteId) {
  conquestMirror = createConquest({ points: conquestPointsBetweenSpawns() });
  conquest = null;
}

/** Live hostiles of the OTHER faction from `team`'s point of view (humans on
    the host's mirrors + fill bots) — respawn siting wants them all. */
function conquestHostiles(team) {
  const out = [];
  for (const [id, r] of net.remote) {
    if (r.alive && r.team != null && r.team !== team) out.push({ x: r.x, z: r.z });
    if (r.alive && r.team == null && String(id) !== String(net.selfId) && net.team !== team) out.push({ x: r.x, z: r.z });
  }
  for (const b of versusBots) {
    if (b.e && b.e.alive && b.team !== team) out.push({ x: b.e.root.position.x, z: b.e.root.position.z });
  }
  return out;
}

/** Forward respawn: owned control points first, the default slot as fallback,
    scored away from live hostiles (nobody materialises inside a view cone). */
function pickVersusRespawn(team, fallbackSlot) {
  const cs = conquestState();
  const owned = cs ? (conquest || conquestMirror).ownedPoints(team) : [];
  return pickRespawnPoint({
    team, fallback: fallbackSlot, owned, hostiles: conquestHostiles(team),
    clearM: CONQUEST.ENEMY_SPAWN_CLEAR_M, rng: Math.random,
  }) || fallbackSlot;
}

function conquestSyncBroadcast() {
  if (!conquest || !lanSession) return;
  lanSession.broadcastEvent('cquest', { s: conquest.snapshot() });
}

function conquestPresence() {
  const cs = conquest.state;
  const n = cs.points.length;
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([0, 0]);
  const count = (x, z, team) => {
    for (let i = 0; i < n; i++) {
      const cp = cs.points[i];
      if (Math.hypot(x - cp.x, z - cp.z) <= cp.r) rows[i][team] += 1;
    }
  };
  if (G.hp > 0 && G.state !== 'dead') count(controller.pos.x, controller.pos.z, net.team === 1 ? 1 : 0);
  for (const r of net.remote.values()) {
    if (!r.alive) continue;
    count(r.x, r.z, r.team === 1 ? 1 : 0);
  }
  for (const b of versusBots) {
    if (b.e && b.e.alive) count(b.e.root.position.x, b.e.root.position.z, b.team === 1 ? 1 : 0);
  }
  return rows;
}

function handleConquestEvents(events) {
  if (!events || !events.length) return;
  for (const ev of events) {
    if (ev.type === 'capture') {
      const who = ev.team === 0 ? '蓝军' : '红军';
      if (hud && hud.addKillFeed) hud.addKillFeed(`${who} 占领控制点 ${ev.point}`);
      if (hud && hud.toast) hud.toast(`${who} 占领控制点${ev.from === 0 || ev.from === 1 ? '（易手）' : ''}`, 2200);
    } else if (ev.type === 'overtime') {
      if (hud && hud.toast) hud.toast('加时 · 毒圈启动 · 先得分者胜', 3200);
      // the gas IS the overtime mechanic: fast ring, host resumes ticking
      startZone(CONQUEST.OVERTIME_GAS_DELAY_S);
    } else if (ev.type === 'roundEnd') {
      const w = ev.winner === 0 ? '蓝军' : ev.winner === 1 ? '红军' : null;
      if (hud && hud.toast) hud.toast(w ? `回合 ${ev.round} 结束 · ${w}拿下 · ${ev.pts[0]}:${ev.pts[1]}` : `回合 ${ev.round} 平局 · ${ev.pts[0]}:${ev.pts[1]}`, 3400);
      // freeze combat for the intermission with the existing grace machinery
      G.versusGraceT = Math.max(G.versusGraceT, CONQUEST.INTERMISSION_S);
      if (ev.done) {
        conquestSyncBroadcast();
        checkVersusWin();
        return;
      }
    } else if (ev.type === 'intermissionOver') {
      startNextRound();
    }
  }
  conquestSyncBroadcast();
}

function startNextRound() {
  if (!conquest) return;
  const r = conquest.startRound();
  // the gas of the previous round (if overtime ran) does not carry over
  startZone();
  // redeploy EVERYONE on the swapped sides with a short no-fire window
  G.versusGraceT = CONQUEST.DEPLOY_S;
  G.versusGraceNotified = false;
  if (net.role === 'host') redeployVersusLocal();
  if (lanSession) lanSession.broadcastEvent('cround', { round: r.round, swap: r.swap, grace: CONQUEST.DEPLOY_S });
  const bots = versusBots.slice();
  for (const b of bots) {
    if (!b.e) continue;
    const slot = versusSpawnSlot(b.team, b.slot ?? 0, 3);
    b.e.spawn(slot.x, slot.z, Math.atan2(-(controller.pos.x - slot.x), -(controller.pos.z - slot.z)), 0);
    b.e.maxHp = 80; b.e.hp = 80;
    b.e.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
    b.respawnAt = 0;
    // the sides swapped — the old objective belongs to the other end of the
    // point line now, so the assignment is redone from scratch
    b.e.objectiveId = null;
    b.e.objectivePoint = null;
  }
  if (hud && hud.toast) hud.toast(`回合 ${r.round} · 部署阶段`, 2600);
  conquestSyncBroadcast();
}

/** Host tick: capture presence, round clock, events, rubber band, bot grace. */
function updateConquest(dt) {
  if (!conquest || G.versusOver) return;
  handleConquestEvents(conquest.tick(dt, conquestPresence(), G.versusGraceT > 0));
  // bot spawn-protection + accuracy rubber band decay
  for (const b of versusBots) {
    if (b.e && (b.e.spawnGraceT || 0) > 0) b.e.spawnGraceT = Math.max(0, b.e.spawnGraceT - dt);
  }
  conquestBandT += dt;
  if (conquestBandT >= 5) {
    conquestBandT = 0;
    const cs = conquest.state;
    const band = botRubberBand(cs.pts);
    for (const b of versusBots) {
      if (!b.e) continue;
      const base = DIFF_TIERS[2].accuracy;    // bots sit on the D3 baseline
      b.e.accuracyMult = base * band[b.team === 1 ? 1 : 0];
    }
  }
  conquestSyncT += dt;
  if (conquestSyncT >= 2) { conquestSyncT = 0; conquestSyncBroadcast(); }
}

/** Client: adopt a conquest snapshot. */
function conquestClientApply(s) {
  if (conquestMirror && s) conquestMirror.applySnapshot(s);
}

/** Client: a new round started — redeploy on the swapped side. */
function conquestRoundClient(msg) {
  if (net.role !== 'client' || !conquestMirror) return;
  redeployVersusLocal();
  G.versusGraceT = Number(msg.grace) || CONQUEST.DEPLOY_S;
  G.versusGraceNotified = false;
  if (hud && hud.toast) hud.toast(`回合 ${Number(msg.round) || '?'} · 部署阶段`, 2600);
}

/** Stand back up at your faction's slot, full health (round start / wipe). */
function redeployVersusLocal() {
  const mySlot = net.spawnSlots && net.spawnSlots[String(net.selfId)];
  const fallback = versusSpawnSlot(mySlot ? mySlot.team : (net.team ?? 0), mySlot ? mySlot.index : 0, 3);
  const sp = pickVersusRespawn(mySlot ? mySlot.team : (net.team ?? 0), fallback);
  G.hp = G.maxHp;
  G.armor = G.maxArmor;
  net.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
  G.state = 'playing';
  controller.revive(sp.x, sp.z);
  controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  viewmodel.state.dead = false;
  if (hud) { hud.setHealth(G.hp, pipsFor(G.armor)); hud.setHint(''); }
}

/** Team fill: pad each faction up to VERSUS_TEAM_SIZE with AI soldiers.
    Bots spawn at their own faction's end of the site, tuned to actually trade
    shots (veteran tier, hp 80, damage x1.8 — the campaign trade values make a
    bot duel drag). */
function startVersusBots(teams, lobbyPlayers) {
  versusBots = [];
  const counts = [0, 0];
  for (const id of Object.keys(teams || {})) counts[teams[id]] += 1;
  for (let team = 0; team < 2; team += 1) {
    // VERSUS 4v4: every faction is padded to VERSUS_TEAM_SIZE combatants with
    // AI (docs/MULTIPLAYER-DESIGN.md — "each team is padded to 4 combatants").
    // A solo host therefore gets 3 allies + 4 enemies, never a 1v7 deathmatch.
    const fill = Math.max(0, VERSUS_TEAM_SIZE - counts[team]);
    for (let i = 0; i < fill; i += 1) {
      // slot index continues after the humans so the whole squad spreads out
      const sp = versusSpawnSlot(team, counts[team] + i, 2.5);
      const e = spawnEnemy({ x: sp.x, z: sp.z, y: 0, profile: 'squad' }, { noRing: true, force: true });
      if (!e) break;
      e.team = team;
      // De-cheesed (Phase 4b): D3 baseline instead of D4 + x1.8 — fill bots
      // used to out-aim humans. The trailing faction's bots get a rubber-band
      // accuracy boost from updateConquest instead.
      if (e.setDifficulty) e.setDifficulty(DIFF_TIERS[2]);
      if (e.setArchetype && i % 3 === 1) e.setArchetype('rusher');
      e.maxHp = 80; e.hp = 80; e.damageMult = 1.15;
      e.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
      if (e._netId == null) e._netId = netEnemySeq++;
      versusBots.push({ e, team, slot: counts[team] + i, respawnAt: 0 });
    }
  }
  teamBrains = [createTeamBrain({ team: 0 }), createTeamBrain({ team: 1 })];
  teamBrainAcc = 0;
  teamDirectors = [
    new AIDirector(nav, level, {}),
    new AIDirector(nav, level, {}),
  ];
}

/**
 * Per-faction coordination tick (host, versus, 0.3 s cadence):
 *   - feed each brain who is alive, who sees what (bots carry their own
 *     canSee; humans get an honest line-of-sight approximation), and the
 *     ring centre as the fallback objective;
 *   - then run one director instance per faction around that faction's
 *     tactical focus, so flank/intel/cover all orbit the shared plan.
 */
/** Conquest objective: soldiers per faction work the control points.
    Nothing in the AI ever walked to a point, so the 25-point round could
    only be scored by a human who happened to stand on one — in practice
    nobody did, no point was ever owned, and every round ran out the clock
    as a 0:0 draw.

    Two rules keep the round alive:
      - the two factions take OPPOSITE ends of the point line. A contested
        point is frozen (neither side scores), so both factions chasing the
        same one would stall the round on 0:0.
      - a second soldier is sent whenever the enemy starts capturing a point
        the faction owns, otherwise a held point could be flipped for free. */
function assignConquestObjective(team) {
  const cs = conquest ? conquest.state : null;
  const squad = versusBots.filter((b) => b.team === team && b.e && b.e.alive);

  // 1. drop assignments whose point is gone or whose runner died
  for (const b of versusBots) {
    if (b.team !== team || !b.e) continue;
    const id = b.e.objectiveId;
    if (id == null) { b.e.objectivePoint = null; continue; }
    const p = cs ? cs.points.find((q) => String(q.id) === String(id)) : null;
    if (!p || !b.e.alive) { b.e.objectiveId = null; b.e.objectivePoint = null; }
  }

  if (!cs || cs.phase !== 'live' || !cs.points || !cs.points.length) return;
  if (!squad.length) return;

  // 2. keep the standing runner. A point takes CAP_TIME_S (6 s) of
  //    uncontested presence to flip and then pays income only while someone
  //    stands on it — re-picking the runner every tick rotated the job and
  //    the capture never finished.
  const runner = squad.find((b) => b.e.objectiveId != null);
  if (runner) {
    const p = cs.points.find((q) => String(q.id) === String(runner.e.objectiveId));
    if (p && p.owner !== (1 - team)) {
      runner.e.objectivePoint = { x: p.x, z: p.z };
      runner.e.objectiveR = p.r || 6;
      // a point of ours is being taken right now: send a second soldier
      const threatened = cs.points.find((q) => q.owner === team
        && q.progTeam === (1 - team) && q.prog > 0);
      if (threatened) {
        const helper = squad.find((b) => b !== runner && b.e.objectiveId == null);
        if (helper) {
          helper.e.objectiveId = String(threatened.id);
          helper.e.objectivePoint = { x: threatened.x, z: threatened.z };
          helper.e.objectiveR = threatened.r || 6;
        }
      }
      return;
    }
    runner.e.objectiveId = null;
  }

  // 3. pick a point. The line of points runs west → east across the map;
  //    each faction takes the end of the line that faces its own side, so
  //    the two runners never contest the same point. Following the CURRENT
  //    side (not the team index) keeps the split correct after the round's
  //    side swap. The middle point is the last resort for both — it is the
  //    neutral prize, and both sides only fall back to it when both ends
  //    are taken.
  const side = versusSideFor(team);
  const ordered = cs.points.slice().sort((a, b) => a.x - b.x);
  const west = ordered[0];
  const east = ordered[ordered.length - 1];
  const middle = ordered.find((p) => p !== west && p !== east) || east;
  const preference = side === 0 ? [west, east, middle] : [east, west, middle];
  let chosen = null;
  for (const p of preference) {
    if (p.owner !== (1 - team)) { chosen = p; break; }
  }
  if (!chosen) chosen = preference[0];
  // the soldier with the shortest walk to it takes the job
  let pick = null, bestD = Infinity;
  for (const b of squad) {
    const d = Math.hypot(b.e.root.position.x - chosen.x, b.e.root.position.z - chosen.z);
    if (d < bestD) { bestD = d; pick = b; }
  }
  if (pick) {
    pick.e.objectiveId = String(chosen.id);
    pick.e.objectivePoint = { x: chosen.x, z: chosen.z };
    pick.e.objectiveR = chosen.r || 6;
  }
}

function updateTeamBrains(dt) {
  if (!G.versusMode || net.role !== 'host') return;
  teamBrainAcc += dt;
  if (teamBrainAcc < 0.3) return;
  const step = teamBrainAcc;
  teamBrainAcc = 0;

  const zs = zoneSys ? zoneSys.state : null;
  for (let t = 0; t < 2; t += 1) {
    const brain = teamBrains[t];
    if (!brain) continue;

    // squad members: bots use their own canSee; humans get an honest
    // approximation (range gate + 2D walkable line), because the host cannot
    // read a remote player's real view frustum.
    const allies = [];
    for (const b of versusBots) {
      const e = b.e;
      if (!e || b.team !== t || !e.alive) continue;
      const sees = new Set();
      if (e.canSee) {
        for (const other of versusBots) {
          if (other.team === t || !other.e || !other.e.alive) continue;
          const o = other.e.root.position;
          if (Math.hypot(o.x - e.root.position.x, o.z - e.root.position.z) < 12) {
            sees.add(`bot:${other.e._netId}`);
          }
        }
      }
      allies.push({
        x: e.root.position.x, z: e.root.position.z, alive: true,
        canSee: !!e.canSee, sees, hp: e.hp,
      });
    }
    const humanAlly = (r) => {
      const sees = new Set();
      for (const other of versusBots) {
        if (other.team === t || !other.e || !other.e.alive) continue;
        const o = other.e.root.position;
        if (Math.hypot(o.x - r.x, o.z - r.z) < 45
            && (!nav || !nav.lineWalkable || nav.lineWalkable(r.x, r.z, o.x, o.z))) {
          sees.add(`bot:${other.e._netId}`);
        }
      }
      return { x: r.x, z: r.z, alive: r.alive, canSee: r.alive, sees, hp: r.hp };
    };
    if (net.team === t && G.hp > 0 && G.state === 'playing') {
      allies.push(humanAlly({ x: controller.pos.x, z: controller.pos.z, hp: G.hp }));
    }
    for (const r of net.remote.values()) {
      if (r.team !== t || !r.alive) continue;
      allies.push(humanAlly(r));
    }

    // hostile actors from this faction's point of view
    const enemies = [];
    for (const b of versusBots) {
      const e = b.e;
      if (!e || b.team === t || !e.alive) continue;
      enemies.push({
        id: `bot:${e._netId}`, x: e.root.position.x, z: e.root.position.z,
        alive: true, hp: e.hp, freshness: 1 - e.hp / Math.max(1, e.maxHp),
      });
    }
    for (const r of net.remote.values()) {
      if (r.team === t || !r.alive) continue;
      enemies.push({ id: r.id, x: r.x, z: r.z, alive: true, hp: r.hp, isHuman: true, freshness: 1 });
    }
    if (net.team !== t && G.hp > 0 && G.state === 'playing') {
      enemies.push({
        id: net.selfId, x: controller.pos.x, z: controller.pos.z,
        alive: true, hp: G.hp, isHuman: true, freshness: 1,
      });
    }

    brain.observe({
      allies,
      enemies,
      ring: zs && !zs.finished ? { x: zs.x, z: zs.z } : null,
    });
    brain.tick(step);

    // one director per faction, scored around that faction's shared focus
    const focus = brain.focus || (zs ? { x: zs.x, z: zs.z } : controller.pos);
    const squad = versusBots.filter((b) => b.team === t && b.e && b.e.alive && b.e.root.visible).map((b) => b.e);
    if (teamDirectors[t] && squad.length) {
      teamDirectors[t].tick(step, squad, focus, G.diff);
    }
    // one soldier per faction works the control points
    assignConquestObjective(t);
  }
}

/** Nearest hostile actor for one AI soldier: humans first-class, plus fill
    bots of the other team. Co-op callers keep using nearestLanTarget. */
function nearestHostileActor(pos, selfTeam, preferredId = null) {
  // Focus fire: if the faction brain has a confirmed visible target and it is
  // still alive, every member aims at it instead of their own nearest. That
  // is what turns eight duelists into one squad.
  if (preferredId != null) {
    const pid = String(preferredId);
    if (pid.startsWith('bot:')) {
      const b = botById(pid.slice(4));
      if (b && b.e && b.e.alive && b.team !== selfTeam) {
        const o = b.e.root.position;
        return {
          id: pid, x: o.x, y: o.y, z: o.z,
          hp: b.e.hp, alive: true, speed: b.e.speed || 0, team: b.team, isBot: true,
        };
      }
    } else {
      const r = net.remote.get(pid);
      if (r && r.alive && (selfTeam == null || r.team !== selfTeam)) {
        return { id: r.id, x: r.x, y: r.y, z: r.z, hp: r.hp, alive: true, speed: r.speed || 0, team: r.team };
      }
    }
  }
  const human = nearestLanTarget(pos, selfTeam);
  // human is null when every human in reach is a teammate — the squad must
  // then hunt the enemy-team bots instead of firing on its own humans.
  let best = human;
  let bestD = human ? Math.hypot(pos.x - best.x, pos.z - best.z) : Infinity;
  for (const b of versusBots) {
    const e = b.e;
    if (!e || !e.alive) continue;
    if (selfTeam != null && b.team === selfTeam) continue;
    const d = Math.hypot(pos.x - e.root.position.x, pos.z - e.root.position.z);
    if (d < bestD) {
      bestD = d;
      best = {
        id: `bot:${e._netId}`,
        x: e.root.position.x, y: e.root.position.y, z: e.root.position.z,
        hp: e.hp, alive: true, speed: e.speed || 0, team: b.team, isBot: true,
      };
    }
  }
  return best;
}

function botById(netId) {
  for (const b of versusBots) {
    if (b.e && String(b.e._netId) === String(netId)) return b;
  }
  return null;
}

/** Series win check. Conquest owns match end now (round wins, Phase 4b);
    this is the single place a finished series turns into the end screen. */
function checkVersusWin() {
  if (!G.versusMode || G.versusOver) return;
  const cs = conquestState();
  if (cs && cs.phase === 'done') endVersusMatch(cs.matchWinner);
}

/** Match end, both ends: freeze combat, unlock the cursor, show the result
    overlay. The host additionally broadcasts `vend` so clients settle with
    the authoritative score. */
function endVersusMatch(winTeam) {
  if (!G.versusMode || G.versusOver) return;
  G.versusOver = true;
  if (G.state === 'playing' || G.state === 'dead') G.state = 'versusEnd';
  input.unlock();
  if (voice) voice.stop();
  const mine = net.team;
  const outcome = winTeam == null ? 'draw' : (mine != null && winTeam === mine ? 'win' : 'lose');
  if (hud && hud.toast) hud.toast(outcome === 'win' ? '胜利' : outcome === 'lose' ? '战败' : '平局', 4000);
  if (hud && hud.setObjective) {
    hud.setObjective(winTeam == null ? '平局' : `${winTeam === 0 ? '蓝军' : '红军'} 获胜`);
  }
  showVersusEnd(winTeam);
  if (net.role === 'host' && lanSession) {
    lanSession.broadcastEvent('vend', { win: winTeam, scores: G.teamScores.slice() });
  }
}

function showVersusEnd(winTeam) {
  const overlay = document.getElementById('versus-end');
  if (!overlay) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const mine = net.team;
  const outcome = winTeam == null ? 'draw' : (mine != null && winTeam === mine ? 'win' : 'lose');
  set('versus-end-kicker', outcome === 'win' ? 'VICTORY · 任务完成' : outcome === 'lose' ? 'DEFEAT · 任务失败' : 'DRAW · 势均力敌');
  set('versus-end-title', winTeam == null ? '平局' : (winTeam === 0 ? '蓝军获胜' : '红军获胜'));
  // Conquest matches are decided by ROUND wins, not by the old 40-kill
  // target — showing "目标 40 杀" here described a rule that no longer runs.
  const cs = conquestState();
  const wins = cs && cs.wins ? cs.wins : null;
  set('versus-end-sub', wins
    ? `回合 ${wins[0]} : ${wins[1]} · 击杀 ${G.teamScores[0]} : ${G.teamScores[1]}`
    : `蓝 ${G.teamScores[0]} : ${G.teamScores[1]} 红 · 目标 ${VERSUS_KILL_TARGET} 杀`);
  const statsEl = document.getElementById('versus-end-stats');
  if (statsEl) {
    const mins = Math.floor(G.time / 60);
    const secs = String(Math.floor(G.time % 60)).padStart(2, '0');
    statsEl.innerHTML = [
      ['蓝军', wins ? `${wins[0]} 回合` : G.teamScores[0]],
      ['红军', wins ? `${wins[1]} 回合` : G.teamScores[1]],
      ['击杀', `${G.teamScores[0]} : ${G.teamScores[1]}`],
      ['用时', `${mins}:${secs}`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }
  set('versus-end-debrief', outcome === 'win'
    ? '干得好。区域已控制，小队正在巩固防线。'
    : outcome === 'lose'
      ? '防线被撕开。重整装备，下一局拿回来。'
      : '双方谁都没能拿到决定性优势。');
  const rematchBtn = document.getElementById('versus-rematch');
  if (rematchBtn) {
    const can = net.role === 'host';
    rematchBtn.disabled = !can;
    rematchBtn.style.opacity = can ? '1' : '.4';
    rematchBtn.title = can ? '' : '仅房主可以再开一局';
  }
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideVersusEnd() {
  const overlay = document.getElementById('versus-end');
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

/** Host: reset the versus match in place (same lobby, same teams) and tell
    everyone to do the same via a fresh `start` event. */
function restartVersusMatch() {
  if (net.role !== 'host' || !G.versusMode || !lanSession) return;
  hideVersusEnd();
  resetGame();
  G.versusMode = true;
  G.versusOver = false;
  G.teamScores = [0, 0];
  G.versusGraceT = VERSUS_GRACE_S;
  G.versusGraceNotified = false;
  G.state = 'playing';
  const mySlot = net.spawnSlots && net.spawnSlots[String(net.selfId)];
  const sp = versusSpawnSlot(mySlot ? mySlot.team : (net.team ?? 0), mySlot ? mySlot.index : 0, 3);
  controller.revive(sp.x, sp.z);
  controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  G.diff = DIFF_TIERS[3];
  firingSlots.max = 4;
  resetFiringSlots();
  startZone();
  conquestHostInit();
  startVersusBots(net.teamAssignments || {}, lanSession.players || []);
  conquestSyncBroadcast();
  for (const r of net.remote.values()) {
    r.hp = 100; r.alive = true; r.respawnAt = 0; r.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
    if (r.avatar) r.avatar.alive = true;
  }
  if (hud) {
    hud.setMode('VERSUS', '回合制征服 · 蓝军 vs 红军');
    hud.setHealth(G.hp, pipsFor(G.armor));
  }
  input.lock();
  lanSession.broadcastEvent('start', {
    wave: 1, site: G.site && G.site.id, versus: true,
    teams: net.teamAssignments, grace: G.versusGraceT, rematch: true,
  });
}

/** Client mirror of restartVersusMatch: rebuild local state from the same
    lobby data (teams/slots were mirrored at the first start). */
function restartVersusClient(startMsg) {
  if (net.role !== 'client') return;
  hideVersusEnd();
  // mirrored enemies belong to the old match: dispose them before resetGame
  // hides everything (they live in BOTH net.enemies and the enemies array)
  for (const [id, e] of net.enemies) {
    try { engine.scene.remove(e.root); if (e.dispose) e.dispose(); } catch (err) { /* ignore */ }
  }
  net.enemies.clear();
  for (let i = enemies.length - 1; i >= 0; i -= 1) if (enemies[i].netRemote) enemies.splice(i, 1);
  if (startMsg && startMsg.teams) {
    net.teamAssignments = startMsg.teams;
    net.team = startMsg.teams[String(net.selfId)] ?? net.team;
    net.spawnSlots = {};
    const seen = [0, 0];
    Object.keys(startMsg.teams).forEach((pid) => {
      const t = startMsg.teams[pid] ?? 0;
      net.spawnSlots[String(pid)] = { team: t, index: seen[t]++ };
    });
  }
  resetGame();
  G.versusMode = true;
  G.versusOver = false;
  G.teamScores = [0, 0];
  G.versusGraceT = (startMsg && Number(startMsg.grace)) || VERSUS_GRACE_S;
  G.versusGraceNotified = false;
  G.state = 'playing';
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  netZoneMirror = createZone({
    rect: (level && level.bounds) ? { ...level.bounds } : (G.site ? G.site.rect : undefined),
    startDelay: 120, warnAt: 15,
  });
  G.zoneWarned = false;
  ensureZoneVisual();
  const mySlot = net.spawnSlots && net.spawnSlots[String(net.selfId)];
  const sp = versusSpawnSlot(mySlot ? mySlot.team : (net.team ?? 0), mySlot ? mySlot.index : 0, 3);
  controller.revive(sp.x, sp.z);
  controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  for (const r of net.remote.values()) {
    r.hp = 100; r.alive = true; r.respawnAt = 0;
    if (r.avatar) r.avatar.alive = true;
  }
  if (hud) {
    hud.setMode('VERSUS', '蓝军 vs 红军');
    hud.setHealth(G.hp, pipsFor(G.armor));
    if (hud.toast) hud.toast('再来一局 · 部署阶段', 2600);
  }
  input.lock();
}

/** Host-side versus kill bookkeeping: team score + respawn + kill feed. */
function onVersusDeath(victimTeam, killerTeam, victimLabel) {
  if (!G.versusMode || G.versusOver) return;
  if (Number.isFinite(killerTeam) && killerTeam !== victimTeam) {
    G.teamScores[killerTeam] = (G.teamScores[killerTeam] || 0) + 1;
    // round points (Phase 4b): a kill is one point toward the 25-point round
    if (conquest) handleConquestEvents([conquest.kill(killerTeam)].filter(Boolean));
  }
  if (hud && hud.addKillFeed) {
    const who = Number.isFinite(killerTeam) ? (killerTeam === 0 ? '蓝军' : '红军') : '毒圈';
    hud.addKillFeed(`${who} 击杀 ${victimLabel || '目标'}`);
  }
  checkVersusWin();
}

/* ---- ring: host authority + shared visuals -------------------------------- */

function ensureZoneVisual() {
  if (zoneVisual || !engine) return;
  const THREE_ = engine.THREE || THREE;
  const wallMat = new THREE_.MeshBasicMaterial({
    color: 0x59d6c9, transparent: true, opacity: 0.14,
    side: THREE_.DoubleSide, depthWrite: false,
  });
  const wall = new THREE_.Mesh(new THREE_.CylinderGeometry(1, 1, 30, 72, 1, true), wallMat);
  wall.position.y = 12;
  wall.renderOrder = 5;
  engine.scene.add(wall);

  const ringMat = new THREE_.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.35, side: THREE_.DoubleSide, depthWrite: false,
  });
  const ringNext = new THREE_.Mesh(new THREE_.RingGeometry(0.96, 1, 72), ringMat);
  ringNext.rotation.x = -Math.PI / 2;
  ringNext.position.y = 0.12;
  ringNext.renderOrder = 5;
  engine.scene.add(ringNext);

  const ringNowMat = new THREE_.MeshBasicMaterial({
    color: 0x59d6c9, transparent: true, opacity: 0.5, side: THREE_.DoubleSide, depthWrite: false,
  });
  const ringNow = new THREE_.Mesh(new THREE_.RingGeometry(0.985, 1, 96), ringNowMat);
  ringNow.rotation.x = -Math.PI / 2;
  ringNow.position.y = 0.1;
  ringNow.renderOrder = 5;
  engine.scene.add(ringNow);

  zoneVisual = { wall, ringNext, ringNow };
}

function disposeZoneVisual() {
  if (!zoneVisual) return;
  for (const key of ['wall', 'ringNext', 'ringNow']) {
    const m = zoneVisual[key];
    if (m) {
      engine.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
  }
  zoneVisual = null;
}

function startZone(startDelay = 120) {
  // Versus/BR zone covers the whole playable map (city + dock + foothills);
  // co-op keeps the site rect. Overtime passes a short delay: the fast ring.
  const rect = G.versusMode && level && level.bounds
    ? { ...level.bounds }
    : (G.playRect || (G.site && G.site.rect));
  if (!rect) return;
  zoneSys = createZone({ rect, startDelay, warnAt: 15 });
  G.zoneWarned = false;
  G.zoneDmgT = 0;
  ensureZoneVisual();
}

function stopZone() {
  zoneSys = null;
  G.zoneWarned = false;
  disposeZoneVisual();
}

/** Zone damage: no red flash, no shake, no hurt sound — the player must be
    able to TELL gas apart from being shot. Blocks regen while active. */
function applyZoneDamage(amount) {
  if (amount <= 0 || G.state !== 'playing') return;
  G.hp = Math.max(0, G.hp - amount);
  G.sinceDamage = 99;             // no passive regen inside the gas
  if (hud && hud.setHealth) hud.setHealth(G.hp, pipsFor(G.armor));
  if (G.hp <= 0 && net.role) {
    playerDie();
  }
}

/** A visible bomber crosses the gas target; host schedules the real shells,
    clients receive the same point and replay only the visual/audio. */
function spawnBombingRun(x, z, broadcast = true) {
  if (!engine || !Number.isFinite(x) || !Number.isFinite(z)) return;
  const mats = engine.mats;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.7, 1.0), mats.metal);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(8.0, 0.12, 2.5), mats.metal);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.6), mats.metal);
  wing.position.z = 0.1;
  tail.position.set(-2.2, 0.35, 0);
  body.castShadow = false; wing.castShadow = false; tail.castShadow = false;
  g.add(body, wing, tail);
  const dir = Math.random() * Math.PI * 2;
  const dx = Math.cos(dir), dz = Math.sin(dir);
  const from = new THREE.Vector3(x - dx * 80, 48, z - dz * 80);
  const to = new THREE.Vector3(x + dx * 80, 48, z + dz * 80);
  g.position.copy(from);
  g.rotation.y = Math.atan2(dx, dz);
  engine.scene.add(g);
  zonePlanes.push({ g, from, to, t: 0, dur: 2.8, target: new THREE.Vector3(x, 0.1, z) });
  if (audio && audio.grenadeBeep) audio.grenadeBeep(0, true);
  if (hud && hud.toast) hud.toast('空袭警报 · 毒圈内目标', 1800);
  if (broadcast) {
    if (artillery) artillery.strike(new THREE.Vector3(x, 0.1, z), { shells: 2, radius: 7, spread: 9, delay: 1.5 });
    if (lanSession) lanSession.broadcastEvent('airstrike', { x, z });
  } else {
    // client: no authoritative damage, just the visible bombs
    setTimeout(() => {
      if (!fx) return;
      fx.explosion(new THREE.Vector3(x, 0.4, z), 1.0);
      if (audio && audio.explosion) audio.explosion(0, 12);
    }, 1500);
  }
}

function updateZonePlanes(dt) {
  for (let i = zonePlanes.length - 1; i >= 0; i -= 1) {
    const p = zonePlanes[i];
    p.t += dt;
    const k = Math.min(1, p.t / p.dur);
    p.g.position.lerpVectors(p.from, p.to, k);
    p.g.rotation.z = Math.sin(k * Math.PI) * 0.06;
    if (k >= 1) {
      engine.scene.remove(p.g);
      zonePlanes.splice(i, 1);
    }
  }
}

/** Host-only: every few seconds, bomb one actor that is outside the ring. */
function updateZoneBombing(dt, zs) {
  if (!G.versusMode || net.role !== 'host' || !zs || !zs.started || G.versusOver) return;
  zoneBombT -= dt;
  if (zoneBombT > 0) return;
  const out = [];
  const px = controller.pos.x, pz = controller.pos.z;
  if (zs.distance > 0.5) out.push({ x: px, z: pz });
  for (const r of net.remote.values()) {
    if (!r.alive) continue;
    if (Math.hypot(r.x - zs.x, r.z - zs.z) > zs.r) out.push({ x: r.x, z: r.z });
  }
  for (const b of versusBots) {
    if (!b.e || !b.e.alive) continue;
    const p = b.e.root.position;
    if (Math.hypot(p.x - zs.x, p.z - zs.z) > zs.r) out.push({ x: p.x, z: p.z });
  }
  if (!out.length) { zoneBombT = 3; return; }
  const t = out[(Math.random() * out.length) | 0];
  spawnBombingRun(t.x + (Math.random() - 0.5) * 4, t.z + (Math.random() - 0.5) * 4, true);
  zoneBombT = 5 + Math.random() * 3;
}

function announceZoneWarning() {
  if (G.zoneWarned) return;
  G.zoneWarned = true;
  // MiniMax VEGA recording; voice.js falls back to zh-CN TTS only if the
  // MP3 is missing or fails to decode.
  if (hud && hud.radio) hud.radio('VEGA', '毒圈将在 15 秒后开始收缩。立即向安全区转移。', 5600, 'zone_warning');
}

function updateZone(dt) {
  updateZonePlanes(dt);
  // authoritative on the host, mirror on the client — both drive visuals
  const zs = net.role === 'host'
    ? (zoneSys ? zoneSys.update(dt, controller.pos.x, controller.pos.z) : null)
    : (netZoneMirror ? netZoneMirror.update(dt, controller.pos.x, controller.pos.z) : null);
  if (!zs) return;

  if (!zs.started) {
    if (zs.delayLeft <= 15) announceZoneWarning();
    // Ring is announced/previewed but does not hurt until its 2-minute start.
  } else if (zs.distance > 0.5) {
    // Brutal gas: one visible 10%-of-max-HP tick every second, not a smooth chip.
    G.zoneDmgT = (G.zoneDmgT || 0) + dt;
    if (G.zoneDmgT >= 1) {
      G.zoneDmgT -= 1;
      applyZoneDamage((G.maxHp || 100) * 0.10);
    }
  } else {
    G.zoneDmgT = 0;
  }

  updateZoneBombing(dt, zs);

  if (zoneVisual) {
    zoneVisual.wall.position.x = zs.x;
    zoneVisual.wall.position.z = zs.z;
    zoneVisual.wall.scale.set(zs.r, 1, zs.r);
    zoneVisual.ringNow.position.x = zs.x;
    zoneVisual.ringNow.position.z = zs.z;
    zoneVisual.ringNow.scale.set(zs.r, zs.r, 1);
    zoneVisual.ringNext.visible = !zs.finished && zs.nextR > 1;
    if (zoneVisual.ringNext.visible) {
      zoneVisual.ringNext.position.x = zs.nextX;
      zoneVisual.ringNext.position.z = zs.nextZ;
      zoneVisual.ringNext.scale.set(zs.nextR, zs.nextR, 1);
      zoneVisual.ringNext.material.opacity = zs.shrinking ? 0.12 : 0.3;
    }
  }

  if (hud && hud.setZoneDistance && zs.distance > 0.5) {
    hud.setZoneDistance(Math.round(zs.distance));
  }

  // objective line: 2-minute arming countdown, then score + ring countdown
  if (hud && hud.setObjective) {
    if (G.versusGraceT > 0) {
      hud.setObjective(`部署阶段 · ${Math.ceil(G.versusGraceT)}s 后交战 · 毒圈 ${Math.ceil(zs.delayLeft)}s 后开启`);
    } else if (!zs.started) {
      const left = Math.max(0, Math.ceil(zs.delayLeft));
      const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
      hud.setObjective(`蓝 ${G.teamScores[0]} : ${G.teamScores[1]} 红 · 毒圈 ${mm}:${ss} 后开启`);
    } else {
      const mins = Math.floor(zs.eta / 60);
      const secs = String(Math.floor(zs.eta % 60)).padStart(2, '0');
      const phase = zs.finished ? '最终圈' : (zs.shrinking ? '收缩中' : `缩圈 ${mins}:${secs}`);
      hud.setObjective(`蓝 ${G.teamScores[0]} : ${G.teamScores[1]} 红 · ${phase}`);
    }
  }
}

/** Host: respawn dead fill bots; gas also kills bots outside the ring. */
function updateVersusBots(dt) {
  if (!G.versusMode || net.role !== 'host' || G.versusOver) return;
  const zs = zoneSys ? zoneSys.state : null;
  const now = Date.now();
  for (const b of versusBots) {
    const e = b.e;
    if (!e) continue;
    if (e.alive && zs && !zs.finished) {
      const d = Math.hypot(e.root.position.x - zs.x, e.root.position.z - zs.z);
      if (d > zs.r) {
        // attackerTeam undefined → the friendly-fire branch is skipped and the
        // bot dies through the normal path; halved so gas is pressure, not a
        // bot exterminator (bots do not path into the ring — known limitation).
        // gas is 10% max HP/s, same rule as humans (no half-damage discount)
        const killed = e.takeDamage((e.maxHp || 100) * 0.10 * dt, null, null, 'torso', undefined);
        if (killed) onVersusBotDown(b, undefined);
      }
    }
    if (!e.alive && b.respawnAt && now >= b.respawnAt) {
      const sp = versusSpawnSlot(b.team, b.slot ?? 0, 4);
      e.spawn(sp.x, sp.z,
        Math.atan2(-(controller.pos.x - sp.x), -(controller.pos.z - sp.z)), 0);
      e.maxHp = 80; e.hp = 80;     // respawn with the tuned versus trade values
      b.respawnAt = 0;
    }
  }
}

/** AI bots are killed through takeDamage from other bots; route that through
    the versus bookkeeping and schedule the respawn (host only). */
function onVersusBotDown(bot, killerTeam) {
  if (net.role !== 'host') return;
  bot.respawnAt = Date.now() + VERSUS_RESPAWN_MS;
  onVersusDeath(bot.team, killerTeam, bot.team === 0 ? '蓝军AI' : '红军AI');
}

/* ---- player vs player ---------------------------------------------------- */

/** Shooter side: the local player hit a remote avatar. Same team → warning
    only; hostile → broadcast pdmg and apply locally for instant feedback. */
function versusPlayerHit(targetId, amount, headshot) {
  if (!G.versusMode || G.versusOver || G.versusGraceT > 0) return false;
  const r = net.remote.get(String(targetId));
  if (!r || !r.alive) return false;
  if (net.team != null && r.team != null && r.team === net.team) {
    if (hud && hud.toast) hud.toast('友军 · 停止射击', 1200);
    return true; // consumed, no damage
  }
  if (lanSession) {
    lanSession.broadcastEvent('pdmg', {
      target: String(targetId), amount, headshot, team: net.team,
    });
  }
  versusApplyPlayerDamage(String(targetId), amount, net.team, headshot);
  return true;
}

/** Receiver side: apply one player-inflicted hit to the local mirror. */
function versusApplyPlayerDamage(targetId, amount, killerTeam, headshot) {
  if (G.versusOver) return;
  const r = net.remote.get(String(targetId));
  if (!r || !r.alive) return;
  r.hp = Math.max(0, r.hp - amount);
  if (hud && hud.hit) hud.hit(!!headshot, r.hp <= 0);
  if (r.hp <= 0) {
    r.alive = false;
    if (r.avatar) r.avatar.alive = false;
    if (net.role === 'host') {
      // schedule the respawn on the authority, then score the kill
      r.respawnAt = Date.now() + VERSUS_RESPAWN_MS;
      onVersusDeath(r.team, Number.isFinite(killerTeam) ? killerTeam : undefined,
        String(r.name || '玩家'));
    }
    if (hud && hud.addKillFeed) {
      const who = Number.isFinite(killerTeam) ? (killerTeam === 0 ? '蓝军' : '红军') : '?';
      hud.addKillFeed(`${who} 击倒 ${r.name || '玩家'}`);
    }
  }
}

/** Host: respawn downed humans at their team spawn (snapshot carries it). */
function updateVersusRespawns(dt = 0) {
  if (!G.versusMode || net.role !== 'host' || G.versusOver) return;
  const now = Date.now();
  for (const r of net.remote.values()) {
    // tick down the remote player's post-respawn invulnerability
    if ((r.spawnGraceT || 0) > 0) r.spawnGraceT = Math.max(0, r.spawnGraceT - dt);
    if (r.alive || !r.respawnAt || now < r.respawnAt) continue;
    const reg = net.spawnSlots && net.spawnSlots[String(r.id)];
    const sp = versusSpawnSlot(reg ? reg.team : (r.team ?? 0),
      reg ? reg.index : Math.floor(Math.random() * VERSUS_TEAM_SIZE), 4);
    r.x = sp.x; r.z = sp.z; r.y = 0;
    r.hp = 100; r.alive = true;
    r.respawnAt = 0;
    r.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
    if (r.avatar) r.avatar.alive = true;
  }
}

function isSpawnAllowed(sp) {
  if (!level || !level.cqbZones) return true;
  for (const z of level.cqbZones) {
    const dZone = Math.hypot(sp.x - z.center.x, sp.z - z.center.z);
    if (dZone < (z.radius || 4) + 4.5) {
      // interior spawn: only use it when the player is fighting near that room
      const dPlayer = Math.hypot(controller.pos.x - z.center.x, controller.pos.z - z.center.z);
      return dPlayer < 14;
    }
  }
  return true;
}

/** Far spawn by default, but a slice of waves now arrives on the flank/behind
    so the player cannot camp one sightline (Sprint G). */
/* ---- spawn safety -------------------------------------------------------
   A spawn point is only usable if (a) it is on a walkable nav cell and
   (b) a ground path to the player exists. Without this, random +/-1 m jitter
   dropped enemies inside walls, containers or sealed rooms and both sides
   could never find each other. */
/* ---- spawn distance band --------------------------------------------------
   A wave has to ARRIVE. The old rules gated the distance on the ZONE
   centroid and then dropped the enemy on any point inside that zone, so a
   wave could materialise 60-140 m out — past every soldier's engagement
   range (rifleman 48 m) and past the perception cap (55 m). Nothing could
   see the player, nothing could reach him, and the wave simply never
   started. These bounds apply to the POINT, not to the zone. */
const SPAWN_BAND = { min: SPAWN_RULES.pointMin, max: SPAWN_RULES.pointMax };
const SPAWN_MAX = SPAWN_RULES.hardMax;

/** Distance from a spawn point to the player (m). */
function spawnDistTo(sp) {
  const p = controller.pos;
  return Math.hypot(sp.x - p.x, sp.z - p.z);
}

/** Is this spawn point inside the preferred band? */
function spawnInBand(sp) {
  const d = spawnDistTo(sp);
  return d >= SPAWN_BAND.min && d <= SPAWN_BAND.max;
}

/** Is this spawn point close enough that the player can plausibly be met? */
function spawnWithinReach(sp) {
  return spawnDistTo(sp) <= SPAWN_MAX;
}

function resolveSpawn(x, z, y = 0) {
  if (nav.isWalkableAt ? nav.isWalkableAt(x, z, y) : nav.isWalkable(x, z)) return { x, z, y };
  const w = nav.closestWalkableOn ? nav.closestWalkableOn(x, z, y) : nav.closestWalkable(x, z);
  return w ? { x: w.x, z: w.z, y } : null;
}

function spawnReachesPlayer(sp) {
  if (sp.y > 1) return true;
  return !!nav.findPath(sp.x, sp.z, 0, controller.pos.x, controller.pos.z, controller.pos.y);
}

function ringSpawn(minR = 12, maxR = 24) {
  const p = controller.pos;
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + Math.random() * 0.35;
    const r = minR + Math.random() * (maxR - minR);
    const sp = resolveSpawn(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 0);
    if (sp && spawnReachesPlayer(sp)) return sp;
  }
  return null;
}

function normalizeSpawns() {
  if (!level || !nav) return;
  for (const sp of level.spawnPoints || []) {
    const r = resolveSpawn(sp.x, sp.z, 0);
    if (r) { sp.x = r.x; sp.z = r.z; }
  }
  for (const sp of level.roofSpawns || []) {
    const r = resolveSpawn(sp.x, sp.z, sp.y || 3.2);
    if (r) { sp.x = r.x; sp.z = r.z; }
  }
}

function validCandidates(pool, requirePath) {
  const out = [];
  const seen = new Set();
  for (const sp of pool) {
    const key = `${sp.x.toFixed(1)}:${sp.z.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = resolveSpawn(sp.x, sp.z, sp.y || 0);
    if (!r) continue;
    if (requirePath && !spawnReachesPlayer(r)) continue;
    out.push(r);
  }
  return out;
}

function pickSpawnPoint(pool, allowFlank, requirePath = true, rng = Math.random) {
  const p = controller.pos;
  const valid = validCandidates(pool, requirePath);
  if (!valid.length) {
    if (requirePath) return ringSpawn();
    const any = validCandidates(pool, false);
    return any.length ? any[Math.floor(rng() * any.length)] : ringSpawn();
  }
  // The old picker kept "the farthest point" as its last resort, which is how
  // a wave ended up 130 m away with nobody able to perceive the player.
  // The last resort is now the CLOSEST point, and anything past SPAWN_MAX is
  // rejected outright.
  const bandMid = (SPAWN_BAND.min + SPAWN_BAND.max) / 2;
  let inBand = null, inBandD = 1e9;     // closest to the band centre
  let nearest = null, nearestD = 1e9;   // closest point at or beyond the band
  let beyond = null, beyondD = 1e9;     // closest point past the band but in reach
  let anyAtAll = null, anyD = 1e9;      // absolute last resort (keeps the wave count)
  let flank = null, flankD = -1;
  const H = controller.headingDeg * Math.PI / 180;
  const fx = Math.sin(H), fz = -Math.cos(H);
  for (const sp of valid) {
    const dx = sp.x - p.x, dz = sp.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < anyD) { anyD = d; anyAtAll = sp; }
    if (d > SPAWN_MAX) continue;                  // out of reach of every sense
    if (d >= SPAWN_BAND.min && d <= SPAWN_BAND.max) {
      const off = Math.abs(d - bandMid);
      if (off < inBandD) { inBandD = off; inBand = sp; }
    }
    if (d >= SPAWN_BAND.min && d < nearestD) { nearestD = d; nearest = sp; }
    if (d > SPAWN_BAND.max && d < beyondD) { beyondD = d; beyond = sp; }
    if (d > 16 && d < 52) {
      const front = (dx * fx + dz * fz) / Math.max(1, d);
      if (front < -0.15 && d > flankD) { flankD = d; flank = sp; }
    }
  }
  /* The flank is a WAVE-level decision, not a per-enemy coin flip. It used
     to be rolled once per soldier, so one wave could mix a front spawn and a
     rear spawn for no reason the player could learn. The caller now decides
     once per wave (from the seeded wave rng) and passes the boolean here,
     which keeps the "you cannot camp one sightline" intent while making the
     whole wave agree on which side it comes from. */
  if (allowFlank && flank) return flank;
  return inBand || nearest || beyond || anyAtAll || ringSpawn();
}

function pickZoneSpawn(pool, zone, rng = Math.random) {
  const near = pool.filter((p2) => {
    const d = Math.hypot(p2.x - zone.x, p2.z - zone.z);
    return d > 7 && d < 30;
  });
  const src = near.length ? near : pool;
  const valid = validCandidates(src, true);
  // a point the player could never perceive is not a spawn, it is scenery
  const reachable = valid.filter((sp) => spawnWithinReach(sp));
  const use = reachable.length ? reachable : valid;
  if (use.length) return use[Math.floor(rng() * use.length)];
  return pickSpawnPoint(pool, false, true, rng) || ringSpawn();
}

function spawnReinforcements(count) {
  if (!level || !level.spawnPoints || !level.spawnPoints.length) return;
  // defend pressure keeps arriving along the attack axes, not from a flat pool
  const picks = buildWaveSpawnPlan(G.wave, count);
  const waveRng = spawnRngFor(G.mode, G.wave);
  // one flank decision for the whole reinforcement batch
  const waveFlank = waveRng() < 0.34;
  for (let i = 0; i < count; i++) {
    let best = null;
    if (picks.length) best = placePlanPick(picks[i % picks.length], false);
    if (!best) {
      const allowed = level.spawnPoints.filter(isSpawnAllowed);
      const src = allowed.length ? allowed : level.spawnPoints;
      best = pickSpawnPoint(src, waveFlank, true, waveRng);
    }
    if (!best) break;
    G.spawnQueue.push({
      x: best.x, z: best.z, y: best.y || 0, type: chooseArchetype(G.wave, i),
      profile: waveProfileName(), anchor: missionAnchor(),
    });
  }
  G.waveRemaining += count;
  G.waveTotal += count;
}

/** Extraction countdown started: spawn a pursuit element from the player's
    blind rear (rusher-weighted) so holding the zone is a fight, not a wait. */
function spawnPursuitWave(count) {
  if (!spawnDirector || !spawnDirector.zones.length || !G.objective) return;
  const zones = zonesWithinRect(spawnDirector.zones, G.playRect);
  const waveRng = spawnRngFor('extract:pursuit', G.wave);
  let picks = spawnDirector.pickExtract({
    zones, extractZone: G.objective.zone, playerPos: controller.pos,
    playerFacingDeg: controller.headingDeg, phase: 'pursuit', count, rng: waveRng,
  });
  // relaxed retry, then the neutral band-respecting picker — a pursuit wave
  // that never arrives is worse than one that arrives from a plainer angle
  if (!picks.length) {
    picks = spawnDirector.pickExtract({
      zones, extractZone: G.objective.zone, playerPos: controller.pos,
      playerFacingDeg: controller.headingDeg, phase: 'pursuit', count,
      rng: waveRng, relaxed: true,
    });
  }
  if (!picks.length) {
    picks = pickNeutralSpawns({ zones, playerPos: controller.pos, count, rng: waveRng });
  }
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    let best = null;
    if (picks.length) best = placePlanPick(picks[i % picks.length], false);
    if (!best) best = pickSpawnPoint(level.spawnPoints, true, true, waveRng);
    if (!best) continue;
    spawned++;
    G.spawnQueue.push({
      x: best.x, z: best.z, y: best.y || 0,
      type: Math.random() < 0.6 ? 'rusher' : 'rifleman',
      profile: 'interceptorPursuit', anchor: missionAnchor(),
    });
  }
  if (spawned) {
    G.waveRemaining += spawned;
    G.waveTotal += spawned;
    if (hud && hud.toast) hud.toast('撤离窗口开启 · 身后有追兵', 2400);
    if (hud && hud.radio) hud.radio('VEGA', '他们嗅到撤退路线了。身后有追兵，边打边撤。', 3200, 'stage_clear');
  }
}

function onObjectiveDone() {
  const obj = G.objective;
  if (!obj || obj.done) return;
  obj.done = true;
  if (G.stats) G.stats.objectiveCleared = true;
  if (hud && hud.setHint) hud.setHint(obj.type === 'defend' ? 'ZONE SECURED' : obj.type === 'infil' ? 'INFILTRATED' : 'EXTRACTED');
  if (audio && audio.ctx) audio.uiConfirm();
  // beat-driven ops: this beat is done — advance to the next one (the op
  // finishes via advanceBeat when the chain runs out)
  if (G.operation && G.operation.beats) {
    setTimeout(() => advanceBeat(), 1200);
    return;
  }
  if (G.operation && G.operation.mode !== 'survival') {
    // defend/extract operations end on the objective, not on the last corpse
    setTimeout(() => { if (G.state === 'playing' && G.operation) finishOperation(); }, 1400);
  }
  if (beacon) {
    beacon.done = true;
    beacon.ringMat.color.setHex(0x9dffa8);
    beacon.colMat.color.setHex(0x9dffa8);
    beacon.markerMat.color.setHex(0x9dffa8);
  }
}

function updateObjective(dt) {
  const obj = G.objective;
  if (!obj) return;
  const p = controller.pos;
  const dist = Math.hypot(p.x - obj.zone.x, p.z - obj.zone.z);
  obj.inside = dist <= obj.zone.r;

  if (obj.type === 'defend') {
    if (!obj.done) {
      if (obj.inside) obj.hold = Math.min(obj.need, obj.hold + dt);
      else obj.hold = Math.max(0, obj.hold - dt * 0.6);
      if (obj.hold >= obj.need) onObjectiveDone();
    }
  } else if (obj.type === 'extract') {
    if (!obj.ready) {
      const clear = G.waveRemaining <= 0 && G.spawnQueue.length === 0 && enemies.every((e) => !e.alive);
      if (clear) {
        obj.ready = true;
        if (hud && hud.setHint) hud.setHint('AREA CLEAR — EXTRACT');
        if (hud && hud.setMode) hud.setMode('EXTRACT', 'REACH THE ZONE');
        // the window opening is the trigger: hunters spawn from the player's
        // blind rear and chase along the extraction route
        spawnPursuitWave(3);
      }
    } else if (!obj.done && obj.inside) {
    obj.hold = Math.min(obj.need, obj.hold + dt);
    if (obj.hold >= obj.need) onObjectiveDone();
  }
  } else if (obj.type === 'infil') {
    // a reach goal with no drain and no clear requirement: kills are
    // optional, ghosting past the garrison is legal
    if (!obj.done && obj.inside) {
      obj.hold = Math.min(obj.need, obj.hold + dt);
      if (obj.hold >= obj.need) onObjectiveDone();
    }
  }
  // 'interact' completes from the interact target's onUse — nothing per-frame

  if (hud && hud.setModeProgress) {
    const pct = obj.need ? obj.hold / obj.need : 0;
    let text;
    if (obj.done) text = obj.type === 'defend' ? 'ZONE SECURED' : obj.type === 'infil' ? 'INFILTRATED' : 'EXTRACTED';
    else if (obj.type === 'defend') text = `${Math.ceil(obj.hold)} / ${obj.need}s · ${obj.inside ? 'HOLDING' : 'RETURN TO ZONE'}`;
    else if (obj.type === 'infil') text = `${obj.hold.toFixed(1)} / ${obj.need}s · ${obj.inside ? 'INFILTRATING' : 'REACH THE ZONE'}`;
    else if (obj.type === 'interact') text = 'SEARCH THE OBJECTIVE';
    else if (!obj.ready) text = 'CLEAR THE AREA';
    else text = `${obj.hold.toFixed(1)} / ${obj.need}s · ${obj.inside ? 'EXTRACTING' : 'REACH THE ZONE'}`;
    const active = obj.done || (obj.type === 'defend' ? obj.inside : (obj.ready && obj.inside));
    hud.setModeProgress(pct, text, active);
  }
  if (hud && hud.setZoneDistance) hud.setZoneDistance(!obj.inside && !obj.done ? dist : null);
}

function ensureBeacon() {
  if (beacon || !engine) return;
  const group = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffb25e, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 64), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);
  const colMat = new THREE.MeshBasicMaterial({
    color: 0xffb25e, transparent: true, opacity: 0.08,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, depthTest: false,
  });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10.0, 20, 1, true), colMat);
  col.position.y = 5.0;
  col.renderOrder = 8;
  group.add(col);
  const markerMat = new THREE.MeshBasicMaterial({
    color: 0xffb25e, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), markerMat);
  marker.position.y = 7.6;
  marker.renderOrder = 8;
  group.add(marker);
  group.visible = false;
  group.renderOrder = 8;
  engine.scene.add(group);
  beacon = { group, ring, col, marker, ringMat, colMat, markerMat, t: 0, done: false };
}

function showBeacon(zone, mode) {
  ensureBeacon();
  if (!beacon) return;
  beacon.group.visible = true;
  beacon.group.position.set(zone.x, 0, zone.z);
  beacon.ring.scale.set(zone.r, zone.r, 1);
  beacon.done = false;
  beacon.zone = zone;
  beacon.col.visible = true;
  beacon.marker.visible = true;
  const c = mode === 'extract' ? 0x55d6e0 : 0xffb25e;
  beacon.ringMat.color.setHex(c);
  beacon.colMat.color.setHex(c);
  beacon.markerMat.color.setHex(c);
}

function hideObjectiveUI() {
  if (beacon) beacon.group.visible = false;
  if (!hud) return;
  if (hud.hideMode) hud.hideMode();
  if (hud.setModeProgress) hud.setModeProgress(0, '', false);
  if (hud.setZoneDistance) hud.setZoneDistance(null);
}

function updateBeacon(dt) {
  if (!beacon || !beacon.group.visible) return;
  beacon.t += dt;
  if (beacon.zone) {
    const cam = engine.camera.position;
    const d = Math.hypot(cam.x - beacon.zone.x, cam.z - beacon.zone.z);
    const close = d < beacon.zone.r + 1.2;
    beacon.col.visible = !close;
    beacon.marker.visible = !close;
  }
  const pulse = 0.5 + 0.5 * Math.sin(beacon.t * 3.2);
  beacon.ringMat.opacity = (beacon.done ? 0.55 : 0.32) + pulse * 0.22;
  beacon.colMat.opacity = (beacon.done ? 0.18 : 0.11) + pulse * 0.07;
  beacon.markerMat.opacity = 0.65 + pulse * 0.3;
  beacon.ring.rotation.z += dt * 0.25;
  beacon.marker.rotation.y += dt * 1.4;
  beacon.marker.position.y = 7.6 + Math.sin(beacon.t * 2.2) * 0.22;
}

async function boot() {
  try {
    setLoading(0.05, '初始化渲染器…');
    await nextFrame();

    G.settings = loadSettings();
    if (G.settings.runMode === 'campaign') {
      campaignActive = true;
      const op = chooseCampaignOperation();
      campaign.selected = op.id;
      saveCampaign(campaign);
    }
    G.tutorial.done = tutorialDone();
    engine = createEngine(document.getElementById('gl'), G.settings.quality);

    // GPU context can be lost (tab backgrounded on low VRAM, driver reset).
    // Pause and tell the player instead of silently rendering a black frame;
    // after restore, three's GPU resources cannot be trusted — reload is the
    // honest recovery path.
    const glCanvas = document.getElementById('gl');
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (G.state === 'playing' || G.state === 'dead') {
        G.state = 'paused';
        pauseEl.classList.remove('hidden');
        input.unlock();
      }
      if (hud && hud.toast) hud.toast('显卡上下文丢失，已暂停。');
    });
    glCanvas.addEventListener('webglcontextrestored', () => {
      if (hud && hud.toast) hud.toast('显卡上下文已恢复，正在重新加载…');
      setTimeout(() => location.reload(), 600);
    });

    setLoading(0.34, '生成程序化 PBR 材质与大气…');
    await nextFrame();

    level = createLevel(engine);
    nav = createNavGrid(level, { cell: 0.8, radius: 0.32, groundAt: (x, z, y) => level.groundHeight(x, z, y), links: level.navLinks });
    normalizeSpawns();
    setLoading(0.58, '构建战区街区…');
    await nextFrame();

    viewmodel = createViewmodel(engine.mats, engine.sky.envTexture);
    setLoading(0.72, '装配武器与手部动画…');
    await nextFrame();

    fx = createFX(engine.scene, engine.mats);
    audio = createAudio();
    weather = createWeatherSystem({ scene: engine.scene, engine, audio });
    weather.set('clear');
    hud = createHUD();
    voice = createVoice();
    voice.setEnabled(G.settings.voice !== false);
    hud.setVoicePlayer((id) => voice.play(id));
    cinema = createCinema({ engine, viewmodel, hud, voice });
    videoIntro = createVideoIntro();
    minimap = createMinimap({ level });
    cinema.setVoice(G.settings.voice !== false);
    input = createInput(engine.renderer.domElement);
    interact = createInteract({ hud, input, onUse: () => { G.tut.interacts++; } });
    codex = loadCodex();
    if (engine && level) {
      intelSys = createIntel({ scene: engine.scene, mats: engine.mats });
      for (const t of intelSys.targetList()) {
        interact.add({
          x: t.x, z: t.z, r: t.r, label: t.label,
          onUse: () => {
            const def = intelSys.collect(t.id);
            if (!def) return;
            if (!codex.intel.includes(def.id)) codex.intel.push(def.id);
            saveCodex(codex);
            hud.toast(`情报已归档 · ${def.title}`, 2400);
            renderArchive();
          },
        });
      }
    }
    for (const door of (level.interactiveDoors || [])) {
      let rec = null;
      rec = interact.add({
        x: door.x, z: door.z, r: 2.4, label: 'E 开门', repeat: true,
        onUse: () => {
          const open = door.toggle();
          if (rec) rec.label = open ? 'E 关门' : 'E 开门';
          if (audio && audio.impact) audio.impact('wood', 0, 0.65);
          if (hud && hud.toast) hud.toast(open ? '门已打开' : '门已关上', 1100);
        },
      });
    }
    for (const win of (level.interactiveWindows || [])) {
      let rec = null;
      rec = interact.add({
        x: win.x, z: win.z, r: 2.2, label: 'E 开窗', repeat: true,
        onUse: () => {
          const open = win.toggle();
          if (rec) rec.label = open ? 'E 关窗' : 'E 开窗';
          if (audio && audio.impact) audio.impact('metal', 0, 0.5);
          if (hud && hud.toast) hud.toast(open ? '窗已打开' : '窗已关上', 1000);
        },
      });
    }
    for (const door of (level.breachDoors || [])) {
      interact.add({
        x: door.x, z: door.z, r: 3.2, label: '按住 E 破门', hold: 1.6,
        onUse: () => {
          if (!door.open()) return;
          if (nav && nav.refreshRegion) nav.refreshRegion(door.rect[0], door.rect[1], door.rect[2], door.rect[3]);
          fx.explosion(new THREE.Vector3(door.x, 1.1, door.z), 0.55);
          audio.explosion(0, 4);
          hud.toast('门已破开', 1400);
        },
      });
    }
    renderControls(document.getElementById('prestart-controls'));
    renderControls(document.getElementById('controls-grid'));
    mothLoad = loadMothGlb().then((g) => { mothGltf = g; }).catch(() => {});
    const unlockAudio = () => { if (audio) { audio.init(); if (audio.resume) audio.resume(); } };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    controller = createController(engine.camera, level.colliders, level.bounds, audio, (x, z, y) => (level.groundHeight ? level.groundHeight(x, z, y) : 0));

    /* ---- Sprint D: pickups, killstreaks, artillery, online board, results */
    pickups = createPickups({
      scene: engine.scene, level, audio,
      onCollect: onPickupCollected,
      onNotify: (kind) => { if (hud && hud.toast) hud.toast(PICKUP_LABEL[kind] || ''); },
    });
    streakSys = createStreaks({ onReward: onStreakReward });
    inventory = createInventory();
    artillery = createArtillery({
      scene: engine.scene, level, fx, audio,
      damageAt: artilleryDamageAt,
      onShake: (v) => controller.addShake(v),
    });
    leaderboard = createLeaderboard({ baseUrl: import.meta.env.VITE_LEADERBOARD_URL || '/api' });
    results = createResults({
      onRedeploy: redeploy,
      onCallsignChange: resubmitWithCallsign,
    });
    refreshDailyUI();
    bindDeck();
    refreshMenuBoard();
    leaderboard.flushOutbox().catch(() => {});
    if (hud.bindSettings) hud.bindSettings(G.settings, onSettingChange);
    if (hud.bindModeSelect) hud.bindModeSelect(G.settings.runMode, onModeSelect);
    if (hud.bindBigModes) {
      hud.bindBigModes({
        onBig: (mode) => {
          if (mode === 'campaign') {
            if (!campaignActive) onModeSelect('campaign');
          } else if (mode === 'playlists') {
            if (G.settings.runMode === 'campaign') onModeSelect('rotation');
            updateBriefing(G.settings.runMode);
            renderOps();
          }
        },
        onPlaylist: (mode) => onModeSelect(mode),
        onLan: () => { if (lanLobby) lanLobby.open(); },
      });
      hud.setBigMode(campaignActive ? 'campaign' : 'playlists');
      if (!campaignActive) hud.setPlaylist(G.settings.runMode);
    }
    worldLabels = createWorldLabels({ camera: engine.camera, level });
    lanLobby = createLanLobby({
      onHost: (data) => joinLan(data),
      onJoin: (data) => joinLan(data),
      onStart: (data) => startLanHostGame(data),
      onLeave: () => leaveLanLobby(),
    });
    try {
      const lanUrl = new URLSearchParams(location.search).get('lan');
      if (lanUrl && lanLobby) lanLobby.open();
    } catch (e) { /* no query support */ }
    bindPrimarySelect();
    renderOps();
    document.querySelectorAll('[data-ops-tab]').forEach((b) => {
      b.addEventListener('click', () => { opsTab = b.dataset.opsTab || 'missions'; syncOpsTab(); if (audio && audio.ctx) audio.ui(); });
    });
    syncOpsTab();
    document.getElementById('mission-next')?.addEventListener('click', () => {
      const cur = operationById(campaign.selected);
      const next = OPERATIONS.find((o) => o.id === cur.id + 1);
      if (!next) return;
      closeMissionOverlay();
      campaign.selected = next.id;
      saveCampaign(campaign);
      campaignActive = true;
      G.settings.runMode = 'campaign';
      saveSettings(G.settings);
      if (hud && hud.setModeSelect) hud.setModeSelect('campaign');
      startGame(true);
      if (audio && audio.ctx) audio.uiConfirm();
    });
    document.getElementById('mission-menu')?.addEventListener('click', () => {
      returnToMenu();
      if (audio && audio.ctx) audio.ui();
    });
    document.getElementById('versus-rematch')?.addEventListener('click', () => {
      if (net.role === 'host') restartVersusMatch();
      if (audio && audio.ctx) audio.uiConfirm();
    });
    document.getElementById('versus-menu')?.addEventListener('click', () => {
      returnToMenu();
      if (audio && audio.ctx) audio.ui();
    });
    updateBriefing(G.settings.runMode);
    const menuVersionEl = document.getElementById('menu-version');
    if (menuVersionEl) menuVersionEl.textContent = 'V' + GAME_VERSION;
    applySettings(true);
    raycaster = new THREE.Raycaster();
    raycaster.far = 160;
    // three-mesh-bvh stops at the first hit inside each merged world buffer
    raycaster.firstHitOnly = true;
    barks = createBarks({ hud, audio, camera: engine.camera, enabled: !SHOT_MODE });
    setupEnemyCtx();
    equipment = createEnemyEquipment({
      scene: engine.scene, level, fx, audio, hud, camera: engine.camera,
      smokeTexture: engine.mats.sprites.smoke,
      glowTexture: engine.mats.sprites.glow,
      targetId: null,
  damagePlayer: (amount, from, attackerTeam, source = null) => {
    // Versus: the current target may be a fill bot, not a human. Route by the
    // id prefix before the human branches; co-op never produces bot: ids.
    if (G.versusMode && enemyCtx.targetId && String(enemyCtx.targetId).startsWith('bot:')) {
      const bot = botById(String(enemyCtx.targetId).slice(4));
      if (bot && bot.e && bot.e.alive) {
        const killed = bot.e.takeDamage(amount, from, null, 'torso', enemyCtx.attackerTeam);
        if (killed) onVersusBotDown(bot, enemyCtx.attackerTeam);
      }
      return;
    }
    if (net.role === 'host' && enemyCtx.targetId && String(enemyCtx.targetId) !== String(net.selfId)) {
      applyLanRemoteDamage(enemyCtx.targetId, amount, from);
    } else {
      applyPlayerDamage(amount, from, undefined, source);
    }
  },
      onFlash: (intensity) => applyFlashbang(intensity),
      onSmoke: (x, z, r, d) => { if (perception) perception.addSmoke(x, z, r, d); },
      onBark: (type, pos) => {
        if (!barks) return;
        barks.say(type === 'frag' ? 'frag' : type === 'flash' ? 'flash' : 'smoke', pos);
      },
      onNoise: (pos, radius, strength) => {
        if (perception) perception.noise(pos.x, pos.z, radius, strength);
      },
      onShake: (amount) => { if (controller) controller.addShake(amount); },
    });

    vmPass = engine.addOverlay(viewmodel.scene, viewmodel.camera);
    if (engine.enableSSAO) engine.enableSSAO();
    window.addEventListener('resize', onResize);

    document.getElementById('deploy').addEventListener('click', onDeployClick);
    if (prestartGo) prestartGo.addEventListener('click', launchGame);
    if (prestartBack) prestartBack.addEventListener('click', closePrestart);
    if (prestartSkip) prestartSkip.addEventListener('change', () => setPrestartSkipped(!!prestartSkip.checked));
    if (tutorialOpen) tutorialOpen.addEventListener('click', () => {
      audio.init();
      audio.setMasterVolume(G.settings.master);
      openManual();
    });
    document.getElementById('manual-close')?.addEventListener('click', closeManual);
    document.getElementById('manual-ok')?.addEventListener('click', closeManual);
    document.getElementById('manual')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'manual') closeManual();
    });
    for (const tab of document.querySelectorAll('#manual-tabs button')) {
      tab.addEventListener('click', () => selectManualTab(tab.dataset.tab));
    }
    const veil = document.getElementById('story-veil');
    const declassify = () => {
      veil?.classList.add('hidden-veil');
      document.querySelector('#manual .story-scroll')?.classList.add('declassified');
    };
    veil?.addEventListener('click', declassify);
    veil?.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); declassify(); }
    });
    document.getElementById('controls-open')?.addEventListener('click', () => {
      document.getElementById('controls')?.classList.remove('hidden');
      document.getElementById('controls')?.setAttribute('aria-hidden', 'false');
      if (audio && audio.ctx) audio.ui();
    });
    const closeControls = () => {
      document.getElementById('controls')?.classList.add('hidden');
      document.getElementById('controls')?.setAttribute('aria-hidden', 'true');
    };
    document.getElementById('controls-close')?.addEventListener('click', closeControls);
    document.getElementById('controls')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'controls') closeControls();
    });
    document.getElementById('resume').addEventListener('click', () => {
      G.state = 'playing';
      pauseEl.classList.add('hidden');
      input.lock();
    });
    document.getElementById('quit').addEventListener('click', () => {
      pauseEl.classList.add('hidden');
      deathEl.classList.add('hidden');
      if (results) results.hide();
      hudEl.classList.add('hidden');
      menuEl.classList.remove('hidden');
      closePrestart();
      closeManual();
      rollDeployFlavor();
      G.state = 'menu';
      input.unlock();
      resetGame();
      refreshDailyUI();
      refreshMenuBoard(true);
      viewmodel.root.visible = false;
    });
    // #redeploy is owned by src/ui/results.js (createResults.onRedeploy)

    for (const b of document.querySelectorAll('.quality-pills button')) {
      b.addEventListener('click', () => {
        const q = b.dataset.q || b.dataset.pq;
        G.settings.quality = q;
        saveSettings(G.settings);
        engine.setQuality(q);
        onResize();
        syncQualityPills();
        audio.init(); audio.ui();
      });
    }

    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-open-settings]') : null;
      if (btn) openSettings();
    });
    window.addEventListener('dod-settings-close', () => { if (hud.closeSettings) hud.closeSettings(); });

    input.on('unlock', () => {
      if (SHOT_MODE) return;
      if (G.state === 'playing') {
        G.state = 'paused';
        pauseEl.classList.remove('hidden');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && G.state === 'playing' && !SHOT_MODE) {
        G.state = 'paused';
        pauseEl.classList.remove('hidden');
        input.unlock();
      }
    });
    input.on('key', (code) => {
      if (code === 'KeyM' && minimap && G.state === 'playing') {
        const on = minimap.toggle();
        G.tut.minimap++;
        if (hud && hud.toast) hud.toast(on ? '小地图 ON' : '小地图 OFF', 1100);
        return;
      }
      if (videoIntro && videoIntro.playing && (code === 'Space' || code === 'Escape')) {
        videoIntro.skip();
        return;
      }
      if (cinema && cinema.playing && (code === 'Space' || code === 'Escape')) {
        cinema.skip();
        return;
      }
      if (code === 'Escape') {
        if (isBoardModalOpen()) { closeBoardModal(); return; }
        if (manualEl && !manualEl.classList.contains('hidden')) { closeManual(); return; }
        if (prestartEl && !prestartEl.classList.contains('hidden')) { closePrestart(); return; }
        const openNow = typeof hud.isSettingsOpen === 'function' ? hud.isSettingsOpen() : !!hud.isSettingsOpen;
        if (openNow) { if (hud.closeSettings) hud.closeSettings(); return; }
        if (G.state === 'playing') { G.state = 'paused'; pauseEl.classList.remove('hidden'); input.unlock(); }
      }
      if (G.state === 'upgrade') {
        if (code === 'Digit1') pickUpgrade(0);
        else if (code === 'Digit2') pickUpgrade(1);
        else if (code === 'Digit3') pickUpgrade(2);
        return;
      }
      if (G.state !== 'playing') return;
      if (code === 'KeyR') reload();
      if (code === 'KeyF' && !(currentWeapon() && currentWeapon().melee)) viewmodel.inspect();
      if (code === 'KeyG') throwGrenade();
      if (code === 'KeyE' && interact) interact.press();
      if (code === 'Digit1') switchWeapon(0);
      if (code === 'Digit2') switchWeapon(1);
      if (code === 'Digit3') switchWeapon(2);
      if (code === 'KeyQ') switchWeapon(G.lastWeapon);
      // V draws / stows the Ka-Bar: it is a sidearm, not a fourth rifle
      if (code === 'KeyV') {
        const ki = WEAPONS.findIndex((x) => x.melee);
        if (ki >= 0) switchWeapon(G.weaponIndex === ki ? G.lastWeapon : ki);
      }
      // consumables: press to channel, press again to cancel
      if (code === 'Digit4' && inventory) startUseItem('bandage');
      if (code === 'Digit5' && inventory) startUseItem('medkit');
      if (code === 'Digit6' && inventory) startUseItem('drink');
      if (code === 'KeyP') { G.state = 'paused'; pauseEl.classList.remove('hidden'); input.unlock(); }
    });
    engine.renderer.domElement.addEventListener('click', () => {
      if (videoIntro && videoIntro.playing) { videoIntro.skip(); return; }
      if (cinema && cinema.playing) { cinema.skip(); return; }
      if (G.state === 'playing' && !SHOT_MODE && !input.locked) input.lock();
    });

    setLoading(0.92, '预热着色器…');
    await nextFrame();

    // menu cinematic: hide the weapon, orbit slowly
    viewmodel.root.visible = false;
    hudEl.classList.add('hidden');
    G.state = 'menu';

    setLoading(1.0, '就绪');
    setTimeout(() => loadingEl.classList.add('hidden'), 260);

    if (SHOT_MODE) {
      startGame(false, true);
      setupShotPose();
    }
    lastTime = performance.now();
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    if (loadText) loadText.textContent = '启动失败：' + (err && err.message ? err.message : err);
  }
}

function onResize() {
  const aspect = window.innerWidth / window.innerHeight;
  viewmodel.setAspect(aspect);
  engine.onResize();
}

function initAudioAmbience() {
  if (!audio.ctx) return;
  audio.ambient();
  audio.setMasterVolume(G.settings.master);
}

/* ------------------------------------------------------------------ game state */
function bindPrimarySelect() {
  const btns = Array.from(document.querySelectorAll('#primary-pills button'));
  const cur = document.getElementById('primary-current');
  if (!btns.length) return;
  const apply = (v) => {
    G.settings.primary = v === 'mk18' ? 'mk18' : 'm4';
    saveSettings(G.settings);
    for (const b of btns) {
      const on = b.dataset.primary === G.settings.primary;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (cur) cur.textContent = G.settings.primary === 'mk18' ? 'MK18' : 'M4A1';
  };
  for (const b of btns) b.addEventListener('click', () => apply(b.dataset.primary));
  apply(G.settings.primary || 'm4');
}

function spawnMoth() {
  const at = { x: 37.6, z: -80.4, yaw: -0.588 };
  if (mothGltf) {
    mothAlly = createMothFromGlb(mothGltf, { scene: engine.scene, ...at });
  } else {
    // procedural fallback while the glTF loads (or if it fails)
    mothAlly = createMoth({ scene: engine.scene, ...at });
    if (mothLoad) mothLoad.then(() => {
      if (!mothGltf || G.operation?.id !== 10 || !mothAlly || mothAlly.source === 'glb') return;
      mothAlly.remove();
      mothAlly = createMothFromGlb(mothGltf, { scene: engine.scene, ...at });
    });
  }
}

function startGame(lock = true, silent = false) {
  closePrestart();
  // any entry path (button, keyboard, debug) must have a running context
  if (audio) {
    audio.init();
    if (audio.resume) audio.resume();
    audio.setMasterVolume(G.settings.master);
    if (barks) barks.preload();
  }
  // a keyboard-activated START must never leave the board modal over the game
  closeBoardModal();
  if (results) results.hide();
  resetGame();
  // the mission is assigned after the reset, which clears the previous run
  if (G.settings && G.settings.runMode !== 'campaign') campaignActive = false;
  G.operation = campaignActive ? activeOperation() : null;
  if (G.operation && G.operation.id === 10 && !mothAlly) spawnMoth();
  // beat checkpoint (Phase 3): a beat-driven op resumes at the beat you
  // died on; the checkpoint is cleared when the op finishes
  let firstWave = 1;
  if (G.operation && G.operation.beats && !net.role) {
    const cp = loadBeatCheckpoint();
    if (cp && cp.opId === G.operation.id && cp.beat > 1 && cp.beat <= operationWaves(G.operation)) {
      firstWave = cp.beat;
    }
  }
  const redeploySub = document.querySelector('#redeploy .rb-sub');
  if (redeploySub) redeploySub.textContent = '重新部署';
  if (voice) voice.stop();
  if (G.settings && G.settings.primary === 'mk18') applyWeaponSwitch(1);
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  G.state = 'playing';
  let spawn = G.operation && G.operation.start;
  if (spawn) {
    G.site = null;
    G.playRect = null;
  } else {
    // free play uses the whole outer ring, not just the main street
    G.site = nextPlaylistSite();
    G.playRect = G.site.rect;
    spawn = G.site;
    // Solo free play: spawn inside the district at the point FARTHEST from
    // the last death (in-district variety without a random 200 m walk).
    // LAN squads skip this — everyone must land on the same rally point.
    if (!net.role && spawnDirector && spawnDirector.zones.length) {
      const pts = [];
      for (const z of zonesWithinRect(spawnDirector.zones, G.site.rect)) pts.push(...z.points);
      const ps = spawnDirector.pickPlayerSpawn({
        zonePoints: pts, site: G.site, lastDeathPos: G.lastDeathPos,
      });
      const safe = resolveSpawn(ps.x, ps.z, ps.y || 0);
      if (safe) spawn = { x: safe.x, z: safe.z, yaw: G.site.yaw };
    }
  }
  /* A scripted op start is hand-authored, so snap it to the nearest
     walkable cell: a typo in a coordinate must not drop the player inside
     a wall. */
  let spawnX = spawn ? spawn.x : 1.2;
  let spawnZ = spawn ? spawn.z : 33;
  if (spawn && nav) {
    const safe = resolveSpawn(spawn.x, spawn.z, spawn.y || 0);
    if (safe) { spawnX = safe.x; spawnZ = safe.z; }
  }
  controller.revive(spawnX, spawnZ);
  controller.setLook(spawn ? (spawn.yaw || 0) : -0.03, -0.015);
  if (!silent) audio.uiConfirm();
  // Campaign difficulty follows the OPERATION (OP01 -> D1, OP14 -> D5),
  // while the wave index keeps driving the beats, the spawn mix and the
  // checkpoints. Without this the campaign never left D2.
  if (G.operation) {
    G.diffSeed = G.operation.id;
    G.diffWave0 = firstWave;
  } else {
    // Survival / free play: the wave index IS the difficulty axis. The seed
    // has to equal diffWave0, otherwise the axis is shifted one wave early
    // (diffWave = seed + n - diffWave0) and wave 8 arrives as D3 instead of
    // the documented D4 — the whole ladder was a wave late in this mode.
    G.diffSeed = 1;
    G.diffWave0 = 1;
  }
  startWave(firstWave);
  if (firstWave > 1 && hud && hud.toast) hud.toast(`从检查点继续 · 节拍 ${firstWave}`, 2600);
  if (!SHOT_MODE && !G.tutorial.done) beginTutorial();
  hudEl.classList.toggle('hidden', HIDE_HUD);
  // resuming a beat-driven op skips the opening cinematic — you have seen it
  const wantCine = G.operation && G.operation.intro && firstWave === 1 && cinema && (!SHOT_MODE || CINE_MODE);
  if (wantCine) {
    G.state = 'cinema';
    hudEl.classList.add('hidden');
    viewmodel.root.visible = false;
    const playScene = () => cinema.play(G.operation.intro, () => {
      G.state = 'playing';
      viewmodel.root.visible = true;
      hudEl.classList.toggle('hidden', HIDE_HUD);
      if (lock) input.lock();
    });
    if (videoIntro) videoIntro.play('/media/opening.mp4', playScene);
    else playScene();
  } else if (lock) {
    input.lock();
  }
  if (!SHOT_MODE) {
    const hint = document.getElementById('hint');
    hint.textContent = '';
  }
}

function resetGame() {
  // Versus state must not leak into the next run (a solo run after a versus
  // match used to keep the gas mirror damaging the player). LAN versus entry
  // points re-apply their flags AFTER startGame()/resetGame() for this reason.
  G.versusMode = false;
  G.versusOver = false;
  G.versusGraceT = 0;
  G.versusGraceNotified = false;
  G.teamScores = [0, 0];
  versusBots = [];
  teamBrains = [null, null];
  teamDirectors = [null, null];
  zoneBombT = 6;
  spawnWaveMemory.recent.length = 0;
  G.lastDeathPos = null;
  G.downedT = 0;
  if (coopDowned) coopDowned.clearAll();
  unmountAllReviveTargets();
  stopZone();
  hideVersusEnd();
  if (inventory) inventory.reset();
  speedBoostT = 0; G.speedBoost = 0;
  applyMoveSpeedMult();
  G.maxArmor = 60; G.armor = 60;
  if (mothAlly) { mothAlly.remove(); mothAlly = null; }
  const perks = dailyPerks();
  G.maxHp = 100;
  G.maxArmor = 60 + perks.armor;
  G.scoreMult = perks.scoreMult;
  G.stats = createRunStats(G.settings.runMode);
  G.upgrades = { damage: 1, fireRate: 1, mag: 1, speed: 0, regen: 1, grenades: 0, health: 0 };
  G.regenRate = 26;
  G.shotsFired = 0;
  G.recoilIndex = 0;
  G.lastShotAt = -1e9;
  G.tut = { reloads: 0, grenades: 0, swaps: 0, minimap: 0, interacts: 0, jumps: 0 };
  G.operation = null;
  G.site = null;
  G.playRect = null;
  G.boss = null;
  G.bossBeatSpawned = false;
  resetBossPhases();
  unmountBeatInteract();
  G.diff = DIFF_TIERS[0];
  G.diffSeed = 1;      // difficulty axis base (campaign sets it per operation)
  G.diffWave0 = 1;     // wave that corresponds to diffSeed
  firingSlots.max = Math.min(G.diff.maxFiring, MAX_FIRING_CEILING);
  resetFiringSlots();
  G.upgradeShown = false;
  G.upgradeCards = [];
  G.mode = 'survival';
  G.boss = null;
  if (hud && hud.clearRadio) hud.clearRadio();
  G.objective = null;
  hotDrop.active = false;
  if (hotDrop.group) hotDrop.group.visible = false;
  if (_dropFx) _dropFx.visible = false;
  hideObjectiveUI();
  if (controller) controller.speedMult = 1;
  if (hud && hud.hideUpgrades) hud.hideUpgrades();
  G.hp = G.maxHp;
  G.armor = G.maxArmor;
  G.score = 0;
  G.scoreBase = 0;
  G.kills = 0;
  G.wave = 1;
  G.waveRemaining = 0;
  G.waveTotal = 0;
  G.spawnQueue.length = 0;
  G.spawnTimer = 0;
  G.waveClearTimer = 0;
  G.grenades = 2 + perks.grenades;
  G.reloadTimer = -1;
  G.reloadTransferred = false;
  G.sinceDamage = 99;
  G.time = 0;
  G.uavUntil = 0;
  G.uavTick = 0;
  lastRunPayload = null;
  if (pickups) pickups.reset();
  if (streakSys) streakSys.reset();
  if (artillery) artillery.reset();
  if (hud.setStreak) hud.setStreak(0, 4);
  if (hud.setUav) hud.setUav(false, 0);
  G.weaponIndex = 0;
  G.weaponAmmo = WEAPONS.map((x) => ({ mag: magCap(x), reserve: x.reserve }));
  G.lastWeapon = 1;
  G.switchT = 0;
  G.switchApplied = false;
  G.switchTo = 0;
  G.unlockedShotgun = false;
  G.mag = magCap(WEAPONS[0]);
  G.reserve = WEAPONS[0].reserve;
  for (const e of enemies) e.root.visible = false;
  enemies.length = 0;
  for (const g of grenades) engine.scene.remove(g.mesh);
  grenades.length = 0;
  if (equipment) equipment.reset();
  if (barks) barks.reset();
  if (perception) perception.clear();
  G.flashA = 0;
  hud.reset();
  if (hud.setFlash) hud.setFlash(0);
  if (hud.setGrenadeWarning) hud.setGrenadeWarning(0, false);
  hud.setWeaponName(WEAPONS[0].name, magCap(WEAPONS[0]), WEAPONS[0].mode);
  if (hud.setWeaponTag) hud.setWeaponTag(WEAPONS[0].tag);
  if (hud.setAmmo) hud.setAmmo(G.mag, G.reserve, WEAPONS[0].name, WEAPONS[0].mode);
  syncSlots();
  hud.setHealth(G.hp, pipsFor(G.armor));
  hud.setScore(0, 0);
  hud.setGrenades(2);
  viewmodel.setWeapon(WEAPONS[0].variant);
}

function pipsFor(armor) { return Math.ceil(armor / 20); }

/* ------------------------------------------------------------------ waves */
function coopAllyCount() {
  if (net.role === 'host') return 1 + net.remote.size;
  return 1;
}

/* ---- per-mode wave spawn plans (Phase 1) ---------------------------------
   Each mode owns a generator (systems/spawn.js); the flat pool picker is
   only the fallback when a generator cannot produce a sane plan. Zones are
   clipped to the active district so a street fight never pulls from the
   dock 400 m away. */
function rememberSpawnZone(ids) {
  for (const id of ids) {
    spawnWaveMemory.recent.push(id);
  }
  while (spawnWaveMemory.recent.length > 6) spawnWaveMemory.recent.shift();
}

/** Which AI profile this wave's soldiers carry (Phase 2). Each mode gets its
    own policy — survival hunts, defend waves advance on the zone, extract
    enemies fortify then relent — versus bots are brain-driven. */
function waveProfileName() {
  if (G.versusMode) return 'squad';
  // beat-driven ops: the beat names its own policy (infil → garrison etc.)
  const op = G.operation;
  const beat = op && op.beats ? beatForWave(op.beats, G.wave) : null;
  if (beat && beat.ai) return beat.ai;
  if (G.operation && G.wave === 1 && G.mode === 'survival') return 'garrison';
  if (G.mode === 'defend') return 'assault';
  if (G.mode === 'extract') return 'interceptor';
  return 'hunter';
}

/** The mission area a zoneAnchor profile should advance on (defend/extract
    objective); null when the current fight has no objective zone. */
function missionAnchor() {
  const z = G.objective && G.objective.zone;
  return z && Number.isFinite(z.x) ? { x: z.x, z: z.z } : null;
}

function buildWaveSpawnPlan(n, total) {
  if (!spawnDirector || !spawnDirector.zones.length) return [];
  if (G.versusMode || net.role === 'client') return [];
  const rect = (G.operation && G.operation.spawnRect) || G.playRect;
  const zones = zonesWithinRect(spawnDirector.zones, rect);
  if (!zones.length) return [];
  const mode = G.mode;
  const count = Math.min(4, total);
  const playerPos = controller.pos;
  const facing = controller.headingDeg;
  // Deterministic per (mode, wave): the same session replays the same waves.
  const rng = spawnRngFor(mode, n);
  const base = { zones, playerPos, playerFacingDeg: facing, rng };

  /* The mode generator is the ONLY thing that decides which side of the map
     the wave comes from. If it cannot produce a plan, we retry it in
     relaxed mode (wider gates, same semantics) before falling back to a
     neutral band-respecting picker. The old path dropped straight to the
     legacy flat pool with a 34% coin flip for a flank, so the same mode
     changed the SIDE of the map between waves — that randomness belonged
     to the point layer, not the semantic layer. */
  let picks = [];
  let source = mode;
  if (mode === 'defend' && G.objective) {
    picks = spawnDirector.pickDefend({
      ...base, objective: G.objective.zone, coverPoints: level.coverPoints,
      count: Math.min(3, total), playerPos, playerFacingDeg: facing,
    });
    if (!picks.length) {
      picks = spawnDirector.pickDefend({
        ...base, objective: G.objective.zone, coverPoints: level.coverPoints,
        count: Math.min(3, total), playerPos, playerFacingDeg: facing, relaxed: true,
      });
      source = 'defend:relaxed';
    }
  } else if (mode === 'infil' && G.objective) {
    // infil: the garrison garrisons the objective — fortify-style spread
    // AROUND the zone the player is sneaking toward, not on the player's axes
    picks = spawnDirector.pickExtract({
      ...base, extractZone: G.objective.zone, phase: 'fortify', count: Math.min(3, total),
    });
    if (!picks.length) {
      picks = spawnDirector.pickExtract({
        ...base, extractZone: G.objective.zone, phase: 'fortify',
        count: Math.min(3, total), relaxed: true,
      });
      source = 'infil:relaxed';
    }
  } else if (mode === 'extract' && G.objective) {
    picks = spawnDirector.pickExtract({
      ...base, extractZone: G.objective.zone, phase: 'fortify', count: Math.min(3, total),
    });
    if (!picks.length) {
      picks = spawnDirector.pickExtract({
        ...base, extractZone: G.objective.zone, phase: 'fortify',
        count: Math.min(3, total), relaxed: true,
      });
      source = 'extract:relaxed';
    }
  } else {
    picks = spawnDirector.pickSurvival({
      ...base, wave: n, recentZones: spawnWaveMemory.recent, count,
    });
    if (!picks.length) {
      picks = spawnDirector.pickSurvival({
        ...base, wave: n, recentZones: spawnWaveMemory.recent, count, relaxed: true,
      });
      source = 'survival:relaxed';
    }
  }

  /* Neutral fallback: still inside the engagement band, still on the map,
     but with no mode semantics. This is the LAST word before the legacy
     pool picker — a wave that arrives is always better than a wave that
     does not. */
  if (!picks.length) {
    picks = pickNeutralSpawns({ zones, playerPos, count, rng });
    source = 'neutral';
  }
  if (!picks.length) return [];

  /* Snapshot the rotation state the plan was made with, BEFORE it is
     updated. The audit replays the wave from these values, so recording the
     post-update list would make the replay drift by one wave. */
  const recentAtPlan = spawnWaveMemory.recent.slice();

  rememberSpawnZone([...new Set(picks.map((p) => p.zone.id))]);

  /* Audit: what was planned, from where, and how far. This is the record
     that makes "the wave landed at 140 m" an answerable question. It also
     carries the inputs the plan depended on, so the wave can be REPLAYED
     later — a plan that cannot be reproduced is not a diagnosis. */
  recordSpawnAudit({
    wave: n,
    mode,
    source,
    seed: SPAWN_SEED,
    player: { x: +playerPos.x.toFixed(1), z: +playerPos.z.toFixed(1) },
    facing: +facing.toFixed(1),
    recentZones: recentAtPlan,
    picks: picks.map((p) => ({
      zone: p.zone ? p.zone.id : null,
      x: p.point ? +p.point.x.toFixed(1) : null,
      z: p.point ? +p.point.z.toFixed(1) : null,
      dist: p.point ? +Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z).toFixed(1) : null,
      sector: p.sector || null,
      blind: !!p.blind,
    })),
  });
  return picks;
}

/** Validate one generator pick into a real spawn: jitter + nav resolve +
    reachability (sealed campaign ops skip the reach check, as before) +
    the distance band. A plan point that lands out of reach is re-picked from
    the same zone; a zone with nothing in reach falls back to a ring spawn
    around the player, because a wave that never arrives is worse than a
    wave that arrives from the wrong side. */
function placePlanPick(pick, sealed) {
  let fallback = null;
  for (let t = 0; t < 5; t++) {
    const a = Math.random() * Math.PI * 2;
    const r = t === 0 ? 0 : 0.9 + Math.random() * 1.3;
    const cand = resolveSpawn(pick.point.x + Math.cos(a) * r, pick.point.z + Math.sin(a) * r, pick.point.y || 0);
    if (!cand) continue;
    if (sealed) return cand;                       // campaign ops keep their scripted placement
    if (!spawnReachesPlayer(cand)) continue;
    if (spawnInBand(cand)) return cand;
    if (spawnWithinReach(cand)) { if (!fallback) fallback = cand; continue; }
  }
  if (fallback) { /* keep searching for a better point in the same zone */ }
  if (sealed) return fallback || null;
  // The zone usually holds a better point than the one the plan picked: look
  // for one inside the engagement band before settling for the fallback.
  const pts = (pick.zone && pick.zone.points) || [];
  let best = null, bestScore = 1e9;
  for (const pt of pts) {
    const cand = resolveSpawn(pt.x, pt.z, pt.y || 0);
    if (!cand || !spawnReachesPlayer(cand)) continue;
    const d = spawnDistTo(cand);
    const score = Math.abs(d - (SPAWN_BAND.min + SPAWN_BAND.max) / 2) + (d > SPAWN_MAX ? 60 : 0);
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  if (best && spawnInBand(best)) return best;
  return fallback || best || ringSpawn();
}

function startWave(n) {
  const prevTier = G.diff;
  // The difficulty axis is NOT the wave index inside an operation: every
  // operation used to restart at wave 1, so the whole 14-op campaign ran at
  // D1-D2 and never saw a flank pair, a suppressor, or a single grenade.
  // G.diffSeed shifts the axis (campaign: the operation id; survival: 0).
  const diffWave = Math.max(1, (G.diffSeed || 0) + (n - (G.diffWave0 || 1)));
  G.diff = diffForWave(diffWave);
  // live stragglers (defend reinforcements) pick up the new behaviour tier too
  for (const e of enemies) if (e.alive && e.setDifficulty) e.setDifficulty(G.diff);
  firingSlots.max = Math.min(G.diff.maxFiring, MAX_FIRING_CEILING);
  resetFiringSlots();
  G.wave = n;
  G.upgradeShown = false;
  // the current wave's beat, resolved once for the whole function
  const opB = G.operation && G.operation.beats ? beatForWave(G.operation.beats, n) : null;
  unmountBeatInteract();
  if (G.stats) G.stats.damagedThisWave = false;
  applyAtmosphereForWave(n);
  const op = G.operation;
  if (op) {
    if (op.atmosphere && engine && engine.applyAtmosphere) {
      const label = engine.applyAtmosphere(op.atmosphere);
      if (hud && hud.setAtmosphere) hud.setAtmosphere(label);
      G.atmosphere = op.atmosphere;
      // 剧情战役天气：op.weather 指定，否则按天色语义给默认
      const DEFAULT_W = { dusk: 'clear', noon: 'clear', storm: 'rain', night: 'fog', bluehour: 'breeze' };
      applyWeatherForAtmo(op.atmosphere, n);
      const wLabel = weather ? weather.set(op.weather || DEFAULT_W[op.atmosphere] || 'clear') : '';
      G.weather = op.weather || DEFAULT_W[op.atmosphere] || 'clear';
      if (hud && hud.setWeather && wLabel) hud.setWeather(wLabel);
    }
    const lines = op.radio.filter((r) => r.at === n || (n === 1 && r.at === 'start'));
    /* An intro cutscene normally eats the wave-1 radio, because the scene
       already says it. On OP11–13 it did NOT: the scene was silent, so the
       only line explaining why the campaign moves on never reached the
       player. `radioAtStart` opts those ops back in. */
    const introEatsRadio = n === 1 && op.intro && !op.radioAtStart;
    if (hud.radio && !introEatsRadio) {
      for (const line of lines) hud.radio(line.speaker, line.text, 7200, line.voice);
    }
    if (op.bossWave === n || (opB && opB.type === 'boss')) {
      G.bossBeatSpawned = false;
      const beatBoss = opB && opB.boss ? opB : null;
      if (op.bossIntro && cinema && (!SHOT_MODE || CINE_MODE)) {
        G.state = 'cinema';
        hudEl.classList.add('hidden');
        viewmodel.root.visible = false;
        cinema.play(op.bossIntro, () => {
          spawnBoss(op, beatBoss);
          G.state = 'playing';
          viewmodel.root.visible = true;
          hudEl.classList.toggle('hidden', HIDE_HUD);
        });
      } else {
        spawnBoss(op, beatBoss);
      }
    } else if (opB && opB.type !== 'boss') {
      G.bossBeatSpawned = false;
    }
  }
  setupObjective(n);
  if (prevTier && prevTier.id !== G.diff.id && hud.toast) {
    hud.toast(`敌方战术升级 · ${G.diff.id} ${G.diff.label}`, 2200);
  }
  if (n >= 3 && !G.unlockedShotgun) {
    G.unlockedShotgun = true;
    if (hud.toast) hud.toast('M870 已解锁 · 按 3 装备');
  }
  const allies = coopAllyCount();
  const coopBonus = allies > 1 ? 2 + 2 * (allies - 1) : 0;
  // beat checkpoint (Phase 3): dying restarts this beat, not the whole op
  if (opB && !net.role) saveBeatCheckpoint(G.operation.id, n);
  const beatEnemies = beatEnemyCount(opB);
  const total = beatEnemies != null ? beatEnemies : Math.min(14, 3 + n + coopBonus);   // + up to 2 roof snipers => <=16
  G.waveTotal = total;
  G.waveRemaining = total;
  G.spawnQueue = [];
  const playerPos = controller.pos;
  let allowedSpawns = level.spawnPoints.filter(isSpawnAllowed);
  const sr = (G.operation && G.operation.spawnRect) || G.playRect;
  if (sr) {
    const inside = allowedSpawns.filter((p) => p.x >= sr.x0 && p.x <= sr.x1 && p.z >= sr.z0 && p.z <= sr.z1);
    if (inside.length >= 2) allowedSpawns = inside;
  }
  const pool = (allowedSpawns.length ? allowedSpawns : level.spawnPoints).slice();
  const objZone = G.objective ? G.objective.zone : null;
  const sealed = !!(op && op.spawnRect);
  const planPicks = buildWaveSpawnPlan(n, total);
  const waveRng = spawnRngFor(G.mode, n);
  // One flank decision for the WHOLE wave. It used to be re-rolled per
  // soldier, so a single wave could mix front and rear spawns for no reason
  // the player could learn — the wave looked random even in a mode with a
  // clear semantic. Now the wave agrees on its side, and the seed makes it
  // reproducible.
  const waveFlank = waveRng() < 0.34;
  for (let i = 0; i < total; i++) {
    let sx = null, sz = null, sy = 0;
    // mode generator first: the wave arrives as a coordinated push along its
    // own plan instead of one point at a time from the flat pool
    if (planPicks.length) {
      const cand = placePlanPick(planPicks[i % planPicks.length], sealed);
      if (cand) { sx = cand.x; sz = cand.z; sy = cand.y || 0; }
    }
    if (sx === null) {
      let best = null;
      if (objZone) best = pickZoneSpawn(pool, objZone, waveRng);
      else best = pickSpawnPoint(pool, waveFlank, !sealed, waveRng);
      if (!best) continue;
      sx = best.x; sz = best.z; sy = best.y || 0;
      for (let t = 0; t < 5; t++) {
        const a = waveRng() * Math.PI * 2, r = 0.9 + waveRng() * 1.3;
        const cand = resolveSpawn(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r, sy);
        if (cand && (sealed || spawnReachesPlayer(cand))) { sx = cand.x; sz = cand.z; sy = cand.y || sy; break; }
      }
    }
    G.spawnQueue.push({
      x: sx, z: sz, y: sy, type: chooseArchetype(n, i),
      profile: waveProfileName(), anchor: missionAnchor(),
    });
  }
  const roofSpawns = level.roofSpawns || [];
  if (roofSpawns.length && n >= 9) {
    // Roof snipers used to drop in at wave 6, right in the middle of D3, and
    // they are the only enemy the player cannot answer with aim: 82 hp at
    // 40-90 m through a roof edge, with a 92 m detection range. They now
    // arrive with the D4/VETERAN step (wave 9), i.e. together with the tier
    // that is built around being shot at from several axes.
    const count = Math.min(2, 1 + Math.floor((n - 9) / 3));
    // the NEAREST roof posts, not a rotating index into the whole table: a
    // sniper 140 m out is a map marker, not a threat, and it keeps the wave
    // from ever clearing. A roof post the player cannot even perceive is
    // skipped (the wave counts stay in sync below).
    const sorted = roofSpawns.slice().sort((a, b) => spawnDistTo(a) - spawnDistTo(b));
    let added = 0;
    for (let i = 0; i < count && i < sorted.length; i++) {
      const sp = sorted[i];
      if (spawnDistTo(sp) > SPAWN_MAX) break;
      G.spawnQueue.unshift({ x: sp.x, z: sp.z, y: sp.y, type: 'sniper', roof: true, profile: waveProfileName() });
      added++;
    }
    G.waveRemaining += added;
    G.waveTotal += added;
  }
  G.spawnTimer = 0.8;
  G.waveClearTimer = 0;
  hud.setWave(n);
  hud.setWaveProgress(0);
  hud.setObjective(opB ? (opB.text || `节拍 ${n}`) : `清剿残敌 · 剩余 ${total}`);
  hud.setHint('WAVE ' + n + (G.mode === 'defend' ? ' · DEFEND' : G.mode === 'extract' ? ' · EXTRACT' : ''));
  setTimeout(() => hud.setHint(''), 1400);
  if (n >= 3 && n % 3 === 0) spawnHotDrop(n);
}

/* ------------------------------------------------------- hot supply drop */
/* Every 3rd wave a marked supply crate lands somewhere on the map. The light
   column is readable from anywhere, so it gives the bigger map a reason to
   rotate instead of holding one angle. Enemies are not scripted to contest it
   (they path to the player); it is a player-facing risk/reward beat. */
/* Drop candidates are keyed by district so the crate never lands 200 m away
   from the district the player is actually fighting in (free-play/LAN rotate
   sites; campaign ops on rail/port resolve via nearest-site fallback). */
const HOT_DROP_ZONES_BY_SITE = {
  street: [
    { x: 0, z: 30, label: '街区南段' },
    { x: -4, z: 6, label: '街区中段' },
    { x: 20.8, z: -10.7, label: '后院市场' },
    { x: 0, z: 70, label: '南院车场' },
    { x: 11.5, z: 68, label: '车库' },
  ],
  souk: [
    { x: -74, z: 12, label: '集市水井' },
    { x: -96, z: 44, label: '集市西口' },
    { x: -50, z: -4, label: '集市东摊' },
  ],
  rail: [
    { x: 4, z: -150, label: '站台调度台' },
    { x: 28, z: -124, label: '货场东侧' },
    { x: -22, z: -168, label: '平车掩体' },
  ],
  port: [
    { x: 98, z: -44, label: '吊臂下' },
    { x: 72, z: -60, label: '集装箱阵' },
    { x: 104, z: -20, label: '码头栈桥' },
  ],
};

/** District the current fight belongs to: LAN/free-play use the rotated site;
    campaign ops (which clear G.site) fall back to the nearest site centroid. */
function currentSiteId() {
  if (G.site) return G.site.id;
  const p = controller ? controller.pos : { x: 0, z: 0 };
  let best = MAP_SITES[0];
  let bestD = Infinity;
  for (const s of MAP_SITES) {
    const d = Math.hypot(p.x - s.zone.x, p.z - s.zone.z);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best.id;
}
const hotDrop = { active: false, x: 0, z: 0, t: 0, group: null, beam: null, ring: null };
let dropMat = null;

function ensureDropVisual() {
  if (hotDrop.group) return;
  dropMat = new THREE.MeshBasicMaterial({
    color: 0xffb257, transparent: true, opacity: 0.09, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  const group = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.15, 30, 14, 1, true), dropMat);
  beam.position.y = 15;
  beam.frustumCulled = false;
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 3.1, 36), dropMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(beam, ring);
  group.visible = false;
  engine.scene.add(group);
  hotDrop.group = group;
  hotDrop.beam = beam;
  hotDrop.ring = ring;
}

function spawnHotDrop(n) {
  if (!pickups || !level) return;
  ensureDropVisual();
  const all = HOT_DROP_ZONES_BY_SITE[currentSiteId()] || HOT_DROP_ZONES_BY_SITE.street;
  const zones = all.filter((z) => {
    const p = nav && nav.closestWalkable(z.x, z.z);
    return !!p;
  });
  const zone = zones.length ? zones[(Math.random() * zones.length) | 0] : all[0];
  const spot = (nav && nav.closestWalkable(zone.x, zone.z)) || { x: zone.x, z: zone.z };
  hotDrop.active = true;
  hotDrop.x = spot.x;
  hotDrop.z = spot.z;
  hotDrop.t = 0;
  hotDrop.group.position.set(spot.x, 0, spot.z);
  hotDrop.group.visible = true;
  pickups.spawn('supply', spot.x, 0.4, spot.z);
  hud.toast(`空投补给 · ${zone.label}`, 2600);
  if (hud.setHint) {
    hud.setHint(`SUPPLY DROP · ${zone.label} · WAVE ${n}`);
    setTimeout(() => hud.setHint(''), 2600);
  }
}

function updateHotDrop(dt) {
  if (!hotDrop.active || !hotDrop.group) return;
  hotDrop.t += dt;
  const pulse = 0.5 + Math.sin(hotDrop.t * 3.2) * 0.5;
  dropMat.opacity = 0.06 + pulse * 0.10;
  hotDrop.ring.rotation.z = hotDrop.t * 0.8;
  hotDrop.beam.position.y = 15;
  const p = controller.pos;
  const d = Math.hypot(p.x - hotDrop.x, p.z - hotDrop.z);
  if (d < 2.4 || hotDrop.t > 70) {
    if (d < 2.4) {
      addScore(200);
      hud.setScore(G.score, G.kills);
      hud.toast('空投补给 · +200');
      if (audio && audio.ctx) audio.uiConfirm();
      pickupFlash(hotDrop.x, hotDrop.z);
    }
    hotDrop.active = false;
    hotDrop.group.visible = false;
  }
}

/* small ring pulse on the floor where the crate was grabbed */
let _dropFx = null;
function pickupFlash(x, z) {
  if (!_dropFx) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd28a, transparent: true, opacity: 0.8, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    _dropFx = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 28), mat);
    _dropFx.rotation.x = -Math.PI / 2;
    _dropFx.visible = false;
    engine.scene.add(_dropFx);
  }
  _dropFx.position.set(x, 0.07, z);
  _dropFx.scale.setScalar(1);
  _dropFx.material.opacity = 0.8;
  _dropFx.visible = true;
  _dropFx.userData.t = 0;
}

function updateDropFx(dt) {
  if (!_dropFx || !_dropFx.visible) return;
  _dropFx.userData.t += dt;
  const t = _dropFx.userData.t;
  _dropFx.scale.setScalar(1 + t * 9);
  _dropFx.material.opacity = Math.max(0, 0.8 - t * 1.6);
  if (t > 0.6) _dropFx.visible = false;
}

function relocateEnemy(e) {
  const p = e.root.position;
  // first choice: if it is standing inside geometry, snap it to the nearest
  // free cell on its own nav layer (keeps interior fights inside the room)
  if (!nav.isWalkableAt(p.x, p.z, p.y)) {
    const w = nav.closestWalkableOn(p.x, p.z, p.y);
    if (w) {
      p.set(w.x, w.y != null ? w.y : p.y, w.z);
      e.path = null; e.pathI = 0; e.pathTimer = 0;
      return true;
    }
  }
  // second choice: re-insert on a far ring (26-40 m). Dropping a stuck
  // soldier 12 m from the player read as a spawn-teleport gank; the far
  // ring keeps him in the fight without the pop-in, and the flank bark is
  // the audible "he came around the side" cue the old teleport never gave.
  const sp = ringSpawn(26, 40) || ringSpawn(12, 26);
  if (sp) {
    p.set(sp.x, sp.y || 0, sp.z);
    e.path = null; e.pathI = 0; e.pathTimer = 0; e.navTarget.x = NaN;
    if (barks && barks.say) barks.say('flank', p);
    return true;
  }
  return false;
}

function spawnEnemy(pos, opts = {}) {
  let e = enemies.find((x) => !x.alive && x.root.visible === false) || enemies.find((x) => !x.alive);
  if (!e) {
    if (enemies.length >= 14) return;
    e = new Enemy(engine.scene, engine.mats, level.colliders);
    enemies.push(e);
  }
  const playerPos = controller.pos;
  let sp = resolveSpawn(pos.x, pos.z, pos.y || 0);
  const sealed = !!(G.operation && G.operation.spawnRect);
  // Versus bots spawn at their assigned slot, period. ringSpawn() is PvE
  // wave semantics ("a ring around the player") — as the versus fallback it
  // deposited the enemy team in a clump right next to the player at spawn.
  if (opts.noRing) {
    if (!sp) {
      sp = (nav && nav.closestWalkable)
        ? (nav.closestWalkable(pos.x, pos.z) || { x: pos.x, z: pos.z, y: pos.y || 0 })
        : { x: pos.x, z: pos.z, y: pos.y || 0 };
    }
  } else {
    if (!sp) sp = ringSpawn() || { x: pos.x, z: pos.z, y: pos.y || 0 };
    else if (!sealed && !opts.force && sp.y <= 1 && !spawnReachesPlayer(sp)) sp = ringSpawn() || sp;
    // final gate: a queued point the player could never perceive is not a
    // spawn, it is scenery. Pull it into reach instead of parking a statue
    // out where nothing can see or be seen.
    if (!sealed && !opts.force && sp && spawnDistTo(sp) > SPAWN_MAX) {
      const pulled = ringSpawn();
      if (pulled) sp = pulled;
    }
  }
  const yaw = Math.atan2(-(playerPos.x - sp.x), -(playerPos.z - sp.z));
  // a shotgun rusher stranded on a platform cannot charge; keep him a rifleman
  const type = ((pos.y || 0) > 0.6 && pos.type === 'rusher') ? 'rifleman' : (pos.type || 'rifleman');
  if (e.setArchetype) e.setArchetype(type);
  if (e.clearBounds) e.clearBounds();
  if (e.setWorldBounds && level.bounds) e.setWorldBounds(level.bounds);
  e.spawn(sp.x, sp.z, yaw, sp.y || 0);
  if (e.setDifficulty) e.setDifficulty(G.diff);
  if (e.setOccluders && level.roofZones) e.setOccluders(level.roofZones);
  if ((pos.y || 0) > 1 && e.setBounds && level.roofZones) {
    const zone = level.roofZones.find((r) => pos.x >= r.x0 && pos.x <= r.x1 && pos.z >= r.z0 && pos.z <= r.z1);
    if (zone) e.setBounds(zone);
  }
  e._netId = netEnemySeq++;
  // Phase 2 profile: policy rides on the spawn request, never on the
  // recycled instance (spawn() resets AI state but keeps the policy object).
  if (pos.profile) e.profile = profileFor(pos.profile);
  e.zoneAnchor = pos.anchor ? { x: pos.anchor.x, z: pos.anchor.z } : null;
  e.root.visible = true;
  if (SHOT_MODE) e.state = 'engage';
  return e;
}

function updateWaves(dt) {
  if (SHOT_MODE && !G.debugWaves) return;
  if (G.spawnQueue.length > 0) {
    G.spawnTimer -= dt;
    const alive = enemies.filter((e) => e.alive).length;
    const aliveCap = Math.min(12, 6 + 2 * (coopAllyCount() - 1));
    if (G.spawnTimer <= 0 && alive < aliveCap) {
      const p = G.spawnQueue.shift();
      spawnEnemy(p);
      G.spawnTimer = 0.75 + Math.random() * 0.6;
    }
  }
  const alive = enemies.filter((e) => e.alive).length;
  // boss beats complete on the boss going down — escorts must not gate it
  const opB = G.operation && G.operation.beats ? beatForWave(G.operation.beats, G.wave) : null;
  const beatBossDone = !!opB && opB.type === 'boss' && G.bossBeatSpawned
    && (!G.boss || !G.boss.alive);
  if ((G.waveRemaining <= 0 && G.spawnQueue.length === 0 && alive === 0) || beatBossDone) {
    const obj = G.objective;
    if (obj && !obj.done) {
      if (obj.type === 'defend') {
        spawnReinforcements(2);
        return;
      }
      if (obj.type === 'extract') {
        if (!obj.ready) {
          obj.ready = true;
          if (hud.setHint) hud.setHint('AREA CLEAR — EXTRACT');
          if (hud.setMode) hud.setMode('EXTRACT', 'REACH THE ZONE');
        }
        return;
      }
      // infil / interact complete from the objective, never from a clear
      if (obj.type === 'infil' || obj.type === 'interact') return;
    }
    // objective-driven beats advance ONLY through onObjectiveDone → advanceBeat;
    // running the clear path too would open the upgrade pick twice
    if (opB && BEAT_OBJECTIVE_TYPES.includes(opB.type)) return;
    if (G.waveClearTimer === 0) {
      G.waveClearTimer = 0.001;
      hud.setHint('WAVE CLEARED');
      addScore(250);
      hud.setScore(G.score, G.kills);
      if (G.stats) {
        G.stats.wavesCleared++;
        if (!G.stats.damagedThisWave) G.stats.flawlessWaves++;
      }
      // resupply between waves
      const w = currentWeapon();
      G.mag = magCap(w);
      G.reserve = w.reserve;
      G.weaponAmmo[G.weaponIndex] = { mag: G.mag, reserve: G.reserve };
      hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
      G.grenades = Math.min(5, G.grenades + 1);
      hud.setGrenades(G.grenades);
    }
    G.waveClearTimer += dt;
    if (!G.upgradeShown && G.waveClearTimer > 1.0) {
      G.upgradeShown = true;
      if (G.operation && G.wave >= operationWaves(G.operation)) { finishOperation(); return; }
      openUpgradeChoice();
    }
  }
  hud.setWaveProgress(1 - G.waveRemaining / Math.max(1, G.waveTotal));
  const roofAlive = enemies.filter((e) => e.alive && e.baseY > 1).length;
  if (G.boss && G.boss.alive) {
    hud.setObjective(`击杀指挥官 · ${Math.max(1, Math.ceil(G.boss.hp))} HP`);
  } else if (roofAlive > 0 && alive === roofAlive) {
    hud.setObjective('屋顶狙击手 · 从后院坡道上屋顶');
  } else if (G.waveRemaining > 0 || alive > 0) {
    hud.setObjective(`清剿残敌 · 剩余 ${Math.max(alive, G.waveRemaining)}`);
  }
}

/* ------------------------------------------------------------------ combat */
const _dir = new THREE.Vector3();
const _meleePoint = new THREE.Vector3();
const _meleeNormal = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _end = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _endFirst = new THREE.Vector3();

function currentWeapon() { return WEAPONS[G.weaponIndex]; }

function syncSlots() {
  if (!hud || !hud.setSlots) return;
  hud.setSlots(WEAPONS.map((w, idx) => {
    const a = idx === G.weaponIndex ? { mag: G.mag, reserve: G.reserve } : (G.weaponAmmo[idx] || { mag: 0, reserve: 0 });
    return {
      name: w.name, mag: a.mag, reserve: a.reserve,
      active: idx === G.weaponIndex,
      locked: idx === 2 && !G.unlockedShotgun,
      melee: !!w.melee,
    };
  }));
}

function applyWeaponSwitch(i) {
  G.weaponAmmo[G.weaponIndex] = { mag: G.mag, reserve: G.reserve };
  G.lastWeapon = G.weaponIndex;
  G.weaponIndex = i;
  const w = WEAPONS[i];
  const a = G.weaponAmmo[i] || { mag: magCap(w), reserve: w.reserve };
  G.mag = Math.min(a.mag, magCap(w));
  G.reserve = a.reserve;
  viewmodel.setWeapon(w.variant);
  hud.setWeaponName(w.name, magCap(w), w.mode);
  hud.setWeaponTag(w.tag);
  hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  syncSlots();
}

function switchWeapon(i) {
  if (i < 0 || i >= WEAPONS.length || i === G.weaponIndex) return;
  if (G.switchT > 0) return;                                   // already swapping
  if (controller.state && controller.state.sprinting) return;  // no swap mid-sprint
  if (i === 2 && !G.unlockedShotgun) {
    if (hud.toast) hud.toast('M870 · 第 3 波解锁');
    return;
  }
  G.tut.swaps++;
  // cancelling a reload loses its progress — switching is a commitment
  if (G.reloadTimer >= 0) { G.reloadTimer = -1; G.reloadTransferred = false; G.reloadShells = 0; }
  G.switchTo = i;
  G.switchT = 0.5;
  G.switchApplied = false;
  viewmodel.setSwap(1);                    // lower the current gun first
  G.fireCooldown = Math.max(G.fireCooldown, 0.5);
  audio.reload('bolt');
}

/** drives the lower → swap → raise transition (0.5 s) */
function updateWeaponSwap(dt) {
  if (G.switchT <= 0) return;
  G.switchT = Math.max(0, G.switchT - dt);
  if (!G.switchApplied && G.switchT <= 0.26) {
    G.switchApplied = true;
    applyWeaponSwitch(G.switchTo);
    viewmodel.setSwap(0);                  // raise the new gun
  }
}

function muzzleWorld(out) {
  const cam = engine.camera;
  cam.getWorldDirection(_dir);
  _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
  _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
  out.copy(cam.position).addScaledVector(_dir, 0.85).addScaledVector(_right, 0.13).addScaledVector(_up, -0.11);
  return out;
}

/* One spread definition for both the bullet cone and the crosshair, so the
   reticle finally shows where the gun actually shoots. */
function playerSpread() {
  const w = currentWeapon();
  const moving = controller.state.speed;
  const ads = controller.adsAmount;
  return (ads > 0.5 ? w.adsSpread : w.spread) * (1 + moving * MOVE_SPREAD) * (1 - ads * 0.65);
}

/** radians of spread -> crosshair radius in CSS pixels at the current FOV */
function spreadToPixels(rad) {
  const halfH = window.innerHeight * 0.5;
  const halfFov = THREE.MathUtils.degToRad(engine.camera.fov) * 0.5;
  return Math.max(1.5, (Math.tan(rad) / Math.tan(halfFov)) * halfH);
}

function fireShot() {
  const w = currentWeapon();
  if (G.mag <= 0) return;
  G.mag--;
  G.shotsFired++;
  if (G.stats) G.stats.shots++;
  hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  syncSlots();
  viewmodel.fire(1);
  const mz = muzzleWorld(_muzzle);
  fx.muzzleFlash(mz);
  audio.gunshot(0);
  const ads = controller.adsAmount;
  const nowMs = performance.now();
  if (nowMs - G.lastShotAt > RECOIL_RESET_MS) G.recoilIndex = 0;
  G.lastShotAt = nowMs;
  const ri = G.recoilIndex++;
  const adsMul = ads > 0.5 ? ADS_RECOIL : 1;
  const upDeg = RECOIL_UP[Math.min(ri, RECOIL_UP.length - 1)] * w.recoil * adsMul;
  const sideDeg = RECOIL_SIDE[ri % RECOIL_SIDE.length] * w.recoil * adsMul;
  controller.kick(upDeg * DEG_TO_KICK, sideDeg * DEG_TO_KICK);
  controller.addShake(0.09);
  if (net.role === 'client') {
    engine.camera.getWorldDirection(_dir);
    const o = engine.camera.position;
    if (lanSession) {
      lanSession.sendFire({
        seq: ++net.seq,
        ox: +o.x.toFixed(2), oy: +o.y.toFixed(2), oz: +o.z.toFixed(2),
        dx: +_dir.x.toFixed(4), dy: +_dir.y.toFixed(4), dz: +_dir.z.toFixed(4),
        weapon: w.id,
        dmg: G.upgrades.damage,
        fireRate: G.upgrades.fireRate,
      });
    }
    _end.copy(o).addScaledVector(_dir, 120);
    fx.tracer(o, _end);
    return;
  }

  const spread = playerSpread();
  const pellets = w.pellets || 1;
  const targets = level.bulletTargets.slice();
  for (const e of enemies) if (e.alive) targets.push(...e.hitboxes);
  // Versus: remote avatars are shootable. Collect their meshes once per shot.
  if (G.versusMode) {
    for (const r of net.remote.values()) {
      if (!r.alive || !r.avatar || !r.avatar.group) continue;
      r.avatar.group.traverse((o) => {
        if (o.isMesh && o.visible) {
          o.userData.pdTarget = r.id;
          targets.push(o);
        }
      });
    }
  }
  const baseDir = _dir;
  engine.camera.getWorldDirection(baseDir);
  _right.set(1, 0, 0).applyQuaternion(engine.camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(engine.camera.quaternion);
  let effects = 0;
  let hitMarked = false;
  const cone = pellets > 1 ? spread * 1.45 : spread;
  const GOLDEN = 2.399963229728653;   // low-discrepancy: even pellet coverage
  for (let p = 0; p < pellets; p++) {
    // pellet 0 keeps the base direction, the rest spiral outwards evenly
    const ang = (p - 1) * GOLDEN;
    const rad = p === 0 ? 0 : cone * Math.sqrt((p - 0.35) / (pellets - 0.7));
    _dir.copy(baseDir)
      .addScaledVector(_right, Math.cos(ang) * rad)
      .addScaledVector(_up, Math.sin(ang) * rad)
      .normalize();
    raycaster.set(engine.camera.position, _dir);
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.object.visible || h.object.userData.enemy || h.object.userData.rayOnly);
    _end.copy(engine.camera.position).addScaledVector(_dir, 120);
    if (p === 0) _endFirst.copy(_end);
    if (hit) {
      _end.copy(hit.point);
      if (p === 0) _endFirst.copy(_end);
      // Smoke is symmetric. It already cuts the AI's sight lines; if it did
      // NOT eat the player's rounds, a cloud would be a free window to shoot
      // an enemy who cannot see you — a pure advantage for the thrower.
      if (perception && perception.smokeBlocks(
        engine.camera.position.x, engine.camera.position.z, hit.point.x, hit.point.z)) {
        if (effects < 3) { audio.impact('concrete'); effects++; }
        continue;
      }
      _normal.copy(hit.face ? hit.face.normal : _dir).transformDirection(hit.object.matrixWorld).negate();
      if (_normal.lengthSq() < 0.1) _normal.copy(_dir).negate();
      const destId = hit.object.userData && hit.object.userData.destructible;
      if (destId && level.hitDestructible) {
        const dres = level.hitDestructible(destId, w.dmg * G.upgrades.damage, hit.point, _normal);
        if (dres && dres.destroyed) {
          // dynamic rebake: the cover is gone, so reopen its cells for AI
          const d = level.destructibles.find((x) => x.id === destId);
          if (d && d.def && nav) {
            const rr = Math.hypot(d.def.w, d.def.d) / 2 + 0.5;
            nav.refreshRegion(d.def.x - rr, d.def.x + rr, d.def.z - rr, d.def.z + rr);
          }
        }
        if (dres && dres.destroyed && G.stats && !G.stats.destroyedIds.has(destId)) {
          G.stats.destroyedIds.add(destId);
          G.stats.destructibles++;
        }
        if (effects < 3) { fx.impact(hit.point, _normal, 'wood'); audio.impact('wood'); effects++; }
      } else {
        const enemy = hit.object.userData.enemy;
        const pdId = hit.object.userData.pdTarget;
        if (pdId != null && versusPlayerHit(pdId, w.dmg * G.upgrades.damage * (hit.object.userData.dmg || 1), hit.object.userData.part === 'head')) {
          const headshot2 = hit.object.userData.part === 'head';
          if (G.stats) G.stats.hits++;
          if (effects < 3) { fx.blood(hit.point, _normal, _dir); audio.impact('flesh'); effects++; }
          if (!hitMarked) { hitMarked = true; audio.hitmarker(headshot2); hud.hit(headshot2, false); }
        } else if (enemy && enemy.alive) {
          const part = hit.object.userData.part;
          const mult = hit.object.userData.dmg || 1;
          const headshot = part === 'head';
          const falloff = w.falloff ? w.falloff(hit.distance) : 1;
          const myTeam = net.team != null ? net.team : (enemy.team != null ? (enemy.team === 0 ? 1 : 0) : undefined);
          const killed = enemy.takeDamage(w.dmg * falloff * G.upgrades.damage * mult, hit.point, _normal, part, myTeam);
          if (G.stats) G.stats.hits++;
          if (effects < 3) { fx.blood(hit.point, _normal, _dir); audio.impact('flesh'); effects++; }
          if (!hitMarked) { hitMarked = true; audio.hitmarker(headshot); hud.hit(headshot, killed); }
          if (killed) onEnemyKilled(enemy, headshot, 'bullet');
        } else if (effects < 3) {
          const mat = hit.object.userData.srcMat || hit.object.material;
          let kind = 'concrete';
          if (mat === engine.mats.metal || mat === engine.mats.metalTan || mat === engine.mats.rust || mat === engine.mats.shop) kind = 'metal';
          if (mat === engine.mats.wood) kind = 'wood';
          fx.impact(hit.point, _normal, kind);
          audio.impact(kind === 'metal' ? 'metal' : 'concrete');
          if (kind === 'metal' && Math.random() > 0.65) audio.ricochet((Math.random() - 0.5) * 0.6);
          effects++;
        }
      }
    }
  }
  // suppression: the lane you are holding becomes expensive for AI routes
  if (nav) {
    nav.markThreat(_endFirst.x, _endFirst.z, 2.6, 1.3);
    nav.markThreat((engine.camera.position.x + _endFirst.x) / 2, (engine.camera.position.z + _endFirst.z) / 2, 2.2, 0.8);
  }
  // AI v2: the shot is a noise event, and rounds cracking past suppress
  if (perception) {
    perception.noise(engine.camera.position.x, engine.camera.position.z, 42, 1, 0.55);
    perception.applySuppression(enemies, _endFirst.x, _endFirst.z, 3.4, 0.55);
    // every bullet-impact crumb feeds the bullet-impact awareness loop:
    // a soldier whose cover just got hit learns which side of the wall
    // the fire is coming from. Only register when the round actually hit
    // geometry — we detect this by checking whether _endFirst is closer
    // than 60 m, which means at least one pellet hit something short of
    // the max-range fallback. We don't have direct access to the per-pellet
    // hit from this scope; `_endFirst` is updated whenever p === 0
    // connects, so the first-pellet result is good enough as a proxy for
    // "something got hit on this shot".
    const shotHitSomething = _endFirst.distanceToSquared(engine.camera.position) < 60 * 60;
    if (shotHitSomething) {
      const ix = _endFirst.x;
      const iz = _endFirst.z;
      // the normal in world space points out of the surface; reversing it
      // gives the unit vector pointing back at the shooter.
      const nx = -(ix - engine.camera.position.x);
      const nz = -(iz - engine.camera.position.z);
      const nl = Math.hypot(nx, nz) || 1;
      perception.impact(ix, iz, nx / nl, nz / nl, 6);
    }
  }
  fx.tracer(mz, _endFirst, { color: 0xffce8f, width: 0.028, life: 0.055 });
  if (G.mag === 0 && G.reserve > 0) setTimeout(() => { if (G.state === 'playing') reload(); }, 160);
}

/* ------------------------------------------------------------------ melee */
/**
 * The Ka-Bar swing.
 *
 * Reach is 2.4 m in a 126° arc in front of the player, so this is a "you are
 * already inside their arms" weapon, not a cheaper rifle. Three things make
 * it worth drawing:
 *   · the swing LUNGES — closing the last half metre is the whole point
 *   · a hit from behind (the enemy is facing more than 100° away from you)
 *     does 2.4x the damage
 *   · a backstab that KILLS is silent: no gunshot, no casualty call-out,
 *     so the squad never learns where you are
 * The costs are the point: 0.62 s between swings, a 2.4 m cone you cannot
 * reach through a wall, and no reach at all if they step back.
 */
function knifeSlash() {
  const w = currentWeapon();
  if (!w || !w.melee) return false;
  if (G.fireCooldown > 0 || G.switchT > 0 || G.reloadTimer >= 0) return false;
  G.fireCooldown = w.meleeCooldown;
  G.shotFired = true;
  viewmodel.slash();
  audio.knifeSwing();

  engine.camera.getWorldDirection(_dir);
  const px = controller.pos.x, pz = controller.pos.z;
  const eye = controller.pos.y + 1.5;
  controller.push(_dir.x, _dir.z, w.lunge);          // the lunge

  // LAN: the host owns the damage, exactly like bullets. The client only
  // reports the swing; a second local pass would double the damage.
  if (net.role === 'client') {
    if (lanSession) {
      lanSession.sendFire({
        seq: ++net.seq,
        ox: +px.toFixed(2), oy: +controller.pos.y.toFixed(2), oz: +pz.toFixed(2),
        dx: +_dir.x.toFixed(4), dy: 0, dz: +_dir.z.toFixed(4),
        weapon: w.id,
        dmg: G.upgrades.damage,
        fireRate: G.upgrades.fireRate,
      });
    }
    return true;
  }

  const cosLimit = Math.cos(w.meleeArc / 2);
  let target = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e || !e.alive || !e.root) continue;
    const ep = e.root.position;
    const dx = ep.x - px, dz = ep.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > w.meleeRange || d < 1e-4) continue;
    if ((dx * _dir.x + dz * _dir.z) / d < cosLimit) continue;      // outside the arc
    if (Math.abs(ep.y - controller.pos.y) > 2.2) continue;          // another floor
    // no stabbing through walls: the raw collider test, not the inflated
    // navigation one (an agent-sized inflation would eat the last 30 cm)
    if (level && level.colliders.length &&
      segmentBlockedByColliders(px, eye, pz, ep.x, ep.y + 1.2, ep.z, level.colliders).blocked) continue;
    if (d < bestD) { bestD = d; target = e; }
  }

  if (!target) {
    // an empty swing still makes a little noise
    if (perception) perception.noise(px, pz, 9, 0.16, 0.3);
    return true;
  }

  const ep = target.root.position;
  // backstab: the enemy is facing away from the player
  const eFx = -Math.sin(target.root.rotation.y);
  const eFz = -Math.cos(target.root.rotation.y);
  let bx = px - ep.x, bz = pz - ep.z;
  const bl = Math.hypot(bx, bz) || 1;
  bx /= bl; bz /= bl;
  const backstab = (bx * eFx + bz * eFz) < -0.34;   // ~100 degrees
  const dmg = w.dmg * (backstab ? w.backstabMult : 1) * G.upgrades.damage;

  _meleePoint.set(ep.x + bx * 0.25, ep.y + 1.25, ep.z + bz * 0.25);
  _meleeNormal.set(-bx, 0.25, -bz).normalize();
  const myTeam = net.team != null ? net.team
    : (target.team != null ? (target.team === 0 ? 1 : 0) : undefined);
  const wasAlive = target.alive;
  const killed = target.takeDamage(dmg, _meleePoint, _meleeNormal, 'torso', myTeam);

  fx.blood(_meleePoint, _meleeNormal, _dir);
  audio.impact('flesh');
  controller.addShake(0.05);
  if (G.stats) G.stats.hits++;
  hud.hit(false, killed);
  if (killed) {
    onEnemyKilled(target, false, 'melee', undefined, backstab && w.backstabSilent);
    if (backstab && w.backstabSilent) hud.toast('背刺 · 无声', 1200);
  } else if (wasAlive) {
    // a soldier who survives a stab knows exactly where you are
    target.flinch = Math.min(1, (target.flinch || 0) + 0.8);
  }
  // a struggle is noisy — except a silent backstab kill
  if (perception && !(killed && backstab && w.backstabSilent)) {
    perception.noise(px, pz, 13, 0.35, 0.4);
  }
  return true;
}

function tryFire(dt) {
  const w = currentWeapon();
  G.fireCooldown -= dt;
  if (G.switchT > 0) { G.firing = false; return; }
  const wantFire = (input.mouse.left && input.locked && G.state === 'playing') || G.debugAutoFire;
  G.firing = wantFire;
  const trigger = w.auto ? wantFire : (input.mouse.leftPressed && input.locked);
  if (!trigger || G.fireCooldown > 0 || G.reloadTimer >= 0) return;
  if (w.melee) { knifeSlash(); return; }
  if (G.mag <= 0) {
    if (G.reserve > 0) reload();
    return;
  }
  G.fireCooldown = 60 / (w.rpm * G.upgrades.fireRate);
  G.shotFired = true;
  fireShot();
}

function spawnBoss(op, beatBoss = null) {
  if (!level || !controller) return;
  const p = controller.pos;
  // beat.boss (Phase 3) overrides the op-level boss fields
  const src = beatBoss ? beatBoss.boss : op;
  const bs = (src && src.spawn) || op.bossSpawn;
  const zx = bs ? bs.x : p.x + (Math.random() < 0.5 ? -6 : 6);
  const zz = bs ? bs.z : p.z - 16;
  // spawnEnemy recycles dead instances, so trust its return value rather
  // than the array tail
  const e = spawnEnemy({ x: zx, z: zz, type: 'shield' });
  if (!e || !e.alive) return;
  e.isBoss = true;
  e.maxHp = (src && src.hp) || op.bossHp || 560;
  e.hp = e.maxHp;
  e.root.scale.setScalar((src && src.scale) || op.bossScale || 1.16);
  G.boss = e;
  G.bossBeatSpawned = true;
  resetBossPhases();
  if (hud) {
    /* bossAlias: the name the HUD shows DURING the fight. The decoy must
       read as the commander until the kill — otherwise the objective line
       ("击杀 指挥官替身") spoils the one good reversal in the campaign. */
    const shown = op.bossAlias || (src && src.name) || op.bossName || '指挥官';
    hud.toast(`${shown} · 重甲`, 2600);
    hud.setObjective(`击杀 ${shown}`);
  }
  /* The boss entrance line. If the op has a radio line for this wave it
     plays that; if the op opens with a boss-intro CUTSCENE, the scene has
     already said it (OP09 says "卡里姆出来了——这次是真的" in the scene), so
     the generic fallback would double up. */
  const bossLine = op.radio.find((r) => r.at === (beatBoss ? G.wave : op.bossWave));
  if (hud && hud.radio) {
    if (bossLine) hud.radio(bossLine.speaker || 'VEGA', bossLine.text, 5600, bossLine.voice);
    else if (!op.bossIntro) hud.radio('VEGA', '指挥官下车了。', 5600, 'cmd_disembark');
  }
}

/* ---- boss phases (Phase 3, plan §4.5) --------------------------------------
   A boss is no longer "a thick soldier": op.bossPhases is a list of threshold
   actions keyed on his HP fraction. Evaluated every frame while he lives;
   each entry fires once.
     warden    — escorts spawn in and he resists `resist` damage while ANY
                 escort lives (kill the guard first)
     escort    — guards without the damage buff
     charge    — he rusherizes: movement multiplier + accuracy bump
     relocate  — teleport to a fallback position, optionally calling
                 reinforcements (Karim's office dance)
     artillery — the crane walks fire onto the player (Salim, OP14: the
                 player killstreak system fired by the enemy) --------------- */

let bossPhaseFired = null;
let bossEscorts = [];
let bossWardenResist = 0;

function resetBossPhases() {
  bossPhaseFired = new Set();
  bossEscorts = [];
  bossWardenResist = 0;
  if (G.boss) G.boss.damageResist = 0;
}

function spawnBossEscort(boss, archetype) {
  const ang = Math.random() * Math.PI * 2;
  const e = spawnEnemy({
    x: boss.root.position.x + Math.cos(ang) * 4.5,
    z: boss.root.position.z + Math.sin(ang) * 4.5,
    y: 0, type: archetype || 'shield', profile: 'assault',
  });
  if (e) bossEscorts.push(e);
  return e;
}

function runBossPhase(ph) {
  const boss = G.boss;
  if (!boss) return;
  switch (ph.action) {
    case 'warden':
      for (let i = 0; i < (ph.escorts || 2); i++) spawnBossEscort(boss, ph.archetype);
      bossWardenResist = ph.resist != null ? ph.resist : 0.5;
      break;
    case 'escort':
      for (let i = 0; i < (ph.count || 2); i++) spawnBossEscort(boss, ph.archetype);
      break;
    case 'charge':
      boss.advanceSpeedMult = ph.mult || 1.4;
      boss.accuracyMult = Math.min(1.2, boss.accuracyMult + 0.08);
      break;
    case 'relocate': {
      if (ph.to) {
        const sp = resolveSpawn(ph.to.x, ph.to.z, 0);
        if (sp) {
          boss.root.position.set(sp.x, sp.y || 0, sp.z);
          boss.path = null; boss.pathI = 0; boss.pathTimer = 0;
          boss.navTarget.x = NaN;
        }
      }
      if (ph.reinforcements) spawnReinforcements(ph.reinforcements);
      break;
    }
    case 'artillery':
      if (artillery) {
        // The crane walks fire onto the player — but it stays READABLE: the
        // first shell lands 1.4 s + 0.62 s of fall later, so a player who
        // reacts to the radio line has time to leave the 4.4 m blast radius,
        // and each shell does 0.7x so a full 3-shell dump cannot delete the
        // whole 180 raw effective health pool on its own.
        artillery.strike({ x: controller.pos.x, z: controller.pos.z }, {
          shells: ph.shells || 3, delay: 1.4, playerDamage: 0.7,
        });
      }
      break;
    default: break;
  }
  if (ph.radioText && hud && hud.radio) hud.radio('VEGA', ph.radioText, 4200);
  else if (hud && hud.toast) hud.toast('指挥官阶段变化', 2200);
}

function updateBossPhases() {
  const op = G.operation;
  if (!op || !op.bossPhases || !G.boss || !G.boss.alive) return;
  if (!bossPhaseFired) bossPhaseFired = new Set();
  // the warden buff lives while ANY escort draws breath
  const escortAlive = bossEscorts.some((e) => e.alive);
  G.boss.damageResist = bossWardenResist > 0 && escortAlive ? bossWardenResist : 0;
  const frac = G.boss.hp / Math.max(1, G.boss.maxHp);
  for (const ph of op.bossPhases) {
    if (bossPhaseFired.has(ph)) continue;
    const at = ph.atHpFrac != null ? ph.atHpFrac : 0;
    if (frac > at) continue;
    bossPhaseFired.add(ph);
    runBossPhase(ph);
  }
}

function showMissionOverlay(op) {
  const s = G.stats || {};
  const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
  const overlay = document.getElementById('mission');
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('mission-kicker', `OPERATION COMPLETE · ${op.code}`);
  set('mission-title', op.name);
  set('mission-sub', `${op.en} · ${op.zoneLabel}`);
  const statsEl = document.getElementById('mission-stats');
  if (statsEl) {
    statsEl.innerHTML = [
      ['KILLS', s.kills || 0],
      ['WAVES', G.wave],
      ['SCORE', Math.round(G.score).toLocaleString('en-US')],
      ['ACC', `${acc}%`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }
  set('mission-debrief', op.debrief);
  const next = OPERATIONS.find((o) => o.id === op.id + 1);
  const nextBtn = document.getElementById('mission-next');
  if (nextBtn) {
    nextBtn.disabled = !next;
    nextBtn.style.opacity = next ? '1' : '.4';
    nextBtn.childNodes[0].textContent = next ? `下一任务 · ${next.name}` : '战役完成 · 无后续';
  }
  G.state = 'mission';
  overlay?.classList.remove('hidden');
  overlay?.setAttribute('aria-hidden', 'false');
}

function finishOperation() {
  const op = G.operation;
  if (!op || G.state === 'mission' || G.state === 'cinema') return;
  input.unlock();
  if (voice) voice.stop();
  if (hud && hud.clearRadio) hud.clearRadio();
  markOperationDone(campaign, op.id);
  // the op is over: the next start of ANY op begins at beat 1
  clearBeatCheckpoint();
  unmountBeatInteract();
  renderOps();
  if (op.outro && cinema && (!SHOT_MODE || CINE_MODE)) {
    G.state = 'cinema';
    hudEl.classList.add('hidden');
    viewmodel.root.visible = false;
    const playEnding = () => cinema.play(op.outro, () => {
      hudEl.classList.remove('hidden');
      viewmodel.root.visible = true;
      victoryThenMission(op);
    });
    /* The final video belongs to the real finale only. OP10's outro is the
       street arc's FALSE ending (the command escapes, the cargo does not),
       so it plays the in-engine scene without the ending film. */
    if (op.outroVideo && videoIntro) videoIntro.play('/media/ending.mp4', playEnding);
    else playEnding();
    return;
  }
  victoryThenMission(op);
}

function victoryThenMission(op) {
  if (!SHOT_MODE && videoIntro && !videoIntro.playing) {
    videoIntro.play('/media/victory.mp4', () => showMissionOverlay(op));
  } else {
    showMissionOverlay(op);
  }
}

function closeMissionOverlay() {
  const overlay = document.getElementById('mission');
  overlay?.classList.add('hidden');
  overlay?.setAttribute('aria-hidden', 'true');
}

function returnToMenu() {
  if (net.role || net.started) {
    leaveLanSession();
    if (lanLobby) { lanLobby.setPlayers([]); lanLobby.setHost(false); lanLobby.setStatus('idle', ''); }
  }
  if (voice) voice.stop();
  if (videoIntro) videoIntro.finish();
  if (cinema && cinema.playing) cinema.skip();
  closeMissionOverlay();
  closePrestart();
  deathEl.classList.add('hidden');
  if (pauseEl) pauseEl.classList.add('hidden');
  if (results) results.hide();
  hudEl.classList.add('hidden');
  menuEl.classList.remove('hidden');
  viewmodel.root.visible = false;
  G.state = 'menu';
  G.operation = null;
  input.unlock();
  resetGame();
  if (campaignActive) {
    const op = chooseCampaignOperation();
    if (campaign.selected !== op.id) { campaign.selected = op.id; saveCampaign(campaign); }
    updateBriefing('campaign');
  }
  refreshDailyUI();
  refreshMenuBoard(true);
  renderOps();
  rollDeployFlavor();
}

/** Each boss dies in its own words. The old single line ("指挥官倒了，车队
 *  正在撤离") fired for EVERY boss, so killing the deputy announced the
 *  commander's death, and killing the decoy announced a victory that the
 *  very next debrief contradicts. */
function bossDeathLine(op) {
  const name = (op && op.bossName) || '';
  if (name.indexOf('哈桑') >= 0) {
    return { shown: '副官 · 哈桑', speaker: 'VEGA', text: '哈桑死了。到死一个字都没说。', voice: 'boss_down_hassan' };
  }
  if (name.indexOf('替身') >= 0) {
    return { shown: '指挥官替身', speaker: 'VEGA', text: '车上那个不是他。真的指挥官已经进北楼了。', voice: 'boss_down_decoy' };
  }
  if (name.indexOf('卡里姆') >= 0) {
    return { shown: '指挥官 · 卡里姆', speaker: '卡里姆', text: '你以为你在追我？让他到北楼来——那句话，是我写的。', voice: 'karim_down' };
  }
  if (name.indexOf('萨利姆') >= 0) {
    return { shown: '萨利姆', speaker: 'VEGA', text: '电台安静了。船不会开。', voice: 'boss_down_salim' };
  }
  return { shown: '指挥官', speaker: 'VEGA', text: '指挥官倒了。车队失去指挥，正在撤离。', voice: 'cmd_down' };
}

function onEnemyKilled(enemy, headshot, cause = 'bullet', killerTeam, silent = false) {
  // killerTeam resolution: callers pass the SHOOTER's faction (a remote
  // client's, a grenade thrower's); `null` means teamless (zone/artillery);
  // undefined falls back to the local player's team.
  const kt = killerTeam === null ? undefined : (killerTeam !== undefined ? killerTeam : net.team);
  // Versus: a downed fill bot is a team point and a respawn timer, not PvE
  // score — the wave/upgrade economy does not run in versus at all.
  if (G.versusMode && enemy && enemy.team != null) {
    const bot = versusBots.find((b) => b.e === enemy);
    if (bot) onVersusBotDown(bot, kt);
    else onVersusDeath(enemy.team, kt, enemy.team === 0 ? '蓝军' : '红军');
    hud.addKillFeed(headshot ? '爆头击杀' : '击杀', headshot, currentWeapon().name);
    if (perception && enemy.root) perception.casualty(enemy.root.position.x, enemy.root.position.z, 22);
    return;
  }
  G.kills++;
  G.waveRemaining = Math.max(0, G.waveRemaining - 1);
  addScore(headshot ? 150 : 100);
  hud.setScore(G.score, G.kills);
  hud.addKillFeed(cause === 'melee' ? '刺杀' : (headshot ? 'HOSTILE' : 'INSURGENT'), headshot, currentWeapon().name);
  G.hitStop = 0.055;
  audio.killConfirm();
  // squad-casualty broadcast: nearby soldiers see / hear their friend die
  // and lift awareness faster than a generic noise event. This is what
  // makes a kill feel like it cost the squad something.
  // a silent backstab must not call the squad: no casualty broadcast, so
  // the soldiers nearby never learn where the player is
  if (perception && enemy && enemy.root && !silent) {
    perception.casualty(enemy.root.position.x, enemy.root.position.z, 22);
  }
  if (G.stats) {
    G.stats.kills++;
    if (headshot) G.stats.headshots++;
    if (cause === 'grenade') G.stats.grenadeKills++;
  }
  if (enemy && enemy.isBoss) {
    addScore(1500);
    hud.setScore(G.score, G.kills);
    const death = bossDeathLine(G.operation);
    /* The kill banner lands AFTER the death line. Otherwise the HUD names
       the decoy ("指挥官替身 击毙") a beat before VEGA gets to say "车上
       那个不是他" — the UI would spoil the one good reversal in the line. */
    setTimeout(() => {
      if (hud) hud.toast(`${death.shown} 击毙 · +1500`, 2400);
    }, 1400);
    if (hud.radio) hud.radio(death.speaker, death.text, 5200, death.voice);
    G.boss = null;
  }
  // killstreak kills must not feed the next streak (CoD rule) or artillery chains forever
  if (streakSys && cause !== 'artillery') streakSys.notifyKill({ headshot, cause });
  if (milestones && cause !== 'artillery') milestones.notifyKill(1);

  // loot: the dropped rifle is the signature CoD beat; consumables are rarer
  if (pickups && enemy && enemy.root) {
    const pos = enemy.root.position;
    if (enemy.rig && enemy.rig.weapon && Math.random() < 0.55) {
      const impulse = new THREE.Vector3((Math.random() - 0.5) * 1.8, 1.1 + Math.random() * 1.4, (Math.random() - 0.5) * 1.8);
      pickups.dropWeapon(enemy.rig.weapon, pos.clone().setY(pos.y + 1.05), impulse);
      enemy.rig.weapon.visible = false;
    }
    const roll = Math.random();
    const ox = (Math.random() - 0.5) * 0.9;
    const oz = (Math.random() - 0.5) * 0.9;
    if (roll < 0.10) pickups.spawn('ammo', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.15) pickups.spawn('armor', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.19) pickups.spawn('grenade', pos.x + ox, pos.y, pos.z + oz);
    // battle-royale gear + consumables (weighted toward consumables)
    else if (roll < 0.27) pickups.spawn('bandage', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.31) pickups.spawn('drink', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.335) pickups.spawn('medkit', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.355) {
      // gear tier roughly tracks wave difficulty
      const gearRoll = Math.random();
      const lv = gearRoll < 0.55 ? 1 : gearRoll < 0.87 ? 2 : 3;
      pickups.spawn(Math.random() < 0.5 ? `armor${lv}` : `helmet${lv}`, pos.x + ox, pos.y, pos.z + oz);
    }
  }

  // limit corpse count
  const dead = enemies.filter((e) => !e.alive);
  if (dead.length > 6) {
    const old = dead[0];
    old.root.visible = false;
  }
}

function reload() {
  const w = currentWeapon();
  if (w.melee) return;
  if (G.reloadTimer >= 0 || G.mag >= magCap(w) || G.reserve <= 0) return;
  if (G.switchT > 0) return;
  G.reloadTimer = 0;
  G.reloadTransferred = false;
  G.tut.reloads++;
  G.reloadShells = w.shell ? magCap(w) - G.mag : 0;
  viewmodel.startReload();
  audio.reload('magOut');
  if (w.shell) return;                 // shells load one at a time in updateReload
  setTimeout(() => { if (G.reloadTimer >= 0) audio.reload('magIn'); }, 700);
  setTimeout(() => { if (G.reloadTimer >= 0) audio.reload('charge'); }, 1500);
}

function updateReload(dt) {
  if (G.reloadTimer < 0) return;
  const wNow = currentWeapon();
  if (wNow.shell) {
    // pump shotgun: one shell every 0.5 s (can be interrupted by switching)
    G.reloadTimer += dt;
    while (G.reloadTimer >= 0.5 && G.reloadShells > 0 && G.mag < magCap(wNow) && G.reserve > 0) {
      G.reloadTimer -= 0.5;
      G.mag++;
      G.reserve--;
      G.reloadShells--;
      hud.setAmmo(G.mag, G.reserve, wNow.name, wNow.mode);
      syncSlots();
      audio.reload('magIn');
    }
    if (G.mag >= magCap(wNow) || G.reserve <= 0) {
      G.reloadTimer = -1;
      G.reloadShells = 0;
      audio.reload('charge');
    }
    return;
  }
  G.reloadTimer += dt;
  if (!G.reloadTransferred && G.reloadTimer > 1.28) {
    G.reloadTransferred = true;
    const w = currentWeapon();
    const need = Math.min(magCap(w) - G.mag, G.reserve);
    G.mag += need;
    G.reserve -= need;
    hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  }
  if (G.reloadTimer > 2.05) {
    G.reloadTimer = -1;
    G.reloadTransferred = false;
    if (G.mag <= 0 && G.reserve > 0) reload();
  }
}

/* ------------------------------------------------------------------ grenade */
function throwGrenade() {
  if (G.grenades <= 0) return;
  if (G.state !== 'playing') return;
  G.grenades--;
  G.tut.grenades++;
  hud.setGrenades(G.grenades);
  const geo = new THREE.SphereGeometry(0.062, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3b4232, roughness: 0.7, metalness: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  engine.camera.getWorldDirection(_dir);
  mesh.position.copy(engine.camera.position).addScaledVector(_dir, 0.5);
  const vel = _dir.clone().multiplyScalar(15).add(new THREE.Vector3(0, 3.4, 0));
  engine.scene.add(mesh);
  // LAN client: the host simulates the authoritative grenade (damage, noise).
  // Ours is a visual copy of the arc so the throw feels right; the host's
  // 'boom' event supplies the explosion.
  const visual = net.role === 'client';
  grenades.push({ mesh, vel, fuse: 2.4, t: 0, visual });
  if (visual && lanSession) {
    lanSession.sendEvent('grenade', {
      ox: +mesh.position.x.toFixed(2), oy: +mesh.position.y.toFixed(2), oz: +mesh.position.z.toFixed(2),
      vx: +vel.x.toFixed(2), vy: +vel.y.toFixed(2), vz: +vel.z.toFixed(2),
    });
  }
  audio.reload('bolt');
}

/** A remote player's grenade. The host simulates it for real (damage, AI
    noise, versus player hits); other clients render the same arc as a
    visual-only copy. The throw is sanity-checked against the sender's last
    known position (LAN trust, but no cross-map grenades). */
function spawnNetGrenade(msg) {
  if (!engine) return;
  const ox = Number(msg.ox), oy = Number(msg.oy), oz = Number(msg.oz);
  if (![ox, oy, oz].every(Number.isFinite)) return;
  const fromId = String(msg.from || msg.id || '');
  const sender = fromId ? net.remote.get(fromId) : null;
  if (net.role === 'host') {
    if (!sender) return;
    if (Math.hypot(ox - sender.x, oz - sender.z) > 8) return;
  }
  const geo = new THREE.SphereGeometry(0.062, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3b4232, roughness: 0.7, metalness: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(ox, oy, oz);
  engine.scene.add(mesh);
  const visual = net.role === 'client';
  grenades.push({
    mesh,
    vel: new THREE.Vector3(Number(msg.vx) || 0, Number(msg.vy) || 0, Number(msg.vz) || 0),
    fuse: 2.4, t: 0,
    visual,
    fromId: visual ? null : fromId,
    attackerTeam: !visual && sender ? sender.team : undefined,
  });
  if (audio) audio.reload('bolt');
}

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.t += dt;
    g.fuse -= dt;
    g.vel.y -= 16 * dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    g.mesh.rotation.x += dt * 9;
    g.mesh.rotation.z += dt * 5;
    if (g.mesh.position.y < 0.07) {
      g.mesh.position.y = 0.07;
      if (g.vel.y < -0.5) audio.impact('concrete', (Math.random() - 0.5) * 0.5, 0.5);
      g.vel.y *= -0.35;
      g.vel.x *= 0.7;
      g.vel.z *= 0.7;
    }
    if (g.fuse <= 0) {
      if (g.visual || net.role === 'client') {
        // visual copy: the host's 'boom' event owns the explosion — just retire
        engine.scene.remove(g.mesh);
        geoDispose(g.mesh);
        grenades.splice(i, 1);
        continue;
      }
      fx.explosion(g.mesh.position.clone(), 1.0);
      audio.explosion(0, g.mesh.position.distanceTo(engine.camera.position));
      if (perception) {
        perception.noise(g.mesh.position.x, g.mesh.position.z, 45, 1.0);
        // The blast SUPPRESSES the squad instead of only announcing the
        // player: soldiers caught near it break for cover and stop pushing.
        // That is what makes the player's frag a crossing tool rather than a
        // beacon that tells every enemy exactly where to run.
        perception.applySuppression(enemies, g.mesh.position.x, g.mesh.position.z, 7.5, 0.9);
      }
      controller.addShake(0.85);
      // Who threw it: a remote player's grenade keeps THEIR team (friendly
      // fire + scoring both key off the thrower, never off the sim owner).
      const throwerTeam = g.attackerTeam !== undefined ? g.attackerTeam : (net.role ? net.team : undefined);
      const dist = g.mesh.position.distanceTo(engine.camera.position);
      // own grenade always hurts; in versus an ENEMY grenade hurts too
      // (friendly fire stays off, matching the pdmg policy)
      if (dist < 7 && (g.fromId == null || (G.versusMode && throwerTeam !== net.team))) {
        applyPlayerDamage(Math.max(10, 85 * (1 - dist / 7)), g.mesh.position);
      }
      for (const e of enemies) {
        if (!e.alive) continue;
        const d = e.root.position.distanceTo(g.mesh.position);
        if (d < 7.5) {
          // attackerTeam = thrower's team; friendly bots take reduced damage
          // and no AI panic. Artillery stays teamless (environmental).
          const died = e.takeDamage(180 * (1 - d / 7.5), g.mesh.position, new THREE.Vector3(0, 1, 0), 'torso', throwerTeam);
          if (died) onEnemyKilled(e, false, 'grenade', throwerTeam);
        }
      }
      // Versus: a grenade hurts enemy-team PLAYERS as well as bots.
      if (G.versusMode && net.role === 'host') {
        for (const r of net.remote.values()) {
          if (!r.alive) continue;
          if (throwerTeam != null && r.team != null && r.team === throwerTeam) continue;
          const d = Math.hypot(r.x - g.mesh.position.x, r.z - g.mesh.position.z);
          if (d < 7.5) applyLanRemoteDamage(r.id, Math.max(10, 85 * (1 - d / 7.5)), g.mesh.position, throwerTeam);
        }
      }
      if (net.role === 'host' && lanSession && net.started) {
        lanSession.broadcastEvent('boom', {
          x: +g.mesh.position.x.toFixed(2), y: +g.mesh.position.y.toFixed(2), z: +g.mesh.position.z.toFixed(2),
        });
      }
      engine.scene.remove(g.mesh);
      geoDispose(g.mesh);
      grenades.splice(i, 1);
    }
  }
}
function geoDispose(m) { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }

/** Flashbang on the player: white-out + tinnitus + shake, distance/angle scaled. */
function applyFlashbang(intensity = 0.5) {
  if (SHOT_MODE) return;
  const a = Math.max(0, Math.min(0.7, intensity));
  G.flashA = Math.max(G.flashA, a);
  if (hud && hud.setFlash) hud.setFlash(G.flashA);
  if (audio) { audio.ringing(a * 0.8); audio.hurt(); }
  if (controller) controller.addShake(0.35 * a);
}

/** Hostile breach: kick a closed door open, re-bake nav, kick up dust. */
function onEnemyBreach(door) {
  if (!door || door.opened || !door.open) return;
  if (!door.open()) return;
  const r = door.rect || [0, 0, 0, 0];
  if (nav && nav.refreshRegion) {
    nav.refreshRegion(r[0] - 0.6, r[1] + 0.6, r[2] - 0.6, r[3] + 0.6);
  }
  const cx = (r[0] + r[1]) * 0.5;
  const cz = (r[2] + r[3]) * 0.5;
  const dist = Math.hypot(engine.camera.position.x - cx, engine.camera.position.z - cz);
  audio.doorBreach(0, dist);
  if (controller) controller.addShake(0.55);
  if (fx) fx.impact(new THREE.Vector3(cx, 1.25, cz), new THREE.Vector3(0, 0, 1), 'wood');
  if (perception) perception.noise(cx, cz, 34, 0.9);
  if (hud && hud.toast) hud.toast('敌方破门', 1800);
}

/* ------------------------------------------------------------------ damage */
function applyPlayerDamage(amount, fromPos, attackerTeam = undefined, source = null) {
  if (G.state !== 'playing' || G.hp <= 0) return;
  if (SHOT_MODE) return;
  // Post-respawn invulnerability (CONQUEST.SPAWN_GRACE_S).
  if (G.versusMode && (net.spawnGraceT || 0) > 0) return;
  // Versus friendly fire against the local human is HALVED — the lobby card
  // promises "友军伤害减半". enemy.takeDamage already halves bot-vs-bot fire;
  // without the same rule here the human took FULL damage from same-team
  // bots (and from stray rounds that pass through them).
  if (G.versusMode && attackerTeam != null && net.team != null && attackerTeam === net.team) {
    amount *= 0.5;
  }
  // helmet tier: flat damage reduction (lv1 8% / lv2 15% / lv3 22%)
  if (inventory) {
    const st = inventory.gearStats();
    if (st.damageReduction > 0) amount *= (1 - st.damageReduction);
  }
  if (G.stats) G.stats.damagedThisWave = true;
  // ---- death attribution -------------------------------------------------
  // "Who killed me, from how far, doing what?" is the only question a
  // player (and a designer) can act on after a bad wave. The source soldier
  // is passed straight through from Enemy.shoot().
  if (fromPos) {
    const dx = fromPos.x - engine.camera.position.x;
    const dz = fromPos.z - engine.camera.position.z;
    G.lastDamage = {
      x: +fromPos.x.toFixed(1), z: +fromPos.z.toFixed(1),
      dist: +Math.hypot(dx, dz).toFixed(1),
      archetype: (source && source.archetype) || null,
      role: (source && source.aiRole) || null,
      utility: !!(source && source.utility),
      tier: G.diff ? G.diff.id : null,
      wave: G.wave,
      t: +(performance.now() / 1000).toFixed(2),
    };
  }
  G.sinceDamage = 0;
  G.hurtTimer = 0.3;
  let dmg = amount;
  if (G.armor > 0) {
    const absorbed = Math.min(G.armor, dmg * 0.75);
    G.armor -= absorbed;
    dmg -= absorbed;
  }
  G.hp -= dmg;
  hud.setHealth(G.hp, pipsFor(G.armor));
  hud.flashDamage(Math.min(0.85, 0.35 + amount / 60));
  controller.addShake(Math.min(0.7, 0.18 + amount / 45));
  audio.hurt();
  if (fromPos) {
    const dx = fromPos.x - engine.camera.position.x;
    const dz = fromPos.z - engine.camera.position.z;
    const bearing = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
    let rel = ((bearing - controller.headingDeg + 540) % 360) - 180;
    hud.setDamage(rel * Math.PI / 180);
  }
  if (G.hp <= 0) playerDie();
  else if (G.hp < 40) audio.setLowHealth(true);
}

/* ---------------------------------------------- loot, streaks, artillery, runs */
const PICKUP_LABEL = {
  ammo: '+90 弹药', armor: '+25 护甲', grenade: '+1 手雷', supply: '战地补给',
  armor1: '一级甲', armor2: '二级甲', armor3: '三级甲',
  helmet1: '一级盔', helmet2: '二级盔', helmet3: '三级盔',
  bandage: '绷带 (4 使用)', medkit: '急救包 (5 使用)', drink: '能量饮料 (6 使用)',
};

/** One formula for the move-speed multiplier (upgrade card + energy drink),
    so every writer stays consistent. */
function applyMoveSpeedMult() {
  if (controller) {
    controller.speedMult = 1 + (G.upgrades.speed || 0) + (speedBoostT > 0 ? (G.speedBoost || 0) : 0);
  }
}

/** Press-to-use a consumable: rules live in systems/inventory.js, this only
    surfaces HUD feedback and forwards the press. */
function startUseItem(item) {
  const r = inventory.press(item, G.hp, G.maxHp);
  if (!r.ok) {
    const why = { empty: '没有', busy: '正在使用其他物品', no_need: '状态良好' }[r.reason] || '';
    if (hud && hud.toast && why) hud.toast(`${ITEMS[item].label} · ${why}`, 1200);
    return;
  }
  if (r.reason === 'cancelled') {
    if (hud && hud.toast) hud.toast('使用已取消', 1000);
    hud.setUseChannel(null);
  }
}

/** Per-frame: advance the active channel; on completion apply the effect.
    Firing is locked while channeling (the weapon gate reads inventory.channel). */
function updateInventory(dt) {
  if (!inventory) return;
  const done = inventory.update(dt);
  const ch = inventory.channel;
  if (hud && hud.setUseChannel) {
    hud.setUseChannel(ch ? { label: ITEMS[ch.item].label, pct: ch.t / ITEMS[ch.item].channelTime } : null);
  }
  if (done) {
    const eff = inventory.effectOf(done);
    if (eff.heal > 0) {
      G.hp = Math.min(eff.healCap, Math.min(G.maxHp, G.hp + eff.heal));
      hud.setHealth(G.hp, pipsFor(G.armor));
    }
    if (eff.speedBoost > 0) { speedBoostT = eff.boostTime; G.speedBoost = eff.speedBoost; }
    hud.setInventory(inventory.pack);
    if (hud && hud.toast) hud.toast(`${ITEMS[done].label} 已使用`, 1200);
  }
  if (speedBoostT > 0) {
    speedBoostT -= dt;
    if (speedBoostT <= 0) G.speedBoost = 0;
    applyMoveSpeedMult();
  }
}

function onPickupCollected(kind, amount) {
  const num = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const ammo = num(kind === 'supply' && amount && amount.ammo, num(amount, 90));
  const armor = num(kind === 'supply' && amount && amount.armor, num(amount, 40));

  // ---- battle-royale gear: level-exclusive per slot ------------------
  if (inventory && ITEMS[kind] && ITEMS[kind].family === 'gear') {
    const verdict = inventory.equip(kind);
    if (!verdict.ok) {
      // worse or equal tier: refuse, leave it for a teammate
      if (hud && hud.toast) hud.toast(`${ITEMS[kind].label} · 已有同级或更好`, 1400);
      return false;
    }
    const st = inventory.gearStats();
    if (st.armorMax > 0) {
      G.maxArmor = st.armorMax;
      G.armor = st.armorMax;              // fresh durability on equip
    }
    hud.setHealth(G.hp, pipsFor(G.armor));
    hud.setGear(st.armorLevel, st.helmetLevel);
    if (hud && hud.toast) {
      hud.toast(`${ITEMS[kind].label} 装备${verdict.replaced ? ' · 替换旧装备' : ''}`, 1800);
    }
    return true;
  }

  // ---- consumables: into the pack, used on a key ----------------------
  if (inventory && ITEMS[kind] && ITEMS[kind].family === 'use') {
    const added = inventory.add(kind, 1);
    if (!added) {
      if (hud && hud.toast) hud.toast(`${ITEMS[kind].label} · 背包已满`, 1400);
      return false;
    }
    hud.setInventory(inventory.pack);
    if (hud && hud.toast) hud.toast(`${ITEMS[kind].label} · 按 ${ITEMS[kind].key} 使用`, 1600);
    return true;
  }
  if (kind === 'ammo' || kind === 'supply') {
    const w = currentWeapon();
    // shells top up the shotgun; rifle boxes feed the current rifle + half to the other
    const gain = w.shell ? 8 : ammo;
    G.reserve = Math.min(999, G.reserve + gain);
    if (!w.shell && kind === 'supply') {
      for (let i = 0; i < WEAPONS.length; i++) {
        if (i === G.weaponIndex || WEAPONS[i].shell) continue;
        const a = G.weaponAmmo[i] || (G.weaponAmmo[i] = { mag: magCap(WEAPONS[i]), reserve: 0 });
        a.reserve = Math.min(999, a.reserve + Math.round(gain * 0.5));
      }
    }
    hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
    syncSlots();
  }
  if (kind === 'armor' || kind === 'supply') {
    G.armor = Math.min(G.maxArmor, G.armor + armor);
    hud.setHealth(G.hp, pipsFor(G.armor));
  }
  if (kind === 'grenade' || kind === 'supply') {
    G.grenades = Math.min(6, G.grenades + 1);
    hud.setGrenades(G.grenades);
  }
  // the pickups module already plays its own pickup cue
  if (hud.toast) hud.toast(PICKUP_LABEL[kind] || '');
}

/** ground point the operator is looking at — artillery walks its shells there */
function aimPoint(maxDist = 42) {
  engine.camera.getWorldDirection(_dir);
  const p = engine.camera.position.clone().addScaledVector(_dir, maxDist);
  p.x = THREE.MathUtils.clamp(p.x, level.bounds.x0 + 1, level.bounds.x1 - 1);
  p.z = THREE.MathUtils.clamp(p.z, level.bounds.z0 + 1, level.bounds.z1 - 1);
  p.y = level.groundHeight ? level.groundHeight(p.x, p.z, p.y) : 0;
  return p;
}

function onStreakReward(id) {
  if (id === 'supply') {
    const p = controller.pos;
    pickups.spawn('supply', p.x + 1.4, p.y, p.z + 1.4);
    if (hud.setStreakReward) hud.setStreakReward('SUPPLY DROP');
  } else if (id === 'uav') {
    // 10 s, not 12 s: the UAV marks EVERY living enemy on the compass while
    // the enemy side only ever gets a 12-20 m error circle, so the window
    // length IS the size of the information asymmetry.
    G.uavUntil = G.time + 10;
    G.uavTick = 0;
    if (hud.setUav) hud.setUav(true, 10);
    if (hud.setStreakReward) hud.setStreakReward('UAV ONLINE');
    audio.uiConfirm();
  } else if (id === 'artillery') {
    // hurtPlayer:false — this is the player's OWN reward. It must never kill
    // the player who earned it (see artilleryDamageAt).
    artillery.strike(aimPoint(40), { shells: 7, radius: 10, spread: 7, hurtPlayer: false });
    if (hud.setStreakReward) hud.setStreakReward('ARTILLERY');
  }
}

/** called by the artillery module per shell impact */
function artilleryDamageAt(point, radius, dmg, ctx) {
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.root.position.distanceTo(point);
    if (d < radius) {
      const died = e.takeDamage(dmg * (1 - (d / radius) * 0.35), point, _up, 'torso');
      // artillery/zone shells are environmental: null killerTeam keeps the
      // versus scoreboard from crediting a faction for a gas kill
      if (died) onEnemyKilled(e, false, 'artillery', null);
    }
  }
  // The player side is policy-driven per strike: a strike the PLAYER earned
  // (kill-streak artillery) must never hurt the player — the aim point is
  // clamped to the map bounds, so standing near an edge facing outwards used
  // to drop the whole barrage on the player's feet (7 shells x 55 = 385 raw
  // against a 180 raw effective health pool). A strike aimed AT the player
  // (boss phase) keeps hurting, but scales its own damage so the dodge
  // window (delay + fall time) stays survivable.
  const c = ctx || {};
  if (c.hurtPlayer !== false) {
    const pd = point.distanceTo(engine.camera.position);
    const pr = radius * 0.8;
    const scale = c.playerDamage == null ? 1 : c.playerDamage;
    if (pd < pr) applyPlayerDamage(Math.max(6, 55 * scale * (1 - pd / pr)), point);
  }
  if (G.versusMode && net.role === 'host') {
    for (const r of net.remote.values()) {
      if (!r.alive) continue;
      const d = Math.hypot(r.x - point.x, r.z - point.z);
      if (d < radius) applyLanRemoteDamage(r.id, dmg * (1 - (d / radius) * 0.35), point);
    }
  }
  // shake is owned by the artillery module (one per shell) — no second kick here
}

function refreshDailyUI() {
  const daily = loadDaily();
  if (menuDailyList) renderDailyList(menuDailyList, daily, { compact: true });
  if (menuDailyCount) menuDailyCount.textContent = `${dailySummary(daily).done}/${daily.defs.length}`;
}

/* ------------------------------------------------------- menu command deck */

function setDeckTab(tab) {
  const next = tab === 'daily' ? 'daily' : tab === 'ops' ? 'ops' : 'board';
  menuDeck.tab = next;
  for (const btn of deckTabs) {
    const on = btn.dataset.deck === next;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panel of deckPanels) {
    const on = panel.id === `deck-${next}`;
    panel.classList.toggle('is-on', on);
    panel.hidden = !on;
  }
  if (next === 'board') refreshMenuBoard(false);
  if (next === 'ops') renderOps();
}

function bindDeck() {
  for (const btn of deckTabs) {
    btn.addEventListener('click', () => { audio.init(); audio.ui(); setDeckTab(btn.dataset.deck); });
  }
  if (menuCallsign) menuCallsign.addEventListener('click', beginCallsignEdit);
  if (menuCallsignInput) {
    menuCallsignInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitCallsign(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelCallsignEdit(); }
    });
    menuCallsignInput.addEventListener('blur', () => { if (!menuCallsignInput.classList.contains('hidden')) commitCallsign(); });
  }
  if (menuCallsign) menuCallsign.textContent = loadCallsign();
  const badge = document.getElementById('menu-board-source');
  if (badge) {
    badge.title = '点击刷新榜单';
    badge.addEventListener('click', () => refreshMenuBoard(true));
  }
  if (menuBoardList) {
    menuBoardList.addEventListener('scroll', () => {
      if (menuBoardList.scrollTop + menuBoardList.clientHeight >= menuBoardList.scrollHeight - 28) {
        loadMoreMenuBoard();
      }
    }, { passive: true });
  }
}

function beginCallsignEdit() {
  if (!menuCallsignInput || !menuCallsign) return;
  if (menuCallsignHint) menuCallsignHint.textContent = '回车保存 · Esc 取消';
  menuCallsign.classList.add('hidden');
  menuCallsignInput.value = loadCallsign();
  menuCallsignInput.classList.remove('hidden');
  menuCallsignInput.focus();
  menuCallsignInput.select();
}

function endCallsignEdit(text, valid) {
  if (!menuCallsignInput || !menuCallsign) return;
  menuCallsignInput.classList.add('hidden');
  menuCallsign.classList.remove('hidden');
  if (valid) menuCallsign.textContent = text;
  if (menuCallsignHint) menuCallsignHint.textContent = valid ? '本地保存' : '1–12 位，字母/数字/空格/._-';
}

function commitCallsign() {
  if (!menuCallsignInput) return false;
  const saved = saveCallsign(menuCallsignInput.value);
  if (!saved) { endCallsignEdit('', false); audio.hurt(); return false; }
  endCallsignEdit(saved, true);
  if (hud && hud.toast) hud.toast(`呼号已保存 · ${saved}`);
  return true;
}

function cancelCallsignEdit() {
  endCallsignEdit(loadCallsign(), true);
}

/** Paint the menu board from cache immediately, then refresh from /api. */
function loadBoardSync() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD_SYNC_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    return {};
  }
}

function boardSyncedAt(mode) {
  const value = Number(loadBoardSync()[mode]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function markBoardSynced(mode) {
  try {
    const map = loadBoardSync();
    map[mode] = Date.now();
    localStorage.setItem(BOARD_SYNC_KEY, JSON.stringify(map));
  } catch (e) { /* storage may be unavailable */ }
}

/** Per-mode paging state for the TOP 100 menu board. */
function boardPage(mode) {
  let state = menuDeck.pages.get(mode);
  if (!state) {
    state = { entries: [], rank: 0, total: 0, nextOffset: null, source: 'local', loading: false, done: false };
    menuDeck.pages.set(mode, state);
  }
  return state;
}

function paintMenuBoard(mode) {
  if (!menuBoardList) return;
  const state = boardPage(mode);
  const board = {
    source: state.source,
    entries: state.entries,
    rank: state.rank,
    total: state.total,
    loading: state.loading,
    done: state.done,
  };
  renderMenuBoard(menuBoardList, board, {
    best: bestFor(mode),
    syncedAt: boardSyncedAt(mode),
    pending: leaderboard ? leaderboard.pending : 0,
    loading: state.loading,
    done: state.done,
  });
}

/** The board is an async snapshot: paint the mirror first, then refresh if stale. */
function refreshMenuBoard(force = false) {
  const mode = G.settings.runMode;
  const state = boardPage(mode);

  if (!state.entries.length) {
    const local = leaderboard ? leaderboard.getLocalBoard(mode).slice(0, 100) : [];
    state.entries = local;
    state.total = local.length;
    state.source = 'local';
    state.done = !leaderboard || local.length < 20;
    if (!state.nextOffset) state.rank = 0;
  }
  paintMenuBoard(mode);
  if (!leaderboard) return;
  // tab switching inside 45 s reuses the cache; submission / quit / badge click force it
  if (!force && state.entries.length && Date.now() - boardSyncedAt(mode) < 45000) return;

  const seq = ++menuDeck.req;
  state.loading = state.entries.length > 0;
  state.done = false;
  leaderboard.fetchBoard(mode, 20, leaderboard.clientId, 0).then((res) => {
    if (seq !== menuDeck.req) return;
    state.loading = false;
    if (!res) { state.done = true; paintMenuBoard(mode); return; }
    if (res.ok) markBoardSynced(mode);
    // offline: show every page the mirror already knows, not just the first one
    const offline = !res.ok && res.source === 'cache';
    const entries = offline ? (leaderboard.getLocalBoard(mode) || res.entries || []) : (res.entries || []);
    state.entries = entries.slice(0, 100);
    if (Number.isFinite(Number(res.rank))) state.rank = Number(res.rank);
    state.total = Math.max(state.entries.length, Number(res.total) || 0);
    state.nextOffset = res.ok && res.nextOffset !== undefined ? res.nextOffset : null;
    state.source = res.source || 'local';
    state.done = !res.ok || state.nextOffset === null || state.entries.length >= 100;
    paintMenuBoard(mode);
  }).catch(() => { state.loading = false; state.done = true; paintMenuBoard(mode); });
}

/** Scroll-to-bottom paging: one page per gesture, capped at the server's TOP 100. */
function loadMoreMenuBoard() {
  const mode = G.settings.runMode;
  const state = boardPage(mode);
  if (!leaderboard || state.loading || state.done || state.nextOffset === null) return;
  const offset = state.nextOffset;
  const seq = menuDeck.req;
  state.loading = true;
  paintMenuBoard(mode);
  leaderboard.fetchBoard(mode, 20, leaderboard.clientId, offset).then((res) => {
    if (seq !== menuDeck.req) return;
    state.loading = false;
    if (!res || !res.ok) { state.done = true; paintMenuBoard(mode); return; }
    const seen = new Set(state.entries.map((e) => e.runId));
    for (const entry of res.entries || []) {
      if (entry && !seen.has(entry.runId)) { state.entries.push(entry); seen.add(entry.runId); }
    }
    state.total = Math.max(state.total, Number(res.total) || 0);
    state.nextOffset = res.nextOffset === undefined ? null : res.nextOffset;
    if (!state.rank && Number.isFinite(Number(res.rank))) state.rank = Number(res.rank);
    state.source = 'online';
    if (state.nextOffset === null || state.entries.length >= 100) state.done = true;
    paintMenuBoard(mode);
  }).catch(() => { state.loading = false; state.done = true; paintMenuBoard(mode); });
}

function resubmitWithCallsign(name) {
  const saved = saveCallsign(name);
  if (!saved || !lastRunPayload || !leaderboard) return;
  leaderboard.submitRun(lastRunPayload, saved).then((res) => {
    if (!res || !res.ok || !results) return;
    results.setBoard({ source: res.source, entries: (res.top || []).slice(0, 8), rank: res.rank, updatedAt: Date.now() });
  }).catch(() => {});
}

/** Called once when the operator dies: totals, dailies, board, results page. */
function finishRun() {
  if (SHOT_MODE || !videoIntro || videoIntro.playing) { showRunResults(); return; }
  videoIntro.play('/media/defeat.mp4', showRunResults);
}

function showRunResults() {
  if (net.role) return;
  const s = G.stats;
  if (!s) return;
  if (!s.score) s.score = G.score;
  s.objectiveWins = s.objectiveCleared ? 1 : 0;
  const daily = loadDaily();
  const { state: dstate } = applyDailyProgress(daily, s);
  const summary = dailySummary(dstate);
  const payload = runPayload(s, {
    score: G.score, wave: G.wave, challengesDone: summary.done,
    // daily-claim binding: which local day this run claims, the timezone it
    // was drawn in, and the score WITHOUT the daily multiplier (the server
    // falls back to it when it voids a bonus claimed on the wrong day).
    scoreBase: G.scoreBase,
    dailyDate: summary.done ? todayKey() : undefined,
    dailyTzMin: -new Date().getTimezoneOffset(),
  });
  lastRunPayload = payload;

  const rec = recordRun({
    ...payload,
    grenadeKills: s.grenadeKills,
    destructibles: s.destructibles,
    objectiveCleared: s.objectiveCleared,
  });
  refreshDailyUI();

  const local = leaderboard ? leaderboard.getLocalBoard(payload.mode) : [];
  const accuracy = s.shots ? Math.min(1, s.hits / s.shots) : 0;
  const callsign = loadCallsign();
  if (results) {
    results.show({
      mode: payload.mode, score: G.score, kills: s.kills, wave: G.wave,
      durationMs: payload.durationMs, headshots: s.headshots, accuracy,
      isBest: rec.isBest, prevBest: rec.prevBest, callsign, runId: payload.runId,
      board: { source: 'local', entries: local.slice(0, 8), rank: 0 },
      daily: dstate,
    });
    if (results.setNewBest) results.setNewBest(rec.isBest, rec.prevBest);
    if (results.setSubmitState) results.setSubmitState('sending', '提交中…');
  }

  if (!leaderboard) return;
  leaderboard.submitRun(payload, callsign).then((res) => {
    if (!results) return;
    if (res && res.ok) {
      results.setSubmitState('done', res.source === 'local' ? '本地记录' : '已上榜');
      results.setBoard({ source: res.source, entries: (res.top || []).slice(0, 8), rank: res.rank, updatedAt: Date.now() });
      menuDeck.cache.delete(payload.mode);
      menuDeck.pages.delete(payload.mode);
      markBoardSynced(payload.mode);
      refreshMenuBoard(true);
    } else {
      // Permanent rejections are the game's fault (bad payload); everything else
      // is queued in the outbox and retried when the API comes back.
      const err = (res && res.error) || '';
      const permanent = /^(bad_|inconsistent_|ticket_|name_)/.test(err);
      if (permanent) results.setSubmitState('failed', '提交被拒');
      else results.setSubmitState('offline', '已存本地 · 联网后补交');
    }
  }).catch(() => {});
}

function redeploy() {
  deathEl.classList.add('hidden');
  startGame(true);
}

function playerDie() {
  if (G.state === 'dead') return;
  // remembered so the next solo spawn lands far from this spot
  G.lastDeathPos = { x: controller.pos.x, z: controller.pos.z };
  // the death log is the attribution table (see G.lastDamage)
  G.deathLog = G.deathLog || [];
  if (G.deathLog.length < 40) {
    G.deathLog.push(Object.assign({ mode: G.settings && G.settings.runMode }, G.lastDamage || {}));
  }
  if (net.role) {
    G.hp = 0;
    // Versus keeps the arcade instant respawn; LAN CO-OP goes down instead —
    // teammates can pick you up (Phase 4a), bleeding out is the real death.
    if (G.versusMode) {
      G.state = 'dead';
      controller.die();
      viewmodel.state.dead = true;
      audio.death();
      audio.setLowHealth(false);
      input.unlock();
      net.respawnT = 5.0;
      if (hud && hud.setHint) hud.setHint('阵亡 · ' + Math.round(net.respawnT) + ' 秒后重新部署');
      if (net.role === 'client' && lanSession) lanSession.sendEvent('down');
      return;
    }
    G.state = 'downed';
    G.downedT = DOWN_BLEED_S;
    controller.die();
    viewmodel.state.dead = true;
    audio.death();
    audio.setLowHealth(false);
    input.unlock();
    const dp = { x: +controller.pos.x.toFixed(1), z: +controller.pos.z.toFixed(1) };
    if (net.role === 'host') {
      ensureCoopDowned().down(String(net.selfId), dp.x, dp.z, Date.now());
      if (lanSession) lanSession.broadcastEvent('downed', { from: String(net.selfId), ...dp });
      checkCoopWipe();
    } else if (lanSession) {
      lanSession.sendEvent('downed', dp);
    }
    if (hud && hud.setHint) hud.setHint(`倒地 · 等待救援 · ${Math.ceil(G.downedT)} 秒后流血`);
    return;
  }
  G.hp = 0;
  G.state = 'dead';
  controller.die();
  viewmodel.state.dead = true;
  audio.death();
  audio.setLowHealth(false);
  input.unlock();
  const fk = document.getElementById('final-kills');
  const fw = document.getElementById('final-wave');
  const fs = document.getElementById('final-score');
  if (fk) fk.textContent = G.kills;
  if (fw) fw.textContent = G.wave;
  if (fs) fs.textContent = G.score;
  // beat-driven campaign: death is a checkpoint retry, not the end of a run —
  // the board submission waits for the op to actually finish
  if (G.operation && G.operation.beats) {
    const sub = document.querySelector('#redeploy .rb-sub');
    if (sub) sub.textContent = `从节拍 ${G.wave} 重试`;
  } else {
    finishRun();
  }
  setTimeout(() => deathEl.classList.remove('hidden'), 900);
}

/* ------------------------------------------------------------------ enemy ctx */
const enemyCtx = {
  playerPos: new THREE.Vector3(),
  playerAlive: true,
  playerSpeed: 0,
  /** >0 while the local target moved fast in the last fraction of a second;
      arms the late-dodge fairness recheck in Enemy.shoot. */
  playerFastT: 0,
  fx: null, audio: null, camera: null,
  coverPoints: [],
  // Who this enemy is shooting at THIS frame (host re-aims every enemy in the
  // update loop): net.selfId/'local' = the local player, a peer id = remote
  // player, 'bot:<n>' = a versus fill bot. Damage must follow the target or
  // every bullet lands on the host no matter who was aimed at.
  targetId: undefined,
  attackerTeam: undefined,
  damagePlayer: (amount, from, source = null) => {
    const tid = enemyCtx.targetId;
    if (tid != null && String(tid).startsWith('bot:')) {
      const bot = botById(String(tid).slice(4));
      if (bot && bot.e && bot.e.alive) {
        const killed = bot.e.takeDamage(amount, from, null, 'torso', enemyCtx.attackerTeam);
        if (killed) onVersusBotDown(bot, enemyCtx.attackerTeam);
      }
      return;
    }
    if (net.role === 'host' && tid != null
        && String(tid) !== String(net.selfId) && String(tid) !== 'local') {
      applyLanRemoteDamage(String(tid), amount, from, enemyCtx.attackerTeam);
      return;
    }
    // Versus: an AI that kills the HOST player scores for its own faction —
    // the kill was aimed (targetId = self), so the shooter's team applies.
    // wasAlive gates out the rest of the killing burst (state is 'dead' by
    // then, but hp stays 0 and would re-score every pellet).
    const wasAlive = G.state === 'playing' && G.hp > 0;
    applyPlayerDamage(amount, from, enemyCtx.attackerTeam, source);
    if (wasAlive && G.versusMode && G.hp <= 0 && net.role) {
      onVersusDeath(net.team,
        Number.isFinite(enemyCtx.attackerTeam) ? enemyCtx.attackerTeam : undefined,
        net.name || 'HOST');
    }
  },
  panFor: null,
  onEnemyFire: null,
};

function setupEnemyCtx() {
  enemyCtx.fx = fx;
  enemyCtx.audio = audio;
  enemyCtx.camera = engine.camera;
  enemyCtx.coverPoints = level.coverPoints;
  enemyCtx.tryFire = tryEnemyFire;
  enemyCtx.nav = nav;
  enemyCtx.groundAt = (x, z, y) => level.groundHeight(x, z, y);
  enemyCtx.playerGroundY = 0;
  // Phase 1: semantic spawn zones over the level's named regions
  if (level) {
    // The director's default rng is the seeded session stream; per-wave
    // generators override it with a wave-specific seed so a wave can be
    // replayed on its own.
    spawnDirector = createSpawnDirector({ level, rng: makeRng(SPAWN_SEED) });
  }
  // AI v2: shared perception + squad director (needs the nav grid + colliders)
  if (nav && level) {
    perception = new Perception();
    aiDirector = new AIDirector(nav, level, {
      barks,
      perception,
      onBreach: (door) => {
        // a breach owns the fight for a moment: no utility on top of the door
        if (equipment && equipment.suppressThrows) equipment.suppressThrows(3000);
        onEnemyBreach(door);
      },
    });
    enemyCtx.ai = {
      perception,
      director: aiDirector,
      neighbors: enemies,
      barks,
    };
  }
  // smoke eats rounds from BOTH sides (see Enemy.shoot and the player's
  // own hit path) — a cloud that only blinded the AI would be a free window
  enemyCtx.smokeBlocks = (x0, z0, x1, z1) => !!(perception && perception.smokeBlocks(x0, z0, x1, z1));
  enemyCtx.panFor = (pos) => {
    const cam = engine.camera;
    const dx = pos.x - cam.position.x, dz = pos.z - cam.position.z;
    const len = Math.hypot(dx, dz) || 1;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    return THREE.MathUtils.clamp((dx / len) * _right.x + (dz / len) * _right.z, -1, 1);
  };
  enemyCtx.onEnemyFire = (pos) => {
    hud.ping(pos, engine.camera, 1.4);
    // friendly gunfire: the squad already knows where its own soldiers are,
    // so this must not pull anyone off their post
    if (perception) perception.noise(pos.x, pos.z, 22, 0.35, 0.35, true);
  };
}

/* ------------------------------------------------------------------ shot poses */
function setupShotPose() {
  if (HIDE_HUD) hudEl.classList.add('hidden');
  const poses = {
    hero: { x: 1.6, z: 27.5, yaw: -0.05, pitch: -0.02, ads: false },
    wide: { x: -2.2, z: 41, yaw: 0.03, pitch: 0.03, ads: false },
    combat: { x: 0.5, z: 17, yaw: 0.02, pitch: -0.01, ads: false },
    gun: { x: 0, z: 12, yaw: 0, pitch: 0, ads: true },
    enemy: { x: 0, z: 9, yaw: 0, pitch: -0.02, ads: false },
    alley: { x: -5.5, z: 8, yaw: 0.75, pitch: -0.02, ads: false },
  };
  const p = poses[POSE] || poses.hero;
  controller.revive(p.x, p.z);
  controller.setLook(p.yaw, p.pitch);
  G.spawnQueue.length = 0;
  G.waveRemaining = 0;
  for (const e of enemies) { e.root.visible = false; e.alive = false; }
  enemies.length = 0;
  if (POSE === 'enemy') {
    G.freezeEnemies = true;
    const e = spawnEnemy({ x: 0.45, z: 4.6 });
    void e;
    for (const en of enemies) { en.root.visible = true; en.state = 'engage'; en.aimBlend = 1; en.root.rotation.y = Math.PI; }
    return;
  }
  if (POSE === 'combat') {
    spawnEnemy({ x: 2.2, z: -2 });
    spawnEnemy({ x: -3.6, z: -9 });
    spawnEnemy({ x: 4.8, z: -14 });
    spawnEnemy({ x: -1.2, z: -20 });
    for (const e of enemies) { e.root.visible = true; e.state = 'engage'; e.aimBlend = 1; }
    // fire a burst for visual interest
    setTimeout(() => {
      if (!fx) return;
      for (const e of enemies) {
        if (!e.alive) continue;
        const m = new THREE.Vector3();
        e.weaponMuzzle.getWorldPosition(m);
        fx.tracer(m, new THREE.Vector3(m.x - 1.5, 1.5, m.z + 15), { color: 0xffc98a, width: 0.03, life: 0.12 });
      }
      const mz = new THREE.Vector3();
      muzzleWorld(mz);
      fx.muzzleFlash(mz);
    }, 900);
  }
  if (POSE === 'gun') { input.mouse.right = true; }
  G.freezeEnemies = false;
  // let enemies settle into a pose, then hold it for a deterministic frame
  setTimeout(() => { G.freezeEnemies = true; }, 1800);
}

/* --------------------------------------------------- wayfinder / area tag */
const wpEl = document.getElementById('waypoint');
const wpName = document.getElementById('waypoint-name');
const wpDist = document.getElementById('waypoint-dist');
const _wpV = new THREE.Vector3();
let wpTick = 0;
let wpKey = '';

/* The backyard has no street-facing door: the route is street → apartment
   front door → living room → east door → yard → roof ramp. Point at the next
   leg only, so the marker never draws a line through a wall. */
function yardWaypoint(px, pz, py) {
  const inYard = px > 16.9 && px < 27.2 && pz > -16.1 && pz < -6.0;
  if (inYard) {
    if (py > 2.4) return null;                      // already on the deck / catwalk
    return { x: 25.15, z: -15.0, y: 1.0, name: '屋面斜坡' };
  }
  if (px >= 27.2) return null;                      // dead-end service lane: no route
  if (px < 9.6) return { x: 9.1, z: -12.0, y: 1.2, name: '公寓正门' };
  return { x: 16.1, z: -12.0, y: 1.2, name: '穿堂门' };
}

function hideWaypoint() {
  if (wpEl && !wpEl.classList.contains('hidden')) wpEl.classList.add('hidden');
}

function updateWayfinder(dt, playing) {
  wpTick -= dt;
  if (wpTick > 0) return;
  wpTick = 0.08;                                    // 12.5 Hz is plenty for a marker

  const p = controller.pos;
  const region = level.regionAt ? level.regionAt(p.x, p.z, p.y) : null;
  if (playing && region) hud.setArea(region.name, region.en);

  if (!playing || !wpEl || !G.settings.wayfinder) { hideWaypoint(); return; }
  const wp = yardWaypoint(p.x, p.z, p.y);
  if (!wp) { hideWaypoint(); return; }

  const cam = engine.camera;
  const dx = wp.x - cam.position.x;
  const dz = wp.z - cam.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 2.4 || dist > 80) { hideWaypoint(); return; }

  // text first, so the edge clamp below measures the final label width
  const key = wp.name + '|' + Math.round(dist);
  if (key !== wpKey) {
    wpKey = key;
    if (wpName) wpName.textContent = wp.name;
    if (wpDist) wpDist.textContent = Math.round(dist) + 'm';
  }

  // project into NDC; a target behind the camera gets pinned to the lower
  // side edge it sits on, so the marker reads as "turn that way"
  _wpV.set(wp.x, wp.y, wp.z).project(cam);
  let nx = _wpV.x, ny = _wpV.y;
  const behind = _wpV.z > 1;
  let off;
  if (behind) {
    const yaw = cam.rotation.y;
    const lateral = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    nx = lateral >= 0 ? 0.94 : -0.94;
    ny = -0.62;
    off = true;
  } else {
    off = Math.abs(nx) > 0.93 || Math.abs(ny) > 0.86;
    nx = Math.max(-0.94, Math.min(0.94, nx));
    ny = Math.max(-0.86, Math.min(0.86, ny));
  }

  const W = window.innerWidth, H = window.innerHeight;
  let x = (nx * 0.5 + 0.5) * W;
  let y = (0.5 - ny * 0.5) * H;
  const hw = (wpEl.offsetWidth || 110) * 0.5 + 10;
  const hh = (wpEl.offsetHeight || 20) * 0.5 + 8;
  x = Math.max(hw, Math.min(W - hw, x));
  y = Math.max(56 + hh, Math.min(H - 108 - hh, y));

  wpEl.style.left = x.toFixed(1) + 'px';
  wpEl.style.top = y.toFixed(1) + 'px';
  wpEl.classList.toggle('is-off', off);
  wpEl.classList.remove('hidden');
}

/* ------------------------------------------------------------------ main loop */
let lastFrameAt = -1e9;
let pauseRenderT = 0;
function loop(now) {
  requestAnimationFrame(loop);
  /* FPS cap: skip whole frames (sim + render). rAF still drives the cadence,
     so on a 120/144Hz panel this halves GPU load and heat versus running
     uncapped. Sim timing derives from lastTime, so pacing stays correct. */
  const cap = G.settings && G.settings.fpsCap != null ? G.settings.fpsCap : 60;
  if (cap > 0 && now - lastFrameAt < 1000 / cap - 0.25) return;
  lastFrameAt = now;
  const rawDt = Math.min(0.25, (now - lastTime) / 1000 || 0.016);
  lastTime = now;
  let dt = rawDt;
  if (rawDt > 0.0001) G.fps = G.fps * 0.94 + (1 / rawDt) * 0.06;
  if (G.hitStop > 0) {
    G.hitStop = Math.max(0, G.hitStop - rawDt);
    dt = rawDt * 0.22;
  }

  const netBackground = net.started && (G.state === 'paused' || G.state === 'upgrade');
  const simulate = G.state === 'playing' || G.state === 'dead' || G.state === 'downed' || netBackground;
  if (simulate) {
    // Local LAN menus never pause the authoritative room. A bounded 60 Hz
    // catch-up keeps gameplay speed stable without an unbounded spiral.
    fixedStepper.advance(dt, updateGame);
    if (G.state === 'upgrade') {
      G.upgradeT = (G.upgradeT || 0) + dt;
      if (G.upgradeT > 32 && G.upgradeCards.length) pickUpgrade(0);
    }
  } else if (G.state === 'menu') {
    fixedStepper.reset();
    updateMenuCamera(dt);
  } else if (G.state === 'upgrade') {
    fixedStepper.reset();
    G.upgradeT = (G.upgradeT || 0) + dt;
    if (G.upgradeT > 32 && G.upgradeCards.length) pickUpgrade(0);
    engine.update(dt, controller.pos);
    level.update(dt, engine.camera);
    fx.update(dt);
    hud.update(dt);
    slotT -= dt;
    if (slotT <= 0) { slotT = 0.2; syncSlots(); }
    if (input.endFrame) input.endFrame();
  } else if (G.state === 'paused') {
    fixedStepper.reset();
    engine.update(dt, controller.pos);
    // Solo pause still freezes gameplay and renders the backdrop at ~12 fps.
    pauseRenderT -= dt;
    if (pauseRenderT > 0) return;
    pauseRenderT = 0.085;
  } else if (G.state === 'cinema') {
    if (cinema) cinema.update(dt);
    engine.update(dt, controller.pos);
    level.update(dt, engine.camera);
    fx.update(dt);
    hud.update(dt);
    if (input.endFrame) input.endFrame();
  }
  // the route marker is a gameplay aid: never leave it floating over menus
  if (G.state !== 'playing' && G.state !== 'dead') hideWaypoint();

  if (weather) weather.update(dt);
  engine.render(dt);

  if (SHOT_MODE) {
    G.readyFrames++;
    if (!G.ready && G.readyFrames > 30) {
      G.ready = true;
      window.__READY = true;
      document.title = 'READY — DEEPSEEK OF DUTY';
    }
  }
}

function updateMenuCamera(dt) {
  G.time += dt;
  const t = G.time;
  const cam = engine.camera;
  cam.position.set(Math.sin(t * 0.07) * 2.4, 1.72 + Math.sin(t * 0.3) * 0.02, 34 - Math.sin(t * 0.08) * 5);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(-0.02 + Math.sin(t * 0.17) * 0.012, -0.04 + Math.sin(t * 0.11) * 0.05, Math.sin(t * 0.13) * 0.004);
  viewmodel.root.visible = false;
  updateSunOcclusion(dt);
  engine.update(dt, cam.position, sunOccluded);
  level.update(dt, cam);
  fx.update(dt);
}

function updateSunOcclusion(dt) {
  sunOcclusionTimer -= dt;
  if (sunOcclusionTimer > 0) return;
  sunOcclusionTimer = 0.18;
  if (!level || !engine) return;
  _sunRay.set(engine.camera.position, engine.sky.sunDir);
  _sunRay.far = 320;
  sunOccluded = _sunRay.intersectObjects(level.bulletTargets, false).length > 0;
}


/* ====================================================================== LAN */
/* Host-authoritative co-op: the host simulates enemies and waves, clients
   send input/fire and render snapshots. This is a LAN trust model (see
   server/README.md §11) — no anti-cheat, no persistence, no host migration
   of world state. */

function lanName() {
  try { return loadCallsign() || 'OPERATOR'; } catch (e) { return 'OPERATOR'; }
}

function lanDisposeActors() {
  unmountNetMilestoneTarget();
  for (const r of net.remote.values()) { try { r.avatar.dispose(); } catch (e) { } }
  net.remote.clear();
  for (const e of net.enemies.values()) {
    try { engine.scene.remove(e.root); if (e.dispose) e.dispose(); } catch (err) { }
  }
  net.enemies.clear();
  // remote enemy visuals also live in the shared array
  for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].netRemote) enemies.splice(i, 1);
}

function leaveLanSession() {
  if (lanSession) { try { lanSession.close(); } catch (e) { } }
  lanSession = null;
  if (net.started) {
    net.started = false;
    net.role = null;
    lanDisposeActors();
  }
  net.role = null; net.selfId = null; net.hostId = null;
  net.tick = 0; net.seq = 0; net.moveEpoch = 0; net.respawnT = 0;
  net.lastSnapshotTick = -1;
  fixedStepper.reset();
}

function leaveLanLobby() {
  leaveLanSession();
  if (lanLobby) { lanLobby.setPlayers([]); lanLobby.setHost(false); lanLobby.setStatus('idle', ''); }
}

async function joinLan(data) {
  if (!data) return;
  leaveLanSession();
  net.name = data.name || lanName();
  if (lanLobby) lanLobby.setStatus('connecting', 'CONNECTING · 正在连接 LAN 服务器…');
  // The room mode (coop/br) fixes the capacity on the server. A joiner whose
  // local versus checkbox disagrees with the room gets MODE_MISMATCH — retry
  // once with the room's mode instead of dumping the player at an error.
  let wantMode = data.versus ? 'br' : 'coop';
  let res = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    leaveLanSession();
    lanSession = createLanClient({
      url: data.server || data.url,
      room: data.room || 'ALPHA',
      name: net.name,
      mode: wantMode,
      p2p: data.p2p === true,
      onLobby: onLanLobby,
      onSnapshot: onLanSnapshot,
      onEvent: onLanEvent,
      onStatus: onLanStatus,
    });
    res = await lanSession.connect();
    if (res && res.ok) break;
    if (!res || res.error !== 'mode_mismatch') break;
    wantMode = wantMode === 'br' ? 'coop' : 'br';
  }
  if (!res || !res.ok) {
    if (lanLobby) lanLobby.setStatus('error', `ERROR · ${(res && res.error) || '连接失败'}`);
    lanSession = null;
    return;
  }
  // The room's mode is authoritative: sync the lobby checkbox so the slot
  // count the UI shows (4 vs 8) matches the server's capacity.
  const roomVersus = lanSession.mode === 'br';
  const versusEl = document.getElementById('lan-versus');
  if (versusEl && versusEl.checked !== roomVersus) {
    versusEl.checked = roomVersus;
    try { localStorage.setItem('dod.lan.versus.v1', roomVersus ? '1' : '0'); } catch (e) { /* ignore */ }
    versusEl.dispatchEvent(new Event('change'));
  }
  net.selfId = res.id;
  net.hostId = res.host;
  onLanLobby(lanSession.players);
  // A HOST press that lands in a room that already has one is the classic
  // "ghost session" trap (an old connection still holds the seat). Say so
  // instead of silently demoting the press into a join.
  if (data.intent === 'host' && net.hostId && net.hostId !== net.selfId) {
    const holder = (lanSession.players || []).find((p) => p.host);
    if (hud && hud.toast) {
      hud.toast(`房间已有房主 ${holder ? holder.name : ''} · 你以队员身份加入（同呼号重连可拿回房主）`, 4200);
    }
  }
}

function onLanLobby(players) {
  if (!lanLobby) return;
  const isHost = Boolean(lanSession && lanSession.isHost);
  lanLobby.setPlayers(players || [], { selfId: net.selfId, isHost });
  lanLobby.setHost(isHost);
  if (!net.started) {
    lanLobby.setStatus(isHost ? 'hosting' : 'joined', isHost
      ? 'HOST · 等待玩家，按 START 开始'
      : 'JOINED · 等待房主开始');
  }
  if (net.started && net.role === 'host') syncLanAvatars(players || []);
}

function onLanStatus(status) {
  if (!status || !lanLobby) return;
  if (status.state === 'error' || status.state === 'closed') {
    lanLobby.setStatus('error', `ERROR · ${status.error || '连接已断开'}`);
  } else if (status.state === 'reconnecting') {
    lanLobby.setStatus('connecting', `RECONNECT · 第 ${status.attempt || 1} 次重连…`);
  }
}

function onLanSnapshot(snap) {
  if (!snap || net.role === 'host') return;
  if (!net.started) {
    if (!lanSession) return;
    startLanClientGame(snap.site);
  }
  if (net.role === 'client') {
    try { applyLanSnapshot(snap); }
    catch (e) { net.lastError = String(e && e.stack || e); }
  }
}

function onLanEvent(msg) {
  if (!msg) return;
  if (msg.t === 'input' && net.role === 'host') {
    applyLanInput(msg);
    return;
  }
  if (msg.t === 'fire' && net.role === 'host') {
    applyLanFire(msg);
    return;
  }
  if (msg.t !== 'event') return;
  if (msg.kind === 'start' && net.role === 'client') {
    if (!net.started) startLanClientGame(msg.site, msg);
    else if (G.versusMode && msg.versus) restartVersusClient(msg);
    return;
  }
  if (msg.kind === 'host_change') {
    // A new authority restarts its tick sequence, so ordering is per-host.
    const nextHost = String(msg.host || '');
    if (nextHost !== String(net.hostId || '')) net.lastSnapshotTick = -1;
    net.hostId = nextHost;
    // Server picked us as the new host mid-game: take over authority and
    // rebuild the world from the resume snapshot (last host snapshot).
    if (String(msg.host) === String(net.selfId) && net.started && net.role === 'client') {
      promoteToLanHost(msg.resume || null);
    }
    return;
  }
  if (msg.kind === 'airstrike' && G.versusMode && net.role !== 'host') {
    spawnBombingRun(Number(msg.x) || 0, Number(msg.z) || 0, false);
    return;
  }
  // Server closed this connection because a newer one took over the
  // same-callsign seat (reconnect path). Explain and do not auto-reconnect:
  if (msg.kind === 'replaced') {
    if (hud && hud.toast) hud.toast('此呼号已在别处重新连接 · 本会话已让位', 3200);
    leaveLanLobby();
    return;
  }
  // A client's grenade: the host simulates it authoritatively and fans the
  // throw out so every other peer renders the same arc (visual copy).
  if (msg.kind === 'grenade') {
    if (net.role === 'host') {
      spawnNetGrenade(msg);
      if (lanSession) lanSession.broadcastEvent('grenade', { ...msg, from: msg.id });
    } else if (String(msg.from || '') !== String(net.selfId)) {
      spawnNetGrenade(msg);
    }
    return;
  }
  if (msg.kind === 'boom' && net.role === 'client') {
    const bp = new THREE.Vector3(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
    if (fx) fx.explosion(bp, 1.0);
    if (audio) audio.explosion(0, bp.distanceTo(engine.camera.position));
    return;
  }
  // A client used a collect marker: the host advances the shared chain if
  // that player's mirrored position is actually at the step (LAN trust, but
  // no cross-map collections).
  if (msg.kind === 'mcollect' && net.role === 'host') {
    const step = milestones && !milestones.isDone ? milestones.current : null;
    const r = net.remote.get(String(msg.id));
    if (step && step.kind === 'collect' && r && r.alive
        && Math.hypot(r.x - step.x, r.z - step.z) <= (step.r || 2.5) + 2.0) {
      milestones.notifyCollect();
    }
    return;
  }
  // Host declared the versus match over: adopt the authoritative score + end.
  if (msg.kind === 'vend' && net.role === 'client' && G.versusMode) {
    if (Array.isArray(msg.scores) && msg.scores.length === 2) {
      G.teamScores[0] = Number(msg.scores[0]) || 0;
      G.teamScores[1] = Number(msg.scores[1]) || 0;
    }
    endVersusMatch(msg.win === 0 || msg.win === 1 ? msg.win : null);
    return;
  }
  if (msg.kind === 'vrematch' && net.role === 'client' && G.versusMode) {
    restartVersusClient(msg);
    return;
  }
  // Versus: player-shot-player. The VICTIM applies the hit to their own real
  // HP (LAN trust: your HP is yours); every other peer applies it to the
  // mirror for instant feedback. The host's snapshot stays authoritative.
  if (msg.kind === 'pdmg' && G.versusMode) {
    if (String(msg.target) === String(net.selfId)) {
      if (G.state === 'playing' && !(G.versusGraceT > 0) && !G.versusOver) {
        applyPlayerDamage(Number(msg.amount) || 0, null);
      }
      return;
    }
    versusApplyPlayerDamage(msg.target, msg.amount || 0, msg.team, !!msg.headshot);
    return;
  }
  // ---- LAN co-op downed / revive (Phase 4a) — co-op only, versus excluded ----
  if (!G.versusMode && net.started) {
    if (msg.kind === 'downed') {
      const from = String(msg.from || msg.id || '');
      if (from && from !== String(net.selfId)) {
        onPeerDowned(from, Number(msg.x) || 0, Number(msg.z) || 0);
        if (net.role === 'host') {
          // fan out so every OTHER client can offer the revive
          if (lanSession) lanSession.broadcastEvent('downed', { from, x: msg.x, z: msg.z });
        }
      }
      return;
    }
    if (msg.kind === 'revive' && net.role === 'host') {
      hostRevive(String(msg.id), String(msg.target || ''));
      return;
    }
    if (msg.kind === 'revived') {
      handleRevived(String(msg.target || ''), String(msg.by || ''));
      return;
    }
    if (msg.kind === 'bledout') {
      const from = String(msg.from || msg.id || '');
      if (from && from !== String(net.selfId)) onPeerBledOut(from);
      return;
    }
    if (msg.kind === 'wipe' && net.role === 'client') {
      coopWipeLocal();
      return;
    }
    if (msg.kind === 'upoffer' && net.role === 'client') {
      clientUpgradeOffer(msg.cards);
      return;
    }
  }
  // A client's own death report carries no target: mark THAT client's mirror
  // on the host. (The old fallthrough applied it to the host — every client
  // death used to kill the host too.)
  if (msg.kind === 'down' && net.role === 'host' && msg.id && String(msg.id) !== String(net.selfId)) {
    const r = net.remote.get(String(msg.id));
    if (r) {
      r.hp = 0;
      r.alive = false;
      if (r.avatar) r.avatar.alive = false;
    }
    return;
  }
  if (msg.target && String(msg.target) !== String(net.selfId)) return;
  if (msg.kind === 'damage' && G.state === 'playing') {
    const from = Array.isArray(msg.from) ? new THREE.Vector3(msg.from[0], msg.from[1], msg.from[2]) : null;
    applyPlayerDamage(msg.amount || 0, from);
  } else if (msg.kind === 'down' && G.state === 'playing') {
    G.hp = 0;
    playerDie();
  } else if (msg.kind === 'respawn') {
    respawnLanLocal();
  } else if (msg.kind === 'hit' && hud && hud.hit) {
    hud.hit(!!msg.headshot, !!msg.killed);
    if (audio) audio.hitmarker(!!msg.headshot);
  } else if (msg.kind === 'shot' && Array.isArray(msg.from) && Array.isArray(msg.to) && fx) {
    fx.tracer(new THREE.Vector3(msg.from[0], msg.from[1], msg.from[2]), new THREE.Vector3(msg.to[0], msg.to[1], msg.to[2]));
  }
}

/** Spread co-op spawn positions so 8 players do not stack on one line.
    Two staggered rows in front of the host keep everyone inside the spawn
    area while staying clear of the very first engagement distance. */
function lanSpawnSlot(index) {
  const row = Math.floor(index / 4);
  const col = index % 4;
  return {
    x: 1.2 + 2.4 * col + row * 1.6,
    z: 33.5 + row * 2.8 - col * 0.4,
    y: 0,
  };
}

function syncLanAvatars(players) {
  if (!engine || !net.started) return;
  const seen = new Set();
  let slot = 0;
  for (const p of players || []) {
    if (String(p.id) === String(net.selfId)) continue;
    const id = String(p.id);
    seen.add(id);
    let r = net.remote.get(id);
    if (!r) {
      const vsSlot = G.versusMode && net.spawnSlots && net.spawnSlots[id];
      const spawn = vsSlot
        ? versusSpawnSlot(vsSlot.team, vsSlot.index, 3)
        : lanSpawnSlot(slot++);
      r = {
        id, name: p.name || 'OPERATOR', hp: 100, alive: true,
        x: spawn.x, z: spawn.z, y: spawn.y, yaw: 0, pitch: 0, speed: 0,
        crouch: 0, ads: 0, weapon: 'm4', team: p.team,
        respawnAt: 0, moveEpoch: 0, lastInputSeq: -1, lastFireSeq: -1,
        lastInputAt: 0, lastFireAt: -1e9,
        avatar: createNetAvatar({
          scene: engine.scene, mats: engine.mats, name: p.name || 'OPERATOR', variant: slot % 3,
          team: G.versusMode ? (p.team ?? 0) : null,
        }),
      };
      // Versus: mark every avatar mesh so raycasts can hit players.
      if (r.avatar && r.avatar.group) {
        r.avatar.group.traverse((o) => { if (o.isMesh) o.userData.pdTarget = id; });
      }
      net.remote.set(id, r);
    } else {
      if (p.name && r.name !== p.name) r.name = p.name;
      if (p.team !== undefined && r.team !== p.team) {
        r.team = p.team;
      }
    }
  }
  for (const [id, r] of net.remote) {
    if (seen.has(id)) continue;
    try { r.avatar.dispose(); } catch (e) { }
    net.remote.delete(id);
  }
}

function applyLanInput(msg) {
  const r = net.remote.get(String(msg.id));
  if (!r) return;
  const now = performance.now() / 1000;
  if (!validMovementPacket(msg, r, now)) return;
  const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
  if (!nav.isWalkableAt(x, z, y) && r.alive) return;
  r.moveEpoch = Number.isSafeInteger(msg.moveEpoch) ? msg.moveEpoch : 0;
  r.lastInputSeq = msg.seq;
  r.lastInputAt = now;
  r.x = x; r.z = z; r.y = y;
  r.yaw = Number(msg.yaw); r.pitch = Number(msg.pitch);
  r.hp = Math.max(0, Math.min(1000, Number(msg.hp) || 0));
  r.alive = msg.alive !== false && r.hp > 0;
  r.speed = Math.max(0, Number(msg.speed) || 0);
  r.crouch = Math.min(1, Math.max(0, Number(msg.crouch) || 0));
  r.ads = Math.min(1, Math.max(0, Number(msg.ads) || 0));
  r.weapon = typeof msg.weapon === 'string' ? msg.weapon : 'unknown';
  r.avatar.alive = r.alive;
}

function onLanSnapshotApplyPlayers(players) {
  syncLanAvatars(players);
  for (const p of players || []) {
    const r = net.remote.get(String(p.id));
    if (!r) continue;
    r.x = Number(p.x) || 0; r.y = Number(p.y) || 0; r.z = Number(p.z) || 0;
    r.yaw = Number(p.yaw) || 0; r.pitch = Number(p.pitch) || 0;
    r.hp = Number(p.hp) || 0;
    r.alive = p.alive !== false && r.hp > 0;
    r.speed = Math.max(0, Number(p.speed) || 0);
    r.crouch = Math.min(1, Math.max(0, Number(p.crouch) || 0));
    r.ads = Math.min(1, Math.max(0, Number(p.ads) || 0));
    r.weapon = typeof p.weapon === 'string' ? p.weapon : 'unknown';
    r.avatar.alive = r.alive;
  }
}

function getOrCreateNetEnemy(data) {
  const id = String(data.id);
  let e = net.enemies.get(id);
  if (!e) {
    e = new Enemy(engine.scene, engine.mats, level.colliders);
    e.netRemote = true;
    e.setArchetype(data.type || 'rifleman');
    e.spawn(Number(data.x) || 0, Number(data.z) || 0, Number(data.yaw) || 0, Number(data.y) || 0);
    e.root.visible = true;
    e.netTarget = new THREE.Vector3(e.root.position.x, e.root.position.y, e.root.position.z);
    net.enemies.set(id, e);
    enemies.push(e);
  }
  e.netTarget.set(Number(data.x) || 0, Number(data.y) || 0, Number(data.z) || 0);
  e.netYaw = Number(data.yaw) || 0;
  e.hp = Number(data.hp) || 0;
  const wantAlive = data.alive !== false;
  if (!wantAlive && e.alive) {
    e.die(new THREE.Vector3(e.root.position.x, e.root.position.y + 1.2, e.root.position.z));
  } else if (wantAlive && !e.alive) {
    // a recycled id — respawn the visual rather than reviving a corpse
    e.spawn(Number(data.x) || 0, Number(data.z) || 0, Number(data.yaw) || 0, Number(data.y) || 0);
  }
  e.root.visible = true;
  return e;
}

/** Clients do not simulate the chain — they mirror the host's view of it.
    This keeps a single source of truth for progress while still showing every
    player what the squad is working on. A `collect` step is also USABLE here:
    the marker mounts locally and the use is reported to the host, which
    validates the distance before advancing the shared chain. */
let netMilestoneTarget = null;
let netMilestoneKey = null;

function unmountNetMilestoneTarget() {
  if (netMilestoneTarget && interact) {
    try { interact.remove(netMilestoneTarget); } catch (e) { /* already gone */ }
  }
  netMilestoneTarget = null;
  netMilestoneKey = null;
}

function applyLanMilestones(data) {
  if (!hud) return;
  if (!data) {
    unmountNetMilestoneTarget();
    if (hud.hideMilestones) hud.hideMilestones();
    return;
  }
  // A passive mirror is enough on the client: it never advances on its own.
  if (!netMilestoneMirror) {
    netMilestoneMirror = createMilestones({ chain: [{ kind: 'kill', need: 1 }], mirror: true });
  }
  const st = netMilestoneMirror.applyRemote(data);
  if (hud.setMode) hud.setMode('OBJECTIVE', st.label);
  if (hud.setMilestones) hud.setMilestones(netMilestoneMirror.serialize(), []);
  if (hud.setZoneDistance) {
    const d = (Number.isFinite(st.x) && Number.isFinite(st.z))
      ? Math.hypot(controller.pos.x - st.x, controller.pos.z - st.z)
      : null;
    hud.setZoneDistance((st.kind === 'reach' || st.kind === 'hold') && d != null && d > 1 ? d : null);
  }
  if (interact && net.role === 'client') {
    const key = (st.kind === 'collect' && !st.done && Number.isFinite(st.x))
      ? `${st.index}:${st.kind}:${st.x}:${st.z}`
      : null;
    if (key !== netMilestoneKey) {
      unmountNetMilestoneTarget();
      netMilestoneKey = key;
      if (key) {
        netMilestoneTarget = interact.add({
          x: st.x, z: st.z, r: st.r || 2.5,
          label: '按住 E 搜集物资',
          hold: 0.8,
          onUse: () => { if (lanSession) lanSession.sendEvent('mcollect', { step: st.index }); },
        });
      }
    }
  }
}

function applyLanSnapshot(snap) {
  if (!snap || net.role !== 'client' || !isNewerSnapshot(snap.tick, net.lastSnapshotTick)) return;
  net.lastSnapshotTick = snap.tick;
  G.wave = Number(snap.wave) || G.wave;
  G.kills = Number(snap.kills) || 0;
  G.score = Number(snap.score) || G.kills * 100;
  G.scoreBase = Math.round(G.score / Math.max(1, G.scoreMult));
  if (hud) {
    hud.setWave(G.wave);
    hud.setScore(G.score, G.kills);
  }
  onLanSnapshotApplyPlayers(snap.players || []);
  if (snap.versus && !G.versusMode) {
    // missed the start event: adopt versus defensively from the snapshot.
    // The mirror MUST use the same rect as the host's zone (site rect, not
    // level bounds) or client and host rings diverge.
    G.versusMode = true;
    net.team = net.team ?? 0;
    netZoneMirror = createZone({
      rect: (G.versusMode && level && level.bounds) ? { ...level.bounds }
        : (G.playRect || (G.site && G.site.rect) || { x0: -30, x1: 30, z0: -30, z1: 30 }),
      startDelay: 120, warnAt: 15,
    });
    G.zoneWarned = false;
    ensureZoneVisual();
    if (hud && hud.setMode) hud.setMode('VERSUS', '蓝军 vs 红军');
  }
  if (G.versusMode) {
    if (Array.isArray(snap.vscores) && snap.vscores.length === 2) {
      G.teamScores[0] = Number(snap.vscores[0]) || 0;
      G.teamScores[1] = Number(snap.vscores[1]) || 0;
    }
    if (snap.zone && netZoneMirror) netZoneMirror.applyRemote(snap.zone);
  }
  applyLanMilestones(snap.milestones || null);
  const seen = new Set();
  const list = Array.isArray(snap.enemies) ? snap.enemies : [];
  for (const d of list) {
    if (!d || d.id == null) continue;
    seen.add(String(d.id));
    getOrCreateNetEnemy(d);
  }
  for (const [id, e] of net.enemies) {
    if (seen.has(id)) continue;
    e.root.visible = false;
  }
  G.waveRemaining = list.filter((e) => e && e.alive !== false).length;
  G.waveTotal = Math.max(G.waveTotal, G.waveRemaining);
  if (hud && hud.setWaveProgress) hud.setWaveProgress(G.waveTotal ? 1 - G.waveRemaining / G.waveTotal : 1);
}

/** Nearest hostile human. The local player is filtered by team exactly like
    remote players are: a same-team bot must never lock onto its own human
    teammate. Returns null when no hostile human exists — in versus the squad
    then falls back to the enemy-team bots (nearestHostileActor). */
/**
 * The centroid of every living LAN player. The squad director uses it as its
 * planning anchor in co-op, so the squad converges on the TEAM instead of on
 * whichever player happens to be the host.
 */
function lanSquadCentroid() {
  let x = controller.pos.x, z = controller.pos.z, n = 1;
  for (const r of net.remote.values()) {
    if (!r.alive) continue;
    x += r.x; z += r.z; n++;
  }
  return { x: x / n, z: z / n };
}

function nearestLanTarget(pos, selfTeam = undefined) {
  // The local player's faction. In versus the host is blue (0) and a client
  // carries its assigned team; in co-op there is no faction at all.
  const localTeam = G.versusMode ? (net.team != null ? net.team : 0) : null;
  let best = null;
  let bestD = Infinity;
  // The local player needs the SAME team filter the remote players get:
  // a same-team bot must never lock onto its own human teammate. Both sides
  // must have a team — a naive compare of undefined === undefined would
  // treat the whole squad as hostile and make everyone shoot their own
  // teammates. In co-op selfTeam is undefined, so the human stays the target.
  if (!(selfTeam != null && localTeam != null && localTeam === selfTeam)) {
    best = {
      id: net.selfId || 'local',
      x: controller.pos.x, y: controller.pos.y, z: controller.pos.z,
      // The deployment window (versusGraceT) hides the local player from
      // targeting entirely: the per-enemy loop overwrites the shared
      // enemyCtx.playerAlive with tgt.alive, so the grace gate must live here
      // or it is silently overwritten and bots open fire mid-deployment.
      hp: G.hp,
      alive: G.hp > 0 && !(G.versusMode && G.versusGraceT > 0),
      speed: controller.state.speedMs,
      eyeY: engine.camera.position.y,
      team: localTeam,
    };
    bestD = Math.hypot(pos.x - best.x, pos.z - best.z);
  }
  for (const r of net.remote.values()) {
    if (!r.alive || r.hp <= 0) continue;
    // Versus filter: skip teammates. The double null-check matters — in co-op
    // or with old snapshots team is undefined on BOTH sides, and a naive
    // `r.team === selfTeam` compares undefined === undefined, treats the whole
    // squad as hostile and makes everyone shoot their own teammates.
    if (selfTeam != null && r.team != null && r.team === selfTeam) continue;
    const d = Math.hypot(pos.x - r.x, pos.z - r.z);
    if (d < bestD) { bestD = d; best = { id: r.id, x: r.x, y: r.y, z: r.z, hp: r.hp, alive: true, speed: r.speed || 0, eyeY: (r.y || 0) + 1.68, team: r.team }; }
  }
  return best;
}

function applyLanRemoteDamage(id, amount, from, attackerTeam) {
  const r = net.remote.get(String(id));
  if (!r || !r.alive) return;
  // Versus deployment grace: nothing may damage humans while teams spread out.
  if (G.versusMode && G.versusGraceT > 0) return;
  // Post-respawn invulnerability for remote humans.
  if (G.versusMode && (r.spawnGraceT || 0) > 0) return;
  r.hp = Math.max(0, r.hp - amount);
  if (lanSession) {
    lanSession.broadcastEvent('damage', {
      target: id, amount,
      from: from ? [from.x, from.y, from.z] : null,
    });
  }
  if (r.hp <= 0) {
    r.alive = false;
    r.avatar.alive = false;
    if (lanSession) lanSession.broadcastEvent('down', { target: id });
    if (G.versusMode) {
      // Host is the authority on versus deaths: schedule the respawn and score
      // the kill for the ATTACKER's faction (bots pass their own team).
      r.respawnAt = Date.now() + VERSUS_RESPAWN_MS;
      onVersusDeath(r.team, Number.isFinite(attackerTeam) ? attackerTeam : undefined,
        String(r.name || '玩家'));
    }
  }
}

/** Distance along a normalized ray to a sphere, or null. The host player owns
    no avatar mesh for clients to hit, so a client's shot at the host is tested
    analytically against two body spheres. */
function raySphereT(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/**
 * Host-authoritative melee for a LAN client. The client sends the swing
 * origin + direction; the host runs exactly the same cone test the local
 * player uses, so a client cannot stab through a wall or further away than
 * the blade reaches.
 */
function applyLanMelee(msg, w) {
  const ox = Number(msg.ox), oz = Number(msg.oz);
  const dx = Number(msg.dx), dz = Number(msg.dz);
  if (!Number.isFinite(ox) || !Number.isFinite(oz) || !Number.isFinite(dx) || !Number.isFinite(dz)) return;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return;
  const fx = dx / len, fz = dz / len;
  const cosLimit = Math.cos(w.meleeArc / 2);
  const shooter = net.remote.get(String(msg.id));
  const shooterTeam = (net.teamAssignments && net.teamAssignments[String(msg.id)] !== undefined)
    ? net.teamAssignments[String(msg.id)]
    : (shooter ? shooter.team : undefined);
  const shooterDmg = Math.min(3, Math.max(0.5, Number(msg.dmg) || 1));

  let target = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e || !e.alive || !e.root) continue;
    const ep = e.root.position;
    const ex = ep.x - ox, ez = ep.z - oz;
    const d = Math.hypot(ex, ez);
    if (d > w.meleeRange || d < 1e-4) continue;
    if ((ex * fx + ez * fz) / d < cosLimit) continue;
    if (d < bestD) { bestD = d; target = e; }
  }
  if (!target) return;

  const ep = target.root.position;
  const eFx = -Math.sin(target.root.rotation.y);
  const eFz = -Math.cos(target.root.rotation.y);
  let bx = ox - ep.x, bz = oz - ep.z;
  const bl = Math.hypot(bx, bz) || 1;
  bx /= bl; bz /= bl;
  const backstab = (bx * eFx + bz * eFz) < -0.34;
  const dmg = w.dmg * (backstab ? w.backstabMult : 1) * shooterDmg;
  _meleePoint.set(ep.x + bx * 0.25, ep.y + 1.25, ep.z + bz * 0.25);
  _meleeNormal.set(-bx, 0.25, -bz).normalize();
  const killed = target.takeDamage(dmg, _meleePoint, _meleeNormal, 'torso', shooterTeam);
  fx.blood(_meleePoint, _meleeNormal, _dir.set(fx, 0, fz));
  audio.impact('flesh');
  hud.hit(false, killed);
  if (killed) onEnemyKilled(target, false, 'melee', shooterTeam, backstab && w.backstabSilent);
}

function applyLanFire(msg) {
  if (!lanSession || net.role !== 'host') return;
  const w = WEAPONS.find((x) => x.id === msg.weapon);
  const shooter = net.remote.get(String(msg.id));
  if (!w || !shooter || !validFirePacket(msg, shooter, performance.now() / 1000, w)) return;
  shooter.lastFireSeq = msg.seq;
  shooter.lastFireAt = performance.now() / 1000;
  // a blade is not a bullet: the host runs the melee test for the client
  if (w.melee) { applyLanMelee(msg, w); return; }
  const ox = Number(msg.ox), oy = Number(msg.oy), oz = Number(msg.oz);
  const dir = new THREE.Vector3(Number(msg.dx), Number(msg.dy), Number(msg.dz));
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize();
  // Per-shooter damage upgrades (Phase 4a): the host cannot see a client's
  // card picks, so the client sends its multiplier (makeFire clamps 0.5-3).
  // Applies to ENEMY damage only — PvP stays base-weapon fair.
  const shooterDmg = Math.min(3, Math.max(0.5, Number(msg.dmg) || 1));
  // Friendly-fire and kill credit use the actual shooter, never the host.
  const shooterTeam = (net.teamAssignments && net.teamAssignments[String(msg.id)] !== undefined)
    ? net.teamAssignments[String(msg.id)]
    : shooter.team;
  const targets = level.bulletTargets.slice();
  for (const e of enemies) if (e.alive) targets.push(...e.hitboxes);
  // Versus: a client's crosshair can be on a PLAYER. Remote avatars (minus the
  // shooter and their teammates) join the target set; the host's own body is
  // tested analytically per pellet below.
  const versusFire = G.versusMode && !(G.versusGraceT > 0) && !G.versusOver;
  if (versusFire) {
    for (const r of net.remote.values()) {
      if (String(r.id) === String(msg.id) || !r.alive || !r.avatar || !r.avatar.group) continue;
      if (shooterTeam != null && r.team != null && r.team === shooterTeam) continue;
      r.avatar.group.traverse((o) => {
        if (o.isMesh && o.visible) {
          o.userData.pdTarget = r.id;
          targets.push(o);
        }
      });
    }
  }
  const pellets = w.pellets || 1;
  let end = null;
  let hitSomething = false, headshot = false, killed = false;
  const origin = new THREE.Vector3(ox, oy, oz);
  for (let p = 0; p < pellets; p++) {
    const d = dir.clone();
    if (p > 0) {
      d.x += (Math.random() - 0.5) * (w.spread || 0.02) * 1.6;
      d.y += (Math.random() - 0.5) * (w.spread || 0.02) * 1.6;
      d.z += (Math.random() - 0.5) * (w.spread || 0.02) * 1.6;
      d.normalize();
    }
    raycaster.set(origin, d);
    raycaster.far = 160;
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.object.visible || h.object.userData.enemy || h.object.userData.rayOnly);
    net.lastFire = hit ? { d: +hit.distance.toFixed(2), enemy: !!hit.object.userData.enemy, part: hit.object.userData.part, name: hit.object.name, visible: hit.object.visible, total: hits.length } : { miss: true, total: hits.length };
    if (!end) end = hit ? hit.point.clone() : origin.clone().addScaledVector(d, 120);

    // the host's own body: two analytic spheres, nearest surface wins over
    // any mesh hit further down the ray
    if (versusFire && G.hp > 0 && G.state === 'playing'
        && (shooterTeam == null || net.team == null || shooterTeam !== net.team)) {
      const tHead = raySphereT(origin, d, controller.pos.x, controller.pos.y + 1.58, controller.pos.z, 0.32);
      const tBody = raySphereT(origin, d, controller.pos.x, controller.pos.y + 1.05, controller.pos.z, 0.55);
      const t = (tHead != null && (tBody == null || tHead <= tBody)) ? tHead : tBody;
      if (t != null && t <= 160 && (!hit || t < hit.distance)) {
        if (!end) end = origin.clone().addScaledVector(d, t);
        const falloff = w.falloff ? w.falloff(t) : 1;
        const wasAlive = G.hp > 0;
        applyPlayerDamage(w.dmg * falloff * (tHead != null && t === tHead ? 1.5 : 1), origin);
        hitSomething = true;
        headshot = headshot || (tHead != null && t === tHead);
        if (wasAlive && G.hp <= 0) {
          killed = true;
          onVersusDeath(net.team, Number.isFinite(shooterTeam) ? shooterTeam : undefined, net.name || 'HOST');
        }
        continue;
      }
    }
    if (!hit) continue;
    if (p === 0) end = hit.point.clone();
    const pdId = hit.object.userData.pdTarget;
    if (pdId != null && versusFire) {
      // player hit: damage the host's mirror (respawn + team score), then
      // broadcast so the victim applies it to their real HP
      const falloff = w.falloff ? w.falloff(hit.distance) : 1;
      const head2 = hit.object.userData.part === 'head';
      const dmg = w.dmg * falloff * (hit.object.userData.dmg || 1);
      versusApplyPlayerDamage(String(pdId), dmg, shooterTeam, head2);
      lanSession.broadcastEvent('pdmg', { target: String(pdId), amount: dmg, headshot: head2, team: shooterTeam });
      hitSomething = true;
      headshot = headshot || head2;
      const rr = net.remote.get(String(pdId));
      if (rr && !rr.alive) killed = true;
      if (fx) fx.blood(hit.point, hit.face ? hit.face.normal : d.clone().negate(), d);
      continue;
    }
    const enemy = hit.object.userData.enemy;
    if (enemy && enemy.alive) {
      const part = hit.object.userData.part;
      const mult = hit.object.userData.dmg || 1;
      const norm = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).negate() : d.clone().negate();
      const falloff = w.falloff ? w.falloff(hit.distance) : 1;
      const didKill = enemy.takeDamage(w.dmg * falloff * mult * shooterDmg, hit.point, norm, part, shooterTeam);
      hitSomething = true; headshot = part === 'head'; killed = killed || didKill;
      if (didKill) onEnemyKilled(enemy, headshot, 'bullet', shooterTeam);
    } else {
      const mat = hit.object.userData.srcMat || hit.object.material;
      let kind = 'concrete';
      if (mat === engine.mats.metal || mat === engine.mats.metalTan || mat === engine.mats.rust || mat === engine.mats.shop) kind = 'metal';
      else if (mat === engine.mats.wood || mat === engine.mats.woodDark) kind = 'wood';
      if (fx) fx.impact(hit.point, hit.face ? hit.face.normal : d.clone().negate(), kind);
    }
  }
  if (end && fx) fx.tracer(origin, end);
  if (hitSomething && lanSession) {
    lanSession.broadcastEvent('hit', { target: msg.id, headshot, killed });
  }
  if (end && lanSession) {
    lanSession.broadcastEvent('shot', { from: [ox, oy, oz], to: [end.x, end.y, end.z] });
  }
}

function sendLanSnapshot() {
  if (!lanSession || net.role !== 'host') return;
  const players = [{
    id: net.selfId, name: net.name, team: net.team,
    x: +controller.pos.x.toFixed(2), y: +controller.pos.y.toFixed(2), z: +controller.pos.z.toFixed(2),
    yaw: +controller.yaw.toFixed(3), pitch: +controller.pitch.toFixed(3),
    hp: Math.round(G.hp), alive: G.hp > 0, speed: +controller.state.speedMs.toFixed(2),
    crouch: controller.state.crouching ? 1 : 0, ads: +controller.adsAmount.toFixed(2),
    weapon: currentWeapon().id,
  }];
  for (const r of net.remote.values()) {
    players.push({
      id: r.id, name: r.name, team: r.team,
      x: +r.x.toFixed(2), y: +(r.y || 0).toFixed(2), z: +r.z.toFixed(2),
      yaw: +r.yaw.toFixed(3), pitch: +r.pitch.toFixed(3),
      hp: Math.round(r.hp), alive: r.alive, speed: r.speed || 0,
      crouch: r.crouch || 0, ads: r.ads || 0, weapon: r.weapon || 'unknown',
    });
  }
  const es = [];
  for (const e of enemies) {
    if (!e.root.visible || e.netRemote || !e._netId) continue;
    es.push({
      id: e._netId, type: e.archetype,
      x: +e.root.position.x.toFixed(2), y: +e.root.position.y.toFixed(2), z: +e.root.position.z.toFixed(2),
      yaw: +e.root.rotation.y.toFixed(3),
      hp: Math.round(e.hp), alive: e.alive,
    });
  }
  lanSession.broadcastSnapshot({
    tick: ++net.tick, players, enemies: es,
    site: G.site && G.site.id,
    versus: G.versusMode, teams: net.teamAssignments || null,
    teamScores: G.teamScores, grace: G.versusGraceT,
    zone: zoneSys ? zoneSys.serialize() : null,
    wave: G.wave, kills: G.kills, score: G.score,
    objective: G.objective ? { type: G.objective.type, done: !!G.objective.done } : null,
    // host-authoritative milestone chain; makeSnapshot() is a pass-through so
    // no protocol change is needed for this field
    milestones: milestones ? milestones.serialize() : null,
    versus: G.versusMode,
    vscores: G.versusMode ? G.teamScores.slice() : null,
    zone: (G.versusMode && zoneSys) ? zoneSys.serialize() : null,
  });
}

/* Host migration: a client promoted to host mid-game rebuilds the world from
   the resume snapshot the relay cached (see server/lan.mjs). The replica
   enemies it was rendering become authoritative; wave/kills/score carry over.
   Honest limits: grenade/projectile in-flight state and AI micro-state are not
   transferred — enemies continue from their snapshot position/hp. */
function promoteToLanHost(resume) {
  if (!lanSession || !lanSession.isHost || !net.started || net.role !== 'client') return;
  net.role = 'host';
  net.hostId = net.selfId;
  if (resume && typeof resume === 'object') {
    if (resume.site) {
      G.site = siteById(resume.site);
      if (G.site) G.playRect = G.site.rect;
    }
    if (Number.isFinite(Number(resume.wave)) && Number(resume.wave) > 0) G.wave = Number(resume.wave);
    if (Number.isFinite(Number(resume.kills))) G.kills = Number(resume.kills);
    if (Number.isFinite(Number(resume.score))) G.score = Number(resume.score);
    G.scoreBase = Math.round(G.score / Math.max(1, G.scoreMult));
    // Replica enemies (netRemote) become the authoritative set. Their ids were
    // the host's _netId values, so future snapshots keep the same identity.
    // Keep net.enemies populated: getOrCreateNetEnemy below must find (not
    // recreate) these instances.
    for (const [id, e] of net.enemies) {
      e.netRemote = false;
      e._netId = id;
    }
    const list = Array.isArray(resume.enemies) ? resume.enemies : [];
    for (const d of list) {
      if (!d || d.id == null) continue;
      getOrCreateNetEnemy(d);
    }
    // New spawns must never collide with ids inherited from the old host.
    netEnemySeq = 1000000;
  }
  if (hud) {
    hud.setWave(G.wave);
    hud.setScore(G.score, G.kills);
    if (hud.toast) hud.toast('你已成为新任房主 · 世界状态已接管');
  }
}

function startLanHostGame(opts = {}) {
  if (!lanSession || !lanSession.isHost) return;
  requestGameFullscreen();
  if (net.started) return;
  net.role = 'host';
  net.selfId = lanSession.id;
  net.started = true;
  if (lanLobby) lanLobby.close();
  if (hud && hud.closeLanModal) hud.closeLanModal();
  campaignActive = false;
  G.settings.runMode = 'survival';
  G.operation = null;
  G.tutorial.done = true;
  G.tutorial.active = false;

  // ---- versus setup: teams alternate by lobby join order; host is team 0 ----
  // G.* versus flags go on AFTER startGame(): resetGame() clears them so a
  // previous versus match can never leak into a fresh run.
  const versus = opts.versus === true;
  net.team = undefined;
  const lobbyPlayers = (opts.players && opts.players.length)
    ? opts.players
    : (lanSession.players || []);
  const teams = {};
  // Versus TDM: two factions of up to 4, alternating by lobby join order so
  // the host (first entry) anchors team 0. Co-op ignores this entirely.
  lobbyPlayers.slice(0, 8).forEach((p, i) => { teams[String(p.id)] = versus ? i % 2 : 0; });
  if (net.selfId != null && teams[String(net.selfId)] === undefined) {
    teams[String(net.selfId)] = 0;
  }
  if (versus) net.team = teams[String(net.selfId)] ?? 0;
  net.teamAssignments = teams;
  // Human spawn slots: per-team join order, humans first, fill bots take the
  // later slots, so a full lobby covers the map instead of stacking.
  net.spawnSlots = {};
  if (versus) {
    const seen = [0, 0];
    for (const p of lobbyPlayers) {
      const t = teams[String(p.id)] ?? 0;
      net.spawnSlots[String(p.id)] = { team: t, index: seen[t]++ };
    }
    if (net.selfId != null && !net.spawnSlots[String(net.selfId)]) {
      net.spawnSlots[String(net.selfId)] = { team: net.team, index: seen[net.team]++ };
    }
  }

  startGame(false, true);
  G.versusMode = versus;
  G.versusOver = false;
  G.versusGraceT = versus ? VERSUS_GRACE_S : 0;
  G.versusGraceNotified = false;
  G.teamScores = [0, 0];
  G.state = 'playing';
  if (versus) {
    // spread the host player too — the site centre is a co-op convention
    const mySlot = net.spawnSlots[String(net.selfId)];
    const sp = versusSpawnSlot(mySlot ? mySlot.team : net.team, mySlot ? mySlot.index : 0, 3);
    controller.revive(sp.x, sp.z);
    controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  } else {
    // Co-op: the squad lands on a RALLY RING, not on one coordinate. Every
    // peer derives the same ring from the same player list, so the squad
    // arrives together but nobody is standing inside anybody else.
    const ids = lobbyPlayers.map((p) => String(p.id));
    const spot = assignCoopRallySpot({
      site: G.site, playerIds: ids, selfId: net.selfId, seed: SPAWN_SEED,
    });
    controller.revive(spot.x, spot.z);
    controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  }
  if (lanSession) {
    lanSession.broadcastEvent('start', {
      wave: 1, site: G.site && G.site.id, versus, teams,
      grace: G.versusGraceT,
      // Co-op peers need the full roster to derive the same rally ring the
      // host used; without it every client would land on its own single
      // anchor and the squad would stack.
      players: lobbyPlayers.map((p) => ({ id: String(p.id) })),
    });
  }
  if (lanLobby) lanLobby.setPlayers(lanSession.players || []);
  syncLanAvatars(lanSession.players || []);
  for (const [id, team] of Object.entries(teams)) {
    const r = net.remote.get(String(id));
    if (r) r.team = team;
  }

  if (versus) {
    // Combat tier and concurrent shooters must be match-level, not the
    // wave-1 training tier, or the fill bots queue behind one firing slot.
    G.diff = DIFF_TIERS[3];
    firingSlots.max = 4;
    resetFiringSlots();
    startZone();
    // conquest rounds (Phase 4b) own the match from here: the first round's
    // deployment grace is the lobby spread (VERSUS_GRACE_S)
    conquestHostInit();
    startVersusBots(teams, lobbyPlayers);
    conquestSyncBroadcast();
    if (hud && hud.setMode) hud.setMode('VERSUS', '回合制征服 · 蓝军 vs 红军');
    if (hud && hud.toast) hud.toast(`对抗模式 · 你是${net.team === 0 ? '蓝军' : '红军'} · 三局两胜`, 3200);
  } else {
    // Co-op previously started with G.operation = null, so the only thing the HUD
    // could report was "clear hostiles" — players had no idea what they were
    // meant to be doing. The host now owns a milestone chain and relays it.
    startMilestones();
    if (hud && hud.setMode) hud.setMode('OBJECTIVE', '推进任务链');
    if (hud && hud.toast) hud.toast('LAN CO-OP · 等待队友');
  }
}

function startLanClientGame(siteId = 'street', startMsg = null) {
  if (net.started) return;
  // LAN START is a host event, not a local gesture; browsers may deny this.
  requestGameFullscreen();
  if (audio) { audio.init(); if (audio.resume) audio.resume(); audio.setMasterVolume(G.settings.master); }
  net.role = 'client';
  net.selfId = lanSession ? lanSession.id : net.selfId;
  net.started = true;
  if (lanLobby) lanLobby.close();
  if (hud && hud.closeLanModal) hud.closeLanModal();
  campaignActive = false;
  G.settings.runMode = 'survival';
  G.operation = null;
  G.tutorial.done = true;
  G.tutorial.active = false;

  // versus flag + team assignment arrive with the host's start event.
  // G.* flags are applied AFTER resetGame(), which clears leftover versus state.
  const versus = startMsg && startMsg.versus === true;
  net.team = undefined;
  if (versus) {
    const teams = (startMsg && startMsg.teams) || {};
    net.team = teams[String(net.selfId)] ?? 0;
    net.teamAssignments = teams;
  }

  resetGame();
  G.versusMode = versus;
  G.versusOver = false;
  G.versusGraceT = versus ? (Number(startMsg && startMsg.grace) || VERSUS_GRACE_S) : 0;
  G.versusGraceNotified = false;
  G.teamScores = [0, 0];
  G.state = 'playing';
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  G.site = siteById(siteId);
  G.playRect = G.site.rect;
  if (!versus) {
    // Co-op: same rally ring the host used — derived from the roster the
    // host broadcast, so this client lands beside its squadmates instead of
    // on the single anchor point they all used to share.
    const roster = (startMsg && Array.isArray(startMsg.players))
      ? startMsg.players.map((p) => String(p.id))
      : [];
    const spot = assignCoopRallySpot({
      site: G.site, playerIds: roster, selfId: net.selfId, seed: SPAWN_SEED,
    });
    controller.revive(spot.x, spot.z);
  } else {
    controller.revive(G.site.x + 2.2, G.site.z + 1.0);
  }
  controller.setLook(G.site.yaw || -0.03, -0.015);
  G.wave = 1;
  G.reserve = Math.max(G.reserve, 240);
  hideObjectiveUI();
  if (versus) {
    // Client mirrors the host's ring read-only; visuals + damage below.
    netZoneMirror = createZone({
      rect: (level && level.bounds) ? { ...level.bounds } : G.site.rect,
      startDelay: 120, warnAt: 15,
    });
    ensureZoneVisual();
    // Mirror the host's slot registry from the start event so both ends spawn
    // at the same spread-out map points, then take this client's own slot.
    const startTeams = (startMsg && startMsg.teams) || {};
    net.spawnSlots = {};
    const seen = [0, 0];
    Object.keys(startTeams).forEach((pid) => {
      const t = startTeams[pid] ?? 0;
      net.spawnSlots[String(pid)] = { team: t, index: seen[t]++ };
    });
    const mySlot = net.spawnSlots[String(net.selfId)];
    const sp = versusSpawnSlot(mySlot ? mySlot.team : (net.team ?? 0), mySlot ? mySlot.index : 0, 3);
    controller.revive(sp.x, sp.z);
    controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
    // conquest mirror (Phase 4b): same points as the host (deterministic per
    // site), state arrives via cquest events
    conquestClientInit(G.site.id);
    if (hud && hud.setMode) hud.setMode('VERSUS', '回合制征服 · 蓝军 vs 红军');
    if (hud && hud.toast) hud.toast(`对抗模式 · 你是${net.team === 0 ? '蓝军' : '红军'} · 三局两胜`, 3200);
  }
  if (hud) {
    if (!versus && hud.setMode) hud.setMode('SURVIVAL', 'HOLD THE LINE');
    hud.setWave(1); hud.setScore(0, 0); hud.setHint('LAN · 同步中…');
  }
  if (input) input.lock();
  net.inputT = 0;
}

function respawnLanLocal() {
  if (G.state === 'playing') return;
  G.hp = G.maxHp;
  G.armor = G.maxArmor;
  G.reserve = Math.max(G.reserve, 240);
  G.state = 'playing';
  net.moveEpoch += 1; // authorizes one explicit redeployment on the host
  // Versus: respawn on YOUR faction slot, same as the host's registry says —
  // the site centre is a co-op convention and double-writing the two spawns
  // snapped the camera across the map on the next input packet.
  let sp = null;
  if (G.versusMode && net.spawnSlots) {
    const mySlot = net.spawnSlots[String(net.selfId)];
    sp = versusSpawnSlot(mySlot ? mySlot.team : (net.team ?? 0), mySlot ? mySlot.index : 0, 3);
  } else if (!G.versusMode && net.role === 'client') {
    // Co-op respawn: back to this player's own spot on the rally ring, so a
    // revived squad reforms where it started rather than at one shared
    // anchor point.
    const roster = (lanSession && Array.isArray(lanSession.players))
      ? lanSession.players.map((p) => String(p.id))
      : [];
    const spot = assignCoopRallySpot({
      site: G.site, playerIds: roster, selfId: net.selfId, seed: SPAWN_SEED,
    });
    sp = spot;
  }
  controller.revive(
    sp ? sp.x : (G.site ? G.site.x : 1.2) + 2.2,
    sp ? sp.z : (G.site ? G.site.z : 33) + 1.0);
  controller.setLook((G.site && G.site.yaw) || -0.03, -0.015);
  viewmodel.state.dead = false;
  // Post-respawn invulnerability (CONQUEST.SPAWN_GRACE_S) — a client that
  // respawns into a firefight needs the same grace the host grants itself.
  if (G.versusMode) net.spawnGraceT = CONQUEST.SPAWN_GRACE_S;
  if (hud) { hud.setHealth(G.hp, pipsFor(G.armor)); hud.setHint(''); }
}

/* ---- LAN co-op downed / revive (Phase 4a) -------------------------------------
   Authority: the host's registry (systems/medical.js). Every peer mirrors it
   from events so it can mount a "hold E to revive" prompt on the downed ally.
     downed  {from,x,z}   a player went down (client → host → everyone)
     revive  {target}     a reviver finished the channel (client → host)
     revived {target,by}  host confirmed the pick-up (host → everyone)
     bledout {from}       the clock ran out (→ regular dead + respawn)
     wipe    {}           nobody standing: everyone redeploys together
   Not carried through host migration: a new host rebuilds from the snapshot,
   downed players simply read as dead there and bleed out locally. ---------- */

function reviveLabelFor(id) {
  if (String(id) === String(net.selfId)) return '按住 E 救援';
  const r = net.remote.get(String(id));
  return `按住 E 救援 ${(r && r.name) || '队友'}`;
}

function mountReviveTarget(id) {
  const key = String(id);
  if (key === String(net.selfId)) return;             // you cannot revive yourself
  if (coopReviveMarks.has(key) || !interact) return;
  const p = ensureCoopDowned().posOf(key);
  if (!p) return;
  const rec = interact.add({
    x: p.x, z: p.z, r: 2.6,
    label: reviveLabelFor(key),
    hold: REVIVE_HOLD_S,
    onUse: () => requestRevive(key),
  });
  coopReviveMarks.set(key, rec);
}

function unmountReviveTarget(id) {
  const rec = coopReviveMarks.get(String(id));
  if (rec && interact) { try { interact.remove(rec); } catch (e) { /* already gone */ } }
  coopReviveMarks.delete(String(id));
}

function unmountAllReviveTargets() {
  for (const id of Array.from(coopReviveMarks.keys())) unmountReviveTarget(id);
}

/** A peer reported going down: register, drop the mirror into its corpse
    pose, and offer the revive prompt. */
function onPeerDowned(id, x, z) {
  const key = String(id);
  ensureCoopDowned().down(key, x, z, Date.now());
  const r = net.remote.get(key);
  if (r) {
    r.hp = 0;
    r.alive = false;
    r.downed = true;
    if (r.avatar) r.avatar.alive = false;
  }
  mountReviveTarget(key);
  if (hud && hud.addKillFeed) hud.addKillFeed(`${(r && r.name) || '队友'} 倒地 · 需要救援`);
}

function requestRevive(targetId) {
  if (G.state !== 'playing') return;
  if (net.role === 'host') hostRevive(String(net.selfId), String(targetId));
  else if (lanSession) lanSession.sendEvent('revive', { target: String(targetId) });
}

/** Host: validate a revive request against the registry (still down, in range). */
function hostRevive(byId, targetId) {
  if (net.role !== 'host' || G.versusMode) return;
  const reg = ensureCoopDowned();
  let rp = null;
  if (byId === String(net.selfId)) {
    if (G.state === 'playing') rp = { x: controller.pos.x, z: controller.pos.z };
  } else {
    const rr = net.remote.get(byId);
    if (rr && rr.alive) rp = { x: rr.x, z: rr.z };
  }
  if (!rp || !reg.canRevive(targetId, rp, Date.now())) return;
  reg.clear(targetId);
  if (lanSession) lanSession.broadcastEvent('revived', { target: targetId, by: byId });
  handleRevived(targetId, byId);
}

/** Everyone (host included — its own broadcast does not loop back). */
function handleRevived(targetId, byId) {
  const key = String(targetId);
  ensureCoopDowned().clear(key);
  unmountReviveTarget(key);
  const byName = String(byId) === String(net.selfId) ? '你'
    : ((net.remote.get(String(byId)) || {}).name || '队友');
  if (key === String(net.selfId)) {
    standUpFromDown();
    if (hud && hud.addKillFeed) hud.addKillFeed(`${byName} 救起了你`);
    return;
  }
  const r = net.remote.get(key);
  if (r) {
    r.downed = false;
    r.alive = true;
    r.hp = Math.max(r.hp, Math.round(100 * REVIVE_HP_FRAC));
    if (r.avatar) r.avatar.alive = true;
  }
  if (hud && hud.addKillFeed) hud.addKillFeed(`${byName} 救起了 ${(r && r.name) || '队友'}`);
}

function standUpFromDown() {
  if (G.state !== 'downed') return;
  G.state = 'playing';
  G.downedT = 0;
  G.hp = Math.max(1, Math.round(G.maxHp * REVIVE_HP_FRAC));
  controller.revive(controller.pos.x, controller.pos.z);
  viewmodel.state.dead = false;
  if (hud) { hud.setHealth(G.hp, pipsFor(G.armor)); hud.setHint('已被救起 · 三分之一血量'); }
  if (audio && audio.uiConfirm) audio.uiConfirm();
  if (!SHOT_MODE && input && input.lock) input.lock();
}

/** The local bleed-out clock ran out: become properly dead and redeploy. */
function bleedOutLocal() {
  if (G.state !== 'downed') return;
  G.state = 'dead';
  net.respawnT = WIPE_RESPAWN_S;
  const me = String(net.selfId);
  ensureCoopDowned().clear(me);
  if (net.role === 'host') {
    if (lanSession) lanSession.broadcastEvent('bledout', { from: me });
    checkCoopWipe();
  } else if (lanSession) {
    lanSession.sendEvent('bledout', {});
  }
  if (hud && hud.setHint) hud.setHint(`流血过多 · ${WIPE_RESPAWN_S} 秒后重新部署`);
}

function onPeerBledOut(id) {
  const key = String(id);
  ensureCoopDowned().clear(key);
  unmountReviveTarget(key);
  const r = net.remote.get(key);
  if (r) r.downed = false;      // stays dead until their respawn input arrives
}

/** Host: nobody left standing → squad wipe, everyone redeploys together. */
function checkCoopWipe() {
  if (net.role !== 'host' || G.versusMode || !lanSession) return;
  const reg = ensureCoopDowned();
  const humans = [{ id: String(net.selfId), alive: G.state === 'playing' || G.state === 'downed' }];
  for (const [id, r] of net.remote) humans.push({ id: String(id), alive: !!r.alive || reg.isDown(id) });
  if (!reg.isWipe(humans)) return;
  lanSession.broadcastEvent('wipe', {});
  coopWipeLocal();
}

function coopWipeLocal() {
  ensureCoopDowned().clearAll();
  unmountAllReviveTargets();
  for (const r of net.remote.values()) r.downed = false;
  if (G.state === 'downed') {
    G.state = 'dead';
    net.respawnT = WIPE_RESPAWN_S;
  }
  if (hud) {
    if (hud.toast) hud.toast('小队全灭 · 重新部署', 3000);
    if (hud.setHint && G.state === 'dead') hud.setHint(`小队全灭 · ${WIPE_RESPAWN_S} 秒后重新部署`);
    if (hud.radio) hud.radio('VEGA', '全队倒了……重新集结，再来一次。', 3600, 'stage_clear');
  }
}

/** Host: sweep bleed-out clocks for peers whose own clock may have drifted. */
function sweepCoopDowned() {
  if (net.role !== 'host' || G.versusMode || !coopDowned) return;
  for (const id of coopDowned.expired(Date.now())) {
    if (id === String(net.selfId)) { if (G.state === 'downed') bleedOutLocal(); continue; }
    onPeerBledOut(id);
    if (lanSession) lanSession.broadcastEvent('bledout', { from: id });
  }
}

/* ---- LAN co-op per-player upgrades (Phase 4a) ---------------------------------
   The host used to be the only one picking cards. Now it broadcasts the offer
   and every client picks locally; damage picks travel back inside the fire
   packet (makeFire.dmg), everything else is already client-side. ------------ */
function clientUpgradeOffer(cardIds) {
  if (net.role !== 'client' || G.versusMode) return;
  if (G.state !== 'playing' || !hud || !hud.showUpgrades) return;   // downed/dead: you miss this one
  const picked = [];
  for (const id of Array.isArray(cardIds) ? cardIds : []) {
    const u = UPGRADE_POOL.find((c) => c.id === id);
    if (u) picked.push(u);
  }
  const cards = (picked.length ? picked : shuffle(UPGRADE_POOL.slice()).slice(0, 3))
    .map((u, i) => ({ ...u, key: String(i + 1) }));
  G.state = 'upgrade';
  G.upgradeT = 0;
  G.upgradeCards = cards;
  hud.showUpgrades(G.upgradeCards, handleUpgradePick);
  input.unlock();
}

function netTick(dt) {
  if (!lanSession || !net.started) return;
  if (net.role === 'host') {
    net.snapT += dt;
    if (net.snapT >= 0.05) { net.snapT = 0; sendLanSnapshot(); }
    for (const r of net.remote.values()) {
      // The LAN payload carries position but not velocity. Derive a coarse
      // speed from the snapshot deltas so the AI can tell a sprinting peer
      // from a static one (hearing radius, hit falloff, intel refresh).
      const now = performance.now() / 1000;
      const prev = r.lastSpeedSample;
      r.speed = prev ? Math.hypot(r.x - prev.x, r.z - prev.z) / Math.max(0.05, now - prev.t) : 0;
      r.lastSpeedSample = { x: r.x, z: r.z, t: now };
      r.avatar.apply({
        x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, alive: r.alive,
        speed: r.speed, crouch: r.crouch, aim: r.ads == null ? 0.6 : r.ads,
      }, dt);
      if (r.avatar.alive) r.avatar.group.visible = Math.hypot(r.x - controller.pos.x, r.z - controller.pos.z) > 0.85;
    }
  } else if (net.role === 'client') {
    net.inputT += dt;
    if (net.inputT >= 0.05) {
      net.inputT = 0;
      lanSession.sendInput({
        seq: ++net.seq,
        x: +controller.pos.x.toFixed(2), y: +controller.pos.y.toFixed(2), z: +controller.pos.z.toFixed(2),
        yaw: controller.yaw, pitch: controller.pitch,
        hp: Math.round(G.hp), alive: G.hp > 0 && G.state !== 'dead',
        speed: controller.state.speedMs,
        crouch: controller.state.crouching ? 1 : 0,
        ads: controller.adsAmount,
        weapon: currentWeapon().id,
        moveEpoch: net.moveEpoch,
      });
    }
    for (const r of net.remote.values()) {
      r.avatar.apply({
        x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, alive: r.alive,
        speed: r.speed, crouch: r.crouch, aim: r.ads == null ? 0.6 : r.ads,
      }, dt);
      if (r.avatar.alive) r.avatar.group.visible = Math.hypot(r.x - controller.pos.x, r.z - controller.pos.z) > 0.85;
    }
    for (const e of net.enemies.values()) {
      if (!e.root.visible) continue;
      if (e.alive) {
        const t = e.netTarget;
        if (t) {
          const a = Math.min(1, dt * 14);
          const moved = Math.hypot(t.x - e.root.position.x, t.z - e.root.position.z);
          e.root.position.x += (t.x - e.root.position.x) * a;
          e.root.position.y += (t.y - e.root.position.y) * a;
          e.root.position.z += (t.z - e.root.position.z) * a;
          let dy = (e.netYaw || 0) - e.root.rotation.y;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          e.root.rotation.y += dy * Math.min(1, dt * 12);
          e.walkAmp += ((moved > 0.03 ? 0.7 : 0) - e.walkAmp) * Math.min(1, dt * 8);
          e.animT = (e.animT || 0) + dt * (moved > 0.03 ? 7 : 1.2);
        }
        e.aimBlend = 0.8;
        e.applyBodyPose();
      } else {
        e.updateDeath(dt);
      }
    }
  }
  if (G.state === 'downed' && net.role) {
    G.downedT -= dt;
    if (hud && hud.setHint) hud.setHint(`倒地 · 等待救援 · ${Math.max(0, Math.ceil(G.downedT))} 秒后流血`);
    if (G.downedT <= 0) bleedOutLocal();
  }
  if (net.role === 'host') sweepCoopDowned();
  if (G.state === 'dead' && net.role) {
    net.respawnT -= dt;
    if (net.respawnT <= 0) respawnLanLocal();
  }
}

/* ---- tactical map feed ------------------------------------------------
   The minimap only shows what the player could reasonably know: loot that
   is lying in the world and the squadmates that are fighting next to you.
   Both lists are tiny, but the map only repaints at 10 Hz, so they are
   rebuilt on a slow tick instead of every frame. */
let minimapFeedT = 0;
let minimapLootCache = null;
let minimapAllyCache = null;

function minimapLoot() {
  if (!pickups) return null;
  return pickups.list();
}

function minimapAllies() {
  const out = [];
  if (net.started) {
    for (const [, r] of net.remote) {
      if (!r || !r.alive) continue;
      // in versus only the own faction is a squadmate; in co-op everyone is
      if (G.versusMode && net.team != null && r.team != null && r.team !== net.team) continue;
      out.push({ x: r.x, z: r.z, yaw: r.yaw });
    }
  }
  if (G.versusMode && net.team != null) {
    for (const b of versusBots) {
      if (!b.e || !b.e.alive || b.team !== net.team) continue;
      out.push({
        x: b.e.root.position.x,
        z: b.e.root.position.z,
        yaw: b.e.root.rotation.y,
      });
    }
  }
  return out;
}

function minimapFeed(dt) {
  minimapFeedT -= dt;
  if (minimapFeedT > 0) return;
  minimapFeedT = 0.2;
  minimapLootCache = minimapLoot();
  minimapAllyCache = minimapAllies();
}

function updateGame(dt) {
  G.time += dt;
  const playing = G.state === 'playing';
  // In LAN, a local pause/upgrade overlay only suppresses input. The room,
  // objective clocks and network replication continue in the background.
  const simPlaying = playing || (net.started && (G.state === 'paused' || G.state === 'upgrade'));
  const lookDX = playing ? input.mouse.dx : 0;
  const lookDY = playing ? input.mouse.dy : 0;

  const jumpNow = playing && input.pressedOnce('Space');
  const meleeOut = !!(currentWeapon() && currentWeapon().melee);
  controller.update(dt, playing ? input : null, {
    ads: playing && input.mouse.right && !meleeOut,
    sprinting: playing && input.down('ShiftLeft'),
    crouching: playing && (input.down('ControlLeft') || input.down('KeyC')),
    jump: jumpNow,
  });
  if (jumpNow) G.tut.jumps++;

  if (G.versusMode && simPlaying && G.versusGraceT > 0) {
    G.versusGraceT = Math.max(0, G.versusGraceT - dt);
    if (G.versusGraceT === 0 && !G.versusGraceNotified) {
      G.versusGraceNotified = true;
      if (hud && hud.toast) hud.toast('交战开始 · 自由开火', 2600);
    }
  }
  // Post-respawn invulnerability for the local human. CONQUEST.SPAWN_GRACE_S
  // was assigned on redeploy but never ticked down and never read, so a
  // respawning player could be shot down again before they moved.
  if (G.versusMode && (net.spawnGraceT || 0) > 0) {
    net.spawnGraceT = Math.max(0, net.spawnGraceT - dt);
  }

  // If a prop/doorway still traps the player, nudge them to the nearest free
  // nav cell after a short pause instead of leaving them permanently stuck.
  if (playing && nav && !G.debugNoUnstick) {
    stuckCooldown = Math.max(0, stuckCooldown - dt);
    const p = controller.pos;
    const gh = level.groundHeight ? level.groundHeight(p.x, p.z, p.y) : 0;
    const grounded = p.y <= gh + 0.55;
    if (!nav.isWalkableAt(p.x, p.z, p.y) && grounded && controller.state.speed < 0.45) {
      stuckTimer += dt;
      if (stuckTimer > 0.8 && stuckCooldown <= 0) {
        const w = nav.closestWalkableOn(p.x, p.z, p.y);
        if (w) {
          const yaw = engine.camera.rotation.y, pitch = engine.camera.rotation.x;
          controller.revive(w.x, w.z);
          controller.setLook(yaw, pitch);
          stuckCooldown = 1.5;
          if (hud && hud.toast) hud.toast('已脱离卡点', 900);
        }
        stuckTimer = 0;
      }
    } else {
      stuckTimer = Math.max(0, stuckTimer - dt * 2);
    }
  }

  if (simPlaying) {
    updateWeaponSwap(dt);
    tryFire(dt);
    updateReload(dt);
    // Grenades run on every peer now: clients simulate the visual arc of
    // their own throws while the host simulates the authoritative one.
    updateGrenades(dt);

    // health regen
    G.sinceDamage += dt;
    if (G.sinceDamage > 3.2 && G.hp < G.maxHp) {
      G.hp = Math.min(G.maxHp, G.hp + G.regenRate * dt);
      hud.setHealth(G.hp, pipsFor(G.armor));
      if (G.hp > 40) audio.setLowHealth(false);
    }
    if (G.versusMode) {
      updateZone(dt);
      if (net.role === 'host') {
        // The conquest round tick — capture progress, hold income, the round
        // clock, the rubber band. It was DEFINED but never CALLED, so the
        // whole round simulation was frozen: no clock, no captures, no
        // scoring, and every round simply never ended.
        updateConquest(dt);
        if (!(G.versusGraceT > 0) && !G.versusOver) updateTeamBrains(dt);
        updateVersusBots(dt);
        updateVersusRespawns(dt);
      }
    }
    updateInventory(dt);
    if (net.role !== 'client') {
      if (!G.versusMode) {
        updateObjective(dt);
        updateWaves(dt);
        // boss HP-threshold script actions (campaign only; needs G.boss)
        updateBossPhases();
      }
      updateTutorial(dt);
      updateMilestones(dt);
    }
    updateBeacon(dt);

    // AI v2: sprinting boots are a noise event; crouch-walking is silent
    if (perception && controller.state.sprinting && controller.state.speed > 4.0) {
      G.footstepNoise = (G.footstepNoise || 0) - dt;
      if (G.footstepNoise <= 0) {
        G.footstepNoise = 0.42;
        perception.noise(controller.pos.x, controller.pos.z, 17, 0.6, 0.3);
      }
    }

    // UAV reward: ping live hostiles on the compass strip
    if (G.uavUntil > G.time) {
      G.uavTick -= dt;
      if (G.uavTick <= 0) {
        G.uavTick = 0.45;
        if (hud.uavPing) {
          for (const e of enemies) if (e.alive) hud.uavPing(e.root.position, engine.camera, 0.7);
        }
      }
      if (hud.setUav) hud.setUav(true, Math.max(0, G.uavUntil - G.time));
    } else if (G.uavUntil) {
      G.uavUntil = 0;
      if (hud.setUav) hud.setUav(false, 0);
    }
  }

  if (G.versusMode && G.state === 'dead' && playing === false) {
    updateZone(dt);
    if (net.role === 'host') updateVersusBots(dt);
  }

  // enemies
  const alive = G.hp > 0;
  enemyCtx.playerPos.copy(engine.camera.position);
  enemyCtx.playerGroundY = controller.pos.y;
  enemyCtx.playerAlive = alive && !(G.versusMode && G.versusGraceT > 0);
  enemyCtx.playerSpeed = controller.state.speed;
  // late-dodge window for the AI hit fairness recheck (enemy.shoot): fresh
  // while the player is moving fast enough that a hit behind cover is suspect
  enemyCtx.playerFastT = Math.max(0, (enemyCtx.playerFastT || 0) - dt);
  if (controller.state.speed > 3.3) enemyCtx.playerFastT = 0.15;
  // lateral movement direction (X / Z) feeds AI aim lead: a soldier aiming
  // at a sprinting player puts the muzzle where the target is going, not
  // where it is. We estimate the direction from the player-position delta
  // each frame so the value decays naturally when the player stops.
  {
    const px = engine.camera.position.x;
    const pz = engine.camera.position.z;
    const lastX = enemyCtx._lastPlayerX ?? px;
    const lastZ = enemyCtx._lastPlayerZ ?? pz;
    const dx = px - lastX;
    const dz = pz - lastZ;
    const dl = Math.hypot(dx, dz);
    if (dl > 0.04) {
      // smoothly blend toward the new direction so a single frame of jitter
      // does not flip the lead vector
      enemyCtx.playerDirX = (enemyCtx.playerDirX || 0) * 0.5 + (dx / dl) * 0.5;
      enemyCtx.playerDirZ = (enemyCtx.playerDirZ || 0) * 0.5 + (dz / dl) * 0.5;
    } else if (controller.state.speed < 0.08) {
      enemyCtx.playerDirX *= 0.7;
      enemyCtx.playerDirZ *= 0.7;
    }
    enemyCtx._lastPlayerX = px;
    enemyCtx._lastPlayerZ = pz;
  }
  // AI v2: tick the shared senses, then hand out squad roles once per 0.3 s
  if (net.role !== 'client') {
  if (perception) perception.update(dt);
  if (aiDirector && nav && !G.versusMode) {
    // In co-op the squad must plan around the TEAM, not around the host: a
    // flank planned around the host while the squad is actually fighting
    // another player produced nonsense routes.
    const anchor = (net.role === 'host' && net.remote.size) ? lanSquadCentroid() : controller.pos;
    aiDirector.tick(dt, enemies, anchor, G.diff, {
      // the player's facing — "left flank" has to mean the player's left
      x: -Math.sin(controller.yaw), z: -Math.cos(controller.yaw),
    });
  }
  // Versus: the grenade subsystem assumes one hostile faction and one player
  // target; both assumptions break, so it stays a co-op-only feature.
  if (equipment && !G.versusMode && !SHOT_MODE && !(net.role === 'host' && net.remote.size > 0)) {
    equipment.update(dt, {
      playerPos: controller.pos,
      playerSpeed: controller.state.speedMs,
      playerAlive: G.hp > 0,
      enemies,
      tier: G.diff,
    });
  }
  }
  if (G.flashA > 0) {
    G.flashA = Math.max(0, G.flashA - dt * 0.8);
    if (hud && hud.setFlash) hud.setFlash(G.flashA);
  }
  // The host owns the enemy simulation, so it publishes the local player's
  // state to the shared context BEFORE the soldiers tick — otherwise every
  // enemy reads last frame's position (and, on frame one, the origin).
  if (net.role === 'host') {
    enemyCtx.targetId = net.selfId || 'local';
    enemyCtx.playerPos.copy(controller.pos);
    enemyCtx.playerGroundY = controller.pos.y;
    enemyCtx.playerAlive = G.hp > 0;
    // metres per second — the AI reasons in m/s (hearing radius, hit falloff,
    // "is the player still?"). controller.state.speed is normalised 0..1.
    enemyCtx.playerSpeed = controller.state.speedMs;
    // the player's EYE height, so the AI can actually aim at a crouched head
    // and so cover can be tested against the real sight line.
    enemyCtx.playerEyeY = engine.camera.position.y;
    enemyCtx.playerFastT = Math.max(0, (enemyCtx.playerFastT || 0) - dt);
    if (controller.state.speedMs > 3.3) enemyCtx.playerFastT = 0.15;
  }

  for (const e of enemies) {
    if (!e.root.visible) continue;
    if (net.role === 'client' && e.netRemote) continue;
    if (net.role === 'host' && (net.remote.size || G.versusMode)) {
      // Versus: a bot targets the nearest hostile ACTOR (humans + enemy-team
      // bots). Co-op keeps the human-only selector; behaviour unchanged.
      const brain = G.versusMode && e.team != null ? teamBrains[e.team] : null;
      const tgt = G.versusMode
        ? nearestHostileActor(e.root.position, e.team, brain ? brain.priorityTargetId : null)
        : nearestLanTarget(e.root.position);
      // Who is pulling the trigger this frame — takeDamage uses it to filter
      // friendly fire between fill bots of the same team. It describes the
      // shooter, not the target, so it is set even when there is no target.
      enemyCtx.attackerTeam = e.team;
      if (!tgt) {
        // No legal target this frame (every hostile is down): hold fire and
        // keep the last aim point instead of shooting the air.
        enemyCtx.targetId = undefined;
        enemyCtx.playerAlive = false;
        e.lastTargetId = null;
        continue;
      }
      enemyCtx.targetId = tgt.id;
      enemyCtx.playerPos.set(tgt.x, tgt.y, tgt.z);
      enemyCtx.playerGroundY = tgt.y;
      enemyCtx.playerEyeY = tgt.eyeY != null ? tgt.eyeY : (tgt.y || 0) + 1.68;
      // versusOver: nobody is a legal target once the match is decided
      enemyCtx.playerAlive = tgt.alive && !G.versusOver;
      enemyCtx.playerSpeed = tgt.speed;
      // Remember the per-soldier target: the shared ctx above is overwritten
      // by the next soldier in this loop, so a probe cannot reconstruct
      // "who was aiming at whom" from it after the fact.
      e.lastTargetId = tgt.id;
    } else {
      // Solo / client: no per-frame retargeting. targetId MUST be cleared or
      // a stale peer id from an earlier LAN session would route damage away
      // from the local player.
      enemyCtx.targetId = undefined;
      enemyCtx.attackerTeam = undefined;
    }
    // Versus cover/intel: a bot must book cover with ITS faction's director —
    // the shared PvE director never ticks in versus, so reservations made
    // there leak forever and every cover point ends up ghost-owned.
    if (enemyCtx.ai) {
      enemyCtx.ai.director = (G.versusMode && e.team != null && teamDirectors[e.team])
        ? teamDirectors[e.team]
        : aiDirector;
    }
    if (G.freezeEnemies && SHOT_MODE) {
      // hold pose but keep sprite/lights alive
      e.weaponFlashT = Math.max(0, e.weaponFlashT - dt);
      e.weaponFlash.material.opacity = e.weaponFlashT > 0 ? 1 : 0;
      continue;
    }
    e.update(dt, enemyCtx);
    // soft-lock guard: an enemy inside geometry (or stranded far away with no
    // walkable line) is re-seated instead of standing there forever.
    if (e.alive) {
      const ep = e.root.position;
      const pdist = Math.hypot(ep.x - controller.pos.x, ep.z - controller.pos.z);
      if (!nav.isWalkableAt(ep.x, ep.z, ep.y)) {
        e._wallT = (e._wallT || 0) + dt;
        if (e._wallT > 0.4) { if (relocateEnemy(e)) e._wallT = 0; }
      } else {
        e._wallT = 0;
        const moved = Math.hypot(ep.x - (e._lastX ?? ep.x), ep.z - (e._lastZ ?? ep.z));
        const cutOff = !e.canSee && !nav.lineWalkable(ep.x, ep.z, controller.pos.x, controller.pos.z);
        // A soldier holding a conquest control point stands still on purpose —
        // that is not the "stuck" the soft-lock guard is looking for. Without
        // this exemption the guard picked the runner up and teleported it off
        // its own objective every 7 seconds, so no point was ever captured.
        if (cutOff && ep.y < 1.2 && !e.isBoss && e.archetype !== 'sniper' && pdist > 24 && moved < 0.03 && !e.objectivePoint) {
          e._stuckT = (e._stuckT || 0) + dt;
          if (e._stuckT > 7) { if (relocateEnemy(e)) e._stuckT = 0; }
        } else {
          e._stuckT = 0;
        }
      }
      e._lastX = ep.x; e._lastZ = ep.z;
    }
    // shadow LOD: far soldiers stop casting (each one is ~47 shadow draws)
    const dx = e.root.position.x - controller.pos.x;
    const dz = e.root.position.z - controller.pos.z;
    const castShadow = dx * dx + dz * dz < 26 * 26;
    if (e._shadowOn !== castShadow) {
      e._shadowOn = castShadow;
      e.root.traverse((o) => { if (o.isMesh) o.castShadow = castShadow; });
    }
    if (e.setDetailVisible) e.setDetailVisible(dx * dx + dz * dz < 24 * 24);
  }

  netTick(dt);

  // pickups / artillery / killstreak counter keep ticking through death so the
  // results beat does not freeze the world
  if (pickups) pickups.update(dt, engine.camera.position);
  updateHotDrop(dt);
  updateDropFx(dt);
  if (nav) nav.update(dt);
  if (artillery) artillery.update(dt);
  if (streakSys) {
    streakSys.update(dt);
    const st = streakSys.state;
    if (hud.setStreak) hud.setStreak(st.streak, st.nextAt);
  }

  // viewmodel
  viewmodel.update(dt, {
    speed: controller.state.speed,
    sprinting: controller.state.sprinting,
    ads: playing && input.mouse.right && !meleeOut,
    lookDX, lookDY,
    dead: G.state === 'dead',
  });
  viewmodel.camera.aspect = engine.camera.aspect;
  viewmodel.camera.updateProjectionMatrix();

  // interaction prompt (E)
  if (interact) interact.update(dt, controller.pos);
  if (intelSys) intelSys.update(dt, G.time);
  if (mothAlly) mothAlly.update(dt);

  // hud
  hud.setHeading(controller.headingDeg);
  hud.setSpread(spreadToPixels(playerSpread()), controller.adsAmount > 0.6);
  if (minimap) {
    minimapFeed(dt);
    const zoneState = G.versusMode
      ? (net.role === 'host' ? (zoneSys && zoneSys.state) : (netZoneMirror && netZoneMirror.state))
      : null;
    minimap.update(dt, {
      x: controller.pos.x, z: controller.pos.z,
      heading: controller.headingDeg,
      enemies,
      objective: G.objective,
      uav: G.uavUntil > G.time,
      time: G.time,
      pickups: minimapLootCache,
      allies: minimapAllyCache,
      zone: zoneState ? {
        x: zoneState.x, z: zoneState.z, r: zoneState.r,
        nextX: zoneState.nextX, nextZ: zoneState.nextZ, nextR: zoneState.nextR,
        shrinking: zoneState.shrinking, finished: zoneState.finished,
      } : null,
    });
  }
  if (worldLabels) {
    worldLabels.setVisible(playing && !HIDE_HUD && !SHOT_MODE);
    if (playing && !HIDE_HUD) worldLabels.update(dt, controller.pos);
  }
  hud.setReloadPrompt(playing && (G.mag === 0 || (G.mag <= Math.ceil(currentWeapon().magSize * 0.15) && G.reloadTimer < 0)) && G.reserve > 0);
  hud.setGrenades(G.grenades);
  hud.update(dt);
  updateWayfinder(dt, playing);

  updateSunOcclusion(dt);
  engine.update(dt, controller.pos, sunOccluded);
  level.update(dt, engine.camera);
  fx.update(dt);
  viewmodel.state.dead = G.state === 'dead';
  if (playing && !input.locked && !SHOT_MODE) {
    if (!G.lockHint) { hud.setHint('点击画面锁定鼠标'); G.lockHint = true; }
  } else if (G.lockHint) { hud.setHint(''); G.lockHint = false; }
  input.endFrame();
}

/* ------------------------------------------------------------------ boot */
boot();

// debug handle
window.__game = {
  get engine() { return engine; }, get level() { return level; }, get player() { return controller; },
  get nav() { return nav; }, get hotDrop() { return hotDrop; },
  switchWeapon: (i) => switchWeapon(i), fireWeapon: () => fireShot(),
  melee: () => knifeSlash(),
  get weaponIndex() { return G.weaponIndex; },
  // debug: what does a shot ray hit first (blockers included)
  debugRay: (ox, oy, oz, dx, dy, dz, max = 120) => {
    const rr = new THREE.Raycaster(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz).normalize(), 0, max);
    rr.firstHitOnly = true;
    const hits = rr.intersectObjects(level.bulletTargets, false);
    const h = hits.find((x) => x.object.visible || x.object.userData.enemy || x.object.userData.rayOnly);
    return h ? { d: +h.distance.toFixed(2), surface: h.object.userData.rayOnly ? 'world' : 'mesh', p: [+h.point.x.toFixed(1), +h.point.y.toFixed(1), +h.point.z.toFixed(1)] } : null;
  },
  get enemies() { return enemies; }, get state() { return G; }, get hud() { return hud; },
  get fx() { return fx; }, get viewmodel() { return viewmodel; }, get input() { return input; },
  get interact() { return interact; },
  get pickups() { return pickups; }, get streaks() { return streakSys; }, get artillery() { return artillery; },
  get leaderboard() { return leaderboard; }, get results() { return results; },
  get daily() { return loadDaily(); },
  get campaign() { return campaign; },
  get voice() { return voice; },
  get cinema() { return cinema; },
  get videoIntro() { return videoIntro; },
  get minimap() { return minimap; },
  get audio() { return audio; },
  get weather() { return weather; },
  get mothAlly() { return mothAlly; },
  get mothInfo() { return mothAlly && mothAlly.info; },
  get ai() { return { perception, director: aiDirector, barks }; },
  get equipment() { return equipment; },
  get barks() { return barks; },
  get net() { return net; }, get zoneSys() { return zoneSys; }, get zonePlanes() { return zonePlanes; }, get versusBots() { return versusBots; },
  get spawnDirector() { return spawnDirector; },
  /** Spawn reproducibility + audit: the session seed, and the last N wave
   *  plans with their distances and sectors. Lets a probe answer "how far
   *  away did wave N actually land?" instead of guessing. */
  get spawnSeed() { return SPAWN_SEED; },
  get spawnAudit() { return (G.spawnAudit || []).slice(); },
  /* Replay a wave from its recorded seed. The audit entry carries the
     inputs the plan depended on (player position, facing, burned zones),
     so the replay reproduces THAT wave rather than today's state — without
     them the plan drifts as soon as the player walks two metres. */
  spawnPlan: (mode, wave) => {
    const entry = (G.spawnAudit || []).slice().reverse()
      .find((e) => e.wave === wave && e.mode === mode);
    const rng = spawnRngFor(mode, wave);
    const zones = spawnDirector ? zonesWithinRect(spawnDirector.zones, G.playRect) : [];
    if (!zones.length) return [];
    const playerPos = entry && entry.player
      ? { x: entry.player.x, z: entry.player.z }
      : controller.pos;
    const facing = entry && Number.isFinite(entry.facing) ? entry.facing : controller.headingDeg;
    const recent = entry && entry.recentZones ? entry.recentZones.slice() : [];
    const base = { zones, playerPos, playerFacingDeg: facing, rng };
    if (mode === 'defend' && G.objective) {
      return spawnDirector.pickDefend({ ...base, objective: G.objective.zone, coverPoints: level.coverPoints, count: 3 });
    }
    if ((mode === 'extract' || mode === 'infil') && G.objective) {
      return spawnDirector.pickExtract({ ...base, extractZone: G.objective.zone, phase: 'fortify', count: 3 });
    }
    return spawnDirector.pickSurvival({ ...base, wave, recentZones: recent, count: 4 });
  },
  get lan() { return lanSession; },
  get lanLobby() { return lanLobby; },
  /** Per-faction squad brains (versus only) — lets a probe read the shared
      intel / focus-fire plan the host is running. */
  get teamBrains() { return teamBrains; },
  /** Conquest round state (points, owners, clock) — lets a probe verify that
      the 25-point round actually progresses instead of stalling on the clock. */
  get conquestState() { return conquestState(); },
  /** Which actor each live soldier is currently aiming at, keyed by the
      soldier's net id. The per-enemy target loop rewrites a single shared
      ctx every frame, so this snapshot is what the fight actually looked
      like that frame. */
  vsTargets: () => {
    const out = {};
    for (const e of enemies) {
      if (!e.alive || !e.root.visible) continue;
      if (e.team == null) continue;
      out[e._netId] = e.lastTargetId;
    }
    return out;
  },
  /** The conquest waypoint each soldier is currently carrying (or null). */
  vsObjectives: () => {
    const out = {};
    for (const b of versusBots) {
      if (!b.e || !b.e.alive) continue;
      out[b.e._netId] = b.e.objectivePoint
        ? { team: b.team, id: b.e.objectiveId, x: b.e.objectivePoint.x, z: b.e.objectivePoint.z }
        : null;
    }
    return out;
  },
  /** Raw per-point presence rows the conquest tick is fed with. */
  vsPresence: () => {
    try { return { rows: conquestPresence(), grace: G.versusGraceT, phase: conquest ? conquest.state.phase : null }; }
    catch (e) { return { error: String(e) }; }
  },
  /** The live control points and who owns them. */
  vsControlPoints: () => {
    const cs = conquest ? conquest.state : null;
    if (!cs) return null;
    return {
      phase: cs.phase, pts: cs.pts.slice(), t: cs.t, round: cs.round,
      points: cs.points.map((p) => ({ id: p.id, x: p.x, z: p.z, r: p.r, owner: p.owner, prog: p.prog, progTeam: p.progTeam })),
    };
  },
  startLanHostGame, startLanClientGame, leaveLanSession, applyLanFire,
  pressInteract: () => { if (interact) interact.press(); },
  aiStats: () => {
    const live = enemies.filter((e) => e.root.visible);
    return {
      roles: aiDirector ? aiDirector.roleCounts() : null,
      director: aiDirector ? { ...aiDirector.stats } : null,
      perception: perception ? perception.stats() : null,
      equipment: equipment ? equipment.stats() : null,
      barks: barks ? barks.count : null,
      // death attribution: "who killed me, from how far, doing what"
      lastDamage: G.lastDamage || null,
      deaths: (G.deathLog || []).slice(-10),
      enemies: live.map((e) => ({
        a: e.archetype, role: e.aiRole, state: e.state,
        awareness: +(e.awareness || 0).toFixed(2),
        see: !!e.canSee,
        settled: +(e.aimSettle || 0).toFixed(2),
        suppress: +(e.suppression || 0).toFixed(2),
        acquire: +(e.acquireT || 0).toFixed(2),
        react: +(e.reactionDelay || 0).toFixed(2),
        cover: e.coverPhase,
        hp: Math.round(e.hp),
      })),
    };
  },
  selectOperation: (id) => selectOperation(id),
  finishOperation: () => finishOperation(),
  renderOps: () => renderOps(),
  auditSpawns: () => ({
    ground: (level.spawnPoints || []).filter((p) => !nav.isWalkableAt(p.x, p.z, 0)).map((p) => [p.x, p.z]),
    roof: (level.roofSpawns || []).filter((p) => !nav.isWalkableAt(p.x, p.z, p.y)).map((p) => [p.x, p.z, p.y]),
  }),
  finishRun, playerDie,
  startGame, resetGame, spawnEnemy, applyPlayerDamage,
  openUpgradeChoice, pickUpgrade, openSettings, applySettings, finishTutorial,
  debugUpgrade: () => openUpgradeChoice(true), debugTutorial: () => beginTutorial(true),
  setSetting: (k, v) => onSettingChange(k, v), loadSettings, saveSettings, startWave, modeForWave,
  fire: () => { fireShot(); }, reload: () => reload(),
  pick: (nx = 0, ny = 0) => {
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), engine.camera);
    const hits = raycaster.intersectObjects(level.bulletTargets, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      point: h.point.toArray().map((v) => +v.toFixed(2)),
      dist: +h.distance.toFixed(2),
      mat: (h.object.userData.srcMat || h.object.material)?.color?.getHexString?.() || null,
      mt: (h.object.userData.srcMat || h.object.material)?.type || null,
      name: h.object.name || h.object.parent?.name || '',
    };
  },
  get fps() { return G.fps; },
};
