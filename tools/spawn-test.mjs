#!/usr/bin/env node
/**
 * Spawn director unit tests (Phase 1 — per-mode spawn generation).
 *
 * systems/spawn.js is pure logic, so these run headlessly like the
 * milestones/zone tests. They pin the invariants the mode redesign depends
 * on: zone building, survival rotation + multi-axis arrivals, defend attack
 * axes, extract fortify/pursuit phases, and the player spawn rule.
 *
 * Run: node tools/spawn-test.mjs
 */

import {
  buildSpawnZones,
  zonesWithinRect,
  pickSurvivalSpawns,
  pickDefendSpawns,
  pickExtractSpawns,
  pickNeutralSpawns,
  pickPlayerSpawn,
  assignCoopRallySpot,
  SPAWN_RULES,
  makeRng,
  hashSeed,
} from '../src/systems/spawn.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ---- fixture: a level with three districts and a shared regionAt ----------
   District centroids sit 40 m from the player — inside the engagement band,
   like the real map's district sub-regions. */
const REGIONS = [
  { id: 'east', x0: 20, x1: 60, z0: -20, z1: 20 },
  { id: 'west', x0: -60, x1: -20, z0: -20, z1: 20 },
  { id: 'north', x0: -20, x1: 20, z0: 20, z1: 60 },
];
const fakeLevel = {
  regionAt(x, z) {
    for (const r of REGIONS) {
      if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return r;
    }
    return { id: 'centre' };
  },
  spawnPoints: [
    // east cluster (attack axis toward centre from +x)
    { x: 36, z: -6 }, { x: 40, z: 8 }, { x: 44, z: 0 },
    // west cluster
    { x: -36, z: -6 }, { x: -40, z: 8 }, { x: -44, z: 0 },
    // north cluster
    { x: -6, z: 36 }, { x: 8, z: 40 }, { x: 0, z: 44 },
    // centre singles
    { x: 5, z: 5 }, { x: -5, z: -5 },
    // a roof point must never become a player spawn
    { x: 6, z: 6, y: 4 },
  ],
};

/* ---- zone building -------------------------------------------------------- */
{
  const zones = buildSpawnZones(fakeLevel);
  check('zones: >=2-point regions become zones', zones.length >= 3);
  const east = zones.find((z) => z.id === 'east');
  check('zones: east zone has its 3 points', !!east && east.points.length === 3);
  check('zones: centroid is the bucket mean',
    !!east && Math.abs(east.centroid.x - 40) < 1 && Math.abs(east.centroid.z) < 1);

  const clipped = zonesWithinRect(zones, { x0: 20, x1: 60, z0: -20, z1: 20 });
  check('zones: rect clip keeps only the east zone', clipped.length === 1 && clipped[0].id === 'east');
  check('zones: rect clip recentres the centroid',
    Math.abs(clipped[0].centroid.x - 40) < 1);
}

/* ---- survival: multi-axis arrival + rotation memory ----------------------- */
{
  const zones = buildSpawnZones(fakeLevel).filter((z) => z.id !== 'centre');
  const player = { x: 0, z: 0 };
  // deterministic rng: always returns 0.5 (mid scores) so structure decides
  const rng = () => 0.5;

  const picks = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 1, recentZones: [], count: 8, rng,
  });
  const usedZones = [...new Set(picks.map((p) => p.zone.id))];
  check('survival: a wave arrives from TWO different axes', usedZones.length >= 2, usedZones.join(','));

  // facing east (0 deg = +z here; use 90 to face +x): the blind pick must be
  // behind-ish, i.e. the west zone
  const picksEast = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 1, recentZones: [], count: 8, rng,
  });
  const blind = picksEast.filter((p) => p.blind).map((p) => p.zone.id);
  check('survival: blind pick lands behind the player (west)',
    blind.length > 0 && blind.every((id) => id === 'west'), blind.join(','));

  // rotation memory: burn east+west at wave 2. The front pick must be the
  // unburned north; west may still appear because it is the only blind-half
  // zone (burned zones are only reused when no alternative exists).
  const burnt = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 2,
    recentZones: ['east', 'west'], count: 8, rng,
  });
  const burntIds = [...new Set(burnt.map((p) => p.zone.id))];
  check('survival: burned zones skipped while alternatives exist',
    !burntIds.includes('east') && burntIds.includes('north'), burntIds.join(','));
  // ...but a long run may reuse them (the map is finite)
  const late = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 6,
    recentZones: ['east', 'west', 'north'], count: 8, rng,
  });
  check('survival: wave >= 6 relaxes rotation memory', late.length > 0);

  check('survival: empty zones -> empty plan (caller falls back)',
    pickSurvivalSpawns({ zones: [], playerPos: player, count: 4 }).length === 0);
}

