import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =========================================================================
 * Battlefield pickups + dropped weapons.
 *
 * Every item is authored part by part (lid, latch, straps, pips, rails, pin ...)
 * and merged into at most four meshes: matte, metal, additive glow, ground ring.
 * Geometry is cached per kind and shared by all instances; four vertex-coloured
 * materials cover the whole set, so the wallet of draw calls stays bounded.
 *
 * Intentional limits: dropped weapons are visual only (no collision, no ammo,
 * not collectable) and bounce off the floor but not walls; pickups never
 * respawn on their own.
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
 * grenades or a gear tier. `ring` is the floor halo, `hover` the float height. */
const KINDS = {
  ammo: { color: 0xffab4d, amount: 90, radius: 1.6, hover: 0.34, ring: [0.15, 0.225] },
  armor: { color: 0x6ea9d4, amount: 25, radius: 1.6, hover: 0.42, ring: [0.14, 0.21] },
  grenade: { color: 0x8fbc84, amount: 1, radius: 1.6, hover: 0.30, ring: [0.11, 0.17] },
  supply: { color: 0xd8d2c4, amount: { ammo: 60, armor: 20 }, radius: 2.2, hover: 0.42, ring: [0.22, 0.32] },
  // ---- battle-royale gear: wearable, level-exclusive (the caller decides
  // via its onCollect verdict whether this pickup may be taken at all) ----
  armor1: { color: 0x7fa8c9, amount: { level: 1 }, radius: 1.7, hover: 0.44, ring: [0.14, 0.21] },
  armor2: { color: 0x59c2f0, amount: { level: 2 }, radius: 1.7, hover: 0.46, ring: [0.15, 0.22] },
  armor3: { color: 0xbfe94f, amount: { level: 3 }, radius: 1.7, hover: 0.48, ring: [0.16, 0.23] },
  helmet1: { color: 0x9aa8b5, amount: { level: 1 }, radius: 1.6, hover: 0.36, ring: [0.12, 0.18] },
  helmet2: { color: 0x6fe3ff, amount: { level: 2 }, radius: 1.6, hover: 0.38, ring: [0.13, 0.19] },
  helmet3: { color: 0xd7b34f, amount: { level: 3 }, radius: 1.6, hover: 0.40, ring: [0.14, 0.20] },
  // ---- consumables: carried in the pack, used on a key press ----
  bandage: { color: 0xe8e2d2, amount: 1, radius: 1.5, hover: 0.28, ring: [0.10, 0.15] },
  medkit: { color: 0xff6a5e, amount: 1, radius: 1.6, hover: 0.32, ring: [0.13, 0.19] },
  drink: { color: 0x7fe08a, amount: 1, radius: 1.5, hover: 0.28, ring: [0.10, 0.15] },
};

/* --------------------------------------------------------------- palette */
const C = {
  metalDark: 0x24292c, metal: 0x59636b, steel: 0x9aa4ac, brass: 0xc2a45c,
  olive: 0x4d5741, oliveDark: 0x323a2b, tan: 0x7d7159, webbing: 0x30372d,
  cream: 0xe6dfcd, paper: 0xf0ead9, white: 0xeef1ee, red: 0xc9362d,
  black: 0x16191b, blue: 0x2f4a63,
};

/* ---------------------------------------------------- geometry builder */
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
const sph = (r, seg = 14) => new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
const tor = (r, tube, tubularSeg = 20, radialSeg = 8) => new THREE.TorusGeometry(r, tube, radialSeg, tubularSeg);
const cone = (r, h, seg = 10) => new THREE.ConeGeometry(r, h, seg);

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _col = new THREE.Color();

function paint(geo, hex, mul = 1) {
  _col.setHex(hex);                       // Color converts sRGB -> linear working space
  if (mul !== 1) _col.multiplyScalar(mul);
  const n = geo.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
}

