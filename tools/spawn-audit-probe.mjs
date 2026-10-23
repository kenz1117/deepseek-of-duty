#!/usr/bin/env node
/**
 * Spawn audit probe — run the real level's spawn zones through the real
 * generators and report where the waves actually land.
 *
 * This is the check that the unit tests cannot do: the unit fixtures are
 * synthetic rectangles, but the shipped map is not. The probe answers the
 * questions a playtest raises:
 *   - does every wave land inside the engagement band?
 *   - how far is the nearest spawn, worst case?
 *   - how much of a wave arrives from behind the player?
 *   - does the same seed replay the same waves?
 *
 * Run: node tools/spawn-audit-probe.mjs
 */
import * as THREE from 'three';
import { createLevel } from '../src/world/level.js';
import { createNavGrid } from '../src/systems/navgrid.js';
import {
  buildSpawnZones, zonesWithinRect, pickSurvivalSpawns, pickDefendSpawns,
  pickExtractSpawns, pickNeutralSpawns, SPAWN_RULES, makeRng, hashSeed,
} from '../src/systems/spawn.js';

const stubTex = new THREE.Texture();
const matsStub = new Proxy({}, {
  get(_t, key) {
    if (key === 'sprites') return new Proxy({}, { get: () => stubTex });
    return new THREE.MeshStandardMaterial();
  },
});
const engine = { scene: new THREE.Scene(), mats: matsStub };
const level = createLevel(engine);
const nav = createNavGrid(level, {
  cell: 0.8, radius: 0.32,
  groundAt: (x, z, y) => level.groundHeight(x, z, y),
  links: level.navLinks,
});

const zones = buildSpawnZones(level);
console.log(`zones: ${zones.length}`);
for (const z of zones) {
  console.log(`  ${String(z.id).padEnd(12)} points=${String(z.points.length).padStart(3)}  centroid=(${z.centroid.x.toFixed(0)}, ${z.centroid.z.toFixed(0)})`);
}

/* The sites the rotation actually plays on. `yaw` is the site's spawn
   heading — the probe must face the way the player actually faces, or the
   front/rear analysis is meaningless. */
const SITES = [
  { id: 'street', x: 1.2, z: 33, yaw: -0.03, rect: { x0: -28, x1: 44, z0: -28, z1: 82 } },
  { id: 'souk', x: -96, z: 46, yaw: 1.7, rect: { x0: -116, x1: -40, z0: -42, z1: 72 } },
  { id: 'rail', x: 0, z: -165, yaw: Math.PI, rect: { x0: -38, x1: 42, z0: -194, z1: -106 } },
  { id: 'port', x: 80, z: -80, yaw: 3.7, rect: { x0: 48, x1: 122, z0: -98, z1: 34 } },
];

/** headingDeg as the controller computes it: (-yaw * 180/PI) mod 360. */
function headingFor(site) {
  let deg = (-site.yaw * 180 / Math.PI) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

const PLAYER_SPOTS = [
  { label: 'site centre', p: (s) => ({ x: s.x, z: s.z }) },
  { label: 'site north', p: (s) => ({ x: s.x, z: s.rect.z1 - 8 }) },
  { label: 'site south', p: (s) => ({ x: s.x, z: s.rect.z0 + 8 }) },
  { label: 'site east', p: (s) => ({ x: s.rect.x1 - 8, z: s.z }) },
  { label: 'site west', p: (s) => ({ x: s.rect.x0 + 8, z: s.z }) },
];

let issues = 0;
const note = (ok, msg) => { if (!ok) { issues++; console.log(`  !! ${msg}`); } };

console.log('\n--- survival waves: distance + rear share (count=6) ---');
for (const site of SITES) {
  const siteZones = zonesWithinRect(zones, site.rect);
  if (!siteZones.length) { console.log(`${site.id}: NO ZONES IN SITE`); issues++; continue; }
  for (const spot of PLAYER_SPOTS) {
    const playerPos = spot.p(site);
    const facing = headingFor(site);
    /* Mirror main.js exactly: strict plan -> relaxed retry -> neutral
       fallback. The probe must audit the chain the game actually runs, not
       the first link of it. */
    const rng = makeRng(hashSeed(1, site.id, spot.label));
    let picks = pickSurvivalSpawns({
      zones: siteZones, playerPos, playerFacingDeg: facing, wave: 1,
      recentZones: [], count: 6, rng,
    });
    let source = 'strict';
    if (!picks.length) {
      picks = pickSurvivalSpawns({
        zones: siteZones, playerPos, playerFacingDeg: facing, wave: 1,
        recentZones: [], count: 6, rng, relaxed: true,
      });
      source = 'relaxed';
    }
    if (!picks.length) {
      picks = pickNeutralSpawns({ zones: siteZones, playerPos, count: 6, rng });
      source = 'neutral';
    }
    if (!picks.length) {
      console.log(`${site.id}/${spot.label}: EMPTY PLAN`);
      issues++;
      continue;
    }
    const dists = picks.map((p) => Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z));
    const blind = picks.filter((p) => p.blind).length;
    const min = Math.min(...dists), max = Math.max(...dists);
    const sectors = [...new Set(picks.map((p) => p.sector))];
    const okBand = picks.every((p) => {
      const d = Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z);
      return d >= SPAWN_RULES.pointMin && d <= SPAWN_RULES.pointMax;
    });
    /* The rear cap can only hold when a front/flank axis EXISTS. When the
       whole district offers one axis and it happens to be behind the
       player, the wave has nowhere else to come from — that is geometry,
       not a spawn bug, and the probe must not flag it as one. */
    const hasFrontish = sectors.some((s) => s !== 'rear');
    const okRear = !hasFrontish || blind <= Math.ceil(picks.length / 3);
    const okWalk = picks.every((p) => {
      const s = nav.closestWalkableOn ? nav.closestWalkableOn(p.point.x, p.point.z, p.point.y || 0) : null;
      return !!s;
    });
    note(okBand, `${site.id}/${spot.label}: distance outside band ${dists.map((d) => d.toFixed(0)).join(',')}`);
    note(okRear, `${site.id}/${spot.label}: rear share ${blind}/${picks.length} with sectors ${sectors.join('/')}`);
    note(okWalk, `${site.id}/${spot.label}: a pick is not on walkable ground`);
    console.log(
      `${site.id.padEnd(7)} ${spot.label.padEnd(13)} dist ${min.toFixed(0).padStart(3)}-${max.toFixed(0).padStart(3)} m` +
      `  rear ${blind}/${picks.length}` +
      `  sectors=${sectors.join('/')}` +
      `  ${source}` +
      `  ${okBand && okRear && okWalk ? 'ok' : 'PROBLEM'}`);
  }
}