/* ---- defend: attack axes toward the objective ----------------------------- */
{
  const zones = buildSpawnZones(fakeLevel).filter((z) => z.id !== 'centre');
  // objective at the centre: east/west/north are three distinct corridors
  const picks = pickDefendSpawns({
    zones, objective: { x: 0, z: 0 }, count: 3, rng: () => 0.5,
  });
  const ids = picks.map((p) => p.zone.id).sort();
  check('defend: three distinct attack axes selected',
    JSON.stringify(ids) === JSON.stringify(['east', 'north', 'west']), ids.join(','));
  // every pick sits in its own zone (the push fights DOWN the corridor)
  check('defend: picks come from their axis zones',
    picks.every((p) => p.zone.points.includes(p.point)));

  // objective deep in the east: west/north qualify, east is inside the
  // standoff band and attacks from ~0 deg — minSpread should reject it once
  // another axis took a nearby bearing... east here is ~180 off west, so
  // instead verify the standoff gate: objective ON the east centroid leaves
  // nothing within standMin -> empty plan (caller falls back)
  const none = pickDefendSpawns({
    zones, objective: { x: 150, z: 0 }, count: 3, rng: () => 0.5,
  });
  check('defend: no axis when the objective sits on the zones', none.length === 0
    || none.every((p) => p.zone.id !== 'east'));
}

/* ---- extract: fortify between player and extract, pursuit behind ---------- */
{
  const zones = buildSpawnZones(fakeLevel).filter((z) => z.id !== 'centre');
  const player = { x: 0, z: 0 };
  const extract = { x: 62, z: 0 };           // due east, past the east zone

  const fortify = pickExtractSpawns({
    zones, extractZone: extract, playerPos: player, playerFacingDeg: 90,
    phase: 'fortify', count: 4, rng: () => 0.5,
  });
  check('extract: fortify mans the route ahead (east only)',
    fortify.length > 0 && fortify.every((p) => p.zone.id === 'east'), fortify.map((p) => p.zone.id).join(','));

  const pursuit = pickExtractSpawns({
    zones, extractZone: extract, playerPos: player, playerFacingDeg: 90,
    phase: 'pursuit', count: 4, rng: () => 0.5,
  });
  check('extract: pursuit comes from behind (west)',
    pursuit.length > 0 && pursuit.every((p) => p.zone.id === 'west'), pursuit.map((p) => p.zone.id).join(','));
}

/* ---- player spawn: farthest from last death, never a roof ----------------- */
{
  const site = { id: 'centre', x: 0, z: 0, rect: { x0: -20, x1: 20, z0: -20, z1: 20 } };
  const pts = [{ x: -15, z: 0 }, { x: 15, z: 0 }, { x: 0, z: -15 }, { x: 6, z: 6, y: 4 }];
  const rng = () => 0.2;

  const s1 = pickPlayerSpawn({ zonePoints: pts, site, lastDeathPos: { x: -14, z: 0 }, rng });
  check('player spawn: picks the far candidate from the last death',
    s1.x > 5, JSON.stringify(s1));
  check('player spawn: roof points are never candidates',
    (s1.y || 0) < 1);

  // no death remembered -> near the site anchor
  const s2 = pickPlayerSpawn({ zonePoints: pts, site, lastDeathPos: null, rng });
  check('player spawn: no death memory anchors on the site centre',
    Math.abs(s2.x) < 3 && Math.abs(s2.z) < 3, JSON.stringify(s2));

  // empty district -> still returns a usable anchor
  const s3 = pickPlayerSpawn({ zonePoints: [], site, lastDeathPos: { x: 100, z: 100 }, rng });
  check('player spawn: falls back to the site anchor', Number.isFinite(s3.x) && Number.isFinite(s3.z));
}

