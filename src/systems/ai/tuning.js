/* =========================================================================
 * AI TUNING — behaviour per difficulty tier.
 *
 * The old ladder only scaled accuracy / damage multipliers, so D5 felt like
 * "the same soldiers, but they hit harder". This table is the behaviour half:
 * how many soldiers push at once, how wide they flank, how quickly they react,
 * how much they commit to cover, and how good their intel on you is.
 *
 * Values are read once per decision (director tick / perception tick), so a
 * tier swap mid-run is safe.
 * ========================================================================= */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const AI_BEHAVIOR = {
  D1: {
    label: 'TRAINING',
    assault: 1, flank: 0, suppress: 0,   // simultaneous role slots (ground squad)
    cover: 0.25,                         // chance to break for cover when hurt/suppressed
    reaction: [0.95, 1.55],              // seconds between seeing you and the first shot
    fov: 0.95,                           // half-angle of the vision cone (rad)
    sight: 55,                           // max visual detection range
    gain: 0.70, decay: 0.45,             // awareness ramp-up / cool-down per second
    settle: 1.25,                        // seconds of visibility to reach full accuracy
    lead: 0.0,                           // aim lead on a sprinting player (visual only)
    intel: 7.0,                          // seconds between rough position hints when blind
    regroup: 0.0,                        // 0..1 how strongly a hurt soldier backs off
  },
  D2: {
    label: 'CONTACT',
    assault: 1, flank: 1, suppress: 0,
    cover: 0.40,
    reaction: [0.78, 1.28],
    fov: 1.02, sight: 64,
    gain: 0.88, decay: 0.50,
    settle: 1.05,
    lead: 0.15,
    intel: 6.0,
    regroup: 0.15,
  },
  D3: {
    label: 'PRESSURE',
    assault: 2, flank: 1, suppress: 1,
    cover: 0.55,
    reaction: [0.62, 1.05],
    fov: 1.08, sight: 72,
    gain: 1.02, decay: 0.55,
    settle: 0.90,
    lead: 0.35,
    intel: 5.0,
    regroup: 0.30,
  },
  D4: {
    label: 'VETERAN',
    assault: 2, flank: 2, suppress: 1,
    cover: 0.72,
    reaction: [0.46, 0.86],
    fov: 1.16, sight: 82,
    gain: 1.16, decay: 0.60,
    settle: 0.74,
    lead: 0.60,
    intel: 4.2,
    regroup: 0.45,
  },
  D5: {
    label: 'ELITE',
    assault: 3, flank: 2, suppress: 2,
    cover: 0.88,
    reaction: [0.32, 0.62],
    fov: 1.28, sight: 92,
    gain: 1.30, decay: 0.65,
    settle: 0.60,
    lead: 0.85,
    intel: 3.4,
    regroup: 0.60,
  },
};

export function behaviorFor(tier) {
  return AI_BEHAVIOR[tier && tier.id] || AI_BEHAVIOR.D3;
}

/* Per-archetype perception / timing modifiers: a rusher is a tunnel-vision
   sprinter, a sniper watches one lane for a long time. */
const ARCH_MOD = {
  rifleman: { fov: 1.00, sight: 1.00, reaction: 1.00, settle: 1.00 },
  rusher:   { fov: 1.30, sight: 0.82, reaction: 0.78, settle: 0.82 },
  shield:   { fov: 1.12, sight: 0.92, reaction: 1.12, settle: 1.08 },
  sniper:   { fov: 0.82, sight: 1.18, reaction: 1.30, settle: 1.28 },
};

export function archMod(archetype) {
  return ARCH_MOD[archetype] || ARCH_MOD.rifleman;
}

/** Per-contact reaction delay: deterministic per tier, randomised per soldier. */
export function reactionDelay(behavior, archetype) {
  const m = archMod(archetype).reaction;
  const [a, b] = behavior.reaction;
  return (a + Math.random() * Math.max(0.01, b - a)) * m;
}

export function clamp01(v) { return clamp(v, 0, 1); }
