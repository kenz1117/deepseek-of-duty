#!/usr/bin/env node
/**
 * Campaign layout probe — ASCII walkability maps for the campaign set pieces.
 * Run: node tools/campaign-layout-probe.mjs
 */
import * as THREE from 'three';
import { createLevel } from '../src/world/level.js';
import { createNavGrid } from '../src/systems/navgrid.js';

const stubTex = new THREE.Texture();
const matsStub = new Proxy({}, {
  get(_t, key) {
    if (key === 'sprites') return new Proxy({}, { get: () => stubTex });
    return new THREE.MeshStandardMaterial();
  },
});
const engine = { scene: new THREE.Scene(), mats: matsStub };
const level = createLevel(engine);
const nav = createNavGrid(level, { cell: 0.8, radius: 0.32, groundAt: (x, z, y) => level.groundHeight(x, z, y), links: level.navLinks });

function map(label, x0, x1, z0, z1, step = 2) {
  console.log(`\n--- ${label}  x ${x0}..${x1}  z ${z0}..${z1} (step ${step}) ---`);
  let head = '      ';
  for (let x = x0; x <= x1; x += step) head += String(Math.round(x)).padStart(4);
  console.log(head);
  for (let z = z0; z <= z1; z += step) {
    let row = String(Math.round(z)).padStart(5) + ' ';
    for (let x = x0; x <= x1; x += step) {
      row += (nav.isWalkableAt(x, z, 0) ? '   .' : '   #');
    }
    console.log(row);
  }
}

map('SOUTH YARD (OP05)', -18, 18, 54, 82);
map('NORTH CHECKPOINT (OP06-08)', -26, 26, -96, -66);
map('EAST DOCK (OP10 finale)', 28, 46, -92, -70);
map('STREET / MARKET (OP01-04)', -8, 30, -20, 8);

function probe(label, x, z, y = 0) {
  const walk = nav.isWalkableAt(x, z, y);
  const near = nav.closestWalkable(x, z, y);
  const d = near ? Math.hypot(near.x - x, near.z - z) : -1;
  console.log(`${label.padEnd(22)} (${x}, ${z})  walk=${walk ? 'Y' : 'n'}  snap=(${near ? near.x.toFixed(1) : 'NA'}, ${near ? near.z.toFixed(1) : 'NA'}) d=${d.toFixed(2)}  region=${(level.regionAt ? (level.regionAt(x, z) || {}).name : '?')}`);
  return { walk, near };
}

console.log('\n=== boss spawn candidates ===');
[[0, -84], [0, -86], [0, -90], [0, -92], [-6, -78], [-6, -84]].forEach((p) => probe('ckpt boss', p[0], p[1]));
[[-6, 66], [-6, 68], [-4, 62], [-8, 60], [-10, 68]].forEach((p) => probe('yard boss', p[0], p[1]));

console.log('\n=== spawn point counts per candidate rect ===');
const rects = {
  'street rect': { x0: -28, x1: 44, z0: -28, z1: 82 },
  'yard rect': { x0: -24, x1: 24, z0: 50, z1: 82 },
  'checkpoint rect': { x0: -28, x1: 28, z0: -94, z1: -68 },
  'market rect': { x0: -6, x1: 30, z0: -24, z1: 10 },
};
const pts = level.spawnPoints || [];
console.log('total spawn points:', pts.length);
for (const [name, r] of Object.entries(rects)) {
  const inside = pts.filter((p) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1 && (p.y || 0) < 1);
  console.log(`${name.padEnd(18)} -> ${inside.length} ground spawn points`, inside.slice(0, 6).map((p) => `(${p.x.toFixed(0)},${p.z.toFixed(0)})`).join(' '));
}
