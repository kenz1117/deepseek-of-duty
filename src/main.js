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
import { createResults, renderDailyList, renderMenuBoard } from './ui/results.js';

/* =========================================================================
   DEEPSEEK OF DUTY — browser vertical slice.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const SHOT_MODE = params.get('shot') === '1';
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
  freezeEnemies: false, debugWaves: false, hitStop: 0, lockHint: false, debugAutoFire: false,
  readyFrames: 0, ready: false,
  hurtTimer: 0,
  settings: { ...DEFAULT_SETTINGS },
  upgrades: { damage: 1, fireRate: 1, mag: 1, speed: 0, regen: 1, grenades: 0, health: 0 },
  upgradeCards: [], upgradeShown: false,
  tutorial: { active: false, step: 0, t: 0, stepT: 0, done: false, lastX: 0, lastZ: 0 },
  shotsFired: 0, regenRate: 26, atmosphere: 'dusk',
  mode: 'survival', objective: null,
  // Sprint D: run counters, streak rewards, UAV window, score multiplier
  stats: null, scoreMult: 1, uavUntil: 0, uavTick: 0,
};

let engine, level, viewmodel, fx, audio, hud, input, controller, vmPass, nav;
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

function chooseArchetype(wave, index) {
  const r = Math.random();
  if (wave <= 2) return 'rifleman';
  if (wave <= 4) return r < 0.30 ? 'rusher' : 'rifleman';
  if (wave <= 6) {
    if (r < 0.16) return 'shield';
    if (r < 0.38) return 'rusher';
    if (r < 0.50) return 'sniper';
    return 'rifleman';
  }
  if (r < 0.28) return 'rusher';
  if (r < 0.44) return 'shield';
  if (r < 0.58) return 'sniper';
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
  { text: 'WASD 移动 · SHIFT 冲刺', key: 'WASD' },
  { text: '鼠标左键射击', key: 'LMB' },
  { text: '鼠标右键瞄准（按住）', key: 'RMB' },
  { text: 'R 换弹 · G 手雷', key: 'R / G' },
];

const MODE_BRIEFS = {
  rotation: {
    label: 'ROTATION', title: '标准轮换', op: 'ROTATION PROTOCOL',
    desc: '每 3 波进入防守，每 5 波进入撤离；其余为生存波次。目标区会在街区、后院、市场与南院车场之间轮换。',
    threat: 'HIGH', ao: 'URBAN', contact: '∞',
    objectives: ['生存波：清空所有敌人', '防守波：在目标区累计守住 60 秒', '撤离波：清空区域后进入撤离区按住 8 秒'],
    note: '敌军以波次持续增援，没有撤离窗口。保持移动，利用掩体，清空街区。',
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
function updateBriefing(mode = G.settings.runMode) {
  const b = MODE_BRIEFS[mode] || MODE_BRIEFS.rotation;
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
  const b = MODE_BRIEFS[mode] || MODE_BRIEFS.rotation;
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
  const moved = Math.hypot(controller.pos.x - t.lastX, controller.pos.z - t.lastZ);
  let done = t.stepT > 5.0;
  if (t.step === 0 && moved > 3) done = true;
  if (t.step === 1 && G.shotsFired >= 3) done = true;
  if (t.step === 2 && controller.adsAmount > 0.6) done = true;
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
  if (pref && pref !== 'rotation') return pref;
  if (n % 5 === 0) return 'extract';
  if (n % 3 === 0) return 'defend';
  return 'survival';
}

function onModeSelect(mode) {
  const valid = ['rotation', 'survival', 'defend', 'extract'];
  G.settings.runMode = valid.includes(mode) ? mode : 'rotation';
  saveSettings(G.settings);
  if (hud && hud.setModeSelect) hud.setModeSelect(G.settings.runMode);
  updateBriefing(G.settings.runMode);
  refreshMenuBoard(true);
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
  const zone = objectiveZone(mode === 'defend' ? 'defend' : 'extract');
  G.objective = {
    type: mode,
    zone,
    need: mode === 'defend' ? 60 : 8,
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
function pickSpawnPoint(pool, allowFlank) {
  const p = controller.pos;
  let best = null, bestD = -1, flank = null, flankD = -1;
  const H = controller.headingDeg * Math.PI / 180;
  const fx = Math.sin(H), fz = -Math.cos(H);   // camera facing on the ground plane
  for (let k = 0; k < 6; k++) {
    const sp = pool[Math.floor(Math.random() * pool.length)];
    const dx = sp.x - p.x, dz = sp.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD) { bestD = d; best = sp; }
    if (d > 16 && d < 52) {
      const front = (dx * fx + dz * fz) / Math.max(1, d);
      if (front < -0.15 && d > flankD) { flankD = d; flank = sp; }
    }
  }
  if (allowFlank && flank && Math.random() < 0.34) return flank;
  return best;
}

function spawnReinforcements(count) {
  if (!level || !level.spawnPoints || !level.spawnPoints.length) return;
  for (let i = 0; i < count; i++) {
    const allowed = level.spawnPoints.filter(isSpawnAllowed);
    const src = allowed.length ? allowed : level.spawnPoints;
    const best = pickSpawnPoint(src, true);
    if (!best) break;
    G.spawnQueue.push({
      x: best.x + (Math.random() - 0.5) * 1.4,
      z: best.z + (Math.random() - 0.5) * 1.4,
      type: chooseArchetype(G.wave, i),
    });
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
    G.tutorial.done = tutorialDone();
    engine = createEngine(document.getElementById('gl'), G.settings.quality);
    setLoading(0.34, '生成程序化 PBR 材质与大气…');
    await nextFrame();

    level = createLevel(engine);
    nav = createNavGrid(level, { cell: 0.8, radius: 0.32, groundAt: (x, z, y) => level.groundHeight(x, z, y), links: level.navLinks });
    setLoading(0.58, '构建战区街区…');
    await nextFrame();

    viewmodel = createViewmodel(engine.mats, engine.sky.envTexture);
    setLoading(0.72, '装配武器与手部动画…');
    await nextFrame();

    fx = createFX(engine.scene, engine.mats);
    audio = createAudio();
    hud = createHUD();
    input = createInput(engine.renderer.domElement);
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
    updateBriefing(G.settings.runMode);
    applySettings(true);
    raycaster = new THREE.Raycaster();
    raycaster.far = 160;
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
      openPrestart();
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
      if (code === 'Escape') {
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
      if (code === 'Digit1') switchWeapon(0);
      if (code === 'Digit2') switchWeapon(1);
      if (code === 'Digit3') switchWeapon(2);
      if (code === 'KeyQ') switchWeapon(G.lastWeapon);
      if (code === 'KeyP') { G.state = 'paused'; pauseEl.classList.remove('hidden'); input.unlock(); }
    });
    engine.renderer.domElement.addEventListener('click', () => {
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
  audio.setMasterVolume(0.58);
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

function startGame(lock = true, silent = false) {
  closePrestart();
  if (results) results.hide();
  resetGame();
  if (G.settings && G.settings.primary === 'mk18') applyWeaponSwitch(1);
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  G.state = 'playing';
  controller.revive(1.2, 33);
  controller.setLook(-0.03, -0.015);
  if (!silent) audio.uiConfirm();
  if (lock) input.lock();
  startWave(1);
  if (!SHOT_MODE && !G.tutorial.done) beginTutorial();
  hudEl.classList.toggle('hidden', HIDE_HUD);
  if (!SHOT_MODE) {
    const hint = document.getElementById('hint');
    hint.textContent = '';
  }
}

function resetGame() {
  const perks = dailyPerks();
  G.maxHp = 100;
  G.maxArmor = 60 + perks.armor;
  G.scoreMult = perks.scoreMult;
  G.stats = createRunStats(G.settings.runMode);
  G.upgrades = { damage: 1, fireRate: 1, mag: 1, speed: 0, regen: 1, grenades: 0, health: 0 };
  G.regenRate = 26;
  G.shotsFired = 0;
  G.upgradeShown = false;
  G.upgradeCards = [];
  G.mode = 'survival';
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
  G.wave = n;
  G.upgradeShown = false;
  if (G.stats) G.stats.damagedThisWave = false;
  applyAtmosphereForWave(n);
  setupObjective(n);
  if (n >= 3 && !G.unlockedShotgun) {
    G.unlockedShotgun = true;
    if (hud.toast) hud.toast('M870 已解锁 · 按 3 装备');
  }
  const total = Math.min(11, 3 + n);
  G.waveTotal = total;
  G.waveRemaining = total;
  G.spawnQueue = [];
  const playerPos = controller.pos;
  const allowedSpawns = level.spawnPoints.filter(isSpawnAllowed);
  const pool = (allowedSpawns.length ? allowedSpawns : level.spawnPoints).slice();
  const objZone = G.objective ? G.objective.zone : null;
  for (let i = 0; i < total; i++) {
    let best = null;
    if (objZone) {
      // objective modes: spawn 7-30 m around the zone so pressure arrives
      const near = pool.filter((p) => {
        const d = Math.hypot(p.x - objZone.x, p.z - objZone.z);
        return d > 7 && d < 30;
      });
      const src = near.length ? near : pool;
      best = src[Math.floor(Math.random() * src.length)];
    } else {
      // survival: far spawns, but ~1/3 arrive on the flank or from behind
      best = pickSpawnPoint(pool, n >= 2);
    }
    G.spawnQueue.push({ x: best.x + (Math.random() - 0.5) * 2.2, z: best.z + (Math.random() - 0.5) * 2.2, type: chooseArchetype(n, i) });
  }
  const roofSpawns = level.roofSpawns || [];
  if (roofSpawns.length && n >= 3) {
    const count = Math.min(2, 1 + Math.floor((n - 3) / 3));
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

function spawnEnemy(pos) {
  let e = enemies.find((x) => !x.alive && x.root.visible === false) || enemies.find((x) => !x.alive);
  if (!e) {
    if (enemies.length >= 14) return;
    e = new Enemy(engine.scene, engine.mats, level.colliders);
    enemies.push(e);
  }
  const playerPos = controller.pos;
  const yaw = Math.atan2(-(playerPos.x - pos.x), -(playerPos.z - pos.z));
  if (e.setArchetype) e.setArchetype(pos.type || 'rifleman');
  if (e.clearBounds) e.clearBounds();
  e.spawn(pos.x, pos.z, yaw, pos.y || 0);
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
      openUpgradeChoice();
    }
  }
  hud.setWaveProgress(1 - G.waveRemaining / Math.max(1, G.waveTotal));
  const roofAlive = enemies.filter((e) => e.alive && e.baseY > 1).length;
  if (roofAlive > 0 && alive === roofAlive) {
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
  controller.kick(0.72 * w.recoil + Math.random() * 0.16, (Math.random() - 0.5) * 0.30 * w.recoil);
  controller.addShake(0.09);
  const moving = controller.state.speed;
  const ads = controller.adsAmount;
  const spread = (ads > 0.5 ? w.adsSpread : w.spread) * (1 + moving * 1.4) * (1 - ads * 0.65);
  const pellets = w.pellets || 1;
  const targets = level.bulletTargets.slice();
  for (const e of enemies) if (e.alive) targets.push(...e.hitboxes);
  const baseDir = _dir;
  engine.camera.getWorldDirection(baseDir);
  _right.set(1, 0, 0).applyQuaternion(engine.camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(engine.camera.quaternion);
  let effects = 0;
  let hitMarked = false;
  for (let p = 0; p < pellets; p++) {
    // pellets spread inside a cone; the first one keeps the base direction
    const cone = pellets > 1 ? spread * 1.45 : spread;
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * cone;
    _dir.copy(baseDir)
      .addScaledVector(_right, Math.cos(ang) * rad)
      .addScaledVector(_up, Math.sin(ang) * rad)
      .normalize();
    raycaster.set(engine.camera.position, _dir);
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.object.visible || h.object.userData.enemy);
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
          const mat = hit.object.material;
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
  const next = tab === 'daily' ? tab : 'board';
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

  controller.update(dt, playing ? input : null, {
    ads: playing && input.mouse.right,
    sprinting: playing && input.down('ShiftLeft'),
    crouching: playing && (input.down('ControlLeft') || input.down('KeyC')),
    jump: playing && input.pressedOnce('Space'),
  });

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

  // hud
  hud.setHeading(controller.headingDeg);
  const speedNorm = controller.state.speed;
  const spreadPx = (G.firing ? 7 : 2) + speedNorm * 9 + (controller.adsAmount > 0.5 ? 0 : 4);
  hud.setSpread(spreadPx, controller.adsAmount > 0.6);
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
    const hits = rr.intersectObjects(level.bulletTargets, false);
    const h = hits.find((x) => x.object.visible || x.object.userData.enemy);
    return h ? { d: +h.distance.toFixed(2), blocker: !!h.object.userData.blocker, p: [+h.point.x.toFixed(1), +h.point.y.toFixed(1), +h.point.z.toFixed(1)] } : null;
  },
  get enemies() { return enemies; }, get state() { return G; }, get hud() { return hud; },
  get fx() { return fx; }, get viewmodel() { return viewmodel; }, get input() { return input; },
  get pickups() { return pickups; }, get streaks() { return streakSys; }, get artillery() { return artillery; },
  get leaderboard() { return leaderboard; }, get results() { return results; },
  get daily() { return loadDaily(); },
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
      mat: h.object.material?.color?.getHexString?.() || null,
      mt: h.object.material?.type || null,
      name: h.object.name || h.object.parent?.name || '',
    };
  },
  get fps() { return G.fps; },
};
