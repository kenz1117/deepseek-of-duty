/* =========================================================================
 * PERCEPTION — one shared sense layer for every soldier.
 *
 * Replaces the old model (a binary "player visible?" raycast every ~0.2 s)
 * with a small awareness system:
 *
 *   • vision cone   — you are not instantly seen from behind; the cone widens
 *                     with awareness and difficulty, and snipers tunnel-vision
 *   • awareness     — 0..1 confidence, rises while you are visible / making
 *                     noise, decays when contact is lost
 *   • reaction      — a contact has to be "acquired" for a tier-dependent delay
 *                     before the first shot, instead of shooting on frame one
 *   • hearing       — every gunshot is a short-lived noise event; nearby
 *                     soldiers investigate the position instead of omniscient
 *                     pathing to you
 *   • suppression   — bullets cracking past reduce accuracy and push a soldier
 *                     toward cover / back-off
 *
 * All of it is plain state on the Enemy instance, so the debug API and the
 * probe tool can read it without reaching into module internals.
 * ========================================================================= */

import { behaviorFor, archMod, reactionDelay } from './tuning.js';

export class Perception {
  constructor() {
    /** short-lived noise events: gunshots, explosions, sprinting boots */
    this.noises = [];
    /** lingering smoke clouds: { x, z, r, t } — these cut line of sight */
    this.smokes = [];
    /**
     * bullet-impact crumbs: where rounds are hitting walls, ground and props.
     * 3D position + normal lets soldiers reason about "fire came from THAT
     * direction" instead of just "fire came from somewhere". Lifetime is
     * short (~6 s) so we keep only the most recent spatter; the list is
     * bounded to keep the per-tick scan cheap.
     */
    this.impacts = [];
    /**
     * recent soldier deaths, broadcast to neighbours so the squad reacts.
     * Kept small; each entry is consumed by the awareness sweep and then
     * fades out on its own clock.
     */
    this.casualties = [];
    this.losChecks = 0;
    this.losHits = 0;
    this.time = 0;
  }

  /** Register a smoke cloud. It blocks soldier vision until it expires. */
  addSmoke(x, z, r = 4.2, duration = 13) {
    this.smokes.push({ x, z, r, t: duration });
  }

  /** A loud event at (x,z). radius in metres, strength 0..1. */
  noise(x, z, radius = 55, strength = 1, life = 0.55) {
    if (this.noises.length > 24) this.noises.shift();
    this.noises.push({ x, z, r: radius, s: strength, life });
  }

  /**
   * Register a bullet-impact crumb. `nx,nz` is the impact normal in the XZ
   * plane (unit vector pointing AWAY from the surface, i.e. back toward the
   * shooter). Soldiers read this and lift awareness even when they did not
   * see the muzzle flash — a sniper cracking a wall 0.4 m behind them is
   * unmistakable.
   */
  impact(x, z, nx, nz, life = 6) {
    if (this.impacts.length > 28) this.impacts.shift();
    this.impacts.push({ x, z, nx, nz, life, max: life });
  }

  /**
   * Broadcast a soldier death to neighbours. They hear/see their friend drop
   * and that bumps awareness faster than a generic noise event.
   */
  casualty(x, z, radius = 22) {
    if (this.casualties.length > 16) this.casualties.shift();
    this.casualties.push({ x, z, r: radius, life: 2.4, max: 2.4 });
  }

  /** Drop transient stimuli between runs (noise + smoke + impacts + deaths). */
  clear() {
    this.noises.length = 0;
    this.smokes.length = 0;
    this.impacts.length = 0;
    this.casualties.length = 0;
  }

  update(dt) {
    this.time += dt;
    for (let i = this.noises.length - 1; i >= 0; i--) {
      this.noises[i].life -= dt;
      if (this.noises[i].life <= 0) this.noises.splice(i, 1);
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      this.smokes[i].t -= dt;
      if (this.smokes[i].t <= 0) this.smokes.splice(i, 1);
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      this.impacts[i].life -= dt;
      if (this.impacts[i].life <= 0) this.impacts.splice(i, 1);
    }
    for (let i = this.casualties.length - 1; i >= 0; i--) {
      this.casualties[i].life -= dt;
      if (this.casualties[i].life <= 0) this.casualties.splice(i, 1);
    }
  }