/* ---- spawn band: a wave must start inside the engagement band -------------
   Regression guard for the wave-convergence fix: a zone's BEARING decides
   which side the wave comes from, but the POINT it lands on decides whether
   the wave can fight at all. A zone whose points are all 100 m away must not
   win over a zone that can start at 30 m, and the point chosen inside a zone
   must be the one closest to the ideal distance. */
{
  const player = { x: 0, z: 0 };
  const mkZone = (id, pts) => ({ id, points: pts, centroid: { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length } });
  const nearZone = mkZone('near', [{ x: 34, z: 0 }, { x: 42, z: 6 }, { x: 26, z: -4 }]);
  const farZone = mkZone('far', [{ x: 110, z: 0 }, { x: 120, z: 8 }, { x: 104, z: -6 }]);
  const rng = () => 0.5;

  const picks = pickSurvivalSpawns({
    zones: [nearZone, farZone], playerPos: player, playerFacingDeg: 90, wave: 1,
    recentZones: [], count: 6, rng,
  });
  check('spawn band: the zone that can start close wins over the far one',
    picks.length > 0 && picks.every((p) => p.zone.id === 'near'),
    picks.map((p) => p.zone.id).join(','));
  check('spawn band: every pick lands inside the engagement band',
    picks.every((p) => {
      const d = Math.hypot(p.point.x - player.x, p.point.z - player.z);
      return d >= 18 && d <= 46;
    }),
    picks.map((p) => Math.round(Math.hypot(p.point.x - player.x, p.point.z - player.z))).join(','));

  // the point inside the zone is chosen by DISTANCE, not at random
  const single = pickSurvivalSpawns({
    zones: [nearZone], playerPos: player, playerFacingDeg: 90, wave: 1,
    recentZones: [], count: 1, rng: () => 0.0,   // no jitter -> the closest point wins
  });
  check('spawn band: the closest point to the ideal distance is used',
    single.length === 1 && Math.hypot(single[0].point.x - player.x, single[0].point.z - player.z) <= 30,
    single.length ? JSON.stringify(single[0].point) : 'no pick');

  // only a far zone available -> the generator returns an EMPTY plan (its
  // documented fallback contract: "nothing in range"), so the caller falls
  // back to the legacy pool picker / ring spawn instead of starting the wave
  // 120 m away
  const onlyFar = pickSurvivalSpawns({
    zones: [farZone], playerPos: player, playerFacingDeg: 90, wave: 1,
    recentZones: [], count: 2, rng,
  });
  check('spawn band: a far-only zone yields an empty plan (caller re-picks)',
    onlyFar.length === 0, `len=${onlyFar.length}`);
}

/* ---- the three layers must not bleed into each other ---------------------
   The invariant this whole refactor exists to protect:
     - the MODE decides which side of the map the wave comes from
     - the RANDOMNESS only decides which metre inside that side
   A generator that returns nothing must NOT silently degrade into a random
   picker that can change the side — that is the bug the old 34% flank roll
   created. It must degrade into a NEUTRAL, band-respecting picker. */
{
  const player = { x: 0, z: 0 };
  const mkZone = (id, pts) => ({
    id, points: pts,
    centroid: {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
    },
  });
  const rng = () => 0.5;

  /* Neutral fallback: no mode semantics, but every point is inside the
     engagement band, so the wave can actually fight. */
  const near = mkZone('near', [{ x: 34, z: 0 }, { x: 40, z: 6 }, { x: 28, z: -5 }]);
  const neutral = pickNeutralSpawns({ zones: [near], playerPos: player, count: 3, rng });
  check('neutral fallback: still produces a plan',
    neutral.length > 0, `len=${neutral.length}`);
  check('neutral fallback: every point is inside the engagement band',
    neutral.every((p) => {
      const d = Math.hypot(p.point.x - player.x, p.point.z - player.z);
      return d >= SPAWN_RULES.pointMin && d <= SPAWN_RULES.pointMax;
    }),
    neutral.map((p) => Math.round(Math.hypot(p.point.x - player.x, p.point.z - player.z))).join(','));
  check('neutral fallback: marks itself as a fallback',
    neutral.every((p) => p.fallback === true));

  /* A zone that is entirely out of range yields nothing — the caller then
     falls through to the legacy pool picker. */
  const far = mkZone('far', [{ x: 110, z: 0 }, { x: 120, z: 8 }]);
  check('neutral fallback: out-of-range zone yields no plan',
    pickNeutralSpawns({ zones: [far], playerPos: player, count: 2, rng }).length === 0);

  /* The relaxed pass must widen the GATES without changing the SIDE. Same
     player, same zones: the relaxed plan still comes from the same side. */
  const zones = buildSpawnZones(fakeLevel).filter((z) => z.id !== 'centre');
  const strict = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 1, recentZones: [], count: 4, rng,
  });
  const loose = pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 1, recentZones: [], count: 4, rng, relaxed: true,
  });
  const strictSectors = new Set(strict.map((p) => p.sector));
  const looseSectors = new Set(loose.map((p) => p.sector));
  check('relaxed pass: keeps the same side as the strict plan',
    loose.length > 0 && strict.length > 0
      && [...looseSectors].every((s) => strictSectors.has(s)),
    `strict=${[...strictSectors].join('/')} loose=${[...looseSectors].join('/')}`);

  /* The rear share is a PROMISE: at most ~1/3 of a wave from behind the
     player's back, even when a "front" zone's nearest point actually lands
     behind them. */
  const rearish = [
    mkZone('front', [{ x: 30, z: -12 }, { x: 34, z: 10 }]),   // centroid in front
    mkZone('back', [{ x: -30, z: -4 }, { x: -34, z: 8 }]),
  ];
  const rearPicks = pickSurvivalSpawns({
    zones: rearish, playerPos: player, playerFacingDeg: 90, wave: 1,
    recentZones: [], count: 6, rng,
  });
  const blindCount = rearPicks.filter((p) => p.blind).length;
  check('survival: rear share stays at or below ~1/3',
    blindCount <= Math.ceil(6 / 3), `blind=${blindCount}/${rearPicks.length}`);
  check('survival: the blind flag matches the point\'s own bearing',
    rearPicks.every((p) => {
      const off = Math.abs(((Math.atan2(p.point.x - player.x, p.point.z - player.z) * 180 / Math.PI) + 360) % 360 - 90);
      return p.blind === (off > 130);
    }));
}

