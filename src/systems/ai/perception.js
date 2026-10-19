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

  /** Drop transient stimuli between runs (noise + smoke). */
  clear() {
    this.noises.length = 0;
    this.smokes.length = 0;
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
      visible = e.canSeePlayer(player, dist);
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
        const k = (1 - nd / n.r) * n.s;
        if (k <= 0) continue;
        e.awareness = Math.min(0.92, e.awareness + k * dt * 2.6);
        if (k > 0.12) { heard = true; heardX = n.x; heardZ = n.z; }
      }
    }

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
    };
  }
}