/* scale -> rotate -> translate, then bake a flat vertex colour. */
function place(geo, p, r, s) {
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  _m4.compose(_v.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
  geo.applyMatrix4(_m4);
}

function makeBuilder() {
  const buckets = { matte: [], metal: [], glow: [] };
  return {
    add(bucket, geo, color, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
      place(geo, p, r, s);
      paint(geo, color);
      buckets[bucket].push(geo);
    },
    build() {
      // One opaque mesh for every matte/metal part (vertex colour carries the
      // difference) keeps the item at two draw calls including its glow ring.
      const opaque = buckets.matte.concat(buckets.metal);
      return {
        body: opaque.length ? mergeGeometries(opaque, false) : null,
        glow: buckets.glow.length ? mergeGeometries(buckets.glow, false) : null,
      };
    },
  };
}

function ringGeo(def) {
  const g = new THREE.RingGeometry(def.ring[0], def.ring[1], 28);
  g.rotateX(-Math.PI / 2);
  // baked darker: the halo shares the brighter glow material
  paint(g, def.color, 0.5);
  return g;
}

/* -------------------------------------------------------- item builders */
function buildAmmo(def) {
  const b = makeBuilder();
  // steel ammo can: body, lid, hinge, latch, carry handle
  b.add('matte', box(0.30, 0.19, 0.21), C.olive);
  b.add('matte', box(0.315, 0.04, 0.225), C.oliveDark, [0, 0.11, 0]);
  b.add('metal', box(0.322, 0.012, 0.012), C.metal, [0, 0.09, 0.114]);
  b.add('metal', box(0.09, 0.022, 0.03), C.metalDark, [0, 0.128, -0.104]);
  b.add('metal', box(0.05, 0.048, 0.02), C.metalDark, [0, 0.08, 0.114]);
  b.add('metal', box(0.068, 0.013, 0.024), C.steel, [0, 0.105, 0.114]);
  b.add('metal', box(0.15, 0.018, 0.022), C.metalDark, [0, 0.148, 0]);
  b.add('metal', box(0.015, 0.05, 0.022), C.metalDark, [-0.068, 0.122, 0]);
  b.add('metal', box(0.015, 0.05, 0.022), C.metalDark, [0.068, 0.122, 0]);
  // stencil stripes + glowing label line
  b.add('matte', box(0.24, 0.017, 0.008), def.color, [0, 0.005, 0.108]);
  b.add('matte', box(0.17, 0.011, 0.008), def.color, [0, -0.022, 0.108]);
  b.add('glow', box(0.25, 0.008, 0.012), def.color, [0, 0.088, 0.109]);
  // belt of visible rounds
  b.add('matte', box(0.23, 0.048, 0.028), C.webbing, [0, -0.06, 0.11]);
  for (let i = 0; i < 5; i++) {
    const x = -0.08 + i * 0.04;
    b.add('metal', cyl(0.010, 0.010, 0.032, 8), C.brass, [x, -0.06, 0.126], [0, 0, Math.PI / 2]);
    b.add('metal', cone(0.009, 0.014, 8), C.brass, [x, -0.06, 0.146], [Math.PI / 2, 0, 0]);
  }
  // corner guards + feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add('metal', box(0.028, 0.03, 0.03), C.metalDark, [sx * 0.138, -0.085, sz * 0.095]);
    b.add('metal', box(0.028, 0.03, 0.03), C.metalDark, [sx * 0.138, 0.086, sz * 0.095]);
    b.add('matte', box(0.038, 0.011, 0.038), C.black, [sx * 0.115, -0.1, sz * 0.075]);
  }
  return b.build();
}

function buildArmorPlate(def) {
  const b = makeBuilder();
  // loose ceramic plate with steel bevels
  b.add('matte', box(0.26, 0.30, 0.05), C.blue);
  b.add('metal', box(0.28, 0.013, 0.015), C.steel, [0, 0.15, 0]);
  b.add('metal', box(0.28, 0.013, 0.015), C.steel, [0, -0.15, 0]);
  b.add('metal', box(0.013, 0.28, 0.015), C.steel, [0.13, 0, 0]);
  b.add('metal', box(0.013, 0.28, 0.015), C.steel, [-0.13, 0, 0]);
  b.add('metal', box(0.022, 0.22, 0.012), C.metal, [0, 0, 0.03]);
  // raised strike face, so the plate reads as armour rather than a tile
  b.add('matte', box(0.16, 0.20, 0.025), 0x3a5c7a, [0, -0.01, 0.038]);
  b.add('metal', box(0.17, 0.012, 0.014), C.metal, [0, 0.098, 0.046]);
  // shoulder tabs and clips
  for (const sx of [-1, 1]) {
    b.add('matte', box(0.062, 0.052, 0.036), C.webbing, [sx * 0.09, 0.168, 0.0], [0, 0, sx * 0.26]);
    b.add('metal', box(0.048, 0.028, 0.036), C.metalDark, [sx * 0.095, 0.145, 0.008]);
    b.add('metal', box(0.013, 0.018, 0.036), C.steel, [sx * 0.095, 0.16, 0.01]);
  }
  b.add('glow', box(0.18, 0.009, 0.012), def.color, [0, 0.085, 0.031]);
  b.add('glow', box(0.011, 0.045, 0.012), def.color, [0, -0.125, 0.031]);
  return b.build();
}