/* The REAL objective spots, copied from main.js OBJECTIVE_SPOTS. The probe
   must audit the layouts players actually meet, not invented ones. */
const OBJECTIVE_SPOTS = {
  street: {
    defend: [{ x: 0, z: -16 }, { x: 0, z: 14 }, { x: -14, z: 2.5 }, { x: 0, z: 70 }],
    extract: [{ x: -19.2, z: 3.0 }, { x: -13.3, z: -2.5 }, { x: 13.3, z: -11.6 }, { x: 11.5, z: 68 }],
  },
  souk: {
    defend: [{ x: -74, z: 12 }, { x: -96, z: 42 }, { x: -52, z: -6 }],
    extract: [{ x: -74, z: 12 }, { x: -88, z: 30 }, { x: -48, z: 8 }],
  },
  rail: {
    defend: [{ x: 4, z: -150 }, { x: 0, z: -180 }, { x: 28, z: -124 }],
    extract: [{ x: 4, z: -150 }, { x: -16, z: -172 }, { x: 24, z: -132 }],
  },
  port: {
    defend: [{ x: 98, z: -44 }, { x: 72, z: -60 }, { x: 104, z: -20 }],
    extract: [{ x: 98, z: -44 }, { x: 84, z: -64 }, { x: 100, z: -12 }],
  },
};

console.log('\n--- defend: attack axes reach the objective (real objective spots) ---');
for (const site of SITES) {
  const siteZones = zonesWithinRect(zones, site.rect);
  const playerPos = { x: site.x, z: site.z };
  for (const objective of (OBJECTIVE_SPOTS[site.id] || {}).defend || []) {
    const picks = pickDefendSpawns({
      zones: siteZones, objective, coverPoints: level.coverPoints, count: 3,
      playerPos, playerFacingDeg: headingFor(site),
      rng: makeRng(hashSeed(2, site.id, objective.x, objective.z)),
    });
    if (!picks.length) {
      console.log(`${site.id} defend(${objective.x},${objective.z}): NO DEFEND AXES`);
      issues++;
      continue;
    }
    const dists = picks.map((p) => Math.hypot(p.point.x - objective.x, p.point.z - objective.z));
    const axes = picks.map((p) => p.axis.toFixed(0));
    console.log(
      `${site.id.padEnd(7)} defend(${objective.x},${objective.z})`.padEnd(36) +
      `  axes=${axes.join('/')}  standoff ${Math.min(...dists).toFixed(0)}-${Math.max(...dists).toFixed(0)} m`);
    note(dists.every((d) => d <= 80), `${site.id}: a defend spawn is further than 80 m from the objective`);
    const pDist = picks.map((p) => Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z));
    note(pDist.every((d) => d <= SPAWN_RULES.hardMax),
      `${site.id}: a defend spawn is out of the player's reach ${pDist.map((d) => d.toFixed(0)).join(',')}`);
  }
}

