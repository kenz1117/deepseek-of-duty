/* =========================================================================
   SPAWN DIRECTOR — per-mode spawn generation over semantic spawn zones.

   Why this exists
   ---------------
   Every PvE mode used to share one generic picker (18–45 m engagement band +
   a 34% blind-side roll) over a single flat point table, so campaign waves,
   endless survival, zone defence and extraction all *felt* identical. The
   mode redesign (docs/PLAN-MODES-AI-REDESIGN.md §3) replaces that with one
   zone layer and one generator per mode:

     zone     = spawn points grouped by named region, with a centroid
     survival = player-anchored, sector-aware, rotates zones between waves
     defend   = attack AXES toward the objective: enemies mass at the far end
                of 2-3 corridors that actually lead to the zone
     extract  = two phases: fortify between player and extract, then pursuit
                from the player's blind rear once the timer starts

   What stays shared is only the substrate every mode needs: nav validation
   and throttling live in main.js; this module is pure logic (no THREE, no
   DOM, no timers) so it can be unit-tested headlessly like milestones.js.

   Fallback contract: every generator returns [] when it cannot produce a
   sane plan (too few zones, nothing in range). Callers MUST fall back to
   the legacy pool picker on an empty result.
   ========================================================================= */

/** Engagement band (m): close enough to arrive in 10-20 s, far enough to
    not pop in on top of the player. Mirrors the legacy picker's band. */
const BAND_MIN = 18;
const BAND_MAX = 55;

/** How many recent waves a zone stays "burned" for the survival rotator. */
const ROTATION_MEMORY = 2;

/** Bearing sectors (deg) used to force multi-axis arrivals. */
function bearingOf(from, to) {
  return (Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI + 360) % 360;
}