function buildCarrier(def, tier) {
  const b = makeBuilder();
  // front/back plates, cummerbund, shoulder straps
  b.add('matte', box(0.28, 0.30, 0.085), C.webbing, [0, 0, 0.018]);
  b.add('matte', box(0.28, 0.28, 0.05), C.oliveDark, [0, 0.01, -0.07]);
  for (const sx of [-1, 1]) {
    b.add('matte', box(0.052, 0.17, 0.12), C.webbing, [sx * 0.152, -0.01, 0]);
    // shoulder straps lie over the top edge instead of standing up like posts
    b.add('matte', box(0.09, 0.032, 0.072), C.webbing, [sx * 0.098, 0.165, -0.012], [-0.5, 0, sx * 0.18]);
    b.add('matte', box(0.096, 0.022, 0.082), C.oliveDark, [sx * 0.108, 0.184, -0.032], [-0.35, 0, sx * 0.14]);
    b.add('metal', box(0.034, 0.046, 0.02), C.metalDark, [sx * 0.092, 0.16, 0.05]);
    b.add('metal', box(0.013, 0.09, 0.055), C.metal, [sx * 0.155, 0.02, 0.018]);
  }
  b.add('matte', box(0.13, 0.046, 0.05), C.oliveDark, [0, 0.175, 0.01]);
  // lower mag pouches give the carrier real silhouette depth
  for (const sx of [-1, 1]) {
    b.add('matte', box(0.078, 0.115, 0.045), C.oliveDark, [sx * 0.076, -0.072, 0.078]);
    b.add('metal', box(0.02, 0.02, 0.012), C.metalDark, [sx * 0.076, -0.03, 0.102]);
  }
  // tier trim: chest band, side tabs, neckline
  b.add('matte', box(0.22, 0.02, 0.012), def.color, [0, 0.112, 0.062]);
  b.add('matte', box(0.018, 0.08, 0.012), def.color, [0.126, 0.05, 0.103]);
  b.add('matte', box(0.018, 0.08, 0.012), def.color, [-0.126, 0.05, 0.103]);
  b.add('matte', box(0.09, 0.016, 0.012), def.color, [0, 0.15, 0.062]);
  // MOLLE rows sit on the upper chest, clear of the pouches
  for (let i = 0; i < 3; i++) b.add('matte', box(0.21, 0.013, 0.009), C.oliveDark, [0, 0.075 - i * 0.033, 0.062]);
  // level pips + readable glow line
  for (let i = 0; i < tier; i++) {
    b.add('glow', box(0.026, 0.026, 0.012), def.color, [(i - (tier - 1) / 2) * 0.046, -0.135, 0.101]);
  }
  b.add('glow', box(0.20, 0.007, 0.012), def.color, [0, -0.008, 0.101]);
  return b.build();
}

function buildHelmet(def, tier) {
  const b = makeBuilder();
  // dome, rim, front brim, top ridge
  b.add('matte', sph(0.14, 16), C.olive, [0, 0.018, 0], [0, 0, 0], [1, 0.84, 1.08]);
  b.add('metal', tor(0.14, 0.015), C.metalDark, [0, -0.042, 0], [Math.PI / 2, 0, 0]);
  b.add('matte', box(0.155, 0.02, 0.05), C.oliveDark, [0, -0.042, 0.125], [0.1, 0, 0]);
  b.add('matte', box(0.05, 0.012, 0.10), C.oliveDark, [0, 0.14, -0.005], [0.05, 0, 0]);
  // side rails (chin straps omitted: at pickup scale they read as legs)
  for (const sx of [-1, 1]) {
    b.add('metal', box(0.022, 0.03, 0.12), C.metal, [sx * 0.137, 0.028, -0.01]);
    b.add('metal', box(0.028, 0.028, 0.028), C.metalDark, [sx * 0.137, 0.028, 0.04]);
    b.add('metal', box(0.016, 0.018, 0.03), C.metalDark, [sx * 0.13, -0.058, 0.03]);
  }
  // NVG shroud, mount and knob
  b.add('metal', box(0.082, 0.018, 0.046), C.metalDark, [0, 0.05, 0.125]);
  b.add('metal', box(0.055, 0.05, 0.042), C.metal, [0, 0.083, 0.132]);
  b.add('metal', cyl(0.013, 0.013, 0.046, 8), C.steel, [0, 0.085, 0.16], [Math.PI / 2, 0, 0]);
  // tier band + glow tab
  b.add('matte', tor(0.138, 0.013), def.color, [0, -0.02, 0], [Math.PI / 2, 0, 0]);
  b.add('glow', box(0.09, 0.015, 0.012), def.color, [0, -0.02, 0.141]);
  // interior padding
  b.add('matte', box(0.15, 0.018, 0.11), C.webbing, [0, -0.028, -0.018]);
  return b.build();
}

