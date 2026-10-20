#!/usr/bin/env node
/**
 * Milestone chain unit tests.
 *
 * Pure logic: no three.js, no DOM. Run: node tools/milestones-test.mjs
 * Exits 0 on success, 1 on any failure.
 */

import { buildChain, createMilestones, stepLabel } from '../src/systems/milestones.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic RNG so chain-shape tests are repeatable. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const reachSpots = [
  { x: 20, z: 0, r: 5 }, { x: -22, z: 8, r: 5 }, { x: 0, z: 26, r: 6 },
];
const holdSpots = [
  { x: 30, z: -12, r: 8 }, { x: -30, z: -14, r: 8 }, { x: 5, z: 34, r: 7 },
];
const collectSpots = [
  { x: 14, z: 18 }, { x: -16, z: 20 }, { x: 24, z: 26 },
];
const origin = { x: 0, z: 0 };

/* --- chain shape ---------------------------------------------------------- */
for (const seed of [1, 7, 42, 1337, 90210]) {
  const chain = buildChain({ reachSpots, holdSpots, collectSpots, origin, rng: seeded(seed) });
  const nonLethal = chain.filter((s) => s.kind !== 'kill').length;
  check(
    `chain(seed ${seed}): has at least 1/3 non-lethal steps`,
    nonLethal >= Math.ceil(chain.length * 0.34),
    `${nonLethal}/${chain.length}`
  );
  check(`chain(seed ${seed}): length is 8`, chain.length === 8, `got ${chain.length}`);
  const invalid = chain.filter(
    (s) => (s.kind === 'reach' || s.kind === 'hold' || s.kind === 'collect')
      && (!Number.isFinite(s.x) || !Number.isFinite(s.z))
  );
  check(`chain(seed ${seed}): every step has a place or is kill`, invalid.length === 0, JSON.stringify(invalid));
}

/* --- degenerate input: empty pools must never emit an impossible step ------ */
{
  const chain = buildChain({ reachSpots: [], holdSpots: [], collectSpots: [], origin, rng: seeded(5) });
  check('empty pools: every step falls back to kill', chain.every((s) => s.kind === 'kill'), JSON.stringify(chain));
  const bad = chain.filter((s) => s.kind !== 'kill' && !Number.isFinite(s.x));
  check('empty pools: no step without coordinates', bad.length === 0, JSON.stringify(bad));
}

/* --- reach advances on entry ---------------------------------------------- */
{
  let advanced = null;
  const m = createMilestones({
    chain: [{ kind: 'reach', x: 10, z: 0, r: 4, need: 1 }, { kind: 'kill', need: 2 }],
    onChainAdvance: (s, i) => { advanced = { s, i }; },
  });
  m.update(0.016, false);
  check('reach: not advanced while outside', m.state.index === 0);
  m.update(0.016, true);
  check('reach: advances when inside', m.state.index === 1, `index=${m.state.index}`);
  check('reach: onChainAdvance fired with next step', advanced && advanced.i === 1);
}

/* --- hold accumulates and decays ------------------------------------------ */
{
  const m = createMilestones({
    chain: [{ kind: 'hold', x: 0, z: 0, r: 6, need: 10 }, { kind: 'kill', need: 1 }],
  });
  for (let i = 0; i < 60; i += 1) m.update(0.1, true); // 6s inside
  check('hold: progress accumulates', m.state.progress01 > 0.5, `p=${m.state.progress01}`);
  for (let i = 0; i < 30; i += 1) m.update(0.1, false); // 3s outside -> decays
  const after = m.state.progress01;
  check('hold: progress decays when leaving', after < 0.6, `p=${after}`);
  for (let i = 0; i < 80; i += 1) m.update(0.1, true);
  check('hold: completes once time is met', m.state.index === 1, `index=${m.state.index}`);
}

/* --- kill counting -------------------------------------------------------- */
{
  let stepsDone = 0;
  const m = createMilestones({
    chain: [{ kind: 'kill', need: 3 }, { kind: 'reach', x: 5, z: 5, r: 3, need: 1 }],
    onStep: () => { stepsDone += 1; },
  });
  m.notifyKill();
  m.notifyKill();
  check('kill: still on step before target', m.state.index === 0 && stepsDone === 0);
  m.notifyKill();
  check('kill: advances at target', m.state.index === 1 && stepsDone === 1);
  m.notifyKill();
  check('kill: extra kills do not skip ahead', m.state.index === 1, `index=${m.state.index}`);
}

