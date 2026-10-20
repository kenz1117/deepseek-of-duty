/* =========================================================================
 * NET AVATARS — lightweight visuals for LAN players and remote enemies.
 *
 * The game already has a full soldier rig (`soldierParts`) and a full Enemy
 * class. For networked actors we only need the visual half:
 *
 *   • NetAvatar: one human rig + a canvas nameplate, interpolated from
 *     snapshots. No AI, no hitboxes, no audio.
 *   • Remote enemy visuals reuse the normal Enemy rig on the host and are
 *     created by main.js on clients (so their hitboxes/animations stay
 *     consistent); this module only owns the player avatar.
 * ========================================================================= */

import * as THREE from 'three';
import { buildSoldier, applyPose } from './soldierParts.js';

function makeNameSprite(name) {
  const text = String(name || 'OPERATOR').slice(0, 12).toUpperCase();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = '600 30px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(4,8,10,0.62)';
  ctx.fillRect(24, 12, 208, 40);
  ctx.strokeStyle = 'rgba(226,180,92,0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 12, 208, 40);
  ctx.fillStyle = 'rgba(240,232,218,0.95)';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.25, 0.31, 1);
  sprite.position.set(0, 2.22, 0);
  return sprite;
}

export function createNetAvatar({ scene, mats, name, variant = 0, officer = true }) {
  const rig = buildSoldier(mats, variant % 3, 'rifleman');
  const group = new THREE.Group();
  group.add(rig.root);
  const label = makeNameSprite(officer ? `★ ${name}` : name);
  group.add(label);
  scene.add(group);

  // Officer silhouette: peaked cap + gold shoulder boards + collar tabs +
  // chest badge. Human LAN players must not read as another generic insurgent
  // when they stand next to AI soldiers.
  const officerBits = [];
  if (officer) {
    const capMat = new THREE.MeshStandardMaterial({ color: 0x1b241f, roughness: 0.82, metalness: 0.05 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.35, metalness: 0.75 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0x7d2320, roughness: 0.8, metalness: 0.05 });
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = true;
      rig.root.add(m);
      officerBits.push(m);
      return m;
    };
    const isRed = true;   // officers always wear the red beret — the clearest silhouette cue
    if (isRed) {
      add(new THREE.SphereGeometry(0.135, 12, 8), redMat, 0, 1.785, -0.012, 0, 0, -0.16).scale.set(1, 0.46, 1.05);
    } else {
      add(new THREE.CylinderGeometry(0.145, 0.16, 0.085, 12), capMat, 0, 1.8, 0);
      add(new THREE.BoxGeometry(0.3, 0.018, 0.13), capMat, 0, 1.762, 0.08);
      add(new THREE.BoxGeometry(0.155, 0.016, 0.155), goldMat, 0, 1.768, 0.012);
    }
    // gold shoulder boards
    add(new THREE.BoxGeometry(0.11, 0.018, 0.2), goldMat, -0.23, 1.47, 0, 0, 0, 0.18);
    add(new THREE.BoxGeometry(0.11, 0.018, 0.2), goldMat, 0.23, 1.47, 0, 0, 0, -0.18);
    // collar tabs and chest badge
    add(new THREE.BoxGeometry(0.055, 0.03, 0.02), goldMat, -0.09, 1.51, 0.14, 0, 0.25, 0);
    add(new THREE.BoxGeometry(0.055, 0.03, 0.02), goldMat, 0.09, 1.51, 0.14, 0, -0.25, 0);
    add(new THREE.BoxGeometry(0.075, 0.085, 0.018), goldMat, 0.16, 1.36, 0.155, 0, -0.1, 0);
  }

  let walkT = 0;
  let walkAmp = 0;
  let alive = true;
  let target = { x: 0, z: 0, yaw: 0 };
  let first = true;

  function apply(state, dt) {
    if (!state) return;
    const moving = Math.hypot((state.x || 0) - group.position.x, (state.z || 0) - group.position.z);
    if (first) {
      group.position.set(state.x || 0, state.y || 0, state.z || 0);
      group.rotation.y = state.yaw || 0;
      first = false;
    } else {
      const a = Math.min(1, dt * 12);
      group.position.x += ((state.x || 0) - group.position.x) * a;
      group.position.y += ((state.y || 0) - group.position.y) * a;
      group.position.z += ((state.z || 0) - group.position.z) * a;
      let dy = (state.yaw || 0) - group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      group.rotation.y += dy * Math.min(1, dt * 12);
    }
    alive = state.alive !== false;
    group.visible = alive;
    if (!alive) return;
    walkAmp += ((moving > 0.02 ? 0.75 : 0) - walkAmp) * Math.min(1, dt * 8);
    walkT += dt * (moving > 0.02 ? 7 : 1.2);
    applyPose(rig, {
      time: walkT,
      crouch: state.crouch || 0,
      walkAmp,
      walkPhase: walkT,
      aim: state.aim != null ? state.aim : 0.65,
      weaponLevel: 0,
      aimPitch: state.pitch || 0,
      lookYaw: 0,
      flinch: 0,
      recoil: 0,
      limp: 0,
      headRoll: 0,
      deathSide: 1,
      flinchSide: 1,
    });
  }

  function dispose() {
    scene.remove(group);
    for (const m of officerBits) {
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    officerBits.length = 0;
    rig.dispose();
    if (label.material) {
      if (label.material.map) label.material.map.dispose();
      label.material.dispose();
    }
  }

  return {
    group, label, apply, dispose,
    get alive() { return alive; },
    set alive(v) { alive = !!v; group.visible = alive; },
    get position() { return group.position; },
  };
}
