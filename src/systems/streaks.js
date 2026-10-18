/* =========================================================================
   STREAKS — pure kill-streak progression logic.

   No three.js, no DOM, no timers: the owner feeds kills and polls state.
   Milestones fire once per life:
     4  kills -> supply
     7  kills -> uav
     11 kills -> artillery
   After 11, every additional 4 kills grants another supply drop.
   ========================================================================= */

const MILESTONE_SUPPLY = 4;
const MILESTONE_UAV = 7;
const MILESTONE_ARTILLERY = 11;
const REPEAT_STEP = 4;

export function createStreaks({ onReward, onTier } = {}) {
  const reward = typeof onReward === 'function' ? onReward : () => {};
  const tierChanged = typeof onTier === 'function' ? onTier : () => {};

  let streak = 0;
  let best = 0;
  let activeTier = null;
  let grantedSupply = false;
  let grantedUav = false;
  let grantedArtillery = false;

  function tierFor(n) {
    if (n >= MILESTONE_ARTILLERY) return 'artillery';
    if (n >= MILESTONE_UAV) return 'uav';
    if (n >= MILESTONE_SUPPLY) return 'supply';
    return null;
  }

  /** first kill count at which the *next* reward lands (always > streak) */
  function nextAtFor(n) {
    if (n < MILESTONE_SUPPLY) return MILESTONE_SUPPLY;
    if (n < MILESTONE_UAV) return MILESTONE_UAV;
    if (n < MILESTONE_ARTILLERY) return MILESTONE_ARTILLERY;
    const base = MILESTONE_ARTILLERY + Math.floor((n - MILESTONE_ARTILLERY) / REPEAT_STEP) * REPEAT_STEP;
    return base + REPEAT_STEP;
  }

  /** last kill count at which a reward landed (0 before the first one) */
  function prevAtFor(n) {
    if (n < MILESTONE_SUPPLY) return 0;
    if (n < MILESTONE_UAV) return MILESTONE_SUPPLY;
    if (n < MILESTONE_ARTILLERY) return MILESTONE_UAV;
    return MILESTONE_ARTILLERY + Math.floor((n - MILESTONE_ARTILLERY) / REPEAT_STEP) * REPEAT_STEP;
  }

  function snapshot() {
    const nextAt = nextAtFor(streak);
    const prevAt = prevAtFor(streak);
    const span = Math.max(1, nextAt - prevAt);
    const progress01 = Math.max(0, Math.min(1, (streak - prevAt) / span));
    return { streak, best, nextAt, progress01, activeTier };
  }

  function syncTier() {
    const next = tierFor(streak);
    if (next !== activeTier) {
      activeTier = next;
      tierChanged(activeTier, snapshot());
    }
  }

  function notifyKill(info) {
    void info; // headshot/weapon metadata is available to callers, not used here
    streak += 1;
    if (streak > best) best = streak;

    if (streak === MILESTONE_SUPPLY) {
      if (!grantedSupply) {
        grantedSupply = true;
        reward('supply');
      }
    } else if (streak === MILESTONE_UAV) {
      if (!grantedUav) {
        grantedUav = true;
        reward('uav');
      }
    } else if (streak === MILESTONE_ARTILLERY) {
      if (!grantedArtillery) {
        grantedArtillery = true;
        reward('artillery');
      }
    } else if (
      streak > MILESTONE_ARTILLERY &&
      (streak - MILESTONE_ARTILLERY) % REPEAT_STEP === 0
    ) {
      reward('supply');
    }

    syncTier();
    return snapshot();
  }

  /** new life: streak and per-life milestone flags reset, best score persists */
  function reset() {
    streak = 0;
    grantedSupply = false;
    grantedUav = false;
    grantedArtillery = false;
    syncTier();
    return snapshot();
  }

  /** logical system: nothing is time based, kept for a uniform update loop */
  function update(dt) {
    void dt;
  }

  return {
    notifyKill,
    update,
    reset,
    get state() {
      return snapshot();
    },
  };
}
