/* =========================================================================
   TEAM BRAIN — per-faction squad coordination for versus mode.

   Pure logic: no three.js, no DOM. The host feeds one observation per
   director tick (0.3 s) and reads back the squad's shared plan. One instance
   per faction, created on the host only.

   What "cooperation" means here, in increasing order of value
   ----------------------------------------------------------
   1. SHARED INTEL  — any soldier that SEES an enemy shouts the position to
      the whole faction (lastKnown). This is the base layer: nobody fights
      alone, and the squad converges on where contact was made.
   2. FOCUS FIRE    — the faction picks ONE priority target that any member
      can currently see, and members prefer it over "nearest". Dying to a
      focused squad feels intentional; dying to eight independent duelists
      feels random.
   3. TACTICAL FOCUS — a single point the squad orbits: the last-known enemy
      position, or the ring centre when intel goes stale (under a shrinking
      ring, the enemy has to come inside, so walking toward the centre is a
      legal deduction, not a wallhack).

   Anti-cheat rule (load-bearing)
   ------------------------------
   The host CAN see every entity, but the brain must not act on that. Intel
   is only refreshed by a member's own `canSee`; priority targets must be
   visible to at least one member right now. Everything else decays. When
   all intel expires the plan degrades to the ring centre — that is game
   sense, not information the squad could not have.

   Deliberately NOT solved here
   ----------------------------
   Per-soldier pathing around focus, revive mechanics, real formation
   keeping. The director already spreads flanks left/right; this module only
   decides WHERE the squad acts, not how each soldier walks.
   ========================================================================= */

/** How long shared intel stays actionable without a refresh. */
const INTEL_TTL = 8.0;

/** A priority target without a fresh sighting loses focus after this long. */
const FOCUS_TARGET_TTL = 2.5;

/** Weight of "low HP" in the focus-fire score. Killing a wounded enemy is
    worth more than poking a full one. */
const WOUNDED_BONUS = 40;

/** Weight of "nearest to the squad centroid" in the focus-fire score. */
const DISTANCE_WEIGHT = 0.35;

function clamp01(v) {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export function createTeamBrain({ team = 0, rng = Math.random } = {}) {
  const rand = typeof rng === 'function' ? rng : Math.random;

  let lastKnown = null;       // { x, z, t }  squad-shared enemy position
  let priorityTargetId = null;
  let priorityTargetT = 0;    // seconds since the priority target was confirmed
  let focus = null;           // { x, z } tactical point, or null
  let centroid = null;        // { x, z } own live centroid, for scoring
  let ringCenter = null;      // { x, z } fallback objective (set by owner)
  let members = [];           // scratch: [{ x, z, alive, canSee, hp, awareness }]
  let enemyScratch = [];      // scratch: [{ id, x, z, alive, hp }]

  function observe({ allies = [], enemies = [], ring = null } = {}) {
    members = Array.isArray(allies) ? allies : [];
    enemyScratch = Array.isArray(enemies) ? enemies : [];
    if (ring && Number.isFinite(ring.x)) ringCenter = { x: ring.x, z: ring.z };
  }

  /** Any live member currently seeing the enemy with this id? */
  function seenByAny(enemy) {
    for (const a of members) {
      if (!a.alive || !a.canSee) continue;
      if (a.sees && a.sees.has(String(enemy.id))) return true;
    }
    return false;
  }

  function tick(dt) {
    // ---- 1. shared intel: freshest sighting wins ------------------------
    let freshest = null;
    for (const e of enemyScratch) {
      if (!e || !e.alive) continue;
      if (!seenByAny(e)) continue;
      if (!freshest || e.freshness > freshest.freshness) freshest = e;
    }
    if (freshest) {
      lastKnown = { x: freshest.x, z: freshest.z, t: 0 };
    } else if (lastKnown) {
      lastKnown.t += dt;
      if (lastKnown.t > INTEL_TTL) lastKnown = null;   // intel expired
    }

    // ---- 2. focus fire: one visible target for the whole faction --------
    if (priorityTargetId != null) {
      priorityTargetT += dt;
      const stillVisible = enemyScratch.some(
        (e) => e && e.alive && String(e.id) === String(priorityTargetId) && seenByAny(e)
      );
      if (!stillVisible && priorityTargetT > FOCUS_TARGET_TTL) {
        priorityTargetId = null;                        // lost him
      }
    }
    if (priorityTargetId == null) {
      // own centroid, for a stable "closest to the squad" term
      const liveAllies = members.filter((a) => a.alive);
      if (liveAllies.length) {
        centroid = {
          x: liveAllies.reduce((s, a) => s + a.x, 0) / liveAllies.length,
          z: liveAllies.reduce((s, a) => s + a.z, 0) / liveAllies.length,
        };
      }
      let best = null;
      let bestScore = -Infinity;
      for (const e of enemyScratch) {
        if (!e || !e.alive || !seenByAny(e)) continue;
        const hpFrac = clamp01((Number(e.hp) || 0) / 100);
        const dist = centroid
          ? Math.hypot(e.x - centroid.x, e.z - centroid.z)
          : 0;
        const score = (1 - hpFrac) * WOUNDED_BONUS - dist * DISTANCE_WEIGHT
          + (e.isHuman ? 6 : 0);      // humans juke; bots die easier
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (best) {
        priorityTargetId = String(best.id);
        priorityTargetT = 0;
      }
    }

    // ---- 3. tactical focus ---------------------------------------------
    if (lastKnown) {
      focus = { x: lastKnown.x, z: lastKnown.z };
    } else if (ringCenter) {
      focus = { x: ringCenter.x, z: ringCenter.z };
    } else {
      focus = null;
    }
  }

  /** Serializable snapshot for debugging / tests. */
  function snapshot() {
    return {
      team,
      focus: focus ? { x: Number(focus.x.toFixed(2)), z: Number(focus.z.toFixed(2)) } : null,
      priorityTargetId,
      intelAge: lastKnown ? Number(lastKnown.t.toFixed(2)) : null,
      hasIntel: !!lastKnown,
    };
  }

  function reset() {
    lastKnown = null;
    priorityTargetId = null;
    priorityTargetT = 0;
    focus = null;
    centroid = null;
  }

  return {
    observe,
    tick,
    reset,
    snapshot,
    get focus() { return focus; },
    get priorityTargetId() { return priorityTargetId; },
    get hasIntel() { return !!lastKnown; },
    get ringCenter() { return ringCenter; },
    set ringCenter(v) {
      if (v && Number.isFinite(v.x)) ringCenter = { x: v.x, z: v.z };
    },
  };
}

export default createTeamBrain;