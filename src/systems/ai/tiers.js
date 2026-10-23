/* =========================================================================
 * DIFFICULTY TIERS — the single source of truth for the wave → tier ladder.
 *
 * It lives in its own module (not in main.js) so tools/diff-tier-test.mjs
 * can import it headlessly and assert the fairness invariants. That matters:
 * the ladder was once edited in two places at once — README and code — and
 * an integration commit put D4/D5 back to maxFiring 3 while the README and
 * every measured TTK still said 2. The whole single-player fairness pass was
 * silently invalidated by a merge.
 *
 * maxFiring is the strongest lever in the game: it is the number of
 * soldiers allowed to START a burst inside one 1.15 s window, so the squad's
 * sustained output is ~maxFiring / 1.15 bursts per second. Keep it at 2 for
 * D3 and above — one player must be able to read how many guns are on them.
 * ========================================================================= */

export const DIFF_TIERS = [
  { id: 'D1', label: 'TRAINING', wave: 1, accuracy: 0.62, damage: 0.55, firstShot: 1.9, burst: 0.65, maxFiring: 1 },
  { id: 'D2', label: 'CONTACT', wave: 3, accuracy: 0.72, damage: 0.72, firstShot: 1.5, burst: 0.80, maxFiring: 2 },
  { id: 'D3', label: 'PRESSURE', wave: 5, accuracy: 0.82, damage: 0.82, firstShot: 1.3, burst: 0.90, maxFiring: 2 },
  { id: 'D4', label: 'VETERAN', wave: 8, accuracy: 0.94, damage: 0.94, firstShot: 1.1, burst: 1.00, maxFiring: 2 },
  { id: 'D5', label: 'ELITE', wave: 12, accuracy: 0.96, damage: 0.95, firstShot: 0.9, burst: 1.05, maxFiring: 2 },
];

/* HARD INVARIANT — single-player readability. See the module header. */
export const MAX_FIRING_CEILING = 2;

export function diffForWave(n) {
  let tier = DIFF_TIERS[0];
  for (const t of DIFF_TIERS) if (n >= t.wave) tier = t;
  return tier;
}
