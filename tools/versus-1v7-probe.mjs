#!/usr/bin/env node
/**
 * VERSUS 1v7 probe — measures what a solo player actually faces.
 *
 * The user report: "1v7 AI, I feel like the bots gang up on me — shouldn't
 * they each be an independent faction?"
 *
 * This probe boots a real headless browser, joins a real LAN room as the
 * only human, starts VERSUS (1 human vs 7 bots), and then samples:
 *
 *   1. team assignment       — who is actually on which side
 *   2. target distribution   — how many bots aim at the human vs elsewhere
 *   3. focus-fire state      — the faction brain's priority target + intel
 *   4. incoming DPS          — damage the player actually takes
 *   5. ring pressure         — how close the bots get
 *
 * The player is a "decent human": re-acquires targets on a ~150 ms cadence,
 * ~1.2 deg of aim error, fires in bursts, reloads, and strafes slightly.
 *
 * usage: node tools/versus-1v7-probe.mjs [seconds] [url] [out]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const seconds = Number(process.argv[2] || 25);
const url = process.argv[3] || 'http://127.0.0.1:5173/?lan=ws://127.0.0.1:8790';
const out = process.argv[4] || 'shots/versus-1v7-probe.json';
const W = 1280, H = 720;
const PORT = 9900 + Math.floor(Math.random() * 90);
const profile = `/tmp/dod-v17-${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(profile, { recursive: true, force: true });

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

let ws;
let id = 0;
const pending = new Map();
const issues = [];
function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}
function cleanup(code) {
  try { ws && ws.close(); } catch (e) { /* noop */ }
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
    ws = new WebSocket(page.webSocketDebuggerUrl, { perMessagePerMessage: false, maxPayload: 64 * 1024 * 1024 });
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

    // The probe runs INSIDE the page: it drives the real lobby UI, joins a
    // real relay room, and starts a real VERSUS match with one human.
    const expr = `(async () => {
      const g = window.__game;
      if (!g) return { error: 'no __game' };
      const G = g.state;

      // --- join a real room as the only player (via the lobby's own path) ---
      const lobby = g.lanLobby;
      if (!lobby) return { error: 'no lanLobby' };
      // fill the lobby fields the same way a human would
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } };
      setVal('lan-server', 'ws://127.0.0.1:8790');
      setVal('lan-room', 'PROBE1');
      setVal('lan-name', 'PROBE');
      const vs = document.getElementById('lan-versus');
      if (vs) { vs.checked = true; vs.dispatchEvent(new Event('change', { bubbles: true })); }
      const hostBtn = document.getElementById('lan-host');
      if (hostBtn) hostBtn.click();
      await new Promise(r => setTimeout(r, 2500));

      const startBtn = document.getElementById('lan-start');
      if (startBtn) startBtn.click();
      await new Promise(r => setTimeout(r, 3000));

      const net = g.net;
      const bots = g.versusBots || [];
      const info = {
        lanJoined: !!(net && net.role),
        role: net ? net.role : null,
        myTeam: net ? net.team : null,
        teamAssignments: net ? JSON.parse(JSON.stringify(net.teamAssignments || {})) : null,
        botCount: bots.length,
        botTeams: bots.map(b => b.team),
        versusMode: !!G.versusMode,
      };
      if (!info.versusMode || bots.length === 0) {
        info.error = 'versus did not start (no bots)';
        return info;
      }

      // --- stand where a bot actually spawns ---
      // In versus the zone covers the whole map, so the ring centre is the
      // map centre, and the team brain's tactical focus falls back to the
      // ring centre when it has no intel. Put the player next to a bot
      // spawn anchor so the fight actually happens — otherwise we measure
      // an idle map, not the swarm the player is complaining about.
      const zs = g.zoneSys ? g.zoneSys.state : null;
      const ring = zs ? { x: zs.x, z: zs.z } : { x: 0, z: 22 };
      // bot team spawn anchors (side 1): (-190,24) (130,-12) (98,-44) (-74,12) ...
      const SPOT = { x: 98, z: -44 };
      g.player.revive(SPOT.x + 3, SPOT.z + 3);
      g.player.setLook(0, -0.02);
      G.versusGraceT = 0;   // skip the deployment window; we want the fight
      G.freezeEnemies = false;

      // A real player in a 1v7 fight moves around and SHOOTS. Gunfire is a
      // noise event (main.js:4078), and noise is what wakes an unaware
      // soldier. Standing perfectly still would measure the wrong thing:
      // an idle player is never found, because the squad profile has no
      // patrol and the team brain cannot see humans.
      const noiseT = { t: 0 };

      const DUR = ${seconds * 1000};
      const t0 = performance.now();
      let lastHp = G.hp, dmg = 0, deaths = 0, deathAt = null;
      let aimAcc = 0, burst = 0, targetId = null;
      const p = g.player.pos;
      const samples = [];
      const brainSeen = { samples: 0, hasIntel: 0, priorityOnHuman: 0, priorityIds: {} };

      while (performance.now() - t0 < DUR) {
        await new Promise(r => setTimeout(r, 80));
        const now = performance.now() - t0;
        G.debugAutoFire = false;

        if (G.hp <= 0) {
          if (!deathAt) { deaths++; deathAt = +(now/1000).toFixed(1); }
          await new Promise(r => setTimeout(r, 300));
          continue;
        }

        // how many bots are aiming at the human right now?
        let aliveBots = 0, nearest = Infinity, aimingAtHuman = 0, shootingAtHuman = 0;
        const roles = {};
        const tgts = g.vsTargets ? g.vsTargets() : {};
        for (const b of (g.versusBots || [])) {
          const e = b.e;
          if (!e || !e.alive) continue;
          aliveBots++;
          if (e.aiRole) roles[e.aiRole] = (roles[e.aiRole]||0)+1;
          const d = Math.hypot(e.root.position.x - p.x, e.root.position.z - p.z);
          if (d < nearest) nearest = d;
          const t = tgts[e._netId];
          if (t != null && String(t) === String(net.selfId)) {
            aimingAtHuman++;
            // actually pulling the trigger at us right now
            if (e.canSee && e.contact && e.fireReady ? e.fireReady(d) : false) shootingAtHuman++;
          }
        }

        // faction brain state for the enemy team
        const brains = g.teamBrains || null;
        if (brains) {
          const b = brains[1];
          if (b) {
            brainSeen.samples++;
            if (b.hasIntel) brainSeen.hasIntel++;
            const pid = b.priorityTargetId;
            if (pid != null) {
              brainSeen.priorityIds[pid] = (brainSeen.priorityIds[pid]||0)+1;
              if (String(pid) === String(net.selfId)) brainSeen.priorityOnHuman++;
            }
          }
        }

        // --- decent-human combat: acquire, aim, burst, strafe ---
        // Fire on a timer whether or not a target is visible: a player
        // fighting a 1v7 sprays into the dark and that gunfire is exactly
        // what pulls the squad in.
        noiseT.t += 80;
        const firing = noiseT.t % 1400 < 420;
        aimAcc += 80;
        let target = null, bestD = 1e9;
        for (const b of (g.versusBots || [])) {
          const e = b.e;
          if (!e || !e.alive || !e.root.visible) continue;
          if (b.team === net.team) continue;
          const d = Math.hypot(e.root.position.x - p.x, e.root.position.z - p.z);
          if (d < bestD) { bestD = d; target = e; }
        }
        if (target) {
          const ep = target.root.position;
          const errY = () => (Math.random()-0.5)*0.042;
          const errP = () => (Math.random()-0.5)*0.03;
          if (aimAcc >= 150 || targetId !== target.root.id) {
            aimAcc = 0; targetId = target.root.id;
            const yaw = Math.atan2(-(ep.x-p.x), -(ep.z-p.z)) + errY();
            const pitch = Math.atan2((ep.y+1.2)-(p.y+1.62), Math.hypot(ep.x-p.x, ep.z-p.z)) + errP();
            g.player.setLook(yaw, pitch);
          }
        }
        burst += 80;
        if (firing) G.debugAutoFire = true;
        if (G.mag === 0 && G.reserve > 0) g.reload();

        // advance toward the nearest bot — a real player closes the distance
        // and the gunfire (a noise event) is what pulls the squad in
        if (target && bestD > 18) {
          const ep = target.root.position;
          const dx = ep.x - p.x, dz = ep.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          const step = 0.055;
          const nx = p.x + (dx/len)*step, nz = p.z + (dz/len)*step;
          if (g.nav.isWalkableAt(nx, nz, p.y)) { p.x = nx; p.z = nz; }
        }
        const dir = Math.sin(now/900) > 0 ? 1 : -1;
        const nx = p.x + dir * 0.035;
        if (g.nav.isWalkableAt(nx, p.z, p.y)) p.x = nx;

        if (G.hp < lastHp) dmg += lastHp - G.hp;
        lastHp = G.hp;
        samples.push({
          t: +(now/1000).toFixed(1), hp: Math.round(G.hp),
          aliveBots, nearest: +nearest.toFixed(1), roles: JSON.stringify(roles),
          aimingAtHuman, shootingAtHuman,
        });
      }
      return {
        ...info, samples, damage: +dmg.toFixed(1), deaths, deathAt,
        brainSeen, hp: G.hp, teamScores: G.teamScores.slice(),
        seconds: ${seconds},
      };
    })()`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const raw = r.result && r.result.value;
    if (!raw) throw new Error('probe failed: ' + JSON.stringify(r).slice(0, 800));

    // --- analysis ---
    const perBotAiming = raw.samples.map(s => s.aliveBots);
    const avgAlive = perBotAiming.length ? perBotAiming.reduce((a,b)=>a+b,0)/perBotAiming.length : 0;
    const nearestVals = raw.samples.map(s => s.nearest).filter(n => Number.isFinite(n));
    const avgNearest = nearestVals.length ? nearestVals.reduce((a,b)=>a+b,0)/nearestVals.length : 0;
    const aimVals = raw.samples.map(s => s.aimingAtHuman).filter(n => Number.isFinite(n));
    const avgAiming = aimVals.length ? aimVals.reduce((a,b)=>a+b,0)/aimVals.length : 0;
    const maxAiming = aimVals.length ? Math.max(...aimVals) : 0;
    const shootVals = raw.samples.map(s => s.shootingAtHuman).filter(n => Number.isFinite(n));
    const avgShooting = shootVals.length ? shootVals.reduce((a,b)=>a+b,0)/shootVals.length : 0;
    const maxShooting = shootVals.length ? Math.max(...shootVals) : 0;
    // how many bots hold each role (summed over frames)
    const roleMix = {};
    for (const s of raw.samples) {
      try {
        const r = JSON.parse(s.roles || '{}');
        for (const k of Object.keys(r)) roleMix[k] = (roleMix[k]||0) + r[k];
      } catch (e) { /* ignore */ }
    }

    const summary = {
      mode: 'versus 1v7 (solo human + 7 AI)',
      lobbyJoined: raw.lanJoined, role: raw.role,
      myTeam: raw.myTeam, teamAssignments: raw.teamAssignments,
      botCount: raw.botCount, botTeams: raw.botTeams,
      versusMode: raw.versusMode,
      damageTaken: raw.damage,
      dpsTaken: +(raw.damage / raw.seconds).toFixed(2),
      deaths: raw.deaths, deathAt: raw.deathAt,
      hpEnd: raw.hp,
      teamScores: raw.teamScores,
      avgAliveBotsEngaged: +avgAlive.toFixed(1),
      avgBotsAimingAtHuman: +avgAiming.toFixed(1),
      maxBotsAimingAtHuman: maxAiming,
      avgBotsShootingAtHuman: +avgShooting.toFixed(1),
      maxBotsShootingAtHuman: maxShooting,
      roleMixFrames: roleMix,
      avgNearestBotDist: +avgNearest.toFixed(1),
      brainHasIntelRate: raw.brainSeen ? +(raw.brainSeen.hasIntel / Math.max(1, raw.brainSeen.samples)).toFixed(2) : null,
      brainPriorityOnHuman: raw.brainSeen ? raw.brainSeen.priorityOnHuman : null,
      brainPriorityIds: raw.brainSeen ? raw.brainSeen.priorityIds : null,
      error: raw.error || null,
    };
    fs.writeFileSync(out, JSON.stringify({ summary, samples: raw.samples }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (issues.length) console.log('ISSUES:\n' + [...new Set(issues)].slice(0,6).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
    if (issues.length) console.error([...new Set(issues)].slice(0,6).join('\n'));
    cleanup(1);
  }
})();
