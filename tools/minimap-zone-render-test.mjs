#!/usr/bin/env node
/**
 * Minimap zone-ring render smoke test (real canvas, headless Chrome).
 *
 * Drives the actual createMinimap module inside a browser page with a fake
 * level, feeds it a versus zone state, and verifies:
 *   1. draw() does not throw with a zone present
 *   2. the ring's teal stroke actually lands on the canvas
 *   3. the outside-darkening tint lands outside the ring
 *   4. no crash when zone is null (co-op path)
 *
 * Run: node tools/minimap-zone-render-test.mjs  (needs the dev server on :5174)
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const PAGE = process.argv[2] || 'http://127.0.0.1:5174/';
const PORT = 9351;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dod-mm-test', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i += 1) {
  await sleep(300);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* warming up */ }
}
if (!wsUrl) { console.log('could not start chrome'); process.exit(1); }

const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: PAGE }, sessionId);
await sleep(3500);

const expr = `(async () => {
  const mod = await import('/src/ui/minimap.js');
  // The main app already owns #minimap; rename it so getElementById below
  // resolves to OUR canvas, otherwise both instances paint the same element.
  const realCanvas = document.getElementById('minimap');
  if (realCanvas) realCanvas.id = 'minimap-real';
  const realWrap = document.getElementById('minimap-wrap');
  if (realWrap) realWrap.id = 'minimap-wrap-real';
  // minimal DOM the module expects
  const wrap = document.createElement('div');
  wrap.id = 'minimap-wrap';
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap'; canvas.width = 320; canvas.height = 320;
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);

  const mm = mod.createMinimap({ level: { colliders: [], bounds: { x0: -118, x1: 124, z0: -196, z1: 128 } } });

  const zone = { x: 8, z: 27, r: 36, nextX: 8, nextZ: 30, nextR: 22, shrinking: false, finished: false };
  const base = { x: 8, z: 27, heading: 0, enemies: [], uav: false, objective: null };

  let threwZone = null, threwNull = null, teal = 0, tint = 0, dashed = 0;
  try {
    mm.update(0.016, { ...base, zone });
    mm.draw({ ...base, zone }, 0);
  } catch (e) { threwZone = String(e && e.message || e); }

  // sample pixels: teal stroke on the ring edge, tint outside it
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, 320, 320).data;
  const scale = 320 / (42 * 2);           // default range 42
  const ringPx = 36 * scale;              // ring radius in px
  const cx = 160, cy = 160;
  const at = (x, y) => { const i = (y * 320 + x) * 4; return [img[i], img[i+1], img[i+2]]; };
  // stroke passes through (cx + ringPx, cy)
  const [r1, g1, b1] = at(Math.min(319, Math.round(cx + ringPx)), cy);
  if (g1 > 140 && b1 > 120 && r1 < 140) teal = 1;
  // far outside the ring: the dark-teal tint raises G/B over the base bg
  const [r2, g2, b2] = at(6, 6);
  if (g2 > 20 && b2 > 20) tint = 1;
  // dashed next ring: the dash pattern has gaps, so sweep the whole arc
  const nr = 22 * scale;
  for (let a = 0; a < 360 && !dashed; a += 3) {
    const rad = (a * Math.PI) / 180;
    const sx = Math.round(cx + Math.cos(rad) * nr);
    const sy = Math.round(cy + Math.sin(rad) * nr);
    for (let ox = -1; ox <= 1 && !dashed; ox++) {
      for (let oy = -1; oy <= 1 && !dashed; oy++) {
        const x = sx + ox, y = sy + oy;
        if (x < 0 || y < 0 || x > 319 || y > 319) continue;
        const [r3, g3, b3] = at(x, y);
        if (r3 > 180 && g3 > 180 && b3 > 180) dashed = 1;
      }
    }
  }

  try { mm.update(0.016, { ...base, zone: null }); mm.draw({ ...base, zone: null }, 0); }
  catch (e) { threwNull = String(e && e.message || e); }

  wrap.remove();
  if (realCanvas) realCanvas.id = 'minimap';
  if (realWrap) realWrap.id = 'minimap-wrap';
  return { threwZone, threwNull, teal, tint, dashed };
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
const out = r.result?.result?.value;
console.log(JSON.stringify(out, null, 2));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures += 1; };
check('draw with zone does not throw', out && out.threwZone === null);
check('teal ring stroke is on the canvas', out && out.teal === 1);
check('outside tint is applied', out && out.tint === 1);
check('next-ring dashes are visible', out && out.dashed === 1);
check('draw with zone=null (co-op) does not throw', out && out.threwNull === null);

console.log(failures === 0 ? '[minimap-zone-render] all checks passed' : `[minimap-zone-render] ${failures} check(s) failed`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);