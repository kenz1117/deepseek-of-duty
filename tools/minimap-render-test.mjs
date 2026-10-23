#!/usr/bin/env node
/**
 * Tactical minimap render test (real canvas, headless Chrome).
 *
 * Drives the actual createMinimap module inside a browser page with a fake
 * level and verifies the pixels that end up on the panel:
 *   1. the storm ring is stroked in teal on the ring edge
 *   2. the area outside the ring is masked DARK (and not colour-washed)
 *   3. the next-ring preview is a dashed arc
 *   4. loot markers are painted, in their own colours
 *   5. squadmates are painted
 *   6. a hostile in the open is painted; the same hostile behind a wall is
 *      not (the map must not be a wallhack)
 *   7. a boss is always painted
 *   8. the player arrow sits in the centre of the panel
 *   9. the objective chip reports the distance
 *  10. zone=null (co-op path) does not throw
 *
 * Run: node tools/minimap-render-test.mjs [page-url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const PAGE = process.argv[2] || process.env.PAGE_URL || 'http://127.0.0.1:5173/';
const PORT = 9351 + Math.floor(Math.random() * 200);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  // the page under test boots the whole game; swiftshader keeps its WebGL
  // context alive so the console stays clean and the check below is honest
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dod-mm-test', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(300);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* warming up */ }
}
if (!wsUrl) { console.log('could not start chrome'); process.exit(1); }

