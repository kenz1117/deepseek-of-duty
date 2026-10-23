/* =========================================================================
 * GEOMETRY — shared, pure LOS helpers.
 *
 * `segmentBlockedByColliders` used to live in entities/enemy.js, but the
 * cover system needs the EXACT same test. The cover system used to run a
 * 2D slab test while the real line of sight was 3D, so a soldier could
 * "hide" behind something that did not actually hide him — the player saw
 * him, he did not shoot, and both sides read as a bug.
 *
 * Keeping the test in one place is what makes cover and sight agree.
 * No three.js, no DOM: unit-testable from node.
 * ========================================================================= */

/**
 * Analytic segment-vs-AABB occlusion test (see Enemy.pathBlocked).
 * Module-level and pure so it can be unit-tested without three.js.
 *
 * @returns {{blocked: boolean, tEnd: number}} tEnd is the path fraction at
 *          the blocking point (1 when clear), for tracer truncation.
 */
export function segmentBlockedByColliders(ax, ay, az, bx, by, bz, colliders, occluders = [], host = null) {
  const dx = bx - ax, dz = bz - az, dy3 = by - ay;

  // 3D roof decks: an elevated shooter cannot see through a deck into the room below
  if (occluders && occluders.length && ay > by + 0.2) {
    for (const o of occluders) {
      if (!(ay > o.y && by < o.y - 0.05)) continue;
      const t = (o.y - ay) / (by - ay);
      if (t <= 0 || t >= 1) continue;
      const x = ax + dx * t, z = az + dz * t;
      if (x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return { blocked: true, tEnd: t };
    }
  }

  const cols = colliders || [];
  const nCols = cols.length;
  // Cheap XZ bounding-box reject. The cover system asks this question for
  // every candidate point of every cover request, so the scan has to stay
  // cheap: a collider whose AABB cannot overlap the segment's bounding box
  // can never be hit by the slab test.
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  for (let k = 0; k < nCols; k++) {
    const c = cols[k];
    if (c === host) continue;
    if (c.x1 < minX || c.x0 > maxX || c.z1 < minZ || c.z0 > maxZ) continue;
    const top = c.top != null ? c.top : Infinity;
    if (Math.min(ay, by) >= top) continue;           // whole path passes over it

    // slab test: overlap of the segment with the AABB in x and z
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDz = dz !== 0 ? 1 / dz : 0;
    let t0 = 0, t1 = 1;
    if (dx !== 0) {
      let ta = (c.x0 - ax) * invDx, tb = (c.x1 - ax) * invDx;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (ax < c.x0 || ax > c.x1) continue;
    if (dz !== 0) {
      let ta = (c.z0 - az) * invDz, tb = (c.z1 - az) * invDz;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (az < c.z0 || az > c.z1) continue;
    if (t0 >= t1 || t1 <= 0 || t0 >= 1) continue;

    // height along the path inside the overlap: blocked only where the
    // eye line is below the collider top
    const h0 = ay + dy3 * t0;
    const h1 = ay + dy3 * t1;
    if (h0 >= top && h1 >= top) continue;            // clears it within the overlap
    return { blocked: true, tEnd: t0 > 0 ? t0 : 0.001 };
  }
  return { blocked: false, tEnd: 1 };
}

/** 2D slab test: does the segment pass through (or end inside) the AABB? */
export function segmentHitsBox(x0, z0, x1, z1, bx0, bx1, bz0, bz1) {
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
