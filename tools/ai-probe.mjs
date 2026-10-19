#!/usr/bin/env node
/**
 * AI behaviour probe — runs a live (non-shot) wave in headless Chrome and
 * samples enemy decision state, engagement distance, stacking, stuck time and
 * incoming damage. Used before/after AI changes so tuning is measured, not
 * guessed.
 *
 * usage: node tools/ai-probe.mjs <wave> [seconds] [url] [outfile]
 *   WAVE=8 node tools/ai-probe.mjs 8 14
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wave = Number(process.argv[2] || 8);
const seconds = Number(process.argv[3] || 14);
const url = process.argv[4] || 'http://127.0.0.1:5173/';
const out = process.argv[5] || `shots/ai-probe-w${wave}.json`;
const W = 1280, H = 720;
const PORT = 9500 + Math.floor(Math.random() * 300);
const profile = `/tmp/dod-ai-${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--mute-audio', '--window-size=' + W + ',' + H, '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ws;
let id = 0;
const pending = new Map();
const issues = [];
function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}
function cleanup(code) {
  try { ws && ws.close(); } catch (e) { /* noop */ }
  try { chrome.kill('SIGKILL'); } catch (e) { /* noop */ }
  setTimeout(() => process.exit(code), 120);
}

(async () => {
  try {
    let targets = null;
    for (let i = 0; i < 100; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets?.length) break; } catch (e) { /* retry */ }
      await sleep(150);
    }
    if (!targets) throw new Error('devtools endpoint never came up\n' + chromeErr.slice(-1500));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        issues.push('[exception] ' + (d.exception?.description || d.text));
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

    const expr = `(async () => {
      const g = window.__game;
      if (!g) return { error: 'no __game' };
      const G = g.state;
      // free-play mode: no campaign intro/cinematic, no operation scripting
      document.querySelector('#mode-select-pills button[data-mode="survival"]')?.click();
      g.startGame(false);
      if (g.finishTutorial) g.finishTutorial();
      G.tutorial.done = true; G.tutorial.active = false;
      G.freezeEnemies = false;
      g.player.revive(${Number(process.env.PX || 0)}, ${Number(process.env.PZ || 20)});
      g.player.setLook(0, -0.02);
      g.startWave(${wave});
      const AUTO = ${process.env.AUTO === '1' ? 'true' : 'false'};
      if (AUTO) G.debugAutoFire = true;
      const DUR = ${seconds * 1000};
      const t0 = performance.now();
      const samples = [];
      const damage = [];
      let lastHp = G.hp;
      let fpsAcc = 0, fpsN = 0;
      while (performance.now() - t0 < DUR) {
        await new Promise(r => setTimeout(r, 100));
        if (G.hp < lastHp) damage.push(+ (lastHp - G.hp).toFixed(1));
        lastHp = G.hp;
        G.hp = G.maxHp;            // keep the observer alive
        G.sinceDamage = 99;
        if (AUTO) {
          // aim at the nearest visible hostile (a crude but repeatable stand-in
          // for a player), otherwise sweep the street
          let best = null, bestD = 1e9;
          for (const e of g.enemies) {
            if (!e.alive || !e.root.visible || !e.canSeePlayer(g.player.pos)) continue;
            const d = Math.hypot(e.root.position.x - g.player.pos.x, e.root.position.z - g.player.pos.z);
            if (d < bestD) { bestD = d; best = e; }
          }
          if (best) {
            const dx = best.root.position.x - g.player.pos.x;
            const dz = best.root.position.z - g.player.pos.z;
            g.player.setLook(Math.atan2(-dx, -dz), Math.atan2((best.root.position.y + 1.25) - 1.62, Math.hypot(dx, dz)));
          } else {
            const a = ((performance.now() - t0) / 1000) * 0.55;
            g.player.setLook(Math.sin(a) * 1.15, -0.03);
          }
        }
        const p = g.player.pos;
        const es = [];
        for (const e of g.enemies) {
          if (!e.root.visible) continue;
          const ep = e.root.position;
          const d = Math.hypot(ep.x - p.x, ep.z - p.z);
          es.push({
            a: e.archetype, s: e.state, see: e.canSee ? 1 : 0, alive: e.alive ? 1 : 0,
            d: +d.toFixed(2), x: +ep.x.toFixed(2), y: +ep.y.toFixed(2), z: +ep.z.toFixed(2),
            sp: +(e.speed || 0).toFixed(2), hp: Math.round(e.hp), boss: e.isBoss ? 1 : 0,
            role: e.aiRole || null, aw: e.awareness != null ? +e.awareness.toFixed(2) : null,
          });
        }
        samples.push({ t: +((performance.now() - t0) / 1000).toFixed(1), px: +p.x.toFixed(1), pz: +p.z.toFixed(1), hp: Math.round(G.hp), es });
        if (G.fps > 0) { fpsAcc += G.fps; fpsN++; }
      }
      return { samples, damage, fps: fpsN ? +(fpsAcc / fpsN).toFixed(1) : 0, state: G.state, wave: G.wave,
        tier: G.diff && G.diff.id, kills: G.kills, shots: G.shotsFired,
        ai: g.aiStats ? g.aiStats() : null };
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const raw = r.result && r.result.value;
    if (!raw || raw.error) throw new Error('probe failed: ' + JSON.stringify(raw || r).slice(0, 800));

    /* ---------------- aggregate ---------------- */
    const states = {};
    const roles = {};
    const eng = [];
    const seeEng = [];
    let overlapSamples = 0, overlapMax = 0, minPairSum = 0, minPairN = 0;
    let activeSamples = 0;
    const stuck = new Map();
    let seeButHold = 0, seeSamples = 0;
    let alivePeak = 0;
    let idleGround = 0, idleRoof = 0, groundSamples = 0;
    for (const s of raw.samples) {
      const alive = s.es.filter((e) => e.alive);
      if (!alive.length) continue;
      activeSamples++;
      alivePeak = Math.max(alivePeak, alive.length);
      let pairs = 0;
      let minPair = 99;
      for (let i = 0; i < alive.length; i++) {
        states[alive[i].s] = (states[alive[i].s] || 0) + 1;
        if (alive[i].y > 0.6) { if (alive[i].s === 'idle') idleRoof++; }
        else { groundSamples++; if (alive[i].s === 'idle') idleGround++; }
        if (alive[i].role) roles[alive[i].role] = (roles[alive[i].role] || 0) + 1;
        if (alive[i].see) {
          seeSamples++;
          seeEng.push(alive[i].d);
          if (alive[i].s !== 'engage' && alive[i].s !== 'cover') seeButHold++;
        }
        if (!alive[i].see && alive[i].d < 60) eng.push(alive[i].d);
        for (let j = i + 1; j < alive.length; j++) {
          const dx = alive[i].x - alive[j].x, dz = alive[i].z - alive[j].z;
          const pd = Math.hypot(dx, dz);
          if (pd < minPair) minPair = pd;
          if (pd < 0.9) pairs++;
        }
        // stuck: wants to close in but barely moves, no LOS, still far away
        if (!alive[i].see && alive[i].d > 6 && alive[i].sp < 0.15) {
          stuck.set(i, (stuck.get(i) || 0) + 1);
        }
      }
      overlapSamples += pairs;
      overlapMax = Math.max(overlapMax, pairs);
      if (minPair < 90) { minPairSum += minPair; minPairN++; }
    }
    const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
    const summary = {
      wave: raw.wave, tier: raw.tier, seconds, fps: raw.fps,
      samples: raw.samples.length,
      activeSamples,
      alivePeak,
      states,
      roles,
      seeRatio: seeSamples ? +(seeButHold / seeSamples).toFixed(2) : null,
      engagedWithLosPct: seeSamples ? +(seeSamples / (activeSamples * alivePeak) * 100).toFixed(1) : 0,
      avgDistNoLos: avg(eng),
      avgDistLos: avg(seeEng),
      pairOverlapPerSample: activeSamples ? +(overlapSamples / activeSamples).toFixed(2) : 0,
      pairOverlapMax: overlapMax,
      minPairAvg: minPairN ? +(minPairSum / minPairN).toFixed(2) : null,
      idleGroundPct: groundSamples ? +(idleGround / groundSamples * 100).toFixed(1) : 0,
      idleRoofSamples: idleRoof,
      groundSamples,
      stuckSamples: [...stuck.values()].filter((n) => n >= 3).length,
      kills: raw.kills || 0,
      playerShots: raw.shots || 0,
      aiDirector: raw.ai && raw.ai.director ? raw.ai.director : null,
      aiPerception: raw.ai && raw.ai.perception ? raw.ai.perception : null,
      damageEvents: raw.damage.length,
      damageTotal: +raw.damage.reduce((a, b) => a + b, 0).toFixed(1),
      damagePerSec: +(raw.damage.reduce((a, b) => a + b, 0) / seconds).toFixed(2),
    };
    fs.writeFileSync(out.replace(/\.json$/, '.raw.json'), JSON.stringify(raw));
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (issues.length) console.log('ISSUES:\n' + [...new Set(issues)].slice(0, 8).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('AI PROBE FAILED:', e.message);
    if (issues.length) console.error([...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(1);
  }
})();
