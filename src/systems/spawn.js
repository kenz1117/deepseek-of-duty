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
   sane plan (too few zones, nothing in range). Callers MUST fall back to the
   legacy pool picker on an empty result.

   Layering (the rule this file exists to enforce)
   ----------------------------------------------
   Three layers, and only the middle one is per-mode:

     1. SUBSTRATE (shared)  — distance rules, nav reachability, throttling,
                              spawn grace. Identical for every mode: a spawn
                              that cannot be walked to or cannot be perceived
                              is broken in every mode equally.
     2. SEMANTICS (per-mode)— WHICH side the wave comes from. This is the
                              only thing a mode generator decides, and it is
                              the part that must never be shared.
     3. RANDOMNESS (shared) — WHICH point inside that side. Pure jitter,
                              never a change of side.

   The old code collapsed 2 and 3: a 34% coin flip inside the flat point
   pool could move a wave to the player's rear, so the same mode produced
   different *geometry* on different waves. Randomness now lives strictly
   below the semantic decision: the generator picks the side, the jitter
   picks the metre.

   Why the analysis is POINT-level, not zone-level
   -----------------------------------------------
   The first cut of this file gated on the zone CENTROID. That is wrong on
   the real map: `container_yard` spans 120 m from (54,-93) to (108,24), so
   its centroid at (70,-67) represents no actual spawn point and sits 90 m
   from a player standing at the north end of the port. Centroid gating
   therefore rejected zones that held perfect spawn points, and accepted
   zones whose nearest point was 3 m from the player's feet.

   Every generator now collects the zone's CANDIDATE POINTS first (the
   points that satisfy the substrate), and decides the side from the
   candidate points' own bearings. The zone stays the unit of ROTATION
   (which region did we just use?) but not the unit of GEOMETRY.

   ========================================================================= */

/* ---- shared distance rules (single source of truth) ----------------------
   These used to live in two files under two names and drifted:
     - spawn.js  BAND_MIN/BAND_MAX (18/55) → zone-CENTROID band
     - main.js   SPAWN_BAND (20/46) + SPAWN_MAX (80) → POINT band
   Same words, different quantities. main.js now imports these instead of
   redefining its own, so a point can never be judged against a band that
   the generator was not aiming at. */
export const SPAWN_RULES = {
  /** Point band (m): where an enemy may actually materialise. A point
   *  outside this band is outside every soldier's engagement range. */
  pointMin: 20,
  pointMax: 46,
  /** Hard cap (m): beyond this nobody perceives anything at all. */
  hardMax: 80,
  /** Ideal distance from the player to the materialisation point (m). */
  idealPointDist: 30,
  /** Zone band (m): a zone whose candidates sit entirely outside this
   *  distance cannot host a wave. */
  zoneCentroidMin: 18,
  zoneCentroidMax: 55,
};

/** Bearing sector thresholds (deg off the player's facing).
 *  front = in the forward arc, flank = shoulder, rear = behind the back. */
const SECTOR_FLANK_DEG = 90;
const SECTOR_REAR_DEG = 130;

/** How many recent waves a zone stays "burned" for the survival rotator. */
const ROTATION_MEMORY = 2;

/* ---- deterministic randomness -------------------------------------------
   A wave plan has to be reproducible or it cannot be audited: "the wave that
   killed me landed 140 m away" is not a bug report you can act on. Every
   generator takes an rng so a caller can pin the stream; main.js derives a
   per-wave seed from the session seed and records it in the spawn audit. */

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  const s = parts.map((p) => String(p)).join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough, and identical across runs. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDEAL_SPAWN_DIST = SPAWN_RULES.idealPointDist;

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

/** Which sector a direction sits in, given the player's facing. */
function sectorOf(offDeg) {
  if (offDeg <= SECTOR_FLANK_DEG) return 'front';
  if (offDeg <= SECTOR_REAR_DEG) return 'flank';
  return 'rear';
}