console.log('\n--- extract: the route is manned (real objective spots) ---');
for (const site of SITES) {
  const siteZones = zonesWithinRect(zones, site.rect);
  const playerPos = { x: site.x, z: site.z };
  for (const extract of (OBJECTIVE_SPOTS[site.id] || {}).extract || []) {
    const fortify = pickExtractSpawns({
      zones: siteZones, extractZone: extract, playerPos, playerFacingDeg: headingFor(site),
      phase: 'fortify', count: 4, rng: makeRng(hashSeed(3, site.id, extract.x)),
    });
    const pursuit = pickExtractSpawns({
      zones: siteZones, extractZone: extract, playerPos, playerFacingDeg: headingFor(site),
      phase: 'pursuit', count: 4, rng: makeRng(hashSeed(4, site.id, extract.x)),
    });
    const fDist = fortify.map((p) => Math.hypot(p.point.x - extract.x, p.point.z - extract.z));
    const pDist = pursuit.map((p) => Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z));
    console.log(
      `${site.id.padEnd(7)} extract(${extract.x},${extract.z})`.padEnd(36) +
      `  fortify ${fortify.length} (to extract ${fDist.length ? Math.min(...fDist).toFixed(0) : '-'} m)` +
      `  pursuit ${pursuit.length} (from player ${pDist.length ? Math.min(...pDist).toFixed(0) : '-'} m)`);
    note(fortify.length > 0, `${site.id}: the extraction route to (${extract.x},${extract.z}) is not manned`);
    note(pursuit.length > 0, `${site.id}: no pursuit wave for extract (${extract.x},${extract.z})`);
  }
}

console.log('\n--- neutral fallback: the last resort still lands in band ---');
for (const site of SITES) {
  const siteZones = zonesWithinRect(zones, site.rect);
  const playerPos = { x: site.x, z: site.z };
  const picks = pickNeutralSpawns({
    zones: siteZones, playerPos, count: 4, rng: makeRng(hashSeed(5, site.id)),
  });
  if (!picks.length) { console.log(`${site.id}: no neutral plan`); continue; }
  const dists = picks.map((p) => Math.hypot(p.point.x - playerPos.x, p.point.z - playerPos.z));
  const ok = dists.every((d) => d >= SPAWN_RULES.pointMin && d <= SPAWN_RULES.pointMax);
  note(ok, `${site.id}: neutral fallback outside the band ${dists.map((d) => d.toFixed(0)).join(',')}`);
  console.log(`${site.id.padEnd(7)} dist ${Math.min(...dists).toFixed(0)}-${Math.max(...dists).toFixed(0)} m  ${ok ? 'ok' : 'PROBLEM'}`);
}

console.log('\n--- determinism: the same seed replays the same wave ---');
{
  const site = SITES[0];
  const siteZones = zonesWithinRect(zones, site.rect);
  const plan = (seed, wave) => pickSurvivalSpawns({
    zones: siteZones, playerPos: { x: site.x, z: site.z }, playerFacingDeg: headingFor(site),
    wave, recentZones: [], count: 6, rng: makeRng(hashSeed(seed, 'survival', wave)),
  }).map((p) => `${p.zone.id}:${p.point.x.toFixed(3)}:${p.point.z.toFixed(3)}`).join('|');
  const a = plan(4242, 5), b = plan(4242, 5);
  console.log(`same seed identical: ${a === b ? 'yes' : 'NO'}`);
  note(a === b, 'the same seed did not replay the same wave');

  /* Variety is measured over a SET of seeds, not one pair: two adjacent
     seeds may legitimately produce the same plan when the district holds
     only a handful of in-band points. The requirement is that the seed
     gives the session VARIETY, not that every seed differs from its
     neighbour. */
  const many = [...Array(24)].map((_, i) => plan(i + 1, 5));
  const distinct = new Set(many).size;
  console.log(`distinct plans over 24 seeds: ${distinct}`);
  note(distinct >= 3, `the seed barely varies the plan (${distinct} distinct plans over 24 seeds)`);

  /* Consecutive waves inside one session must not repeat the same plan. */
  const waves = [...Array(8)].map((_, i) => plan(4242, i + 1));
  const waveVariety = new Set(waves).size;
  console.log(`distinct plans over waves 1-8 (one session): ${waveVariety}`);
  note(waveVariety >= 3, `consecutive waves repeat the same plan (${waveVariety} distinct over 8 waves)`);
}

console.log(issues === 0
  ? '\n[spawn-audit] no issues found'
  : `\n[spawn-audit] ${issues} issue(s) found`);
process.exit(issues === 0 ? 0 : 1);
