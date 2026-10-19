#!/usr/bin/env node
/**
 * Headless frame-capture recorder (screencast-free).
 * usage: node tools/record-frames.mjs <url> <framesDir> [width] [height] [driverFile]
 * Captures via Page.captureScreenshot at natural CDP pace (~10-18fps),
 * writes JPEG frames + ffconcat manifest.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'http://127.0.0.1:8321/';
const outDir = process.argv[3] || '/tmp/dod-frames';
const W = Number(process.argv[4] || 1920);
const H = Number(process.argv[5] || 1080);
const driverFile = process.argv[6] || decodeURIComponent(new URL('./record-highlights.mjs', import.meta.url).pathname);
const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = `/tmp/dod-hl-${PORT}`;

const src = fs.readFileSync(driverFile, 'utf8');
const a = src.indexOf('const DRIVER = `');
const b = src.indexOf('}))()`;', a);
if (a < 0 || b < 0) throw new Error('DRIVER not found in ' + driverFile);
const DRIVER = src.slice(a, b + '}))()`;'.length).replace('const DRIVER = `', 'var DRIVER = `');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map(); const frames = [];
function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => { pending.set(msgId, { resolve, reject }); ws.send(JSON.stringify({ id: msgId, method, params })); });
}
function cleanup(code) {
  try { ws && ws.close(); } catch (e) {}
  try { chrome.kill('SIGKILL'); } catch (e) {}
  setTimeout(() => process.exit(code), 150);
}
(async () => {
  const t0 = Date.now();
  let targets = null;
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch (e) {}
    await sleep(200);
  }
  if (!targets) throw new Error('devtools never came up');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(9000);
  const readyExpr = "window.__game && __game.engine && document.getElementById('loading').classList.contains('hidden')";
  let ready = false;
  for (let i = 0; i < 160; i++) {
    const r = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true }).catch(() => null);
    if (r && r.result && r.result.value === true) { ready = true; break; }
    await sleep(250);
  }
  if (!ready) throw new Error('game never became ready');
  await sleep(1200);
  send('Runtime.evaluate', { expression: DRIVER, returnByValue: true }).catch((e) => console.log('driver eval error:', e.message));
  console.log('driver injected, capturing frames…');
  const tEnd = Date.now() + 40000;
  while (Date.now() < tEnd) {
    const st = await send('Runtime.evaluate', { expression: 'JSON.stringify({done: window.__DRIVER_DONE || null, err: window.__DRIVER_ERR || null, ticks: window.__DRIVER_TICK || 0})', returnByValue: true }).catch(() => null);
    const v = st && st.result && st.result.value; let s = null; try { s = JSON.parse(v); } catch (e) {}
    if (s && s.err) throw new Error('driver crashed: ' + s.err);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    const idx = frames.length;
    fs.writeFileSync(path.join(outDir, `f_${String(idx).padStart(6, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
    frames.push({ file: `f_${String(idx).padStart(6, '0')}.jpg`, ts: Date.now() / 1000 });
    if (idx % 50 === 0) console.log(`  frame ${idx} @ ${((Date.now() - t0) / 1000).toFixed(0)}s ticks=${s && s.ticks}`);
    if (s && s.done) { console.log('driver done:', JSON.stringify(s.done)); break; }
  }
  await sleep(400);
  if (frames.length < 60) throw new Error(`only ${frames.length} frames`);
  let list = 'ffconcat version 1.0\n';
  for (let i = 0; i < frames.length; i++) {
    const dur = Math.max(0.02, (frames[i + 1] ? frames[i + 1].ts : frames[i].ts + 0.06) - frames[i].ts);
    list += `file '${frames[i].file}'\nduration ${dur.toFixed(4)}\n`;
  }
  list += `file '${frames[frames.length - 1].file}'\n`;
  fs.writeFileSync(path.join(outDir, 'list.txt'), list);
  const span = frames[frames.length - 1].ts - frames[0].ts;
  console.log(`captured ${frames.length} frames, span ${span.toFixed(1)}s, avg fps ${(frames.length / span).toFixed(1)}`);
  cleanup(0);
})().catch((err) => { console.error('RECORD FAILED:', err.message); cleanup(1); });
