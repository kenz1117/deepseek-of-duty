/* =========================================================================
   World kit — flora, water and small cover.

   The map had no green inside the playable districts and almost no water,
   so the streets read as a concrete box. This module adds the missing layer:

     · flora   street trees, souk acacias, palms, bushes, grass, flowers,
               vines, window boxes, potted plants, reeds
     · water   fountain basins, cisterns, a settling pond, a drainage
               canal, duckboard bridges — all with a rippling surface
     · cover   pipes, pallets, tyres, cones, toolboxes, cable spools,
               planters — the small stuff a fight actually happens around

   Everything is visual-only unless a builder is given a collider: plants
   never block the navigation grid, so the AI paths and the spawn audit stay
   exactly where they were.

   Builders take the district group as first argument (S / R / P), so the
   merge pass keeps each district's own bounding volume.
   ========================================================================= */

import * as THREE from 'three';

export function createKit(ctx) {
  const {
    mats, rnd,
    box, cyl, gnd, win,          // level helpers (same signatures as B/C/GND/WIN)
    addCollider, addColliderRot, // optional collider hooks
    blob,                        // contact shadow blob (optional)
    lightPool,                   // fake light pool (optional)
  } = ctx;

  const LEAF = ['leaf', 'leafDeep', 'leafDry'];
  const BLOSSOM = ['blossomA', 'blossomB', 'blossomC'];

  /* A basin wall is a thin shell: it has to be visible from both sides or
     the near half vanishes and the pool reads as a broken ring. */
  let wallMat2 = null;
  function doubleSided(mat) {
    if (!wallMat2) {
      wallMat2 = mat.clone();
      wallMat2.side = THREE.DoubleSide;
    }
    return wallMat2;
  }

  /* ------------------------------------------------------------ helpers */
  const jitter = (a) => (rnd() - 0.5) * a;

  /** a low-poly blob: the building block of every canopy */
  function blobGeo(r, detail = 0) {
    return new THREE.IcosahedronGeometry(r, detail);
  }

  function blobMesh(r, mat, x, y, z, sx = 1, sy = 1, sz = 1, cast = false) {
    const m = new THREE.Mesh(blobGeo(r), mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = cast;
    m.receiveShadow = false;
    return m;
  }

  /* ================================================================ FLORA */

  /**
   * Conifer: a tapered trunk with stacked skirts of needles. This is the
   * silhouette the hills were missing — the old backdrop used bare cones.
   */
  function pine(g, x, z, { h = 8, spread = 2.3, tiers = 5, deep = false } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rnd() * 6.28;
    const trunkH = h * 0.28;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.24, trunkH, 6), mats.bark);
    trunk.position.y = trunkH / 2;
    grp.add(trunk);
    const mat = deep ? mats.leafDeep : mats.leaf;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const r = spread * (1 - t * 0.7) * (0.92 + rnd() * 0.16);
      const cy = trunkH * 0.55 + t * (h - trunkH) * 0.92;
      const ch = ((h - trunkH) / tiers) * 2.15;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, ch, 7), mat);
      cone.position.y = cy;
      cone.rotation.y = rnd() * 3;
      cone.castShadow = false;
      grp.add(cone);
    }
    g.add(grp);
    return grp;
  }

  /** slim column tree (cypress) — the vertical accent of a hillside */
  function cypress(g, x, z, { h = 7.5, r = 0.95 } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.18, h * 0.22, 6), mats.bark);
    trunk.position.y = h * 0.11;
    grp.add(trunk);
    const lobes = 5;
    for (let i = 0; i < lobes; i++) {
      const t = i / (lobes - 1);
      const blob = blobMesh(r * (1 - t * 0.55) * (0.9 + rnd() * 0.2), mats.leafDeep,
        jitter(0.16), h * (0.24 + t * 0.66), jitter(0.16), 1, 1.5, 1);
      grp.add(blob);
    }
    g.add(grp);
    return grp;
  }

  /** olive tree: short gnarled trunk, wide silver-green crown */
  function olive(g, x, z, { h = 4.4 } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rnd() * 6.28;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, h * 0.42, 7), mats.bark);
    trunk.position.y = h * 0.21;
    grp.add(trunk);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + jitter(0.5);
      const len = h * 0.3;
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, len, 5), mats.bark);
      br.position.set(Math.cos(a) * len * 0.3, h * 0.45, Math.sin(a) * len * 0.3);
      br.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
      grp.add(br);
    }
    const lobes = 6;
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + jitter(0.4);
      const rad = h * 0.2 * (0.75 + rnd() * 0.5);
      const dist = h * 0.28 * rnd();
      const m = blobMesh(rad, mats.leafDry, Math.cos(a) * dist, h * 0.66 + jitter(0.3), Math.sin(a) * dist, 1, 0.78, 1);
      grp.add(m);
    }
    g.add(grp);
    return grp;
  }

  /** dry-stone wall: stacked irregular stones along a line */
  function stoneWall(g, x0, z0, x1, z1, { h = 0.92, thickness = 0.6 } = {}) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.round(len / 0.5));
    const rot = Math.atan2(dz, dx);
    const grp = new THREE.Group();
    grp.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    grp.rotation.y = -rot;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const px = -len / 2 + len * t;
      const rows = 2 + Math.floor(rnd() * 2);
      for (let r = 0; r < rows; r++) {
        const sw = 0.34 + rnd() * 0.26;
        const sh = 0.18 + rnd() * 0.08;
        const stone = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, thickness * (0.8 + rnd() * 0.4)), mats.plasterC);
        stone.position.set(px + jitter(0.06), sh / 2 + r * (h / rows), jitter(0.07));
        stone.rotation.set(jitter(0.06), jitter(0.12), jitter(0.08));
        stone.castShadow = false;
        stone.receiveShadow = true;
        grp.add(stone);
      }
    }
    g.add(grp);
    return grp;
  }

  /** boulder cluster: three chunky stones */
  function boulder(g, x, z, { s = 1.4 } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rnd() * 6.28;
    for (let i = 0; i < 3; i++) {
      const r = s * (0.45 + rnd() * 0.4);
      const m = new THREE.Mesh(blobGeo(r, 0), mats.concrete);
      m.position.set(jitter(s * 0.6), r * 0.62, jitter(s * 0.6));
      m.scale.set(1, 0.78, 1);
      m.rotation.set(rnd(), rnd() * 3, rnd() * 0.4);
      m.castShadow = false;
      m.receiveShadow = true;
      grp.add(m);
    }
    g.add(grp);
    if (addCollider) addCollider(x, z, s * 1.2, s * 1.2, 0.05, s * 1.1);
    return grp;
  }

  /**
   * A tree. kind:
   *   'street'  pruned city tree, crown starts at 2.6 m so sight lines stay open
   *   'acacia'  slim trunk + wide umbrella crown (the souk silhouette)
   *   'palm'    ringed trunk + alpha-cut fronds
   */
  function tree(g, x, z, { kind = 'street', h = 4.8, yaw = 0, pit = true } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = yaw;

    if (kind === 'palm') {
      const th = h * 1.25;
      const lean = jitter(0.12);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.22, th, 7), mats.bark);
      trunk.position.set(lean * th * 0.4, th / 2, 0);
      trunk.rotation.z = lean;
      trunk.castShadow = false;
      grp.add(trunk);
      // trunk rings
      for (let i = 1; i < 7; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 4, 9), mats.bark);
        ring.position.set(lean * th * 0.4 * (i / 7), (th * i) / 7, 0);
        ring.rotation.x = Math.PI / 2;
        grp.add(ring);
      }
      const topX = lean * th * 0.4;
      const topY = th;
      const fronds = 8;
      for (let i = 0; i < fronds; i++) {
        const a = (i / fronds) * Math.PI * 2 + jitter(0.25);
        const droop = 0.55 + rnd() * 0.45;
        const frond = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.5), mats.frond);
        frond.position.set(topX + Math.cos(a) * 0.9, topY - 0.25 - droop * 0.25, Math.sin(a) * 0.9);
        frond.rotation.set(-Math.PI / 2 + droop * 0.55, 0, -a + Math.PI / 2);
        frond.castShadow = false;
        grp.add(frond);
      }
      // coconut cluster
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(blobGeo(0.13), mats.bark);
        c.position.set(topX + jitter(0.3), topY - 0.35 - rnd() * 0.2, jitter(0.3));
        grp.add(c);
      }
    } else {
      const trunkH = kind === 'acacia' ? h * 0.62 : h * 0.42;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, trunkH, 7), mats.bark);
      trunk.position.y = trunkH / 2;
      trunk.castShadow = false;
      grp.add(trunk);
      // a couple of branches so the silhouette is not a lollipop
      const branches = kind === 'acacia' ? 3 : 2;
      for (let i = 0; i < branches; i++) {
        const a = (i / branches) * Math.PI * 2 + jitter(0.6);
        const len = h * (kind === 'acacia' ? 0.26 : 0.2);
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, len, 5), mats.bark);
        br.position.set(Math.cos(a) * len * 0.32, trunkH + len * 0.3, Math.sin(a) * len * 0.32);
        br.rotation.set(Math.sin(a) * 0.75, 0, -Math.cos(a) * 0.75);
        br.castShadow = false;
        grp.add(br);
      }
      // crown: a cluster of small lobes on a squashed dome. One big blob
      // reads as a flat green polygon; a dozen small ones read as leaves.
      const crownY = kind === 'acacia' ? h * 0.78 : h * 0.66;
      const lobes = kind === 'acacia' ? 7 : 9;
      const base = h * (kind === 'acacia' ? 0.15 : 0.13);
      for (let i = 0; i < lobes; i++) {
        const u = rnd() * 2 - 1;
        const a = rnd() * Math.PI * 2;
        const ring = Math.sqrt(Math.max(0, 1 - u * u));
        const rad = base * (0.6 + rnd() * 0.6);
        const dx = Math.cos(a) * ring * rad * 1.4;
        const dz = Math.sin(a) * ring * rad * 1.4;
        const dy = u * rad * (kind === 'acacia' ? 0.5 : 0.9);
        const roll = rnd();
        const mat = mats[roll < 0.2 ? 'leafDeep' : roll < 0.3 ? 'leafDry' : 'leaf'];
        grp.add(blobMesh(rad, mat, dx, crownY + dy, dz, 1, 0.85, 1));
      }
      if (kind === 'acacia') {
        const top = blobMesh(h * 0.17, mats.leaf, 0, crownY + h * 0.05, 0, 1.4, 0.36, 1.4);
        grp.add(top);
      }
    }

    if (pit) {
      // tree pit: soil + a cast-iron grate ring around the trunk
      const soil = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), mats.soil);
      soil.rotation.x = -Math.PI / 2;
      soil.position.y = 0.02;
      grp.add(soil);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.035, 4, 12), mats.rust);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.03;
      grp.add(ring);
    }

    g.add(grp);
    return grp;
  }

  /** low shrub: 3-5 overlapping blobs */
  function bush(g, x, z, s = 1, y = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const lobes = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < lobes; i++) {
      const r = 0.28 * s * (0.7 + rnd() * 0.6);
      const m = blobMesh(r, mats[LEAF[(i + 1) % LEAF.length]], jitter(0.5 * s), r * 0.75 + jitter(0.08), jitter(0.5 * s), 1, 0.8, 1);
      grp.add(m);
    }
    g.add(grp);
    return grp;
  }

  /** grass tuft: crossed alpha-cut blades */
  function grassTuft(g, x, z, s = 1, y = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = rnd() * Math.PI;
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.42 * s, 0.5 * s), mats.weed);
      blade.position.set(0, 0.24 * s, 0);
      blade.rotation.y = i * Math.PI / 2;
      blade.castShadow = false;
      grp.add(blade);
    }
    g.add(grp);
    return grp;
  }

  /** flower patch: grass with a few coloured blossoms */
  function flowerBed(g, x, z, r = 1.2, y = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const tufts = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < tufts; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * r;
      const t = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.46), mats.weed);
      t.position.set(Math.cos(a) * d, 0.22, Math.sin(a) * d);
      t.rotation.y = rnd() * Math.PI;
      t.castShadow = false;
      grp.add(t);
    }
    const blooms = 4 + Math.floor(rnd() * 5);
    for (let i = 0; i < blooms; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * r * 0.9;
      const b = new THREE.Mesh(new THREE.CircleGeometry(0.055 + rnd() * 0.03, 5), mats[BLOSSOM[i % BLOSSOM.length]]);
      b.position.set(Math.cos(a) * d, 0.3 + rnd() * 0.22, Math.sin(a) * d);
      b.rotation.set(-Math.PI / 2 + jitter(0.5), rnd() * Math.PI, 0);
      b.castShadow = false;
      grp.add(b);
    }
    g.add(grp);
    return grp;
  }

  /** climbing vine: a green strip with leaf blobs */
  function vine(g, x, y, z, ry = 0, h = 3) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = ry;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.55, h), mats.leafDeep);
    strip.position.set(0, h / 2, 0.02);
    strip.castShadow = false;
    grp.add(strip);
    const leaves = Math.max(4, Math.floor(h * 3));
    for (let i = 0; i < leaves; i++) {
      const l = blobMesh(0.1 + rnd() * 0.07, mats.leaf, jitter(0.34), (i / leaves) * h + jitter(0.2), 0.06, 1, 0.6, 1);
      grp.add(l);
    }
    g.add(grp);
    return grp;
  }

  /** terracotta pot with a small shrub */
  function potPlant(g, x, z, s = 1, y = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.16 * s, 0.34 * s, 9), mats.plasterC);
    pot.position.y = 0.17 * s;
    pot.castShadow = false;
    grp.add(pot);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22 * s, 0.025 * s, 4, 10), mats.plasterC);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.33 * s;
    grp.add(rim);
    const soil = new THREE.Mesh(new THREE.CircleGeometry(0.19 * s, 8), mats.soil);
    soil.rotation.x = -Math.PI / 2;
    soil.position.y = 0.33 * s;
    grp.add(soil);
    const leaves = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < leaves; i++) {
      const l = blobMesh(0.15 * s * (0.8 + rnd() * 0.5), mats[LEAF[i % LEAF.length]],
        jitter(0.16 * s), 0.42 * s + rnd() * 0.14 * s, jitter(0.16 * s), 1, 0.85, 1);
      grp.add(l);
    }
    g.add(grp);
    return grp;
  }

  /** tall reeds at a water edge: alpha-cut blades, not green planks */
  function reeds(g, x, z, s = 1, y = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const n = 4 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const tall = 0.8 + rnd() * 0.7;
      const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.3 * s, tall * s), mats.weed);
      blade.position.set(jitter(0.22 * s), tall * s * 0.5, jitter(0.22 * s));
      blade.rotation.set(jitter(0.12), rnd() * Math.PI, jitter(0.18));
      blade.castShadow = false;
      grp.add(blade);
    }
    // a few seed heads
    for (let i = 0; i < 2; i++) {
      const head = new THREE.Mesh(new THREE.CircleGeometry(0.035 * s, 4), mats.leafDry);
      head.position.set(jitter(0.2 * s), (0.85 + rnd() * 0.5) * s, jitter(0.2 * s));
      head.rotation.set(jitter(0.6), rnd() * Math.PI, jitter(0.6));
      head.castShadow = false;
      grp.add(head);
    }
    g.add(grp);
    return grp;
  }

  /** flower box under a window */
  function windowBox(g, x, y, z, ry = 0, w = 1.1) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = ry;
    const trough = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, 0.28), mats.wood);
    trough.position.set(0, 0, 0.06);
    trough.castShadow = false;
    trough.receiveShadow = true;
    grp.add(trough);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.05, 0.3), mats.metalTan);
    lip.position.set(0, 0.11, 0.06);
    lip.castShadow = false;
    grp.add(lip);
    const dirt = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.05, 0.2), mats.soil);
    dirt.position.set(0, 0.12, 0.06);
    grp.add(dirt);
    const n = Math.max(3, Math.floor(w * 4));
    for (let i = 0; i < n; i++) {
      const px = -w / 2 + (w / n) * (i + 0.5);
      const l = blobMesh(0.09 + rnd() * 0.05, mats[LEAF[i % LEAF.length]], px, 0.19, 0.06, 1, 0.8, 1);
      grp.add(l);
      if (i % 2 === 0) {
        const b = new THREE.Mesh(new THREE.CircleGeometry(0.045, 5), mats[BLOSSOM[i % BLOSSOM.length]]);
        b.position.set(px, 0.27 + rnd() * 0.05, 0.06);
        b.rotation.x = -Math.PI / 2 + jitter(0.4);
        grp.add(b);
      }
    }
    g.add(grp);
    return grp;
  }

  /** concrete planter: waist-high, real cover, with a shrub on top */
  function planter(g, x, z, w = 1.6, d = 0.8, rot = 0) {
    const h = 0.92;
    box(g, w, h, d, mats.concrete, x, h / 2, z, rot, { collide: true, uv: 1.1 });
    box(g, w * 1.06, 0.08, d * 1.1, mats.concreteDark, x, h + 0.04, z, rot, { cast: false, uv: 0.9 });
    const soil = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, 0.06, d * 0.7), mats.soil);
    soil.position.set(x, h + 0.06, z);
    soil.rotation.y = rot;
    soil.castShadow = false;
    g.add(soil);
    const grp = new THREE.Group();
    grp.position.set(x, h + 0.08, z);
    const lobes = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < lobes; i++) {
      const l = blobMesh(0.22 * (0.8 + rnd() * 0.5), mats[LEAF[i % LEAF.length]],
        jitter(w * 0.3), 0.2 + rnd() * 0.14, jitter(d * 0.25), 1, 0.85, 1);
      grp.add(l);
    }
    g.add(grp);
    return grp;
  }

  /* ================================================================= WATER */

  /** water surface: a plane with the shared rippling normal map */
  function waterPlane(w, d, x, y, z, rot = 0) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 1, 1), mats.water);
    m.rotation.set(-Math.PI / 2, 0, rot);
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 1;
    return m;
  }

  /**
   * Rectangular basin: concrete rim, dark bottom, water surface.
   * `solid` gives it a collider so nobody wades into the deep ones.
   */
  function pool(g, x, z, { w = 4, d = 3, depth = 0.6, rim = 0.18, rot = 0, solid = true, jet = false } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    // sunken bottom
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mats.puddle);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.012;
    grp.add(bottom);
    // inner walls
    for (const [bw, bd, bx, bz] of [[w + rim * 2, rim, 0, -(d / 2 + rim / 2)], [w + rim * 2, rim, 0, d / 2 + rim / 2],
      [rim, d, -(w / 2 + rim / 2), 0], [rim, d, w / 2 + rim / 2, 0]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(bw, depth + rim, bd), mats.concrete);
      wall.position.set(bx, (depth + rim) / 2, bz);
      wall.castShadow = false;
      wall.receiveShadow = true;
      grp.add(wall);
    }
    // coping
    for (const [bw, bd, bx, bz] of [[w + rim * 2.2, rim * 1.1, 0, -(d / 2 + rim / 2)], [w + rim * 2.2, rim * 1.1, 0, d / 2 + rim / 2],
      [rim * 1.1, d, -(w / 2 + rim / 2), 0], [rim * 1.1, d, w / 2 + rim / 2, 0]]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.07, bd), mats.concreteDark);
      cap.position.set(bx, depth + rim, bz);
      cap.castShadow = false;
      grp.add(cap);
    }
    grp.add(waterPlane(w, d, 0, depth * 0.86, 0));
    if (jet) {
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, depth * 1.5, 7), mats.water);
      column.position.y = depth * 0.86 + depth * 0.75;
      column.castShadow = false;
      grp.add(column);
      const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, depth * 0.75, 6), mats.water);
      drop.position.y = depth * 0.86 + depth * 0.38;
      drop.castShadow = false;
      grp.add(drop);
    }
    g.add(grp);
    if (solid && addCollider) addColliderRot(x, z, w + rim * 2, d + rim * 2, rot, 0.04, depth + rim);
    return grp;
  }

  /** round fountain basin with a tiered centre and a jet */
  function fountain(g, x, z, r = 2.4, { depth = 0.45, solid = true } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const wallH = depth + 0.14;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wallH, 24, 1, true), doubleSided(mats.concrete));
    wall.position.y = wallH / 2;
    wall.castShadow = false;
    wall.receiveShadow = true;
    grp.add(wall);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(r - 0.04, 24), mats.puddle);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.03;
    grp.add(bottom);
    const coping = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 5, 28), mats.concreteDark);
    coping.rotation.x = Math.PI / 2;
    coping.position.y = wallH;
    grp.add(coping);
    // the water sits high in the basin so it reads from a standing eye
    const surf = new THREE.Mesh(new THREE.CircleGeometry(r - 0.06, 28), mats.water);
    surf.rotation.x = -Math.PI / 2;
    surf.position.y = depth * 0.86;
    surf.renderOrder = 1;
    grp.add(surf);
    // tiered centre: plinth + bowl + jet
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, depth * 0.9, 12), mats.concrete);
    plinth.position.y = depth * 0.45;
    grp.add(plinth);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.34, 0.22, 14), mats.concrete);
    bowl.position.y = depth * 0.95;
    grp.add(bowl);
    const bowlWater = new THREE.Mesh(new THREE.CircleGeometry(0.56, 14), mats.water);
    bowlWater.rotation.x = -Math.PI / 2;
    bowlWater.position.y = depth * 0.95 + 0.1;
    bowlWater.renderOrder = 2;
    grp.add(bowlWater);
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.085, 1.0, 8), mats.water);
    jet.position.y = depth * 0.95 + 0.62;
    jet.castShadow = false;
    grp.add(jet);
    // spray dots where the jet falls back
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd();
      const sp = new THREE.Mesh(new THREE.CircleGeometry(0.13, 6), mats.water);
      sp.position.set(Math.cos(a) * (r * 0.42), depth * 0.87, Math.sin(a) * (r * 0.42));
      sp.rotation.set(-Math.PI / 2, 0, 0);
      sp.renderOrder = 2;
      grp.add(sp);
    }
    g.add(grp);
    if (solid && addCollider) addCollider(x, z, r * 2, r * 2, 0.04, wallH);
    return grp;
  }

  /**
   * Drainage canal: a straight channel with sloped concrete banks.
   * The bed sits just above the yard floor, so the player wades across it
   * instead of being stopped by a collider.
   */
  function canal(g, x0, z0, x1, z1, { width = 2.6, depth = 0.32 } = {}) {
    const grp = new THREE.Group();
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const rot = Math.atan2(dz, dx);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    grp.position.set(cx, 0, cz);
    grp.rotation.y = -rot;
    // bed
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(len, width), mats.puddle);
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = 0.02;
    grp.add(bed);
    // banks
    for (const s of [-1, 1]) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(len, depth, 0.34), mats.concrete);
      bank.position.set(0, depth / 2, s * (width / 2 + 0.17));
      bank.castShadow = false;
      bank.receiveShadow = true;
      grp.add(bank);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.42), mats.concreteDark);
      lip.position.set(0, depth, s * (width / 2 + 0.19));
      lip.castShadow = false;
      grp.add(lip);
    }
    grp.add(waterPlane(len, width * 0.9, 0, depth * 0.78, 0, 0));
    g.add(grp);
    return grp;
  }

  /**
   * Duckboard bridge: planks laid over the canal with a handrail.
   * It stays at ground level, so crossing it needs no navigation layer.
   */
  function duckBridge(g, x, z, rot = 0, { span = 3.4, width = 2.0 } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    const planks = Math.max(6, Math.round(span / 0.34));
    for (let i = 0; i < planks; i++) {
      const t = (i / (planks - 1) - 0.5) * span;
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, width), mats.wood);
      p.position.set(t, 0.28, 0);
      p.rotation.y = jitter(0.02);
      p.castShadow = false;
      p.receiveShadow = true;
      grp.add(p);
    }
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.07, 0.07), mats.wood);
      rail.position.set(0, 0.95, s * (width / 2 - 0.06));
      rail.castShadow = false;
      grp.add(rail);
      for (let i = 0; i < 4; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), mats.wood);
        post.position.set(-span / 2 + 0.2 + (i / 3) * (span - 0.4), 0.62, s * (width / 2 - 0.06));
        post.castShadow = false;
        grp.add(post);
      }
    }
    g.add(grp);
    return grp;
  }

  /**
   * A river: a flat, wadeable ribbon of water with wet banks and reeds.
   * The bed sits a couple of centimetres above the ground so the player
   * walks through it ankle deep instead of being stopped by a collider.
   */
  function river(g, x0, z0, x1, z1, { width = 8, withReeds = true } = {}) {
    const grp = new THREE.Group();
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const rot = Math.atan2(dz, dx);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    grp.position.set(cx, 0, cz);
    grp.rotation.y = -rot;
    // wet sand along both banks, with a darker line right at the water
    for (const s of [-1, 1]) {
      const bank = new THREE.Mesh(new THREE.PlaneGeometry(len, width * 0.8), mats.dirt);
      bank.rotation.x = -Math.PI / 2;
      bank.position.set(0, 0.021, s * (width * 0.5 + width * 0.4));
      bank.receiveShadow = true;
      grp.add(bank);
      const wet = new THREE.Mesh(new THREE.PlaneGeometry(len, width * 0.18), mats.puddle);
      wet.rotation.x = -Math.PI / 2;
      wet.position.set(0, 0.026, s * (width * 0.5 + 0.18));
      grp.add(wet);
    }
    grp.add(waterPlane(len, width, 0, 0.045, 0, 0));
    g.add(grp);
    if (withReeds) {
      const n = Math.max(4, Math.round(len / 3.4));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const rx = x0 + dx * t;
        const rz = z0 + dz * t;
        for (const s of [-1, 1]) {
          const ox = Math.sin(rot) * s * (width / 2 + 0.5);
          const oz = Math.cos(rot) * s * (width / 2 + 0.5);
          reeds(g, rx + ox, rz + oz, 0.9 + rnd() * 0.5);
        }
      }
    }
    return grp;
  }

  /** flat culvert bridge: a concrete slab flush with the ground */
  function flatBridge(g, x, z, rot = 0, { span = 10, width = 3.4 } = {}) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(width, 0.14, span), mats.concrete);
    slab.position.y = 0.06;
    slab.receiveShadow = true;
    slab.castShadow = false;
    grp.add(slab);
    for (const s of [-1, 1]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, span), mats.concreteDark);
      kerb.position.set(s * (width / 2 - 0.11), 0.12, 0);
      kerb.castShadow = false;
      grp.add(kerb);
      for (let i = 0; i < 4; i++) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 6), mats.rust);
        post.position.set(s * (width / 2 - 0.11), 0.55, -span / 2 + 0.6 + i * ((span - 1.2) / 3));
        post.castShadow = false;
        grp.add(post);
      }
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, span - 1.0, 6), mats.rust);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(s * (width / 2 - 0.11), 0.98, 0);
      rail.castShadow = false;
      grp.add(rail);
    }
    g.add(grp);
    return grp;
  }

  /* ================================================================= COVER */

  /** concrete pipe on the ground */
  function pipeCover(g, x, z, rot = 0, len = 2.2, r = 0.42) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14, 1, true), mats.concrete);
    body.rotation.z = Math.PI / 2;
    body.rotation.y = rot;
    body.position.set(x, r, z);
    body.castShadow = false;
    body.receiveShadow = true;
    g.add(body);
    for (const s of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.045, 5, 16), mats.concreteDark);
      rim.rotation.y = Math.PI / 2;
      rim.rotation.x = rot;
      rim.position.set(x + Math.cos(rot) * s * len / 2, r, z - Math.sin(rot) * s * len / 2);
      rim.castShadow = false;
      g.add(rim);
    }
    if (addCollider) addColliderRot(x, z, len, r * 2, rot, 0.04, r * 2);
    return body;
  }

  /** stack of tyres */
  function tireStack(g, x, z, n = 3) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    for (let i = 0; i < n; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.13, 6, 14), mats.rubber);
      t.rotation.x = Math.PI / 2;
      t.position.set(jitter(0.06), 0.14 + i * 0.24, jitter(0.06));
      t.rotation.z = rnd() * Math.PI;
      t.castShadow = false;
      grp.add(t);
    }
    g.add(grp);
    if (addCollider) addCollider(x, z, 0.8, 0.8, 0.04, n * 0.24);
    return grp;
  }

  /** stack of wooden pallets */
  function palletStack(g, x, z, n = 3, rot = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    for (let i = 0; i < n; i++) {
      const y = i * 0.16;
      for (let k = 0; k < 3; k++) {
        const slat = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.035, 0.13), mats.wood);
        slat.position.set(0, y + 0.14, -0.42 + k * 0.42);
        slat.castShadow = false;
        grp.add(slat);
      }
      for (const bx of [-0.45, 0, 0.45]) {
        const blk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.9), mats.wood);
        blk.position.set(bx, y + 0.06, 0);
        blk.castShadow = false;
        grp.add(blk);
      }
    }
    g.add(grp);
    if (addCollider) addColliderRot(x, z, 1.2, 0.95, rot, 0.04, n * 0.16);
    return grp;
  }

  /** traffic cone */
  function cone(g, x, z, rot = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.52, 8), mats.paint);
    c.position.y = 0.28;
    c.castShadow = false;
    grp.add(c);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.3), mats.paint);
    base.position.y = 0.03;
    base.castShadow = false;
    grp.add(base);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.15, 0.08, 8), mats.paper);
    band.position.y = 0.32;
    band.castShadow = false;
    grp.add(band);
    g.add(grp);
    return grp;
  }

  /** steel toolbox on the ground */
  function toolbox(g, x, z, rot = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.34, 0.36), mats.metal);
    body.position.y = 0.17;
    body.castShadow = false;
    body.receiveShadow = true;
    grp.add(body);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.06, 0.38), mats.metalTan);
    lid.position.y = 0.36;
    lid.castShadow = false;
    grp.add(lid);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.016, 4, 8, Math.PI), mats.metal);
    handle.position.y = 0.4;
    handle.rotation.y = Math.PI / 2;
    grp.add(handle);
    g.add(grp);
    if (addCollider) addColliderRot(x, z, 0.68, 0.4, rot, 0.04, 0.4);
    return grp;
  }

  /** wooden cable spool on its side */
  function cableSpool(g, x, z, rot = 0, r = 0.62) {
    const grp = new THREE.Group();
    grp.position.set(x, r, z);
    grp.rotation.set(0, rot, Math.PI / 2);
    for (const s of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.07, 14), mats.wood);
      cheek.position.y = s * 0.34;
      cheek.castShadow = false;
      grp.add(cheek);
    }
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.62, 12), mats.rust);
    drum.castShadow = false;
    grp.add(drum);
    g.add(grp);
    if (addCollider) addColliderRot(x, z, r * 2, r * 2, rot, 0.04, r * 2);
    return grp;
  }

  /** sandbag pile: a low, soft corner */
  function sandbagPile(g, x, z, rot = 0, rows = 3, cols = 4) {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = rot;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bag = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.22, 0.32), mats.sandbag);
        bag.position.set(-cols * 0.28 + c * 0.56 + (r % 2) * 0.28, 0.11 + r * 0.2, jitter(0.05));
        bag.rotation.set(jitter(0.06), jitter(0.15), jitter(0.06));
        bag.castShadow = false;
        grp.add(bag);
      }
    }
    g.add(grp);
    if (addCollider) addColliderRot(x, z, cols * 0.56, 0.5, rot, 0.05, rows * 0.2);
    return grp;
  }

  /* ============================================================ BUILDING */

  /** satellite dish on a wall or roof */
  function satelliteDish(g, x, y, z, ry = 0, r = 0.42) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = ry;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), mats.metal);
    arm.rotation.z = Math.PI / 2;
    arm.position.x = 0.25;
    grp.add(arm);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), mats.paper);
    dish.rotation.z = -Math.PI / 2.6;
    dish.position.x = 0.5;
    dish.castShadow = false;
    grp.add(dish);
    const lnb = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.26, 6), mats.metal);
    lnb.rotation.z = Math.PI / 2;
    lnb.position.x = 0.74;
    grp.add(lnb);
    g.add(grp);
    return grp;
  }

  /** fire escape: a landing plus a ladder */
  function fireEscape(g, x, y, z, ry = 0, w = 2.2, d = 1.1) {
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    grp.rotation.y = ry;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), mats.metal);
    deck.position.set(0, 0, d / 2);
    deck.castShadow = false;
    grp.add(deck);
    for (let i = 0; i < 7; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, d), mats.rust);
      bar.position.set(-w / 2 + 0.1 + i * ((w - 0.2) / 6), 0.05, d / 2);
      bar.castShadow = false;
      grp.add(bar);
    }
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), mats.rust);
      post.position.set(s * (w / 2 - 0.05), 0.5, d - 0.05);
      post.castShadow = false;
      grp.add(post);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, d), mats.rust);
      rail.position.set(s * (w / 2 - 0.05), 1.0, d / 2);
      rail.castShadow = false;
      grp.add(rail);
    }
    // ladder down
    const lad = new THREE.Group();
    lad.position.set(-w / 2 + 0.25, -1.9, d * 0.3);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.0, 0.05), mats.rust);
      rail.position.x = s * 0.22;
      rail.castShadow = false;
      lad.add(rail);
    }
    for (let i = 0; i < 6; i++) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.04), mats.rust);
      rung.position.y = -0.9 + i * 0.36;
      rung.castShadow = false;
      lad.add(rung);
    }
    grp.add(lad);
    g.add(grp);
    return grp;
  }

  /* --------------------------------------------------------------- misc */
  function contactShadow(x, z, r) { if (blob) blob(x, z, r, r, 0.35); }
  function poolOfLight(x, z, r, a) { if (lightPool) lightPool(x, z, r, a); }

  return {
    tree, pine, cypress, olive, boulder, stoneWall,
    bush, grassTuft, flowerBed, vine, potPlant, reeds, windowBox, planter,
    pool, fountain, canal, duckBridge, river, flatBridge,
    pipeCover, tireStack, palletStack, cone, toolbox, cableSpool, sandbagPile,
    satelliteDish, fireEscape,
    contactShadow, poolOfLight,
  };
}