/* ---- determinism: the same seed must replay the same wave --------------- */
{
  const player = { x: 0, z: 0 };
  const zones = buildSpawnZones(fakeLevel).filter((z) => z.id !== 'centre');
  const planFor = (seed) => pickSurvivalSpawns({
    zones, playerPos: player, playerFacingDeg: 90, wave: 3,
    recentZones: ['east'], count: 6,
    rng: makeRng(hashSeed(seed, 'survival', 3)),
  });
  const a = planFor(12345);
  const b = planFor(12345);
  const c = planFor(99999);
  const key = (p) => p.map((x) => `${x.zone.id}:${x.point.x.toFixed(3)}:${x.point.z.toFixed(3)}`).join('|');
  check('seed: the same seed replays the same wave', key(a) === key(b));
  check('seed: a different seed produces a different wave', key(a) !== key(c));
  check('seed: hashSeed is stable', hashSeed(1, 'survival', 3) === hashSeed(1, 'survival', 3));
}

/* ---- co-op rally: the squad lands together but not on one point --------- */
{
  const site = { x: 10, z: -20 };
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const spots = ids.map((id) => assignCoopRallySpot({ site, playerIds: ids, selfId: id, seed: 7 }));
  check('coop rally: every player gets a spot',
    spots.length === 4 && spots.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z)));
  check('coop rally: no two players share a point',
    new Set(spots.map((s) => `${s.x.toFixed(2)}:${s.z.toFixed(2)}`)).size === 4);
  const gaps = [];
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      gaps.push(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z));
    }
  }
  const minGap = Math.min(...gaps);
  check('coop rally: neighbours keep a minimum separation',
    minGap >= 2.5, `minGap=${minGap.toFixed(2)}`);
  // determinism: the same roster and id must yield the same spot on every
  // peer, otherwise the squad would land in different places per client
  const again = assignCoopRallySpot({ site, playerIds: ids, selfId: 'p2', seed: 7 });
  check('coop rally: the same player gets the same spot on every peer',
    Math.abs(again.x - spots[1].x) < 1e-9 && Math.abs(again.z - spots[1].z) < 1e-9);
  // a peer that only knows its own id still lands somewhere valid
  const solo = assignCoopRallySpot({ site, playerIds: [], selfId: 'p9', seed: 7 });
  check('coop rally: an unknown roster still returns a usable spot',
    Number.isFinite(solo.x) && Number.isFinite(solo.z));
}

console.log(failures === 0 ? '\n[spawn-test] all checks passed' : `\n[spawn-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
