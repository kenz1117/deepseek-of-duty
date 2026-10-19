import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

/* =========================================================================
   Raycast acceleration.

   The world is merged into a handful of very large static meshes (~1.2M
   triangles). A brute-force THREE.Raycaster walk over that geometry costs
   ~9 ms per bullet, so a single shotgun blast blocked the frame for 70+ ms.
   Patching Mesh.raycast with three-mesh-bvh makes every geometry that owns a
   boundsTree ~50x cheaper to raycast, and silently falls back to the stock
   implementation for meshes without one (enemy hitboxes, props).
   ========================================================================= */

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export function buildBoundsTree(geometry, options = {}) {
  if (!geometry || geometry.boundsTree) return null;
  // leaf 16 keeps the tree small for big merged buffers without slowing queries much
  const tree = geometry.computeBoundsTree({ maxLeafSize: 16, ...options });
  return tree;
}

export function buildBoundsTreeFor(objects) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let count = 0;
  for (const o of objects) {
    if (!o || !o.isMesh || !o.geometry) continue;
    if (buildBoundsTree(o.geometry)) count++;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { count, ms };
}
