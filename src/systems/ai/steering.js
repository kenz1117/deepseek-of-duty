/* =========================================================================
 * STEERING — local spatial behaviour layered on top of A*.
 *
 * A* gives a route; it does not stop six soldiers from occupying the same
 * square metre, nor does it smooth the 0.8 m grid staircase. These helpers are
 * deliberately small and allocation-free:
 *
 *   separate()  — repulsion from neighbours + the player body
 *   pullString() — skip A* waypoints that are already in a clear straight line
 *   arrival()    — ease speed down near a target instead of overshooting
 * ========================================================================= */

/**
 * Add neighbour separation to `move` ({x,z}, expected unit-ish). Mutates move.
 * neighbors is the live enemy array; `self` is skipped.
 */
export function separate(self, neighbors, move, strength = 1.0) {
  if (!neighbors || !neighbors.length) return move;
  const p = self.root.position;
  let px = 0, pz = 0;
  for (let i = 0; i < neighbors.length; i++) {
    const o = neighbors[i];
    if (o === self || !o.alive) continue;
    const op = o.root.position;
    if (Math.abs(op.y - p.y) > 1.6) continue;
    const dx = p.x - op.x, dz = p.z - op.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 3.61 || d2 < 1e-5) continue;      // 1.9 m radius
    const d = Math.sqrt(d2);
    const w = (1.9 - d) / 1.9;
    px += (dx / d) * w;
    pz += (dz / d) * w;
  }
  if (px || pz) {
    move.x += px * strength;
    move.z += pz * strength;
    const l = Math.hypot(move.x, move.z) || 1;
    move.x /= l;
    move.z /= l;
  }
  return move;
}

/** Keep agents from standing inside the player (a rusher may hug, just not clip). */
export function avoidBody(self, playerPos, move, radius = 1.15) {
  const p = self.root.position;
  const dx = p.x - playerPos.x, dz = p.z - playerPos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius || d2 < 1e-5) return move;
  const d = Math.sqrt(d2);
  move.x += (dx / d) * (1 - d / radius) * 0.9;
  move.z += (dz / d) * (1 - d / radius) * 0.9;
  return move;
}

/**
 * String-pull the first few waypoints: advance pathI to the furthest waypoint
 * that is still directly walkable. Call only when a fresh path was produced.
 */
export function pullString(nav, path, pathI, x, z, maxSkip = 4) {
  if (!nav || !path || path.length < 2) return pathI;
  let best = pathI;
  const end = Math.min(path.length - 1, pathI + maxSkip);
  for (let j = pathI + 1; j <= end; j++) {
    if (nav.lineWalkable(x, z, path[j].x, path[j].z)) best = j;
  }
  return best;
}

/** Speed scale for a close target: full speed beyond `slow` metres. */
export function arrival(dist, slow = 1.6, min = 0.35) {
  if (dist >= slow) return 1;
  return Math.max(min, dist / slow);
}
