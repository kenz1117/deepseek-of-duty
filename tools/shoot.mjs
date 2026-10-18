#!/usr/bin/env node
/**
 * Deterministic headless screenshot tool.
 * usage: node tools/shoot.mjs <url> <outfile> [waitMs] [width] [height]
 * Launches Chrome with CDP, waits for window.__READY, captures a PNG and
 * prints console errors so visual regressions are easy to trace.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'http://127.0.0.1:5173/?shot=1&pose=hero';
const out = process.argv[3] || 'shots/shot.png';
const settle = Number(process.argv[4] || 1500);
const W = Number(process.argv[5] || 1600);
const H = Number(process.argv[6] || 900);
const PORT = 9333 + Math.floor(Math.random() * 200);
const profile = `/tmp/dod-shot-${PORT}`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio',
  '--window-size=' + W + ',' + H,
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
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

function cleanup(code) {
  try { ws && ws.close(); } catch (e) { }
  try { chrome.kill('SIGKILL'); } catch (e) { }
  setTimeout(() => process.exit(code), 120);
}

(async () => {
  try {
    // wait for devtools endpoint
    let targets = null;
    for (let i = 0; i < 100; i++) {
      try {
        targets = await getJSON('/json/list');
        if (targets && targets.length) break;
      } catch (e) { }
      await sleep(150);
    }
    if (!targets) throw new Error('Chrome devtools endpoint never came up.\n' + chromeErr.slice(-2000));
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
      if (msg.method === 'Runtime.consoleAPICalled') {
        const t = msg.params.type;
        if (t === 'error' || t === 'warning') {
          const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
          consoleErrors.push(`[${t}] ${text}`);
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

    // wait for the game to flag itself ready
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const r = await send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true }).catch(() => null);
      if (r && r.result && r.result.value === true) { ready = true; break; }
      await sleep(250);
    }
    await sleep(settle);

    const evalExpr = process.env.EVAL;
    if (evalExpr) {
      const r = await send('Runtime.evaluate', { expression: evalExpr, returnByValue: true, awaitPromise: true }).catch((e) => ({ error: e.message }));
      console.log('EVAL:', JSON.stringify(r.result ? r.result.value : r));
      await sleep(Number(process.env.POST_EVAL_MS || 280));
    }

    const fatal = consoleErrors.some((e) => e.startsWith('[exception]'));
    if (!ready || fatal) {
      fs.rmSync(out, { force: true });
      console.error(`SHOT FAILED: ready=${ready} fatal=${fatal}`);
      for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.error(e);
      cleanup(1);
      return;
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${out} (${W}x${H}) ready=${ready}`);
    if (consoleErrors.length) {
      console.log('--- console issues ---');
      for (const e of [...new Set(consoleErrors)].slice(0, 25)) console.log(e);
    }
    cleanup(0);
  } catch (err) {
    console.error('SHOOT FAILED:', err.message);
    if (chromeErr) console.error(chromeErr.slice(-1500));
    cleanup(1);
  }
})();