/* --- collect via interact ------------------------------------------------- */
{
  const m = createMilestones({
    chain: [{ kind: 'collect', id: 'm1', x: 0, z: 0, need: 1 }, { kind: 'kill', need: 1 }],
  });
  check('collect: wrong id ignored', m.notifyCollect('other') === false);
  check('collect: matching id advances', m.notifyCollect('m1') === true);
  check('collect: index advanced', m.state.index === 1);
}

/* --- chain completion ----------------------------------------------------- */
{
  let allDone = false;
  const m = createMilestones({
    chain: [{ kind: 'kill', need: 1 }, { kind: 'kill', need: 1 }],
    onAllDone: () => { allDone = true; },
  });
  m.notifyKill();
  m.notifyKill();
  check('chain: onAllDone fired', allDone);
  check('chain: state.done true', m.state.done === true);
  m.notifyKill();
  check('chain: ignores events after completion', m.state.index === 2, `index=${m.state.index}`);
}

/* --- a chain must be completable without killing anyone -------------------- */
{
  // Only non-lethal pools available -> chain must contain zero kill steps,
  // proving the guarantee holds rather than being accidental.
  const chain = buildChain({
    reachSpots: [{ x: 20, z: 0, r: 5 }, { x: -20, z: 0, r: 5 }, { x: 0, z: 24, r: 5 }],
    holdSpots: [{ x: 25, z: 10, r: 6 }, { x: -25, z: 10, r: 6 }, { x: 0, z: 30, r: 6 }],
    collectSpots: [{ x: 12, z: 12 }, { x: -12, z: 12 }, { x: 18, z: 20 }],
    origin,
    rng: seeded(99),
  });
  check('non-lethal pools: chain has no kill steps', chain.every((s) => s.kind !== 'kill'), JSON.stringify(chain.map((s) => s.kind)));
}

/* --- LAN serialize / applyRemote round-trip ------------------------------- */
{
  const host = createMilestones({
    chain: [{ kind: 'hold', x: 7, z: 9, r: 6, need: 10 }, { kind: 'reach', x: 3, z: 3, r: 4, need: 1 }],
  });
  for (let i = 0; i < 100; i += 1) host.update(0.1, true);
  const wire = host.serialize();
  check('serialize: is a plain object', wire && typeof wire === 'object' && !Array.isArray(wire));
  check('serialize: carries index/total', wire.index === 1 && wire.total === 2, JSON.stringify(wire));

  const client = createMilestones({
    chain: [{ kind: 'kill', need: 99 }, { kind: 'kill', need: 99 }, { kind: 'kill', need: 99 }],
  });
  client.applyRemote(wire);
  check('applyRemote: client mirrors host index', client.state.index === wire.index, `got ${client.state.index}`);
  check('applyRemote: client mirrors host step kind', client.state.kind === 'reach', `got ${client.state.kind}`);
  check('applyRemote: client mirrors coordinates', client.state.x === wire.x && client.state.z === wire.z);
}

/* --- reset ---------------------------------------------------------------- */
{
  const m = createMilestones({ chain: [{ kind: 'kill', need: 2 }, { kind: 'kill', need: 2 }] });
  m.notifyKill(); m.notifyKill();
  check('reset: chain had advanced to step 1', m.state.index === 1, `index=${m.state.index}`);
  check('reset: first step marked done', m.steps[0].done === true);
  m.reset();
  check('reset: back to step 0', m.state.index === 0);
  check('reset: steps marked incomplete', m.steps.every((s) => !s.done));
  check('reset: active again', m.state.done === false);
}

/* --- labels --------------------------------------------------------------- */
{
  check('label: reach', stepLabel({ kind: 'reach' }) === '前往标记点');
  check('label: hold', stepLabel({ kind: 'hold' }) === '守住目标区');
  check('label: collect', stepLabel({ kind: 'collect' }) === '搜集标记物');
  check('label: kill', stepLabel({ kind: 'kill' }) === '歼灭残敌');
  check('label: unknown is safe', typeof stepLabel({ kind: '???' }) === 'string');
  check('label: null is safe', stepLabel(null) === '');
}

console.log(failures === 0 ? '\n[milestones-test] all checks passed' : `\n[milestones-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);