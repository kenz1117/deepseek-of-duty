#!/usr/bin/env node
/**
 * Fairness probe — a repeatable "decent human" player instead of a perfect
 * aimbot. The bot re-acquires targets with a ~150 ms cadence, adds ~1.2° of
 * aim error, fires in bursts, reloads, and strafes a little. That is enough to
 * expose damage spikes that the idle-player probe hides and that a perfect
 * aimbot never suffers.
 *
 * usage: node tools/fairness.mjs <wave> [seconds] [url] [out]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wave = Number(process.argv[2] || 8);
const seconds = Number(process.argv[3] || 30);
const url = process.argv[4] || 'http://127.0.0.1:5173/';
const out = process.argv[5] || `shots/fairness-w${wave}.json`;
const W = 1280, H = 720;
const PORT = 9800 + Math.floor(Math.random() * 150);
const profile = `/tmp/dod-fair-${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',' + H, '--force-device-scale-factor=1',
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
    if (!targets) throw new Error('devtools endpoint never came up\n' + chromeErr.slice(-1200));
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
        issues.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        issues.push('[console] ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    // The device-metrics override re-creates the renderer on current Chrome
    // builds, which reloads the page and kills the CDP session mid-probe
    // ("Inspected target navigated or closed"). The --window-size flag already
    // gives us the viewport we want, so the override is opt-in only.
    if (process.env.SET_METRICS) {
      await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    }
    await send('Page.navigate', { url });
    // Vite's dependency optimizer forces a full page reload on the first
    // load of a fresh dev server, which kills the CDP session if we evaluate
    // too early. 20 s is the safe default; override with BOOT_MS.
    await sleep(Number(process.env.BOOT_MS || 20000));

    const expr = `(async () => {
      const g = window.__game;
      if (!g) return { error: 'no __game' };
      const G = g.state;
      // Force survival mode. The menu pill click is unreliable in a
      // production bundle, and a CAMPAIGN run is fatal for the probe:
      // OP01 is three waves long, so startWave(8) would finish the
      // operation and the probe would measure an empty map.
      try { g.setSetting('runMode', 'survival'); } catch (e) {}
      document.querySelector('#mode-select-pills button[data-mode="survival"]')?.click();
      try { g.setSetting('runMode', 'survival'); } catch (e) {}
      g.startGame(false);
      if (g.finishTutorial) g.finishTutorial();
      G.tutorial.done = true; G.tutorial.active = false;
      G.freezeEnemies = false;
      g.player.revive(0, 22);
      g.player.setLook(0, -0.02);
      g.startWave(${wave});
      const DUR = ${seconds * 1000};
      const t0 = performance.now();
      const samples = [];
      let lastHp = G.hp, dmg = 0, deaths = 0, deathAt = null, burst = 0, targetId = null;
      let aimAcc = 0;
      const errY = () => (Math.random() - 0.5) * 0.042;   // ~1.2 deg
      const errP = () => (Math.random() - 0.5) * 0.03;
      while (performance.now() - t0 < DUR) {
        await new Promise(r => setTimeout(r, 80));
        const now = performance.now() - t0;
        const p = g.player.pos;
        G.debugAutoFire = false;

        if (G.hp <= 0) { if (!deathAt) { deaths++; deathAt = +(now / 1000).toFixed(1); } await new Promise(r => setTimeout(r, 300)); continue; }

        // human-ish target acquisition: 150 ms cadence, nearest visible hostile
        aimAcc += 80;
        let target = null, bestD = 1e9;
        for (const e of g.enemies) {
          if (!e.alive || !e.root.visible) continue;
          if (!e.canSeePlayer(p)) continue;
          const d = Math.hypot(e.root.position.x - p.x, e.root.position.z - p.z);
          if (d < bestD) { bestD = d; target = e; }
        }
        if (target) {
          const ep = target.root.position;
          if (aimAcc >= 150 || targetId !== target.root.id) {
            aimAcc = 0; targetId = target.root.id;
            const yaw = Math.atan2(-(ep.x - p.x), -(ep.z - p.z)) + errY();
            const pitch = Math.atan2((ep.y + 1.2) - (p.y + 1.62), Math.hypot(ep.x - p.x, ep.z - p.z)) + errP();
            g.player.setLook(yaw, pitch);
          }
          burst += 80;
          if (burst % 520 < 360) G.debugAutoFire = true;
        }

        if (G.mag === 0 && G.reserve > 0) g.reload();

        // light strafe, respecting collision-ish points
        const dir = Math.sin(now / 900) > 0 ? 1 : -1;
        const nx = p.x + dir * 0.035;
        if (g.nav.isWalkableAt(nx, p.z, p.y)) p.x = nx;

        if (G.hp < lastHp) dmg += lastHp - G.hp;
        lastHp = G.hp;
        samples.push({ t: +(now / 1000).toFixed(1), hp: Math.round(G.hp), kills: G.kills, mag: G.mag, alive: g.enemies.filter(e => e.alive).length });
      }
      return {
        samples, seconds: ${seconds}, wave: G.wave, tier: G.diff && G.diff.id,
        kills: G.kills, shots: G.stats ? G.stats.shots : G.shotsFired,
        hits: G.stats ? G.stats.hits : null,
        damage: +dmg.toFixed(1), deaths, deathAt,
        equipment: g.aiStats ? g.aiStats().equipment : null,
        barks: g.aiStats ? g.aiStats().barks : null,
        // ---- death attribution: who killed the bot, from how far, doing what
        deathLog: (G.deathLog || []).slice(),
        lastDamage: G.lastDamage || null,
      };
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const raw = r.result && r.result.value;
    if (!raw || raw.error) throw new Error('fairness failed: ' + JSON.stringify(raw || r).slice(0, 700));

    const hpMin = Math.min(...raw.samples.map((s) => s.hp));
    const spent = raw.damage;
    /* ---- death attribution table ---------------------------------------
       "Who killed me" is the only question a wave can answer. Bucket the
       death log by archetype, by squad role and by range so a bad wave can
       be attributed instead of guessed at. */
    const log = raw.deathLog || [];
    const bucket = (d) => {
      if (d < 10) return '0-10m';
      if (d < 20) return '10-20m';
      if (d < 35) return '20-35m';
      return '35m+';
    };
    const tally = (key) => {
      const m = {};
      for (const d of log) {
        const k = key(d);
        m[k] = (m[k] || 0) + 1;
      }
      return m;
    };
    const attribution = {
      deaths: log.length,
      byArchetype: tally((d) => d.archetype || (d.utility ? 'utility' : 'unknown')),
      byRole: tally((d) => d.role || 'unknown'),
      byRange: tally((d) => bucket(d.dist || 0)),
      byUtility: tally((d) => (d.utility ? 'utility' : 'bullet')),
      log,
    };
    const summary = {
      wave: raw.wave, tier: raw.tier, seconds: raw.seconds,
      kills: raw.kills, shots: raw.shots, hits: raw.hits,
      damageTaken: spent,
      dpsTaken: +(spent / raw.seconds).toFixed(2),
      hpMin,
      deaths: raw.deaths,
      deathAt: raw.deathAt,
      attribution,
      equipment: raw.equipment,
      barks: raw.barks,
    };
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (issues.length) console.log('ISSUES:\n' + [...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('FAIRNESS FAILED:', e.message);
    if (issues.length) console.error([...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(1);
  }
})();
