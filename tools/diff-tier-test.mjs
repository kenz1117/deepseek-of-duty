#!/usr/bin/env node
/**
 * DIFF-TIER / WEAPON TABLE TEST — the regression guard.
 *
 * Why this file exists
 * --------------------
 * The single-player fairness pass (commit ad346ba) calibrated every measured
 * TTK at `maxFiring = 2` for D3..D5 and wrote that down in README. A later
 * integration commit (6e7831d) put D4/D5 back to 3 while the README and all
 * the measured data still said 2 — so the shipped build silently ran a ~50 %
 * hotter squad than the one that had been balanced, and nobody noticed for
 * a whole release cycle. The same class of drift happened to the shotgun's
 * falloff curve and to the "屋顶狙击手第 6 波起" line.
 *
 * This test therefore does two things:
 *   1. asserts the FAIRNESS INVARIANTS on the code (hard limits that must
 *      never be relaxed without re-running the fairness probes), and
 *   2. asserts that README still documents the numbers the code uses, so
 *      the documentation can no longer drift away from the build.
 *
 * usage: node tools/diff-tier-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIFF_TIERS, diffForWave, MAX_FIRING_CEILING } from '../src/systems/ai/tiers.js';
import { WEAPONS, shotgunDamage } from '../src/core/weapons.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`PASS  ${name}`); return; }
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ 1. tiers */
for (const t of DIFF_TIERS) {
  check(`tier ${t.id}: maxFiring <= ${MAX_FIRING_CEILING}`,
    t.maxFiring <= MAX_FIRING_CEILING, `maxFiring=${t.maxFiring}`);
  check(`tier ${t.id}: hit/damage multipliers stay within 1`,
    t.accuracy <= 1 && t.damage <= 1 && t.accuracy > 0 && t.damage > 0,
    `accuracy=${t.accuracy} damage=${t.damage}`);
}
check('D1 training tier is a single gun at a time', DIFF_TIERS[0].maxFiring === 1);
check('D3..D5 never exceed the single-player readability ceiling',
  DIFF_TIERS.slice(2).every((t) => t.maxFiring === MAX_FIRING_CEILING));

for (let i = 1; i < DIFF_TIERS.length; i++) {
  check(`wave thresholds ascend (${DIFF_TIERS[i - 1].id} → ${DIFF_TIERS[i].id})`,
    DIFF_TIERS[i].wave > DIFF_TIERS[i - 1].wave);
  check(`hit/damage never drop when the tier goes up (${DIFF_TIERS[i - 1].id} → ${DIFF_TIERS[i].id})`,
    DIFF_TIERS[i].accuracy >= DIFF_TIERS[i - 1].accuracy
    && DIFF_TIERS[i].damage >= DIFF_TIERS[i - 1].damage);
  check(`reaction delay never gets slower (${DIFF_TIERS[i - 1].id} → ${DIFF_TIERS[i].id})`,
    DIFF_TIERS[i].firstShot <= DIFF_TIERS[i - 1].firstShot);
}

check('diffForWave(1) is D1', diffForWave(1).id === 'D1');
check('diffForWave(3) is D2', diffForWave(3).id === 'D2');
check('diffForWave(5) is D3', diffForWave(5).id === 'D3');
check('diffForWave(8) is D4', diffForWave(8).id === 'D4');
check('diffForWave(12) is D5', diffForWave(12).id === 'D5');
check('diffForWave(40) is still D5', diffForWave(40).id === 'D5');

/* ---------------------------------------------------------------- 2. weapons */
const m870 = WEAPONS.find((w) => w.id === 'm870');
check('M870 exists', !!m870);
if (m870) {
  const at4 = shotgunDamage(m870, 4);
  const at12 = shotgunDamage(m870, 12);
  const at20 = shotgunDamage(m870, 20);
  // one shell must still kill a 100 hp rifleman out to ~13 m
  check('M870: one shell kills a 100 hp rifleman at 4 m', at4 >= 100, `${at4.toFixed(1)} raw`);
  check('M870: one shell still kills a 100 hp rifleman at 12 m', at12 >= 100, `${at12.toFixed(1)} raw`);
  check('M870: falloff never goes below the 42 % floor', at20 >= 176 * 0.42 - 0.01, `${at20.toFixed(1)} raw`);
  check('M870: falloff is monotonic', shotgunDamage(m870, 8) > shotgunDamage(m870, 16));
  check('M870: 6 shells in the tube, 40 in reserve', m870.magSize === 6 && m870.reserve === 40);
}
const m4 = WEAPONS.find((w) => w.id === 'm4');
const mk18 = WEAPONS.find((w) => w.id === 'mk18');
check('M4A1 is the balanced rifle (30 dmg / 720 rpm)', m4 && m4.dmg === 30 && m4.rpm === 720);
check('MK18 is the burst rifle (36 dmg / 850 rpm / recoil 1.35)',
  mk18 && mk18.dmg === 36 && mk18.rpm === 850 && mk18.recoil === 1.35);

/* --------------------------------------------------------------- 3. README */
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

/* The canonical difficulty table lives under a dedicated heading so the test
   can find it without depending on the rest of the README's layout. */
const tableRe = /<!-- DIFF-TIERS:BEGIN -->([\s\S]*?)<!-- DIFF-TIERS:END -->/;
const block = readme.match(tableRe);
check('README carries the canonical difficulty table markers', !!block);
if (block) {
  const rows = block[1].split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => c.length > 6 && /^D\d/.test(c[1]));
  check('README table has one row per tier', rows.length === DIFF_TIERS.length,
    `readme=${rows.length} code=${DIFF_TIERS.length}`);
  for (const t of DIFF_TIERS) {
    const row = rows.find((c) => c[1].startsWith(t.id));
    if (!row) { check(`README row for ${t.id}`, false, 'row missing'); continue; }
    const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
    check(`README ${t.id}: hit matches the code`, Math.abs(num(row[3]) - t.accuracy) < 0.005,
      `readme=${row[3]} code=${t.accuracy}`);
    check(`README ${t.id}: damage matches the code`, Math.abs(num(row[4]) - t.damage) < 0.005,
      `readme=${row[4]} code=${t.damage}`);
    check(`README ${t.id}: first-shot delay matches the code`,
      Math.abs(num(row[5]) - t.firstShot) < 0.005, `readme=${row[5]} code=${t.firstShot}`);
    check(`README ${t.id}: simultaneous fire matches the code`,
      num(row[6]) === t.maxFiring, `readme=${row[6]} code=${t.maxFiring}`);
  }
}
check('README states the simultaneous-fire ceiling for D3/D4/D5',
  /D3\/D4\/D5[^。\n]*最多\s*2/.test(readme) || /D3\/D4\/D5[^。\n]*=\s*2/.test(readme));
check('README documents the M870 falloff the code implements',
  /12\s*m[^。\n]*60\s*%/.test(readme) && /42\s*%/.test(readme),
  'expected "12 m 衰减到约 60 %" and "20 m 触底 42 %"');

if (failed) {
  console.log(`\n[diff-tier-test] ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\n[diff-tier-test] all checks passed');
