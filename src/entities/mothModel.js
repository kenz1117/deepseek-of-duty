import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =========================================================================
   MOTH — real CC0 glTF character (Quaternius Ultimate Modular Women, SciFi).

   The pack ships a skinned rig without animation clips, so the idle is a
   hand-posed skeleton: arms aimed at a tablet, plus a small procedural sway
   on chest/head. Tablet, headset and backpack antenna are added in code so
   she reads as a UAV operator rather than a generic soldier.
   ========================================================================= */

const MODEL_URL = '/models/moth.glb';
const TARGET_HEIGHT = 1.75;

export function loadMothGlb(url = MODEL_URL) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(url, resolve, undefined, reject);
  });
}

function aimBone(bones, boneName, childName, dirLocal, modelQuat) {
  const bone = bones[boneName];
  const child = bones[childName];
  if (!bone || !child) return;
  bone.updateWorldMatrix(true, false);
  const parentQ = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(parentQ);
  const target = dirLocal.clone().applyQuaternion(modelQuat).normalize();
  const local = target.applyQuaternion(parentQ.clone().invert()).normalize();
  const rest = child.position.clone().normalize();
  bone.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(rest, local));
}

function makePatchTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#151a20'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#e3b26a'; g.lineWidth = 5; g.strokeRect(6, 6, 244, 116);
  g.fillStyle = '#e3b26a'; g.font = 'bold 46px monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('MOTH', 128, 52);
  g.fillStyle = '#9fb2be'; g.font = '22px monospace';
  g.fillText('UAV // ISR', 128, 94);
  return new THREE.CanvasTexture(c);
}

