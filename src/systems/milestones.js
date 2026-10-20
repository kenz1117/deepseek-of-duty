/* =========================================================================
   MILESTONES — phase chain that gives a match a shape beyond "kill things".

   No three.js, no DOM, no timers: the owner feeds events and position, and
   polls state. This mirrors src/systems/streaks.js deliberately — both are
   pure logic so they can be unit-tested and reused by single player and the
   LAN host without touching the renderer.

   Why this exists
   ---------------
   In co-op the match had no objective at all (G.operation = null), so the
   HUD could only say "clear hostiles". Players reported having no idea what
   they were supposed to be doing. A milestone chain fixes that by always
   showing "current step, progress, what happens next".

   Design rule: the chain must be advanceable WITHOUT killing anyone.
   A chain of pure kill goals would reproduce the exact problem it is meant
   to solve, so every run mixes in reach / hold / collect steps.

   Step kinds
   ----------
     reach   walk into the zone          (no input required)
     hold    stand inside the zone       (decays when you leave)
     collect interact at the marker     (uses the existing E-interaction)
     kill    eliminate N hostiles        (the only lethal kind, never alone)

   The owner owns the interact targets for `collect`; this module only tracks
   progress and decides when a step is finished. See wireCollect().
   ========================================================================= */

/** How many steps are always generated for a match. */
export const MILESTONE_CHAIN_LENGTH = 8;

/** Fraction of steps that must be non-lethal, so a chain can never become
    "just kill things again". 1/3 is a floor, not an exact quota. */
const MIN_NON_LETHAL = 0.34;

/** Hard cap on how far a step may sit from the player when a chain is built.
    Keeps steps in the current fight instead of sending players across the map. */
const STEP_MIN_DIST = 8;
const STEP_MAX_DIST = 46;

/** `hold` steps decay when the player leaves the zone (matches the existing
    defend objective behaviour in main.js updateObjective). */
const HOLD_DECAY = 0.6;

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

/**
 * Build an ordered chain of steps.
 *
 * @param {object}   opts
 * @param {Array}    opts.reachSpots  [{x,z,r}] arrival targets
 * @param {Array}    opts.holdSpots   [{x,z,r}] stand-and-hold targets
 * @param {Array}    opts.collectSpots[{x,z}] interaction markers
 * @param {object}   opts.origin      {x,z} the player/anchor position
 * @param {function} [opts.rng]       () => [0,1) for deterministic tests
 * @param {number}   [opts.length]
 */
export function buildChain({
  reachSpots = [],
  holdSpots = [],
  collectSpots = [],
  origin = { x: 0, z: 0 },
  rng = Math.random,
  length = MILESTONE_CHAIN_LENGTH,
} = {}) {
  const rand = typeof rng === 'function' ? rng : Math.random;

  // Rank each pool by distance so we can sample nearby targets cheaply.
  const rank = (spots) =>
    spots
      .map((s) => ({ s, d: dist2(origin, s) }))
      .filter((e) => e.d >= STEP_MIN_DIST * 0.5 && e.d <= STEP_MAX_DIST)
      .sort((a, b) => a.d - b.d)
      .map((e) => e.s);

  const pools = {
    reach: rank(reachSpots),
    hold: rank(holdSpots),
    collect: rank(collectSpots),
  };

  const chain = [];
  // Guarantee the mix up front so we never emit an all-lethal chain, even if a
  // pool runs dry later.
  const wanted = [];
  const nonLethalCount = Math.max(2, Math.ceil(length * MIN_NON_LETHAL));
  for (let i = 0; i < length; i += 1) {
    const needNonLethal = wanted.filter((k) => k !== 'kill').length < nonLethalCount;
    const options = ['reach', 'hold', 'collect', 'kill'];
    const pick = options[Math.floor(rand() * options.length) % options.length];
    wanted.push(needNonLethal && pick === 'kill' ? 'reach' : pick);
  }

  for (let i = 0; i < length; i += 1) {
    const kind = wanted[i];
    const pool = pools[kind] || [];
    const spot = pool.length ? pool[Math.floor(rand() * pool.length) % pool.length] : null;
    // Any positional kind without a spot is downgraded to `kill`, so the chain
    // can never contain an objective the player has no way to satisfy.
    const positional = kind === 'reach' || kind === 'hold' || kind === 'collect';
    const finalKind = positional && !spot ? 'kill' : kind;

    if (finalKind === 'kill') {
      chain.push({ kind: 'kill', need: 3 + Math.floor(rand() * 4) });
      continue;
    }
    // collect markers are plain {x,z}; reach/hold usually carry an explicit r.
    const defaultR = finalKind === 'hold' ? 6 : finalKind === 'collect' ? 2.5 : 4;
    const r = Number(spot.r) > 0 ? Number(spot.r) : defaultR;
    const step = { kind: finalKind, x: spot.x, z: spot.z, r, need: 1 };
    if (finalKind === 'hold') step.need = 12;
    if (finalKind === 'collect') step.id = `ms_${i}_${Math.round(spot.x)}_${Math.round(spot.z)}`;
    chain.push(step);
  }
  return chain;
}

