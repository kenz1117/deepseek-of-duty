/* =========================================================================
 * SQUAD DIRECTOR — the layer that makes several soldiers act like a squad.
 *
 * Before this, every soldier independently chose to flank every few seconds.
 * Ten enemies could all swing left, all take the same cover point, or all sit
 * still — the sum was noise, not tactics. The director hands out a small,
 * readable set of jobs on a 0.3 s tick:
 *
 *   assault  — close the distance and pressure you
 *   flank    — swing wide on an assigned side, then engage
 *   suppress — hold a firing lane at range
 *   hold     — work toward mid range and fire when they see you
 *
 * Tier caps how many of each can exist at once (D1 barely coordinates, D5 runs
 * two flanks plus a base of fire). It also owns cover reservations so two
 * soldiers never dive behind the same crate, and it feeds *stale* position
 * intel to soldiers who have lost you, so they search your last area instead of
 * tracking you through walls.
 * ========================================================================= */

import { behaviorFor } from './tuning.js';
import { createCoverSystem } from './cover.js';

const TICK = 0.3;

function budgets(B, n) {
  if (n <= 0) return { assault: 0, flank: 0, suppress: 0, hold: 0 };
  const assault = n <= 2 ? n : Math.min(n, Math.max(1, B.assault));
  const flank = Math.min(n - assault, B.flank);
  const suppress = Math.min(n - assault - flank, B.suppress);
  const hold = Math.max(0, n - assault - flank - suppress);
  return { assault, flank, suppress, hold };
}

export class AIDirector {
  constructor(nav, level) {
    this.nav = nav;
    this.level = level;
    this.cover = level ? createCoverSystem(level, nav) : null;
    this.coverReserve = new Map();     // "x,z" -> enemy
    this.coverPointByKey = new Map();  // "x,z" -> {x,z}
    this.acc = 0;
    this.flankSide = 1;
    this.stats = { reassigns: 0, intelHints: 0, coverClaims: 0, boss: 0 };
    this.lastRoles = { assault: 0, flank: 0, suppress: 0, hold: 0 };
  }

  tick(dt, enemies, playerPos, tier) {
    this.acc += dt;
    if (this.acc < TICK) return;
    const step = this.acc;
    this.acc = 0;
    const B = behaviorFor(tier);

    const live = [];
    for (const e of enemies) if (e.alive && e.root.visible) live.push(e);

    // reservations do not outlive their soldier
    for (const [k, e] of this.coverReserve) {
      if (!e.alive || e.root.visible === false) this.coverReserve.delete(k);
    }

    for (const e of live) {
      if (e.isBoss) {
        e.aiRole = 'assault';
        e.aiSide = 1;
        this.stats.boss = 1;
        continue;
      }
      if (e.roleT > 0) e.roleT -= step;
      else e.aiRole = null;
    }

    const ground = live.filter((e) => !e.isBoss && e.baseY <= 0.5);
    const n = ground.length;
    const want = budgets(B, n);
    const pool = [];

    const counts = { assault: 0, flank: 0, suppress: 0, hold: 0 };
    for (const e of ground) {
      if (e.aiRole && counts[e.aiRole] != null) {
        if (counts[e.aiRole] < want[e.aiRole]) counts[e.aiRole]++;
        else { e.aiRole = null; pool.push(e); }   // over budget: re-queue
      } else pool.push(e);
    }

    const distTo = (e) => Math.hypot(playerPos.x - e.root.position.x, playerPos.z - e.root.position.z);
    const take = (scoreFn) => {
      if (!pool.length) return null;
      let bi = -1, bs = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const s = scoreFn(pool[i]);
        if (s > bs) { bs = s; bi = i; }
      }
      return bi >= 0 ? pool.splice(bi, 1)[0] : null;
    };

