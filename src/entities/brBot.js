import * as THREE from 'three';
import { buildSoldier, applyPose, applyRagdoll } from './soldierParts.js';

/* =========================================================================
 * BR BOT — a standalone free-for-all Battle-Royale actor.
 *
 * Owns its own rig, hitboxes, locomotion, LOS and firing. It knows nothing
 * about the campaign waves, the squad director or the perception system: all
 * decision inputs arrive in update(dt, ctx). That keeps it usable from a BR
 * mode (or a test harness) without touching main.js / level.js.
 *
 *   createBrBot({ scene, mats, colliders, level, nav, id, name, variant })
 *     => { root, hitboxes, hp, alive, pos, id, name,
 *          spawn, update, takeDamage, die, dispose, setVisible }
 *
 * update ctx:
 *   { targets:[{id,x,y,z,alive,isHuman}], nav, level, fx, audio,
 *     damageTarget(target, dmg, fromPos) }
 *
 * - nearest alive target, pursue to 14–22 m through the nav grid
 * - LOS ray vs level.bulletTargets, 3–6 round bursts, 4–7 dmg per hit
 * - tracer / muzzle flash / enemyShot audio
 * - low hp or recently hit: sidestep to the nearest cover point
 * - death: light 7-body ragdoll (same solver shape as Enemy), hitboxes off
 * - corpse holds ~7 s then hides so the slot can be reused
 * ========================================================================= */

const EYE_Y = 1.685;
const THIGH_SIZE = 0.435;
const SHIN_SIZE = 0.395;
// shared invisible hit-volume material (one draw-less material for all bots)
const HB_MAT = new THREE.MeshBasicMaterial();

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _mz = new THREE.Vector3();
const _end = new THREE.Vector3();
const _ray = new THREE.Raycaster();
_ray.firstHitOnly = true;

const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const clamp = THREE.MathUtils.clamp;
const rnd = Math.random;

/* --------------------------------------------------------------- ragdoll */
// 7 bodies / 8 distance constraints — same budget as the campaign corpse.
const RAG_BODY_DEF = [
  { k: 'head', w: 0.60, r: 0.105, lift: 1.00 },
  { k: 'chest', w: 0.95, r: 0.150, lift: 0.80 },
  { k: 'pelvis', w: 1.00, r: 0.140, lift: 0.30 },
  { k: 'handL', w: 0.30, r: 0.045, lift: 0.90 },
  { k: 'handR', w: 0.30, r: 0.045, lift: 0.90 },
  { k: 'footL', w: 0.42, r: 0.065, lift: 0.00 },
  { k: 'footR', w: 0.42, r: 0.065, lift: 0.00 },
];
const RAG_CON_DEF = [
  ['pelvis', 'chest'], ['chest', 'head'],
  ['chest', 'handL'], ['chest', 'handR'],
  ['pelvis', 'footL'], ['pelvis', 'footR'],
  ['head', 'pelvis', 0.94],
  ['footL', 'footR'],
];
const RAG_DT = 1 / 60;
const _ragQInv = new THREE.Quaternion();
const _ragS = {
  pelvis: new THREE.Vector3(), chest: new THREE.Vector3(), head: new THREE.Vector3(),
  handL: new THREE.Vector3(), handR: new THREE.Vector3(),
  footL: new THREE.Vector3(), footR: new THREE.Vector3(),
  forward: new THREE.Vector3(0, 0, -1),
};

