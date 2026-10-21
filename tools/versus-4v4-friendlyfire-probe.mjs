#!/usr/bin/env node
/**
 * VERSUS 4v4 friendly-fire probe.
 *
 * The 1v7 probe showed all 7 bots aiming at the local human. The target
 * selector (nearestLanTarget) seeds its "best" candidate with the LOCAL
 * player and only filters REMOTE players by team. A same-team fill bot
 * therefore has its own human teammate as a legal hostile.
 *
 * This probe builds a real 2-player VERSUS lobby (one real browser host +
 * one protocol-level fake client on the other team) and measures:
 *   - how many of the host's OWN teammates' fill bots target the host
 *   - how much damage the host takes from his own faction
 *
 * usage: node tools/versus-4v4-friendlyfire-probe.mjs [seconds]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const seconds = Number(process.argv[2] || 20);
const url = 'http://127.0.0.1:5173/?lan=ws://127.0.0.1:8790';
const out = 'shots/versus-4v4-friendlyfire-probe.json';
const ROOM = 'FF4';
const W = 1280, H = 720;
const PORT = 9800 + Math.floor(Math.random() * 90);
const profile = `/tmp/dod-ff4-${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

// ---- the fake second player (protocol level, no renderer) ----
// It must join AFTER the browser claims the room, otherwise the fake wins
// the host election and the browser ends up a client (no authority, no bots).
let fakeId = null;
let resolveFake = () => {};
const fakeReady = new Promise((resolve) => { resolveFake = resolve; });
function joinFake() {
  if (fake.readyState === WebSocket.OPEN) {
    fake.send(JSON.stringify({ t: 'join', room: ROOM, name: 'RIVAL', mode: 'br' }));
  }
}
const fake = new WebSocket('ws://127.0.0.1:8790/?room=' + ROOM);
fake.on('open', () => { /* wait for joinFake() */ });
fake.on('message', (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.t === 'welcome') { fakeId = m.id; resolveFake(fakeId); }
});
fake.on('error', () => { /* relay may not be up yet */ });

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

let ws; let id = 0; const pending = new Map(); const issues = [];
function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}
function cleanup(code) {
  try { ws && ws.close(); } catch (e) { /* noop */ }
  try { fake && fake.close(); } catch (e) { /* noop */ }
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
    if (!targets) throw new Error('devtools never came up\n' + chromeErr.slice(-1200));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
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
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await sleep(Number(process.env.BOOT_MS || 9000));

    // ---- PHASE 1: browser claims the room as host ----
    const phase1 = `(async () => {
      const g = window.__game;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } };
      setVal('lan-server', 'ws://127.0.0.1:8790');
      setVal('lan-room', '${ROOM}');
      setVal('lan-name', 'HOST');
      const vs = document.getElementById('lan-versus');
      if (vs) { vs.checked = true; vs.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('lan-host')?.click();
      await new Promise(r => setTimeout(r, 2500));
      return { isHost: !!(g.lan && g.lan.isHost), role: g.net.role, players: (g.lan?.players || []).length };
    })()`;
    const r1 = await send('Runtime.evaluate', { expression: phase1, returnByValue: true, awaitPromise: true });
    const p1 = r1.result && r1.result.value;
    if (!p1 || !p1.isHost) throw new Error('browser did not become host: ' + JSON.stringify(p1));

    // ---- node joins the rival into the room the browser now owns ----
    joinFake();
    await fakeReady;
    await sleep(1200);

    // ---- PHASE 2: start the match and sample ----
    const expr = `(async () => {
      const g = window.__game;
      const G = g.state;
      const net = g.net;
      // wait for the rival to land in the lobby
      for (let i = 0; i < 40; i++) {
        if ((g.lan?.players || []).length >= 2) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const lobbyPlayers = (g.lan?.players || []).map(p => ({ id: p.id, host: !!p.host, name: p.name }));
      document.getElementById('lan-start')?.click();
      await new Promise(r => setTimeout(r, 3500));

      const bots = g.versusBots || [];
      const info = {
        lobbyPlayers, role: net.role, myTeam: net.team,
        teamAssignments: net.teamAssignments ? JSON.parse(JSON.stringify(net.teamAssignments)) : null,
        botCount: bots.length,
        botTeams: bots.map(b => b.team),
        versusMode: !!G.versusMode,
      };
      if (!info.versusMode) { info.error = 'versus did not start'; return info; }

      G.versusGraceT = 0;
      const p = g.player.pos;
      g.player.revive(p.x, p.z);
      const DUR = ${seconds * 1000};
      const t0 = performance.now();
      let lastHp = G.hp, dmg = 0;
      const samples = [];
      const counts = { ownTeamBotsAimingAtHost: 0, enemyTeamBotsAimingAtHost: 0, frames: 0 };
      while (performance.now() - t0 < DUR) {
        await new Promise(r => setTimeout(r, 80));
        counts.frames++;
        const tgts = g.vsTargets ? g.vsTargets() : {};
        let own = 0, enemy = 0;
        for (const b of (g.versusBots || [])) {
          const e = b.e;
          if (!e || !e.alive) continue;
          const t = tgts[e._netId];
          if (t == null) continue;
          if (String(t) === String(net.selfId)) {
            if (b.team === net.team) own++; else enemy++;
          }
        }
        counts.ownTeamBotsAimingAtHost += own;
        counts.enemyTeamBotsAimingAtHost += enemy;
        if (G.hp < lastHp) dmg += lastHp - G.hp;
        lastHp = G.hp;
        samples.push({ t: +((performance.now()-t0)/1000).toFixed(1), hp: Math.round(G.hp), own, enemy });
      }
      return { ...info, counts, damage: +dmg.toFixed(1), hp: G.hp, teamScores: G.teamScores.slice(), samples };
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const raw = r.result && r.result.value;
    if (!raw) throw new Error('probe failed: ' + JSON.stringify(r).slice(0, 800));
    if (!raw.counts) { console.log('RAW:', JSON.stringify(raw).slice(0, 2000)); throw new Error('probe did not reach the sampling phase'); }

    const f = Math.max(1, raw.counts.frames);
    const summary = {
      mode: 'versus 4v4 (host + fake peer, fill bots both sides)',
      lobbyPlayers: raw.lobbyPlayers,
      role: raw.role, myTeam: raw.myTeam,
      teamAssignments: raw.teamAssignments,
      botCount: raw.botCount, botTeams: raw.botTeams,
      ownTeamBotsAimingAtHost_avg: +(raw.counts.ownTeamBotsAimingAtHost / f).toFixed(2),
      enemyTeamBotsAimingAtHost_avg: +(raw.counts.enemyTeamBotsAimingAtHost / f).toFixed(2),
      damageTakenByHost: raw.damage,
      hpEnd: raw.hp,
      teamScores: raw.teamScores,
      error: raw.error || null,
    };
    fs.writeFileSync(out, JSON.stringify({ summary, samples: raw.samples }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (issues.length) console.log('ISSUES:\n' + [...new Set(issues)].slice(0,6).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
    cleanup(1);
  }
})();
