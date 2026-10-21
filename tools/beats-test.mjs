#!/usr/bin/env node
/**
 * Campaign beat engine unit tests (Phase 3 — scripted missions).
 *
 * systems/beats.js is pure logic; story.js only touches localStorage inside
 * functions, so both import headlessly. These pin:
 *   - the beat→wave mapping and the completion rules per beat type
 *   - the objective each beat mounts (and that clear-driven beats mount none)
 *   - the integrity of the four reworked ops (OP02/05/09/14): every chain is
 *     walkable start→finish with the facts the runtime will actually feed it
 *
 * Run: node tools/beats-test.mjs
 */

import {
  beatForWave, beatMode, beatObjective, beatComplete, beatEnemyCount,
  operationWaves, BEAT_OBJECTIVE_TYPES,
} from '../src/systems/beats.js';
import { OPERATIONS } from '../src/story.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ---- mapping -------------------------------------------------------------- */

const demo = [
  { type: 'infil', zone: { x: 0, z: 0, r: 4 } },
  { type: 'assault' },
  { type: 'defend', zone: { x: 1, z: 1, r: 3 }, hold: 45 },
  { type: 'extract', zone: { x: 2, z: 2, r: 3 } },
];
check('beatForWave is 1-based', beatForWave(demo, 1) === demo[0] && beatForWave(demo, 4) === demo[3]);
check('beatForWave out of range is null', beatForWave(demo, 0) === null && beatForWave(demo, 5) === null);
check('operationWaves: beats win over waves', operationWaves({ beats: demo, waves: 99 }) === 4);
check('operationWaves: legacy ops keep waves', operationWaves({ waves: 3 }) === 3);

check('beatMode: infil/interact are first-class modes',
  beatMode(demo[0]) === 'infil'
  && beatMode({ type: 'interact' }) === 'interact'
  && beatMode(demo[2]) === 'defend'
  && beatMode({ type: 'boss' }) === 'survival'
  && beatMode(null) === 'survival');

check('beatObjective: defend/extract/infil mount zones with hold',
  beatObjective(demo[2]).type === 'defend' && beatObjective(demo[2]).need === 45
  && beatObjective(demo[3]).type === 'extract' && beatObjective(demo[3]).need === 8
  && beatObjective(demo[0]).type === 'infil' && beatObjective(demo[0]).need === 3);
check('beatObjective: clear-driven beats mount nothing',
  beatObjective(demo[1]) === null && beatObjective({ type: 'boss' }) === null);
check('beatObjective: interact maps its spot', beatObjective({ type: 'interact', spot: { x: 5, z: 5 } }).zone.x === 5);

check('beatEnemyCount: explicit wins, absent is null',
  beatEnemyCount({ enemies: 0 }) === 0 && beatEnemyCount({}) === null);

/* ---- completion rules ------------------------------------------------------ */

check('survival/assault complete on a clear field',
  beatComplete({ type: 'survival' }, { cleared: true })
  && beatComplete({ type: 'assault' }, { cleared: true })
  && !beatComplete({ type: 'assault' }, { cleared: false, objectiveDone: true }));
check('objective beats complete ONLY on the objective',
  beatComplete({ type: 'infil' }, { objectiveDone: true, cleared: false })
  && !beatComplete({ type: 'infil' }, { cleared: true, objectiveDone: false })
  && !beatComplete({ type: 'defend' }, { cleared: true }));
check('boss beats need bossSpawned AND bossDead (escorts do not gate)',
  beatComplete({ type: 'boss' }, { bossSpawned: true, bossDead: true })
  && !beatComplete({ type: 'boss' }, { bossSpawned: false, bossDead: true })
  && !beatComplete({ type: 'boss' }, { bossSpawned: true, bossDead: false }));
check('objective-type list covers infil/defend/extract/interact',
  BEAT_OBJECTIVE_TYPES.length === 4
  && BEAT_OBJECTIVE_TYPES.includes('infil') && BEAT_OBJECTIVE_TYPES.includes('interact'));

/* ---- the four reworked ops walk start → finish ----------------------------- */

const WALK = [
  // beat type → the facts sequence that should complete it
  { infil: [{ objectiveDone: true }], defend: [{ objectiveDone: true }], extract: [{ objectiveDone: true }], interact: [{ objectiveDone: true }], survival: [{ cleared: true }], assault: [{ cleared: true }], boss: [{ bossSpawned: true, bossDead: false }, { bossSpawned: true, bossDead: true }] },
];

function walkChain(op) {
  for (let n = 1; n <= op.beats.length; n++) {
    const beat = beatForWave(op.beats, n);
    if (!beat) return `beat ${n} missing`;
    const steps = WALK[0][beat.type];
    if (!steps) return `beat ${n}: no completion facts for type ${beat.type}`;
    let done = false;
    for (const facts of steps) {
      if (beatComplete(beat, facts)) { done = true; break; }
    }
    if (!done) return `beat ${n} (${beat.type}) cannot complete`;
  }
  return null;
}

for (const id of [2, 5, 9, 14]) {
  const op = OPERATIONS.find((o) => o.id === id);
  check(`OP${String(id).padStart(2, '0')} has a beat chain`, !!(op && op.beats));
  if (op && op.beats) {
    check(`OP${String(id).padStart(2, '0')} walks start → finish`, walkChain(op) === null, walkChain(op) || '');
    check(`OP${String(id).padStart(2, '0')} waves field matches the chain`,
      op.waves === op.beats.length && operationWaves(op) === op.beats.length);
    const bad = op.beats.filter((b) => !['infil', 'assault', 'defend', 'extract', 'interact', 'boss', 'survival'].includes(b.type));
    check(`OP${String(id).padStart(2, '0')} beat types are legal`, bad.length === 0, bad.map((b) => b.type).join(','));
    // zone/interact beats must carry real objectives; boss beats need a boss
    const missing = op.beats.filter((b) => {
      if (b.type === 'boss') return !(b.boss && b.boss.hp && b.boss.name);
      if (b.type === 'interact') return !b.spot;
      if (['defend', 'extract', 'infil'].includes(b.type)) return !(b.zone && Number.isFinite(b.zone.x));
      return false;
    });
    check(`OP${String(id).padStart(2, '0')} every beat carries its objective`, missing.length === 0,
      missing.map((b) => b.name || b.type).join(','));
    // radio keyed on the wave number must not point past the chain
    const far = (op.radio || []).filter((r) => typeof r.at === 'number' && r.at > op.beats.length);
    check(`OP${String(id).padStart(2, '0')} radio lines stay inside the chain`, far.length === 0);
  }
}

const untouched = OPERATIONS.filter((o) => ![2, 5, 9, 14].includes(o.id));
check('the other ten ops are untouched (no beats)', untouched.every((o) => !o.beats));
check('legacy boss op OP07 still uses bossWave',
  OPERATIONS.find((o) => o.id === 7).bossWave === 3);

process.exit(failures ? 1 : 0);
