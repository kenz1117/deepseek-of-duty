import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =========================================================================
   soldierParts.js — procedural modern-warfare soldier rig.

   Conventions (important):
     * the soldier FACES -Z (three.js forward), his right hand is at +X
     * origin of the returned root is between the soles; total height 1.82 m
     * every animated pivot is a Group; static gear is merged per material, so
       one soldier costs ~32 meshes / draw calls
     * two-bone IK puts both hands on the rifle and both feet on the ground,
       so nothing floats and the knees really bend
   ========================================================================= */

const TAU = Math.PI * 2;
const Y_DOWN = new THREE.Vector3(0, -1, 0);
const TEX = 0.42; // metres per cloth-texture repeat

/* ---------------------------------------------------------------- utilities */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function nonIndexed(g) {
  return g.index ? g.toNonIndexed() : g;
}

function scaleBoxUV(g, w, h, d, S = TEX) {
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [u, v] = dims[f];
    for (let i = 0; i < 6; i++) {
      const k = f * 6 + i;
      uv.setXY(k, uv.getX(k) * u / S, uv.getY(k) * v / S);
    }
  }
  uv.needsUpdate = true;
}

function box(w, h, d, S = TEX) {
  const g = nonIndexed(new THREE.BoxGeometry(w, h, d));
  scaleBoxUV(g, w, h, d, S);
  return g;
}

function rbox(w, h, d, r = 0.02) {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.45));
  return nonIndexed(g);
}

function torus(r, tube, rs = 6, ts = 20) {
  return nonIndexed(new THREE.TorusGeometry(r, tube, rs, ts));
}

function cyl(rTop, rBot, h, seg = 10, S = TEX, open = false) {
  const g = nonIndexed(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open));
  const uv = g.attributes.uv;
  const circ = TAU * Math.max(rTop, rBot);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / S, uv.getY(i) * h / S);
  uv.needsUpdate = true;
  return g;
}

function sph(r, seg = 12, thetaStart = 0, thetaLen = Math.PI, S = TEX) {
  const g = nonIndexed(new THREE.SphereGeometry(
    r, seg, Math.max(5, (seg * 0.72) | 0), 0, TAU, thetaStart, thetaLen
  ));
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TAU * r / S, uv.getY(i) * Math.PI * r / S);
  uv.needsUpdate = true;
  return g;
}

function place(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  _m4.compose(_v.set(p[0], p[1], p[2]), _q, _v2.set(s[0], s[1], s[2]));
  g.applyMatrix4(_m4);
  if (g.normalizeNormals) g.normalizeNormals();
  return g;
}

function makeBuilder() {
  const buckets = new Map();
  return {
    add(geo, mat) {
      let a = buckets.get(mat);
      if (!a) buckets.set(mat, (a = []));
      a.push(geo);
    },
    part(geo, mat, p, r, s) { this.add(place(geo, p, r, s), mat); },
    build(parent, castMats, receiveMats, meshes) {
      for (const [mat, geos] of buckets) {
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (!merged) {
          for (const g of geos) {
            const m = new THREE.Mesh(g, mat);
            m.castShadow = !!(castMats && castMats.has(mat));
            m.receiveShadow = !!(receiveMats && receiveMats.has(mat));
            parent.add(m);
            if (meshes) meshes.push(m);
          }
          continue;
        }
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = !!(castMats && castMats.has(mat));
        mesh.receiveShadow = !!(receiveMats && receiveMats.has(mat));
        parent.add(mesh);
        if (meshes) meshes.push(mesh);
      }
      buckets.clear();
    },
  };
}

/* ------------------------------------------------------- procedural textures */

let _normalCache = null;

function fabricNormal() {
  if (_normalCache) return _normalCache;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  const h = new Float32Array(S * S);
  const rnd = mulberry32(9182);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      h[y * S + x] = (Math.sin(x * 1.9) + Math.sin(y * 1.9)) * 0.5 + (rnd() - 0.5) * 0.9;
    }
  }
  const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      const i = (y * S + x) * 4;
      d[i] = 128 + dx * 26;
      d[i + 1] = 128 + dy * 26;
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _normalCache = t;
  return t;
}

