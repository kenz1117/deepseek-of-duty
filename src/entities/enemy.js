import * as THREE from 'three';
import { buildSoldier, applyPose } from './soldierParts.js';

/* =========================================================================
   Enemy soldier — AI (advance / engage / cover, suppression, burst fire)
   plus layered procedural gear and a two-segment IK-animated body driven by
   soldierParts.js. Public API is unchanged for main.js.
   ========================================================================= */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// one shared invisible material for every hit volume
const HB_MAT = new THREE.MeshBasicMaterial();

// variants cycle deterministically so screenshots and squads stay varied
let _variantCounter = 0;

const EYE_Y = 1.685;
const CHEST_Y = 1.30;
// animated leg segment lengths (mirrors soldierParts.js)
const THIGH_SIZE = 0.435;
const SHIN_SIZE = 0.395;

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
const clamp = THREE.MathUtils.clamp;

export class Enemy {
  constructor(scene, mats, colliders, rnd) {
    this.scene = scene;
    this.mats = mats;
    this.colliders = colliders;
    this.rnd = rnd || Math.random;

    this.hp = 100;
    this.alive = true;
    this.state = 'advance';
    this.walkT = Math.random() * 10;
    this.speed = 0;
    this.deathT = 0;
    this.flinch = 0;
    this.recoil = 0;
    this.canSee = false;
    this.sightTimer = Math.random() * 0.3;
    this.burstLeft = 0;
    this.fireTimer = 0.8 + Math.random() * 1.2;
    this.strafeDir = Math.random() > 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 2;
    this.repositionTimer = 3 + Math.random() * 3;
    this.crouch = 0;
    this.coverPoint = null;
    this.coverTimer = 0;
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.idleTime = 0;
    this.lastDamage = 0;

    this.aimBlend = 1;
    this.weaponLevel = 0;
    this.walkAmp = 0;
    this.headYawS = 0;
    this.aimPitchS = 0;
    this.animT = Math.random() * 6;
    this.weaponFlashT = 0;
    this.deathSide = 1;
    this.deathFall = 1;
    this.deathPose = { l: 0.5, r: 0.5 };

    this.variant = _variantCounter++ % 3;
    this.rig = buildSoldier(mats, this.variant);

    this.root = new THREE.Group();
    this.root.position.set(0, 0, 0);
    this.root.add(this.rig.root);
    scene.add(this.root);

    // convenience aliases
    this.body = this.rig.root;
    this.hips = this.rig.hips;
    this.torso = this.rig.torso;
    this.headPivot = this.rig.headPivot;
    this.armL = this.rig.armL;
    this.armR = this.rig.armR;
    this.legL = this.rig.legL;
    this.legR = this.rig.legR;
    this.weapon = this.rig.weapon;
    this.weaponMuzzle = this.rig.weaponMuzzle;
    this.weaponFlash = this.rig.weaponFlash;

    this.hitboxes = [];
    this.buildHitboxes();
    this.restPose();
  }