export function createMothFromGlb(gltf, { scene, x, z, yaw = 0 }) {
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  scene.add(root);

  const inner = gltf.scene;
  // restoring the bind transform keeps repeated spawns identical (the same
  // scene object is reused when OP10 is restarted)
  if (!gltf.userData.__mothBase) {
    gltf.userData.__mothBase = {
      p: inner.position.clone(), q: inner.quaternion.clone(), s: inner.scale.clone(),
    };
  }
  const bindBase = gltf.userData.__mothBase;
  inner.position.copy(bindBase.p);
  inner.quaternion.copy(bindBase.q);
  inner.scale.copy(bindBase.s);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const scale = TARGET_HEIGHT / (size.y || 1.85);
  inner.scale.setScalar(scale);
  inner.position.y = -box.min.y * scale;
  // keep the glTF's own axis correction; face -Z with a wrapper instead
  const facing = new THREE.Group();
  facing.rotation.y = Math.PI;
  facing.add(inner);
  inner.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      if (o.material) {
        o.material.side = THREE.FrontSide;
        if (o.material.map) o.material.map.anisotropy = 4;
      }
    }
  });
  root.add(facing);
  root.updateMatrixWorld(true);

  // ---- pose the arms around a tablet (bones are local to the model)
  const bones = {};
  inner.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const modelQ = new THREE.Quaternion();
  inner.getWorldQuaternion(modelQ);
  const v = (a, b, c) => new THREE.Vector3(a, b, c);
  aimBone(bones, 'UpperArmL', 'LowerArmL', v(-0.22, -0.85, 0.48), modelQ);
  aimBone(bones, 'UpperArmR', 'LowerArmR', v(0.22, -0.85, 0.48), modelQ);
  aimBone(bones, 'LowerArmL', 'HandL', v(0.18, -0.24, 0.95), modelQ);
  aimBone(bones, 'LowerArmR', 'HandR', v(-0.18, -0.24, 0.95), modelQ);

  // ---- tablet in both hands
  const tablet = new THREE.Group();
  tablet.position.set(0, 1.02, -0.27);
  tablet.rotation.x = -0.5;
  root.add(tablet);
  const tBody = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.55, metalness: 0.2 }));
  tBody.castShadow = true;
  tablet.add(tBody);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x74d6ff, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), screenMat);
  screen.rotation.x = -Math.PI / 2;
  screen.position.y = 0.011;
  tablet.add(screen);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.04),
    new THREE.MeshStandardMaterial({ color: 0xe3b26a, roughness: 0.6 }));
  edge.position.set(0.11, 0.016, 0.06);
  tablet.add(edge);

  // ---- headset + boom mic (attached at head height; head sway is tiny)
  const headset = new THREE.Group();
  headset.position.set(0, 1.6, 0);
  root.add(headset);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.7 });
  for (const sx of [-1, 1]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), dark);
    cup.rotation.z = Math.PI / 2;
    cup.position.set(sx * 0.105, 0, 0);
    headset.add(cup);
  }
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.011, 6, 12, Math.PI), dark);
  band.rotation.z = Math.PI;
  band.position.y = 0.03;
  headset.add(band);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.13, 5), dark);
  boom.position.set(-0.1, -0.055, -0.03);
  boom.rotation.x = 0.55;
  headset.add(boom);
  const mic = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 4), dark);
  mic.position.set(-0.1, -0.11, -0.075);
  headset.add(mic);

  // ---- backpack antenna + patch
  const pack = new THREE.Group();
  pack.position.set(0, 1.28, 0.15);
  root.add(pack);
  const packBox = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x222a31, roughness: 0.85 }));
  packBox.castShadow = true;
  pack.add(packBox);
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.09),
    new THREE.MeshStandardMaterial({ map: makePatchTexture(), roughness: 0.9 }));
  patch.position.set(0, 0.02, 0.062);
  pack.add(patch);
  const antenna = new THREE.Group();
  antenna.position.set(0.1, 0.17, 0.02);
  pack.add(antenna);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x6d737a, roughness: 0.4, metalness: 0.6 }));
  rod.position.y = 0.25;
  antenna.add(rod);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x7dff9a, toneMapped: false });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.017, 6, 4), ledMat);
  led.position.y = 0.5;
  antenna.add(led);

  // ---- small cool fill so the face reads at dusk
  const fill = new THREE.PointLight(0xa8d8ff, 0.32, 2.0, 2);
  fill.position.set(0, 1.35, -0.4);
  root.add(fill);

  // ---- idle: tiny skeletal sway around the posed base
  const base = {};
  for (const n of ['Chest', 'Neck', 'Head', 'Torso']) {
    if (bones[n]) base[n] = bones[n].quaternion.clone();
  }
  let t = Math.random() * 8;
  const dq = new THREE.Quaternion();
  const e = new THREE.Euler();

  function update(dt) {
    t += dt;
    const sway = Math.sin(t * 0.55);
    if (bones.Chest && base.Chest) {
      e.set(0.012 * Math.sin(t * 1.4), sway * 0.035, 0.01 * sway);
      bones.Chest.quaternion.copy(base.Chest).multiply(dq.setFromEuler(e));
    }
    if (bones.Head && base.Head) {
      e.set(-0.03 + 0.02 * Math.sin(t * 0.9), Math.sin(t * 0.33) * 0.22, 0.01 * sway);
      bones.Head.quaternion.copy(base.Head).multiply(dq.setFromEuler(e));
    }
    tablet.position.y = 1.02 + Math.sin(t * 1.5) * 0.006;
    tablet.rotation.z = sway * 0.025;
    antenna.rotation.z = Math.sin(t * 1.1) * 0.03;
    ledMat.color.setHex(Math.sin(t * 2.3) > 0 ? 0x7dff9a : 0x1d6b34);
    screenMat.color.setHex(Math.sin(t * 3.1) > 0.96 ? 0xbdefff : 0x74d6ff);
  }

  function remove() {
    scene.remove(root);
    facing.remove(inner);              // keep the source glTF reusable
    for (const g of [tablet, headset, pack]) {
      g.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m) { if (m.map) m.map.dispose(); m.dispose(); } }
      });
    }
    if (fill) fill.dispose();
  }

  return { root, update, remove, get position() { return root.position; }, source: 'glb',
    get info() { return { size: [size.x, size.y, size.z], scale, innerScale: inner.scale.x, innerY: inner.position.y }; } };
}
