#!/usr/bin/env node
/**
 * AI AUDIT PROBE — measures the invariants this pass changed, in a real
 * browser, against the live game.
 *
 * The unit tests (tools/ai-profile-test.mjs) pin the LOGIC. This pins the
 * BEHAVIOUR, and it separates the two phases that were previously mixed
 * into one noisy number:
 *
 *   PHASE A (approach)  — from the wave start until the squad is engaged.
 *                         This is where a flank has to arrive behind you,
 *                         so the flank bearings are read HERE.
 *   PHASE B (engagement)— N seconds of actual contact. This is where the
 *                         incoming fire, the cover usage and the utility
 *                         use are read.
 *
 * A single fixed window measured "did the wave arrive", which varies wildly
 * between runs (13.8 m average in one run, 51 m in the next), so the
 * engagement is now the thing being measured.
 *
 * usage: node tools/ai-audit-probe.mjs [url] [wave] [seconds]
 *        POSTURES=stand,crouch  AUTO=0  to select one scenario
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'http://127.0.0.1:5173/';
const wave = Number(process.argv[3] || 8);
const seconds = Number(process.argv[4] || 14);
const W = 1280, H = 720;
const PORT = 9800 + Math.floor(Math.random() * 150);
const profile = `/tmp/dod-audit-${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync('shots', { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',' + H, '--force-device-scale-factor=1',
  '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ws;
let id = 0;
const pending = new Map();
const issues = [];
function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
function cleanup(code) {
  try { ws && ws.close(); } catch (e) { /* noop */ }
  try { chrome.kill('SIGKILL'); } catch (e) { /* noop */ }
  setTimeout(() => process.exit(code), 120);
}

