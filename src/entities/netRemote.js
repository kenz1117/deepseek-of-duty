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

export function createNetAvatar({ scene, mats, name, variant = 0 }) {
  const rig = buildSoldier(mats, variant % 3, 'rifleman');
  const group = new THREE.Group();
  group.add(rig.root);
  const label = makeNameSprite(name);
  group.add(label);
  scene.add(group);

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