    while (counts.assault < want.assault) {
      const e = take((x) => -distTo(x) - 30 * (x.suppression || 0));
      if (!e) break;
      e.aiRole = 'assault'; e.roleT = 4 + Math.random() * 4; counts.assault++;
    }
    while (counts.flank < want.flank) {
      const e = take((x) => (x.canSee ? -6 : 6) - Math.abs(distTo(x) - 24) * 0.2 + signSide(x, playerPos) * 0.3);
      if (!e) break;
      this.flankSide = -this.flankSide;
      e.aiRole = 'flank'; e.aiSide = this.flankSide; e.roleT = 5 + Math.random() * 4; counts.flank++;
    }
    while (counts.suppress < want.suppress) {
      const e = take((x) => (x.canSee ? 8 : 0) - Math.abs(distTo(x) - 22) * 0.25);
      if (!e) break;
      e.aiRole = 'suppress'; e.roleT = 5 + Math.random() * 4; counts.suppress++;
    }
    while (pool.length) {
      const e = pool.shift();
      e.aiRole = 'hold'; e.roleT = 5 + Math.random() * 5; counts.hold++;
    }

    // Opening intel: a fresh soldier is not a statue. He gets a rough contact
    // report immediately (a few metres of error) and starts working toward it,
    // instead of standing in the spawn yard until he happens to see you.
    for (const e of ground) {
      if (e.investigate || (e.awareness || 0) >= 0.2) continue;
      const ang = Math.random() * Math.PI * 2;
      const err = 3 + Math.random() * 7;
      let x = playerPos.x + Math.cos(ang) * err;
      let z = playerPos.z + Math.sin(ang) * err;
      if (this.nav && !this.nav.isWalkableAt(x, z, 0)) {
        const w = this.nav.closestWalkable(x, z);
        if (w) { x = w.x; z = w.z; }
      }
      e.investigate = { x, z };
      e.investigateT = 0;
    }

    // Stale intel: a soldier that lost you gets an approximate position a few
    // seconds later, not a live wallhack. This is what makes them search the
    // area you were last seen in instead of standing still.
    for (const e of ground) {
      if (e.canSee || e.awareness > 0.6) { e.intelT = 0; continue; }
      e.intelT = (e.intelT || 0) + step;
      if (!e.intelDue) e.intelDue = B.intel * (0.55 + Math.random() * 0.5);
      if (e.intelT < e.intelDue) continue;
      e.intelT = 0;
      e.intelDue = B.intel * (0.55 + Math.random() * 0.5);
      const ang = Math.random() * Math.PI * 2;
      const err = 3 + Math.random() * 7;
      let x = playerPos.x + Math.cos(ang) * err;
      let z = playerPos.z + Math.sin(ang) * err;
      if (this.nav && !this.nav.isWalkableAt(x, z, 0)) {
        const w = this.nav.closestWalkable(x, z);
        if (w) { x = w.x; z = w.z; }
      }
      e.investigate = { x, z };
      e.investigateT = 0;
      this.stats.intelHints++;
    }

    this.stats.reassigns++;
    this.lastRoles = counts;
  }

  /** Claim a validated cover point for `e` (or return its current one). */
  requestCover(e, playerPos) {
    if (!this.cover) return null;
    if (e.coverKey) {
      const pt = this.coverPointByKey.get(e.coverKey);
      if (pt && this.coverReserve.get(e.coverKey) === e) return pt;
    }
    const pt = this.cover.find(e, playerPos, { maxFromEnemy: 14, reserved: this.coverReserve });
    if (!pt) return null;
    const key = `${pt.x.toFixed(1)},${pt.z.toFixed(1)}`;
    this.coverReserve.set(key, e);
    this.coverPointByKey.set(key, pt);
    e.coverKey = key;
    this.stats.coverClaims++;
    return pt;
  }

  releaseCover(e) {
    if (!e.coverKey) return;
    if (this.coverReserve.get(e.coverKey) === e) this.coverReserve.delete(e.coverKey);
    e.coverKey = null;
  }

  roleCounts() {
    return { ...this.lastRoles };
  }
}

function signSide(e, playerPos) {
  // which side of the player's current facing is this soldier on?
  const p = e.root.position;
  return Math.sign(p.x - playerPos.x) || 1;
}
