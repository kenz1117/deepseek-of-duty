#!/usr/bin/env node
/**
 * Deterministic gameplay recorder.
 * usage: node tools/record.mjs <url> <framesDir> [width] [height]
 *
 * Boots the game in headless Chrome, captures a screencast of the menu
 * cinematic plus one full scripted combat run (aim / move / burst fire /
 * reload / weapon swap / grenade), and writes JPEG frames + a ffconcat
 * manifest ready for ffmpeg.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'http://127.0.0.1:8321/';
const outDir = process.argv[3] || '/tmp/dod-rec';
const W = Number(process.argv[4] || 1920);
const H = Number(process.argv[5] || 1080);
const PORT = 9600 + Math.floor(Math.random() * 300);
const profile = `/tmp/dod-rec-${PORT}`;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  // headed window parked offscreen: headless mode has no CVDisplayLink on
  // macOS, so Page.startScreencast never emits frames — a real window does.
  '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',' + H,
  '--window-position=40,40',
  '--force-device-scale-factor=1',
  '--use-angle=metal',
  '--enable-gpu',
  '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return res.json();
}

let ws;
let id = 0;
const pending = new Map();
const frames = []; // { file, ts }
const consoleErrors = [];

function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

function cleanup(code) {
  try { ws && ws.close(); } catch (e) { }
  try { chrome.kill('SIGKILL'); } catch (e) { }
  setTimeout(() => process.exit(code), 150);
}

// ---------------------------------------------------------------- driver
// Runs inside the page. Timeline (ms after startGame):
//  - menu cinematic until 4200ms wall time, then deploy without pointer lock
//  - movement segments, aim smoothing toward nearest living enemy,
//    burst fire via G.debugAutoFire, auto reload, one weapon swap,
//    one grenade, inspect animation as the outro.
const DRIVER = `(() => new Promise((resolve, reject) => {
  window.__DRIVER_BOOT = true;
  const g = window.__game;
  if (!g) { reject(new Error('__game missing')); return; }
  const G = g.state;
  const P = g.player;
  const enemies = g.enemies;
  const t0 = performance.now();
  const kd = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const ku = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const tp = (x, z, lookX, lookZ) => {
    const spot = g.nav.closestWalkable(x, z) || { x, z };
    P.pos.x = spot.x; P.pos.z = spot.z; P.vel && P.vel.set(0, 0, 0);
    if (lookX !== undefined) {
      const dx = lookX - spot.x, dz = lookZ - spot.z;
      P.setLook(Math.atan2(-dx, -dz), 0.02);
    }
  };
  const spawnNear = (n, r) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, d = r * (0.7 + Math.random() * 0.5);
      try { g.spawnEnemy({ x: P.pos.x + Math.sin(a) * d, z: P.pos.z + Math.cos(a) * d }); } catch (e) {}
    }
  };
  const SCENES = [
    { at: 0,     run: () => {} },
    { at: 7000,  run: () => { tp(-6.6, 54, -6.6, 62.6); } },
    { at: 12000, run: () => { try { g.switchWeapon(2); } catch (e) {} try { g.startWave(3); } catch (e) {} tp(14, 70, 20, 62); } },
    { at: 19500, run: () => { if (g.hotDrop && g.hotDrop.active) tp(g.hotDrop.x + 1.2, g.hotDrop.z + 1.2, g.hotDrop.x, g.hotDrop.z); } },
    { at: 23000, run: () => { tp(4, 44, 4, 20); } },
  ];
  let notifyCount = 0, nextNotify = 23500;
  let moveKeys = [], moveUntil = 0, nextMoveAt = 2500;
  let si = 0;
  let startedFlag = false;
  function started0() {
    if (!startedFlag && performance.now() - t0 >= 4200) {
      startedFlag = true;
      G.lockHint = true;
      g.startGame(false, true);
      G.lockHint = true;
      G.debugAutoFire = false;
      G.debugWaves = true;
      G.maxHp = 99999; G.hp = 99999; if ('armor' in G) G.armor = 100;
    }
    return startedFlag;
  }
  function frame() {
    window.__DRIVER_TICK = (window.__DRIVER_TICK || 0) + 1;
    try {
    const t = performance.now() - t0;
    if (!startedFlag) { if (!started0()) { requestAnimationFrame(frame); return; } }
    const ts = t - 4200;
    while (si < SCENES.length && ts >= SCENES[si].at) { try { SCENES[si++].run(); } catch (e) { window.__SC_ERR = String(e); } for (const k of moveKeys) ku(k); moveKeys = []; nextMoveAt = ts + 1800; }
    if (ts >= 23500 && notifyCount < 11 && ts >= nextNotify) {
      try { g.streaks.notifyKill(); notifyCount++; } catch (e) { window.__NK_ERR = String(e); }
      nextNotify = ts + 550;
    }
    let best = null, bestD = 1e9;
    const p = P.pos;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.root.position.x - p.x, e.root.position.z - p.z);
      if (d > 1.5 && d < bestD) { bestD = d; best = e; }
    }
    if (best) {
      const px = P.pos.x, py = P.pos.y + P.eyeHeight, pz = P.pos.z;
      const dx = best.root.position.x - px, dy = (best.root.position.y + 1.05) - py, dz = best.root.position.z - pz;
      const hd = Math.hypot(dx, dz) || 0.001;
      const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, hd);
      const k = 1 - Math.exp(-0.016 * 9);
      P.setLook(P.yaw + wrap(wantYaw - P.yaw) * k, P.pitch + (wantPitch - P.pitch) * k + (Math.random() - 0.5) * 0.004);
      G.debugAutoFire = bestD < 40;
      if (ts >= nextMoveAt && bestD > 3.5) {
        for (const k of moveKeys) ku(k);
        const r = Math.random();
        moveKeys = r < 0.55 ? ['KeyW'] : (r < 0.8 ? ['KeyW', 'KeyA'] : ['KeyW', 'KeyD']);
        for (const k of moveKeys) kd(k);
        if (Math.random() < 0.4) { kd('ShiftLeft'); moveKeys.push('ShiftLeft'); }
        moveUntil = ts + 550 + Math.random() * 350;
        nextMoveAt = moveUntil + 1200 + Math.random() * 1500;
      }
      if (moveKeys.length && ts >= moveUntil) { for (const k of moveKeys) ku(k); moveKeys = []; }
    } else {
      G.debugAutoFire = false;
      P.setLook(P.yaw + 0.004, P.pitch * 0.99);
    }
    if (G.mag <= 2 && G.reloadTimer < 0 && G.reserve > 0) g.reload();
    if (G.hp < G.maxHp) G.hp = G.maxHp;
    if (ts >= 29500) {
      G.debugAutoFire = false; for (const k of moveKeys) ku(k); moveKeys = [];
      resolve({ kills: G.kills, score: G.score, wave: G.wave, notified: notifyCount, scErr: window.__SC_ERR || null, nkErr: window.__NK_ERR || null });
      return;
    }
    requestAnimationFrame(frame);
    } catch (err) { window.__DRIVER_ERR = String(err && err.message || err); }
  }
  requestAnimationFrame(frame);
}))()`;


// ---------------------------------------------------------------- main
(async () => {
  const t0 = Date.now();
  try {
    let targets = null;
    for (let i = 0; i < 100; i++) {
      try {
        targets = await getJSON('/json/list');
        if (targets && targets.length) break;
      } catch (e) { }
      await sleep(150);
    }
    if (!targets) throw new Error('devtools endpoint never came up.\n' + chromeErr.slice(-2000));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Page.screencastFrame') {
        const p = msg.params;
        const idx = frames.length;
        const file = path.join(outDir, `f_${String(idx).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(p.data, 'base64'));
        frames.push({ file, ts: (p.metadata && p.metadata.timestamp) || performance.now() / 1000 });
        ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: p.sessionId } }));
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const t = msg.params.type;
        if (t === 'error') {
          consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleErrors.push('[exception] ' + (d.exception?.description || d.text));
      }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    const loaded = new Promise((resolve) => {
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Page.loadEventFired') { ws.off('message', handler); resolve(); }
      };
      ws.on('message', handler);
      setTimeout(resolve, 8000);
    });
    await send('Page.navigate', { url });
    await loaded;

    const readyExpr = "window.__game && __game.engine && document.getElementById('loading').classList.contains('hidden')";
    let ready = false;
    for (let i = 0; i < 160; i++) {
      const r = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true }).catch(() => null);
      if (r && r.result && r.result.value === true) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new Error('game never signalled __READY');
    await sleep(1200); // let the menu cinematic settle

    await send('Page.startScreencast', {
      format: 'jpeg', quality: 75,
      maxWidth: W, maxHeight: H, everyNthFrame: 3,
    });
    console.log(`screencast started, driving match… (t=${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    // inject the autoplayer; completion is polled via window.__DRIVER_DONE
    // because awaitPromise on a 55s rAF-driven promise is unreliable here
    send('Runtime.evaluate', { expression: DRIVER, returnByValue: true, awaitPromise: true })
      .catch((e) => console.log('driver evaluate error:', e.message));

    let done = null;
    for (let i = 0; i < 150; i++) {
      await sleep(1000);
      const r = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({ done: window.__DRIVER_DONE || null, err: window.__DRIVER_ERR || null, boot: !!window.__DRIVER_BOOT, ticks: window.__DRIVER_TICK || 0 })',
        returnByValue: true,
      }).catch(() => null);
      const v = r && r.result && r.result.value;
      let st = null;
      try { st = JSON.parse(v); } catch (e) { }
      if (st && st.err) throw new Error('driver crashed: ' + st.err);
      if (st && st.done) { done = st.done; break; }
      if (i % 5 === 4) console.log(`  … ${frames.length} frames, driver boot=${st && st.boot} ticks=${st && st.ticks} (t=${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    if (!done) throw new Error('driver never finished within 150s');
    await sleep(600);

    console.log('match state:', JSON.stringify(done));
    await send('Page.stopScreencast');

    // ffconcat manifest (VFR: real frame timestamps, repeated last entry)
    if (frames.length < 100) throw new Error(`only ${frames.length} frames captured`);
    let list = 'ffconcat version 1.0\n';
    for (let i = 0; i < frames.length; i++) {
      const dur = Math.max(0.004, (frames[i + 1] ? frames[i + 1].ts : frames[i].ts + 0.05) - frames[i].ts);
      list += `file '${path.basename(frames[i].file)}'\nduration ${dur.toFixed(4)}\n`;
    }
    list += `file '${path.basename(frames[frames.length - 1].file)}'\n`;
    fs.writeFileSync(path.join(outDir, 'list.txt'), list);

    const span = frames[frames.length - 1].ts - frames[0].ts;
    console.log(`captured ${frames.length} frames, span ${span.toFixed(2)}s, avg fps ${(frames.length / span).toFixed(1)}`);
    if (consoleErrors.length) {
      console.log('--- console issues ---');
      for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log(e);
    }
    cleanup(0);
  } catch (err) {
    console.error('RECORD FAILED:', err.message);
    if (chromeErr) console.error(chromeErr.slice(-1500));
    cleanup(1);
  }
})();
