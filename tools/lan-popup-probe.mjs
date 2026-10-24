#!/usr/bin/env node
/**
 * LAN popup regression probe.
 *
 * Reproduces the reported bug end to end: home → LAN → VERSUS card → lobby →
 * HOST → start the match. After the match starts, NOTHING may be left on
 * screen except the HUD — the NETWORK OPERATIONS popup used to survive and
 * had to be dismissed by hand.
 *
 * Run: node tools/lan-popup-probe.mjs [lan-ws-url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const LAN = process.argv[2] || 'ws://127.0.0.1:8799';
const PAGE = `http://127.0.0.1:5173/?lan=${encodeURIComponent(LAN)}&room=PROBE`;
const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = `/tmp/dod-lanpopup-${PORT}`;

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=1400,860', '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === 'page');
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch { /* warming up */ }
}
if (!wsUrl) { console.log('could not start chrome'); process.exit(1); }

const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map(); const consoleErrors = [];
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
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: PAGE });
await sleep(9000);

const visibleOverlays = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('.overlay')) {
    if (!el.id) continue;
    const hidden = el.classList.contains('hidden') || el.getAttribute('aria-hidden') === 'true' || getComputedStyle(el).display === 'none';
    if (!hidden) out.push(el.id);
  }
  return out;
})()`;

const step = async (label, expr, wait = 1200) => {
  if (expr) await evaluate(expr);
  await sleep(wait);
  const vis = await evaluate(visibleOverlays);
  console.log(`${label.padEnd(22)} overlays: ${JSON.stringify(vis)}`);
  return vis;
};

await step('home', null, 300);
// home → the LAN mode card opens the NETWORK OPERATIONS popup
await step('open LAN popup', 'document.getElementById("lan-open").click()');
// the VERSUS card is the one that used to leave the popup behind
await step('pick VERSUS card', 'document.getElementById("lan-versus-open").click()');
await step('become host', 'document.getElementById("lan-host").click()', 1800);
const hostStatus = await evaluate('document.getElementById("lan-status-text") ? document.getElementById("lan-status-text").textContent.trim() : "?"');
console.log('host status:', hostStatus);
await step('start the match', 'document.getElementById("lan-start").click()', 2500);

const state = await evaluate('window.__game ? window.__game.state.state : "no game"');
const vis = await evaluate(visibleOverlays);
console.log('game state:', state);
console.log('menu hidden:', await evaluate('document.getElementById("menu").classList.contains("hidden")'));
console.log('hud visible:', await evaluate('!document.getElementById("hud").classList.contains("hidden")'));
console.log('lan modal open flag:', await evaluate('window.__game && window.__game.hud ? window.__game.hud.lanModalOpen : "?"'));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures += 1; };
check('no popup is left after the match starts', vis.length === 0);
check('the game is running', state === 'playing');
check('the main menu is hidden', await evaluate('document.getElementById("menu").classList.contains("hidden")'));
check('the HUD is visible', await evaluate('!document.getElementById("hud").classList.contains("hidden")'));
check('no console errors', consoleErrors.length === 0);
if (consoleErrors.length) for (const e of consoleErrors.slice(0, 8)) console.log('   ', e);

console.log(failures === 0 ? '[lan-popup] all checks passed' : `[lan-popup] ${failures} check(s) failed`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
