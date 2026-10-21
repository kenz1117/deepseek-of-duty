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

/* --- spawn spread: 8 combatants must not stack on one point --------------- */
{
  // versusSpawnSlot geometry for the narrowest site (port, 74 x 132)
  const rect = { x0: 48, x1: 122, z0: -98, z1: 34 };
  const midZ = (rect.z0 + rect.z1) / 2;
  const slot = (team, index) => {
    const hz0 = team === 0 ? rect.z0 + 14 : midZ + 12;
    const hz1 = team === 0 ? midZ - 12 : rect.z1 - 14;
    const col = index % 2;
    const row = Math.floor(index / 2) % 2;
    return {
      x: (rect.x0 + 16) + col * ((rect.x1 - rect.x0) - 32),
      z: hz0 + row * (hz1 - hz0),
    };
  };
  const pts = [];
  for (let t = 0; t < 2; t += 1) for (let i = 0; i < 4; i += 1) pts.push({ ...slot(t, i), team: t });
  let minSame = Infinity;
  let minCross = Infinity;
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      if (pts[i].team === pts[j].team) { if (d < minSame) minSame = d; }
      else if (d < minCross) minCross = d;
    }
  }
  check('spawns: same-team slots never closer than 24 m', minSame >= 24, `${minSame.toFixed(1)} m`);
  check('spawns: factions separated by at least 20 m at spawn', minCross >= 20, `${minCross.toFixed(1)} m`);
  check('wiring: humans and bots both use versusSpawnSlot',
    /versusSpawnSlot\(vsSlot\.team, vsSlot\.index/.test(mainSrc)
      && /versusSpawnSlot\(team, counts\[team\] \+ i/.test(mainSrc));
  check('wiring: minimap feed carries the zone ring',
    /zone: zoneState \? \{/.test(mainSrc));
}

/* --- spawn integrity: no ringSpawn fallback, deployment grace ------------ */
{
  check('spawns: versus bots bypass the PvE ringSpawn fallback',
    /opts\.noRing/.test(mainSrc) && /noRing: true, force: true/.test(mainSrc));
  check('spawns: ringSpawn never runs for noRing spawns',
    /if \(opts\.noRing\) \{[\s\S]{0,400}\} else \{[\s\S]{0,200}ringSpawn\(\)/.test(mainSrc));
  check('deployment: grace gate lives in the targeting selector',
    /alive: G\.hp > 0 && !\(G\.versusMode && G\.versusGraceT > 0\)/.test(mainSrc));
  check('deployment: HUD shows the phase countdown',
    /部署阶段/.test(mainSrc));
}

/* --- Phase 0 LAN fix guards (all were real bugs) -------------------------- */
{
  // A client's untargeted 'down' report must never fall through to the host's
  // own playerDie() — it used to kill the host every time a client died.
  const downHost = mainSrc.indexOf("msg.kind === 'down' && net.role === 'host'");
  const downSelf = mainSrc.indexOf("msg.kind === 'down' && G.state === 'playing'");
  check('lan: client down-report marks the mirror, not the host',
    downHost > 0 && downSelf > downHost);

  // Enemy damage must follow the per-frame target, not land on the host.
  check('ai damage: routed by targetId (bot / remote / local)',
    /damagePlayer: \(amount, from\) => \{[\s\S]{0,200}startsWith\('bot:'\)/.test(mainSrc)
      && /applyLanRemoteDamage\(String\(tid\), amount, from, enemyCtx\.attackerTeam\)/.test(mainSrc));
  check('ai damage: stale targetId cleared on the solo branch',
    /else \{[\s\S]{0,320}enemyCtx\.targetId = undefined;/.test(mainSrc));

  // PvP closure: the victim applies pdmg to their own HP; the host's fire
  // arbitration includes player avatars and the host's own body spheres.
  check('pdmg: victim self-applies real damage',
    /kind === 'pdmg'[\s\S]{0,260}String\(msg\.target\) === String\(net\.selfId\)[\s\S]{0,160}applyPlayerDamage\(Number\(msg\.amount\)/.test(mainSrc));
  check('applyLanFire: remote avatars are targets (pdTarget)',
    /userData\.pdTarget = r\.id;[\s\S]{0,40}targets\.push\(o\)/.test(mainSrc));
  check('applyLanFire: host body tested analytically (raySphereT)',
    /raySphereT\(origin, d, controller\.pos\.x, controller\.pos\.y \+ 1\.58/.test(mainSrc));
  check('applyLanFire: kill credit uses the shooter team',
    /onEnemyKilled\(enemy, headshot, 'bullet', shooterTeam\)/.test(mainSrc));

  // Match end: 40 kills ends the match with a settlement, not a toast.
  check('versus end: checkVersusWin ends the match',
    /function checkVersusWin\(\) \{[\s\S]{0,200}endVersusMatch\(/.test(mainSrc));
  check('versus end: resetGame clears versus state (no leak into solo)',
    /function resetGame\(\) \{[\s\S]{0,420}G\.versusMode = false;[\s\S]{0,80}G\.versusOver = false;/.test(mainSrc));
  check('versus end: rematch rebuilds on both ends',
    /function restartVersusMatch\(\)/.test(mainSrc) && /function restartVersusClient\(startMsg\)/.test(mainSrc));

  // Client grenades: host simulates authoritatively, peers see the arc.
  check('grenade: client reports the throw instead of simulating damage',
    /lanSession\.sendEvent\('grenade', \{[\s\S]{0,120}vx:/.test(mainSrc));
  check('grenade: host rebroadcasts the arc and the boom',
    /broadcastEvent\('grenade', \{ \.\.\.msg, from: msg\.id \}\)/.test(mainSrc)
      && /broadcastEvent\('boom', \{/.test(mainSrc));
  check('grenade: clients still simulate their visual copy',
    /^ {4}updateGrenades\(dt\);$/m.test(mainSrc)
      && !/if \(net\.role !== 'client'\) updateGrenades/.test(mainSrc));

  // Milestones are squad objectives: any teammate can advance them.
  check('milestones: reach/hold count any alive teammate (host side)',
    /net\.role === 'host'\) \{[\s\S]{0,140}for \(const r of net\.remote\.values\(\)\)[\s\S]{0,120}inside = true; break;/.test(mainSrc));
  check('milestones: clients can collect via mcollect + host distance check',
    /sendEvent\('mcollect'/.test(mainSrc)
      && /kind === 'mcollect' && net\.role === 'host'[\s\S]{0,300}milestones\.notifyCollect\(\)/.test(mainSrc));

  // Cover booking in versus goes to the per-faction director (the PvE
  // instance never ticks in versus, so reservations there leaked forever).
  check('versus cover: bots book with their faction director',
    /enemyCtx\.ai\.director = \(G\.versusMode && e\.team != null && teamDirectors\[e\.team\]\)/.test(mainSrc));
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

/* --- Phase 2 AI-profile guards (behaviour policy per mode) ---------------- */
{
  const percSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'ai', 'perception.js'), 'utf8');
  const profSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'ai', 'profiles.js'), 'utf8');

  // the profile table exists and the enemy consumes it
  check('phase2: profile table with per-mode policies', /export const AI_PROFILES[\s\S]{0,1600}garrison:/.test(profSrc));
  check('phase2: enemy imports the profile layer', /from '\.\.\/systems\/ai\/profiles\.js'/.test(enemySrc));
  check('phase2: spawn carries profile + anchor into the enemy', /if \(pos\.profile\) e\.profile = profileFor\(pos\.profile\);/.test(mainSrc)
    && /e\.zoneAnchor = pos\.anchor \?/.test(mainSrc));
  check('phase2: waves stamp per-mode profiles', /profile: waveProfileName\(\), anchor: missionAnchor\(\)/.test(mainSrc));
  check('phase2: versus fill bots run the squad profile', /profile: 'squad'/.test(mainSrc));
  check('phase2: pursuit wave runs the interceptor-pursuit profile', mainSrc.includes("'interceptorPursuit'"));

  // fair intel: the director hands out stimuli/area hints, never live fixes
  check('phase2: director passes perception for stimulus queries', /perception,\s*\n\s*onBreach/.test(mainSrc));

  // patrol state
  check('phase2: unalerted garrison patrols instead of statue-ing', /else if \(this\.profile && this\.profile\.patrol\) \{[\s\S]{0,120}this\.state = 'patrol';/.test(enemySrc));
  check('phase2: patrol movement branch exists', /state === 'patrol'[\s\S]{0,900}pickPatrolPoint\(/.test(enemySrc));

  // real flanking
  check('phase2: flank assignment computes a validated waypoint', /const fp = pickFlankPoint\(\{[\s\S]{0,200}side: e\.aiSide/.test(directorSrc));
  check('phase2: flankers commit to the route', /this\.aiRole === 'flank' && this\.flankPoint && !this\.flankDone[\s\S]{0,340}else this\.state = 'advance';/.test(enemySrc));
  check('phase2: flankers may return fire on the route', /!\(this\.state === 'advance' && this\.aiRole === 'flank'/.test(enemySrc));

  // suppression bites movement
  check('phase2: suppression breaks advancing soldiers toward cover + off-lane',
    /this\.state === 'advance' && this\.suppression > 0\.55[\s\S]{0,300}this\.wantCover = true;/.test(enemySrc));

  // open-fire budget covers every archetype
  check('phase2: rusher fire gated by the budget', /updateRusherFire[\s\S]{0,400}ctx\.tryFire && !ctx\.tryFire\(\)/.test(enemySrc));
  check('phase2: sniper fire gated by the budget at trigger time',
    /this\.warnT <= 0\) \{[\s\S]{0,300}ctx\.tryFire && !ctx\.tryFire\(\)/.test(enemySrc));
  check('phase2: fire budget scales by tier', /maxFiring: 1 \}/.test(mainSrc) && /maxFiring: 3 \}/.test(mainSrc));

  // late-dodge fairness recheck
  check('phase2: rolled hits re-check geometry during a late dodge',
    /let hit = !path\.blocked && Math\.random\(\) < hitChance;[\s\S]{0,560}hit = this\.canSeeTarget\(playerPos, dist\);/.test(enemySrc));
  check('phase2: ctx arms the late-dodge window', /playerFastT = 0\.15;/.test(mainSrc));

  // quiet-behind stealth: the 4.2 m auto-detect respects the facing
  check('phase2: quiet rear approach is not auto-detected at knife range',
    /quietBehind = \(ctx\.playerSpeed \|\| 0\) < 2\.2 && cos2 < -0\.05 && e\.awareness < 0\.45/.test(percSrc));

  // relocation warning
  check('phase2: stuck-enemy teleport prefers a far ring + flank bark',
    /ringSpawn\(26, 40\) \|\| ringSpawn\(12, 26\)[\s\S]{0,160}barks\.say\('flank', p\)/.test(mainSrc));
}

/* --- Phase 3 campaign-beat guards (scripted missions) --------------------- */
{
  const storySrc = readFileSync(path.join(ROOT, 'src', 'story.js'), 'utf8');
  const beatsSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'beats.js'), 'utf8');

  // pure engine exists and main.js consumes it
  check('phase3: beat engine exports the decision layer',
    /export function beatForWave/.test(beatsSrc) && /export function beatComplete/.test(beatsSrc));
  check('phase3: modeForWave resolves the beat mode', /const beat = op && op\.beats \? beatForWave\(op\.beats, n\) : null;[\s\S]{0,120}beatMode\(beat\)/.test(mainSrc));

  // startWave: checkpoint, declared enemy count, boss beat gate
  check('phase3: each beat start writes a checkpoint', /saveBeatCheckpoint\(G\.operation\.id, n\)/.test(mainSrc));
  check('phase3: beat enemy count replaces the legacy formula', /beatEnemyCount\(opB\)/.test(mainSrc));
  check('phase3: boss beats spawn the beat boss', /opB && opB\.type === 'boss'/.test(mainSrc)
    && /spawnBoss\(op, beatBoss\)/.test(mainSrc));

  // objective layer
  check('phase3: beat objectives mount via setupBeatObjective', /function setupBeatObjective\(beat\)/.test(mainSrc));
  check('phase3: infil is a reach goal with no clear requirement', /obj\.type === 'infil'/.test(mainSrc));
  check('phase3: interact beats mount an interact target', /function mountBeatInteract\(beat, spot\)/.test(mainSrc));
  check('phase3: objective-driven beats never run the clear path', /opB && BEAT_OBJECTIVE_TYPES\.includes\(opB\.type\)/.test(mainSrc));

  // progression
  check('phase3: objective completion advances the beat', /setTimeout\(\(\) => advanceBeat\(\), 1200\)/.test(mainSrc));
  check('phase3: advanceBeat finishes the op on the last beat',
    /function advanceBeat\(\)[\s\S]{0,300}G\.wave >= operationWaves\(op\)/.test(mainSrc));
  check('phase3: wave-clear gate uses operationWaves', /G\.wave >= operationWaves\(G\.operation\)/.test(mainSrc));
  check('phase3: boss beats complete without gating on escorts', /G\.bossBeatSpawned/.test(mainSrc)
    && /beatBossDone/.test(mainSrc));

  // checkpoints
  check('phase3: checkpoint storage exists in story.js',
    /export function saveBeatCheckpoint/.test(storySrc)
    && /export function loadBeatCheckpoint/.test(storySrc)
    && /export function clearBeatCheckpoint/.test(storySrc));
  check('phase3: startGame resumes from the checkpoint', /loadBeatCheckpoint\(\)[\s\S]{0,200}firstWave = cp\.beat/.test(mainSrc));
  check('phase3: finishing the op clears the checkpoint', /clearBeatCheckpoint\(\);/.test(mainSrc));
  check('phase3: beat-op deaths retry instead of ending the run',
    /G\.operation && G\.operation\.beats\) \{[\s\S]{0,220}从节拍/.test(mainSrc));

  // boss phases
  check('phase3: boss phase engine exists', /function updateBossPhases\(\)/.test(mainSrc)
    && /function runBossPhase\(ph\)/.test(mainSrc));
  check('phase3: boss phases wired into the update loop', /updateWaves\(dt\);[\s\S]{0,200}updateBossPhases\(\);/.test(mainSrc));
  check('phase3: warden buff applies through damageResist',
    /G\.boss\.damageResist = bossWardenResist > 0 && escortAlive \? bossWardenResist : 0;/.test(mainSrc));
  check('phase3: enemy.takeDamage respects damageResist', /if \(this\.damageResist > 0\) amount \*= 1 - Math\.min\(0\.9, this\.damageResist\);/.test(enemySrc));
  check('phase3: charge mode multiplies movement', /this\.advanceSpeedMult \|\| 1/.test(enemySrc));
  check('phase3: boss artillery reuses the strike system', /artillery\.strike\(\{ x: controller\.pos\.x/.test(mainSrc));

  // data: the four reworked ops carry chains in story.js
  check('phase3: OP02/05/09/14 carry beat chains',
    ['id: 2,', 'id: 5,', 'id: 9,', 'id: 14,'].every((marker) => {
      const i = storySrc.indexOf(marker);
      const next = storySrc.indexOf('id:', i + 1);
      const seg = storySrc.slice(i, next > 0 ? next : undefined);
      return seg.includes('beats:');
    }));
}

/* --- Phase 4a LAN co-op guards (downed/revive + per-player upgrades) ------ */
{
  const protoSrc = readFileSync(path.join(ROOT, 'src', 'net', 'lanProtocol.js'), 'utf8');
  const medSrc = readFileSync(path.join(ROOT, 'src', 'systems', 'medical.js'), 'utf8');

  // pure registry exists and main.js consumes it
  check('phase4a: medical registry exports the rules', /export function createDownedRegistry/.test(medSrc)
    && /function isWipe\(humans\)/.test(medSrc));
  check('phase4a: main imports the medical layer', /from '\.\/systems\/medical\.js'/.test(mainSrc));

  // co-op deaths go DOWNED; versus keeps its instant respawn
  check('phase4a: co-op death enters the downed state', /G\.state = 'downed';\s*\n\s*G\.downedT = DOWN_BLEED_S;/.test(mainSrc));
  check('phase4a: versus death still respawns in 5 s',
    /if \(G\.versusMode\) \{[\s\S]{0,260}net\.respawnT = 5\.0;/.test(mainSrc));
  check('phase4a: solo death path untouched (finishRun / beat retry)', /从节拍 \$\{G\.wave\} 重试/.test(mainSrc));

  // event wiring (co-op only, gated on !versus)
  check('phase4a: downed/revive/revived/bledout/wipe/upoffer handlers exist',
    ["msg.kind === 'downed'", "msg.kind === 'revive' && net.role === 'host'", "msg.kind === 'revived'",
      "msg.kind === 'bledout'", "msg.kind === 'wipe' && net.role === 'client'", "msg.kind === 'upoffer' && net.role === 'client'"]
      .every((s) => mainSrc.includes(s)));
  check('phase4a: co-op medical events are gated off versus', /if \(!G\.versusMode && net\.started\) \{\s*\n\s*if \(msg\.kind === 'downed'\)/.test(mainSrc));
  check('phase4a: host fans a client downed report out to the others',
    /onPeerDowned\(from[\s\S]{0,200}broadcastEvent\('downed', \{ from, x: msg\.x, z: msg\.z \}\)/.test(mainSrc));

  // revive authority: host validates range + still-down via the registry
  check('phase4a: host validates revives against the registry', /reg\.canRevive\(targetId, rp, Date\.now\(\)\)/.test(mainSrc));
  check('phase4a: revive stands the target up at half health',
    /function standUpFromDown\(\)[\s\S]{0,260}Math\.round\(G\.maxHp \* REVIVE_HP_FRAC\)/.test(mainSrc));
  check('phase4a: you cannot mount a revive prompt on yourself', /if \(key === String\(net\.selfId\)\) return;\s*\/\/ you cannot revive yourself/.test(mainSrc));

  // bleed-out + wipe
  check('phase4a: the bleed-out clock ticks and converts to dead', /G\.state === 'downed' && net\.role\) \{[\s\S]{0,260}bleedOutLocal\(\)/.test(mainSrc));
  check('phase4a: host sweeps peer bleed-outs', /function sweepCoopDowned\(\)/.test(mainSrc) && /sweepCoopDowned\(\);/.test(mainSrc));
  check('phase4a: squad wipe redeploys everyone together', /function checkCoopWipe\(\)[\s\S]{0,400}broadcastEvent\('wipe'/.test(mainSrc));
  check('phase4a: resetGame clears the registry + prompts', /coopDowned\.clearAll\(\);\s*\n\s*unmountAllReviveTargets\(\);/.test(mainSrc));

  // per-player upgrades
  check('phase4a: host broadcasts the upgrade offer', /broadcastEvent\('upoffer', \{ cards: G\.upgradeCards\.map/.test(mainSrc));
  check('phase4a: clients pick locally and do NOT advance the wave',
    /if \(net\.role === 'client'\) \{\s*\n\s*if \(!SHOT_MODE\) input\.lock\(\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*startWave\(G\.wave \+ 1\);/.test(mainSrc));
  check('phase4a: client damage picks ride the fire packet', /dmg: G\.upgrades\.damage,/.test(mainSrc)
    && /dmg: Math\.min\(3, Math\.max\(0\.5, dmg\)\),/.test(protoSrc));
  check('phase4a: host applies the shooter multiplier to enemy damage only',
    /enemy\.takeDamage\(w\.dmg \* falloff \* mult \* shooterDmg/.test(mainSrc)
    && !/versusApplyPlayerDamage\(String\(pdId\), dmg \* shooterDmg/.test(mainSrc));
}

console.log(failures === 0 ? '\n[versus-guard] all checks passed' : `\n[versus-guard] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);