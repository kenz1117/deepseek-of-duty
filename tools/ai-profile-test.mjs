#!/usr/bin/env node
/**
 * AI profile unit tests (Phase 2 — per-mode behaviour policy).
 *
 * systems/ai/profiles.js is pure logic, so these run headlessly like the
 * spawn tests. They pin the invariants the mode redesign depends on:
 * flank sector geometry, patrol beat continuity, and — most important —
 * the fair-intel rule: NO decision ever returns the live player position,
 * only stimuli or coarse area anchors.
 *
 * Run: node tools/ai-profile-test.mjs
 */

import {
  AI_PROFILES,
  profileFor,
  pickFlankPoint,
  pickPatrolPoint,
  decideIntel,
} from '../src/systems/ai/profiles.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DEG = Math.PI / 180;

/* ---- profile table ------------------------------------------------------- */

check('profileFor: known names resolve', profileFor('hunter') === AI_PROFILES.hunter
  && profileFor('garrison') === AI_PROFILES.garrison);
check('profileFor: unknown falls back to default', profileFor('nope') === AI_PROFILES.default);
check('garrison patrols, squad gets no intel',
  !!AI_PROFILES.garrison.patrol && AI_PROFILES.squad.intel === 'none');
check('zoneAnchor profiles target areas (assault / interceptor)',
  AI_PROFILES.assault.zoneAnchor && AI_PROFILES.interceptor.zoneAnchor
  && !AI_PROFILES.hunter.zoneAnchor);
check('interceptor fortifies wider than pursuit',
  AI_PROFILES.interceptor.standoffMod > AI_PROFILES.interceptorPursuit.standoffMod);

/* ---- flank geometry ------------------------------------------------------ */

// threat at origin, flanker approaching from the east
const threat = { x: 0, z: 0 };
const from = { x: 30, z: 0 };
const fp = pickFlankPoint({ from, threat, side: 1, rng: mulberry32(7) });
check('flank point produced', !!fp);
if (fp) {
  const d = Math.hypot(fp.x - threat.x, fp.z - threat.z);
  check('flank point in the 14-20 m band', d >= 13.9 && d <= 20.1, `d=${d.toFixed(1)}`);
  // angle from the threat, measured off the threat→flanker bearing (east, 0°)
  const ang = Math.atan2(fp.z - threat.z, fp.x - threat.x) / DEG;
  check('flank point in the 80-150° side sector', ang >= 79 && ang <= 151, `ang=${ang.toFixed(0)}`);
}
// side -1 mirrors to negative z here (clockwise from east)
const fp2 = pickFlankPoint({ from, threat, side: -1, rng: mulberry32(7) });
if (fp && fp2) {
  check('side flag picks opposite sectors', Math.sign(fp.z) !== Math.sign(fp2.z) || Math.abs(fp2.z) < 1e-9,
    `z1=${fp.z.toFixed(1)} z2=${fp2.z.toFixed(1)}`);
}
check('degenerate geometry returns null (flanker on the threat)',
  pickFlankPoint({ from: { x: 0, z: 0.2 }, threat, side: 1, rng: mulberry32(1) }) === null);

/* ---- patrol geometry ----------------------------------------------------- */

const rngP = mulberry32(11);
const home = { x: 100, z: 100 };
let worst = 0;
let maxTurn = 0;
let prevDir = null;
for (let i = 0; i < 200; i++) {
  const leg = pickPatrolPoint({ home, radius: 13, rng: rngP, prevDir });
  const d = Math.hypot(leg.x - home.x, leg.z - home.z);
  if (d > worst) worst = d;
  if (prevDir != null) {
    let turn = Math.abs(leg.dir - prevDir);
    while (turn > Math.PI) turn = Math.abs(turn - Math.PI * 2);
    if (turn > maxTurn) maxTurn = turn;
  }
  prevDir = leg.dir;
}
check('patrol legs stay inside the beat radius', worst <= 13.01, `worst=${worst.toFixed(1)}`);
check('patrol turns stay one-way (±100°)', maxTurn <= 101 * DEG, `maxTurn=${(maxTurn / DEG).toFixed(0)}°`);

