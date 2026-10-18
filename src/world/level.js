import * as THREE from 'three';
import { projectBoxUV, mergeStatic } from '../core/geo.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../core/materials.js';

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
  const bulletTargets = [];
  const spawnPoints = [];
  const coverPoints = [];
  const fires = [];
  const rnd = mulberry32(20261018);
  let shopLights = 0;          // budget: keep the point-light count sane

  const rr = (a, b) => a + rnd() * (b - a);
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  const T = 2.4;          // default world texture tile (m)

  /* ------------------------------------------------------------------ utils */
  function add(mesh, group = statics) { group.add(mesh); return mesh; }

  function addColliderRect(x0, x1, z0, z1) { const c = { x0, x1, z0, z1 }; colliders.push(c); return c; }
  function addCollider(cx, cz, w, d, pad = 0) {
    return addColliderRect(cx - w / 2 - pad, cx + w / 2 + pad, cz - d / 2 - pad, cz + d / 2 + pad);
  }
  function addColliderRot(cx, cz, w, d, rot = 0, pad = 0.05) {
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    return addCollider(cx, cz, w * c + d * s, w * s + d * c, pad);
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
    if (opts.collide) addColliderRot(x, z, w, d, rotY, opts.pad ?? 0.04);
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
    if (opts.collide) addColliderRot(x, z, w, d, rotY, opts.pad ?? 0.04);
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
      statics.add(m);
      const rim = new THREE.Mesh(new THREE.RingGeometry(rad * 0.94, rad * 1.14, 28), mats.patch);
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

    // world bounds (players)
    addColliderRect(-30, -22, -80, 80);
    addColliderRect(22, 30, -80, 80);
    addColliderRect(-30, 30, -80, -66);
    addColliderRect(-30, 30, 54, 80);
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
    // kitchen counter along the back wall (tall cover)
    meshBox(0.85, 0.95, 2.6, mats.wood, 15.8, floorY + 0.475, -12.9, 0, { uv: 1.1 });
    meshBox(0.95, 0.06, 2.7, mats.metal, 15.8, floorY + 0.98, -12.9, 0, { uv: 0.8, cast: false });
    for (const sy of [1.65, 2.15]) {
      meshBox(0.45, 0.05, 2.5, mats.wood, 16.05, floorY + sy, -12.9, 0, { uv: 0.8, cast: false });
    }
    addColliderRect(15.35, 16.35, -14.25, -11.55);
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
      po.position.set(16.18, rr(1.4, 2.2), rr(-14.2, -10.2));
      po.rotation.y = -Math.PI / 2;
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
  const RAMP = { x0: 24.6, x1: 25.9, z0: -15.6, z1: -7.1, rise: 3.2 };
  const ROOF_ZONES = [
    { x0: 18.2, x1: 23.8, z0: -13.8, z1: -7.6, y: 3.2 },   // market roof deck
    { x0: 23.7, x1: 26.0, z0: -8.4, z1: -6.8, y: 3.2 },    // ramp top landing
    { x0: 17.45, x1: 18.3, z0: -11.9, z1: -11.1, y: 3.2 }, // catwalk to the apartment edge
  ];
  const ROOF_SPAWNS = [
    { x: 22.2, z: -11.8, y: 3.2 },
    { x: 25.0, z: -7.2, y: 3.2 },
    { x: 17.8, z: -11.5, y: 3.2 },
  ];
  const ROOF_COVERS = [
    { x: 22.8, z: -8.6, y: 3.2, h: true },
    { x: 18.5, z: -8.0, y: 3.2, h: false },
  ];
  const MARKET_CQB = {
    id: 'yard-market',
    name: '后院市场',
    entry: { x: 21.2, z: -15.2 },
    center: { x: 20.8, z: -10.7 },
    radius: 4.4,
    spawns: [{ x: 18.6, z: -12.4 }, { x: 22.6, z: -9.2 }],
    covers: [{ x: 17.45, z: -8.5, h: true }, { x: 22.85, z: -7.1, h: false }],
  };
  const DESTRUCTIBLE_DEFS = [
    { id: 'market-west-counter', x: 17.475, z: -8.5, w: 0.85, h: 1.0, d: 2.6, mat: 'wood', hp: 110 },
    { id: 'yard-crate-a', x: 17.35, z: -14.35, w: 1.0, h: 1.0, d: 1.0, mat: 'wood', hp: 55 },
    { id: 'yard-crate-b', x: 26.4, z: -15.3, w: 1.1, h: 1.1, d: 1.1, mat: 'wood', hp: 60 },
    { id: 'market-sacks', x: 17.35, z: -6.45, w: 0.95, h: 0.9, d: 1.8, mat: 'sandbag', hp: 120 },
    { id: 'yard-barricade', x: 28.6, z: -14.9, w: 1.4, h: 1.0, d: 0.45, mat: 'metal', hp: 80 },
  ];
  const destructibles = [];
  const debris = [];
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1);

  /** highest standable floor at x,z that is not more than y+0.6 above the caller */
  function groundHeight(x, z, y = 0) {
    let best = 0;
    const ceiling = y + 0.6;
    if (x >= RAMP.x0 && x <= RAMP.x1 && z >= RAMP.z0 && z <= RAMP.z1) {
      const t = Math.max(0, Math.min(1, (z - RAMP.z0) / (RAMP.z1 - RAMP.z0)));
      const h = RAMP.rise * t;
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
      const collider = addColliderRot(def.x, def.z, def.w, def.d, def.rot || 0, 0.02);
      destructibles.push({ id: def.id, mesh, collider, hp: def.hp, maxHp: def.hp, def, destroyed: false });
    }
  }

  /* fences / lane / market / ramp / catwalk (all static -> merged) */
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
    for (const [px, pz] of [[17.95, -14.0], [24.05, -14.0], [17.95, -7.4], [24.05, -7.4], [17.95, -10.7], [24.05, -10.7]]) {
      meshBox(0.15, 3.2, 0.15, mats.metal, px, 1.6, pz, 0, { uv: 0.8 });
      meshBox(0.55, 0.12, 0.55, mats.concreteDark, px, 0.08, pz, 0, { uv: 0.8, cast: false });
    }
    for (const pz of [-14.0, -7.4]) {
      meshBox(6.4, 0.16, 0.16, mats.metal, 21.0, 3.0, pz, 0, { uv: 0.8, cast: false });
    }
    for (const px of [17.95, 24.05]) meshBox(0.16, 0.16, 6.9, mats.metal, px, 3.0, -10.7, 0, { uv: 0.8, cast: false });
    // the walkable deck (top exactly 3.2)
    meshBox(5.6, 0.2, 6.2, mats.metal, 21.0, 3.1, -10.7, 0, { uv: 1.2 });
    for (let i = 0; i < 7; i++) meshBox(5.4, 0.06, 0.1, mats.rust, 21.0, 3.21, -13.5 + i * 0.92, 0, { uv: 0.6, cast: false });
    // low parapet (visual)
    for (const [w, d, x, z] of [[5.6, 0.06, 21.0, -13.77], [0.06, 6.2, 18.23, -10.7]]) {
      meshBox(w, 0.34, d, mats.metal, x, 3.39, z, 0, { uv: 0.9, cast: false });
    }
    meshBox(0.06, 0.34, 5.9, mats.metal, 23.77, 3.39, -11.2, 0, { uv: 0.9, cast: false });
    meshBox(5.6, 0.34, 0.06, mats.metal, 21.0, 3.39, -7.63, 0, { uv: 0.9, cast: false });
    // skylight + roof clutter (visual only, no colliders)
    meshBox(1.3, 0.07, 1.3, mats.metalTan, 21.0, 3.24, -10.6, 0, { uv: 0.7, cast: false });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05), mats.windowGlass);
    sky.rotation.x = -Math.PI / 2; sky.position.set(21.0, 3.28, -10.6);
    statics.add(sky);
    meshBox(0.95, 0.9, 0.95, mats.wood, 22.8, 3.65, -8.6, 0.2, { uv: 0.8 });
    meshBox(0.85, 0.8, 0.85, mats.wood, 19.4, 3.6, -12.8, -0.15, { uv: 0.8 });
    meshBox(0.7, 0.7, 0.6, mats.metal, 20.0, 3.55, -9.0, 0, { uv: 0.6 });
    // awnings over the side stalls
    meshBox(1.5, 0.05, 7.7, mats.awning, 17.45, 2.62, -10.7, 0, { uv: 0.9, rz: -0.12 });
    meshBox(0.05, 0.2, 7.7, mats.burlap, 16.75, 2.48, -10.7, 0, { uv: 0.8, cast: false });
    for (const zz of [-14.2, -7.2]) meshBox(1.2, 0.05, 7.0, mats.awning, 21.0, 2.66, zz, 0, { uv: 0.9, rx: 0.12 });
    // stall counters (outside the deck footprint; all are ground colliders)
    for (const [cx, cz] of [[19.45, -14.25], [22.85, -14.25], [19.45, -7.1], [22.85, -7.1]]) {
      meshBox(1.7, 0.95, 0.55, mats.wood, cx, 0.475, cz, 0, { uv: 1.0 });
      meshBox(1.85, 0.07, 0.68, mats.metalTan, cx, 0.98, cz, 0, { uv: 0.8, cast: false });
      addColliderRect(cx - 0.85, cx + 0.85, cz - 0.28, cz + 0.28);
    }
    // goods on the counters / shelves along the west side (outside deck)
    for (let i = 0; i < 4; i++) {
      meshBox(0.26, 0.2, 0.3, i % 2 ? mats.burlap : mats.metalTan, 17.15, 1.12 + (i % 2) * 1.2, -9.4 + i * 0.6, 0, { uv: 0.5, cast: false });
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
    const ml = new THREE.PointLight(0xffb070, 6.6, 9, 2);
    ml.position.set(20.9, 2.45, -10.7);
    dynamic.add(ml);
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
    crate(17.35, -13.9, 0.8, 0.3);
    crate(23.75, -14.4, 0.75, 1.1);
    crate(23.35, -6.45, 0.7, 0.7);
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
    meshBox(1.3, 0.14, rlen, mats.metal, (RAMP.x0 + RAMP.x1) / 2, 1.6, (RAMP.z0 + RAMP.z1) / 2, 0, { rx: -ang, uv: 1.0 });
    for (let k = 0; k < 11; k++) {
      const z = RAMP.z0 + 0.6 + k * 0.8;
      const h = RAMP.rise * (z - RAMP.z0) / (RAMP.z1 - RAMP.z0);
      meshBox(1.16, 0.035, 0.07, mats.rust, (RAMP.x0 + RAMP.x1) / 2, h + 0.09, z, 0, { uv: 0.5, cast: false, rx: -ang });
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
    meshBox(0.08, 2.1, 0.08, mats.wood, 24.3, 1.05, -15.4, 0, { uv: 0.5, cast: false });
    const rs = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.62), mats.signC);
    rs.position.set(24.3, 1.85, -15.36);
    statics.add(rs);

    // ---------- ramp top landing + catwalk to the apartment edge
    meshBox(2.3, 0.16, 1.9, mats.metal, 24.85, 3.12, -7.6, 0, { uv: 1.0 });
    for (const [w, d, x, z] of [[2.3, 0.05, 24.85, -6.68], [0.05, 1.9, 25.98, -7.6]]) {
      meshBox(w, 0.32, d, mats.metal, x, 3.36, z, 0, { uv: 0.8, cast: false });
    }
    meshBox(0.9, 0.16, 0.9, mats.metal, 21.0, 3.12, -7.15, 0, { uv: 1.0 }); // small link plate
    // grating catwalk (x 17.45..18.3 / z -11.9..-11.1)
    meshBox(0.95, 0.1, 0.9, mats.metal, 17.875, 3.15, -11.5, 0, { uv: 0.8 });
    for (let i = 0; i < 6; i++) meshBox(0.85, 0.035, 0.06, mats.rust, 17.875, 3.21, -11.86 + i * 0.14, 0, { uv: 0.4, cast: false });
    for (const [w, d, x, z] of [[0.95, 0.05, 17.875, -11.94], [0.95, 0.05, 17.875, -11.06]]) {
      meshBox(w, 0.9, d, mats.rust, x, 3.65, z, 0, { uv: 0.5, cast: false });
      for (let k = 0; k < 4; k++) meshBox(0.04, 0.85, 0.04, mats.rust, 17.55 + k * 0.24, 3.62, z, 0, { uv: 0.3, cast: false });
    }
    // brackets back to the apartment wall (visual)
    for (const z of [-11.9, -11.1]) meshBox(0.9, 0.08, 0.08, mats.rust, 17.35, 2.95, z, 0, { uv: 0.5, cast: false });
    // ledge plate against the wall (visual, extends to x=17.0)
    meshBox(0.5, 0.1, 1.0, mats.metal, 17.22, 3.15, -11.5, 0, { uv: 0.6, cast: false });
    // roof-access ladder cage? no stairs; just a sign
    const rsign = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), mats.signB);
    rsign.position.set(17.4, 2.6, -11.5);
    rsign.rotation.y = Math.PI / 2;
    statics.add(rsign);

    // ---------- yard clutter (kept outside every roof/catwalk footprint)
    crate(17.25, -10.4, 0.62, 0.4);
    crate(26.55, -11.8, 0.9, 1.2);
    barrel(26.9, -9.4);
    barrel(26.6, -7.2, {});
    tireStack(26.4, -14.6, 2);
    pallet(26.0, -13.4, 0.8);
    crate(23.9, -15.4, 0.8, 0.9);
    addTrashPile(1.2, -1, 1.2);
    // a small yard lamp on the apartment wall
    meshBox(0.3, 0.05, 0.05, mats.rust, 17.05, 3.55, -10.2, 0, { uv: 0.5, cast: false });
    meshBox(0.22, 0.13, 0.17, mats.metalTan, 17.2, 3.44, -10.2, 0, { uv: 0.6 });
    lightPool(17.45, -10.2, 1.5, 0.18);
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
    // end wall + steel gate + warm doorway
    const endW = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.2, 6.0), mats.plasterB);
    projectBoxUV(endW.geometry, 3.0);
    endW.position.set(xEnd, 2.1, 3.0);
    endW.castShadow = true; endW.receiveShadow = true;
    statics.add(endW);
    addCollider(xEnd, 3.0, 0.5, 6.0);
    meshBox(0.08, 2.4, 1.4, mats.metal, xEnd + 0.3, 1.25, 2.1, 0, { uv: 1.0 });
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.7), mats.windowLitDim);
    warm.position.set(xEnd + 0.34, 1.35, 4.4);
    warm.rotation.y = Math.PI / 2;
    statics.add(warm);
    lightPool(xEnd + 0.9, 4.4, 1.6, 0.22);
    const al = new THREE.PointLight(0xffa055, 2.6, 7, 2);
    al.position.set(xEnd + 0.8, 1.8, 4.4);
    dynamic.add(al);
    meshBox(0.12, 2.0, 1.25, mats.metal, xEnd + 0.31, 1.25, 4.4, 0, { uv: 0.9, cast: false });
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
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10), mats.plasterB);
      projectBoxUV(b.geometry, 3.4);
      b.position.set(cx, h / 2, z);
      b.castShadow = true; b.receiveShadow = true;
      statics.add(b);
      addCollider(cx, z, w, 10);
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
    }
    // bridge across the gap
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(12.4, 1.3, 3.6), mats.concreteDark);
    projectBoxUV(bridge.geometry, 2.6);
    bridge.position.set(0, 8.4, z);
    bridge.castShadow = true; bridge.receiveShadow = true;
    statics.add(bridge);
    addCollider(0, z, 12.4, 3.6);
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
    addColliderRot(x, z, size, size * 0.92, rot, 0.03);
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
    addColliderRot(cx, cz, cols * 0.62 + 0.1, 0.6, rotY, 0.1);
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
    addColliderRot(x, z, 0.72, 2.5, rot, 0.05);
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
    addColliderRot(x, z, 2.05, 4.55, rot, 0.05);
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
    addColliderRot(x, z, 2.18, 5.2, rot, 0.05);
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
  buildAlley();
  buildGatehouse();

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
  const dustMat = new THREE.PointsMaterial({
    size: 0.04, map: mats.sprites.glow, color: 0xffe6c4,
    transparent: true, opacity: 0.45, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
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

  // far silhouettes: merged, never shadow casting
  const farMerged = mergeStatic(farGroup, { castShadow: false, receiveShadow: false });
  root.add(farMerged);
  farGroup.clear();

  // static surfaces receive bullet impacts (decals are excluded)
  bulletTargets.length = 0;
  merged.traverse((o) => {
    if (!o.isMesh) return;
    const ud = (o.material && o.material.userData) || {};
    if (!ud.noBullet) bulletTargets.push(o);
  });

  /* ------------------------------------------------------------------ spawns */
  spawnPoints.push(
    { x: 0, z: -61 }, { x: -1.6, z: -57.2 }, { x: 4.5, z: -60 },
    { x: -5.5, z: -45.4 }, { x: 6.8, z: -40 }, { x: -6.0, z: -31 },
    { x: 6.4, z: -18 }, { x: -7.4, z: -4 }, { x: 7.2, z: 4 },
    { x: -6.8, z: 14 }, { x: 6.6, z: 24 }, { x: 0, z: -48 },
    { x: -15.5, z: 3.2 }
  );
  coverPoints.push(
    { x: -3.3, z: 15.6, h: true }, { x: 4.9, z: -8, h: false },
    { x: -1.8, z: 26.4, h: false }, { x: 2.6, z: 0.6, h: true },
    { x: -5.2, z: -7.0, h: false }, { x: 5.5, z: 17.0, h: false },
    { x: -6.0, z: -21.6, h: false }, { x: 5.4, z: -30.4, h: true },
    { x: -6.9, z: -34.5, h: true }, { x: 6.2, z: -46.5, h: false },
    { x: -14.2, z: 2.2, h: true }, { x: 0.9, z: -27.2, h: true }
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
    {
      id: 'street-apartment',
      name: '临街公寓',
      entry: { x: 9.0, z: -12.0 },
      center: { x: 13.3, z: -11.6 },
      radius: 4.2,
      spawns: [{ x: 14.6, z: -10.4 }, { x: 11.5, z: -8.2 }],
      covers: [{ x: 15.8, z: -12.9, h: true }, { x: 14.0, z: -9.5, h: false }],
    },
  ];
  const objectiveZones = {
    defend: { x: 0, z: -16, r: 8.5 },
    extract: { x: -19.2, z: 3.0, r: 3.5 },
  };
  // expose the interior combat points through the legacy arrays too
  for (const z of cqbZones) {
    for (const sp of z.spawns) spawnPoints.push({ x: sp.x, z: sp.z });
    for (const cv of z.covers) coverPoints.push({ x: cv.x, z: cv.z, h: cv.h });
  }

  /* ------------------------------------------------------------------ update */
  let time = 0;
  const pos = dust.geometry.attributes.position;
  function update(dt, camera) {
    time += dt;
    for (const f of fires) {
      const flick = 0.78 + Math.sin(time * 17.3 + f.base.x) * 0.1 + Math.sin(time * 7.1) * 0.08 + Math.pow(Math.random(), 3) * 0.25;
      if (f.light) f.light.intensity = f.intensity * flick;
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
    for (let i = 0; i < dustCount; i++) {
      const s = dustSeed[i];
      pos.array[i * 3 + 1] += (Math.sin(time * 0.6 + s) * 0.05 + 0.012) * dt;
      pos.array[i * 3] += Math.cos(time * 0.35 + s * 1.7) * 0.09 * dt;
      if (pos.array[i * 3 + 1] > 13) pos.array[i * 3 + 1] = 0.2;
    }
    pos.needsUpdate = true;
    void camera;
  }

  return {
    root, colliders, bulletTargets, spawnPoints, coverPoints,
    bounds: { x0: -22, x1: 22, z0: -64, z1: 52 },
    cqbZones, objectiveZones,
    update, fires,
  };
}
