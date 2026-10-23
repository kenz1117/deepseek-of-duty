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
import { createCoverSystem, coverKey } from './cover.js';
import { pickFlankPoint, decideIntel, AI_PROFILES } from './profiles.js';

const TICK = 0.3;

export function budgets(B, n, morale = 1) {
  if (n <= 0) return { assault: 0, flank: 0, suppress: 0, hold: 0 };
  // A squad with no base of fire is a mob: everyone either rushes you or
  // drifts sideways, and nothing ever holds a lane. The old order
  // (assault -> flank -> suppress -> whatever is left) left `hold` at 0 for
  // every realistic wave size at D3+, so keep one soldier back whenever the
  // squad can spare one.
  const reserve = n >= 3 ? 1 : 0;
  // when morale is high (>=1) use tier defaults as-is. When it drops, swap
  // one flank slot for an extra hold — the squad falls back to base-of-fire
  // rather than committing to fresh angles while bleeding.
  const flankBudget = morale >= 0.95 ? B.flank : Math.max(0, B.flank - 1);
  const suppressBudget = B.suppress;
  const assault = n <= 2 ? n : Math.min(n - reserve, Math.max(1, B.assault));
  const flank = Math.min(n - assault - reserve, flankBudget);
  const suppress = Math.min(n - assault - flank - reserve, suppressBudget);
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

  tick(dt, enemies, playerPos, tier, facing = null) {
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
    // Morale counts ACTUAL DEATHS. The old model counted witnesses
    // (soldiers with comradeLostT set), so one death seen by two soldiers
    // read as two casualties, and one death nobody witnessed read as none.
    const seen = this._seenAlive || (this._seenAlive = new WeakSet());
    let newDeaths = 0;
    for (const e of enemies) {
      if (e.alive) seen.add(e);
      else if (seen.has(e)) { seen.delete(e); newDeaths++; }
    }
    this.squadDeaths = (this.squadDeaths || 0) + newDeaths;
    const liveN = Math.max(1, ground.length);
    if (!ground.length) { this.squadDeaths = 0; this.squadPeak = 0; }
    this.squadPeak = Math.max(this.squadPeak || 0, liveN);
    // ratio 0..1; clamp at 6 casualties out of 6 to leave headroom
    const moraleDrop = Math.min(1, this.squadDeaths / Math.min(6, Math.max(1, this.squadPeak)));
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
      else { e.aiRole = null; e.flankPoint = null; e.flankDone = false; }
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
      const e = take((x) => {
        let s = -distTo(x) - 30 * (x.suppression || 0);
        // Two assault soldiers must not come down the same lane. Penalise a
        // candidate that already sits inside the player's frontal cone, so
        // the second one swings wide instead of forming a conga line.
        if (facing) s += 2.4 * facingAlign(x, playerPos, facing);
        return s;
      });
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
        // A flank needs a BELIEF: you cannot circle someone you have not
        // found. The old fallback (the squad's area anchor — the region
        // centroid of the player's LIVE position) handed every soldier a
        // free regional radar, and put the arc point up to ~60 m from the
        // player, so the "flank" landed in front of the player half the
        // time. Only a soldier who SAW the player or HEARD something may
        // take the job; the rest converge first and flank later.
        if (!flankBelief(x)) return -Infinity;
        const base = (x.canSee ? -6 : 6) - Math.abs(distTo(x) - 24) * 0.2;
        // prefer soldiers whose current bearing already leans to the side
        // we need next; pick the side with fewer flankers so far
        const candidateSide = signSide(x, playerPos, facing);
        const sideCount = takenSides[String(candidateSide)] || 0;
        const otherCount = flankers.length - sideCount;
        // soft penalty for the side that's already busy
        const spread = (sideCount > otherCount) ? -2.5 : (sideCount === otherCount ? 0.5 : 1.8);
        return base + spread;
      });
      if (!e) break;
      // alternate sides; if the candidate's natural side is on the busy
      // side, send them the other way
      const candidateSide = signSide(e, playerPos, facing);
      const busy = (takenSides[String(candidateSide)] || 0) > takenSides[String(-candidateSide)];
      this.flankSide = busy ? -candidateSide : candidateSide;
      e.aiRole = 'flank';
      e.aiSide = this.flankSide;
      e.roleT = 5 + Math.random() * 4;
      // The anchor is THIS soldier's own belief:
      //   lastSeen  — where he actually saw the player (exact, stale)
      //   investigate — where he heard the fight (a noise, a bullet impact,
      //                or the squad's radio report: the neighbourhood hint
      //                that arrives on the intel clock with a 12-20 m error)
      // Both are legitimate: they are what a real soldier would act on.
      // The neighbourhood anchor of the player's LIVE position is NOT — it
      // is a squad-level radar that lands the arc wherever the region
      // centroid happens to be.
      const threat = e.lastSeen || e.investigate;
      const walkable = (x, z) => !this.nav || this.nav.isWalkableAt(x, z, 0);
      const reachable = (fp) => !!fp && (!this.nav || (this.nav.isWalkableAt(fp.x, fp.z, 0)
        && (!this.nav.findPath
            || this.nav.findPath(e.root.position.x, e.root.position.z, 0, fp.x, fp.z, 0))));
      // The arc is measured from the SQUAD's centroid, not from the
      // flanker itself: measured from the flanker it degenerates into a
      // perpendicular sidestep (the arc point sits next to the player
      // instead of around him). Measured from the squad's mass, the flanker
      // lands on the far side of the belief from everyone else — a pincer.
      // This is squad-level knowledge (where my own squad is), not a
      // wallhack (the belief is still the soldier's own).
      // ...measured from the MAIN BODY only: including the flanker in the
      // centroid puts the reference on top of him, and the arc degenerates
      // back into a sidestep.
      const mainBody = ground.filter((x) => x.aiRole !== 'flank' && x !== e);
      const ref = squadCentroid(mainBody.length ? mainBody : ground);
      let fp = pickFlankPoint({
        from: e.root.position, threat, ref, side: e.aiSide, rng: Math.random, walkable,
        // 130-180 deg off the main body's bearing: the squad presses from
        // where the player is looking, the flanker arrives from behind it
        minAngle: 130, maxAngle: 180,
      });
      if (!reachable(fp)) {
        // No usable arc on this side: try the mirrored side before giving up.
        // A flanker with no plan degrades into a permanent lateral strafe,
        // which reads as "random shuffling", not as a flanking arc.
        const fp2 = pickFlankPoint({
          from: e.root.position, threat, ref, side: -e.aiSide, rng: Math.random, walkable,
          minAngle: 130, maxAngle: 180,
        });
        if (reachable(fp2)) { fp = fp2; e.aiSide = -e.aiSide; }
      }
      if (reachable(fp)) {
        e.flankPoint = { x: fp.x, z: fp.z };
        e.flankDone = false;
        e.flankT = 0;            // route timer restarts with the new waypoint
      } else {
        e.flankPoint = null;
        e.flankDone = true;
      }
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

    // ---- contact reports (Phase 2: no free intel) --------------------------
    // The old loops handed every soldier the player's live position with
    // 3-10 m of error — once on spawn, then again every B.intel seconds.
    // Holding an angle for more than a few seconds read as a wallhack.
    // Now a soldier is only told what he could actually have perceived:
    //   1. a concrete stimulus near him (shots, bullet impacts, a friend
    //      dying) with a small reporting error — decideIntel() picks it up;
    //   2. area profiles, on the normal intel clock, get which NEIGHBOURHOOD
    //      the player is in (region centroid, 12-20 m of error), so waves
    //      still converge on the fight without meter-precision tracking;
    //   3. garrison/squad profiles get nothing — they hold their post /
    //      patrol, or are driven by the versus faction brain.
    for (const e of ground) {
      if (e.team != null) continue;                       // brain owns versus intel
      // A soldier who can SEE the player needs no report. A soldier who is
      // merely ALERT but holds no belief does: `lastSeen` is cleared when a
      // search times out, and an alert soldier used to be skipped here, so
      // he stayed beliefless forever — no flank, no search target, one
      // fewer body in the squad.
      if (e.canSee) { e.intelT = 0; continue; }
      if ((e.awareness || 0) >= 0.6 && flankBelief(e)) { e.intelT = 0; continue; }
      if (e.investigate && e.investigateT < 6) continue;  // already on a fresh job
      const prof = e.profile || AI_PROFILES.default;
      const intelEvery = B.intel * (0.55 + Math.random() * 0.5);
      const src = this.hooks.perception ? this.stimulusFor(e) : null;
      const hint = decideIntel({
        profile: prof, intelT: e.intelT || 0, intelEvery,
        stimuli: src ? [src] : null, area: this.areaAnchor(playerPos), rng: Math.random,
      });
      if (hint.kind === 'stimulus' || hint.kind === 'area') {
        e.investigate = { x: hint.x, z: hint.z };
        e.investigateT = 0;
        e.intelT = 0;
        e.intelDue = intelEvery;
        this.stats.intelHints++;
      } else if (hint.kind === 'wait') {
        e.intelT = (e.intelT || 0) + step;
      } else {
        e.intelT = 0;    // 'none': nothing to accrue towards
      }
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

  /**
   * Freshest thing this soldier could have perceived: a live noise inside
   * its own radius, a bullet impact within 12 m, or a squad death within
   * its broadcast radius. Positions only — never the player's live point.
   */
  stimulusFor(e) {
    const P = this.hooks.perception;
    if (!P) return null;
    const p = e.root.position;
    let best = null, bestLife = -1;
    for (const n of P.noises) {
      if (n.life <= 0) continue;
      if (Math.hypot(n.x - p.x, n.z - p.z) > n.r) continue;
      if (n.life > bestLife) { bestLife = n.life; best = n; }
    }
    if (!best) for (const imp of P.impacts) {
      if (imp.life <= 0) continue;
      if (Math.hypot(imp.x - p.x, imp.z - p.z) > 12) continue;
      if (imp.life > bestLife) { bestLife = imp.life; best = imp; }
    }
    if (!best) for (const c of P.casualties) {
      if (c.life <= 0) continue;
      if (Math.hypot(c.x - p.x, c.z - p.z) > c.r) continue;
      if (c.life > bestLife) { bestLife = c.life; best = c; }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  /**
   * NEIGHBOURHOOD anchor for the player's position: the centroid of the
   * named region he stands in (a 50-120 m cell), or the raw position for
   * the street fallback (decideIntel then adds 12-20 m on top). This is the
   * granularity a squad radio report would actually carry.
   */
  areaAnchor(playerPos) {
    const regionAt = this.level && this.level.regionAt;
    if (regionAt) {
      const r = regionAt(playerPos.x, playerPos.z);
      if (r && r.x0 !== undefined) return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
    }
    return { x: playerPos.x, z: playerPos.z };
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
    // Versus: one reservation table, but keys are namespaced per faction so
    // the two teams do not fight over the same cover spots (the reserve map
    // itself stays shared — a spot freed by either side is reusable by both,
    // it just cannot be double-booked).
    //
    // The key MUST be built by coverKey(): the writer and the reader used
    // different formats, so the reservation never matched and two soldiers
    // happily claimed the same crate.
    const team = e.team == null ? 0 : e.team;
    const pt = this.cover.find(e, playerPos, {
      maxFromEnemy: 14, reserved: this.coverReserve, team,
    });
    if (!pt) return null;
    const key = coverKey(pt.x, pt.z, team);
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

/**
 * May this soldier take a flank job?
 *
 * A flank is an arc AROUND a known position, so it needs a position to
 * arc around. `lastSeen` is where the soldier saw the player;
 * `investigate` is where he heard the fight (noise, bullet impact, or the
 * squad's radio report). Without either, the soldier has no idea where the
 * player is and must converge first — which is also the readable order of
 * a real fight: find him, then swing wide.
 */
/** Centroid of a set of soldiers — the squad's mass, in the XZ plane. */
function squadCentroid(list) {
  if (!list || !list.length) return null;
  let x = 0, z = 0, n = 0;
  for (const e of list) {
    const p = e.root && e.root.position;
    if (!p) continue;
    x += p.x; z += p.z; n++;
  }
  return n ? { x: x / n, z: z / n } : null;
}

export function flankBelief(e) {
  if (!e) return null;
  if (e.lastSeen) return e.lastSeen;
  if (e.investigate && (e.investigateT == null || e.investigateT < 24)) return e.investigate;
  return null;
}

function signSide(e, playerPos, facing = null) {
  // Which side of the PLAYER is this soldier on? The old version used the
  // world X axis, so "left flank" and "right flank" were fixed to the map,
  // not to the player — turning to face a flank did not work because the
  // flank was never relative to you. With a facing vector the side is the
  // player's left/right.
  const p = e.root.position;
  const rx = p.x - playerPos.x, rz = p.z - playerPos.z;
  if (facing) {
    // cross product of (player forward) x (player -> soldier): positive =
    // the soldier is on the player's left
    const cross = facing.x * rz - facing.z * rx;
    return cross >= 0 ? 1 : -1;
  }
  return Math.sign(rx) || 1;
}

/** 1 when the soldier is dead ahead of the player, 0 when off to the side. */
function facingAlign(e, playerPos, facing) {
  const p = e.root.position;
  const rx = p.x - playerPos.x, rz = p.z - playerPos.z;
  const l = Math.hypot(rx, rz) || 1;
  const dot = (rx / l) * facing.x + (rz / l) * facing.z;
  return Math.max(0, dot);
}