/** Bearing offset (deg) of a point from the player, measured against the
 *  player's facing. 0 = dead ahead, 180 = directly behind. */
function pointOffsetDeg(playerPos, point, playerFacingDeg) {
  const brg = bearingOf(playerPos, point);
  return Math.abs(bearingDelta(brg, playerFacingDeg));
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

/* ---- candidate collection ------------------------------------------------
   The substrate layer: which points of a zone may host a spawn at all. A
   candidate is a point that satisfies the shared distance rules, and it
   carries its own bearing so the semantic layer can work on real geometry
   instead of a zone-average.

   The band is the hard rule: a point outside it is not a usable spawn,
   because a wave that starts 78 m away never fights. Points beyond the
   band are collected separately as `far` and used ONLY when a district
   genuinely has nothing inside the band — a wave that arrives late beats a
   wave that never arrives. */

function bandFor(relaxed) {
  return relaxed
    ? { min: SPAWN_RULES.pointMin * 0.7, max: SPAWN_RULES.pointMax * 1.5 }
    : { min: SPAWN_RULES.pointMin, max: SPAWN_RULES.pointMax };
}

/** Collect a zone's spawn candidates relative to the player. */
function candidatesFor(zone, playerPos, playerFacingDeg, band) {
  const out = [];
  for (const p of zone.points) {
    const d = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
    if (d < band.min || d > band.max) continue;
    const off = pointOffsetDeg(playerPos, p, playerFacingDeg);
    out.push({ p, d, off, sector: sectorOf(off), inBand: true });
  }
  return out;
}

/** Collect a zone's points that are reachable but outside the band. */
function farCandidatesFor(zone, playerPos, playerFacingDeg, band) {
  const out = [];
  const maxD = Math.max(band.max, SPAWN_RULES.hardMax);
  for (const p of zone.points) {
    const d = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
    if (d < band.min || d > maxD) continue;
    const off = pointOffsetDeg(playerPos, p, playerFacingDeg);
    out.push({ p, d, off, sector: sectorOf(off), inBand: false });
  }
  return out;
}

/** Best candidate by distance to the ideal, with jitter to break ties.
 *  In-band candidates always win over out-of-band ones. */
function bestCandidate(cands, rng, jitter = 9) {
  let best = null, bestScore = Infinity;
  for (const c of cands) {
    const penalty = c.inBand === false ? 30 : 0;
    const score = Math.abs(c.d - IDEAL_SPAWN_DIST) + penalty + rng() * jitter;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/**
 * SURVIVAL — player-anchored multi-axis pressure that rotates between waves.
 *
 * Picks up to three axes per wave from different bearing sectors around the
 * player (front / flank / rear), never reusing the zones burned in the last
 * ROTATION_MEMORY waves. The wave is then allocated across those axes so
 * that no more than ~1/3 of it arrives from behind the player's back.
 *
 * @returns {Array<{zone, point, blind, off, sector}>} one entry per enemy
 */
export function pickSurvivalSpawns({
  zones, playerPos, playerFacingDeg = 0, wave = 1, recentZones = [], count = 4,
  rng = Math.random, relaxed = false,
}) {
  if (!zones || !zones.length || !playerPos || count <= 0) return [];
  const burned = new Set(recentZones.slice(-ROTATION_MEMORY));
  const band = bandFor(relaxed);

  /* Zone -> its in-band candidates. A zone with no candidate cannot host
     this wave; this is the point-level replacement for the old centroid
     gate, and it is what lets a 120 m wide region still serve a wave from
     the end the player is standing at. */
  const zc = [];
  for (const zone of zones) {
    const cands = candidatesFor(zone, playerPos, playerFacingDeg, band);
    if (!cands.length) continue;
    zc.push({ zone, cands });
  }
  if (!zc.length) return [];

  /* Choose one zone per bearing sector. Rotation is a HARD preference
     here, not a score bonus: a burned zone is only reused when no fresh
     zone can serve that sector at all.

     Each axis carries ONLY the candidates of its own sector. An axis that
     could hand out a point from another sector would break the very
     promise it was chosen to keep — that is how a "front" wave ended up
     landing behind the player. */
  const usedZones = new Set();
  const axes = [];
  for (const sector of ['front', 'flank', 'rear']) {
    const inSector = zc
      .map((z) => ({ z, cands: z.cands.filter((c) => c.sector === sector) }))
      .filter((e) => e.cands.length);
    if (!inSector.length) continue;

    const rank = (e) => {
      const fresh = burned.has(e.z.zone.id) ? 1 : 0;
      const dup = usedZones.has(e.z.zone.id) ? 1 : 0;
      return fresh * 4 + dup * 2;         // fresh + unused wins outright
    };
    inSector.sort((a, b) => rank(a) - rank(b));
    const fresh = inSector.filter((e) => rank(e) === 0);
    const pool = fresh.length ? fresh : inSector;
    /* Among equally-ranked zones, prefer the one whose best candidate sits
       closest to the ideal engagement distance. The jitter here is what
       makes two seeds pick different zones: with a tiny jitter the distance
       term dominated and every session produced the same three zones, so
       the seed bought nothing. */
    let best = null, bestScore = Infinity;
    for (const e of pool) {
      const c = bestCandidate(e.cands, rng, 0);
      if (!c) continue;
      const score = Math.abs(c.d - IDEAL_SPAWN_DIST) + rank(e) * 40 + rng() * 9;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (!best) continue;
    usedZones.add(best.z.zone.id);
    axes.push({ sector, zone: best.z.zone, cands: best.cands });
  }
  if (!axes.length) return [];

  /* Allocate the wave across the axes. The rear axis is capped at ~1/3 of
     the wave: a soldier arriving from behind starts its reaction clock
     before the player can turn, which is the "shot from nowhere" feeling
     the old picker kept producing by accident.

     Quotas are explicit rather than round-robin: a round-robin let the
     rear axis claim a third of the wave by luck of the order, and let the
     front axis hand out rear points when it ran out of its own. */
  const rearAxes = axes.filter((a) => a.sector === 'rear');
  const frontAxes = axes.filter((a) => a.sector !== 'rear');
  const rearCap = Math.max(1, Math.ceil(count / 3));
  const rearQuota = rearAxes.length ? Math.min(rearCap, count) : 0;
  const frontQuota = count - rearQuota;

  const picks = [];
  const usedPoints = new Set();
  const takeFrom = (axis, budget) => {
    const pool = axis.cands.filter((c) => !usedPoints.has(`${c.p.x.toFixed(1)}:${c.p.z.toFixed(1)}`));
    if (!pool.length) return 0;
    const c = bestCandidate(pool, rng);
    if (!c) return 0;
    usedPoints.add(`${c.p.x.toFixed(1)}:${c.p.z.toFixed(1)}`);
    picks.push({
      zone: axis.zone,
      point: c.p,
      off: c.off,
      sector: c.sector,
      blind: c.off > SECTOR_REAR_DEG,      // behind the player's back
    });
    return 1;
  };

  /* Front/flank first: those are the axes the player can actually see
     coming. If they run out of points, the wave is topped up from the
     rear axis rather than shrinking. */
  let frontDone = 0;
  let fi = 0;
  while (frontDone < frontQuota && fi < count * 8) {
    const axis = frontAxes[fi % frontAxes.length];
    fi++;
    if (!axis) break;
    frontDone += takeFrom(axis, frontQuota);
  }
  let rearDone = 0;
  let ri = 0;
  while (rearDone < rearQuota && ri < count * 8) {
    const axis = rearAxes[ri % rearAxes.length];
    ri++;
    if (!axis) break;
    rearDone += takeFrom(axis, rearQuota);
  }
  /* Top up: a wave that is short is a wave that never starts. But the top-up
     prefers the FLANK over the rear — a shoulder arrival is still something
     the player can turn into, while a rear arrival starts the enemy's
     reaction clock first. Only when nothing else is left does the rear
     axis get the overflow. */
  let guard = 0;
  while (picks.length < count && guard++ < count * 8) {
    let taken = 0;
    for (const axis of frontAxes) {
      if (picks.length >= count) break;
      taken += takeFrom(axis, count);
    }
    if (taken) continue;
    for (const axis of rearAxes) {
      if (picks.length >= count) break;
      taken += takeFrom(axis, count);
    }
    if (!taken) break;
  }
  return picks;
}

/**
 * DEFEND — attack axes. A zone can host an axis when it holds points that
 * stand off from the objective at a usable distance, and when its approach
 * bearing differs from the axes already chosen (a second zone on the same
 * corridor is not a second axis).
 *
 * The axis bearing is taken from the zone's own standoff CANDIDATES, not
 * from its centroid: the objective can sit inside a wide zone, and then the
 * centroid says nothing about where the enemy would actually appear.
 */
export function pickDefendSpawns({
  zones, objective, coverPoints = [], count = 3,
  minSpread = 55, standMin = 22, standMax = 80,
  rng = Math.random, relaxed = false, playerPos = null, playerFacingDeg = 0,
}) {
  if (!zones || !zones.length || !objective) return [];
  if (relaxed) {
    standMin = Math.max(8, standMin * 0.5);
    standMax = standMax * 1.6;
    minSpread = Math.max(20, minSpread * 0.5);
  }

  const axes = [];
  for (const zone of zones) {
    /* Standoff candidates: points that sit at a usable distance FROM the
       objective, i.e. far enough to fight down a corridor, close enough to
       reach it. */
    const cands = [];
    for (const p of zone.points) {
      const dObj = Math.hypot(p.x - objective.x, p.z - objective.z);
      if (dObj < standMin || dObj > standMax) continue;
      cands.push({ p, dObj, brg: bearingOf(p, objective) });
    }
    if (!cands.length) continue;
    /* If the player is known, the spawn must also be inside the player's
       engagement band — otherwise the wave arrives in a corridor the player
       cannot even perceive. When the player is unknown (unit tests, level
       design queries) the objective-relative standoff is the only rule. */
    let usable = cands;
    if (playerPos) {
      const band = bandFor(relaxed);
      const near = cands.filter((c) => {
        const d = Math.hypot(c.p.x - playerPos.x, c.p.z - playerPos.z);
        return d >= band.min && d <= band.max;
      });
      if (near.length) usable = near;
    }
    const chain = coverChain(zone, objective, coverPoints);
    axes.push({
      zone, cands: usable,
      toObj: circularMean(usable.map((c) => c.brg)),
      chainDepth: chain.length,
      score: Math.min(...usable.map((c) => c.dObj)) + rng() * 14,
    });
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
  for (let i = 0; i < count; i++) {
    const ax = chosen[i % chosen.length];
    // push starts at the zone's outer edge so the wave must fight DOWN the
    // corridor toward the objective instead of materialising beside it
    const sorted = ax.cands.slice().sort((a, b) => b.dObj - a.dObj);
    const c = sorted[i % sorted.length];
    picks.push({
      zone: ax.zone,
      point: c.p,
      axis: ax.toObj,
      chainDepth: ax.chainDepth,
    });
  }
  return picks;
}

/**
 * EXTRACT — two phases.
 *  fortify: the corridor BETWEEN the player and the extraction zone is
 *           pre-manned — the player must fight through it.
 *  pursuit: once the countdown starts, hunters come from the player's
 *           back door — the direction OPPOSITE the extraction route.
 *
 * Both phases are geometric. The corridor test projects the candidate onto
 * the player→extract SEGMENT and measures the perpendicular distance to it,
 * instead of comparing raw bearings: a raw bearing offset says "this point
 * is 60° off the route", but a corridor is a LINE, and on a real map the
 * spawn points near a route are often 60-80° off its bearing while still
 * standing in the corridor itself. Projecting onto the segment gets both
 * cases right.
 *
 * The pursuit phase prefers points as far behind the route as the map
 * allows. When a district has nothing genuinely behind the player, the
 * best available direction is used rather than no wave at all — a pursuit
 * wave that arrives from the least-bad angle beats a pursuit wave that
 * never arrives.
 */
export function pickExtractSpawns({
  zones, extractZone, playerPos, playerFacingDeg = 0, phase = 'fortify', count = 3,
  rng = Math.random, relaxed = false,
}) {
  if (!zones || !zones.length || !extractZone || !playerPos) return [];
  const toExt = bearingOf(playerPos, extractZone);
  const offLimit = relaxed ? 120 : 90;
  const corridorMax = relaxed ? 48 : 34;     // max perpendicular distance to the route
  const pursuitFloor = relaxed ? 70 : 100;    // min |offset| to count as "behind"
  const band = bandFor(relaxed);

  /* The player→extract segment, in the form the corridor test needs. */
  const segX = extractZone.x - playerPos.x;
  const segZ = extractZone.z - playerPos.z;
  const segLen = Math.hypot(segX, segZ) || 1;
  const segUx = segX / segLen;
  const segUz = segZ / segLen;

  const scored = [];
  for (const zone of zones) {
    const cands = [];
    for (const p of zone.points) {
      const dPlayer = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (dPlayer < band.min || dPlayer > band.max) continue;
      const dExt = Math.hypot(p.x - extractZone.x, p.z - extractZone.z);
      const rx = p.x - playerPos.x;
      const rz = p.z - playerPos.z;
      const along = rx * segUx + rz * segUz;          // metres along the route
      const perp = Math.abs(rx * segUz - rz * segUx);  // metres off the route
      const off = bearingDelta(bearingOf(playerPos, p), toExt);

      if (phase === 'fortify') {
        // on the corridor: between the player and the extract, and near the
        // line. The along/perp test IS the corridor definition; the dExt
        // bound is only a sanity net, so it stays generous.
        if (along < 2 || along > segLen * 1.3) continue;
        if (perp > corridorMax) continue;
        const dExtMax = relaxed ? 150 : 110;
        if (dExt < 3 || dExt > dExtMax) continue;
        cands.push({ p, dPlayer, dExt, off, along, perp,
          score: (1 - perp / corridorMax) * 0.7 + (1 - dExt / dExtMax) * 0.3 });
      } else {
        // behind: opposite the route. The corridor test does not apply here
        // — the hunters come from the player's BACK DOOR, not the route.
        if (Math.abs(off) < 20) continue;               // straight ahead or straight back: not a back door
        cands.push({ p, dPlayer, dExt, off, along, perp,
          score: Math.min(1, Math.abs(off) / 180) + Math.min(1, dPlayer / 60) * 0.4 });
      }
    }
    if (!cands.length) continue;
    for (const c of cands) c.score += rng() * 0.5;
    scored.push({ zone, cands });
  }
  if (!scored.length) return [];

  if (phase === 'pursuit') {
    /* Keep only the genuinely-behind candidates when the district has any.
       Without this filter a FLANK point (90° off the route) sat in the
       same pool as a real back-door point and could win on distance, so the
       "pursuit" wave arrived from the side — which is the opposite of what
       the phase is for. */
    const behind = [];
    for (const s of scored) {
      const c = s.cands.filter((x) => Math.abs(x.off) >= pursuitFloor);
      if (c.length) behind.push({ zone: s.zone, cands: c });
    }
    if (behind.length) {
      scored.length = 0;
      scored.push(...behind);
    } else {
      /* Nothing is genuinely behind the player in this district: use the
         most-behind direction available rather than dropping the wave. */
      const fallback = [];
      for (const s of scored) {
        for (const c of s.cands) fallback.push({ zone: s.zone, cands: [c] });
      }
      if (!fallback.length) return [];
      fallback.sort((a, b) => Math.abs(b.cands[0].off) - Math.abs(a.cands[0].off));
      scored.length = 0;
      scored.push(...fallback.slice(0, Math.max(1, Math.min(2, count))));
    }
  }

  scored.sort((a, b) => Math.max(...b.cands.map((c) => c.score)) - Math.max(...a.cands.map((c) => c.score)));
  const top = scored.slice(0, Math.max(1, Math.min(2, count)));

  const picks = [];
  for (let i = 0; i < count; i++) {
    const sel = top[i % top.length];
    /* The zone picks the side; the point inside it is chosen by how well it
       serves that side: for fortify that means sitting TIGHT on the route
       (small perpendicular distance), for pursuit it means being as far
       behind the route as possible. */
    const desired = phase === 'fortify' ? toExt : toExt + 180;
    const withDev = sel.cands.map((c) => ({
      c,
      dev: phase === 'fortify'
        ? c.perp
        : Math.abs(bearingDelta(bearingOf(playerPos, c.p), desired)),
    }));
    const aligned = phase === 'fortify'
      ? withDev.filter((e) => e.dev <= corridorMax * 0.7)
      : withDev.filter((e) => e.dev <= 90);
    const pool = aligned.length ? aligned : withDev;
    let best = null, bestScore = Infinity;
    for (const e of pool) {
      const score = Math.abs(e.c.dPlayer - IDEAL_SPAWN_DIST) + e.dev * 1.5 + rng() * 9;
      if (score < bestScore) { bestScore = score; best = e.c; }
    }
    if (!best) continue;
    const off = pointOffsetDeg(playerPos, best.p, playerFacingDeg);
    picks.push({
      zone: sel.zone,
      point: best.p,
      off,
      sector: sectorOf(off),
      blind: off > SECTOR_REAR_DEG,
      phase,
    });
  }
  return picks;
}

/**
 * NEUTRAL FALLBACK — the last resort before the legacy flat pool.
 *
 * It carries no mode semantics on purpose: it is used when a mode generator
 * could not produce a plan at all (the player pushed into a corner of the
 * map, the objective moved out of range). What it does guarantee is the
 * SUBSTRATE contract every mode shares: every point sits inside the
 * engagement band, so the wave can actually fight. The old fallback rolled
 * a 34% coin flip for a flank, which meant the same mode could change the
 * SIDE of the map between waves — the one thing a mode must never do.
 */
export function pickNeutralSpawns({ zones, playerPos, count = 3, rng = Math.random, playerFacingDeg = 0 }) {
  if (!zones || !zones.length || !playerPos) return [];
  const band = { min: SPAWN_RULES.pointMin, max: SPAWN_RULES.pointMax };
  const perZone = [];
  for (const zone of zones) {
    const cands = candidatesFor(zone, playerPos, playerFacingDeg, band);
    if (!cands.length) continue;
    const best = bestCandidate(cands, rng);
    if (!best) continue;
    perZone.push({ zone, cands, best });
  }
  if (!perZone.length) return [];
  perZone.sort((a, b) => Math.abs(a.best.d - IDEAL_SPAWN_DIST) - Math.abs(b.best.d - IDEAL_SPAWN_DIST));

  const picks = [];
  const used = new Set();
  let round = 0;
  while (picks.length < count && round < perZone.length * 3) {
    for (const sel of perZone) {
      if (picks.length >= count) break;
      const pool = sel.cands.filter((c) => !used.has(`${c.p.x.toFixed(1)}:${c.p.z.toFixed(1)}`));
      if (!pool.length) continue;
      const c = bestCandidate(pool, rng);
      if (!c) continue;
      used.add(`${c.p.x.toFixed(1)}:${c.p.z.toFixed(1)}`);
      picks.push({
        zone: sel.zone,
        point: c.p,
        off: c.off,
        sector: c.sector,
        blind: c.off > SECTOR_REAR_DEG,
        fallback: true,
      });
    }
    round++;
  }
  return picks;
}

/**
 * PLAYER SPAWN — site-anchored rotation with in-site randomisation.
 * CoD-style: the district rotates (caller's job); within the district we
 * pick among the district's own spawn points the one FARTHEST from the
 * last death, so the player cannot spawn-camp a fixed corner nor eat a
 * random 200 m walk. Falls back to the site anchor when the district has no
 * points.
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

/**
 * CO-OP RALLY — spread a squad over a rally point.
 *
 * A LAN squad must land TOGETHER (that is the co-op fantasy) but not ON
 * TOP of each other: four bodies on one coordinate means the grenades
 * friendly-fire the med-kit and nobody can move.
 *
 * Every peer computes the SAME layout from the SAME player list, so no
 * extra sync round-trip is needed: the slot is chosen by the player's
 * position in the sorted id list, and the ring radius grows with the squad
 * size so the minimum separation between neighbours holds.
 *
 * @param {string[]} playerIds  every player in the match (any order)
 * @param {string}   selfId     the local player
 */
export function assignCoopRallySpot({ site, playerIds = [], selfId, minGap = 2.6, seed = 0 }) {
  const base = site || { x: 1.2, z: 33 };
  const ids = [...new Set((playerIds || []).map((id) => String(id)))]
    .sort();
  if (!ids.length) return { x: base.x, z: base.z };
  const mine = String(selfId);
  let idx = ids.indexOf(mine);
  if (idx < 0) idx = 0;
  const n = ids.length;

  /* Ring radius from the minimum gap: neighbours on the ring sit
     2R·sin(π/n) apart, so R = gap / (2·sin(π/n)). The 1.15 factor absorbs
     the angular jitter below — without it, two neighbours can drift a few
     degrees towards each other and end up closer than the minimum. */
  const sinHalf = Math.sin(Math.PI / Math.max(2, n));
  const radius = n <= 1 ? 0 : Math.max(minGap / (2 * Math.max(0.15, sinHalf)), 1.6) * 1.15;

  /* Angle from the id itself (not the index) so a peer that sees a
     different id list still lands somewhere sane rather than on top of
     somebody else; the index keeps the ring evenly filled. The jitter is
     small enough that the minimum separation still holds. */
  const h = hashSeed(seed, mine);
  const jitter = ((h % 1000) / 1000 - 0.5) * (Math.PI * 2 / n) * 0.15;
  const a = (idx / n) * Math.PI * 2 + jitter;

  return {
    x: base.x + Math.cos(a) * radius,
    z: base.z + Math.sin(a) * radius,
  };
}

/** Circular mean of a set of bearings (deg) — the "average direction"
 *  of a group of points, without the 0/360 wrap artefact. */
function circularMean(bearings) {
  if (!bearings.length) return 0;
  let sx = 0, sy = 0;
  for (const b of bearings) {
    sx += Math.cos(b * Math.PI / 180);
    sy += Math.sin(b * Math.PI / 180);
  }
  if (!sx && !sy) return bearings[0];
  return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
}

/** Convenience wrapper the host uses per wave. */
export function createSpawnDirector({ level, rng = Math.random } = {}) {
  const zones = level ? buildSpawnZones(level) : [];
  return {
    zones,
    pickSurvival: (opts) => pickSurvivalSpawns({ zones, rng, ...opts }),
    pickDefend: (opts) => pickDefendSpawns({ zones, rng, ...opts }),
    pickExtract: (opts) => pickExtractSpawns({ zones, rng, ...opts }),
    pickNeutral: (opts) => pickNeutralSpawns({ zones, rng, ...opts }),
    pickPlayerSpawn: (opts) => pickPlayerSpawn({ rng, ...opts }),
    assignCoopRallySpot: (opts) => assignCoopRallySpot({ ...opts }),
  };
}

export default createSpawnDirector;
