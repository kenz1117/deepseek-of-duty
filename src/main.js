import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createLevel } from './world/level.js';
import { createViewmodel } from './player/viewmodel.js';
import { createFX } from './fx/fx.js';
import { createAudio } from './core/audio.js';
import { createHUD } from './ui/hud.js';
import { createInput } from './core/input.js';
import { createController } from './player/controller.js';
import { Enemy } from './entities/enemy.js';
import { loadSettings, saveSettings, sanitizeSettings, tutorialDone, markTutorialDone, prestartSkipped, setPrestartSkipped, DEFAULT_SETTINGS } from './core/settings.js';
import { createRunStats, runPayload, recordRun, applyDailyProgress, loadDaily, dailySummary, dailyPerks, loadCallsign, saveCallsign, bestFor } from './core/profile.js';
import { createPickups } from './world/pickups.js';
import { createStreaks } from './systems/streaks.js';
import { createArtillery } from './systems/artillery.js';
import { createLeaderboard } from './net/leaderboard.js';
import { createNavGrid } from './systems/navgrid.js';
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
} from './story.js';

/* =========================================================================
   DEEPSEEK OF DUTY — browser vertical slice.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const SHOT_MODE = params.get('shot') === '1';
const CINE_MODE = params.get('cine') === '1';
const POSE = params.get('pose') || 'hero';
const HIDE_HUD = params.get('hidehud') === '1';

const WEAPONS = [
  {
    id: 'm4', name: 'M4A1', tag: 'PRIMARY <i></i> AR', magSize: 30, reserve: 180, dmg: 30, rpm: 720,
    auto: true, spread: 0.0125, adsSpread: 0.0016, recoil: 1.0, variant: 'black', mode: 'AUTO',
  },
  {
    // close-range: harder hitting + faster, but kicks more and needs a tighter burst
    id: 'mk18', name: 'MK18', tag: 'PRIMARY <i></i> CQB', magSize: 25, reserve: 125, dmg: 36, rpm: 850,
    auto: true, spread: 0.0175, adsSpread: 0.0026, recoil: 1.35, variant: 'tan', mode: 'AUTO',
  },
  {
    // pump shotgun: 8 pellets, shell-by-shell reload, placeholder viewmodel
    id: 'm870', name: 'M870', tag: 'PRIMARY <i></i> SG', magSize: 6, reserve: 30, dmg: 22, rpm: 75,
    auto: false, spread: 0.045, adsSpread: 0.035, recoil: 1.6, variant: 'wood', mode: 'PUMP',
    pellets: 8, shell: true,
    falloff: (d) => (d <= 4 ? 1 : Math.max(0.3, 1 - (d - 4) * 0.06)),
  },
];

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
let campaignActive = false;

const G = {
  state: 'loading',
  hp: 100, maxHp: 100, armor: 60, maxArmor: 60,
  score: 0, kills: 0, wave: 1, waveRemaining: 0, waveTotal: 0,
  spawnQueue: [], spawnTimer: 0, waveClearTimer: 0,
  time: 0, sinceDamage: 99,
  weaponIndex: 0, mag: 30, reserve: 180,
  weaponAmmo: [{ mag: 30, reserve: 180 }, { mag: 25, reserve: 150 }, { mag: 6, reserve: 30 }],
  lastWeapon: 1, switchT: 0, switchTo: 0, switchApplied: false, unlockedShotgun: false,
  fps: 60,
  reloadTimer: -1, reloadTransferred: false, reloadShells: 0,
  fireCooldown: 0, grenades: 2,
  firing: false, shotFired: false,
  recoilIndex: 0, lastShotAt: -1e9,
  tut: { reloads: 0, grenades: 0, swaps: 0, minimap: 0, interacts: 0, jumps: 0 },
  freezeEnemies: false, debugWaves: false, hitStop: 0, lockHint: false, debugAutoFire: false,
  readyFrames: 0, ready: false,
  hurtTimer: 0,
  settings: { ...DEFAULT_SETTINGS },
  upgrades: { damage: 1, fireRate: 1, mag: 1, speed: 0, regen: 1, grenades: 0, health: 0 },
  upgradeCards: [], upgradeShown: false,
  tutorial: { active: false, step: 0, t: 0, stepT: 0, done: false, lastX: 0, lastZ: 0 },
  shotsFired: 0, regenRate: 26, atmosphere: 'dusk',
  mode: 'survival', objective: null, operation: null, boss: null,
  // Sprint D: run counters, streak rewards, UAV window, score multiplier
  stats: null, scoreMult: 1, uavUntil: 0, uavTick: 0,
};

let engine, level, viewmodel, fx, audio, hud, input, controller, vmPass, nav, cinema, voice, videoIntro, minimap, interact, intelSys;
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
const _sunRay = new THREE.Raycaster();
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

const ATM_ORDER = ['dusk', 'noon', 'storm', 'bluehour'];

function magCap(w) {
  return Math.max(1, Math.round(w.magSize * G.upgrades.mag));
}

function applyAtmosphereForWave(n) {
  const key = ATM_ORDER[(Math.max(1, n) - 1) % ATM_ORDER.length];
  G.atmosphere = key;
  if (!engine || !engine.applyAtmosphere) return;
  const label = engine.applyAtmosphere(key);
  if (hud && hud.setAtmosphere) hud.setAtmosphere(label);
}

/* Difficulty ladder. The archetype table stays the baseline; every tier is a
   multiplier on top so a wave can be tuned without forking enemy behaviour. */
