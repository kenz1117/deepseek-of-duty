/* =========================================================================
 * COVER — cover-point evaluation and reservation.
 *
 * The old cover move was "pick the nearest cover point within 14 m", with no
 * check that the point actually hides you. That produced soldiers crouching in
 * the open. This module scores a point by:
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
 * Peeking works because standing eye height (1.685 m) clears most of these
 * waist-high covers, so the existing canSeePlayer() ray decides when a soldier
 * can actually shoot from behind it.
 * ========================================================================= */

const CROUCH_SIGHT_Y = 0.95;
const OFFSET = 0.62;

function segmentHitsBox(x0, z0, x1, z1, bx0, bx1, bz0, bz1) {
  // 2D slab test: does the segment pass through the AABB?
  const dx = x1 - x0, dz = z1 - z0;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-6) {
    if (x0 < bx0 || x0 > bx1) return false;
  } else {
    let t1 = (bx0 - x0) / dx, t2 = (bx1 - x0) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-6) {
    if (z0 < bz0 || z0 > bz1) return false;
  } else {
    let t1 = (bz0 - z0) / dz, t2 = (bz1 - z0) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

export function createCoverSystem(level, nav) {
  const colliders = level.colliders || [];
  const points = (level.coverPoints || []).filter((p) => !(p.y > 0.4));

  function blocksCrouched(x, z, px, pz) {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (c.top != null && c.top < CROUCH_SIGHT_Y) continue;
      if (segmentHitsBox(x, z, px, pz, c.x0, c.x1, c.z0, c.z1)) return true;
    }
    return false;
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
    // a "fresh" fire-direction hint (last few seconds of incoming rounds)
    // is treated as a known threat lane; cover closer to the inbound axis
    // is downgraded so the soldier is not sent right back into the fire.
    const threat = (e.fireBearingT && e.fireBearingT > 0.1)
      ? { x: e.fireBearingX || 0, z: e.fireBearingZ || 0 }
      : null;
    const px = e.root.position.x, pz = e.root.position.z;
    let best = null, bestScore = -Infinity;

    const test = (x, z) => {
      if (reserved && reserved.has(`${x.toFixed(1)},${z.toFixed(1)}`)) return;
      const de = Math.hypot(x - px, z - pz);
      if (de > maxFromEnemy) return;
      const dp = Math.hypot(x - playerPos.x, z - playerPos.z);
      if (dp < 6.5 || dp > 32) return;
      if (nav && !nav.isWalkableAt(x, z, 0)) return;
      if (!blocksCrouched(x, z, playerPos.x, playerPos.z)) return;
      let score = 5 - Math.abs(dp - 15) * 0.22 - de * 0.30;
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
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    };

    for (const cp of points) { if (!cp.invalid) test(cp.x, cp.z); }

    if (maxFromEnemy >= 12) {
      const faces = nearbyFaces(e, playerPos, maxFromEnemy);
      for (const [x, z] of faces) test(x, z);
    }
    return best;
  }

  return { find, points, blocksCrouched };
}
