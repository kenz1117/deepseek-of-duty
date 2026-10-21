import * as THREE from 'three';
import { buildSoldier, applyPose, applyRagdoll } from './soldierParts.js';
import { behaviorFor, reactionDelay } from '../systems/ai/tuning.js';
import { separate, avoidBody, pullString, arrival } from '../systems/ai/steering.js';
import { AI_PROFILES, pickPatrolPoint } from '../systems/ai/profiles.js';

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
/* shoot() scratch: every pellet used to allocate 2 Vector3; tracer()/muzzleFlash()
   copy coordinates synchronously, so shared temps are safe here. */
const _shotMuzzle = new THREE.Vector3();
const _shotEnd = new THREE.Vector3();
const _shotSpread = new THREE.Vector3();
const _shotPellet = new THREE.Vector3();

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

/* --------------------------------------------------------------- ragdoll */
// 7 bodies / 8 distance constraints per corpse: head, chest, pelvis,
// two hands, two feet. Solved with Verlet + PBD; drives the existing rig.
const RAG_BODY_DEF = [
  { k: 'head',   w: 0.60, r: 0.105, lift: 1.00 },
  { k: 'chest',  w: 0.95, r: 0.150, lift: 0.80 },
  { k: 'pelvis', w: 1.00, r: 0.140, lift: 0.30 },
  { k: 'handL',  w: 0.30, r: 0.045, lift: 0.90 },
  { k: 'handR',  w: 0.30, r: 0.045, lift: 0.90 },
  { k: 'footL',  w: 0.42, r: 0.065, lift: 0.00 },
  { k: 'footR',  w: 0.42, r: 0.065, lift: 0.00 },
];
const RAG_CON_DEF = [
  ['pelvis', 'chest'], ['chest', 'head'],
  ['chest', 'handL'], ['chest', 'handR'],
  ['pelvis', 'footL'], ['pelvis', 'footR'],
  // keeps the spine from folding back onto the legs (a pure distance
  // ragdoll otherwise collapses into a pile at the waist)
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

/**
 * Analytic segment-vs-AABB occlusion test (see Enemy.pathBlocked).
 * Module-level and pure so it can be unit-tested without three.js.
 *
 * @returns {{blocked: boolean, tEnd: number}} tEnd is the path fraction at
 *          the blocking point (1 when clear), for tracer truncation.
 */
export function segmentBlockedByColliders(ax, ay, az, bx, by, bz, colliders, occluders = [], host = null) {
  const dx = bx - ax, dz = bz - az, dy3 = by - ay;

  // 3D roof decks: an elevated shooter cannot see through a deck into the room below
  if (occluders && occluders.length && ay > by + 0.2) {
    for (const o of occluders) {
      if (!(ay > o.y && by < o.y - 0.05)) continue;
      const t = (o.y - ay) / (by - ay);
      if (t <= 0 || t >= 1) continue;
      const x = ax + dx * t, z = az + dz * t;
      if (x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return { blocked: true, tEnd: t };
    }
  }

  const cols = colliders || [];
  const nCols = cols.length;
  for (let k = 0; k < nCols; k++) {
    const c = cols[k];
    if (c === host) continue;
    const top = c.top != null ? c.top : Infinity;
    if (Math.min(ay, by) >= top) continue;           // whole path passes over it

    // slab test: overlap of the segment with the AABB in x and z
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDz = dz !== 0 ? 1 / dz : 0;
    let t0 = 0, t1 = 1;
    if (dx !== 0) {
      let ta = (c.x0 - ax) * invDx, tb = (c.x1 - ax) * invDx;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (ax < c.x0 || ax > c.x1) continue;
    if (dz !== 0) {
      let ta = (c.z0 - az) * invDz, tb = (c.z1 - az) * invDz;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (az < c.z0 || az > c.z1) continue;
    if (t0 >= t1 || t1 <= 0 || t0 >= 1) continue;

    // height along the path inside the overlap: blocked only where the
    // eye line is below the collider top
    const h0 = ay + dy3 * t0;
    const h1 = ay + dy3 * t1;
    if (h0 >= top && h1 >= top) continue;            // clears it within the overlap
    return { blocked: true, tEnd: t0 > 0 ? t0 : 0.001 };
  }
  return { blocked: false, tEnd: 1 };
}

export class Enemy {
  constructor(scene, mats, colliders, rnd) {
    this.scene = scene;
    this.mats = mats;
    this.colliders = colliders;
    this.occluders = [];
    this.rnd = rnd || Math.random;

    this.archetype = 'rifleman';
    this.def = ARCHETYPES.rifleman;
    this.maxHp = this.def.hp;
    // difficulty layer (applied by main.js per wave); 1 = archetype baseline
    this.diff = null;
    this.accuracyMult = 1;
    this.damageMult = 1;
    this.firstShotMult = 1;
    this.burstMult = 1;

    this.hp = this.maxHp;
    this.alive = true;
    // Faction id (0/1) in versus mode; undefined in co-op/PvE. Undefined must
    // stay a legal value: every team check treats "both sides have a team" as
    // the only condition for friendly/hostile filtering, so co-op behaviour
    // stays unchanged.
    this.team = undefined;
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
    this.areaTimer = 5 + Math.random() * 4;
    this.repositionPoint = null;
    // ground pathfinding + "lost contact" search (Sprint H)
    this.path = null;
    this.pathI = 0;
    this.pathTimer = 0;
    this.navTarget = { x: 0, z: 0 };
    this.lastSeen = null;
    this.lastSeenT = 99;
    this.searchHold = 0;
    this.followHeight = null;
    this.followHeight = null;
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

    /* ---- AI v2 state (see systems/ai/*) -------------------------------- */
    this.awareness = 0;          // 0..1 confidence that the player is here
    this.losTimer = Math.random() * 0.2;
    this.losCache = false;
    this.contact = false;        // currently in a visual engagement
    this.acquireT = 0;           // seconds of continuous contact
    this.reactionDelay = 0.8;    // tier-driven delay before the first shot
    this.aimSettle = 0;          // 0..1 accuracy ramp while tracking
    this.suppression = 0;        // 0..1 incoming-fire pressure
    this.aiRole = 'hold';        // assigned by the squad director
    this.aiSide = 1;             // flank direction
    this.roleT = 0;
    this.intelT = 0;
    this.intelDue = 0;
    this.investigate = null;
    this.investigateT = 0;
    this.wantCover = false;
    this.coverKey = null;
    this.breachDoor = null;
    this.coverCd = 0;
    this.coverPhase = 'move';    // move | hide | peek
    this.coverPhaseT = 0;
    this.coverPeek = false;
    this.coverNoSightT = 0;
    this.flankT = 0;
    // Phase 2 profile layer: policy (intel rules / patrol / zone anchor /
    // stand-off modifier) set per spawn by main.js; behaviour reads it.
    this.profile = AI_PROFILES.default;
    this.flankPoint = null;      // real-flank waypoint (director-assigned)
    this.flankDone = false;      // route finished — revert to normal flank play
    this.patrolHome = null;      // garrison post centre (set on spawn)
    this.patrolPoint = null;     // current beat leg
    this.patrolT = 0;            // leg timer / dwell
    this.patrolDir = null;       // last leg bearing (keeps turns one-way)
    this.zoneAnchor = null;      // mission-area target for zoneAnchor profiles
    // Phase 3 boss-phase hooks: fraction of incoming damage shrugged off
    // (warden escorts alive) and a movement multiplier (charge mode)
    this.damageResist = 0;
    this.advanceSpeedMult = 1;
    // AI v2.x: morale / bullet-impact / panic state
    this.comradeLostT = 0;        // seconds since I saw a friend die nearby
    this.fireBearingX = 0;        // last-known rough firing direction (unit)
    this.fireBearingZ = 0;
    this.fireBearingT = 0;        // freshness window
    this.panicT = 0;              // rifleman-only: shaky aim after a wound

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
    // world clamps: the level grew north (HQ) and east (dock); the old fixed
    // box cut those areas off and squeezed soldiers onto a single wall line
    this.worldBounds = { x0: -28, x1: 28, z0: -63, z1: 83 };

    // ragdoll / corpse
    this.ragdoll = null;
    this.corpseT = 0;
    this.deathPart = 'torso';
    this.deathExplosive = false;
    this.velX = 0;
    this.velZ = 0;
    this.fadeMats = null;
    this.matBackup = null;

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
  /** Per-wave difficulty knobs. Kept as multipliers so the archetype table
   *  stays the single description of baseline behaviour. */
  setDifficulty(tier) {
    this.diff = tier || null;
    this.accuracyMult = tier ? tier.accuracy : 1;
    this.damageMult = tier ? tier.damage : 1;
    this.firstShotMult = tier ? tier.firstShot : 1;
    this.burstMult = tier ? tier.burst : 1;
    // the first shot is gated by perception.reactionDelay now; this timer only
    // staggers the trigger so a squad does not open up on the same frame
    this.fireTimer = 0.18 + Math.random() * 0.45;
  }

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
    this.fireTimer = 0.18 + Math.random() * 0.5;
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
    this.resetAiState();

    this.rebuildVisual();

    if (this.alive) {
      this.deathT = 0;
      this.root.rotation.set(0, this.root.rotation.y, 0);
      this.restPose();
    } else if (this.ragdoll) {
      this.applyRagdollPose();
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

  /** Playable rectangle for world clamping (level.bounds), inset by the body. */
  setWorldBounds(b) {
    if (!b) return this;
    this.worldBounds = {
      x0: Number.isFinite(b.x0) ? b.x0 : this.worldBounds.x0,
      x1: Number.isFinite(b.x1) ? b.x1 : this.worldBounds.x1,
      z0: Number.isFinite(b.z0) ? b.z0 : this.worldBounds.z0,
      z1: Number.isFinite(b.z1) ? b.z1 : this.worldBounds.z1,
    };
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
    this.restoreMaterials();
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
    this.collectDetails();
  }

  /** Small meshes (pouches, straps, eyes, patches) are invisible past ~24 m.
   *  Hiding them is a cheap per-enemy draw-call cut without touching the rig. */
  collectDetails() {
    this.detailMeshes = [];
    this.rig.root.traverse((o) => {
      if (!o.isMesh || o.userData.enemy || !o.visible) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const r = o.geometry.boundingSphere ? o.geometry.boundingSphere.radius : 1;
      if (r < 0.075) this.detailMeshes.push(o);
    });
    this._detailOn = true;
  }

  setDetailVisible(show) {
    if (this._detailOn === show) return;
    this._detailOn = show;
    for (const m of this.detailMeshes) m.visible = show;
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
  /* The pose blob is rebuilt every frame for every soldier; keep ONE object
     per instance and mutate it (was ~1200 object literals/sec at 20 hostiles). */
  poseScratch() {
    return this._pose || (this._pose = {
      time: 0, crouch: 0.10, walkAmp: 0, walkPhase: 0, aim: 1, weaponLevel: 0,
      aimPitch: 0, lookYaw: 0, flinch: 0, recoil: 0, limp: 0,
      headRoll: 0, deathSide: 1, flinchSide: 1,
    });
  }

  restPose() {
    const P = this.poseScratch();
    P.time = 0; P.crouch = 0.10; P.walkAmp = 0; P.walkPhase = 0; P.aim = 1;
    P.weaponLevel = 0; P.aimPitch = 0; P.lookYaw = 0; P.flinch = 0; P.recoil = 0;
    P.limp = 0; P.headRoll = 0; P.deathSide = 1; P.flinchSide = 1;
    applyPose(this.rig, P);
  }

  applyBodyPose() {
    const P = this.poseScratch();
    P.time = this.animT;
    P.crouch = this.crouch;
    P.walkAmp = this.walkAmp;
    P.walkPhase = this.walkT;
    P.aim = this.aimBlend;
    P.weaponLevel = this.weaponLevel;
    P.aimPitch = this.aimPitchS;
    P.lookYaw = this.headYawS;
    P.flinch = this.flinch;
    P.recoil = this.recoil;
    P.limp = 0;
    P.headRoll = 0;
    P.deathSide = this.deathSide;
    P.flinchSide = this.lastHitSide || 1;
    applyPose(this.rig, P);
  }

  /* --------------------------------------------------------------- spawning */
  spawn(x, z, yaw = 0, y = 0) {
    this.restoreMaterials();
    this.ragdoll = null;
    this.corpseT = 0;
    this.deathPart = 'torso';
    this.deathExplosive = false;
    this.velX = 0;
    this.velZ = 0;
    this.baseY = Number.isFinite(y) ? y : 0;
    this.root.position.set(x, this.baseY, z);
    this.root.rotation.set(0, yaw, 0);
    if (this.bounds) this.clampToBounds();
    this.hp = this.maxHp;
    this.alive = true;
    this.state = 'advance';
    this.deathT = 0;
    this.burstLeft = 0;
    this.fireTimer = 0.18 + Math.random() * 0.5;
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
    this.areaTimer = 5 + this.rnd() * 4;
    this.repositionPoint = null;
    this.path = null;
    this.pathI = 0;
    this.pathTimer = 0;
    this.navTarget.x = 0;
    this.navTarget.z = 0;
    this.lastSeen = null;
    this.lastSeenT = 99;
    this.searchHold = 0;
    this.repositionTimer = 3 + this.rnd() * 3;
    this.repositionT = 0;
    this.warnT = 0;
    this.warnActive = false;
    this.resetAiState();
    // garrison beat: patrol posts orbit the spawn point
    this.patrolHome = { x, z };
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

  /** AI v2 state reset — called by spawn()/setArchetype() so a recycled
   *  instance does not inherit awareness, a cover claim or a role. */
  resetAiState() {
    this.awareness = 0;
    this.losTimer = this.rnd() * 0.2;
    this.losCache = false;
    this.contact = false;
    this.acquireT = 0;
    this.reactionDelay = 0.8;
    this.aimSettle = 0;
    this.suppression = 0;
    this.aiRole = 'hold';
    this.aiSide = this.rnd() > 0.5 ? 1 : -1;
    this.roleT = 0;
    this.intelT = 0;
    this.intelDue = 0;
    this.investigate = null;
    this.investigateT = 0;
    this.wantCover = false;
    this.coverKey = null;
    this.breachDoor = null;
    this.coverCd = 0;
    this.coverPhase = 'move';
    this.coverPhaseT = 0;
    this.coverPeek = false;
    this.coverNoSightT = 0;
    this.flankT = 0;
    this.flankPoint = null;
    this.flankDone = false;
    this.patrolPoint = null;
    this.patrolT = 0;
    this.patrolDir = null;
    this.zoneAnchor = null;
    this.coverPoint = null;
    this.coverTimer = 0;
  }

  /* ---------------------------------------------------------------- damage */
  /** returns true if this damage killed */
  takeDamage(amount, point, normal, part = 'torso', attackerTeam = undefined) {
    if (!this.alive) return false;
    // boss-phase warden buff (Phase 3): fraction of incoming damage shrugged
    // off while the escort lives — applied before any branch so friendly
    // chip damage respects it too
    if (this.damageResist > 0) amount *= 1 - Math.min(0.9, this.damageResist);

    // ---- friendly fire (versus mode only) ----
    // Enters only when BOTH ids exist and match; undefined attacker (player
    // shots, artillery, old snapshots) never reaches this branch, so co-op
    // behaviour is unchanged. Friendly fire must NOT run the "I've been shot
    // by an enemy" reaction block below — awareness=0.9 + contact +
    // investigate=shooter would make allies turn on each other, wantCover and
    // panicT would make them twitch out of position. So: hp + flinch only.
    if (attackerTeam != null && this.team != null && attackerTeam === this.team) {
      const dmg = amount * 0.35;
      this.hp -= dmg;
      this.flinch = Math.min(1, this.flinch + 0.25);
      this.lastDamage = 0.4;
      if (this.hp <= 0) {
        this.die(point, normal);
        return true;
      }
      return false;
    }

    this.deathPart = part;
    this.deathExplosive = !!(normal && normal.y > 0.75);

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

    // Being hit is information: acquire the shooter, shake the aim, and
    // remember to look for cover — but only some soldiers break off.
    const B = behaviorFor(this.diff);
    this.awareness = Math.min(1, Math.max(this.awareness, 0.9));
    this.suppression = Math.min(1, this.suppression + (part === 'shield' ? 0.04 : 0.14));
    this.aimSettle = Math.max(0, this.aimSettle * 0.45);
    if (point) this.investigate = { x: point.x, z: point.z };
    if (!this.contact) {
      this.contact = true;
      this.acquireT = 0;
      this.reactionDelay = reactionDelay(B, this.archetype) * 0.5;
    }
    this.wantCover = this.def.useCover && Math.random() < B.cover;
    // morale-of-one: a hurt soldier that's still healthy enough to fight
    // does not run. But below ~35 % HP a rifleman becomes flaky — his
    // accuracy wobbles, he is more likely to break for cover on the next
    // hit, and his reaction window narrows. A shield or sniper stays
    // disciplined because the player wants their archetype to feel
    // distinct.
    const hpPct = this.hp / this.maxHp;
    if (this.archetype === 'rifleman' && hpPct < 0.36) {
      this.panicT = 4.2;
      this.aimSettle = Math.max(0, this.aimSettle * 0.65);
      // a flustered rifleman is more likely to break for cover
      if (Math.random() < 0.45) this.wantCover = true;
    }
    if (this.state === 'advance' || this.state === 'idle') {
      this.state = this.canSee ? 'engage' : 'search';
      if (this.state === 'search' && this.searchHold <= 0) this.searchHold = 3.5;
    }
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
    this.corpseT = 0;
    this.startRagdoll(point);
    void normal;
  }

  /* --------------------------------------------------------------- vision */
  setOccluders(list) { this.occluders = Array.isArray(list) ? list : []; }

  /**
   * 2D collider line-of-sight test between this soldier's eye and its current
   * target (the local player in co-op, any hostile actor in versus mode —
   * main.js redirects ctx.playerPos per enemy before calling this).
   * `dist` is the planar distance perception already computed: passing it keeps
   * this function allocation-free and lets it bail out on range.
   */
  canSeeTarget(targetPos, dist) {
    return this.pathBlocked(targetPos, dist).blocked === false;
  }

  /**
   * Analytic line-of-sight / shot-path test from this soldier's eye to a
   * target point. Replaces the old 1.15 m sampled march, which leaked on
   * thin walls: with a step larger than the wall thickness both samples can
   * land on either side and the wall disappears. The slab test below is
   * exact for every AABB, so thin cover actually blocks.
   *
   * Returns { blocked, tEnd } — tEnd is the path fraction at the blocking
   * point (1 when clear), so callers can truncate a tracer against the wall
   * instead of drawing it through.
   */
  pathBlocked(targetPos, dist) {
    const p = this.root.position;
    const ax = p.x, az = p.z, ay = EYE_Y + p.y;
    const bx = targetPos.x, bz = targetPos.z;
    const by = targetPos.y != null ? targetPos.y : CHEST_Y;
    const dx = bx - ax, dz = bz - az;
    const planar = dist != null ? dist : Math.hypot(dx, dz);
    if (planar > 130) return { blocked: true, tEnd: 0 };

    // an elevated shooter ignores the footprint of the building it stands on
    // (colliders are 2D, so its own roof would otherwise block every shot)
    let host = null;
    if (this.baseY > 0.5) {
      for (let k = 0; k < this.colliders.length; k++) {
        const c = this.colliders[k];
        if (ax > c.x0 && ax < c.x1 && az > c.z0 && az < c.z1) { host = c; break; }
      }
    }
    return segmentBlockedByColliders(ax, ay, az, bx, by, bz, this.colliders, this.occluders, host);
  }

  /** Back-compat alias — the old name, safe to keep while callers migrate. */
  canSeePlayer(targetPos, dist) {
    return this.canSeeTarget(targetPos, dist);
  }

  resolveCollision() {
    const p = this.root.position;
    const r = 0.34;
    for (const c of this.colliders) {
      if (c.top != null && c.top <= p.y + 0.2) continue;
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
    const wb = this.worldBounds;
    p.x = clamp(p.x, wb.x0 + 0.4, wb.x1 - 0.4);
    p.z = clamp(p.z, wb.z0 + 0.4, wb.z1 - 0.4);
  }

  /* --------------------------------------------------------------- update */
  update(dt, ctx) {
    const playerPos = ctx.playerPos;
    const def = this.def;
    const B = behaviorFor(this.diff);
    const ai = ctx.ai || null;
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
    this.coverCd = Math.max(0, this.coverCd - dt);

    // ---- perception: vision cone, awareness, hearing, suppression decay
    if (ai && ai.perception) {
      ai.perception.sense(this, ctx, dt);
    } else {
      // defensive fallback for direct callers outside main.js: binary sight
      this.sightTimer -= dt;
      if (this.sightTimer <= 0) {
        this.sightTimer = 0.16 + Math.random() * 0.12;
        this.canSee = this.canSeeTarget(playerPos);
      }
      if (this.canSee) {
        this.lastSeenT = 0;
        if (this.lastSeen) { this.lastSeen.x = playerPos.x; this.lastSeen.z = playerPos.z; }
        else this.lastSeen = { x: playerPos.x, z: playerPos.z };
        this.awareness = 1;
      } else {
        this.lastSeenT += dt;
        this.awareness = Math.max(0, this.awareness - dt * 0.7);
      }
    }
    if (this.investigate) this.investigateT += dt;

    // ---- aim settle: accuracy ramps while tracking, collapses when hit
    const settle = Math.max(0.18, B.settle
      * (this.archetype === 'sniper' ? 1.3 : this.archetype === 'rusher' ? 0.8 : 1));
    // panic jitter: a hurt rifleman cannot hold a steady sight picture,
    // so his aimSettle decays toward a lower cap and never quite settles.
    const panicCap = (this.panicT || 0) > 0 ? 0.62 : 1;
    if (this.canSee) this.aimSettle = Math.min(panicCap, this.aimSettle + dt / settle);
    else this.aimSettle = Math.max(0, this.aimSettle - dt * 1.7);
    if ((this.panicT || 0) > 0) {
      // continuous micro-jitter while panicking: the soldier's accuracy
      // oscillates slightly frame-to-frame, not enough to read as "blind",
      // enough to read as "shaken".
      const jitter = (Math.sin(this.animT * 7.3 + this.rnd() * 6.28)) * 0.05;
      this.aimSettle = Math.max(0, Math.min(panicCap, this.aimSettle + jitter));
      this.panicT = Math.max(0, this.panicT - dt);
    }

    const p = this.root.position;
    const px0 = p.x;
    const pz0 = p.z;
    const tox = playerPos.x - p.x;
    const toz = playerPos.z - p.z;
    const dist = Math.hypot(tox, toz);
    const inv = dist > 1e-4 ? 1 / dist : 0;
    const dirX = tox * inv, dirZ = toz * inv;
    const sideX = -dirZ, sideZ = dirX;

    const boss = !!this.isBoss;
    const aware = boss || this.awareness > 0.45;
    const confident = boss || this.awareness > 0.7;
    const role = boss ? 'assault' : (this.aiRole || 'hold');

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.9 + Math.random() * 1.7;
      this.strafeDir *= -1;
    }

    // ---- cover: break for it when hurt or pinned, then peek/hide in place
    if (this.state !== 'cover' && def.useCover && this.coverCd <= 0
        && this.awareness > 0.5 && (this.wantCover || this.suppression > 0.55)) {
      const pt = ai && ai.director ? ai.director.requestCover(this, playerPos) : null;
      if (pt) {
        this.coverPoint = pt;
        this.state = 'cover';
        this.coverTimer = 10;          // travel budget; reset to hold time on arrival
        this.coverPhase = 'move';
        this.coverPhaseT = 0;
        this.coverPeek = false;
        this.coverNoSightT = 0;
      } else {
        this.coverCd = 1.6 + Math.random();
      }
      this.wantCover = false;
    }

    // ---- state selection
    if (this.state === 'cover') {
      this.coverTimer -= dt;
      if (this.coverTimer <= 0) this.leaveCover(ai);
    } else if (this.state === 'search') {
      this.searchHold -= dt;
      if (this.canSee && confident) this.state = 'engage';
      else if (!this.lastSeen || this.lastSeenT > 8 || this.searchHold <= 0) {
        this.state = 'advance';
        this.lastSeen = null;
      }
    } else if (this.state === 'reposition') {
      this.repositionT -= dt;
      if (this.repositionT <= 0) this.state = this.canSee ? 'engage' : 'advance';
    } else if (!aware) {
      if (this.investigate && this.investigateT < 24) {
        this.state = 'search';
        if (this.searchHold <= 0) this.searchHold = 4 + Math.random() * 3;
      } else if (this.profile && this.profile.patrol) {
        // unalerted garrison: walk the beat instead of statue-ing on the spawn
        this.state = 'patrol';
      } else {
        this.state = 'idle';
      }
    } else if (role === 'breach' && this.breachDoor && !this.breachDoor.opened) {
      this.state = 'advance';
    } else if (role === 'breachSupport' && this.breachDoor && !this.breachDoor.opened) {
      // breach support: hold a firing position covering the door while the
      // stacker charges it. Picks the side furthest from the player so the
      // door does not become a frontal peek into the player's gun.
      this.state = 'engage';
    } else if (this.canSee && confident && dist < (def.engageRange || 48)) {
      this.state = 'engage';
    } else if (this.lastSeen && this.lastSeenT < 5.5) {
      this.state = 'search';
      if (this.searchHold <= 0) this.searchHold = 3.4 + Math.random() * 1.6;
    } else {
      this.state = 'advance';
    }

    // real flank (Phase 2): while a flank waypoint is pending, stay on the
    // route even through brief line-of-sight — that commitment is what makes
    // a flank readable instead of a teleport-in. Bail out when the point is
    // reached, the fight is at arm's length, or the soldier lost the job.
    if (this.state !== 'cover' && this.aiRole === 'flank' && this.flankPoint && !this.flankDone) {
      const fdx = this.flankPoint.x - p.x;
      const fdz = this.flankPoint.z - p.z;
      const fd = Math.hypot(fdx, fdz);
      if (fd <= 2.6 || dist < 12) this.flankDone = true;
      else this.state = 'advance';
    }

    // ---- movement intent
    let moveX = 0, moveZ = 0, speedTarget = 0;
    let faceMove = false;

    if (this.state === 'idle') {
      speedTarget = 0;
    } else if (this.state === 'patrol') {
      // garrison beat: walk one leg at a time around the post, at a slow
      // walk, checking the straight line first — patrol legs are short
      // (≤13 m) so a blocked line just means "pick another leg", not A*.
      this.patrolT -= dt;
      const pp = this.patrolPoint;
      const pd = pp ? Math.hypot(pp.x - p.x, pp.z - p.z) : Infinity;
      if (!pp || pd < 1.1 || this.patrolT <= 0) {
        const cfg = this.profile.patrol;
        const next = pickPatrolPoint({
          home: this.patrolHome || p, radius: cfg.radius, rng: this.rnd, prevDir: this.patrolDir,
        });
        const lineOk = !ctx.nav || !ctx.nav.lineWalkable
          || ctx.nav.lineWalkable(p.x, p.z, next.x, next.z);
        const cellOk = !ctx.nav || !ctx.nav.isWalkableAt || ctx.nav.isWalkableAt(next.x, next.z, this.baseY);
        if (lineOk && cellOk) {
          this.patrolPoint = { x: next.x, z: next.z };
          this.patrolDir = next.dir;
          this.patrolT = cfg.dwell[0] + this.rnd() * (cfg.dwell[1] - cfg.dwell[0]);
        } else {
          // blocked beat: stand fast briefly, then try a fresh leg
          this.patrolPoint = null;
          this.patrolT = 1.5 + this.rnd();
        }
      }
      if (this.patrolPoint) {
        const wx = this.patrolPoint.x - p.x, wz = this.patrolPoint.z - p.z;
        const wd = Math.hypot(wx, wz) || 1;
        moveX = wx / wd; moveZ = wz / wd;
        speedTarget = 1.15;
        faceMove = true;
      }
    } else if (this.state === 'cover') {
      const cp = this.coverPoint;
      if (cp) {
        const cx = cp.x - p.x, cz = cp.z - p.z;
        const cd = Math.hypot(cx, cz);
        if (cd > 0.75) {
          moveX = cx / cd; moveZ = cz / cd;
          speedTarget = 3.4 * arrival(cd, 2.2);
          faceMove = true;
        } else {
          speedTarget = 0;
          if (this.coverPhase === 'move') {
            // arrived: switch from travel to peek/hide and start the hold clock
            this.coverPhase = 'hide';
            this.coverPeek = false;
            this.coverPhaseT = 0.5 + Math.random() * 0.6;
            this.coverTimer = 3.2 + Math.random() * 2.2;
          }
          this.coverPhaseT -= dt;
          if (this.coverPhaseT <= 0) {
            if (this.coverPhase === 'peek') {
              this.coverPhase = 'hide';
              this.coverPeek = false;
              this.coverPhaseT = 0.9 + Math.random() * 1.0;
            } else {
              this.coverPhase = 'peek';
              this.coverPeek = true;
              this.coverPhaseT = 1.0 + Math.random() * 0.9;
            }
          }
          if (this.coverPhase === 'peek') {
            this.coverNoSightT = this.canSee ? 0 : this.coverNoSightT + dt;
            if (this.coverNoSightT > 2.4) this.leaveCover(ai);
          }
        }
      } else this.leaveCover(ai);
    } else if (this.state === 'search') {
      const ls = this.lastSeen || this.investigate || playerPos;
      const sx = ls.x - p.x, sz = ls.z - p.z;
      const sd = Math.hypot(sx, sz);
      if (sd > 1.4) {
        moveX = sx / sd; moveZ = sz / sd;
        speedTarget = this.awareness > 0.7 ? 3.0 : 2.4;
        faceMove = true;
      } else speedTarget = 0;
    } else if (this.state === 'advance') {
      // real flank: run the assigned side/rear waypoint. The navDrive pass
      // below paths around walls toward it; the straight-line push here
      // covers open ground. On arrival the normal flank strafe takes over.
      if (this.aiRole === 'flank' && this.flankPoint && !this.flankDone) {
        const fx2 = this.flankPoint.x - p.x;
        const fz2 = this.flankPoint.z - p.z;
        const fd2 = Math.hypot(fx2, fz2) || 1;
        moveX = fx2 / fd2; moveZ = fz2 / fd2;
        speedTarget = def.advanceSpeed * (this.advanceSpeedMult || 1) * (this.awareness > 0.7 ? 1 : 0.85);
        faceMove = true;
      } else if (role === 'breachSupport' && this.breachDoor && this.breachDoor.rect) {
        // breachSupport: instead of running toward the door, the support
        // soldier picks a position roughly 9 m off the door axis, on the
        // side furthest from the player. From there they can fire on
        // anyone peeking the door and not get flanked by the player.
        const dr = this.breachDoor.rect;
        const dx2 = (dr[0] + dr[1]) * 0.5 - p.x;
        const dz2 = (dr[2] + dr[3]) * 0.5 - p.z;
        const ddoor = Math.hypot(dx2, dz2) || 1;
        const desired = 9;
        if (ddoor > desired + 1.5) {
          moveX = dx2 / ddoor; moveZ = dz2 / ddoor;
          speedTarget = 3.0;
          faceMove = true;
        } else if (ddoor < desired - 2) {
          // too close: back off, but only if it does not put us in the
          // player's face; flip to retreat along the door-axis
          moveX = -dx2 / ddoor; moveZ = -dz2 / ddoor;
          speedTarget = 1.6;
          faceMove = true;
        } else {
          // in position: strafe laterally to keep the player from
          // tracking a static target
          moveX = sideX * this.strafeDir * 0.5;
          moveZ = sideZ * this.strafeDir * 0.5;
          speedTarget = 1.0;
          faceMove = true;
        }
      } else {
        // zoneAnchor profiles (assault / interceptor) advance on the MISSION
        // AREA when nothing fresher exists — the player is an obstacle on
        // the way, not a homing beacon.
        const tgt = this.investigate
          || (this.lastSeen && this.lastSeenT < 6 ? this.lastSeen : null)
          || (this.profile && this.profile.zoneAnchor && this.zoneAnchor)
          || playerPos;
        const tx = tgt.x - p.x, tz = tgt.z - p.z;
        const td = Math.hypot(tx, tz) || 1;
        const so = this.profile ? (this.profile.standoffMod || 0) : 0;
        const baseStandoff = role === 'breach' ? 1.2
          : role === 'suppress' ? 26 : role === 'hold' ? 20 : role === 'flank' ? 17 : 8;
        const standoff = Math.max(4, baseStandoff + so);
        if (role === 'breach' && td <= 1.6) {
          speedTarget = 0;
        } else if (td > standoff) {
          moveX = tx / td; moveZ = tz / td;
          speedTarget = def.advanceSpeed * (this.advanceSpeedMult || 1) * (this.awareness > 0.7 ? 1 : 0.82);
          faceMove = true;
        } else {
          moveX = sideX * this.strafeDir * 0.5;
          moveZ = sideZ * this.strafeDir * 0.5;
          speedTarget = 1.1;
          faceMove = true;
        }
      }
    } else if (this.state === 'engage') {
      if (this.archetype === 'rusher') {
        const push = dist > 3.2 ? 1 : 0;
        const circle = dist > 3.2 ? 0.3 : 1.0;
        moveX = dirX * push + sideX * this.strafeDir * circle;
        moveZ = dirZ * push + sideZ * this.strafeDir * circle;
        speedTarget = dist > 3.2 ? def.engageSpeed * (this.advanceSpeedMult || 1) : 3.0;
      } else if (role === 'breachSupport' && this.breachDoor && this.breachDoor.rect) {
        // breachSupport during engage: the soldier has arrived at the
        // 9 m support position and now has the player in sight. They
        // shoot from there instead of pushing in — they exist to cover
        // the stacker, not to be the second wave. Lateral strafe keeps
        // them hard to track; an "advance" toward the door only fires
        // if they have drifted away from the support line.
        const dr = this.breachDoor.rect;
        const cx2 = (dr[0] + dr[1]) * 0.5;
        const cz2 = (dr[2] + dr[3]) * 0.5;
        const dx2 = cx2 - p.x;
        const dz2 = cz2 - p.z;
        const ddoor = Math.hypot(dx2, dz2) || 1;
        const desired = 9;
        if (ddoor > desired + 2.5) {
          // drifted away from the support line: drift back, do not push
          // the player
          moveX = dx2 / ddoor * 0.7;
          moveZ = dz2 / ddoor * 0.7;
          speedTarget = 1.8;
          faceMove = true;
        } else {
          // in position: strafe laterally, prefer moving off-axis to
          // make the player's lead less effective
          moveX = sideX * this.strafeDir * 0.85;
          moveZ = sideZ * this.strafeDir * 0.85;
          speedTarget = 1.2;
          faceMove = true;
        }
      } else if (this.archetype === 'sniper') {
        this.repositionT = Math.max(0, this.repositionT - dt);
        if (this.repositionT > 0) {
          moveX = sideX * this.strafeDir;
          moveZ = sideZ * this.strafeDir;
          speedTarget = 3.0;
          faceMove = true;
        } else {
          const push = dist > def.wantDist + 10 ? 1 : dist < def.wantDist - 10 ? -1 : 0;
          moveX = dirX * push + sideX * this.strafeDir * 0.2;
          moveZ = dirZ * push + sideZ * this.strafeDir * 0.2;
          speedTarget = push !== 0 ? def.engageSpeed : 0.6;
        }
      } else if (this.archetype === 'shield' && !boss) {
        if (dist > def.wantDist) {
          moveX = dirX; moveZ = dirZ;
          speedTarget = def.engageSpeed;
        } else {
          moveX = sideX * this.strafeDir * 0.5;
          moveZ = sideZ * this.strafeDir * 0.5;
          speedTarget = 0.6;
        }
      } else if (role === 'suppress') {
        const push = dist > 30 ? 1 : dist < 13 ? -1 : 0;
        moveX = dirX * push + sideX * this.strafeDir * 0.45;
        moveZ = dirZ * push + sideZ * this.strafeDir * 0.45;
        speedTarget = push !== 0 ? 2.4 : 0.8;
      } else if (role === 'flank') {
        const radial = dist > 21 ? 0.85 : dist < 11 ? -0.75 : 0;
        moveX = dirX * radial + sideX * this.aiSide * 0.95;
        moveZ = dirZ * radial + sideZ * this.aiSide * 0.95;
        speedTarget = 2.9;
      } else if (role === 'assault' || boss) {
        const close = (def.engageSpeed + (boss ? 0.4 : 0.9)) * (this.advanceSpeedMult || 1);
        if (dist > 9) {
          moveX = dirX + sideX * this.strafeDir * 0.3;
          moveZ = dirZ + sideZ * this.strafeDir * 0.3;
          speedTarget = close;
        } else {
          moveX = sideX * this.strafeDir * 0.9 - dirX * 0.25;
          moveZ = sideZ * this.strafeDir * 0.9 - dirZ * 0.25;
          speedTarget = 1.8;
        }
      } else {
        const want = def.wantDist;
        const push = dist > want + 6 ? 1 : dist < want - 6 ? -1 : 0;
        moveX = dirX * push + sideX * this.strafeDir * 0.65;
        moveZ = dirZ * push + sideZ * this.strafeDir * 0.65;
        speedTarget = push !== 0 ? 2.2 : 1.05;
        if (dist < 7) {
          moveX = -dirX + sideX * this.strafeDir * 0.4;
          moveZ = -dirZ + sideZ * this.strafeDir * 0.4;
          speedTarget = 2.1;
        }
      }
    }

    // suppression bites movement, not just aim (Phase 2): a pinned soldier
    // slows down, edges off the incoming fire lane, and cover-capable
    // archetypes ask for the nearest crate instead of walking into the
    // stream. Rushers stay immune by design — closing distance IS their
    // answer to being shot at.
    if (this.state === 'advance' && this.suppression > 0.55 && !boss
        && this.archetype !== 'rusher' && role !== 'breach') {
      if (def.useCover && this.coverCd <= 0) this.wantCover = true;
      if (speedTarget > 0) {
        speedTarget *= 1 - 0.45 * Math.min(1, this.suppression);
        const bx = this.fireBearingX || 0, bz = this.fireBearingZ || 0;
        if (bx || bz) {
          let px2 = -bz, pz2 = bx;                 // perpendicular of the lane
          if (px2 * moveX + pz2 * moveZ < 0) { px2 = -px2; pz2 = -pz2; }
          const nx2 = moveX + px2 * 0.7, nz2 = moveZ + pz2 * 0.7;
          const nl = Math.hypot(nx2, nz2) || 1;
          moveX = nx2 / nl; moveZ = nz2 / nl;
        }
      }
    }

    // ---- ground pathfinding: steer around walls when the straight line is blocked
    if (ctx.nav && this.baseY <= 0.5 && !this.pinned
        && (this.state === 'advance' || this.state === 'search' || this.state === 'cover'
            || (this.aiRole === 'breachSupport' && this.breachDoor))) {
      // breachSupport uses the door position, not the player, as its
      // navigation target — otherwise A* would path them straight at the
      // player instead of holding the support line.
      const isBreachSupport = this.aiRole === 'breachSupport' && this.breachDoor;
      const tgt = isBreachSupport
        ? { x: (this.breachDoor.rect[0] + this.breachDoor.rect[1]) * 0.5,
            z: (this.breachDoor.rect[2] + this.breachDoor.rect[3]) * 0.5 }
        : (this.aiRole === 'flank' && this.flankPoint && !this.flankDone)
        ? this.flankPoint
        : this.state === 'search' ? (this.lastSeen || this.investigate || playerPos)
        : this.state === 'cover' ? this.coverPoint
          : (this.investigate && this.investigateT < 24 ? this.investigate
            : (this.lastSeen && this.lastSeenT < 6 ? this.lastSeen
              : (this.profile && this.profile.zoneAnchor && this.zoneAnchor)
                ? this.zoneAnchor
                : playerPos));
      if (tgt) {
        const steer = this.followPath(ctx.nav, tgt, dt, 0);
        if (steer) {
          moveX = steer.x;
          moveZ = steer.z;
          speedTarget = Math.max(speedTarget, this.state === 'advance' ? def.advanceSpeed * 0.9 : 2.6);
        }
      }
    }

    // ---- local avoidance: no two soldiers in the same square metre, and never
    //      standing inside the player. Idle soldiers still shuffle apart, which
    //      stops a spawn cluster from reading as one body.
    if (!this.pinned) {
      const mv = this._mv || (this._mv = { x: 0, z: 0 });
      mv.x = moveX; mv.z = moveZ;
      const before = Math.hypot(mv.x, mv.z);
      if (ai && ai.neighbors) separate(this, ai.neighbors, mv, 1.0);
      if (dist > 0.25 && this.archetype !== 'sniper' && this.state !== 'idle') avoidBody(this, playerPos, mv, 1.05);
      if (this.state === 'idle' && before < 0.01 && Math.hypot(mv.x, mv.z) > 0.05) {
        speedTarget = Math.max(speedTarget, 1.0);
      }
      moveX = mv.x; moveZ = mv.z;
    }

    if (this.pinned) { moveX = 0; moveZ = 0; speedTarget = 0; }
    this.speed += (speedTarget - this.speed) * Math.min(1, dt * 6);
    const moving = this.speed > 0.35;
    if (this.speed > 0.02) {
      this.root.position.x += moveX * this.speed * dt;
      this.root.position.z += moveZ * this.speed * dt;
      if (this.bounds) this.clampToBounds();
      // above deck height the 2D colliders below (walls, trucks) must not pin
      // the body: roof travel only needs the bounds
      else if (this.root.position.y < 2.0) this.resolveCollision();
      else {
        const bp = this.root.position;
        const wb = this.worldBounds;
        bp.x = clamp(bp.x, wb.x0 + 0.4, wb.x1 - 0.4);
        bp.z = clamp(bp.z, wb.z0 + 0.4, wb.z1 - 0.4);
      }
    }
    // vertical follow: ramps/roof layers (ground agents only)
    if (ctx.groundAt && !this.bounds) {
      let gy;
      const navDrive = this.state === 'advance' || this.state === 'search' || this.state === 'reposition';
      if (navDrive && this.followHeight != null && this.followHeight > 1.0) {
        gy = Math.min(ctx.groundAt(this.root.position.x, this.root.position.z, this.followHeight), this.followHeight);
        if (gy < this.followHeight - 0.6 && this.root.position.y > this.followHeight - 0.9) {
          gy = this.root.position.y;
        }
      } else {
        gy = ctx.groundAt(this.root.position.x, this.root.position.z, this.root.position.y + 0.8);
      }
      const dy = gy - this.root.position.y;
      if (dy > 0.9) this.root.position.y += Math.min(dy, dt * 4.5);
      else if (dy < -0.9) this.root.position.y -= Math.min(-dy, dt * 8);
      else this.root.position.y += dy * Math.min(1, dt * 9);
    }
    if (dt > 1e-4) {
      this.velX = clamp((this.root.position.x - px0) / dt, -6, 6);
      this.velZ = clamp((this.root.position.z - pz0) / dt, -6, 6);
    }

    // ---- facing: face travel while repositioning, face the player in a fight.
    // An unaware soldier must NOT rotate to track you — that was the old
    // omniscient tell, and it also let them spot you without ever looking.
    let faceYaw = Math.atan2(-dirX, -dirZ);
    if (faceMove && this.speed > 0.3) faceYaw = Math.atan2(-moveX, -moveZ);
    else if (!aware) faceYaw = this.root.rotation.y;
    const setYaw = Math.atan2(-dirX, -dirZ);
    const dyaw = wrapPi(faceYaw - this.root.rotation.y);
    const turnRate = this.archetype === 'shield' ? 2.6 : this.state === 'engage' ? 7 : 4.5;
    this.root.rotation.y += dyaw * Math.min(1, dt * turnRate);

    // ---- aim / look
    const lookErr = wrapPi(setYaw - this.root.rotation.y);
    const headTarget = (this.state === 'idle' || this.state === 'patrol')
      ? Math.sin(this.animT * 0.9) * 0.45
      : clamp(lookErr * 0.8, -0.95, 0.95);
    this.headYawS += (headTarget - this.headYawS) * Math.min(1, dt * 5.5);
    const playerEye = playerPos.y != null ? playerPos.y : CHEST_Y;
    const pitchTarget = Math.atan2(playerEye - (this.root.position.y + EYE_Y), Math.max(0.8, dist));
    this.aimPitchS += (pitchTarget - this.aimPitchS) * Math.min(1, dt * 5);
    this.aimPitch = this.aimPitchS;

    // ---- blends
    let crouchTarget = 0;
    if (this.state === 'cover') crouchTarget = this.coverPeek ? 0.12 : 1;
    else if (this.state === 'idle') crouchTarget = 0.05;
    else if (this.suppression > 0.6) crouchTarget = 0.3;
    else if (this.state === 'engage') {
      if (this.archetype === 'shield') crouchTarget = def.crouchEngage;
      else if (this.archetype === 'sniper') crouchTarget = this.repositionT > 0 ? 0.12 : def.crouchEngage;
      else if (this.archetype === 'rifleman' && this.hp < 62) crouchTarget = 0.34;
    }
    this.crouch += (crouchTarget - this.crouch) * Math.min(1, dt * 5);

    const swingTarget = moving ? Math.min(1.2, 0.5 + this.speed * 0.24) : 0;
    this.walkAmp += (swingTarget - this.walkAmp) * Math.min(1, dt * 7);
    this.walkT += dt * (moving ? (2.4 + this.speed * 2.2) : 0.85);

    const shootingStance = this.state === 'engage' || (this.state === 'cover' && this.coverPeek);
    const wantAim = shootingStance && this.canSee ? 1 : (aware ? 0.55 : 0);
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

  /** True when this soldier may pull the trigger: contact acquired, reaction
   *  delay elapsed, aim settled enough, and not hiding behind cover. */
  fireReady(dist) {
    if (!this.alive || !this.canSee || !this.contact) return false;
    if (this.acquireT < this.reactionDelay) return false;
    if (this.aimSettle < 0.25) return false;
    // inside cover only the peek phase may shoot; while still running to cover
    // a soldier can snap off a shot on the move (with a movement penalty).
    // Same deal for a flanker running his route: he may return fire while
    // advancing, or a visible flank would read as "he ignores me".
    if (this.state === 'cover' && !this.coverPeek && this.coverPhase !== 'move') return false;
    if (this.state !== 'engage' && this.state !== 'cover'
        && !(this.state === 'advance' && this.aiRole === 'flank'
             && this.flankPoint && !this.flankDone)) return false;
    if (dist > (this.def.fireRange || 48)) return false;
    return true;
  }

  leaveCover(ai) {
    if (ai && ai.director && ai.director.releaseCover) ai.director.releaseCover(this);
    this.coverPoint = null;
    this.coverPeek = false;
    this.coverPhase = 'move';
    this.coverCd = 5 + Math.random() * 3;
    this.state = this.canSee ? 'engage' : 'advance';
  }

  /* -------------------------------------------------------------- firing */
  updateBurstFire(dt, ctx, dist, playerPos) {
    const def = this.def;
    if (this.fireReady(dist) && ctx.playerAlive) {
      this.fireTimer -= dt;
      if (this.burstLeft > 0) {
        if (this.fireTimer <= 0) {
          this.shoot(ctx, dist, playerPos);
          this.burstLeft--;
          this.fireTimer = def.burstGap + Math.random() * 0.05;
        }
      } else if (this.fireTimer <= 0) {
        // global aggression budget: only N soldiers may open fire at once
        if (ctx.tryFire && !ctx.tryFire(this)) {
          this.fireTimer = 0.28 + Math.random() * 0.22;
          return;
        }
        const base = def.burstMin + Math.floor(Math.random() * (def.burstMax - def.burstMin + 1));
        this.burstLeft = Math.max(2, Math.round(base * this.burstMult));
        this.fireTimer = def.burstPause + Math.random() * 0.3;
      }
    } else if (this.burstLeft > 0) {
      this.burstLeft = 0;
    }
  }

  updateRusherFire(dt, ctx, dist, playerPos) {
    this.fireTimer -= dt;
    if (!ctx.playerAlive || !this.fireReady(dist)) return;
    if (this.fireTimer <= 0) {
      // rushers join the global open-fire budget — six shotguns starting a
      // blast on the same frame was the biggest spike-damage source left
      if (ctx.tryFire && !ctx.tryFire()) {
        this.fireTimer = 0.25 + Math.random() * 0.2;
        return;
      }
      this.shoot(ctx, dist, playerPos);
      this.fireTimer = this.def.fireInterval * (0.8 + Math.random() * 0.5);
    }
  }

  updateSniperFire(dt, ctx, dist, playerPos) {
    this.fireTimer -= dt;
    const canFire = ctx.playerAlive && this.fireReady(dist);
    if (this.warnT > 0) {
      this.warnT -= dt;
      if (!canFire) {
        this.warnT = 0;
        this.warnActive = false;
      } else if (this.warnT <= 0) {
        this.warnT = 0;
        this.warnActive = false;
        // snipers join the global open-fire budget too; under pressure the
        // laser stays up a beat longer instead of a warned shot vanishing
        if (ctx.tryFire && !ctx.tryFire()) {
          this.warnT = 0.35;
          this.warnActive = true;
          return;
        }
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
    const active = this.warnActive && this.canSee && this.alive && this.state === 'engage';
    this.laser.visible = active;
    if (this.glint) this.glint.visible = active;
    if (!active) return;

    this.weaponMuzzle.getWorldPosition(_v1);
    _v2.set(playerPos.x, playerPos.y - 0.12, playerPos.z).sub(_v1);
    const len = _v2.length();
    // stop the beam short of the player's eye so it never fills the screen
    const visLen = Math.max(0.4, len - 1.15);
    this.laser.position.copy(_v1);
    this.laser.scale.set(0.011, visLen, 0.011);
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
    this.corpseT += dt;
    if (this.ragdoll) {
      this.stepRagdoll(dt);
      this.applyRagdollPose();
    } else {
      this.deathT = Math.min(1, this.deathT + dt * 1.35);
      this.applyDeathPose();
    }
    this.weaponFlash.material.opacity = 0;
    if (this.laser) this.laser.visible = false;
    if (this.glint) this.glint.visible = false;

    // hold the corpse ~6 s, fade 0.9 s, then hide so main.js can recycle it
    if (this.corpseT > 6.0) {
      if (!this.fadeMats) this.startCorpseFade();
      this.updateCorpseFade(Math.min(1, (this.corpseT - 6.0) / 0.9));
      if (this.corpseT > 6.95 && this.root.visible) {
        this.root.visible = false;
        this.restoreMaterials();
      }
    }
  }

  /* ------------------------------------------------------------- ragdoll */
  /** Capture the current skeleton as 7 bodies + constraints and kick them. */
  startRagdoll(point) {
    this.root.updateWorldMatrix(true, true);

    const pelvis = this.hips.getWorldPosition(new THREE.Vector3());
    const tq = this.torso.getWorldQuaternion(new THREE.Quaternion());
    const chest = this.torso.getWorldPosition(new THREE.Vector3())
      .add(new THREE.Vector3(0, 0.26, 0).applyQuaternion(tq));
    const hq = this.headPivot.getWorldQuaternion(new THREE.Quaternion());
    const head = this.headPivot.getWorldPosition(new THREE.Vector3())
      .add(new THREE.Vector3(0, 0.15, 0).applyQuaternion(hq));
    const handL = this.armL.hand.getWorldPosition(new THREE.Vector3());
    const handR = this.armR.hand.getWorldPosition(new THREE.Vector3());
    const footL = this.legL.ankle.getWorldPosition(new THREE.Vector3());
    const footR = this.legR.ankle.getWorldPosition(new THREE.Vector3());

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

    // push away from the shooter / blast: from the impact point to the feet
    const dir = new THREE.Vector3();
    if (point) dir.set(this.root.position.x - point.x, 0, this.root.position.z - point.z);
    if (dir.lengthSq() < 1e-4) {
      // impact points at the body axis (e.g. a centred chest shot): push back
      dir.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
    }
    dir.normalize();

    const part = this.deathPart || 'torso';
    const imp = { head: 0.5, chest: 0.9, pelvis: 0.7, handL: 0.6, handR: 0.6, footL: 0.25, footR: 0.25 };
    if (part === 'head') {
      imp.head = 3.2; imp.chest = 1.0; imp.pelvis = 0.4; imp.handL = 0.9; imp.handR = 0.9;
    } else if (part === 'arms') {
      if (point && point.distanceTo(handL) < point.distanceTo(handR)) imp.handL = 2.4;
      else imp.handR = 2.4;
      imp.chest = 0.8;
    } else if (part === 'legs') {
      if (point && point.distanceTo(footL) < point.distanceTo(footR)) imp.footL = 2.6;
      else imp.footR = 2.6;
      imp.pelvis = 0.5; imp.chest = 0.35; imp.head = 0.3;
    }
    if (this.deathExplosive) for (const k in imp) imp[k] *= 1.7;

    const baseVx = this.velX * 0.5;
    const baseVz = this.velZ * 0.5;
    for (const b of bodies) {
      const k = imp[b.k];
      const vx = baseVx + dir.x * k + (this.rnd() - 0.5) * 0.5;
      const vz = baseVz + dir.z * k + (this.rnd() - 0.5) * 0.5;
      const vy = 0.30 + k * 0.20 * b.lift + this.rnd() * 0.18;
      b.prev.set(b.p.x - vx * RAG_DT, b.p.y - vy * RAG_DT, b.p.z - vz * RAG_DT);
    }

    this.ragdoll = { bodies, cons, t: 0, acc: 0, done: false };
  }

  stepRagdoll(dt) {
    const rd = this.ragdoll;
    if (!rd || rd.done) return;
    rd.t += dt;
    if (rd.t > 3.2) { rd.done = true; return; }
    rd.acc = Math.min(rd.acc + dt, 0.07);
    let steps = 0;
    while (rd.acc >= RAG_DT && steps < 3) {
      this.integrateRagdoll(RAG_DT, rd);
      rd.acc -= RAG_DT;
      steps++;
    }
  }

  integrateRagdoll(h, rd) {
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
    // distance constraints (PBD, 6 iterations)
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
    // floor = baseY plane (roof-aware): clamp + friction + tiny bounce
    for (const b of rd.bodies) {
      const floor = this.baseY + b.r;
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

  applyRagdollPose() {
    const rd = this.ragdoll;
    if (!rd) return;
    const get = (k) => rd.bodies.find((b) => b.k === k).p;
    _ragQInv.copy(this.root.quaternion).invert();
    const toLocal = (v, out) => out.copy(v).sub(this.root.position).applyQuaternion(_ragQInv);
    toLocal(get('pelvis'), _ragS.pelvis);
    toLocal(get('chest'), _ragS.chest);
    toLocal(get('head'), _ragS.head);
    toLocal(get('handL'), _ragS.handL);
    toLocal(get('handR'), _ragS.handR);
    toLocal(get('footL'), _ragS.footL);
    toLocal(get('footR'), _ragS.footR);
    _ragS.forward.set(0, 0, -1);
    applyRagdoll(this.rig, _ragS);
  }

  /* ------------------------------------------------------- corpse fade */
  startCorpseFade() {
    const map = new Map();
    this.fadeMats = [];
    this.matBackup = this.rig.meshes.map((m) => m.material);
    for (const m of this.rig.meshes) {
      let c = map.get(m.material);
      if (!c) {
        c = m.material.clone();
        c.transparent = true;
        c.depthWrite = false;
        c.opacity = 1;
        map.set(m.material, c);
        this.fadeMats.push(c);
      }
      m.material = c;
    }
  }

  updateCorpseFade(a) {
    if (!this.fadeMats) return;
    const o = Math.max(0, 1 - a);
    for (const c of this.fadeMats) c.opacity = o;
  }

  restoreMaterials() {
    if (this.matBackup && this.rig) {
      const meshes = this.rig.meshes;
      for (let i = 0; i < meshes.length && i < this.matBackup.length; i++) {
        meshes[i].material = this.matBackup[i];
      }
    }
    this.matBackup = null;
    if (this.fadeMats) {
      for (const c of this.fadeMats) c.dispose();
      this.fadeMats = null;
    }
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

    const muzzle = _shotMuzzle;
    this.weaponMuzzle.getWorldPosition(muzzle);

    const playerSpeed = ctx.playerSpeed || 0;
    // Lateral velocity vector (X / Z) feeds the lead correction: a soldier
    // aiming at a sprinting player puts the muzzle where the target is
    // going, not where it is. The component along the firing line is what
    // matters; cross-axis motion only widens the spread.
    const sx = this.root.position.x, sz = this.root.position.z;
    const tx0 = playerPos.x - sx, tz0 = playerPos.z - sz;
    const leadX = (ctx.playerDirX || 0) * playerSpeed;
    const leadZ = (ctx.playerDirZ || 0) * playerSpeed;
    const proj = dist > 0.001
      ? (leadX * tx0 / dist + leadZ * tz0 / dist) * 0.18
      : 0;
    // Accuracy is no longer a flat dice roll: a soldier that just rounded the
    // corner (or is eating suppressive fire) is measurably less accurate than
    // one that has been tracking you for a second.
    const settleMul = 0.55 + 0.45 * this.aimSettle;
    const suppressMul = 1 - 0.4 * this.suppression;
    // squad-morale nudge: a soldier who just saw a friend drop gets
    // tighter, but more than one and the squad starts losing its edge.
    const squadMorale = (ctx.ai && ctx.ai.director && ctx.ai.director.squadMorale) || 1;
    const moraleMul = clamp(squadMorale - (1 - (this.comradeLostT || 0) / 4) * 0.04, 0.85, 1.05);
    const hitChance = clamp(
      def.hitBase * this.accuracyMult * moraleMul * settleMul * suppressMul
        - dist * def.hitFalloff - playerSpeed * def.hitSpeedFalloff
        - Math.min(0.16, this.speed * 0.03)
        - Math.max(0, proj - 0.04) * 0.55,
      0.05, 0.95
    );
    // Final authority on every shot: the actual path from muzzle to target.
    // fireReady trusts a 0.13-0.36 s old losCache, so a soldier that peeked
    // and re-covered would otherwise keep hitting through the wall. A blocked
    // path forces the shot to miss and truncates the tracer at the wall.
    const path = this.pathBlocked(playerPos, dist);
    let hit = !path.blocked && Math.random() < hitChance;
    // late-dodge fairness recheck (Phase 2): when the player broke line of
    // sight within the last ~0.15 s (dived behind a crate mid-burst), a
    // rolled hit gets one fresh geometric re-check. Keeps the dice feel,
    // kills the classic "shot me through the corner I just rounded".
    if (hit && (ctx.playerFastT || 0) > 0 && dist > 8) {
      hit = this.canSeeTarget(playerPos, dist);
    }
    const truncateTo = path.blocked ? path.tEnd : 1;
    const pOwn = this.root.position;
    const ax = pOwn.x, az = pOwn.z, ay = EYE_Y + pOwn.y;
    const pan = ctx.panFor ? ctx.panFor(this.root.position) : 0;

    if (this.archetype === 'rusher') {
      /* shotgun: several pellets, brutal up close, useless far away */
      const falloff = clamp(1 - dist / (def.fireRange + 3), 0.1, 1);
      const dmg = (def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0])) * (0.35 + 0.65 * falloff) * this.damageMult;
      // rusher lead: closer range, smaller correction. The shotgun pellets
      // share the same offset so the spread still feels like a single burst.
      const lrX = leadX * 0.10;
      const lrZ = leadZ * 0.10;
      const end = _shotEnd;
      if (path.blocked) {
        // wall between us: pellets die at the wall, not at the player
        end.set(ax + (playerPos.x - ax) * truncateTo,
                ay + (playerPos.y - ay) * truncateTo,
                az + (playerPos.z - az) * truncateTo);
      } else if (hit) {
        end.copy(playerPos).add(_shotSpread.set((Math.random() - 0.5) * 0.3 + lrX, -0.12, (Math.random() - 0.5) * 0.3 + lrZ));
      } else {
        end.copy(playerPos).add(_shotSpread.set(
          (Math.random() - 0.5) * (0.5 + dist * 0.06) + lrX,
          (Math.random() - 0.5) * 0.4,
          (Math.random() - 0.5) * 0.5 + lrZ));
      }
      for (let i = 0; i < 5; i++) {
        const e = i === 2 ? end : _shotPellet.copy(end).add(_shotSpread.set(
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
      const dmg = (def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0])) * this.damageMult;
      // sniper lead is strongest: the rifleman-archetype tunings are very
      // precise and the in-game telemetry showed snipers missing perpendicular
      // movers because there was no lead at all.
      const lsX = leadX * 0.32;
      const lsZ = leadZ * 0.32;
      const end = _shotEnd;
      if (path.blocked) {
        end.set(ax + (playerPos.x - ax) * truncateTo,
                ay + (playerPos.y - ay) * truncateTo,
                az + (playerPos.z - az) * truncateTo);
      } else if (hit) {
        end.copy(playerPos).add(_shotSpread.set((Math.random() - 0.5) * 0.12 + lsX, -0.1, (Math.random() - 0.5) * 0.12 + lsZ));
      } else {
        end.copy(playerPos).add(_shotSpread.set((Math.random() - 0.5) * 0.5 + lsX, -0.2, (Math.random() - 0.5) * 0.5 + lsZ));
      }
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
    // lead offset: where the muzzle should aim vs. where the player is now.
    // The soldier uses its own X/Z direction toward the player to translate
    // the lateral velocity into an XZ aim offset (positive = put the muzzle
    // ahead of the player's current position along the firing line).
    const dirXn = dist > 0.001 ? tx0 / dist : 0;
    const dirZn = dist > 0.001 ? tz0 / dist : 0;
    const leadOffsetX = leadX * 0.16;
    const leadOffsetZ = leadZ * 0.16;
    const spread = _shotSpread.set(
      (Math.random() - 0.5) * baseErr + (Math.random() - 0.5) * 0.18 + leadOffsetX,
      (Math.random() - 0.5) * baseErr * 0.7,
      (Math.random() - 0.5) * baseErr + (Math.random() - 0.5) * 0.18 + leadOffsetZ
    );
    const target = _shotEnd.copy(playerPos).add(spread);
    let endpoint;
    if (path.blocked) {
      endpoint = _shotPellet.set(ax + (playerPos.x - ax) * truncateTo,
        ay + (playerPos.y - ay) * truncateTo,
        az + (playerPos.z - az) * truncateTo);
    } else if (hit) {
      endpoint = _shotPellet.copy(playerPos).add(_shotSpread.set((Math.random() - 0.5) * 0.25, -0.15, (Math.random() - 0.5) * 0.25));
    } else {
      endpoint = target;
    }
    ctx.fx.tracer(muzzle, endpoint, { color: 0xffc98a, width: 0.03, life: 0.05 });
    ctx.fx.muzzleFlash(muzzle);
    if (hit) {
      const dmg = (def.shotDamage[0] + Math.random() * (def.shotDamage[1] - def.shotDamage[0])) * this.damageMult;
      ctx.damagePlayer(dmg, this.root.position);
    }
    ctx.audio.enemyShot(pan, dist);
    this.weaponLevel = 1;
    if (!hit && dist < 26 && Math.random() > 0.5) ctx.audio.whiz(pan);
    if (ctx.onEnemyFire) ctx.onEnemyFire(this.root.position, this);
  }

  /** A* steering for ground agents; returns a unit direction or null to use
   *  the state's own straight-line steering (clear line of sight = cheaper). */
  followPath(nav, tgt, dt, targetY = 0) {
    const p = this.root.position;
    this.pathTimer -= dt;
    const moved = Math.hypot(tgt.x - this.navTarget.x, tgt.z - this.navTarget.z);
    if (!this.path || this.pathTimer <= 0 || moved > 2.2) {
      this.navTarget.x = tgt.x;
      this.navTarget.z = tgt.z;
      this.pathTimer = 0.85 + Math.random() * 0.55;
      // straight line shortcut only makes sense on the ground layer
      if (targetY < 1 && p.y < 1 && nav.lineWalkable(p.x, p.z, tgt.x, tgt.z)) {
        this.path = null;
        return null;
      }
      this.path = nav.findPath(p.x, p.z, p.y, tgt.x, tgt.z, targetY);
      this.pathI = 0;
      if (!this.path || !this.path.length) { this.path = null; this.followHeight = null; return null; }
      // string-pull the grid staircase into a readable diagonal
      if (targetY < 1 && p.y < 1) this.pathI = pullString(nav, this.path, 0, p.x, p.z, 4);
    }
    while (this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp.x - p.x, dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6) { this.pathI++; continue; }
      this.followHeight = nav.layerHeight ? nav.layerHeight(wp.layer) : null;
      return { x: dx / d, z: dz / d };
    }
    this.followHeight = null;
    return null;
  }

  dispose() {
    this.restoreMaterials();
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
