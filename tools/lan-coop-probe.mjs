#!/usr/bin/env node
/**
 * One-off LAN integration probe (Phase 0 verification).
 *
 * Joins a room as a protocol-level fake client (no renderer) against a real
 * host browser session, then verifies:
 *   1. host applies the client's input (mirror follows our position)
 *   2. enemies damage the client: 'damage' events arrive targeted at us (P0-2)
 *   3. client grenade is simulated by the host: 'boom' event comes back (P0-6)
 *   4. milestones advance from a non-host player standing in the zone (P0-7)
 *
 * Usage: node /tmp/lan-probe.mjs <room> <serverUrl>
 * Requires a host browser already in-game in that room (co-op).
 */
import WebSocket from 'ws';

const room = process.argv[2] || 'COOP1';
const server = process.argv[3] || 'ws://127.0.0.1:8790';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new WebSocket(`${server}/?room=${room}`);
let selfId = null;
let hostId = null;
let snapshot = null;
let pos = { x: 2.2, y: 0, z: -164 };
let hp = 100;
let alive = true;
let seq = 0;
let damageEvents = 0;
let boomEvents = 0;
let milestoneStart = null;
let milestoneAdvanced = false;
let phase = 'join';

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'join', room, name: 'PROBE', mode: 'coop' }));
});

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.t === 'welcome') {
    selfId = msg.id;
    hostId = msg.host;
    log('joined', { selfId, hostId, mode: msg.mode });
    phase = 'play';
    return;
  }
  if (msg.t === 'snapshot') {
    snapshot = msg;
    return;
  }
  if (msg.t !== 'event') return;
  if (msg.kind === 'damage' && msg.target === selfId) {
    damageEvents += 1;
    // a real client applies it to their own HP and reports back via input
    hp = Math.max(0, hp - (Number(msg.amount) || 0));
    if (hp <= 0 && alive) { alive = false; ws.send(JSON.stringify({ t: 'event', kind: 'down' })); }
    if (damageEvents <= 3) log('DAMAGE received', { amount: msg.amount, hp });
    return;
  }
  if (msg.kind === 'boom') {
    boomEvents += 1;
    log('BOOM received', { x: msg.x, y: msg.y, z: msg.z });
    return;
  }
});

// input stream
setInterval(() => {
  if (!selfId) return;
  ws.send(JSON.stringify({
    t: 'input', seq: ++seq,
    x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
    yaw: 0, pitch: 0, hp: Math.round(hp), alive,
  }));
}, 100);

// scripted phases
async function main() {
  // wait for the game to be running (snapshots flowing with enemies)
  for (let i = 0; i < 100; i += 1) {
    if (snapshot && Array.isArray(snapshot.enemies) && snapshot.enemies.some((e) => e.alive !== false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!snapshot) { log('FAIL: no snapshot'); process.exit(1); }
  const foe = snapshot.enemies.find((e) => e.alive !== false);
  log('first live enemy', foe);

  // P0-2: stand next to a live enemy so host-side AI targets us
  pos = { x: foe.x + 2.5, y: foe.y || 0, z: foe.z };
  log('teleported next to enemy at', pos);
  const t0 = Date.now();
  while (damageEvents === 0 && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  log(damageEvents > 0 ? `P0-2 PASS: enemy damaged remote client (${damageEvents} events)` : 'P0-2 FAIL: no damage events in 20s');

  // P0-6: throw a grenade (client -> host simulates -> boom broadcast)
  ws.send(JSON.stringify({
    t: 'event', kind: 'grenade',
    ox: +pos.x.toFixed(2), oy: 1.5, oz: +pos.z.toFixed(2),
    vx: 0, vy: 8, vz: 0,
  }));
  log('grenade thrown');
  const t1 = Date.now();
  while (boomEvents === 0 && Date.now() - t1 < 6000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  log(boomEvents > 0 ? 'P0-6 PASS: host simulated client grenade and broadcast boom' : 'P0-6 FAIL: no boom in 6s');

  // P0-7: move into the active milestone zone (reach/hold) or collect it
  const ms = snapshot && snapshot.milestones;
  log('milestone step', ms);
  if (ms && !ms.done && Number.isFinite(ms.x)) {
    milestoneStart = ms.index;
    pos = { x: ms.x, y: 0, z: ms.z };
    if (ms.kind === 'collect') {
      // stand at the marker and report the use
      ws.send(JSON.stringify({ t: 'event', kind: 'mcollect', step: ms.index }));
    }
    const t2 = Date.now();
    while (Date.now() - t2 < 15000) {
      await new Promise((r) => setTimeout(r, 300));
      const cur = snapshot && snapshot.milestones;
      if (cur && cur.index !== milestoneStart) { milestoneAdvanced = true; break; }
      // collect steps may need a second push if the first raced the teleport
      if (ms.kind === 'collect' && !milestoneAdvanced) {
        ws.send(JSON.stringify({ t: 'event', kind: 'mcollect', step: milestoneStart }));
      }
    }
    log(milestoneAdvanced
      ? `P0-7 PASS: milestone advanced by a non-host player (${ms.kind})`
      : `P0-7 FAIL: milestone stuck at index ${milestoneStart} (${ms.kind})`);
  } else {
    log('P0-7 SKIP: no positional milestone step', ms && ms.kind);
  }

  log('summary', { damageEvents, boomEvents, milestoneAdvanced, hp });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
setTimeout(() => { log('TIMEOUT'); process.exit(1); }, 60000);