async function runScenario(page, posture) {
  const expr = `(async () => {
    const g = window.__game;
    if (!g) return { error: 'no __game' };
    const G = g.state;
    document.querySelector('#mode-select-pills button[data-mode="survival"]')?.click();
    g.startGame(false);
    if (g.finishTutorial) g.finishTutorial();
    G.tutorial.done = true; G.tutorial.active = false;
    G.freezeEnemies = false;
    // Do NOT teleport the player: free play picks a random site, and a
    // fixed (0,20) often lands outside that site, which put the wave 70 m
    // away in a different part of the map. The deployment spawn is always
    // inside the site, so the spawn zones are local.
    const spawnPos = { x: g.player.pos.x, z: g.player.pos.z };
    g.startWave(${wave});
    const POSTURE = ${JSON.stringify(posture)};
    const AUTO = ${process.env.AUTO === '0' ? 'false' : 'true'};
    const DUR = ${seconds * 1000};

    // ---- shared counters -------------------------------------------------
    const acc = {
      leak: 0, leakSamples: 0,
      roleTicks: { assault: 0, flank: 0, suppress: 0, hold: 0, other: 0 },
      roleTicksTotal: 0, holdEmptyTicks: 0,
      flankBehind: 0, flankTotal: 0, flankDotSum: 0,
      flankEarlyBehind: 0, flankEarlyTotal: 0, flankEarlyDotSum: 0,
      flankFightBehind: 0, flankFightTotal: 0, flankFightDotSum: 0,
      // the decisive pincer metric: the flankers' bearing vs the MAIN
      // BODY's bearing, both relative to the player's facing. A real
      // flanking arc puts them on the opposite side from everyone else.
      mainTotal: 0, mainDotSum: 0,
      // the decisive crouch metric: of the enemies that CAN see you standing,
      // how many lose you when you crouch? (measured with the enemy's own
      // LOS function, in the live fight)
      sawStand: 0, sawCrouch: 0, lostOnCrouch: 0, visChecks: 0,
      coverSeen: 0, coverPhase: { hide: 0, peek: 0, move: 0 },
      distSum: 0, distN: 0, minDist: 999, sawLos: 0,
    };
    const sample = (phase) => {
      const p = g.player.pos;
      const f = { x: -Math.sin(g.player.yaw), z: -Math.cos(g.player.yaw) };
      const roles = {};
      for (const e of g.enemies) {
        if (!e.alive || !e.root.visible) continue;
        const ep = e.root.position;
        const d = Math.hypot(ep.x - p.x, ep.z - p.z);
        acc.distSum += d; acc.distN++;
        if (d < acc.minDist) acc.minDist = d;
        if (e.canSee) acc.sawLos++;
        // per-enemy: standing eye vs crouched eye against this enemy's own
        // line of sight (the same function the AI uses to decide to shoot)
        if (typeof e.canSeeTarget === 'function') {
          const stand = e.canSeeTarget(g.player.pos, d, 1.68);
          const crouch = e.canSeeTarget(g.player.pos, d, 1.05);
          acc.visChecks++;
          if (stand) { acc.sawStand++; if (!crouch) acc.lostOnCrouch++; }
          if (crouch) acc.sawCrouch++;
        }
        // wallhack check: aware but holding NO belief at all
        const aware = (e.awareness || 0) > 0.45;
        const hasBelief = !!(e.investigate || e.lastSeen);
        if (aware && !e.canSee && !hasBelief) acc.leak++;
        acc.leakSamples++;
        const r = e.aiRole || 'other';
        roles[r] = (roles[r] || 0) + 1;
        acc.roleTicks[r] = (acc.roleTicks[r] || 0) + 1;
        // A flank has to arrive BEHIND the player. Sampled in both phases:
        // 'early' = the first 8 s of the approach, 'fight' = once the fight
        // is joined (which is when a belief-gated flank actually starts).
        if (r === 'flank') {
          const rx0 = ep.x - p.x, rz0 = ep.z - p.z;
          const l0 = Math.hypot(rx0, rz0) || 1;
          const dot0 = (rx0 / l0) * f.x + (rz0 / l0) * f.z;
          acc.flankFightTotal++; acc.flankFightDotSum += dot0;
          if (dot0 < -0.3) acc.flankFightBehind++;
        } else if (r === 'assault' || r === 'hold' || r === 'suppress') {
          const rx1 = ep.x - p.x, rz1 = ep.z - p.z;
          const l1 = Math.hypot(rx1, rz1) || 1;
          acc.mainTotal++; acc.mainDotSum += (rx1 / l1) * f.x + (rz1 / l1) * f.z;
        }
        if (phase === 'approach' && r === 'flank') {
          const rx = ep.x - p.x, rz = ep.z - p.z;
          const l = Math.hypot(rx, rz) || 1;
          const dot = (rx / l) * f.x + (rz / l) * f.z;   // -1 = directly behind
          acc.flankTotal++; acc.flankDotSum += dot;
          if (dot < -0.3) acc.flankBehind++;
          // the pure approach: the first 8 s after the wave starts, before
          // the squad can have closed and turned the flank into a rush
          if (approachT < 8000) {
            acc.flankEarlyTotal++; acc.flankEarlyDotSum += dot;
            if (dot < -0.3) acc.flankEarlyBehind++;
          }
        }
        if (e.coverPhase) { acc.coverSeen++; acc.coverPhase[e.coverPhase] = (acc.coverPhase[e.coverPhase] || 0) + 1; }
      }
      acc.roleTicksTotal++;
      const liveRoles = Object.keys(roles).filter(k => k !== 'other');
      if (liveRoles.length >= 3 && !liveRoles.includes('hold')) acc.holdEmptyTicks++;
    };

    const aimAndShoot = () => {
      let best = null, bestD = 1e9;
      for (const e of g.enemies) {
        if (!e.alive || !e.root.visible || !e.canSeePlayer(g.player.pos)) continue;
        const d = Math.hypot(e.root.position.x - g.player.pos.x, e.root.position.z - g.player.pos.z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) { G.debugAutoFire = false; return; }
      const dx = best.root.position.x - g.player.pos.x;
      const dz = best.root.position.z - g.player.pos.z;
      g.player.setLook(Math.atan2(-dx, -dz), Math.atan2((best.root.position.y + 1.25) - 1.62, Math.hypot(dx, dz)));
    };

    // ================= PHASE A: the approach ================================
    const aT0 = performance.now();
    let engaged = false, approachMs = 0, approachT = 0;
    while (performance.now() - aT0 < 30000) {
      await new Promise(r => setTimeout(r, 120));
      approachT = performance.now() - aT0;
      sample('approach');
      let near = 0, seeing = 0;
      for (const e of g.enemies) {
        if (!e.alive || !e.root.visible) continue;
        const ep = e.root.position;
        const d = Math.hypot(ep.x - g.player.pos.x, ep.z - g.player.pos.z);
        if (d < 40) near++;
        if (e.canSee) seeing++;
      }
      if (near >= 2 && seeing >= 1) { engaged = true; approachMs = performance.now() - aT0; break; }
    }
    const approach = {
      engaged, approachSec: +(approachMs / 1000).toFixed(1),
      flankTotal: acc.flankTotal, flankBehind: acc.flankBehind,
      flankDot: acc.flankTotal ? +(acc.flankDotSum / acc.flankTotal).toFixed(2) : null,
      flankEarlyTotal: acc.flankEarlyTotal, flankEarlyBehind: acc.flankEarlyBehind,
      flankEarlyDot: acc.flankEarlyTotal ? +(acc.flankEarlyDotSum / acc.flankEarlyTotal).toFixed(2) : null,
      avgDist: acc.distN ? +(acc.distSum / acc.distN).toFixed(1) : null,
    };

    // ================= PHASE B: the engagement =============================
    // counters reset: only the fight itself is measured now
    acc.leak = 0; acc.leakSamples = 0; acc.roleTicks = { assault: 0, flank: 0, suppress: 0, hold: 0, other: 0 };
    acc.roleTicksTotal = 0; acc.holdEmptyTicks = 0; acc.coverSeen = 0;
    acc.coverPhase = { hide: 0, peek: 0, move: 0 };
    const bDistSum = 0; let bDistN = 0;
    const t0 = performance.now();
    let lastHp = G.hp, dmg = 0, hits = 0, burstT = 0;
    while (performance.now() - t0 < DUR) {
      await new Promise(r => setTimeout(r, 100));
      if (G.hp < lastHp) { dmg += lastHp - G.hp; hits++; }
      lastHp = G.hp;
      G.hp = G.maxHp; G.sinceDamage = 99;
      if (AUTO) {
        // BURST fire, not a held trigger: a continuous stream pins the nav
        // threat field and the squad routes around the player instead of
        // fighting (and the lane never gets suppressed).
        burstT += 100;
        G.debugAutoFire = (burstT % 1600) < 400;
        aimAndShoot();
      }
      if (POSTURE === 'strafe') {
        const a = (performance.now() - t0) / 700;
        g.player.setLook(Math.sin(a) * 1.1, -0.02);
        const p = g.player.pos;
        const nx = p.x + Math.cos(a) * 0.08;
        if (g.nav.isWalkableAt(nx, p.z, p.y)) p.x = nx;
      }
      const before = bDistN;
      sample('engage');
      bDistN += acc.distN - (acc.distNBefore || 0);
      acc.distNBefore = acc.distN;
    }
    if (POSTURE === 'crouch') window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));

    const ai = g.aiStats ? g.aiStats() : null;
    const eq = ai && ai.equipment ? ai.equipment : null;
    return {
      posture: POSTURE,
      spawnPos,
      engaged,
      // the flank bearings DURING the fight — this is where a belief-gated
      // flank actually runs, so it is the number that matters
      flankFightTotal: acc.flankFightTotal, flankFightBehind: acc.flankFightBehind,
      flankFightDot: acc.flankFightTotal ? +(acc.flankFightDotSum / acc.flankFightTotal).toFixed(2) : null,
      mainDot: acc.mainTotal ? +(acc.mainDotSum / acc.mainTotal).toFixed(2) : null,
      mainTotal: acc.mainTotal,
      damage: +dmg.toFixed(1), hitEvents: hits, dps: +(dmg / ${seconds}).toFixed(2),
      leak: acc.leak, leakSamples: acc.leakSamples,
      visibility: {
        checks: acc.visChecks, sawStand: acc.sawStand, sawCrouch: acc.sawCrouch,
        lostOnCrouch: acc.lostOnCrouch,
      },
      roleTicks: acc.roleTicks, roleTicksTotal: acc.roleTicksTotal, holdEmptyTicks: acc.holdEmptyTicks,
      coverSeen: acc.coverSeen, coverPhase: acc.coverPhase,
      approach,
      equipment: eq,
      director: ai && ai.director ? ai.director : null,
      roles: ai && ai.roles ? ai.roles : null,
      tier: G.diff && G.diff.id,
    };
  })()`;

  let r = null, lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await send('Page.navigate', { url });
      await sleep(Number(process.env.BOOT_MS || 9000));
    }
  }
  if (lastErr) throw lastErr;
  if (r.exceptionDetails) {
    fs.writeFileSync('/tmp/audit-expr.js', expr);
    throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  }
  const raw = r.result && r.result.value;
  if (!raw || raw.error) throw new Error('scenario failed: ' + JSON.stringify(raw || r).slice(0, 600));
  return raw;
}