/** seamless multi-tone camouflage + cloth folds + grime */
function camoTexture(V) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(1013 + V.id * 7331);

  g.fillStyle = V.base;
  g.fillRect(0, 0, S, S);

  const cols = [V.c1, V.c2, V.c3, V.c4];
  const blob = (cx, cy, r, n) => {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      const rr = r * (0.5 + rnd() * 0.8);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (0.7 + rnd() * 0.5)]);
    }
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const sx = cx + ox * S;
        const sy = cy + oy * S;
        if (sx < -70 || sx > S + 70 || sy < -70 || sy > S + 70) continue;
        g.beginPath();
        for (let k = 0; k < pts.length; k++) {
          const x = pts[k][0] + ox * S;
          const y = pts[k][1] + oy * S;
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        g.fill();
      }
    }
  };

  for (let pass = 0; pass < 3; pass++) {
    const count = [34, 90, 70][pass];
    const size = [36, 15, 9][pass];
    g.globalAlpha = [0.95, 0.9, 0.86][pass];
    for (let i = 0; i < count; i++) {
      g.fillStyle = cols[(rnd() * cols.length) | 0];
      blob(rnd() * S, rnd() * S, size * (0.55 + rnd() * 0.9), 5 + ((rnd() * 5) | 0));
    }
  }
  g.globalAlpha = 1;

  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  const grain = mulberry32(4411 + V.id);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const fold =
        Math.sin(x * 0.075 + Math.sin(y * 0.012) * 2.1) * 8 +
        Math.sin(x * 0.21 + y * 0.03) * 2.5;
      const weave = ((x & 1) ? 3.2 : -3.2) + ((y & 1) ? 2.4 : -2.4);
      const n = (grain() - 0.5) * 20;
      const mud = Math.max(0, Math.sin(x * 0.02 + y * 0.013) * 0.5 + 0.5);
      const mudAmt = mud * Math.max(0, y / S - 0.55) * 46;
      d[i] = Math.max(0, Math.min(255, d[i] + fold + weave + n - mudAmt * 0.9));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + fold + weave + n - mudAmt * 0.95));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + fold + weave + n - mudAmt * 1.15));
    }
  }
  g.putImageData(img, 0, 0);

  g.globalAlpha = 0.12;
  for (let i = 0; i < 40; i++) {
    g.fillStyle = i % 3 === 0 ? '#cfc6ac' : '#171a14';
    const r = 3 + rnd() * 14;
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, r, r * (0.2 + rnd() * 0.5), rnd() * TAU, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ------------------------------------------------------------ material sets */

const VARIANTS = [
  {
    id: 0, name: 'woodland',
    base: '#4e4c39', c1: '#39402c', c2: '#1f231c', c3: '#6c6448', c4: '#3f3728',
    clothTint: 0xffffff, gear: '#4a4b3e', gear2: '#5b5d49', glove: '#4b4234',
    leather: '#27231d', skin: '#a3785a', metalTint: '#33373a',
    face: 'balaclava', goggles: 'eyes', nvg: 'mount', pack: true,
  },
  {
    id: 1, name: 'desert',
    base: '#8d7a58', c1: '#ac9a72', c2: '#645840', c3: '#77664a', c4: '#b5a37c',
    clothTint: 0xf4efe6, gear: '#544c3c', gear2: '#8a7a58', glove: '#6b5a40',
    leather: '#403225', skin: '#b0835f', metalTint: '#3f3d35',
    face: 'shemagh', goggles: 'helmet', nvg: 'stowed', pack: true,
  },
  {
    id: 2, name: 'urban',
    base: '#4a5053', c1: '#31383c', c2: '#1d2327', c3: '#666c6c', c4: '#3c4343',
    clothTint: 0xf2f4f4, gear: '#41474d', gear2: '#525b62', glove: '#2f3337',
    leather: '#1a1c1f', skin: '#8e6a52', metalTint: '#2e3336',
    face: 'mask', goggles: 'eyes', nvg: 'active', pack: false,
  },
];

const _variantMats = new Map();

function materialsFor(V) {
  if (_variantMats.has(V.id)) return _variantMats.get(V.id);
  const camo = camoTexture(V);
  const nrm = fabricNormal();
  const nScale = new THREE.Vector2(0.65, 0.65);

  const cloth = new THREE.MeshStandardMaterial({
    map: camo, normalMap: nrm, normalScale: nScale, color: V.clothTint,
    roughness: 0.93, metalness: 0.02, envMapIntensity: 0.95,
  });
  const gear = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.gear), roughness: 0.84, metalness: 0.1, envMapIntensity: 0.8,
  });
  const gear2 = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.gear2), roughness: 0.9, metalness: 0.04, envMapIntensity: 0.75,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.metalTint), roughness: 0.52, metalness: 0.68, envMapIntensity: 0.95,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x111314, roughness: 0.92, metalness: 0.02, envMapIntensity: 0.5,
  });
  const glove = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.glove), roughness: 0.84, metalness: 0.03, envMapIntensity: 0.65,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.skin), roughness: 0.7, metalness: 0.0, envMapIntensity: 0.7,
  });
  const leather = new THREE.MeshStandardMaterial({
    color: new THREE.Color(V.leather), roughness: 0.72, metalness: 0.06, envMapIntensity: 0.85,
  });
  const lens = new THREE.MeshStandardMaterial({
    color: 0x0b1418, roughness: 0.08, metalness: 0.94, envMapIntensity: 2.4,
  });
  const out = { cloth, gear, gear2, metal, rubber, glove, skin, leather, lens, V };
  _variantMats.set(V.id, out);
  return out;
}

// weapon materials are shared by every soldier (and kept off the game's
// mirror-like gunmetal so the rifle doesn't blow out against the sky)
let _gunMats = null;
function gunMaterials() {
  if (_gunMats) return _gunMats;
  _gunMats = {
    metal: new THREE.MeshStandardMaterial({
      color: 0x232527, roughness: 0.58, metalness: 0.50, envMapIntensity: 0.45,
    }),
    polymer: new THREE.MeshStandardMaterial({
      color: 0x1b1c1e, roughness: 0.68, metalness: 0.42, envMapIntensity: 0.40,
    }),
    // kept for API symmetry; furniture now uses the dark polymer too
    tanPolymer: new THREE.MeshStandardMaterial({
      color: 0x1b1c1e, roughness: 0.68, metalness: 0.42, envMapIntensity: 0.40,
    }),
  };
  return _gunMats;
}

/* ---------------------------------------------------------------- two-bone IK */

