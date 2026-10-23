/* =========================================================================
 * COVER — cover-point evaluation and reservation.
 *
 * The old cover move was "pick the nearest cover point within 14 m", with no
 * check that the point actually hides you. That produced soldiers crouching
 * in the open. This module scores a point by:
 *
 *   • it really breaks the player's line of sight at crouch height (0.95 m),
 *   • it is in a useful distance band from the player (6.5–32 m),
 *   • it is close enough to reach without crossing the open,
 *   • nobody else has claimed it.
 *
 * Candidates come from two sources: the hand-placed level cover points, and
 * faces of nearby colliders (walls, trucks, fences). The second source is what
 * makes cover work on long streets that never had explicit cover props — the
 * soldier hugs the wall face that puts masonry between him and you.
 *
 * THE COVER TEST IS 3D NOW. It used to be a 2D slab test ("is there a wall
 * between us in plan view"), while the real line of sight is a 3D segment
 * (see systems/ai/geom.js). The mismatch produced the classic "the soldier
 * is crouched right there but I can still see him and he is not shooting"
 * stalemate — he was behind "cover" that did not actually cover.
 *
 * Peeking works because standing eye height (1.685 m) clears most of these
 * waist-high covers, so the existing canSeeTarget() ray decides when a
 * soldier can actually shoot from behind it.
 * ========================================================================= */

import { segmentBlockedByColliders, segmentHitsBox } from './geom.js';

const CROUCH_SIGHT_Y = 0.95;
const OFFSET = 0.62;
const PLAYER_EYE_STAND = 1.68;
const PLAYER_EYE_CROUCH = 1.05;

/**
 * Canonical reservation key. The director writes into the reservation map
 * with this key and the cover system checks it with this key — they used to
 * disagree on the format (the map stored "t0:12.3,45.6", the lookup asked
 * for "12.3,45.6"), so two soldiers could claim the same crate.
 */
export function coverKey(x, z, team = 0) {
  return `t${team == null ? 0 : team}:${x.toFixed(1)},${z.toFixed(1)}`;
}

export function createCoverSystem(level, nav) {
  const colliders = level.colliders || [];
  const points = (level.coverPoints || []).filter((p) => !(p.y > 0.4));

  /**
   * How good is this spot as cover?
   *   2 — hidden from a STANDING player (real cover)
   *   1 — hidden only from a CROUCHED player (half cover)
   *   0 — not cover at all
   * The test is the same 3D segment test the AI's own sight line uses, from
   * the player's eye down to the crouched soldier's head.
   */
  function coverQuality(x, z, px, pz) {
    const fromStand = segmentBlockedByColliders(
      px, PLAYER_EYE_STAND, pz, x, CROUCH_SIGHT_Y, z, colliders).blocked;
    if (!fromStand) return 0;
    const fromCrouch = segmentBlockedByColliders(
      px, PLAYER_EYE_CROUCH, pz, x, CROUCH_SIGHT_Y, z, colliders).blocked;
    return fromCrouch ? 2 : 1;
  }

  function blocksCrouched(x, z, px, pz) {
    return coverQuality(x, z, px, pz) >= 2;
  }

  /**
   * Wall-face cover around the soldier: 4 face midpoints per nearby collider,
   * pushed out by the agent radius. Only candidates that hide a crouched body
   * from the player survive, so no need to score the normal direction.
   */
  function nearbyFaces(e, playerPos, maxFromEnemy) {
    const p = e.root.position;
    const out = [];
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.top != null && c.top < CROUCH_SIGHT_Y) continue;
      // cheap reject: collider AABB further than maxFromEnemy from the soldier
      const nx = Math.max(c.x0, Math.min(c.x1, p.x));
      const nz = Math.max(c.z0, Math.min(c.z1, p.z));
      if (Math.hypot(nx - p.x, nz - p.z) > maxFromEnemy) continue;
      const mx = (c.x0 + c.x1) * 0.5, mz = (c.z0 + c.z1) * 0.5;
      const faces = [
        [c.x0 - OFFSET, mz], [c.x1 + OFFSET, mz],
        [mx, c.z0 - OFFSET], [mx, c.z1 + OFFSET],
      ];
      for (const [fx, fz] of faces) {
        if (Math.hypot(fx - p.x, fz - p.z) > maxFromEnemy) continue;
        if (nav && !nav.isWalkableAt(fx, fz, 0)) continue;
        out.push([fx, fz]);
      }
    }
    return out;
  }

  function find(e, playerPos, opts = {}) {
    const maxFromEnemy = opts.maxFromEnemy || 15;
    const reserved = opts.reserved || null;
    const team = opts.team == null ? 0 : opts.team;
    // a "fresh" fire-direction hint (last few seconds of incoming rounds)
    // is treated as a known threat lane; cover closer to the inbound axis
    // is downgraded so the soldier is not sent right back into the fire.
    const threat = (e.fireBearingT && e.fireBearingT > 0.1)
      ? { x: e.fireBearingX || 0, z: e.fireBearingZ || 0 }
      : null;
    const px = e.root.position.x, pz = e.root.position.z;
    let best = null, bestScore = -Infinity;

    // Pass 1 insists on REAL cover (hidden from a standing player). If the
    // map offers none nearby, pass 2 accepts half cover rather than sending
    // the soldier to stand in the open.
    const runPass = (minQuality) => {
      best = null; bestScore = -Infinity;
      const test = (x, z) => {
        if (reserved && reserved.has(coverKey(x, z, team))) return;
        const de = Math.hypot(x - px, z - pz);
        if (de > maxFromEnemy) return;
        const dp = Math.hypot(x - playerPos.x, z - playerPos.z);
        if (dp < 6.5 || dp > 32) return;
        if (nav && !nav.isWalkableAt(x, z, 0)) return;
        const q = coverQuality(x, z, playerPos.x, playerPos.z);
        if (q < minQuality) return;
        let score = 5 - Math.abs(dp - 15) * 0.22 - de * 0.30;
        if (q >= 2) score += 1.2;              // real cover beats half cover
        if (nav && !nav.lineWalkable(px, pz, x, z)) score -= 1.4;
        // penalty for cover that sits between the soldier and a known fire
        // direction: hiding behind something on the fire axis is fine for
        // the cover test, but it tells the soldier they are still facing
        // the threat lane. We nudge them sideways instead.
        if (threat) {
          const tx = x - px, tz = z - pz;
          const tl = Math.hypot(tx, tz) || 1;
          const align = (tx / tl) * threat.x + (tz / tl) * threat.z;
          if (align > 0.45) score -= 1.6;          // cover sits "in front" of the fire direction
          else if (align < -0.45) score += 0.6;    // cover sits off-axis: better flank, less obvious
        }
        // peer-spread: cover 1.4 m from a chosen cover is suspicious, but
        // we want some breathing room, not just clutter. Soft penalty.
        if (best && Math.hypot(best.x - x, best.z - z) < 1.4) return;
        if (score > bestScore) { bestScore = score; best = { x, z, quality: q }; }
      };

      for (const cp of points) { if (!cp.invalid) test(cp.x, cp.z); }

      if (maxFromEnemy >= 12) {
        const faces = nearbyFaces(e, playerPos, maxFromEnemy);
        for (const [x, z] of faces) test(x, z);
      }
      return best;
    };

    let found = runPass(2);
    if (!found) found = runPass(1);
    return found;
  }

  return { find, points, blocksCrouched, coverQuality };
}