const DIFF_TIERS = [
  { id: 'D1', label: 'TRAINING', wave: 1, accuracy: 0.62, damage: 0.55, firstShot: 1.9, burst: 0.65, maxFiring: 2 },
  { id: 'D2', label: 'CONTACT', wave: 3, accuracy: 0.72, damage: 0.72, firstShot: 1.5, burst: 0.80, maxFiring: 2 },
  { id: 'D3', label: 'PRESSURE', wave: 5, accuracy: 0.85, damage: 0.85, firstShot: 1.3, burst: 0.90, maxFiring: 3 },
  { id: 'D4', label: 'VETERAN', wave: 8, accuracy: 1.00, damage: 1.00, firstShot: 1.1, burst: 1.00, maxFiring: 4 },
  { id: 'D5', label: 'ELITE', wave: 12, accuracy: 1.08, damage: 1.10, firstShot: 0.9, burst: 1.10, maxFiring: 5 },
];

function diffForWave(n) {
  let tier = DIFF_TIERS[0];
  for (const t of DIFF_TIERS) if (n >= t.wave) tier = t;
  return tier;
}

/* Global aggression budget: N soldiers may open fire in the same window.
   Without it four riflemen can start a burst on the same frame and delete
   the player before the first tracer is readable. */
const firingSlots = { max: 1, life: 1.15, at: [] };
function tryEnemyFire() {
  const now = performance.now() / 1000;
  while (firingSlots.at.length && now - firingSlots.at[0] > firingSlots.life) firingSlots.at.shift();
  if (firingSlots.at.length >= firingSlots.max) return false;
  firingSlots.at.push(now);
  return true;
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
  if (initial && engine) engine.setQuality(G.settings.quality);
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
  if (card.id === 'speed') controller.speedMult = 1 + G.upgrades.speed;
  if (card.id === 'regen') G.regenRate = 26 * G.upgrades.regen;
  G.upgradeCards = [];
  if (hud.hideUpgrades) hud.hideUpgrades();
  G.state = 'playing';
  if (audio && audio.ctx) audio.uiConfirm();
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
  { key: '1-3', text: '1 / 2 / 3 切换武器 · Q 切回', test: () => G.tut.swaps > 0 },
  { key: 'M', text: 'M 开关小地图', test: () => G.tut.minimap > 0 },
  { key: 'E', text: 'E 交互：破门 / 收集情报', test: () => G.tut.interacts > 0, timeout: 8 },
];

const MODE_BRIEFS = {
  campaign: {
    label: 'CAMPAIGN', title: '剧情推进', op: 'CAMPAIGN PROTOCOL',
    desc: '按 OP01 → OP10 推进战役：每关有独立简报、过场、目标与结局。选择任务后 START 部署，完成后可继续下一关。',
    threat: 'STORY', ao: 'URBAN', contact: '10 OPS',
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
      contact: `${op.waves} WAVES`,
      objectives: [
        op.mode === 'survival' ? `清空 ${op.waves} 波敌人` : '完成区域目标',
        `区域：${op.zoneLabel}`,
        op.bossWave ? '击杀敌方指挥官' : '活着完成任务',
      ],
      note: '',
    };
  }
  return MODE_BRIEFS[mode] || MODE_BRIEFS.campaign;
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

function launchGame() {
  closePrestart();
  G.tutorial.done = true;
  markTutorialDone();
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
  if (pref === 'campaign') return (G.operation && G.operation.mode) || 'survival';
  return pref || 'survival';
}