function buildGrenade(def) {
  const b = makeBuilder();
  // segmented frag body
  b.add('metal', sph(0.075, 14), C.oliveDark, [0, 0, 0], [0, 0, 0], [1, 1.15, 1]);
  for (let i = 0; i < 3; i++) b.add('metal', tor(0.072, 0.004, 16, 6), C.metal, [0, -0.045 + i * 0.045, 0], [Math.PI / 2, 0, 0]);
  b.add('matte', tor(0.070, 0.010, 18, 6), def.color, [0, 0.058, 0], [Math.PI / 2, 0, 0]);
  // fuze head, lever, pin
  b.add('metal', cyl(0.03, 0.036, 0.03, 10), C.metalDark, [0, 0.105, 0]);
  b.add('metal', box(0.05, 0.045, 0.07), C.olive, [0, 0.14, -0.002]);
  b.add('metal', box(0.018, 0.10, 0.014), C.steel, [0.033, 0.135, -0.012], [0, 0, 0.12]);
  b.add('metal', tor(0.018, 0.005, 12, 6), C.brass, [-0.048, 0.138, 0], [0, Math.PI / 2, 0]);
  b.add('metal', cyl(0.004, 0.004, 0.05, 6), C.steel, [-0.028, 0.138, 0], [0, 0, Math.PI / 2]);
  b.add('glow', box(0.05, 0.008, 0.012), def.color, [0, 0.112, 0.043]);
  return b.build();
}

function buildSupply(def) {
  const b = makeBuilder();
  // crate body, lid and seam
  b.add('matte', box(0.46, 0.28, 0.36), C.tan);
  b.add('matte', box(0.49, 0.07, 0.39), C.oliveDark, [0, 0.175, 0]);
  b.add('metal', box(0.492, 0.012, 0.392), C.metalDark, [0, 0.14, 0]);
  // reinforced corners + edge strips
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add('metal', box(0.036, 0.30, 0.036), C.metal, [sx * 0.222, 0, sz * 0.168]);
    b.add('metal', box(0.05, 0.02, 0.05), C.metalDark, [sx * 0.222, 0.205, sz * 0.168]);
    b.add('metal', box(0.05, 0.02, 0.05), C.metalDark, [sx * 0.222, -0.148, sz * 0.168]);
  }
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    b.add('metal', box(0.47, 0.02, 0.02), C.metalDark, [0, sy * 0.142, sz * 0.187]);
  }
  // webbing straps with buckles
  for (const sx of [-1, 1]) {
    b.add('matte', box(0.055, 0.35, 0.395), C.webbing, [sx * 0.13, 0.02, 0]);
    b.add('metal', box(0.06, 0.05, 0.02), C.metalDark, [sx * 0.13, -0.03, 0.196]);
    b.add('metal', box(0.04, 0.03, 0.022), C.steel, [sx * 0.13, -0.005, 0.197]);
  }
  // white service cross + stencilled border
  b.add('matte', box(0.12, 0.028, 0.008), C.white, [0, 0.035, 0.197]);
  b.add('matte', box(0.028, 0.12, 0.008), C.white, [0, 0.035, 0.197]);
  b.add('glow', box(0.19, 0.012, 0.012), def.color, [0, 0.105, 0.197]);
  // side handles + feet
  for (const sx of [-1, 1]) {
    b.add('metal', box(0.03, 0.06, 0.10), C.metalDark, [sx * 0.248, 0.02, 0]);
    b.add('matte', box(0.05, 0.012, 0.05), C.black, [sx * 0.18, -0.146, 0.14]);
    b.add('matte', box(0.05, 0.012, 0.05), C.black, [sx * 0.18, -0.146, -0.14]);
  }
  return b.build();
}

