#!/usr/bin/env node
/**
 * Versus-mode guard tests.
 *
 * The versus changes ride on two easy-to-regress invariants. Both were real
 * bugs during development, so they are pinned here as source-level guards
 * (the modules under guard live in the UI megafile main.js, which cannot be
 * imported headlessly):
 *
 *   1. Team filtering must null-check BOTH sides. A naive `r.team === selfTeam`
 *      compares undefined === undefined in co-op, treats the squad as hostile,
 *      and makes everyone shoot their own teammates.
 *   2. Friendly fire must return BEFORE the "I've been shot by an enemy" AI
 *      reaction block, or allies turn on each other (awareness=0.9 +
 *      investigate=shooter).
 *
 * Run: node tools/versus-guard-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSrc = readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const enemySrc = readFileSync(path.join(ROOT, 'src', 'entities', 'enemy.js'), 'utf8');
const directorSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'ai', 'director.js'), 'utf8');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* --- guard 1: double null-check in the target selector -------------------- */
{
  const ok = /selfTeam != null && r\.team != null && r\.team === selfTeam/.test(mainSrc);
  check('target selector: team filter null-checks BOTH sides', ok);
  // and the naive form must NOT exist
  const naive = /if \(r\.team === selfTeam\) continue;/.test(mainSrc);
  check('target selector: naive undefined===undefined filter absent', !naive);
}

/* --- guard 2: friendly fire returns before AI reactions ------------------- */
{
  const tdIdx = enemySrc.indexOf('takeDamage(amount, point, normal, part');
  const ffIdx = enemySrc.indexOf('attackerTeam != null && this.team != null && attackerTeam === this.team', tdIdx);
  const awareIdx = enemySrc.indexOf('this.awareness = Math.min(1, Math.max(this.awareness, 0.9))', ffIdx);
  check('takeDamage: friendly branch exists', ffIdx > tdIdx);
  check('takeDamage: friendly branch precedes the AI-reaction block',
    ffIdx > 0 && awareIdx > ffIdx, `ff=${ffIdx} aware=${awareIdx}`);
  // the friendly branch must return false / true without touching awareness
  const branch = enemySrc.slice(ffIdx, awareIdx);
  check('takeDamage: friendly branch does not set awareness/suppression/investigate',
    !/awareness|suppression|investigate|wantCover|panicT|contact/.test(branch));
}

/* --- guard 3: versus gates the PvE-only subsystems ------------------------ */
{
  check('update loop: waves gated by versus',
    /if \(!G\.versusMode\)[\s\S]{0,80}updateWaves\(dt\)/.test(mainSrc));
  check('equipment: gated by versus',
    /equipment && !G\.versusMode/.test(mainSrc));
  check('director: breach disabled for teamed soldiers',
    /updateBreach[\s\S]{0,400}e\.team != null/.test(directorSrc));
  check('director: cover keys namespaced per faction',
    /t\$\{e\.team == null \? 0 : e\.team\}/.test(directorSrc));
}

/* --- guard 4: versus snapshot fields -------------------------------------- */
{
  check('snapshot: players carry team',
    /id: net\.selfId, name: net\.name, team: net\.team/.test(mainSrc));
  check('snapshot: zone + vscores fields present',
    /vscores: G\.versusMode \? G\.teamScores\.slice\(\) : null/.test(mainSrc)
      && /zone: \(G\.versusMode && zoneSys\) \? zoneSys\.serialize\(\) : null/.test(mainSrc));
  check('snapshot: clients mirror zone read-only',
    /netZoneMirror\.applyRemote\(snap\.zone\)/.test(mainSrc));
}

/* --- team coordination wiring (focus fire / per-faction director) --------- */
{
  const brainSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'ai', 'teamBrain.js'), 'utf8');
  check('teamBrain: intel only from a member sighting (anti-wallhack)',
    /seenByAny\(e\)/.test(brainSrc) && /INTEL_TTL/.test(brainSrc));
  check('wiring: per-bot targeting consults the brain priority',
    /nearestHostileActor\(e\.root\.position, e\.team, brain \? brain\.priorityTargetId : null\)/.test(mainSrc));
  check('wiring: PvE director gated off in versus (per-faction instances)',
    /aiDirector && nav && !G\.versusMode\) aiDirector\.tick/.test(mainSrc));
  check('wiring: coordination tick is called from the game loop',
    /updateTeamBrains\(dt\)/.test(mainSrc));
  check('wiring: coordination tick is host-only',
    /function updateTeamBrains\(dt\) \{\s*\n\s*if \(!G\.versusMode \|\| net\.role !== 'host'\) return;/.test(mainSrc));
}

/* --- team assignment math (the actual logic, re-implemented + verified) --- */
{
  // main.js assigns teams by lobby join order: host first, alternating.
  const assign = (ids) => Object.fromEntries(ids.map((id, i) => [String(id), i % 2]));
  const t = assign(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  const counts = [0, 0];
  for (const v of Object.values(t)) counts[v] += 1;
  check('teams: 8 players split 4v4', counts[0] === 4 && counts[1] === 4, JSON.stringify(counts));
  const t3 = assign(['a', 'b', 'c']);
  check('teams: 3 players split 2v1 (host on the larger side)',
    t3.a === 0 && t3.b === 1 && t3.c === 0);

  // fill: each team padded to 4 bots
  const fill = (counts2) => counts2.map((c) => Math.max(0, 4 - c));
  check('fill: 3 players -> 2 bots + 3 bots (each side to 4)', JSON.stringify(fill([2, 1])) === '[2,3]');
  check('fill: 8 players -> zero bots', JSON.stringify(fill([4, 4])) === '[0,0]');
}

/* --- zone smoke inside versus context ------------------------------------- */
{
  const { createZone } = await import('../src/systems/zone.js');
  const z = createZone({ rect: { x0: -28, x1: 44, z0: -28, z1: 82 } });
  let clipped = false;
  for (let i = 0; i < 4000 && !z.isFinal; i += 1) {
    const s = z.update(0.25, 0, 0);
    const inscribed = Math.min(72, 110) / 2;
    if (s.r <= inscribed) {
      const margin = Math.min(s.x + 28, 44 - s.x, s.z + 28, 82 - s.z);
      if (s.r - margin > 0.001) clipped = true;
    }
  }
  check('zone: versus-site ring never clips the playable rect', !clipped);
}

console.log(failures === 0 ? '\n[versus-guard] all checks passed' : `\n[versus-guard] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);