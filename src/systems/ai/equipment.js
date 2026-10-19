/* =========================================================================
 * ENEMY TACTICAL EQUIPMENT — frag / flash / smoke, thrown by the squad.
 *
 * What "best practice" means here (and what the old build was missing):
 *
 *   1. TELEGRAPH  — the thrower shouts, the HUD shows a type icon + a direction
 *      arrow, and the grenade blinks/ticks. You always get a beat to react.
 *   2. CAUSE      — utilities are answers to a problem, not a timer:
 *        frag  = you have been holding still behind cover for ~3 s
 *        flash = you are camping an angle the squad needs to push
 *        smoke = two or more soldiers have line of sight and want to cross
 *   3. DISCIPLINE — tier-gated per-type cooldowns, at most one lethal and one
 *      tactical in the air, and no throw that would land on a friendly.
 *   4. FAIRNESS   — frag damage falls off over 7.5 m and is reduced heavily
 *      when world geometry blocks it; flash intensity depends on distance and
 *      on whether you are looking at it; smoke cuts AI sight lines for both
 *      sides (perception), not just for you.
 *
 * The player already has frags on G; this module is the hostile side.
 * ========================================================================= */

import * as THREE from 'three';

const GRAVITY = 16;
const MAX_ACTIVE_LETHAL = 1;
const MAX_ACTIVE_TACTICAL = 1;

// cooldown ranges in seconds; D1 (training) throws nothing
const TIER_UTILITY = {
  D2: { frag: [18, 26] },
  D3: { frag: [14, 20], flash: [24, 34] },
  D4: { frag: [10, 15], flash: [18, 26], smoke: [26, 36] },
  D5: { frag: [8, 12], flash: [13, 20], smoke: [18, 28] },
};