const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikElbow = new THREE.Vector3();
const _ikY = new THREE.Vector3();
const _ikD2 = new THREE.Vector3();
const _ikX = new THREE.Vector3();
const _ikZ = new THREE.Vector3();
const _ikLocal = new THREE.Vector3();

/** allocation-free two-bone solve in the hip group's parent space */
function solveTwoBone(hip, joint, target, a, b, pole) {
  const S = hip.position;
  _ikDir.subVectors(target, S);
  let d = _ikDir.length();
  if (d < 1e-5) return;
  const maxD = a + b - 0.004;
  const minD = Math.abs(a - b) + 0.02;
  if (d > maxD) _ikDir.multiplyScalar(maxD / d);
  else if (d < minD) _ikDir.normalize().multiplyScalar(minD);
  d = _ikDir.length();
  _ikDir.divideScalar(d);

  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

  _ikPole.copy(pole).addScaledVector(_ikDir, -pole.dot(_ikDir));
  if (_ikPole.lengthSq() < 1e-7) _ikPole.set(0, 0, 1).addScaledVector(_ikDir, -_ikDir.z);
  _ikPole.normalize();

  _ikElbow.copy(S).addScaledVector(_ikDir, a * cosA).addScaledVector(_ikPole, a * sinA);

  _ikY.subVectors(S, _ikElbow).normalize();
  _ikD2.subVectors(target, _ikElbow).normalize();
  _ikX.crossVectors(_ikY, _ikD2);
  if (_ikX.lengthSq() < 1e-8) _ikX.set(1, 0, 0).addScaledVector(_ikY, -_ikY.x);
  _ikX.normalize();
  _ikZ.crossVectors(_ikX, _ikY).normalize();
  _ikX.crossVectors(_ikY, _ikZ).normalize();

  _m4.makeBasis(_ikX, _ikY, _ikZ);
  hip.quaternion.setFromRotationMatrix(_m4);

  _q.copy(hip.quaternion).invert();
  _ikLocal.copy(_ikD2).applyQuaternion(_q);
  joint.quaternion.setFromUnitVectors(Y_DOWN, _ikLocal);
}

/* ------------------------------------------------------------------- build */

const HIP_Y = 0.935;
const THIGH = 0.435;
const SHIN = 0.395;
const UPPER_ARM = 0.31;
const FORE_ARM = 0.285;

// rifle anchors in weapon space (origin = top of the pistol grip,
// -Z muzzle, +Z stock). Left hand sits on the rear of the handguard.
const ANCHOR_R = new THREE.Vector3(0, 0.012, 0.02);
const ANCHOR_L = new THREE.Vector3(0, 0.083, -0.356);

