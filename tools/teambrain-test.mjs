#!/usr/bin/env node
/**
 * TeamBrain unit tests — per-faction coordination logic.
 *
 * The load-bearing property is the anti-cheat rule: intel only comes from a
 * member's own sighting. The host can see every entity; the brain must not.
 * Run: node tools/teambrain-test.mjs
 */

import { createTeamBrain } from '../src/systems/ai/teamBrain.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** ally: { x, z, alive, canSee, sees: Set(ids), hp }   enemy: { id, x, z, alive, hp } */

/* --- shared intel -------------------------------------------------------- */
{
  const brain = createTeamBrain({ team: 0 });
  const enemy = { id: 'e1', x: 30, z: -12, alive: true, hp: 100 };
  const noSight = { allies: [{ x: 0, z: 0, alive: true, canSee: false, sees: new Set(), hp: 100 }], enemies: [enemy] };
  brain.observe(noSight);
  brain.tick(0.3);
  check('intel: no sighting -> no intel', brain.hasIntel === false);
  check('intel: no sighting -> focus is not the enemy position',
    brain.focus === null || (brain.focus.x !== 30 && brain.focus.z !== -12));

  const sight = { allies: [{ x: 0, z: 0, alive: true, canSee: true, sees: new Set(['e1']), hp: 100 }], enemies: [enemy] };
  brain.observe(sight);
  brain.tick(0.3);
  check('intel: a sighting creates shared intel', brain.hasIntel === true);
  check('intel: focus moves to the reported position',
    brain.focus && Math.hypot(brain.focus.x - 30, brain.focus.z + 12) < 0.01);

  // the spotter dies; intel must decay, not persist forever
  brain.observe(noSight);
  for (let i = 0; i < 27; i += 1) brain.tick(0.3);   // ~8.1 s
  check('intel: expires after the TTL with no refresh', brain.hasIntel === false);
}

/* --- focus fire ---------------------------------------------------------- */
{
  const brain = createTeamBrain({ team: 0 });
  const fullHp = { id: 'far', x: 12, z: 0, alive: true, hp: 100 };
  const wounded = { id: 'hurt', x: 14, z: 0, alive: true, hp: 20 };
  const ally = { x: 0, z: 0, alive: true, canSee: true, sees: new Set(['far', 'hurt']), hp: 100 };
  brain.observe({ allies: [ally], enemies: [fullHp, wounded] });
  brain.tick(0.3);
  check('focus fire: the wounded enemy is the priority', brain.priorityTargetId === 'hurt',
    `got ${brain.priorityTargetId}`);

  // invisible target must never become the priority
  const hidden = { id: 'ghost', x: 40, z: 0, alive: true, hp: 5 };
  brain.observe({ allies: [ally], enemies: [fullHp, hidden] });   // ghost not in sees
  brain.tick(0.3);
  check('focus fire: unobservable target is never picked', brain.priorityTargetId !== 'ghost');

  // losing sight drops the priority after the TTL
  brain.observe({ allies: [{ ...ally, canSee: false }], enemies: [wounded] });
  for (let i = 0; i < 9; i += 1) brain.tick(0.3);   // 2.7 s > 2.5 s TTL
  check('focus fire: priority released after losing sight', brain.priorityTargetId === null);
}

/* --- human-preference weighting ------------------------------------------ */
{
  const brain = createTeamBrain({ team: 1 });
  const bot = { id: 'bot', x: 10, z: 0, alive: true, hp: 100 };
  const human = { id: 'human', x: 10.5, z: 0, alive: true, hp: 100, isHuman: true };
  const ally = { x: 0, z: 0, alive: true, canSee: true, sees: new Set(['bot', 'human']), hp: 100 };
  brain.observe({ allies: [ally], enemies: [bot, human] });
  brain.tick(0.3);
  check('focus fire: humans are preferred over bots at equal ranges',
    brain.priorityTargetId === 'human', `got ${brain.priorityTargetId}`);
}

/* --- ring-centre fallback is legal deduction, not a wallhack ------------- */
{
  const brain = createTeamBrain({ team: 0 });
  brain.ringCenter = { x: 8, z: 27 };
  // stale situation: nobody sees anything, no intel
  brain.observe({ allies: [{ x: 0, z: 0, alive: true, canSee: false, sees: new Set(), hp: 100 }], enemies: [] });
  for (let i = 0; i < 30; i += 1) brain.tick(0.3);
  check('fallback: with no intel the squad orbits the ring centre',
    brain.focus && Math.hypot(brain.focus.x - 8, brain.focus.z - 27) < 0.01);
}

/* --- an ally can see a target only via its own sees set ------------------ */
{
  const brain = createTeamBrain({ team: 0 });
  const enemy = { id: 'e9', x: 50, z: 50, alive: true, hp: 1 };   // nearly dead
  const blind = { x: 0, z: 0, alive: true, canSee: true, sees: new Set(), hp: 100 };
  brain.observe({ allies: [blind], enemies: [enemy] });
  brain.tick(0.3);
  check('anti-cheat: canSee alone without the sees set grants nothing',
    brain.priorityTargetId === null && brain.hasIntel === false);
}

/* --- dead allies and dead enemies are ignored ---------------------------- */
{
  const brain = createTeamBrain({ team: 0 });
  const deadEnemy = { id: 'dead', x: 3, z: 3, alive: false, hp: 0 };
  const deadAlly = { x: 0, z: 0, alive: false, canSee: true, sees: new Set(['dead']), hp: 0 };
  brain.observe({ allies: [deadAlly], enemies: [deadEnemy] });
  brain.tick(0.3);
  check('bodies: dead spotters and dead targets are ignored',
    brain.priorityTargetId === null && brain.hasIntel === false);
}

/* --- reset --------------------------------------------------------------- */
{
  const brain = createTeamBrain({ team: 0 });
  brain.observe({
    allies: [{ x: 0, z: 0, alive: true, canSee: true, sees: new Set(['x1']), hp: 100 }],
    enemies: [{ id: 'x1', x: 5, z: 5, alive: true, hp: 50 }],
  });
  brain.tick(0.3);
  check('reset: brain had a plan', brain.hasIntel === true);
  brain.reset();
  check('reset: clears intel and priority',
    brain.hasIntel === false && brain.priorityTargetId === null);
}

console.log(failures === 0 ? '\n[teambrain-test] all checks passed' : `\n[teambrain-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);