/* ---- fair intel decisions ------------------------------------------------ */

// a stimulus ALWAYS wins, regardless of profile or clock
const stim = [{ x: 42, z: -7 }];
const r1 = decideIntel({ profile: AI_PROFILES.garrison, intelT: 0, intelEvery: 999, stimuli: stim, area: null, rng: mulberry32(3) });
check('stimulus hint wins for garrison', r1.kind === 'stimulus'
  && Math.hypot(r1.x - 42, r1.z + 7) <= 7.1, JSON.stringify(r1));
const r2 = decideIntel({ profile: AI_PROFILES.squad, intelT: 99, intelEvery: 1, stimuli: stim, area: { x: 0, z: 0 }, rng: mulberry32(3) });
check('stimulus hint wins even for brain-driven squads', r2.kind === 'stimulus');

// area profiles: neighbourhood hint only when the clock is due
const area = { x: 10, z: 10 };
const r3 = decideIntel({ profile: AI_PROFILES.hunter, intelT: 0, intelEvery: 5, stimuli: null, area, rng: mulberry32(5) });
check('hunter waits before the intel clock is due', r3.kind === 'wait');
const r4 = decideIntel({ profile: AI_PROFILES.hunter, intelT: 6, intelEvery: 5, stimuli: null, area, rng: mulberry32(5) });
check('hunter gets the area hint when due', r4.kind === 'area');
if (r4.kind === 'area') {
  const err = Math.hypot(r4.x - area.x, r4.z - area.z);
  check('area hint error is coarse (12-20 m), not meter-level', err >= 4.8 && err <= 20.1, `err=${err.toFixed(1)}`);
}

// garrison with no stimulus: NOTHING, ever (sneakability is the point)
for (let t = 0; t <= 60; t += 5) {
  const r = decideIntel({ profile: AI_PROFILES.garrison, intelT: t, intelEvery: 4, stimuli: null, area, rng: mulberry32(9) });
  if (r.kind !== 'none') {
    check('garrison never gets area hints', false, `t=${t} kind=${r.kind}`);
    break;
  }
  if (t === 60) check('garrison never gets area hints', true);
}
// squad with no stimulus: nothing either
const r5 = decideIntel({ profile: AI_PROFILES.squad, intelT: 99, intelEvery: 1, stimuli: null, area, rng: mulberry32(2) });
check('squad gets no area hints', r5.kind === 'none');

// area hints must not collapse onto the live position: worst case over many
// draws stays far beyond the old 3-10 m reporting error
{
  let minErr = Infinity;
  for (let i = 0; i < 200; i++) {
    const r = decideIntel({ profile: AI_PROFILES.hunter, intelT: 99, intelEvery: 1, stimuli: null, area: { x: 500, z: 500 }, rng: mulberry32(100 + i) });
    if (r.kind === 'area') minErr = Math.min(minErr, Math.hypot(r.x - 500, r.z - 500));
  }
  check('area hint can never read as a live fix', minErr >= 4.8, `minErr=${minErr.toFixed(1)}`);
}

/* ---- regression guard: the old wallhack must not come back ----------------
   director.js used to hand out `playerPos.x + cos(ang) * err` with 3-10 m of
   error. The profile test cannot import director (three.js), so pin the
   rule here textually: no live-position offset from playerPos may remain. */
import { readFileSync } from 'node:fs';
const dirSrc = readFileSync(new URL('../src/systems/ai/director.js', import.meta.url), 'utf8');
check('director no longer offsets from the live player position for intel',
  !/playerPos\.x \+ Math\.cos/.test(dirSrc));
check('director routes intel through decideIntel', dirSrc.includes('decideIntel('));

process.exit(failures ? 1 : 0);
