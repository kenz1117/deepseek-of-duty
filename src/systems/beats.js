/* =========================================================================
 * BEATS — the campaign beat chain (Phase 3).
 *
 * A mission stops being "mode + N waves" and becomes a scripted chain of
 * BEATS: infiltrate → seize → hold → exfil, or search → ambush → boss →
 * mop-up. Each beat maps onto the EXISTING wave machinery (one beat = one
 * wave) instead of replacing it: setupObjective still mounts the zone, the
 * upgrade loop still runs between beats, radio lines still key on the wave
 * number. This module is the pure decision layer:
 *
 *   beatForWave    — 1-based wave → beat
 *   beatMode       — which G.mode the wave loop runs (adds infil/interact)
 *   beatObjective  — what setupObjective mounts (zone / hold / nothing)
 *   beatComplete   — has this beat's goal been met, given runtime facts?
 *
 * Completion split, enforced here and in main.js:
 *   objective-driven beats (defend/extract/infil/interact) advance when the
 *   objective completes — kills are OPTIONAL for infil (ghosting is legal);
 *   clear-driven beats (survival/assault) advance when the field is clear;
 *   boss beats advance when the boss is down, escorts or not.
 *
 * Pure logic: no three.js, no DOM. Tested by tools/beats-test.mjs.
 * ========================================================================= */

/** Beat types whose completion comes from the objective (not the kill count). */
export const BEAT_OBJECTIVE_TYPES = Object.freeze([
  'infil', 'defend', 'extract', 'interact',
]);

export function beatForWave(beats, n) {
  return beats && beats[n - 1] ? beats[n - 1] : null;
}

/** Total "waves" for an op: beats when scripted, else the legacy count. */
export function operationWaves(op) {
  if (op && op.beats) return op.beats.length;
  return op && op.waves ? op.waves : 1;
}

/** G.mode for a beat. 'infil' and 'interact' are new objective types; the
    boss beat still runs the survival loop (its completion is boss-gated). */
export function beatMode(beat) {
  if (!beat) return 'survival';
  switch (beat.type) {
    case 'defend': return 'defend';
    case 'extract': return 'extract';
    case 'infil': return 'infil';
    case 'interact': return 'interact';
    default: return 'survival';
  }
}

/** AI profile for the beat's soldiers (Phase 2 layer), or null to inherit. */
export function beatProfile(beat) {
  return beat && beat.ai ? beat.ai : null;
}

/** What setupObjective mounts for this beat. null = no zone objective
    (survival / assault / boss beats). */
export function beatObjective(beat) {
  if (!beat) return null;
  if (beat.type === 'defend') {
    return { type: 'defend', zone: beat.zone, need: beat.hold || 45 };
  }
  if (beat.type === 'extract') {
    return { type: 'extract', zone: beat.zone, need: beat.hold || 8 };
  }
  if (beat.type === 'infil') {
    return { type: 'infil', zone: beat.zone, need: beat.hold || 3 };
  }
  if (beat.type === 'interact') {
    return { type: 'interact', zone: beat.spot, need: 0 };
  }
  return null;
}

/**
 * Is this beat done? `facts`:
 *   cleared       — field is clear (no live enemies, no pending spawns)
 *   objectiveDone — the mounted objective completed (hold/reach/interact)
 *   bossSpawned   — the beat's boss has entered
 *   bossDead      — the boss is down
 */
export function beatComplete(beat, facts = {}) {
  if (!beat) return false;
  if (beat.type === 'boss') return !!(facts.bossSpawned && facts.bossDead);
  if (BEAT_OBJECTIVE_TYPES.includes(beat.type)) return !!facts.objectiveDone;
  return !!facts.cleared;
}

/** Declared enemy count for the beat, or null to use the legacy formula. */
export function beatEnemyCount(beat) {
  return beat && Number.isInteger(beat.enemies) ? beat.enemies : null;
}
