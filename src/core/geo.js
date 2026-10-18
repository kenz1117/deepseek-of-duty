import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =========================================================================
   Geometry helpers: world-space UV projection (so every surface keeps a
   consistent texel density with a single shared material) and static merging.
   ========================================================================= */

export function projectBoxUV(geo, scale = 1) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= ax && ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv.setXY(i, u / scale, v / scale);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Project a plane's UVs from world position; mode 'z' faces ±Z, 'x' faces ±X, 'y' faces up */
export function projectPlaneUV(geo, tile = 1, mode = 'z') {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (mode === 'x') { u = z / tile; v = -y / tile; }
    else if (mode === 'y') { u = x / tile; v = z / tile; }
    else { u = x / tile; v = -y / tile; }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
  return geo;
}

export function box(w, h, d, mat, { uvScale = 1, round = 0, segments = 2 } = {}) {
  let geo;
  if (round > 0) {
    geo = new RoundedBox(w, h, d, segments, round);
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
  }
  projectBoxUV(geo, uvScale);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

let _roundedGeoCache = new Map();
function RoundedBox(w, h, d, seg, r) {
  const key = `${w}|${h}|${d}|${seg}|${r}`;
  if (!_roundedGeoCache.has(key)) {
    const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) * 0.49));
    _roundedGeoCache.set(key, g);
  }
  return _roundedGeoCache.get(key).clone();
}

// three addons has RoundedBoxGeometry; grab it lazily to keep imports tidy
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function cyl(rt, rb, h, seg, mat, { uvScale = 1 } = {}) {
  const geo = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  // cylindrical UVs: keep world-ish density
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (Math.PI * 2 * Math.max(rt, rb)) / uvScale, uv.getY(i) * h / uvScale);
  }
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/** Merge a group's static meshes by material into a handful of draw calls. */
export function mergeStatic(group, { castShadow = true, receiveShadow = true } = {}) {
  group.updateMatrixWorld(true);
  const byMat = new Map();
  const leftovers = [];
  group.traverse((o) => {
    if (!o.isMesh || o.userData.noMerge) { if (o.isMesh) leftovers.push(o); return; }
    let geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    // drop attributes that break merging when absent
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    }
    if (!geo.attributes.uv) {
      const count = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    const key = o.material.uuid;
    if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [] });
    byMat.get(key).geos.push(geo);
  });
  const out = new THREE.Group();
  for (const { mat, geos } of byMat.values()) {
    try {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      out.add(mesh);
    } catch (e) {
      console.warn('merge failed for material', mat.name, e);
    }
    for (const g of geos) g.dispose();
  }
  for (const o of leftovers) out.add(o);
  return out;
}
