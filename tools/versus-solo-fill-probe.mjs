#!/usr/bin/env node
/**
 * VERSUS solo-fill probe — verifies what a solo player actually gets.
 *
 * The design spec (docs/MULTIPLAYER-DESIGN.md) says: "each team is padded to
 * 4 combatants with AI bots; e.g. 2 humans + 2 bots per side" and "up to 8
 * bots total (4 per team), fewer when more humans join". A solo host must
 * therefore get 3 allies + 4 enemies — never a 1v7 deathmatch.
 *
 * This probe boots a real headless browser, joins a real LAN room as the
 * ONLY human, starts VERSUS, and then samples every frame:
 *
 *   1. team composition     — bots per faction (must be 3 ally / 4 enemy)
 *   2. who aims at the human — per faction. Ally bots aiming at their own
 *      human is friendly fire and must be ZERO.
 *   3. incoming DPS         — damage the player actually takes
 *   4. the enemy brain      — priority target + intel state
 *
 * usage: node tools/versus-solo-fill-probe.mjs [seconds] [url] [out]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const seconds = Number(process.argv[2] || 30);
const url = process.argv[3] || 'http://127.0.0.1:5173/?lan=ws://127.0.0.1:8790';
const out = process.argv[4] || 'shots/versus-solo-fill-probe.json';
const W = 1280, H = 720;
const PORT = 9900 + Math.floor(Math.random() * 90);
const profile = `/tmp/dod-fill-${PORT}`;
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

    const expr = `(async () => {
      const g = window.__game;
      if (!g) return { error: 'no __game' };
      const G = g.state;

      // --- join a real room as the only player (via the lobby's own path) ---
      const lobby = g.lanLobby;
      if (!lobby) return { error: 'no lanLobby' };
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } };
      setVal('lan-server', 'ws://127.0.0.1:8790');
      setVal('lan-room', 'FILL1');
      setVal('lan-name', 'FILLPROBE');
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
        botSlots: bots.map(b => b.slot),
        versusMode: !!G.versusMode,
      };
      if (!info.versusMode || bots.length === 0) {
        info.error = 'versus did not start (no bots)';
        return info;
      }

      // Stand near a control point but NOT on it: a player standing exactly
      // on a point freezes the capture (contested = nobody scores), which
      // would hide whether the AI ever takes a point on its own.
      const cpInfo = g.vsControlPoints ? g.vsControlPoints() : null;
      let px = 98, pz = -44;
      if (cpInfo && cpInfo.points && cpInfo.points.length) {
        const mid = cpInfo.points.find((q) => q.id === 'mid') || cpInfo.points[0];
        px = mid.x + 26; pz = mid.z + 14;
      }
      g.player.revive(px, pz);
      g.player.setLook(0, -0.02);
      G.versusGraceT = 0;
      G.freezeEnemies = false;

      const DUR = ${seconds * 1000};
      const t0 = performance.now();
      let lastHp = G.hp, dmg = 0, deaths = 0, deathAt = null;
      let aimAcc = 0, targetId = null, noiseT = 0;
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

        // --- per-faction target audit -------------------------------------
        // vsTargets() reports each soldier's CURRENT target id. A blue bot
        // whose target is the blue human is friendly fire.
        const tgts = g.vsTargets ? g.vsTargets() : {};
        let allyAlive = 0, enemyAlive = 0;
        let allyAimingAtHuman = 0, enemyAimingAtHuman = 0;
        let allyShootingAtHuman = 0, enemyShootingAtHuman = 0;
        let nearest = Infinity, nearestEnemy = Infinity;
        const roles = {};
        for (const b of (g.versusBots || [])) {
          const e = b.e;
          if (!e || !e.alive) continue;
          if (e.aiRole) roles[e.aiRole] = (roles[e.aiRole]||0)+1;
          const d = Math.hypot(e.root.position.x - p.x, e.root.position.z - p.z);
          if (d < nearest) nearest = d;
          const t = tgts[e._netId];
          const aiming = t != null && String(t) === String(net.selfId);
          if (b.team === net.team) {
            allyAlive++;
            if (d < nearestEnemy) nearestEnemy = d;
            if (aiming) {
              allyAimingAtHuman++;
              if (e.canSee && e.contact && e.fireReady ? e.fireReady(d) : false) allyShootingAtHuman++;
            }
          } else {
            enemyAlive++;
            if (d < nearestEnemy) nearestEnemy = d;
            if (aiming) {
              enemyAimingAtHuman++;
              if (e.canSee && e.contact && e.fireReady ? e.fireReady(d) : false) enemyShootingAtHuman++;
            }
          }
        }

        // --- enemy faction brain -----------------------------------------
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

        // --- decent-human combat ------------------------------------------
        // Fire on a timer: gunfire is a noise event and noise is what pulls
        // an unaware soldier into the fight.
        noiseT += 80;
        const firing = noiseT % 1400 < 420;
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
        if (firing) G.debugAutoFire = true;
        if (G.mag === 0 && G.reserve > 0) g.reload();

        // advance toward the nearest enemy — a real player closes the gap
        if (target && bestD > 20) {
          const ep = target.root.position;
          const dx = ep.x - p.x, dz = ep.z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          const step = 0.06;
          const nx = p.x + (dx/len)*step, nz = p.z + (dz/len)*step;
          if (g.nav.isWalkableAt(nx, nz, p.y)) { p.x = nx; p.z = nz; }
        }
        const dir = Math.sin(now/900) > 0 ? 1 : -1;
        const nx = p.x + dir * 0.035;
        if (g.nav.isWalkableAt(nx, p.z, p.y)) p.x = nx;

        if (G.hp < lastHp) dmg += lastHp - G.hp;
        lastHp = G.hp;
        // conquest round state: who owns the control points, and how the
        // round is actually being scored (bots have no objective behaviour,
        // so point income can stall entirely)
        const cs = g.conquestState || null;
        const owners = cs ? cs.points.map((pt) => (pt.owner === 0 ? 'B' : pt.owner === 1 ? 'R' : '-')).join('') : null;
        // objective runners: who carries a control-point waypoint and how far
        // they still are from it
        const objs = g.vsObjectives ? g.vsObjectives() : {};
        let objCount = 0, objMinDist = Infinity, objIds = [];
        for (const b of (g.versusBots || [])) {
          const o = objs[b.e ? b.e._netId : -1];
          if (!o) continue;
          objCount++;
          const dd = Math.hypot(o.x - b.e.root.position.x, o.z - b.e.root.position.z);
          if (dd < objMinDist) objMinDist = dd;
          objIds.push('T' + b.team + ':' + (o.id || '?') + ':' + dd.toFixed(0));
        }
        const cp = g.vsControlPoints ? g.vsControlPoints() : null;
        samples.push({
          t: +(now/1000).toFixed(1), hp: Math.round(G.hp),
          allyAlive, enemyAlive, nearest: +nearest.toFixed(1),
          allyAimingAtHuman, enemyAimingAtHuman,
          allyShootingAtHuman, enemyShootingAtHuman,
          roles: JSON.stringify(roles),
          owners, pts: cs ? cs.pts.slice() : null, phase: cs ? cs.phase : null,
          objCount, objMinDist: Number.isFinite(objMinDist) ? +objMinDist.toFixed(1) : null,
          objIds: objIds.join(','),
          cp: cp ? JSON.stringify(cp.points.map((p) => [p.id, p.owner, +Number(p.prog).toFixed(2), p.progTeam])) : null,
          pres: g.vsPresence ? JSON.stringify(g.vsPresence()) : null,
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
    if (!Array.isArray(raw.samples)) {
      throw new Error('probe returned no samples: ' + JSON.stringify(raw).slice(0, 900)
        + (r.exceptionDetails ? ' | EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) : ''));
    }

    // --- analysis ---
    const avg = (key) => {
      const v = raw.samples.map((s) => s[key]).filter((n) => Number.isFinite(n));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    };
    const max = (key) => {
      const v = raw.samples.map((s) => s[key]).filter((n) => Number.isFinite(n));
      return v.length ? Math.max(...v) : 0;
    };
    const roleMix = {};
    for (const s of raw.samples) {
      try {
        const rr = JSON.parse(s.roles || '{}');
        for (const k of Object.keys(rr)) roleMix[k] = (roleMix[k] || 0) + rr[k];
      } catch (e) { /* ignore */ }
    }

    const allyCount = (raw.botTeams || []).filter((t) => t === raw.myTeam).length;
    const enemyCount = (raw.botTeams || []).filter((t) => t !== raw.myTeam).length;

    const summary = {
      mode: 'versus solo fill (1 human + AI padding)',
      lobbyJoined: raw.lanJoined, role: raw.role,
      myTeam: raw.myTeam, teamAssignments: raw.teamAssignments,
      botCount: raw.botCount,
      botTeams: raw.botTeams, botSlots: raw.botSlots,
      allyBots: allyCount, enemyBots: enemyCount,
      versusMode: raw.versusMode,
      damageTaken: raw.damage,
      dpsTaken: +(raw.damage / raw.seconds).toFixed(2),
      deaths: raw.deaths, deathAt: raw.deathAt,
      hpEnd: raw.hp,
      teamScores: raw.teamScores,
      avgAllyBotsAlive: +avg('allyAlive').toFixed(1),
      avgEnemyBotsAlive: +avg('enemyAlive').toFixed(1),
      avgAllyAimingAtHuman: +avg('allyAimingAtHuman').toFixed(2),
      maxAllyAimingAtHuman: max('allyAimingAtHuman'),
      avgEnemyAimingAtHuman: +avg('enemyAimingAtHuman').toFixed(2),
      maxEnemyAimingAtHuman: max('enemyAimingAtHuman'),
      avgAllyShootingAtHuman: +avg('allyShootingAtHuman').toFixed(2),
      avgEnemyShootingAtHuman: +avg('enemyShootingAtHuman').toFixed(2),
      roleMixFrames: roleMix,
      brainHasIntelRate: raw.brainSeen ? +(raw.brainSeen.hasIntel / Math.max(1, raw.brainSeen.samples)).toFixed(2) : null,
      brainPriorityOnHuman: raw.brainSeen ? raw.brainSeen.priorityOnHuman : null,
      brainPriorityIds: raw.brainSeen ? raw.brainSeen.priorityIds : null,
      error: raw.error || null,
    };
    fs.writeFileSync(out, JSON.stringify({ summary, samples: raw.samples }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (issues.length) console.log('ISSUES:\n' + [...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(0);
  } catch (e) {
    console.error('PROBE FAILED:', e.message);
    if (issues.length) console.error([...new Set(issues)].slice(0, 6).join('\n'));
    cleanup(1);
  }
})();
