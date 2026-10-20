import * as THREE from 'three';
import { INTEL } from '../codex.js';

/* Fixed intel pickups. The meshes are tiny (paper + glow) and the E prompt is
   driven by the shared interact system, not by proximity in here. */

const SPOTS = [
  { id: 'pass', x: 12.2, y: 0.9, z: -13.4 },
  { id: 'manifest', x: -12.4, y: 0.9, z: -3.0 },
  { id: 'radio_log', x: 20.8, y: 0.9, z: -12.4 },
  { id: 'roster', x: 6.2, y: 0.9, z: -61.0 },
  { id: 'order', x: 11.4, y: 1.1, z: -66.3 },
  { id: 'exfil', x: 41.8, y: 0.9, z: -76.8 },
  /* expansion districts — two per district so intel play pays off everywhere */
  { id: 'souk_ledger', x: -73.4, y: 0.9, z: 10.8 },
  { id: 'souk_route', x: -53.2, y: 0.9, z: 13.2 },
  { id: 'rail_waybill', x: 15.0, y: 1.62, z: -159.2 },
  { id: 'rail_signal', x: 5.2, y: 0.9, z: -148.6 },
  { id: 'port_tally', x: 78.8, y: 0.95, z: 25.8 },
  { id: 'port_note', x: 82.8, y: 0.95, z: 12.6 },
];

export function createIntel({ scene, mats }) {
  const items = [];
  const paperGeo = new THREE.PlaneGeometry(0.32, 0.42);
  const glowMat = new THREE.SpriteMaterial({
    map: mats.sprites.glow, color: new THREE.Color(0xc8b46a),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0.35,
  });

  for (const s of SPOTS) {
    const def = INTEL.find((i) => i.id === s.id);
    if (!def) continue;
    const g = new THREE.Group();
    const paper = new THREE.Mesh(paperGeo, mats.paper || mats.signA);
    paper.rotation.x = -Math.PI / 2;
    paper.rotation.z = Math.random() * 0.6;
    g.add(paper);
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(0.9);
    glow.position.y = 0.12;
    g.add(glow);
    g.position.set(s.x, s.y, s.z);
    scene.add(g);
    items.push({ id: s.id, def, group: g, collected: false, baseY: s.y, phase: Math.random() * 6 });
  }

  function update(dt, time) {
    for (const it of items) {
      if (it.collected) continue;
      it.group.position.y = it.baseY + Math.sin(time * 1.6 + it.phase) * 0.05;
      it.group.rotation.y += dt * 0.6;
    }
  }

  function collect(id) {
    const it = items.find((i) => i.id === id);
    if (!it || it.collected) return null;
    it.collected = true;
    it.group.visible = false;
    return it.def;
  }

  function targetList() {
    return items.filter((i) => !i.collected).map((it) => ({
      x: it.group.position.x, z: it.group.position.z, r: 2.0,
      label: `E 收集情报 · ${it.def.title}`, id: it.id,
    }));
  }

  return { items, update, collect, targetList, SPOTS };
}