const WARN_LABEL = { frag: '手雷', flash: '闪光', smoke: '烟幕' };

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _ray = new THREE.Raycaster();

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function createEnemyEquipment(opts) {
  const {
    scene, level, fx, audio, hud, camera, smokeTexture, glowTexture,
    damagePlayer, onFlash, onSmoke, onBark, onNoise, onShake,
  } = opts;

  const geo = new THREE.SphereGeometry(0.075, 10, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a4032, roughness: 0.72, metalness: 0.35 });
  const glowMat = new THREE.SpriteMaterial({
    map: glowTexture, color: 0xff3b20, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });

  const cds = { frag: 0, flash: 0, smoke: 0 };
  const projectiles = [];
  const clouds = [];
  const stats = { frag: 0, flash: 0, smoke: 0, clouds: 0, denied: 0 };
  let campT = 0;
  let beepT = 0;
  let warnT = 0;
  let booted = false;

  function reset() {
    for (const p of projectiles) removeProjectile(p);
    projectiles.length = 0;
    for (const c of clouds) removeCloud(c);
    clouds.length = 0;
    cds.frag = 6 + Math.random() * 4;   // first utility arrives after the fight starts
    cds.flash = 9 + Math.random() * 6;
    cds.smoke = 12 + Math.random() * 8;
    campT = 0;
    beepT = 0;
    warnT = 0;
    if (hud && hud.setGrenadeWarning) hud.setGrenadeWarning(0, false);
  }

  function removeProjectile(p) {
    if (!p) return;
    if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    if (p.glow) {
      if (p.glow.parent) p.glow.parent.remove(p.glow);
      p.glow.material.dispose();
    }
  }

  function removeCloud(c) {
    if (!c) return;
    if (c.group.parent) c.group.parent.remove(c.group);
    c.mat.dispose();
    stats.clouds = Math.max(0, stats.clouds - 1);
  }

  function activeCount(type) {
    let n = 0;
    for (const p of projectiles) if (p.type === type) n++;
    return n;
  }
  function activeTactical() { return activeCount('flash') + activeCount('smoke'); }
  function activeLethal() { return activeCount('frag'); }

  function findThrower(live, px, pz, type) {
    let best = null, bestScore = -Infinity;
    for (const e of live) {
      if (e.baseY > 1.2) continue;                    // platform campers do not lob
      if ((e.awareness || 0) < 0.62) continue;
      const ep = e.root.position;
      const d = Math.hypot(ep.x - px, ep.z - pz);
      if (d < 7 || d > 30) continue;
      if (!e.canSee && (e.lastSeenT || 99) > 3) continue;
      // a smoke can be thrown from further back than a frag
      if (type === 'smoke' && d > 34) continue;
      let score = 12 - Math.abs(d - 16) * 0.8;
      if (e.canSee) score += 4;
      if (e.aiRole === 'assault') score += 2;
      if (e.aiRole === 'suppress') score += 1.5;
      if (e.state === 'cover') score -= 3;            // busy hiding
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  function friendlyNear(live, x, z, r) {
    for (const e of live) {
      const ep = e.root.position;
      if (Math.hypot(ep.x - x, ep.z - z) < r) return true;
    }
    return false;
  }

  function chooseType(cfg, live, losCount, px, pz) {
    if (cfg.frag && cds.frag <= 0 && activeLethal() < MAX_ACTIVE_LETHAL && campT > 2.8) return 'frag';
    if (cfg.flash && cds.flash <= 0 && activeTactical() < MAX_ACTIVE_TACTICAL && campT > 4.2) return 'flash';
    if (cfg.smoke && cds.smoke <= 0 && activeTactical() < MAX_ACTIVE_TACTICAL
        && campT > 3.6 && losCount >= 2 && live.length >= 2) return 'smoke';
    return null;
  }

  function targetFor(type, live, playerPos, thrower) {
    let x = playerPos.x, z = playerPos.z;
    let err = 1.4;
    if (type === 'frag') err = 2.2;
    else if (type === 'flash') err = 1.1;
    else if (type === 'smoke') {
      // drop the screen between the squad and the player, slightly their side
      let cx = 0, cz = 0, n = 0;
      for (const e of live) { cx += e.root.position.x; cz += e.root.position.z; n++; }
      if (n) { cx /= n; cz /= n; }
      x = playerPos.x + (cx - playerPos.x) * 0.55;
      z = playerPos.z + (cz - playerPos.z) * 0.55;
      err = 1.6;
    }
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * err;
    return {
      x: x + Math.cos(ang) * r,
      y: 0.15,
      z: z + Math.sin(ang) * r,
    };
  }

  function throwUtility(type, e, target, live) {
    const tp = e.root.position;
    const from = {
      x: tp.x + Math.sin(e.root.rotation.y) * -0.35,
      y: tp.y + 1.42,
      z: tp.z + Math.cos(e.root.rotation.y) * -0.35,
    };
    const flight = type === 'smoke' ? 1.35 : 1.15;
    const vx = (target.x - from.x) / flight;
    const vz = (target.z - from.z) / flight;
    const vy = (target.y - from.y + 0.5 * GRAVITY * flight * flight) / flight;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.position.set(from.x, from.y, from.z);
    scene.add(mesh);
    const glow = new THREE.Sprite(glowMat.clone());
    glow.scale.setScalar(0.16);
    glow.position.set(0, 0.05, 0);
    mesh.add(glow);

    const fuse = type === 'flash' ? 1.65 : type === 'smoke' ? 1.8 : 2.55;
    const p = {
      type, mesh, glow, fuse, t: 0,
      vel: new THREE.Vector3(vx, vy, vz),
      owner: e,
    };
    projectiles.push(p);
    stats[type]++;

    const cfg = TIER_UTILITY[e.diff && e.diff.id];
    if (cfg && cfg[type]) {
      cds[type] = rand(cfg[type][0], cfg[type][1]);
    } else {
      cds[type] = 20;
    }
    if (onBark) onBark(type, tp);
    // a thrown grenade is also a noise cue for the rest of the squad
    if (onNoise) onNoise(tp, 22, 0.5);
    void live;
  }

  function tryThrow(dt, ctx) {
    const tier = ctx.tier;
    const cfg = tier && TIER_UTILITY[tier.id];
    if (!cfg) return;
    const live = (ctx.enemies || []).filter((e) => e.alive && e.root.visible);
    if (!live.length) return;
    const pp = ctx.playerPos;
    const losCount = live.reduce((n, e) => n + (e.canSee ? 1 : 0), 0);
    const type = chooseType(cfg, live, losCount, pp.x, pp.z);
    if (!type) return;

    // player has to be doing something the utility answers
    if (type !== 'smoke' && losCount === 0 && campT < 3.5) return;

    const thrower = findThrower(live, pp.x, pp.z, type);
    if (!thrower) return;
    const target = targetFor(type, live, pp, thrower);
    if ((type === 'frag' || type === 'flash')
        && friendlyNear(live, target.x, target.z, type === 'frag' ? 5.0 : 3.2)) {
      stats.denied++;
      return;
    }
    throwUtility(type, thrower, target, live);
  }

  function pointSegment(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-6 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  }

  function coverMultiplier(pos) {
    if (!level || !level.bulletTargets) return 1;
    const cam = camera.position;
    _v.set(cam.x - pos.x, cam.y - pos.y, cam.z - pos.z);
    const dist = _v.length();
    if (dist < 0.4) return 1;
    _v.divideScalar(dist);
    _ray.set(new THREE.Vector3(pos.x, pos.y + 0.15, pos.z), _v);
    _ray.far = Math.max(0.2, dist - 0.45);
    _ray.firstHitOnly = true;
    const hits = _ray.intersectObjects(level.bulletTargets, false);
    return hits.length ? 0.32 : 1;
  }

  function panFor(pos) {
    if (!camera) return 0;
    const dx = pos.x - camera.position.x, dz = pos.z - camera.position.z;
    const len = Math.hypot(dx, dz) || 1;
    _fwd.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return clamp((dx / len) * _fwd.x + (dz / len) * _fwd.z, -1, 1);
  }

  function explode(p) {
    const pos = p.mesh.position.clone();
    const pan = panFor(pos);
    const cam = camera.position;
    const dist = pos.distanceTo(cam);

    if (p.type === 'frag') {
      fx.explosion(pos, 1.0);
      audio.explosion(pan, dist);
      if (onShake) onShake(clamp(1.1 - dist / 18, 0.15, 0.85));
      if (onNoise) onNoise(pos, 42, 1);
      if (dist < 7.5) {
        const falloff = Math.pow(1 - dist / 7.5, 1.25);
        const dmg = 95 * falloff * coverMultiplier(pos);
        if (dmg > 1) damagePlayer(dmg, pos);
      }
    } else if (p.type === 'flash') {
      audio.flashbang(pan, dist);
      if (onNoise) onNoise(pos, 26, 0.7);
      if (dist < 16) {
        _v.set(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z).normalize();
        _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const facing = _fwd.dot(_v);                 // 1 = staring at it
        const look = 0.22 + 0.78 * Math.max(0, facing);
        const intensity = clamp((1 - dist / 16) * look, 0, 1);
        if (intensity > 0.06) {
          if (onFlash) onFlash(intensity, pos);
          if (onShake) onShake(0.45 * intensity);
        }
      }
    } else if (p.type === 'smoke') {
      audio.smokePop(pan, dist);
      spawnCloud(pos.x, pos.z);
      if (onSmoke) onSmoke(pos.x, pos.z, 4.2, 13);
      if (onNoise) onNoise(pos, 18, 0.5);
    }
  }

  function spawnCloud(x, z) {
    const cmat = new THREE.SpriteMaterial({
      map: smokeTexture, color: 0xa8a69c, transparent: true, opacity: 0,
      depthWrite: false, fog: true,
    });
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const puffs = [];
    for (let i = 0; i < 22; i++) {
      const s = new THREE.Sprite(cmat);
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * 2.7;
      s.position.set(Math.cos(ang) * rad, 0.5 + Math.random() * 2.9, Math.sin(ang) * rad);
      const sc = rand(2.1, 4.6);
      s.scale.set(sc, sc, 1);
      s.material.rotation = Math.random() * Math.PI;
      group.add(s);
      puffs.push({ s, phase: Math.random() * 6.28, rise: rand(0.04, 0.14), drift: rand(-0.1, 0.1) });
    }
    scene.add(group);
    const cloud = { group, mat: cmat, x, z, t: 0, life: 13.2, puffs };
    clouds.push(cloud);
    stats.clouds++;
  }

  function updateClouds(dt) {
    for (let i = clouds.length - 1; i >= 0; i--) {
      const c = clouds[i];
      c.t += dt;
      const fadeIn = Math.min(1, c.t / 0.85);
      const fadeOut = Math.min(1, Math.max(0, (c.life - c.t) / 2.4));
      c.mat.opacity = 0.42 * fadeIn * fadeOut;
      for (const p of c.puffs) {
        p.s.position.y += p.rise * dt;
        p.s.position.x += Math.sin(c.t * 0.5 + p.phase) * p.drift * dt * 2;
        p.s.material.rotation += dt * 0.05;
      }
      if (c.t >= c.life) {
        removeCloud(c);
        clouds.splice(i, 1);
      }
    }
  }

  function updateWarning(dt, playerPos) {
    let nearest = null, nd = Infinity;
    for (const p of projectiles) {
      if (p.type === 'smoke') continue;
      const d = p.mesh.position.distanceTo(playerPos);
      if (d < nd) { nd = d; nearest = p; }
    }
    if (!nearest) {
      if (warnT > 0) {
        warnT = 0;
        if (hud && hud.setGrenadeWarning) hud.setGrenadeWarning(0, false);
      }
      return;
    }
    warnT = 0.2;
    // screen-relative angle: 0 = ahead, +90° = right (CSS rotate is clockwise)
    const dx = nearest.mesh.position.x - camera.position.x;
    const dz = nearest.mesh.position.z - camera.position.z;
    const len = Math.hypot(dx, dz) || 1;
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const along = (dx / len) * _fwd.x + (dz / len) * _fwd.z;
    const across = (dx / len) * _right.x + (dz / len) * _right.z;
    const rel = Math.atan2(across, along);
    if (hud && hud.setGrenadeWarning) hud.setGrenadeWarning(rel, true, nearest.type);

    beepT -= dt;
    if (beepT <= 0) {
      const urgent = nearest.fuse < 0.85;
      beepT = urgent ? 0.22 : 0.48;
      audio.grenadeBeep(panFor(nearest.mesh.position), urgent);
    }
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.t += dt;
      p.fuse -= dt;
      p.vel.y -= GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 8;
      p.mesh.rotation.z += dt * 5;
      if (p.glow) p.glow.visible = Math.sin(p.t * 26) > -0.15;
      if (p.mesh.position.y < 0.08) {
        p.mesh.position.y = 0.08;
        if (p.vel.y < -1.2) {
          audio.impact('concrete', panFor(p.mesh.position), 0.45);
        }
        p.vel.y *= -0.32;
        p.vel.x *= 0.66;
        p.vel.z *= 0.66;
      }
      if (p.fuse <= 0) {
        explode(p);
        removeProjectile(p);
        projectiles.splice(i, 1);
      }
    }
  }

  function update(dt, ctx) {
    if (!ctx || !ctx.playerPos) return;
    if (ctx.playerAlive === false) {
      if (warnT > 0) { warnT = 0; if (hud && hud.setGrenadeWarning) hud.setGrenadeWarning(0, false); }
      return;
    }
    if (!booted) { reset(); booted = true; }

    cds.frag = Math.max(0, cds.frag - dt);
    cds.flash = Math.max(0, cds.flash - dt);
    cds.smoke = Math.max(0, cds.smoke - dt);

    const speed = ctx.playerSpeed || 0;
    if (speed < 1.15) campT += dt;
    else campT = Math.max(0, campT - dt * 2.4);

    updateProjectiles(dt);
    updateClouds(dt);
    updateWarning(dt, ctx.playerPos);
    tryThrow(dt, ctx);
  }

  return {
    update, reset,
    stats() {
      return {
        ...stats,
        active: projectiles.length,
        campT: +campT.toFixed(1),
        clouds: clouds.length,
      };
    },
    get projectiles() { return projectiles; },
    get clouds() { return clouds; },
    debugWarn: () => WARN_LABEL,
  };
}
