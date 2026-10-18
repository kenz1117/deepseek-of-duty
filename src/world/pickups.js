import * as THREE from 'three';

/* =========================================================================
 * Battlefield pickups + dropped weapons.
 * Pickups are 3 pooled meshes; drops clone shared enemy geometry/materials.
 * Everything is capped (the frame is draw-call-bound).
 * Intentional limits: drops are visual only (no collision/ammo/pickup) and
 * bounce off the floor but not walls; pickups never respawn on their own.
 * ========================================================================= */

const MAX_PICKUPS = 10;
const MAX_WEAPONS = 8;
const WEAPON_LIFE = 25;          // seconds from drop to despawn
const WEAPON_FADE = 1.4;         // fade window at the end of that life
const GRAVITY = 18;
const REST_Y = 0.06;             // gun origin height above the floor while airborne
const V_TOLERANCE = 2.2;         // never grab a street pickup from the roof above
const SPIN = 0.9, FLOAT_AMP = 0.05, FLOAT_HZ = 1.9;   // yaw rad/s, +/- 5 cm bob, bob rate

/* `amount` is what the caller adds to the player: reserve rounds, armor points,
 * grenades. 'supply' is the one composite case, so its amount carries both. */
const KINDS = {
  ammo: { color: 0xffab4d, amount: 90, radius: 1.6, hover: 0.34, trimY: 0.070,
    body: [0.32, 0.19, 0.22], trim: [0.33, 0.022, 0.23], ring: [0.15, 0.225] },
  armor: { color: 0x6ea9d4, amount: 25, radius: 1.6, hover: 0.42, trimY: 0.095,
    body: [0.28, 0.32, 0.14], trim: [0.29, 0.034, 0.05], ring: [0.14, 0.21] },
  grenade: { color: 0x8fbc84, amount: 1, radius: 1.6, hover: 0.30, trimY: 0.12, ring: [0.11, 0.17] },
  supply: { color: 0xd8d2c4, amount: { ammo: 60, armor: 20 }, radius: 2.2, hover: 0.42,
    trimY: 0.15, body: [0.46, 0.30, 0.36], trim: [0.47, 0.026, 0.37], ring: [0.22, 0.32] },
};

// Built on first use, dropped by reset() so a restarted level leaks no buffers.
let pool = null;

// update() must not allocate; these module-scoped temps are reused synchronously.
const _wp = new THREE.Vector3(), _wq = new THREE.Quaternion(), _ws = new THREE.Vector3();
const _box = new THREE.Box3();

