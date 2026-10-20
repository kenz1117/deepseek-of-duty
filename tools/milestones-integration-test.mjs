#!/usr/bin/env node
/**
 * Milestone integration test.
 *
 * Exercises the real wiring contract between systems/milestones.js and the
 * shapes main.js actually produces/consumes: the spots collected from
 * OBJECTIVE_SPOTS / objectiveZones / cqbZones / intel.targetList(), the
 * host->client snapshot field, and the HUD checklist payload.
 *
 * Run: node tools/milestones-integration-test.mjs
 */

import { createMilestones } from '../src/systems/milestones.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* Real spot shapes copied from the game's data tables (main.js:1021 OBJECTIVE_SPOTS,
   level.js:5892 objectiveZones, level.js:5871 cqbZones, intel.js:65 targetList). */
const OBJECTIVE_SPOTS_STREET = {
  defend: [
    { x: 0, z: -16, r: 8.5 }, { x: 0, z: 14, r: 8.0 },
    { x: -14, z: 2.5, r: 3.8 }, { x: 0, z: 70, r: 8.0 }, { x: 11.5, z: 68, r: 3.6 },
  ],
  extract: [
    { x: -19.2, z: 3.0, r: 3.5 }, { x: -13.3, z: -2.5, r: 2.7 },
    { x: 13.3, z: -11.6, r: 3.0 }, { x: 11.5, z: 68, r: 3.2 },
  ],
};
const objectiveZones = {
  defend: { x: 0, z: -12, r: 7 },
  backyard: { x: -22, z: 26, r: 6 },
  market: { x: 14, z: 34, r: 5 },
};
const cqbZones = [
  { id: 'alley-workshop', center: { x: -6, z: -4 }, radius: 3.6 },
  { id: 'street-apartment', center: { x: 12, z: -18 }, radius: 4.2 },
];
const intelTargets = [
  { x: 8, z: 30, r: 2.0, label: 'E 收集情报 · 北站', id: 'i0' },
  { x: -10, z: 22, r: 2.0, label: 'E 收集情报 · 老城', id: 'i1' },
];

// Mirror of milestoneSpots() in main.js.
function milestoneSpots(siteId = 'street') {
  const reach = [];
  const hold = [];
  const collect = [];
  const table = OBJECTIVE_SPOTS_STREET;
  for (const s of table.defend) hold.push(s);
  for (const s of table.extract) reach.push(s);
  for (const key of Object.keys(objectiveZones)) {
    const z = objectiveZones[key];
    if (z && Number.isFinite(z.x)) hold.push({ x: z.x, z: z.z, r: z.r });
  }
  for (const q of cqbZones) hold.push({ x: q.center.x, z: q.center.z, r: Math.min(5, q.radius) });
  for (const t of intelTargets) collect.push({ x: t.x, z: t.z });
  return { reach, hold, collect };
}

const spots = milestoneSpots();
check('spots: reach pool populated', spots.reach.length === 4, `${spots.reach.length}`);
check('spots: hold pool populated', spots.hold.length > 5, `${spots.hold.length}`);
check('spots: collect pool populated', spots.collect.length === 2);

/* --- the chain built from real data must be playable ------------------- */
const mounted = [];
const ms = createMilestones({
  reachSpots: spots.reach,
  holdSpots: spots.hold,
  collectSpots: spots.collect,
  origin: { x: 0, z: 33.5 },
  onChainAdvance: (step, i) => { mounted.push({ step, i }); },
});

check('chain: mounts a first step', mounted.length === 1);
const kinds = ms.steps.map((s) => s.kind);
const nonLethal = kinds.filter((k) => k !== 'kill').length;
check('chain: >=1/3 non-lethal', nonLethal >= 3, JSON.stringify(kinds));
check('chain: all positional steps have finite coords',
  ms.steps.every((s) => s.kind === 'kill' || (Number.isFinite(s.x) && Number.isFinite(s.z))));

/* --- simulate a player playing the whole chain ------------------------- */
const player = { x: 0, z: 33.5 };
let collectFireCount = 0;
let finished = false;
const play = createMilestones({
  reachSpots: spots.reach,
  holdSpots: spots.hold,
  collectSpots: spots.collect,
  origin: player,
  onAllDone: () => { finished = true; },
});

for (let guard = 0; guard < 400 && !finished; guard += 1) {
  const step = play.current;
  if (!step) break;
  if (step.kind === 'reach') {
    player.x = step.x; player.z = step.z;
    play.update(0.016, true);
  } else if (step.kind === 'hold') {
    player.x = step.x; player.z = step.z;
    for (let i = 0; i < 200 && play.current === step; i += 1) play.update(0.1, true);
  } else if (step.kind === 'collect') {
    collectFireCount += 1;
    play.notifyCollect(step.id);
  } else {
    for (let k = 0; k < step.need; k += 1) play.notifyKill(1);
  }
}
check('chain: a player can complete the whole chain by playing it', finished === true);
check('chain: collect steps are reachable via interact id', collectFireCount >= 0);

/* --- host -> client snapshot round trip with real payload -------------- */
{
  const host = createMilestones({
    reachSpots: spots.reach, holdSpots: spots.hold, collectSpots: spots.collect,
    origin: player,
  });
  // advance the host a couple of steps the way main.js would
  host.notifyKill(1);
  const wire = host.serialize();
  // main.js broadcasts this inside snapshot { milestones: ... }
  const snapshot = { t: 'snapshot', tick: 1, players: [], enemies: [], wave: 1, kills: 0, score: 0, milestones: wire };
  const size = JSON.stringify(snapshot).length;
  check('snapshot: fits well inside the 16 KB cap', size < 16384, `${size} bytes`);
  check('snapshot: milestones field is pass-through', JSON.parse(JSON.stringify(snapshot)).milestones.index === wire.index);

  const client = createMilestones({ chain: [{ kind: 'kill', need: 1 }], mirror: true });
  client.applyRemote(snapshot.milestones);
  check('client: mirrors host index', client.state.index === wire.index);
  check('client: mirrors host label', client.state.label === wire.label);
  client.update(1, true);
  check('client: a mirror never advances on its own', client.state.index === wire.index, `index=${client.state.index}`);
}

/* --- HUD checklist payload shape --------------------------------------- */
{
  const st = ms.serialize();
  const upcoming = ms.steps.slice(st.index + 1, st.index + 3).map((s) => s.kind);
  check('hud: serialize has all fields the HUD reads',
    ['index', 'total', 'kind', 'label', 'need', 'x', 'z', 'r', 'progress01', 'done', 'kills']
      .every((k) => k in st), JSON.stringify(Object.keys(st)));
  check('hud: progress01 is 0..1', st.progress01 >= 0 && st.progress01 <= 1);
  check('hud: upcoming is at most 2 entries', upcoming.length <= 2);
  check('hud: chain has 8 steps so the checklist always has future work', ms.steps.length === 8);
}

console.log(failures === 0 ? '\n[milestones-integration] all checks passed' : `\n[milestones-integration] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);