import * as THREE from 'three';
import { buildSoldier, applyPose } from './soldierParts.js';

/* =========================================================================
   Enemy soldier — four archetypes on one rig:
     rifleman  baseline burst-fire soldier
     rusher    fast, low HP, close-range shotgun, flanks, never takes cover
     shield    slow, ballistic shield blocks frontal damage (flank / head)
     sniper    long range, laser + lens warning, one heavy shot, then relocates
   The public API used by main.js (constructor / spawn / update / takeDamage /
   alive / hitboxes / die / dispose) is unchanged; setArchetype() is additive.
   ========================================================================= */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// one shared invisible material for every hit volume
const HB_MAT = new THREE.MeshBasicMaterial();

// variants cycle deterministically so screenshots and squads stay varied
let _variantCounter = 0;

const EYE_Y = 1.685;
const CHEST_Y = 1.30;
// animated leg segment lengths (mirrors soldierParts.js)
const THIGH_SIZE = 0.435;
const SHIN_SIZE = 0.395;

/* ------------------------------------------------------------ archetypes */

const ARCHETYPES = {
  rifleman: {
    label: 'rifleman',
    hp: 100,
    advanceSpeed: 3.3,
    engageSpeed: 1.15,
    wantDist: 15,
    fireRange: 48, engageRange: 48,
    burstMin: 3, burstMax: 6, burstGap: 0.09, burstPause: 0.3,
    shotDamage: [4.5, 7.0],
    hitBase: 0.72, hitFalloff: 0.011, hitSpeedFalloff: 0.035,
    useCover: true, coverHp: 38,
    crouchEngage: 0,
    firstShot: 0.8,
    stagger: 0,
  },
  rusher: {
    label: 'rusher',
    hp: 58,
    advanceSpeed: 5.4,
    engageSpeed: 4.7,
    wantDist: 3.0,
    fireRange: 13, engageRange: 34,
    fireInterval: 0.95,
    shotDamage: [12, 18],
    hitBase: 0.94, hitFalloff: 0.05, hitSpeedFalloff: 0.02,
    useCover: false, coverHp: 0,
    crouchEngage: 0,
    firstShot: 0.7,
    flank: 0.95,
  },
  shield: {
    label: 'shield',
    hp: 150,
    advanceSpeed: 1.55,
    engageSpeed: 2.1,
    wantDist: 11,
    fireRange: 42, engageRange: 44,
    burstMin: 2, burstMax: 4, burstGap: 0.13, burstPause: 0.5,
    shotDamage: [2.6, 4.4],
    hitBase: 0.55, hitFalloff: 0.008, hitSpeedFalloff: 0.03,
    useCover: false, coverHp: 0,
    crouchEngage: 0.45,
    firstShot: 1.2,
    frontDamage: 0.15,
  },
  sniper: {
    label: 'sniper',
    hp: 82,
    advanceSpeed: 2.4,
    engageSpeed: 1.7,
    wantDist: 34,
    fireRange: 82, engageRange: 95,
    shotDamage: [38, 48],
    hitBase: 0.93, hitFalloff: 0.0025, hitSpeedFalloff: 0.015,
    useCover: false, coverHp: 0,
    crouchEngage: 0.55,
    firstShot: 1.6,
    warnTime: 0.9,
    cooldown: 3.6,
    relocTime: 1.5,
  },
};