(async () => {
  try {
    let targets = null;
    for (let i = 0; i < 100; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets?.length) break; } catch (e) { /* retry */ }
      await sleep(150);
    }
    if (!targets) throw new Error('devtools endpoint never came up\n' + chromeErr.slice(-1200));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessage: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        issues.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        issues.push('[console] ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(Number(process.env.BOOT_MS || 9000));

    const out = { wave, seconds, url };
    const postures = (process.env.POSTURES || 'stand,crouch,strafe').split(',');
    for (const posture of postures) {
      out[posture] = await runScenario(page, posture);
      const s = out[posture];
      process.stderr.write(`  ${posture}: dps=${s.dps} engaged=${s.approach.engaged} flankBehind=${s.approach.flankBehind}/${s.approach.flankTotal} cover=${s.director && s.director.coverClaims} frag=${s.equipment && s.equipment.frag}\n`);
    }

    const s = out.stand || out.crouch || out.strafe;
    const c = out.crouch, m = out.strafe;
    const lines = [];
    const push = (ok, label, detail) => lines.push(`${ok ? 'PASS' : 'WARN'}  ${label}${detail ? ' — ' + detail : ''}`);
    push(s.approach.engaged, 'the wave actually reached the player', `in ${s.approach.approachSec}s`);
    push(s.leak === 0, 'no aware-without-belief frames (wallhack closed)', `leak=${s.leak}/${s.leakSamples}`);
    push(s.holdEmptyTicks === 0, 'every 3+ squad keeps a base of fire', `emptyTicks=${s.holdEmptyTicks}/${s.roleTicksTotal}`);
    const vis = s.visibility || {};
    push(vis.sawStand === 0 || vis.lostOnCrouch > 0, 'crouching breaks enemy line of sight',
      `saw=${vis.sawStand} lostOnCrouch=${vis.lostOnCrouch} stillSaw=${vis.sawCrouch} (checks=${vis.checks})`);
    push(s.equipment && s.equipment.frag > 0, 'the enemy frag actually leaves a hand',
      `frag=${s.equipment && s.equipment.frag} denied=${s.equipment && s.equipment.denied}`);
    // the pincer test: the flankers must be on a DIFFERENT bearing from the
    // main body (that is what "flanked" means), and ideally behind the
    // player's facing while the main body is in front
    const sep = (s.flankFightTotal && s.mainTotal)
      ? +(s.flankFightDot - s.mainDot).toFixed(2) : null;
    push(sep !== null && Math.abs(sep) > 0.4, 'the flank comes from a different bearing than the main body',
      `flankDot=${s.flankFightDot} mainDot=${s.mainDot} sep=${sep} (${s.flankFightBehind}/${s.flankFightTotal} behind)`);
    push(s.director && s.director.coverClaims > 0, 'soldiers take cover under fire',
      `coverClaims=${s.director && s.director.coverClaims}`);
    if (c) push(c.dps < s.dps, 'crouching measurably reduces incoming fire',
      `stand=${s.dps}/s crouch=${c.dps}/s`);
    if (m) push(m.dps < s.dps, 'moving measurably reduces incoming fire',
      `stand=${s.dps}/s strafe=${m.dps}/s`);

    out.verdict = lines;
    fs.writeFileSync('shots/ai-audit-probe.json', JSON.stringify(out, null, 2));
    const brief = (x) => x && ({
      dps: x.dps, hitEvents: x.hitEvents, leak: `${x.leak}/${x.leakSamples}`,
      holdEmpty: `${x.holdEmptyTicks}/${x.roleTicksTotal}`,
      frag: x.equipment && x.equipment.frag, denied: x.equipment && x.equipment.denied,
      campT: x.equipment && x.equipment.campT, coverClaims: x.director && x.director.coverClaims,
      approach: x.approach, roles: x.roles,
    });
    console.log(JSON.stringify({ wave, tier: s.tier, seconds, stand: brief(s), crouch: brief(c), strafe: brief(m) }, null, 2));
    console.log('\n' + lines.join('\n'));
    if (issues.length) console.log('\nISSUES:\n' + [...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('AUDIT FAILED:', e.message);
    cleanup(1);
  }
})();
