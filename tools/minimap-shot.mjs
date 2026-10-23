#!/usr/bin/env node
/**
 * Minimap visual capture (headless Chrome + CDP).
 *
 * usage:
 *   node tools/minimap-shot.mjs lab   [out.png]          # all lab panels
 *   node tools/minimap-shot.mjs panel [out.png] [index]  # one lab panel, big
 *   node tools/minimap-shot.mjs live  [out.png]          # real in-game minimap
 *
 * "lab" mounts createMinimap on a throwaway DOM with a synthetic city block
 * and a fully populated state (enemies, engaged enemies, boss, zone ring,
 * objective, pickups) so the visual design can be judged in isolation.
 * "live" screenshots the minimap inside the running game (?shot=1).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MODE = process.argv[2] || 'lab';
const OUT = process.argv[3] || `shots/minimap-${MODE}.png`;
const PANEL = Number(process.argv[4] || 0);
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:5173/';
const PORT = 9500 + Math.floor(Math.random() * 300);
const profile = `/tmp/dod-mm-shot-${PORT}`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=1600,900', '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map(); const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

const LAB_DRIVER = `(async () => {
  const mod = await import('/src/ui/minimap.js');
  // hide the live HUD minimap so it does not sit on top of the lab render
  const live = document.getElementById('minimap-wrap');
  if (live) live.style.display = 'none';

  // synthetic city block: streets + buildings with varied heights
  const colliders = [];
  const add = (x0, x1, z0, z1, top) => colliders.push({ x0, x1, z0, z1, top });
  for (let i = -3; i <= 3; i++) {
    add(i * 12 - 4, i * 12 + 4, -34, -18, 9);
    add(i * 12 - 4, i * 12 + 4, 18, 34, 7);
    add(-40, -24, i * 12 - 4, i * 12 + 4, 8);
    add(24, 40, i * 12 - 4, i * 12 + 4, 8);
  }
  add(-6, 6, -6, 6, 4.5);
  add(8, 20, 6, 16, 2.0);
  add(-22, -10, 8, 18, 1.4);
  add(10, 16, -24, -14, 12);
  add(-16, -8, -22, -10, 5.5);
  const level = { colliders, regionAt: () => ({ name: '后院市场' }) };

  const host = document.createElement('div');
  host.id = 'mm-lab';
  host.style.cssText = 'position:fixed;left:40px;top:40px;width:166px;height:166px;z-index:99999;background:#0a0e12;';
  const wrap = document.createElement('div');
  wrap.id = 'minimap-wrap';
  wrap.className = 'minimap-wrap';
  wrap.style.cssText = 'position:relative;width:166px;height:166px;';
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap'; canvas.width = 320; canvas.height = 320;
  wrap.appendChild(canvas);
  const north = document.createElement('span'); north.className = 'mm-north'; north.textContent = 'N';
  const region = document.createElement('span'); region.className = 'mm-region'; region.id = 'mm-region'; region.textContent = '街区';
  const hint = document.createElement('span'); hint.className = 'mm-hint'; hint.textContent = 'M';
  wrap.append(north, region, hint);
  host.appendChild(wrap);
  document.body.appendChild(host);

  const mm = mod.createMinimap({ level });
  const enemy = (x, z, extra) => ({ alive: true, pos: { x, z }, ...extra });
  const state = {
    x: 0, z: 0, heading: 28, time: 1.2, uav: false,
    enemies: [
      enemy(9, -7, {}),
      enemy(-13, 6, { burstLeft: 0.4, warnActive: true }),
      enemy(16, 12, { isBoss: true }),
      enemy(-26, -22, {}),
    ],
    objective: { zone: { x: 18, z: -20, r: 4.5 }, done: false },
    zone: { x: 6, z: 4, r: 30, nextX: 2, nextZ: 0, nextR: 18, shrinking: false, finished: false },
    pickups: [
      { kind: 'ammo', x: 6, z: 9 }, { kind: 'medkit', x: -7, z: -5 },
      { kind: 'armor', x: 12, z: 3 }, { kind: 'grenade', x: -4, z: 12 },
    ],
    allies: [{ x: -8, z: 16, name: 'ALPHA' }],
  };
  mm.draw(state, 0.4);
  const r = wrap.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`;

const LIVE_DRIVER = `(() => {
  const w = document.getElementById('minimap-wrap');
  if (!w) return null;
  ${process.env.ZOOM === '1' ? "const b = document.getElementById('mm-zoom'); if (b && b.textContent.trim() === '42m') b.click();" : ''}
  const r = w.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`;

const LAB_PAGE_DRIVER = `(() => {
  const b = document.body.getBoundingClientRect();
  return { x: 0, y: 0, w: Math.ceil(b.width), h: Math.ceil(b.height) };
})()`;

const LAB_PANEL_DRIVER = `(() => {
  const r = (window.__labRects && window.__labRects()[${PANEL}]);
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
})()`;

const HUD_DRIVER = `(() => {
  const el = document.querySelector('.hud-topright') || document.getElementById('minimap-wrap');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`;

(async () => {
  try {
    let targets = null;
    for (let i = 0; i < 100; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        if (targets && targets.length) break;
      } catch (e) { }
      await sleep(150);
    }
    if (!targets) throw new Error('chrome devtools never came up\n' + chromeErr.slice(-1500));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageExtensible: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
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

    const url = (MODE === 'live' || MODE === 'hud') ? `${PAGE}?shot=1&pose=hero`
      : (MODE === 'lab' || MODE === 'panel') ? `${PAGE}tools/minimap-lab.html` : PAGE;
    await send('Page.navigate', { url });
    await sleep((MODE === 'live' || MODE === 'hud') ? 9000 : 2500);

    if (MODE === 'live' || MODE === 'hud') {
      for (let i = 0; i < 80; i++) {
        const r = await send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true }).catch(() => null);
        if (r && r.result?.value === true) break;
        await sleep(250);
      }
      await sleep(1200);
    }

    const drv = await send('Runtime.evaluate', {
      expression: MODE === 'live' ? LIVE_DRIVER
        : MODE === 'hud' ? HUD_DRIVER
        : MODE === 'panel' ? LAB_PANEL_DRIVER
        : MODE === 'lab' ? LAB_PAGE_DRIVER : LAB_DRIVER,
      returnByValue: true, awaitPromise: true,
    });
    if (drv.exceptionDetails) throw new Error('driver failed: ' + JSON.stringify(drv.exceptionDetails.exception?.description || drv.exceptionDetails.text));
    const rect = drv.result?.value;
    if (!rect) throw new Error('driver returned no rect');
    await sleep(250);

    const scale = MODE === 'lab' ? 2 : MODE === 'live' ? 3 : MODE === 'panel' ? 5 : MODE === 'hud' ? 2 : 4;
    const clip = (MODE === 'lab' || MODE === 'panel' || MODE === 'hud')
      ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale }
      : { x: rect.x - 6, y: rect.y - 6, width: rect.w + 12, height: rect.h + 12, scale };
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip,
    });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${OUT} (${Math.round(rect.w * scale)}x${Math.round(rect.h * scale)})`);
    if (consoleErrors.length) {
      console.log('--- console issues ---');
      for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log(e);
    }
  } catch (err) {
    console.error('MINIMAP SHOT FAILED:', err.message);
    if (chromeErr) console.error(chromeErr.slice(-1200));
  } finally {
    try { ws && ws.close(); } catch (e) { }
    try { chrome.kill('SIGKILL'); } catch (e) { }
    setTimeout(() => process.exit(0), 150);
  }
})();