function buildBandage(def) {
  const b = makeBuilder();
  // rolled gauze (axis X) with spiral grooves
  b.add('matte', cyl(0.065, 0.065, 0.13, 14), C.cream, [0, 0, 0], [0, 0, Math.PI / 2]);
  for (let i = -1; i <= 1; i++) b.add('matte', tor(0.058, 0.004, 14, 6), C.paper, [i * 0.042, 0, 0], [0, Math.PI / 2, 0]);
  // paper wrap + seam
  b.add('matte', box(0.09, 0.10, 0.11), C.paper);
  b.add('matte', box(0.012, 0.104, 0.114), C.cream, [-0.03, 0, 0]);
  // red cross on the wrap face
  b.add('matte', box(0.062, 0.016, 0.006), C.red, [0.008, 0.008, 0.057]);
  b.add('matte', box(0.016, 0.062, 0.006), C.red, [0.008, 0.008, 0.057]);
  // loose tail + metal clip
  b.add('matte', box(0.10, 0.012, 0.048), C.paper, [0.095, -0.028, 0.01], [0, 0, 0.1]);
  b.add('metal', box(0.022, 0.032, 0.06), C.metal, [0.072, 0, 0]);
  b.add('glow', box(0.07, 0.01, 0.012), def.color, [0, 0.02, 0.056]);
  return b.build();
}

function buildMedkit(def) {
  const b = makeBuilder();
  // hard case + lid + seam
  b.add('matte', box(0.34, 0.22, 0.19), C.cream);
  b.add('matte', box(0.35, 0.05, 0.20), C.paper, [0, 0.11, 0]);
  b.add('metal', box(0.352, 0.01, 0.202), C.metalDark, [0, 0.084, 0]);
  // handle arch + latches
  b.add('metal', box(0.15, 0.02, 0.03), C.metalDark, [0, 0.185, 0]);
  for (const sx of [-1, 1]) {
    b.add('metal', box(0.024, 0.05, 0.03), C.metalDark, [sx * 0.065, 0.16, 0]);
    b.add('metal', box(0.046, 0.044, 0.02), C.metal, [sx * 0.094, 0.09, 0.1]);
    b.add('metal', box(0.028, 0.016, 0.024), C.steel, [sx * 0.094, 0.07, 0.101]);
    // corner bumpers + feet
    b.add('metal', box(0.03, 0.03, 0.03), C.metalDark, [sx * 0.155, -0.1, 0.085]);
    b.add('metal', box(0.03, 0.03, 0.03), C.metalDark, [sx * 0.155, -0.1, -0.085]);
    b.add('matte', box(0.048, 0.011, 0.048), C.black, [sx * 0.122, -0.116, 0.058]);
    b.add('matte', box(0.048, 0.011, 0.048), C.black, [sx * 0.122, -0.116, -0.058]);
  }
  // red cross front + lid
  b.add('matte', box(0.125, 0.034, 0.008), C.red, [0, 0.012, 0.098]);
  b.add('matte', box(0.034, 0.125, 0.008), C.red, [0, 0.012, 0.098]);
  b.add('matte', box(0.11, 0.03, 0.008), C.red, [0, 0.137, 0]);
  b.add('glow', box(0.19, 0.008, 0.012), C.red, [0, -0.068, 0.097]);
  return b.build();
}

function buildDrink(def) {
  const b = makeBuilder();
  // aluminium can + top/bottom rims
  b.add('metal', cyl(0.045, 0.045, 0.15, 16), C.steel);
  b.add('metal', cyl(0.035, 0.045, 0.026, 16), C.metal, [0, 0.088, 0]);
  b.add('metal', cyl(0.035, 0.035, 0.008, 16), C.metalDark, [0, 0.104, 0]);
  b.add('metal', cyl(0.046, 0.046, 0.008, 16), C.metalDark, [0, -0.078, 0]);
  // pull tab
  b.add('metal', box(0.018, 0.006, 0.03), C.steel, [0.012, 0.11, 0]);
  b.add('metal', tor(0.011, 0.003, 10, 6), C.steel, [0.008, 0.112, 0.012], [Math.PI / 2, 0, 0]);
  // label band + energy stripes
  b.add('matte', cyl(0.047, 0.047, 0.072, 16), 0x22808f);
  b.add('matte', cyl(0.048, 0.048, 0.008, 16), C.metalDark, [0, 0.04, 0]);
  b.add('matte', cyl(0.048, 0.048, 0.008, 16), C.metalDark, [0, -0.04, 0]);
  for (const sx of [-1, 1]) b.add('glow', box(0.012, 0.055, 0.008), def.color, [sx * 0.022, 0, 0.046], [0, 0, sx * 0.5]);
  b.add('glow', box(0.06, 0.008, 0.008), def.color, [0, 0.038, 0.046]);
  return b.build();
}