export const ARCHETYPE_TYPES = Object.keys(ARCHETYPES);

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

    this.archetype = 'rifleman';
    this.def = ARCHETYPES.rifleman;
    this.maxHp = this.def.hp;

    this.hp = this.maxHp;
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
    this.repositionT = 0;
    this.warnT = 0;
    this.warnActive = false;
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

    // vertical placement (roof / platform support)
    this.baseY = 0;
    this.bounds = null;
    this.pinned = false;

    this.variant = _variantCounter++ % 3;
    this.rig = null;
    this.laser = null;
    this.glint = null;
    this.hitboxes = [];

    this.root = new THREE.Group();
    this.root.position.set(0, 0, 0);
    scene.add(this.root);

    this.rebuildVisual();
    this.restPose();
  }

  /* ------------------------------------------------------------ archetype */
  /**
   * Switch archetype. Safe before or after spawn(): rebuilds the visual,
   * hit volumes and combat profile, and resets hp / speed / damage / timers /
   * behaviour. Position and facing are preserved.
   */
  setArchetype(type) {
    const t = ARCHETYPES[type] ? type : 'rifleman';
    this.archetype = t;
    this.def = ARCHETYPES[t];
    this.maxHp = this.def.hp;

    // full combat reset (spawn() will also call this path-safe reset)
    this.hp = this.maxHp;
    this.state = 'advance';
    this.flinch = 0;
    this.recoil = 0;
    this.speed = 0;
    this.walkAmp = 0;
    this.walkT = this.rnd() * 6;
    this.aimBlend = 1;
    this.weaponLevel = 0;
    this.burstLeft = 0;
    this.warnT = 0;
    this.warnActive = false;
    this.repositionT = 0;
    this.fireTimer = this.def.firstShot;
    this.canSee = false;
    this.sightTimer = this.rnd() * 0.3;
    this.coverPoint = null;
    this.coverTimer = 0;
    this.crouch = 0.1;
    this.headYawS = 0;
    this.aimPitchS = 0;
    this.aimPitch = 0;
    this.lastDamage = 0;
    this.weaponFlashT = 0;

    this.rebuildVisual();

    if (this.alive) {
      this.deathT = 0;
      this.root.rotation.set(0, this.root.rotation.y, 0);
      this.restPose();
    } else {
      this.applyDeathPose();
    }
    return this;
  }

  /* ------------------------------------------------------- placement API */
  /**
   * Confine the AI to a horizontal rectangle (a roof / catwalk). Pass
   * `pinned: true` to keep it in place and only aim + fire.
   * Safe before or after spawn(); spawn() keeps bounds unless cleared.
   */
  setBounds(b) {
    if (!b) return this.clearBounds();
    const n = (v, d) => (Number.isFinite(v) ? v : d);
    const px = this.root.position.x;
    const pz = this.root.position.z;
    const ax = n(b.x0, px), bx = n(b.x1, px);
    const az = n(b.z0, pz), bz = n(b.z1, pz);
    this.bounds = {
      x0: Math.min(ax, bx), x1: Math.max(ax, bx),
      z0: Math.min(az, bz), z1: Math.max(az, bz),
    };
    this.pinned = !!b.pinned;
    this.clampToBounds();
    return this;
  }

  clearBounds() {
    this.bounds = null;
    this.pinned = false;
    return this;
  }

  setPinned(v) {
    this.pinned = !!v;
    return this;
  }

  clampToBounds() {
    const b = this.bounds;
    if (!b) return;
    const p = this.root.position;
    p.x = clamp(p.x, b.x0, b.x1);
    p.z = clamp(p.z, b.z0, b.z1);
  }

  /* --------------------------------------------------------------- visuals */
  rebuildVisual() {
    if (this.rig) {
      this.root.remove(this.rig.root);
      this.rig.dispose();
      this.rig = null;
    }
    this.rig = buildSoldier(this.mats, this.variant, this.archetype);
    this.root.add(this.rig.root);

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
    this.weaponFlash.material.opacity = 0;

    this.setupOverlays();
    this.buildHitboxes();
  }

  /** sniper laser + scope glint (no lights) */
  setupOverlays() {
    if (this.laser) {
      this.scene.remove(this.laser);
      this.laser.geometry.dispose();
      this.laser.material.dispose();
      this.laser = null;
    }
    if (this.glint) {
      if (this.glint.parent) this.glint.parent.remove(this.glint);
      this.glint.material.dispose();
      this.glint = null;
    }
    if (this.archetype !== 'sniper') return;

    // thin additive beam (no light source): visible from any angle
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2418, transparent: true, opacity: 0,
      depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    });
    this.laser = new THREE.Mesh(geo, mat);
    this.laser.frustumCulled = false;
    this.laser.visible = false;
    this.scene.add(this.laser);

    this.glint = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.mats.sprites.glow, color: 0xffd9c8, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0,
    }));
    this.glint.scale.setScalar(0.16);
    this.glint.position.copy(this.rig.scopePos);
    this.glint.visible = false;
    this.rig.weapon.add(this.glint);
  }

  buildHitboxes() {
    for (const h of this.hitboxes) {
      if (h.parent) h.parent.remove(h);
      h.geometry.dispose();
    }
    this.hitboxes.length = 0;

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

    // the shield is its own hit volume: bullets hit it before the torso
    if (this.rig.hasShield) {
      this.shieldBox = mk(0.66, 0.84, 0.09, this.rig.torso, 0, 0.15, -0.375, 'shield', 0.05);
    } else {
      this.shieldBox = null;
    }
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

  applyBodyPose() {
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
      limp: 0,
      headRoll: 0,
      deathSide: this.deathSide,
      flinchSide: this.lastHitSide || 1,
    });
  }

  /* --------------------------------------------------------------- spawning */
  spawn(x, z, yaw = 0, y = 0) {
    this.baseY = Number.isFinite(y) ? y : 0;
    this.root.position.set(x, this.baseY, z);
    this.root.rotation.set(0, yaw, 0);
    if (this.bounds) this.clampToBounds();
    this.hp = this.maxHp;
    this.alive = true;
    this.state = 'advance';
    this.deathT = 0;
    this.burstLeft = 0;
    this.fireTimer = this.def.firstShot + Math.random() * 0.6;
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
    this.aimYaw = 0;
    this.idleTime = 0;
    this.strafeDir = this.rnd() > 0.5 ? 1 : -1;
    this.strafeTimer = 1 + this.rnd() * 2;
    this.repositionTimer = 3 + this.rnd() * 3;
    this.repositionT = 0;
    this.warnT = 0;
    this.warnActive = false;
    this.deathFall = 1;
    this.deathSide = 1;
    this.deathTwist = 0;
    this.weaponFlashT = 0;
    this.weaponFlash.material.opacity = 0;
    if (this.laser) this.laser.visible = false;
    if (this.glint) this.glint.visible = false;
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

    let dmg = amount;
    if (this.archetype === 'shield') {
      const boom = !!(normal && normal.y > 0.75);
      if (part === 'shield' && !boom) {
        dmg *= 0.05; // shield face itself
      } else if (part !== 'head' && !boom && point) {
        // frontal cone relative to facing; sides/back take full damage
        const dx = point.x - this.root.position.x;
        const dz = point.z - this.root.position.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          const fx = -Math.sin(this.root.rotation.y);
          const fz = -Math.cos(this.root.rotation.y);
          const cos = (dx / len) * fx + (dz / len) * fz;
          const def = this.def;
          if (cos > 0.5) dmg *= def.frontDamage;
          else if (cos > 0.2) dmg *= 0.55;
        }
      }
    }

    this.hp -= dmg;
    this.flinch = Math.min(1, this.flinch + (part === 'shield' ? 0.12 : 0.55));
    this.lastDamage = 0.5;
    if (part === 'arms') this.flinch *= 0.7;
    if (point) {
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
    this.warnT = 0;
    this.warnActive = false;
    this.weapon.visible = true;
    if (this.laser) this.laser.visible = false;
    if (this.glint) this.glint.visible = false;
    for (const h of this.hitboxes) h.visible = false;
    void point; void normal;
  }

  /* --------------------------------------------------------------- vision */
  canSeePlayer(playerPos) {
    const a = this.eyePos.clone();
    const b = playerPos.clone();
    const dx = b.x - a.x, dz = b.z - a.z;
    const steps = Math.max(2, Math.floor(Math.hypot(dx, dz) / 1.2));
    // an elevated shooter ignores the footprint of the building it stands on
    // (colliders are 2D, so its own roof would otherwise block every shot)
    const elevated = this.baseY > 0.5;
    const px = this.root.position.x, pz = this.root.position.z;
    const host = elevated ? this.colliders.find((c) => px > c.x0 && px < c.x1 && pz > c.z0 && pz < c.z1) : null;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t, z = a.z + dz * t;
      for (const c of this.colliders) {
        if (c === host) continue;
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
    const def = this.def;
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
    if (def.useCover && this.hp < def.coverHp && this.lastDamage > 0 && this.state !== 'cover') {
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
      if (this.canSee && dist < (def.engageRange || 48)) this.state = 'engage';
      else this.state = 'advance';
    }

    // ---- movement
    let moveX = 0, moveZ = 0;
    let speedTarget = 0;
    const sideX = -dir.z, sideZ = dir.x;

    if (this.state === 'advance') {
      if (this.archetype === 'rusher' || (this.archetype === 'rifleman')) {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 1.4 + Math.random() * 2.2; this.strafeDir *= -1; }
        const flare = this.archetype === 'rusher' ? def.flank : 0.55;
        const sx = sideX * this.strafeDir * flare;
        const sz = sideZ * this.strafeDir * flare;
        _v3.set(dir.x + sx, 0, dir.z + sz).normalize();
        moveX = _v3.x; moveZ = _v3.z;
        speedTarget = def.advanceSpeed;
      } else if (this.archetype === 'sniper') {
        // approach until inside firing band
        const push = dist > def.wantDist + 18 ? 1 : 0.25;
        _v3.set(dir.x * push + sideX * this.strafeDir * 0.15, 0,
          dir.z * push + sideZ * this.strafeDir * 0.15).normalize();
        moveX = _v3.x; moveZ = _v3.z;
        speedTarget = def.advanceSpeed;
      } else {
        // shield: straight, slow pressure
        moveX = dir.x; moveZ = dir.z;
        speedTarget = def.advanceSpeed;
      }
    } else if (this.state === 'engage') {
      if (this.archetype === 'rusher') {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 0.9 + Math.random() * 1.2; this.strafeDir *= -1; }
        // charge, then circle at knife range
        const push = dist > 3.2 ? 1 : 0;
        const circle = dist > 3.2 ? 0.35 : 1.0;
        _v3.set(dir.x * push + sideX * this.strafeDir * circle, 0,
          dir.z * push + sideZ * this.strafeDir * circle).normalize();
        moveX = _v3.x; moveZ = _v3.z;
        speedTarget = dist > 3.2 ? def.engageSpeed : 3.0;
      } else if (this.archetype === 'sniper') {
        this.repositionT = Math.max(0, this.repositionT - dt);
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 1.8 + Math.random() * 1.6; this.strafeDir *= -1; }
        if (this.repositionT > 0) {
          // relocate after a shot: fast lateral move
          moveX = sideX * this.strafeDir; moveZ = sideZ * this.strafeDir;
          speedTarget = 3.2;
        } else {
          const push = dist > def.wantDist + 10 ? 1 : dist < def.wantDist - 10 ? -1 : 0;
          _v3.set(dir.x * push + sideX * this.strafeDir * 0.25, 0,
            dir.z * push + sideZ * this.strafeDir * 0.25).normalize();
          moveX = _v3.x; moveZ = _v3.z;
          speedTarget = push !== 0 ? def.engageSpeed : 0.7;
        }
      } else if (this.archetype === 'shield') {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 2.0 + Math.random() * 2.0; this.strafeDir *= -1; }
        if (dist > def.wantDist) {
          moveX = dir.x; moveZ = dir.z;
          speedTarget = def.engageSpeed;
        } else {
          moveX = sideX * this.strafeDir * 0.5; moveZ = sideZ * this.strafeDir * 0.5;
          speedTarget = 0.6;
        }
      } else {
        this.repositionTimer -= dt;
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 1.0 + Math.random() * 1.6; this.strafeDir *= -1; }
        const want = def.wantDist;
        const push = dist > want + 6 ? 1 : dist < want - 6 ? -1 : 0;
        _v3.set(dir.x * push + sideX * this.strafeDir * 0.7, 0,
          dir.z * push + sideZ * this.strafeDir * 0.7).normalize();
        moveX = _v3.x * 0.66; moveZ = _v3.z * 0.66;
        speedTarget = dist > 32 ? 2.4 : 1.15;
        if (dist < 9) { moveX = -dir.x; moveZ = -dir.z; speedTarget = 2.1; }
      }
    } else if (this.state === 'cover' && this.coverPoint) {
      const cx = this.coverPoint.x - this.root.position.x;
      const cz = this.coverPoint.z - this.root.position.z;
      const cd = Math.hypot(cx, cz);
      if (cd > 0.7) { moveX = cx / cd; moveZ = cz / cd; speedTarget = 3.4; }
      else speedTarget = 0;
    }

    if (this.pinned) { moveX = 0; moveZ = 0; speedTarget = 0; }
    this.speed += (speedTarget - this.speed) * Math.min(1, dt * 6);
    const moving = this.speed > 0.35;
    if (this.speed > 0.02) {
      this.root.position.x += moveX * this.speed * dt;
      this.root.position.z += moveZ * this.speed * dt;
      if (this.bounds) this.clampToBounds();
      else if (this.baseY <= 0.5) this.resolveCollision();
      else {
        const p = this.root.position;
        p.x = clamp(p.x, -20, 20);
        p.z = clamp(p.z, -63, 50);
      }
    }

    // ---- facing
    let faceYaw;
    if (this.state === 'advance' && this.speed > 0.3 && this.archetype !== 'sniper') {
      faceYaw = Math.atan2(-moveX, -moveZ);
    } else {
      faceYaw = Math.atan2(-dir.x, -dir.z);
    }
    const dy = wrapPi(faceYaw - this.root.rotation.y);
    const turnRate = this.archetype === 'shield' ? 2.6 : this.state === 'engage' ? 7 : 4.5;
    this.root.rotation.y += dy * Math.min(1, dt * turnRate);

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
    let crouchTarget = 0;
    if (this.state === 'cover') crouchTarget = 1;
    else if (this.state === 'engage') {
      if (this.archetype === 'shield') crouchTarget = def.crouchEngage;
      else if (this.archetype === 'sniper') crouchTarget = this.repositionT > 0 ? 0.12 : def.crouchEngage;
      else if (this.archetype === 'rifleman' && this.hp < 62) crouchTarget = 0.34;
    }
    this.crouch += (crouchTarget - this.crouch) * Math.min(1, dt * 5);

    const swingTarget = moving ? Math.min(1.2, 0.5 + this.speed * 0.24) : 0;
    this.walkAmp += (swingTarget - this.walkAmp) * Math.min(1, dt * 7);
    this.walkT += dt * (moving ? (2.4 + this.speed * 2.2) : 0.85);

    const wantAim = (this.state === 'engage' || this.state === 'cover') && this.canSee ? 1 : 0;
    this.aimBlend += (wantAim - this.aimBlend) * Math.min(1, dt * 5.5);

    const levelTarget = this.burstLeft > 0 || this.warnActive ? 1 : 0;
    this.weaponLevel += (levelTarget - this.weaponLevel) * Math.min(1, dt * 12);

    this.applyBodyPose();

    // ---- shooting
    if (this.archetype === 'sniper') this.updateSniperFire(dt, ctx, dist, playerPos);
    else if (this.archetype === 'rusher') this.updateRusherFire(dt, ctx, dist, playerPos);
    else this.updateBurstFire(dt, ctx, dist, playerPos);

    if (this.archetype === 'sniper') this.updateSniperWarning(playerPos);
  }

  /* -------------------------------------------------------------- firing */
  updateBurstFire(dt, ctx, dist, playerPos) {
    const def = this.def;
    if (this.state === 'engage' && this.canSee && ctx.playerAlive && dist < def.fireRange) {
      this.fireTimer -= dt;
      if (this.burstLeft > 0) {
        if (this.fireTimer <= 0) {
          this.shoot(ctx, dist, playerPos);
          this.burstLeft--;
          this.fireTimer = def.burstGap + Math.random() * 0.05;
        }
      } else if (this.fireTimer <= 0) {
        this.burstLeft = def.burstMin + Math.floor(Math.random() * (def.burstMax - def.burstMin + 1));
        this.fireTimer = def.burstPause + Math.random() * 0.3;
      }
    } else if (this.burstLeft > 0) {
      this.burstLeft = 0;
    }
  }

  updateRusherFire(dt, ctx, dist, playerPos) {
    this.fireTimer -= dt;
    if (this.state !== 'engage' || !this.canSee || !ctx.playerAlive) return;
    if (dist > this.def.fireRange) return;
    if (this.fireTimer <= 0) {
      this.shoot(ctx, dist, playerPos);
      this.fireTimer = this.def.fireInterval * (0.8 + Math.random() * 0.5);
    }
  }

  updateSniperFire(dt, ctx, dist, playerPos) {
    this.fireTimer -= dt;
    const canFire = this.state === 'engage' && this.canSee && ctx.playerAlive && dist < this.def.fireRange;
    if (this.warnT > 0) {
      this.warnT -= dt;
      if (!canFire) {
        this.warnT = 0;
        this.warnActive = false;
      } else if (this.warnT <= 0) {
        this.warnT = 0;
        this.warnActive = false;
        this.shoot(ctx, dist, playerPos);
        this.fireTimer = this.def.cooldown * (0.85 + this.rnd() * 0.4);
        this.repositionT = this.def.relocTime;
        this.strafeDir *= -1;
      }
    } else if (canFire && this.fireTimer <= 0 && this.repositionT <= 0) {
      this.warnT = this.def.warnTime;
      this.warnActive = true;
    }
  }

  updateSniperWarning(playerPos) {
    if (!this.laser) return;
    const active = this.warnActive && this.canSee && this.alive;
    this.laser.visible = active;
    if (this.glint) this.glint.visible = active;
    if (!active) return;

    this.weaponMuzzle.getWorldPosition(_v1);
    _v2.set(playerPos.x, playerPos.y - 0.12, playerPos.z).sub(_v1);
    const len = _v2.length();
    this.laser.position.copy(_v1);
    this.laser.scale.set(0.011, Math.max(0.01, len), 0.011);
    this.laser.quaternion.setFromUnitVectors(_up, _v2.divideScalar(len || 1));
    const flick = 0.62 + 0.32 * Math.sin(this.animT * 46);
    this.laser.material.opacity = this.warnT < 0.28 ? flick : flick * 0.68;
    this.laser.material.color.setHex(this.warnT < 0.28 ? 0xff7a4a : 0xff2418);
    if (this.glint) {
      this.glint.material.opacity = 0.6 + 0.4 * Math.sin(this.animT * 11);
      this.glint.scale.setScalar(0.14 + 0.05 * Math.sin(this.animT * 17));
    }
  }

  /* --------------------------------------------------------- death anim */
  updateDeath(dt) {
    this.deathT = Math.min(1, this.deathT + dt * 1.35);
    this.applyDeathPose();
  }

  applyDeathPose() {
    const e = this.deathT * this.deathT * (3 - 2 * this.deathT);
    const fall = this.deathFall;
    const angle = (Math.PI * 0.5 - 0.06) * fall;
    const buckle = Math.sin(Math.min(1, this.deathT * 2.2) * Math.PI) * 0.09;
    this.root.rotation.x = angle * e - buckle * (1 - e);
    this.root.rotation.z = this.deathTwist * 0.55 * e;
    this.root.position.y = this.baseY + 0.075 * e;

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

    if (this.deathT >= 1) this.root.position.y = this.baseY + 0.08;
    this.weaponFlash.material.opacity = 0;
    if (this.laser) this.laser.visible = false;
    if (this.glint) this.glint.visible = false;
  }

  /* --------------------------------------------------------------- combat */
  shoot(ctx, dist, playerPos) {
    const def = this.def;
    this.weaponFlashT = 0.05;
    this.weaponFlash.material.opacity = 1;
    this.weaponFlash.material.rotation = Math.random() * 6;
    this.weaponFlash.scale.setScalar(
      this.archetype === 'rusher' ? 0.26 + Math.random() * 0.12
        : this.archetype === 'sniper' ? 0.22 + Math.random() * 0.08
          : 0.18 + Math.random() * 0.1
    );
    this.recoil = this.archetype === 'sniper' ? 1 : this.archetype === 'rusher' ? 0.9 : 0.85;

    const muzzle = new THREE.Vector3();
    this.weaponMuzzle.getWorldPosition(muzzle);

    const playerSpeed = ctx.playerSpeed || 0;
    const hitChance = clamp(
      def.hitBase - dist * def.hitFalloff - playerSpeed * def.hitSpeedFalloff,
      0.12, 0.95
    );
    const hit = Math.random() < hitChance;
    const pan = ctx.panFor ? ctx.panFor(this.root.position) : 0;

    if (this.archetype === 'rusher') {
      /* shotgun: several pellets, brutal up close, useless far away */
      const falloff = clamp(1 - dist / (def.fireRange + 3), 0.1, 1);
      const dmg = (def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0])) * (0.35 + 0.65 * falloff);
      const end = hit
        ? playerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, -0.12, (Math.random() - 0.5) * 0.3))
        : playerPos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * (0.5 + dist * 0.06), (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.5));
      for (let i = 0; i < 5; i++) {
        const e = i === 2 ? end : end.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 0.55, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.55));
        ctx.fx.tracer(muzzle, e, { color: 0xffd2a0, width: 0.022, life: 0.045 });
      }
      ctx.fx.muzzleFlash(muzzle);
      if (hit) {
        ctx.damagePlayer(dmg, this.root.position);
      }
      ctx.audio.enemyShot(pan, dist);
      this.weaponLevel = 1;
      if (!hit && dist < 20 && Math.random() > 0.4) ctx.audio.whiz(pan);
      if (ctx.onEnemyFire) ctx.onEnemyFire(this.root.position, this);
      return;
    }

    if (this.archetype === 'sniper') {
      const dmg = def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0]);
      const end = hit
        ? playerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.12, -0.1, (Math.random() - 0.5) * 0.12))
        : playerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, -0.2, (Math.random() - 0.5) * 0.5));
      ctx.fx.tracer(muzzle, end, { color: 0xffe0b8, width: 0.036, life: 0.07 });
      ctx.fx.muzzleFlash(muzzle);
      if (hit) ctx.damagePlayer(dmg, this.root.position);
      ctx.audio.enemyShot(pan, dist);
      this.weaponLevel = 1;
      if (!hit && dist < 40 && Math.random() > 0.3) ctx.audio.whiz(pan);
      if (ctx.onEnemyFire) ctx.onEnemyFire(this.root.position, this);
      return;
    }

    /* rifleman / shield: rifle burst */
    const baseErr = 0.32 + dist * 0.020 + playerSpeed * 0.05;
    const spread = new THREE.Vector3(
      (Math.random() - 0.5) * baseErr,
      (Math.random() - 0.5) * baseErr * 0.7,
      (Math.random() - 0.5) * baseErr
    );
    const target = playerPos.clone().add(spread);
    const endpoint = hit
      ? playerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.25, -0.15, (Math.random() - 0.5) * 0.25))
      : target;
    ctx.fx.tracer(muzzle, endpoint, { color: 0xffc98a, width: 0.03, life: 0.05 });
    ctx.fx.muzzleFlash(muzzle);
    if (hit) {
      const dmg = def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0]);
      ctx.damagePlayer(dmg, this.root.position);
    }
    ctx.audio.enemyShot(pan, dist);
    this.weaponLevel = 1;
    if (!hit && dist < 26 && Math.random() > 0.5) ctx.audio.whiz(pan);
    if (ctx.onEnemyFire) ctx.onEnemyFire(this.root.position, this);
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
    if (this.rig) this.rig.dispose();
    if (this.laser) {
      this.scene.remove(this.laser);
      this.laser.geometry.dispose();
      this.laser.material.dispose();
      this.laser = null;
    }
    if (this.glint) {
      if (this.glint.parent) this.glint.parent.remove(this.glint);
      this.glint.material.dispose();
      this.glint = null;
    }
  }
}