const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleErrors.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
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

  // a small city block: one wall east of the player, open street to the west
  const level = {
    colliders: [
      { x0: 6, x1: 30, z0: -30, z1: 30, top: 8 },
      { x0: -30, x1: -6, z0: 8, z1: 30, top: 8 },
    ],
    regionAt: () => ({ name: '街区' }),
  };

  const wrap = document.createElement('div');
  wrap.id = 'minimap-wrap';
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap'; canvas.width = 320; canvas.height = 320;
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);

  const mm = mod.createMinimap({ level });
  const ctx = canvas.getContext('2d');
  const img = () => ctx.getImageData(0, 0, 320, 320).data;

  const countPixels = (data, test) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (test(data[i], data[i + 1], data[i + 2])) n += 1;
    }
    return n;
  };
  const isRed = (r, g, b) => r > 190 && g < 120 && b < 110;
  const isGreen = (r, g, b) => g > 190 && r < 190 && b < 200;
  const isAmber = (r, g, b) => r > 200 && g > 130 && g < 205 && b < 110;
  const isTeal = (r, g, b) => g > 120 && b > 110 && r < 130;

  const base = { x: 0, z: 0, heading: 0, enemies: [], uav: false, objective: null };
  const out = {};

  /* ---- 1..3: zone ring, mask and dashes ------------------------------- */
  const zone = { x: 0, z: 0, r: 30, nextX: 0, nextZ: 0, nextR: 18, shrinking: false, finished: false };
  let threwZone = null, threwNull = null;
  try {
    mm.update(0.016, { ...base, zone });
    mm.draw({ ...base, zone }, 0);
  } catch (e) { threwZone = String(e && e.message || e); }
  let data = img();
  const scale = 320 / (42 * 2);
  const ringPx = 30 * scale;
  const at = (d, x, y) => { const i = (Math.round(y) * 320 + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const edge = at(data, 160 + ringPx, 160);
  out.teal = (edge[1] > 110 && edge[2] > 100 && edge[0] < 140) ? 1 : 0;

  // outside the ring the panel is masked darker, and it is NOT colour-washed
  const outside = at(data, 6, 6);
  const inside = at(data, 160 - 46, 160);
  const lum = (c) => c[0] + c[1] + c[2];
  out.masked = lum(outside) < lum(inside) - 6 ? 1 : 0;
  out.noWash = outside[1] < 26 && outside[2] < 30 ? 1 : 0;

  // the next ring is dashed: along its arc some pixels are lit, some are not
  const nr = 18 * scale;
  let lit = 0, dark = 0;
  for (let a = 0; a < 360; a += 1) {
    const rad = (a * Math.PI) / 180;
    const [r3, g3, b3] = at(data, 160 + Math.cos(rad) * nr, 160 + Math.sin(rad) * nr);
    if (r3 + g3 + b3 > 90) lit += 1; else dark += 1;
  }
  out.dashed = (lit > 30 && dark > 30) ? 1 : 0;

  /* ---- 4..7: loot, allies, fog of war, boss ---------------------------- */
  const scene = {
    ...base,
    enemies: [
      { alive: true, pos: { x: -12, z: 0 } },            // open street -> seen
      { alive: true, pos: { x: 14, z: 0 } },             // behind the wall -> hidden
      { alive: true, pos: { x: 0, z: -14 }, isBoss: true },  // boss -> always seen
    ],
    pickups: [{ kind: 'ammo', x: -4, z: 0 }],
    allies: [{ x: 4, z: 0, yaw: 0 }],
  };
  mm.draw(scene, 0);
  data = img();
  out.red = countPixels(data, isRed);
  out.green = countPixels(data, isGreen);
  out.amber = countPixels(data, isAmber);

  // the hidden hostile sits at world x=14 -> canvas x = 160 + 14*scale
  const hiddenX = Math.round(160 + 14 * scale);
  const hiddenY = 160;
  out.hiddenRed = 0;
  for (let dx = -8; dx <= 8; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      const [r4, g4, b4] = at(data, hiddenX + dx, hiddenY + dy);
      if (isRed(r4, g4, b4)) out.hiddenRed += 1;
    }
  }
  // the visible hostile sits at world x=-12 -> canvas x = 160 - 12*scale
  const seenX = Math.round(160 - 12 * scale);
  out.seenRed = 0;
  for (let dx = -8; dx <= 8; dx++) {
    for (let dy = -8; dy <= 8; dy++) {
      const [r5, g5, b5] = at(data, seenX + dx, 160 + dy);
      if (isRed(r5, g5, b5)) out.seenRed += 1;
    }
  }

  /* ---- 8: the player arrow sits in the middle ------------------------- */
  const centre = at(data, 160, 150);
  out.centre = (centre[1] > 150 && centre[2] > 170 && centre[0] < 160) ? 1 : 0;

  /* ---- 9: the objective chip reports the distance --------------------- */
  mm.draw({ ...base, objective: { zone: { x: 10, z: 0, r: 4 }, done: false } }, 0);
  const chip = document.getElementById('mm-objdist');
  out.chip = chip && !chip.hidden && /10/.test(chip.textContent) ? 1 : 0;

  /* ---- 10: co-op path (no zone) ---------------------------------------- */
  try { mm.update(0.016, { ...base, zone: null }); mm.draw({ ...base, zone: null }, 0); }
  catch (e) { threwNull = String(e && e.message || e); }
  out.threwZone = threwZone;
  out.threwNull = threwNull;

  wrap.remove();
  if (realCanvas) realCanvas.id = 'minimap';
  if (realWrap) realWrap.id = 'minimap-wrap';
  return out;
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
const out = r.result?.result?.value;
if (r.result?.exceptionDetails) {
  console.log(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text, null, 2));
}
console.log(JSON.stringify(out, null, 2));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures += 1; };
check('draw with zone does not throw', out && out.threwZone === null);
check('storm ring is stroked in teal', out && out.teal === 1);
check('area outside the ring is masked darker', out && out.masked === 1);
check('storm mask is neutral (no colour wash)', out && out.noWash === 1);
check('next-ring preview is dashed', out && out.dashed === 1);
check('hostile in the open is painted', out && out.seenRed > 0);
check('hostile behind a wall is not painted', out && out.hiddenRed === 0);
check('boss is painted', out && out.red > 0);
check('squadmate is painted', out && out.green > 0);
check('loot marker is painted', out && out.amber > 0);
check('player arrow sits in the centre', out && out.centre === 1);
check('objective chip reports the distance', out && out.chip === 1);
check('draw with zone=null (co-op) does not throw', out && out.threwNull === null);
check('no console errors', consoleErrors.length === 0);
if (consoleErrors.length) for (const e of consoleErrors.slice(0, 8)) console.log('   ', e);

console.log(failures === 0 ? '[minimap-render] all checks passed' : `[minimap-render] ${failures} check(s) failed`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