  /* ------------------------------------------------------------ hitboxes */
  buildHitboxes() {
    const mk = (w, h, d, parent, x, y, z, part, dmg) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), HB_MAT);
      m.position.set(x, y, z);
      m.visible = false;
      m.userData = { enemy: this, part, dmg };
      parent.add(m);
      this.hitboxes.push(m);
      return m;
    };
    // head follows the helmet + face, tight enough that helmet shots connect
    this.headBox = mk(0.218, 0.256, 0.215, this.rig.headPivot, 0, 0.161, -0.005, 'head', 3.6);
    // short neck volume closes the head/torso gap (counts as torso, not a headshot)
    this.neckBox = mk(0.17, 0.14, 0.17, this.rig.torso, 0, 0.49, 0, 'torso', 1.0);
    this.torsoBox = mk(0.445, 0.40, 0.31, this.rig.torso, 0, 0.255, 0, 'torso', 1.0);
    this.hipBox = mk(0.36, 0.26, 0.27, this.rig.hips, 0, 0.055, 0, 'torso', 0.9);
    this.armLBox = mk(0.135, 0.29, 0.155, this.rig.armL.shoulder, 0, -0.155, 0, 'arms', 0.6);
    this.armRBox = mk(0.135, 0.29, 0.155, this.rig.armR.shoulder, 0, -0.155, 0, 'arms', 0.6);
    this.foreLBox = mk(0.12, 0.25, 0.14, this.rig.armL.elbow, 0, -0.13, 0, 'arms', 0.6);
    this.foreRBox = mk(0.12, 0.25, 0.14, this.rig.armR.elbow, 0, -0.13, 0, 'arms', 0.6);
    this.legLBox = mk(0.165, THIGH_SIZE, 0.195, this.rig.legL.hip, 0, -THIGH_SIZE * 0.5, 0, 'legs', 0.7);
    this.legRBox = mk(0.165, THIGH_SIZE, 0.195, this.rig.legR.hip, 0, -THIGH_SIZE * 0.5, 0, 'legs', 0.7);
    this.shinLBox = mk(0.148, SHIN_SIZE, 0.178, this.rig.legL.knee, 0, -SHIN_SIZE * 0.5, 0, 'legs', 0.65);
    this.shinRBox = mk(0.148, SHIN_SIZE, 0.178, this.rig.legR.knee, 0, -SHIN_SIZE * 0.5, 0, 'legs', 0.65);
    this.footLBox = mk(0.135, 0.115, 0.30, this.rig.legL.ankle, 0, -0.05, -0.055, 'legs', 0.55);
    this.footRBox = mk(0.135, 0.115, 0.30, this.rig.legR.ankle, 0, -0.05, -0.055, 'legs', 0.55);
  }

  /* --------------------------------------------------------------- posing */
  restPose() {
    applyPose(this.rig, {
      time: 0,
      crouch: 0.10,
      walkAmp: 0,
      walkPhase: 0,
      aim: 1,
      weaponLevel: 0,
      aimPitch: 0,
      lookYaw: 0,
      flinch: 0,
      recoil: 0,
      limp: 0,
    });
  }

  applyBodyPose(dt, opts = {}) {
    applyPose(this.rig, {
      time: this.animT,
      crouch: this.crouch,
      walkAmp: this.walkAmp,
      walkPhase: this.walkT,
      aim: this.aimBlend,
      weaponLevel: this.weaponLevel,
      aimPitch: this.aimPitchS,
      lookYaw: this.headYawS,
      flinch: this.flinch,
      recoil: this.recoil,
      limp: opts.limp || 0,
      headRoll: opts.headRoll || 0,
      deathSide: this.deathSide,
      flinchSide: this.lastHitSide || 1,
    });
  }

  /* --------------------------------------------------------------- spawning */
  spawn(x, z, yaw = 0) {
    this.root.position.set(x, 0, z);
    this.root.rotation.set(0, yaw, 0);
    this.hp = 100;
    this.alive = true;
    this.state = 'advance';
    this.deathT = 0;
    this.burstLeft = 0;
    this.fireTimer = 0.6 + Math.random() * 1.4;
    this.crouch = 0.10;
    this.flinch = 0;
    this.recoil = 0;
    this.speed = 0;
    this.walkAmp = 0;
    this.aimBlend = 1;
    this.weaponLevel = 0;
    this.headYawS = 0;
    this.aimPitchS = 0;
    this.aimPitch = 0;
    this.walkT = Math.random() * 6;
    this.animT = 0;
    // full AI state reset: main.js recycles dead Enemy instances
    this.coverPoint = null;
    this.coverTimer = 0;
    this.canSee = false;
    this.sightTimer = Math.random() * 0.3;
    this.lastDamage = 0;
    this.burstLeft = 0;
    this.aimYaw = 0;
    this.idleTime = 0;
    this.strafeDir = this.rnd() > 0.5 ? 1 : -1;
    this.strafeTimer = 1 + this.rnd() * 2;
    this.repositionTimer = 3 + this.rnd() * 3;
    this.deathFall = 1;
    this.deathSide = 1;
    this.deathTwist = 0;
    this.weaponFlashT = 0;
    this.weaponFlash.material.opacity = 0;
    this.weapon.visible = true;
    for (const h of this.hitboxes) h.visible = false;
    this.restPose();
  }

  get eyePos() {
    return _v1.set(this.root.position.x, EYE_Y + this.root.position.y, this.root.position.z);
  }

  /* ---------------------------------------------------------------- damage */
  /** returns true if this damage killed */
  takeDamage(amount, point, normal, part = 'torso') {
    if (!this.alive) return false;
    this.hp -= amount;
    this.flinch = Math.min(1, this.flinch + 0.55);
    this.lastDamage = 0.5;
    if (part === 'arms') this.flinch *= 0.7;
    if (point) {
      // remember which side the hit came from so the body twists away from it
      const dx = point.x - this.root.position.x;
      const dz = point.z - this.root.position.z;
      const local = Math.atan2(dx, dz) - this.root.rotation.y;
      this.lastHitSide = Math.sin(local) > 0 ? 1 : -1;
    }
    if (this.hp <= 0) {
      this.die(point, normal);
      return true;
    }
    if (this.state === 'advance') this.state = 'engage';
    return false;
  }

  die(point, normal) {
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.deathFall = this.rnd() > 0.42 ? 1 : -1;
    this.deathSide = this.rnd() > 0.5 ? 1 : -1;
    this.deathTwist = (this.rnd() - 0.5) * 1.1;
    this.deathPose = { l: this.rnd(), r: this.rnd() };
    this.speed = 0;
    this.walkAmp = 0;
    this.crouch = 0;
    this.weapon.visible = true;
    for (const h of this.hitboxes) h.visible = false;
    void point; void normal;
  }

  /* --------------------------------------------------------------- vision */
  canSeePlayer(playerPos) {
    const a = this.eyePos.clone();
    const b = playerPos.clone();
    const dx = b.x - a.x, dz = b.z - a.z;
    const steps = Math.max(2, Math.floor(Math.hypot(dx, dz) / 1.2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      for (const c of this.colliders) {
        if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) return false;
      }
    }
    return true;
  }

  resolveCollision() {
    const p = this.root.position;
    const r = 0.34;
    for (const c of this.colliders) {
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
    p.x = clamp(p.x, -20, 20);
    p.z = clamp(p.z, -63, 50);
  }

  /* --------------------------------------------------------------- update */
  update(dt, ctx) {
    const playerPos = ctx.playerPos;
    this.animT += dt;

    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }

    this.flinch = Math.max(0, this.flinch - dt * 2.8);
    this.recoil = Math.max(0, this.recoil - dt * 6.0);
    this.lastDamage = Math.max(0, this.lastDamage - dt);
    this.weaponFlashT = Math.max(0, this.weaponFlashT - dt);
    this.weaponFlash.material.opacity = this.weaponFlashT > 0 ? 1 : 0;

    // ---- perception (throttled)
    this.sightTimer -= dt;
    if (this.sightTimer <= 0) {
      this.sightTimer = 0.16 + Math.random() * 0.12;
      this.canSee = this.canSeePlayer(playerPos);
    }

    const toPlayer = _v2.set(playerPos.x - this.root.position.x, 0, playerPos.z - this.root.position.z);
    const dist = toPlayer.length();
    const dir = toPlayer.clone().normalize();

    // ---- state selection
    if (this.hp < 38 && this.lastDamage > 0 && this.state !== 'cover') {
      const cp = this.nearestCover(ctx.coverPoints, playerPos);
      if (cp) {
        this.coverPoint = cp;
        this.state = 'cover';
        this.coverTimer = 2.2 + Math.random() * 2.0;
      }
    }
    if (this.state === 'cover') {
      this.coverTimer -= dt;
      if (this.coverTimer <= 0) { this.state = this.canSee ? 'engage' : 'advance'; this.coverPoint = null; }
    } else if (this.state !== 'dead') {
      if (this.canSee && dist < 48) this.state = 'engage';
      else this.state = 'advance';
    }
    if (this.state === 'engage' && dist > 52) this.state = 'advance';

    // ---- movement
    let moveX = 0, moveZ = 0;
    let speedTarget = 0;
    if (this.state === 'advance') {
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) { this.strafeTimer = 1.4 + Math.random() * 2.2; this.strafeDir *= -1; }
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.strafeDir * 0.55);
      _v3.copy(dir).add(side).normalize();
      moveX = _v3.x; moveZ = _v3.z;
      speedTarget = 3.3;
    } else if (this.state === 'engage') {
      this.repositionTimer -= dt;
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) { this.strafeTimer = 1.0 + Math.random() * 1.6; this.strafeDir *= -1; }
      const want = 15;
      const push = dist > want + 6 ? 1 : dist < want - 6 ? -1 : 0;
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.strafeDir);
      _v3.copy(dir).multiplyScalar(push).add(side.multiplyScalar(0.7)).normalize();
      moveX = _v3.x * 0.66; moveZ = _v3.z * 0.66;
      speedTarget = dist > 32 ? 2.4 : 1.15;
      if (dist < 9) { moveX = -dir.x; moveZ = -dir.z; speedTarget = 2.1; }
    } else if (this.state === 'cover' && this.coverPoint) {
      const cx = this.coverPoint.x - this.root.position.x;
      const cz = this.coverPoint.z - this.root.position.z;
      const cd = Math.hypot(cx, cz);
      if (cd > 0.7) { moveX = cx / cd; moveZ = cz / cd; speedTarget = 3.4; }
      else speedTarget = 0;
    }

    this.speed += (speedTarget - this.speed) * Math.min(1, dt * 6);
    const moving = this.speed > 0.35;
    if (this.speed > 0.02) {
      this.root.position.x += moveX * this.speed * dt;
      this.root.position.z += moveZ * this.speed * dt;
      this.resolveCollision();
    }

    // ---- facing: face the movement when advancing, the player when engaging
    let faceYaw;
    if (this.state === 'advance' && this.speed > 0.3) {
      faceYaw = Math.atan2(-moveX, -moveZ);
    } else {
      faceYaw = Math.atan2(-dir.x, -dir.z);
    }
    const dy = wrapPi(faceYaw - this.root.rotation.y);
    this.root.rotation.y += dy * Math.min(1, dt * (this.state === 'engage' ? 7 : 4.5));

    // ---- aim / look
    const targetYaw = Math.atan2(-dir.x, -dir.z);
    const lookErr = wrapPi(targetYaw - this.root.rotation.y);
    const headTarget = clamp(lookErr * 0.8, -0.95, 0.95);
    this.headYawS += (headTarget - this.headYawS) * Math.min(1, dt * 5.5);
    const playerEye = playerPos.y != null ? playerPos.y : CHEST_Y;
    const pitchTarget = Math.atan2(playerEye - (this.root.position.y + EYE_Y), Math.max(0.8, dist));
    this.aimPitchS += (pitchTarget - this.aimPitchS) * Math.min(1, dt * 5);
    this.aimPitch = this.aimPitchS;

    // ---- blends
    const crouchTarget = this.state === 'cover' ? 1 : (this.state === 'engage' && this.hp < 62 ? 0.34 : 0);
    this.crouch += (crouchTarget - this.crouch) * Math.min(1, dt * 5);

    const swingTarget = moving ? Math.min(1.2, 0.5 + this.speed * 0.24) : 0;
    this.walkAmp += (swingTarget - this.walkAmp) * Math.min(1, dt * 7);
    this.walkT += dt * (moving ? (2.4 + this.speed * 2.2) : 0.85);

    const wantAim = (this.state === 'engage' || this.state === 'cover') && this.canSee ? 1 : 0;
    this.aimBlend += (wantAim - this.aimBlend) * Math.min(1, dt * 5.5);

    const levelTarget = this.burstLeft > 0 ? 1 : 0;
    this.weaponLevel += (levelTarget - this.weaponLevel) * Math.min(1, dt * 12);

    this.applyBodyPose(dt);

    // ---- shooting
    if (this.state === 'engage' && this.canSee && ctx.playerAlive) {
      this.fireTimer -= dt;
      if (this.burstLeft > 0) {
        if (this.fireTimer <= 0) {
          this.shoot(ctx, dist, playerPos);
          this.burstLeft--;
          this.fireTimer = 0.085 + Math.random() * 0.05;
        }
      } else if (this.fireTimer <= 0) {
        this.burstLeft = 3 + Math.floor(Math.random() * 4);
        this.fireTimer = 0.3 + Math.random() * 0.35;
      }
    } else if (this.burstLeft > 0) {
      this.burstLeft = 0;
    }
  }

  /* --------------------------------------------------------- death anim */
  updateDeath(dt) {
    this.deathT = Math.min(1, this.deathT + dt * 1.35);
    const e = this.deathT * this.deathT * (3 - 2 * this.deathT);
    const fall = this.deathFall;
    const angle = (Math.PI * 0.5 - 0.06) * fall;
    // a touch of buckle before the body goes over
    const buckle = Math.sin(Math.min(1, this.deathT * 2.2) * Math.PI) * 0.09;
    this.root.rotation.x = angle * e - buckle * (1 - e);
    this.root.rotation.z = this.deathTwist * 0.55 * e;
    this.root.position.y = 0.075 * e;

    // limbs go limp as the body drops
    applyPose(this.rig, {
      time: this.animT,
      crouch: 0,
      walkAmp: 0,
      walkPhase: this.deathPose.l * 2,
      aim: 0.25 * (1 - e),
      weaponLevel: 0,
      aimPitch: -0.1,
      lookYaw: 0,
      flinch: 0,
      recoil: 0,
      limp: e,
      headRoll: 0.35 * e * this.deathSide,
      deathSide: this.deathSide,
    });

    // settle: the body lies on its side/back instead of sinking in the road
    if (this.deathT >= 1) this.root.position.y = 0.08;
    this.weaponFlash.material.opacity = 0;
  }

  /* --------------------------------------------------------------- combat */
  shoot(ctx, dist, playerPos) {
    this.weaponFlashT = 0.05;
    this.weaponFlash.material.opacity = 1;
    this.weaponFlash.material.rotation = Math.random() * 6;
    this.weaponFlash.scale.setScalar(0.18 + Math.random() * 0.1);
    this.recoil = 0.85;
    this.weaponLevel = 1;

    const muzzle = new THREE.Vector3();
    this.weaponMuzzle.getWorldPosition(muzzle);

    const playerSpeed = ctx.playerSpeed || 0;
    const baseErr = 0.32 + dist * 0.020 + playerSpeed * 0.05;
    const spread = new THREE.Vector3(
      (Math.random() - 0.5) * baseErr,
      (Math.random() - 0.5) * baseErr * 0.7,
      (Math.random() - 0.5) * baseErr
    );
    const target = playerPos.clone().add(spread);
    const hitChance = clamp(0.72 - dist * 0.011 - playerSpeed * 0.035, 0.12, 0.72);
    const hit = Math.random() < hitChance;

    const endpoint = hit
      ? playerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.25, -0.15, (Math.random() - 0.5) * 0.25))
      : target;
    ctx.fx.tracer(muzzle, endpoint, { color: 0xffc98a, width: 0.03, life: 0.05 });
    ctx.fx.muzzleFlash(muzzle);
    if (hit) ctx.damagePlayer(4.5 + Math.random() * 2.5, this.root.position);

    const pan = ctx.panFor ? ctx.panFor(this.root.position) : 0;
    ctx.audio.enemyShot(pan, dist);
    if (ctx.onEnemyFire) ctx.onEnemyFire(this.root.position, this);
    if (!hit && dist < 26 && Math.random() > 0.5) ctx.audio.whiz(pan);
  }

  nearestCover(coverPoints, playerPos) {
    let best = null, bestScore = Infinity;
    for (const cp of coverPoints) {
      const d = Math.hypot(cp.x - this.root.position.x, cp.z - this.root.position.z);
      if (d > 14) continue;
      const toPlayer = Math.hypot(cp.x - playerPos.x, cp.z - playerPos.z);
      const score = d * 0.6 - toPlayer * 0.25 + Math.random() * 2;
      if (score < bestScore) { bestScore = score; best = cp; }
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.root);
    this.rig.dispose();
  }
}