export function createBrBot({
  scene, mats, colliders = [], level = null, nav = null,
  id = 0, name = '', variant = 0, archetype = 'rifleman',
} = {}) {
  /* ------------------------------------------------------------- rig */
  const rig = buildSoldier(mats, variant % 3, archetype);
  const root = new THREE.Group();
  root.add(rig.root);
  scene.add(root);

  const hitboxes = [];

  // per-bot combat profile (small jitter so a pack does not fire in lockstep)
  const D = {
    hp: 100,
    walkSpeed: 3.1 + rnd() * 0.5,
    runSpeed: 4.3 + rnd() * 0.6,
    wantDist: 14 + rnd() * 8,          // 14–22 m
    fireRange: 34,
    burstMin: 3, burstMax: 6,
    burstGap: 0.095 + rnd() * 0.02,
    burstPause: 0.55 + rnd() * 0.6,
    dmgMin: 4, dmgMax: 7,
    hitBase: 0.74, hitFalloff: 0.010,
    coverHp: 38,
  };

  let alive = true;
  let hp = D.hp;
  let state = 'pursue';
  let targetId = null;
  let path = null;
  let pathI = 0;
  let repathT = 0;
  let failT = 0;
  let walkT = rnd() * 6;
  let animT = rnd() * 6;
  let walkAmp = 0;
  let speed = 0;
  let yaw = 0;
  let aimBlend = 0.4;
  let aimPitchS = 0;
  let lookYawS = 0;
  let flinch = 0;
  let recoil = 0;
  let weaponLevel = 0;
  let burstLeft = 0;
  let burstT = 0;
  let fireCd = 0.8 + rnd() * 1.2;
  let weaponFlashT = 0;
  let lastHitT = 0;
  let strafeDir = rnd() < 0.5 ? 1 : -1;
  let strafeT = 1.2 + rnd() * 1.6;
  let coverPoint = null;
  let coverT = 0;
  let wanderT = 0;
  let wanderYaw = rnd() * 6.283;
  let deathPart = 'torso';
  let baseY = 0;
  let corpseT = 0;
  let ragdoll = null;
  let velX = 0;
  let velZ = 0;

  /* ---------------------------------------------------------- hitboxes */
  function buildHitboxes() {
    for (const h of hitboxes) {
      if (h.parent) h.parent.remove(h);
      h.geometry.dispose();
    }
    hitboxes.length = 0;
    const mk = (w, h, d, parent, x, y, z, part, dmg) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), HB_MAT);
      m.position.set(x, y, z);
      m.visible = false;
      // `enemy` keeps compatibility with a main.js ray pipeline that reads
      // userData.enemy; `bot` is the explicit BR handle.
      m.userData = { enemy: api, bot: api, part, dmg };
      parent.add(m);
      hitboxes.push(m);
      return m;
    };
    mk(0.218, 0.256, 0.215, rig.headPivot, 0, 0.161, -0.005, 'head', 3.6);
    mk(0.17, 0.14, 0.17, rig.torso, 0, 0.49, 0, 'torso', 1.0);
    mk(0.445, 0.40, 0.31, rig.torso, 0, 0.255, 0, 'torso', 1.0);
    mk(0.36, 0.26, 0.27, rig.hips, 0, 0.055, 0, 'torso', 0.9);
    mk(0.135, 0.29, 0.155, rig.armL.shoulder, 0, -0.155, 0, 'arms', 0.6);
    mk(0.135, 0.29, 0.155, rig.armR.shoulder, 0, -0.155, 0, 'arms', 0.6);
    mk(0.12, 0.25, 0.14, rig.armL.elbow, 0, -0.13, 0, 'arms', 0.6);
    mk(0.12, 0.25, 0.14, rig.armR.elbow, 0, -0.13, 0, 'arms', 0.6);
    mk(0.165, THIGH_SIZE, 0.195, rig.legL.hip, 0, -THIGH_SIZE * 0.5, 0, 'legs', 0.7);
    mk(0.165, THIGH_SIZE, 0.195, rig.legR.hip, 0, -THIGH_SIZE * 0.5, 0, 'legs', 0.7);
    mk(0.148, SHIN_SIZE, 0.178, rig.legL.knee, 0, -SHIN_SIZE * 0.5, 0, 'legs', 0.65);
    mk(0.148, SHIN_SIZE, 0.178, rig.legR.knee, 0, -SHIN_SIZE * 0.5, 0, 'legs', 0.65);
    mk(0.135, 0.115, 0.30, rig.legL.ankle, 0, -0.05, -0.055, 'legs', 0.55);
    mk(0.135, 0.115, 0.30, rig.legR.ankle, 0, -0.05, -0.055, 'legs', 0.55);
  }

  function setHitboxesVisible(v) {
    for (const h of hitboxes) h.visible = v;
  }

  /* -------------------------------------------------------------- posing */
  function restPose() {
    applyPose(rig, {
      time: 0, crouch: 0.10, walkAmp: 0, walkPhase: 0, aim: 0.5,
      weaponLevel: 0, aimPitch: 0, lookYaw: 0, flinch: 0, recoil: 0, limp: 0,
    });
  }

  function applyBodyPose() {
    applyPose(rig, {
      time: animT,
      crouch: state === 'cover' ? 0.5 : (hp < 45 ? 0.18 : 0.1),
      walkAmp,
      walkPhase: walkT,
      aim: aimBlend,
      weaponLevel,
      aimPitch: aimPitchS,
      lookYaw: lookYawS,
      flinch,
      recoil,
      limp: 0,
      headRoll: 0,
      deathSide: 1,
      flinchSide: 1,
    });
  }

  /* ------------------------------------------------------------- spawning */
  function spawn(x, z, yawIn = 0, y = 0) {
    baseY = Number.isFinite(y) ? y : 0;
    root.position.set(x, baseY, z);
    root.rotation.set(0, yawIn, 0);
    yaw = yawIn;
    alive = true;
    hp = D.hp;
    state = 'pursue';
    targetId = null;
    path = null;
    pathI = 0;
    repathT = 0;
    failT = 0;
    speed = 0;
    walkAmp = 0;
    walkT = rnd() * 6;
    animT = 0;
    aimBlend = 0.4;
    aimPitchS = 0;
    lookYawS = 0;
    flinch = 0;
    recoil = 0;
    weaponLevel = 0;
    burstLeft = 0;
    burstT = 0;
    fireCd = 0.7 + rnd() * 1.0;
    weaponFlashT = 0;
    lastHitT = 0;
    coverPoint = null;
    coverT = 0;
    wanderT = 0;
    wanderYaw = rnd() * 6.283;
    deathPart = 'torso';
    corpseT = 0;
    ragdoll = null;
    velX = 0;
    velZ = 0;
    rig.weaponFlash.material.opacity = 0;
    rig.root.visible = true;
    root.visible = true;
    setHitboxesVisible(false);
    restPose();
  }

  /* --------------------------------------------------------------- damage */
  function takeDamage(dmg, point, part = 'torso') {
    if (!alive) return false;
    deathPart = part;
    hp -= dmg;
    flinch = Math.min(1, flinch + 0.5);
    lastHitT = 0.9;
    // a hit from a side the bot is not facing also turns it a little
    if (point) {
      const dx = point.x - root.position.x;
      const dz = point.z - root.position.z;
      if (Math.hypot(dx, dz) > 0.2) yaw += clamp(wrapPi(Math.atan2(-dx, -dz) - yaw) * 0.25, -0.6, 0.6);
    }
    if (hp <= 0) {
      die(point);
      return true;
    }
    return false;
  }

  function die(fromPos) {
    if (!alive) return;
    alive = false;
    state = 'dead';
    speed = 0;
    walkAmp = 0;
    burstLeft = 0;
    setHitboxesVisible(false);
    startRagdoll(fromPos);
    corpseT = 0;
  }

  /* -------------------------------------------------------------- ragdoll */
  function startRagdoll(point) {
    root.updateWorldMatrix(true, true);
    const pelvis = rig.hips.getWorldPosition(new THREE.Vector3());
    rig.torso.getWorldQuaternion(_q1);
    const chest = rig.torso.getWorldPosition(new THREE.Vector3())
      .add(_v1.set(0, 0.26, 0).applyQuaternion(_q1));
    rig.headPivot.getWorldQuaternion(_q1);
    const head = rig.headPivot.getWorldPosition(new THREE.Vector3())
      .add(_v1.set(0, 0.15, 0).applyQuaternion(_q1));
    const handL = rig.armL.hand.getWorldPosition(new THREE.Vector3());
    const handR = rig.armR.hand.getWorldPosition(new THREE.Vector3());
    const footL = rig.legL.ankle.getWorldPosition(new THREE.Vector3());
    const footR = rig.legR.ankle.getWorldPosition(new THREE.Vector3());

    const bodies = [];
    const add = (k, p) => {
      const d = RAG_BODY_DEF.find((b) => b.k === k);
      bodies.push({ k, w: d.w, r: d.r, lift: d.lift, p: p.clone(), prev: p.clone() });
    };
    add('head', head);
    add('chest', chest);
    add('pelvis', pelvis);
    add('handL', handL);
    add('handR', handR);
    add('footL', footL);
    add('footR', footR);
    const byKey = (k) => bodies.find((b) => b.k === k);
    const cons = RAG_CON_DEF.map(([a, b, scale]) => ({
      a: byKey(a), b: byKey(b),
      rest: Math.max(0.05, byKey(a).p.distanceTo(byKey(b).p) * (scale || 1)),
    }));

    const dir = new THREE.Vector3();
    if (point) dir.set(root.position.x - point.x, 0, root.position.z - point.z);
    if (dir.lengthSq() < 1e-4) dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    dir.normalize();

    const imp = { head: 0.5, chest: 0.9, pelvis: 0.7, handL: 0.6, handR: 0.6, footL: 0.25, footR: 0.25 };
    if (deathPart === 'head') {
      imp.head = 3.2; imp.chest = 1.0; imp.pelvis = 0.4; imp.handL = 0.9; imp.handR = 0.9;
    } else if (deathPart === 'arms') {
      if (point && point.distanceTo(handL) < point.distanceTo(handR)) imp.handL = 2.4;
      else imp.handR = 2.4;
      imp.chest = 0.8;
    } else if (deathPart === 'legs') {
      if (point && point.distanceTo(footL) < point.distanceTo(footR)) imp.footL = 2.6;
      else imp.footR = 2.6;
      imp.pelvis = 0.5; imp.chest = 0.35; imp.head = 0.3;
    }
    const baseVx = velX * 0.5;
    const baseVz = velZ * 0.5;
    for (const b of bodies) {
      const k = imp[b.k];
      const vx = baseVx + dir.x * k + (rnd() - 0.5) * 0.5;
      const vz = baseVz + dir.z * k + (rnd() - 0.5) * 0.5;
      const vy = 0.30 + k * 0.20 * b.lift + rnd() * 0.18;
      b.prev.set(b.p.x - vx * RAG_DT, b.p.y - vy * RAG_DT, b.p.z - vz * RAG_DT);
    }
    ragdoll = { bodies, cons, t: 0, acc: 0, done: false };
  }

  function stepRagdoll(dt) {
    const rd = ragdoll;
    if (!rd || rd.done) return;
    rd.t += dt;
    if (rd.t > 3.2) { rd.done = true; return; }
    rd.acc = Math.min(rd.acc + dt, 0.07);
    let steps = 0;
    while (rd.acc >= RAG_DT && steps < 3) {
      integrateRagdoll(RAG_DT, rd);
      rd.acc -= RAG_DT;
      steps++;
    }
  }

  function integrateRagdoll(h, rd) {
    const g = -9.8 * h * h;
    for (const b of rd.bodies) {
      const vx = (b.p.x - b.prev.x) * 0.995;
      const vy = (b.p.y - b.prev.y) * 0.995;
      const vz = (b.p.z - b.prev.z) * 0.995;
      b.prev.set(b.p.x, b.p.y, b.p.z);
      b.p.x += vx;
      b.p.y += vy + g;
      b.p.z += vz;
    }
    for (let it = 0; it < 6; it++) {
      for (const c of rd.cons) {
        const a = c.a, b = c.b;
        const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, dz = b.p.z - a.p.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-5) continue;
        const diff = (len - c.rest) / len;
        const wa = a.w / (a.w + b.w);
        const wb = 1 - wa;
        a.p.x += dx * diff * wa; a.p.y += dy * diff * wa; a.p.z += dz * diff * wa;
        b.p.x -= dx * diff * wb; b.p.y -= dy * diff * wb; b.p.z -= dz * diff * wb;
      }
    }
    for (const b of rd.bodies) {
      const floor = baseY + b.r;
      if (b.p.y < floor) {
        b.p.y = floor;
        const hx = b.p.x - b.prev.x;
        const hz = b.p.z - b.prev.z;
        b.prev.x = b.p.x - hx * 0.55;
        b.prev.z = b.p.z - hz * 0.55;
        const bounce = (b.p.y - b.prev.y) * 0.12;
        if (bounce < 0) b.prev.y = b.p.y + bounce;
      }
    }
  }

  function applyRagdollPose() {
    const rd = ragdoll;
    if (!rd) return;
    const get = (k) => rd.bodies.find((b) => b.k === k).p;
    _ragQInv.copy(root.quaternion).invert();
    const toLocal = (v, out) => out.copy(v).sub(root.position).applyQuaternion(_ragQInv);
    toLocal(get('pelvis'), _ragS.pelvis);
    toLocal(get('chest'), _ragS.chest);
    toLocal(get('head'), _ragS.head);
    toLocal(get('handL'), _ragS.handL);
    toLocal(get('handR'), _ragS.handR);
    toLocal(get('footL'), _ragS.footL);
    toLocal(get('footR'), _ragS.footR);
    _ragS.forward.set(0, 0, -1);
    applyRagdoll(rig, _ragS);
  }

  /* ----------------------------------------------------------------- nav */
  function resolveCollision() {
    const p = root.position;
    const r = 0.34;
    for (const c of colliders) {
      if (p.x > c.x0 - r && p.x < c.x1 + r && p.z > c.z0 - r && p.z < c.z1 + r) {
        const dl = Math.abs(p.x - (c.x0 - r));
        const dr = Math.abs((c.x1 + r) - p.x);
        const db = Math.abs(p.z - (c.z0 - r));
        const df = Math.abs((c.z1 + r) - p.z);
        const m = Math.min(dl, dr, db, df);
        if (m === dl) p.x = c.x0 - r;
        else if (m === dr) p.x = c.x1 + r;
        else if (m === db) p.z = c.z0 - r;
        else p.z = c.z1 + r;
      }
    }
    const b = level && level.bounds;
    if (b) {
      p.x = clamp(p.x, b.x0 + 0.4, b.x1 - 0.4);
      p.z = clamp(p.z, b.z0 + 0.4, b.z1 - 0.4);
    }
  }

  function groundAt(x, z) {
    if (level && typeof level.groundHeight === 'function') {
      return level.groundHeight(x, z, baseY) || 0;
    }
    return baseY;
  }

  function repathTo(gx, gz, gy) {
    if (!nav) { path = [{ x: gx, z: gz }]; pathI = 0; return; }
    const p = nav.findPath
      ? nav.findPath(root.position.x, root.position.z, baseY, gx, gz, gy || 0, 3200)
      : null;
    if (p && p.length) {
      path = p;
      pathI = 0;
      failT = 0;
    } else {
      // unreachable: fall back to a straight line for a moment, then retry
      path = [{ x: gx, z: gz }];
      pathI = 0;
      failT += 0.5;
    }
  }

  function hasLOS(eye, to) {
    if (!level || !level.bulletTargets) return true;
    _v3.copy(to).sub(eye);
    const dist = _v3.length();
    if (dist < 0.2) return true;
    _v3.divideScalar(dist);
    _ray.set(eye, _v3);
    _ray.far = dist - 0.25;
    const hits = _ray.intersectObjects(level.bulletTargets, false);
    for (const h of hits) {
      if (h.distance < dist - 0.3 && h.object.visible !== false) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ AI */
  function pickTarget(targets) {
    let best = null;
    let bestD = Infinity;
    for (const t of targets) {
      if (!t || t.id === id || t.alive === false) continue;
      const d = Math.hypot((t.x || 0) - root.position.x, (t.z || 0) - root.position.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    return { target: best, dist: bestD };
  }

  function nearestCover(target) {
    if (!level || !level.coverPoints || !level.coverPoints.length) return null;
    let best = null;
    let bestScore = Infinity;
    const tp = target || { x: 0, z: 0 };
    for (const c of level.coverPoints) {
      const d = Math.hypot(c.x - root.position.x, c.z - root.position.z);
      if (d > 13 || d < 1.4) continue;
      const distTarget = Math.hypot(c.x - tp.x, c.z - tp.z);
      const score = d * 0.55 - distTarget * 0.22 + rnd() * 1.5;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  function fireRound(ctx, target, muzzle) {
    const dist = Math.hypot(target.x - root.position.x, target.z - root.position.z);
    const pan = ctx.panFor ? ctx.panFor(root.position) : 0;
    const hitChance = clamp(D.hitBase - dist * D.hitFalloff, 0.2, 0.85);
    const hit = rnd() < hitChance;
    const spread = hit ? 0.12 : 0.35 + dist * 0.02;
    _end.set(
      target.x + (rnd() - 0.5) * spread,
      (target.y || 0) + 1.2 + (rnd() - 0.5) * spread * 0.6,
      target.z + (rnd() - 0.5) * spread
    );
    const fx = ctx.fx;
    if (fx) {
      if (fx.tracer) fx.tracer(muzzle, _end, { color: 0xffc98a, width: 0.028, life: 0.05 });
      if (fx.muzzleFlash) fx.muzzleFlash(muzzle);
    }
    if (ctx.audio && ctx.audio.enemyShot) ctx.audio.enemyShot(pan, Math.hypot(target.x - root.position.x, target.z - root.position.z));
    weaponFlashT = 0.05;
    rig.weaponFlash.material.opacity = 1;
    rig.weaponFlash.material.rotation = rnd() * 6;
    rig.weaponFlash.scale.setScalar(0.18 + rnd() * 0.1);
    recoil = 0.7;
    if (hit && ctx.damageTarget) {
      const dmg = D.dmgMin + rnd() * (D.dmgMax - D.dmgMin);
      ctx.damageTarget(target, dmg, root.position);
    }
  }

  /* -------------------------------------------------------------- update */
  function update(dt, ctx = {}) {
    animT += dt;
    if (!alive) {
      corpseT += dt;
      if (ragdoll) {
        stepRagdoll(dt);
        applyRagdollPose();
      }
      rig.weaponFlash.material.opacity = 0;
      if (corpseT > 7 && root.visible) root.visible = false;
      return;
    }

    flinch = Math.max(0, flinch - dt * 2.6);
    recoil = Math.max(0, recoil - dt * 7);
    weaponFlashT = Math.max(0, weaponFlashT - dt);
    rig.weaponFlash.material.opacity = weaponFlashT > 0 ? 1 : 0;
    lastHitT = Math.max(0, lastHitT - dt);

    const ox = root.position.x, oz = root.position.z;
    const targets = ctx.targets || [];
    const { target, dist } = pickTarget(targets);
    targetId = target ? target.id : null;

    // ---- low hp / under fire: sidestep to cover
    if (!coverPoint && D.coverHp && hp < D.coverHp && (lastHitT > 0 || rnd() < 0.02) && target) {
      const cp = nearestCover(target);
      if (cp) {
        coverPoint = cp;
        coverT = 2.2 + rnd() * 1.6;
        state = 'cover';
        path = null;
      }
    }
    if (coverPoint) {
      coverT -= dt;
      if (coverT <= 0) { coverPoint = null; state = 'pursue'; path = null; }
    }

    // ---- movement goal
    let goalX = null, goalZ = null, goalY = 0;
    let wantSpeed = 0;
    if (coverPoint) {
      const d = Math.hypot(coverPoint.x - root.position.x, coverPoint.z - root.position.z);
      if (d > 0.7) { goalX = coverPoint.x; goalZ = coverPoint.z; goalY = groundAt(coverPoint.x, coverPoint.z); wantSpeed = D.runSpeed; }
    } else if (target) {
      const tx = target.x, tz = target.z;
      const tGround = Number.isFinite(target.y) ? target.y : 0;
      if (dist > D.wantDist + 3) {
        goalX = tx; goalZ = tz; goalY = tGround;
        wantSpeed = dist > 30 ? D.runSpeed : D.walkSpeed;
      } else if (dist < D.wantDist - 3) {
        // too close: back off while keeping the target in front
        const bx = root.position.x - tx;
        const bz = root.position.z - tz;
        const bl = Math.hypot(bx, bz) || 1;
        goalX = tx + (bx / bl) * D.wantDist;
        goalZ = tz + (bz / bl) * D.wantDist;
        goalY = groundAt(goalX, goalZ);
        wantSpeed = D.walkSpeed * 0.9;
      } else {
        // inside the band: strafe to stay awkward
        strafeT -= dt;
        if (strafeT <= 0) { strafeT = 1.1 + rnd() * 1.7; strafeDir *= -1; }
        const dx = tx - root.position.x;
        const dz = tz - root.position.z;
        const dl = Math.hypot(dx, dz) || 1;
        goalX = root.position.x + (-dz / dl) * strafeDir * 4;
        goalZ = root.position.z + (dx / dl) * strafeDir * 4;
        goalY = groundAt(goalX, goalZ);
        wantSpeed = D.walkSpeed * 0.55;
      }
    } else {
      // no target: slow wander so the bot never looks frozen
      wanderT -= dt;
      if (wanderT <= 0) { wanderT = 2 + rnd() * 3; wanderYaw = rnd() * 6.283; }
      goalX = root.position.x - Math.sin(wanderYaw) * 4;
      goalZ = root.position.z - Math.cos(wanderYaw) * 4;
      goalY = groundAt(goalX, goalZ);
      wantSpeed = D.walkSpeed * 0.45;
    }

    // ---- path following
    repathT -= dt;
    if (goalX !== null && (repathT <= 0 || !path || pathI >= path.length)) {
      repathTo(goalX, goalZ, goalY);
      repathT = 0.65 + rnd() * 0.35;
    }

    let moveX = 0, moveZ = 0;
    if (path && pathI < path.length) {
      let wp = path[pathI];
      let dx = wp.x - root.position.x;
      let dz = wp.z - root.position.z;
      let d = Math.hypot(dx, dz);
      while (d < 0.55 && pathI < path.length - 1) {
        pathI++;
        wp = path[pathI];
        dx = wp.x - root.position.x;
        dz = wp.z - root.position.z;
        d = Math.hypot(dx, dz);
      }
      if (d > 0.25) { moveX = dx / d; moveZ = dz / d; }
      else if (pathI >= path.length - 1) path = null;
    }

    // keep a personal-space bubble (bots should not stack into one mesh)
    for (const t of targets) {
      if (!t || t.id === id) continue;
      const dx = root.position.x - (t.x || 0);
      const dz = root.position.z - (t.z || 0);
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.0001 && d2 < 1.44) {
        const d = Math.sqrt(d2);
        moveX += (dx / d) * 0.5;
        moveZ += (dz / d) * 0.5;
      }
    }
    const ml = Math.hypot(moveX, moveZ);
    if (ml > 0.001) { moveX /= ml; moveZ /= ml; }

    speed += (wantSpeed * (ml > 0.001 ? 1 : 0) - speed) * Math.min(1, dt * 6);
    const moving = speed > 0.35;
    if (speed > 0.02) {
      root.position.x += moveX * speed * dt;
      root.position.z += moveZ * speed * dt;
      resolveCollision();
    }
    if (dt > 1e-4) {
      velX = clamp((root.position.x - ox) / dt, -6, 6);
      velZ = clamp((root.position.z - oz) / dt, -6, 6);
    }

    // ---- facing: target when engaging, movement otherwise
    const tx = target ? target.x : root.position.x;
    const tz = target ? target.z : root.position.z;
    let faceYaw;
    if (target && (dist < D.fireRange + 6 || !moving)) faceYaw = Math.atan2(-(tx - root.position.x), -(tz - root.position.z));
    else if (moving) faceYaw = Math.atan2(-moveX, -moveZ);
    else faceYaw = yaw;
    yaw += wrapPi(faceYaw - yaw) * Math.min(1, dt * 7);
    root.rotation.y = yaw;

    // ---- LOS + firing
    let los = false;
    let aimPitch = 0;
    if (target) {
      const eyeY = baseY + EYE_Y;
      _v1.set(root.position.x, eyeY, root.position.z);
      _v2.set(tx, (target.y || 0) + 1.2, tz);
      aimPitch = Math.atan2(_v2.y - eyeY, Math.max(1, dist));
      los = hasLOS(_v1, _v2);
      const aligned = Math.abs(wrapPi(Math.atan2(-(tx - root.position.x), -(tz - root.position.z)) - yaw)) < 0.5;
      if (los && aligned && dist < D.fireRange) state = 'engage';
      else if (state !== 'cover') state = 'pursue';

      fireCd -= dt;
      if (los && aligned && dist < D.fireRange && state !== 'cover') {
        if (burstLeft <= 0 && fireCd <= 0) {
          burstLeft = D.burstMin + Math.floor(rnd() * (D.burstMax - D.burstMin + 1));
          burstT = 0;
        }
      }
      if (burstLeft > 0) {
        burstT -= dt;
        if (burstT <= 0) {
          rig.weaponMuzzle.getWorldPosition(_mz);
          fireRound(ctx, target, _mz);
          burstLeft--;
          burstT = D.burstGap;
          if (burstLeft <= 0) fireCd = D.burstPause;
        }
      }
      // aim/look smoothing
      const lookTarget = alignYawTo(root.position, tx, tz);
      lookYawS += (clamp(wrapPi(lookTarget - yaw), -0.9, 0.9) - lookYawS) * Math.min(1, dt * 6);
      aimPitchS += (aimPitch - aimPitchS) * Math.min(1, dt * 6);
    } else {
      lookYawS += (0 - lookYawS) * Math.min(1, dt * 4);
    }

    const wantAim = target && los ? 1 : 0.35;
    aimBlend += (wantAim - aimBlend) * Math.min(1, dt * 6);
    weaponLevel += (((burstLeft > 0) ? 1 : 0) - weaponLevel) * Math.min(1, dt * 12);
    const swing = moving ? Math.min(1.2, 0.5 + speed * 0.24) : 0;
    walkAmp += (swing - walkAmp) * Math.min(1, dt * 7);
    walkT += dt * (moving ? (2.4 + speed * 2.2) : 0.85);

    applyBodyPose();
  }

  function alignYawTo(pos, tx, tz) {
    return Math.atan2(-(tx - pos.x), -(tz - pos.z));
  }

  /* --------------------------------------------------------------- public */
  const api = {
    id,
    name: name || `BOT-${id}`,
    root,
    hitboxes,
    get hp() { return hp; },
    set hp(v) { hp = v; },
    get alive() { return alive; },
    get pos() { return root.position; },
    get state() { return state; },
    get targetId() { return targetId; },
    get baseY() { return baseY; },
    get speed() { return speed; },
    get ragdollInfo() {
      return ragdoll
        ? { bodies: ragdoll.bodies.length, cons: ragdoll.cons.length, t: +ragdoll.t.toFixed(2), done: ragdoll.done }
        : null;
    },
    get corpseT() { return +corpseT.toFixed(2); },
    spawn,
    update,
    takeDamage,
    die,
    setVisible(v) { root.visible = !!v; },
    dispose() {
      scene.remove(root);
      for (const h of hitboxes) {
        if (h.parent) h.parent.remove(h);
        h.geometry.dispose();
      }
      hitboxes.length = 0;
      rig.dispose();
    },
  };
  // build after `api` exists: each hit volume stores userData.enemy = api
  buildHitboxes();
  return api;
}
