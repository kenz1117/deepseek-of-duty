import * as THREE from 'three';
import { buildSoldier, applyPose } from './soldierParts.js';

/* A scripted friendly NPC. No hitbox, no collision, no AI: it only holds a
   pose and scans, so it can stand in the escape route without affecting the
   fight. MOTH is a UAV operator, so the rifle stays low. */
export function createAlly({ scene, mats, x, z, yaw = 0, variant = 2 }) {
  const rig = buildSoldier(mats, variant, 'rifleman');
  const root = rig.root;
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  if (rig.weaponFlash) rig.weaponFlash.visible = false;
  scene.add(root);
  let time = Math.random() * 4;
  let scan = 0;

  function update(dt) {
    time += dt;
    scan += dt;
    applyPose(rig, {
      aim: 0.35, crouch: 0, walkAmp: 0.015, time, aimPitch: -0.06,
      flinch: 0,
    });
    // slow head scan, like someone watching a tablet / the sky
    rig.headPivot.rotation.y = Math.sin(scan * 0.55) * 0.38;
    rig.headPivot.rotation.x = -0.12 + Math.sin(scan * 0.9) * 0.04;
  }

  function remove() {
    scene.remove(root);
    if (rig.dispose) rig.dispose();
  }

  return { root, update, remove, get position() { return root.position; } };
}