/** Human-facing label for a step, used by the HUD checklist. */
export function stepLabel(step) {
  if (!step) return '';
  if (step.kind === 'reach') return '前往标记点';
  if (step.kind === 'hold') return '守住目标区';
  if (step.kind === 'collect') return '搜集标记物';
  if (step.kind === 'kill') return '歼灭残敌';
  return '目标';
}

/**
 * Create a milestone tracker.
 *
 * @param {object}   opts
 * @param {Array}    [opts.chain]    pre-built chain (else built from spots)
 * @param {function} [opts.onStep]   (step, index, state) on each completion
 * @param {function} [opts.onAllDone] (state)
 * @param {function} [opts.onChainAdvance] (nextStep, index) when a new step
 *                         becomes active, so the owner can mount its interact
 *                         target / beacon.
 */
export function createMilestones({
  chain = null,
  reachSpots = [],
  holdSpots = [],
  collectSpots = [],
  origin = { x: 0, z: 0 },
  rng = Math.random,
  onStep = null,
  onAllDone = null,
  onChainAdvance = null,
  length = MILESTONE_CHAIN_LENGTH,
  mirror = false,
} = {}) {
  const steps = (Array.isArray(chain) && chain.length
    ? chain.slice()
    : buildChain({ reachSpots, holdSpots, collectSpots, origin, rng, length }));

  let index = 0;
  let holdTime = 0;
  let killCount = 0;
  let completedAt = null;
  let active = true;

  function currentStep() {
    return steps[index] || null;
  }

  function stepProgress(step) {
    if (!step) return 1;
    if (step.kind === 'hold') return clamp01(holdTime / Math.max(1, step.need));
    if (step.kind === 'kill') return clamp01(killCount / Math.max(1, step.need));
    // reach / collect are binary; progress only moves once satisfied.
    return step.done ? 1 : 0;
  }

  function snapshot() {
    const step = currentStep();
    return {
      index,
      total: steps.length,
      kind: step ? step.kind : null,
      label: stepLabel(step),
      need: step ? step.need : 0,
      x: step ? step.x : null,
      z: step ? step.z : null,
      r: step ? step.r : null,
      progress01: stepProgress(step),
      done: !active,
      // counts by kind, so the owner can show "2/3 kills" style copy
      kills: killCount,
    };
  }

  function announce(newStep, i) {
    if (typeof onChainAdvance === 'function') onChainAdvance(newStep, i);
  }

  function advance() {
    // A mirror only ever renders the host's chain; letting it advance on its
    // own would let the client's HUD disagree with the authoritative host.
    if (mirror) return;
    const finished = steps[index];
    if (finished) finished.done = true;
    if (typeof onStep === 'function') onStep(finished, index, snapshot());
    index += 1;
    holdTime = 0;
    killCount = 0;
    if (index >= steps.length) {
      active = false;
      if (typeof onAllDone === 'function') onAllDone(snapshot());
      return;
    }
    announce(currentStep(), index);
  }

  /** Called by the owner when the interact system fires a collect target. */
  function notifyCollect(id) {
    const step = currentStep();
    if (!active || !step || step.kind !== 'collect') return false;
    if (id !== undefined && step.id !== undefined && String(id) !== String(step.id)) return false;
    step.done = true;
    advance();
    return true;
  }

  /** Called by the owner on each confirmed enemy kill. */
  function notifyKill(n = 1) {
    const step = currentStep();
    if (!active || !step || step.kind !== 'kill') return snapshot();
    killCount += n;
    if (killCount >= step.need) advance();
    return snapshot();
  }

  /**
   * Per-frame progress. `inside` is the owner telling us the player is
   * currently standing in the active zone (reach/hold only).
   */
  function update(dt, inside = false) {
    const step = currentStep();
    if (!active || !step) return snapshot();

    if (step.kind === 'hold') {
      if (inside) holdTime += dt;
      else holdTime = Math.max(0, holdTime - dt * HOLD_DECAY);
      // Epsilon: repeated float addition can land a hair under the threshold
      // (100 x 0.1 == 9.999999999999998), which would strand the player on a
      // step whose bar reads full but never completes.
      if (holdTime + 1e-6 >= step.need) advance();
      return snapshot();
    }

    if (step.kind === 'reach' && inside) {
      step.done = true;
      advance();
    }
    return snapshot();
  }

  function reset() {
    index = 0;
    holdTime = 0;
    killCount = 0;
    completedAt = null;
    active = true;
    for (const s of steps) s.done = false;
    announce(currentStep(), 0);
    return snapshot();
  }

  function skip() {
    if (!active) return snapshot();
    advance();
    return snapshot();
  }

  /** Serializable view for the LAN snapshot (host -> clients). */
  function serialize() {
    const s = snapshot();
    return {
      index: s.index,
      total: s.total,
      kind: s.kind,
      label: s.label,
      need: s.need,
      x: s.x,
      z: s.z,
      r: s.r,
      progress01: Number(s.progress01.toFixed(3)),
      done: s.done,
      kills: s.kills,
    };
  }

  /** Apply a host-authoritative snapshot on a client. */
  function applyRemote(data) {
    if (!data || typeof data !== 'object') return snapshot();
    const total = Number(data.total);
    const nextIndex = Number(data.index);
    if (Number.isFinite(total) && total > 0 && steps.length !== total) steps.length = total;
    if (Number.isFinite(nextIndex) && nextIndex !== index) {
      index = Math.max(0, Math.min(steps.length, nextIndex));
      for (let i = 0; i < index; i += 1) steps[i].done = true;
      holdTime = 0;
      killCount = Number(data.kills) || 0;
      announce(currentStep(), index);
    } else if (Number.isFinite(data.kills)) {
      killCount = Number(data.kills) || 0;
    }
    const step = currentStep();
    if (step && Number.isFinite(data.x)) {
      step.x = Number(data.x);
      step.z = Number(data.z);
      step.r = Number(data.r);
      step.need = Number(data.need) || step.need;
      step.kind = typeof data.kind === 'string' ? data.kind : step.kind;
    }
    active = data.done !== true;
    return snapshot();
  }

  // Announce the opening step so the owner can mount its marker/target on
  // construction, exactly as it does for every later step. Without this the
  // first milestone had no beacon and no interact target until it was reached.
  if (typeof onChainAdvance === 'function') onChainAdvance(currentStep(), 0);

  return {
    update,
    notifyKill,
    notifyCollect,
    skip,
    reset,
    serialize,
    applyRemote,
    get state() {
      return snapshot();
    },
    get steps() {
      return steps;
    },
    get current() {
      return currentStep();
    },
    get isDone() {
      return !active;
    },
  };
}

export default createMilestones;