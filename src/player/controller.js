import * as THREE from 'three';

/* =========================================================================
   First-person controller: pointer-lock mouse look, acceleration based
   movement, wall sliding, sprint / crouch / jump, head bob, ADS zoom,
   recoil springs and trauma-based camera shake.
   ========================================================================= */

export function createController(camera, colliders, bounds, audio) {
  const pos = new THREE.Vector3(0, 0, 34);
  const vel = new THREE.Vector3();
  let yaw = 0, pitch = 0;
  let recoilPitch = 0, recoilYaw = 0;
  let recoilPitchVel = 0, recoilYawVel = 0;
  let adsT = 0, sprintT = 0, crouchT = 0;
  let eyeBase = 1.68;
  let bobT = 0, bobAmp = 0;
  let stepAccum = 0;
  let grounded = true, vy = 0;
  let shake = 0;
  let dead = false;
  let deadT = 0;
  let lastDamage = 0;
  const SPEED = { walk: 4.3, sprint: 7.0, crouch: 2.2, ads: 2.9 };
  const radius = 0.36;
  const state = { speed: 0, moving: false, sprinting: false, crouching: false, ads: false };

  function collides(x, z) {
    for (const c of colliders) {
      const cx = THREE.MathUtils.clamp(x, c.x0, c.x1);
      const cz = THREE.MathUtils.clamp(z, c.z0, c.z1);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1;
  }

  function update(dt, input, opts = {}) {
    if (input) {
      const { dx, dy } = input.consumeMouse();
      if (!dead) {
        const sens = 0.00215 * input.sensitivity * (1 - adsT * 0.42);
        yaw -= dx * sens;
        pitch -= dy * sens;
        pitch = THREE.MathUtils.clamp(pitch, -1.45, 1.42);
      }
    }

    if (dead) {
      deadT = Math.min(1, deadT + dt * 1.6);
      const e = deadT * deadT * (3 - 2 * deadT);
      eyeBase = THREE.MathUtils.lerp(1.68, 0.34, e);
      camera.position.set(pos.x, eyeBase, pos.z);
      camera.rotation.set(
        THREE.MathUtils.lerp(pitch, -0.55, e),
        yaw,
        THREE.MathUtils.lerp(0, 0.55, e)
      );
      return;
    }

    const wantADS = !!opts.ads;
    const wantSprint = !!opts.sprinting && !wantADS;
    const wantCrouch = !!opts.crouching;

    adsT += ((wantADS ? 1 : 0) - adsT) * Math.min(1, dt * 9);
    sprintT += ((wantSprint ? 1 : 0) - sprintT) * Math.min(1, dt * 6);
    crouchT += ((wantCrouch ? 1 : 0) - crouchT) * Math.min(1, dt * 8);

    // ---- movement input
    let mx = 0, mz = 0;
    if (input) {
      if (input.down('KeyW')) mz += 1;
      if (input.down('KeyS')) mz -= 1;
      if (input.down('KeyA')) mx -= 1;
      if (input.down('KeyD')) mx += 1;
    }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }

    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const wish = new THREE.Vector3().addScaledVector(forward, mz).addScaledVector(right, mx);

    let targetSpeed = 0;
    if (len > 0) {
      targetSpeed = wantSprint ? SPEED.sprint : wantCrouch ? SPEED.crouch : wantADS ? SPEED.ads : SPEED.walk;
      targetSpeed *= 1 - crouchT * 0.25;
    }
    const accel = grounded ? (len > 0 ? 26 : 18) : 5;
    const targetVel = wish.multiplyScalar(targetSpeed);
    vel.x += (targetVel.x - vel.x) * Math.min(1, accel * dt);
    vel.z += (targetVel.z - vel.z) * Math.min(1, accel * dt);
    if (!len) {
      const f = Math.min(1, 10 * dt);
      vel.x *= 1 - f; vel.z *= 1 - f;
    }

    // ---- integrate with wall sliding
    const nx = pos.x + vel.x * dt;
    if (!collides(nx, pos.z)) pos.x = nx; else vel.x = 0;
    const nz = pos.z + vel.z * dt;
    if (!collides(pos.x, nz)) pos.z = nz; else vel.z = 0;
    pos.x = THREE.MathUtils.clamp(pos.x, bounds.x0, bounds.x1);
    pos.z = THREE.MathUtils.clamp(pos.z, bounds.z0, bounds.z1);

    // ---- jump / gravity
    if (opts.jump && grounded && !wantCrouch) {
      vy = 4.4; grounded = false;
    }
    if (!grounded) {
      vy -= 15.5 * dt;
      pos.y += vy * dt;
      if (pos.y <= 0) {
        pos.y = 0; grounded = true;
        vy = 0;
        shake = Math.min(1, shake + 0.22);
        if (audio) audio.footstep('concrete', 1.2);
      }
    }

    // ---- speed readout
    state.speed = Math.hypot(vel.x, vel.z) / SPEED.sprint;
    state.moving = len > 0 && state.speed > 0.08;
    state.sprinting = wantSprint && state.moving;
    state.crouching = wantCrouch;
    state.ads = wantADS;

    // ---- head bob & footsteps
    const speedAbs = Math.hypot(vel.x, vel.z);
    const bobRate = 8.2 + speedAbs * 0.85;
    bobT += dt * bobRate * (0.55 + speedAbs * 0.12);
    const targetBob = Math.min(1, speedAbs / SPEED.walk) * (wantSprint ? 1.55 : 1) * (1 - adsT * 0.55);
    bobAmp += (targetBob - bobAmp) * Math.min(1, dt * 6);

    stepAccum += speedAbs * dt;
    const stepDist = wantSprint ? 2.7 : 2.15;
    if (stepAccum > stepDist && grounded) {
      stepAccum = 0;
      if (audio) audio.footstep('concrete', 0.75 + (wantSprint ? 0.5 : 0));
    }

    const bobY = Math.sin(bobT * 2) * 0.032 * bobAmp;
    const bobX = Math.cos(bobT) * 0.028 * bobAmp;
    const breathe = Math.sin(performance.now() / 1000 * 1.1) * 0.006;

    // ---- recoil spring
    const K = 190, D = 17;
    recoilPitchVel += (-K * recoilPitch - D * recoilPitchVel) * dt;
    recoilPitch += recoilPitchVel * dt;
    recoilYawVel += (-K * recoilYaw - D * recoilYawVel) * dt;
    recoilYaw += recoilYawVel * dt;

    // ---- camera
    const standEye = THREE.MathUtils.lerp(1.68, 1.05, crouchT);
    eyeBase += (standEye - eyeBase) * Math.min(1, dt * 12);
    const eye = eyeBase + bobY * 0.55 + breathe + pos.y;

    // shake
    shake = Math.max(0, shake - dt * 1.6);
    const sh = shake * shake;
    const t = performance.now() / 1000;
    const shX = Math.sin(t * 47.3) * 0.014 * sh;
    const shY = Math.cos(t * 39.1) * 0.014 * sh;
    const shR = Math.sin(t * 31.7) * 0.012 * sh;

    // strafe roll
    const localStrafe = vel.dot(right) / SPEED.walk;
    const roll = -localStrafe * 0.018 - shR;

    camera.position.set(pos.x + bobX * 0.5 + shX, eye, pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      pitch + recoilPitch + bobY * 0.35 + shY,
      yaw + recoilYaw + bobX * 0.25,
      roll
    );

    // ---- fov
    const baseFov = 78;
    const fov = THREE.MathUtils.lerp(baseFov + sprintT * 5.5, 50, adsT);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
  }

  return {
    pos, vel, state, update,
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get adsAmount() { return adsT; },
    get sprintAmount() { return sprintT; },
    get eyeHeight() { return eyeBase; },
    get grounded() { return grounded; },
    get dead() { return dead; },
    get speedAbs() { return Math.hypot(vel.x, vel.z); },
    setPosition(x, y, z) { pos.set(x, y, z); },
    setLook(y, p) { yaw = y; pitch = p; },
    kick(pitchKick, yawKick) {
      recoilPitchVel += pitchKick;
      recoilYawVel += yawKick;
    },
    addShake(v) { shake = Math.min(1.2, shake + v); },
    damageFeedback() { lastDamage = 0; },
    die() {
      dead = true; deadT = 0;
      vel.set(0, 0, 0);
    },
    revive(x, z) {
      dead = false; deadT = 0;
      pos.set(x, 0, z); vel.set(0, 0, 0);
      eyeBase = 1.68; pitch = 0; yaw = 0;
      recoilPitch = recoilYaw = 0; recoilPitchVel = recoilYawVel = 0;
      camera.fov = 78; camera.updateProjectionMatrix();
    },
    get headingDeg() {
      let deg = (-yaw * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      return deg;
    },
  };
}
