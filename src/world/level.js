import * as THREE from 'three';
import { projectBoxUV, mergeStatic } from '../core/geo.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../core/materials.js';
import { buildBoundsTreeFor } from '../core/bvh.js';

/* =========================================================================
   LEVEL: "AL-MAZRAH CROSSING" — a contested city block at dusk.
   Art direction: low warm sun down the street, thick dust haze, teal shadows,
   burnt-out vehicles, sandbags, cables, and a gatehouse framing the far end.

   Facade system:
     - close buildings are built from a real 0.5 m screen wall: piers, spandrels,
       recessed window cavities, sills, lintels, mullions, dark/lit glass.
     - mid buildings keep a texture panel but with world-sized window modules,
       per-building UV offsets and extra trim so nothing repeats.
   ========================================================================= */

const OUT = 9.85;          // outer facade plane (street side)
const SCREEN = 0.5;        // facade screen thickness
const WALL = OUT + SCREEN; // building body face
const ROAD = 6.9;          // asphalt half width
const SW = OUT - ROAD;     // sidewalk width
const SWX = (ROAD + OUT) / 2;

export function createLevel(engine) {
  const { mats } = engine;
  const scene = engine.scene;
  const root = new THREE.Group();
  const statics = new THREE.Group();
  const dynamic = new THREE.Group();
  const farGroup = new THREE.Group();
  root.add(statics, farGroup, dynamic);
  scene.add(root);

  const colliders = [];   // {x0,x1,z0,z1}
  const breachDoors = [];
  const interactiveDoors = [];
  const interactiveWindows = [];
  const bulletTargets = [];
  const spawnPoints = [];
  const coverPoints = [];
  const fires = [];
  const rnd = mulberry32(20261018);
  let shopLights = 0;          // budget: keep the point-light count sane
  let seaMatRef = null;

  const rr = (a, b) => a + rnd() * (b - a);
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  const T = 2.4;          // default world texture tile (m)

  /* ------------------------------------------------------------------ utils */
  function add(mesh, group = statics) { group.add(mesh); return mesh; }

  // `top` is the world-space height of the collider so movement, bullets and
  // line-of-sight can ignore geometry below the agent's feet / eye line.
  function addColliderRect(x0, x1, z0, z1, top = 10) { const c = { x0, x1, z0, z1, top }; colliders.push(c); return c; }
  function addCollider(cx, cz, w, d, pad = 0, top = 10) {
    return addColliderRect(cx - w / 2 - pad, cx + w / 2 + pad, cz - d / 2 - pad, cz + d / 2 + pad, top);
  }
  function addColliderRot(cx, cz, w, d, rot = 0, pad = 0.05, top = 10) {
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    return addCollider(cx, cz, w * c + d * s, w * s + d * c, pad, top);
  }

  const roundedCache = new Map();
  function roundedGeo(w, h, d, r, uv = 1.4) {
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r}|${uv}`;
    if (!roundedCache.has(key)) {
      const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.48));
      projectBoxUV(g, uv);
      roundedCache.set(key, g);
    }
    return roundedCache.get(key).clone();
  }

  /** box whose top face is scaled in X/Z - reads as a tapered car cabin */
  function taperGeo(w, h, d, tx = 0.9, tz = 0.9) {
    const g = new THREE.BoxGeometry(w, h, d);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > h * 0.49) { p.setX(i, p.getX(i) * tx); p.setZ(i, p.getZ(i) * tz); }
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }

  function meshBox(w, h, d, mat, x, y, z, rotY = 0, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    projectBoxUV(geo, opts.uv ?? T);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(opts.rx || 0, rotY, opts.rz || 0);
    m.castShadow = opts.cast !== false;
    m.receiveShadow = opts.recv !== false;
    add(m, opts.group || statics);
    if (opts.collide) addColliderRot(x, z, w, d, rotY, opts.pad ?? 0.04, y + h / 2);
    return m;
  }

  function meshRound(w, h, d, r, mat, x, y, z, rotY = 0, opts = {}) {
    const geo = roundedGeo(w, h, d, r, opts.uv ?? 1.4);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(opts.rx || 0, rotY, opts.rz || 0);
    m.castShadow = opts.cast !== false;
    m.receiveShadow = opts.recv !== false;
    add(m, opts.group || statics);
    if (opts.collide) addColliderRot(x, z, w, d, rotY, opts.pad ?? 0.04, y + h / 2);
    return m;
  }

  function meshCyl(rt, rb, h, seg, mat, x, y, z, opts = {}) {
    const geo = new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!opts.open);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
    m.castShadow = opts.cast !== false;
    m.receiveShadow = opts.recv !== false;
    add(m, opts.group || statics);
    return m;
  }

  function meshPlane(w, h, mat, x, y, z, opts = {}) {
    const g = new THREE.PlaneGeometry(w, h, opts.seg || 1, opts.seg || 1);
    if (opts.uvScale) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / opts.uvScale, uv.getY(i) * h / opts.uvScale);
    }
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.set(opts.rx || 0, opts.ry || 0, opts.rz || 0);
    m.castShadow = !!opts.cast;
    m.receiveShadow = opts.recv !== false;
    add(m, opts.group || statics);
    return m;
  }

  /** facade panel with explicit texture module size + UV offset (kills tiling) */
  function meshPanel(w, h, tileW, tileH, offU, offV, mat, x, y, z, rotY, opts = {}) {
    const g = new THREE.PlaneGeometry(w, h, 1, 1);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (w / tileW) + offU, uv.getY(i) * (h / tileH) + offV);
    }
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.castShadow = false;
    m.receiveShadow = true;
    add(m, opts.group || statics);
    return m;
  }

  /* ---- contact shadows + fake light pools (no extra lights needed) ------ */
  const blobMat = new THREE.MeshBasicMaterial({
    map: mats.sprites.glow, color: 0x000000, transparent: true, opacity: 0.42,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  blobMat.userData.noShadow = true; blobMat.userData.noBullet = true;
  const poolMat = new THREE.MeshBasicMaterial({
    map: mats.sprites.glow, color: 0xff7c34, transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  poolMat.userData.noShadow = true; poolMat.userData.noBullet = true;

  const blobMats = new Map();
  const poolMats = new Map();
  function blob(x, z, rx, rz, op = 0.44, rot = 0, y = 0.013) {
    const key = op.toFixed(2);
    if (!blobMats.has(key)) {
      const mm = blobMat.clone();
      mm.opacity = op;
      blobMats.set(key, mm);
    }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(rx * 2, rz * 2), blobMats.get(key));
    m.rotation.set(-Math.PI / 2, 0, rot);
    m.position.set(x, y, z);
    m.renderOrder = 2;
    statics.add(m);
    return m;
  }
  function lightPool(x, z, r, op = 0.4, color = null) {
    const key = op.toFixed(2) + (color || '');
    if (!poolMats.has(key)) {
      const mm = poolMat.clone();
      mm.opacity = op;
      if (color) mm.color = new THREE.Color(color);
      poolMats.set(key, mm);
    }
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 18), poolMats.get(key));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.016, z);
    m.renderOrder = 3;
    statics.add(m);
    return m;
  }

  /* ------------------------------------------------------------------ ground */
  function buildGround() {
    // dirt under everything (fills alley / gaps so there is never a void)
    const dirt = new THREE.Mesh(new THREE.PlaneGeometry(90, 210), mats.dirt);
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = -0.06;
    dirt.receiveShadow = true;
    statics.add(dirt);

    // ---- road: world-space UVs, 2.6 m tile
    const rw = ROAD * 2, rl = 152;
    const roadGeo = new THREE.PlaneGeometry(rw, rl, 1, 1);
    roadGeo.rotateX(-Math.PI / 2);
    roadGeo.translate(0, 0, -6);
    const pos = roadGeo.attributes.position, ruv = roadGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) ruv.setXY(i, pos.getX(i) / 2.6, pos.getZ(i) / 2.6);
    const road = new THREE.Mesh(roadGeo, mats.asphalt);
    road.receiveShadow = true;
    statics.add(road);

    // ---- sidewalks: individual slabs so joints + level drift read
    for (const side of [-1, 1]) {
      for (let z = -72; z < 58; z += 5.3) {
        const len = 5.3 - 0.035;
        const hh = 0.155 + (rnd() - 0.5) * 0.012;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(SW, hh, len), mats.concrete);
        projectBoxUV(slab.geometry, 2.2);
        slab.position.set(side * SWX, hh / 2 - 0.005, z + len / 2);
        slab.rotation.y = (rnd() - 0.5) * 0.004;
        slab.rotation.z = (rnd() - 0.5) * 0.003;
        slab.castShadow = false; slab.receiveShadow = true;
        statics.add(slab);
      }
      // curb stones
      for (let z = -72; z < 58; z += 2.0) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 1.94), mats.concrete);
        projectBoxUV(c.geometry, 1.6);
        c.position.set(side * (ROAD + 0.03), 0.1, z + 0.98);
        c.castShadow = false; c.receiveShadow = true;
        statics.add(c);
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.035, 1.96), mats.concreteDark);
        projectBoxUV(top.geometry, 1.4);
        top.position.set(side * (ROAD + 0.03), 0.2, z + 0.98);
        top.castShadow = false; top.receiveShadow = true;
        statics.add(top);
      }
      // gutter stain strip
      meshPlane(0.62, 130, mats.patch, side * (ROAD - 0.36), 0.006, -7, { rx: -Math.PI / 2, uvScale: 2.2, recv: true });
    }

    // ---- drains along the curb
    for (const side of [-1, 1]) {
      for (const z of [38, 14, -12, -38, -58]) {
        const x = side * (ROAD - 0.22);
        meshBox(0.44, 0.06, 0.86, mats.metal, x, 0.028, z, 0, { uv: 0.8, cast: false });
        meshBox(0.5, 0.05, 0.94, mats.concreteDark, x, 0.012, z, 0, { uv: 1, cast: false });
        for (let i = 0; i < 4; i++) meshBox(0.36, 0.03, 0.07, mats.rubber, x, 0.062, z - 0.28 + i * 0.19, 0, { cast: false });
      }
    }

    // ---- manholes
    for (const [mx, mz] of [[1.9, 15.5], [-2.7, -21], [4.4, -46], [-4.2, 35]]) {
      const collar = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.58, 22), mats.concreteDark);
      collar.rotation.x = -Math.PI / 2; collar.position.set(mx, 0.011, mz); statics.add(collar);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.03, 20), mats.rust);
      projectBoxUV(lid.geometry, 0.9);
      lid.position.set(mx, 0.02, mz); lid.receiveShadow = true; statics.add(lid);
      for (let i = 0; i < 5; i++) {
        meshBox(0.58, 0.012, 0.045, mats.metal, mx, 0.037, mz - 0.15 + i * 0.075, 0, { uv: 0.5, cast: false });
      }
      meshBox(0.34, 0.014, 0.34, mats.patch, mx, 0.038, mz, 0, { uv: 0.5, cast: false });
    }

    // ---- road markings (worn paint)
    const paint = mats.paint;
    for (let z = 52; z > -60; z -= 7.4) {
      meshPlane(0.15, 2.9, paint, 0, 0.014, z, { rx: -Math.PI / 2, uvScale: 1.05, cast: false });
    }
    // crosswalk (zebra bars parallel to travel) - old, thin, half erased
    for (let i = 0; i < 9; i++) {
      const x = -5.0 + i * 1.25;
      meshPlane(0.44, 3.0, paint, x + (rnd() - 0.5) * 0.09, 0.015, 17.4 + (rnd() - 0.5) * 0.1, {
        rx: -Math.PI / 2, rz: (rnd() - 0.5) * 0.012, uvScale: 0.95, cast: false,
      });
    }
    // stop line + a few surviving edge dashes
    meshPlane(5.6, 0.3, paint, -3.2, 0.014, 15.1, { rx: -Math.PI / 2, uvScale: 0.9, cast: false });
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        meshPlane(0.08, 7.5, paint, side * 6.45, 0.013, 44 - k * 26, { rx: -Math.PI / 2, uvScale: 1.2, cast: false });
      }
    }
    // one faded lane arrow
    {
      const ax = 3.1, az = 5.5;
      meshPlane(0.3, 2.1, paint, ax, 0.014, az, { rx: -Math.PI / 2, uvScale: 1.1, cast: false });
      const head = new THREE.Mesh(new THREE.CircleGeometry(0.46, 3), paint);
      head.rotation.set(-Math.PI / 2, 0, Math.PI);
      head.scale.set(0.66, 1, 1);
      head.position.set(ax, 0.014, az - 1.36);
      statics.add(head);
    }

    // ---- oil drips / burn marks (dry, slightly glossy)
    for (let i = 0; i < 9; i++) {
      const ox = rr(-5.6, 5.6), oz = rr(-56, 48), r = rr(0.3, 0.95);
      const o = new THREE.Mesh(new THREE.CircleGeometry(r, 11), mats.patch);
      o.scale.y = rr(0.5, 0.95);
      o.rotation.set(-Math.PI / 2, 0, rr(0, 3));
      o.position.set(ox, 0.0095, oz);
      o.receiveShadow = true;
      statics.add(o);
      meshBox(0.1, 0.01, 0.1, mats.rubber, ox + rr(-0.2, 0.2), 0.011, oz + rr(-0.2, 0.2), 0, { cast: false });
    }

    // ---- repair patches / pothole scars
    for (let i = 0; i < 17; i++) {
      const px = rr(-6.2, 6.2), pz = rr(-58, 50), r = rr(0.5, 1.9);
      const g = new THREE.CircleGeometry(r, 9);
      const p = g.attributes.position;
      for (let k = 1; k < p.count; k++) {
        p.setX(k, p.getX(k) * rr(0.72, 1.3));
        p.setY(k, p.getY(k) * rr(0.72, 1.3));
      }
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mats.patch);
      m.position.set(px, 0.008, pz);
      m.rotation.y = rnd() * 6;
      m.receiveShadow = true;
      statics.add(m);
    }
    // tar crack snakes
    for (let i = 0; i < 26; i++) {
      let px = rr(-6, 6), pz = rr(-55, 50), ang = rnd() * 6.28;
      for (let s = 0; s < 5; s++) {
        const len = rr(0.5, 1.5);
        meshPlane(0.09, len, mats.patch, px, 0.009, pz, {
          rx: -Math.PI / 2, rz: 0, ry: 0, cast: false,
        }).rotation.set(-Math.PI / 2, 0, ang);
        px += Math.cos(ang) * len; pz += Math.sin(ang) * len;
        ang += rr(-0.7, 0.7);
      }
    }

    // ---- puddles (dark, rippled, no white disc)
    const puddleSpots = [
      [-3.6, 12.5, 1.7, 0.62], [4.9, -9, 1.25, 0.5], [0.4, 27.5, 1.0, 0.4],
      [-5.2, -31, 1.45, 0.55], [5.6, 41, 1.1, 0.45], [-1.8, -52, 1.3, 0.5],
      [-13.5, 2.2, 0.9, 0.45],
    ];
    for (const [px, pz, rad, sq] of puddleSpots) {
      const g = new THREE.CircleGeometry(rad, 30);
      const p = g.attributes.position;
      for (let k = 1; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k);
        const a = Math.atan2(y, x), rl = Math.hypot(x, y) / rad;
        p.setZ(k, Math.sin(a * 5 + px) * 0.006 * rl + Math.cos(a * 3 + pz) * 0.004 * rl);
        p.setY(k, y * sq + Math.sin(a * 2) * rad * 0.06);
      }
      g.computeVertexNormals();
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mats.puddle);
      m.position.set(px, 0.009, pz);
      m.receiveShadow = true;
      m.userData.noAO = true;
      statics.add(m);
      const rim = new THREE.Mesh(new THREE.RingGeometry(rad * 0.94, rad * 1.14, 28), mats.patch);
      rim.userData.noAO = true;
      rim.rotation.x = -Math.PI / 2;
      rim.scale.y = sq;
      rim.position.set(px, 0.006, pz);
      rim.receiveShadow = true;
      statics.add(rim);
    }

    // ---- tyre skid marks (curved ribbons)
    addSkid([[-4.6, 26], [-4.2, 22], [-3.2, 18.5], [-2.2, 16]], 0.34);
    addSkid([[-3.9, 26], [-3.4, 22.2], [-2.4, 19]], 0.3);
    addSkid([[5.4, -4], [4.4, -8], [3.4, -12], [3.6, -16]], 0.36);
    addSkid([[6.0, 6], [5.2, 2], [4.6, -2]], 0.3);
    addSkid([[-1.2, -36], [-1.6, -40], [-1.0, -44]], 0.34);

    // world bounds (players) — Season 3: the west strip opens to the souk
    // connector, and the north backstop gets a 12 m rail-depot gate.
    addColliderRect(-30, 0, -98, -96);
    addColliderRect(12, 30, -98, -96);
    addColliderRect(-30, 30, 82, 100);   // south backstop sits behind the depot yard wall
  }

  function addSkid(pts, width) {
    const n = pts.length;
    const verts = [], uvs = [], idx = [];
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      const [nx, nz] = pts[Math.min(i + 1, n - 1)];
      const [px, pz] = pts[Math.max(i - 1, 0)];
      let dx = nx - px, dz = nz - pz;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const ox = -dz * width * 0.5, oz = dx * width * 0.5;
      if (i > 0) dist += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      verts.push(x - ox, 0.012, z - oz, x + ox, 0.012, z + oz);
      uvs.push(0, dist / 2.2, 1, dist / 2.2);
      if (i < n - 1) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mats.skid);
    m.receiveShadow = false;
    statics.add(m);
  }

  /* ------------------------------------------------------------------ facade */
  const FACADE_INFO = {
    A: { mat: 'facadeA', cols: 3, floors: 2, modW: 3.05, floorH: 3.25 },
    B: { mat: 'facadeB', cols: 4, floors: 2, modW: 3.05, floorH: 3.25 },
    C: { mat: 'facadeC', cols: 3, floors: 2, modW: 3.05, floorH: 3.25 },
    D: { mat: 'facadeD', cols: 3, floors: 3, modW: 3.05, floorH: 3.25 },
  };

  /* =====================================================================
     CQB interiors: two enterable single-storey rooms carved out of the
     solid building volumes. No stairs (enemy AI has no navmesh).
     ===================================================================== */
  const INTERIOR_SPECS = {
    workshop: {
      kind: 'workshop',
      frontZ: [-5.0, 0.0],
      gh: 4.35,
      rooms: [{ x0: -16.35, x1: -10.35, z0: -5.0, z1: 0.0, ceilY: 3.0, floorY: 0.12 }],
      light: { x: -13.0, y: 2.5, z: -2.3, i: 6.2 },
    },
    apartment: {
      kind: 'apartment',
      frontZ: [-15.0, -7.0],
      gh: 4.35,
      rooms: [
        { x0: 10.35, x1: 16.35, z0: -15.0, z1: -9.0, ceilY: 3.05, floorY: 0.155 },
        { x0: 10.35, x1: 13.2, z0: -9.0, z1: -7.0, ceilY: 3.05, floorY: 0.155 },
        // real backyard: a full-height void through the block (open sky)
        { x0: 17.0, x1: 24.35, z0: -16.0, z1: -6.2, ceilY: 18, floorY: 0 },
        // 2.0 m passage from the apartment's east wall into the yard
        { x0: 16.35, x1: 17.0, z0: -13.1, z1: -11.1, ceilY: 2.5, floorY: 0.155 },
      ],
      light: { x: 13.3, y: 2.55, z: -11.8, i: 6.2 },
    },
  };

  function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }

  function subtractIv(ivs, a, b) {
    const out = [];
    for (const [p, q] of ivs) {
      if (b <= p || a >= q) { out.push([p, q]); continue; }
      if (a > p) out.push([p, a]);
      if (b < q) out.push([b, q]);
    }
    return out;
  }

  /** Axis-aligned wall with rectangular holes (doors / windows).
   *  axis 'x': thickness along x (t0..t1), runs along z (a0..a1).
   *  axis 'z': thickness along z (t0..t1), runs along x (a0..a1). */
  function wallWithHoles(axis, t0, t1, a0, a1, y0, y1, holes, mat, opts = {}) {
    const uv = opts.uv ?? 2.2;
    const collide = opts.collide !== false;
    const cast = opts.cast !== false;
    const cuts = [a0, a1];
    for (const h of holes) cuts.push(clampNum(h.a0, a0, a1), clampNum(h.a1, a0, a1));
    const us = [...new Set(cuts.map((v) => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
    const tm = (t0 + t1) / 2, th = t1 - t0;
    for (let i = 0; i < us.length - 1; i++) {
      const sa = us[i], sb = us[i + 1];
      if (sb - sa < 0.02) continue;
      const mid = (sa + sb) / 2;
      const cover = holes.filter((h) => h.a0 <= sa + 0.003 && h.a1 >= sb - 0.003);
      let ivs = [[y0, y1]];
      for (const h of cover) {
        ivs = subtractIv(ivs, Math.max(y0, h.y0 ?? y0), Math.min(y1, h.y1 ?? y1));
      }
      for (const [iy0, iy1] of ivs) {
        if (iy1 - iy0 < 0.02) continue;
        if (axis === 'x') {
          meshBox(th, iy1 - iy0, sb - sa, mat, tm, (iy0 + iy1) / 2, mid, 0, { uv, cast });
          if (collide && iy0 < 1.8) addColliderRect(t0, t1, sa, sb);
        } else {
          meshBox(sb - sa, iy1 - iy0, th, mat, mid, (iy0 + iy1) / 2, tm, 0, { uv, cast });
          if (collide && iy0 < 1.8) addColliderRect(sa, sb, t0, t1);
        }
      }
    }
  }

  function interiorWallBox(x0, x1, z0, z1, y0, y1, mat, uv = 2.2, cast = true) {
    meshBox(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, { uv, cast });
    addColliderRect(x0, x1, z0, z1);
  }

  function doorFrame(axis, t0, t1, a0, a1, yBase, yTop, mat) {
    const tm = (t0 + t1) / 2, th = t1 - t0, fw = 0.13;
    if (axis === 'x') {
      meshBox(th + 0.1, yTop - yBase, fw, mat, tm, (yBase + yTop) / 2, a0 + fw / 2, 0, { uv: 0.8, cast: false });
      meshBox(th + 0.1, yTop - yBase, fw, mat, tm, (yBase + yTop) / 2, a1 - fw / 2, 0, { uv: 0.8, cast: false });
      meshBox(th + 0.1, fw, a1 - a0, mat, tm, yTop - fw / 2, (a0 + a1) / 2, 0, { uv: 0.8, cast: false });
    } else {
      meshBox(fw, yTop - yBase, th + 0.1, mat, a0 + fw / 2, (yBase + yTop) / 2, tm, 0, { uv: 0.8, cast: false });
      meshBox(fw, yTop - yBase, th + 0.1, mat, a1 - fw / 2, (yBase + yTop) / 2, tm, 0, { uv: 0.8, cast: false });
      meshBox(a1 - a0, fw, th + 0.1, mat, (a0 + a1) / 2, yTop - fw / 2, tm, 0, { uv: 0.8, cast: false });
    }
  }

  function thresholdStrip(axis, t0, t1, a0, a1, y, mat) {
    if (axis === 'x') meshBox(t1 - t0 + 0.06, 0.025, a1 - a0, mat, (t0 + t1) / 2, y - 0.012, (a0 + a1) / 2, 0, { uv: 0.8, cast: false });
    else meshBox(a1 - a0, 0.025, t1 - t0 + 0.06, mat, (a0 + a1) / 2, y - 0.012, (t0 + t1) / 2, 0, { uv: 0.8, cast: false });
  }

  function openDoorLeaf(hingeX, hingeZ, w, h, yBase, angle, mat) {
    const g = new THREE.Group();
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), mat);
    projectBoxUV(leaf.geometry, 1.0);
    leaf.position.set(w / 2, h / 2, 0);
    leaf.castShadow = true; leaf.receiveShadow = true;
    g.add(leaf);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.04), mats.metal);
    handle.position.set(w - 0.18, h * 0.45, 0.05);
    g.add(handle);
    g.position.set(hingeX, yBase, hingeZ);
    g.rotation.y = angle;
    statics.add(g);
  }

  function interiorLamp(x, y, z, intensity = 6.2) {
    meshCyl(0.012, 0.012, 0.4, 4, mats.rubber, x, y + 0.2, z, { cast: false });
    meshCyl(0.16, 0.24, 0.1, 10, mats.metalTan, x, y, z, { cast: false });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), mats.windowLit);
    bulb.position.set(x, y - 0.08, z);
    statics.add(bulb);
    const pl = new THREE.PointLight(0xffb070, intensity, 7, 2);
    pl.position.set(x, y - 0.14, z);
    dynamic.add(pl);
    lightPool(x, z, 1.9, 0.16);
    return pl;
  }

  function roomFloor(x0, x1, z0, z1, y, mat, uv = 1.8) {
    meshBox(x1 - x0, 0.1, z1 - z0, mat, (x0 + x1) / 2, y - 0.05, (z0 + z1) / 2, 0, { uv, cast: false });
  }

  /** Replace a building's solid body with boxes that leave the room voids open. */
  function buildCarvedBody(def) {
    const { side, z0, z1, depth, h } = def;
    const spec = INTERIOR_SPECS[def.interior];
    const plaster = def.plaster || mats.plasterA;
    const bodyX0 = side < 0 ? -(WALL + depth) : WALL;
    const bodyX1 = side < 0 ? -WALL : WALL + depth;
    const zs = [z0, z1];
    const xs = [bodyX0, bodyX1];
    for (const r of spec.rooms) { zs.push(r.z0, r.z1); xs.push(r.x0, r.x1); }
    const us = [...new Set(zs.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    const vx = [...new Set(xs.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    for (let i = 0; i < vx.length - 1; i++) {
      for (let j = 0; j < us.length - 1; j++) {
        const x0 = vx[i], x1 = vx[i + 1], cz0 = us[j], cz1 = us[j + 1];
        if (x1 - x0 < 0.02 || cz1 - cz0 < 0.02) continue;
        const room = spec.rooms.find((r) => x0 >= r.x0 - 0.002 && x1 <= r.x1 + 0.002 && cz0 >= r.z0 - 0.002 && cz1 <= r.z1 + 0.002);
        if (room) {
          const topH = h - room.ceilY;
          if (topH > 0.02) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, topH, cz1 - cz0), plaster);
            projectBoxUV(b.geometry, 3.6);
            b.position.set((x0 + x1) / 2, room.ceilY + topH / 2, (cz0 + cz1) / 2);
            b.castShadow = true; b.receiveShadow = true;
            statics.add(b);
          }
        } else {
          const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, cz1 - cz0), plaster);
          projectBoxUV(b.geometry, 3.6);
          b.position.set((x0 + x1) / 2, h / 2, (cz0 + cz1) / 2);
          b.castShadow = true; b.receiveShadow = true;
          statics.add(b);
          addColliderRect(x0, x1, cz0, cz1);
        }
      }
    }
  }

  /* ---- 1) alley workshop / cafe (inside L3, x -16.35..-10.35, z -5..0) ---- */
  function buildWorkshopInterior() {
    const x0 = -16.35, x1 = -10.35, z0 = -5.0, z1 = 0.0;
    const floorY = 0.12, ceilY = 3.0;
    const wallMat = mats.plasterC;

    roomFloor(x0, x1, z0, z1, floorY, mats.concreteDark, 1.6);
    meshBox(x1 - x0, 0.07, z1 - z0, mats.plasterB, (x0 + x1) / 2, ceilY - 0.035, (z0 + z1) / 2, 0, { uv: 2.4, cast: false });
    for (const bz of [z0 + 1.1, z0 + 2.45, z0 + 3.8]) {
      meshBox(x1 - x0, 0.16, 0.14, mats.wood, (x0 + x1) / 2, ceilY - 0.13, bz, 0, { uv: 0.8, cast: false });
    }

    // side walls (back + south): linings with collision
    interiorWallBox(x0, x0 + 0.16, z0, z1, floorY, ceilY, wallMat);
    interiorWallBox(x0, x1, z0, z0 + 0.16, floorY, ceilY, wallMat);

    // street front wall (through the old screen) with a 2.1 m door + shop window
    wallWithHoles('x', -10.35, -9.85, z0, z1, floorY, 4.35, [
      { a0: -3.25, a1: -1.15, y0: floorY, y1: 2.5 },
      { a0: -4.8, a1: -3.65, y0: 0.95, y1: 2.2 },
    ], wallMat, { uv: 2.4 });
    doorFrame('x', -10.35, -9.85, -3.25, -1.15, floorY, 2.5, mats.metalTan);
    thresholdStrip('x', -10.35, -9.85, -3.25, -1.15, floorY, mats.concreteDark);

    // alley wall (z = 0) with a 2.2 m door
    wallWithHoles('z', -0.3, 0.0, x0, x1, floorY, ceilY, [
      { a0: -13.3, a1: -11.1, y0: floorY, y1: 2.5 },
    ], wallMat, { uv: 2.4 });
    doorFrame('z', -0.3, 0.0, -13.3, -11.1, floorY, 2.5, mats.metalTan);
    thresholdStrip('z', -0.3, 0.0, -13.3, -11.1, floorY, mats.concreteDark);
    // plinth band on the alley face (segments around the door)
    wallWithHoles('z', -0.36, -0.30, x0, x1, 0.0, 0.55, [
      { a0: -13.3, a1: -11.1, y0: 0.0, y1: 0.55 },
    ], mats.concreteDark, { uv: 1.6, collide: false, cast: false });
    // plinth on the street front wall
    wallWithHoles('x', -9.90, -9.84, z0, z1, 0.0, 0.55, [
      { a0: -3.25, a1: -1.15, y0: 0.0, y1: 0.55 },
    ], mats.concreteDark, { uv: 1.6, collide: false, cast: false });

    // open leaves + warm shop front
    openDoorLeaf(-13.3, -0.15, 1.05, 2.3, floorY, -1.75, mats.wood);
    openDoorLeaf(-10.42, -3.22, 0.95, 2.3, floorY, 2.2, mats.metal);
    // window: half-broken glass + bars + stone sill
    const wx = -4.22, wy = 1.57;
    for (const [sy, sz] of [[1.05, -4.72], [2.1, -3.72], [1.6, -4.68]]) {
      const shard = new THREE.Mesh(new THREE.PlaneGeometry(0.09, rr(0.18, 0.3)), mats.glassBroken);
      shard.position.set(-10.04, sy, sz);
      shard.rotation.set(0, Math.PI / 2, rr(-0.4, 0.4));
      statics.add(shard);
    }
    for (const dz of [-4.72, -4.22, -3.72]) {
      meshBox(0.03, 1.15, 0.03, mats.rust, -9.93, 1.55, dz, 0, { uv: 0.4, cast: false });
    }
    meshBox(0.28, 0.1, 1.3, mats.concrete, -9.93, 0.9, wx, 0, { uv: 0.9 });
    meshBox(0.1, 0.1, 1.3, mats.concreteDark, -9.99, 2.26, wx, 0, { uv: 0.8, cast: false });

    // awning + signage over the alley door
    meshBox(1.15, 0.06, 2.9, mats.awning, -9.4, 2.85, -2.2, 0, { uv: 0.95, rz: -0.18 });
    meshBox(0.05, 0.22, 2.9, mats.burlap, -9.95, 2.68, -2.2, 0, { uv: 0.8, cast: false });
    for (const dz of [-3.4, -1.0]) {
      meshBox(0.95, 0.05, 0.05, mats.rust, -9.47, 2.7, dz, 0, { uv: 0.5, cast: false });
    }
    wallSign(-1, -2.2, 3.15, 2.6, 0.72, mats.signB, 0.12);
    const alleySign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.62), mats.signA);
    alleySign.position.set(-12.2, 2.95, 0.08);
    statics.add(alleySign);
    meshBox(2.3, 0.08, 0.1, mats.metalTan, -12.2, 2.62, 0.1, 0, { uv: 0.8, cast: false });
    // work lamp over the alley door + warm spill
    meshBox(0.42, 0.05, 0.05, mats.rust, -12.2, 3.3, 0.3, 0, { uv: 0.5, cast: false });
    meshBox(0.3, 0.16, 0.22, mats.metalTan, -12.2, 3.17, 0.52, 0, { uv: 0.6 });
    const doorwayBulb = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.13), mats.windowLit);
    doorwayBulb.rotation.x = Math.PI / 2;
    doorwayBulb.position.set(-12.2, 3.08, 0.52);
    statics.add(doorwayBulb);
    lightPool(-12.2, 1.2, 1.9, 0.28);
    lightPool(-9.0, -2.2, 1.6, 0.2);

    // ---- interior dressing / cover
    // back shelving
    for (const sy of [1.15, 1.85, 2.55]) {
      meshBox(0.36, 0.05, 3.35, mats.wood, -16.05, sy, -2.55, 0, { uv: 0.9, cast: false });
    }
    for (const sz of [-4.15, -0.95]) {
      meshBox(0.08, 2.6, 0.08, mats.wood, -16.02, 1.3, sz, 0, { uv: 0.6, cast: false });
    }
    addColliderRect(-16.3, -15.85, -4.4, -0.7);
    // shelf clutter
    for (let i = 0; i < 6; i++) {
      meshBox(rr(0.12, 0.24), rr(0.12, 0.22), rr(0.12, 0.24), i % 2 ? mats.metalTan : mats.burlap,
        -16.05, 1.2 + (i % 3) * 0.7, -1.2 - i * 0.45, rr(0, 1.5), { uv: 0.5, cast: false });
    }
    // counter (tall cover)
    meshBox(1.1, 0.95, 1.6, mats.wood, -15.35, floorY + 0.475, -3.4, 0, { uv: 1.1 });
    meshBox(1.2, 0.06, 1.7, mats.metal, -15.35, floorY + 0.98, -3.4, 0, { uv: 0.8, cast: false });
    addColliderRect(-15.95, -14.75, -4.2, -2.6);
    // crates (low cover) near the south wall
    crate(-11.6, -4.15, 0.95, 0.3);
    crate(-12.45, -4.05, 0.78, 1.1);
    // workbench along the south wall
    meshBox(1.7, 0.14, 0.6, mats.wood, -13.8, floorY + 0.86, -4.5, 0, { uv: 0.9 });
    for (const dx of [-1.55, -0.05]) {
      meshBox(0.08, 0.86, 0.08, mats.metal, -13.8 + dx, floorY + 0.43, -4.5, 0, { uv: 0.5, cast: false });
    }
    addColliderRect(-14.7, -12.9, -4.85, -4.15);
    // tools / clutter on the bench
    meshBox(0.34, 0.2, 0.22, mats.metal, -14.1, floorY + 1.03, -4.55, 0.3, { uv: 0.6, cast: false });
    meshBox(0.5, 0.08, 0.2, mats.rust, -13.3, floorY + 1.0, -4.4, 0.1, { uv: 0.5, cast: false });
    // a barrel + tyres for silhouette
    barrel(-15.2, -1.25);
    tire(-11.2, -2.4, 0.6);
    // rug + scattered paper
    meshBox(2.6, 0.012, 1.8, mats.burlap, -13.3, floorY + 0.008, -2.4, 0.05, { uv: 1.4, cast: false });
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.16, 0.28), rr(0.2, 0.34)), mats.paper);
      p.position.set(rr(-15, -11.2), floorY + 0.015, rr(-4.6, -0.6));
      p.rotation.set(-Math.PI / 2, 0, rr(0, 6));
      statics.add(p);
    }
    // posters + grime on the back wall
    for (let i = 0; i < 2; i++) {
      const po = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.6, 0.9), rr(0.7, 1.0)), i ? mats.signC : mats.paper);
      po.position.set(-16.18, rr(1.5, 2.2), rr(-4.2, -1.0));
      po.rotation.y = Math.PI / 2;
      statics.add(po);
    }
    // hanging bulb (single point light in this room)
    interiorLamp(-13.0, 2.5, -2.3, 6.2);
    // warm interior fill panels (emissive, no extra lights)
    const warmPanel = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.7), mats.windowLitDim);
    warmPanel.position.set(-16.2, 2.55, -3.3);
    warmPanel.rotation.y = Math.PI / 2;
    statics.add(warmPanel);
  }

  /* ---- 2) street apartment (inside R4, x 10.35..16.35, z -15..-7) -------- */
  function buildApartmentInterior() {
    const mx0 = 10.35, mx1 = 16.35, mz0 = -15.0, mz1 = -9.0;
    const hx0 = 10.35, hx1 = 13.2, hz0 = -9.0, hz1 = -7.0;
    const floorY = 0.155, ceilY = 3.05;
    const wallMat = mats.plasterC;

    roomFloor(mx0, mx1, mz0, mz1, floorY, mats.wood, 2.0);
    roomFloor(hx0, hx1, hz0, hz1, floorY, mats.wood, 2.0);
    meshBox(mx1 - mx0, 0.07, mz1 - mz0, mats.plasterB, (mx0 + mx1) / 2, ceilY - 0.035, (mz0 + mz1) / 2, 0, { uv: 2.4, cast: false });
    meshBox(hx1 - hx0, 0.07, hz1 - hz0, mats.plasterB, (hx0 + hx1) / 2, ceilY - 0.035, (hz0 + hz1) / 2, 0, { uv: 2.4, cast: false });
    for (const bz of [mz0 + 1.4, mz0 + 2.9, mz0 + 4.4]) {
      meshBox(mx1 - mx0, 0.14, 0.13, mats.wood, (mx0 + mx1) / 2, ceilY - 0.12, bz, 0, { uv: 0.8, cast: false });
    }

    // shell linings
    // east wall with a 2.0 m door into the backyard
    wallWithHoles('x', mx1 - 0.16, mx1, mz0, mz1, floorY, ceilY, [
      { a0: -13.1, a1: -11.1, y0: floorY, y1: 2.4 },
    ], wallMat, { uv: 2.2 });
    doorFrame('x', mx1 - 0.16, mx1, -13.1, -11.1, floorY, 2.4, mats.metalTan);
    thresholdStrip('x', mx1 - 0.16, mx1, -13.1, -11.1, floorY, mats.concreteDark);
    doorFrame('x', 16.35, 17.0, -13.1, -11.1, floorY, 2.4, mats.metalTan);
    thresholdStrip('x', 16.35, 17.0, -13.1, -11.1, floorY, mats.concreteDark);
    // open steel leaf on the yard side
    openDoorLeaf(17.04, -13.06, 0.95, 2.3, floorY, 2.35, mats.metal);
    // small yard canopy + wall lamp over the door
    meshBox(1.15, 0.06, 2.6, mats.awning, 17.55, 2.8, -12.1, 0, { uv: 0.95, rz: -0.18 });
    meshBox(0.05, 0.18, 2.6, mats.burlap, 17.0, 2.66, -12.1, 0, { uv: 0.8, cast: false });
    meshBox(0.32, 0.05, 0.05, mats.rust, 17.05, 3.15, -11.4, 0, { uv: 0.5, cast: false });
    meshBox(0.24, 0.14, 0.18, mats.metalTan, 17.2, 3.03, -11.4, 0, { uv: 0.6 });
    const yl = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.11), mats.windowLit);
    yl.rotation.x = Math.PI / 2;
    yl.position.set(17.2, 2.95, -11.4);
    statics.add(yl);
    lightPool(17.7, -12.1, 1.5, 0.24);
    interiorWallBox(mx0, mx1, mz0, mz0 + 0.16, floorY, ceilY, wallMat); // south
    interiorWallBox(hx1 - 0.16, hx1, hz0, hz1, floorY, ceilY, wallMat); // hall east
    interiorWallBox(hx0, hx1, hz1 - 0.16, hz1, floorY, ceilY, wallMat); // hall north
    // shared wall between main room and hall, with a 1.8 m door
    wallWithHoles('z', -9.26, -9.0, mx0, mx1, floorY, ceilY, [
      { a0: 11.15, a1: 12.95, y0: floorY, y1: 2.35 },
    ], wallMat, { uv: 2.2 });
    doorFrame('z', -9.26, -9.0, 11.15, 12.95, floorY, 2.35, mats.wood);

    // street front wall: 2.0 m main door + window + 1.8 m back door
    wallWithHoles('x', 9.85, 10.35, mz0, hz1, floorY, 4.35, [
      { a0: -13.0, a1: -11.0, y0: floorY, y1: 2.5 },
      { a0: -14.35, a1: -13.35, y0: 1.0, y1: 2.15 },
      { a0: -8.8, a1: -7.0, y0: floorY, y1: 2.5 },
    ], wallMat, { uv: 2.4 });
    doorFrame('x', 9.85, 10.35, -13.0, -11.0, floorY, 2.5, mats.metalTan);
    doorFrame('x', 9.85, 10.35, -8.8, -7.0, floorY, 2.5, mats.metalTan);
    thresholdStrip('x', 9.85, 10.35, -13.0, -11.0, floorY, mats.concreteDark);
    thresholdStrip('x', 9.85, 10.35, -8.8, -7.0, floorY, mats.concreteDark);
    // street plinth around both doors
    wallWithHoles('x', 9.84, 9.90, mz0, hz1, 0.0, 0.55, [
      { a0: -13.0, a1: -11.0, y0: 0.0, y1: 0.55 },
      { a0: -8.8, a1: -7.0, y0: 0.0, y1: 0.55 },
    ], mats.concreteDark, { uv: 1.6, collide: false, cast: false });

    openDoorLeaf(9.93, -12.98, 0.98, 2.3, floorY, -2.25, mats.wood);
    openDoorLeaf(9.93, -7.03, 0.9, 2.3, floorY, -2.3, mats.metal);
    openDoorLeaf(12.95, -9.22, 0.88, 2.2, floorY, -2.1, mats.wood);

    // window: bars + half glass + sill
    const wz = -13.85;
    for (const [sy, sz] of [[1.1, -14.28], [2.05, -13.42], [1.55, -14.24]]) {
      const shard = new THREE.Mesh(new THREE.PlaneGeometry(0.09, rr(0.18, 0.3)), mats.glassBroken);
      shard.position.set(10.05, sy, sz);
      shard.rotation.set(0, -Math.PI / 2, rr(-0.4, 0.4));
      statics.add(shard);
    }
    for (const dz of [-14.3, -13.85, -13.4]) {
      meshBox(0.03, 1.1, 0.03, mats.rust, 9.92, 1.55, dz, 0, { uv: 0.4, cast: false });
    }
    meshBox(0.26, 0.1, 1.2, mats.concrete, 9.92, 0.97, wz, 0, { uv: 0.9 });
    meshBox(0.1, 0.1, 1.2, mats.concreteDark, 9.98, 2.18, wz, 0, { uv: 0.8, cast: false });

    // facade dressing: sign, lamp, awning over main door
    wallSign(1, -12.0, 3.2, 2.4, 0.7, mats.signA, 0.12);
    meshBox(1.0, 0.06, 2.6, mats.awning, 9.4, 2.88, -12.0, 0, { uv: 0.95, rz: 0.18 });
    meshBox(0.05, 0.2, 2.6, mats.burlap, 9.95, 2.72, -12.0, 0, { uv: 0.8, cast: false });
    for (const dz of [-13.2, -10.8]) meshBox(0.9, 0.05, 0.05, mats.rust, 9.46, 2.7, dz, 0, { uv: 0.5, cast: false });
    meshBox(0.4, 0.05, 0.05, mats.rust, 9.72, 3.1, -7.8, 0, { uv: 0.5, cast: false });
    meshBox(0.26, 0.14, 0.2, mats.metalTan, 9.55, 3.0, -7.8, 0, { uv: 0.6 });
    const dl = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.12), mats.windowLit);
    dl.rotation.x = Math.PI / 2;
    dl.position.set(9.55, 2.92, -7.8);
    statics.add(dl);
    lightPool(8.7, -12.0, 1.7, 0.22);
    lightPool(8.7, -7.8, 1.5, 0.2);

    // ---- furnishings / cover
    // kitchen counter along the south wall (clear of the yard door on the east wall)
    meshBox(2.5, 0.95, 0.8, mats.wood, 13.75, floorY + 0.475, -14.5, 0, { uv: 1.1 });
    meshBox(2.62, 0.06, 0.9, mats.metal, 13.75, floorY + 0.98, -14.5, 0, { uv: 0.8, cast: false });
    for (const sy of [1.65, 2.15]) {
      meshBox(2.3, 0.05, 0.4, mats.wood, 13.75, floorY + sy, -14.72, 0, { uv: 0.8, cast: false });
    }
    addColliderRect(12.5, 15.0, -14.9, -14.1);
    // sofa / bench (low cover) against the north wall, east of the hall door
    meshBox(1.6, 0.42, 0.9, mats.burlap, 14.0, floorY + 0.21, -9.48, 0, { uv: 1.0 });
    meshBox(1.6, 0.55, 0.2, mats.burlap, 14.0, floorY + 0.62, -9.28, 0, { uv: 0.8, cast: false });
    addColliderRect(13.15, 14.85, -9.95, -9.0);
    // coffee table (low cover) + a chair
    meshBox(1.2, 0.07, 0.7, mats.wood, 13.6, floorY + 0.43, -10.6, 0.06, { uv: 0.8 });
    for (const [dx, dz] of [[-0.5, -0.28], [0.5, -0.28], [-0.5, 0.28], [0.5, 0.28]]) {
      meshBox(0.06, 0.4, 0.06, mats.wood, 13.6 + dx, floorY + 0.2, -10.6 + dz, 0, { uv: 0.5, cast: false });
    }
    addColliderRect(12.95, 14.25, -11.0, -10.2);
    meshBox(0.45, 0.06, 0.45, mats.wood, 12.6, floorY + 0.45, -10.3, 0.3, { uv: 0.7 });
    meshBox(0.45, 0.5, 0.06, mats.wood, 12.6, floorY + 0.7, -10.52, 0.3, { uv: 0.7 });
    for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
      meshBox(0.05, 0.45, 0.05, mats.wood, 12.6 + dx, floorY + 0.22, -10.3 + dz, 0, { uv: 0.5, cast: false });
    }
    addColliderRect(12.35, 12.85, -10.55, -10.05);
    // low cabinet on the south wall + poster above
    meshBox(1.5, 0.6, 0.42, mats.wood, 11.7, floorY + 0.3, -14.62, 0, { uv: 0.9 });
    addColliderRect(10.95, 12.45, -14.85, -14.4);
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.7), mats.signC);
    sp.position.set(11.7, 1.85, -14.83);
    statics.add(sp);
    // back hall: shelf + boxes
    for (const sy of [1.2, 1.9, 2.5]) {
      meshBox(0.34, 0.05, 1.65, mats.wood, 13.0, floorY + sy, -8.0, 0, { uv: 0.8, cast: false });
    }
    addColliderRect(12.8, 13.2, -8.85, -7.15);
    meshBox(0.6, 0.6, 0.7, mats.wood, 12.3, floorY + 0.3, -8.75, 0.1, { uv: 0.8 });
    addColliderRect(12.0, 12.6, -9.1, -8.4);
    // rug, posters, TV panel
    meshBox(2.8, 0.012, 2.0, mats.burlap, 12.8, floorY + 0.008, -11.1, 0.03, { uv: 1.4, cast: false });
    meshBox(0.05, 0.9, 1.5, mats.rubber, 16.2, floorY + 1.7, -10.6, 0, { uv: 0.8, cast: false });
    meshBox(0.06, 0.98, 1.58, mats.metalTan, 16.22, floorY + 1.7, -10.6, 0, { uv: 0.6, cast: false });
    meshBox(0.06, 0.82, 1.42, mats.rubber, 16.19, floorY + 1.7, -10.6, 0, { uv: 0.6, cast: false });
    for (let i = 0; i < 2; i++) {
      const po = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.5, 0.8), rr(0.6, 0.9)), i ? mats.signC : mats.paper);
      po.position.set(rr(12.6, 14.4), rr(1.4, 2.2), -14.86);
      statics.add(po);
    }
    // ceiling lamp + a second small bulb in the back hall (emissive only)
    interiorLamp(13.3, 2.55, -11.8, 6.2);
    const hallBulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mats.windowLit);
    hallBulb.position.set(11.6, 2.55, -8.0);
    statics.add(hallBulb);
    const hallLight = new THREE.PointLight(0xffb070, 3.4, 4.5, 2);
    hallLight.position.set(11.6, 2.4, -8.0);
    dynamic.add(hallLight);
    lightPool(11.6, -8.0, 1.4, 0.14);
    // visible hall dressing through the back door
    meshBox(0.9, 0.95, 0.5, mats.wood, 11.0, floorY + 0.475, -7.35, 0, { uv: 0.9 });
    addColliderRect(10.55, 11.45, -7.6, -7.1);
    meshBox(0.5, 0.55, 0.6, mats.metalTan, 12.2, floorY + 0.28, -7.4, 0.2, { uv: 0.7 });
    const hallPoster = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.8), mats.signC);
    hallPoster.position.set(13.15, 1.7, -8.2);
    hallPoster.rotation.y = -Math.PI / 2;
    statics.add(hallPoster);
  }

  function buildInterior(def) {
    if (!def || !def.interior) return;
    if (def.interior === 'workshop') buildWorkshopInterior();
    else if (def.interior === 'apartment') buildApartmentInterior();
  }


  /* =====================================================================
     Backyard + covered market + roof ramp/catwalk + destructible cover
     All raised walkable surfaces live OUTSIDE the building footprints
     (x >= 17) so the 2D colliders of the block never create air walls.
     ===================================================================== */
  const RAMP = { x0: 24.6, x1: 25.9, z0: -15.4, z1: -8.6, rise: 3.2 };
  // interior stair up to the north HQ mezzanine (same 3.2 m layer as the roofs)
  const HQ_STAIR = { x0: 12.45, x1: 13.95, z0: -74.4, z1: -71.0, rise: 3.2 };
  // east dock loading ramp up to the 1.2 m platform
  const DOCK_RAMP = { x0: 43.2, x1: 44.4, z0: -83.2, z1: -86.5, rise: 1.2 };
  // Season 3: rail depot elevated platform 0 -> 4.2
  const EXPANSION_RAMPS = [
    { x0: 28.0, x1: 30.0, z0: -136.0, z1: -144.0, rise: 4.2, id: 'rail' },
  ];
  const ROOF_ZONES = [
    { x0: 17.75, x1: 23.4, z0: -13.4, z1: -7.9, y: 3.2 },  // market roof deck (west edge reaches the catwalk)
    { x0: 22.7, x1: 26.0, z0: -8.6, z1: -7.9, y: 3.2 },    // ramp top landing (0.7 m overlap with the deck)
    { x0: 17.45, x1: 18.35, z0: -14.5, z1: -6.2, y: 3.2 }, // catwalk along the apartment wall (0.6 m overlap)
  ];
  const ROOF_SPAWNS = [
    { x: 22.0, z: -11.6, y: 3.2 },
    { x: 25.0, z: -8.2, y: 3.2 },
    { x: 17.8, z: -11.5, y: 3.2 },
  ];
  const ROOF_COVERS = [
    { x: 22.6, z: -8.7, y: 3.2, h: true },
    { x: 20.0, z: -12.8, y: 3.2, h: false },
  ];
  const MARKET_CQB = {
    id: 'yard-market',
    name: '后院市场',
    entry: { x: 21.2, z: -15.2 },
    center: { x: 20.8, z: -10.7 },
    radius: 4.4,
    spawns: [{ x: 18.9, z: -12.3 }, { x: 22.9, z: -9.6 }],
    covers: [{ x: 19.7, z: -14.35, h: false }, { x: 23.0, z: -14.35, h: false }],
  };

  /* =====================================================================
     SOUTH YARD: the street opens into a depot yard (Sprint F).
     Additive geometry only — nothing in the existing block is moved or
     carved, so the street/backyard/market layout stays byte-identical.
     ===================================================================== */
  const SOUTH = { x0: -17.0, x1: 17.0, z0: 56.0, z1: 82.0 };
  const DEPOT = { x0: 5.0, x1: 15.0, z0: 66.0, z1: 78.0, wallH: 3.6, roofY: 3.72 };
  const SOUTH_RAMP = { x0: 3.2, x1: 4.9, z0: 66.4, z1: 72.0, rise: 3.72 };
  ROOF_ZONES.push({
    x0: DEPOT.x0 - 0.2, x1: DEPOT.x1 + 0.1,
    z0: DEPOT.z0 - 0.1, z1: DEPOT.z1 + 0.1, y: DEPOT.roofY,
  });
  ROOF_SPAWNS.push({ x: 10.0, z: 72.0, y: DEPOT.roofY });
  ROOF_COVERS.push({ x: 13.4, z: 72.0, y: DEPOT.roofY, h: true });

  const DESTRUCTIBLE_DEFS = [
    { id: 'yard-crate-a', x: 26.9, z: -14.4, w: 1.0, h: 1.0, d: 1.0, mat: 'wood', hp: 55 },
    { id: 'yard-crate-b', x: 24.9, z: -6.35, w: 1.1, h: 1.1, d: 1.1, mat: 'wood', hp: 60 },
    { id: 'market-sacks', x: 25.4, z: -6.6, w: 0.95, h: 1.0, d: 1.8, mat: 'sandbag', hp: 120 },
    { id: 'yard-barricade', x: 28.6, z: -14.9, w: 1.4, h: 1.0, d: 0.45, mat: 'metal', hp: 80 },
    // south depot yard (Sprint G): breakable cover on the approach lanes
    { id: 'south-crate', x: 2.6, z: 74.8, w: 1.15, h: 1.15, d: 1.15, mat: 'wood', hp: 60 },
    { id: 'south-sacks', x: -1.8, z: 73.4, w: 1.9, h: 1.0, d: 0.9, mat: 'sandbag', hp: 130 },
    { id: 'south-barricade', x: -9.6, z: 66.8, w: 1.6, h: 1.0, d: 0.45, mat: 'metal', hp: 85 },
    { id: 'south-pallets', x: 12.4, z: 80.0, w: 1.2, h: 1.1, d: 1.2, mat: 'wood', hp: 55 },
  ];
  const destructibles = [];
  const debris = [];
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1);

  /** highest standable floor at x,z that is not more than y+0.6 above the caller */
  function groundHeight(x, z, y = 0) {
    let best = 0;
    const ceiling = y + 0.6;
    for (const r of [RAMP, SOUTH_RAMP, HQ_STAIR, DOCK_RAMP, ...EXPANSION_RAMPS]) {
      let t;
      if (r.axis === 'x') {
        const rx0 = Math.min(r.x0, r.x1), rx1 = Math.max(r.x0, r.x1);
        const rz0 = Math.min(r.z0, r.z1), rz1 = Math.max(r.z0, r.z1);
        if (x < rx0 || x > rx1 || z < rz0 || z > rz1) continue;
        t = Math.max(0, Math.min(1, (x - r.x0) / (r.x1 - r.x0)));
      } else {
        const rz0 = Math.min(r.z0, r.z1), rz1 = Math.max(r.z0, r.z1);
        if (x < r.x0 || x > r.x1 || z < rz0 || z > rz1) continue;
        t = Math.max(0, Math.min(1, (z - r.z0) / (r.z1 - r.z0)));
      }
      const h = r.rise * t;
      if (h <= ceiling) best = Math.max(best, h);
    }
    for (const r of ROOF_ZONES) {
      if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && r.y <= ceiling) best = Math.max(best, r.y);
    }
    return best;
  }

  function spawnDebris(x, y, z, n, mat, scale = 1, size = null) {
    const sw = size ? size.w : 1.0, sd = size ? size.d : 1.0;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(debrisGeo, mat);
      const s = (0.07 + Math.random() * 0.12) * scale;
      m.scale.set(s * 1.5, s * 0.55, s * 1.7);
      m.position.set(x + (Math.random() - 0.5) * sw, y + Math.random() * 0.45, z + (Math.random() - 0.5) * sd);
      m.rotation.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3);
      m.castShadow = false; m.receiveShadow = true;
      root.add(m);
      debris.push({
        m,
        vx: (Math.random() - 0.5) * 2.6,
        vy: 1.1 + Math.random() * 2.8,
        vz: (Math.random() - 0.5) * 2.6,
        life: 2.2 + Math.random() * 0.9,
        spin: (Math.random() - 0.5) * 9,
      });
    }
  }

  function hitDestructible(id, dmg = 1, point = null, normal = null) {
    void normal;
    const d = destructibles.find((o) => o.id === id);
    if (!d) return { destroyed: false, hp: 0 };
    if (d.destroyed) return { destroyed: true, hp: 0 };
    d.hp -= Math.max(1, dmg || 1);
    if (d.hp > 0) {
      if (point) spawnDebris(point.x, point.y, point.z, 3, d.mesh.material, 0.45);
      return { destroyed: false, hp: d.hp };
    }
    d.hp = 0;
    d.destroyed = true;
    // Cover points that relied on this prop are no longer cover. Keep the
    // object identity: the AI cover system holds the same references.
    for (const cp of coverPoints) {
      if (Math.hypot(cp.x - d.def.x, cp.z - d.def.z) <= 2.3) cp.invalid = true;
    }
    if (d.mesh.parent) d.mesh.parent.remove(d.mesh);
    const bi = bulletTargets.indexOf(d.mesh);
    if (bi >= 0) bulletTargets.splice(bi, 1);
    const ci = colliders.indexOf(d.collider);
    if (ci >= 0) colliders.splice(ci, 1);
    spawnDebris(d.mesh.position.x, d.mesh.position.y, d.mesh.position.z, 14, d.mesh.material, 1.1, d.def);
    return { destroyed: true, hp: 0 };
  }

  function buildYardDestructibles() {
    for (const def of DESTRUCTIBLE_DEFS) {
      const geo = new THREE.BoxGeometry(def.w, def.h, def.d);
      projectBoxUV(geo, 1.0);
      const mesh = new THREE.Mesh(geo, mats[def.mat] || mats.wood);
      mesh.position.set(def.x, def.h / 2, def.z);
      mesh.rotation.y = def.rot || 0;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.destructible = def.id;
      root.add(mesh);
      bulletTargets.push(mesh);
      const collider = addColliderRot(def.x, def.z, def.w, def.d, def.rot || 0, 0.02, def.h);
      destructibles.push({ id: def.id, mesh, collider, hp: def.hp, maxHp: def.hp, def, destroyed: false });
    }
  }

  /* fences / lane / market / ramp / catwalk (all static -> merged) */

  /* ===================================================================
     BACKDROP — scenery only, entirely outside the playable bounds:
     west grass/hills/120 m mountain, east sea + dock, north/south desert.
     No colliders, no nav, no shadow casting, no bullet surfaces.
     =================================================================== */
  function buildBackdrop() {
    const brnd = mulberry32(77123);
    const inCity = (x, z) => x > -118 && x < 118 && z > -196 && z < 128;
    const inFoothills = (x, z) => x >= -235 && x <= -118 && z >= -120 && z <= 120;
    const H = (x, z) => {
      if (x > 118) return -4;                 // sea floor
      if (inCity(x, z)) return -3;            // under the city ground
      if (inFoothills(x, z)) return -0.6;     // under the playable foothill floor
      if (x < -235) {
        const t = Math.min(1, (-235 - x) / 515);
        const ridge = Math.sin(Math.PI * Math.min(1, t * 1.06));
        let h = 120 * Math.pow(Math.max(0, ridge), 1.25);
        h *= 0.84 + 0.13 * Math.sin(z * 0.013) + 0.05 * Math.sin(x * 0.021 + z * 0.017);
        h += 10 * Math.sin(x * 0.013 + z * 0.009) * Math.min(1, t * 1.6);
        h += (6 * Math.sin(x * 0.05 + z * 0.02) + 4 * Math.sin(z * 0.045)) * Math.min(1, t * 1.5);
        h = Math.min(122, h);
        return Math.max(0, h);
      }
      const edge = z < -196 ? (-196 - z) : (z - 128);
      const t = Math.min(1, Math.max(0, edge / 45));
      let h = (3 + 8 * Math.sin(x * 0.018 + z * 0.025) + 3 * Math.sin(x * 0.06)) * t;
      if (x < -60) h += Math.max(0, (-60 - x) / 58) * 10 * t;
      return Math.max(0, h);
    };

    const X0 = 25, W = 1550, D = 1000, SX = 72, SZ = 48;
    const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    const cGrass = new THREE.Color(0x3f4a2e);
    const cDry = new THREE.Color(0x6b6047);
    const cRock = new THREE.Color(0x5e574f);
    const cHigh = new THREE.Color(0x8a847c);
    const cSand = new THREE.Color(0x8a7a5c);
    const cFloor = new THREE.Color(0x1b3038);
    const cInside = new THREE.Color(0x24241f);
    const fogC = new THREE.Color(0x8a7e70);
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + X0, wz = pos.getZ(i);
      const y = H(wx, wz);
      pos.setY(i, y);
      let c;
      if (wx > 118) c = cFloor.clone();
      else if (inCity(wx, wz) || inFoothills(wx, wz)) c = cInside.clone();
      else if (wx < -235) {
        if (y < 10) c = cGrass.clone().lerp(cDry, y / 10);
        else if (y < 50) c = cDry.clone().lerp(cRock, (y - 10) / 40);
        else c = cRock.clone().lerp(cHigh, Math.min(1, (y - 50) / 70));
      } else {
        c = cSand.clone().lerp(cDry, Math.min(1, y / 18));
        if (y > 16) c.lerp(cRock, Math.min(1, (y - 16) / 20));
      }
      const n = 0.9 + brnd() * 0.18;
      c.multiplyScalar(n);
      const dist = Math.hypot(wx - 40, wz);
      const haze = Math.min(0.4, Math.max(0, (dist - 200) / 700) * 0.4);
      c.lerp(fogC, haze);
      colors.push(c.r, c.g, c.b);
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const terrain = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false,
    }));
    terrain.position.set(X0, 0, 0);
    terrain.castShadow = false; terrain.receiveShadow = false;
    terrain.name = 'backdrop-terrain';
    root.add(terrain);

    // ---- sea ----
    const seaGeo = new THREE.PlaneGeometry(682, 1200, 48, 32);
    seaGeo.rotateX(-Math.PI / 2);
    const seaMat = new THREE.MeshBasicMaterial({ color: 0x2f6470, fog: true });
    seaMat.onBeforeCompile = (shader) => {
      shader.uniforms.uSeaTime = { value: 0 };
      shader.vertexShader = 'uniform float uSeaTime;\nvarying vec2 vSeaPos;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSeaPos = position.xz;
         float wave = sin(position.x * 0.07 + position.z * 0.05 + uSeaTime * 0.9) * 0.12
                    + sin(position.x * 0.13 - position.z * 0.11 + uSeaTime * 1.7) * 0.05;
         transformed.y += wave;`
      );
      shader.fragmentShader = 'uniform float uSeaTime;\nvarying vec2 vSeaPos;\n' + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         float bands = sin(vSeaPos.x * 0.55 + vSeaPos.y * 0.42 + uSeaTime * 1.8) * 0.5 + 0.5;
         gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.36, 0.52, 0.55), bands * 0.08);`
      );
      seaMat.userData.shader = shader;
    };
    seaMatRef = seaMat;
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.position.set(459, -0.3, 0);
    sea.castShadow = false; sea.receiveShadow = false;
    sea.name = 'backdrop-sea';
    root.add(sea);

    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xd6e4e1, transparent: true, opacity: 0.42, depthWrite: false, fog: false,
    });
    const foamGeo = new THREE.PlaneGeometry(2.8, 132);
    foamGeo.rotateX(-Math.PI / 2);
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.position.set(119.5, -0.27, -32);
    root.add(foam);
    const foamGeo2 = new THREE.PlaneGeometry(70, 1.6);
    foamGeo2.rotateX(-Math.PI / 2);
    const foam2 = new THREE.Mesh(foamGeo2, foamMat);
    foam2.position.set(155, -0.27, -2.1);
    root.add(foam2);
    const foam3 = new THREE.Mesh(foamGeo2, foamMat);
    foam3.position.set(155, -0.27, -21.9);
    root.add(foam3);

    // ---- dock (scenic, outside bounds) ----
    const dBox = (w, h, d, mat, x, y, z, rot = 0, uv = 1.4) =>
      meshBox(w, h, d, mat, x, y, z, rot, { group: farGroup, uv, cast: false, recv: false });
    const dCyl = (rt, rb, h, seg, mat, x, y, z) =>
      meshCyl(rt, rb, h, seg, mat, x, y, z, { group: farGroup, cast: false, recv: false });
    dBox(70, 0.6, 20, mats.concrete, 155, 0.3, -12, 0, 2.6);
    dBox(70, 0.12, 0.35, mats.wood, 155, 0.66, -22, 0, 1.2);
    dBox(70, 0.12, 0.35, mats.wood, 155, 0.66, -2, 0, 1.2);
    for (let x = 124; x <= 186; x += 8) for (const z of [-20, -4]) dCyl(0.35, 0.42, 2.2, 8, mats.concreteDark, x, 0.1, z);
    for (let x = 128; x <= 184; x += 14) for (const z of [-20.3, -3.7]) {
      dCyl(0.32, 0.36, 0.9, 8, mats.rust, x, 1.05, z);
      dCyl(0.5, 0.5, 0.12, 8, mats.metal, x, 1.52, z);
    }
    for (const x of [130, 158, 184]) {
      dCyl(0.06, 0.08, 4.6, 6, mats.metal, x, 2.8, -20.8);
      dBox(0.5, 0.18, 0.5, mats.windowLit, x, 5.15, -20.8);
    }
    dBox(2.0, 2.0, 2.0, mats.wood, 136, 1.6, -8, 0.12);
    dBox(1.4, 1.6, 1.4, mats.wood, 138.5, 1.4, -7.4, -0.08);
    dBox(2.2, 2.2, 2.2, mats.wood, 148, 1.7, -16, 0.05);
    dBox(2.4, 2.4, 2.4, mats.metalTan, 178, 1.8, -11, 0.15);
    dBox(1.6, 1.4, 1.6, mats.rust, 168, 1.3, -6, 0.2);
    dBox(0.8, 8.0, 0.8, mats.metal, 176, 4.4, -18, 0);
    dBox(7.0, 0.4, 0.4, mats.metal, 179, 8.2, -18, 0.55);
    dBox(0.08, 3.4, 0.08, mats.metal, 182, 6.4, -18, 0, 0.8);
    dBox(18, 4.0, 5.0, mats.plasterB, 174, 2.6, -19.0, 0, 1.8);
    dBox(18.5, 0.35, 5.5, mats.metal, 174, 4.75, -19.0, 0, 1.4);
    dBox(3.0, 2.6, 0.2, mats.metal, 174, 1.9, -16.4, 0, 1.0);
    dBox(8, 0.22, 1.8, mats.wood, 193, 0.72, -10, 0, 1.0);
    for (let x = 190; x <= 196; x += 2) dBox(0.1, 1.1, 0.1, mats.metal, x, 1.35, -10, 0, 0.6);

    // ---- playable dock: 0.6 m deck, gangway from the quay, rails, nav ----
    EXPANSION_RAMPS.push({ id: 'dock-gangway', x0: 116.2, x1: 121.0, z0: -14, z1: -10, rise: 0.6, axis: 'x' });
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      meshBox(4.8, 0.1, 3.7, mats.wood, 116.3 + 4.7 * t, 0.05 + 0.6 * t, -12, 0, { group: statics, uv: 1.2, cast: false });
    }
    for (const z of [-14.1, -9.9]) {
      meshBox(5.2, 0.08, 0.08, mats.rust, 118.6, 1.05, z, 0, { group: statics, cast: false });
      for (let x = 116.4; x <= 120.8; x += 1.3) meshBox(0.07, 1.0, 0.07, mats.metal, x, 0.5, z, 0, { group: statics, cast: false });
    }
    // visible dock rails (colliders go in separately)
    for (const z of [-22, -2]) {
      for (let x = 121; x <= 189; x += 7) meshBox(0.09, 1.05, 0.09, mats.metal, x, 1.12, z, 0, { group: statics, cast: false });
      meshBox(69, 0.07, 0.07, mats.rust, 155, 1.55, z, 0, { group: statics, cast: false });
      meshBox(69, 0.06, 0.06, mats.rust, 155, 0.95, z, 0, { group: statics, cast: false });
    }
    for (let z = -21; z <= -3; z += 6) meshBox(0.09, 1.05, 0.09, mats.metal, 189.8, 1.12, z, 0, { group: statics, cast: false });
    meshBox(0.07, 0.07, 19.2, mats.rust, 189.8, 1.55, -12, 0, { group: statics, cast: false });
    // dock seal: perimeter colliders (sea is non-walkable outside the deck)
    addCollider(155, -22.25, 70, 0.3, 0.04);
    addCollider(155, -1.75, 70, 0.3, 0.04);
    addCollider(190.25, -12, 0.3, 20, 0.04);
    addCollider(119.6, -18, 0.3, 8, 0.04);
    addCollider(119.6, -6, 0.3, 8, 0.04);
    addCollider(118.5, -14.2, 5.5, 0.25, 0.04);
    addCollider(118.5, -9.8, 5.5, 0.25, 0.04);
    // big water exclusion outside the dock footprint
    addCollider(154, -120, 72, 196, 0.04);
    addCollider(154, 74, 72, 152, 0.04);
    addCollider(119.2, -18, 2.2, 8, 0.04);
    addCollider(119.2, -6, 2.2, 8, 0.04);
    // deck obstacles (shed + big crates) so the player cannot walk through them
    addCollider(174, -19, 18, 5, 0.05);
    addCollider(136, -8, 2.1, 2.1, 0.05);
    addCollider(148, -16, 2.3, 2.3, 0.05);
    addCollider(178, -11, 2.5, 2.5, 0.05);
    ROOF_ZONES.push({ x0: 120, x1: 190, z0: -22, z1: -2, y: 0.6 });
    ROOF_SPAWNS.push({ x: 150, z: -12, y: 0.6 }); spawnPoints.push({ x: 150, z: -12, y: 0.6 });
    ROOF_COVERS.push({ x: 160, z: -18, y: 0.6, h: true }, { x: 140, z: -6, y: 0.6, h: false });
    coverPoints.push({ x: 160, z: -18, y: 0.6, h: true }, { x: 140, z: -6, y: 0.6, h: false });
    // two dock buildings: office (east) + store hut (west), both enterable
    const dockHut = (cx, cz, w, d, doorZ) => {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, base = 0.6, h = 2.4;
      meshBox(w, 0.08, d, mats.wood, cx, base + 0.04, cz, 0, { group: statics, uv: 1.0, cast: false });
      meshBox(w, h, 0.16, mats.plasterB, cx, base + h / 2, z0, 0, { group: statics, uv: 1.2 });
      meshBox(w, h, 0.16, mats.plasterB, cx, base + h / 2, z1, 0, { group: statics, uv: 1.2 });
      meshBox(0.16, h, d, mats.plasterB, x0, base + h / 2, cz, 0, { group: statics, uv: 1.2 });
      const gap = 1.8;
      // carve the door by leaving a gap in the east wall: split it around z=cz
      meshBox(0.16, h, (d - gap) / 2, mats.plasterB, x1, base + h / 2, cz - (gap + d) / 4, 0, { group: statics, uv: 1.0 });
      meshBox(0.16, h, (d - gap) / 2, mats.plasterB, x1, base + h / 2, cz + (gap + d) / 4, 0, { group: statics, uv: 1.0 });
      meshBox(w + 0.3, 0.16, d + 0.3, mats.metal, cx, base + h + 0.08, cz, 0, { group: statics, uv: 1.4 });
      meshBox(0.06, 0.75, 0.9, mats.windowLitDim, x0 + 0.05, base + 1.5, cz + 0.6, 0, { group: statics, cast: false });
      // east wall door header + frame
      meshBox(0.2, 0.5, gap + 0.3, mats.wood, x1, base + h - 0.25, cz, 0, { group: statics, cast: false });
      meshBox(1.1, 0.65, 0.5, mats.wood, cx - 0.5, base + 0.35, cz - (d - 2.3) / 2, 0, { group: statics, uv: 0.8 });
      addCollider(x0, cz, 0.2, d, 0.05);
      addCollider(x1, cz - gap / 2 - 0.5, 0.2, (d - gap) / 2, 0.05);
      addCollider(x1, cz + gap / 2 + 0.5, 0.2, (d - gap) / 2, 0.05);
      addCollider(cx, z0, w, 0.2, 0.05);
      addCollider(cx, z1, w, 0.2, 0.05);
    };
    dockHut(183, -6, 4.0, 3.0, true);
    dockHut(130, -18, 3.5, 3.0, false);
    // sentry/checkpoint at the gangway head (keeps the 4 m gate clear)
    meshBox(1.9, 0.12, 1.9, mats.concrete, 123.2, 0.66, -16.2, 0, { group: statics, cast: false });
    for (const [x, z] of [[122.4, -16.2], [124.0, -16.2]]) meshBox(0.3, 2.1, 0.3, mats.wood, x, 1.65, z, 0, { group: statics, cast: false });
    meshBox(2.1, 0.14, 2.1, mats.metal, 123.2, 2.75, -16.2, 0, { group: statics, cast: false });
    meshBox(0.12, 1.0, 1.0, mats.windowLit, 123.2, 2.2, -15.3, 0, { group: statics, cast: false });
    meshBox(2.6, 0.8, 0.7, mats.sandbag, 121.6, 1.0, -15.0, 0, { group: statics, uv: 0.8 });
    meshBox(2.6, 0.8, 0.7, mats.sandbag, 121.6, 1.0, -9.0, 0, { group: statics, uv: 0.8 });
    addCollider(123.2, -16.2, 2.0, 2.0, 0.05);
    addCollider(121.6, -15.0, 2.6, 0.7, 0.05);
    addCollider(121.6, -9.0, 2.6, 0.7, 0.05);
    // mooring ropes + dock lamp light
    for (const [x, z, len, ry] of [[187, -19.5, 8, 0.55], [187, -17.0, 8, 0.45], [186, -21.0, 6, 0.7]]) {
      meshBox(0.035, 0.035, len, mats.rust, x, 0.9, z, ry, { group: statics, cast: false });
    }
    const dockLight = new THREE.PointLight(0xffc48a, 0.5, 18, 1.8);
    dockLight.position.set(160, 4.2, -12); root.add(dockLight);


    // distant ship / buoy silhouettes (unfogged so they read as a horizon)
    const silMat = new THREE.MeshLambertMaterial({ color: 0x394044, flatShading: true, fog: false });
    const silGroup = new THREE.Group();
    const sil = (w, h, d, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), silMat);
      m.position.set(x, y, z); m.rotation.y = ry; m.castShadow = false; m.receiveShadow = false; silGroup.add(m);
    };
    sil(26, 3.0, 6, 320, 0.5, -90, 0.12); sil(9, 3.0, 5, 318, 2.9, -90, 0.12); sil(0.4, 7, 0.4, 318, 7.8, -90);
    sil(20, 2.4, 5, 470, 0.2, 80, -0.2); sil(7, 2.4, 4, 468, 2.3, 80, -0.2);
    sil(30, 3.4, 7, 680, 0.6, -180, 0.05); sil(11, 3.2, 5, 678, 3.4, -180, 0.05);
    for (const [x, z] of [[205, -60], [238, 28], [270, -120]]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 1.2, 6), silMat);
      b.position.set(x, -0.1, z); b.castShadow = false; b.receiveShadow = false; silGroup.add(b);
    }
    const silMerged = mergeStatic(silGroup, { castShadow: false, receiveShadow: false });
    root.add(silMerged);

    // transition tree / rock silhouettes
    const treeMat = new THREE.MeshBasicMaterial({ color: 0x2b3724, fog: false });
    const trunkMat = new THREE.MeshBasicMaterial({ color: 0x2a231b, fog: false });
    const rockMat = new THREE.MeshBasicMaterial({ color: 0x4e4842, fog: false });
    const treeGroup = new THREE.Group(), trunkGroup = new THREE.Group(), rockGroup = new THREE.Group();
    const treeGeo = new THREE.ConeGeometry(2.2, 6.6, 6);
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.2, 5);
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    for (let i = 0; i < 44; i++) {
      const x = -124 - brnd() * 110, z = -430 + brnd() * 860;
      const y = H(x, z);
      const s = 0.6 + brnd() * 0.8;
      const t = new THREE.Mesh(treeGeo, treeMat);
      t.position.set(x, y + 4.8 * s, z); t.scale.setScalar(s);
      t.castShadow = false; t.receiveShadow = false; treeGroup.add(t);
      const tr = new THREE.Mesh(trunkGeo, trunkMat);
      tr.position.set(x, y + 1.1 * s, z); tr.scale.setScalar(s);
      tr.castShadow = false; tr.receiveShadow = false; trunkGroup.add(tr);
    }
    for (let i = 0; i < 30; i++) {
      const x = -124 - brnd() * 170, z = -440 + brnd() * 880;
      const y = H(x, z);
      const s = 0.7 + brnd() * 1.9;
      const r = new THREE.Mesh(rockGeo, rockMat);
      r.position.set(x, y + 0.45 * s, z); r.scale.set(s * (0.8 + brnd() * 0.5), s * 0.6, s);
      r.rotation.set(brnd() * 2, brnd() * 6, brnd() * 2);
      r.castShadow = false; r.receiveShadow = false; rockGroup.add(r);
    }
    root.add(mergeStatic(treeGroup, { castShadow: false, receiveShadow: false }));
    root.add(mergeStatic(trunkGroup, { castShadow: false, receiveShadow: false }));
    root.add(mergeStatic(rockGroup, { castShadow: false, receiveShadow: false }));
  }

  /* ===================================================================
     FOOTHILLS — playable west fringe (x -235..-118, z -120..120).
     Buildings/rocks are merged statics (bullet targets); instanced trees,
     grass and flowers keep the draw-call cost flat.
     =================================================================== */
  function buildFoothills() {
    const frnd = mulberry32(90210);
    // unlit vertex-coloured grass/dirt floor (readable from every direction)
    const gg = new THREE.PlaneGeometry(117, 240, 24, 40);
    gg.rotateX(-Math.PI / 2);
    const gp = gg.attributes.position, gcols = [];
    const cG1 = new THREE.Color(0x5a6a44), cG2 = new THREE.Color(0x495838), cDirt = new THREE.Color(0x7a684a);
    for (let i = 0; i < gp.count; i++) {
      const lx = gp.getX(i), lz = gp.getZ(i);
      const isPath = Math.abs(lz) < 3.2 || Math.abs(lx + 1.5) < 3.6;
      const c = (isPath ? cDirt : cG1.clone().lerp(cG2, 0.5 + 0.5 * Math.sin(lx * 0.21 + lz * 0.17))).clone();
      const n = 0.94 + frnd() * 0.12; c.multiplyScalar(n);
      gcols.push(c.r, c.g, c.b);
    }
    gg.setAttribute('color', new THREE.Float32BufferAttribute(gcols, 3));
    const gmesh = new THREE.Mesh(gg, new THREE.MeshBasicMaterial({ vertexColors: true }));
    gmesh.position.set(-176.5, 0.02, 0); gmesh.castShadow = false; gmesh.receiveShadow = false;
    root.add(gmesh);

    const wallH = 2.7, t = 0.24, door = 2.0;
    const hut = (cx, cz) => {
      const w = 4.4, d = 5.6, h = wallH;
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
      meshBox(w, 0.1, d, mats.concrete, cx, 0.05, cz, 0, { uv: 1.4, cast: false });
      meshBox(w, h, t, mats.plasterC, cx, h / 2, z0, 0, { collide: true, uv: 1.4 });
      meshBox(t, h, d, mats.plasterC, x0, h / 2, cz, 0, { collide: true, uv: 1.4 });
      meshBox(t, h, d, mats.plasterC, x1, h / 2, cz, 0, { collide: true, uv: 1.4 });
      const gap = (w - door) / 2;
      meshBox(gap, h, t, mats.plasterC, x0 + gap / 2, h / 2, z1, 0, { collide: true, uv: 1.2 });
      meshBox(gap, h, t, mats.plasterC, x1 - gap / 2, h / 2, z1, 0, { collide: true, uv: 1.2 });
      meshBox(door, 0.55, t, mats.plasterC, cx, h - 0.28, z1, 0, { cast: false });
      meshBox(w + 0.5, 0.26, d + 0.5, mats.wood, cx, h + 0.13, cz, 0, { uv: 1.6 });
      meshBox(0.06, 0.9, 1.1, mats.windowLitDim, x0 + 0.02, 1.55, cz + 1.2, 0, { cast: false });
      meshBox(1.6, 0.7, 0.55, mats.wood, cx - 0.6, 0.35, z0 + 1.2, 0, { uv: 0.8, collide: true });
      meshBox(1.6, 0.08, 0.75, mats.wood, cx - 0.6, 0.74, z0 + 1.2, 0, { cast: false });
      meshBox(0.8, 0.25, 1.8, mats.wood, cx + 1.25, 0.24, z0 + 1.6, 0, { uv: 0.7, collide: true });
      meshBox(0.8, 0.6, 0.06, mats.wood, cx + 1.25, 0.6, z0 + 2.45, 0, { cast: false });
      meshBox(0.55, 0.55, 0.55, mats.wood, cx - 1.6, 0.3, z1 - 1.1, 0, { uv: 0.7, collide: true });
    };
    hut(-200, 44);
    hut(-168, -62);
    for (const [lx, lz] of [[-200, 44], [-168, -62]]) {
      const lamp = new THREE.PointLight(0xffb07a, 0.55, 13, 1.6);
      lamp.position.set(lx, 2.2, lz); root.add(lamp);
    }

    // watchtower: 4.2 m deck, ramp from the south-east, roof zone + spawn/cover
    EXPANSION_RAMPS.push({ id: 'foothill-tower', x0: -206.8, x1: -205.4, z0: 16, z1: 8, rise: 4.2 });
    for (const [x, z] of [[-212, 4], [-212, 8], [-208, 4], [-208, 8]]) meshBox(0.26, 4.2, 0.26, mats.wood, x, 2.1, z, 0, { uv: 0.8, collide: true });
    meshBox(4.6, 0.32, 4.6, mats.wood, -210, 4.05, 6, 0, { uv: 1.8 });
    meshBox(5.0, 0.22, 5.0, mats.metal, -210, 5.9, 6, 0, { uv: 1.6 });
    for (const [x, z] of [[-212.2, 4], [-212.2, 8], [-207.8, 4], [-207.8, 8]]) meshBox(0.2, 0.05, 0.2, mats.wood, x, 4.3, z, 0, { cast: false });
    for (const yy of [4.9, 5.5]) {
      meshBox(4.5, 0.07, 0.07, mats.wood, -210, yy, 4.0, 0, { cast: false });
      meshBox(4.5, 0.07, 0.07, mats.wood, -210, yy, 8.0, 0, { cast: false });
      meshBox(0.07, 0.07, 4.5, mats.wood, -212, yy, 6, 0, { cast: false });
      meshBox(0.07, 0.07, 4.5, mats.wood, -208, yy, 6, 0, { cast: false });
    }
    for (let i = 0; i < 10; i++) {
      const tt = i / 9;
      meshBox(1.4, 0.12, 0.9, mats.wood, -206.1, 4.2 * tt + 0.05, 16 - 8 * tt, 0, { cast: false });
    }
    ROOF_ZONES.push({ x0: -212, x1: -208, z0: 4, z1: 8, y: 4.2 });
    ROOF_ZONES.push({ x0: -208, x1: -205.4, z0: 6, z1: 8, y: 4.2 });
    ROOF_SPAWNS.push({ x: -210, z: 6, y: 4.2 }); spawnPoints.push({ x: -210, z: 6, y: 4.2 });
    ROOF_COVERS.push({ x: -210, z: 7, y: 4.2, h: true }); coverPoints.push({ x: -210, z: 7, y: 4.2, h: true });

    // checkpoint bunker + sandbags
    const bx = -150, bz = -80;
    meshBox(5.0, 0.1, 4.0, mats.concrete, bx, 0.05, bz, 0, { uv: 1.4, cast: false });
    meshBox(5.0, 2.3, 0.26, mats.concrete, bx, 1.15, bz - 2.0, 0, { collide: true, uv: 1.4 });
    meshBox(0.26, 2.3, 4.0, mats.concrete, bx - 2.5, 1.15, bz, 0, { collide: true, uv: 1.4 });
    meshBox(0.26, 2.3, 1.4, mats.concrete, bx + 2.5, 1.15, bz - 1.3, 0, { collide: true, uv: 1.2 });
    meshBox(0.26, 2.3, 1.4, mats.concrete, bx + 2.5, 1.15, bz + 1.3, 0, { collide: true, uv: 1.2 });
    meshBox(0.26, 1.0, 1.6, mats.concrete, bx + 2.5, 1.8, bz, 0, { cast: false });
    meshBox(5.2, 0.25, 4.3, mats.concreteDark, bx, 2.4, bz, 0, { uv: 1.4 });
    for (const [ox, oz] of [[-2.8, -0.5], [-2.8, 1.0], [2.9, 2.4], [-1.4, 2.9]]) {
      meshBox(1.8, 0.8, 0.6, mats.sandbag, bx + ox, 0.4, bz + oz, 0, { uv: 0.8, collide: true });
      coverPoints.push({ x: bx + ox, z: bz + oz + 0.8, h: false });
    }
    // campfire + light pool
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      meshBox(0.35, 0.22, 0.35, mats.plasterC, -190 + Math.cos(a) * 0.8, 0.11, 24 + Math.sin(a) * 0.8, 0, { cast: false });
    }
    for (const [dx, dz] of [[-0.5, -0.2], [0.4, 0.3], [0.1, -0.5]]) meshBox(0.9, 0.18, 0.18, mats.wood, -190 + dx, 0.2, 24 + dz, 0.4, { cast: false });
    const fireLight = new THREE.PointLight(0xff8a44, 0.9, 14, 1.6);
    fireLight.position.set(-190, 1.0, 24); root.add(fireLight);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({
      map: mats.sprites.glow, color: 0xff8a44, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(-190, 0.05, 24); root.add(glow);

    // rock cover (merged statics)
    const rockMat = mats.concrete;
    for (const [x, z, s] of [[-215, -20, 1.6], [-195, 65, 1.4], [-180, -85, 1.8], [-160, 80, 1.3], [-145, 0, 1.2], [-135, -40, 1.5], [-220, 20, 1.4], [-150, 30, 1.1]]) {
      const g = new THREE.DodecahedronGeometry(1, 0);
      const m = new THREE.Mesh(g, rockMat);
      m.position.set(x, 0.45 * s, z); m.scale.set(s, s * 0.6, s); m.rotation.set(frnd() * 2, frnd() * 6, 0);
      m.castShadow = false; m.receiveShadow = false; statics.add(m);
      addCollider(x, z, s * 1.4, s * 1.2, 0.05);
      coverPoints.push({ x: x + s * 0.9, z, h: false });
    }
    // sandbag line at the checkpoint approach
    for (const [x, z] of [[-142, -20], [-139, -18], [-136, -22]]) {
      meshBox(1.7, 0.85, 0.7, mats.sandbag, x, 0.42, z, 0.2, { uv: 0.8, collide: true });
      coverPoints.push({ x, z: z + 0.8, h: false });
    }

    // boundary fences (gated to the city on the east)
    const fence = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), rot = Math.atan2(x1 - x0, z1 - z0);
      meshBox(0.08, 1.0, len, mats.rust, (x0 + x1) / 2, 0.5, (z0 + z1) / 2, Math.atan2(x1 - x0, z1 - z0), { uv: 0.8, cast: false });
      for (let i = 0; i <= Math.floor(len / 3); i++) {
        const tt = i / Math.max(1, Math.floor(len / 3));
        meshBox(0.1, 1.2, 0.1, mats.metal, x0 + (x1 - x0) * tt, 0.6, z0 + (z1 - z0) * tt, 0, { cast: false });
      }
      addColliderRot((x0 + x1) / 2, (z0 + z1) / 2, 0.3, len, rot, 0.05);
    };
    fence(-234, -118, -118, -118);
    fence(-234, 118, -118, 118);
    fence(-234, -118, -234, 118);
    fence(-118, -118, -118, -20);
    fence(-118, 20, -118, 40);
    fence(-118, 56, -118, 118);
    fence(-196, 118, -196, 108);

    // instanced trees (24) + grass/flowers, no shadow cost
    const trees = [
      [-225, -100, 1.1], [-220, -70, 1.0], [-228, 80, 1.2], [-215, 60, 0.9], [-205, -30, 1.1],
      [-195, -100, 1.2], [-190, 80, 1.0], [-180, 100, 1.1], [-175, 70, 0.9], [-165, 30, 1.0],
      [-160, 100, 1.2], [-155, 60, 1.0], [-145, -30, 1.1], [-140, -60, 0.9], [-135, 40, 1.1],
      [-130, 90, 1.0], [-230, 40, 1.2], [-225, 110, 1.0], [-220, -110, 1.1], [-210, -90, 0.9],
      [-200, 100, 1.1], [-185, -40, 1.0], [-170, 10, 0.9], [-160, -100, 1.1],
    ];
    const foliage = new THREE.InstancedMesh(new THREE.ConeGeometry(1.7, 5.2, 6), new THREE.MeshBasicMaterial({ color: 0x30412a }), trees.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 5), new THREE.MeshBasicMaterial({ color: 0x34291f }), trees.length);
    foliage.castShadow = false; foliage.receiveShadow = false; trunks.castShadow = false; trunks.receiveShadow = false;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    trees.forEach(([x, z, s], i) => {
      m4.compose(new THREE.Vector3(x, 4.4 * s, z), q, sc.set(s, s, s)); foliage.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(x, 1.1 * s, z), q, sc.set(s, s, s)); trunks.setMatrixAt(i, m4);
      addCollider(x, z, 0.8 * s, 0.8 * s, 0.04);
      if (i % 3 === 0) coverPoints.push({ x: x + 1.0, z: z + 0.7, h: false });
    });
    root.add(foliage, trunks);
    const grassGeo = new THREE.PlaneGeometry(0.13, 0.46);
    const grass = new THREE.InstancedMesh(grassGeo, new THREE.MeshBasicMaterial({ color: 0x5b6a3d, side: THREE.DoubleSide }), 380);
    grass.castShadow = false; grass.receiveShadow = false;
    const e = new THREE.Euler();
    for (let i = 0; i < 380; i++) {
      const x = -232 + frnd() * 112, z = -116 + frnd() * 232;
      q.setFromEuler(e.set(0, frnd() * 6.28, 0));
      m4.compose(new THREE.Vector3(x, 0.23, z), q, sc.set(1, 1, 1)); grass.setMatrixAt(i, m4);
    }
    root.add(grass);
    const flowers = new THREE.InstancedMesh(new THREE.CircleGeometry(0.06, 5), new THREE.MeshBasicMaterial({ color: 0xc9a15e }), 110);
    flowers.castShadow = false; flowers.receiveShadow = false;
    for (let i = 0; i < 110; i++) {
      const x = -232 + frnd() * 112, z = -116 + frnd() * 232;
      q.setFromEuler(e.set(-Math.PI / 2, 0, 0));
      m4.compose(new THREE.Vector3(x, 0.18, z), q, sc.set(1, 1, 1)); flowers.setMatrixAt(i, m4);
    }
    root.add(flowers);

    // trail sign + dirt path from the city gate
    meshBox(0.12, 2.2, 0.12, mats.wood, -120.5, 1.1, 45.5, 0, { cast: false });
    meshBox(1.6, 0.7, 0.08, mats.signA, -120.5, 2.0, 45.5, 0, { cast: false });
    const pathMat = new THREE.MeshBasicMaterial({ color: 0x756043 });
    const path1 = new THREE.Mesh(new THREE.PlaneGeometry(82, 3.4), pathMat);
    path1.rotation.x = -Math.PI / 2; path1.position.set(-157, 0.04, 46); root.add(path1);
    for (const [x, z] of [[-180, 0], [-160, 50], [-200, -60], [-140, 20]]) spawnPoints.push({ x, z });
    for (const [x, z] of [[-190, 24], [-200, 44], [-168, -62], [-150, -80], [-210, 6]]) coverPoints.push({ x: x + 0.6, z: z + 0.6, h: false });
  }

  function buildYardMarketStatic() {
    // ---------- ground: yard + back lane
    meshPlane(10.6, 10.4, mats.dirt, 22.0, 0.012, -11.05, { rx: -Math.PI / 2, uvScale: 2.6, recv: true });
    meshPlane(2.6, 10.4, mats.dirt, 28.45, 0.012, -11.05, { rx: -Math.PI / 2, uvScale: 1.9, recv: true });
    meshBox(7.0, 0.07, 7.9, mats.concrete, 20.5, 0.035, -10.7, 0, { uv: 2.2, cast: false });
    addPuddles([[19.2, -15.3, 1.2, 0.5], [25.9, -9.0, 0.9, 0.5], [26.7, -13.9, 0.8, 0.45]]);
    addWeeds(17.15, -14.9, 2);
    addWeeds(26.7, -6.5, 3);
    addWeeds(26.9, -15.2, 2);
    addRubble(26.5, -6.7, 1.2, 12);
    addRubble(17.1, -15.4, 0.9, 8);

    // ---------- tall apartment wall facing the yard (windows / pipe / grime)
    for (const wy of [5.4, 8.2, 11.0]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.35), mats.windowGlass);
      win.position.set(17.02, wy, -12.4);
      win.rotation.y = Math.PI / 2;
      statics.add(win);
      for (const dz of [-0.6, 0.6]) meshBox(0.12, 1.55, 0.12, mats.concrete, 17.03, wy, -12.4 + dz, 0, { uv: 0.8, cast: false });
      meshBox(0.14, 0.12, 1.45, mats.concrete, 17.05, wy - 0.74, -12.4, 0, { uv: 0.8, cast: false });
      meshBox(0.16, 1.1, 0.16, mats.interior, 17.03, wy - 0.1, -12.4 - 0.7, 0, { uv: 0.5, cast: false });
      addGrime(-1, 17.02, wy - 1.4, -12.4, 1.1, 1.4);
    }
    meshCyl(0.05, 0.05, 10.6, 6, mats.rust, 17.08, 8.0, -9.6, { cast: false });
    for (const yy of [3.6, 7.2, 10.8]) meshBox(0.16, 0.12, 0.5, mats.rust, 17.06, yy, -9.6, 0, { uv: 0.5, cast: false });

    // ---------- east fence + gate (see-through bars)
    const fx = 27.2;
    const gateZ0 = -13.2, gateZ1 = -10.8;
    for (const z of [-16.1, -14.65, gateZ0, gateZ1, -9.35, -7.9, -6.0]) {
      meshBox(0.16, 2.5, 0.16, mats.metal, fx, 1.25, z, 0, { uv: 0.8 });
    }
    for (const [za, zb] of [[-16.1, gateZ0], [gateZ1, -6.0]]) {
      for (const yy of [0.55, 1.3, 2.05]) meshBox(0.06, 0.06, zb - za, mats.metal, fx, yy, (za + zb) / 2, 0, { uv: 0.7, cast: false });
      if (za < -14) meshBox(0.05, 0.8, zb - za, mats.shop, fx, 0.48, (za + zb) / 2, 0, { uv: 1.5, cast: false });
      for (let z = za + 0.1; z < zb - 0.05; z += 0.2) meshBox(0.028, 1.45, 0.028, mats.metal, fx, 1.25, z, 0, { uv: 0.4, cast: false });
      addColliderRect(fx - 0.12, fx + 0.12, za, zb);
    }
    // gate piers + open leaves (visual, opening stays clear)
    for (const z of [gateZ0, gateZ1]) meshBox(0.24, 2.7, 0.24, mats.concreteDark, fx, 1.35, z, 0, { uv: 1.0 });
    for (const [z, dir] of [[gateZ0, -1], [gateZ1, 1]]) {
      const g = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5), mats.metal);
        bar.position.set(0, 1.0, dir * (0.2 + i * 0.22));
        g.add(bar);
      }
      for (const yy of [0.35, 1.75]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.35), mats.metal);
        rail.position.set(0, yy, dir * 0.8);
        g.add(rail);
      }
      g.position.set(fx + 0.02, 0, z);
      g.rotation.y = dir * 0.55;
      statics.add(g);
    }
    // gate lamp + "EXIT" board
    meshBox(0.4, 0.05, 0.05, mats.rust, fx - 0.2, 3.0, -12.0, 0, { uv: 0.5, cast: false });
    meshBox(0.24, 0.14, 0.2, mats.metalTan, fx - 0.4, 2.88, -12.0, 0, { uv: 0.6 });
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.11), mats.windowLit);
    gl.rotation.x = Math.PI / 2;
    gl.position.set(fx - 0.4, 2.8, -12.0);
    statics.add(gl);
    lightPool(fx - 0.6, -12.0, 1.6, 0.22);
    const ex = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.4), mats.signB);
    ex.position.set(fx + 0.14, 2.05, -12.0);
    ex.rotation.y = Math.PI / 2;
    statics.add(ex);

    // ---------- south fence + north fence (building wall covers the rest)
    for (const [ax0, ax1, az] of [[16.9, 27.2, -16.1], [24.35, 27.2, -6.0]]) {
      for (let x = ax0 + 0.1; x <= ax1; x += 2.1) meshBox(0.14, 2.4, 0.14, mats.metal, x, 1.2, az, 0, { uv: 0.8 });
      for (const yy of [0.55, 1.3, 2.0]) meshBox(ax1 - ax0, 0.06, 0.06, mats.metal, (ax0 + ax1) / 2, yy, az, 0, { uv: 0.7, cast: false });
      for (let x = ax0 + 0.12; x < ax1 - 0.05; x += 0.2) meshBox(0.028, 1.4, 0.028, mats.metal, x, 1.2, az, 0, { uv: 0.4, cast: false });
      addColliderRect(ax0, ax1, az - 0.12, az + 0.12);
    }

    // ---------- service lane + boundary wall + distant skyline
    meshBox(0.32, 3.1, 10.1, mats.plasterB, 29.7, 1.55, -11.05, 0, { uv: 2.6 });
    meshBox(0.5, 0.14, 10.2, mats.concreteDark, 29.7, 3.14, -11.05, 0, { uv: 1.6, cast: false });
    addColliderRect(29.52, 29.9, -16.1, -6.0);
    for (const z of [-16.1, -6.0]) {
      meshBox(2.6, 2.6, 0.3, mats.plasterB, 28.45, 1.3, z, 0, { uv: 2.2 });
      addColliderRect(27.2, 29.8, z - 0.18, z + 0.18);
    }
    for (let k = 0; k < 4; k++) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(rr(1.4, 2.4), rr(1.0, 1.8)), mats.graffiti);
      g.position.set(29.52, rr(0.7, 2.0), rr(-15.2, -7.0));
      g.rotation.y = -Math.PI / 2;
      statics.add(g);
    }
    // junk in the lane
    barrel(28.6, -8.4);
    pallet(28.4, -14.8, 0.5);
    tire(28.9, -10.6, 0.7);
    // distant silhouettes beyond the lane wall (seen through the bar fence)
    for (let k = 0; k < 5; k++) {
      const bx = 34 + k * 3.6, bz = -18 + k * 3.4;
      const bh = 8 + (k % 3) * 5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(rr(2.4, 4.2), bh, rr(2.4, 4.2)), mats.concreteDark);
      b.position.set(bx, bh / 2, bz);
      farGroup.add(b);
    }

    // ---------- market hall (open stalls + walkable roof deck on posts)
    const mx0 = 17.0, mx1 = 24.0, mz0 = -14.6, mz1 = -6.8;
    meshBox(mx1 - mx0, 0.08, mz1 - mz0, mats.concreteDark, (mx0 + mx1) / 2, 0.04, (mz0 + mz1) / 2, 0, { uv: 2.4, cast: false });
    // posts OUTSIDE the deck footprint (no colliders, so no roof air walls)
    for (const [px, pz] of [[18.4, -13.6], [23.6, -13.6], [18.4, -7.7], [23.6, -7.7], [18.4, -10.65], [23.6, -10.65]]) {
      meshBox(0.15, 3.2, 0.15, mats.metal, px, 1.6, pz, 0, { uv: 0.8 });
      meshBox(0.55, 0.12, 0.55, mats.concreteDark, px, 0.08, pz, 0, { uv: 0.8, cast: false });
    }
    for (const pz of [-13.6, -7.7]) meshBox(5.4, 0.16, 0.16, mats.metal, 21.0, 3.0, pz, 0, { uv: 0.8, cast: false });
    for (const px of [18.4, 23.6]) meshBox(0.16, 0.16, 6.1, mats.metal, px, 3.0, -10.65, 0, { uv: 0.8, cast: false });
    // the walkable deck (top exactly 3.2)
    meshBox(4.8, 0.2, 5.5, mats.metal, 21.0, 3.1, -10.65, 0, { uv: 1.2 });
    for (let i = 0; i < 6; i++) meshBox(4.6, 0.06, 0.1, mats.rust, 21.0, 3.21, -12.9 + i * 0.86, 0, { uv: 0.6, cast: false });
    // low parapet (visual)
    for (const [w, d, x, z] of [[4.8, 0.06, 21.0, -13.37], [0.06, 5.5, 18.63, -10.65]]) {
      meshBox(w, 0.34, d, mats.metal, x, 3.39, z, 0, { uv: 0.9, cast: false });
    }
    meshBox(0.06, 0.34, 4.4, mats.metal, 23.37, 3.39, -11.5, 0, { uv: 0.9, cast: false });
    meshBox(4.8, 0.34, 0.06, mats.metal, 21.0, 3.39, -7.93, 0, { uv: 0.9, cast: false });
    // skylight + roof clutter (visual only, no colliders)
    meshBox(1.3, 0.07, 1.3, mats.metalTan, 21.0, 3.24, -10.6, 0, { uv: 0.7, cast: false });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05), mats.windowGlass);
    sky.rotation.x = -Math.PI / 2; sky.position.set(21.0, 3.28, -10.6);
    statics.add(sky);
    meshBox(0.95, 0.9, 0.95, mats.wood, 22.6, 3.65, -8.7, 0.2, { uv: 0.8 });
    meshBox(0.85, 0.8, 0.85, mats.wood, 19.6, 3.6, -12.5, -0.15, { uv: 0.8 });
    meshBox(0.7, 0.7, 0.6, mats.metal, 20.0, 3.55, -12.8, 0, { uv: 0.6 });
    // awnings over the side stalls
    meshBox(1.5, 0.05, 7.7, mats.awning, 17.45, 2.62, -10.7, 0, { uv: 0.9, rz: -0.12 });
    meshBox(0.05, 0.2, 7.7, mats.burlap, 16.75, 2.48, -10.7, 0, { uv: 0.8, cast: false });
    for (const zz of [-14.2, -7.2]) meshBox(1.2, 0.05, 7.0, mats.awning, 21.0, 2.66, zz, 0, { uv: 0.9, rx: 0.12 });
    // stall counters (outside the deck footprint; all are ground colliders)
    for (const [cx, cz] of [[19.7, -14.35], [23.0, -14.35]]) {
      meshBox(1.7, 0.95, 0.55, mats.wood, cx, 0.475, cz, 0, { uv: 1.0 });
      meshBox(1.85, 0.07, 0.68, mats.metalTan, cx, 0.98, cz, 0, { uv: 0.8, cast: false });
      addColliderRect(cx - 0.85, cx + 0.85, cz - 0.28, cz + 0.28);
    }
    // goods on the south counters
    for (let i = 0; i < 3; i++) {
      meshBox(0.26, 0.18, 0.3, i % 2 ? mats.burlap : mats.metalTan, 19.2 + i * 0.5, 1.07, -14.35, 0, { uv: 0.5, cast: false });
    }
    meshBox(0.45, 0.05, 2.6, mats.wood, 17.1, 1.7, -8.5, 0, { uv: 0.8, cast: false });
    meshBox(0.45, 0.05, 2.6, mats.wood, 17.1, 2.25, -8.5, 0, { uv: 0.8, cast: false });
    for (let i = 0; i < 3; i++) meshBox(0.34, 0.24, 0.34, mats.burlap, 17.15, 1.85, -9.4 + i * 0.8, 0, { uv: 0.5, cast: false });
    // hanging bulbs + single point light
    for (const [bx, bz] of [[19.4, -12.0], [21.0, -10.7], [22.6, -9.2]]) {
      meshCyl(0.01, 0.01, 0.45, 4, mats.rubber, bx, 2.8, bz, { cast: false });
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mats.windowLit);
      bulb.position.set(bx, 2.57, bz);
      statics.add(bulb);
      lightPool(bx, bz, 1.3, 0.14);
    }
    const ml = new THREE.PointLight(0xffb070, 7.4, 9.5, 2);
    ml.position.set(20.9, 2.45, -10.7);
    dynamic.add(ml);
    // warm emissive strips under the deck (no extra point lights)
    for (const [sx, sz] of [[19.7, -12.6], [22.3, -9.0], [21.0, -10.7]]) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.22), mats.windowLitDim);
      strip.rotation.x = Math.PI / 2;
      strip.position.set(sx, 3.05, sz);
      statics.add(strip);
      lightPool(sx, sz, 1.4, 0.1);
    }
    // entrance signs / frames
    for (const [sz, rot] of [[-14.55, Math.PI], [-6.85, 0]]) {
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.55), mats.signB);
      frame.position.set(21.0, 2.25, sz);
      frame.rotation.y = rot === 0 ? 0 : Math.PI;
      statics.add(frame);
      meshBox(2.1, 0.08, 0.08, mats.rust, 21.0, 2.56, sz, 0, { uv: 0.6, cast: false });
      for (const px of [20.22, 22.18]) meshBox(0.1, 2.35, 0.1, mats.wood, px, 1.17, sz, 0, { uv: 0.6, cast: false });
    }
    // crates at the hall edges (outside the deck)
    crate(23.0, -14.55, 0.75, 1.1);
    crate(23.7, -15.2, 0.7, 0.7);
    // floor grime / paper
    for (let i = 0; i < 5; i++) {
      const pp = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.16, 0.3), rr(0.2, 0.36)), mats.paper);
      pp.rotation.set(-Math.PI / 2, 0, rr(0, 6));
      pp.position.set(rr(18.0, 23.6), 0.075, rr(-13.8, -7.4));
      statics.add(pp);
    }

    // ---------- ramp: yard ground -> market roof (no stairs)
    const ang = Math.atan2(RAMP.rise, RAMP.z1 - RAMP.z0);
    const rlen = Math.hypot(RAMP.rise, RAMP.z1 - RAMP.z0);
    meshBox(1.3, 0.14, rlen, mats.metal, (RAMP.x0 + RAMP.x1) / 2, 1.6 - 0.07 * Math.cos(ang), (RAMP.z0 + RAMP.z1) / 2, 0, { rx: -ang, uv: 1.0 });
    for (let k = 0; k < 11; k++) {
      const z = RAMP.z0 + 0.6 + k * 0.8;
      const h = RAMP.rise * (z - RAMP.z0) / (RAMP.z1 - RAMP.z0);
      meshBox(1.16, 0.035, 0.07, mats.rust, (RAMP.x0 + RAMP.x1) / 2, h + 0.02, z, 0, { uv: 0.5, cast: false, rx: -ang });
    }
    // side rails (visual only)
    for (const rx of [RAMP.x0 - 0.03, RAMP.x1 + 0.03]) {
      meshBox(0.05, 0.05, rlen, mats.rust, rx, 1.6 + 0.95, (RAMP.z0 + RAMP.z1) / 2, 0, { rx: -ang, uv: 0.5, cast: false });
      for (let k = 0; k < 6; k++) {
        const z = RAMP.z0 + 0.5 + k * 1.55;
        const h = RAMP.rise * (z - RAMP.z0) / (RAMP.z1 - RAMP.z0);
        meshBox(0.05, 0.95, 0.05, mats.rust, rx, h + 0.48, z, 0, { uv: 0.4, cast: false });
      }
    }
    for (let k = 0; k < 4; k++) {
      const z = RAMP.z0 + 1.2 + k * 2.0;
      const h = RAMP.rise * (z - RAMP.z0) / (RAMP.z1 - RAMP.z0);
      meshBox(0.08, h, 0.08, mats.metal, RAMP.x1 - 0.1, h / 2, z, 0, { uv: 0.5, cast: false });
    }
    // roof-access sign at the ramp base
    meshBox(0.08, 2.1, 0.08, mats.wood, 24.2, 1.05, -15.1, 0, { uv: 0.5, cast: false });
    const rs = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.62), mats.signC);
    rs.position.set(24.2, 1.85, -15.06);
    statics.add(rs);

    // ---------- ramp top landing + catwalk to the apartment edge
    meshBox(2.7, 0.16, 0.85, mats.metal, 24.65, 3.12, -8.25, 0, { uv: 1.0 });
    // guard rail at the landing's north edge: a player walking straight up stops on the roof
    meshBox(2.7, 0.9, 0.06, mats.rust, 24.65, 3.65, -7.92, 0, { uv: 0.5, cast: false });
    for (let k = 0; k < 6; k++) meshBox(0.04, 0.85, 0.04, mats.rust, 23.4 + k * 0.5, 3.62, -7.92, 0, { uv: 0.3, cast: false });
    addColliderRect(23.5, 26.0, -7.98, -7.88);
    // side rails (visual)
    for (const [w, d, x, z] of [[2.7, 0.05, 24.65, -8.63], [0.05, 0.85, 25.98, -8.25]]) {
      meshBox(w, 0.32, d, mats.metal, x, 3.36, z, 0, { uv: 0.8, cast: false });
    }
    meshBox(0.9, 0.16, 0.9, mats.metal, 21.0, 3.12, -7.15, 0, { uv: 1.0 }); // small link plate
    // grating catwalk: full length of the apartment's east side, z -14.5..-6.2
    meshBox(1.3, 0.1, 8.3, mats.metal, 18.05, 3.155, -10.35, 0, { uv: 0.9 });
    for (let i = 0; i < 15; i++) meshBox(1.2, 0.035, 0.06, mats.rust, 18.05, 3.205, -14.3 + i * 0.56, 0, { uv: 0.4, cast: false });
    // west railing (continuous, visual only)
    for (const [w, d, x, z] of [[1.3, 0.05, 18.05, -14.52], [1.3, 0.05, 18.05, -6.2]]) {
      meshBox(w, 0.9, d, mats.rust, x, 3.65, z, 0, { uv: 0.5, cast: false });
    }
    meshBox(0.05, 0.05, 8.3, mats.rust, 17.48, 3.65, -10.35, 0, { uv: 0.4, cast: false });
    for (let k = 0; k < 11; k++) meshBox(0.04, 0.85, 0.04, mats.rust, 17.48, 3.62, -14.3 + k * 0.8, 0, { uv: 0.3, cast: false });
    // east railing only where the deck does not join (south and north ends)
    for (const [za, zb] of [[-14.5, -13.5], [-7.8, -6.2]]) {
      const len = zb - za;
      meshBox(0.05, 0.9, len, mats.rust, 18.32, 3.65, (za + zb) / 2, 0, { uv: 0.5, cast: false });
      for (let k = 0; k <= Math.ceil(len / 0.7); k++) {
        meshBox(0.04, 0.85, 0.04, mats.rust, 18.32, 3.62, za + Math.min(len, k * 0.7), 0, { uv: 0.3, cast: false });
      }
    }
    // brackets back to the apartment wall (visual)
    for (const z of [-14.0, -12.0, -10.0, -8.0, -6.6]) meshBox(0.5, 0.08, 0.08, mats.rust, 17.22, 2.95, z, 0, { uv: 0.5, cast: false });
    // wall plate / landing strip at the north end (visual)
    meshBox(0.9, 0.1, 1.2, mats.metal, 17.35, 3.15, -6.5, 0, { uv: 0.6, cast: false });
    // roof-access ladder cage? no stairs; just a sign
    const rsign = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), mats.signB);
    rsign.position.set(17.4, 2.6, -11.5);
    rsign.rotation.y = Math.PI / 2;
    statics.add(rsign);

    // ---------- yard clutter (kept outside every roof/catwalk footprint)
    barrel(26.9, -9.4);
    barrel(26.7, -6.5, {});
    tireStack(22.4, -15.5, 2);
    pallet(26.0, -13.4, 0.8);
    crate(23.9, -15.4, 0.8, 0.9);
    for (let i = 0; i < 6; i++) {
      const bag = new THREE.Mesh(roundedGeo(rr(0.24, 0.4), rr(0.2, 0.34), rr(0.24, 0.42), 0.1, 0.6), i % 2 ? mats.burlap : mats.metal);
      bag.position.set(26.45 + rr(-0.55, 0.55), 0.14, -15.2 + rr(-0.6, 0.6));
      bag.rotation.set(rr(-0.2, 0.2), rr(0, 6), rr(-0.2, 0.2));
      bag.castShadow = true; bag.receiveShadow = true;
      statics.add(bag);
    }
    for (let i = 0; i < 3; i++) {
      const pp = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.3, 0.6), rr(0.4, 0.7)), mats.paper);
      pp.rotation.set(-Math.PI / 2.1, rr(0, 6), 0);
      pp.position.set(26.2 + rr(-0.6, 0.6), 0.07 + i * 0.03, -14.6 + rr(-0.8, 0.8));
      statics.add(pp);
    }
    // a small yard lamp on the apartment wall
    meshBox(0.3, 0.05, 0.05, mats.rust, 17.05, 3.55, -10.2, 0, { uv: 0.5, cast: false });
    meshBox(0.22, 0.13, 0.17, mats.metalTan, 17.2, 3.44, -10.2, 0, { uv: 0.6 });
    lightPool(17.45, -10.2, 1.5, 0.18);
  }


  /* =====================================================================
     SEASON 3 — map expansion: old souk (west), rail depot (north),
     container yard (east). Each district is built into its own group and
     merged separately at the end so its bounding volume stays local
     (frustum culling keeps the street render cost flat).
     ===================================================================== */
  const EXPANSION_GROUPS = {
    souk: new THREE.Group(),
    rail: new THREE.Group(),
    port: new THREE.Group(),
  };
  const EXPANSION_STAGES = {
    souk: { x: -96, z: 46, yaw: 0.6 },
    rail: { x: 0, z: -180, yaw: 0 },
    port: { x: 80, z: -80, yaw: -1.2 },
  };
  const EXPANSION_OBJECTIVES = {};
  const RAIL_PLATFORM = { x0: -30, x1: 30, z0: -152, z1: -144, y: 4.2 };
  const EXPANSION_DISTRICTS = [
    {
      id: 'old_souk', name: '老城集市', en: 'OLD SOUK',
      rect: { x0: -116, x1: -40, z0: -42, z1: 72 },
      stage: EXPANSION_STAGES.souk, objective: { x: -74, z: 12, r: 6 },
    },
    {
      id: 'rail_depot', name: '北站货场', en: 'RAIL DEPOT',
      rect: { x0: -38, x1: 42, z0: -194, z1: -106 },
      stage: EXPANSION_STAGES.rail, objective: { x: 4, z: -142, r: 7 },
    },
    {
      id: 'container_yard', name: '东港集装箱场', en: 'CONTAINER YARD',
      rect: { x0: 48, x1: 122, z0: -98, z1: 34 },
      stage: EXPANSION_STAGES.port, objective: { x: 98, z: -44, r: 6 },
    },
  ];

  function buildExpansion() {
    const S = EXPANSION_GROUPS.souk;
    const R = EXPANSION_GROUPS.rail;
    const P = EXPANSION_GROUPS.port;

    const B = (g, w, h, d, mat, x, y, z, rot = 0, o = {}) => meshBox(w, h, d, mat, x, y, z, rot, { ...o, group: g });
    const C = (g, rt, rb, h, seg, mat, x, y, z, o = {}) => meshCyl(rt, rb, h, seg, mat, x, y, z, { ...o, group: g });
    const GND = (g, w, d, mat, x, z, y = 0.006, uv = 3) => meshPlane(w, d, mat, x, y, z, { rx: -Math.PI / 2, uvScale: uv, recv: true, group: g });
    const WIN = (g, w, h, mat, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = false; m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const SIGN = (g, w, h, mat, x, y, z, ry) => WIN(g, w, h, mat, x, y, z, ry);

    /* base dirt under everything (2 tris; the old dirt plane only covered the street) */
    meshPlane(300, 360, mats.dirt, 3, -0.09, -34, { rx: -Math.PI / 2, uvScale: 6, recv: true, cast: false });

    /* ================================================================ SOUK */
    // ground + alley paving
    GND(S, 76, 114, mats.dirt, -78, 15, 0.004, 3.6);
    for (const [x0, x1, z0, z1] of [
      [-80, -72, -42, 72], [-104, -97, -42, 72], [-56.5, -49, -42, 72],
      [-116, -40, 16, 24], [-116, -40, -12, -5], [-116, -40, 46, 54],
      [-62, -40, -12, 32], [-104, -88, 40, 56],
    ]) {
      B(S, x1 - x0, 0.035, z1 - z0, mats.concreteDark, (x0 + x1) / 2, 0.018, (z0 + z1) / 2, 0, { uv: 4.0, cast: false });
    }
    // perimeter city wall
    for (const [x0, x1, z0, z1, h] of [
      [-116.6, -116, -42, 72, 9], [-116, -40, 72, 72.6, 9], [-116, -40, -42.6, -42, 9],
    ]) {
      B(S, x1 - x0, h, z1 - z0, mats.plasterB, (x0 + x1) / 2, h / 2, (z0 + z1) / 2, 0, { collide: true, uv: 3.0 });
      B(S, x1 - x0 + 0.2, 0.3, z1 - z0 + 0.2, mats.concrete, (x0 + x1) / 2, h + 0.15, (z0 + z1) / 2, 0, { uv: 2.0, cast: false });
    }
    // east wall with the two 6 m+ gates (z -8..2, z 18..30)
    for (const [za, zb] of [[-42, -8], [2, 18], [30, 72]]) {
      B(S, 0.6, 8.4, zb - za, mats.plasterB, -40, 4.2, (za + zb) / 2, 0, { collide: true, uv: 2.8 });
      B(S, 0.8, 0.28, zb - za + 0.2, mats.concrete, -40, 8.55, (za + zb) / 2, 0, { uv: 2.0, cast: false });
    }
    for (const [za, zb] of [[-8, 2], [18, 30]]) {
      for (const z of [za, zb]) B(S, 0.8, 8.4, 0.35, mats.plasterB, -40, 4.2, z, 0, { collide: true, uv: 2.0 });
      B(S, 0.9, 0.9, zb - za, mats.concreteDark, -40, 7.95, (za + zb) / 2, 0, { uv: 2.0, cast: false });
      B(S, 0.7, 0.16, zb - za, mats.concrete, -40, 0.08, (za + zb) / 2, 0, { uv: 1.6, cast: false });
      // gate arch/awning
      B(S, 2.4, 0.1, zb - za + 0.6, mats.awning, -41.2, 4.4, (za + zb) / 2, 0, { rz: 0.1, cast: false });
    }

    // shophouse blocks
    const blocks = [
      [-116, -104, -42, -12, 7.6, 0], [-97, -80, -42, -12, 8.4, 1], [-72, -62, -42, -12, 7.2, 2],
      [-116, -104, -5, 16, 6.9, 1], [-97, -80, -5, 16, 7.8, 2], [-72, -62, -5, 16, 8.1, 0],
      [-116, -104, 24, 40, 7.3, 2], [-88, -80, 24, 40, 6.7, 1], [-72, -62, 24, 32, 7.6, 0],
      [-116, -104, 56, 72, 7.1, 1], [-88, -80, 56, 72, 7.9, 2], [-72, -62, 32, 72, 7.4, 1],
      [-62, -40, -42, -12, 7.5, 0], [-62, -40, 32, 72, 7.7, 2],
    ];
    const wallMats = [mats.plasterA, mats.plasterB, mats.plasterC];
    function facadeX(g, x, z0, z1, dir, h, tone) {
      const len = z1 - z0, cz = (z0 + z1) / 2;
      const wm = wallMats[tone % 3];
      B(g, 0.12, 2.5, Math.min(len * 0.78, 7.2), mats.wood, x + dir * 0.06, 1.25, cz, 0, { uv: 1.3 });
      WIN(g, Math.min(len * 0.45, 3.0), 1.5, mats.windowLitDim, x + dir * 0.14, 1.4, cz - len * 0.08, dir * Math.PI / 2);
      {
        const ww = Math.min(len * 0.45, 3.0), zc = cz - len * 0.08;
        for (const oz of [-ww / 3, 0, ww / 3]) B(g, 0.06, 1.5, 0.06, mats.wood, x + dir * 0.19, 1.4, zc + oz, 0, { cast: false });
        for (const yy of [0.78, 1.36, 2.02]) B(g, 0.06, 0.06, ww, mats.wood, x + dir * 0.19, yy, zc, 0, { cast: false });
        for (const oz of [-ww / 2 - 0.06, ww / 2 + 0.06]) B(g, 0.09, 1.7, 0.09, mats.wood, x + dir * 0.17, 1.4, zc + oz, 0, { cast: false });
        B(g, ww, 0.42, 0.07, mats.wood, x + dir * 0.22, 0.86, zc, 0, { cast: false });
        B(g, ww, 0.2, 0.07, mats.wood, x + dir * 0.22, 2.06, zc, 0, { cast: false });
      }
      B(g, 0.1, 0.16, Math.min(len * 0.5, 3.4), mats.metalTan, x + dir * 0.12, 2.62, cz, 0, { uv: 0.8, cast: false });
      B(g, 1.15, 0.08, Math.min(len * 0.86, 8), mats.awning, x + dir * 0.62, 2.72, cz, 0, { rz: dir * 0.14, cast: false });
      B(g, 0.06, 0.26, Math.min(len * 0.86, 8), mats.burlap, x + dir * 1.16, 2.6, cz, 0, { uv: 0.8, cast: false });
      for (let k = 0; k < 3; k++) {
        const zz = z0 + len * (0.2 + k * 0.3);
        WIN(g, 0.85, 1.05, mats.windowGlass, x + dir * 0.16, h * 0.58, zz, dir * Math.PI / 2);
        B(g, 0.1, 1.2, 1.0, wm, x + dir * 0.07, h * 0.58, zz, 0, { uv: 0.9, cast: false });
        B(g, 0.1, 0.12, 1.2, mats.concrete, x + dir * 0.16, h * 0.58 - 0.62, zz, 0, { uv: 0.6, cast: false });
      }
      B(g, 0.9, 0.1, Math.min(len * 0.55, 5.2), mats.metalTan, x + dir * 0.42, h * 0.43, cz, 0, { cast: false });
      for (let k = 0; k < 4; k++) B(g, 0.04, 0.72, 0.04, mats.rust, x + dir * 0.84, h * 0.43 + 0.36, cz - 2 + k * 1.32, 0, { cast: false });
      B(g, 0.06, 0.06, Math.min(len * 0.55, 5.2), mats.rust, x + dir * 0.84, h * 0.43 + 0.74, cz, 0, { cast: false });
    }
    function facadeZ(g, z, x0, x1, dir, h, tone) {
      const len = x1 - x0, cx = (x0 + x1) / 2;
      const wm = wallMats[tone % 3];
      B(g, Math.min(len * 0.78, 7.2), 2.5, 0.12, mats.wood, cx, 1.25, z + dir * 0.06, 0, { uv: 1.3 });
      WIN(g, Math.min(len * 0.45, 3.0), 1.5, mats.windowLitDim, cx - len * 0.08, 1.4, z + dir * 0.14, dir > 0 ? 0 : Math.PI);
      {
        const ww = Math.min(len * 0.45, 3.0), xc = cx - len * 0.08;
        for (const ox of [-ww / 3, 0, ww / 3]) B(g, 0.06, 1.5, 0.06, mats.wood, xc + ox, 1.4, z + dir * 0.19, 0, { cast: false });
        for (const yy of [0.78, 1.36, 2.02]) B(g, ww, 0.06, 0.06, mats.wood, xc, yy, z + dir * 0.19, 0, { cast: false });
        for (const ox of [-ww / 2 - 0.06, ww / 2 + 0.06]) B(g, 0.09, 1.7, 0.09, mats.wood, xc + ox, 1.4, z + dir * 0.17, 0, { cast: false });
        B(g, ww, 0.42, 0.07, mats.wood, xc, 0.86, z + dir * 0.22, 0, { cast: false });
        B(g, ww, 0.2, 0.07, mats.wood, xc, 2.06, z + dir * 0.22, 0, { cast: false });
      }
      B(g, Math.min(len * 0.5, 3.4), 0.16, 0.1, mats.metalTan, cx, 2.62, z + dir * 0.12, 0, { uv: 0.8, cast: false });
      B(g, Math.min(len * 0.86, 8), 0.08, 1.15, mats.awning, cx, 2.72, z + dir * 0.62, 0, { rx: -dir * 0.14, cast: false });
      B(g, Math.min(len * 0.86, 8), 0.26, 0.06, mats.burlap, cx, 2.6, z + dir * 1.16, 0, { uv: 0.8, cast: false });
      for (let k = 0; k < 3; k++) {
        const xx = x0 + len * (0.2 + k * 0.3);
        WIN(g, 0.85, 1.05, mats.windowGlass, xx, h * 0.58, z + dir * 0.16, dir > 0 ? 0 : Math.PI);
        B(g, 1.0, 1.2, 0.1, wm, xx, h * 0.58, z + dir * 0.07, 0, { uv: 0.9, cast: false });
        B(g, 1.2, 0.12, 0.1, mats.concrete, xx, h * 0.58 - 0.62, z + dir * 0.16, 0, { uv: 0.6, cast: false });
      }
      B(g, Math.min(len * 0.55, 5.2), 0.1, 0.9, mats.metalTan, cx, h * 0.43, z + dir * 0.42, 0, { cast: false });
      for (let k = 0; k < 4; k++) B(g, 0.04, 0.72, 0.04, mats.rust, cx - 2 + k * 1.32, h * 0.43 + 0.36, z + dir * 0.84, 0, { cast: false });
      B(g, Math.min(len * 0.55, 5.2), 0.06, 0.06, mats.rust, cx, h * 0.43 + 0.74, z + dir * 0.84, 0, { cast: false });
    }
    for (const [x0, x1, z0, z1, h, tone] of blocks) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      B(S, x1 - x0, h, z1 - z0, wallMats[tone % 3], cx, h / 2, cz, 0, { collide: true, uv: 2.8 });
      B(S, x1 - x0 + 0.3, 0.36, z1 - z0 + 0.3, mats.concreteDark, cx, h + 0.18, cz, 0, { uv: 2.2, cast: false });
      facadeX(S, x1, z0, z1, 1, h, tone);
      facadeX(S, x0, z0, z1, -1, h, tone);
      facadeZ(S, z1, x0, x1, 1, h, tone);
      facadeZ(S, z0, x0, x1, -1, h, tone);
      // roof clutter
      B(S, 0.85, 0.7, 1.1, mats.metal, cx - (x1 - x0) * 0.22, h + 0.55, cz + (z1 - z0) * 0.2, 0.2, { uv: 1.2 });
      B(S, 1.2, 0.9, 1.2, mats.metalTan, cx + (x1 - x0) * 0.2, h + 0.65, cz - (z1 - z0) * 0.18, -0.3, { uv: 1.2 });
      C(S, 0.65, 0.7, 1.3, 10, mats.metal, cx + (x1 - x0) * 0.28, h + 1.05, cz + (z1 - z0) * 0.28);
      C(S, 0.03, 0.03, 2.6, 4, mats.rust, cx, h + 1.6, cz + (z1 - z0) * 0.1, { cast: false });
      B(S, 0.8, 0.9, 0.1, mats.metalTan, cx - (x1 - x0) * 0.18, h + 0.6, cz - (z1 - z0) * 0.2, 0, { uv: 0.8 });
    }

    // two enterable shops on the east plaza (x -58..-50)
    function soukShop(g, x0, x1, z0, z1, doorW = 2.2, wallH = 3.4, roofTrim = true, counter = true) {
      const h = wallH, t = 0.3, door = doorW, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      B(g, x1 - x0, 0.12, z1 - z0, mats.concrete, cx, 0.06, cz, 0, { uv: 1.6, cast: false });
      B(g, x1 - x0 + 0.4, 0.26, z1 - z0 + 0.4, mats.concreteDark, cx, h + 0.13, cz, 0, { uv: 1.6 });
      if (roofTrim) B(g, x1 - x0, 0.16, z1 - z0, mats.wood, cx, h + 0.34, cz, 0, { uv: 1.4, cast: false });
      // west / north / south walls are solid; east wall takes the door
      B(g, t, h, z1 - z0, wallMats[0], x0 + t / 2, h / 2, cz, 0, { collide: true, uv: 1.6 });
      B(g, x1 - x0, h, t, wallMats[2], cx, h / 2, z0 + t / 2, 0, { collide: true, uv: 1.6 });
      B(g, x1 - x0, h, t, wallMats[1], cx, h / 2, z1 - t / 2, 0, { collide: true, uv: 1.6 });
      const span = z1 - z0 - 2 * t;
      const gap = (span - door) / 2;
      B(g, t, h, gap, wallMats[1], x1 - t / 2, h / 2, z0 + t + gap / 2, 0, { collide: true, uv: 1.4 });
      B(g, t, h, gap, wallMats[1], x1 - t / 2, h / 2, z1 - t - gap / 2, 0, { collide: true, uv: 1.4 });
      B(g, t, h - 2.3, door, wallMats[1], x1 - t / 2, 2.3 + (h - 2.3) / 2, cz, 0, { uv: 1.2 });
      B(g, 0.5, 0.16, door + 0.5, mats.wood, x1 + 0.1, 2.32, cz, 0, { uv: 0.8, cast: false });
      B(g, 0.7, 0.05, door + 0.4, mats.metal, x1 + 0.35, 0.03, cz, 0, { uv: 0.6, cast: false });
      // interior: counter, shelf, lit bulb
      if (counter) B(g, 0.8, 1.0, 2.4, mats.wood, x0 + 1.0, 0.62, cz, 0, { uv: 1.0, collide: true });
      B(g, 2.6, 0.08, 0.7, mats.wood, cx, 1.6, z0 + 1.1, 0, { uv: 0.8, cast: false });
      B(g, 0.9, 0.06, 0.5, mats.metalTan, cx + 0.6, 2.2, z0 + 1.0, 0, { uv: 0.6, cast: false });
      B(g, 0.5, 0.12, 0.5, mats.metalTan, cx, 2.7, cz, 0, { uv: 0.5, cast: false });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mats.windowLit);
      lamp.position.set(cx, 2.62, cz); g.add(lamp);
      B(g, 0.7, 0.5, 0.9, mats.wood, x1 - 1.4, 0.55, z0 + 1.4, 0.2, { uv: 0.8, collide: true });
      SIGN(g, 2.0, 0.45, mats.signC, x1 + 0.24, h + 0.55, cz, Math.PI / 2);
    }
    soukShop(S, -58, -50, -4, 3.4);
    soukShop(S, -58, -50, 4.6, 12);

    // courtyard: minaret, fountain, palms, arcade
    const minX = -110, minZ = 48;
    B(S, 4.2, 1.2, 4.2, mats.concreteDark, minX, 0.6, minZ, 0, { uv: 1.8, collide: true });
    B(S, 3.2, 16.5, 3.2, mats.plasterB, minX, 8.85, minZ, 0, { uv: 2.4, collide: true });
    B(S, 3.6, 0.3, 3.6, mats.concrete, minX, 17.3, minZ, 0, { uv: 1.6, cast: false });
    B(S, 1.5, 2.6, 1.5, mats.plasterB, minX, 18.7, minZ, 0, { uv: 1.4 });
    C(S, 0.1, 1.3, 1.6, 10, mats.metalTan, minX, 20.4, minZ);
    C(S, 0.06, 0.06, 1.4, 5, mats.rust, minX, 21.4, minZ, { cast: false });
    WIN(S, 0.8, 1.4, mats.windowLitDim, minX + 1.42, 8.4, minZ, Math.PI / 2);
    WIN(S, 1.0, 0.5, mats.windowLitDim, minX, 16.2, minZ + 1.62, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      B(S, 0.22, 0.5, 0.22, mats.plasterC, minX + Math.cos(a) * 1.7, 17.7, minZ + Math.sin(a) * 1.7, 0, { uv: 0.6, cast: false });
    }
    // fountain
    C(S, 2.6, 2.8, 0.7, 14, mats.concrete, -95, 0.35, 52.5);
    C(S, 2.1, 2.1, 0.08, 14, mats.puddle, -95, 0.55, 52.5, { cast: false });
    C(S, 0.4, 0.55, 1.5, 8, mats.plasterC, -95, 1.1, 52.5);
    addCollider(-95, 52.5, 5.0, 5.0, 0.1);
    // arcade along the courtyard's east side
    for (let i = 0; i < 4; i++) {
      const zz = 41 + i * 4.0;
      B(S, 0.7, 4.2, 0.7, mats.plasterB, -88, 2.1, zz, 0, { uv: 1.2, collide: true });
      B(S, 0.5, 0.9, 3.4, mats.plasterC, -88, 4.4, zz + 1.7, 0, { uv: 1.2 });
    }
    // palms
    function soukPalm(g, x, z, s = 1) {
      C(g, 0.14 * s, 0.2 * s, 4.6 * s, 6, mats.wood, x, 2.3 * s, z);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.3;
        const fr = new THREE.Mesh(new THREE.PlaneGeometry(0.55 * s, 2.6 * s), mats.frond);
        fr.position.set(x + Math.cos(a) * 0.7 * s, 4.5 * s, z + Math.sin(a) * 0.7 * s);
        fr.rotation.set(-0.5, a, 0.25);
        fr.castShadow = true; g.add(fr);
      }
    }
    soukPalm(S, -101, 44, 1.05);
    soukPalm(S, -90, 53, 0.95);
    soukPalm(S, -108, 44, 1.0);
    soukPalm(S, -93, 42, 0.9);

    // market stalls in the plaza / alleys
    function stall(g, x, z, rot = 0) {
      B(g, 2.4, 0.9, 1.3, mats.wood, x, 0.45, z, rot, { uv: 1.0, collide: true });
      B(g, 2.5, 0.08, 1.45, mats.metalTan, x, 0.94, z, rot, { uv: 0.8, cast: false });
      for (const dx of [-1.05, 1.05]) {
        C(g, 0.04, 0.04, 2.4, 5, mats.metal, x + dx * Math.cos(rot), 2.05, z - dx * Math.sin(rot), { cast: false });
      }
      B(g, 2.9, 0.06, 1.7, mats.awning, x, 2.6, z, rot, { rz: 0.06, cast: false });
      B(g, 0.35, 0.28, 0.35, mats.burlap, x - 0.5, 1.1, z, rot, { uv: 0.5, cast: false });
      B(g, 0.3, 0.24, 0.3, mats.polymerTan, x + 0.45, 1.08, z + 0.15, rot, { uv: 0.5, cast: false });
    }
    stall(S, -76, 0.5, 0.1);
    stall(S, -76, 20, -0.05);
    stall(S, -54, 14, 0.4);
    stall(S, -45, -9.5, 0);
    stall(S, -100, 28, 0.2);
    stall(S, -68, 48, -0.3);
    // crates / barrels (plain, no helpers that write to statics)
    for (const [x, z, s] of [[-73, 8, 0.9], [-52, -2, 0.8], [-99, 33, 1.0], [-45, 24, 0.85], [-64, 40, 0.9]]) {
      B(S, s, s, s, mats.wood, x, s / 2, z, 0.2, { uv: 0.8, collide: true });
      B(S, s * 0.9, 0.08, s * 0.9, mats.wood, x, s + 0.02, z, 0.2, { cast: false });
    }
    for (const [x, z] of [[-77, -10], [-98, 18], [-44, 6], [-70, 34]]) {
      C(S, 0.34, 0.34, 0.95, 10, mats.rust, x, 0.48, z);
      addCollider(x, z, 0.75, 0.75, 0.04);
    }

    // souk spawns/covers
    spawnPoints.push(
      { x: -96, z: 46 }, { x: -74, z: 10 }, { x: -46, z: -2 }, { x: -110, z: 20 },
      { x: -90, z: 20 }, { x: -76, z: 52 },
    );
    coverPoints.push(
      { x: -74.6, z: 0.5, h: false }, { x: -52.6, z: 14, h: false }, { x: -95, z: 46, h: true },
      { x: -53, z: 6, h: true }, { x: -84, z: 20, h: false }, { x: -43.6, z: -9.5, h: false },
    );
    EXPANSION_OBJECTIVES.old_souk = { x: -74, z: 12, r: 6 };

    /* ============================================================== RAIL */
    GND(R, 82, 90, mats.asphalt, 2, -150, 0.004, 3.2);
    // tracks (ballast + rails + sleepers)
    for (const tz of [-168, -160]) {
      B(R, 80, 0.12, 4.0, mats.concreteDark, 2, 0.03, tz, 0, { uv: 3.0, cast: false });
      for (const off of [-0.72, 0.72]) B(R, 80, 0.14, 0.12, mats.metal, 2, 0.12, tz + off, 0, { uv: 1.0, cast: false });
      for (let x = -36; x <= 40; x += 0.9) B(R, 2.5, 0.08, 0.22, mats.wood, x, 0.08, tz, 0, { uv: 0.6, cast: false });
    }
    // two flatcars / wagons as cover
    for (const [x, z, rot] of [[-18, -168, 0], [16, -160, 0]]) {
      B(R, 11.5, 1.1, 2.7, mats.metal, x, 0.95, z, rot, { uv: 1.6, collide: true });
      B(R, 11.8, 0.18, 2.9, mats.rust, x, 1.55, z, rot, { uv: 1.2, cast: false });
      for (const dx of [-4.2, 4.2]) for (const dz of [-0.9, 0.9]) {
        C(R, 0.32, 0.32, 0.24, 10, mats.rubber, x + dx, 0.34, z + dz, { rz: Math.PI / 2 });
      }
    }
    // warehouse 20 x 28 with two 6 m doors
    const wx0 = -26, wx1 = -6, wz0 = -190, wz1 = -162, wh = 8.5;
    B(R, wx1 - wx0, 0.14, wz1 - wz0, mats.concrete, (wx0 + wx1) / 2, 0.07, (wz0 + wz1) / 2, 0, { uv: 2.4, cast: false });
    B(R, wx1 - wx0, wh, 0.35, mats.plasterB, (wx0 + wx1) / 2, wh / 2, wz0, 0, { collide: true, uv: 2.8 });
    B(R, wx1 - wx0, wh, 0.35, mats.plasterB, (wx0 + wx1) / 2, wh / 2, wz1, 0, { collide: true, uv: 2.8 });
    B(R, 0.35, wh, wz1 - wz0, mats.plasterB, wx0, wh / 2, (wz0 + wz1) / 2, 0, { collide: true, uv: 2.8 });
    // east wall with a 6 m door z -182..-176
    for (const [za, zb] of [[wz0, -182], [-176, wz1]]) B(R, 0.35, wh, zb - za, mats.plasterB, wx1, wh / 2, (za + zb) / 2, 0, { collide: true, uv: 2.4 });
    B(R, 0.35, wh - 4.6, 6, mats.plasterB, wx1, 4.6 + (wh - 4.6) / 2, -179, 0, { uv: 1.8 });
    for (const z of [-182, -176]) B(R, 0.5, 4.6, 0.4, mats.metalTan, wx1, 2.3, z, 0, { uv: 1.0 });
    B(R, wx1 - wx0 + 0.4, 0.3, wz1 - wz0 + 0.4, mats.concreteDark, (wx0 + wx1) / 2, wh + 0.15, (wz0 + wz1) / 2, 0, { uv: 2.4, cast: false });
    // interior racks + crates
    for (const [x, z, w, d, h] of [[-24, -186, 2.2, 1.0, 4.0], [-24, -180, 2.2, 1.0, 4.0], [-24, -174, 2.2, 1.0, 4.0],
      [-13, -186, 1.0, 2.2, 3.4], [-8.5, -168, 1.4, 3.0, 2.2]]) {
      B(R, w, h, d, mats.metal, x, h / 2, z, 0, { uv: 1.2, collide: true });
    }
    for (const [x, z, s] of [[-20, -170, 1.1], [-18, -168.5, 0.8], [-10, -178, 1.0], [-14, -182, 0.9], [-9.5, -172, 0.75]]) {
      B(R, s, s, s, mats.wood, x, s / 2, z, 0.3, { uv: 0.8, collide: true });
    }
    for (const [x, z] of [[-22, -176], [-8, -166], [-15, -186], [-11, -184]]) {
      WIN(R, 1.3, 0.3, mats.windowLitDim, x, 7.7, z, 0);
      C(R, 0.02, 0.02, 0.5, 4, mats.rubber, x, 7.9, z, { cast: false });
    }
    // interior light strips (emissive)
    for (const z of [-184, -176, -168]) {
      B(R, 17, 0.06, 0.5, mats.windowLitDim, -16, 8.2, z, 0, { cast: false });
    }
    // rails outside: buffer stops
    for (const tz of [-168, -160]) {
      B(R, 0.4, 1.4, 3.6, mats.concreteDark, -37, 0.7, tz, 0, { uv: 1.2, collide: true });
      B(R, 0.3, 1.0, 1.0, mats.rust, -36.6, 0.9, tz, 0, { uv: 0.6 });
    }
    // elevated platform y=4.2
    B(R, 60, 0.26, 8, mats.concrete, 0, 4.07, -148, 0, { uv: 3.0 });
    B(R, 60, 0.12, 8, mats.metal, 0, 3.92, -148, 0, { uv: 2.0, cast: false });
    for (let x = -28; x <= 28; x += 8) {
      for (const z of [-151, -145]) {
        B(R, 0.5, 4.0, 0.5, mats.concreteDark, x, 2.0, z, 0, { uv: 1.0, collide: true });
      }
    }
    // canopy over the platform
    for (let x = -28; x <= 28; x += 8) for (const z of [-151, -145]) {
      B(R, 0.18, 3.2, 0.18, mats.metal, x, 5.8, z, 0, { uv: 0.8, cast: false });
    }
    B(R, 58, 0.22, 8, mats.metal, 0, 7.5, -148, 0, { uv: 2.6, cast: false });
    for (let x = -27; x <= 27; x += 6) B(R, 0.1, 0.1, 7.6, mats.rust, x, 7.3, -148, 0, { uv: 0.6, cast: false });
    // platform furniture
    for (const x of [-22, -4, 14, 26]) {
      B(R, 2.2, 0.5, 0.6, mats.wood, x, 4.55, -151, 0, { uv: 0.8, collide: true });
      B(R, 0.9, 0.9, 0.7, mats.metalTan, x + 1.6, 4.85, -145, 0, { uv: 0.8, collide: true });
      WIN(R, 1.1, 0.16, mats.windowLitDim, x, 7.35, -148, 0);
    }
    // platform edge railings (visual only)
    for (const z of [-152.0, -144.0]) {
      B(R, 60, 0.06, 0.06, mats.rust, 0, 5.1, z, 0, { uv: 0.6, cast: false });
      for (let x = -29; x <= 29; x += 2.4) B(R, 0.04, 0.9, 0.04, mats.rust, x, 4.65, z, 0, { cast: false });
    }
    // ramp 0 -> 4.2 (x 28..30, z -136..-144)
    const railAng = Math.atan2(4.2, 8);
    B(R, 2.0, 0.14, 8.12, mats.metal, 29, 2.1 - 0.06 * Math.cos(railAng), -140, 0, { rx: railAng, uv: 1.0 });
    for (let i = 0; i < 11; i++) {
      const t = i / 10, z = -136 - t * 8, h = 4.2 * t;
      B(R, 1.9, 0.04, 0.08, mats.rust, 29, h + 0.05, z, 0, { uv: 0.5, cast: false, rx: railAng });
    }
    for (const x of [28.0, 30.0]) {
      B(R, 0.06, 0.06, 8.1, mats.rust, x, 2.7, -140, 0, { rx: railAng, uv: 0.5, cast: false });
      for (let i = 0; i < 5; i++) {
        const t = i / 4, z = -136 - t * 8, h = 4.2 * t;
        B(R, 0.05, 1.0, 0.05, mats.rust, x, h + 0.55, z, 0, { cast: false });
      }
    }
    for (let i = 0; i < 4; i++) {
      const t = i / 3, z = -136.8 - t * 7.2, h = 4.2 * t;
      B(R, 0.1, h + 0.1, 0.1, mats.metal, 28.2, (h + 0.1) / 2, z, 0, { cast: false });
    }
    // containers north/east/west
    function railBox(x, z, stack, rot = 0) {
      for (let i = 0; i < stack; i++) {
        B(R, 6.0, 2.5, 2.4, i % 2 ? mats.metalTan : mats.metal, x, 1.27 + i * 2.55, z, rot, { uv: 1.4, collide: true });
        for (let k = 0; k < 4; k++) B(R, 5.8, 0.12, 0.08, mats.rust, x, 0.4 + k * 0.6, z + 1.22 * (rot ? 0 : 1), rot, { uv: 0.5, cast: false });
      }
    }
    for (const [x, z, s, r] of [[-34, -178, 2, 0], [-34, -172, 1, 0], [-34, -120, 2, 0], [-34, -114, 1, 0],
      [34, -186, 2, 0], [34, -180, 1, 0], [34, -124, 2, 0], [36, -118, 1, 0]]) railBox(x, z, s, r);
    // signal gantry + water tower
    for (const x of [36, 40]) B(R, 0.35, 9.5, 0.35, mats.metal, x, 4.75, -176, 0, { uv: 0.8, collide: true });
    B(R, 4.6, 0.3, 0.3, mats.metal, 38, 9.4, -176, 0, { uv: 1.0, cast: false });
    for (const x of [37, 39]) WIN(R, 0.5, 0.5, mats.windowLit, x, 8.9, -175.8, 0);
    C(R, 2.4, 2.6, 1.6, 12, mats.metal, 30, 7.2, -168);
    for (const [dx, dz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) B(R, 0.2, 7.2, 0.2, mats.rust, 30 + dx, 3.6, -168 + dz, 0, { cast: false });
    // yard props
    for (const [x, z] of [[16, -176], [20, -166], [-2, -166], [-2, -112], [22, -112], [-30, -130]]) {
      C(R, 0.35, 0.35, 1.0, 10, mats.rust, x, 0.5, z);
      addCollider(x, z, 0.8, 0.8, 0.04);
    }
    for (const [x, z] of [[10, -158], [26, -134], [-20, -158], [-2, -150]]) {
      B(R, 1.2, 1.0, 1.2, mats.wood, x, 0.5, z, 0.3, { uv: 0.8, collide: true });
    }
    // perimeter walls with the south gate 0..12
    for (const [xa, xb] of [[-38, 0], [12, 42]]) {
      B(R, xb - xa, 3.6, 0.5, mats.concreteDark, (xa + xb) / 2, 1.8, -106, 0, { collide: true, uv: 2.6 });
      B(R, xb - xa, 0.16, 0.7, mats.concrete, (xa + xb) / 2, 3.7, -106, 0, { uv: 2.0, cast: false });
    }
    B(R, 0.5, 3.6, 88, mats.concreteDark, -38, 1.8, -150, 0, { collide: true, uv: 2.6 });
    B(R, 0.5, 3.6, 88, mats.concreteDark, 42, 1.8, -150, 0, { collide: true, uv: 2.6 });
    B(R, 81, 3.6, 0.5, mats.concreteDark, 2, 1.8, -194, 0, { collide: true, uv: 2.6 });
    for (const x of [0, 12]) B(R, 0.35, 3.8, 0.35, mats.concreteDark, x, 1.9, -106, 0, { uv: 0.8, collide: true });
    B(R, 12.4, 0.8, 0.5, mats.concreteDark, 6, 3.5, -106, 0, { uv: 2.0, cast: false });
    // rail spawns/covers (ground + platform)
    spawnPoints.push(
      { x: 0, z: -180 }, { x: 28, z: -120 }, { x: -30, z: -112 }, { x: 4, z: -136 }, { x: -16, z: -176 },
    );
    coverPoints.push(
      { x: -22, z: -170, h: true }, { x: -10, z: -184, h: false }, { x: 12, z: -156, h: true },
      { x: 34, z: -130, h: false }, { x: -3.2, z: -166, h: false },
    );
    ROOF_ZONES.push({ ...RAIL_PLATFORM });
    ROOF_SPAWNS.push({ x: 24, z: -148, y: 4.2 }, { x: -24, z: -148, y: 4.2 });
    ROOF_COVERS.push({ x: 10, z: -148, y: 4.2, h: true }, { x: -8, z: -148, y: 4.2, h: false });
    spawnPoints.push({ x: 24, z: -148, y: 4.2 }, { x: -24, z: -148, y: 4.2 });
    coverPoints.push({ x: 10, z: -148, y: 4.2, h: true }, { x: -8, z: -148, y: 4.2, h: false });
    EXPANSION_OBJECTIVES.rail_depot = { x: 4, z: -142, r: 7 };

    /* ============================================================== PORT */
    GND(P, 68, 132, mats.asphalt, 84, -32, 0.004, 3.4);
    // quay + water
    // low quay curb + railing so the water edge reads (instead of a solid wall)
    // split at the dock gangway (z -14..-10)
    B(P, 0.6, 0.22, 84, mats.concreteDark, 116, 0.11, -56, 0, { uv: 2.4, collide: true });
    B(P, 0.6, 0.22, 44, mats.concreteDark, 116, 0.11, 12, 0, { uv: 2.4, collide: true });
    B(P, 0.8, 0.08, 84, mats.concrete, 116, 0.26, -56, 0, { uv: 1.8, cast: false });
    B(P, 0.8, 0.08, 44, mats.concrete, 116, 0.26, 12, 0, { uv: 1.8, cast: false });
    for (let z = -94; z <= 30; z += 3.0) { if (z > -14 && z < -10) continue; C(P, 0.035, 0.035, 1.05, 5, mats.rust, 116, 0.78, z, { cast: false }); }
    for (const [za, zb] of [[-94, -14], [-10, 30]]) {
      for (const yy of [0.55, 1.08, 1.35]) B(P, 0.05, 0.05, zb - za, mats.rust, 116, yy, (za + zb) / 2, 0, { uv: 0.8, cast: false });
    }
    for (let z = -94; z <= 30; z += 3) { if (z > -14 && z < -10) continue; C(P, 0.028, 0.028, 1.25, 5, mats.rust, 116.02, 0.7, z, { cast: false }); }
    for (const z of [-14, -10]) { B(P, 0.22, 1.5, 0.22, mats.metal, 116.0, 0.75, z, 0, { uv: 0.7, collide: true }); B(P, 0.7, 0.12, 0.7, mats.metalTan, 116.0, 1.52, z, 0, { cast: false }); }
    for (let z = -94; z <= 30; z += 6) {
      C(P, 0.18, 0.22, 0.9, 8, mats.rust, 114.6, 0.45, z);
      B(P, 0.7, 0.5, 0.7, mats.metal, 114.6, 0.25, z, 0, { uv: 0.8, collide: true });
    }
    // ship hull beyond the quay
    B(P, 12, 6.5, 44, mats.metal, 197, 1.4, -12, 0, { uv: 3.0 });
    B(P, 10, 3.2, 20, mats.plasterB, 197, 5.8, -12, 0, { uv: 2.4 });
    B(P, 3, 3, 3, mats.rust, 197, 7.5, -12, 0, { uv: 1.2 });
    for (let z = -24; z <= 16; z += 8) B(P, 0.3, 1.6, 0.3, mats.metal, 116.2, 5.2, z, 0, { cast: false });
    // perimeter
    B(P, 0.5, 3.4, 14, mats.concreteDark, 48, 1.7, -91, 0, { collide: true, uv: 2.6 });
    B(P, 0.5, 3.4, 110, mats.concreteDark, 48, 1.7, -21, 0, { collide: true, uv: 2.6 });
    for (const z of [-84, -76]) B(P, 0.35, 3.6, 0.35, mats.concreteDark, 48, 1.8, z, 0, { uv: 0.8, collide: true });
    B(P, 0.5, 0.8, 8.4, mats.concreteDark, 48, 3.4, -80, 0, { uv: 2.0, cast: false });
    B(P, 68, 3.4, 0.5, mats.concreteDark, 82, 1.7, -98, 0, { collide: true, uv: 2.6 });
    B(P, 68, 3.4, 0.5, mats.concreteDark, 82, 1.7, 34, 0, { collide: true, uv: 2.6 });
    // container maze
    const PORT_PAL = [mats.metal, mats.metalTan, mats.rust, mats.shop, mats.polymerTan];
    function portBox(x, z, stack, rot = 0) {
      const ci = Math.abs(Math.round(x * 0.17 + z * 0.11));
      for (let i = 0; i < stack; i++) {
        const m = PORT_PAL[(ci + i) % PORT_PAL.length];
        B(P, 12.0, 2.6, 2.6, m, x, 1.32 + i * 2.65, z, rot, { uv: 1.8, collide: true });
        // corrugated long faces
        for (let k = 0; k < 8; k++) {
          const off = -5.2 + k * 1.48;
          B(P, 0.08, 2.32, 0.06, mats.rust, x + (rot ? 1.32 : off), 1.32 + i * 2.65, z + (rot ? off : 1.32), 0, { uv: 0.4, cast: false });
          B(P, 0.08, 2.32, 0.06, mats.rust, x + (rot ? -1.32 : off), 1.32 + i * 2.65, z + (rot ? off : -1.32), 0, { uv: 0.4, cast: false });
        }
        // door end: four locking bars + corner castings
        for (let k = 0; k < 4; k++) B(P, 0.06, 2.2, 0.05, mats.rust, x + (rot ? 0 : 5.98), 1.3 + i * 2.65, z + (rot ? 5.98 : -0.9 + k * 0.6), 0, { uv: 0.4, cast: false });
        for (const dx of [-5.9, 5.9]) for (const dz of [-1.2, 1.2]) B(P, 0.16, 0.16, 0.16, mats.metalTan, x + dx, 0.16 + i * 2.65, z + dz, 0, { cast: false });
      }
    }
    const rows = [-70, -56, -42, -28, -14];
    const rowXs = [58, 72, 86, 100];
    for (let ri = 0; ri < rows.length; ri++) {
      for (let xi = 0; xi < rowXs.length; xi++) {
        const x = rowXs[xi], z = rows[ri];
        if (ri === 0 && z === -70 && (x === 72 || x === 86)) continue;   // stage lane
        if (ri === 2 && x === 100) continue;                           // objective gap
        portBox(x, z, (ri + xi) % 3 === 0 ? 2 : 1);
      }
    }
    // 20ft feeder boxes
    for (const [x, z] of [[64, -84], [92, -84], [54, -20], [110, 2], [62, 18]]) {
      B(P, 6.1, 2.4, 2.4, mats.metal, x, 1.2, z, 0, { uv: 1.6, collide: true });
    }
    // gantry crane
    for (const x of [92, 108]) for (const z of [-60, -36]) {
      B(P, 1.1, 21, 1.1, mats.metal, x, 10.5, z, 0, { uv: 2.0, collide: true });
      B(P, 2.2, 0.4, 2.2, mats.concreteDark, x, 0.2, z, 0, { uv: 1.2, cast: false });
    }
    B(P, 18, 1.1, 1.1, mats.metal, 100, 21, -60, 0, { uv: 1.6, cast: false });
    B(P, 18, 1.1, 1.1, mats.metal, 100, 21, -36, 0, { uv: 1.6, cast: false });
    B(P, 1.0, 1.0, 25, mats.rust, 100, 21.9, -48, 0, { uv: 2.0, cast: false });
    B(P, 2.4, 1.8, 3.2, mats.metalTan, 100, 20.3, -48, 0, { uv: 1.0 });
    for (let i = 0; i < 5; i++) B(P, 0.08, 4.5, 0.08, mats.rust, 99.4 + i * 0.3, 18.5, -48, 0, { cast: false });
    B(P, 6.1, 2.6, 2.6, mats.metal, 100, 15.4, -48, 0, { uv: 1.4 });
    // warehouse 24 x 20, two south doors
    const px0 = 60, px1 = 84, pz0 = 8, pz1 = 28, ph = 9;
    B(P, px1 - px0, 0.14, pz1 - pz0, mats.concrete, (px0 + px1) / 2, 0.07, (pz0 + pz1) / 2, 0, { uv: 2.6, cast: false });
    B(P, px1 - px0, ph, 0.35, mats.plasterB, (px0 + px1) / 2, ph / 2, pz1, 0, { collide: true, uv: 3.0 });
    B(P, 0.35, ph, pz1 - pz0, mats.plasterB, px0, ph / 2, (pz0 + pz1) / 2, 0, { collide: true, uv: 2.8 });
    B(P, 0.35, ph, pz1 - pz0, mats.plasterB, px1, ph / 2, (pz0 + pz1) / 2, 0, { collide: true, uv: 2.8 });
    B(P, px1 - px0 + 0.5, 0.3, pz1 - pz0 + 0.5, mats.concreteDark, (px0 + px1) / 2, ph + 0.15, (pz0 + pz1) / 2, 0, { uv: 2.4, cast: false });
    // south doors: two 5 m openings (wall built as segments)
    for (const [xa, xb] of [[60, 64], [70, 74], [80, 84]]) B(P, xb - xa, ph, 0.4, mats.plasterB, (xa + xb) / 2, ph / 2, pz0, 0, { collide: true, uv: 2.0 });
    for (const [xa, xb] of [[64, 70], [74, 80]]) {
      B(P, xb - xa, ph - 4.4, 0.4, mats.plasterB, (xa + xb) / 2, 4.4 + (ph - 4.4) / 2, pz0, 0, { uv: 1.6 });
      for (const x of [xa, xb]) B(P, 0.4, 4.4, 0.5, mats.metalTan, x, 2.2, pz0, 0, { uv: 1.0, collide: true });
    }
    for (const [x, z] of [[63, 12], [73, 12]]) B(P, 0.8, 0.3, 0.8, mats.concreteDark, x, 4.2, z, 0, { uv: 1.0 });
    // interior racks
    for (let i = 0; i < 4; i++) {
      B(P, 2.0, 4.2, 14, mats.metal, 64 + i * 5.2, 2.1, 20, 0, { uv: 2.0, collide: true });
      B(P, 2.4, 0.2, 14.4, mats.rust, 64 + i * 5.2, 4.3, 20, 0, { uv: 1.6, cast: false });
    }
    for (const [x, z] of [[62, 25], [78, 25], [82, 12], [60.5, 10]]) B(P, 1.0, 0.9, 1.0, mats.wood, x, 0.45, z, 0.2, { uv: 0.8, collide: true });
    for (const z of [12, 18, 24]) B(P, 22, 0.06, 0.5, mats.windowLitDim, 72, 8.6, z, 0, { cast: false });
    // port spawns/covers
    spawnPoints.push(
      { x: 80, z: -80 }, { x: 60, z: -88 }, { x: 108, z: 24 }, { x: 72, z: 18 }, { x: 54, z: -60 },
    );
    coverPoints.push(
      { x: 70, z: -40, h: true }, { x: 93, z: -28, h: true }, { x: 104, z: -58, h: false },
      { x: 78, z: 22, h: true }, { x: 58, z: -16, h: false },
    );
    EXPANSION_OBJECTIVES.container_yard = { x: 98, z: -44, r: 6 };
    EXPANSION_OBJECTIVES.dock = { x: 150, z: -12, r: 6 };
    EXPANSION_OBJECTIVES.foothills = { x: -190, z: 24, r: 6 };

    /* ========================================================= connectors */
    // west: service street between the old map and the souk
    B(S, 18.2, 0.06, 44, mats.dirt, -31.1, 0.02, 11, 0, { uv: 3.0, cast: false });
    B(S, 16.0, 3.0, 0.5, mats.concreteDark, -30, 1.5, -10.5, 0, { collide: true, uv: 2.2 });
    B(S, 16.0, 3.0, 0.5, mats.concreteDark, -30, 1.5, 32.5, 0, { collide: true, uv: 2.2 });
    // north: gate corridor checkpoint -> rail
    B(R, 12, 0.06, 12, mats.asphalt, 6, 0.02, -102, 0, { uv: 2.4, cast: false });
    for (const x of [0, 12]) B(R, 0.4, 3.4, 12, mats.concreteDark, x, 1.7, -102, 0, { collide: true, uv: 2.2 });
    // east: dock -> port gate corridor
    B(P, 6, 0.06, 8, mats.asphalt, 47, 0.02, -80, 0, { uv: 2.0, cast: false });
    for (const z of [-84, -76]) B(P, 6, 3.4, 0.4, mats.concreteDark, 47, 1.7, z, 0, { collide: true, uv: 2.0 });

    /* =====================================================================
       ART PASS — dense props, signage and landmarks. Everything below is
       visual only (no colliders), so gate/stage/nav contracts stay intact.
       ===================================================================== */
    const rope = (g, x0, y0, z0, x1, y1, z1, r = 0.014, mat = mats.rubber) => {
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      const len = Math.hypot(dx, dy, dz) || 0.01;
      const m = meshCyl(r, r, len, 3, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, { group: g, cast: false });
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
      return m;
    };
    const lantern = (g, x, y, z, s = 1) => {
      B(g, 0.018, 0.42 * s, 0.018, mats.rubber, x, y + 0.21 * s, z, 0, { cast: false });
      B(g, 0.17 * s, 0.05 * s, 0.17 * s, mats.metalTan, x, y, z, 0, { uv: 0.4, cast: false });
      const bl = new THREE.Mesh(new THREE.SphereGeometry(0.1 * s, 8, 6), mats.windowLit);
      bl.position.set(x, y - 0.09 * s, z); g.add(bl);
      B(g, 0.12 * s, 0.05 * s, 0.12 * s, mats.metalTan, x, y - 0.2 * s, z, 0, { cast: false });
    };
    const cloth = (g, w, h, mat, x, y, z, ry = 0) => B(g, w, h, 0.015, mat, x, y, z, ry, { uv: 0.7, cast: false });
    const pot = (g, x, z, s = 0.5, mat = mats.polymerTan, y0 = 0) => {
      B(g, 0.5 * s, 0.06 * s, 0.5 * s, mat, x, y0 + 0.03 * s, z, 0, { cast: false });
      C(g, 0.16 * s, 0.25 * s, 0.52 * s, 10, mat, x, y0 + 0.26 * s, z);
      C(g, 0.21 * s, 0.21 * s, 0.06 * s, 10, mats.rust, x, y0 + 0.55 * s, z, { cast: false });
    };
    const sack = (g, x, z, s = 0.5, mat = mats.burlap, y0 = 0) => meshRound(0.52 * s, 0.34 * s, 0.44 * s, 0.08, mat, x, y0 + 0.18 * s, z, 0.2, { group: g, uv: 0.6 });
    const crateD = (g, x, z, s = 0.7, rot = 0.2) => {
      B(g, s, s, s, mats.wood, x, s / 2, z, rot, { uv: 0.9 });
      B(g, s * 0.92, 0.05, s * 0.92, mats.wood, x, s + 0.02, z, rot, { cast: false });
      B(g, s * 0.1, s + 0.02, s * 0.1, mats.wood, x - s * 0.45, s / 2, z, rot, { cast: false });
    };
    const signZ = (g, x, y, z, ry, w, h, mat) => {
      B(g, w + 0.14, h + 0.14, 0.05, mats.wood, x, y, z, ry, { uv: 0.8, cast: false });
      WIN(g, w, h, mat, x + Math.sin(ry) * 0.04, y, z + Math.cos(ry) * 0.04, ry);
    };
    const arch = (g, x, z, span, rot = 0, h = 3.4) => {
      for (const s of [-1, 1]) B(g, 0.6, h, 0.6, mats.plasterB, x + s * span / 2 * Math.cos(rot), h / 2, z - s * span / 2 * Math.sin(rot), rot, { uv: 1.2 });
      B(g, span + 0.9, 0.5, 0.65, mats.plasterC, x, h + 0.1, z, rot, { uv: 1.2 });
      for (const s of [-1, 1]) B(g, 0.8, 0.32, 0.68, mats.concrete, x + s * span / 2 * Math.cos(rot), h - 0.28, z - s * span / 2 * Math.sin(rot), rot, { cast: false });
      B(g, 0.45, 0.55, 0.66, mats.concrete, x, h + 0.55, z, rot, { uv: 0.8, cast: false });
    };
    const stallArt = (g, x, z, rot = 0, w = 3.4, d = 2.1) => {
      B(g, w, 0.88, d * 0.6, mats.wood, x, 0.44, z, rot, { uv: 1.0 });
      B(g, w + 0.2, 0.08, d * 0.72, mats.metalTan, x, 0.92, z, rot, { uv: 0.8, cast: false });
      for (const s of [-1, 1]) C(g, 0.04, 0.04, 2.5, 5, mats.metal, x + s * (w / 2 - 0.12) * Math.cos(rot), 1.25, z - s * (w / 2 - 0.12) * Math.sin(rot), { cast: false });
      const n = 7, sw = w / n;
      for (let i = 0; i < n; i++) {
        const off = -w / 2 + sw * (i + 0.5);
        B(g, sw + 0.015, 0.05, d * 0.9, i % 2 ? mats.awning : mats.shop, x + off * Math.cos(rot), 2.5, z - off * Math.sin(rot), rot, { rz: 0.1, cast: false });
      }
      B(g, w, 0.24, 0.05, mats.burlap, x + Math.sin(rot) * d * 0.45, 2.36, z + Math.cos(rot) * d * 0.45, rot, { cast: false });
      for (let i = 0; i < 3; i++) pot(g, x + (i - 1) * 0.72 * Math.cos(rot), z - (i - 1) * 0.72 * Math.sin(rot), 0.42, mats.polymerTan, 0.94);
      sack(g, x + 1.0 * Math.cos(rot), z - 1.0 * Math.sin(rot), 0.5, mats.burlap, 0.94);
      sack(g, x + 1.05 * Math.cos(rot), z - 1.05 * Math.sin(rot) + 0.35, 0.38, mats.sandbag, 0.94);
      pot(g, x - 1.2 * Math.cos(rot), z + 1.2 * Math.sin(rot), 0.32, mats.rust, 0.94);
      pot(g, x + 0.2 * Math.cos(rot), z - 0.2 * Math.sin(rot), 0.3, mats.rust, 0.94);
      sack(g, x - 0.6 * Math.cos(rot), z + 0.6 * Math.sin(rot) + 0.3, 0.36, mats.burlap, 0.94);
      crateD(g, x - 1.05 * Math.cos(rot), z + 1.05 * Math.sin(rot), 0.58, rot);
    };
    const rug = (g, x, z, w, d, mat, rot = 0) => {
      B(g, w, 0.02, d, mat, x, 0.025, z, rot, { cast: false });
      for (let i = 0; i < 3; i++) B(g, w * 0.18, 0.022, d, i % 2 ? mats.burlap : mat, x - w * 0.3 + i * w * 0.3, 0.027, z, rot, { cast: false });
    };

    /* ---------- souk: courtyard market ---------- */
    stallArt(S, -90.5, 43.5, 0.16);
    stallArt(S, -100.8, 44.0, -0.22);
    stallArt(S, -90.2, 53.6, 0.04);
    for (const [x, z, s] of [[-87.5, 41.5, 0.75], [-86.8, 42.2, 0.6], [-102.8, 46.0, 0.85], [-102.2, 45.2, 0.55]]) crateD(S, x, z, s, 0.3);
    for (const [x, z] of [[-88.6, 44.8], [-89.2, 45.5], [-101.4, 42.0], [-102.0, 42.6], [-91.2, 52.0]]) sack(S, x, z, 0.55);
    for (const [x, z, s] of [[-88.0, 46.5, 0.5], [-101.8, 43.3, 0.55], [-90.8, 54.5, 0.45]]) pot(S, x, z, s);
    rug(S, -96.5, 43.0, 3.6, 2.2, mats.awning, 0.1);
    rug(S, -99.2, 44.2, 2.8, 1.8, mats.burlap, 0.1);
    rug(S, -98.4, 45.6, 3.2, 2.0, mats.awning, 0.04);
    pot(S, -98.0, 43.2, 0.42);
    sack(S, -98.8, 43.0, 0.5);
    rug(S, -93.0, 52.0, 3.0, 2.0, mats.burlap, -0.2);
    // well at the courtyard's north-west corner
    C(S, 1.35, 1.5, 0.95, 14, mats.concrete, -100.5, 0.47, 47.2);
    C(S, 1.1, 1.1, 0.06, 14, mats.puddle, -100.5, 0.96, 47.2, { cast: false });
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      C(S, 0.06, 0.07, 2.2, 5, mats.wood, -100.5 + Math.cos(a) * 1.35, 1.1, 47.2 + Math.sin(a) * 1.35, { cast: false });
    }
    B(S, 3.2, 0.08, 2.2, mats.wood, -100.5, 2.2, 47.2, 0.1, { uv: 0.8, cast: false });
    rope(S, -101.0, 2.15, 47.2, -101.0, 1.1, 47.2, 0.02, mats.burlap);
    B(S, 0.32, 0.28, 0.32, mats.metal, -101.0, 1.0, 47.2, 0, { uv: 0.5, cast: false });
    // fountain canopy + buckets
    for (const a of [0.2, 2.3, 4.2]) {
      C(S, 0.05, 0.05, 2.4, 5, mats.wood, -95 + Math.cos(a) * 2.3, 2.0, 52.5 + Math.sin(a) * 2.3, { cast: false });
    }
    B(S, 4.4, 0.07, 4.4, mats.awning, -95, 3.25, 52.5, 0.15, { uv: 0.9, cast: false });
    B(S, 4.6, 0.2, 0.05, mats.burlap, -95, 3.12, 54.7, 0, { cast: false });
    // minaret landmark details (balcony, arched openings, dome, crescent, lamps)
    B(S, 4.4, 0.26, 4.4, mats.concrete, -110, 17.5, 48, 0, { uv: 1.4, cast: false });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      B(S, 0.18, 0.8, 0.18, mats.plasterC, -110 + Math.cos(a) * 1.9, 17.95, 48 + Math.sin(a) * 1.9, 0, { cast: false });
    }
    for (let i = 0; i < 4; i++) {
      const zz = 46.6 + (i % 2) * 2.6, xx = -111.4 + Math.floor(i / 2) * 2.8;
      WIN(S, 0.8, 1.6, mats.windowLitDim, xx, 13.0, zz, Math.PI / 2);
      WIN(S, 0.6, 1.1, mats.windowLitDim, -110, 9.4, 46.55 + (i % 2) * 2.9, 0);
    }
    // lower courses, door, windows on the courtyard (east) face
    for (const yy of [4.4, 8.1]) B(S, 3.5, 0.18, 3.5, mats.concrete, -110, yy, 48, 0, { uv: 1.6, cast: false });
    B(S, 1.9, 3.2, 0.06, mats.wood, -108.34, 1.7, 48, Math.PI / 2, { uv: 1.0, cast: false });
    WIN(S, 1.7, 3.0, mats.interior, -108.3, 1.65, 48, Math.PI / 2);
    for (const zz of [47.05, 48.95]) B(S, 0.12, 3.3, 0.18, mats.concrete, -108.28, 1.7, zz, 0, { cast: false });
    B(S, 2.1, 0.28, 0.22, mats.concrete, -108.28, 3.35, 48, Math.PI / 2, { uv: 0.8, cast: false });
    B(S, 0.7, 0.5, 0.16, mats.signC, -108.28, 3.9, 48, Math.PI / 2, { uv: 0.6, cast: false });
    WIN(S, 0.7, 1.1, mats.windowLitDim, -108.3, 6.2, 48, Math.PI / 2);
    WIN(S, 0.8, 1.3, mats.windowLitDim, -108.3, 10.4, 48, Math.PI / 2);
    for (const zz of [-0.22, 0.22]) B(S, 0.05, 1.3, 0.05, mats.wood, -108.26, 10.4, 48 + zz, 0, { cast: false });
    B(S, 1.0, 0.5, 0.1, mats.signB, -108.28, 5.0, 48, Math.PI / 2, { uv: 0.6, cast: false });
    for (const zz of [-0.2, 0.2]) B(S, 0.05, 1.1, 0.05, mats.wood, -108.26, 6.2, 48 + zz, 0, { cast: false });
    const mgl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), mats.windowLit);
    mgl.position.set(-108.15, 2.9, 49.8); S.add(mgl);
    C(S, 1.45, 1.95, 2.2, 12, mats.metalTan, -110, 18.9, 48);
    C(S, 0.2, 1.4, 0.9, 12, mats.metalTan, -110, 20.4, 48, { cast: false });
    const crescent = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.075, 5, 10, Math.PI * 1.25), mats.metalTan);
    crescent.position.set(-110, 21.3, 48); crescent.rotation.z = -Math.PI * 0.35;
    S.add(crescent);
    for (const a of [0.3, 2.2, 4.1, 5.9]) lantern(S, -110 + Math.cos(a) * 2.0, 17.9, 48 + Math.sin(a) * 2.0, 0.9);
    // laundry + lantern spans + overhead cables
    rope(S, -62, 3.3, 27, -41, 3.1, 26, 0.012, mats.burlap);
    for (let i = 0; i < 4; i++) cloth(S, 1.5, 1.3, i % 2 ? mats.burlap : mats.awning, -59 + i * 5.1, 2.7, 26.5 + (i % 2) * 0.3, Math.PI / 2 + 0.15);
    rope(S, -104, 3.6, 54, -88, 3.2, 44, 0.012);
    for (let i = 1; i <= 5; i++) lantern(S, -104 + i * 2.6, 3.35 - Math.sin(i / 6 * Math.PI) * 0.25, 54 - i * 1.7, 1.0);
    rope(S, -88, 3.4, 44, -80, 3.8, 20, 0.012);
    for (let i = 1; i <= 4; i++) lantern(S, -88 + i * 1.7, 3.45, 44 - i * 5.2, 0.9);
    rope(S, -72, 4.6, 40, -62, 4.4, 58, 0.012);
    rope(S, -80, 5.2, -2, -72, 5.0, 14, 0.012);
    // arches over the plaza / courtyard
    arch(S, -62, 24, 5.0, 0);
    arch(S, -62, -4, 5.0, 0);
    arch(S, -89.0, 32.0, 4.2, Math.PI / 2);
    WIN(S, 2.2, 2.6, mats.interior, -88.08, 1.4, 32.0, -Math.PI / 2);
    cloth(S, 4.2, 1.1, mats.awning, -89.15, 5.1, 32.0, -Math.PI / 2);
    // shop signs + plaza boards
    signZ(S, -49.85, 4.2, 8.3, Math.PI / 2, 2.4, 0.7, mats.signC);
    signZ(S, -49.85, 4.2, -0.3, Math.PI / 2, 2.4, 0.7, mats.signB);
    signZ(S, -40.2, 5.0, 16.0, -Math.PI / 2, 3.0, 0.9, mats.signA);
    signZ(S, -60.0, 4.0, 30.5, 0, 2.2, 0.6, mats.signB);
    B(S, 0.08, 3.6, 0.08, mats.wood, -60.0, 1.8, 30.5, 0, { cast: false });
    // wall trim / grime / posters on the courtyard-facing blocks
    const wallDecoZ = (x, z0, z1, dir) => {
      B(S, 0.16, 0.9, z1 - z0, mats.concreteDark, x, 0.45, (z0 + z1) / 2, 0, { uv: 1.8, cast: false });
      B(S, 0.02, 1.2, z1 - z0, mats.grime, x + dir * 0.02, 1.5, (z0 + z1) / 2, 0, { cast: false });
      for (let i = 0; i < 2; i++) {
        const zz = z0 + (z1 - z0) * (0.25 + i * 0.45);
        WIN(S, 0.75, 0.95, i ? mats.signC : mats.paper, x + dir * 0.03, 1.9, zz, dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        B(S, 0.05, 1.05, 0.85, mats.concrete, x + dir * 0.01, 1.9, zz, 0, { uv: 0.6, cast: false });
      }
    };
    wallDecoZ(-88.05, 26, 38, -1);
    wallDecoZ(-80.05, 26, 38, 1);
    wallDecoZ(-88.05, 58, 70, -1);
    wallDecoZ(-72.05, 34, 52, -1);
    wallDecoZ(-104.05, 26, 38, 1);
    const wallDecoX = (z, x0, x1, dir) => {
      B(S, x1 - x0, 0.9, 0.16, mats.concreteDark, (x0 + x1) / 2, 0.45, z + dir * 0.05, 0, { uv: 1.8, cast: false });
      B(S, x1 - x0, 1.2, 0.02, mats.grime, (x0 + x1) / 2, 1.5, z + dir * 0.08, 0, { cast: false });
      for (let i = 0; i < 2; i++) {
        const xx = x0 + (x1 - x0) * (0.3 + i * 0.4);
        WIN(S, 0.75, 0.95, i ? mats.signC : mats.paper, xx, 1.9, z + dir * 0.1, dir > 0 ? 0 : Math.PI);
        B(S, 0.85, 1.05, 0.04, mats.concrete, xx, 1.9, z + dir * 0.06, 0, { uv: 0.6, cast: false });
      }
    };
    wallDecoX(40, -116, -104, 1);
    wallDecoX(56, -116, -104, -1);
    arch(S, -110, 44, 4.0, 0);
    WIN(S, 2.2, 2.8, mats.interior, -110, 1.5, 44.1, Math.PI);
    wallDecoZ(-40.3, 2, 16, -1);
    // posters near the gates
    for (const [x, z, ry] of [[-39.7, 6, -Math.PI / 2], [-39.7, 12, -Math.PI / 2], [-39.7, 32, -Math.PI / 2], [-61.8, 22, Math.PI / 2]]) {
      WIN(S, 0.8, 1.1, mats.paper, x, 2.1, z, ry);
      WIN(S, 0.6, 0.8, mats.signC, x + 0.01, 3.4, z + 1.1, ry);
    }

    /* ---------- rail: rolling stock + yard clutter ---------- */
    const trainCar = (g, x, z, len, kind) => {
      const h = kind === 'loco' ? 3.4 : 3.0;
      B(g, len, h, 2.7, kind === 'loco' ? mats.rust : mats.metal, x, 0.75 + h / 2, z, 0, { uv: 1.8 });
      B(g, len + 0.3, 0.18, 2.9, mats.concreteDark, x, 0.75 + h + 0.09, z, 0, { cast: false });
      for (let i = 0; i < Math.floor(len / 1.7); i++) B(g, 0.09, h * 0.82, 2.76, mats.rust, x - len / 2 + 0.9 + i * 1.7, 0.75 + h / 2, z, 0, { cast: false });
      for (const dx of [-len / 2 + 1.8, len / 2 - 1.8]) for (const dz of [-0.95, 0.95]) {
        C(g, 0.4, 0.4, 0.3, 10, mats.rubber, x + dx, 0.42, z + dz, { rz: Math.PI / 2, cast: false });
      }
      if (kind !== 'loco') {
        for (const dz of [-1.36, 1.36]) {
          B(g, 3.2, 2.3, 0.06, mats.metalTan, x, 0.75 + h / 2, z + dz, 0, { uv: 1.0, cast: false });
          for (const dx of [-1.7, 1.7]) B(g, 0.09, 2.4, 0.08, mats.rust, x + dx, 0.75 + h / 2, z + dz, 0, { cast: false });
          WIN(g, 1.4, 0.3, mats.paper, x - 1.0, 0.75 + h * 0.8, z + dz + (dz > 0 ? 0.04 : -0.04), dz > 0 ? 0 : Math.PI);
          for (const dx of [-len / 2 + 0.35, len / 2 - 0.35]) for (let k = 0; k < 5; k++) {
            B(g, 0.4, 0.05, 0.05, mats.rust, x + dx, 0.85 + k * 0.5, z + 1.39, 0, { cast: false });
          }
        }
      }
      if (kind === 'loco') {
        B(g, 3.4, 2.0, 2.9, mats.rust, x + len / 2 - 2.0, 1.9 + 1.0, z, 0, { uv: 1.4 });
        WIN(g, 2.5, 0.8, mats.windowLitDim, x + len / 2 - 2.0, 3.2, z + 1.47, 0);
        WIN(g, 2.5, 0.8, mats.windowLitDim, x + len / 2 - 2.0, 3.2, z - 1.47, Math.PI);
        B(g, 0.5, 0.7, 0.5, mats.metal, x + len / 2 - 0.6, 6.2, z, 0, { uv: 0.6 });
        lantern(g, x + len / 2 - 0.6, 6.9, z, 1.1);
      }
      return h;
    };
    trainCar(R, -30, -160, 11.0, 'loco');
    trainCar(R, 28, -168, 12.0, 'box');
    trainCar(R, 34, -160, 7.0, 'box');
    trainCar(R, 12, -168, 12.0, 'box');
    trainCar(R, 24, -160, 11.0, 'loco');
    // container stacks in the yard
    const railStack = (g, x, z, stack, len = 6.0) => {
      for (let i = 0; i < stack; i++) {
        const m = i % 2 ? mats.metalTan : mats.metal;
        B(g, len, 2.5, 2.4, m, x, 1.28 + i * 2.55, z, 0, { uv: 1.6 });
        for (let k = 0; k < 4; k++) B(g, len - 0.2, 0.1, 0.07, mats.rust, x, 0.42 + k * 0.55, z + 1.22, 0, { cast: false });
        B(g, 0.1, 2.1, 0.1, mats.metal, x + len / 2 - 0.2, 1.3 + i * 2.55, z + 1.24, 0, { cast: false });
      }
    };
    railStack(R, -28, -174, 3);
    railStack(R, 26, -176, 2);
    railStack(R, 8, -186, 2);
    railStack(R, -20, -118, 2);
    // forklift near the warehouse
    B(R, 2.2, 1.3, 1.4, mats.metalTan, 10, 1.0, -176, 0.3, { uv: 1.2 });
    B(R, 1.1, 1.2, 1.3, mats.metal, 9.2, 2.2, -177, 0.3, { uv: 1.0 });
    B(R, 0.18, 3.2, 0.18, mats.metal, 11.0, 2.1, -174.8, 0, { cast: false });
    B(R, 0.18, 3.2, 0.18, mats.metal, 11.0, 2.1, -177.2, 0, { cast: false });
    B(R, 0.16, 0.16, 0.16, mats.metal, 11.0, 3.7, -176, 0, { cast: false });
    for (const dz of [-0.55, 0.55]) C(R, 0.36, 0.36, 0.26, 10, mats.rubber, 10.4, 0.4, -176 + dz, { rz: Math.PI / 2, cast: false });
    // pallets
    const palletArt = (g, x, z, n = 3) => {
      for (let i = 0; i < n; i++) {
        B(g, 1.2, 0.14, 1.0, mats.wood, x, 0.1 + i * 0.18, z, 0.2, { cast: false });
        B(g, 1.0, 0.05, 0.8, mats.wood, x, 0.19 + i * 0.18, z, 0.2, { cast: false });
      }
    };
    palletArt(R, -8, -174, 4);
    palletArt(R, 22, -122, 3);
    palletArt(R, 4, -118, 2);
    // signal masts
    for (const [x, z, red] of [[-14, -164, true], [16, -156, false], [30, -150, true]]) {
      C(R, 0.1, 0.12, 4.8, 6, mats.metal, x, 2.4, z, { cast: false });
      B(R, 1.0, 0.12, 0.12, mats.metal, x + 0.45, 4.4, z, 0, { cast: false });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), red ? mats.windowLit : mats.windowLitDim);
      lamp.position.set(x + 0.9, 4.4, z); R.add(lamp);
      B(R, 0.24, 0.3, 0.24, mats.metal, x + 0.9, 4.62, z, 0, { cast: false });
    }
    // platform shelter / benches / clock / safety line
    for (const x of [-24, -6, 12]) {
      B(R, 2.6, 0.12, 0.55, mats.wood, x, 4.78, -148.8, 0, { cast: false });
      B(R, 2.6, 0.55, 0.1, mats.wood, x, 5.1, -149.1, 0, { cast: false });
      for (const dx of [-1.1, 1.1]) B(R, 0.1, 0.5, 0.5, mats.metal, x + dx, 4.45, -148.8, 0, { cast: false });
    }
    // shelter (posts + roof + glass)
    for (const x of [-2, 6]) for (const z of [-150.5, -146.5]) B(R, 0.12, 3.1, 0.12, mats.metal, x, 5.75, z, 0, { cast: false });
    B(R, 9.0, 0.16, 4.8, mats.metal, 2, 7.35, -148.5, 0, { cast: false });
    for (const z of [-150.4, -146.6]) WIN(R, 8.6, 1.3, mats.windowGlass, 2, 5.6, z, z < -148 ? 0 : Math.PI);
    for (const x of [-2, 6]) WIN(R, 3.8, 1.3, mats.windowGlass, x, 5.6, -148.5, Math.PI / 2);
    signZ(R, 2, 7.6, -146.4, 0, 3.2, 0.6, mats.signB);
    // clock
    C(R, 0.42, 0.42, 0.16, 14, mats.metalTan, 20, 6.4, -148.5, { rx: Math.PI / 2 });
    WIN(R, 0.5, 0.5, mats.windowLit, 20, 6.4, -148.4, 0);
    B(R, 0.08, 3.4, 0.08, mats.metal, 20, 4.9, -148.5, 0, { cast: false });
    // yellow safety line
    B(R, 58, 0.02, 0.16, mats.paint, 0, 4.23, -144.5, 0, { cast: false });
    B(R, 58, 0.02, 0.1, mats.paint, 0, 4.23, -151.7, 0, { cast: false });
    // catenary poles + wires
    for (const x of [-36, -20, -4, 12, 28, 40]) {
      C(R, 0.08, 0.1, 8.5, 5, mats.metal, x, 4.25, -164, { cast: false });
      B(R, 2.2, 0.08, 0.08, mats.metal, x, 8.0, -164, 0, { cast: false });
    }
    for (let i = 0; i < 5; i++) {
      const xa = [-36, -20, -4, 12, 28][i], xb = xa + 16;
      rope(R, xa, 8.0, -164, xb, 8.0, -164, 0.012, mats.metal);
      rope(R, xa, 7.6, -164, xb, 7.6, -164, 0.01, mats.metal);
    }
    // warehouse graffiti / posters / loading dock
    for (const [z, y, w, h, mat] of [[-184, 2.4, 3.0, 1.6, mats.graffiti], [-172, 2.2, 5.0, 2.0, mats.graffiti], [-170, 2.2, 2.4, 1.4, mats.graffiti], [-166, 3.0, 1.8, 1.0, mats.signC], [-180, 5.8, 2.6, 0.8, mats.paper], [-174, 5.0, 2.0, 0.9, mats.signC]]) {
      WIN(R, w, h, mat, -5.82, y, z, Math.PI / 2);
    }
    B(R, 3.2, 0.12, 6.6, mats.metal, -4.6, 0.06, -179, 0, { uv: 1.2, cast: false });
    for (const z of [-182, -176]) B(R, 0.5, 0.45, 0.35, mats.rubber, -5.6, 0.4, z, 0, { cast: false });
    for (const [x, z] of [[-4.4, -183.4], [-4.2, -174.8]]) crateD(R, x, z, 0.7, 0.2);
    palletArt(R, -3.6, -177.2, 3);
    palletArt(R, 4.2, -176.0, 2);
    crateD(R, -6.0, -174.0, 0.75, 0.2);
    crateD(R, 2.0, -172.0, 0.6, 0.4);
    crateD(R, -2.0, -171.0, 0.8, 0.2);
    palletArt(R, 0.0, -173.5, 2);
    C(R, 0.1, 0.12, 4.6, 6, mats.metal, 3.0, 2.3, -166.0, { cast: false });
    B(R, 0.9, 0.12, 0.12, mats.metal, 3.4, 4.3, -166.0, 0, { cast: false });
    const sig = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), mats.windowLit);
    sig.position.set(3.85, 4.3, -166.0); R.add(sig);
    for (const [x, z] of [[2, -172.8], [6.2, -170.4]]) C(R, 0.34, 0.34, 0.95, 10, mats.rust, x, 0.48, z);
    signZ(R, 2, 7.7, -152.05, 0, 4.2, 0.75, mats.signA);
    for (const x of [-16, -4, 8, 20]) lantern(R, x, 5.0, -150.0, 1.0);
    // platform luggage cart
    B(R, 2.0, 0.35, 1.2, mats.metal, -12, 4.55, -147.5, 0, { uv: 1.0 });
    for (const dx of [-0.7, 0.7]) for (const dz of [-0.4, 0.4]) C(R, 0.16, 0.16, 0.12, 8, mats.rubber, -12 + dx, 4.3, -147.5 + dz, { cast: false });
    for (const dz of [-0.5, 0.5]) B(R, 0.06, 1.0, 0.06, mats.metal, -13, 5.0, -147.5 + dz, 0, { cast: false });

    /* ---------- port: multi-colour stacks, crane, barge, dock ---------- */
    const portStackArt = (g, x, z, stack, rot = 0) => {
      for (let i = 0; i < stack; i++) {
        const m = PORT_PAL[(Math.abs(Math.round(x)) + i) % PORT_PAL.length];
        B(g, 12.0, 2.6, 2.6, m, x, 1.32 + i * 2.65, z, rot, { uv: 1.8 });
        for (let k = 0; k < 6; k++) B(g, 0.07, 2.3, 0.05, mats.rust, x - 5.2 + k * 2.0, 1.32 + i * 2.65, z + 1.32, 0, { cast: false });
        for (let k = 0; k < 4; k++) B(g, 0.05, 2.2, 0.05, mats.rust, x + 5.98, 1.3 + i * 2.65, z - 0.9 + k * 0.6, 0, { cast: false });
        for (const dx of [-5.9, 5.9]) for (const dz of [-1.2, 1.2]) B(g, 0.15, 0.15, 0.15, mats.metalTan, x + dx, 0.15 + i * 2.65, z + dz, 0, { cast: false });
      }
    };
    portStackArt(P, 56, -88, 2);
    portStackArt(P, 104, -86, 2);
    portStackArt(P, 60, -44, 2);
    portStackArt(P, 110, -52, 1);
    portStackArt(P, 54, -16, 2);
    portStackArt(P, 108, 16, 1);
    // gantry crane lattice / cab / cables / lights
    for (const [x, z] of [[92, -60], [108, -60], [92, -36], [108, -36]]) {
      for (let i = 0; i < 4; i++) {
        const y = 2.5 + i * 5.2;
        B(P, 0.12, 5.4, 0.12, mats.rust, x + 0.5, y, z, 0, { rz: 0.12, cast: false });
        B(P, 0.12, 5.4, 0.12, mats.rust, x - 0.5, y, z, 0, { rz: -0.12, cast: false });
        B(P, 1.1, 0.1, 0.1, mats.metal, x, y + 2.4, z, 0, { cast: false });
      }
    }
    B(P, 4.0, 1.8, 3.0, mats.metalTan, 100, 19.0, -48, 0, { uv: 1.2 });
    WIN(P, 3.0, 0.9, mats.windowLitDim, 100, 19.2, -46.48, 0);
    for (const x of [97.5, 102.5]) rope(P, x, 20.0, -48, x + (x < 100 ? -1.5 : 1.5), 15.2, -48, 0.02, mats.rust);
    B(P, 7.0, 0.35, 0.35, mats.metal, 100, 14.8, -48, 0, { cast: false });
    for (const x of [96.8, 103.2]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), mats.windowLit);
      lamp.position.set(x, 22.0, -48); P.add(lamp);
    }
    // barge 1 (large) + barge 2 silhouette
    // barge 1 (north water)
    B(P, 11, 2.6, 38, mats.rust, 121.5, -0.1, -78, 0, { uv: 3.0 });
    B(P, 8, 1.6, 10, mats.metalTan, 124, 1.4, -92, 0, { uv: 2.0 });
    B(P, 5, 2.6, 6, mats.plasterB, 124, 2.4, -62, 0, { uv: 1.6 });
    WIN(P, 3.4, 0.8, mats.windowLitDim, 121.4, 2.8, -62, -Math.PI / 2);
    C(P, 0.1, 0.12, 9, 5, mats.metal, 124, 5.8, -88, { cast: false });
    for (const z of [-90, -84, -76, -70]) B(P, 8, 2.4, 2.2, PORT_PAL[Math.abs(z) % 5], 123, 2.5, z, 0, { uv: 1.4 });
    for (const z of [-94, -66]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), mats.windowLit);
      lamp.position.set(120, 2.2, z); P.add(lamp);
    }
    // barge 2 (south of the cargo ship)
    B(P, 9, 2.2, 24, mats.metal, 122, 0.2, -52, 0, { uv: 2.6 });
    B(P, 5, 2.2, 8, mats.plasterC, 123, 1.8, -46, 0, { uv: 1.4 });
    for (const z of [-58, -54]) B(P, 7, 2.2, 2.1, mats.metalTan, 122, 2.4, z, 0, { uv: 1.2 });
    // bollards + mooring ropes
    for (let z = -92; z <= 30; z += 9) {
      C(P, 0.22, 0.26, 0.9, 8, mats.rust, 115.0, 0.45, z);
      B(P, 0.5, 0.12, 0.5, mats.metal, 115.0, 0.9, z, 0, { cast: false });
    }
    for (const z of [-10, 2]) rope(P, 115.2, 0.8, z, 118.5, 1.0, z + 6, 0.03, mats.burlap);
    // oil drums / pallets / floodlights / fence
    for (const [x, z] of [[58, -20], [59, -21], [60, -20], [90, -16], [91, -15], [108, 4], [108, 5], [72, -66], [73, -66]]) {
      C(P, 0.34, 0.34, 0.95, 10, (x + z) % 2 ? mats.rust : mats.metalTan, x, 0.48, z);
      C(P, 0.35, 0.35, 0.05, 10, mats.metal, x, 0.9, z, { cast: false });
    }
    for (const [x, z] of [[70, -60], [84, -20], [100, -10], [58, 4], [104, 2]]) palletArt(P, x, z, 4);
    for (const [x, z] of [[60, -50], [90, -82], [110, 0], [70, 12]]) {
      C(P, 0.09, 0.12, 10.5, 6, mats.metal, x, 5.25, z, { cast: false });
      B(P, 1.6, 0.14, 0.14, mats.metal, x + 0.7, 10.3, z, 0, { cast: false });
      for (const dx of [0, 1.4]) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55), mats.windowLitDim);
        panel.position.set(x + dx, 10.05, z); panel.rotation.x = 0.25; P.add(panel);
      }
    }
    // security fence along the south edge
    for (let x = 48; x <= 116; x += 4) C(P, 0.04, 0.05, 2.4, 5, mats.metal, x, 1.2, -96.5, { cast: false });
    for (const yy of [0.5, 1.4, 2.2]) B(P, 68, 0.04, 0.04, mats.metal, 82, yy, -96.5, 0, { cast: false });
    for (let x = 48; x < 116; x += 8) {
      rope(P, x, 0.4, -96.5, x + 4, 2.2, -96.5, 0.008, mats.rust);
      rope(P, x + 4, 0.4, -96.5, x, 2.2, -96.5, 0.008, mats.rust);
    }
    // warehouse dock: plate, bumpers, trailer, crates, hazard stripes
    B(P, 24, 0.14, 1.6, mats.concreteDark, 72, 0.07, 6.9, 0, { uv: 2.0, cast: false });
    for (const x of [61, 67, 76, 82]) B(P, 0.5, 0.5, 0.35, mats.rubber, x, 0.35, 7.4, 0, { cast: false });
    B(P, 8.5, 2.6, 2.4, mats.metal, 88, 1.3, 3.0, 0, { uv: 1.6 });
    B(P, 3.0, 2.3, 2.5, mats.metalTan, 84, 1.15, 3.0, 0, { uv: 1.2 });
    for (const dx of [-3.0, 3.0]) for (const dz of [-0.9, 0.9]) C(P, 0.36, 0.36, 0.26, 10, mats.rubber, 88 + dx, 0.38, 3.0 + dz, { rz: Math.PI / 2, cast: false });
    for (const [x, z] of [[62, 3.2], [64, 3.0], [78, 3.4], [80, 3.1]]) crateD(P, x, z, 0.7, 0.2);
    for (let i = 0; i < 6; i++) B(P, 0.6, 0.02, 1.3, i % 2 ? mats.paint : mats.rust, 64 + i * 1.2, 0.14, 7.5, 0, { cast: false });
    // lane lines + bay numbers
    for (const z of [-76, -62, -48, -34, -20, -6]) B(P, 58, 0.02, 0.22, mats.paint, 82, 0.025, z, 0, { cast: false });
    for (const [x, z, n] of [[58, -70, 0], [72, -56, 1], [86, -42, 2], [100, -28, 3], [104, -14, 4]]) {
      WIN(P, 1.5, 1.5, mats.signA, x, 0.03, z, 0).rotation.x = -Math.PI / 2;
    }
    // stage-view extra colour near the port spawn
    portStackArt(P, 92, -90, 2);
    portStackArt(P, 66, -74, 1);
    portStackArt(P, 62, -64, 3);
    portStackArt(P, 104, -70, 2);
    portStackArt(P, 94, -58, 1);
    palletArt(P, 74, -76, 3);
    palletArt(P, 86, -72, 2);
    for (const [x, z] of [[84, -74], [85, -73], [73, -70]]) C(P, 0.34, 0.34, 0.95, 10, (x + z) % 2 ? mats.rust : mats.metalTan, x, 0.48, z);
    crateD(P, 80, -74, 0.7, 0.2);
    // ground bay numbers in the near lane
    for (const [x, z] of [[76, -76], [88, -76], [64, -68]]) WIN(P, 1.4, 1.4, mats.signA, x, 0.03, z, 0).rotation.x = -Math.PI / 2;
    B(P, 34, 0.02, 0.28, mats.paint, 83, 0.03, -78, 0, { cast: false });
    palletArt(P, 88, -76, 3);
    palletArt(P, 72, -76, 2);
    for (const [x, z] of [[70, -74], [90, -78], [91, -77]]) C(P, 0.34, 0.34, 0.95, 10, mats.rust, x, 0.48, z);
    // extra work light over the near lane
    C(P, 0.09, 0.12, 9.0, 6, mats.metal, 94, 4.5, -72, { cast: false });
    B(P, 1.4, 0.12, 0.12, mats.metal, 94.6, 8.8, -72, 0, { cast: false });
    B(P, 0.55, 0.14, 0.35, mats.windowLitDim, 95.2, 8.7, -72, 0, { cast: false });


    /* =====================================================================
       LIGHTING + WALL DRESS — blind-critic pass.
       The engine hemisphere is global, so the three districts get local
       point-light fills (distance-limited) instead of touching the street.
       ===================================================================== */
    const poolMat = new THREE.MeshBasicMaterial({
      map: mats.sprites.glow, color: 0xffb877, transparent: true, opacity: 0.34,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pool = (g, x, y, z, r) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), poolMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.renderOrder = 2;
      g.add(m);
      return m;
    };
    const addPoint = (x, y, z, color, intensity, dist, decay = 1.4) => {
      const l = new THREE.PointLight(color, intensity, dist, decay);
      l.position.set(x, y, z);
      dynamic.add(l);
      return l;
    };
    // rail: 3 platform work lights + 2 yard masts + broad cool fill
    for (const x of [-18, 0, 18]) {
      B(R, 1.1, 0.16, 0.5, mats.metal, x, 7.05, -148, 0, { uv: 0.8, cast: false });
      B(R, 0.9, 0.05, 0.35, mats.windowLitDim, x, 6.96, -148, 0, { cast: false });
      pool(R, x, 4.24, -148, 3.4);
      addPoint(x, 6.6, -148, 0xffb066, 12, 20, 1.4);
    }
    for (const [x, z] of [[-22, -156], [24, -130]]) {
      C(R, 0.08, 0.12, 7.6, 6, mats.metal, x, 3.8, z, { cast: false });
      B(R, 1.6, 0.1, 0.1, mats.metal, x + 0.6, 7.4, z, 0, { cast: false });
      B(R, 0.5, 0.12, 0.3, mats.windowLitDim, x + 1.25, 7.3, z, 0, { cast: false });
      pool(R, x + 1.25, 0.03, z, 4.2);
      addPoint(x + 1.25, 7.1, z, 0xffc27a, 16, 30, 1.3);
    }
    addPoint(0, 11, -165, 0x9fb6c8, 10, 48, 1.0);   // local hemi fill (rail)
    addPoint(-90, 10, 26, 0x9fb6c8, 9, 50, 1.0);    // local hemi fill (souk)
    addPoint(96, 10, -30, 0x9fb6c8, 10, 48, 1.0);   // local hemi fill (port)
    // warehouse window bands (rail east wall) + mullions
    for (const z of [-186, -176, -166]) {
      B(R, 0.08, 1.0, 6.0, mats.metal, -5.92, 6.4, z, 0, { uv: 0.8, cast: false });
      WIN(R, 5.4, 0.55, z === -176 ? mats.windowLit : mats.windowLitDim, -5.84, 6.4, z, Math.PI / 2);
      for (const dz of [-2.7, 0, 2.7]) B(R, 0.06, 0.55, 0.08, mats.metal, -5.8, 6.4, z + dz, 0, { cast: false });
    }
    // shopfront / floodlight ground pools
    for (const [x, z] of [[-49.5, 8.3], [-49.5, -0.3], [-40.8, 24], [-63.5, 30]]) pool(S, x, 0.03, z, 2.6);
    for (const [x, z] of [[60, -50], [90, -82], [110, 0], [70, 12]]) pool(P, x + 0.7, 0.03, z, 4.0);
    pool(P, 95.2, 0.03, -72, 4.2);
    addPoint(95.2, 8.4, -72, 0xffc27a, 14, 32, 1.3);

    /* ---------- wall dressing helpers ---------- */
    const acUnit = (g, x, y, z, ry = 0) => {
      B(g, 1.1, 0.7, 0.55, mats.metal, x, y, z, ry, { uv: 0.8 });
      B(g, 0.9, 0.06, 0.62, mats.concrete, x, y - 0.4, z, ry, { cast: false });
      WIN(g, 0.8, 0.42, mats.interior, x + Math.sin(ry) * 0.29, y, z + Math.cos(ry) * 0.29, ry);
      for (const s of [-0.4, 0.4]) B(g, 0.06, 0.4, 0.06, mats.rust, x + Math.cos(ry) * s, y - 0.55, z - Math.sin(ry) * s, 0, { cast: false });
    };
    const pipe = (g, x, z, h, y0 = 0.2) => {
      C(g, 0.06, 0.07, h, 6, mats.rust, x, y0 + h / 2, z);
      for (let i = 1; i < 4; i++) B(g, 0.18, 0.06, 0.18, mats.metal, x, y0 + h * i / 4, z, 0, { cast: false });
    };
    const winRecess = (g, x, y, z, ry, w = 1.3, h = 1.6, lit = false) => {
      B(g, w + 0.22, h + 0.22, 0.05, mats.concreteDark, x, y, z, ry, { cast: false });
      WIN(g, w, h, lit ? mats.windowLitDim : mats.interior, x + Math.sin(ry) * 0.04, y, z + Math.cos(ry) * 0.04, ry);
      for (const o of [-w / 3, 0, w / 3]) B(g, 0.05, h, 0.05, mats.wood, x + Math.sin(ry) * 0.07 + Math.cos(ry) * o, y, z + Math.cos(ry) * 0.07 - Math.sin(ry) * o, ry, { cast: false });
      for (const o of [-h / 3, 0, h / 3]) B(g, w, 0.05, 0.05, mats.wood, x + Math.sin(ry) * 0.07, y + o, z + Math.cos(ry) * 0.07, ry, { cast: false });
      B(g, w + 0.3, 0.1, 0.22, mats.concrete, x + Math.sin(ry) * 0.1, y - h / 2 - 0.1, z + Math.cos(ry) * 0.1, ry, { cast: false });
    };
    // souk courtyard + objective-alley walls
    acUnit(S, -88.45, 5.2, 30.0, -Math.PI / 2);
    pipe(S, -88.4, 36.5, 6.4);
    winRecess(S, -88.04, 3.2, 28.5, -Math.PI / 2, 1.2, 1.5, true);
    winRecess(S, -88.04, 3.2, 35.5, -Math.PI / 2, 1.0, 1.4, false);
    acUnit(S, -112.0, 5.0, 40.5, 0);
    pipe(S, -106.5, 40.4, 6.0);
    winRecess(S, -114.0, 3.2, 40.04, 0, 1.3, 1.5, false);
    winRecess(S, -108.5, 3.2, 40.04, 0, 1.2, 1.5, true);
    acUnit(S, -108.0, 5.2, 55.5, Math.PI);
    pipe(S, -105.5, 55.6, 6.2);
    winRecess(S, -112.0, 3.2, 55.96, Math.PI, 1.2, 1.5, true);
    winRecess(S, -79.96, 3.0, 2.0, Math.PI / 2, 1.3, 1.6, true);
    winRecess(S, -79.96, 3.0, 9.0, Math.PI / 2, 1.1, 1.5, false);
    acUnit(S, -79.5, 4.8, 12.0, Math.PI / 2);
    winRecess(S, -72.04, 3.0, 4.0, -Math.PI / 2, 1.2, 1.5, true);
    pipe(S, -72.1, 12.0, 5.8);
    // wall lanterns on the courtyard (local highlights, no extra light)
    for (const [x, y, z, ry] of [[-88.3, 4.4, 31.5, -Math.PI / 2], [-79.7, 4.2, 5.0, Math.PI / 2], [-110.0, 4.5, 40.4, 0]]) {
      B(S, 0.3, 0.12, 0.12, mats.metal, x, y + 0.3, z, ry, { cast: false });
      const gl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), mats.windowLit);
      gl.position.set(x + Math.sin(ry) * 0.15, y, z + Math.cos(ry) * 0.15); S.add(gl);
    }
    // rail warehouse east wall: ribs, plinth, AC, pipe, sign
    for (let z = -189; z <= -163; z += 1.6) B(R, 0.06, 7.4, 0.1, mats.metal, -5.94, 4.3, z, 0, { cast: false });
    B(R, 0.3, 0.7, 28.2, mats.concreteDark, -5.86, 0.35, -176, 0, { uv: 2.0, cast: false });
    acUnit(R, -5.45, 5.2, -183, Math.PI / 2);
    pipe(R, -5.5, -187, 7.0);
    B(R, 0.05, 1.5, 28.0, mats.grime, -5.96, 1.2, -176, 0, { cast: false });
    for (const [zc, w] of [[-186.0, 3.4], [-168.5, 3.6]]) {
      B(R, 0.1, 4.6, w, mats.metal, -5.9, 2.4, zc, 0, { uv: 1.6, cast: false });
      for (let k = 0; k < 4; k++) B(R, 0.12, 4.5, 0.05, mats.rust, -5.84, 2.4, zc - w / 2 + 0.5 + k * (w / 4.4), 0, { cast: false });
    }
    B(R, 0.06, 0.8, 3.4, mats.metal, -5.8, 4.3, -174, 0, { cast: false });
    WIN(R, 3.0, 0.6, mats.signA, -5.76, 4.3, -174, Math.PI / 2);
    B(R, 0.3, 0.25, 0.25, mats.metal, -5.7, 5.0, -180.0, 0, { cast: false });
    const wl = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), mats.windowLit);
    wl.position.set(-5.7, 4.8, -180.0); R.add(wl);
    B(R, 0.06, 0.9, 4.4, mats.metal, -5.78, 7.3, -174, 0, { cast: false });
    WIN(R, 4.0, 0.7, mats.signB, -5.74, 7.3, -174, Math.PI / 2);
    // port warehouse south wall: ribs, plinth, band, AC
    for (let x = 60.6; x <= 83.4; x += 1.5) B(P, 0.08, 7.4, 0.06, mats.metal, x, 4.4, 7.78, 0, { cast: false });
    B(P, 24.2, 0.7, 0.28, mats.concreteDark, 72, 0.35, 7.75, 0, { uv: 2.0, cast: false });
    WIN(P, 18, 0.55, mats.windowLitDim, 72, 6.5, 7.7, Math.PI);
    for (const x of [63, 69, 75, 81]) B(P, 0.06, 0.55, 0.06, mats.metal, x, 6.5, 7.68, 0, { cast: false });
    acUnit(P, 66, 5.2, 7.35, Math.PI);
    WIN(P, 4.0, 0.8, mats.signA, 72, 7.4, 7.66, Math.PI);


    /* =====================================================================
       DENSITY / COVER PASS — facilities, blockers and low cover with real
       colliders. Stage points and the three gates keep >=2.5 m clear.
       ===================================================================== */
    const solidBox = (g, x, z, w, d, h, mat, rot = 0, uv = 1.0) => {
      B(g, w, h, d, mat, x, h / 2, z, rot, { uv, collide: true });
      B(g, w * 0.94, 0.06, d * 0.94, mat, x, h + 0.02, z, rot, { cast: false });
    };
    const lowCover = (g, x, z, w, d, h, mat, rot = 0, cx = 0.9, cz = 0) => {
      solidBox(g, x, z, w, d, h, mat, rot);
      coverPoints.push({ x: x + cx, z: z + cz, h: h >= 1.4 });
    };
    const crateSolid = (g, x, z, s = 1.0, rot = 0.1) => {
      B(g, s, s, s, mats.wood, x, s / 2, z, rot, { uv: 0.9, collide: true });
      B(g, s * 0.92, 0.06, s * 0.92, mats.wood, x, s + 0.02, z, rot, { cast: false });
      coverPoints.push({ x: x + 0.9, z: z + 0.9, h: false });
    };
    const drumSolid = (g, x, z, mat = mats.rust) => {
      C(g, 0.34, 0.34, 0.95, 10, mat, x, 0.48, z);
      C(g, 0.35, 0.35, 0.05, 10, mats.metal, x, 0.92, z, { cast: false });
      addCollider(x, z, 0.75, 0.75, 0.04);
      coverPoints.push({ x: x + 0.8, z, h: false });
    };
    const barrierSolid = (g, x, z, w = 2.4, rot = 0) => {
      solidBox(g, x, z, w, 0.45, 0.95, mats.concrete, rot);
      coverPoints.push({ x: x, z: z + Math.cos(rot) * 0.9, h: false });
    };
    const stallSolid = (g, x, z, rot = 0, w = 3.2, d = 2.0) => {
      B(g, w, 0.9, d * 0.6, mats.wood, x, 0.45, z, rot, { uv: 1.0, collide: true });
      B(g, w + 0.2, 0.08, d * 0.72, mats.metalTan, x, 0.93, z, rot, { uv: 0.8, cast: false });
      for (const s of [-1, 1]) C(g, 0.04, 0.04, 2.5, 5, mats.metal, x + s * (w / 2 - 0.12) * Math.cos(rot), 1.25, z - s * (w / 2 - 0.12) * Math.sin(rot), { cast: false });
      for (let i = 0; i < 7; i++) {
        const off = -w / 2 + (w / 7) * (i + 0.5);
        B(g, w / 7 + 0.015, 0.05, d * 0.9, i % 2 ? mats.awning : mats.shop, x + off * Math.cos(rot), 2.5, z - off * Math.sin(rot), rot, { cast: false });
      }
      B(g, w, 0.24, 0.05, mats.burlap, x + Math.sin(rot) * d * 0.45, 2.36, z + Math.cos(rot) * d * 0.45, rot, { cast: false });
      coverPoints.push({ x: x + 1.2 * Math.cos(rot), z: z - 1.2 * Math.sin(rot), h: false });
    };
    const cartSolid = (g, x, z, rot = 0) => {
      B(g, 2.4, 0.6, 1.2, mats.wood, x, 0.8, z, rot, { uv: 1.0, collide: true });
      for (const dx of [-0.8, 0.8]) for (const dz of [-0.45, 0.45]) C(g, 0.26, 0.26, 0.18, 8, mats.rubber, x + dx * Math.cos(rot), 0.3, z - dx * Math.sin(rot) + dz, { rz: Math.PI / 2, cast: false });
      B(g, 0.08, 0.08, 1.4, mats.metal, x - 1.4 * Math.cos(rot), 0.75, z + 1.4 * Math.sin(rot), rot, { cast: false });
      coverPoints.push({ x: x + 1.1, z: z + 0.8, h: false });
    };
    const troughSolid = (g, x, z, rot = 0) => {
      B(g, 2.8, 0.8, 1.0, mats.concrete, x, 0.4, z, rot, { uv: 1.4, collide: true });
      B(g, 2.4, 0.06, 0.7, mats.puddle, x, 0.82, z, rot, { cast: false });
      coverPoints.push({ x: x + 1.2, z: z + 0.8, h: false });
    };
    const containerSolid = (g, x, z, n, rot = 0, base = 0) => {
      for (let i = 0; i < n; i++) {
        const m = PORT_PAL[(Math.abs(Math.round(x + z)) + i) % PORT_PAL.length];
        B(g, 12, 2.6, 2.6, m, x, base + 1.32 + i * 2.65, z, rot, { uv: 1.8, collide: true });
        for (let k = 0; k < 5; k++) B(g, 0.07, 2.3, 0.05, mats.rust, x - 5.2 + k * 2.4, base + 1.32 + i * 2.65, z + 1.32, rot, { cast: false });
        for (const dz of [-1.2, 1.2]) B(g, 0.12, 0.12, 0.12, mats.metalTan, x + 5.9, base + 0.15 + i * 2.65, z + dz, rot, { cast: false });
      }
      coverPoints.push({ x: x + 7.0, z: z, h: true });
    };
    const trailerSolid = (g, x, z, rot = 0, mat = mats.metal) => {
      B(g, 8.5, 2.6, 2.4, mat, x, 1.5, z, rot, { uv: 1.6, collide: true });
      for (const dx of [-3.0, 3.0]) for (const dz of [-0.9, 0.9]) C(g, 0.36, 0.36, 0.26, 10, mats.rubber, x + dx * Math.cos(rot), 0.38, z - dx * Math.sin(rot) + dz, { rz: Math.PI / 2, cast: false });
      coverPoints.push({ x: x + Math.cos(rot) * 5.2, z: z - Math.sin(rot) * 5.2, h: true });
    };
    const officeSolid = (g, x, z, w = 4.0, d = 3.0, mat = mats.plasterB) => {
      B(g, w, 0.12, d, mats.concrete, x, 0.06, z, 0, { cast: false });
      B(g, w, 2.8, 0.25, mat, x, 1.4, z - d / 2, 0, { collide: true, uv: 1.4 });
      B(g, w, 2.8, 0.25, mat, x, 1.4, z + d / 2, 0, { collide: true, uv: 1.4 });
      B(g, 0.25, 2.8, d, mat, x - w / 2, 1.4, z, 0, { collide: true, uv: 1.4 });
      B(g, 0.25, 2.8, d / 2 - 0.9, mat, x + w / 2, 1.4, z - d / 2 + (d / 2 - 0.9) / 2, 0, { collide: true, uv: 1.2 });
      B(g, 0.25, 2.8, d / 2 - 0.9, mat, x + w / 2, 1.4, z + d / 2 - (d / 2 - 0.9) / 2, 0, { collide: true, uv: 1.2 });
      B(g, 0.25, 1.0, 1.8, mat, x + w / 2, 2.3, z, 0, { uv: 1.0, cast: false });
      B(g, w + 0.4, 0.2, d + 0.4, mats.concreteDark, x, 2.9, z, 0, { uv: 1.4 });
      B(g, 1.4, 0.8, 0.6, mats.wood, x - 0.5, 1.0, z, 0, { uv: 0.8, collide: true });
      WIN(g, 1.2, 0.7, mats.windowLitDim, x + 0.5, 1.8, z + d / 2 + 0.03, 0);
      coverPoints.push({ x: x + w / 2 + 1.2, z: z, h: true });
    };
    const fenceSolid = (g, x, z, w, rot = 0) => {
      B(g, w, 0.08, 0.08, mats.metal, x, 1.9, z, rot, { cast: false });
      B(g, w, 0.08, 0.08, mats.metal, x, 0.8, z, rot, { cast: false });
      for (let i = 0; i < Math.ceil(w / 2); i++) B(g, 0.08, 2.0, 0.08, mats.metal, x - w / 2 + i * 2, 1.0, z, rot, { cast: false });
      addColliderRot(x, z, w, 0.2, rot, 0.05);
    };

    /* ---------------- SOUK ---------------- */
    stallSolid(S, -102.0, 42.0, 0.15);
    stallSolid(S, -89.3, 58.5, -0.2);
    stallSolid(S, -90.0, 57.2, 0.05);
    cartSolid(S, -99.0, 43.0, 0.2);
    cartSolid(S, -58.0, 5.5, -0.4);
    troughSolid(S, -45.0, 33.0, 0);
    for (const [x, z, rot] of [[-79.2, 15.5, 0], [-42.5, 13.5, 0], [-60.0, 30.5, 0]]) {
      B(S, 2.2, 0.5, 0.6, mats.wood, x, 0.25, z, rot, { uv: 0.8, collide: true });
      B(S, 2.2, 0.5, 0.1, mats.wood, x, 0.75, z - 0.28, rot, { cast: false });
      coverPoints.push({ x: x + 0.8, z: z, h: false });
    }
    lowCover(S, -101.0, 40.3, 4.0, 0.6, 1.0, mats.plasterC, 0, 0.8, 0.9);
    lowCover(S, -90.5, 55.6, 4.0, 0.6, 1.0, mats.plasterC, 0, 0.8, -0.9);
    
    for (const [x, z, s] of [[-98.5, 41.8, 0.85], [-94.5, 41.8, 0.8], [-103.2, 47.5, 0.9], [-102.4, 51.5, 0.8], [-90.7, 50.8, 0.9], [-90.7, 41.2, 0.8], [-97.0, 40.4, 0.9], [-92.0, 55.7, 0.8],
      [-79.0, 6.0, 0.9], [-73.0, -2.0, 0.8], [-79.0, -14.0, 0.9],  [-79.0, 34.0, 0.9], [-79.0, 28.0, 0.8],
      [-92.0, 17.2, 0.8], [-84.0, 22.6, 0.9], [-66.0, 17.2, 0.8], [-55.0, 22.6, 0.9], [-48.0, -14.0, 0.8], [-44.0, 12.0, 0.9], [-61.0, 11.0, 0.8]]) crateSolid(S, x, z, s, 0.15);
    for (const [x, z] of [[-80.0, 12.0], [-72.0, 8.0], [-94.0, 40.5], [-87.5, 47.0], [-100.5, 46.0]]) drumSolid(S, x, z);
    for (const [x, z] of [[-76.0, 20.0], [-70.0, 36.0], [-55.0, 8.0], [-46.0, 20.0]]) sack(S, x, z, 0.55);
    B(S, 2.4, 0.12, 13.0, mats.wood, -88.0, 4.35, 47.0, 0, { cast: false });
    for (const z of [41, 45, 49, 53]) B(S, 2.4, 0.12, 0.12, mats.wood, -88.0, 4.25, z, 0, { cast: false });
    for (const z of [43.5, 47.0, 50.5]) lantern(S, -88.0, 4.0, z, 0.9);
    for (const [x, z] of [[-57.4, 1.6], [-57.4, -2.2], [-57.4, 6.8], [-57.4, 10.2]]) {
      B(S, 0.6, 1.9, 2.0, mats.wood, x, 1.0, z, 0, { uv: 0.8, collide: true });
      B(S, 0.7, 0.06, 2.1, mats.wood, x, 1.98, z, 0, { cast: false });
    }

    /* ---------------- RAIL ---------------- */
    B(R, 4.2, 0.14, 18.0, mats.metal, -3.4, 5.6, -174, 0, { cast: false });
    for (const z of [-184.5, -180.0, -175.0, -170.0, -165.0]) B(R, 0.12, 4.0, 0.12, mats.metal, -5.3, 3.6, z, 0, { cast: false });
    for (const z of [-181.5, -168.0]) {
      B(R, 2.2, 0.8, 0.35, mats.metalTan, -5.4, 0.4, z, 0, { uv: 0.8, collide: true });
      WIN(R, 1.6, 0.4, mats.signA, -4.28, 5.1, z, Math.PI / 2);
    }
    B(R, 3.6, 2.4, 0.12, mats.metal, -5.82, 1.3, -168.0, Math.PI / 2, { uv: 1.0, collide: true });
    trailerSolid(R, 20.0, -176.0, 0, mats.metalTan);
    containerSolid(R, 18.0, -166.0, 2, 0);
    B(R, 2.0, 1.4, 1.4, mats.metalTan, 14.5, 1.0, -176.0, 0.3, { uv: 1.2, collide: true });
    B(R, 1.0, 1.2, 1.2, mats.metal, 13.9, 2.2, -177.0, 0.3, { uv: 1.0 });
    B(R, 0.18, 3.2, 0.18, mats.metal, 15.5, 2.1, -174.8, 0, { cast: false });
    B(R, 0.18, 3.2, 0.18, mats.metal, 15.5, 2.1, -177.2, 0, { cast: false });
    coverPoints.push({ x: 13.0, z: -176.0, h: true });
    palletArt(R, 16.0, -170.0, 3);
    addCollider(-30.0, -160.0, 11.0, 2.7, 0.1);
    addCollider(28.0, -168.0, 12.0, 2.7, 0.1);
    addCollider(34.0, -160.0, 7.0, 2.7, 0.1);
    trainCar(R, -14.0, -160.0, 9.0, 'box');
    addCollider(-14.0, -160.0, 9.0, 2.7, 0.1);
    for (const [x, z] of [[-30.0, -156.6], [28.0, -164.6], [-14.0, -156.6]]) coverPoints.push({ x, z, h: true });
    officeSolid(R, 16.0, -122.0, 3.0, 2.6, mats.plasterB);
    for (const [x, z] of [[18.0, -140.0], [-14.0, -128.0]]) {
      B(R, 2.2, 0.5, 0.6, mats.wood, x, 0.25, z, 0, { uv: 0.8, collide: true });
      B(R, 2.2, 0.5, 0.1, mats.wood, x, 0.75, z - 0.28, 0, { cast: false });
      coverPoints.push({ x: x + 0.8, z, h: false });
    }
    fenceSolid(R, 22.0, -106.0, 14.0, 0);
    for (const x of [16.0, 20.0]) {
      B(R, 0.18, 1.0, 0.18, mats.metal, x, 0.5, -106.0, 0, { collide: true });
      B(R, 0.9, 0.08, 0.08, mats.metal, x, 1.0, -106.0, 0, { cast: false });
    }
    for (const [x, z, s] of [[20, -180, 0.9], [24, -172, 0.8], [26, -164, 0.9], [30, -154, 0.8], [22, -134, 0.9], [16, -118, 0.8],
      [-14, -174, 0.9], [-20, -166, 0.8], [-24, -150, 0.9], [-28, -134, 0.8], [-20, -120, 0.9], [-16, -112, 0.8]]) crateSolid(R, x, z, s, 0.15);
    for (const [x, z] of [[24, -160], [28, -146], [18, -126], [-30, -160], [-26, -142], [-18, -120]]) drumSolid(R, x, z);
    for (const [x, z, w] of [[14, -150, 2.4], [20, -140, 2.2], [-14, -140, 2.4], [-20, -124, 2.2]]) barrierSolid(R, x, z, w, 0);
    for (const [x, z] of [[-28, -150], [-18, -146], [16, -150], [26, -146]]) {
      B(R, 1.0, 1.0, 1.0, mats.wood, x, 0.5, z, 0, { uv: 0.8, collide: true });
      coverPoints.push({ x, z: z + 0.9, h: false });
    }
    for (const [x, z] of [[-16, -148], [-6, -147.5], [6, -148], [16, -147.5]]) {
      B(R, 1.6, 0.6, 0.7, mats.wood, x, 4.5, z, 0, { uv: 0.8, cast: false });
      B(R, 1.2, 0.5, 0.5, mats.metalTan, x + 1.1, 4.45, z, 0, { uv: 0.6, cast: false });
    }
    B(R, 0.25, 4.0, 6.0, mats.plasterA, -24.0, 2.0, -185.0, 0, { collide: true, uv: 1.6 });
    B(R, 6.0, 4.0, 0.25, mats.plasterA, -21.0, 2.0, -188.0, 0, { collide: true, uv: 1.6 });
    B(R, 6.0, 4.0, 0.25, mats.plasterA, -21.0, 2.0, -182.0, 0, { collide: true, uv: 1.6 });
    B(R, 0.25, 3.0, 2.0, mats.plasterA, -24.0, 1.5, -188.5, 0, { collide: true, uv: 1.0 });
    B(R, 2.0, 0.8, 0.6, mats.wood, -21.5, 1.0, -185.0, 0, { uv: 0.8, collide: true });
    WIN(R, 1.2, 0.6, mats.windowLitDim, -21.0, 2.4, -181.86, 0);
    for (const [x, z] of [[-30, -112], [20, -136]]) {
      C(R, 1.0, 1.0, 0.7, 12, mats.wood, x, 1.0, z, { rx: Math.PI / 2 });
      addCollider(x, z, 2.0, 1.0, 0.1);
      coverPoints.push({ x: x + 1.4, z, h: true });
    }

    /* ---------------- PORT ---------------- */
    containerSolid(P, 86.0, -66.0, 2);
    containerSolid(P, 72.0, -38.0, 2);
    containerSolid(P, 58.0, -36.0, 2);
    containerSolid(P, 104.0, -38.0, 2);
    containerSolid(P, 108.0, -62.0, 2);
    for (const [x, z] of [[92, -60], [108, -60], [92, -36], [108, -36]]) {
      solidBox(P, x, z, 2.2, 0.6, 0.9, mats.concrete, 0);
      coverPoints.push({ x: x + 1.4, z, h: false });
    }
    soukShop(P, 52, 56, -94, -89, 1.6, 2.94, false, false);
    trailerSolid(P, 88.0, 2.0, 0, mats.metal);
    for (const [x, z] of [[114, -20], [114, -8], [114, 4]]) {
      B(P, 0.5, 1.0, 0.5, mats.rust, x, 0.5, z, 0, { uv: 0.6, collide: true });
      B(P, 0.7, 0.1, 0.7, mats.metal, x, 1.05, z, 0, { cast: false });
    }
    for (const [x, z] of [[74, -72], [86, -72], [90, -78]]) palletArt(P, x, z, 3);
    for (const [x, z] of [[70, -70], [94, -74], [88, -48], [100, -16]]) drumSolid(P, x, z);
    for (const [x, z, w] of [[60, -88, 2.4], [96, -62, 2.2], [110, -40, 2.2]]) barrierSolid(P, x, z, w, 0);
    for (const [x, z, s] of [[76, -64, 0.9], [68, -68, 0.8], [72, -52, 0.9], [56, -70, 0.8], [62, -20, 0.9], [78, -96, 0.9], [104, -80, 0.8]]) crateSolid(P, x, z, s, 0.15);
    fenceSolid(P, 100.0, -94.0, 6.0, 0);
    fenceSolid(P, 108.0, -10.0, 8.0, Math.PI / 2);
    for (const [x, z] of [[60, -50], [90, -82], [110, 0], [70, 12]]) solidBox(P, x, z, 0.9, 0.9, 1.2, mats.concreteDark, 0);
    for (const x of [61, 67, 76, 82]) B(P, 0.5, 0.5, 0.35, mats.rubber, x, 0.25, 7.4, 0, { collide: true });
    for (const [x, z] of [[74, -76], [86, -72], [90, -78]]) coverPoints.push({ x: x + 1.6, z: z + 1.2, h: false });
    for (const [x, z] of [[60, -84], [96, -62], [110, -40]]) coverPoints.push({ x, z: z + 0.9, h: false });

    /* ---------------- stage foreground / midground cover ---------------- */
    // souk: cart/crates/sacks in front of the well, low stall + low wall beyond
    crateSolid(S, -101.2, 44.2, 0.9);
    crateSolid(S, -102.4, 45.3, 0.8);
    lowCover(S, -100.4, 44.6, 1.8, 0.7, 0.9, mats.sandbag, 0, -0.9, 0.8);
    cartSolid(S, -103.5, 47.0, 0.8);
    stallSolid(S, -104.5, 44.0, 0.1, 3.0, 1.8);
    lowCover(S, -104.8, 48.8, 2.6, 0.6, 1.0, mats.plasterC, 0, 0.8, 0.8);
    crateSolid(S, -98.9, 44.0, 0.85);
    crateSolid(S, -99.6, 45.3, 0.8);
    lowCover(S, -99.4, 46.8, 1.4, 0.55, 0.8, mats.sandbag, 0, -0.7, -0.6);
    lowCover(S, -103.8, 45.8, 2.0, 0.55, 1.0, mats.plasterC, 0, 0.8, 0.8);
    for (const [x, z] of [[-100.8, 43.6], [-101.6, 43.9], [-102.8, 46.1]]) sack(S, x, z, 0.55);

    // rail: pallets/drums/buffers 5-12 m ahead, flatbed + container under the platform
    crateSolid(R, -4.5, -158.5, 0.9);
    crateSolid(R, 13.5, -158.0, 0.9);
    drumSolid(R, -3.8, -159.2);
    drumSolid(R, 14.5, -156.0);
    barrierSolid(R, -5.5, -156.0, 2.4);
    barrierSolid(R, 16.0, -155.5, 2.2);
    lowCover(R, 4.0, -160.0, 1.4, 1.0, 0.8, mats.concreteDark, 0, 1.0, 0.8);
    lowCover(R, -5.0, -160.0, 1.2, 1.0, 0.8, mats.metal, 0, 1.0, 0.8);
    drumSolid(R, 5.8, -158.5);
    drumSolid(R, -6.5, -158.0);
    barrierSolid(R, 4.0, -157.5, 2.0);
    trailerSolid(R, 20.0, -151.0);
    containerSolid(R, -22.0, -151.0, 1);

    // port: two low cover groups 4-10 m out, trailer + bollards at 12-20 m
    lowCover(P, 83.0, -76.0, 2.2, 1.2, 0.9, mats.wood, 0, 1.6, 0.8);
    lowCover(P, 87.0, -73.0, 2.4, 0.7, 1.0, mats.concrete, 0, 1.6, 0.8);
    drumSolid(P, 84.6, -75.0);
    drumSolid(P, 88.6, -72.6);
    trailerSolid(P, 96.0, -76.0);
    lowCover(P, 90.0, -69.0, 2.0, 1.2, 1.2, mats.metal, 0, 1.2, 0.8);
    for (const [x, z] of [[88.0, -70.0], [92.0, -66.0]]) {
      B(P, 0.5, 1.0, 0.5, mats.rust, x, 0.5, z, 0, { uv: 0.6, collide: true });
      B(P, 0.7, 0.1, 0.7, mats.metal, x, 1.05, z, 0, { cast: false });
      coverPoints.push({ x: x + 0.8, z, h: false });
    }
    for (const [x, z] of [[90.0, -70.0], [96.0, -66.0]]) {
      B(P, 0.5, 1.0, 0.5, mats.rust, x, 0.5, z, 0, { uv: 0.6, collide: true });
      B(P, 0.7, 0.1, 0.7, mats.metal, x, 1.05, z, 0, { cast: false });
      coverPoints.push({ x: x + 0.8, z, h: false });
    }


    /* ================= vertical routes / interiors / destructibles ================= */
    const rampVis = (g, x0, x1, z0, z1, rise) => {
      const dz = Math.abs(z1 - z0), len = Math.hypot(dz, rise), ang = Math.atan2(rise, dz);
      const rx = z1 < z0 ? ang : -ang;
      B(g, x1 - x0, 0.14, len + 0.1, mats.metal, (x0 + x1) / 2, rise / 2, (z0 + z1) / 2, 0, { rx, uv: 1.2, cast: false });
      for (const x of [x0 + 0.05, x1 - 0.05]) {
        B(g, 0.06, 0.06, len, mats.rust, x, rise / 2 + 0.95, (z0 + z1) / 2, 0, { rx, cast: false });
        for (let i = 0; i <= 5; i++) {
          const t = i / 5;
          B(g, 0.07, 0.95, 0.07, mats.rust, x, rise * t + 0.47, z0 + (z1 - z0) * t, 0, { cast: false });
        }
      }
      for (let i = 1; i < 8; i++) {
        const t = i / 8;
        B(g, x1 - x0 - 0.08, 0.05, 0.3, mats.rust, (x0 + x1) / 2, rise * t + 0.02, z0 + (z1 - z0) * t, 0, { cast: false });
      }
      B(g, x1 - x0 + 0.2, 0.12, 1.2, mats.concrete, (x0 + x1) / 2, rise + 0.06, z1, 0, { uv: 1.0, cast: false });
    };
    const addRoof = (x0, x1, z0, z1, y, sx, sz, cx, cz) => {
      ROOF_ZONES.push({ x0, x1, z0, z1, y });
      if (sx !== undefined) { ROOF_SPAWNS.push({ x: sx, z: sz, y }); spawnPoints.push({ x: sx, z: sz, y }); }
      if (cx !== undefined) { ROOF_COVERS.push({ x: cx, z: cz, y, h: false }); coverPoints.push({ x: cx, z: cz, y, h: false }); }
    };

    // ---- OLD SOUK: exterior stair from the plaza to the shop roof (3.82 m) ----
    EXPANSION_RAMPS.push({ id: 'souk-shop', x0: -49.0, x1: -47.4, z0: 15.6, z1: 9.4, rise: 3.82 });
    rampVis(S, -49.0, -47.4, 15.6, 9.4, 3.82);
    addRoof(-58, -50, 4.6, 12, 3.82, -54.0, 10.4, -52.0, 8.4);
    addRoof(-50, -47.4, 7.2, 9.4, 3.82);
    ROOF_COVERS.push({ x: -55.6, z: 5.6, y: 3.82, h: false }); coverPoints.push({ x: -55.6, z: 5.6, y: 3.82, h: false });
    B(S, 7.6, 0.1, 0.3, mats.wood, -53.8, 3.9, 4.75, 0, { cast: false });
    B(S, 0.3, 0.1, 7.2, mats.wood, -57.7, 3.9, 8.3, 0, { cast: false });
    B(S, 1.4, 1.0, 0.9, mats.metalTan, -55.8, 4.35, 10.8, 0, { uv: 0.8, cast: false });
    B(S, 0.9, 0.7, 0.7, mats.wood, -51.6, 4.2, 6.0, 0, { uv: 0.7, cast: false });

    // ---- RAIL: external loading deck + stair, bridged to the station platform (4.2 m) ----
    EXPANSION_RAMPS.push({ id: 'rail-load', x0: -1.8, x1: -0.4, z0: -170.0, z1: -162.0, rise: 4.2 });
    rampVis(R, -1.8, -0.4, -170.0, -162.0, 4.2);
    B(R, 4.0, 0.26, 10.0, mats.concrete, -4.0, 4.07, -157.0, 0, { uv: 1.8 });
    for (const [x, z] of [[-6.0, -160.0], [-6.0, -154.0], [-2.0, -162.0], [-2.0, -152.0]]) {
      B(R, 0.18, 4.2, 0.18, mats.metal, x, 2.1, z, 0, { uv: 0.8, collide: true });
    }
    for (const z of [-161.8, -152.2]) B(R, 4.0, 0.07, 0.07, mats.metal, -4.0, 5.1, z, 0, { cast: false });
    for (const x of [-5.95, -2.05]) B(R, 0.07, 0.07, 9.6, mats.metal, x, 5.1, -157.0, 0, { cast: false });
    for (let i = 0; i < 5; i++) B(R, 0.07, 0.9, 0.07, mats.metal, -5.95 + i * 0.98, 4.65, -152.2, 0, { cast: false });
    addRoof(-6, -2, -162, -152, 4.2, -4.0, -157.0, -4.0, -160.0);
    addRoof(-2.4, -0.4, -162, -160, 4.2);
    ROOF_COVERS.push({ x: -4.8, z: -154.5, y: 4.2, h: false }); coverPoints.push({ x: -4.8, z: -154.5, y: 4.2, h: false });
    B(R, 1.2, 0.9, 0.8, mats.wood, -4.5, 4.65, -154.5, 0, { uv: 0.8, cast: false });
    B(R, 1.6, 0.06, 6.0, mats.concreteDark, -4.0, 4.22, -157.0, 0, { uv: 1.2, cast: false });

    // ---- PORT: stair to the dock-office roof (3.26 m) ----
    EXPANSION_RAMPS.push({ id: 'port-office', x0: 56.2, x1: 57.8, z0: -86.0, z1: -91.5, rise: 3.20 });
    rampVis(P, 56.2, 57.8, -86.0, -91.5, 3.20);
    addRoof(52, 56, -94, -89, 3.20, 54.5, -90.5, 55.0, -89.5);
    addRoof(56, 57.8, -92.3, -90.7, 3.20);
    ROOF_COVERS.push({ x: 53.2, z: -89.4, y: 3.20, h: false }); coverPoints.push({ x: 53.2, z: -89.4, y: 3.20, h: false });
    B(P, 3.6, 0.1, 0.3, mats.wood, 54.0, 3.26, -89.1, 0, { cast: false });
    B(P, 0.3, 0.1, 4.6, mats.wood, 52.1, 3.26, -91.5, 0, { cast: false });
    B(P, 1.2, 0.8, 0.8, mats.metalTan, 54.4, 3.64, -92.6, 0, { uv: 0.8, cast: false });

    // ---- shared office door / chair / mug helpers ----
    const officeDoor = (g, x, zc, wh, signMat) => {
      const d = 1.6;
      for (const s of [-1, 1]) B(g, 0.1, Math.min(wh, 2.3), 0.1, mats.wood, x - 0.03, Math.min(wh, 2.3) / 2, zc + s * (d / 2 + 0.05), 0, { cast: false });
      B(g, 0.1, 0.12, d + 0.24, mats.wood, x - 0.03, 2.28, zc, 0, { cast: false });
      B(g, 0.5, 0.035, d + 0.2, mats.metal, x - 0.02, 0.018, zc, 0, { cast: false });
      const hz = zc + d / 2, leafD = 0.78, ang = 0.55;
      const pivot = new THREE.Group();
      pivot.position.set(x - 0.28, 1.03, hz);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.02, leafD), mats.wood);
      leaf.position.set(0, 0, -leafD / 2);
      leaf.castShadow = false; leaf.receiveShadow = true;
      pivot.add(leaf);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), mats.metalTan);
      knob.position.set(-0.065, 0, -leafD + 0.12);
      pivot.add(knob);
      pivot.rotation.y = ang;
      g.add(pivot);
      for (const yy of [0.42, 1.72]) C(g, 0.035, 0.035, 0.12, 6, mats.metal, x - 0.03, yy, hz - 0.03, { rz: Math.PI / 2, cast: false });
      B(g, 0.05, 0.3, 0.95, signMat || mats.signB, x + 0.06, 2.55, zc, 0, { cast: false });
      const doorRec = {
        x: x - 0.1, z: zc, isOpen: false,
        toggle() {
          this.isOpen = !this.isOpen;
          pivot.rotation.y = this.isOpen ? 1.78 : ang;
          return this.isOpen;
        },
      };
      interactiveDoors.push(doorRec);
    };
    const windowShutter = (g, x, y, z, w, h, rot = 0) => {
      for (const dz of [-w / 2, w / 2]) B(g, 0.08, h + 0.16, 0.08, mats.wood, x, y, z + dz, 0, { cast: false });
      B(g, 0.1, 0.08, w + 0.16, mats.wood, x, y - h / 2 - 0.04, z, 0, { cast: false });
      B(g, 0.1, 0.08, w + 0.16, mats.wood, x, y + h / 2 + 0.04, z, 0, { cast: false });
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      pivot.rotation.y = rot;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, w), mats.metal);
      panel.castShadow = false; panel.receiveShadow = true;
      pivot.add(panel);
      g.add(pivot);
      const rec = {
        x, z, isOpen: false,
        toggle() {
          this.isOpen = !this.isOpen;
          pivot.rotation.y = rot + (this.isOpen ? 1.35 : 0);
          return this.isOpen;
        },
      };
      interactiveWindows.push(rec);
    };

    const officeChair = (g, x, z, rot = 0) => {
      B(g, 0.42, 0.07, 0.42, mats.wood, x, 0.45, z, rot, { cast: false });
      B(g, 0.42, 0.5, 0.06, mats.wood, x, 0.72, z - 0.19, rot, { cast: false });
      for (const dx of [-0.16, 0.16]) for (const dz of [-0.16, 0.16]) B(g, 0.05, 0.44, 0.05, mats.metal, x + dx, 0.22, z + dz, 0, { cast: false });
    };
    const officeMug = (g, x, y, z) => C(g, 0.048, 0.042, 0.09, 8, mats.plasterC, x, y + 0.045, z, { cast: false });

    // ---- RAIL ticket / station office (4 x 6, 2.8 m, 1.6 m door) ----
    soukShop(R, 16.0, 20.0, -134.0, -128.0, 1.6, 2.8, true, false);
    officeDoor(R, 20.0, -131.0, 2.8, mats.signB);
    windowShutter(R, 16.02, 1.55, -131.0, 1.15, 0.9, 0);
    // counter along north wall + desk/chair south + locker west + bench
    B(R, 2.2, 1.0, 0.6, mats.wood, 17.8, 0.5, -133.35, 0, { uv: 0.8, collide: true });
    B(R, 2.3, 0.06, 0.7, mats.metalTan, 17.8, 1.03, -133.35, 0, { cast: false });
    B(R, 1.3, 0.75, 0.6, mats.wood, 18.6, 0.375, -129.0, 0, { uv: 0.8, collide: true });
    officeChair(R, 18.6, -129.7, 0.1);
    B(R, 0.62, 1.8, 0.55, mats.metal, 16.35, 0.9, -130.2, 0, { uv: 0.9, collide: true });
    B(R, 0.5, 0.03, 0.4, mats.metalTan, 16.35, 1.82, -130.2, 0, { cast: false });
    B(R, 0.55, 0.5, 1.6, mats.wood, 16.4, 0.25, -129.0, 0, { uv: 0.8, collide: true });
    B(R, 0.1, 0.5, 1.6, mats.wood, 16.12, 0.75, -129.0, 0, { cast: false });
    B(R, 0.6, 0.6, 0.6, mats.wood, 19.4, 0.3, -133.4, 0, { uv: 0.7, collide: true });
    // radio + antenna (counter and desk), papers, mug
    B(R, 0.36, 0.22, 0.26, mats.metalTan, 17.4, 1.12, -133.3, 0, { uv: 0.5 });
    WIN(R, 0.24, 0.13, mats.windowLitDim, 17.4, 1.18, -133.16, 0);
    C(R, 0.012, 0.012, 0.62, 4, mats.metal, 17.4, 1.55, -133.3, { cast: false });
    B(R, 0.32, 0.2, 0.24, mats.metal, 18.9, 0.86, -129.0, 0, { uv: 0.5 });
    C(R, 0.012, 0.012, 0.44, 4, mats.metal, 18.9, 1.2, -129.0, { cast: false });
    B(R, 0.24, 0.012, 0.3, mats.signB, 18.3, 0.76, -128.85, 0, { cast: false });
    officeMug(R, 18.7, 0.75, -128.8);
    // wall map/board, shelf boxes / files, clock / poster
    B(R, 1.3, 0.85, 0.05, mats.wood, 18.0, 1.9, -133.68, 0, { cast: false });
    B(R, 1.18, 0.72, 0.04, mats.signB, 18.0, 1.9, -133.64, 0, { cast: false });
    for (const [bx, bw, bh, bd] of [[17.2, 0.3, 0.28, 0.34], [18.2, 0.32, 0.26, 0.3], [18.9, 0.24, 0.2, 0.28]]) B(R, bw, bh, bd, mats.signC, bx, 1.68, -132.9, 0, { cast: false });
    B(R, 0.04, 0.32, 0.32, mats.windowLitDim, 16.31, 2.2, -131.0, 0, { cast: false });
    B(R, 0.05, 0.2, 0.02, mats.metal, 16.3, 2.26, -131.0, 0, { cast: false });
    B(R, 0.04, 0.72, 0.52, mats.signA, 16.31, 1.45, -132.3, 0, { cast: false });
    addPoint(18, 2.45, -131, 0xffb066, 0.6, 6, 1.5);
    pool(R, 18, 0.02, -131, 1.35);

    // ---- PORT dock office (4 x 5, 2.94 m, 1.6 m door) ----
    soukShop(P, 52, 56, -94, -89, 1.6, 2.94, false, false);
    officeDoor(P, 56.0, -91.5, 2.94, mats.signC);
    windowShutter(P, 52.02, 1.55, -91.5, 1.1, 0.9, 0);
    B(P, 1.2, 0.75, 0.6, mats.wood, 53.4, 0.375, -90.2, 0, { uv: 0.8, collide: true });
    officeChair(P, 53.4, -90.8, 0.15);
    B(P, 0.62, 1.8, 0.55, mats.metal, 55.4, 0.9, -93.4, 0, { uv: 0.9, collide: true });
    B(P, 0.5, 0.03, 0.4, mats.metalTan, 55.4, 1.82, -93.4, 0, { cast: false });
    B(P, 0.6, 0.6, 0.6, mats.wood, 52.7, 0.3, -89.6, 0, { uv: 0.7, collide: true });
    B(P, 0.34, 0.22, 0.26, mats.metalTan, 53.4, 0.87, -90.2, 0, { uv: 0.5 });
    WIN(P, 0.24, 0.13, mats.windowLitDim, 53.4, 0.93, -90.06, 0);
    C(P, 0.012, 0.012, 0.5, 4, mats.metal, 53.4, 1.3, -90.2, { cast: false });
    B(P, 0.24, 0.012, 0.3, mats.signB, 53.9, 0.76, -90.05, 0, { cast: false });
    officeMug(P, 53.1, 0.75, -90.1);
    B(P, 1.3, 0.85, 0.05, mats.wood, 54.0, 1.9, -89.32, 0, { cast: false });
    B(P, 1.18, 0.72, 0.04, mats.signB, 54.0, 1.9, -89.28, 0, { cast: false });
    for (const [bx, bw, bh, bd] of [[53.0, 0.3, 0.28, 0.34], [54.0, 0.3, 0.26, 0.3], [54.9, 0.24, 0.2, 0.28]]) B(P, bw, bh, bd, mats.signC, bx, 1.68, -92.9, 0, { cast: false });
    B(P, 0.04, 0.32, 0.32, mats.windowLitDim, 52.31, 2.2, -91.5, 0, { cast: false });
    B(P, 0.05, 0.2, 0.02, mats.metal, 52.3, 2.26, -91.5, 0, { cast: false });
    B(P, 0.04, 0.72, 0.52, mats.signA, 52.31, 1.45, -92.9, 0, { cast: false });
    WIN(P, 1.1, 0.7, mats.windowLitDim, 54.0, 1.9, -94.02, Math.PI);
    for (const ox of [-0.45, 0, 0.45]) B(P, 0.05, 0.8, 0.06, mats.wood, 54.0 + ox, 1.9, -94.06, 0, { cast: false });
    B(P, 1.2, 0.06, 0.06, mats.wood, 54.0, 1.9, -94.06, 0, { cast: false });
    addPoint(54, 2.5, -91.5, 0xffb066, 0.6, 6, 1.5);
    pool(P, 54, 0.02, -91.5, 1.35);

    // ---- PORT container-top catwalk: office roof -> container 1 -> container 2 (3.20 m) ----
    const cWall = (x, z, w, d, m = mats.metal) => B(P, w, 3.2, d, m, x, 1.6, z, 0, { uv: 1.5, collide: true });
    const cRail = (x, z0, z1, axis) => {
      for (const z of [z0, z1]) B(P, 0.07, 0.07, axis === 'z' ? 0.07 : 0.07, mats.metal, x, 4.05, z, 0, { cast: false });
    };
    // container 1 shell (hollow, 58..70 x -95..-90); bridge gaps at z -92.3..-90.7
    cWall(58, -93.65, 0.24, 2.7);
    cWall(58, -90.35, 0.24, 0.7);
    cWall(70, -93.65, 0.24, 2.7);
    cWall(70, -90.35, 0.24, 0.7);
    cWall(64, -95, 12, 0.24);
    cWall(64, -90, 12, 0.24);
    B(P, 12, 0.16, 5, mats.metalTan, 64, 3.12, -92.5, 0, { uv: 1.8 });
    for (let x = 58.6; x < 70; x += 1.4) B(P, 0.05, 2.9, 0.05, mats.rust, x, 1.55, -94.83, 0, { cast: false });
    for (let x = 58.6; x < 70; x += 1.4) B(P, 0.05, 2.9, 0.05, mats.rust, x, 1.55, -90.17, 0, { cast: false });
    for (let z = -94.4; z < -90; z += 1.1) B(P, 0.05, 2.9, 0.05, mats.rust, 58.17, 1.55, z, 0, { cast: false });
    for (let z = -94.4; z < -90; z += 1.1) B(P, 0.05, 2.9, 0.05, mats.rust, 69.83, 1.55, z, 0, { cast: false });
    // visible top deck plate + rails/edge trim
    B(P, 11.7, 0.08, 4.7, mats.metal, 64, 3.22, -92.5, 0, { uv: 2.2, cast: false });
    for (const z of [-95, -90]) {
      B(P, 12, 0.08, 0.08, mats.rust, 64, 4.0, z, 0, { cast: false });
      B(P, 12, 0.08, 0.08, mats.rust, 64, 3.45, z, 0, { cast: false });
      for (let x = 58; x <= 70; x += 2) B(P, 0.07, 1.0, 0.07, mats.metal, x, 3.7, z, 0, { cast: false });
    }
    for (const x of [58, 70]) {
      for (const [za, zb] of [[-95, -92.3], [-90.7, -90]]) {
        B(P, 0.08, 0.08, zb - za, mats.rust, x, 4.0, (za + zb) / 2, 0, { cast: false });
        B(P, 0.08, 0.08, zb - za, mats.rust, x, 3.45, (za + zb) / 2, 0, { cast: false });
        for (let z = za; z <= zb; z += 2) B(P, 0.07, 1.0, 0.07, mats.metal, x, 3.7, z, 0, { cast: false });
      }
    }
    B(P, 1.1, 0.08, 0.9, mats.metalTan, 65.5, 3.28, -93.2, 0, { uv: 0.8, cast: false });
    B(P, 1.0, 0.5, 0.8, mats.metal, 65.5, 3.45, -93.2, 0, { uv: 0.8 });
    // container 2 shell (72..84 x -95..-90); catwalk gap on west
    cWall(72, -93.65, 0.24, 2.7);
    cWall(72, -90.35, 0.24, 0.7);
    cWall(84, -92.5, 0.24, 5);
    cWall(78, -95, 12, 0.24);
    cWall(78, -90, 12, 0.24);
    B(P, 12, 0.16, 5, mats.metalTan, 78, 3.12, -92.5, 0, { uv: 1.8 });
    for (let x = 72.6; x < 84; x += 1.4) B(P, 0.05, 2.9, 0.05, mats.rust, x, 1.55, -94.83, 0, { cast: false });
    for (let x = 72.6; x < 84; x += 1.4) B(P, 0.05, 2.9, 0.05, mats.rust, x, 1.55, -90.17, 0, { cast: false });
    for (let z = -94.4; z < -90; z += 1.1) B(P, 0.05, 2.9, 0.05, mats.rust, 83.83, 1.55, z, 0, { cast: false });
    B(P, 11.7, 0.08, 4.7, mats.metal, 78, 3.22, -92.5, 0, { uv: 2.2, cast: false });
    for (const z of [-95, -90]) {
      B(P, 12, 0.08, 0.08, mats.rust, 78, 4.0, z, 0, { cast: false });
      B(P, 12, 0.08, 0.08, mats.rust, 78, 3.45, z, 0, { cast: false });
      for (let x = 72; x <= 84; x += 2) B(P, 0.07, 1.0, 0.07, mats.metal, x, 3.7, z, 0, { cast: false });
    }
    for (const [za, zb] of [[-95, -92.3], [-90.7, -90]]) {
      B(P, 0.08, 0.08, zb - za, mats.rust, 72, 4.0, (za + zb) / 2, 0, { cast: false });
      B(P, 0.08, 0.08, zb - za, mats.rust, 72, 3.45, (za + zb) / 2, 0, { cast: false });
      for (let z = za; z <= zb; z += 2) B(P, 0.07, 1.0, 0.07, mats.metal, 72, 3.7, z, 0, { cast: false });
    }
    B(P, 0.08, 0.08, 5, mats.rust, 84, 4.0, -92.5, 0, { cast: false });
    B(P, 0.08, 0.08, 5, mats.rust, 84, 3.45, -92.5, 0, { cast: false });
    for (let z = -95; z <= -90; z += 2) B(P, 0.07, 1.0, 0.07, mats.metal, 84, 3.7, z, 0, { cast: false });
    for (const z of [-93.4, -91.6]) B(P, 0.1, 2.7, 0.08, mats.metalTan, 84.14, 1.4, z, 0, { uv: 0.8, cast: false });
    B(P, 2.2, 0.08, 0.9, mats.metalTan, 80.5, 3.28, -91.2, 0, { uv: 0.8, cast: false });
    // bridge (office roof -> container 1) + catwalk (container 1 -> 2)
    B(P, 2.0, 0.14, 1.6, mats.metal, 57, 3.13, -91.5, 0, { uv: 1.4 });
    B(P, 2.0, 0.14, 1.6, mats.metal, 71, 3.13, -91.5, 0, { uv: 1.4 });
    for (const x of [57, 71]) {
      for (const z of [-92.27, -90.73]) {
        B(P, 1.7, 0.07, 0.07, mats.rust, x, 4.0, z, 0, { cast: false });
        for (const dx of [-0.8, 0.8]) B(P, 0.07, 1.0, 0.07, mats.metal, x + dx, 3.65, z, 0, { cast: false });
      }
    }
    B(P, 0.5, 0.04, 2.0, mats.metal, 57, 3.23, -91.5, 0, { cast: false });
    // roof zones / spawns / covers
    ROOF_ZONES.push({ x0: 56, x1: 58, z0: -92.3, z1: -90.7, y: 3.2 });
    addRoof(58, 70, -95, -90, 3.2, 64.0, -92.5, 60.0, -93.2);
    ROOF_COVERS.push({ x: 68.0, z: -91.2, y: 3.2, h: false }); coverPoints.push({ x: 68.0, z: -91.2, y: 3.2, h: false });
    ROOF_ZONES.push({ x0: 70, x1: 72, z0: -92.3, z1: -90.7, y: 3.2 });
    addRoof(72, 84, -95, -90, 3.2, 78.0, -92.5, 78.0, -91.0);

    // ---- rail warehouse open loading bay (plate + frame, door path stays clear) ----
    B(R, 4.0, 0.06, 5.8, mats.concreteDark, -4.0, 0.03, -179.0, 0, { uv: 1.4, cast: false });
    for (const z of [-182.15, -175.85]) B(R, 0.2, 3.4, 0.2, mats.metal, -5.8, 1.7, z, 0, { uv: 0.8, collide: true });
    B(R, 0.2, 0.2, 6.5, mats.metal, -5.8, 3.35, -179.0, 0, { cast: false });
    palletArt(R, -3.0, -172.5, 3);
    crateSolid(R, -8.5, -171.5, 0.9);

    // ---- destructible cover (wood 55-60 / sandbag 120-125 / metal 80-85 hp) ----
    DESTRUCTIBLE_DEFS.push(
      { id: 'souk-break-crate', x: -101.5, z: 39.0, w: 1.0, h: 1.0, d: 1.0, mat: 'wood', hp: 55 },
      { id: 'souk-break-sacks', x: -105.0, z: 46.2, w: 1.8, h: 1.0, d: 0.9, mat: 'sandbag', hp: 120 },
      { id: 'souk-break-rail', x: -103.0, z: 51.5, w: 1.6, h: 1.0, d: 0.45, mat: 'metal', hp: 80 },
      { id: 'souk-break-crate2', x: -90.0, z: 38.5, w: 1.1, h: 1.1, d: 1.1, mat: 'wood', hp: 60 },
      { id: 'rail-break-crate', x: -8.0, z: -156.5, w: 1.0, h: 1.0, d: 1.0, mat: 'wood', hp: 60 },
      { id: 'rail-break-sacks', x: 14.0, z: -148.0, w: 1.8, h: 1.0, d: 0.9, mat: 'sandbag', hp: 125 },
      { id: 'rail-break-rail', x: 18.0, z: -142.0, w: 1.6, h: 1.0, d: 0.45, mat: 'metal', hp: 85 },
      { id: 'rail-break-crate2', x: 16.0, z: -170.0, w: 1.1, h: 1.1, d: 1.1, mat: 'wood', hp: 55 },
      { id: 'port-break-crate', x: 76.0, z: -70.0, w: 1.0, h: 1.0, d: 1.0, mat: 'wood', hp: 55 },
      { id: 'port-break-sacks', x: 86.0, z: -78.0, w: 1.8, h: 1.0, d: 0.9, mat: 'sandbag', hp: 120 },
      { id: 'port-break-rail', x: 92.0, z: -74.0, w: 1.6, h: 1.0, d: 0.45, mat: 'metal', hp: 80 },
      { id: 'port-break-crate2', x: 88.0, z: -84.0, w: 1.1, h: 1.1, d: 1.1, mat: 'wood', hp: 60 },
    );


  }

  function buildBuilding(def) {
    const { side, z0, z1, depth, h } = def;
    const len = z1 - z0, zc = (z0 + z1) / 2;
    const gh = def.gh ?? (def.detail === 'high' ? 4.35 : 4.1);
    const plaster = def.plaster || mats.plasterA;
    const bodyX0 = side < 0 ? -(WALL + depth) : WALL;
    const bodyX1 = side < 0 ? -WALL : WALL + depth;

    // ---- body volume (plain plaster; street face is covered by screen/panel)
    if (def.interior) {
      buildCarvedBody(def);          // leaves the CQB room void open to the street
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(depth, h, len), plaster);
      projectBoxUV(body.geometry, 3.6);
      body.position.set(side * (WALL + depth / 2), h / 2, zc);
      body.castShadow = true; body.receiveShadow = true;
      statics.add(body);
      addColliderRect(bodyX0, bodyX1, z0, z1);
    }

    // roof slab lip (split around an open courtyard, if any)
    if (def.roofHole) {
      const rh = def.roofHole;
      const zseg = [[z0, rh.z0], [rh.z1, z1]];
      for (const [za, zb] of zseg) {
        if (zb - za > 0.05) {
          meshBox(depth + 0.22, 0.26, zb - za, mats.concreteDark, side * (WALL + depth / 2), h + 0.06, (za + zb) / 2, 0, { uv: 2.2, cast: false });
        }
      }
      const xa = Math.min(bodyX0, bodyX1), xb = Math.max(bodyX0, bodyX1);
      const hx0 = Math.min(rh.x0, rh.x1), hx1 = Math.max(rh.x0, rh.x1);
      if (hx0 - xa > 0.05) {
        meshBox(hx0 - xa, 0.26, rh.z1 - rh.z0, mats.concreteDark, (xa + hx0) / 2, h + 0.06, (rh.z0 + rh.z1) / 2, 0, { uv: 2.2, cast: false });
      }
      if (xb - hx1 > 0.05) {
        meshBox(xb - hx1, 0.26, rh.z1 - rh.z0, mats.concreteDark, (hx1 + xb) / 2, h + 0.06, (rh.z0 + rh.z1) / 2, 0, { uv: 2.2, cast: false });
      }
      // low coping around the courtyard opening
      for (const [cx0, cx1, cz0, cz1] of [
        [hx0, hx1, rh.z0 - 0.18, rh.z0], [hx0, hx1, rh.z1, rh.z1 + 0.18],
        [hx0 - 0.18, hx0, rh.z0, rh.z1], [hx1, hx1 + 0.18, rh.z0, rh.z1],
      ]) {
        meshBox(cx1 - cx0, 0.34, cz1 - cz0, mats.concrete, (cx0 + cx1) / 2, h + 0.2, (cz0 + cz1) / 2, 0, { uv: 1.6, cast: false });
      }
    } else {
      meshBox(depth + 0.22, 0.26, len + 0.2, mats.concreteDark, side * (WALL + depth / 2), h + 0.06, zc, 0, { uv: 2.2, cast: false });
    }

    const bays = Math.max(2, Math.round(len / 3.15));
    const bayW = len / bays;

    if (def.detail === 'high') {
      buildDetailedFacade(side, z0, z1, gh, h, plaster, def);
    } else {
      // ---- texture panel with world-scaled window modules + per-building offset
      const info = FACADE_INFO[def.facade || 'A'] || FACADE_INFO.A;
      const tileW = info.cols * info.modW;
      const tileH = info.floors * info.floorH;
      const offU = rnd() * 1.7, offV = rnd() * 1.3;
      const panelH = h - gh - 0.15;
      meshPanel(len, panelH, tileW, tileH, offU, offV + (gh / tileH), mats[info.mat],
        side * (OUT + 0.47), gh + panelH / 2 + 0.15, zc, -side * Math.PI / 2);
      const px = side * (OUT + 0.47);
      // base band + cornice break up the seam (all flush to the panel plane)
      meshBox(0.62, 0.42, len, mats.concreteDark, side * (OUT + 0.28), gh + 0.21, zc, 0, { uv: 2.2 });
      meshBox(0.5, 0.3, len + 0.1, mats.concrete, side * (OUT + 0.34), h - 0.5, zc, 0, { uv: 2.2 });
      // corner quoins
      for (const zz of [z0 + 0.35, z1 - 0.35]) {
        for (let q = 0; q < Math.floor((h - gh) / 1.25); q++) {
          const qw = q % 2 ? 0.95 : 0.65;
          meshBox(0.34, 0.34, qw, mats.concrete, side * (OUT + 0.34), gh + 0.5 + q * 1.25, zz, 0, { uv: 1.6 });
        }
      }
      // pilasters + string courses: break up the painted module repetition
      const nP = Math.max(3, Math.round(len / 3.6));
      for (let i = 0; i <= nP; i++) {
        const pz = z0 + (i / nP) * len;
        meshBox(0.42, h - gh - 0.55, 0.4, mats.concrete, side * (OUT + 0.27), gh + (h - gh) / 2, pz, 0, { uv: 2.0, cast: false });
        meshBox(0.5, 0.14, 0.52, mats.concreteDark, side * (OUT + 0.24), gh + 0.1, pz, 0, { uv: 1.4, cast: false });
      }
      for (let f = 1; f <= 2; f++) {
        const yy = gh + f * ((h - gh) / 3);
        meshBox(0.34, 0.13, len, mats.concreteDark, side * (OUT + 0.34), yy, zc, 0, { uv: 1.8, cast: false });
      }
      // AC units + drip grime on the mid facade
      for (let i = 0; i < 5; i++) {
        const ay = gh + rr(1.6, Math.max(2.2, h - gh - 2.2));
        const az = zc + rr(-len * 0.44, len * 0.44);
        meshBox(0.36, 0.48, 0.7, mats.metal, side * (OUT + 0.28), ay, az, 0, { uv: 1.0, cast: false });
        addGrime(side, side * (OUT + 0.45), ay - 0.55, az, 0.62, 1.2);
      }
      // shallow balcony slabs + railings so mid buildings also read 3D
      const nBal = def.balconies ?? (rnd() < 0.5 ? 1 : 2);
      for (let b = 0; b < nBal; b++) {
        const by = gh + 3.0 + b * 6.6;
        if (by > h - 2) break;
        const bz = zc + (rnd() - 0.5) * (len - 4);
        const bw = Math.min(3.1, len * 0.32);
        meshBox(0.95, 0.14, bw, mats.concreteDark, px, by, bz, 0, { uv: 1.2 });
        meshBox(0.1, 0.34, bw, mats.concrete, px - side * 0.45, by + 0.24, bz, 0, { uv: 1.0, cast: false });
        for (let k = 0; k < 8; k++) {
          meshBox(0.045, 0.88, 0.045, mats.rust, px - side * 0.48, by + 0.5, bz - bw / 2 + k * (bw / 7), 0, { uv: 0.8, cast: false });
        }
        meshBox(0.06, 0.06, bw, mats.rust, px - side * 0.48, by + 0.94, bz, 0, { uv: 0.8, cast: false });
        if (rnd() < 0.6) addLaundryCloth(px - side * 0.5, by + 0.92, bz + rr(-0.6, 0.6), side);
      }
      // occasional projecting sign to break the silhouette
      if (rnd() < 0.6) bladeSign(side, zc + rr(-len * 0.3, len * 0.3), gh + 2.6, 1.2, 0.55, pick([mats.signA, mats.signC]));
    }

    buildGroundFloor(side, z0, z1, gh, bays, def);
    buildRoof(side, z0, z1, h, def);
    buildWallServices(side, z0, z1, h, gh, def);
    if (def.interior) buildInterior(def);
  }

  /* ---- high detail: real window recesses -------------------------------- */
  function buildDetailedFacade(side, z0, z1, gh, h, plaster, def) {
    const len = z1 - z0, zc = (z0 + z1) / 2;
    const floors = Math.max(2, Math.round((h - gh - 0.7) / 3.3));
    const fh = (h - gh - 0.35) / floors;
    const bays = def.bays || Math.max(2, Math.round(len / 3.15));
    const bayW = len / bays;
    const pierW = Math.min(0.7, bayW * 0.24);
    const sx = side * (OUT + SCREEN / 2);
    const xf = (d) => side * (OUT - d);           // outward from wall plane
    const xin = (d) => side * (OUT + d);          // inward
    const faceRot = -side * Math.PI / 2;

    for (let f = 0; f < floors; f++) {
      const y0 = gh + f * fh;
      const wh = Math.min(1.82, fh * 0.56);
      const ww = Math.min(1.5, Math.max(1.05, bayW - pierW - 0.34));
      const yb = y0 + fh * 0.30;

      // bands above / below the window row
      const lowH = yb - y0;
      const upH = (y0 + fh) - (yb + wh);
      meshBox(SCREEN, lowH, len, plaster, sx, y0 + lowH / 2, zc, 0, { uv: 3.6, cast: false });
      meshBox(SCREEN, upH, len, plaster, sx, yb + wh + upH / 2, zc, 0, { uv: 3.6, cast: false });

      // piers (end piers kept fully inside the lot)
      for (let i = 0; i <= bays; i++) {
        const pz = i === 0 ? z0 + pierW / 2 : i === bays ? z1 - pierW / 2 : z0 + i * bayW;
        meshBox(SCREEN, wh, pierW, plaster, sx, yb + wh / 2, pz, 0, { uv: 3.6, cast: false });
      }

      // string course at every floor line
      if (f > 0) {
        meshBox(0.66, 0.16, len + 0.02, mats.concrete, side * (OUT + 0.2), y0 - 0.08, zc, 0, { uv: 2.4, cast: false });
        meshBox(0.58, 0.06, len + 0.02, mats.concreteDark, xf(0.02), y0 - 0.2, zc, 0, { uv: 2.4, cast: false });
        addGrimeBand(side, z0, z1, y0 - 0.26, 0.5);
      }

      for (let i = 0; i < bays; i++) {
        const wz = z0 + (i + 0.5) * bayW;
        const openW = bayW - pierW;
        // cheeks between window and piers
        const cheek = (openW - ww) / 2;
        if (cheek > 0.01) {
          meshBox(SCREEN, wh, cheek, plaster, sx, yb + wh / 2, wz - ww / 2 - cheek / 2, 0, { uv: 3.2, cast: false });
          meshBox(SCREEN, wh, cheek, plaster, sx, yb + wh / 2, wz + ww / 2 + cheek / 2, 0, { uv: 3.2, cast: false });
        }
        addWindow(side, wz, yb, ww, wh, f, i, def, { xf, xin, sx, faceRot, plaster });
      }
    }
    // cornice
    meshBox(0.78, 0.34, len + 0.14, mats.concrete, side * (OUT + 0.2), h - 0.55, zc, 0, { uv: 2.2 });
    meshBox(0.6, 0.12, len + 0.18, mats.concreteDark, xf(0.06), h - 0.34, zc, 0, { uv: 2.2, cast: false });
    addGrimeBand(side, z0 + 0.4, z1 - 0.4, h - 0.95, 0.42);
  }

  function addWindow(side, z, yb, ww, wh, floor, bay, def, ctx) {
    const { xf, xin, faceRot } = ctx;
    const lit = rnd() < 0.17;
    const dim = !lit && rnd() < 0.12;
    const broken = !lit && rnd() < 0.09;
    const shutters = !lit && rnd() < 0.1;

    // dark cavity (BackSide box) - this is the real recess depth
    const cavDepth = 0.46;
    const cav = new THREE.Mesh(new THREE.BoxGeometry(cavDepth, wh, ww), mats.interior);
    cav.position.set(xin(cavDepth / 2 + 0.02), yb + wh / 2, z);
    cav.castShadow = false; cav.receiveShadow = false;
    statics.add(cav);

    if (!broken) {
      // glass sits deep inside, tilted a hair
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(ww - 0.08, wh - 0.08), lit ? mats.windowLit : dim ? mats.windowLitDim : mats.windowGlass);
      glass.position.set(xin(0.35), yb + wh / 2, z);
      glass.rotation.y = faceRot;
      glass.castShadow = false; glass.receiveShadow = true;
      statics.add(glass);
      if (!lit && !dim && rnd() < 0.3) {
        // curtain / blind strip behind the glass, just visible
        const cur = new THREE.Mesh(new THREE.PlaneGeometry(ww * 0.34, wh - 0.12), mats.burlap);
        cur.position.set(xin(0.39), yb + wh / 2, z + (rnd() > 0.5 ? -1 : 1) * (ww / 2 - ww * 0.17));
        cur.rotation.y = faceRot;
        cur.castShadow = false;
        statics.add(cur);
      }
    } else {
      // broken pane: a few shards left in the frame + dark void
      for (let s = 0; s < 4; s++) {
        const sw = rr(0.12, 0.3), sh = rr(0.1, 0.35);
        const shard = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mats.glassBroken);
        shard.position.set(xin(0.33), yb + (s < 2 ? wh - sh * 0.6 - 0.04 : 0.06 + sh * 0.4), z + rr(-ww * 0.4, ww * 0.4));
        shard.rotation.set(0, faceRot, rr(-0.5, 0.5));
        shard.castShadow = false;
        statics.add(shard);
      }
    }

    // frame: jambs, head, mullion, transom
    const fr = mats.metal;
    const frDepth = xin(0.07);
    for (const sgn of [-1, 1]) {
      meshBox(0.1, wh + 0.06, 0.075, fr, frDepth, yb + wh / 2, z + sgn * (ww / 2 + 0.01), 0, { uv: 0.7, cast: false });
    }
    meshBox(0.1, 0.075, ww + 0.14, fr, frDepth, yb + wh + 0.02, z, 0, { uv: 0.7, cast: false });
    meshBox(0.09, 0.07, ww + 0.14, fr, frDepth, yb - 0.01, z, 0, { uv: 0.7, cast: false });
    meshBox(0.075, wh, 0.05, fr, xin(0.1), yb + wh / 2, z, 0, { uv: 0.7, cast: false });
    if (wh > 1.3) meshBox(0.07, 0.045, ww, fr, xin(0.11), yb + wh * 0.62, z, 0, { uv: 0.7, cast: false });
    // security bars on a few ground-ish floors
    if (floor < 1 && rnd() < 0.4) {
      for (let b = 0; b < 4; b++) {
        meshBox(0.03, wh - 0.05, 0.03, mats.rust, xf(0.05), yb + wh / 2, z - ww * 0.36 + b * ww * 0.24, 0, { uv: 0.4, cast: false });
      }
      meshBox(0.035, 0.035, ww * 0.9, mats.rust, xf(0.05), yb + wh * 0.55, z, 0, { uv: 0.4, cast: false });
    }

    // stone sill protruding out, with a drip shadow
    meshBox(0.24, 0.11, ww + 0.3, mats.concrete, xf(0.09), yb - 0.055, z, 0, { uv: 1.1 });
    meshBox(0.2, 0.045, ww + 0.34, mats.concreteDark, xf(0.11), yb - 0.13, z, 0, { uv: 0.9, cast: false });
    addGrime(side, xf(0.03), yb - 0.2, z, ww * 1.15, 0.9);

    // shutters
    if (shutters) {
      for (const sgn of [-1, 1]) {
        meshBox(0.05, wh * 0.96, ww * 0.46, mats.wood, xf(0.04), yb + wh / 2, z + sgn * ww * 0.235, 0, { uv: 0.9, cast: false });
      }
    }

    // AC unit hanging under some windows
    if (rnd() < 0.32 && yb > 2.6) {
      const az = z + (rnd() > 0.5 ? 1 : -1) * ww * 0.32;
      const acY = yb - 0.44;
      meshBox(0.38, 0.5, 0.74, mats.metal, xf(0.19), acY, az, 0, { uv: 1.0 });
      meshBox(0.44, 0.05, 0.8, mats.metalTan, xf(0.19), acY + 0.27, az, 0, { uv: 0.8, cast: false });
      meshBox(0.06, 0.06, 0.86, mats.rust, xf(0.02), acY - 0.3, az, 0, { uv: 0.6, cast: false });
      addGrime(side, xf(0.02), acY - 0.5, az, 0.55, 1.3);
      // drip pipe
      meshCyl(0.02, 0.02, 0.4, 4, mats.rubber, xf(0.24), acY - 0.5, az + 0.3, { cast: false });
    }

    // balcony on some upper windows
    if (floor >= 1 && rnd() < 0.3) {
      const bw = Math.min(2.4, ww + 0.6);
      meshBox(0.95, 0.12, bw, mats.concreteDark, xf(0.5), yb - 0.16, z, 0, { uv: 1.2 });
      for (const sgn of [-1, 1]) {
        const br = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.06), mats.rust);
        br.position.set(xf(0.32), yb - 0.36, z + sgn * (bw / 2 - 0.25));
        br.rotation.z = side * 0.75;
        statics.add(br);
      }
      meshBox(0.12, 0.5, bw, mats.concrete, xf(0.96), yb - 0.02, z, 0, { uv: 1.0, cast: false });
      for (let k = 0; k < 9; k++) {
        meshBox(0.04, 0.86, 0.04, mats.rust, xf(0.98), yb + 0.5, z - bw / 2 + k * (bw / 8), 0, { uv: 0.6, cast: false });
      }
      meshBox(0.06, 0.06, bw, mats.rust, xf(0.98), yb + 0.94, z, 0, { uv: 0.6, cast: false });
      if (rnd() < 0.6) addLaundryCloth(xf(0.96), yb + 0.95, z + rr(-0.7, 0.7), side);
      if (rnd() < 0.4) { // plastic chair silhouette
        meshBox(0.42, 0.06, 0.42, mats.polymerTan, xf(0.55), yb + 0.28, z + rr(-0.5, 0.5), 0, { uv: 0.6 });
        meshBox(0.42, 0.42, 0.05, mats.polymerTan, xf(0.55), yb + 0.5, z + rr(-0.5, 0.5), 0, { uv: 0.6 });
      }
    }
  }

  /* ---- ground floor: shops, shutters, doors, blank walls ----------------- */
  function buildGroundFloor(side, z0, z1, gh, bays, def) {
    const len = z1 - z0;
    const bayW = len / bays;
    const sx = side * (OUT + SCREEN / 2);
    const xf = (d) => side * (OUT - d);
    const xin = (d) => side * (OUT + d);
    const faceRot = -side * Math.PI / 2;

    // plinth (split around an enterable interior frontage)
    const frontZ = def.interior ? INTERIOR_SPECS[def.interior].frontZ : null;
    if (frontZ) {
      const segs = [[z0, Math.max(z0, frontZ[0])], [Math.min(z1, frontZ[1]), z1]];
      for (const [pa, pb] of segs) {
        if (pb - pa < 0.05) continue;
        meshBox(0.66, 0.56, pb - pa, mats.concreteDark, side * (OUT + 0.2), 0.28, (pa + pb) / 2, 0, { uv: 1.8, cast: false });
      }
    } else {
      meshBox(0.66, 0.56, len, mats.concreteDark, side * (OUT + 0.2), 0.28, z0 + len / 2, 0, { uv: 1.8, cast: false });
    }
    // top lintel band above ground floor
    meshBox(0.74, 0.5, len + 0.04, mats.concrete, side * (OUT + 0.19), gh - 0.25, z0 + len / 2, 0, { uv: 2.2 });
    meshBox(0.72, 0.07, len + 0.06, mats.concreteDark, xf(0.03), gh - 0.53, z0 + len / 2, 0, { uv: 2.2, cast: false });

    for (let i = 0; i < bays; i++) {
      const bz = z0 + (i + 0.5) * bayW;
      const bw = bayW - 0.62;
      // the enterable CQB room builds its own front wall + doors here
      if (frontZ && bz > frontZ[0] - 0.35 && bz < frontZ[1] + 0.35) continue;
      const x = side * (OUT + SCREEN / 2);
      let kind = def.ground || 'wall';
      if (kind === 'shop' && bays > 2 && i === bays - 1) kind = 'door';
      if (kind === 'shutter' && i === 0) kind = 'cafe';
      if (kind === 'door' && i !== bays - 1) kind = rnd() < 0.5 ? 'shutter' : 'wall';
      if (kind === 'shutter' && rnd() < 0.34) kind = 'cafe';
      if (kind === 'wall' && rnd() < 0.3) kind = 'cafe';
      if (def.detail === 'ruin') kind = 'ruin';

      if (kind === 'shop') {
        // recessed shopfront
        const oh = gh - 0.95;
        const cavity = new THREE.Mesh(new THREE.BoxGeometry(0.6, oh, bw), mats.interior);
        cavity.position.set(xin(0.3), oh / 2 + 0.3, bz);
        cavity.castShadow = false; cavity.receiveShadow = false;
        statics.add(cavity);
        // bulkhead
        meshBox(0.72, 0.55, bw + 0.1, mats.concreteDark, xin(0.3), 0.28, bz, 0, { uv: 1.8 });
        // frame
        for (const sgn of [-1, 1]) meshBox(0.18, oh, 0.1, mats.metal, xin(0.30), 0.3 + oh / 2, bz + sgn * (bw / 2 - 0.05), 0, { uv: 0.9 });
        meshBox(0.18, 0.1, bw, mats.metal, xin(0.30), 0.3 + oh - 0.05, bz, 0, { uv: 0.9 });
        if (rnd() < 0.55) {
          const glass = new THREE.Mesh(new THREE.PlaneGeometry(bw - 0.24, oh - 0.24), mats.windowGlass);
          glass.position.set(xin(0.44), 0.3 + oh / 2, bz);
          glass.rotation.y = faceRot;
          glass.castShadow = false; glass.receiveShadow = true;
          statics.add(glass);
          if (rnd() < 0.45) { // broken shop window
            for (let s = 0; s < 5; s++) {
              const shard = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.15, 0.4), rr(0.12, 0.35)), mats.glassBroken);
              shard.position.set(xin(0.42), rr(0.5, 0.3 + oh), bz + rr(-bw * 0.42, bw * 0.42));
              shard.rotation.set(0, faceRot, rr(-0.6, 0.6));
              shard.castShadow = false;
              statics.add(shard);
            }
          }
        } else {
          // open front: shelves + warm interior
          meshBox(0.36, 0.06, bw - 0.5, mats.wood, xin(0.34), 1.25, bz, 0, { uv: 1.0, cast: false });
          meshBox(0.36, 0.06, bw - 0.5, mats.wood, xin(0.34), 1.95, bz, 0, { uv: 1.0, cast: false });
          meshBox(0.3, 0.03, bw - 0.6, mats.wood, xin(0.36), 2.6, bz, 0, { uv: 1.0, cast: false });
          const warm = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.55, 0.9), mats.windowLitDim);
          warm.position.set(xin(0.55), 2.35, bz);
          warm.rotation.y = faceRot;
          statics.add(warm);
          // counter
          meshBox(0.5, 0.9, bw * 0.5, mats.wood, xin(0.3), 0.75, bz + bw * 0.18, 0, { uv: 1.2 });
          lightPool(side * (OUT - 1.0), bz, 1.5, 0.18);
          if (shopLights < 3 && rnd() < 0.3) {
            shopLights++;
            const pl = new THREE.PointLight(0xffa055, 3.2, 6.5, 2);
            pl.position.set(side * (OUT - 0.7), 2.3, bz);
            dynamic.add(pl);
          }
        }
        // half-lowered roller shutter housing + panel
        if (rnd() < 0.6) {
          meshBox(0.34, 0.5, bw + 0.16, mats.shop, xf(0.05), gh - 0.72, bz, 0, { uv: 1.6 });
          const drop = rr(0.5, 1.8);
          meshBox(0.06, drop, bw, mats.shop, xf(0.1), gh - 0.95 - drop / 2, bz, 0, { uv: 1.2 });
        }
        // awning: sloped canvas + valance + two short wall brackets
        if (rnd() < 0.55) {
          const awMat = rnd() < 0.62 ? mats.awning : mats.burlap;
          const depth = rr(0.95, 1.25);
          const tilt = rr(0.14, 0.22);
          const aw = meshBox(depth, 0.06, bw + 0.35, awMat, xf(depth * 0.52), gh - 0.72, bz, 0, {
            uv: 0.95, rz: side * tilt, cast: true,
          });
          aw.position.y = gh - 0.78;
          // scalloped valance hanging off the front edge
          meshBox(0.05, rr(0.18, 0.28), bw + 0.35, mats.burlap, xf(depth - 0.04), gh - 1.02, bz, 0, { uv: 0.8, cast: false });
          // front rail + diagonal braces make the canopy read as supported
          meshBox(0.05, 0.05, bw + 0.35, mats.rust, xf(depth - 0.04), gh - 0.86, bz, 0, { uv: 0.5, cast: false });
          for (const sgn of [-1, 1]) {
            meshBox(depth * 0.85, 0.05, 0.05, mats.rust, xf(depth * 0.45), gh - 0.9, bz + sgn * (bw / 2 - 0.25), 0, { uv: 0.5, cast: false });
            const br = new THREE.Mesh(new THREE.BoxGeometry(depth * 1.0, 0.04, 0.04), mats.rust);
            br.position.set(xf(depth * 0.46), gh - 1.02, bz + sgn * (bw / 2 - 0.28));
            br.rotation.z = side * 0.75;
            statics.add(br);
          }
          addGrime(side, xf(0.05), gh - 1.25, bz, bw * 0.9, 0.55);
        }
        // sign board above the shopfront
        const sm = pick([mats.signA, mats.signB, mats.signC]);
        wallSign(side, bz, gh - 0.05, Math.min(bw, 3.4), 0.8, sm, 0.12);
        meshBox(0.2, 0.06, bw + 0.24, mats.metalTan, xf(0.13), gh + 0.4, bz, 0, { uv: 1.2, cast: false });
        addGrime(side, xf(0.06), gh + 0.36, bz, bw * 0.9, 0.5);
        // step
        meshBox(0.9, 0.14, bw + 0.4, mats.concrete, xf(0.35), 0.07, bz, 0, { uv: 1.4, cast: false });
        // entrance trash / crates
        if (rnd() < 0.5) addTrashPile(bz + rr(-1, 1), side);
      } else if (kind === 'shutter') {
        // full roller shutter
        meshBox(0.1, 2.95, bw, mats.shop, xf(0.09), 1.55, bz, 0, { uv: 1.9 });
        meshBox(0.26, 0.36, bw + 0.2, mats.shop, xf(0.08), gh - 0.78, bz, 0, { uv: 1.6 });
        for (const sgn of [-1, 1]) {
          meshBox(0.16, 3.1, 0.13, mats.rust, xf(0.06), 1.55, bz + sgn * (bw / 2 + 0.06), 0, { uv: 0.9, cast: false });
        }
        // sign + awning
        wallSign(side, bz, gh - 0.05, Math.min(bw, 3.2), 0.82, pick([mats.signB, mats.signC]), 0.12);
        if (rnd() < 0.4) {
          meshBox(1.05, 0.06, bw + 0.25, mats.awning, xf(0.5), gh - 1.42, bz, 0, { uv: 0.95, rz: side * 0.17 });
          meshBox(0.05, 0.2, bw + 0.25, mats.burlap, xf(1.0), gh - 1.62, bz, 0, { uv: 0.8, cast: false });
        }
        // graffiti decals on the shutter
        const gdec = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.8, 1.4), mats.graffiti);
        gdec.position.set(xf(0.05), 1.35, bz);
        gdec.rotation.set(0, faceRot, rr(-0.06, 0.06));
        statics.add(gdec);
        // trash in front
        if (rnd() < 0.6) addTrashPile(bz, side);
      } else if (kind === 'cafe') {
        // small open-front cafe: dark room + warm counter light + awning
        const oh = 2.75;
        const cav = new THREE.Mesh(new THREE.BoxGeometry(0.55, oh, bw), mats.interior);
        cav.position.set(xin(0.29), oh / 2 + 0.2, bz);
        cav.castShadow = false;
        statics.add(cav);
        meshBox(0.5, 0.5, bw + 0.1, mats.concreteDark, xin(0.28), 0.25, bz, 0, { uv: 1.6 });
        const warm = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.66, 1.15), mats.windowLitDim);
        warm.position.set(xin(0.53), 1.95, bz);
        warm.rotation.y = faceRot;
        statics.add(warm);
        meshBox(0.42, 0.95, bw * 0.62, mats.wood, xin(0.3), 0.78, bz, 0, { uv: 1.1 });
        meshBox(0.36, 0.06, bw * 0.62, mats.wood, xin(0.3), 1.28, bz, 0, { uv: 1.0, cast: false });
        for (const sgn of [-1, 1]) meshBox(0.2, oh, 0.14, mats.metal, xin(0.27), oh / 2 + 0.2, bz + sgn * (bw / 2 - 0.07), 0, { uv: 0.9 });
        meshBox(0.6, 0.12, bw + 0.1, mats.metalTan, xin(0.24), oh + 0.16, bz, 0, { uv: 0.9, cast: false });
        // canvas awning + sign
        meshBox(1.1, 0.06, bw + 0.3, mats.awning, xf(0.5), oh + 0.05, bz, 0, { uv: 0.9, rz: side * 0.2 });
        meshBox(0.05, 0.22, bw + 0.3, mats.burlap, xf(1.02), oh - 0.14, bz, 0, { uv: 0.8, cast: false });
        for (const sgn of [-1, 1]) {
          meshBox(0.95, 0.045, 0.045, mats.rust, xf(0.5), oh - 0.12, bz + sgn * (bw / 2 - 0.2), 0, { uv: 0.5, cast: false });
        }
        wallSign(side, bz, oh + 0.62, Math.min(bw, 2.8), 0.62, pick([mats.signA, mats.signC]), 0.1);
        lightPool(side * (OUT - 1.1), bz, 1.6, 0.2);
        if (shopLights < 4 && rnd() < 0.5) {
          shopLights++;
          const pl = new THREE.PointLight(0xffa055, 3.4, 7, 2);
          pl.position.set(side * (OUT - 0.85), 2.4, bz);
          dynamic.add(pl);
        }
        // stools / crates outside
        if (rnd() < 0.7) {
          crate(bz * 0 + side * (OUT - 1.35), bz - bw * 0.32, 0.55, rnd(), 0.16);
          crate(side * (OUT - 1.55), bz + bw * 0.28, 0.48, rnd(), 0.14);
        }
        if (rnd() < 0.6) addTrashPile(bz + bw * 0.42, side, 0.9);
      } else if (kind === 'door') {
        // steel door recessed with steps
        const oh = 2.5;
        const cavity = new THREE.Mesh(new THREE.BoxGeometry(0.34, oh, 1.5), mats.interior);
        cavity.position.set(xin(0.17), oh / 2 + 0.3, bz);
        cavity.castShadow = false;
        statics.add(cavity);
        meshBox(0.1, 2.25, 1.2, mats.metal, xin(0.28), 1.42, bz, 0, { uv: 1.0 });
        for (let d = 0; d < 4; d++) meshBox(0.11, 0.28, 1.22, mats.metalTan, xin(0.28), 0.4 + d * 0.55, bz, 0, { uv: 0.8, cast: false });
        meshBox(0.14, 0.1, 1.36, mats.concreteDark, xin(0.24), 2.58, bz, 0, { uv: 0.8, cast: false });
        meshBox(1.05, 0.13, 1.85, mats.concrete, xf(0.28), 0.065, bz, 0, { uv: 1.2, cast: false });
        meshBox(0.55, 0.13, 1.5, mats.concrete, xf(0.55), 0.19, bz, 0, { uv: 1.0, cast: false });
        meshBox(0.55, 0.12, 1.6, mats.concreteDark, xf(0.28), 0.28, bz, 0, { uv: 1.0, cast: false });
        // canopy
        meshBox(0.95, 0.09, 1.5, mats.metal, xf(0.38), 3.05, bz, 0, { uv: 1.0, rz: side * 0.12 });
        // lamp + meter box + conduit
        meshBox(0.24, 0.16, 0.14, mats.metalTan, xf(0.14), 2.95, bz + 0.95, 0, { uv: 0.7 });
        meshBox(0.34, 0.46, 0.22, mats.metal, xf(0.1), 1.5, bz - 1.05, 0, { uv: 0.8 });
        meshCyl(0.03, 0.03, 3.0, 5, mats.rubber, xf(0.08), 1.5, bz - 1.2, { cast: false });
        addGrime(side, xf(0.05), 2.6, bz, 1.5, 0.7);
        if (rnd() < 0.5) addSandbags(bz - 1.4, side, 2, 2, 0.2);
      } else if (kind === 'ruin') {
        // collapsed frontage: exposed brick + rubble
        meshBox(0.35, 3.6, bw, mats.brick, side * (OUT + 0.32), 1.8, bz, 0, { uv: 1.6 });
        for (let k = 0; k < 5; k++) {
          meshBox(0.4, rr(0.25, 0.8), rr(0.3, 0.9), mats.concreteDark, side * (OUT + 0.28), rr(0.2, 2.3), bz + rr(-bw * 0.4, bw * 0.4), rr(-0.3, 0.3), { uv: 1.2 });
        }
        addRubble(bz, side * 9.3, 1.6, 18);
      } else {
        // blank wall: plaster, posters, graffiti, pipes
        for (let q = 0; q < 3; q++) {
          const po = new THREE.Mesh(
            new THREE.PlaneGeometry(rr(0.42, 0.7), rr(0.55, 0.9)),
            q === 1 ? mats.paper : pick([mats.signC, mats.signA, mats.signB])
          );
          po.position.set(xf(0.04), rr(1.5, 2.3), bz + rr(-1.1, 1.1));
          po.rotation.set(0, faceRot, rr(-0.08, 0.08));
          po.castShadow = false;
          statics.add(po);
        }
        // torn flyers on the plinth
        for (let q = 0; q < 2; q++) {
          const fl = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.2, 0.34), rr(0.26, 0.4)), mats.paper);
          fl.position.set(xf(0.03), rr(0.7, 1.1), bz + rr(-1.2, 1.2));
          fl.rotation.set(0, faceRot, rr(-0.25, 0.25));
          statics.add(fl);
        }
        const gdec = new THREE.Mesh(new THREE.PlaneGeometry(bw * 0.7, 1.1), mats.graffiti);
        gdec.position.set(xf(0.03), 1.15, bz);
        gdec.rotation.set(0, faceRot, rr(-0.1, 0.1));
        statics.add(gdec);
        meshCyl(0.05, 0.05, 3.2, 6, mats.rust, xf(0.06), 1.6, bz + bw * 0.35, { cast: false });
        addGrime(side, xf(0.02), 1.0, bz, bw * 0.8, 1.6);
        if (rnd() < 0.5) addWeeds(side * 9.3, bz + rr(-1, 1), 3);
      }
    }
    // a blade sign sticking out over the sidewalk, occasionally
    if (rnd() < 0.5) {
      const bz = z0 + len * rr(0.25, 0.75);
      bladeSign(side, bz, gh + 1.35, 1.3, 0.6, pick([mats.signA, mats.signB, mats.signC]));
    }
  }

  /* ---- roof clutter ------------------------------------------------------ */
  function buildRoof(side, z0, z1, h, def) {
    const len = z1 - z0, zc = (z0 + z1) / 2;
    const pf = 0.36;
    const ruin = def.detail === 'ruin';

    // parapet walls with coping
    const segs = Math.max(2, Math.round(len / 2.6));
    for (let s = 0; s < segs; s++) {
      const sz = z0 + (s + 0.5) * (len / segs);
      const broken = ruin && rnd() < 0.55;
      if (broken) continue;
      const ph = 0.82 + (rnd() - 0.5) * 0.22;
      meshBox(pf, ph, len / segs - 0.03, mats.concreteDark, side * (OUT + 0.26), h + ph / 2, sz, 0, { uv: 1.8 });
      meshBox(pf + 0.16, 0.1, len / segs - 0.03, mats.concrete, side * (OUT + 0.26), h + ph + 0.04, sz, 0, { uv: 1.4, cast: false });
    }
    // side parapets
    for (const zz of [z0 + 0.18, z1 - 0.18]) {
      meshBox(2.4, 0.6, pf, mats.concreteDark, side * (OUT + 1.3), h + 0.3, zz, 0, { uv: 1.6, cast: false });
    }

    // stair bulkhead
    if (rnd() < 0.8 && !ruin) {
      const bx = side * (OUT + rr(2.4, 3.6)), bz = zc + rr(-len * 0.25, len * 0.25);
      meshBox(2.3, 2.35, 2.6, mats.plasterB, bx, h + 1.17, bz, rr(-0.1, 0.1), { uv: 3.0 });
      meshBox(2.5, 0.14, 2.8, mats.concreteDark, bx, h + 2.4, bz, 0, { uv: 1.6, cast: false });
      meshBox(0.08, 1.7, 0.85, mats.metal, bx - side * 1.17, h + 0.85, bz, 0, { uv: 0.9, cast: false });
      meshBox(0.1, 1.1, 0.7, mats.metalTan, bx + side * 0.2, h + 1.5, bz + 1.31, 0, { uv: 0.8, cast: false });
      // rooftop water tank
      if (rnd() < 0.6) {
        const tx = side * (OUT + rr(5.2, 6.6)), tz = zc + rr(-len * 0.3, len * 0.3);
        meshCyl(0.82, 0.86, 1.55, 12, mats.metal, tx, h + 0.95, tz);
        meshCyl(0.05, 0.92, 0.5, 12, mats.metalTan, tx, h + 1.95, tz);
        for (let l = 0; l < 4; l++) {
          const a = (l / 4) * Math.PI * 2 + 0.4;
          meshBox(0.09, 0.5, 0.09, mats.rust, tx + Math.cos(a) * 0.6, h + 0.25, tz + Math.sin(a) * 0.6, 0, { uv: 0.6, cast: false });
        }
        meshCyl(0.03, 0.03, 2.2, 4, mats.rust, tx + 0.4, h + 0.6, tz, { cast: false });
      }
    }
    // AC condensers + satellite dishes + antennas
    for (let k = 0; k < 2; k++) {
      const ax = side * (OUT + rr(1.4, 4.5)), az = zc + rr(-len * 0.35, len * 0.35);
      meshBox(0.8, 0.72, 1.05, mats.metal, ax, h + 0.36, az, rr(0, 1.5), { uv: 1.2 });
      const fan = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 5, 12), mats.rust);
      fan.rotation.y = Math.PI / 2;
      fan.position.set(ax + side * 0.42, h + 0.38, az);
      statics.add(fan);
    }
    if (rnd() < 0.7) {
      const dx = side * (OUT + rr(1.8, 3.5)), dz = zc + rr(-len * 0.3, len * 0.3);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42), mats.metalTan);
      dish.rotation.set(Math.PI * 0.62, rr(0, 6), 0);
      dish.position.set(dx, h + 0.85, dz);
      dish.castShadow = true;
      statics.add(dish);
      meshCyl(0.04, 0.05, 1.0, 5, mats.rust, dx, h + 0.5, dz, { cast: false });
    }
    // antenna mast + wires
    meshCyl(0.025, 0.04, rr(2.5, 4.5), 5, mats.metal, side * (OUT + rr(2, 4)), h + 1.2, zc + rr(-len * 0.3, len * 0.3), { cast: false });
    // rooftop laundry + sandbags
    if (!ruin && rnd() < 0.55) {
      const lz = zc + rr(-len * 0.25, len * 0.25);
      const x1 = side * (OUT + 1.1), x2 = side * (OUT + 4.2), ly = h + 1.9;
      cableLine(new THREE.Vector3(x1, ly, lz), new THREE.Vector3(x2, ly - 0.15, lz + rr(-1, 1)), 0.25, 0.012);
      for (let c = 0; c < 3; c++) {
        addLaundryCloth((x1 + x2) / 2 + rr(-1.2, 1.2), ly - 0.04, lz + rr(-0.3, 0.3), side, true);
      }
    }
    if (!ruin && rnd() < 0.5) {
      for (let b = 0; b < 4; b++) {
        meshRound(0.62, 0.24, 0.34, 0.09, mats.sandbag, side * (OUT + 0.55), h + 0.98 + (b % 2) * 0.2, zc + rr(-len * 0.3, len * 0.3), rr(-0.2, 0.2), { uv: 0.8 });
      }
    }
    if (ruin) {
      // hanging rebar + broken slabs
      for (let k = 0; k < 7; k++) {
        const l = rr(1, 3.4);
        meshCyl(0.018, 0.018, l, 4, mats.rust, side * (OUT - 0.3 + rr(-0.4, 0.4)), h - l / 2 + 0.1, zc + rr(-len * 0.45, len * 0.45), {
          rx: rr(-0.3, 0.3), rz: rr(-0.35, 0.35), cast: false,
        });
      }
      for (let k = 0; k < 4; k++) {
        meshBox(rr(2, 4), 0.22, rr(1.4, 2.6), mats.concreteDark, side * (OUT + rr(1.5, 4)), h + 0.2 + k * 0.0, zc + rr(-len * 0.4, len * 0.4), rr(-0.4, 0.4), { uv: 1.8 });
      }
    }
  }

  /** wall-mounted sign board: metal backing + one-tile printed face */
  function wallSign(side, bz, y, w, hh, mat, out = 0.12) {
    meshBox(0.1, hh + 0.08, w + 0.1, mats.metalTan, side * (OUT - out + 0.02), y, bz, 0, { uv: 0.9, cast: false });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mat);
    face.position.set(side * (OUT - out - 0.04), y, bz);
    face.rotation.y = -side * Math.PI / 2;
    face.castShadow = false;
    statics.add(face);
    return face;
  }

  /** projecting blade sign (two printed faces + metal frame) */
  function bladeSign(side, bz, y, w, hh, mat) {
    const cx = side * (OUT - w / 2 - 0.15);
    meshBox(w, hh + 0.07, 0.09, mats.metalTan, cx, y, bz, 0, { uv: 0.9, cast: true });
    for (const fz of [-0.052, 0.052]) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.08, hh - 0.04), mat);
      f.position.set(cx, y, bz + fz);
      if (fz < 0) f.rotation.y = Math.PI;
      statics.add(f);
    }
    meshBox(w * 0.7, 0.05, 0.05, mats.rust, side * (OUT - w * 0.35 - 0.05), y + hh / 2 + 0.06, bz, 0, { uv: 0.5, cast: false });
    meshBox(0.05, 0.34, 0.05, mats.rust, side * (OUT - 0.05), y + hh / 2 - 0.1, bz, 0, { uv: 0.5, cast: false });
  }

  /* ---- wall services: downpipes, cables, grime bands -------------------- */
  function buildWallServices(side, z0, z1, h, gh, def) {
    const len = z1 - z0;
    const xf = (d) => side * (OUT - d);
    // corner downpipes
    for (const zz of [z0 + 0.22, z1 - 0.22]) {
      meshCyl(0.046, 0.046, h - 0.4, 6, mats.rust, xf(0.07), (h - 0.4) / 2, zz, { cast: false });
      meshCyl(0.06, 0.052, 0.24, 6, mats.rust, xf(0.075), 0.72, zz, { cast: false });
      for (let b = 0; b < Math.floor(h / 4); b++) {
        meshBox(0.07, 0.06, 0.2, mats.metal, xf(0.06), 2.5 + b * 4.2, zz, 0, { uv: 0.5, cast: false });
      }
    }
    // horizontal drain + conduit on the wall
    meshCyl(0.045, 0.045, len - 0.6, 6, mats.rust, xf(0.09), gh + 0.55, z0 + len / 2, { rz: Math.PI / 2, cast: false });
    for (let k = 0; k < Math.floor(len / 5); k++) {
      meshCyl(0.028, 0.028, h * 0.55, 5, mats.rubber, xf(0.07), h * 0.5, z0 + 1.4 + k * 4.6, { cast: false });
    }
    // electric junction boxes
    for (let k = 0; k < 2; k++) {
      const bz = z0 + rr(1.5, len - 1.5);
      meshBox(0.2, 0.3, 0.24, mats.metalTan, xf(0.1), gh + rr(0.8, 2.2), bz, 0, { uv: 0.6, cast: false });
    }
    // base splash band
    addGrimeBand(side, z0 + 0.3, z1 - 0.3, 0.55, 0.75);
    // long vertical damp streaks from the parapet
    for (let k = 0; k < 3; k++) {
      addGrime(side, xf(0.02), rr(2, h - 2), z0 + rr(1, len - 1), rr(0.7, 1.6), rr(1.5, 3.5));
    }
    // wall lamp
    if (rnd() < 0.5) {
      const bz = z0 + len * rr(0.2, 0.8);
      meshBox(0.5, 0.06, 0.06, mats.rust, xf(0.25), gh + 0.9, bz, 0, { uv: 0.5, cast: false });
      meshBox(0.3, 0.14, 0.2, mats.metalTan, xf(0.5), gh + 0.83, bz, 0, { uv: 0.6 });
    }
  }

  function addGrimeBand(side, z0, z1, y, height) {
    const len = z1 - z0;
    if (len < 0.4) return;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(len, height), mats.grime);
    g.position.set(side * (OUT - 0.012), y + height / 2, z0 + len / 2);
    g.rotation.y = -side * Math.PI / 2;
    g.castShadow = false;
    statics.add(g);
  }
  function addGrime(side, x, y, z, w, hh) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mats.grime);
    g.position.set(x, y, z);
    g.rotation.y = -side * Math.PI / 2;
    g.castShadow = false;
    statics.add(g);
  }

  /* ------------------------------------------------------------------ alley */
  function buildAlley() {
    const z0 = 0, z1 = 6;
    const xEnd = -22.6;
    // floor (dirt / cracked concrete)
    meshBox(13.0, 0.12, 6.0, mats.concreteDark, -16.3, 0.06, 3.0, 0, { uv: 2.0, cast: false });
    // drainage channel + grate
    meshBox(0.32, 0.06, 5.6, mats.patch, -16.3, 0.13, 3.0, 0, { uv: 1.0, cast: false });
    for (let i = 0; i < 7; i++) meshBox(0.26, 0.03, 0.05, mats.metal, -16.3, 0.17, 0.5 + i * 0.8, 0, { cast: false });
    // Season 3: the dead-end wall becomes a 6 m gate into the old souk.
    // A lintel + two pier stubs keep the alley reading as a gate, not a hole.
    meshBox(0.6, 0.8, 6.6, mats.plasterB, xEnd, 3.85, 3.0, 0, { uv: 2.2, cast: false });
    meshBox(0.36, 0.12, 6.7, mats.concrete, xEnd, 4.3, 3.0, 0, { uv: 1.6, cast: false });
    for (const zz of [0.0, 6.0]) {
      meshBox(0.58, 4.2, 0.36, mats.plasterB, xEnd, 2.1, zz, 0, { uv: 2.0, collide: true });
      meshBox(0.7, 0.12, 0.5, mats.concrete, xEnd, 4.24, zz, 0, { uv: 1.0, cast: false });
    }
    meshBox(0.4, 0.16, 6.0, mats.concreteDark, xEnd, 0.08, 3.0, 0, { uv: 1.4, cast: false });
    // service strip / connector ground behind the gate
    meshBox(8.4, 0.04, 14.0, mats.dirt, -26.4, 0.01, 2.0, 0, { uv: 2.6, cast: false });
    meshBox(1.8, 0.05, 6.0, mats.asphalt, -22.9, 0.03, 3.0, 0, { uv: 1.6, cast: false });
    const al = new THREE.PointLight(0xffa055, 2.6, 7, 2);
    al.position.set(xEnd + 0.9, 1.9, 4.6);
    dynamic.add(al);
    lightPool(xEnd + 1.1, 4.6, 1.6, 0.2);
    // stairs down the alley end
    for (let s = 0; s < 3; s++) meshBox(1.6, 0.16, 1.1, mats.concrete, -21.2 + s * 0.2, 0.08 + s * 0.15, 4.6, 0, { uv: 1.0, cast: false });
    // graffiti + posters on both side walls
    for (let k = 0; k < 4; k++) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(rr(1.2, 2.2), rr(1.0, 1.8)), mats.graffiti);
      const zside = k % 2 ? z0 + 0.03 : z1 - 0.03;
      g.position.set(k % 2 ? rr(-21.5, -16.7) : rr(-21, -11), rr(0.8, 2.5), zside);
      g.rotation.set(0, k % 2 ? 0 : Math.PI, rr(-0.1, 0.1));
      statics.add(g);
    }
    // pipes running along the walls + dripping AC
    meshCyl(0.07, 0.07, 12, 6, mats.rust, -16.3, 3.2, z0 + 0.14, { rz: Math.PI / 2, cast: false });
    meshCyl(0.05, 0.05, 12, 6, mats.rubber, -16.3, 4.6, z1 - 0.14, { rz: Math.PI / 2, cast: false });
    for (let k = 0; k < 3; k++) {
      meshBox(0.5, 0.42, 0.62, mats.metal, -12 - k * 3.2, 5.4, z1 - 0.35, 0, { uv: 1.0, cast: false });
      addGrime(-1, -12 - k * 3.2, 4.6, z1 - 0.4, 0.7, 1.6, 0, Math.PI);
    }
    // wall-mounted service ladder (rails + rungs)
    for (const dz of [0.18, 0.86]) meshCyl(0.028, 0.028, 3.1, 5, mats.rust, -11.65, 4.1, z0 + dz, { cast: false });
    for (let r = 0; r < 9; r++) {
      meshBox(0.05, 0.035, 0.7, mats.rust, -11.65, 2.62 + r * 0.33, z0 + 0.52, 0, { uv: 0.4, cast: false });
    }
    dumpster(-10.4, 2.6, 1.62);
    pallet(-14.9, 1.3, 0.7);
    barrel(-19.9, 1.1);
    addTrashPile(1.2, -1, 1.1);
    addTrashPile(4.9, -1, 1.2);
    // overhead laundry line
    cableLine(new THREE.Vector3(-11.8, 4.15, 5.62), new THREE.Vector3(-20.6, 3.95, 5.55), 0.22, 0.014, mats.burlap);
    for (let c = 0; c < 4; c++) {
      addLaundryCloth(-13.2 - c * 1.7, 3.86, 5.52, -1, true);
    }
    // dumpster, crates, trash, tires, pallet
    dumpster(-15.2, 4.9, 1.55);
    addTrashPile(2.7, -1, 1.4);
    pallet(-17.6, 1.4, 1.2);
    crate(-18.8, 2.4, 0.9, 0.4);
    crate(-19.4, 3.1, 0.7, 1.1, 0.75);
    tireStack(-20.4, 5.2, 3);
    addRubble(-18.6, 5.2, 1.5, 22);
    addWeeds(-20.5, 1.4, 3);
    addWeeds(-11.5, 4.6, 3);
    addPuddles([[-14.2, 2.2, 1.1, 0.55], [-19.4, 4.6, 0.8, 0.5]]);
    // barred side windows + a big faded painted ad break up the blank alley wall
    for (const [wx2, wy2] of [[-18.6, 4.7], [-20.6, 7.4]]) {
      const cav2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.2, 1.0), mats.interior);
      cav2.position.set(wx2, wy2, z0 - 0.17);
      statics.add(cav2);
      const gl2 = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 1.1), mats.windowGlass);
      gl2.position.set(wx2, wy2, z0 - 0.05);
      statics.add(gl2);
      for (const dx of [-0.4, 0, 0.4]) meshBox(0.035, 1.2, 0.035, mats.rust, wx2 + dx, wy2, z0 + 0.03, 0, { uv: 0.4, cast: false });
      meshBox(1.2, 0.09, 0.2, mats.concrete, wx2, wy2 - 0.66, z0 + 0.05, 0, { uv: 0.8, cast: false });
      meshBox(1.2, 0.1, 0.18, mats.concreteDark, wx2, wy2 + 0.68, z0 + 0.05, 0, { uv: 0.8, cast: false });
      addGrime(-1, wx2, wy2 - 1.0, z0 + 0.005, 1.1, 0.9, 0, Math.PI);
    }
    const ad = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3), mats.signC);
    ad.position.set(-19.2, 2.5, z0 + 0.035);
    statics.add(ad);
    meshCyl(0.045, 0.045, 8.5, 6, mats.rust, -18.4, 0.9, z0 + 0.09, { rz: Math.PI / 2, cast: false });
    for (const zz of [-17.8, -20.4]) meshCyl(0.045, 0.045, 2.6, 6, mats.rust, zz, 1.3, z0 + 0.09, { cast: false });
  }

  /* ------------------------------------------------------------------ gatehouse */
  function buildGatehouse() {
    const z = -70, h = 15;
    for (const side of [-1, 1]) {
      const cx = side * 10.5, w = 9;
      if (side < 0) {
        // west block stays solid
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10), mats.plasterB);
        projectBoxUV(b.geometry, 3.4);
        b.position.set(cx, h / 2, z);
        b.castShadow = true; b.receiveShadow = true;
        statics.add(b);
        addCollider(cx, z, w, 10);
      }
      // parapet
      for (const dz of [-1, 1]) meshBox(w + 0.2, 0.8, 0.34, mats.concreteDark, cx, h + 0.4, z + dz * 4.8, 0, { uv: 1.6 });
      // facade panel facing the street
      meshPanel(w - 0.2, h - 1.2, 9.15, 9.75, rnd() * 1.4, 0.1, mats.facadeD, cx, h / 2 + 0.3, z + 5.02, 0);
      // firing slits + embrasures
      for (const yy of [4.2, 7.6, 11.2]) {
        for (let i = 0; i < 2; i++) {
          meshBox(1.35, 0.55, 0.36, mats.interior, cx - 2.4 + i * 4.8, yy, z + 5.16, 0, { uv: 0.6, cast: false });
          meshBox(1.5, 0.12, 0.5, mats.concreteDark, cx - 2.4 + i * 4.8, yy - 0.34, z + 5.2, 0, { uv: 0.6, cast: false });
        }
      }
      // sandbagged nest on top of the bridge
      for (let i = 0; i < 7; i++) {
        meshRound(0.62, 0.25, 0.34, 0.09, mats.sandbag, cx - 2.4 + (i % 4) * 0.64, h + 0.92 + Math.floor(i / 4) * 0.22, z + 4.55, rnd() * 0.2, { uv: 0.8 });
      }
      // yard-facing elevation: the checkpoint sees this side, so give it
      // window cavities instead of a bare box
      for (const yy of [3.6, 6.6, 9.8, 12.4]) {
        for (const dx of [-2.6, 1.4]) {
          meshBox(1.5, 1.15, 0.3, mats.interior, cx + dx, yy, z - 5.02, 0, { uv: 0.7, cast: false });
          meshBox(1.7, 0.12, 0.52, mats.concreteDark, cx + dx, yy - 0.64, z - 5.06, 0, { uv: 0.7, cast: false });
          meshBox(1.7, 0.16, 0.56, mats.concrete, cx + dx, yy + 0.66, z - 5.06, 0, { uv: 0.7, cast: false });
        }
      }
      // downpipe + a wall lamp over the gate side
      meshCyl(0.055, 0.055, h - 1.4, 5, mats.metal, cx - 4.1, (h - 1.4) / 2, z - 5.3);
      meshBox(0.26, 0.14, 0.2, mats.metalTan, cx + 3.8, 4.6, z - 5.2, 0, { uv: 0.6 });
    }
    /* ---- NORTH HQ: the east gatehouse block is hollow on the ground floor.
       Yard door (north) -> ops room -> partition -> commander office, plus a
       side door into the gate passage. Upper mass stays solid. ---- */
    function buildNorthHq() {
      const x0 = 6.15, x1 = 14.85, z0 = -74.9, z1 = -65.1;
      const cx = (x0 + x1) / 2;
      const fY = 0.16, cY = 3.2;          // ground-floor ceiling
      const upY = 6.4;                    // mezzanine ceiling
      const wallMat = mats.plasterC;

      roomFloor(x0, x1, z0, z1, fY, mats.concrete, 2.4);
      // mezzanine slab over the office half (visual; walk height comes from
      // ROOF_ZONES at 3.2) + upper ceiling and the solid mass above it
      meshBox(x1 - x0 - 0.3, 0.2, 5.9, mats.concreteDark, cx, cY, -68.15, 0, { uv: 2.4, cast: false });
      meshBox(x1 - x0 - 0.3, 0.04, 5.9, mats.wood, cx, cY + 0.12, -68.15, 0, { uv: 1.8, cast: false });
      meshBox(x1 - x0, 0.24, z1 - z0, mats.concreteDark, cx, upY, (z0 + z1) / 2, 0, { uv: 2.4, cast: false });
      meshBox(x1 - x0 + 0.3, 8.4, z1 - z0 + 0.3, mats.plasterB, cx, upY + 4.3, (z0 + z1) / 2, 0, { uv: 3.0 });

      // outer walls with openings
      wallWithHoles('z', -75.12, -74.88, x0, x1, fY, cY, [
        { a0: 9.55, a1: 11.25, y0: fY, y1: 2.42 },
      ], wallMat, { uv: 2.2 });
      wallWithHoles('z', -65.12, -64.88, x0, x1, fY, cY, [], wallMat, { uv: 2.2 });
      wallWithHoles('x', 6.0, 6.3, z0, z1, fY, cY, [
        { a0: -70.7, a1: -69.1, y0: fY, y1: 2.35 },
      ], wallMat, { uv: 2.2 });
      wallWithHoles('x', 14.7, 15.0, z0, z1, fY, cY, [], wallMat, { uv: 2.2 });
      addColliderRect(14.7, 15.0, z0, z1, cY);
      addColliderRect(6.0, 6.3, -74.9, -70.7, cY);
      addColliderRect(6.0, 6.3, -69.1, -65.1, cY);

      // upper storey shell: same footprint, windows over the yard and street
      wallWithHoles('z', -75.12, -74.88, x0, x1, cY, upY, [
        { a0: 7.15, a1: 8.65, y0: 3.7, y1: 4.9 },
        { a0: 11.15, a1: 12.65, y0: 3.7, y1: 4.9 },
      ], wallMat, { uv: 2.2, collide: false });
      wallWithHoles('z', -65.12, -64.88, x0, x1, cY, upY, [
        { a0: 10.9, a1: 12.5, y0: 4.2, y1: 5.4 },
      ], wallMat, { uv: 2.2, collide: false });
      wallWithHoles('x', 6.0, 6.3, z0, z1, cY, upY, [], wallMat, { uv: 2.2, collide: false });
      wallWithHoles('x', 14.7, 15.0, z0, z1, cY, upY, [], wallMat, { uv: 2.2, collide: false });

      // partition: ops room | commander office, with a 1.5 m door
      wallWithHoles('z', -70.2, -69.9, x0, x1, fY, cY, [
        { a0: 9.9, a1: 11.5, y0: fY, y1: 2.3 },
      ], wallMat, { uv: 2.0 });
      doorFrame('z', -70.2, -69.9, 9.9, 11.5, fY, 2.3, mats.wood);
      thresholdStrip('z', -70.2, -69.9, 9.9, 11.5, fY, mats.concreteDark);

      // frame + open leaf on the gate-side door, frame on the yard door
      doorFrame('x', 6.0, 6.3, -70.7, -69.1, fY, 2.35, mats.metalTan);
      thresholdStrip('x', 6.0, 6.3, -70.7, -69.1, fY, mats.concreteDark);
      openDoorLeaf(6.26, -70.66, 0.9, 2.2, fY, -2.2, mats.metal);
      doorFrame('z', -75.12, -74.88, 9.55, 11.25, fY, 2.42, mats.metal);
      thresholdStrip('z', -75.12, -74.88, 9.55, 11.25, fY, mats.concreteDark);

      // the breach door: closed until the player holds E
      const doorMesh = new THREE.Mesh(new THREE.BoxGeometry(1.68, 2.28, 0.1), mats.metal);
      projectBoxUV(doorMesh.geometry, 1.2);
      doorMesh.position.set(10.4, fY + 1.14, -75.0);
      doorMesh.castShadow = true; doorMesh.receiveShadow = true;
      statics.add(doorMesh);
      const doorCol = addColliderRect(9.58, 11.22, -75.08, -74.92, 2.5);
      breachDoors.push({
        id: 'hq-entry', x: 10.4, z: -75.0,
        rect: [9.3, 11.5, -75.4, -74.6],
        opened: false,
        open() {
          if (this.opened) return false;
          this.opened = true;
          const i = colliders.indexOf(doorCol);
          if (i >= 0) colliders.splice(i, 1);
          doorMesh.visible = false;
          return true;
        },
      });

      // ---- ops room (north half)
      // radio wall panel (the old floor rack sat in the stair footprint)
      meshBox(0.1, 1.5, 2.0, mats.metal, 6.36, 1.45, -72.6, 0, { uv: 1.0, cast: false });
      meshBox(0.04, 1.2, 1.7, mats.interior, 6.43, 1.5, -72.6, 0, { uv: 0.8, cast: false });
      meshBox(2.6, 0.08, 1.0, mats.wood, 7.9, 1.0, -72.3, 0, { uv: 1.0 });
      for (const [lx, lz] of [[6.9, -72.3], [8.9, -72.3]]) meshBox(0.1, 0.92, 0.9, mats.metal, lx, 0.5, lz, 0, { uv: 0.6 });
      addCollider(7.9, -72.3, 2.7, 1.1, 0.05, 1.0);
      meshBox(1.1, 1.0, 0.9, mats.wood, 7.0, 0.5, -73.9, 0.2, { collide: true, uv: 1.0 });
      meshBox(0.9, 0.7, 0.8, mats.wood, 7.9, 0.35, -74.1, -0.15, { collide: true, uv: 0.9 });
      for (let i = 0; i < 6; i++) {
        meshRound(0.6, 0.24, 0.34, 0.09, mats.sandbag, 7.1 + (i % 3) * 0.62, 0.14, -74.25, 0, { uv: 0.8 });
      }
      addCollider(7.8, -74.25, 1.9, 0.7, 0.05, 0.9);
      meshBox(0.9, 0.55, 0.4, mats.metalTan, 8.4, 1.2, -70.4, 0, { uv: 0.8 });

      // ---- commander office (south half)
      meshBox(2.0, 0.82, 0.95, mats.wood, 12.7, 0.57, -67.2, 0, { uv: 1.2 });
      meshBox(2.06, 0.06, 1.0, mats.metal, 12.7, 1.0, -67.2, 0, { uv: 0.8, cast: false });
      addCollider(12.7, -67.2, 2.1, 1.05, 0.05, 1.05);
      meshBox(0.55, 1.0, 0.55, mats.rubber, 12.7, 0.5, -68.1, 0, { uv: 0.8 });
      meshBox(1.9, 0.75, 1.1, mats.wood, 8.2, 0.53, -67.0, 0.05, { uv: 1.1 });   // map table
      addCollider(8.2, -67.0, 2.0, 1.2, 0.05, 1.0);
      meshBox(0.8, 1.3, 0.7, mats.metal, 14.1, 0.81, -68.7, 0, { collide: true, uv: 1.0 });  // safe
      meshBox(0.75, 1.15, 0.6, mats.metal, 14.05, 0.73, -66.2, 0, { collide: true, uv: 1.0 }); // filing
      meshBox(0.75, 1.15, 0.6, mats.metal, 14.05, 0.73, -65.6, 0, { collide: true, uv: 1.0 });
      meshBox(2.2, 0.04, 1.4, mats.burlap, 11.0, fY + 0.03, -67.2, 0, { uv: 1.0, cast: false });
      for (const [rx, rz, rw, rd] of [[11.0, -66.48, 2.26, 0.06], [11.0, -67.92, 2.26, 0.06], [9.88, -67.2, 0.06, 1.5], [12.12, -67.2, 0.06, 1.5]]) {
        meshBox(rw, 0.05, rd, mats.concreteDark, rx, fY + 0.04, rz, 0, { uv: 0.8, cast: false });
      }

      // wall dressing: boards, a clock, campaign map
      meshBox(1.6, 1.0, 0.06, mats.signB, 8.4, 2.1, -65.2, 0, { uv: 0.8, cast: false });
      meshBox(1.1, 0.8, 0.05, mats.signA, 12.4, 2.2, -70.16, 0, { uv: 0.7, cast: false });
      meshBox(0.42, 0.42, 0.05, mats.interior, 10.3, 2.6, -74.94, 0, { uv: 0.5, cast: false });

      // lights: two warm interior lamps + red emergency over the breach door
      interiorLamp(8.6, 3.1, -72.6, 5.4);
      interiorLamp(12.2, 3.1, -67.4, 4.8);
      meshBox(0.3, 0.12, 0.18, mats.windowLit, 10.4, 2.85, -74.86, 0, { uv: 0.5, cast: false });
      lightPool(10.4, -74.4, 1.6, 0.22, 0xff6b4a);

      // ---- interior dressing: light panels, pipes, boards, monitors
      for (const [fx, fz] of [[8.9, -72.6], [12.3, -72.4], [11.2, -67.6], [8.2, -67.2]]) {
        meshBox(1.5, 0.06, 0.34, mats.windowLit, fx, 3.28, fz, 0, { uv: 0.7, cast: false });
        meshBox(1.6, 0.05, 0.44, mats.metalTan, fx, 3.24, fz, 0, { uv: 0.6, cast: false });
      }
      // suspended ceiling panels knock the black slab back
      for (const [px, pz, pw, pd] of [[7.9, -72.4, 3.0, 3.4], [11.6, -72.2, 2.6, 3.2], [11.2, -67.4, 4.2, 3.0]]) {
        meshBox(pw, 0.03, pd, mats.plasterB, px, 3.33, pz, 0, { uv: 2.0, cast: false });
      }
      // skirting + a service pipe run
      for (const [sx, sz, sw, sd] of [[10.5, -74.82, 8.5, 0.06], [10.5, -65.16, 8.5, 0.06], [6.34, -70, 0.06, 9.7], [14.66, -70, 0.06, 9.7]]) {
        meshBox(sw, 0.2, sd, mats.concreteDark, sx, 0.27, sz, 0, { uv: 1.2, cast: false });
      }
      meshCyl(0.06, 0.06, 8.4, 6, mats.rust, 10.5, 3.18, -74.6, { rz: Math.PI / 2 });
      meshCyl(0.045, 0.045, 8.4, 6, mats.metal, 12.9, 3.12, -70.6, { rz: Math.PI / 2 });

      // ops room: monitors, map board, papers
      const monitor = (x, y, z, rot, w = 0.62, h = 0.4) => {
        meshBox(w, h, 0.06, mats.interior, x, y, z, rot, { uv: 0.6, cast: false });
        meshBox(w - 0.06, h - 0.06, 0.02, mats.windowGlass, x, y, z + 0.04, rot, { uv: 0.5, cast: false });
        meshBox(0.1, 0.1, 0.12, mats.metal, x, y - h / 2 - 0.05, z, rot, { uv: 0.4, cast: false });
      };
      monitor(6.46, 1.5, -72.3, Math.PI / 2, 0.7, 0.42);
      monitor(6.46, 1.5, -73.0, Math.PI / 2, 0.7, 0.42);
      meshBox(1.8, 1.05, 0.05, mats.signA, 6.36, 1.95, -72.4, Math.PI / 2, { uv: 0.8, cast: false });
      meshBox(0.9, 0.65, 0.05, mats.signB, 6.36, 1.9, -71.2, Math.PI / 2, { uv: 0.7, cast: false });
      for (let i = 0; i < 5; i++) {
        meshPlane(0.28, 0.2, mats.paper || mats.signA, 10.4 + (i % 3) * 0.42, 1.045, -72.2 + Math.floor(i / 3) * 0.4,
          { rx: -Math.PI / 2, cast: false });
      }

      // office: desk monitor, papers, lamp, chair, map board
      monitor(12.7, 1.28, -67.05, 0, 0.66, 0.4);
      meshBox(0.16, 0.06, 0.16, mats.metalTan, 11.9, 1.04, -67.2, 0, { uv: 0.5, cast: false });
      meshCyl(0.03, 0.03, 0.62, 5, mats.metal, 11.9, 1.35, -67.2, { cast: false });
      meshBox(0.22, 0.1, 0.14, mats.windowLit, 11.9, 1.68, -67.2, 0, { uv: 0.4, cast: false });
      for (let i = 0; i < 3; i++) {
        meshPlane(0.24, 0.16, mats.signA, 12.2 + i * 0.3, 1.02, -67.5, { rx: -Math.PI / 2, cast: false });
      }
      meshBox(1.1, 0.7, 0.05, mats.signB, 10.2, 1.9, -65.2, 0, { uv: 0.7, cast: false });
      meshBox(0.5, 0.5, 0.5, mats.rubber, 12.7, 0.35, -66.2, 0.1, { uv: 0.7, cast: false });
      meshBox(0.52, 0.08, 0.52, mats.rubber, 12.7, 0.64, -66.2, 0.1, { uv: 0.6, cast: false });

      // red emergency strip over the breach door
      meshBox(0.9, 0.08, 0.08, mats.windowLit, 10.4, 2.92, -74.8, 0, { uv: 0.5, cast: false });

      // ---- ground-floor detail pass: lockers, cables, stencils, beams
      for (let i = 0; i < 3; i++) {
        meshBox(0.55, 1.8, 0.5, mats.metal, 6.62, 0.9, -66.4 - i * 0.62, 0, { collide: true, uv: 0.7 });
        meshBox(0.5, 0.04, 0.04, mats.rust, 6.62, 1.45, -66.4 - i * 0.62, 0, { uv: 0.4, cast: false });
      }
      meshBox(0.9, 0.55, 0.6, mats.wood, 6.9, 0.28, -74.2, 0, { collide: true, uv: 0.8 });
      meshBox(0.7, 0.45, 0.5, mats.wood, 7.7, 0.23, -74.3, 0.2, { collide: true, uv: 0.7 });
      for (const [cx2, cz2] of [[13.6, -73.9], [14.2, -73.5]]) {
        meshCyl(0.22, 0.22, 0.12, 10, mats.rubber, cx2, 0.08, cz2, { cast: false });
        meshCyl(0.14, 0.14, 0.1, 10, mats.rust, cx2, 0.16, cz2, { cast: false });
      }
      // cable runs along the ceiling and down the wall
      meshCyl(0.035, 0.035, 7.6, 5, mats.rubber, 10.6, 6.18, -69.9, { rz: Math.PI / 2, cast: false });
      meshCyl(0.03, 0.03, 3.0, 5, mats.rubber, 14.55, 4.7, -72.2, { cast: false });
      for (let i = 0; i < 4; i++) meshBox(0.06, 0.9, 0.06, mats.rust, 6.4, 6.1, -73.9 + i * 1.3, 0, { uv: 0.4, cast: false });
      // beams over the double-height ops room
      for (const bz of [-73.4, -71.8]) meshBox(8.4, 0.16, 0.2, mats.metal, 10.5, 6.22, bz, 0, { uv: 1.2, cast: false });
      // fluorescent strips high in the void
      for (const [fx, fz] of [[8.4, -73.0], [12.0, -72.8]]) {
        meshBox(1.6, 0.06, 0.2, mats.windowLit, fx, 6.2, fz, 0, { uv: 0.6, cast: false });
      }
      // stencils + hazard stripes at the breach
      meshBox(1.4, 0.5, 0.04, mats.signB, 8.2, 1.4, -74.94, 0, { uv: 0.6, cast: false });
      for (let i = 0; i < 7; i++) {
        meshBox(0.22, 0.02, 0.5, i % 2 ? mats.signA : mats.rubber, 9.6 + i * 0.28, fY + 0.02, -74.55, 0, { uv: 0.4, cast: false });
      }

      /* ---- mezzanine: stair, railing, upper storey furniture ----
         The stair is a groundHeight ramp (HQ_STAIR); the deck joins the 3.2 m
         nav layer via ROOF_ZONES so both the player and AI can use it. */
      const stair = HQ_STAIR;
      const steps = 16;
      const dz = (stair.z1 - stair.z0) / steps;
      for (let i = 0; i < steps; i++) {
        const h = stair.rise * (i + 1) / steps;
        const z = stair.z0 + (i + 0.5) * dz;
        meshBox(stair.x1 - stair.x0, h, dz + 0.012, mats.metal, (stair.x0 + stair.x1) / 2, h / 2, z, 0, { uv: 0.7 });
        meshBox(stair.x1 - stair.x0 + 0.04, 0.03, dz + 0.02, mats.rust, (stair.x0 + stair.x1) / 2, h + 0.015, z, 0, { uv: 0.5, cast: false });
      }
      for (const sx of [stair.x0 - 0.04, stair.x1 + 0.04]) {
        for (let i = 1; i < steps; i += 2) {
          const h = stair.rise * i / steps;
          const z = stair.z0 + i * dz;
          meshBox(0.05, 1.0, 0.05, mats.rust, sx, h + 0.5, z, 0, { uv: 0.5, cast: false });
        }
        meshBox(0.05, 0.05, Math.hypot(stair.rise, stair.z1 - stair.z0), mats.rust, sx,
          stair.rise / 2 + 0.92, (stair.z0 + stair.z1) / 2, 0,
          { uv: 0.5, cast: false, rx: -Math.atan2(stair.rise, stair.z1 - stair.z0) });
      }
      // landing lip
      meshBox(stair.x1 - stair.x0, 0.06, 0.4, mats.metal, (stair.x0 + stair.x1) / 2, stair.rise - 0.02, stair.z1 + 0.18, 0, { uv: 0.6 });

      // mezzanine railing along the open edge (visual only; nav bounds the deck)
      for (let i = 0; i < 8; i++) {
        const rx = x0 + 0.3 + i * 0.86;
        if (rx > stair.x0 - 0.2) break;
        meshBox(0.05, 1.05, 0.05, mats.rust, rx, cY + 0.52, -71.08, 0, { uv: 0.5, cast: false });
      }
      meshBox(stair.x0 - x0 - 0.3, 0.05, 0.05, mats.rust, (x0 + 0.3 + stair.x0 - 0.2) / 2, cY + 1.04, -71.08, 0, { uv: 0.5, cast: false });
      meshBox(0.05, 0.05, 5.6, mats.rust, stair.x0 - 0.02, cY + 1.04, -68.4, 0, { uv: 0.5, cast: false });

      // upper storey: comms desk, map board, cabinets, crates (visual only —
      // 2D colliders cannot be floor-specific, so the deck stays walk-through)
      meshBox(2.0, 0.82, 0.9, mats.wood, 8.6, cY + 0.57, -66.4, 0, { uv: 1.2 });
      meshBox(2.06, 0.06, 0.95, mats.metal, 8.6, cY + 1.0, -66.4, 0, { uv: 0.8, cast: false });
      monitor(8.6, cY + 1.28, -66.55, 0, 0.62, 0.38);
      meshBox(0.7, 1.2, 0.6, mats.metal, 13.9, cY + 0.6, -69.2, 0, { uv: 0.9 });
      meshBox(0.7, 1.2, 0.6, mats.metal, 13.9, cY + 0.6, -68.5, 0, { uv: 0.9 });
      meshBox(1.6, 1.0, 0.06, mats.signA, 10.4, cY + 1.55, -65.24, 0, { uv: 0.8, cast: false });
      meshBox(0.9, 0.7, 0.9, mats.wood, 7.2, cY + 0.35, -69.8, 0.2, { uv: 0.9 });
      meshBox(1.4, 0.04, 2.4, mats.burlap, 10.4, cY + 0.13, -67.4, 0, { uv: 1.0, cast: false });
      interiorLamp(9.0, upY - 0.35, -67.0, 3.4);
      interiorLamp(12.6, upY - 0.35, -67.2, 3.0);
      lightPool(10.4, -67.2, 2.2, 0.16);

      // open the 3.2 m nav layer over the deck; stair portals are generated
      // automatically where HQ_STAIR's ground height meets the layer
      ROOF_ZONES.push({ x0: 6.3, x1: 14.7, z0: -71.2, z1: -65.2, y: 3.2 });
      ROOF_SPAWNS.push({ x: 11.6, z: -67.0, y: 3.2 });
      ROOF_COVERS.push({ x: 13.9, z: -68.9, y: 3.2, h: true });

      // spawn/cover for the interior fight
      spawnPoints.push({ x: 7.2, z: -73.3 }, { x: 13.4, z: -69.4 }, { x: 7.3, z: -66.1 });
      coverPoints.push({ x: 10.4, z: -72.9, h: 1.0 }, { x: 12.7, z: -67.9, h: 1.0 }, { x: 14.1, z: -68.7, h: 1.3 });
    }

    buildNorthHq();

    // bridge across the gap
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(12.4, 1.3, 3.6), mats.concreteDark);
    projectBoxUV(bridge.geometry, 2.6);
    bridge.position.set(0, 8.4, z);
    bridge.castShadow = true; bridge.receiveShadow = true;
    statics.add(bridge);
    // no ground collider: the bridge is 8.4 m up and the checkpoint pass runs
    // underneath it (a 2D collider here sealed the only route north)
    for (const dz of [-1.55, 1.55]) {
      meshBox(12.4, 0.95, 0.3, mats.concreteDark, 0, 9.5, z + dz, 0, { uv: 1.4 });
      meshBox(12.4, 0.1, 0.4, mats.concrete, 0, 10.02, z + dz, 0, { uv: 1.4, cast: false });
    }
    // gate piers + header
    for (const side of [-1, 1]) meshBox(0.8, 5.2, 0.8, mats.concrete, side * 5.4, 2.6, z + 1.7, 0, { uv: 1.2 });
    meshBox(11.6, 0.85, 0.9, mats.concrete, 0, 5.35, z + 1.7, 0, { uv: 1.2 });
    // two knocked-open leaf gates (street stays open to the gatehouse)
    for (const side of [-1, 1]) {
      const leafW = 4.0;
      const gf = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 3.9, 5), mats.rust);
        bar.position.set(-side * (0.25 + i * (leafW - 0.5) / 6), 2.1, 0);
        bar.castShadow = false;
        gf.add(bar);
      }
      for (const by of [1.15, 3.55]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(leafW, 0.1, 0.1), mats.rust);
        rail.position.set(-side * leafW / 2, by, 0);
        gf.add(rail);
      }
      // diagonal brace
      const brace = new THREE.Mesh(new THREE.BoxGeometry(leafW * 1.05, 0.07, 0.07), mats.rust);
      brace.position.set(-side * leafW / 2, 2.35, 0);
      brace.rotation.z = side * 0.38;
      gf.add(brace);
      gf.position.set(side * 5.2, 0, z + 1.7);
      gf.rotation.y = side * (side < 0 ? 1.15 : 0.55);
      statics.add(gf);
    }
    // gate warning boards + sandbags so it reads as a checkpoint, not a black box
    for (const [bx, by, bw2, bh2] of [[3.6, 3.6, 1.5, 0.7], [-4.2, 3.6, 1.2, 0.62]]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(bw2, bh2), mats.signB);
      board.position.set(bx, by, z + 2.35);
      board.castShadow = false;
      statics.add(board);
      meshBox(bw2 + 0.08, bh2 + 0.06, 0.05, mats.metalTan, bx, by, z + 2.4, 0, { uv: 0.7, cast: false });
    }
    for (let i = 0; i < 4; i++) {
      meshRound(0.62, 0.25, 0.34, 0.09, mats.sandbag, -5.0 + (i % 2) * 0.62, 0.13 + Math.floor(i / 2) * 0.24, z + 3.2, rnd() * 0.2, { uv: 0.8 });
    }

    // hanging rebar / cut cables
    for (let i = 0; i < 9; i++) {
      const l = 1.2 + rnd() * 3.2;
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, l, 4), mats.rust);
      c.position.set(-4.8 + i * 1.2, 7.7 - l / 2, z + 2.1);
      c.rotation.z = (rnd() - 0.5) * 0.3;
      c.castShadow = false;
      statics.add(c);
    }
    // checkpoint booth + boom barrier + warning signs
    meshBox(2.0, 2.6, 2.2, mats.plasterA, 4.6, 1.3, -61.6, 0.12, { uv: 2.2, collide: true });
    meshBox(2.3, 0.14, 2.5, mats.concreteDark, 4.6, 2.68, -61.6, 0.12, { uv: 1.4, cast: false });
    meshBox(1.0, 0.9, 0.06, mats.windowGlass, 4.1, 1.85, -60.45, 0.12, { uv: 1.0, cast: false });
    meshBox(0.1, 1.0, 1.0, mats.windowGlass, 3.62, 1.85, -61.6, 0, { uv: 1.0, cast: false });
    meshBox(0.16, 0.1, 0.16, mats.rust, -1.6, 0.65, -59.5, 0, { uv: 0.5 });
    meshBox(0.1, 0.1, 4.0, mats.metalTan, -1.6, 1.05, -57.6, 0, { uv: 0.8, rz: -0.06 });
    for (let i = 0; i < 5; i++) meshBox(0.12, 0.2, 0.4, mats.rubber, -1.6, 1.12, -56.2 - i * 0.8, 0, { uv: 0.5, cast: false });
    meshBox(0.12, 1.8, 1.1, mats.signB, -4.2, 1.7, -58.4, 0, { uv: 0.9 });
    meshBox(0.1, 0.1, 1.3, mats.rust, -4.2, 1.0, -58.4, 0, { uv: 0.5, rx: Math.PI / 2 });
    // concrete blocks / t-wall
    for (const [bx, bz, br] of [[-3.2, -64.5, 0.2], [2.2, -64.2, -0.14], [-7.6, -65.5, 0.5]]) {
      jerseyBarrier(bx, bz, br);
    }
    // steel hedgehogs / lane closure at the gate
    for (const [gx, gz] of [[-3.6, -62.4], [3.4, -62.8], [-0.6, -63.6]]) {
      for (let a = 0; a < 3; a++) {
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1.5), mats.rust);
        beam.position.set(gx, 0.55, gz);
        beam.rotation.set(0.75, a * Math.PI / 3, 0.75 * (a % 2 ? -1 : 1));
        beam.castShadow = true;
        statics.add(beam);
      }
      addCollider(gx, gz, 1.2, 1.2, 0.05);
    }
    // gate work lamp
    meshBox(0.1, 0.1, 0.35, mats.metal, 0, 4.6, -66.4, 0, { uv: 0.5, cast: false });
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.22), mats.windowLit);
    gl.position.set(0, 4.45, -66.4);
    statics.add(gl);
    lightPool(0, -64.6, 2.2, 0.2);
    addRubble(0, -64.5, 3.4, 34);
    addRubble(-7, -63.5, 2.6, 20);
    // camo netting draped on the bridge
    for (let i = 0; i < 3; i++) {
      const net = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.2), mats.burlap);
      net.position.set(-4 + i * 4, 8.9 - i * 0.1, z + 2.15);
      net.rotation.set(rr(-0.1, 0.1), 0, rr(-0.08, 0.08));
      statics.add(net);
    }
    // fires at the checkpoint
    barrel(-4.4, -66.5, { fire: true, noLight: true });
    barrel(4.0, -67.2, { fire: true, noLight: true });
  }

  /* =====================================================================
     SOUTH YARD — the street opens into a depot yard at the south end.
     A second combat space with a different silhouette: open sky, containers,
     a walkable garage roof reached by an outside ramp, and a truck bay you
     can fight inside. Everything here is additive; the north block is intact.
     ===================================================================== */
  /* ------------------------------------------------------------------ north checkpoint */
  /* A small walled yard beyond the gatehouse: the story's last stand. It reuses
     the street's concrete/asphalt kit, so it costs a fraction of a new block. */
  function buildNorthYard() {
    const Z0 = -96, Z1 = -66;
    const cz = (Z0 + Z1) / 2;
    const wallMat = mats.concreteDark;
    const copMat = mats.concrete;

    // ground: asphalt pad over the dirt, drains toward the back wall
    meshPlane(64, Z1 - Z0 + 4, mats.asphalt, 0, 0.006, cz, { rx: -Math.PI / 2, uvScale: 3.0, recv: true });
    addPuddles([[-8.4, -88.0, 1.3, 0.5], [9.6, -76.0, 0.9, 0.4], [15.0, -92.5, 1.1, 0.42]]);
    addRubble(-19.4, -90.2, 1.2, 12);
    addRubble(18.8, -74.4, 1.0, 10);
    addWeeds(-22.0, -84.0, 4);
    addWeeds(21.6, -92.0, 3);

    // perimeter: side walls + backstop with a closed gate in the middle
    meshBox(0.36, 3.1, Z1 - Z0, wallMat, -30, 1.55, cz, 0, { collide: true, uv: 2.4 });
    // east wall: 4 m dock gate at z -82..-78
    meshBox(0.36, 3.1, 14, wallMat, 30, 1.55, -89, 0, { collide: true, uv: 2.4 });
    meshBox(0.36, 3.1, 12, wallMat, 30, 1.55, -72, 0, { collide: true, uv: 2.4 });
    meshBox(0.36, 0.7, 4, wallMat, 30, 2.75, -80, 0, { uv: 2.4, cast: false });
    for (const [xa, xb] of [[-30, 0], [12, 30]]) {
      meshBox(xb - xa, 3.1, 0.36, wallMat, (xa + xb) / 2, 1.55, Z0, 0, { collide: true, uv: 2.4 });
    }
    meshBox(0.52, 0.12, Z1 - Z0, copMat, -30, 3.16, cz, 0, { uv: 2.0, cast: false });
    meshBox(0.52, 0.12, 14, copMat, 30, 3.16, -89, 0, { uv: 2.0, cast: false });
    meshBox(0.52, 0.12, 12, copMat, 30, 3.16, -72, 0, { uv: 2.0, cast: false });
    meshBox(0.52, 0.12, 4, copMat, 30, 3.16, -80, 0, { uv: 2.0, cast: false });
    for (const [xa, xb] of [[-30, 0], [12, 30]]) {
      meshBox(xb - xa, 0.12, 0.52, copMat, (xa + xb) / 2, 3.16, Z0, 0, { uv: 2.0, cast: false });
    }
    // Season 3: open 12 m gate to the rail depot (0..12)
    for (const x of [0, 12]) meshBox(0.28, 3.5, 0.28, wallMat, x, 1.75, Z0, 0, { uv: 0.9, collide: true });
    meshBox(12.4, 0.7, 0.42, mats.concreteDark, 6, 3.45, Z0, 0, { uv: 2.0, cast: false });
    meshBox(12.0, 0.1, 0.5, mats.concrete, 6, 0.05, Z0, 0, { uv: 1.4, cast: false });
    for (const yy of [0.35, 1.5]) meshBox(0.08, 0.08, 0.5, mats.metal, 0.15, yy, Z0 + 0.2, 0, { uv: 0.4, cast: false });

    // checkpoint booth: one small interior nook facing the gate
    const bx = -8.5, bz = -74.5;
    meshBox(3.2, 0.12, 2.8, mats.concrete, bx, 0.06, bz, 0, { uv: 1.6, cast: false });
    meshBox(0.24, 2.5, 2.8, mats.plasterA, bx - 1.5, 1.25, bz, 0, { collide: true, uv: 1.6 });
    meshBox(0.24, 2.5, 2.8, mats.plasterA, bx + 1.5, 1.25, bz, 0, { collide: true, uv: 1.6 });
    meshBox(3.2, 0.22, 2.8, mats.concreteDark, bx, 2.62, bz, 0, { uv: 1.8 });
    meshBox(3.2, 0.9, 0.12, mats.interior, bx, 1.05, bz - 1.34, 0, { uv: 0.8, cast: false });
    meshBox(1.0, 0.5, 0.1, mats.metalTan, bx, 1.55, bz - 1.4, 0, { uv: 0.6, cast: false });

    // jersey barriers: two staggered lines that break sightlines
    const barrier = (x, z, w, rot = 0) => {
      meshBox(w, 0.86, 0.52, mats.concrete, x, 0.43, z, rot, { collide: true, uv: 1.4 });
      meshBox(w * 0.94, 0.16, 0.42, mats.concreteDark, x, 0.92, z, rot, { uv: 1.2, cast: false });
    };
    for (const [x, z, w, r] of [
      [-16.5, -78.0, 4.6, 0.04], [-11.2, -78.6, 3.4, -0.05], [12.6, -80.0, 4.2, 0.06],
      [17.4, -80.6, 3.0, 0.0], [-4.0, -87.5, 4.0, 0.03], [4.6, -87.0, 3.6, -0.04],
    ]) barrier(x, z, w, r);

    // sandbag nests + crates
    const nest = (x, z) => {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 1.65 - 0.2;
        meshRound(0.6, 0.24, 0.34, 0.09, mats.sandbag,
          x + Math.cos(a) * 1.15, 0.13 + (i % 3) * 0.23, z + Math.sin(a) * 1.15, -a, { uv: 0.8 });
      }
      addCollider(x, z, 2.3, 2.3, 0.1, 1.0);
      coverPoints.push({ x, z, h: 1.0 });
    };
    nest(-22.0, -72.5);
    nest(21.4, -88.5);
    nest(2.0, -93.0);
    for (const [x, z, w, h, d, rot] of [
      [7.8, -90.4, 1.3, 1.0, 1.0, 0.2], [9.2, -89.6, 1.0, 0.8, 0.9, -0.15],
      [-15.0, -85.8, 1.4, 1.1, 1.1, 0.1], [-16.4, -84.4, 1.0, 0.7, 1.0, 0.3],
    ]) meshBox(w, h, d, mats.wood, x, h / 2, z, rot, { collide: true, uv: 1.2 });

    // light poles + a pair of oil drums
    for (const [x, z] of [[-22.5, -80.0], [22.5, -86.0]]) {
      meshCyl(0.09, 0.11, 5.4, 6, mats.metal, x, 2.7, z);
      meshBox(0.5, 0.14, 0.3, mats.metalTan, x, 5.3, z, 0, { uv: 0.6 });
      lightPool(x, z, 3.2, 0.16);
    }
    for (const [x, z] of [[16.4, -77.2], [17.3, -78.0]]) {
      meshCyl(0.32, 0.32, 0.9, 10, mats.rust, x, 0.45, z);
      addCollider(x, z, 0.7, 0.7, 0.05, 0.9);
    }

    // heavy dressing: a burnt car, a box truck and container stacks give the
    // yard silhouettes to fight around instead of an empty apron
    carWreck(-19.6, -73.6, 0.55, true);

    // ---- art pass: chicane cover, a T-wall, tire/pipe stacks
    for (const [x, z, w, r] of [
      [-1.2, -83.2, 3.8, 0.06], [3.4, -84.0, 3.0, -0.04],
      [-9.8, -92.0, 4.4, 0.03], [15.6, -77.0, 3.2, 0.0],
    ]) barrier(x, z, w, r);
    // concrete T-wall: blocks the straight line from gate to back wall
    meshBox(5.2, 2.2, 0.36, mats.concrete, -6.0, 1.1, -89.4, 0.02, { collide: true, uv: 1.6 });
    meshBox(0.36, 2.2, 2.6, mats.concrete, -8.4, 1.1, -88.2, 0.02, { collide: true, uv: 1.6 });
    meshBox(5.4, 0.18, 0.5, mats.concreteDark, -6.0, 2.24, -89.4, 0.02, { uv: 1.4, cast: false });
    // tire stacks + a pipe bundle
    for (const [tx, tz, n] of [[17.4, -76.8, 3], [18.3, -77.6, 2], [-12.4, -82.8, 2]]) {
      for (let i = 0; i < n; i++) {
        meshCyl(0.56, 0.56, 0.24, 12, mats.interior, tx, 0.14 + i * 0.26, tz);
      }
      addCollider(tx, tz, 1.2, 1.2, 0.1, 1.0);
    }
    for (let i = 0; i < 5; i++) {
      meshCyl(0.18, 0.18, 2.6, 8, mats.rust, -23.2 + i * 0.38, 0.2, -77.4, { rz: Math.PI / 2 });
    }

    // ---- lighting: two more masts + a working fire that anchors the yard
    for (const [x, z, rot] of [[-2.6, -71.4, 0.2], [-21.8, -93.0, -0.3]]) {
      meshCyl(0.1, 0.12, 6.0, 6, mats.metal, x, 3.0, z);
      meshBox(0.7, 0.22, 0.42, mats.metalTan, x, 6.0, z, rot, { uv: 0.7 });
      meshBox(0.5, 0.1, 0.3, mats.windowLit, x, 5.86, z + 0.12, rot, { uv: 0.5, cast: false });
      lightPool(x, z + 0.6, 3.6, 0.2, 0xffb066);
    }
    addFire(7.8, 0.85, -82.4);
    // warm pools over the fighting lane so the yard is not a black hole
    for (const [lx, lz, lr, lo] of [[0.5, -84.0, 4.6, 0.3], [-10.5, -78.0, 3.8, 0.24], [16.5, -88.0, 3.6, 0.24]]) {
      lightPool(lx, lz, lr, lo, 0xffb066);
    }
    addFire(-24.0, 0.6, -108.0, { light: false });   // distant smoke column
    addFire(17.5, 0.6, -112.0, { light: false });    // second column over the skyline

    // ---- boom barrier across the inner gate (striped arm on a pivot post)
    meshCyl(0.12, 0.14, 1.1, 8, mats.metal, 4.6, 0.55, -68.9);
    for (let i = 0; i < 8; i++) {
      meshBox(0.72, 0.14, 0.14, i % 2 ? mats.concrete : mats.rust,
        -1.1 + i * 0.72, 0.95, -68.9, -0.12, { uv: 0.5, cast: false });
    }
    meshBox(5.8, 0.05, 0.05, mats.metal, 1.7, 0.86, -68.9, -0.12, { uv: 0.5, cast: false });

    boxTruck(13.2, -90.6, 0.18);
    const container = (x, z, rot, stack) => {
      for (let i = 0; i < stack; i++) {
        meshBox(6.2, 2.55, 2.45, i % 2 ? mats.metalTan : mats.metal, x, 1.3 + i * 2.6, z, rot,
          { collide: true, uv: 1.6 });
        meshBox(6.24, 0.12, 2.5, mats.concreteDark, x, 2.6 + i * 2.6, z, rot, { uv: 1.2, cast: false });
      }
    };
    container(-24.2, -89.5, Math.PI / 2, 2);
    container(22.4, -92.0, 0, 1);
    // watchtower frame at the north-east corner (visual: the yard reads manned)
    const tx = 24.6, tz = -93.4;
    for (const [ox, oz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) {
      meshCyl(0.08, 0.1, 3.4, 5, mats.rust, tx + ox, 1.7, tz + oz);
    }
    meshBox(3.0, 0.14, 3.0, mats.wood, tx, 3.45, tz, 0, { uv: 1.0 });
    for (const [ox, oz] of [[0, -1.5], [0, 1.5], [-1.5, 0], [1.5, 0]]) {
      meshBox(ox ? 0.1 : 3.0, 0.9, oz ? 0.1 : 3.0, mats.wood, tx + ox, 3.95, tz + oz, 0, { uv: 0.9 });
    }
    meshBox(3.4, 0.12, 3.4, mats.metalTan, tx, 4.5, tz, 0, { uv: 1.0, cast: false });
    for (let i = 0; i < 6; i++) {
      meshRound(0.6, 0.24, 0.34, 0.09, mats.sandbag, tx - 1.2 + (i % 3) * 1.2, 3.66, tz + 1.35, 0, { uv: 0.8 });
    }
    // sandbag line just inside the gate
    for (let i = 0; i < 10; i++) {
      meshRound(0.62, 0.25, 0.34, 0.09, mats.sandbag, -4.6 + (i % 5) * 1.25, 0.13 + Math.floor(i / 5) * 0.23, -68.2, 0, { uv: 0.8 });
    }
    addColliderRect(-5.2, 0.8, -68.7, -67.7, 1.0);

    // close the new east bound behind the street block (dock is reached from
    // the checkpoint only); plain concrete back wall
    for (const [za, zb] of [[-66, 10], [10, 84]]) {
      meshBox(0.4, 3.2, zb - za, mats.concreteDark, 30.2, 1.6, (za + zb) / 2, 0, { collide: true, uv: 2.6 });
      meshBox(0.56, 0.12, zb - za, mats.concrete, 30.2, 3.26, (za + zb) / 2, 0, { uv: 2.0, cast: false });
    }

    // gates warn: a faded sign on the street side of the gatehouse
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.5), mats.signA);
    sign.position.set(0, 4.2, -66.4);
    sign.rotation.y = Math.PI;
    statics.add(sign);
  }

  /* ------------------------------------------------------------------ east dock */
  /* Loading yard behind the checkpoint's east wall: flat apron, containers,
     a shed facade and floodlights, used as the escape route in OP10. */
  function buildEastDock() {
    const X0 = 30, X1 = 46, Z0 = -92, Z1 = -70;
    const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const wallMat = mats.concreteDark;

    meshPlane(X1 - X0 + 4, Z1 - Z0 + 4, mats.asphalt, cx, 0.006, cz, { rx: -Math.PI / 2, uvScale: 3.2, recv: true });
    addPuddles([[36.5, -86.0, 1.2, 0.45], [42.0, -75.5, 0.9, 0.4]]);
    addRubble(33.2, -72.4, 1.0, 10);
    addWeeds(44.8, -89.0, 3);

    // perimeter (west is the checkpoint wall, with the gate)
    // Season 3: 8 m port gate at z -84..-76
    meshBox(0.4, 3.2, 8, wallMat, X1, 1.6, -88, 0, { collide: true, uv: 2.6 });
    meshBox(0.4, 3.2, 6, wallMat, X1, 1.6, -73, 0, { collide: true, uv: 2.6 });
    for (const z of [-84, -76]) meshBox(0.32, 3.5, 0.32, wallMat, X1, 1.75, z, 0, { uv: 0.9, collide: true });
    meshBox(0.4, 0.7, 8.4, mats.concreteDark, X1, 3.5, -80, 0, { uv: 2.0, cast: false });
    for (const yy of [0.4, 1.6]) meshBox(0.08, 0.08, 0.4, mats.metal, X1, yy, -83.8, 0, { uv: 0.4, cast: false });
    for (const [xa, xb] of [[X0, X1]]) {
      meshBox(xb - xa, 3.2, 0.4, wallMat, (xa + xb) / 2, 1.6, Z0, 0, { collide: true, uv: 2.6 });
      meshBox(xb - xa, 3.2, 0.4, wallMat, (xa + xb) / 2, 1.6, Z1, 0, { collide: true, uv: 2.6 });
    }
    meshBox(0.56, 0.12, 8, mats.concrete, X1, 3.26, -88, 0, { uv: 2.0, cast: false });
    meshBox(0.56, 0.12, 6, mats.concrete, X1, 3.26, -73, 0, { uv: 2.0, cast: false });

    // shed facade moved north of the new gate + roll-up door
    meshBox(0.3, 5.2, 5.6, mats.plasterB, 45.6, 2.6, -88.6, 0, { uv: 2.4 });
    meshBox(3.6, 3.4, 0.18, mats.metal, 45.4, 1.7, -88.6, 0, { uv: 1.2 });
    for (let i = 0; i < 6; i++) meshBox(3.5, 0.06, 0.2, mats.metal, 45.35, 0.35 + i * 0.52, -88.6, 0, { uv: 0.6, cast: false });
    meshBox(4.2, 0.5, 0.5, mats.concreteDark, 45.4, 3.7, -88.6, 0, { uv: 1.0 });

    // containers + truck + pallets
    for (const [x, z, rot, stack] of [[34.0, -88.8, 0, 1], [35.6, -91.4, Math.PI / 2, 2]]) {
      for (let i = 0; i < stack; i++) {
        meshBox(6.0, 2.5, 2.4, i % 2 ? mats.metalTan : mats.metal, x, 1.28 + i * 2.55, z, rot,
          { collide: true, uv: 1.6 });
      }
    }
    boxTruck(40.4, -74.6, Math.PI * 0.52);
    for (const [x, z] of [[32.8, -80.4], [33.6, -81.2]]) {
      meshCyl(0.32, 0.32, 0.9, 10, mats.rust, x, 0.45, z);
      addCollider(x, z, 0.7, 0.7, 0.05, 0.9);
    }
    for (const [x, z, w, d] of [[44.2, -72.6, 2.2, 1.4], [43.2, -71.4, 1.8, 1.2]]) {
      meshBox(w, 0.12, d, mats.wood, x, 0.08, z, 0, { uv: 1.2 });
      addCollider(x, z, w, d, 0.05, 0.3);
    }

    // barriers + floodlights
    for (const [x, z, w, rot] of [[37.4, -77.8, 4.0, 0.03], [39.0, -84.8, 3.4, -0.04], [33.8, -84.0, 3.0, 0.06]]) {
      meshBox(w, 0.86, 0.52, mats.concrete, x, 0.43, z, rot, { collide: true, uv: 1.4 });
    }
    for (const [x, z] of [[31.8, -74.2], [44.4, -86.2]]) {
      meshCyl(0.1, 0.12, 6.0, 6, mats.metal, x, 3.0, z);
      meshBox(0.7, 0.22, 0.42, mats.metalTan, x, 6.0, z, 0, { uv: 0.7 });
      meshBox(0.5, 0.1, 0.3, mats.windowLit, x, 5.86, z + 0.12, 0, { uv: 0.5, cast: false });
      lightPool(x, z + 0.7, 3.6, 0.22, 0xffb066);
    }

    /* ---- raised loading platform + gantry crane ---- */
    const px0 = 41.6, px1 = 45.8, pz0 = -92, pz1 = -86.3, py = 1.2;
    meshBox(px1 - px0, 0.26, pz1 - pz0, mats.concrete, (px0 + px1) / 2, py - 0.13, (pz0 + pz1) / 2, 0, { uv: 2.0 });
    meshBox(px1 - px0, 0.04, pz1 - pz0, mats.concreteDark, (px0 + px1) / 2, py + 0.01, (pz0 + pz1) / 2, 0, { uv: 1.4, cast: false });
    for (let i = 0; i < 14; i++) {
      meshBox(0.18, 0.03, 0.9, mats.metalTan, px0 + 0.3 + i * 0.28, py + 0.03, pz1 - 0.55, 0, { uv: 0.4, cast: false });
    }
    // ramp steps
    const steps = 12, rdz = (DOCK_RAMP.z1 - DOCK_RAMP.z0) / steps;
    for (let i = 0; i < steps; i++) {
      const h = DOCK_RAMP.rise * (i + 1) / steps;
      const z = DOCK_RAMP.z0 + (i + 0.5) * rdz;
      meshBox(DOCK_RAMP.x1 - DOCK_RAMP.x0, h, rdz + 0.01, mats.metal, (DOCK_RAMP.x0 + DOCK_RAMP.x1) / 2, h / 2, z, 0, { uv: 0.7 });
    }
    for (const sx of [DOCK_RAMP.x0 - 0.04, DOCK_RAMP.x1 + 0.04]) {
      meshBox(0.05, 0.05, Math.hypot(DOCK_RAMP.rise, DOCK_RAMP.z1 - DOCK_RAMP.z0), mats.rust, sx,
        DOCK_RAMP.rise / 2 + 0.95, (DOCK_RAMP.z0 + DOCK_RAMP.z1) / 2, 0,
        { uv: 0.5, cast: false, rx: -Math.atan2(DOCK_RAMP.rise, DOCK_RAMP.z1 - DOCK_RAMP.z0) });
      for (let i = 1; i < steps; i += 2) meshBox(0.05, 1.0, 0.05, mats.rust, sx, DOCK_RAMP.rise * i / steps + 0.5, DOCK_RAMP.z0 + i * rdz, 0, { uv: 0.5, cast: false });
    }
    // platform railing (visual)
    for (const [rx, rz, rw, rd] of [[px0 + 0.15, (pz0 + pz1) / 2, 0.05, pz1 - pz0], [(px0 + px1) / 2, pz0 + 0.15, px1 - px0, 0.05]]) {
      meshBox(rw, 0.05, rd, mats.rust, rx, py + 1.05, rz, 0, { uv: 0.5, cast: false });
    }
    for (let i = 0; i < 8; i++) meshBox(0.05, 1.05, 0.05, mats.rust, px0 + 0.15, py + 0.52, pz0 + 0.3 + i * 0.85, 0, { uv: 0.5, cast: false });

    // gantry: two legs + beam + trolley (visual; legs collide)
    for (const gx of [33.4, 45.0]) {
      meshBox(0.45, 6.4, 0.45, mats.metal, gx, 3.2, -89.2, 0, { collide: true, uv: 1.0 });
      meshBox(0.7, 0.3, 0.7, mats.concreteDark, gx, 0.15, -89.2, 0, { uv: 0.6 });
      meshBox(0.15, 2.2, 0.15, mats.rust, gx, 5.4, -88.4, 0, { uv: 0.4, cast: false });
    }
    meshBox(12.0, 0.55, 0.6, mats.metal, 39.2, 6.35, -89.2, 0, { uv: 1.2 });
    meshBox(0.8, 0.7, 0.9, mats.rust, 38.4, 5.75, -89.2, 0, { uv: 0.7 });
    meshCyl(0.03, 0.03, 1.8, 5, mats.rust, 38.4, 4.7, -89.2, { cast: false });
    meshBox(0.5, 0.45, 0.5, mats.metalTan, 38.4, 3.8, -89.2, 0, { uv: 0.5 });
    // crates + control cabinet on the platform
    for (const [bx, bz] of [[42.6, -90.9], [44.2, -91.3], [42.8, -87.4]]) crate(bx, bz, 0.9, 0.2, py);
    meshBox(0.8, 1.2, 0.5, mats.metal, 44.9, py + 0.6, -87.0, 0, { uv: 0.9 });
    lightPool(43.6, -88.8, 2.4, 0.18);

    // walkable 1.2 m platform layer + ramp portals
    ROOF_ZONES.push({ x0: px0, x1: px1, z0: pz0, z1: pz1, y: py });
    ROOF_SPAWNS.push({ x: 43.8, z: -89.6, y: py });
    ROOF_COVERS.push({ x: 42.6, z: -90.4, y: py, h: true });

    // spawns / covers / region
    spawnPoints.push({ x: 33.0, z: -85.0 }, { x: 42.0, z: -87.0 }, { x: 38.0, z: -73.2 }, { x: 44.0, z: -80.0 });
    coverPoints.push({ x: 34.0, z: -87.6, h: 1.0 }, { x: 39.0, z: -84.8, h: 0.9 }, { x: 40.4, z: -76.2, h: 1.2 });
  }

  function buildSouthYard() {
    const cz = (SOUTH.z0 + SOUTH.z1) / 2;

    // ---------- ground: asphalt yard, apron, dirt drift at the walls
    meshPlane(SOUTH.x1 - SOUTH.x0 + 8, SOUTH.z1 - SOUTH.z0 + 6, mats.asphalt, 0, 0.009, cz, {
      rx: -Math.PI / 2, uvScale: 3.4, recv: true,
    });
    meshBox(4.6, 0.06, 12.8, mats.concrete, DEPOT.x0 - 1.9, 0.032, 68.0, 0, { uv: 2.2, cast: false });
    addPuddles([[-9.6, 62.0, 1.4, 0.55], [4.2, 74.6, 1.0, 0.5], [13.2, 79.4, 1.2, 0.45], [-14.4, 70.2, 0.8, 0.4]]);
    addRubble(15.4, 80.4, 1.3, 16);
    addRubble(-15.8, 58.6, 1.1, 12);
    addWeeds(-16.4, 71.0, 4);
    addWeeds(15.9, 64.0, 3);

    // ---------- perimeter walls: east / west / south (gate in the middle)
    const wallMat = mats.concreteDark;
    const copMat = mats.concrete;
    meshBox(0.36, 3.1, SOUTH.z1 - SOUTH.z0, wallMat, SOUTH.x1, 1.55, cz, 0, { collide: true, uv: 2.4 });
    meshBox(0.36, 3.1, 28, wallMat, SOUTH.x0, 1.55, 68, 0, { collide: true, uv: 2.4 });
    for (const [xa, xb] of [[SOUTH.x0, -3.0], [3.0, SOUTH.x1]]) {
      meshBox(xb - xa, 3.1, 0.36, wallMat, (xa + xb) / 2, 1.55, SOUTH.z1, 0, { collide: true, uv: 2.4 });
    }
    meshBox(0.52, 0.12, SOUTH.z1 - SOUTH.z0, copMat, SOUTH.x1, 3.16, cz, 0, { uv: 2.0, cast: false });
    meshBox(0.52, 0.12, 28, copMat, SOUTH.x0, 3.16, 68, 0, { uv: 2.0, cast: false });
    for (const [xa, xb] of [[SOUTH.x0, -3.0], [3.0, SOUTH.x1]]) {
      meshBox(xb - xa, 0.12, 0.52, copMat, (xa + xb) / 2, 3.16, SOUTH.z1, 0, { uv: 2.0, cast: false });
    }
    // gate: steel bars + open leaves; the opening stays closed to the player
    for (let i = 0; i < 15; i++) {
      meshBox(0.04, 1.55, 0.04, mats.metal, -2.86 + i * 0.41, 0.9, SOUTH.z1, 0, { uv: 0.4, cast: false });
    }
    for (const yy of [0.35, 1.62]) meshBox(6.0, 0.06, 0.06, mats.metal, 0, yy, SOUTH.z1, 0, { uv: 0.6, cast: false });
    addColliderRect(-3.0, 3.0, SOUTH.z1 - 0.12, SOUTH.z1 + 0.12);
    for (const [gz, dir] of [[-3.0, -1], [3.0, 1]]) {
      const g = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5), mats.metal);
        bar.position.set(0, 1.0, dir * (0.2 + i * 0.22));
        g.add(bar);
      }
      g.position.set(gz, 0, SOUTH.z1 - 0.06);
      g.rotation.y = dir * 0.5;
      statics.add(g);
    }
    for (const z of [-3.0, 3.0]) meshBox(0.26, 3.3, 0.26, wallMat, z, 1.65, SOUTH.z1, 0, { uv: 0.9 });
    // gate lamp + yard board
    meshBox(0.3, 0.05, 0.05, mats.rust, 0, 3.36, SOUTH.z1 - 0.2, 0, { uv: 0.5, cast: false });
    meshBox(0.26, 0.14, 0.2, mats.metalTan, 0, 3.28, SOUTH.z1 - 0.35, 0, { uv: 0.6 });
    lightPool(0, SOUTH.z1 - 1.2, 2.6, 0.18);

    // ---------- depot shell: bay opens north (visible from the street mouth)
    const d = DEPOT;
    const dcx = (d.x0 + d.x1) / 2, dcz = (d.z0 + d.z1) / 2;
    const bayX0 = 6.8, bayX1 = 13.2, bayTop = 2.9;
    meshBox(d.x1 - d.x0, 0.12, d.z1 - d.z0, mats.concreteDark, dcx, 0.06, dcz, 0, { uv: 2.6, cast: false });
    // south / east / west walls
    meshBox(d.x1 - d.x0, d.wallH, 0.3, mats.plasterB, dcx, d.wallH / 2, d.z1 - 0.15, 0, { collide: true, uv: 2.4 });
    meshBox(0.3, d.wallH, d.z1 - d.z0, mats.plasterB, d.x1 - 0.15, d.wallH / 2, dcz, 0, { collide: true, uv: 2.4 });
    meshBox(0.3, d.wallH, d.z1 - d.z0, mats.plasterB, d.x0 + 0.15, d.wallH / 2, dcz, 0, { collide: true, uv: 2.4 });
    // north wall: piers either side of the 6.4 m bay, lintel above the opening
    for (const [xa, xb] of [[d.x0, bayX0], [bayX1, d.x1]]) {
      meshBox(xb - xa, d.wallH, 0.3, mats.plasterB, (xa + xb) / 2, d.wallH / 2, d.z0 + 0.15, 0, { collide: true, uv: 2.4 });
    }
    meshBox(bayX1 - bayX0, d.wallH - bayTop, 0.34, mats.concreteDark, (bayX0 + bayX1) / 2, (d.wallH + bayTop) / 2, d.z0 + 0.17, 0, { uv: 1.8, cast: false });
    // rolled-up steel shutter tucked into the lintel
    meshBox(bayX1 - bayX0 - 0.1, 0.5, 0.22, mats.metal, (bayX0 + bayX1) / 2, bayTop + 0.14, d.z0 + 0.06, 0, { uv: 0.9, cast: false });
    for (let i = 0; i < 4; i++) {
      meshBox(bayX1 - bayX0 - 0.3, 0.03, 0.2, mats.metal, (bayX0 + bayX1) / 2, bayTop + 0.02 - i * 0.11, d.z0 + 0.02, 0, { uv: 0.6, cast: false });
    }
    // roof slab (top = DEPOT.roofY) + parapet; west edge left open at the ramp
    meshBox(d.x1 - d.x0 + 0.5, 0.24, d.z1 - d.z0 + 0.5, mats.concrete, dcx, d.wallH - 0.12, dcz, 0, { uv: 2.8 });
    for (const [w, dep, px, pz] of [
      [d.x1 - d.x0 + 0.5, 0.14, dcx, d.z0 - 0.18],
      [d.x1 - d.x0 + 0.5, 0.14, dcx, d.z1 + 0.18],
      [0.14, d.z1 - d.z0 + 0.5, d.x1 + 0.18, dcz],
    ]) {
      meshBox(w, 0.34, dep, mats.concrete, px, DEPOT.roofY + 0.17, pz, 0, { uv: 2.0, cast: false });
    }
    for (const [za, zb] of [[d.z0 - 0.25, 66.2], [70.8, d.z1 + 0.25]]) {
      meshBox(0.14, 0.34, zb - za, mats.concrete, d.x0 - 0.18, DEPOT.roofY + 0.17, (za + zb) / 2, 0, { uv: 1.6, cast: false });
    }
    // roof clutter: skylight, AC box, sacks, a broken vent
    meshBox(1.4, 0.16, 1.4, mats.metalTan, 9.0, DEPOT.roofY + 0.08, 74.0, 0, { uv: 1.0 });
    meshBox(0.9, 0.7, 0.9, mats.metal, 13.4, DEPOT.roofY + 0.35, 72.0, 0.12, { uv: 0.8 });
    meshBox(0.7, 0.5, 0.55, mats.burlap, 6.4, DEPOT.roofY + 0.25, 77.2, -0.2, { uv: 0.8 });
    meshCyl(0.18, 0.18, 0.6, 8, mats.rust, 14.2, DEPOT.roofY + 0.3, 76.4);
    // depot signage over the bay, facing the yard entrance
    const baySign = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.62), mats.signB);
    baySign.position.set((bayX0 + bayX1) / 2, bayTop + 0.42, d.z0 - 0.02);
    baySign.rotation.y = Math.PI;
    statics.add(baySign);

    // ---------- outside ramp to the roof (no stairs, walk up)
    const sr = SOUTH_RAMP;
    const ang = Math.atan2(sr.rise, sr.z1 - sr.z0);
    const rlen = Math.hypot(sr.rise, sr.z1 - sr.z0);
    const rmx = (sr.x0 + sr.x1) / 2, rmz = (sr.z0 + sr.z1) / 2;
    meshBox(1.4, 0.14, rlen, mats.metal, rmx, sr.rise / 2 - 0.07 * Math.cos(ang), rmz, 0, { rx: -ang, uv: 1.0 });
    for (let k = 0; k < 10; k++) {
      const z = sr.z0 + 0.5 + k * 0.4;
      const h = sr.rise * (z - sr.z0) / (sr.z1 - sr.z0);
      meshBox(1.26, 0.035, 0.07, mats.rust, rmx, h + 0.02, z, 0, { uv: 0.5, cast: false, rx: -ang });
    }
    for (const rx of [sr.x0 - 0.03, sr.x1 + 0.03]) {
      meshBox(0.05, 0.05, rlen, mats.rust, rx, sr.rise / 2 + 0.95, rmz, 0, { rx: -ang, uv: 0.5, cast: false });
      for (let k = 0; k < 5; k++) {
        const z = sr.z0 + 0.5 + k * 0.85;
        const h = sr.rise * (z - sr.z0) / (sr.z1 - sr.z0);
        meshBox(0.05, 0.95, 0.05, mats.rust, rx, h + 0.48, z, 0, { uv: 0.4, cast: false });
      }
    }
    // landing plate bridges the ramp top onto the roof's west edge
    meshBox(1.6, 0.12, 1.2, mats.metal, 4.9, DEPOT.roofY - 0.06, sr.z1 - 0.1, 0, { uv: 1.0 });
    // ramp sign at the base
    meshBox(0.07, 2.0, 0.07, mats.wood, sr.x0 - 0.5, 1.0, sr.z0 - 0.25, 0, { uv: 0.5, cast: false });
    const rs = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), mats.signC);
    rs.position.set(sr.x0 - 0.5, 1.75, sr.z0 - 0.21);
    statics.add(rs);

    // ---------- truck bay interior (entered from the north)
    boxTruck(10.0, 72.4, 0.02);
    meshBox(0.8, 0.92, 3.0, mats.wood, d.x1 - 0.68, 0.46, 71.4, 0, { uv: 1.0, collide: true });
    meshBox(0.84, 0.06, 3.1, mats.metal, d.x1 - 0.68, 0.95, 71.4, 0, { uv: 0.8, cast: false });
    for (const [cx, czz] of [[6.4, 76.2], [13.6, 76.4], [6.6, 68.6]]) crate(cx, czz, 1.0, 0.2);
    for (let i = 0; i < 4; i++) {
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.12, 8, 14), mats.rubber);
      tyre.rotation.x = Math.PI / 2; tyre.position.set(14.2 - i * 0.1, 0.16, 76.6 + i * 0.02);
      statics.add(tyre);
    }
    addPuddles([[8.0, 69.6, 0.9, 0.5], [12.8, 76.0, 0.7, 0.4]]);
    // single warm bulb (one point light for the whole bay)
    meshCyl(0.012, 0.012, 0.5, 4, mats.rubber, 10.0, 3.0, 72.4, { cast: false });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mats.windowLit);
    bulb.position.set(10.0, 2.72, 72.4);
    statics.add(bulb);
    const bayLight = new THREE.PointLight(0xffb070, 5.6, 10.5, 2);
    bayLight.position.set(10.0, 2.66, 72.4);
    dynamic.add(bayLight);
    lightPool(10.0, 72.4, 2.6, 0.2);

    // ---------- water tower: the yard's landmark, visible through the gate
    const wt = { x: -6.6, z: 62.6 };
    for (const [dx, dz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
      meshBox(0.28, 6.6, 0.28, mats.metal, wt.x + dx, 3.3, wt.z + dz, 0, { uv: 0.7 });
      addCollider(wt.x + dx, wt.z + dz, 0.44, 0.44, 0.03);
    }
    for (const yy of [2.2, 4.4, 6.2]) {
      for (const [w, dep, px, pz] of [
        [3.6, 0.09, wt.x, wt.z - 1.7], [3.6, 0.09, wt.x, wt.z + 1.7],
        [0.09, 3.6, wt.x - 1.7, wt.z], [0.09, 3.6, wt.x + 1.7, wt.z],
      ]) {
        meshBox(w, 0.08, dep, mats.rust, px, yy, pz, 0, { uv: 0.6, cast: false });
      }
    }
    // access platform + railing
    meshBox(4.2, 0.16, 4.2, mats.metal, wt.x, 6.68, wt.z, 0, { uv: 1.2 });
    for (let i = 0; i < 5; i++) {
      const t = -2.0 + i * 1.0;
      for (const [px, pz] of [[wt.x + t, wt.z - 2.05], [wt.x + t, wt.z + 2.05]]) {
        meshBox(0.06, 0.95, 0.06, mats.rust, px, 7.2, pz, 0, { uv: 0.4, cast: false });
      }
      for (const [px, pz] of [[wt.x - 2.05, wt.z + t], [wt.x + 2.05, wt.z + t]]) {
        meshBox(0.06, 0.95, 0.06, mats.rust, px, 7.2, pz, 0, { uv: 0.4, cast: false });
      }
    }
    for (const [w, dep, px, pz] of [
      [4.2, 0.06, wt.x, wt.z - 2.05], [4.2, 0.06, wt.x, wt.z + 2.05],
      [0.06, 4.2, wt.x - 2.05, wt.z], [0.06, 4.2, wt.x + 2.05, wt.z],
    ]) {
      meshBox(w, 0.06, dep, mats.rust, px, 7.7, pz, 0, { uv: 0.6, cast: false });
    }
    // tank + hoop ribs + conical cap
    meshCyl(2.05, 2.05, 2.9, 16, mats.rust, wt.x, 8.55, wt.z, { cast: true });
    for (const yy of [7.25, 8.1, 8.95, 9.8]) meshCyl(2.09, 2.09, 0.1, 16, mats.metal, wt.x, yy, wt.z, { cast: false });
    meshCyl(2.2, 1.15, 1.15, 16, mats.metalTan, wt.x, 10.57, wt.z, { cast: true });
    // ladder up the south leg + down pipe
    for (const sx of [-0.24, 0.24]) meshBox(0.05, 6.4, 0.05, mats.metal, wt.x + sx, 3.2, wt.z + 2.08, 0, { uv: 0.4, cast: false });
    for (let i = 0; i < 16; i++) meshBox(0.5, 0.04, 0.04, mats.metal, wt.x, 0.5 + i * 0.4, wt.z + 2.08, 0, { uv: 0.4, cast: false });
    meshCyl(0.09, 0.09, 6.3, 6, mats.rust, wt.x + 1.88, 3.2, wt.z - 1.88, { cast: false });
    lightPool(wt.x, wt.z, 3.0, 0.12);

    // ---------- fuel island under a canopy: second landmark + cover
    const FUEL = { x: 1.0, z: 71.6 };
    meshBox(4.6, 0.24, 2.6, mats.concrete, FUEL.x, 0.12, FUEL.z, 0, { uv: 2.0, collide: true });
    for (const [px, pz] of [[-2.0, -1.1], [2.0, -1.1], [-2.0, 1.1], [2.0, 1.1]]) {
      meshBox(0.18, 3.5, 0.18, mats.metal, FUEL.x + px, 1.75, FUEL.z + pz, 0, { uv: 0.6, collide: true });
    }
    meshBox(5.4, 0.2, 3.2, mats.metalTan, FUEL.x, 3.62, FUEL.z, 0, { uv: 2.4 });
    meshBox(5.4, 0.5, 0.14, mats.signB, FUEL.x, 3.9, FUEL.z - 1.62, 0, { uv: 2.2 });
    for (const dx of [-1.2, 1.2]) {
      meshBox(0.9, 1.4, 0.62, mats.metal, FUEL.x + dx, 0.94, FUEL.z, 0, { uv: 1.2, collide: true });
      meshBox(0.66, 0.44, 0.03, mats.rubber, FUEL.x + dx, 1.36, FUEL.z - 0.32, 0, { uv: 0.5, cast: false });
      meshBox(0.1, 0.85, 0.1, mats.rust, FUEL.x + dx + 0.52, 0.68, FUEL.z + 0.33, 0, { uv: 0.4, cast: false });
      meshBox(0.16, 0.16, 0.16, mats.metalTan, FUEL.x + dx, 1.72, FUEL.z - 0.1, 0, { uv: 0.4, cast: false });
    }
    for (const dx of [-2.35, 2.35]) meshCyl(0.12, 0.13, 0.85, 8, mats.metalTan, FUEL.x + dx, 0.42, FUEL.z - 1.3);
    meshCyl(0.24, 0.24, 0.8, 10, mats.rust, FUEL.x + 3.1, 0.4, FUEL.z + 0.9);
    meshCyl(0.24, 0.24, 0.8, 10, mats.rust, FUEL.x + 3.5, 0.4, FUEL.z + 1.4);
    addPuddles([[FUEL.x - 1.6, FUEL.z + 1.4, 1.2, 0.5], [FUEL.x + 1.8, FUEL.z + 0.4, 0.9, 0.4]]);
    lightPool(FUEL.x, FUEL.z, 3.0, 0.16);

    // ---------- yard dressing: containers, wrecks, truck, gate furniture
    container(-13.6, 76.4, 0.06);
    container(13.9, 59.6, 0.02);
    carWreck(-10.4, 63.4, 0.42);
    carWreck(7.4, 79.6, 2.3);
    boxTruck(-6.0, 70.6, 0.5);
    dumpster(14.9, 63.0, -0.16);
    sandbagWall(1.2, 67.6, Math.PI / 2, 3, 4);
    crateStack(-8.8, 79.0, 3);
    crate(3.0, 60.8, 0.9, 0.3);
    pallet(-13.8, 60.2, 0.2);
    tireStack(-15.2, 66.4, 3);
    barrel(-9.6, 61.6, { fire: true });
    barrel(14.4, 66.4);
    for (const [jx, jz, jr] of [[-4.9, 80.5, 0.02], [4.9, 80.5, -0.03]]) jerseyBarrier(jx, jz, jr);
    // light poles (blob pools only — no extra point lights)
    for (const [px, pz] of [[-13.6, 58.8], [13.4, 79.6]]) {
      meshCyl(0.07, 0.1, 6.2, 8, mats.metal, px, 3.1, pz);
      meshBox(0.55, 0.14, 0.55, mats.metalTan, px, 6.2, pz, 0, { uv: 0.6 });
      meshBox(0.34, 0.05, 0.34, mats.rubber, px, 6.11, pz, 0, { uv: 0.4, cast: false });
      addCollider(px, pz, 0.3, 0.3, 0.02);
      lightPool(px, pz, 3.4, 0.15);
    }
    // graffiti on the yard walls
    for (let k = 0; k < 3; k++) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(rr(1.4, 2.2), rr(0.9, 1.5)), mats.graffiti);
      g.position.set(SOUTH.x1 - 0.2, rr(0.9, 2.1), rr(62, 74));
      g.rotation.y = -Math.PI / 2;
      statics.add(g);
    }
    // ---- entrance frame: the street mouth reads as a depot checkpoint
    for (const sx of [-1, 1]) {
      meshBox(0.7, 5.0, 0.7, mats.concreteDark, sx * 9.6, 2.5, SOUTH.z0 + 0.2, 0, { collide: true, uv: 1.4 });
      meshBox(0.9, 0.2, 0.9, mats.concrete, sx * 9.6, 5.1, SOUTH.z0 + 0.2, 0, { uv: 1.0, cast: false });
      meshBox(0.72, 0.32, 0.72, mats.metalTan, sx * 9.6, 1.15, SOUTH.z0 + 0.2, 0, { uv: 0.6, cast: false });
    }
    meshBox(19.9, 0.42, 0.5, mats.concreteDark, 0, 5.18, SOUTH.z0 + 0.2, 0, { uv: 2.2, cast: false });
    const yardSign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.72), mats.signB);
    yardSign.position.set(0, 5.18, SOUTH.z0 - 0.06);
    yardSign.rotation.y = Math.PI;
    statics.add(yardSign);
    // raised barrier arm over the right-hand lane
    meshBox(0.12, 0.12, 3.6, mats.metalTan, 6.2, 2.35, SOUTH.z0 + 1.5, 0.02, { uv: 0.4, cast: false });
    meshBox(0.2, 1.0, 0.2, mats.metal, 6.2, 1.0, SOUTH.z0 + 0.6, 0, { uv: 0.5 });
    // pipe stack along the west wall
    for (let i = 0; i < 3; i++) {
      meshCyl(0.24, 0.24, 3.0, 10, mats.rust, -15.3, 0.26 + (i % 2) * 0.48, 71.6 + i * 0.25, { cast: true });
    }
    addCollider(-15.3, 71.9, 1.0, 3.2, 0.04);

    // outer perimeter berm beyond the yard wall: closes the horizon at ground
    // level without stacking untextured blocks into the haze
    meshBox(124, 2.6, 0.7, mats.concreteDark, 0, 1.3, 90.0, 0, { uv: 3.2, cast: false });
    meshBox(124, 0.16, 0.9, mats.concrete, 0, 2.68, 90.0, 0, { uv: 3.2, cast: false });

    // ---- backdrop: dress the street block's south ends (they close the yard)
    function grimeS(x, y, z, w, hh) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mats.grime);
      g.position.set(x, y, z);
      g.castShadow = false;
      statics.add(g);
    }
    function southWindow(x, y, z, w, h, lit) {
      // recess: a dark inset box behind the glass reads as depth, not a poster
      meshBox(w + 0.08, h + 0.08, 0.3, mats.interior, x, y, z - 0.14, 0, { uv: 0.5, cast: false });
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), lit ? mats.windowLitDim : mats.windowGlass);
      glass.position.set(x, y, z + 0.01);
      statics.add(glass);
      // jambs / lintel / sill sit proud of the wall
      for (const dx of [-w / 2 - 0.07, w / 2 + 0.07]) {
        meshBox(0.1, h + 0.16, 0.12, mats.concrete, x + dx, y, z + 0.05, 0, { uv: 0.55, cast: false });
      }
      meshBox(w + 0.26, 0.12, 0.14, mats.concreteDark, x, y + h / 2 + 0.07, z + 0.05, 0, { uv: 0.6, cast: false });
      meshBox(w + 0.3, 0.14, 0.22, mats.concrete, x, y - h / 2 - 0.08, z + 0.07, 0, { uv: 0.7, cast: false });
      grimeS(x, y - h / 2 - 0.85, z + 0.02, w + 0.5, 1.0);
    }
    function southShutter(x, z, w) {
      meshBox(w, 2.5, 0.14, mats.shop, x, 1.32, z + 0.05, 0, { uv: 1.4 });
      for (let i = 0; i < 12; i++) {
        meshBox(w - 0.06, 0.035, 0.06, mats.metal, x, 0.28 + i * 0.19, z + 0.14, 0, { uv: 0.4, cast: false });
      }
      meshBox(w + 0.16, 0.16, 0.18, mats.concreteDark, x, 2.62, z + 0.08, 0, { uv: 0.7, cast: false });
    }
    // right block south face (z = 56, x 9.85..24.85, h 22)
    for (let row = 0; row < 4; row++) {
      const wy = 5.3 + row * 4.0;
      for (let col = 0; col < 3; col++) {
        southWindow(13.0 + col * 3.6, wy, SOUTH.z0, 1.24, 1.55, (row * 3 + col) % 5 === 2);
      }
    }
    southShutter(20.4, SOUTH.z0, 2.9);
    southShutter(16.2, SOUTH.z0, 2.4);
    for (const px of [10.5, 24.1]) meshCyl(0.07, 0.07, 20.4, 7, mats.rust, px, 10.2, SOUTH.z0 + 0.14, { cast: false });
    for (const [ax, ay] of [[18.6, 6.3], [22.6, 10.6], [14.6, 14.4]]) {
      meshBox(0.86, 0.62, 0.4, mats.metal, ax, ay, SOUTH.z0 + 0.22, 0, { uv: 0.8 });
      meshBox(0.7, 0.5, 0.02, mats.metalTan, ax, ay, SOUTH.z0 + 0.45, 0, { uv: 0.5, cast: false });
    }
    grimeS(17.0, 1.1, SOUTH.z0 + 0.02, 13.0, 2.4);
    // left block south face (z = 54, x -23.85..-9.85, h 19)
    for (let row = 0; row < 3; row++) {
      const wy = 5.6 + row * 4.2;
      for (let col = 0; col < 3; col++) southWindow(-20.4 + col * 3.6, wy, 54.0, 1.2, 1.5, row === 1 && col === 1);
    }
    southShutter(-12.4, 54.0, 2.6);
    for (const [bx, by] of [[-13.4, 9.6], [-17.8, 12.4]]) {
      meshBox(0.86, 0.62, 0.4, mats.metal, bx, by, 54.2, 0, { uv: 0.8 });
    }
    grimeS(-16.8, 1.4, 54.02, 12.4, 2.8);
    meshCyl(0.07, 0.07, 17.6, 7, mats.rust, -10.4, 8.8, 54.12, { cast: false });
    for (let k = 0; k < 2; k++) {
      const gp = new THREE.Mesh(new THREE.PlaneGeometry(rr(1.6, 2.4), rr(0.9, 1.4)), mats.graffiti);
      gp.position.set(rr(12, 22), rr(0.8, 1.9), SOUTH.z0 + 0.04);
      statics.add(gp);
    }

    // ---------- shipping container (ribs + door bars, merged with the statics)
    function container(x, z, rot) {
      const g = new THREE.Group();
      const w = 2.44, h = 2.6, dep = 6.0;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), mats.rust);
      projectBoxUV(body.geometry, 1.6);
      body.position.y = h / 2 + 0.05;
      body.castShadow = true; body.receiveShadow = true;
      g.add(body);
      for (const sx of [-w / 2 - 0.03, w / 2 + 0.03]) {
        for (let i = 0; i < 11; i++) {
          const rib = new THREE.Mesh(new THREE.BoxGeometry(0.06, h - 0.2, 0.14), mats.metal);
          rib.position.set(sx, h / 2 + 0.05, -dep / 2 + 0.5 + i * 0.5);
          rib.castShadow = false;
          g.add(rib);
        }
      }
      const door = new THREE.Mesh(new THREE.BoxGeometry(w - 0.16, h - 0.24, 0.06), mats.metalTan);
      door.position.set(0, h / 2 + 0.05, dep / 2 + 0.02);
      g.add(door);
      for (const dx of [-0.5, 0.5]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, h - 0.4, 0.07), mats.metal);
        bar.position.set(dx, h / 2 + 0.05, dep / 2 + 0.07);
        g.add(bar);
      }
      for (const sx of [-w / 2, w / 2]) {
        for (const sz of [-dep / 2, dep / 2]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, h + 0.1, 0.12), mats.metal);
          post.position.set(sx, (h + 0.1) / 2, sz);
          g.add(post);
        }
      }
      g.position.set(x, 0, z);
      g.rotation.y = rot;
      statics.add(g);
      addColliderRot(x, z, w + 0.16, dep + 0.16, rot, 0.06, 2.6);
    }
  }

  /* ------------------------------------------------------------------ props */
  function barrel(x, z, { fire = false, y = 0, noLight = false } = {}) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.39, 0.94, 14, 1), mats.rust);
    body.position.y = 0.47; body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    for (const yy of [0.2, 0.74]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.385, 0.028, 6, 16), mats.metal);
      rim.rotation.x = Math.PI / 2; rim.position.y = yy; rim.castShadow = false;
      g.add(rim);
    }
    meshCyl(0.39, 0.39, 0.05, 14, mats.metal, 0, 0.95, 0, { group: g, cast: false });
    g.position.set(x, y, z);
    g.rotation.y = rnd() * 6;
    statics.add(g);
    addCollider(x, z, 0.85, 0.85, 0.05);
    blob(x, z, 0.62, 0.62, 0.42);
    if (fire) addFire(x, y + 0.95, z, { light: !noLight });
    return g;
  }

  function addFire(x, y, z, opts = {}) {
    const withLight = opts.light !== false;
    let light = null;
    if (withLight) {
      light = new THREE.PointLight(0xff7a2c, 14, 15, 2);
      light.position.set(x, y + 0.3, z);
      light.castShadow = false;
      dynamic.add(light);
    }

    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 14),
      new THREE.MeshBasicMaterial({ color: 0xff6a1e, toneMapped: false })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(x, y + 0.01, z);
    dynamic.add(glow);

    const sprites = [];
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: mats.sprites.glow, color: new THREE.Color(0xff8c3a),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
      }));
      const s = 0.55 + rnd() * 0.5;
      sp.scale.set(s, s * 1.4, 1);
      sp.position.set(x + (rnd() - 0.5) * 0.3, y + 0.1 + rnd() * 0.5, z + (rnd() - 0.5) * 0.3);
      dynamic.add(sp);
      sprites.push({ sp, phase: rnd() * 10, s });
    }
    const smoke = [];
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: mats.sprites.smoke, color: new THREE.Color(0x3a342c),
        transparent: true, depthWrite: false, opacity: 0.18,
      }));
      sp.scale.setScalar(1.7);
      sp.position.set(x, y + 0.5, z);
      dynamic.add(sp);
      smoke.push({ sp, t: rnd(), seed: rnd() * 10 });
    }
    fires.push({ light, sprites, smoke, base: new THREE.Vector3(x, y, z), intensity: 14, glow });
    lightPool(x, z, 1.9, 0.22);
  }

  function crate(x, z, size = 1.1, rot = 0, y = 0) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(roundedGeo(size, size * 0.84, size * 0.92, 0.03, 1.1), mats.wood);
    body.position.y = size * 0.42; body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    // slats
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const sl = new THREE.Mesh(new THREE.BoxGeometry(size * 1.01, size * 0.14, 0.05), mats.wood);
        sl.position.set(0, size * (0.16 + i * 0.24), sgn * size * 0.46);
        sl.castShadow = false;
        g.add(sl);
      }
    }
    g.position.set(x, y, z); g.rotation.y = rot;
    statics.add(g);
    addColliderRot(x, z, size, size * 0.92, rot, 0.03, 1.9);
    blob(x, z, size * 0.62, size * 0.58, 0.38, -rot);
    return g;
  }

  function crateStack(x, z, n = 3) {
    crate(x, z, 1.15, 0.2);
    if (n > 1) crate(x + 1.12, z - 0.18, 0.95, -0.3);
    if (n > 2) crate(x + 0.52, z - 0.03, 0.9, 0.7, 0.97);
    if (n > 3) crate(x - 0.24, z - 1.05, 0.82, 1.4);
  }

  function sandbagWall(cx, cz, rotY = 0, rows = 4, cols = 6, mat = mats.burlap) {
    const g = new THREE.Group();
    const bagGeo = roundedGeo(0.62, 0.25, 0.34, 0.1, 0.8);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bag = new THREE.Mesh(bagGeo, rnd() < 0.4 ? mats.burlap : mat);
        const offset = (r % 2) * 0.31;
        const slump = rnd() < 0.12 ? 0.72 : 1;
        bag.position.set(-cols * 0.31 + c * 0.62 + offset, 0.125 + r * 0.235, (rnd() - 0.5) * 0.08);
        bag.rotation.set((rnd() - 0.5) * 0.09, (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.09);
        bag.scale.set(1, slump, 1 + (rnd() - 0.5) * 0.08);
        bag.castShadow = true; bag.receiveShadow = true;
        g.add(bag);
      }
    }
    g.position.set(cx, 0, cz);
    g.rotation.y = rotY;
    statics.add(g);
    addColliderRot(cx, cz, cols * 0.62 + 0.1, 0.6, rotY, 0.1, 1.05);
    blob(cx, cz, cols * 0.33, 0.42, 0.4, -rotY);
    return g;
  }

  function addSandbags(x, z, rows, cols, side) {
    sandbagWall(x, z + (side < 0 ? 0.1 : -0.1), side < 0 ? 0.02 : Math.PI - 0.02, rows, cols, mats.sandbag);
  }

  function jerseyBarrier(x, z, rot = 0) {
    const g = new THREE.Group();
    // trapezoid profile in four chamfered slabs (sharp silhouette, fine texture)
    const prof = [
      [0.68, 0.26, 0.13, mats.concreteDark],
      [0.56, 0.26, 0.39, mats.concrete],
      [0.42, 0.24, 0.64, mats.concrete],
      [0.3, 0.24, 0.88, mats.concrete],
    ];
    for (const [w, hh, y, m] of prof) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 2.5), m);
      projectBoxUV(b.geometry, 1.15);
      b.position.y = y; b.castShadow = true; b.receiveShadow = true;
      g.add(b);
    }
    // base stain + chipped top + rebar stub
    const stain = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 2.52), mats.patch);
    stain.position.y = 0.05; g.add(stain);
    const chip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.4), mats.concreteDark);
    chip.position.set(0.16, 1.0, rr(-0.9, 0.9)); chip.rotation.z = 0.5; chip.rotation.y = 0.3; g.add(chip);
    const rb = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 4), mats.rust);
    rb.position.set(0.02, 1.12, 0.9); rb.rotation.z = 0.8; g.add(rb);
    g.position.set(x, 0, z); g.rotation.y = rot;
    statics.add(g);
    addColliderRot(x, z, 0.72, 2.5, rot, 0.05, 1.05);
    blob(x, z, 0.52, 1.32, 0.42, -rot);
    return g;
  }

  /* ---- vehicles ---------------------------------------------------------- */
  function carWreck(x, z, rot = 0, burnt = true) {
    const g = new THREE.Group();
    const bodyMat = burnt ? mats.rust : mats.metalTan;
    // ---- lower body: rounded, slightly narrower at the belt line
    const ch = new THREE.Mesh(roundedGeo(1.82, 0.66, 4.45, 0.13, 1.25), bodyMat);
    ch.position.y = 0.62; ch.castShadow = true; ch.receiveShadow = true; g.add(ch);
    // ---- hood / trunk: tapered sheet metal
    const hoodGeo = taperGeo(1.74, 0.3, 1.25, 0.9, 0.93);
    projectBoxUV(hoodGeo, 1.2);
    const hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(0, 0.9, 1.48); hood.castShadow = true; hood.receiveShadow = true; g.add(hood);
    const trunkGeo = taperGeo(1.74, 0.28, 1.02, 0.9, 0.94);
    projectBoxUV(trunkGeo, 1.2);
    const trunk = new THREE.Mesh(trunkGeo, bodyMat);
    trunk.position.set(0, 0.89, -1.62); trunk.castShadow = true; trunk.receiveShadow = true; g.add(trunk);
    // ---- cabin: dark glazed volume + body-coloured pillars + roof
    const cab = new THREE.Mesh(roundedGeo(1.66, 0.68, 2.2, 0.09, 1.0), mats.windowGlass);
    cab.position.set(0, 1.2, -0.12); cab.castShadow = true; cab.receiveShadow = true; g.add(cab);
    const roof = new THREE.Mesh(roundedGeo(1.52, 0.13, 1.88, 0.04, 1.0), bodyMat);
    roof.position.set(0, 1.56, -0.14); roof.castShadow = true; g.add(roof);
    // beltline chrome + roof drip rails + B pillars (define the cabin at distance)
    meshBox(1.74, 0.05, 2.26, mats.metalTan, 0, 1.44, -0.12, 0, { group: g, uv: 0.6, cast: false });
    meshBox(1.52, 0.04, 1.9, mats.rust, 0, 1.58, -0.14, 0, { group: g, uv: 0.6, cast: false });
    for (const sx of [-0.8, 0.8]) {
      meshBox(0.055, 0.46, 0.09, mats.metalTan, sx, 1.21, -0.12, 0, { group: g, uv: 0.5, cast: false });
    }
    // pillars
    for (const [pz, tilt] of [[0.94, -0.34], [-1.06, 0.3]]) {
      for (const sx of [-0.76, 0.76]) {
        const p = new THREE.Mesh(taperGeo(0.09, 0.62, 0.14, 0.8, 0.7), bodyMat);
        p.position.set(sx, 1.16, pz); p.rotation.x = tilt; p.castShadow = false; g.add(p);
      }
    }
    for (const sx of [-0.81, 0.81]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.58, 0.09), bodyMat);
      p.position.set(sx, 1.16, -0.12); p.castShadow = false; g.add(p);
    }
    // ---- smashed side glass: shards + black voids left in the frames
    for (const sx of [-0.82, 0.82]) {
      const vo = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 1.7), mats.interior);
      vo.position.set(sx, 1.16, -0.12); g.add(vo);
      for (let k = 0; k < 5; k++) {
        const sh = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.1, 0.26), rr(0.08, 0.24)), mats.glassBroken);
        sh.position.set(sx + (sx > 0 ? 0.035 : -0.035), 1.02 + rr(0, 0.26), rr(-1.0, 0.86));
        sh.rotation.set(rr(-0.4, 0.4), Math.PI / 2, rr(-0.6, 0.6));
        g.add(sh);
      }
    }
    // windshield frame + shattered pane
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.52), mats.glassBroken);
    ws.position.set(0, 1.2, 0.98); ws.rotation.x = -0.62; g.add(ws);
    const rs = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.46), mats.glassBroken);
    rs.position.set(0, 1.19, -1.18); rs.rotation.x = 0.6; rs.rotation.y = Math.PI; g.add(rs);
    // ---- doors (one missing / hanging)
    for (const sx of [-0.93, 0.93]) {
      if (burnt && sx > 0) {
        const fr = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 1.12), mats.metal);
        fr.position.set(sx, 1.4, 0.08); g.add(fr);
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.46), mats.gunMetalWorn);
        st.position.set(sx - 0.24, 0.9, -0.2); g.add(st);
        continue;
      }
      const door = new THREE.Mesh(taperGeo(0.08, 0.56, 1.12, 0.95, 0.98), bodyMat);
      door.position.set(sx, 0.72, 0.08); door.castShadow = true; g.add(door);
      const hd = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.17), mats.metal);
      hd.position.set(sx + (sx > 0 ? 0.035 : -0.035), 0.84, -0.32); g.add(hd);
    }
    // ---- wheel arches + wheels (two flat, one missing)
    const wheelPos = [[-1.0, 1.42, 1], [1.0, 1.42, 0.66], [-1.0, -1.47, 0.6], [1.0, -1.47, 1]];
    for (const [wx, wz, flat] of wheelPos) {
      const arch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 1.0), mats.rubber);
      arch.position.set(wx * 0.94, 0.66, wz); g.add(arch);
      const brow = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.06, 5, 10, Math.PI), bodyMat);
      brow.rotation.y = Math.PI / 2;
      brow.position.set(wx * 0.92, 0.52, wz);
      brow.scale.set(1, 1, 1.45);
      brow.castShadow = false;
      g.add(brow);
      if (flat < 0.6) {
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 8), mats.metal);
        hub.rotation.z = Math.PI / 2; hub.position.set(wx, 0.3, wz); g.add(hub);
        continue;
      }
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 16), mats.rubber);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(wx, flat < 0.85 ? 0.24 : 0.35, wz);
      wh.scale.set(1, flat < 0.85 ? 0.6 : 0.95, 1);
      wh.castShadow = true; g.add(wh);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.275, 8), mats.metal);
      hub.rotation.z = Math.PI / 2; hub.position.set(wx, wh.position.y, wz); g.add(hub);
    }
    // ---- bumpers, lights, plate, mirrors, seats
    const fb = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.16, 0.15), mats.metal);
    fb.position.set(0, 0.5, 2.24); fb.rotation.z = burnt ? 0.05 : 0; fb.castShadow = true; g.add(fb);
    const rb = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.14, 0.13), mats.metal);
    rb.position.set(0.12, 0.44, -2.24); rb.rotation.set(0.14, 0, -0.26); g.add(rb);
    for (const lx of [-0.6, 0.6]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 0.05), mats.glassBroken);
      hl.position.set(lx, 0.79, 2.19); g.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.05), mats.rubber);
      tl.position.set(lx, 0.79, -2.17); g.add(tl);
    }
    meshBox(0.34, 0.13, 0.03, mats.metalTan, 0, 0.54, -2.28, 0, { group: g, uv: 0.4, cast: false });
    for (const sx of [-1.0, 1.0]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.04), mats.metal);
      arm.position.set(sx, 1.02, 0.9); g.add(arm);
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.19), burnt ? mats.rust : mats.metalTan);
      mir.position.set(sx + (sx > 0 ? 0.07 : -0.07), 1.02, 0.9); g.add(mir);
    }
    for (const sx of [-0.4, 0.4]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.44), mats.gunMetalWorn);
      seat.position.set(sx, 0.86, -0.36); g.add(seat);
    }
    g.position.set(x, 0.02, z);
    g.rotation.y = rot;
    g.rotation.z = (rnd() - 0.5) * 0.04;
    statics.add(g);
    addColliderRot(x, z, 2.05, 4.55, rot, 0.05, 1.32);
    blob(x, z, 1.24, 2.36, 0.52, -rot, Math.abs(x) > 6.9 ? 0.176 : 0.012);
    return g;
  }

  function pickup(x, z, rot = 0, burnt = false) {
    const g = new THREE.Group();
    const bodyMat = burnt ? mats.rust : mats.metalTan;
    // chassis / lower body
    const ch = new THREE.Mesh(roundedGeo(1.98, 0.62, 4.95, 0.13, 1.25), bodyMat);
    ch.position.y = 0.74; ch.castShadow = true; ch.receiveShadow = true; g.add(ch);
    // hood (tapered)
    const hg = taperGeo(1.9, 0.28, 1.35, 0.9, 0.94);
    projectBoxUV(hg, 1.25);
    const hood = new THREE.Mesh(hg, bodyMat);
    hood.position.set(0, 1.0, 1.75); hood.castShadow = true; g.add(hood);
    // cab: glazed volume + roof + pillars
    const cab = new THREE.Mesh(roundedGeo(1.86, 0.86, 1.95, 0.1, 1.0), mats.windowGlass);
    cab.position.set(0, 1.48, 0.55); cab.castShadow = true; g.add(cab);
    const roof = new THREE.Mesh(roundedGeo(1.7, 0.11, 1.78, 0.05, 1.0), bodyMat);
    roof.position.set(0, 1.92, 0.52); roof.castShadow = true; g.add(roof);
    meshBox(1.9, 0.055, 1.98, mats.metalTan, 0, 1.82, 0.52, 0, { group: g, uv: 0.6, cast: false });
    for (const sx of [-0.93, 0.93]) {
      meshBox(0.06, 0.56, 0.09, mats.metalTan, sx, 1.5, 0.52, 0, { group: g, uv: 0.5, cast: false });
    }
    for (const [pz, tilt] of [[1.5, -0.34], [-0.4, 0.28]]) {
      for (const sx of [-0.86, 0.86]) {
        const pl = new THREE.Mesh(taperGeo(0.1, 0.82, 0.16, 0.8, 0.7), bodyMat);
        pl.position.set(sx, 1.43, pz); pl.rotation.x = tilt; g.add(pl);
      }
    }
    // broken side glass
    for (const sx of [-0.92, 0.92]) {
      const vo = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.52, 1.5), mats.interior);
      vo.position.set(sx, 1.42, 0.52); g.add(vo);
      for (let k = 0; k < 3; k++) {
        const sh = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.1, 0.24), rr(0.08, 0.2)), mats.glassBroken);
        sh.position.set(sx + (sx > 0 ? 0.035 : -0.035), 1.2 + rr(0, 0.3), rr(-0.2, 1.2));
        sh.rotation.set(rr(-0.4, 0.4), Math.PI / 2, rr(-0.6, 0.6));
        g.add(sh);
      }
    }
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.6), mats.glassBroken);
    ws.position.set(0, 1.52, 1.55); ws.rotation.x = -0.5; g.add(ws);
    // bed: floor, side walls, tailgate (missing on this one)
    const bedFloor = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.1, 2.15), mats.metal);
    bedFloor.position.set(0, 1.0, -1.55); g.add(bedFloor);
    for (const sx of [-0.88, 0.88]) {
      const wall = new THREE.Mesh(taperGeo(0.1, 0.56, 2.18, 0.9, 0.98), bodyMat);
      wall.position.set(sx, 1.28, -1.55); wall.castShadow = true; g.add(wall);
    }
    const bedFront = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.56, 0.1), bodyMat);
    bedFront.position.set(0, 1.28, -0.45); g.add(bedFront);
    // cargo: a tarp bundle + two tyres
    const cargo = new THREE.Mesh(roundedGeo(1.2, 0.5, 1.0, 0.1, 0.8), mats.burlap);
    cargo.position.set(-0.2, 1.35, -1.5); cargo.rotation.y = 0.2; cargo.castShadow = true; g.add(cargo);
    for (let i = 0; i < 2; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.13, 7, 14), mats.rubber);
      t.rotation.x = Math.PI / 2 + 0.08; t.position.set(0.45 + i * 0.05, 1.16 + i * 0.2, -2.1);
      t.castShadow = true; g.add(t);
    }
    // wheels (one flat, one missing hubcap)
    for (const [wx, wz, flat] of [[-1.06, 1.6, 1], [1.06, 1.6, 1], [-1.06, -1.62, 0.82], [1.06, -1.62, 0.55]]) {
      const arch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 1.12), mats.rubber);
      arch.position.set(wx * 0.94, 0.8, wz); g.add(arch);
      const brow = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.07, 5, 10, Math.PI), bodyMat);
      brow.rotation.y = Math.PI / 2;
      brow.position.set(wx * 0.92, 0.62, wz);
      brow.scale.set(1, 1, 1.5);
      brow.castShadow = false;
      g.add(brow);
      if (flat < 0.6) continue;
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.32, 16), mats.rubber);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(wx, flat < 0.9 ? 0.28 : 0.44, wz);
      wh.scale.set(1, flat < 0.9 ? 0.6 : 0.96, 1);
      wh.castShadow = true; g.add(wh);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.34, 8), mats.metal);
      hub.rotation.z = Math.PI / 2; hub.position.set(wx, wh.position.y, wz); g.add(hub);
    }
    // bumper, lights, mirrors
    meshBox(2.2, 0.18, 0.16, mats.metal, 0, 0.62, 2.5, 0, { group: g, uv: 0.8 });
    meshBox(2.1, 0.14, 0.12, mats.metal, 0.1, 0.58, -2.62, 0, { group: g, uv: 0.8 });
    for (const lx of [-0.66, 0.66]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), mats.glassBroken);
      hl.position.set(lx, 0.98, 2.5); g.add(hl);
    }
    for (const sx of [-1.06, 1.06]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.05), mats.metal);
      arm.position.set(sx, 1.3, 1.5); g.add(arm);
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.24), bodyMat);
      mir.position.set(sx + (sx > 0 ? 0.08 : -0.08), 1.3, 1.5); g.add(mir);
    }
    g.position.set(x, 0.02, z); g.rotation.y = rot;
    statics.add(g);
    addColliderRot(x, z, 2.18, 5.2, rot, 0.05, 2.7);
    blob(x, z, 1.3, 2.6, 0.52, -rot, Math.abs(x) > 6.9 ? 0.176 : 0.012);
    return g;
  }

  function boxTruck(x, z, rot = 0) {
    const g = new THREE.Group();
    // cab
    const cab = new THREE.Mesh(roundedGeo(2.2, 1.75, 2.2, 0.12, 1.4), mats.rust);
    cab.position.set(0, 1.28, 2.55); cab.castShadow = true; cab.receiveShadow = true; g.add(cab);
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.7), mats.glassBroken);
    ws.position.set(0, 1.7, 3.62); ws.rotation.x = -0.18; g.add(ws);
    // cargo box
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.35, 2.35, 4.3), mats.rust);
    projectBoxUV(box.geometry, 1.6);
    box.position.set(0, 1.55, -0.75); box.castShadow = true; box.receiveShadow = true; g.add(box);
    // tarp roof
    const tarp = new THREE.Mesh(roundedGeo(2.3, 0.28, 4.2, 0.08, 1.2), mats.burlap);
    tarp.position.set(0, 2.85, -0.75); tarp.castShadow = true; g.add(tarp);
    // side ribs (make the cargo box read as a truck body, not a black slab)
    for (const sx of [-1.19, 1.19]) {
      for (const yy of [0.75, 1.5, 2.25]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 4.15), mats.metal);
        rib.position.set(sx, yy, -0.75); rib.castShadow = false; g.add(rib);
      }
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.5, 4.2), mats.metal);
      skirt.position.set(sx, 0.55, -0.75); g.add(skirt);
      // rear door seam + hinges
      for (const dz of [-0.2, 0.2]) {
        const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.22), mats.metalTan);
        hinge.position.set(sx, 1.4, -2.88 + dz * 0.5); g.add(hinge);
      }
    }
    // rear doors
    for (const sx of [-0.58, 0.58]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.12, 2.1, 0.07), mats.rust);
      door.position.set(sx, 1.5, -2.93); door.castShadow = true; g.add(door);
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.05), mats.metal);
      lock.position.set(sx + (sx > 0 ? -0.48 : 0.48), 1.5, -2.9); g.add(lock);
    }
    const rearRail = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.09, 0.09), mats.metalTan);
    rearRail.position.set(0, 0.55, -2.96); g.add(rearRail);
    // burnt holes / dents (on the visible flank)
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.02, rr(0.3, 0.8), rr(0.4, 0.9)), mats.rust);
      d.position.set(rnd() > 0.5 ? 1.19 : -1.19, rr(0.8, 2.3), rr(-2.7, 1.2)); g.add(d);
    }
    // wheels (6) + flat ones
    for (const [wx, wz, flat] of [[-1.14, 2.4, 1], [1.14, 2.4, 0.5], [-1.14, -1.5, 1], [1.14, -1.5, 0.9], [-1.14, -2.5, 0.65], [1.14, -2.5, 1]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.32, 12), mats.rubber);
      wh.rotation.z = Math.PI / 2; wh.position.set(wx, flat < 0.7 ? 0.28 : 0.46, wz);
      wh.scale.set(1, flat < 0.7 ? 0.62 : 0.96, 1);
      wh.castShadow = true; g.add(wh);
    }
    // bumper
    meshBox(2.3, 0.18, 0.18, mats.metal, 0, 0.55, 3.7, 0, { group: g, uv: 0.8 });
    g.position.set(x, 0.02, z); g.rotation.y = rot;
    statics.add(g);
    addColliderRot(x, z, 2.5, 6.2, rot, 0.05);
    blob(x, z, 1.5, 3.2, 0.55, -rot, Math.abs(x) > 6.9 ? 0.176 : 0.012);
    return g;
  }

  function dumpster(x, z, rot = 0) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(roundedGeo(1.45, 1.1, 2.05, 0.05, 1.4), mats.metal);
    b.position.y = 0.65; b.castShadow = true; b.receiveShadow = true; g.add(b);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 2.1), mats.rust);
    lid.position.set(0, 1.22, -0.08); lid.rotation.x = -0.24; lid.castShadow = true; g.add(lid);
    for (const sx of [-0.6, 0.6]) {
      for (const wz of [-0.7, 0.7]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.07, 8), mats.rubber);
        wheel.rotation.z = Math.PI / 2; wheel.position.set(sx, 0.09, wz);
        g.add(wheel);
      }
    }
    const gd = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), mats.graffiti);
    gd.position.set(0.73, 0.8, 0); gd.rotation.y = Math.PI / 2;
    g.add(gd);
    // trash overflowing
    for (let i = 0; i < 5; i++) {
      const bag = new THREE.Mesh(roundedGeo(rr(0.3, 0.5), rr(0.25, 0.4), rr(0.3, 0.5), 0.12, 0.6), mats.burlap);
      bag.position.set(rr(-0.7, 0.7), 1.3 + rr(0, 0.2), rr(-1, 1));
      bag.castShadow = true;
      g.add(bag);
    }
    g.position.set(x, 0, z); g.rotation.y = rot;
    statics.add(g);
    addColliderRot(x, z, 1.6, 2.2, rot, 0.06);
    blob(x, z, 1.0, 1.32, 0.45, -rot);
  }

  function pallet(x, z, rot = 0) {
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.045, 0.13), mats.wood);
      p.position.set(0, 0.15, -0.44 + i * 0.22); p.castShadow = true; g.add(p);
    }
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 1.0), mats.wood);
      b.position.set(-0.4 + i * 0.4, 0.07, 0); b.castShadow = true; g.add(b);
    }
    g.position.set(x, 0, z); g.rotation.y = rot; statics.add(g);
  }

  function tireStack(x, z, n = 3) {
    for (let i = 0; i < n; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.14, 7, 14), mats.rubber);
      t.rotation.set(Math.PI / 2 + rr(-0.15, 0.15), rr(0, 6), rr(-0.1, 0.1));
      t.position.set(x + rr(-0.12, 0.12), 0.15 + i * 0.28, z + rr(-0.12, 0.12));
      t.castShadow = true;
      statics.add(t);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.13, 10), mats.metalTan);
      rim.rotation.copy(t.rotation);
      rim.position.copy(t.position);
      statics.add(rim);
    }
    addCollider(x, z, 0.9, 0.9, 0.02);
    blob(x, z, 0.5, 0.5, 0.38);
  }

  function tire(x, z, rot = 0) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.14, 7, 14), mats.rubber);
    t.rotation.set(Math.PI / 2 + rr(-0.3, 0.3), rot, rr(-0.2, 0.2));
    t.position.set(x, 0.15, z);
    t.castShadow = true;
    statics.add(t);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 10), mats.metalTan);
    rim.rotation.copy(t.rotation);
    rim.position.copy(t.position);
    statics.add(rim);
  }

  function addTrashPile(cz, side, spread = 1.4) {
    const x0 = side * (OUT - 0.55);
    for (let i = 0; i < 7; i++) {
      const bag = new THREE.Mesh(roundedGeo(rr(0.26, 0.44), rr(0.22, 0.38), rr(0.26, 0.46), 0.12, 0.6), rnd() < 0.5 ? mats.burlap : mats.metal);
      bag.position.set(x0 + rr(-0.4, 0.4), 0.18, cz + rr(-spread, spread));
      bag.rotation.set(rr(-0.2, 0.2), rr(0, 6), rr(-0.2, 0.2));
      bag.castShadow = true; bag.receiveShadow = true;
      statics.add(bag);
    }
    // cardboard / paper
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(rr(0.4, 0.8), rr(0.5, 1.0)), mats.paper);
      c.rotation.set(-Math.PI / 2 + rr(-0.3, 0.3), rr(0, 6), 0);
      c.position.set(x0 + rr(-0.7, 0.7), 0.08 + i * 0.05, cz + rr(-spread, spread));
      statics.add(c);
    }
    addCollider(x0, cz, 0.9, spread * 2, 0.05);
    blob(x0, cz, 0.5, spread * 0.85, 0.32);
  }

  function addRubble(cx, cz, radius = 2, count = 26) {
    const rockA = new THREE.DodecahedronGeometry(1, 0);
    const rockB = new THREE.IcosahedronGeometry(1, 0);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.65) * radius;
      const s = 0.12 + rnd() * (radius * 0.24);
      const geo = (rnd() > 0.4 ? rockA : rockB).clone();
      projectBoxUV(geo, s < 0.22 ? 0.5 : 1.6);
      const chunkMat = s < 0.22 ? mats.brick : pick([mats.concrete, mats.concreteDark, mats.concrete]);
      const m = new THREE.Mesh(geo, chunkMat);
      const y = s * 0.55 + Math.max(0, (1 - r / radius)) * 0.18;
      m.position.set(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      m.scale.set(s * rr(0.7, 1.4), s * rr(0.5, 1.0), s * rr(0.7, 1.4));
      m.rotation.set(rnd() * 3, rnd() * 6, rnd() * 3);
      m.castShadow = true; m.receiveShadow = true;
      statics.add(m);
    }
    // rebar / broken bricks
    for (let i = 0; i < Math.min(8, count / 3); i++) {
      const l = 0.5 + rnd() * 1.4;
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, l, 4), mats.rust);
      c.position.set(cx + (rnd() - 0.5) * radius * 1.6, l * 0.42, cz + (rnd() - 0.5) * radius * 1.6);
      c.rotation.set((rnd() - 0.5) * 1.4, rnd() * 6, (rnd() - 0.5) * 1.4);
      c.castShadow = false;
      statics.add(c);
    }
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.12), mats.brick);
      b.position.set(cx + (rnd() - 0.5) * radius * 1.7, 0.08, cz + (rnd() - 0.5) * radius * 1.7);
      b.rotation.set(rnd(), rnd() * 6, rnd());
      statics.add(b);
    }
    if (radius >= 1.8) addCollider(cx, cz, radius * 1.1, radius * 1.1, 0.05);
  }

  function addWeeds(cx, cz, count = 4, side = 1) {
    for (let i = 0; i < count; i++) {
      const s = rr(0.26, 0.55);
      const x = cx + rr(-0.35, 0.35);
      const z = cz + rr(-0.9, 0.9);
      for (let p = 0; p < 2; p++) {
        const g = new THREE.PlaneGeometry(s * 1.25, s);
        const m = new THREE.Mesh(g, mats.weed);
        m.position.set(x, s * 0.46, z);
        m.rotation.set(rr(-0.08, 0.08), p * Math.PI / 2 + rr(-0.35, 0.35), rr(-0.12, 0.12));
        m.castShadow = false;
        statics.add(m);
      }
    }
  }

  function addLitter(x0, x1, z0, z1, n) {
    for (let i = 0; i < n; i++) {
      const x = rr(x0, x1), z = rr(z0, z1);
      const kind = rnd();
      if (kind < 0.55) {
        // paper scraps
        const s = rr(0.14, 0.34);
        const p = new THREE.Mesh(new THREE.PlaneGeometry(s, s * rr(0.7, 1.3)), mats.paper);
        p.position.set(x, 0.02 + rnd() * 0.02, z);
        p.rotation.set(-Math.PI / 2 + rr(-0.35, 0.35), rr(0, 6.3), rr(-0.2, 0.2));
        statics.add(p);
      } else if (kind < 0.72) {
        // cans / bottles
        const h = rr(0.1, 0.24);
        const c = new THREE.Mesh(new THREE.CylinderGeometry(rr(0.035, 0.06), rr(0.035, 0.06), h, 6), rnd() > 0.6 ? mats.glassBroken : mats.metalTan);
        c.position.set(x, h / 2 + 0.01, z);
        c.rotation.set(Math.PI / 2 + rr(-0.3, 0.3), rr(0, 6), rr(-0.4, 0.4));
        statics.add(c);
      } else if (kind < 0.86) {
        // brick chunks / rubble bit
        const b = new THREE.Mesh(new THREE.BoxGeometry(rr(0.1, 0.24), rr(0.05, 0.1), rr(0.1, 0.2)), rnd() > 0.5 ? mats.brick : mats.concreteDark);
        b.position.set(x, 0.04, z);
        b.rotation.set(rr(-0.3, 0.3), rr(0, 6), rr(-0.3, 0.3));
        statics.add(b);
      } else {
        // shell casings
        for (let s = 0; s < 3; s++) {
          const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.045, 5), mats.metalTan);
          sh.position.set(x + rr(-0.12, 0.12), 0.012, z + rr(-0.12, 0.12));
          sh.rotation.set(Math.PI / 2 + rr(-0.2, 0.2), rr(0, 6), 0);
          statics.add(sh);
        }
      }
    }
  }

  function addPuddles(list) {
    for (const [px, pz, rad, sq] of list) {
      const g = new THREE.CircleGeometry(rad, 26);
      const p = g.attributes.position;
      for (let k = 1; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k);
        const a = Math.atan2(y, x), rl = Math.hypot(x, y) / rad;
        p.setZ(k, Math.sin(a * 6 + px) * 0.005 * rl);
      }
      g.computeVertexNormals();
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mats.puddle);
      m.position.set(px, 0.012, pz);
      m.userData.noAO = true;
      statics.add(m);
    }
  }

  /* ---- cables / lines ---------------------------------------------------- */
  function cableLine(p0, p1, sag, radius, mat = mats.rubber, segs = 10) {
    const mid = p0.clone().lerp(p1, 0.5);
    mid.y -= sag;
    const curve = new THREE.CatmullRomCurve3([p0, mid, p1]);
    const geo = new THREE.TubeGeometry(curve, segs, radius, 4, false);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false; m.receiveShadow = false;
    statics.add(m);
    return m;
  }

  function addLaundryCloth(x, y, z, side, across = false) {
    // a hanging piece of cloth: slightly curved plane
    const w = rr(0.45, 0.85), hh = rr(0.5, 0.95);
    const g = new THREE.PlaneGeometry(w, hh, 3, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i) / (w / 2);
      p.setZ(i, Math.cos(px * 1.4) * 0.06 + Math.sin(p.getY(i) * 3) * 0.02);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, rnd() < 0.5 ? mats.burlap : mats.sandbag);
    m.position.set(x, y - hh / 2, z);
    m.rotation.y = across ? rr(-0.4, 0.4) : -side * Math.PI / 2 + rr(-0.2, 0.2);
    m.castShadow = true;
    statics.add(m);
    return m;
  }

  /* ---- street furniture -------------------------------------------------- */
  function powerPole(x, z, side) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.12, 9.2, 8), mats.concreteDark);
    projectBoxUV(pole.geometry, 1.2);
    pole.position.set(x, 4.6, z); pole.castShadow = true;
    statics.add(pole);
    meshBox(0.9, 0.042, 0.042, mats.metal, x, 8.45, z, 0, { uv: 0.6, cast: false });
    meshBox(0.72, 0.04, 0.04, mats.metal, x, 7.95, z, 0, { uv: 0.6, cast: false });
    for (const sgn of [-1, 1]) {
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.035), mats.metal);
      br.position.set(x + sgn * 0.4, 8.28, z);
      br.rotation.z = sgn * 0.6;
      statics.add(br);
    }
    for (const off of [-0.5, 0.5]) {
      meshCyl(0.028, 0.036, 0.16, 5, mats.metal, x + off, 8.35, z, { cast: false });
    }
    for (const off of [-0.4, 0.4]) {
      meshCyl(0.026, 0.032, 0.14, 5, mats.metal, x + off, 7.86, z, { cast: false });
    }
    // transformer
    if (rnd() < 0.45) meshCyl(0.2, 0.2, 0.5, 8, mats.metal, x + side * 0.24, 7.45, z, { cast: false });
    addCollider(x, z, 0.4, 0.4, 0.03);
    blob(x, z, 0.34, 0.34, 0.32);
    return { x, z };
  }

  function streetLamp(x, z, side, broken = false) {
    const h = 7.4;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, h, 7), mats.metal);
    pole.position.set(x, h / 2, z);
    pole.rotation.z = broken ? side * 0.05 : 0;
    pole.castShadow = true;
    statics.add(pole);
    const armLen = 1.55;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.07, 0.07), mats.metal);
    arm.position.set(x - side * armLen / 2, h - 0.15, z);
    arm.rotation.z = broken ? side * 0.06 : 0;
    statics.add(arm);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.16, 0.3), mats.metalTan);
    head.position.set(x - side * armLen, h - 0.26, z);
    head.castShadow = true;
    statics.add(head);
    if (!broken) {
      meshBox(0.34, 0.05, 0.2, mats.metal, x - side * armLen, h - 0.35, z, 0, { uv: 0.5, cast: false });
    }
    addCollider(x, z, 0.28, 0.28, 0.02);
    blob(x, z, 0.28, 0.28, 0.3);
  }

  function signPost(x, z, rot = 0) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 3.1, 6), mats.metal);
    pole.position.set(x, 1.55, z); pole.rotation.z = 0.06; pole.castShadow = true;
    statics.add(pole);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.55, 0.05), mats.signC);
    sign.position.set(x + 0.1, 2.7, z); sign.rotation.set(0, rot, 0.09); sign.castShadow = true;
    statics.add(sign);
  }

  function palmTree(x, z, scale = 1) {
    const g = new THREE.Group();
    const h = 7.2 * scale;
    const segs = 8;
    let px = 0, pz = 0;
    const bendX = rr(-0.18, 0.18), bendZ = rr(-0.18, 0.18);
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const y = t * h;
      const rc = (0.19 - t * 0.08) * scale;
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(rc * 0.92, rc, h / segs + 0.06, 8), mats.wood);
      px = bendX * scale * t * t * 3;
      pz = bendZ * scale * t * t * 3;
      seg.position.set(px, y + h / segs / 2, pz);
      seg.rotation.z = -bendX * 0.5;
      seg.castShadow = true; seg.receiveShadow = true;
      g.add(seg);
    }
    const topX = bendX * scale * 3, topZ = bendZ * scale * 3;
    // fronds
    const nf = 15;
    for (let i = 0; i < nf; i++) {
      const a = (i / nf) * Math.PI * 2 + rr(-0.12, 0.12);
      const L = (2.3 + rnd() * 0.9) * scale;
      const geo = new THREE.PlaneGeometry(L, 0.62 * scale);
      geo.rotateX(-Math.PI / 2);
      geo.translate(L / 2, 0, 0);
      for (const layer of [0, 1]) {
        const gg = geo.clone();
        const f = new THREE.Mesh(gg, mats.frond);
        f.position.set(topX, h - 0.1 - layer * 0.25, topZ);
        f.rotation.y = a + layer * 0.3;
        f.rotation.z = layer ? -rr(0.75, 1.15) : -rr(0.2, 0.6);
        f.scale.setScalar(layer ? 0.78 : 1);
        f.castShadow = true;
        g.add(f);
      }
    }
    // dead fronds hanging
    for (let i = 0; i < 3; i++) {
      const L = 1.3 * scale;
      const geo = new THREE.PlaneGeometry(L, 0.4 * scale);
      geo.rotateX(-Math.PI / 2); geo.translate(L / 2, 0, 0);
      const f = new THREE.Mesh(geo, mats.burlap);
      f.position.set(topX, h - 0.15, topZ);
      f.rotation.y = rr(0, 6);
      f.rotation.z = -1.45;
      g.add(f);
    }
    g.position.set(x, 0, z);
    statics.add(g);
    addCollider(x, z, 0.5, 0.5, 0.02);
    blob(x, z, 0.55, 0.55, 0.36);
  }

  function distantCity() {
    const m1 = new THREE.MeshStandardMaterial({ color: 0x585449, roughness: 1, metalness: 0 });
    const m2 = new THREE.MeshStandardMaterial({ color: 0x423f38, roughness: 1, metalness: 0 });
    const blocks = [];
    for (let i = 0; i < 34; i++) {
      let x = 0, z = 0, tries = 0;
      do {
        x = (rnd() - 0.5) * 300;
        z = -104 - rnd() * 155;
        tries++;
      } while (tries < 40 && Math.abs(x) < 34 && z > -180);
      const w = 8 + rnd() * 24, d = 8 + rnd() * 24;
      let h = 10 + rnd() * 58;
      if (Math.abs(x) < 70) h = Math.min(h, 30);
      if (Math.abs(x) < 34) h = Math.min(h, 16);
      const geo = new THREE.BoxGeometry(w, h, d);
      projectBoxUV(geo, 9);
      const b = new THREE.Mesh(geo, rnd() > 0.5 ? m1 : m2);
      b.position.set(x, h / 2, z);
      blocks.push(b);
      // rooftop silhouette: setback / antenna
      if (rnd() < 0.5) {
        const g2 = new THREE.BoxGeometry(w * 0.45, 3 + rnd() * 6, d * 0.45);
        const b2 = new THREE.Mesh(g2, b.material);
        b2.position.set(x + rr(-w * 0.2, w * 0.2), h + 2, z + rr(-d * 0.2, d * 0.2));
        blocks.push(b2);
      }
    }
    // minaret + dome (a city landmark reads through the fog)
    const mw = new THREE.MeshStandardMaterial({ color: 0x5c574d, roughness: 1 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 34, 10), mw);
    shaft.position.set(-9.5, 17, -88);
    farGroup.add(shaft);
    const balc = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.8, 10), mw);
    balc.position.set(-9.5, 27, -88); farGroup.add(balc);
    const balc2 = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.6, 10), mw);
    balc2.position.set(-9.5, 20, -88); farGroup.add(balc2);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3.2, 10), mw);
    cap.position.set(-9.5, 35.6, -88); farGroup.add(cap);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(5.2, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), mw);
    dome.position.set(-20, 11, -94); farGroup.add(dome);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 6, 14), mw);
    drum.position.set(-20, 8, -94); farGroup.add(drum);
    // water tower
    const wt = new THREE.Group();
    for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 22, 6), mw);
      leg.position.set(lx, 11, lz); wt.add(leg);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 5, 12), mw);
    tank.position.y = 24; wt.add(tank);
    const tcap = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.6, 12), mw);
    tcap.position.y = 27.8; wt.add(tcap);
    wt.position.set(27, 0, -92);
    farGroup.add(wt);
    // construction crane
    const crane = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 46, 1.2), mw);
    mast.position.y = 23; crane.add(mast);
    const jib = new THREE.Mesh(new THREE.BoxGeometry(34, 1, 1), mw);
    jib.position.set(10, 45, 0); crane.add(jib);
    crane.position.set(-52, 0, -128);
    farGroup.add(crane);
    for (const b of blocks) farGroup.add(b);
    // distant smoke columns
    for (const [sx, sz, n] of [[-52, -150, 5], [40, -172, 6], [6, -196, 5], [-116, -136, 4]]) {
      for (let i = 0; i < n; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: mats.sprites.smoke, color: new THREE.Color(0x4a4238),
          transparent: true, opacity: 0.11, depthWrite: false,
        }));
        const s = 16 + i * 8;
        sp.scale.set(s, s * 1.3, 1);
        sp.position.set(sx + Math.sin(i * 0.8) * 9, 8 + i * 10, sz + Math.cos(i) * 7);
        dynamic.add(sp);
      }
    }
  }

  /* ------------------------------------------------------------------ build */
  buildGround();

  const BUILDINGS = [
    // left side
    { side: -1, z0: 26, z1: 54, depth: 14, h: 19, detail: 'high', plaster: mats.plasterB, ground: 'wall', bays: 7 },
    { side: -1, z0: 6, z1: 26, depth: 15, h: 22, detail: 'high', plaster: mats.plasterA, ground: 'shutter', bays: 6 },
    { side: -1, z0: -16, z1: 0, depth: 15, h: 16, detail: 'high', plaster: mats.plasterC, ground: 'shop', bays: 5, interior: 'workshop' },
    { side: -1, z0: -36, z1: -16, depth: 14, h: 25, detail: 'high', plaster: mats.plasterB, ground: 'shop', bays: 6 },
    { side: -1, z0: -54, z1: -36, depth: 13, h: 18, detail: 'mid', plaster: mats.plasterA, facade: 'C', ground: 'wall', balconies: 2 },
    { side: -1, z0: -66, z1: -54, depth: 15, h: 20, detail: 'ruin', plaster: mats.plasterB, ground: 'wall' },
    // right side
    { side: 1, z0: 30, z1: 56, depth: 15, h: 22, detail: 'high', plaster: mats.plasterA, ground: 'shutter', bays: 7 },
    { side: 1, z0: 12, z1: 30, depth: 16, h: 15, detail: 'high', plaster: mats.plasterA, ground: 'shop', bays: 6 },
    { side: 1, z0: -6, z1: 12, depth: 15, h: 24, detail: 'high', plaster: mats.plasterB, ground: 'door', bays: 6 },
    { side: 1, z0: -26, z1: -6, depth: 14, h: 18, detail: 'high', plaster: mats.plasterC, ground: 'shop', bays: 6, interior: 'apartment', roofHole: { x0: 17.0, x1: 24.35, z0: -16.0, z1: -6.2 } },
    { side: 1, z0: -46, z1: -26, depth: 15, h: 21, detail: 'mid', plaster: mats.plasterB, facade: 'D', ground: 'wall', balconies: 2 },
    { side: 1, z0: -64, z1: -46, depth: 14, h: 13, detail: 'ruin', plaster: mats.plasterA, ground: 'wall' },
  ];
  for (const b of BUILDINGS) buildBuilding(b);
  buildYardMarketStatic();
  buildAlley();
  buildGatehouse();
  buildNorthYard();
  buildEastDock();
  buildSouthYard();
  buildExpansion();
  buildBackdrop();
  buildFoothills();

  // ---- fire escapes on the two closest multi-storey fronts
  function fireEscape(side, z, floors, fh) {
    const xf = (d) => side * (OUT - d);
    for (let f = 0; f < floors; f++) {
      const y = 4.6 + f * fh;
      meshBox(0.92, 0.09, 3.2, mats.rust, xf(0.48), y, z, 0, { uv: 1.0 });
      for (let k = 0; k < 8; k++) {
        meshBox(0.035, 0.86, 0.035, mats.rust, xf(0.92), y + 0.48, z - 1.5 + k * 0.43, 0, { uv: 0.5, cast: false });
      }
      meshBox(0.05, 0.05, 3.2, mats.rust, xf(0.92), y + 0.92, z, 0, { uv: 0.5, cast: false });
      meshBox(0.05, 0.05, 3.2, mats.rust, xf(0.15), y + 0.92, z, 0, { uv: 0.5, cast: false });
      if (f < floors - 1) {
        // diagonal ladder between platforms
        for (const sgn of [-1, 1]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.9, 0.05), mats.rust);
          rail.position.set(xf(0.85 + sgn * 0.12), y + fh / 2, z + sgn * 0.42);
          rail.rotation.x = sgn * 0.25;
          statics.add(rail);
        }
        for (let r = 0; r < 8; r++) {
          meshBox(0.05, 0.045, 0.82, mats.rust, xf(0.85), y + 0.4 + r * (fh - 0.5) / 8, z, 0, { uv: 0.4, cast: false });
        }
      }
    }
  }
  fireEscape(-1, 13.5, 4, 3.3);
  fireEscape(1, 2.5, 4, 3.3);
  fireEscape(1, -18.5, 3, 3.1);

  /* ---- hero street props ------------------------------------------------ */
  carWreck(-3.3, 13.2, 0.34, true);
  carWreck(4.6, -10.5, -0.22, false);
  carWreck(-1.4, -44.5, 1.15, true);
  pickup(3.9, -32.5, 0.18, false);
  pickup(-6.9, -8.6, 1.92, true);
  boxTruck(4.7, -24.8, 1.44);
  boxTruck(-5.9, -57.5, -0.25);
  carWreck(5.1, 17.4, -0.78, true);
  carWreck(-7.5, 34.6, -0.95, false);

  jerseyBarrier(-3.3, 21.4, 0.10);
  jerseyBarrier(-2.15, 21.2, 0.06);
  jerseyBarrier(3.0, -2.8, 0.7);
  jerseyBarrier(-5.0, -8.6, 1.45);
  jerseyBarrier(-3.9, -8.2, 1.42);
  jerseyBarrier(-1.4, -13.2, 0.22);
  jerseyBarrier(2.6, -14.6, -0.34);
  tireStack(-0.4, -15.4, 2);
  addRubble(1.2, -17.2, 1.3, 10);
  crate(-3.2, -16.4, 0.72, 0.9);

  sandbagWall(-4.9, 28.0, 0.06, 4, 7, mats.burlap);
  sandbagWall(6.1, 16.2, -0.5, 3, 5, mats.sandbag);
  sandbagWall(-6.4, -24.2, 1.2, 3, 5, mats.burlap);
  sandbagWall(5.6, -46.5, -0.3, 3, 5, mats.burlap);

  crateStack(-11.6, 4.7, 3);
  crateStack(6.3, -21.5, 3);
  crate(-6.2, 15.2, 1.0, 0.4);
  crate(-2.0, -52.5, 0.9, 0.8);
  dumpster(-7.3, 22.6, 1.57);
  dumpster(7.4, -43.5, -1.5);
  dumpster(-14.2, 4.7, 1.55);

  addFire(-1.9, 0.95, -23.6);
  barrel(5.55, 18.6, { fire: true });
  barrel(-6.25, -22.8, { fire: true });
  barrel(-5.5, 13.5);
  barrel(6.35, -37.5);
  barrel(-6.7, -49.2);

  tire(-6.3, 19.8, 0.4); tire(-5.7, 20.6, 1.2); tire(6.5, -6.4, 0.2);
  tireStack(6.9, 41.5, 3);
  tireStack(-6.9, -34.5, 4);
  pallet(-5.9, 10.9, 0.6); pallet(6.2, 27.4, 1.2);
  pallet(-20.9, 5.1, 0.4);
  signPost(6.85, 22.4, 0.3);
  signPost(-6.9, -30.2, -0.2);
  streetLamp(7.3, 33.5, 1, false);
  streetLamp(-7.3, 6.8, -1, true);
  streetLamp(7.3, -19.5, 1, false);
  streetLamp(-7.3, -46.5, -1, true);

  // utility poles + overhead lines (the street reads as a corridor of cables)
  const polesL = [44, 26, 12, -10, -28, -46, -62].map((z) => powerPole(-7.55, z, -1));
  const polesR = [36, 18, 0, -18, -36, -54].map((z) => powerPole(7.55, z, 1));
  for (let i = 1; i < polesL.length; i++) {
    for (const off of [-0.5, 0.5]) {
      cableLine(
        new THREE.Vector3(-7.55 + off, 8.55, polesL[i - 1].z),
        new THREE.Vector3(-7.55 + off, 8.55, polesL[i].z), 0.5 + Math.abs(polesL[i].z - polesL[i - 1].z) * 0.006, 0.02,
      );
    }
  }
  for (let i = 1; i < polesR.length; i++) {
    for (const off of [-0.55, 0.55]) {
      cableLine(
        new THREE.Vector3(7.55 + off, 8.45, polesR[i - 1].z),
        new THREE.Vector3(7.55 + off, 8.45, polesR[i].z), 0.45 + Math.abs(polesR[i].z - polesR[i - 1].z) * 0.006, 0.018,
      );
    }
  }
  // crossing cables between facades
  for (const [cz, h1, sag] of [[20, 8.9, 2.1], [2.4, 7.6, 1.7], [-16, 9.4, 2.3], [-38, 8.2, 2.0], [-56, 7.4, 1.6]]) {
    const z2 = cz + rr(-1.5, 1.5), h2 = h1 + rr(-0.3, 0.3);
    cableLine(new THREE.Vector3(-9.6, h1, cz), new THREE.Vector3(9.6, h2, z2), sag, 0.013);
    cableLine(new THREE.Vector3(-9.6, h1 - 0.5, cz + 0.5), new THREE.Vector3(9.6, h2 - 0.3, z2 + 0.7), sag * 0.9, 0.009);
    // wall anchors so the wires visibly terminate on the facades
    for (const sx of [-1, 1]) {
      meshBox(0.14, 0.14, 0.2, mats.rust, sx * (OUT - 0.07), h1 - 0.25, sx < 0 ? cz : z2, 0, { uv: 0.4, cast: false });
    }
  }
  // bare laundry lines across the street (cloth stays on balconies / in the alley)
  for (const cz of [10.5, -12.5]) {
    cableLine(new THREE.Vector3(-9.4, 6.4, cz), new THREE.Vector3(9.4, 6.7, cz + 1.2), 1.1, 0.01);
  }

  palmTree(-8.6, 33.5, 1.05);
  palmTree(8.7, -34.5, 0.95);
  palmTree(-8.9, -51.5, 1.1);

  /* ---- surface litter & growth ----------------------------------------- */
  addLitter(-9.3, -7.0, -62, 52, 90);
  addLitter(7.0, 9.3, -62, 52, 90);
  addLitter(-6.4, 6.4, -62, 52, 50);
  addLitter(-21.5, -10.5, 0.3, 5.7, 40);
  for (const z of [38, 29, 20, 11, 2, -7, -16, -25, -34, -43, -52]) {
    addWeeds(-9.62, z, 2);
    addWeeds(9.62, z, 2);
  }
  for (const z of [34, 17, -4, -26, -48]) {
    addWeeds(-6.86, z, 1);
    addWeeds(6.86, z, 1);
  }
  addRubble(-6.5, 40.5, 2.7, 26);
  addRubble(7.4, 7.4, 2.0, 18);
  addRubble(-7.7, -46.5, 2.4, 20);
  addRubble(6.8, 28.5, 1.5, 12);
  addRubble(-7.0, 19.5, 1.25, 10);
  addRubble(-4.2, -31.5, 1.8, 14);
  addTrashPile(21.6, -1, 1.6);
  addTrashPile(-12.5, -1, 1.3);
  addTrashPile(-31.4, 1, 1.2);
  addTrashPile(46.2, 1, 1.2);

  distantCity();

  /* ------------------------------------------------------------------ dust motes */
  const dustCount = 1200;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustCount * 3);
  const dustSeed = new Float32Array(dustCount);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (rnd() - 0.5) * 34;
    dustPos[i * 3 + 1] = 0.2 + Math.pow(rnd(), 0.7) * 12;
    dustPos[i * 3 + 2] = (rnd() - 0.5) * 110;
    dustSeed[i] = rnd() * 100;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
  const dustMat = new THREE.PointsMaterial({
    size: 0.04, map: mats.sprites.glow, color: 0xffe6c4,
    transparent: true, opacity: 0.45, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  /* Drift runs on the GPU now: the CPU version integrated 1200 particles with
     two trig calls each and re-uploaded the whole position buffer EVERY frame
     (~15 KB/frame upload + ~144k sin/cos per second). The shader reproduces
     the same motion: slow rise with wraparound + gentle sway. */
  const dustTime = { value: 0 };
  dustMat.onBeforeCompile = (shader) => {
    shader.uniforms.uDustTime = dustTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uDustTime;\nattribute float aSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.x += sin(uDustTime * 0.35 + aSeed * 1.7) * 0.26;
        transformed.y = mod(position.y - 0.2 + uDustTime * 0.012, 12.8) + 0.2
                      + sin(uDustTime * 0.6 + aSeed) * 0.083;
      `);
  };
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  dynamic.add(dust);

  /* ------------------------------------------------------------------ merge */
  const merged = mergeStatic(statics);
  merged.traverse((o) => {
    if (!o.isMesh) return;
    const ud = (o.material && o.material.userData) || {};
    o.castShadow = !ud.noShadow;
    o.receiveShadow = true;
  });
  root.add(merged);
  statics.clear();

  // Season 3 districts: merge each group separately so it keeps a local
  // bounding volume (frustum culling keeps the street cost flat).
  const districtMerged = [];
  for (const key of ['souk', 'rail', 'port']) {
    const grp = EXPANSION_GROUPS[key];
    if (!grp || !grp.children.length) continue;
    const dm = mergeStatic(grp);
    dm.name = 'district:' + key;
    dm.traverse((o) => {
      if (!o.isMesh) return;
      const ud = (o.material && o.material.userData) || {};
      o.castShadow = !ud.noShadow;
      o.receiveShadow = true;
    });
    root.add(dm);
    districtMerged.push(dm);
  }

  // far silhouettes: merged, never shadow casting
  const farMerged = mergeStatic(farGroup, { castShadow: false, receiveShadow: false });
  root.add(farMerged);
  farGroup.clear();

  // Static surfaces receive bullet impacts (decals are excluded). The merged
  // meshes are FrontSide, so a shot fired from inside a room would exit through
  // a back face and ignore the wall. Ray against invisible DoubleSide copies of
  // the same geometry instead: real triangles, both faces, no AABB guesses.
  // The copies share the merged geometry, so this costs no extra memory.
  bulletTargets.length = 0;
  const rayOnlyMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });
  const rayGroup = new THREE.Group();
  rayGroup.name = 'bullet-surfaces';
  const addRayCopies = (src) => {
    src.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const ud = (o.material && o.material.userData) || {};
      if (ud.noBullet) return;
      const m = new THREE.Mesh(o.geometry, rayOnlyMat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(o.matrixWorld);
      m.matrixWorld.copy(o.matrixWorld);
      m.userData.rayOnly = true;
      m.userData.srcMat = o.material;   // impact FX still needs the real material
      rayGroup.add(m);
      bulletTargets.push(m);
    });
  };
  addRayCopies(merged);
  for (const dm of districtMerged) addRayCopies(dm);
  root.add(rayGroup);
  // BVH once per merged buffer: a bullet costs 9 ms brute-force, <0.3 ms here.
  const bvhStats = buildBoundsTreeFor(bulletTargets);
  buildYardDestructibles();

  /* ------------------------------------------------------------------ spawns */
  spawnPoints.push(
    { x: 0, z: -92 }, { x: -12, z: -88 }, { x: 12, z: -87 }, { x: -21.5, z: -78 }, { x: 21.0, z: -80 },
    { x: 0, z: -61 }, { x: -1.6, z: -57.2 }, { x: 4.5, z: -60 },
    { x: -5.5, z: -45.4 }, { x: 6.8, z: -40 }, { x: -6.0, z: -31 },
    { x: 6.4, z: -18 }, { x: -7.4, z: -4 }, { x: 7.2, z: 4 },
    { x: -6.8, z: 14 }, { x: 6.6, z: 24 }, { x: 0, z: -48 },
    { x: -15.5, z: 3.2 },
    // south depot yard: pressure can now arrive from behind the spawn
    { x: -15.2, z: 80.2 }, { x: 15.2, z: 80.2 }, { x: 0, z: 80.8 },
    { x: -15.4, z: 60.2 }, { x: 15.4, z: 60.4 }, { x: 13.6, z: 75.8 }
  );
  coverPoints.push(
    { x: 1.0, z: 73.6, h: true }, { x: -2.0, z: 70.6, h: true },
    { x: -3.3, z: 15.6, h: true }, { x: 4.9, z: -8, h: false },
    { x: -1.8, z: 26.4, h: false }, { x: 2.6, z: 0.6, h: true },
    { x: -5.2, z: -7.0, h: false }, { x: 5.5, z: 17.0, h: false },
    { x: -6.0, z: -21.6, h: false }, { x: 5.4, z: -30.4, h: true },
    { x: -6.9, z: -34.5, h: true }, { x: 6.2, z: -46.5, h: false },
    { x: -14.2, z: 2.2, h: true }, { x: 0.9, z: -27.2, h: true },
    // south yard cover: containers, wrecks, truck bay corner, sandbags
    { x: -14.0, z: 77.6, h: true }, { x: -6.0, z: 71.6, h: true },
    { x: 2.6, z: 78.4, h: true }, { x: -11.4, z: 64.0, h: false },
    { x: 5.0, z: 69.2, h: false }, { x: -4.2, z: 60.6, h: true },
    { x: 15.2, z: 79.2, h: true }, { x: 6.9, z: 68.0, h: false }
  );

  /* ---- CQB zones + objective zones (Sprint B) ------------------------------
     Two enterable single-storey rooms carved into L3 (alley workshop) and R4
     (street apartment). Coordinates are the authoritative gameplay data. */
  const cqbZones = [
    {
      id: 'alley-workshop',
      name: '巷内工坊',
      entry: { x: -12.2, z: 1.1 },
      center: { x: -13.3, z: -2.5 },
      radius: 3.6,
      spawns: [{ x: -14.7, z: -1.8 }, { x: -11.5, z: -1.5 }],
      covers: [{ x: -15.35, z: -3.4, h: true }, { x: -11.6, z: -4.15, h: false }],
    },
    MARKET_CQB,
    {
      id: 'street-apartment',
      name: '临街公寓',
      entry: { x: 9.0, z: -12.0 },
      center: { x: 13.3, z: -11.6 },
      radius: 4.2,
      spawns: [{ x: 14.6, z: -10.4 }, { x: 11.5, z: -8.2 }],
      covers: [{ x: 13.75, z: -14.5, h: true }, { x: 14.0, z: -9.5, h: false }],
    },
  ];
  const objectiveZones = {
    defend: { x: 0, z: -16, r: 8.5 },
    extract: { x: -19.2, z: 3.0, r: 3.5 },
    backyard: { x: 21.8, z: -11.0, r: 5.2 },
    market: { x: 20.8, z: -10.7, r: 3.8 },
    yard: { x: 0, z: 70, r: 8.0 },
    checkpoint: { x: 0, z: -82, r: 8.0 },
    north_hq: { x: 10.6, z: -68.6, r: 2.6 },
    east_dock: { x: 43.5, z: -81, r: 4.5 },
    depot: { x: 11.5, z: 68, r: 4.0 },
    ...EXPANSION_OBJECTIVES,
  };
  // expose the interior combat points through the legacy arrays too
  for (const z of cqbZones) {
    for (const sp of z.spawns) spawnPoints.push({ x: sp.x, z: sp.z });
    for (const cv of z.covers) coverPoints.push({ x: cv.x, z: cv.z, h: cv.h });
  }
  for (const sp of ROOF_SPAWNS) spawnPoints.push({ x: sp.x, z: sp.z, y: sp.y });
  for (const cv of ROOF_COVERS) coverPoints.push({ x: cv.x, z: cv.z, h: cv.h, y: cv.y });

  /* ------------------------------------------------------------------ update */
  let time = 0;
  function update(dt, camera) {
    time += dt;
    dustTime.value = time;
    if (seaMatRef && seaMatRef.userData.shader) seaMatRef.userData.shader.uniforms.uSeaTime.value = time;
    // destructible debris
    for (let i = debris.length - 1; i >= 0; i--) {
      const p = debris[i];
      p.life -= dt;
      if (p.life <= 0) { root.remove(p.m); debris.splice(i, 1); continue; }
      p.vy -= 18 * dt;
      p.m.position.x += p.vx * dt;
      p.m.position.y += p.vy * dt;
      p.m.position.z += p.vz * dt;
      if (p.m.position.y < 0.06) {
        p.m.position.y = 0.06;
        p.vy *= -0.28; p.vx *= 0.62; p.vz *= 0.62;
      }
      p.m.rotation.x += p.spin * dt;
      p.m.rotation.z += p.spin * 0.7 * dt;
    }
    /* Fires animate only near the camera: 5+ sites x 11 sprites of per-frame
       position/scale/opacity churn (each sprite is also a draw call, so a fire
       you cannot see is pure cost). Freeze frames beyond 80 m; light flicker
       fades out past 45 m. */
    const camX = camera ? camera.position.x : 0;
    const camZ = camera ? camera.position.z : 0;
    for (const f of fires) {
      const fdx = f.base.x - camX;
      const fdz = f.base.z - camZ;
      const fireD2 = fdx * fdx + fdz * fdz;
      if (f.light) {
        if (fireD2 < 80 * 80) {
          const flick = 0.78 + Math.sin(time * 17.3 + f.base.x) * 0.1 + Math.sin(time * 7.1) * 0.08 + Math.pow(Math.random(), 3) * 0.25;
          const near = fireD2 < 45 * 45 ? 1 : Math.max(0, 1 - (Math.sqrt(fireD2) - 45) / 35);
          f.light.intensity = f.intensity * flick * near;
        } else if (f.light.intensity !== 0) {
          f.light.intensity = 0;
        }
      }
      if (fireD2 > 80 * 80) continue;
      for (const s of f.sprites) {
        s.phase += dt * (2.2 + s.s * 2);
        const wob = Math.sin(s.phase) * 0.12;
        s.sp.position.x = f.base.x + wob;
        s.sp.position.z = f.base.z + Math.cos(s.phase * 1.3) * 0.1;
        s.sp.position.y = f.base.y + 0.2 + ((s.phase * 0.35) % 1.2);
        const sc = s.s * (1 + Math.sin(s.phase * 3) * 0.12);
        s.sp.scale.set(sc * 0.8, sc * 1.5, 1);
        s.sp.material.opacity = 0.34 + Math.sin(s.phase * 4) * 0.12;
      }
      for (const s of f.smoke) {
        s.t += dt * 0.14;
        if (s.t > 1) { s.t -= 1; s.seed = Math.random() * 10; }
        const h = s.t * 7;
        s.sp.position.set(
          f.base.x + Math.sin(s.seed + s.t * 4) * (0.4 + s.t * 1.4) + s.t * 1.0,
          f.base.y + 0.8 + h,
          f.base.z + Math.cos(s.seed * 0.7 + s.t * 3) * (0.3 + s.t * 1.2)
        );
        s.sp.scale.setScalar(1.0 + s.t * 4.5);
        s.sp.material.opacity = 0.16 * (1 - s.t) * Math.min(1, s.t * 5);
      }
    }
  }

  /* ------------------------------------------------------- named regions */
  /* Coarse rectangles for the HUD location tag and the wayfinder. First hit
     wins, so keep the small / specific areas ahead of the wide fallbacks. */
  const REGIONS = [
    { id: 'old_souk', name: '老城集市', en: 'OLD SOUK', x0: -116, x1: -40, z0: -42, z1: 72 },
    { id: 'rail_depot', name: '北站货场', en: 'RAIL DEPOT', x0: -38, x1: 42, z0: -194, z1: -106 },
    { id: 'container_yard', name: '东港集装箱场', en: 'CONTAINER YARD', x0: 48, x1: 122, z0: -98, z1: 34 },
    { id: 'dock', name: '东码头', en: 'DOCK', x0: 118, x1: 190, z0: -22, z1: -2, minY: 0.2 },
    { id: 'foothills', name: '西侧山脚', en: 'FOOTHILLS', x0: -235, x1: -118, z0: -120, z1: 120 },
    { id: 'souk_gate', name: '集市门廊', en: 'SOUK GATE', x0: -40, x1: -22, z0: -11, z1: 34 },
    { id: 'rail_gate', name: '北站门廊', en: 'RAIL GATE', x0: -1, x1: 13, z0: -108, z1: -95 },
    { id: 'port_gate', name: '东港门廊', en: 'PORT GATE', x0: 44, x1: 50, z0: -85, z1: -75 },
    { id: 'east-dock', name: '东码头', en: 'EAST DOCK', x0: 30, x1: 46, z0: -92, z1: -70 },
    { id: 'north-hq', name: '北楼', en: 'NORTH HQ', x0: 6.0, x1: 15.0, z0: -75.2, z1: -64.8 },
    { id: 'checkpoint', name: '北检查站', en: 'CHECKPOINT', x0: -30, x1: 30, z0: -96, z1: -66 },
    { id: 'depot-roof', name: '车库屋顶', en: 'DEPOT ROOF', x0: 6.4, x1: 16.6, z0: 61.7, z1: 74.3, minY: 3.0 },
    { id: 'depot', name: '车库', en: 'DEPOT', x0: 6.4, x1: 16.6, z0: 61.8, z1: 74.2 },
    { id: 'south-yard', name: '南院车场', en: 'SOUTH YARD', x0: -17.2, x1: 17.2, z0: 55.8, z1: 82.2 },
    { id: 'roof', name: '市场屋顶', en: 'ROOFTOP', x0: 17.3, x1: 26.1, z0: -14.6, z1: -6.1, minY: 2.4 },
    { id: 'lane', name: '服务巷', en: 'SERVICE LANE', x0: 27.2, x1: 29.8, z0: -16.1, z1: -6.0 },
    { id: 'market', name: '后院市场', en: 'YARD MARKET', x0: 17.0, x1: 24.0, z0: -14.6, z1: -6.8 },
    { id: 'yard', name: '后院', en: 'BACKYARD', x0: 16.9, x1: 27.2, z0: -16.1, z1: -6.0 },
    { id: 'apartment', name: '临街公寓', en: 'APARTMENT', x0: 9.85, x1: 16.9, z0: -15.0, z1: -7.0 },
    { id: 'workshop', name: '左巷工坊', en: 'WORKSHOP', x0: -16.6, x1: -9.85, z0: -5.2, z1: 0.2 },
    { id: 'alley', name: '左巷', en: 'WEST ALLEY', x0: -30, x1: -9.85, z0: -64, z1: 52 },
  ];
  const STREET_REGION = { id: 'street', name: '街区', en: 'STREET' };
  function regionAt(x, z, y = 0) {
    for (const r of REGIONS) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      if (r.minY !== undefined && y < r.minY) continue;
      return r;
    }
    return STREET_REGION;
  }

  return {
    root, colliders, bulletTargets, spawnPoints, coverPoints, bvhStats, breachDoors, interactiveDoors, interactiveWindows,
    bounds: { x0: -234.8, x1: 190.4, z0: -220, z1: 150.4 },
    cqbZones, objectiveZones, regionAt, regions: REGIONS,
    stages: EXPANSION_STAGES, districts: EXPANSION_DISTRICTS,
    groundHeight, roofZones: ROOF_ZONES, roofSpawns: ROOF_SPAWNS, roofCovers: ROOF_COVERS,
    navLinks: [{ ax: 15.9, az: -12.0, bx: 17.6, bz: -12.0 }],
    destructibles, hitDestructible,
    update, fires,
  };
}