  /** True when the segment passes through (or ends inside) a smoke cloud. */
  smokeBlocks(x0, z0, x1, z1) {
    for (let i = 0; i < this.smokes.length; i++) {
      const s = this.smokes[i];
      const dx = x1 - x0, dz = z1 - z0;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-6 ? ((s.x - x0) * dx + (s.z - z0) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x0 + dx * t, pz = z0 + dz * t;
      if (Math.hypot(s.x - px, s.z - pz) < s.r) return true;
    }
    return false;
  }

  /**
   * Run one perception tick for `e`. Cheap unless the LOS timer fires (and the
   * cone/range gate rejects most of those before the raycast).
   */
  sense(e, ctx, dt) {
    const player = ctx.playerPos;
    const P = e.root.position;
    const B = behaviorFor(e.diff);
    const AM = archMod(e.archetype);

    const dx = player.x - P.x;
    const dz = player.z - P.z;
    const dist = Math.hypot(dx, dz);
    const range = Math.min(B.sight * AM.sight, (e.def.engageRange || 70) * 1.15);

    // ---------------- vision cone + range gate ----------------
    let inCone = false;
    if (ctx.playerAlive && dist < range) {
      if (dist < 4.2 || e.awareness > 0.92 || e.isBoss) inCone = true;
      else {
        const yaw = e.root.rotation.y;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const cos = (dx * fx + dz * fz) / (dist || 1);
        // head look adds a little tolerance to the cone
        const half = B.fov * AM.fov + Math.abs(e.headYawS || 0) * 0.35;
        inCone = cos > Math.cos(half);
      }
    }

    e.losTimer -= dt;
    let visible = false;
    if (inCone && e.losTimer <= 0) {
      e.losTimer = (e.archetype === 'sniper' ? 0.26 : 0.13) + Math.random() * 0.1;
      visible = e.canSeeTarget(player, dist);
      this.losChecks++;
      if (visible) this.losHits++;
      e.losCache = visible;
    } else if (inCone) {
      visible = !!e.losCache;
    } else {
      e.losCache = false;
    }

    // smoke is a hard visual blocker for AI; the player still sees sprites
    if (visible && this.smokes.length && this.smokeBlocks(P.x, P.z, player.x, player.z)) {
      visible = false;
      e.losCache = false;
    }

    e.canSee = visible;

    // ---------------- hearing ----------------
    let heardX = 0, heardZ = 0, heard = false;
    if (!visible) {
      for (const n of this.noises) {
        const nd = Math.hypot(n.x - P.x, n.z - P.z);
        if (nd > n.r) continue;
        // acoustic occlusion: a building between us and the noise cuts
        // perceived loudness sharply. nav.lineWalkable returning true
        // means the segment is open ground, which usually means it is also
        // acoustically open. A blocked line means the noise has to pass
        // through at least one wall.
        let blocked = false;
        if (ctx.nav && ctx.nav.lineWalkable) {
          blocked = !ctx.nav.lineWalkable(n.x, n.z, P.x, P.z);
        }
        const baseK = (1 - nd / n.r) * n.s;
        const occK = blocked ? baseK * 0.28 : baseK;
        if (occK <= 0) continue;
        e.awareness = Math.min(0.92, e.awareness + occK * dt * 2.6);
        if (occK > 0.12) { heard = true; heardX = n.x; heardZ = n.z; }
      }
    }

    // ---------------- bullet-impact awareness ----------------
    // A round hitting the wall 1 m from a soldier is unambiguous: someone
    // is shooting from the opposite side of that wall. Lift awareness and
    // accumulate a rough bearing so the cover system can route the soldier
    // away from that lane instead of back toward it.
    let bumpDirX = 0, bumpDirZ = 0, bumpAny = false;
    for (let i = 0; i < this.impacts.length; i++) {
      const imp = this.impacts[i];
      const dx2 = imp.x - P.x, dz2 = imp.z - P.z;
      const d2 = Math.hypot(dx2, dz2);
      // only local crumbs register; far splatter is too ambiguous to act on
      if (d2 > 14) continue;
      const prox = (1 - d2 / 14);
      const freshness = imp.life / imp.max;
      const k = prox * freshness;
      // dot product tells us if the impact normal points back toward the
      // shooter (fromShooter ≈ 1) or away (-1). Hits on the cover's
      // back-face are twice as informative as hits on the front.
      const dot = (dx2 * imp.nx + dz2 * imp.nz) / (d2 || 1);
      const fromShooter = Math.max(0, -dot);
      const lift = k * (0.18 + 0.22 * fromShooter);
      e.awareness = Math.min(1, e.awareness + lift * dt * 6);
      if (fromShooter > 0.2 && d2 > 0.5) {
        bumpDirX += imp.nx * fromShooter * prox;
        bumpDirZ += imp.nz * fromShooter * prox;
        bumpAny = true;
      }
    }
    if (bumpAny) {
      e.fireBearingX = bumpDirX;
      e.fireBearingZ = bumpDirZ;
      e.fireBearingT = 0.8;
    } else if ((e.fireBearingT || 0) > 0) {
      e.fireBearingT = Math.max(0, e.fireBearingT - dt);
      if (e.fireBearingT === 0) { e.fireBearingX = 0; e.fireBearingZ = 0; }
    }

    // ---------------- squad-casualty awareness ----------------
    // Hearing a friend die nearby is louder and more alarming than a
    // generic noise: the soldier is faster to engage but also more
    // cautious about the next doorway.
    for (let i = 0; i < this.casualties.length; i++) {
      const c = this.casualties[i];
      const cd = Math.hypot(c.x - P.x, c.z - P.z);
      if (cd > c.r) continue;
      const prox = (1 - cd / c.r);
      const freshness = c.life / c.max;
      const lift = prox * freshness * 0.55;
      e.awareness = Math.min(1, e.awareness + lift * dt * 4);
      e.comradeLostT = 3.5;
      if (prox > 0.5 && freshness > 0.4 && (!e.investigate || e.lastSeenT > 1.5)) {
        e.investigate = { x: c.x, z: c.z };
        e.investigateT = 0;
      }
    }
    if ((e.comradeLostT || 0) > 0) e.comradeLostT = Math.max(0, e.comradeLostT - dt);

    // ---------------- awareness ----------------
    if (visible) {
      const playerMove = Math.min(1, (ctx.playerSpeed || 0) / 5);
      const climbing = e.baseY > 0.5 ? 0.85 : 1;
      const gain = B.gain * (0.75 + 0.55 * playerMove) * climbing;
      e.awareness = Math.min(1, e.awareness + gain * dt);
      e.lastSeenT = 0;
      if (e.lastSeen) { e.lastSeen.x = player.x; e.lastSeen.z = player.z; }
      else e.lastSeen = { x: player.x, z: player.z };
      e.investigate = null;
    } else {
      e.lastSeenT += dt;
      const decay = B.decay * (e.awareness < 0.4 ? 1.35 : 0.75);
      e.awareness = Math.max(0, e.awareness - decay * dt);
      if (heard && (!e.investigate || e.lastSeenT > 1.5)) {
        e.investigate = { x: heardX, z: heardZ };
        e.investigateT = 0;
      }
    }

    // ---------------- contact / reaction ----------------
    if (e.isBoss) {
      e.awareness = 1;
      e.acquireT = Math.max(e.acquireT, 10);
      e.contact = true;
    } else if (visible && e.awareness >= 0.7) {
      if (!e.contact) {
        e.contact = true;
        e.acquireT = 0;
        e.reactionDelay = reactionDelay(B, e.archetype);
        // the squad announces first contact (cooldown-gated by the bark system)
        if (ctx.ai && ctx.ai.barks) ctx.ai.barks.say('contact', e.root.position);
      }
      e.acquireT += dt;
    } else if (e.awareness < 0.5) {
      e.contact = false;
      e.acquireT = Math.max(0, e.acquireT - dt * 2.5);
    }

    // ---------------- suppression decay ----------------
    e.suppression = Math.max(0, (e.suppression || 0) - dt * (e.isBoss ? 0.55 : 0.75));

    return visible;
  }

  /**
   * Apply suppression to an already-collected live enemy list. Kept as a
   * separate pass in main.js so the shooter (player) does not have to import
   * enemy internals.
   */
  applySuppression(enemies, x, z, radius = 2.6, amount = 0.5) {
    for (const e of enemies) {
      if (!e.alive || !e.root.visible) continue;
      const p = e.root.position;
      if (Math.abs(p.y - 0) > 2.5) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius) continue;
      const k = 1 - d / radius;
      e.suppression = Math.min(1, (e.suppression || 0) + amount * k);
      // a round snapping past is information too
      e.awareness = Math.min(1, (e.awareness || 0) + 0.18 * k);
      e.investigate = e.investigate || { x, z };
    }
  }

  stats() {
    return {
      losChecks: this.losChecks, losHits: this.losHits,
      noises: this.noises.length, smokes: this.smokes.length,
      impacts: this.impacts.length, casualties: this.casualties.length,
    };
  }
}
