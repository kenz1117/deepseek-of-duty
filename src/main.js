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

/* =========================================================================
   DEEPSEEK OF DUTY — browser vertical slice.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const SHOT_MODE = params.get('shot') === '1';
const POSE = params.get('pose') || 'hero';
const HIDE_HUD = params.get('hidehud') === '1';

const WEAPONS = [
  {
    id: 'm4', name: 'M4A1', magSize: 30, reserve: 180, dmg: 30, rpm: 720,
    auto: true, spread: 0.0125, adsSpread: 0.0016, recoil: 1.0, variant: 'black', mode: 'AUTO',
  },
  {
    id: 'mk18', name: 'MK18', magSize: 25, reserve: 150, dmg: 34, rpm: 800,
    auto: true, spread: 0.0150, adsSpread: 0.0021, recoil: 1.18, variant: 'tan', mode: 'AUTO',
  },
];

const G = {
  state: 'loading',
  hp: 100, maxHp: 100, armor: 60, maxArmor: 60,
  score: 0, kills: 0, wave: 1, waveRemaining: 0, waveTotal: 0,
  spawnQueue: [], spawnTimer: 0, waveClearTimer: 0,
  time: 0, sinceDamage: 99,
  weaponIndex: 0, mag: 30, reserve: 180,
  weaponAmmo: [{ mag: 30, reserve: 180 }, { mag: 25, reserve: 150 }],
  fps: 60,
  reloadTimer: -1, reloadTransferred: false,
  fireCooldown: 0, grenades: 2,
  firing: false, shotFired: false,
  freezeEnemies: false, debugWaves: false, hitStop: 0, lockHint: false, debugAutoFire: false,
  readyFrames: 0, ready: false,
  hurtTimer: 0,
};

let engine, level, viewmodel, fx, audio, hud, input, controller, vmPass;
const enemies = [];
const grenades = [];
let raycaster, clock;
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

function setLoading(p, text) {
  if (loadFill) loadFill.style.width = `${p * 100}%`;
  if (loadText && text) loadText.textContent = text;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    setLoading(0.05, '初始化渲染器…');
    await nextFrame();

    engine = createEngine(document.getElementById('gl'), 'high');
    setLoading(0.34, '生成程序化 PBR 材质与大气…');
    await nextFrame();

    level = createLevel(engine);
    setLoading(0.58, '构建战区街区…');
    await nextFrame();

    viewmodel = createViewmodel(engine.mats, engine.sky.envTexture);
    setLoading(0.72, '装配武器与手部动画…');
    await nextFrame();

    fx = createFX(engine.scene, engine.mats);
    audio = createAudio();
    hud = createHUD();
    input = createInput(engine.renderer.domElement);
    controller = createController(engine.camera, level.colliders, level.bounds, audio);
    raycaster = new THREE.Raycaster();
    raycaster.far = 160;
    setupEnemyCtx();

    vmPass = engine.addOverlay(viewmodel.scene, viewmodel.camera);
    window.addEventListener('resize', onResize);

    document.getElementById('deploy').addEventListener('click', () => {
      audio.init();
      initAudioAmbience();
      startGame(true);
    });
    document.getElementById('resume').addEventListener('click', () => {
      G.state = 'playing';
      pauseEl.classList.add('hidden');
      input.lock();
    });
    document.getElementById('quit').addEventListener('click', () => {
      pauseEl.classList.add('hidden');
      deathEl.classList.add('hidden');
      hudEl.classList.add('hidden');
      menuEl.classList.remove('hidden');
      G.state = 'menu';
      input.unlock();
      resetGame();
      viewmodel.root.visible = false;
    });
    document.getElementById('redeploy').addEventListener('click', () => {
      deathEl.classList.add('hidden');
      resetGame();
      startGame(true);
    });

    for (const b of document.querySelectorAll('.quality-pills button')) {
      b.addEventListener('click', () => {
        const q = b.dataset.q || b.dataset.pq;
        engine.setQuality(q);
        onResize();
        for (const other of document.querySelectorAll(`.quality-pills button`)) {
          other.classList.toggle('active', (other.dataset.q || other.dataset.pq) === q);
        }
        audio.init(); audio.ui();
      });
    }

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
        if (G.state === 'playing') { G.state = 'paused'; pauseEl.classList.remove('hidden'); input.unlock(); }
      }
      if (G.state !== 'playing') return;
      if (code === 'KeyR') reload();
      if (code === 'KeyF') viewmodel.inspect();
      if (code === 'KeyG') throwGrenade();
      if (code === 'Digit1') switchWeapon(0);
      if (code === 'Digit2') switchWeapon(1);
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
function startGame(lock = true, silent = false) {
  resetGame();
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');
  viewmodel.root.visible = true;
  G.state = 'playing';
  controller.revive(1.2, 33);
  controller.setLook(-0.03, -0.015);
  if (!silent) audio.uiConfirm();
  if (lock) input.lock();
  startWave(1);
  hudEl.classList.toggle('hidden', HIDE_HUD);
  if (!SHOT_MODE) {
    const hint = document.getElementById('hint');
    hint.textContent = '';
  }
}

function resetGame() {
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
  G.grenades = 2;
  G.reloadTimer = -1;
  G.reloadTransferred = false;
  G.sinceDamage = 99;
  G.time = 0;
  G.weaponIndex = 0;
  G.weaponAmmo = [{ mag: WEAPONS[0].magSize, reserve: WEAPONS[0].reserve }, { mag: WEAPONS[1].magSize, reserve: WEAPONS[1].reserve }];
  G.mag = WEAPONS[0].magSize;
  G.reserve = WEAPONS[0].reserve;
  for (const e of enemies) e.root.visible = false;
  enemies.length = 0;
  for (const g of grenades) engine.scene.remove(g.mesh);
  grenades.length = 0;
  hud.reset();
  hud.setWeaponName(WEAPONS[0].name, WEAPONS[0].magSize, WEAPONS[0].mode);
  hud.setAmmo(G.mag, G.reserve, WEAPONS[0].name, WEAPONS[0].mode);
  hud.setHealth(G.hp, pipsFor(G.armor));
  hud.setScore(0, 0);
  hud.setGrenades(2);
  viewmodel.setWeapon(WEAPONS[0].variant);
}

function pipsFor(armor) { return Math.ceil(armor / 20); }

/* ------------------------------------------------------------------ waves */
function startWave(n) {
  G.wave = n;
  const total = Math.min(11, 3 + n);
  G.waveTotal = total;
  G.waveRemaining = total;
  G.spawnQueue = [];
  const playerPos = controller.pos;
  const pool = level.spawnPoints.slice();
  for (let i = 0; i < total; i++) {
    // prefer far spawn points
    let best = null, bestD = -1;
    for (let k = 0; k < 4; k++) {
      const p = pool[Math.floor(Math.random() * pool.length)];
      const d = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (d > bestD) { bestD = d; best = p; }
    }
    G.spawnQueue.push({ x: best.x + (Math.random() - 0.5) * 2.2, z: best.z + (Math.random() - 0.5) * 2.2 });
  }
  G.spawnTimer = 0.8;
  G.waveClearTimer = 0;
  hud.setWave(n);
  hud.setWaveProgress(0);
  hud.setObjective(`清剿残敌 · 剩余 ${total}`);
  hud.setHint('WAVE ' + n);
  setTimeout(() => hud.setHint(''), 1400);
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
  e.spawn(pos.x, pos.z, yaw);
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
    if (G.waveClearTimer === 0) {
      G.waveClearTimer = 0.001;
      hud.setHint('WAVE CLEARED');
      G.score += 250;
      hud.setScore(G.score, G.kills);
      // resupply between waves
      const w = currentWeapon();
      G.mag = w.magSize;
      G.reserve = w.reserve;
      G.weaponAmmo[G.weaponIndex] = { mag: G.mag, reserve: G.reserve };
      hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
      G.grenades = Math.min(3, G.grenades + 1);
      hud.setGrenades(G.grenades);
    }
    G.waveClearTimer += dt;
    if (G.waveClearTimer > 4.0) {
      G.waveClearTimer = 0;
      startWave(G.wave + 1);
    }
  }
  hud.setWaveProgress(1 - G.waveRemaining / Math.max(1, G.waveTotal));
  if (G.waveRemaining > 0 || alive > 0) {
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

function currentWeapon() { return WEAPONS[G.weaponIndex]; }

function switchWeapon(i) {
  if (i === G.weaponIndex || G.reloadTimer >= 0) return;
  G.weaponAmmo[G.weaponIndex] = { mag: G.mag, reserve: G.reserve };
  G.weaponIndex = i;
  const w = WEAPONS[i];
  const a = G.weaponAmmo[i] || { mag: w.magSize, reserve: w.reserve };
  G.mag = a.mag;
  G.reserve = a.reserve;
  viewmodel.setWeapon(w.variant);
  hud.setWeaponName(w.name, w.magSize, w.mode);
  hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  audio.reload('bolt');
  G.fireCooldown = 0.35;
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
  hud.setAmmo(G.mag, G.reserve, w.name, w.mode);
  viewmodel.fire(1);
  const mz = muzzleWorld(_muzzle);
  fx.muzzleFlash(mz);
  audio.gunshot(0);
  controller.kick(0.72 * w.recoil + Math.random() * 0.16, (Math.random() - 0.5) * 0.30 * w.recoil);
  controller.addShake(0.09);
  const moving = controller.state.speed;
  const ads = controller.adsAmount;
  const spread = (ads > 0.5 ? w.adsSpread : w.spread) * (1 + moving * 1.4) * (1 - ads * 0.65);
  engine.camera.getWorldDirection(_dir);
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.sqrt(Math.random()) * spread;
  _right.set(1, 0, 0).applyQuaternion(engine.camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(engine.camera.quaternion);
  _dir.addScaledVector(_right, Math.cos(ang) * rad).addScaledVector(_up, Math.sin(ang) * rad).normalize();
  raycaster.set(engine.camera.position, _dir);
  const targets = level.bulletTargets.slice();
  for (const e of enemies) if (e.alive) targets.push(...e.hitboxes);
  const hits = raycaster.intersectObjects(targets, false);
  const hit = hits.find((h) => h.object.visible || h.object.userData.enemy);
  _end.copy(engine.camera.position).addScaledVector(_dir, 120);
  if (hit) {
    _end.copy(hit.point);
    _normal.copy(hit.face ? hit.face.normal : _dir).transformDirection(hit.object.matrixWorld).negate();
    if (_normal.lengthSq() < 0.1) _normal.copy(_dir).negate();
    const enemy = hit.object.userData.enemy;
    if (enemy && enemy.alive) {
      const part = hit.object.userData.part;
      const mult = hit.object.userData.dmg || 1;
      const headshot = part === 'head';
      const killed = enemy.takeDamage(w.dmg * mult, hit.point, _normal, part);
      fx.blood(hit.point, _normal, _dir);
      audio.impact('flesh');
      audio.hitmarker(headshot);
      hud.hit(headshot, killed);
      if (killed) onEnemyKilled(enemy, headshot);
    } else {
      const mat = hit.object.material;
      let kind = 'concrete';
      if (mat === engine.mats.metal || mat === engine.mats.metalTan || mat === engine.mats.rust || mat === engine.mats.shop) kind = 'metal';
      if (mat === engine.mats.wood) kind = 'wood';
      fx.impact(hit.point, _normal, kind);
      audio.impact(kind === 'metal' ? 'metal' : 'concrete');
      if (kind === 'metal' && Math.random() > 0.65) audio.ricochet((Math.random() - 0.5) * 0.6);
    }
  }
  fx.tracer(mz, _end, { color: 0xffce8f, width: 0.028, life: 0.055 });
  if (G.mag === 0 && G.reserve > 0) setTimeout(() => { if (G.state === 'playing') reload(); }, 160);
}

function tryFire(dt) {
  const w = currentWeapon();
  G.fireCooldown -= dt;
  const wantFire = (input.mouse.left && input.locked && G.state === 'playing') || G.debugAutoFire;
  G.firing = wantFire;
  const trigger = w.auto ? wantFire : (input.mouse.leftPressed && input.locked);
  if (!trigger || G.fireCooldown > 0 || G.reloadTimer >= 0) return;
  if (G.mag <= 0) {
    if (G.reserve > 0) reload();
    return;
  }
  G.fireCooldown = 60 / w.rpm;
  G.shotFired = true;
  fireShot();
}

function onEnemyKilled(enemy, headshot) {
  G.kills++;
  G.waveRemaining = Math.max(0, G.waveRemaining - 1);
  G.score += headshot ? 150 : 100;
  hud.setScore(G.score, G.kills);
  hud.addKillFeed(headshot ? 'HOSTILE' : 'INSURGENT', headshot, currentWeapon().name);
  G.hitStop = 0.055;
  audio.killConfirm();
  // limit corpse count
  const dead = enemies.filter((e) => !e.alive);
  if (dead.length > 6) {
    const old = dead[0];
    old.root.visible = false;
  }
}

function reload() {
  const w = currentWeapon();
  if (G.reloadTimer >= 0 || G.mag >= w.magSize || G.reserve <= 0) return;
  G.reloadTimer = 0;
  G.reloadTransferred = false;
  viewmodel.startReload();
  audio.reload('magOut');
  setTimeout(() => { if (G.reloadTimer >= 0) audio.reload('magIn'); }, 700);
  setTimeout(() => { if (G.reloadTimer >= 0) audio.reload('charge'); }, 1500);
}

function updateReload(dt) {
  if (G.reloadTimer < 0) return;
  G.reloadTimer += dt;
  if (!G.reloadTransferred && G.reloadTimer > 1.28) {
    G.reloadTransferred = true;
    const w = currentWeapon();
    const need = Math.min(w.magSize - G.mag, G.reserve);
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
          if (died) onEnemyKilled(e, false);
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

function playerDie() {
  G.hp = 0;
  G.state = 'dead';
  controller.die();
  viewmodel.state.dead = true;
  audio.death();
  audio.setLowHealth(false);
  input.unlock();
  document.getElementById('final-kills').textContent = G.kills;
  document.getElementById('final-wave').textContent = G.wave;
  document.getElementById('final-score').textContent = G.score;
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
  } else if (G.state === 'paused') {
    engine.update(dt, controller.pos);
  }

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
    tryFire(dt);
    updateReload(dt);
    updateGrenades(dt);

    // health regen
    G.sinceDamage += dt;
    if (G.sinceDamage > 4.2 && G.hp < G.maxHp) {
      G.hp = Math.min(G.maxHp, G.hp + 26 * dt);
      hud.setHealth(G.hp, pipsFor(G.armor));
      if (G.hp > 40) audio.setLowHealth(false);
    }
    updateWaves(dt);
  }

  // enemies
  const alive = G.hp > 0;
  enemyCtx.playerPos.copy(engine.camera.position);
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
  get enemies() { return enemies; }, get state() { return G; }, get hud() { return hud; },
  get fx() { return fx; }, get viewmodel() { return viewmodel; },
  startGame, resetGame, spawnEnemy, applyPlayerDamage,
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