export function buildSoldier(mats, variantIndex = 0) {
  const V = VARIANTS[variantIndex % VARIANTS.length];
  const M = materialsFor(V);
  const GUN = gunMaterials();
  const meshes = [];
  const cast = new Set([M.cloth, M.gear, M.leather, GUN.metal, GUN.polymer, GUN.tanPolymer]);
  const recv = new Set([M.cloth, M.gear, M.leather]);

  const root = new THREE.Group(); // feet on y=0, faces -Z
  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  root.add(hips);

  /* ------------------------------------------------------------ pelvis */
  {
    const b = makeBuilder();
    b.part(rbox(0.325, 0.21, 0.22, 0.045), M.cloth, [0, 0.02, 0]);
    b.part(rbox(0.30, 0.13, 0.195, 0.04), M.cloth, [0, -0.075, 0.005]);
    b.part(box(0.285, 0.10, 0.055), M.cloth, [0, 0.02, 0.118], [0.14, 0, 0]);
    b.build(hips, cast, recv, meshes);

    const g = makeBuilder();
    g.part(rbox(0.34, 0.08, 0.24, 0.018), M.gear, [0, 0.085, 0]);          // belt
    g.part(box(0.055, 0.042, 0.02), M.metal, [0, 0.085, -0.124]);          // buckle
    for (const sx of [-1, 1]) {
      g.part(rbox(0.085, 0.11, 0.06, 0.016), M.gear, [sx * 0.105, 0.045, -0.118]);
      g.part(box(0.07, 0.02, 0.05), M.metal, [sx * 0.105, 0.102, -0.12]);
    }
    g.part(rbox(0.105, 0.115, 0.06, 0.016), M.gear, [0.105, 0.03, 0.118]);  // dump pouch
    g.part(rbox(0.035, 0.155, 0.052, 0.012), M.gear, [-0.16, -0.005, 0.02], [0, 0, 0.09]);
    g.part(box(0.045, 0.04, 0.014), M.metal, [-0.163, 0.072, 0.02]);
    g.part(cyl(0.044, 0.044, 0.11, 8), M.gear, [-0.145, 0.01, 0.105]);      // canteen
    g.build(hips, cast, recv, meshes);
  }

  /* ------------------------------------------------------------- torso */
  const torso = new THREE.Group();
  torso.position.y = 0.095;
  torso.rotation.order = 'YXZ';
  hips.add(torso);

  {
    // one builder per animated group: one merged mesh per material
    const b = makeBuilder();
    // --- cloth volumes
    b.part(rbox(0.362, 0.34, 0.262, 0.072), M.cloth, [0, 0.285, 0.0]);   // chest
    b.part(rbox(0.312, 0.18, 0.228, 0.05), M.cloth, [0, 0.085, 0.005]);  // abdomen
    b.part(rbox(0.425, 0.122, 0.215, 0.06), M.cloth, [0, 0.405, 0.005]); // yoke
    b.part(cyl(0.055, 0.063, 0.11, 8), M.cloth, [0, 0.49, 0.005]);       // neck
    b.part(cyl(0.083, 0.077, 0.062, 10), M.cloth, [0, 0.448, 0.005]);    // collar

    // --- plate carrier body + straps (dark nylon)
    b.part(rbox(0.322, 0.29, 0.08, 0.03), M.gear, [0, 0.25, -0.14]);
    b.part(rbox(0.312, 0.278, 0.062, 0.024), M.gear, [0, 0.26, 0.132]);
    for (const sx of [-1, 1]) {
      b.part(rbox(0.048, 0.17, 0.225, 0.016), M.gear, [sx * 0.178, 0.14, 0.0]);
      b.part(box(0.072, 0.03, 0.135), M.gear, [sx * 0.11, 0.404, -0.055], [0.25, 0, 0]);
      b.part(box(0.068, 0.026, 0.125), M.gear, [sx * 0.108, 0.404, 0.064], [-0.3, 0, 0]);
      // side plate pouch
      b.part(rbox(0.055, 0.095, 0.08, 0.014), M.gear, [sx * 0.19, 0.105, -0.035]);
    }
    // hydration tube over the left shoulder
    b.part(cyl(0.009, 0.009, 0.10, 6), M.gear, [0.12, 0.40, 0.03], [0.5, 0, -0.25]);
    b.part(cyl(0.009, 0.009, 0.15, 6), M.gear, [0.124, 0.335, -0.09], [1.3, 0, 0]);
    // radio on the back-right of the carrier, antenna rakes back
    b.part(rbox(0.064, 0.12, 0.044, 0.014), M.gear, [0.152, 0.296, 0.108]);
    b.part(cyl(0.005, 0.0034, 0.30, 5), M.gear, [0.158, 0.525, 0.15], [-0.30, 0, 0.12]);
    // pack
    if (V.pack) {
      b.part(rbox(0.26, 0.22, 0.12, 0.034), M.gear, [0, 0.30, 0.222]);
      b.part(rbox(0.215, 0.085, 0.085, 0.024), M.gear2, [0, 0.402, 0.212]);
      b.part(box(0.24, 0.022, 0.03), M.gear2, [0, 0.255, 0.284]);
    } else {
      b.part(rbox(0.235, 0.25, 0.09, 0.028), M.gear, [0, 0.30, 0.2]);
      b.part(box(0.2, 0.02, 0.025), M.gear2, [0, 0.26, 0.248]);
    }

    // --- webbing, pouches and shoulder pads (lighter tone)
    for (const px of [-0.10, 0, 0.10]) {
      b.part(rbox(0.082, 0.125, 0.06, 0.016), M.gear2, [px, 0.125, -0.207]);
      b.part(box(0.068, 0.024, 0.05), M.gear, [px, 0.19, -0.212]);
      b.part(box(0.015, 0.06, 0.016), M.gear, [px, 0.148, -0.238]);
    }
    b.part(rbox(0.095, 0.085, 0.05, 0.012), M.gear2, [-0.11, 0.318, -0.185]);
    b.part(box(0.30, 0.018, 0.014), M.gear2, [0, 0.245, -0.192]);
    b.part(box(0.30, 0.018, 0.014), M.gear2, [0, 0.34, -0.192]);
    for (const sx of [-1, 1]) {
      b.part(rbox(0.118, 0.05, 0.175, 0.022), M.gear2, [sx * 0.178, 0.452, 0.0], [0, 0, sx * 0.30]);
    }
    // chest light
    b.part(cyl(0.019, 0.021, 0.055, 8), M.metal, [-0.112, 0.385, -0.19], [Math.PI / 2, 0, 0]);
    b.build(torso, cast, recv, meshes);
  }

  /* -------------------------------------------------------------- head */
  const headPivot = new THREE.Group();
  headPivot.position.y = 0.505;
  headPivot.rotation.order = 'YXZ';
  torso.add(headPivot);
  buildHead(headPivot, M, V, meshes, cast, recv);

  /* -------------------------------------------------------------- arms */
  const mkArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.197, 0.415, 0.0);
    shoulder.rotation.order = 'YXZ';
    torso.add(shoulder);

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    shoulder.add(elbow);

    const hand = new THREE.Group();
    hand.position.y = -FORE_ARM;
    elbow.add(hand);

    const b = makeBuilder();
    b.part(sph(0.076, 10), M.cloth, [0, -0.01, 0], [0, 0, 0], [1.0, 0.95, 1.06]);
    b.part(cyl(0.063, 0.052, UPPER_ARM, 10), M.cloth, [0, -UPPER_ARM * 0.5, 0]);
    b.part(cyl(0.055, 0.052, 0.055, 10), M.cloth, [0, -UPPER_ARM + 0.024, 0]);
    // issue patch on the upper arm
    b.part(box(0.05, 0.065, 0.012), M.cloth, [side * 0.055, -0.13, -0.02], [0, side * 0.35, 0]);
    b.build(shoulder, cast, recv, meshes);

    const f = makeBuilder();
    f.part(cyl(0.053, 0.046, FORE_ARM, 10), M.cloth, [0, -FORE_ARM * 0.5, 0]);
    f.part(cyl(0.056, 0.05, 0.10, 10), M.cloth, [0, -0.065, 0]); // rolled cuff
    f.build(elbow, cast, recv, meshes);

    const gl = makeBuilder();
    gl.part(rbox(0.064, 0.10, 0.09, 0.026), M.glove, [0, -0.055, -0.004]);
    gl.part(rbox(0.056, 0.038, 0.03, 0.012), M.glove, [side * 0.044, -0.035, 0.002]);
    for (let k = 0; k < 3; k++) {
      gl.part(rbox(0.052, 0.018, 0.019, 0.006), M.glove, [0, -0.078, -0.048]);
    }
    gl.part(rbox(0.028, 0.048, 0.04, 0.012), M.glove, [-side * 0.034, -0.05, -0.03]);
    gl.build(hand, cast, recv, meshes);

    return { shoulder, elbow, hand };
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  /* -------------------------------------------------------------- legs */
  const mkLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.108, 0, 0);
    hip.rotation.order = 'YXZ';
    hips.add(hip);

    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    hip.add(knee);

    const ankle = new THREE.Group();
    ankle.position.y = -SHIN;
    knee.add(ankle);

    const b = makeBuilder();
    b.part(cyl(0.099, 0.079, THIGH, 10), M.cloth, [0, -THIGH * 0.5, 0]);
    b.part(sph(0.09, 8), M.cloth, [0, -0.005, 0], [0, 0, 0], [0.96, 0.8, 1.0]);
    b.build(hip, cast, recv, meshes);

    const g = makeBuilder();
    g.part(rbox(0.066, 0.14, 0.05, 0.015), M.gear, [side * 0.07, -0.19, -0.012]);
    g.part(box(0.06, 0.022, 0.04), M.gear, [side * 0.07, -0.125, -0.014]);
    if (side > 0) {
      // drop-leg holster with a stowed pistol grip
      g.part(rbox(0.088, 0.165, 0.06, 0.018), M.gear, [0.072, -0.215, -0.008]);
      g.part(box(0.032, 0.075, 0.038), M.gear, [0.072, -0.128, 0.014], [0.28, 0, 0]);
      g.part(box(0.032, 0.026, 0.045), M.metal, [0.072, -0.088, 0.028], [0.28, 0, 0]);
      g.part(box(0.098, 0.024, 0.11), M.gear, [0.066, -0.288, -0.012]);
      g.part(box(0.095, 0.022, 0.105), M.gear, [0.066, -0.15, -0.006]);
    } else {
      g.part(rbox(0.062, 0.09, 0.045, 0.012), M.gear, [-0.07, -0.10, 0.012]);
    }
    g.build(hip, cast, recv, meshes);

    const k = makeBuilder();
    k.part(rbox(0.125, 0.13, 0.08, 0.03), M.gear, [0, -0.022, -0.05], [0.12, 0, 0]);
    k.part(box(0.108, 0.022, 0.04), M.gear, [0, 0.038, -0.048]);
    k.build(knee, cast, recv, meshes);

    const s = makeBuilder();
    s.part(cyl(0.078, 0.062, 0.05, 10), M.cloth, [0, -0.012, 0]);
    s.part(cyl(0.062, 0.052, SHIN, 10), M.cloth, [0, -SHIN * 0.5, 0]);
    s.part(cyl(0.066, 0.062, 0.075, 10), M.cloth, [0, -SHIN + 0.034, 0]);
    s.build(knee, cast, recv, meshes);

    const bt = makeBuilder();
    bt.part(rbox(0.112, 0.125, 0.135, 0.024), M.leather, [0, 0.008, 0.0]);
    bt.part(rbox(0.118, 0.078, 0.26, 0.028), M.leather, [0, -0.055, -0.055]);
    bt.part(rbox(0.128, 0.034, 0.29, 0.014), M.leather, [0, -0.089, -0.057]);
    bt.part(rbox(0.11, 0.056, 0.065, 0.018), M.leather, [0, -0.062, -0.178]);
    bt.part(box(0.104, 0.02, 0.032), M.leather, [0, -0.02, -0.105]);
    bt.part(box(0.106, 0.018, 0.03), M.leather, [0, -0.038, -0.075]);
    bt.build(ankle, cast, recv, meshes);

    return { hip, knee, ankle };
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  /* ------------------------------------------------------------- rifle */
  const weapon = new THREE.Group();
  weapon.rotation.order = 'YXZ';
  torso.add(weapon);
  const weaponMuzzle = new THREE.Object3D();
  const muzzleLocal = new THREE.Vector3(0, 0.052, -0.60);
  weaponMuzzle.position.copy(muzzleLocal);
  weapon.add(weaponMuzzle);

  {
    const mt = makeBuilder();
    const pl = makeBuilder();
    const pol = GUN.polymer;
    const dark = GUN.polymer;
    const rail = 0.16;

    // receiver group (origin = top of the pistol grip, -Z forward)
    mt.part(box(0.05, 0.078, 0.26, rail), GUN.metal, [0, 0.046, -0.11]);
    mt.part(box(0.046, 0.05, 0.13, rail), GUN.metal, [0, -0.002, -0.12]);
    mt.part(box(0.014, 0.03, 0.055), GUN.metal, [0.027, 0.052, -0.12]); // ejection port
    mt.part(box(0.028, 0.016, 0.30, rail), GUN.metal, [0, 0.09, -0.13]); // top rail
    for (let i = 0; i < 8; i++) mt.part(box(0.03, 0.009, 0.013), GUN.metal, [0, 0.098, -0.02 - i * 0.026]);
    // handguard
    pl.part(cyl(0.032, 0.029, 0.26, 8, 0.3), pol, [0, 0.052, -0.37], [Math.PI / 2, 0, 0], [1, 1, 0.85]);
    mt.part(box(0.026, 0.013, 0.24, rail), GUN.metal, [0, 0.081, -0.37]);
    mt.part(box(0.013, 0.024, 0.17), GUN.metal, [0.034, 0.05, -0.365]);
    mt.part(box(0.013, 0.024, 0.17), GUN.metal, [-0.034, 0.05, -0.365]);
    // barrel + brake
    mt.part(cyl(0.0115, 0.0115, 0.135, 8), GUN.metal, [0, 0.052, -0.505], [Math.PI / 2, 0, 0]);
    mt.part(cyl(0.016, 0.014, 0.062, 8), GUN.metal, [0, 0.052, -0.577], [Math.PI / 2, 0, 0]);
    mt.part(cyl(0.0175, 0.0175, 0.013, 8), GUN.metal, [0, 0.052, -0.548], [Math.PI / 2, 0, 0]);
    mt.part(box(0.028, 0.03, 0.032), GUN.metal, [0, 0.077, -0.493]); // gas block
    // magazine (two blocks approximate the curve)
    pl.part(rbox(0.032, 0.12, 0.068, 0.009), dark, [0, -0.077, -0.155], [0.06, 0, 0]);
    pl.part(rbox(0.032, 0.085, 0.063, 0.009), dark, [0, -0.16, -0.172], [0.24, 0, 0]);
    pl.part(box(0.036, 0.014, 0.072), dark, [0, -0.202, -0.182], [0.24, 0, 0]);
    // grip + trigger guard
    pl.part(rbox(0.035, 0.105, 0.052, 0.015), pol, [0, -0.045, 0.022], [-0.33, 0, 0]);
    pl.part(box(0.02, 0.009, 0.06), dark, [0, -0.012, -0.02]);
    // buffer tube + stock
    mt.part(cyl(0.017, 0.017, 0.10, 8), GUN.metal, [0, 0.055, 0.06], [Math.PI / 2, 0, 0]);
    pl.part(rbox(0.048, 0.09, 0.115, 0.014), pol, [0, 0.035, 0.185]);
    pl.part(rbox(0.04, 0.024, 0.10, 0.01), pol, [0, 0.088, 0.175]);
    pl.part(rbox(0.052, 0.098, 0.016, 0.006), pol, [0, 0.032, 0.248]);
    // optic
    mt.part(box(0.036, 0.013, 0.08), GUN.metal, [0, 0.104, -0.055]);
    mt.part(box(0.052, 0.062, 0.017), GUN.metal, [0, 0.148, -0.088]);
    mt.part(box(0.052, 0.022, 0.064), GUN.metal, [0, 0.172, -0.06]);
    mt.part(box(0.052, 0.062, 0.015), GUN.metal, [0, 0.148, -0.012]);
    mt.part(box(0.028, 0.013, 0.032), GUN.metal, [0, 0.07, 0.012]);
    // optic glass uses the variant's lens material
    mt.build(weapon, cast, null, meshes);
    pl.build(weapon, cast, null, meshes);

    const ln = makeBuilder();
    ln.part(box(0.038, 0.044, 0.007), M.lens, [0, 0.148, -0.083]);
    ln.build(weapon, null, null, meshes);
  }

  /* ------------------------------------------------------- muzzle flash */
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: mats.sprites.flash, color: 0xffe0b0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0,
  }));
  flash.scale.setScalar(0.5);
  flash.position.copy(muzzleLocal);
  weapon.add(flash);

  return {
    root, body: root, hips, torso, headPivot,
    armL, armR, legL, legR,
    weapon, weaponMuzzle, weaponFlash: flash,
    variant: V, meshes,
    anchorR: ANCHOR_R, anchorL: ANCHOR_L,
    height: 1.82, eyeHeight: 1.685,
    dispose() {
      for (const m of meshes) if (m.geometry) m.geometry.dispose();
      flash.material.dispose();
    },
  };
}

