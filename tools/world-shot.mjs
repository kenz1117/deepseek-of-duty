#!/usr/bin/env node
/**
 * District walk-through capture (headless Chrome + CDP).
 *
 * Teleports the camera through the map and captures one PNG per pose, so a
 * pass over the world can be judged from real frames instead of from code.
 *
 * usage:
 *   node tools/world-shot.mjs [outDir] [poseName ...]
 *   node tools/world-shot.mjs shots/world            # every pose
 *   node tools/world-shot.mjs shots/world souk port  # a subset
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:5173/';
const OUT_DIR = process.argv[2] || 'shots/world';
const WANT = process.argv.slice(3);

/* name, x, z, yaw, pitch, (optional) look-at target for a framing shot */
const POSES = [
  { name: 'street', x: 1.6, z: 27.5, yaw: -0.05, pitch: -0.02 },
  { name: 'street-back', x: 0, z: 12, yaw: 3.1, pitch: -0.04 },
  { name: 'street-trees', x: 0, z: 34, yaw: 0.0, pitch: -0.02 },
  { name: 'souk-plaza', x: -95, z: 58, yaw: 0.0, pitch: -0.03 },
  { name: 'souk-court', x: -96, z: 44, yaw: -2.3, pitch: -0.06 },
  { name: 'souk-alley', x: -100.5, z: 30, yaw: 0.0, pitch: -0.02 },
  { name: 'souk-arch', x: -62, z: 20, yaw: 0.2, pitch: 0.04 },
  { name: 'rail-yard', x: 0, z: -140, yaw: 0.05, pitch: -0.02 },
  { name: 'rail-pond', x: -32, z: -179, yaw: 0.0, pitch: -0.16 },
  { name: 'rail-canal', x: -10, z: -142, yaw: 0.0, pitch: -0.05 },
  { name: 'rail-channel', x: 6, z: -180, yaw: 0.0, pitch: -0.02 },
  { name: 'rail-platform', x: 0, z: -148, yaw: 1.6, pitch: 0.0 },
  { name: 'rail-gate', x: 6, z: -100, yaw: 3.1, pitch: 0.02 },
  { name: 'port-yard', x: 80, z: -70, yaw: 0.6, pitch: -0.03 },
  { name: 'port-canal', x: 100, z: -22, yaw: 0.0, pitch: -0.14 },
  { name: 'port-canal2', x: 62, z: -20, yaw: 0.35, pitch: -0.08 },
  { name: 'port-quay', x: 104, z: -60, yaw: 1.5, pitch: -0.02 },
  { name: 'port-gate', x: 47, z: -80, yaw: -1.5, pitch: 0.0 },
  { name: 'dock', x: 120, z: -10, yaw: 1.2, pitch: 0.0 },
  { name: 'south-yard', x: 0, z: 70, yaw: 0.4, pitch: -0.04 },
  { name: 'north-hq', x: 10, z: -70, yaw: 0.0, pitch: 0.02 },
  { name: 'foothill-river', x: -178, z: -20, yaw: 0.0, pitch: -0.10 },
];

/* top-down views for layout proofs */
const TOP_VIEWS = [
  { name: 'street', x: 0, z: 0, h: 90 },
  { name: 'souk', x: -80, z: 20, h: 90 },
  { name: 'rail', x: 0, z: -155, h: 90 },
  { name: 'port', x: 82, z: -35, h: 95 },
  { name: 'hills', x: -176, z: -30, h: 70 },
];

const PORT = 9600 + Math.floor(Math.random() * 200);const profile = `/tmp/dod-world-shot-${PORT}`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=1600,900', '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map(); const consoleErrors = [];
function send(method, params = {}, sessionId) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}

try {
  let targets = null;
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets && targets.length) break;
    } catch { /* warming up */ }
    await sleep(150);
  }
  if (!targets) throw new Error('chrome devtools never came up\n' + chromeErr.slice(-1200));
  const page = targets.find((t) => t.type === 'page') || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleErrors.push(`[${msg.params.type}] ` + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${PAGE}?shot=1&pose=hero` });
  for (let i = 0; i < 140; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true }).catch(() => null);
    if (r && r.result?.value === true) break;
    await sleep(250);
  }
  await sleep(1500);

  const list = WANT.length ? POSES.filter((p) => WANT.includes(p.name)) : POSES;
  for (const pose of list) {
    const moved = await send('Runtime.evaluate', {
      expression: `(() => {
        const g = window.__game;
        if (!g || !g.player) return 'no-game';
        g.player.revive(${pose.x}, ${pose.z});
        g.player.setLook(${pose.yaw}, ${pose.pitch});
        return 'ok';
      })()`,
      returnByValue: true,
    });
    if (moved.result?.value !== 'ok') { console.log(`skip ${pose.name}: ${moved.result?.value}`); continue; }
    await sleep(900);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const out = path.join(OUT_DIR, `${pose.name}.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${out}`);
  }

  /* top-down layout proof: render the world from above with a clone of the
     game camera and read the canvas back in the same frame */
  if (process.env.TOP === '1') {
    for (const t of TOP_VIEWS) {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => {
          const e = window.__game.engine;
          const cam = e.camera.clone();
          cam.position.set(${t.x}, ${t.h || 70}, ${t.z});
          cam.lookAt(${t.x}, 0, ${t.z});
          cam.updateProjectionMatrix();
          await new Promise((res) => requestAnimationFrame(() => { e.renderer.render(e.scene, cam); res(); }));
          return e.renderer.domElement.toDataURL('image/png');
        })()`,
        returnByValue: true, awaitPromise: true,
      });
      const url = r.result?.value;
      if (!url || !url.startsWith('data:image/png')) { console.log(`top ${t.name}: failed`, JSON.stringify(r).slice(0, 300)); continue; }
      const out = path.join(OUT_DIR, `top-${t.name}.png`);
      fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`saved ${out}`);
    }
  }
  if (consoleErrors.length) {
    console.log('--- console issues ---');
    for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log(e);
  } else {
    console.log('console clean');
  }
} catch (err) {
  console.error('WORLD SHOT FAILED:', err.message);
  if (chromeErr) console.error(chromeErr.slice(-1000));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 150);
}
