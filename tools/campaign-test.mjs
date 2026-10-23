#!/usr/bin/env node
/**
 * Campaign script + layout contract tests.
 *
 * The 2026-10-23 narrative pass fixed a class of bugs that were invisible in
 * playtesting because they were all in the WIRING, not in the content:
 *
 *   - a boss kill announced "the commander is down" for the deputy and for
 *     the decoy, contradicting the story two lines later;
 *   - two different radio lines shared one audio file (subtitle/voice
 *     desync);
 *   - the wave-1 radio of OP11–13 was swallowed by a SILENT intro cutscene,
 *     so the only line explaining the next move never reached the player;
 *   - the boss reveal cutscenes were staged in the wrong district;
 *   - OP01–08 had no explicit start/spawnRect, so the rotating free-play
 *     district decided where "南院" and "北检查站" actually were.
 *
 * These tests pin all of that. Run: node tools/campaign-test.mjs
 */

import * as THREE from 'three';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLevel } from '../src/world/level.js';
import { createNavGrid } from '../src/systems/navgrid.js';
import { OPERATIONS } from '../src/story.js';
import { SCENES } from '../src/cinema.js';
import { VOICE_LINES } from '../src/voice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICE_DIR = path.join(ROOT, 'public', 'audio', 'voice');
const hasRecording = (id) => {
  const v = VOICE_LINES[id];
  return !!v && fs.existsSync(path.join(VOICE_DIR, v.file));
};

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ------------------------------------------------------------------ data ---- */

const ops = OPERATIONS;
const opById = new Map(ops.map((o) => [o.id, o]));

/* Every op must pin its own ground. Without start/spawnRect the op inherits
 * the rotating free-play district and the scripted geography is fiction. */
for (const op of ops) {
  check(`OP${op.id} pins a start position`, !!op.start && Number.isFinite(op.start.x) && Number.isFinite(op.start.z),
    JSON.stringify(op.start));
  check(`OP${op.id} pins a spawn rect`, !!op.spawnRect && Number.isFinite(op.spawnRect.x0) && Number.isFinite(op.spawnRect.z1),
    JSON.stringify(op.spawnRect));
}

/* Voice integrity: every referenced id must exist, and no two lines inside
 * one op may share an id (that is how the OP02 subtitle/voice desync
 * happened). */
for (const op of ops) {
  const seen = new Map();
  for (const line of op.radio || []) {
    if (!line.voice) continue;
    check(`OP${op.id} radio voice "${line.voice}" exists`, !!VOICE_LINES[line.voice]);
    if (seen.has(line.voice)) {
      check(`OP${op.id} radio has no duplicate voice id "${line.voice}"`, false,
        `lines "${seen.get(line.voice)}" and "${line.text}"`);
    } else {
      seen.set(line.voice, line.text);
    }
  }
  const texts = new Set();
  for (const line of op.radio || []) {
    check(`OP${op.id} radio lines are unique`, !texts.has(line.text), line.text);
    texts.add(line.text);
  }
}

/* Cutscene voice ids exist, and a scene must not reuse one id for two
 * different sentences. */
for (const [id, scene] of Object.entries(SCENES)) {
  const seen = new Map();
  for (const line of scene.lines || []) {
    if (!line.voice) continue;
    check(`scene ${id} voice "${line.voice}" exists`, !!VOICE_LINES[line.voice]);
    if (seen.has(line.voice)) {
      check(`scene ${id} has no duplicate voice id "${line.voice}"`, false, 'two lines, one file');
    } else seen.set(line.voice, line.text);
  }
}

/* Every line that is NOT silent must be able to speak: either it has a
 * recording, or it carries a fallback text for the browser TTS. */
for (const [id, scene] of Object.entries(SCENES)) {
  for (const line of scene.lines || []) {
    if (line.silent) continue;
    const v = line.voice ? VOICE_LINES[line.voice] : null;
    check(`scene ${id} line "${line.text.slice(0, 12)}…" can speak`,
      !line.voice || (v && (v.file || v.text)), line.voice || 'no voice id');
  }
}

/* A missing mp3 is only acceptable if the entry carries a fallback text —
 * that is what the browser TTS reads, so subtitle and voice stay in sync.
 * A missing mp3 WITHOUT a fallback would leave the line silent. */
for (const op of ops) {
  for (const line of op.radio || []) {
    if (!line.voice) continue;
    const v = VOICE_LINES[line.voice];
    if (!v) continue;
    if (!hasRecording(line.voice)) {
      check(`OP${op.id} "${line.voice}" has a fallback text`,
        !!v.text, 'missing mp3 and no fallback text');
    }
  }
}
for (const [id, scene] of Object.entries(SCENES)) {
  for (const line of scene.lines || []) {
    if (!line.voice || line.silent) continue;
    const v = VOICE_LINES[line.voice];
    if (!v) continue;
    if (!hasRecording(line.voice)) {
      check(`scene ${id} "${line.voice}" has a fallback text`,
        !!v.text, 'missing mp3 and no fallback text');
    }
  }
}

/* Boss death lines: one per boss, and the commander title belongs to Karim
 * alone (Salim runs the port on Karim's radio instead). */
const BOSS_EXPECT = {
  5: { name: '副官 · 哈桑', voice: 'boss_down_hassan' },
  7: { name: '指挥官替身', voice: 'boss_down_decoy' },
  9: { name: '指挥官 · 卡里姆', voice: 'karim_down' },
  14: { name: '萨利姆 · 卡里姆的接线员', voice: 'boss_down_salim' },
};
for (const [id, exp] of Object.entries(BOSS_EXPECT)) {
  const op = opById.get(Number(id));
  check(`OP${id} boss is "${exp.name}"`, !!op && op.bossName === exp.name, op && op.bossName);
  check(`OP${id} death line "${exp.voice}" exists`, !!VOICE_LINES[exp.voice]);
}
/* The decoy must read as the commander until the kill. */
check('OP07 hides the decoy behind an alias', !!opById.get(7).bossAlias, opById.get(7).bossAlias);
check('OP07 alias does not spoil the twist', !/替身/.test(opById.get(7).bossAlias || ''), opById.get(7).bossAlias);