/* ------------------------------------------------------------------- head */

function buildHead(headPivot, M, V, meshes, cast, recv) {
  // single builder -> one merged mesh per material on the head
  const b = makeBuilder();

  // skull / jaw / ears
  b.part(sph(0.1, 14), M.skin, [0, 0.155, 0], [0, 0, 0], [0.79, 0.96, 0.9]);
  b.part(sph(0.09, 12), M.skin, [0, 0.107, -0.016], [0, 0, 0], [0.64, 0.56, 0.62]);
  for (const sx of [-1, 1]) {
    b.part(sph(0.024, 8), M.skin, [sx * 0.077, 0.152, 0.006], [0, 0, 0], [0.55, 1.0, 0.8]);
  }

  // full balaclava + neck gaiter (no skin band anywhere)
  b.part(sph(0.103, 14, 0.86, Math.PI - 0.86), M.gear, [0, 0.158, 0.002], [0, 0, 0], [0.815, 1.0, 0.935]);
  b.part(cyl(0.064, 0.075, 0.12, 10), M.gear, [0, 0.015, 0.0]);

  // helmet: closed-ish cap sitting above the goggles
  b.part(sph(0.106, 18, 0, 1.63), M.cloth, [0, 0.186, 0.0], [0, 0, 0], [1.04, 0.98, 1.10]);
  // cloth rim ring (torus: no caps, so it can't slice the face)
  b.part(torus(0.105, 0.009, 6, 20), M.cloth, [0, 0.1805, 0.0], [Math.PI / 2, 0, 0], [1, 1, 1.06]);
  // scrim band around the helmet (open tube)
  b.part(cyl(0.1095, 0.1095, 0.024, 20, 0.35, true), M.gear2, [0, 0.207, 0.0], [0, 0, 0], [1, 1, 1.06]);
  // crown strap
  b.part(box(0.032, 0.018, 0.20, 0.2), M.cloth, [0, 0.281, 0.012], [0.1, 0, 0]);

  // shemagh variant wraps the neck and lower face
  if (V.face === 'shemagh') {
    b.part(rbox(0.162, 0.105, 0.165, 0.04), M.cloth, [0, 0.098, -0.004]);
    b.part(rbox(0.178, 0.06, 0.16, 0.032), M.cloth, [0, 0.158, 0.022], [0.2, 0, 0]);
  }

  // goggles sit just under the helmet rim
  if (V.goggles === 'eyes' || V.face === 'mask') {
    b.part(rbox(0.144, 0.056, 0.048, 0.016), M.gear, [0, 0.150, -0.077], [0.06, 0, 0]);
    b.part(box(0.156, 0.028, 0.026), M.gear, [0, 0.150, -0.05]);
    for (const sx of [-1, 1]) b.part(box(0.019, 0.038, 0.095), M.gear, [sx * 0.084, 0.150, -0.012]);
  } else {
    b.part(rbox(0.144, 0.056, 0.058, 0.016), M.gear, [0, 0.252, -0.072], [0.95, 0, 0]);
    for (const sx of [-1, 1]) b.part(box(0.019, 0.032, 0.08), M.gear, [sx * 0.084, 0.244, -0.02]);
  }
  if (V.face === 'mask') {
    b.part(rbox(0.132, 0.108, 0.095, 0.03), M.gear, [0, 0.09, -0.05]);
    b.part(cyl(0.03, 0.03, 0.028, 10), M.gear, [0, 0.095, -0.112], [Math.PI / 2, 0, 0]);
  } else {
    // neoprene half-mask: hides the goggle/balaclava seam and reads as a face
    b.part(rbox(0.142, 0.088, 0.052, 0.022), M.gear, [0, 0.096, -0.072]);
    b.part(box(0.06, 0.014, 0.02), M.gear2, [0, 0.05, -0.096]);
  }
  // chin strap
  for (const sx of [-1, 1]) {
    b.part(box(0.013, 0.10, 0.013), M.gear, [sx * 0.073, 0.09, -0.012], [0, 0, sx * 0.12]);
  }
  b.part(box(0.066, 0.02, 0.017), M.gear, [0, 0.04, -0.048]);

  // NVG mount + side rails (metal)
  b.part(rbox(0.054, 0.044, 0.03, 0.008), M.metal, [0, 0.244, -0.092]);
  b.part(box(0.026, 0.052, 0.017), M.metal, [0, 0.214, -0.097], [0.25, 0, 0]);
  for (const sx of [-1, 1]) {
    b.part(box(0.015, 0.026, 0.105), M.metal, [sx * 0.1, 0.196, -0.005]);
    b.part(box(0.013, 0.013, 0.032), M.metal, [sx * 0.106, 0.17, -0.046]);
  }
  if (V.nvg === 'active') {
    b.part(box(0.035, 0.03, 0.04), M.metal, [0, 0.248, -0.12]);
    for (const sx of [-1, 1]) {
      b.part(cyl(0.02, 0.022, 0.058, 10), M.metal, [sx * 0.025, 0.258, -0.16], [Math.PI / 2, 0, 0]);
      b.part(cyl(0.021, 0.021, 0.008, 10), M.lens, [sx * 0.025, 0.258, -0.19], [Math.PI / 2, 0, 0]);
    }
  } else if (V.nvg === 'stowed') {
    b.part(box(0.044, 0.044, 0.054), M.metal, [0, 0.29, -0.056], [0.95, 0, 0]);
  }

  // goggle glass
  if (V.goggles === 'eyes' || V.face === 'mask') {
    b.part(box(0.128, 0.04, 0.01), M.lens, [0, 0.150, -0.1], [0.06, 0, 0]);
  }

  b.build(headPivot, cast, null, meshes);
}

