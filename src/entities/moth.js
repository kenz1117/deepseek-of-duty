import * as THREE from 'three';

/* =========================================================================
   MOTH — a dedicated UAV operator model, built from primitives.

   Deliberately NOT the soldier rig: no helmet, no plate carrier, no rifle.
   She reads as a specialist: beanie, headset + boom mic, jacket, backpack
   antenna, tablet in both hands. No hitbox, no collision, no combat logic.
   ========================================================================= */

function makePatchTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1f24'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#e3b26a'; g.lineWidth = 5; g.strokeRect(6, 6, 244, 116);
  g.fillStyle = '#e3b26a';
  g.font = 'bold 46px monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 52);
  g.fillStyle = '#9fb2be';
  g.font = '22px monospace';
  g.fillText('UAV // ISR', 128, 94);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 2;
  return t;
}

export function createMoth({ scene, x, z, yaw = 0 }) {
  const M = {
    jacket: new THREE.MeshStandardMaterial({ color: 0x36434f, roughness: 0.9 }),
    jacketDark: new THREE.MeshStandardMaterial({ color: 0x232b33, roughness: 0.95 }),
    pants: new THREE.MeshStandardMaterial({ color: 0x3a3d37, roughness: 0.96 }),
    boot: new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.85 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc99a7a, roughness: 0.7 }),
    beanie: new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.98 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.55, metalness: 0.15 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x6d737a, roughness: 0.42, metalness: 0.65 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xe3b26a, roughness: 0.6 }),
    vest: new THREE.MeshStandardMaterial({ color: 0xc46b1e, roughness: 0.82 }),
    reflect: new THREE.MeshStandardMaterial({ color: 0xd9e6ea, roughness: 0.35, metalness: 0.1, emissive: 0x1a2428, emissiveIntensity: 0.4 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x74d6ff, toneMapped: false }),
    led: new THREE.MeshBasicMaterial({ color: 0x7dff9a, toneMapped: false }),
    patch: new THREE.MeshStandardMaterial({ map: makePatchTexture('MOTH'), roughness: 0.9 }),
  };

  const root = new THREE.Group();
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  scene.add(root);
  // cool fill so the front reads against the sunset backlight
  const fill = new THREE.PointLight(0xa8d8ff, 0.34, 2.2, 2);
  fill.position.set(0, 1.15, -0.35);
  root.add(fill);
  // tiny warm face light so the head is not a silhouette
  const faceLight = new THREE.PointLight(0xffd9b0, 0.22, 1.1, 2);
  faceLight.position.set(0, 1.5, -0.32);
  root.add(faceLight);

  const box = (w, h, d, mat, px, py, pz, parent = root) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(px, py, pz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const cyl = (r1, r2, h, seg, mat, px, py, pz, parent = root) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat);
    m.position.set(px, py, pz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  /* ---------------------------------------------------------------- lower body */
  const hips = new THREE.Group();
  hips.position.y = 0.96;
  root.add(hips);

  for (const sx of [-1, 1]) {
    box(0.16, 0.14, 0.28, M.boot, sx * 0.115, -0.9, -0.03, hips);   // boots
    box(0.145, 0.52, 0.17, M.pants, sx * 0.115, -0.57, 0.0, hips);  // shins
    box(0.17, 0.48, 0.2, M.pants, sx * 0.12, -0.12, 0.0, hips);     // thighs
  }
  box(0.36, 0.2, 0.24, M.pants, 0, -0.02, 0, hips);                 // seat
  box(0.38, 0.07, 0.25, M.plastic, 0, 0.08, 0, hips);               // belt

  /* ------------------------------------------------------------------- torso */
  const torso = new THREE.Group();
  torso.position.y = 1.08;
  root.add(torso);
  box(0.42, 0.46, 0.25, M.jacket, 0, 0.22, 0, torso);               // jacket body
  box(0.44, 0.12, 0.27, M.jacketDark, 0, 0.03, 0, torso);           // hem
  box(0.14, 0.4, 0.06, M.jacketDark, 0, 0.22, -0.15, torso);        // zip strip
  box(0.3, 0.1, 0.06, M.accent, 0, 0.38, 0.16, torso);              // shoulder stripe? back
  // high-vis vest front/back + reflective strips
  box(0.4, 0.3, 0.015, M.vest, 0, 0.22, -0.132, torso);
  box(0.4, 0.3, 0.015, M.vest, 0, 0.22, 0.132, torso);
  for (const yy of [0.16, 0.28]) {
    box(0.41, 0.045, 0.02, M.reflect, 0, yy, -0.135, torso);
    box(0.41, 0.045, 0.02, M.reflect, 0, yy, 0.135, torso);
  }
  // chest patch
  const chest = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.07), M.patch);
  chest.position.set(-0.12, 0.3, -0.131);
  torso.add(chest);

  /* backpack + antenna */
  const pack = new THREE.Group();
  pack.position.set(0, 1.24, 0.18);
  root.add(pack);
  box(0.32, 0.4, 0.17, M.jacketDark, 0, 0, 0, pack);
  box(0.26, 0.08, 0.04, M.accent, 0, 0.12, 0.095, pack);
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11), M.patch);
  patch.position.set(0, 0.02, 0.092);
  pack.add(patch);
  const antenna = new THREE.Group();
  antenna.position.set(0.11, 0.2, 0.04);
  pack.add(antenna);
  cyl(0.012, 0.012, 0.55, 6, M.metal, 0, 0.275, 0, antenna);
  cyl(0.035, 0.02, 0.06, 8, M.plastic, 0, 0.03, 0, antenna);
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), M.led);
  led.position.set(0, 0.56, 0);
  antenna.add(led);

  /* ------------------------------------------------------------------- head */
  const neck = new THREE.Group();
  neck.position.y = 1.5;
  root.add(neck);
  cyl(0.055, 0.06, 0.09, 8, M.skin, 0, 0.03, 0, neck);
  const headPivot = new THREE.Group();
  headPivot.position.y = 0.15;
  neck.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), M.skin);
  head.scale.set(0.9, 1.0, 0.95);
  head.castShadow = true;
  headPivot.add(head);
  // beanie
  const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.104, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), M.beanie);
  beanie.position.y = 0.025;
  beanie.scale.set(1, 0.95, 1);
  beanie.castShadow = true;
  headPivot.add(beanie);
  box(0.215, 0.04, 0.215, M.beanie, 0, 0.022, 0, headPivot);          // cuff
  // face plate (keeps the face readable at distance)
  box(0.13, 0.1, 0.03, M.skin, 0, 0.0, -0.088, headPivot);
  box(0.06, 0.032, 0.03, M.reflect, 0, 0.085, -0.102, headPivot);    // headlamp
  // headset
  for (const sx of [-1, 1]) {
    const cup = cyl(0.045, 0.045, 0.03, 10, M.plastic, sx * 0.105, 0.01, 0, headPivot);
    cup.rotation.z = Math.PI / 2;
  }
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.012, 6, 12, Math.PI), M.plastic);
  band.rotation.z = Math.PI;
  band.position.y = 0.03;
  headPivot.add(band);
  // glasses (reads as a tech specialist, not a soldier)
  box(0.15, 0.03, 0.02, M.plastic, 0, 0.012, -0.106, headPivot);
  box(0.02, 0.032, 0.02, M.plastic, 0, 0.02, -0.1, headPivot);
  // boom mic
  const boom = new THREE.Group();
  boom.position.set(-0.1, -0.005, -0.02);
  headPivot.add(boom);
  cyl(0.008, 0.008, 0.15, 5, M.plastic, 0, -0.07, -0.05, boom).rotation.x = 0.5;
  cyl(0.014, 0.014, 0.03, 6, M.plastic, 0, -0.13, -0.11, boom);

  /* ------------------------------------------------------------------- arms */
  /* arms built as explicit segments so the hands actually meet the tablet */
  const limb = (ax, ay, az, bx, by, bz, r, mat) => {
    const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = dir.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, len, 7), mat);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    m.castShadow = true; m.receiveShadow = true;
    root.add(m);
    return m;
  };
  for (const sx of [-1, 1]) {
    const sh = [sx * 0.235, 1.46, 0];
    const el = [sx * 0.30, 1.17, -0.11];
    const hd = [sx * 0.155, 1.04, -0.305];
    // shoulder cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), M.jacket);
    cap.position.set(sh[0], sh[1], sh[2]);
    cap.castShadow = true;
    root.add(cap);
    limb(sh[0], sh[1], sh[2], el[0], el[1], el[2], 0.062, M.jacket);
    limb(el[0], el[1], el[2], hd[0], hd[1], hd[2], 0.052, M.jacketDark);
    // cuff
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 8), M.jacketDark);
    cuff.position.set(hd[0], hd[1] + 0.02, hd[2] + 0.02);
    root.add(cuff);
    // hand reaching the tablet edge
    const hand = box(0.075, 0.10, 0.08, M.skin, hd[0], hd[1], hd[2], root);
    hand.rotation.set(-0.6, 0, sx * 0.25);
    // thumb
    box(0.022, 0.05, 0.025, M.skin, hd[0] + sx * 0.03, hd[1] + 0.01, hd[2] - 0.035, root);
  }

  /* tablet held in both hands */
  const tablet = new THREE.Group();
  tablet.position.set(0, 1.03, -0.34);
  tablet.rotation.x = -0.55;
  root.add(tablet);
  box(0.3, 0.02, 0.2, M.plastic, 0, 0, 0, tablet);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), M.screen);
  screen.rotation.x = -Math.PI / 2;
  screen.position.y = 0.012;
  tablet.add(screen);
  box(0.05, 0.015, 0.04, M.accent, 0.11, 0.015, 0.06, tablet);

  // pose the arms down toward the tablet

  /* ------------------------------------------------------------------ update */
  let t = Math.random() * 10;
  const baseY = root.position.y;
  function update(dt) {
    t += dt;
    // breathing + weight shift
    root.position.y = baseY + Math.sin(t * 1.4) * 0.008;
    torso.rotation.z = Math.sin(t * 0.7) * 0.012;
    torso.rotation.x = 0.03 + Math.sin(t * 1.4) * 0.008;
    // head: tablet -> horizon scan
    headPivot.rotation.y = Math.sin(t * 0.42) * 0.34;
    headPivot.rotation.x = -0.05 + Math.sin(t * 0.9) * 0.03;
    // tablet tilt + screen flicker
    tablet.rotation.z = Math.sin(t * 0.8) * 0.03;
    tablet.position.y = 1.08 + Math.sin(t * 1.6) * 0.006;
    M.screen.color.setHex(Math.sin(t * 3.1) > 0.96 ? 0xbdefff : 0x74d6ff);
    // antenna sway + LED blink
    antenna.rotation.z = Math.sin(t * 1.1) * 0.035;
    M.led.color.setHex(Math.sin(t * 2.4) > 0 ? 0x7dff9a : 0x1d6b34);
  }

  function remove() {
    scene.remove(root);
    root.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
      }
    });
    for (const k in M) if (M[k].dispose) M[k].dispose();
  }

  return { root, update, remove, get position() { return root.position; } };
}
