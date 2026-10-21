/* =========================================================================
 * AI PROFILES — the strategy layer that makes modes feel different.
 *
 * The shared low-level stack (perception / navgrid / cover / steering) stays
 * identical for every enemy. What changes per mode is *policy*, and policy
 * lives here:
 *
 *   hunter      survival waves — relentless, area-level intel, wide flanks
 *   assault     defend-mode attackers & counterattacks — the OBJECTIVE is
 *               the target, the player is just an obstacle on the way
 *   interceptor extract enemies — fortify at long standoff, or give up
 *               positions entirely once the pursuit starts
 *   garrison    unalerted campaign troops — patrol their post, and only
 *               react to something they could actually have perceived
 *   squad       versus fill bots — the faction brain owns intel, the
 *               director only hands out jobs
 *   default     current behaviour, used when nothing else applies
 *
 * Everything in this module is pure logic: no three.js, no DOM, no timers.
 * The director and Enemy read the tables; tools/ai-profile-test.mjs tests
 * the geometry and the intel decision headlessly.
 * ========================================================================= */

export const AI_PROFILES = {
  default: {
    id: 'default',
    /** intel: how this soldier may be told where to search.
     *  'area'    — neighbourhood-level hints (region centroid + big error)
     *  'stimuli' — only concrete noises / impacts / friendly deaths
     *  'none'    — nobody hands this soldier intel at all (brain-driven) */
    intel: 'area',
    /** patrol: { radius, dwell:[min,max] } — walk posts while unalerted */
    patrol: null,
    /** zoneAnchor: advance toward the mission area instead of the player
     *  when there is nothing fresher to go on */
    zoneAnchor: false,
    /** metres added to the role stand-off table (hold 20 / flank 17 / …) */
    standoffMod: 0,
  },
  hunter: { id: 'hunter', intel: 'area', patrol: null, zoneAnchor: false, standoffMod: 0 },
  assault: { id: 'assault', intel: 'area', patrol: null, zoneAnchor: true, standoffMod: -2 },
  interceptor: { id: 'interceptor', intel: 'area', patrol: null, zoneAnchor: true, standoffMod: 8 },
  interceptorPursuit: { id: 'interceptorPursuit', intel: 'area', patrol: null, zoneAnchor: true, standoffMod: -6 },
  garrison: { id: 'garrison', intel: 'stimuli', patrol: { radius: 13, dwell: [4, 9] }, zoneAnchor: false, standoffMod: 0 },
  squad: { id: 'squad', intel: 'none', patrol: null, zoneAnchor: false, standoffMod: 0 },
};

export function profileFor(name) {
  return AI_PROFILES[name] || AI_PROFILES.default;
}

/* --------------------------------------------------------- flank geometry */

const DEG = Math.PI / 180;

/**
 * A real flank waypoint: a point sitting in the side/rear sector of the
 * threat, 14-20 m out, on the assigned side. The ENEMY walks this route
 * with A* instead of strafing sideways into the player's gun.
 *
 * `threat` is the flanker's *knowledge* of the target (lastSeen / a stimulus
 * / an area hint) — never assumed to be the live position, so a flank
 * planned from stale intel reads as "he swung around where I was", not
 * "he read my coordinates".
 *
 * @returns {{x:number, z:number, dir:number}|null} dir = bearing from the
 *          point back to the threat (rad), so callers can face the threat
 *          on arrival. null when the sector maths cannot produce a point
 *          (degenerate geometry) — the caller then falls back to strafe.
 */
export function pickFlankPoint({ from, threat, side = 1, rng = Math.random,
  minDist = 14, maxDist = 20, minAngle = 80, maxAngle = 150, tries = 6 }) {
  if (!from || !threat) return null;
  const dx = from.x - threat.x;
  const dz = from.z - threat.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null;
  if (Math.hypot(dx, dz) < 0.5) return null;
  const base = Math.atan2(dz, dx);
  const sgn = side >= 0 ? 1 : -1;
  for (let i = 0; i < tries; i++) {
    // spread tries across the sector instead of clustering on the first rng
    const frac = (i + rng()) / tries;
    const off = (minAngle + frac * (maxAngle - minAngle)) * DEG;
    const r = minDist + rng() * Math.max(0, maxDist - minDist);
    const a = base + sgn * off;
    const x = threat.x + Math.cos(a) * r;
    const z = threat.z + Math.sin(a) * r;
    const back = Math.atan2(threat.z - z, threat.x - x);
    // first geometric candidate wins; reachability is the caller's job
    return { x, z, dir: back };
  }
  return null;
}

/* -------------------------------------------------------- patrol geometry */

/**
 * A patrol leg for an unalerted soldier: a walkable-looking point within
 * `radius` of the post, biased to keep turning the same way so a sentry
 * circles his beat instead of vibrating between two points.
 *
 * @returns {{x:number, z:number, dir:number}} dir = leg bearing (rad),
 *          fed back as `prevDir` on the next call.
 */
export function pickPatrolPoint({ home, radius = 13, rng = Math.random, prevDir = null }) {
  const h = home || { x: 0, z: 0 };
  const base = prevDir != null && Number.isFinite(prevDir)
    ? prevDir + (rng() * 2 - 1) * (100 * DEG)     // keep turning, ±100°
    : rng() * Math.PI * 2;
  const d = radius * (0.45 + 0.55 * rng());
  return { x: h.x + Math.cos(base) * d, z: h.z + Math.sin(base) * d, dir: base };
}

/* ------------------------------------------------------------ intel rules */

function jitter(rng, err) {
  const a = rng() * Math.PI * 2;
  const r = err * (0.4 + 0.6 * rng());
  return { dx: Math.cos(a) * r, dz: Math.sin(a) * r };
}

/**
 * One intel decision for one soldier — the fair replacement for the old
 * director wallhack. Nobody is ever told the live player position:
 *
 *   1. a concrete stimulus (gunshot / impact / friend died) always wins,
 *      with a small 2-7 m reporting error — that is information a human
 *      squad really would have;
 *   2. otherwise `area` profiles get a NEIGHBOURHOOD hint on the normal
 *      intel clock (region centroid + 12-20 m of error) — "he's somewhere
 *      in the souk", not "he's at x=12.4";
 *   3. `stimuli` profiles (garrison) get nothing but #1 — they hold their
 *      post and patrol, so sneaking past them stays viable;
 *   4. `none` profiles (squad) get nothing at all; their brain feeds them.
 *
 * @returns {{kind:'stimulus'|'area', x:number, z:number}
 *          |{kind:'none'}|{kind:'wait'}} — 'wait' means "keep accruing the
 *          intel clock, say nothing this tick".
 */
export function decideIntel({ profile, intelT, intelEvery, stimuli = null, area = null, rng = Math.random }) {
  const p = profile || AI_PROFILES.default;
  if (stimuli && stimuli.length) {
    const s = stimuli[0];
    const j = jitter(rng, 2 + rng() * 5);
    return { kind: 'stimulus', x: s.x + j.dx, z: s.z + j.dz };
  }
  if (p.intel === 'area' && area && Number.isFinite(area.x)
      && Number.isFinite(intelEvery) && intelT >= intelEvery) {
    const j = jitter(rng, 12 + rng() * 8);
    return { kind: 'area', x: area.x + j.dx, z: area.z + j.dz };
  }
  return { kind: p.intel === 'area' ? 'wait' : 'none' };
}