/* --------------------------------------------------------------- animation */

const _hipQInv = new THREE.Quaternion();
const _armQ = new THREE.Quaternion();
const _footQ = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _legQ = new THREE.Quaternion();
const _footTarget = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Pose the rig. All inputs are already-smoothed values from the AI layer.
 * Allocation free.
 */
export function applyPose(rig, P) {
  const { hips, torso, headPivot, legL, legR, armL, armR, weapon } = rig;

  const crouch = P.crouch || 0;
  const amp = P.walkAmp || 0;
  const phase = P.walkPhase || 0;
  const aim = P.aim == null ? 1 : P.aim;
  const level = P.weaponLevel || 0;
  const aimPitch = P.aimPitch || 0;
  const flinch = P.flinch || 0;
  const recoil = P.recoil || 0;
  const limp = P.limp || 0;
  const t = P.time || 0;
  const breathe = Math.sin(t * 1.55);

  /* hips */
  const bob = amp * (0.022 * Math.abs(Math.sin(phase)) + 0.006 * Math.sin(phase * 2));
  hips.position.set(
    Math.sin(phase) * 0.012 * amp,
    HIP_Y - crouch * 0.285 - bob + breathe * 0.0035 - limp * 0.05,
    0
  );
  const blade = aim * 0.13;
  hips.rotation.set(0, -Math.sin(phase) * 0.10 * amp + blade, 0);

  /* torso */
  const lean = crouch * 0.38 + amp * 0.10 + limp * 0.08;
  torso.rotation.set(
    -lean + flinch * 0.34 + recoil * 0.035 + breathe * 0.005,
    Math.sin(phase) * 0.135 * amp + aim * 0.045 - blade * 0.72,
    Math.sin(phase) * 0.028 * amp - flinch * 0.06 + Math.sin(t * 0.7) * 0.004,
    'YXZ'
  );
  const bodyPitch = hips.rotation.x + torso.rotation.x;
  const bodyYaw = hips.rotation.y + torso.rotation.y;

  /* rifle in torso space
     ready: canted across the chest so the muzzle/side read from the front
     leveled (firing): muzzle on the target */
  const low = 1 - aim;
  weapon.position.set(
    0.132 + 0.05 * low,
    (0.218 - 0.118 * low) + breathe * 0.0045 + recoil * 0.012 - limp * 0.075,
    (-0.185 + 0.065 * low) + recoil * 0.030
  );
  const targetPitch = aim * (aimPitch - (1 - level) * 0.075) + low * (-0.58) + limp * 0.10;
  const targetYaw = aim * (0.06 + (1 - level) * 0.36) + low * 0.62 - limp * 0.10;
  weapon.rotation.set(
    targetPitch - bodyPitch + recoil * 0.05,
    targetYaw - bodyYaw,
    -0.12 - 0.14 * low + Math.sin(t * 0.9) * 0.004,
    'YXZ'
  );
  _qw.copy(weapon.quaternion);

  /* arms: two-bone IK onto the rifle */
  _footTarget.copy(rig.anchorR).applyQuaternion(_qw).add(weapon.position);
  _pole.set(0.45, -1.0, 0.30);
  solveTwoBone(armR.shoulder, armR.elbow, _footTarget, UPPER_ARM, FORE_ARM, _pole);
  _footTarget.copy(rig.anchorL).applyQuaternion(_qw).add(weapon.position);
  _pole.set(-0.62, -1.0, 0.18);
  solveTwoBone(armL.shoulder, armL.elbow, _footTarget, UPPER_ARM, FORE_ARM, _pole);

  // fists lock to the weapon orientation
  _armQ.multiplyQuaternions(armR.shoulder.quaternion, armR.elbow.quaternion).invert();
  armR.hand.quaternion.copy(_armQ).multiply(_qw);
  _armQ.multiplyQuaternions(armL.shoulder.quaternion, armL.elbow.quaternion).invert();
  armL.hand.quaternion.copy(_armQ).multiply(_qw);

  /* legs: procedural gait + IK, feet stay on the ground */
  // stride/cadence tuned so planted feet travel with the body (little sliding)
  const stride = 0.26 * amp * (1 + 0.5 * amp);
  const lift = 0.06 * amp + 0.03 * amp * amp;
  _hipQInv.copy(hips.quaternion).invert();

  const solveLeg = (leg, side, p) => {
    const swing = Math.max(0, -Math.sin(p));
    const fx = side * 0.128 + limp * side * 0.09;
    const fy = 0.105 + swing * lift + limp * 0.14;
    const fz = -Math.cos(p) * stride + (side < 0 ? -0.035 : 0.04) + crouch * 0.035 +
      limp * (side < 0 ? -0.16 : 0.22);
    _footTarget.set(fx, fy, fz).sub(hips.position).applyQuaternion(_hipQInv);
    _pole.set(side * 0.30, 0, -1).applyQuaternion(_hipQInv);
    solveTwoBone(leg.hip, leg.knee, _footTarget, THIGH, SHIN, _pole);

    const footPitch = swing * 0.28 * amp + limp * 0.4;
    _legQ.copy(leg.hip.quaternion).multiply(leg.knee.quaternion).invert();
    _footQ.setFromEuler(_lookEuler.set(footPitch, side * 0.055, 0, 'YXZ'));
    leg.ankle.quaternion.copy(_legQ).multiply(_footQ);
  };
  solveLeg(legL, -1, phase);
  solveLeg(legR, 1, phase + Math.PI);

  /* head */
  const lookYaw = (P.lookYaw || 0) - bodyYaw;
  headPivot.rotation.set(
    THREE.MathUtils.clamp(aimPitch * 0.9 - bodyPitch, -0.55, 0.6) + flinch * 0.16 - limp * 0.30 + breathe * 0.006,
    THREE.MathUtils.clamp(lookYaw, -1.05, 1.05),
    (P.headRoll || 0) + flinch * 0.12 * (P.flinchSide || 1) + limp * 0.5 * (P.deathSide || 1),
    'YXZ'
  );
}