function buildPool() {
  const geo = {}, mat = {};
  for (const kind in KINDS) {
    const def = KINDS[kind];
    geo[kind] = kind === 'grenade'
      ? { body: new THREE.IcosahedronGeometry(0.105, 0), trim: new THREE.CylinderGeometry(0.045, 0.05, 0.07, 8) }
      : { body: new THREE.BoxGeometry(...def.body), trim: new THREE.BoxGeometry(...def.trim) };

    // Baked flat so every instance shares one ring pose.
    const ring = new THREE.RingGeometry(def.ring[0], def.ring[1], 28);
    ring.rotateX(-Math.PI / 2);
    geo[kind].ring = ring;

    mat[kind] = {
      body: new THREE.MeshStandardMaterial({
        color: 0x1d2126, roughness: 0.55, metalness: 0.40,
        emissive: new THREE.Color(def.color), emissiveIntensity: 0.05,
      }),
      // additive, no depth write: reads as emitted light rather than plastic
      glow: new THREE.MeshBasicMaterial({
        color: def.color, transparent: true, opacity: 0.62,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
      ring: new THREE.MeshBasicMaterial({
        color: def.color, transparent: true, opacity: 0.20,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      }),
    };
  }
  pool = { geo, mat };
  return pool;
}

export function createPickups({ scene, level, audio = null, onCollect, onNotify }) {
  const pickups = [];
  const weapons = [];
  // level always exposes this; the fallback keeps a half-built test scene alive.
  const groundAt = (x, z, y) => (level && level.groundHeight ? level.groundHeight(x, z, y) : 0);
  const bounds = level && level.bounds ? level.bounds : null;

  /* ------------------------------------------------------------- pickups */
  function removePickup(index) {
    const it = pickups[index];
    if (!it) return;
    scene.remove(it.root);
    // geometry/material are pooled: reset() disposes them once, not per pickup
    pickups.splice(index, 1);
  }

  function spawn(kind, x, y, z, opts = {}) {
    const def = KINDS[kind];
    if (!def) return null;
    const p = pool || buildPool();

    let px = x, pz = z;   // keep crates inside the playable rectangle
    if (bounds) {
      px = Math.min(bounds.x1 - 0.6, Math.max(bounds.x0 + 0.6, px));
      pz = Math.min(bounds.z1 - 0.6, Math.max(bounds.z0 + 0.6, pz));
    }
    // y is the height we drop *from*: passing it to groundHeight lets the same
    // call land on a roof (its ceiling is y + 0.6) or on the street when low.
    const surface = groundAt(px, pz, y === undefined || y === null ? 0 : y);

    while (pickups.length >= MAX_PICKUPS) removePickup(0);
    const root = new THREE.Group();
    root.position.set(px, surface, pz);
    root.rotation.y = opts.yaw !== undefined ? opts.yaw : Math.random() * Math.PI * 2;

    const body = new THREE.Mesh(p.geo[kind].body, p.mat[kind].body);
    body.position.y = def.hover;

    const trim = new THREE.Mesh(p.geo[kind].trim, p.mat[kind].glow);
    trim.position.y = def.hover + def.trimY;
    // Additive strips have no usable normals: keep them out of the SSAO normal
    // pass or they smear a black halo on the floor (same reason as puddles).
    trim.userData.noAO = true;

    const ring = new THREE.Mesh(p.geo[kind].ring, p.mat[kind].ring);
    ring.position.y = 0.015;
    ring.userData.noAO = true;
    ring.renderOrder = 1;

    root.add(body, trim, ring);
    scene.add(root);
    pickups.push({ kind, root, body, trim, surface, t: 0,
      phase: Math.random() * Math.PI * 2,
      amount: opts.amount !== undefined ? opts.amount : def.amount });
    return pickups[pickups.length - 1];
  }

  /* -------------------------------------------------------- weapon drops */
  function removeWeapon(index) {
    const w = weapons[index];
    if (!w) return;
    scene.remove(w.root);
    // Only the private fade copies are ours; clone geometry/material are shared.
    if (w.fadeMats) {
      for (const m of w.fadeMats) m.dispose();
      w.fadeMats = null;
    }
    weapons.splice(index, 1);
  }

  function startWeaponFade(w) {
    /* Shared materials must never be touched: the same instance is still on the
     * corpse and on every living rifleman. Copy per unique material once, fade
     * the copy, dispose it on despawn (same trick as enemy.js corpse fade). */
    const seen = new Map();
    w.fadeMats = [];
    w.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const src = o.material;
      let copy = seen.get(src);
      if (!copy) {
        copy = src.clone();
        copy.transparent = true;
        copy.depthWrite = false;
        copy.opacity = 1;
        seen.set(src, copy);
        w.fadeMats.push(copy);
      }
      o.material = copy;
    });
  }

  function settleWeapon(w, ground) {
    w.landed = true;
    w.vx = 0; w.vy = 0; w.vz = 0;
    w.ax = 0; w.ay = 0; w.az = 0;
    // The clone's origin is the pistol grip, not its lowest point. Measure the
    // resting pose once and sink it until the lowest vertex meets the floor.
    _box.setFromObject(w.root);
    if (Number.isFinite(_box.min.y)) w.root.position.y += (ground + 0.01) - _box.min.y;
  }

  function dropWeapon(sourceGroup, position, velocity) {
    if (!sourceGroup) return null;
    // The weapon is posed under the torso, so use its world transform, not local.
    sourceGroup.updateWorldMatrix(true, false);
    sourceGroup.matrixWorld.decompose(_wp, _wq, _ws);
    const clone = sourceGroup.clone(true);

    // Muzzle flash / scope glint are sprites owned by the living enemy; a dropped
    // rifle has no business carrying them (and each costs a draw call).
    const junk = [];
    clone.traverse((o) => {
      if (o.isSprite || o.isPoints || o.isLine) { junk.push(o); return; }
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
      // Keep noAO only: every other marker belongs to enemy-internal systems and
      // is stale once the clone is detached.
      if (o.userData) for (const k in o.userData) if (k !== 'noAO') delete o.userData[k];
    });
    for (const o of junk) if (o.parent) o.parent.remove(o);

    // The holder carries the world transform and is what physics moves; the clone
    // keeps only its gun shape (its own hand offset is neutralised).
    clone.position.set(0, 0, 0); clone.quaternion.identity(); clone.scale.set(1, 1, 1); clone.visible = true;

    const root = new THREE.Group();
    root.add(clone);
    root.position.copy(position || _wp);
    root.quaternion.copy(_wq);
    root.scale.copy(_ws);
    scene.add(root);

    while (weapons.length >= MAX_WEAPONS) removeWeapon(0);
    const w = {
      root, landed: false, age: 0, fadeMats: null,
      vx: velocity ? velocity.x : (Math.random() - 0.5) * 2.6,
      vy: velocity ? velocity.y : 1.7 + Math.random() * 1.8,
      vz: velocity ? velocity.z : (Math.random() - 0.5) * 2.6,
      ax: (Math.random() - 0.5) * 7,
      ay: (Math.random() - 0.5) * 9,
      az: (Math.random() - 0.5) * 7,
    };
    weapons.push(w);
    return w;
  }

  function updateWeapon(w, dt) {
    const p = w.root.position;
    w.age += dt;

    if (!w.landed) {
      w.vy -= GRAVITY * dt;
      const prevY = p.y;
      p.x += w.vx * dt;
      p.y += w.vy * dt;
      p.z += w.vz * dt;
      w.root.rotation.x += w.ax * dt;
      w.root.rotation.y += w.ay * dt;
      w.root.rotation.z += w.az * dt;

      // Probe the highest of previous/current y: groundHeight only reports floors
      // up to y + 0.6, so probing the fallen y would let a roof drop tunnel to the street.
      const g = groundAt(p.x, p.z, Math.max(prevY, p.y));
      if (p.y <= g + REST_Y) {
        if (w.vy < -1.6) {
          p.y = g + REST_Y;
          w.vy = -w.vy * 0.34;
          w.vx *= 0.55; w.vz *= 0.55;
          w.ax *= 0.45; w.ay *= 0.50; w.az *= 0.45;
        } else {
          settleWeapon(w, g);
        }
      }

      // Cheap "walls": keep drops in the street without a collider query.
      if (bounds) {
        if (p.x < bounds.x0 + 0.4) { p.x = bounds.x0 + 0.4; w.vx = Math.abs(w.vx) * 0.3; }
        else if (p.x > bounds.x1 - 0.4) { p.x = bounds.x1 - 0.4; w.vx = -Math.abs(w.vx) * 0.3; }
        if (p.z < bounds.z0 + 0.4) { p.z = bounds.z0 + 0.4; w.vz = Math.abs(w.vz) * 0.3; }
        else if (p.z > bounds.z1 - 0.4) { p.z = bounds.z1 - 0.4; w.vz = -Math.abs(w.vz) * 0.3; }
      }
    }

    if (w.age >= WEAPON_LIFE - WEAPON_FADE) {
      if (!w.fadeMats) startWeaponFade(w);
      const a = Math.max(0, (WEAPON_LIFE - w.age) / WEAPON_FADE);
      for (let i = 0; i < w.fadeMats.length; i++) w.fadeMats[i].opacity = a;
    }
  }

  function update(dt, playerPos) {
    if (!(dt > 0)) return;

    for (let i = weapons.length - 1; i >= 0; i--) {
      const w = weapons[i];
      updateWeapon(w, dt);
      if (w.age >= WEAPON_LIFE) removeWeapon(i);
    }

    const px = playerPos ? playerPos.x : 0;
    const py = playerPos ? playerPos.y : 0;
    const pz = playerPos ? playerPos.z : 0;

    for (let i = pickups.length - 1; i >= 0; i--) {
      const it = pickups[i];
      const def = KINDS[it.kind];

      // Spin the whole prop, bob body+trim, keep the floor ring planted.
      it.t += dt;
      it.root.rotation.y += SPIN * dt;
      const bob = Math.sin(it.phase + it.t * FLOAT_HZ) * FLOAT_AMP;
      it.body.position.y = def.hover + bob;
      it.trim.position.y = def.hover + def.trimY + bob;

      if (!playerPos) continue;
      const dx = px - it.root.position.x;
      const dz = pz - it.root.position.z;
      if (dx * dx + dz * dz > def.radius * def.radius) continue;
      // Vertical check: a street pickup is not collectable from the roof above.
      if (Math.abs(py - (it.surface + def.hover)) > V_TOLERANCE) continue;

      removePickup(i);
      if (onCollect) onCollect(it.kind, it.amount);
      if (audio && audio.uiConfirm) audio.uiConfirm();
      if (onNotify) onNotify(it.kind);
    }
  }

  function reset() {
    for (let i = pickups.length - 1; i >= 0; i--) removePickup(i);
    for (let i = weapons.length - 1; i >= 0; i--) removeWeapon(i);
    if (pool) {
      for (const kind in pool.geo) for (const key in pool.geo[kind]) pool.geo[kind][key].dispose();
      for (const kind in pool.mat) for (const key in pool.mat[kind]) pool.mat[kind][key].dispose();
      pool = null;
    }
  }

  return {
    spawn,
    dropWeapon,
    update,
    reset,
    get counts() {
      return { pickups: pickups.length, weapons: weapons.length, total: pickups.length + weapons.length };
    },
  };
}