/* The commander title must not be handed to a second boss. OP07 is the
 * exception BY DESIGN: the decoy's real name contains it, and the HUD hides
 * it behind an alias until the kill. */
for (const op of ops) {
  if (!op.bossName || op.id === 9 || op.id === 7) continue;
  check(`OP${op.id} boss does not claim the title 指挥官`, !/指挥官/.test(op.bossName), op.bossName);
}

/* The final video belongs to the real finale only; OP10 is a false ending. */
check('OP10 outro is the false ending (no ending film)', opById.get(10).outro === 'finale' && !opById.get(10).outroVideo);
check('OP14 plays the ending film', !!opById.get(14).outroVideo);

/* The OP11–13 motivation lines must survive the intro cutscene. */
for (const id of [11, 12, 13]) {
  const op = opById.get(id);
  check(`OP${id} keeps its wave-1 radio`, !!op.radioAtStart);
  check(`OP${id} has a wave-1 radio line`, (op.radio || []).some((r) => r.at === 'start'));
}

/* The convoy thread: OP05 → OP06 → OP07 → OP08 must each hand the player a
 * reason to walk north, and only one of them may claim the convoy already
 * passed the gate. */
const op6 = opById.get(6).radio.find((r) => r.at === 'start' && r.speaker === 'VEGA');
check('OP06 orders the player to HOLD the gate', !!op6 && /别让他们|守住/.test(op6.text), op6 && op6.text);
const op7 = opById.get(7).radio.find((r) => r.at === 'start' && r.speaker === 'DISPATCH');
check('OP07 convoy has not passed the gate yet', !!op7 && !/已过/.test(op7.text), op7 && op7.text);
const op8 = opById.get(8).radio.find((r) => r.at === 'start' && r.speaker === 'VEGA');
check('OP08 is a lockdown, not a re-run of OP06', !!op8 && /夺|冲出来|封/.test(op8.text), op8 && op8.text);

/* ---------------------------------------------------------------- layout ---- */

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

function walkable(x, z) {
  if (nav.isWalkableAt(x, z, 0)) return true;
  const near = nav.closestWalkable(x, z, 0);
  return !!near && Math.hypot(near.x - x, near.z - z) < 1.5;
}
function regionOf(x, z) {
  const r = level.regionAt ? level.regionAt(x, z) : null;
  return r ? (r.name || r.id || '') : '';
}

/* Each op's start must stand in the district its story claims. Two ops
 * start one step outside their set piece on purpose: OP03 begins in the
 * apartment passage that leads into the backlot, OP09 begins outside the
 * HQ because the mission IS the breach. */
const OP_REGION = {
  1: '街区', 2: '街区', 3: '临街公寓', 4: '街区', 5: '南院车场',
  6: '北检查站', 7: '北检查站', 8: '北检查站', 9: '北检查站', 10: '东码头',
  11: '老城集市', 12: '北站货场', 13: '东港集装箱场', 14: '东港集装箱场',
};
for (const op of ops) {
  const want = OP_REGION[op.id];
  if (!want || !op.start) continue;
  const at = regionOf(op.start.x, op.start.z);
  check(`OP${op.id} start stands in ${want}`, at === want, `got "${at}" at (${op.start.x}, ${op.start.z})`);
  check(`OP${op.id} start is walkable`, walkable(op.start.x, op.start.z), `(${op.start.x}, ${op.start.z})`);
}

/* Boss spawn points must be walkable too, or the fight starts in a wall. */
for (const op of ops) {
  const bs = op.bossSpawn || (op.bosses || []).map((b) => b.spawn).find(Boolean);
  if (bs) check(`OP${op.id} boss spawn is walkable`, walkable(bs.x, bs.z), `(${bs.x}, ${bs.z})`);
  for (const beat of op.beats || []) {
    if (beat.boss && beat.boss.spawn) {
      check(`OP${op.id} boss beat spawn is walkable`, walkable(beat.boss.spawn.x, beat.boss.spawn.z),
        `(${beat.boss.spawn.x}, ${beat.boss.spawn.z})`);
    }
    if (beat.type === 'interact' && beat.spot && typeof beat.spot === 'object') {
      check(`OP${op.id} interact spot is walkable`, walkable(beat.spot.x, beat.spot.z),
        `(${beat.spot.x}, ${beat.spot.z})`);
    }
  }
}

/* Cutscene actors must stand where the scene claims to be. */
const SCENE_STAGE = {
  hassan_intro: '南院车场',
  boss_reveal: '北检查站',
  finale: '东码头',
  karim_intro: '北楼',
  souk_intro: '老城集市',
  rail_intro: '北站货场',
  port_intro: '东港集装箱场',
  finale2_intro: '东港集装箱场',
  ending2: '东港集装箱场',
  op01_intro: '街区',
};
for (const [id, scene] of Object.entries(SCENES)) {
  const want = SCENE_STAGE[id];
  if (!want) continue;
  for (const a of scene.actors || []) {
    const at = regionOf(a.x, a.z);
    check(`scene ${id} actor stands in ${want}`, at === want, `got "${at}" at (${a.x}, ${a.z})`);
  }
}

console.log(failures === 0 ? '\n[campaign-test] all checks passed' : `\n[campaign-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
