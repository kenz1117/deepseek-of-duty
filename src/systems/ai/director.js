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

function budgets(B, n, morale = 1) {
  if (n <= 0) return { assault: 0, flank: 0, suppress: 0, hold: 0 };
  // when morale is high (>=1) use tier defaults as-is. When it drops, swap
  // one flank slot for an extra hold — the squad falls back to base-of-fire
  // rather than committing to fresh angles while bleeding.
  const flankBudget = morale >= 0.95 ? B.flank : Math.max(0, B.flank - 1);
  const suppressBudget = morale >= 0.95 ? B.suppress : B.suppress;
  const assault = n <= 2 ? n : Math.min(n, Math.max(1, B.assault));
  const flank = Math.min(n - assault, flankBudget);
  const suppress = Math.min(n - assault - flank, suppressBudget);
  const hold = Math.max(0, n - assault - flank - suppress);
  return { assault, flank, suppress, hold };
}

export class AIDirector {
  constructor(nav, level, hooks = {}) {
    this.nav = nav;
    this.level = level;
    this.hooks = hooks || {};
    this.cover = level ? createCoverSystem(level, nav) : null;
    this.coverReserve = new Map();     // "x,z" -> enemy
    this.coverPointByKey = new Map();  // "x,z" -> {x,z}
    this.acc = 0;
    this.flankSide = 1;
    this.stats = { reassigns: 0, intelHints: 0, coverClaims: 0, boss: 0 };
    this.lastRoles = { assault: 0, flank: 0, suppress: 0, hold: 0, breach: 0, breachSupport: 0 };
  }