function chooseCampaignOperation() {
  const next = OPERATIONS.find((o) => isUnlocked(campaign, o.id) && !campaign.done.includes(o.id));
  if (next) return next;
  const sel = operationById(campaign.selected);
  if (sel && isUnlocked(campaign, sel.id)) return sel;
  return OPERATIONS[OPERATIONS.length - 1];
}

function onModeSelect(mode) {
  const valid = ['campaign', 'survival', 'defend', 'extract'];
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

function objectiveZone(kind) {
  const base = level && level.objectiveZones && level.objectiveZones[kind];
  // Objective remix: the zone moves between street / start / alley / interiors.
  const spots = kind === 'defend'
    ? [
        (base && typeof base.x === 'number') ? base : { x: 0, z: -16, r: 8.5 },
        { x: 0, z: 14, r: 8.0 },
        { x: -14, z: 2.5, r: 3.8 },
        { x: 0, z: 70, r: 8.0 },
        { x: 11.5, z: 68, r: 3.6 },
      ]
    : [
        (base && typeof base.x === 'number') ? base : { x: -19.2, z: 3.0, r: 3.5 },
        { x: -13.3, z: -2.5, r: 2.7 },
        { x: 13.3, z: -11.6, r: 3.0 },
        { x: 11.5, z: 68, r: 3.2 },
      ];
  const market = level && level.cqbZones && level.cqbZones.find((z) => /market|yard|后院|市场/.test((z.id || '') + (z.name || '')));
  if (market) spots.push({ x: market.center.x, z: market.center.z, r: Math.min(3.6, market.radius || 3.6) });
  const extra = level && level.objectiveZones;
  if (kind === 'defend' && extra && extra.backyard) spots.push(extra.backyard);
  const idx = kind === 'defend'
    ? Math.floor((G.wave || 1) / 3) % spots.length
    : Math.floor((G.wave || 1) / 5) % spots.length;
  return spots[idx];
}

function setupObjective(n) {
  const mode = modeForWave(n);
  G.mode = mode;
  G.objective = null;
  if (mode === 'survival') { hideObjectiveUI(); return; }
  const zone = (G.operation && G.operation.zone)
    ? { ...G.operation.zone }
    : objectiveZone(mode === 'defend' ? 'defend' : 'extract');
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

function pickSpawnPoint(pool, allowFlank, requirePath = true) {
  const p = controller.pos;
  const valid = validCandidates(pool, requirePath);
  if (!valid.length) {
    if (requirePath) return ringSpawn();
    const any = validCandidates(pool, false);
    return any.length ? any[Math.floor(Math.random() * any.length)] : ringSpawn();
  }
  let best = null, bestD = -1, mid = null, midD = -1, near = null, nearD = 1e9, flank = null, flankD = -1;
  const H = controller.headingDeg * Math.PI / 180;
  const fx = Math.sin(H), fz = -Math.cos(H);
  for (const sp of valid) {
    const dx = sp.x - p.x, dz = sp.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD) { bestD = d; best = sp; }
    // engagement band: close enough to arrive in ~10-20 s, far enough to not
    // pop in on top of the player (the old "always farthest" rule put waves
    // 120 m away once the dock opened)
    if (d >= 18 && d <= 45 && d > midD) { midD = d; mid = sp; }
    if (d > 10 && d < nearD) { nearD = d; near = sp; }
    if (d > 16 && d < 52) {
      const front = (dx * fx + dz * fz) / Math.max(1, d);
      if (front < -0.15 && d > flankD) { flankD = d; flank = sp; }
    }
  }
  if (allowFlank && flank && Math.random() < 0.34) return flank;
  return mid || near || best;
}

function pickZoneSpawn(pool, zone) {
  const near = pool.filter((p2) => {
    const d = Math.hypot(p2.x - zone.x, p2.z - zone.z);
    return d > 7 && d < 30;
  });
  const src = near.length ? near : pool;
  const valid = validCandidates(src, true);
  if (valid.length) return valid[Math.floor(Math.random() * valid.length)];
  return pickSpawnPoint(pool, false) || ringSpawn();
}

function spawnReinforcements(count) {
  if (!level || !level.spawnPoints || !level.spawnPoints.length) return;
  for (let i = 0; i < count; i++) {
    const allowed = level.spawnPoints.filter(isSpawnAllowed);
    const src = allowed.length ? allowed : level.spawnPoints;
    const best = pickSpawnPoint(src, true);
    if (!best) break;
    G.spawnQueue.push({ x: best.x, z: best.z, y: best.y || 0, type: chooseArchetype(G.wave, i) });
  }
  G.waveRemaining += count;
  G.waveTotal += count;
}

function onObjectiveDone() {
  const obj = G.objective;
  if (!obj || obj.done) return;
  obj.done = true;
  if (G.stats) G.stats.objectiveCleared = true;
  if (hud && hud.setHint) hud.setHint(obj.type === 'defend' ? 'ZONE SECURED' : 'EXTRACTED');
  if (audio && audio.ctx) audio.uiConfirm();
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
      }
    } else if (!obj.done && obj.inside) {
      obj.hold = Math.min(obj.need, obj.hold + dt);
      if (obj.hold >= obj.need) onObjectiveDone();
    }
  }

  if (hud && hud.setModeProgress) {
    const pct = obj.need ? obj.hold / obj.need : 0;
    let text;
    if (obj.done) text = obj.type === 'defend' ? 'ZONE SECURED' : 'EXTRACTED';
    else if (obj.type === 'defend') text = `${Math.ceil(obj.hold)} / ${obj.need}s · ${obj.inside ? 'HOLDING' : 'RETURN TO ZONE'}`;
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
    updateBriefing(G.settings.runMode);
    applySettings(true);
    raycaster = new THREE.Raycaster();
    raycaster.far = 160;
    // three-mesh-bvh stops at the first hit inside each merged world buffer
    raycaster.firstHitOnly = true;
    setupEnemyCtx();

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
      if (code === 'KeyF') viewmodel.inspect();
      if (code === 'KeyG') throwGrenade();
      if (code === 'KeyE' && interact) interact.press();
      if (code === 'Digit1') switchWeapon(0);
      if (code === 'Digit2') switchWeapon(1);
      if (code === 'Digit3') switchWeapon(2);
      if (code === 'KeyQ') switchWeapon(G.lastWeapon);
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
  }
  // a keyboard-activated START must never leave the board modal over the game
  closeBoardModal();
  if (results) results.hide();
  resetGame();
  // the mission is assigned after the reset, which clears the previous run
  G.operation = activeOperation();
  if (G.operation && G.operation.id === 10 && !mothAlly) spawnMoth();
  if (voice) voice.stop();
  if (G.settings && G.settings.primary === 'mk18') applyWeaponSwitch(1);
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  G.state = 'playing';
  const st = G.operation && G.operation.start;
  controller.revive(st ? st.x : 1.2, st ? st.z : 33);
  controller.setLook(st ? (st.yaw || 0) : -0.03, -0.015);
  if (!silent) audio.uiConfirm();
  startWave(1);
  if (!SHOT_MODE && !G.tutorial.done) beginTutorial();
  hudEl.classList.toggle('hidden', HIDE_HUD);
  const wantCine = G.operation && G.operation.intro && cinema && (!SHOT_MODE || CINE_MODE);
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
  G.boss = null;
  G.diff = DIFF_TIERS[0];
  firingSlots.max = G.diff.maxFiring;
  firingSlots.at.length = 0;
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
  hud.reset();
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
function startWave(n) {
  const prevTier = G.diff;
  G.diff = diffForWave(n);
  firingSlots.max = G.diff.maxFiring;
  firingSlots.at.length = 0;
  G.wave = n;
  G.upgradeShown = false;
  if (G.stats) G.stats.damagedThisWave = false;
  applyAtmosphereForWave(n);
  const op = G.operation;
  if (op) {
    if (op.atmosphere && engine && engine.applyAtmosphere) {
      const label = engine.applyAtmosphere(op.atmosphere);
      if (hud && hud.setAtmosphere) hud.setAtmosphere(label);
      G.atmosphere = op.atmosphere;
    }
    const lines = op.radio.filter((r) => r.at === n || (n === 1 && r.at === 'start'));
    if (hud.radio && !(n === 1 && op.intro)) {
      for (const line of lines) hud.radio(line.speaker, line.text, 7200, line.voice);
    }
    if (op.bossWave === n) {
      if (op.bossIntro && cinema && (!SHOT_MODE || CINE_MODE)) {
        G.state = 'cinema';
        hudEl.classList.add('hidden');
        viewmodel.root.visible = false;
        cinema.play(op.bossIntro, () => {
          spawnBoss(op);
          G.state = 'playing';
          viewmodel.root.visible = true;
          hudEl.classList.toggle('hidden', HIDE_HUD);
        });
      } else {
        spawnBoss(op);
      }
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
  const total = Math.min(11, 3 + n);
  G.waveTotal = total;
  G.waveRemaining = total;
  G.spawnQueue = [];
  const playerPos = controller.pos;
  let allowedSpawns = level.spawnPoints.filter(isSpawnAllowed);
  const sr = G.operation && G.operation.spawnRect;
  if (sr) {
    const inside = allowedSpawns.filter((p) => p.x >= sr.x0 && p.x <= sr.x1 && p.z >= sr.z0 && p.z <= sr.z1);
    if (inside.length >= 2) allowedSpawns = inside;
  }
  const pool = (allowedSpawns.length ? allowedSpawns : level.spawnPoints).slice();
  const objZone = G.objective ? G.objective.zone : null;
  const sealed = !!(op && op.spawnRect);
  for (let i = 0; i < total; i++) {
    let best = null;
    if (objZone) best = pickZoneSpawn(pool, objZone);
    else best = pickSpawnPoint(pool, n >= 2, !sealed);
    if (!best) continue;
    let sx = best.x, sz = best.z, sy = best.y || 0;
    for (let t = 0; t < 5; t++) {
      const a = Math.random() * Math.PI * 2, r = 0.9 + Math.random() * 1.3;
      const cand = resolveSpawn(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r, sy);
      if (cand && (sealed || spawnReachesPlayer(cand))) { sx = cand.x; sz = cand.z; sy = cand.y || sy; break; }
    }
    G.spawnQueue.push({ x: sx, z: sz, y: sy, type: chooseArchetype(n, i) });
  }
  const roofSpawns = level.roofSpawns || [];
  if (roofSpawns.length && n >= 6) {
    const count = Math.min(2, 1 + Math.floor((n - 6) / 3));
    for (let i = 0; i < count; i++) {
      const sp = roofSpawns[(n + i) % roofSpawns.length];
      G.spawnQueue.unshift({ x: sp.x, z: sp.z, y: sp.y, type: 'sniper', roof: true });
    }
    G.waveRemaining += count;
    G.waveTotal += count;
  }
  G.spawnTimer = 0.8;
  G.waveClearTimer = 0;
  hud.setWave(n);
  hud.setWaveProgress(0);
  hud.setObjective(`清剿残敌 · 剩余 ${total}`);
  hud.setHint('WAVE ' + n + (G.mode === 'defend' ? ' · DEFEND' : G.mode === 'extract' ? ' · EXTRACT' : ''));
  setTimeout(() => hud.setHint(''), 1400);
  if (n >= 3 && n % 3 === 0) spawnHotDrop(n);
}

/* ------------------------------------------------------- hot supply drop */
/* Every 3rd wave a marked supply crate lands somewhere on the map. The light
   column is readable from anywhere, so it gives the bigger map a reason to
   rotate instead of holding one angle. Enemies are not scripted to contest it
   (they path to the player); it is a player-facing risk/reward beat. */
const HOT_DROP_ZONES = [
  { x: 0, z: 30, label: '街区南段' },
  { x: -4, z: 6, label: '街区中段' },
  { x: 20.8, z: -10.7, label: '后院市场' },
  { x: 0, z: 70, label: '南院车场' },
  { x: 11.5, z: 68, label: '车库' },
];
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
  const zones = HOT_DROP_ZONES.filter((z) => {
    const p = nav && nav.closestWalkable(z.x, z.z);
    return !!p;
  });
  const zone = zones.length ? zones[(Math.random() * zones.length) | 0] : HOT_DROP_ZONES[0];
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
      G.score += 200;
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
  // second choice: re-insert at a reachable ring around the player
  const sp = ringSpawn(12, 26);
  if (sp) {
    p.set(sp.x, sp.y || 0, sp.z);
    e.path = null; e.pathI = 0; e.pathTimer = 0; e.navTarget.x = NaN;
    return true;
  }
  return false;
}

function spawnEnemy(pos) {
  let e = enemies.find((x) => !x.alive && x.root.visible === false) || enemies.find((x) => !x.alive);
  if (!e) {
    if (enemies.length >= 14) return;
    e = new Enemy(engine.scene, engine.mats, level.colliders);
    enemies.push(e);
  }
  const playerPos = controller.pos;
  let sp = resolveSpawn(pos.x, pos.z, pos.y || 0);
  const sealed = !!(G.operation && G.operation.spawnRect);
  if (!sp) sp = ringSpawn() || { x: pos.x, z: pos.z, y: pos.y || 0 };
  else if (!sealed && sp.y <= 1 && !spawnReachesPlayer(sp)) sp = ringSpawn() || sp;
  const yaw = Math.atan2(-(playerPos.x - sp.x), -(playerPos.z - sp.z));
  if (e.setArchetype) e.setArchetype(pos.type || 'rifleman');
  if (e.clearBounds) e.clearBounds();
  e.spawn(sp.x, sp.z, yaw, sp.y || 0);
  if (e.setDifficulty) e.setDifficulty(G.diff);
  if (e.setOccluders && level.roofZones) e.setOccluders(level.roofZones);
  if ((pos.y || 0) > 1 && e.setBounds && level.roofZones) {
    const zone = level.roofZones.find((r) => pos.x >= r.x0 && pos.x <= r.x1 && pos.z >= r.z0 && pos.z <= r.z1);
    if (zone) e.setBounds(zone);
  }
  e.root.visible = true;
  if (SHOT_MODE) e.state = 'engage';
}

function updateWaves(dt) {
  if (SHOT_MODE && !G.debugWaves) return;
  if (G.spawnQueue.length > 0) {
    G.spawnTimer -= dt;
    const alive = enemies.filter((e) => e.alive).length;
    if (G.spawnTimer <= 0 && alive < 6) {
      const p = G.spawnQueue.shift();
      spawnEnemy(p);
      G.spawnTimer = 0.75 + Math.random() * 0.6;
    }
  }
  const alive = enemies.filter((e) => e.alive).length;
  if (G.waveRemaining <= 0 && G.spawnQueue.length === 0 && alive === 0) {
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
    }
    if (G.waveClearTimer === 0) {
      G.waveClearTimer = 0.001;
      hud.setHint('WAVE CLEARED');
      G.score += Math.round(250 * G.scoreMult);
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
      if (G.operation && G.wave >= G.operation.waves) { finishOperation(); return; }
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
    return { name: w.name, mag: a.mag, reserve: a.reserve, active: idx === G.weaponIndex, locked: idx === 2 && !G.unlockedShotgun };
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
  const spread = playerSpread();
  const pellets = w.pellets || 1;
  const targets = level.bulletTargets.slice();
  for (const e of enemies) if (e.alive) targets.push(...e.hitboxes);
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
        if (enemy && enemy.alive) {
          const part = hit.object.userData.part;
          const mult = hit.object.userData.dmg || 1;
          const headshot = part === 'head';
          const falloff = w.falloff ? w.falloff(hit.distance) : 1;
          const killed = enemy.takeDamage(w.dmg * falloff * G.upgrades.damage * mult, hit.point, _normal, part);
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
  fx.tracer(mz, _endFirst, { color: 0xffce8f, width: 0.028, life: 0.055 });
  if (G.mag === 0 && G.reserve > 0) setTimeout(() => { if (G.state === 'playing') reload(); }, 160);
}

function tryFire(dt) {
  const w = currentWeapon();
  G.fireCooldown -= dt;
  if (G.switchT > 0) { G.firing = false; return; }
  const wantFire = (input.mouse.left && input.locked && G.state === 'playing') || G.debugAutoFire;
  G.firing = wantFire;
  const trigger = w.auto ? wantFire : (input.mouse.leftPressed && input.locked);
  if (!trigger || G.fireCooldown > 0 || G.reloadTimer >= 0) return;
  if (G.mag <= 0) {
    if (G.reserve > 0) reload();
    return;
  }
  G.fireCooldown = 60 / (w.rpm * G.upgrades.fireRate);
  G.shotFired = true;
  fireShot();
}

function spawnBoss(op) {
  if (!level || !controller) return;
  const p = controller.pos;
  const bs = op.bossSpawn;
  const zx = bs ? bs.x : p.x + (Math.random() < 0.5 ? -6 : 6);
  const zz = bs ? bs.z : p.z - 16;
  spawnEnemy({ x: zx, z: zz, type: 'shield' });
  const e = enemies[enemies.length - 1];
  if (!e || !e.alive) return;
  e.isBoss = true;
  e.maxHp = op.bossHp || 560;
  e.hp = e.maxHp;
  e.root.scale.setScalar(op.bossScale || 1.16);
  G.boss = e;
  if (hud) {
    hud.toast(`${op.bossName || '指挥官'} · 重甲`, 2600);
    hud.setObjective(`击杀 ${op.bossName || '敌方指挥官'}`);
  }
  if (hud && hud.radio) hud.radio('VEGA', op.radio.find((r) => r.at === op.bossWave)?.text || '指挥官下车了。', 5600);
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
  renderOps();
  if (op.outro && cinema && (!SHOT_MODE || CINE_MODE)) {
    G.state = 'cinema';
    hudEl.classList.add('hidden');
    viewmodel.root.visible = false;
    const playEnding = () => cinema.play(op.outro, () => {
      hudEl.classList.remove('hidden');
      viewmodel.root.visible = true;
      showMissionOverlay(op);
    });
    if (videoIntro) videoIntro.play('/media/ending.mp4', playEnding);
    else playEnding();
    return;
  }
  showMissionOverlay(op);
}

function closeMissionOverlay() {
  const overlay = document.getElementById('mission');
  overlay?.classList.add('hidden');
  overlay?.setAttribute('aria-hidden', 'true');
}

function returnToMenu() {
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

function onEnemyKilled(enemy, headshot, cause = 'bullet') {
  G.kills++;
  G.waveRemaining = Math.max(0, G.waveRemaining - 1);
  G.score += Math.round((headshot ? 150 : 100) * G.scoreMult);
  hud.setScore(G.score, G.kills);
  hud.addKillFeed(headshot ? 'HOSTILE' : 'INSURGENT', headshot, currentWeapon().name);
  G.hitStop = 0.055;
  audio.killConfirm();
  if (G.stats) {
    G.stats.kills++;
    if (headshot) G.stats.headshots++;
    if (cause === 'grenade') G.stats.grenadeKills++;
  }
  if (enemy && enemy.isBoss) {
    G.score += Math.round(1500 * G.scoreMult);
    hud.setScore(G.score, G.kills);
    hud.toast('指挥官击毙 · +1500', 2400);
    if (hud.radio) hud.radio('VEGA', '指挥官倒了。车队失去指挥，正在撤离。', 5200);
    G.boss = null;
  }
  // killstreak kills must not feed the next streak (CoD rule) or artillery chains forever
  if (streakSys && cause !== 'artillery') streakSys.notifyKill({ headshot, cause });

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
    if (roll < 0.12) pickups.spawn('ammo', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.18) pickups.spawn('armor', pos.x + ox, pos.y, pos.z + oz);
    else if (roll < 0.22) pickups.spawn('grenade', pos.x + ox, pos.y, pos.z + oz);
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
  grenades.push({ mesh, vel, fuse: 2.4, t: 0 });
  audio.reload('bolt');
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
      fx.explosion(g.mesh.position.clone(), 1.0);
      audio.explosion(0, g.mesh.position.distanceTo(engine.camera.position));
      controller.addShake(0.85);
      const dist = g.mesh.position.distanceTo(engine.camera.position);
      if (dist < 7) applyPlayerDamage(Math.max(10, 85 * (1 - dist / 7)), g.mesh.position);
      for (const e of enemies) {
        if (!e.alive) continue;
        const d = e.root.position.distanceTo(g.mesh.position);
        if (d < 7.5) {
          const died = e.takeDamage(180 * (1 - d / 7.5), g.mesh.position, new THREE.Vector3(0, 1, 0), 'torso');
          if (died) onEnemyKilled(e, false, 'grenade');
        }
      }
      engine.scene.remove(g.mesh);
      geoDispose(g.mesh);
      grenades.splice(i, 1);
    }
  }
}
function geoDispose(m) { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }

/* ------------------------------------------------------------------ damage */
function applyPlayerDamage(amount, fromPos) {
  if (G.state !== 'playing' || G.hp <= 0) return;
  if (SHOT_MODE) return;
  if (G.stats) G.stats.damagedThisWave = true;
  G.sinceDamage = 0;
  G.hurtTimer = 0.3;
  let dmg = amount;
  if (G.armor > 0) {
    const absorbed = Math.min(G.armor, dmg * 0.6);
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
const PICKUP_LABEL = { ammo: '+90 弹药', armor: '+25 护甲', grenade: '+1 手雷', supply: '战地补给' };

function onPickupCollected(kind, amount) {
  const num = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const ammo = num(kind === 'supply' && amount && amount.ammo, num(amount, 90));
  const armor = num(kind === 'supply' && amount && amount.armor, num(amount, 25));
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
    G.uavUntil = G.time + 12;
    G.uavTick = 0;
    if (hud.setUav) hud.setUav(true, 12);
    if (hud.setStreakReward) hud.setStreakReward('UAV ONLINE');
    audio.uiConfirm();
  } else if (id === 'artillery') {
    artillery.strike(aimPoint(40), { shells: 7, radius: 10, spread: 7 });
    if (hud.setStreakReward) hud.setStreakReward('ARTILLERY');
  }
}

/** called by the artillery module per shell impact */
function artilleryDamageAt(point, radius, dmg) {
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.root.position.distanceTo(point);
    if (d < radius) {
      const died = e.takeDamage(dmg * (1 - (d / radius) * 0.35), point, _up, 'torso');
      if (died) onEnemyKilled(e, false, 'artillery');
    }
  }
  const pd = point.distanceTo(engine.camera.position);
  if (pd < radius * 0.8) applyPlayerDamage(Math.max(6, 55 * (1 - pd / (radius * 0.8))), point);
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
  const s = G.stats;
  if (!s) return;
  if (!s.score) s.score = G.score;
  s.objectiveWins = s.objectiveCleared ? 1 : 0;
  const daily = loadDaily();
  const { state: dstate } = applyDailyProgress(daily, s);
  const summary = dailySummary(dstate);
  const payload = runPayload(s, { score: G.score, wave: G.wave, challengesDone: summary.done });
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
  finishRun();
  setTimeout(() => deathEl.classList.remove('hidden'), 900);
}

/* ------------------------------------------------------------------ enemy ctx */
const enemyCtx = {
  playerPos: new THREE.Vector3(),
  playerAlive: true,
  playerSpeed: 0,
  fx: null, audio: null, camera: null,
  coverPoints: [],
  damagePlayer: (amount, from) => applyPlayerDamage(amount, from),
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
  enemyCtx.panFor = (pos) => {
    const cam = engine.camera;
    const dx = pos.x - cam.position.x, dz = pos.z - cam.position.z;
    const len = Math.hypot(dx, dz) || 1;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    return THREE.MathUtils.clamp((dx / len) * _right.x + (dz / len) * _right.z, -1, 1);
  };
  enemyCtx.onEnemyFire = (pos) => {
    hud.ping(pos, engine.camera, 1.4);
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
function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
  lastTime = now;
  let dt = rawDt;
  if (rawDt > 0.0001) G.fps = G.fps * 0.94 + (1 / rawDt) * 0.06;
  if (G.hitStop > 0) {
    G.hitStop = Math.max(0, G.hitStop - rawDt);
    dt = rawDt * 0.22;
  }

  if (G.state === 'playing' || G.state === 'dead') {
    updateGame(dt);
  } else if (G.state === 'menu') {
    updateMenuCamera(dt);
  } else if (G.state === 'upgrade') {
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
    engine.update(dt, controller.pos);
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

function updateGame(dt) {
  G.time += dt;
  const playing = G.state === 'playing';
  const lookDX = playing ? input.mouse.dx : 0;
  const lookDY = playing ? input.mouse.dy : 0;

  const jumpNow = playing && input.pressedOnce('Space');
  controller.update(dt, playing ? input : null, {
    ads: playing && input.mouse.right,
    sprinting: playing && input.down('ShiftLeft'),
    crouching: playing && (input.down('ControlLeft') || input.down('KeyC')),
    jump: jumpNow,
  });
  if (jumpNow) G.tut.jumps++;

  if (playing) {
    updateWeaponSwap(dt);
    tryFire(dt);
    updateReload(dt);
    updateGrenades(dt);

    // health regen
    G.sinceDamage += dt;
    if (G.sinceDamage > 4.2 && G.hp < G.maxHp) {
      G.hp = Math.min(G.maxHp, G.hp + G.regenRate * dt);
      hud.setHealth(G.hp, pipsFor(G.armor));
      if (G.hp > 40) audio.setLowHealth(false);
    }
    updateObjective(dt);
    updateWaves(dt);
    updateTutorial(dt);
    updateBeacon(dt);

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

  // enemies
  const alive = G.hp > 0;
  enemyCtx.playerPos.copy(engine.camera.position);
  enemyCtx.playerGroundY = controller.pos.y;
  enemyCtx.playerAlive = alive;
  enemyCtx.playerSpeed = controller.state.speed;
  for (const e of enemies) {
    if (!e.root.visible) continue;
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
        if (cutOff && ep.y < 1.2 && !e.isBoss && e.archetype !== 'sniper' && pdist > 24 && moved < 0.03) {
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
    ads: playing && input.mouse.right,
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
    minimap.update(dt, {
      x: controller.pos.x, z: controller.pos.z,
      heading: controller.headingDeg,
      enemies,
      objective: G.objective,
      uav: G.uavUntil > G.time,
      time: G.time,
    });
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
  get pickups() { return pickups; }, get streaks() { return streakSys; }, get artillery() { return artillery; },
  get leaderboard() { return leaderboard; }, get results() { return results; },
  get daily() { return loadDaily(); },
  get campaign() { return campaign; },
  get voice() { return voice; },
  get cinema() { return cinema; },
  get videoIntro() { return videoIntro; },
  get minimap() { return minimap; },
  get audio() { return audio; },
  get mothAlly() { return mothAlly; },
  get mothInfo() { return mothAlly && mothAlly.info; },
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