/** Signed smallest difference between two bearings, in (-180, 180]. */
function bearingDelta(a, b) {
  let d = ((a - b) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function centroidOf(points) {
  let x = 0, z = 0;
  for (const p of points) { x += p.x; z += p.z; }
  return { x: x / points.length, z: z / points.length };
}

/**
 * Group the level's flat spawn table into named-region zones.
 *
 * @param {object}   level          needs spawnPoints[] and regionAt(x,z,y)
 * @param {function} [regionKeyOf]  optional override (point) => region id
 * @returns {Array} zones [{ id, points, centroid }] with >= 2 points each
 */
export function buildSpawnZones(level, regionKeyOf) {
  const buckets = new Map();
  for (const p of level.spawnPoints || []) {
    const key = regionKeyOf
      ? regionKeyOf(p)
      : (level.regionAt ? level.regionAt(p.x, p.z, p.y || 0) : null);
    const id = (key && (key.id || key.en)) || 'street';
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(p);
  }
  const zones = [];
  for (const [id, points] of buckets) {
    if (points.length < 2) continue;
    zones.push({ id, points, centroid: centroidOf(points) });
  }
  return zones;
}

/**
 * Re-bucket zones against a rect (the active district). Points outside the
 * rect drop out; zones left with < 2 points are discarded and survivors get
 * a fresh rect-local centroid. A null rect returns the input unchanged.
 */
export function zonesWithinRect(zones, rect) {
  if (!rect) return zones || [];
  const out = [];
  for (const zone of zones || []) {
    const pts = zone.points.filter((p) =>
      p.x >= rect.x0 && p.x <= rect.x1 && p.z >= rect.z0 && p.z <= rect.z1);
    if (pts.length < 2) continue;
    out.push({ id: zone.id, points: pts, centroid: centroidOf(pts) });
  }
  return out;
}

/** Cover points within `maxOff` metres of the zone→target line, projected
    order (far from target first). This is the future coverChain for the AI
    profile layer; the defend generator uses it to pace axis pushes. */
export function coverChain(zone, target, coverPoints, maxOff = 9, maxLen = 6) {
  if (!Array.isArray(coverPoints) || !coverPoints.length) return [];
  const ax = zone.centroid.x, az = zone.centroid.z;
  const dx = target.x - ax, dz = target.z - az;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const scored = [];
  for (const c of coverPoints) {
    const t = (c.x - ax) * ux + (c.z - az) * uz;
    if (t <= 2 || t >= len - 2) continue;
    const offX = ax + ux * t - c.x;
    const offZ = az + uz * t - c.z;
    const off = Math.hypot(offX, offZ);
    if (off > maxOff) continue;
    scored.push({ c, t });
  }
  scored.sort((a, b) => b.t - a.t);           // far from the target first
  return scored.slice(0, maxLen).map((s) => s.c);
}

/**
 * SURVIVAL — player-anchored multi-axis pressure that rotates between waves.
 *
 * Picks two zones per wave from different bearing sectors around the player
 * (front-ish + one blind), never reusing the zones burned in the last
 * ROTATION_MEMORY waves. Returns an ordered pick list; callers consume it
 * round-robin so the wave arrives from two axes at once.
 *
 * @returns {Array<{zone, point}>} one entry per requested enemy
 */
export function pickSurvivalSpawns({
  zones, playerPos, playerFacingDeg = 0, wave = 1, recentZones = [], count = 4,
  rng = Math.random,
}) {
  if (!zones || !zones.length || !playerPos || count <= 0) return [];
  const burned = new Set(recentZones.slice(-ROTATION_MEMORY));

  const scored = [];
  for (const zone of zones) {
    const d = Math.hypot(zone.centroid.x - playerPos.x, zone.centroid.z - playerPos.z);
    if (d < BAND_MIN * 0.6 || d > BAND_MAX * 1.6) continue;   // hard range gate
    const brg = bearingOf(playerPos, zone.centroid);
    const off = Math.abs(bearingDelta(brg, playerFacingDeg)); // 0 = dead ahead
    // far-engagement preference, blind-sector preference, rotation penalty
    const bandScore = 1 - Math.abs(d - (BAND_MIN + BAND_MAX) / 2) / (BAND_MAX - BAND_MIN);
    const blindScore = off / 180;                              // behind = 1
    const rotPenalty = burned.has(zone.id) ? 1.2 : 0;
    scored.push({ zone, brg, off, d, score: bandScore + blindScore - rotPenalty + rng() * 0.4 });
  }
  if (!scored.length) return [];

  // one zone from the FRONT half, one from the BLIND half, distinct sectors
  const front = scored.filter((s) => s.off <= 90).sort((a, b) => b.score - a.score);
  const blind = scored.filter((s) => s.off > 90).sort((a, b) => b.score - a.score);
  const first = front[0] || scored.sort((a, b) => b.score - a.score)[0];
  // blind pick avoids recently used zones while any alternative exists; from
  // wave 6 the whole map is fair game again (a long survival run must still
  // be allowed to come from somewhere)
  const pool = wave >= 6 ? scored : blind;
  let blindPool = pool.filter((s) => s.zone !== first.zone && !burned.has(s.zone.id));
  if (!blindPool.length) blindPool = pool.filter((s) => s.zone !== first.zone);
  const second = blindPool.sort((a, b) => b.score - a.score)[0] || null;
  const chosen = second ? [first, second] : [first];

  const picks = [];
  for (let i = 0; i < count; i += 1) {
    const sel = chosen[i % chosen.length];
    const point = sel.zone.points[Math.floor(rng() * sel.zone.points.length) % sel.zone.points.length];
    picks.push({ zone: sel.zone, point, blind: sel.off > 90 });
  }
  return picks;
}

/**
 * DEFEND — attack axes. Zones whose centroid "aims at" the objective
 * (approach bearing within `axisTol` of the true bearing) and sit in a
 * usable standoff band from it. Distinct axes are at least `minSpread`
 * apart so the player can read and pre-aim 2-3 corridors.
 */
export function pickDefendSpawns({
  zones, objective, coverPoints = [], count = 3,
  minSpread = 55, standMin = 22, standMax = 80,
  rng = Math.random,
}) {
  if (!zones || !zones.length || !objective) return [];

  const axes = [];
  for (const zone of zones) {
    const d = Math.hypot(zone.centroid.x - objective.x, zone.centroid.z - objective.z);
    if (d < standMin || d > standMax) continue;
    const toObj = bearingOf(zone.centroid, objective);
    const chain = coverChain(zone, objective, coverPoints);
    axes.push({ zone, d, toObj, chainDepth: chain.length, score: d + rng() * 14 });
  }
  if (!axes.length) return [];
  axes.sort((a, b) => a.score - b.score);

  const chosen = [];
  for (const ax of axes) {
    if (chosen.length >= count) break;
    // axes must attack the objective from DIFFERENT bearings: a near-0° delta
    // is the same corridor. A near-180° delta is the opposite end of the map
    // and IS a distinct axis, so only the small-delta case clashes.
    const clash = chosen.some((c) => Math.abs(bearingDelta(c.toObj, ax.toObj)) < minSpread);
    if (clash) continue;
    chosen.push(ax);
  }
  if (!chosen.length) chosen.push(axes[0]);

  const picks = [];
  for (let i = 0; i < count; i += 1) {
    const ax = chosen[i % chosen.length];
    // push starts at the zone's outer edge so the wave must fight DOWN the
    // corridor toward the objective instead of materialising beside it
    const points = ax.zone.points.slice().sort((a, b) =>
      Math.hypot(b.x - objective.x, b.z - objective.z) - Math.hypot(a.x - objective.x, a.z - objective.z));
    picks.push({ zone: ax.zone, point: points[i % points.length], axis: ax.toObj, chainDepth: ax.chainDepth });
  }
  return picks;
}

/**
 * EXTRACT — two phases.
 *  fortify: zones lying BETWEEN the player and the extraction zone (the
 *           corridor the player must fight through is pre-manned).
 *  pursuit: zones BEHIND the player (opposite the extract bearing) so the
 *           countdown starts with hunters on the extraction route's backdoor.
 */
export function pickExtractSpawns({
  zones, extractZone, playerPos, playerFacingDeg = 0, phase = 'fortify', count = 3,
  rng = Math.random,
}) {
  if (!zones || !zones.length || !extractZone || !playerPos) return [];
  const toExt = bearingOf(playerPos, extractZone);

  const scored = [];
  for (const zone of zones) {
    const dExt = Math.hypot(zone.centroid.x - extractZone.x, zone.centroid.z - extractZone.z);
    const brg = bearingOf(playerPos, zone.centroid);
    const off = bearingDelta(brg, toExt);        // 0 = on the way, 180 = behind
    if (phase === 'fortify') {
      if (dExt < 8 || dExt > 45) continue;
      if (Math.abs(off) > 60) continue;           // roughly on the route
      scored.push({ zone, score: 1 - Math.abs(off) / 60 + rng() * 0.5 });
    } else {
      // strictly behind-ish: the extract route bearing splits front/rear
      if (Math.abs(off) < 100) continue;
      const dPlayer = Math.hypot(zone.centroid.x - playerPos.x, zone.centroid.z - playerPos.z);
      if (dPlayer < 12) continue;
      scored.push({ zone, score: Math.min(1, dPlayer / 60) + rng() * 0.5 });
    }
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.max(1, Math.min(2, count)));

  const picks = [];
  for (let i = 0; i < count; i += 1) {
    const sel = top[i % top.length];
    const point = sel.zone.points[Math.floor(rng() * sel.zone.points.length) % sel.zone.points.length];
    picks.push({ zone: sel.zone, point, phase });
  }
  return picks;
}

/**
 * PLAYER SPAWN — site-anchored rotation with in-site randomisation.
 * CoD-style: the district rotates (caller's job); within the district we
 * pick among the district's own spawn points the one FARTHEST from the last
 * death, so the player cannot spawn-camp a fixed corner nor eat a random
 * 200 m walk. Falls back to the site anchor when the district has no points.
 */
export function pickPlayerSpawn({ zonePoints, site, lastDeathPos = null, rng = Math.random }) {
  // ground points only: roof/nav-link spawns are for AI, not the player
  const candidates = (zonePoints || []).filter((p) => {
    if ((p.y || 0) > 1) return false;
    if (!site || !site.rect) return true;
    return p.x >= site.rect.x0 && p.x <= site.rect.x1 && p.z >= site.rect.z0 && p.z <= site.rect.z1;
  });
  if (!candidates.length || !lastDeathPos) {
    const base = site || { x: 1.2, z: 33 };
    return { x: base.x + (rng() - 0.5) * 2, z: base.z + (rng() - 0.5) * 2, y: 0 };
  }
  let best = null, bestD = -1;
  for (const p of candidates) {
    const d = Math.hypot(p.x - lastDeathPos.x, p.z - lastDeathPos.z);
    const jittered = d + rng() * 6;              // break ties stochastically
    if (jittered > bestD) { bestD = jittered; best = p; }
  }
  return { x: best.x + (rng() - 0.5) * 1.6, z: best.z + (rng() - 0.5) * 1.6, y: best.y || 0 };
}

/** Convenience wrapper the host uses per wave. */
export function createSpawnDirector({ level, rng = Math.random } = {}) {
  const zones = level ? buildSpawnZones(level) : [];
  return {
    zones,
    pickSurvival: (opts) => pickSurvivalSpawns({ zones, rng, ...opts }),
    pickDefend: (opts) => pickDefendSpawns({ zones, rng, ...opts }),
    pickExtract: (opts) => pickExtractSpawns({ zones, rng, ...opts }),
    pickPlayerSpawn: (opts) => pickPlayerSpawn({ rng, ...opts }),
  };
}

export default createSpawnDirector;
