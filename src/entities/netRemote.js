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

function makeNameSprite(name, team = null) {
  const text = String(name || 'OPERATOR').slice(0, 12).toUpperCase();
  const teamColor = team === 0 ? '#78baff' : team === 1 ? '#ff8b7d' : '#e2b45c';
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
  ctx.strokeStyle = teamColor;
  ctx.lineWidth = 3;
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

export function createNetAvatar({ scene, mats, name, variant = 0, officer = true, team = null }) {
  const rig = buildSoldier(mats, variant % 3, 'rifleman');
  const group = new THREE.Group();
  group.add(rig.root);
  const label = makeNameSprite(officer ? `★ ${name}` : name, team);
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

  // Team recognition must survive distance, shadow and nameplate occlusion.
  // Keep the emissive contribution subtle so these read as uniform panels,
  // not glowing targets.
  if (team === 0 || team === 1) {
    const color = team === 0 ? 0x3b83c4 : 0xc54f43;
    const teamMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.22, roughness: 0.68, metalness: 0.08,
    });
    const addTeamPanel = (x, y, z, sx, sy, sz) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), teamMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      rig.root.add(mesh);
      officerBits.push(mesh);
    };
    addTeamPanel(-0.245, 1.455, 0.015, 0.075, 0.055, 0.21);
    addTeamPanel(0.245, 1.455, 0.015, 0.075, 0.055, 0.21);
    addTeamPanel(0, 1.36, 0.164, 0.19, 0.055, 0.018);
  }

  let walkT = 0;
  let walkAmp = 0;
  let alive = true;
  let deathT = 0;
  let first = true;

  function setAlive(next) {
    if (next === alive) return;
    alive = next;
    deathT = 0;
    group.visible = true;
    label.visible = alive;
    if (alive) group.rotation.z = 0;
  }

  function apply(state, dt) {
    if (!state) return;
    const step = Math.max(0.001, Math.min(0.1, Number(dt) || 0.016));
    const dx = (state.x || 0) - group.position.x;
    const dz = (state.z || 0) - group.position.z;
    const fallbackSpeed = Math.hypot(dx, dz) / step;
    const reportedSpeed = Number(state.speed);
    const speed = Number.isFinite(reportedSpeed) ? Math.max(0, reportedSpeed) : fallbackSpeed;
    if (first) {
      group.position.set(state.x || 0, state.y || 0, state.z || 0);
      group.rotation.y = state.yaw || 0;
      first = false;
    } else {
      const a = Math.min(1, step * 12);
      group.position.x += dx * a;
      group.position.y += ((state.y || 0) - group.position.y) * a;
      group.position.z += dz * a;
      let dy = (state.yaw || 0) - group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      group.rotation.y += dy * Math.min(1, step * 12);
    }
    setAlive(state.alive !== false);
    group.visible = true;
    if (!alive) {
      deathT = Math.min(1, deathT + step * 3.8);
      const fall = 1 - (1 - deathT) * (1 - deathT);
      group.rotation.z = -Math.PI * 0.47 * fall;
      return;
    }
    group.rotation.z = 0;
    label.visible = true;
    const moveAmount = THREE.MathUtils.clamp(speed / 4.5, 0, 1);
    walkAmp += (moveAmount * 0.85 - walkAmp) * Math.min(1, step * 9);
    walkT += step * (speed > 0.15 ? 5.2 + Math.min(speed, 8) * 0.45 : 1.2);
    applyPose(rig, {
      time: walkT,
      crouch: THREE.MathUtils.clamp(Number(state.crouch) || 0, 0, 1),
      walkAmp,
      walkPhase: walkT,
      aim: THREE.MathUtils.clamp(state.aim == null ? 0.65 : Number(state.aim) || 0, 0, 1),
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
    set alive(v) { setAlive(!!v); },
    get position() { return group.position; },
  };
}