  tick(dt, enemies, playerPos, tier) {
    this.acc += dt;
    if (this.acc < TICK) return;
    const step = this.acc;
    this.acc = 0;
    const B = behaviorFor(tier);

    const live = [];
    for (const e of enemies) if (e.alive && e.root.visible) live.push(e);

    // reservations do not outlive their soldier, and a destroyed prop
    // invalidates the cover point it used to provide.
    for (const [k, e] of this.coverReserve) {
      const pt = this.coverPointByKey.get(k);
      if (!e.alive || e.root.visible === false || (pt && pt.invalid)) {
        this.coverReserve.delete(k);
        if (pt && pt.invalid) e.coverKey = null;
      }
    }

    const ground = live.filter((e) => !e.isBoss && e.baseY <= 0.5);

    // ---- squad morale ----
    // Casualties lift the rest of the squad's alertness and slightly bias
    // them toward regroup (defensive) play when the squad is bleeding.
    // A boss or the player being on the same body as everyone counts as a
    // "we have a fight" baseline so the value is interpretable.
    let casualties = 0;
    for (const e of live) if ((e.comradeLostT || 0) > 0) casualties++;
    this.squadCasualties = casualties;
    // ratio 0..1; clamp at 6 casualties out of 6 to leave headroom
    const liveN = Math.max(1, ground.length);
    const moraleDrop = Math.min(1, casualties / Math.min(6, liveN));
    // reverse mapping: more dead friends → lower morale → less accuracy
    // multiplier the squad applies to itself, and a small bias toward
    // hold / suppress instead of pushing on flanks.
    this.squadMorale = 1 - moraleDrop * 0.18;

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

    const n = ground.length;
    const want = budgets(B, n, this.squadMorale || 1);
    const pool = [];

    const counts = { assault: 0, flank: 0, suppress: 0, hold: 0 };
    for (const e of ground) {
      // a soldier already working on a breach / breach-support keeps that job
      if ((e.aiRole === 'breach' || e.aiRole === 'breachSupport')
          && e.breachDoor && !e.breachDoor.opened) continue;
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
      // quadrant-aware flank scoring: with two or more flank slots we want
      // the squad on opposite sides, not stacked. scoreFn reads the
      // candidate's current bearing from the player and compares it to
      // where other live flankers already are — the lower the overlap,
      // the higher the score.
      const flankers = ground.filter((x) => x.aiRole === 'flank' && x.aiSide);
      const takenSides = { 1: 0, '-1': 0 };
      for (const f of flankers) takenSides[String(f.aiSide)]++;
      const e = take((x) => {
        const base = (x.canSee ? -6 : 6) - Math.abs(distTo(x) - 24) * 0.2;
        // prefer soldiers whose current bearing already leans to the side
        // we need next; pick the side with fewer flankers so far
        const candidateSide = signSide(x, playerPos);
        const sideCount = takenSides[String(candidateSide)] || 0;
        const otherCount = flankers.length - sideCount;
        // soft penalty for the side that's already busy
        const spread = (sideCount > otherCount) ? -2.5 : (sideCount === otherCount ? 0.5 : 1.8);
        return base + spread;
      });
      if (!e) break;
      // alternate sides; if the candidate's natural side is on the busy
      // side, send them the other way
      const candidateSide = signSide(e, playerPos);
      const busy = (takenSides[String(candidateSide)] || 0) > takenSides[String(-candidateSide)];
      this.flankSide = busy ? -candidateSide : candidateSide;
      e.aiRole = 'flank';
      e.aiSide = this.flankSide;
      e.roleT = 5 + Math.random() * 4;
      counts.flank++;
      if (this.hooks.barks) this.hooks.barks.say('flank', e.root.position);
    }
    while (counts.suppress < want.suppress) {
      const e = take((x) => (x.canSee ? 8 : 0) - Math.abs(distTo(x) - 22) * 0.25);
      if (!e) break;
      e.aiRole = 'suppress'; e.roleT = 5 + Math.random() * 4; counts.suppress++;
      if (this.hooks.barks) this.hooks.barks.say('suppress', e.root.position);
    }
    while (pool.length) {
      const e = pool.shift();
      e.aiRole = 'hold'; e.roleT = 5 + Math.random() * 5; counts.hold++;
    }

    for (const e of ground) {
      if (e.aiRole !== 'breach') continue;
      if (!e.breachDoor || e.breachDoor.opened) { e.aiRole = null; e.breachDoor = null; }
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

    this.updateBreach(step, ground, playerPos);

    // ---- squad-level bark triggers ----
    // 'down' fires when the casualty count crosses 1 → 2 (or 0 → 1).
    // 'regroup' fires when the squad is bleeding AND at least 3 live
    // members are suppressed: that's the moment a "fall back" call makes
    // sense (the squad is taking more fire than it can return).
    if (this.hooks.barks) {
      if (this._prevCasualties == null) this._prevCasualties = 0;
      if (this.squadCasualties > this._prevCasualties
          && this.squadCasualties >= 1
          && this.squadCasualties <= 3) {
        // pick a position near the casualty for the bark; not all soldiers
        // have heard the death, only those with comradeLostT set
        const deadOrigin = ground.find((e) => (e.comradeLostT || 0) > 1.8);
        if (deadOrigin) this.hooks.barks.say('down', deadOrigin.root.position);
      }
      this._prevCasualties = this.squadCasualties || 0;

      if (this._regroupCd == null) this._regroupCd = 0;
      this._regroupCd = Math.max(0, this._regroupCd - step);
      const suppressedN = ground.reduce((n, e) => n + ((e.suppression || 0) > 0.55 ? 1 : 0), 0);
      if (suppressedN >= 3 && this._regroupCd <= 0
          && (this.squadCasualties || 0) >= 1) {
        // pick the suppressed soldier with the most suppression as the
        // origin of the call
        let hero = null, sup = 0;
        for (const e of ground) {
          if ((e.suppression || 0) > sup) { sup = e.suppression; hero = e; }
        }
        if (hero) this.hooks.barks.say('regroup', hero.root.position);
        this._regroupCd = 6;
      }
    }

    this.stats.reassigns++;
    this.lastRoles = counts;
  }

  /**
   * Breach: if the player is camping on the far side of a closed breach door
   * and a soldier is stacked on it, kick it open instead of waiting forever.
   * Telegraphed by the caller (bark + 2.5 s of stacking).
   */
  updateBreach(step, ground, playerPos) {
    // Versus: the breach criterion is "the target is on the other side of this
    // door". With two factions the "target" is a centroid — both teams would
    // blow open their own cover for the enemy. Disable rather than redefine.
    if (step && step.some && step.some((e) => e.team != null)) return;
    const doors = this.level && this.level.breachDoors;
    if (!doors || !doors.length) return;
    for (const door of doors) {
      if (door.opened) {
        // release anyone still holding this door as a breach job,
        // including the support who was providing cover fire.
        for (const e of ground) {
          if (e.breachDoor !== door) continue;
          e.breachDoor = null;
          if (e.aiRole === 'breach' || e.aiRole === 'breachSupport') e.aiRole = 'assault';
        }
        continue;
      }
      const r = door.rect;
      if (!r) continue;
      const cx = (r[0] + r[1]) * 0.5;
      const cz = (r[2] + r[3]) * 0.5;
      const playerNear = Math.hypot(playerPos.x - cx, playerPos.z - cz) < 15;
      if (!playerNear) { door._aiBreachT = 0; continue; }
      // pick one soldier on the far side and send him to the door
      let stacker = ground.find((e) => e.aiRole === 'breach' && e.breachDoor === door) || null;
      let bestD = Infinity;
      if (!stacker) for (const e of ground) {
        if (e.aiRole === 'breach') continue;
        const ep = e.root.position;
        if (Math.hypot(ep.x - cx, ep.z - cz) > 16) continue;
        const sideE = (ep.z - cz);
        const sideP = (playerPos.z - cz);
        if (Math.abs(sideE) < 0.25 || Math.abs(sideP) < 0.25) continue;
        if (Math.sign(sideE) === Math.sign(sideP)) continue;
        const d = Math.hypot(ep.x - cx, ep.z - cz);
        if (d < bestD) { bestD = d; stacker = e; }
      }
      if (!stacker) { door._aiBreachT = Math.max(0, (door._aiBreachT || 0) - step * 1.8); continue; }
      if (stacker.aiRole !== 'breach') {
        stacker.aiRole = 'breach';
        stacker.breachDoor = door;
        stacker.roleT = 4;
        stacker.investigate = { x: cx, z: cz };
        stacker.investigateT = 0;
      }
      // breach support: a second soldier within 18 m gets a "cover the
      // door" role so the player cannot just lean out and headshot the
      // stacker while he charges the door. We do NOT pick rusher for this
      // job — rushing is their archetype (close-range shotgun, no
      // cover, never waits), and a rusher on "hold" still rushes the
      // nearest target. sniper / shield / rifleman are all fine; the
      // ordering below prefers the soldier closest to the door so the
      // support arrives in time.
      const supportKey = `_aiSupport_${door.id ?? cx + ',' + cz}`;
      if (!door[supportKey]) {
        let bestSup = null, bestSupD = Infinity;
        for (const e of ground) {
          if (e === stacker) continue;
          if (e.aiRole === 'breach' || e.aiRole === 'breachSupport') continue;
          // archetype gate: skip rusher, accept everyone else
          if (e.archetype === 'rusher') continue;
          // skip soldiers already committed to a flank / breach route
          const ep = e.root.position;
          const d = Math.hypot(ep.x - cx, ep.z - cz);
          if (d > 18) continue;
          if (d < bestSupD) { bestSupD = d; bestSup = e; }
        }
        if (bestSup) {
          door[supportKey] = bestSup;
          bestSup.aiRole = 'breachSupport';
          bestSup.breachDoor = door;
          bestSup.roleT = 6;
        }
      }
      // if the assigned support is gone, clear the key so we re-pick
      const sup = door[supportKey];
      if (sup && (!sup.alive || sup.breachDoor !== door)) {
        door[supportKey] = null;
      }

      const ep = stacker.root.position;
      if (Math.hypot(ep.x - cx, ep.z - cz) > 2.8) {
        door._aiBreachT = Math.max(0, (door._aiBreachT || 0) - step * 1.2);
        continue;
      }
      door._aiBreachT = (door._aiBreachT || 0) + step;
      if (door._aiBreachT > 2.5) {
        door._aiBreachT = 0;
        if (this.hooks.onBreach) this.hooks.onBreach(door, stacker);
        if (this.hooks.barks) this.hooks.barks.say('breach', stacker.root.position);
        stacker.aiRole = 'assault';
        stacker.breachDoor = null;
        stacker.roleT = 0;
        this.stats.breaches = (this.stats.breaches || 0) + 1;
      }
    }
  }

  /** Claim a validated cover point for `e` (or return its current one). */
  requestCover(e, playerPos) {
    if (!this.cover) return null;
    if (e.coverKey) {
      const pt = this.coverPointByKey.get(e.coverKey);
      if (pt && !pt.invalid && this.coverReserve.get(e.coverKey) === e) return pt;
      if (pt && pt.invalid) {
        this.coverReserve.delete(e.coverKey);
        e.coverKey = null;
      }
    }
    const pt = this.cover.find(e, playerPos, { maxFromEnemy: 14, reserved: this.coverReserve });
    if (!pt) return null;
    // Versus: one reservation table, but keys are namespaced per faction so
    // the two teams do not fight over the same cover spots (the reserve map
    // itself stays shared — a spot freed by either side is reusable by both,
    // it just cannot be double-booked).
    const key = `t${e.team == null ? 0 : e.team}:${pt.x.toFixed(1)},${pt.z.toFixed(1)}`;
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