const BUILDERS = {
  ammo: buildAmmo,
  armor: buildArmorPlate,
  armor1: (d) => buildCarrier(d, 1), armor2: (d) => buildCarrier(d, 2), armor3: (d) => buildCarrier(d, 3),
  helmet1: (d) => buildHelmet(d, 1), helmet2: (d) => buildHelmet(d, 2), helmet3: (d) => buildHelmet(d, 3),
  grenade: buildGrenade,
  supply: buildSupply,
  bandage: buildBandage,
  medkit: buildMedkit,
  drink: buildDrink,
};

/* ------------------------------------------------- shared item resources */
// Geometry per kind (built lazily, disposed by reset); four materials in total.
const assetCache = new Map();
let mats = null;

function materials() {
  if (mats) return mats;
  mats = {
    body: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.58, metalness: 0.34, envMapIntensity: 0.9,
    }),
    glow: new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }),
  };
  return mats;
}

function assets(kind) {
  let a = assetCache.get(kind);
  if (!a) {
    const def = KINDS[kind];
    const built = BUILDERS[kind](def);
    const parts = [];
    if (built.glow) {
      // Glow accents are baked in ground space so they can share one mesh with
      // the planted floor ring (the opaque body is the part that bobs).
      built.glow.translate(0, def.hover, 0);
      parts.push(built.glow);
    }
    parts.push(ringGeo(def));
    a = { body: built.body, glow: mergeGeometries(parts, false) };
    assetCache.set(kind, a);
  }
  return a;
}

// update() must not allocate; these module-scoped temps are reused synchronously.
const _wp = new THREE.Vector3(), _wq = new THREE.Quaternion(), _ws = new THREE.Vector3();
const _box = new THREE.Box3();

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
    // geometry/materials are pooled: reset() disposes them once, not per pickup
    pickups.splice(index, 1);
  }

  function spawn(kind, x, y, z, opts = {}) {
    const def = KINDS[kind];
    if (!def) return null;
    const m = materials();
    const a = assets(kind);

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

    // The item floats and bobs as one mesh; the glow accents + floor ring stay
    // planted in a single additive mesh (built in ground space).
    const body = new THREE.Mesh(a.body, m.body);
    body.position.y = def.hover;
    const glow = new THREE.Mesh(a.glow, m.glow);
    // Additive geometry has no usable normals: keep it out of the SSAO normal
    // pass or it smears a black halo on the floor (same reason as puddles).
    glow.userData.noAO = true;
    glow.renderOrder = 1;

    root.add(body, glow);
    scene.add(root);
    pickups.push({ kind, root, body, glow, surface, t: 0,
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
      for (const mt of w.fadeMats) mt.dispose();
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

      // Spin the whole prop and bob the item; the floor ring keeps its height.
      it.t += dt;
      it.root.rotation.y += SPIN * dt;
      it.body.position.y = def.hover + Math.sin(it.phase + it.t * FLOAT_HZ) * FLOAT_AMP;

      if (!playerPos) continue;
      const dx = px - it.root.position.x;
      const dz = pz - it.root.position.z;
      if (dx * dx + dz * dz > def.radius * def.radius) continue;
      // Vertical check: a street pickup is not collectable from the roof above.
      if (Math.abs(py - (it.surface + def.hover)) > V_TOLERANCE) continue;

      // The caller may refuse (e.g. a worse gear tier than the equipped one);
      // a refused pickup stays on the ground for whoever can use it.
      const verdict = onCollect ? onCollect(it.kind, it.amount) : true;
      if (verdict === false) continue;
      removePickup(i);
      if (audio && audio.uiConfirm) audio.uiConfirm();
      if (onNotify) onNotify(it.kind);
    }
  }

  function reset() {
    for (let i = pickups.length - 1; i >= 0; i--) removePickup(i);
    for (let i = weapons.length - 1; i >= 0; i--) removeWeapon(i);
    for (const a of assetCache.values()) {
      for (const key in a) if (a[key] && a[key].dispose) a[key].dispose();
    }
    assetCache.clear();
    if (mats) {
      for (const key in mats) mats[key].dispose();
      mats = null;
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
