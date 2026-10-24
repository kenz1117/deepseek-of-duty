import * as THREE from 'three';

/* =========================================================================
   First-person controller: pointer-lock mouse look, acceleration based
   movement, wall sliding, sprint / crouch / jump, head bob, ADS zoom,
   recoil springs and trauma-based camera shake.
   ========================================================================= */

export function createController(camera, colliders, bounds, audio, groundProvider = null) {
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
  let pushX = 0, pushZ = 0;      // knife-lunge impulse (see update)
  let shake = 0;
  let groundFn = typeof groundProvider === 'function' ? groundProvider : null;
  let adsSensitivity = 0.58, invertY = false, baseFovSetting = 78, reduceMotion = false, speedMult = 1;
  let dead = false;
  let deadT = 0;
  let lastDamage = 0;
  const SPEED = { walk: 4.3, sprint: 7.0, crouch: 2.2, ads: 2.9 };
  const radius = 0.36;
  // speed: normalised 0..1 (relative to sprint speed) — used by the viewmodel.
  // speedMs: the real velocity in m/s — the AI side reasons in metres per
  // second (hearing radius, hit falloff, "is the player still?"), so it must
  // never read the normalised value.
  const state = { speed: 0, speedMs: 0, moving: false, sprinting: false, crouching: false, ads: false };
  // per-frame basis vectors, hoisted: fresh Vector3s here cost ~180 allocs/sec
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();

  function collides(x, z, y = pos.y) {
    for (const c of colliders) {
      // 2D footprint + a height cap: standing on a deck ignores the walls below
      if (c.top != null && c.top <= y + 0.2) continue;
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
        const sens = 0.00215 * input.sensitivity * (1 - adsT * (1 - adsSensitivity));
        yaw -= dx * sens;
        pitch += (invertY ? dy : -dy) * sens;
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

    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    wish.set(0, 0, 0).addScaledVector(forward, mz).addScaledVector(right, mx);

    let targetSpeed = 0;
    if (len > 0) {
      targetSpeed = wantSprint ? SPEED.sprint : wantCrouch ? SPEED.crouch : wantADS ? SPEED.ads : SPEED.walk;
      targetSpeed *= (1 - crouchT * 0.25) * speedMult;
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

    /* ---- impulse (the knife lunge)
       A knife swing has to close the last half metre, and the normal
       velocity channel damps toward the walk speed within a frame or two —
       so the lunge needs its own decaying impulse, applied after the walk
       integration and clipped by the same collision test. */
    if (pushX !== 0 || pushZ !== 0) {
      const px2 = pos.x + pushX * dt;
      if (!collides(px2, pos.z)) pos.x = px2; else pushX = 0;
      const pz2 = pos.z + pushZ * dt;
      if (!collides(pos.x, pz2)) pos.z = pz2; else pushZ = 0;
      const decay = Math.exp(-7.5 * dt);
      pushX *= decay; pushZ *= decay;
      if (Math.abs(pushX) < 0.02) pushX = 0;
      if (Math.abs(pushZ) < 0.02) pushZ = 0;
    }

    // ---- jump / gravity
    const gy = groundFn ? groundFn(pos.x, pos.z, pos.y) : 0;
    if (opts.jump && grounded && !wantCrouch) {
      vy = 4.4; grounded = false;
    }
    if (grounded) {
      if (gy > pos.y + 0.6) {
        // ledge/step too high: do not teleport up (a collider should block it)
      } else if (gy < pos.y - 0.55) {
        grounded = false; vy = 0;
      } else {
        pos.y = gy;
      }
    }
    if (!grounded) {
      vy -= 15.5 * dt;
      pos.y += vy * dt;
      const closeToFloor = pos.y + 0.7 >= gy;
      if (vy <= 0 && pos.y <= gy && closeToFloor) {
        pos.y = gy; grounded = true;
        vy = 0;
        shake = Math.min(1, shake + 0.22);
        if (audio) audio.footstep('concrete', 1.2);
      } else if (pos.y <= 0) {
        // fallback base ground (also protects under-roof jumps)
        pos.y = 0; grounded = true; vy = 0;
      }
    }

    // ---- speed readout
    state.speed = Math.hypot(vel.x, vel.z) / SPEED.sprint;
    state.speedMs = Math.hypot(vel.x, vel.z);
    state.moving = len > 0 && state.speed > 0.08;
    state.sprinting = wantSprint && state.moving;
    state.crouching = wantCrouch;
    state.ads = wantADS;

    // ---- head bob & footsteps
    const speedAbs = Math.hypot(vel.x, vel.z);
    const bobRate = 8.2 + speedAbs * 0.85;
    bobT += dt * bobRate * (0.55 + speedAbs * 0.12);
    const targetBob = Math.min(1, speedAbs / SPEED.walk) * (wantSprint ? 1.55 : 1) * (1 - adsT * 0.55) * (reduceMotion ? 0.22 : 1);
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
    // Impulse-driven, but capped: a long spray must never walk the camera off
    // the target, otherwise the crosshair stops meaning anything.
    const K = 190, D = 17;
    recoilPitchVel += (-K * recoilPitch - D * recoilPitchVel) * dt;
    recoilPitch += recoilPitchVel * dt;
    recoilYawVel += (-K * recoilYaw - D * recoilYawVel) * dt;
    recoilYaw += recoilYawVel * dt;
    if (recoilPitch > 0.0115) { recoilPitch = 0.0115; if (recoilPitchVel > 0) recoilPitchVel = 0; }
    if (recoilPitch < -0.014) { recoilPitch = -0.014; if (recoilPitchVel < 0) recoilPitchVel = 0; }
    if (recoilYaw > 0.010) { recoilYaw = 0.010; if (recoilYawVel > 0) recoilYawVel = 0; }
    if (recoilYaw < -0.010) { recoilYaw = -0.010; if (recoilYawVel < 0) recoilYawVel = 0; }

    // ---- camera
    const standEye = THREE.MathUtils.lerp(1.68, 1.05, crouchT);
    eyeBase += (standEye - eyeBase) * Math.min(1, dt * 12);
    const eye = eyeBase + bobY * 0.55 + breathe + pos.y;

    // shake
    shake = Math.max(0, shake - dt * 1.6);
    const sh = shake * shake * (reduceMotion ? 0.35 : 1);
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
    const fov = THREE.MathUtils.lerp(baseFovSetting + sprintT * 5.5, baseFovSetting * 0.64, adsT);
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
    setGroundProvider(fn) { groundFn = typeof fn === 'function' ? fn : null; },
    /** directional impulse in m/s (the knife lunge). Decays on its own. */
    push(x, z, speed) {
      const l = Math.hypot(x, z);
      if (l < 1e-4) return;
      pushX += (x / l) * speed;
      pushZ += (z / l) * speed;
    },
    set adsSensitivity(v) { adsSensitivity = THREE.MathUtils.clamp(v, 0.2, 1); },
    get adsSensitivity() { return adsSensitivity; },
    set invertY(v) { invertY = !!v; },
    get invertY() { return invertY; },
    set baseFov(v) { baseFovSetting = THREE.MathUtils.clamp(v, 60, 120); },
    get baseFov() { return baseFovSetting; },
    set reduceMotion(v) { reduceMotion = !!v; },
    get reduceMotion() { return reduceMotion; },
    set speedMult(v) { speedMult = Math.max(0.5, v); },
    get speedMult() { return speedMult; },
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
      camera.fov = baseFovSetting; camera.updateProjectionMatrix();
    },
    get headingDeg() {
      let deg = (-yaw * 180 / Math.PI) % 360;
      if (deg < 0) deg += 360;
      return deg;
    },
  };
}
