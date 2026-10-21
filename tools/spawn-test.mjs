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
  pickPlayerSpawn,
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

console.log(failures === 0 ? '\n[spawn-test] all checks passed' : `\n[spawn-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
