#!/usr/bin/env node
/**
 * Live minimap interaction test (real game, headless Chrome).
 *
 * Boots the actual game (?shot=1) and checks the HUD behaviour that unit
 * tests cannot see:
 *   · the range button cycles 42 m / 70 m and the panel repaints
 *   · M hides the panel AND the loot legend, M shows them again
 *   · re-showing the panel repaints it around the PLAYER (the old code
 *     repainted around the world origin and flashed a foreign block of
 *     streets for one frame)
 *   · the panel and the legend are laid out as one stack under the score
 *   · the console stays clean
 *
 * Run: node tools/minimap-live-test.mjs [page-url]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PAGE = process.argv[2] || process.env.PAGE_URL || 'http://127.0.0.1:5173/?shot=1&pose=hero';
const PORT = 9400 + Math.floor(Math.random() * 200);
const profile = `/tmp/dod-mm-live-${PORT}`;
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=1600,900', '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ws; let id = 0; const pending = new Map(); const consoleErrors = [];
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

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
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 120; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true }).catch(() => null);
    if (r && r.result?.value === true) break;
    await sleep(250);
  }
  await sleep(1500);

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  const out = {};

  out.start = await evaluate(`(() => {
    const wrap = document.getElementById('minimap-wrap');
    const btn = document.getElementById('mm-zoom');
    const legend = document.getElementById('mm-legend');
    const canvas = document.getElementById('minimap');
    return {
      wrapHidden: wrap.classList.contains('hidden'),
      btn: btn ? btn.textContent : null,
      legendItems: legend ? legend.children.length : 0,
      legendUnderMap: legend ? (legend.getBoundingClientRect().top >= wrap.getBoundingClientRect().bottom - 1) : false,
      canvas: canvas ? [canvas.width, canvas.height] : null,
    };
  })()`);

  // range button cycles and the panel repaints
  out.zoom = await evaluate(`(async () => {
    const btn = document.getElementById('mm-zoom');
    const canvas = document.getElementById('minimap');
    const ctx = canvas.getContext('2d');
    const before = btn.textContent;
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = btn.textContent;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonEmpty = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 40) nonEmpty += 1;
    return { before, after, painted: nonEmpty > 500 };
  })()`);

  // M hides the panel and the legend
  out.toggleOff = await evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const wrap = document.getElementById('minimap-wrap');
    const legend = document.getElementById('mm-legend');
    return {
      wrapHidden: wrap.classList.contains('hidden'),
      legendHidden: !legend || legend.classList.contains('hidden'),
    };
  })()`);

  // M shows it again — and the repaint must be centred on the player
  out.toggleOn = await evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const wrap = document.getElementById('minimap-wrap');
    const legend = document.getElementById('mm-legend');
    const canvas = document.getElementById('minimap');
    const ctx = canvas.getContext('2d');
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // the player arrow is drawn at the centre of the panel
    const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const mid = at(Math.round(canvas.width / 2), Math.round(canvas.height / 2) - 4);
    return {
      wrapHidden: wrap.classList.contains('hidden'),
      legendHidden: !legend || legend.classList.contains('hidden'),
      centreArrow: (mid[1] > 130 && mid[2] > 150) ? 1 : 0,
    };
  })()`);

  console.log(JSON.stringify(out, null, 2));

  let failures = 0;
  const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures += 1; };
  check('panel is visible on start', out.start && !out.start.wrapHidden);
  check('range button shows a range', out.start && /\d+m/.test(out.start.btn || ''));
  check('loot legend has its entries', out.start && out.start.legendItems === 5);
  check('legend sits under the map', out.start && out.start.legendUnderMap === true);
  check('range button cycles', out.zoom && out.zoom.before !== out.zoom.after);
  check('panel repaints after the range change', out.zoom && out.zoom.painted === true);
  check('M hides the panel', out.toggleOff && out.toggleOff.wrapHidden === true);
  check('M hides the legend too', out.toggleOff && out.toggleOff.legendHidden === true);
  check('M shows the panel again', out.toggleOn && out.toggleOn.wrapHidden === false);
  check('M shows the legend again', out.toggleOn && out.toggleOn.legendHidden === false);
  check('re-shown panel is centred on the player', out.toggleOn && out.toggleOn.centreArrow === 1);
  check('no console errors', consoleErrors.length === 0);
  if (consoleErrors.length) for (const e of consoleErrors.slice(0, 8)) console.log('   ', e);

  console.log(failures === 0 ? '[minimap-live] all checks passed' : `[minimap-live] ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error('MINIMAP LIVE TEST FAILED:', err.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 150);
}
