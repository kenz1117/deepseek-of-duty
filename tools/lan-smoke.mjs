#!/usr/bin/env node
/**
 * LAN relay smoke test.
 *
 * Starts server/lan.mjs on an ephemeral port (LAN_PORT=0), connects real
 * `ws` clients, and verifies:
 *   - welcome / lobby / host election
 *   - host snapshot relay and client input/fire relay
 *   - ready event updates the lobby
 *   - host event broadcast
 *   - co-op cap (LAN_COOP_MAX_PLAYERS) and BR cap (LAN_BR_MAX_PLAYERS)
 *   - mode round-trip (`coop` / `br`) + BR zone/player relay
 *   - host promotion on disconnect
 *   - per-client message rate limit
 *   - 16 KB WebSocket payload cap
 *
 * Usage: node tools/lan-smoke.mjs
 * Exits 0 on success, 1 on any failure. Does not touch ports 5173/8790.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  LAN_BR_MAX_PLAYERS,
  LAN_COOP_MAX_PLAYERS,
  LAN_RATE_LIMIT_PER_SEC,
} from '../src/net/lanProtocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server', 'lan.mjs');

let child = null;
let stdoutTail = '';
let stderrTail = '';
let failures = 0;
const clients = [];

function appendTail(current, chunk, maxLines = 30) {
  const lines = (current + chunk).split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function check(label, condition, details = '') {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${details ? ` — ${details}` : ''}`);
  }
}

class TestClient {
  constructor(url) {
    this.url = url;
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.closed = null;
    this.closeWaiters = [];
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('close', (code, reason) => this.onClose(code, String(reason || '')));
    this.ws.on('error', () => {
      /* close follows; avoid unhandled 'error' */
    });
    clients.push(this);
  }

  open(timeoutMs = 4000) {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off('open', onOpen);
        this.ws.off('error', onError);
        reject(new Error(`WebSocket open timeout: ${this.url}`));
      }, timeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        this.ws.off('error', onError);
        resolve();
      };
      const onError = () => {
        clearTimeout(timer);
        this.ws.off('open', onOpen);
        reject(new Error(`WebSocket open failed: ${this.url}`));
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
    });
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    this.messages.push(message);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (!waiter.predicate(message)) continue;
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  onClose(code, reason) {
    this.closed = { code, reason };
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`socket closed while waiting for ${waiter.label} (${code})`));
    }
    for (const waiter of this.closeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.closed);
    }
  }

  send(message) {
    if (this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  rawSend(text) {
    if (this.ws.readyState !== 1) return false;
    try {
      this.ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  waitFor(predicate, { timeoutMs = 4000, label = 'message' } = {}) {
    const existing = this.messages.findIndex(predicate);
    if (existing >= 0) {
      return Promise.resolve(this.messages.splice(existing, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        label,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          resolve(message);
        },
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitClose(timeoutMs = 4000) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (closed) => {
          clearTimeout(waiter.timer);
          resolve(closed);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.closeWaiters.indexOf(waiter);
        if (index >= 0) this.closeWaiters.splice(index, 1);
        reject(new Error('timeout waiting for socket close'));
      }, timeoutMs);
      this.closeWaiters.push(waiter);
    });
  }

  close() {
    try {
      this.ws.close(1000, 'test_done');
    } catch {
      /* ignore */
    }
  }
}

async function startServer() {
  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, LAN_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk.toString());
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const match = stdoutTail.match(/listening on ws:\/\/[^:\s]+:(\d+)/);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\n${stderrTail}`);
    }
    await sleep(50);
  }
  throw new Error(`server did not report a listening port\n${stderrTail}`);
}

async function stopServer() {
  for (const client of clients) client.close();
  await sleep(100);
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(3000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(1000)]);
  }
  try {
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch {
    /* ignore */
  }
}

async function main() {
  const port = await startServer();
  const wsBase = `ws://127.0.0.1:${port}/?room=COOP`;
  console.log(`[lan-smoke] server on ephemeral port ${port}`);

  // --- welcome / lobby / host election ------------------------------------
  const a = new TestClient(wsBase);
  await a.open();
  a.send({ t: 'join', room: 'COOP', name: 'HOST' });

  const aWelcome = await a.waitFor(
    (message) => message.t === 'welcome',
    { label: 'welcome for A' }
  );
  check(
    'welcome: A 获得 id/host/room/mode/players（缺省 coop）',
    typeof aWelcome.id === 'string' &&
      aWelcome.host === aWelcome.id &&
      aWelcome.room === 'COOP' &&
      aWelcome.mode === 'coop' &&
      Array.isArray(aWelcome.players) &&
      aWelcome.players.length === 1,
    JSON.stringify(aWelcome)
  );

  const aLobby1 = await a.waitFor(
    (message) => message.t === 'lobby' && message.players.length === 1,
    { label: 'lobby with 1 player' }
  );
  check(
    'lobby: A 是 host（mode=coop）',
    aLobby1.mode === 'coop' &&
      aLobby1.players[0].id === aWelcome.id &&
      aLobby1.players[0].host === true,
    JSON.stringify(aLobby1)
  );

  const b = new TestClient(wsBase);
  await b.open();
  b.send({ t: 'join', room: 'COOP', name: 'CLIENT' });

  const bWelcome = await b.waitFor(
    (message) => message.t === 'welcome',
    { label: 'welcome for B' }
  );
  check(
    'welcome: B 看到 A 是 host、两人且 mode=coop',
    bWelcome.id !== aWelcome.id &&
      bWelcome.host === aWelcome.id &&
      bWelcome.mode === 'coop' &&
      bWelcome.players.length === 2,
    JSON.stringify(bWelcome)
  );

  const aLobby2 = await a.waitFor(
    (message) => message.t === 'lobby' && message.players.length === 2,
    { label: 'lobby with 2 players' }
  );
  check(
    'lobby: A 看到两个玩家且只有自己是 host',
    aLobby2.players.filter((player) => player.host).length === 1 &&
      aLobby2.players.find((player) => player.host).id === aWelcome.id,
    JSON.stringify(aLobby2)
  );

  // --- snapshot / input / fire relay --------------------------------------
  a.send({
    t: 'snapshot',
    tick: 7,
    players: [{ id: aWelcome.id, x: 1, z: 2 }],
    enemies: [{ id: 'e1', x: 3, z: 4 }],
    wave: 3,
    kills: 11,
    objective: 'defend',
  });
  const snapshot = await b.waitFor(
    (message) => message.t === 'snapshot',
    { label: 'snapshot from host' }
  );
  check(
    'snapshot: host 快照到达 client（服务端补 mode=coop）',
    snapshot.mode === 'coop' &&
      snapshot.tick === 7 && snapshot.wave === 3 && snapshot.kills === 11 &&
      snapshot.objective === 'defend',
    JSON.stringify(snapshot)
  );

  b.send({
    t: 'input',
    seq: 5,
    x: 1,
    z: 2,
    yaw: 0.5,
    pitch: 0,
    hp: 90,
    alive: true,
  });
  const input = await a.waitFor(
    (message) => message.t === 'input',
    { label: 'input from B' }
  );
  check(
    'input: client 输入到达 host 且带来源 id',
    input.id === bWelcome.id && input.seq === 5 && input.hp === 90,
    JSON.stringify(input)
  );

  b.send({
    t: 'fire',
    seq: 6,
    ox: 0,
    oy: 1.6,
    oz: 0,
    dx: 1,
    dy: 0,
    dz: 0,
    weapon: 'AK',
  });
  const fire = await a.waitFor(
    (message) => message.t === 'fire',
    { label: 'fire from B' }
  );
  check(
    'fire: client 开火到达 host 且带来源 id',
    fire.id === bWelcome.id && fire.weapon === 'AK' && fire.seq === 6,
    JSON.stringify(fire)
  );

  // Host fire is relayed to clients for presentation.
  a.send({
    t: 'fire',
    seq: 7,
    ox: 2,
    oy: 1.6,
    oz: 2,
    dx: -1,
    dy: 0,
    dz: 0,
    weapon: 'M4',
  });
  const hostFire = await b.waitFor(
    (message) => message.t === 'fire' && message.id === aWelcome.id,
    { label: 'host fire broadcast' }
  );
  check('fire: host 开火广播到 client', hostFire.weapon === 'M4', JSON.stringify(hostFire));

  // --- ready event + lobby update ----------------------------------------
  b.send({ t: 'event', kind: 'ready', ready: true });
  const readyEvent = await a.waitFor(
    (message) => message.t === 'event' && message.kind === 'ready',
    { label: 'ready event on host' }
  );
  check('event: client ready 到达 host', readyEvent.id === bWelcome.id, JSON.stringify(readyEvent));

  const readyLobby = await a.waitFor(
    (message) =>
      message.t === 'lobby' &&
      message.players.some((player) => player.id === bWelcome.id && player.ready === true),
    { label: 'lobby with ready flag' }
  );
  check('lobby: ready 状态被服务端记录', readyLobby.players.length === 2, JSON.stringify(readyLobby));

  // --- host event broadcast ----------------------------------------------
  a.send({ t: 'event', kind: 'damage', target: bWelcome.id, amount: 10 });
  const damage = await b.waitFor(
    (message) => message.t === 'event' && message.kind === 'damage',
    { label: 'damage event on client' }
  );
  check(
    'event: host 事件广播到 client',
    damage.id === aWelcome.id && damage.target === bWelcome.id && damage.amount === 10,
    JSON.stringify(damage)
  );

  // --- co-op room cap -----------------------------------------------------
  // Co-op stays at 4 players even though the absolute/BR ceiling is 8.
  const fillers = [];
  for (let i = 2; i < LAN_COOP_MAX_PLAYERS; i++) {
    const filler = new TestClient(wsBase);
    await filler.open();
    filler.send({ t: 'join', room: 'COOP', name: `FILLER${i}` });
    await filler.waitFor((message) => message.t === 'welcome', { label: `welcome for filler ${i}` });
    fillers.push(filler);
  }

  const overflow = new TestClient(wsBase);
  await overflow.open();
  overflow.send({ t: 'join', room: 'COOP', name: 'OVERFLOW' });
  const overflowClose = await overflow.waitClose(4000);
  check(
    `co-op room cap: 第 ${LAN_COOP_MAX_PLAYERS + 1} 人被拒绝（4004）`,
    overflowClose.code === 4004,
    JSON.stringify(overflowClose)
  );

  // Drop the fillers so the host-promotion check below still sees 1 remaining
  // player after A leaves.
  for (const filler of fillers) filler.close();
  await sleep(300);

  // --- host promotion -----------------------------------------------------
  // The room is back to A + B, so after A leaves only B remains.
  a.close();
  const promotedLobby = await b.waitFor(
    (message) =>
      message.t === 'lobby' &&
      message.players.length === 1 &&
      message.players.some((player) => player.id === bWelcome.id && player.host === true),
    { label: 'lobby after host promotion' }
  );
  const hostChange = await b.waitFor(
    (message) =>
      message.t === 'event' &&
      message.kind === 'host_change' &&
      message.host === bWelcome.id,
    { label: 'host_change event' }
  );
  check(
    'host promotion: A 断开后 B 被提升为 host',
    promotedLobby.players.filter((player) => player.host).length === 1 &&
      hostChange.host === bWelcome.id,
    JSON.stringify({ promotedLobby, hostChange })
  );

  b.close();
  await sleep(200);

  // -------------------------------------------------------------------------
  // Battle Royale: 8-player room, mode round-trip, BR zone/player relay.
  // -------------------------------------------------------------------------
  const brBase = `ws://127.0.0.1:${port}/?room=BRROOM`;
  const brClients = [];
  const brWelcomes = [];
  for (let i = 0; i < LAN_BR_MAX_PLAYERS; i += 1) {
    const brClient = new TestClient(brBase);
    await brClient.open();
    brClient.send({ t: 'join', room: 'BRROOM', name: `BR${i}`, mode: 'br' });
    const welcome = await brClient.waitFor(
      (message) => message.t === 'welcome',
      { label: `BR welcome ${i}` }
    );
    brClients.push(brClient);
    brWelcomes.push(welcome);
  }
  check(
    `BR: ${LAN_BR_MAX_PLAYERS} 人全部加入且 welcome.mode=br`,
    brWelcomes.length === LAN_BR_MAX_PLAYERS &&
      brWelcomes.every((welcome) => welcome.mode === 'br' && welcome.room === 'BRROOM'),
    JSON.stringify(brWelcomes.map((welcome) => ({ id: welcome.id, mode: welcome.mode })))
  );

  const brLobby = await brClients[0].waitFor(
    (message) =>
      message.t === 'lobby' &&
      message.mode === 'br' &&
      message.players.length === LAN_BR_MAX_PLAYERS,
    { label: 'BR lobby with 8 players' }
  );
  check(
    'BR lobby: host 看到 8 人且 mode=br',
    brLobby.players.length === LAN_BR_MAX_PLAYERS && brLobby.mode === 'br',
    JSON.stringify(brLobby.players.map((player) => player.name))
  );

  const brOverflow = new TestClient(brBase);
  await brOverflow.open();
  brOverflow.send({ t: 'join', room: 'BRROOM', name: 'BR_OVERFLOW', mode: 'br' });
  const brOverflowClose = await brOverflow.waitClose(4000);
  check(
    `BR room cap: 第 ${LAN_BR_MAX_PLAYERS + 1} 人被拒绝（4004）`,
    brOverflowClose.code === 4004,
    JSON.stringify(brOverflowClose)
  );

  const brHostId = brWelcomes[0].id;
  const brPeerId = brWelcomes[1].id;
  brClients[0].send({
    t: 'snapshot',
    mode: 'br',
    tick: 10,
    players: [
      { id: brHostId, team: 'alpha', hp: 100, alive: true, x: 1, z: 2 },
      { id: brPeerId, team: 'bravo', hp: 80, alive: true, x: 3, z: 4 },
    ],
    enemies: [],
    wave: 0,
    kills: 0,
    objective: null,
    br: {
      zone: {
        x: 0,
        z: 0,
        r: 50,
        nextX: 10,
        nextZ: -5,
        nextR: 40,
        phase: 'closing',
        shrinkLeft: 30,
      },
      alive: 2,
      winner: null,
      phase: 'live',
    },
  });
  const brSnapshot = await brClients[1].waitFor(
    (message) => message.t === 'snapshot' && message.mode === 'br',
    { label: 'BR snapshot on client' }
  );
  check(
    'BR snapshot: mode/br.zone/player team/hp/alive 原样中继',
    brSnapshot.br &&
      brSnapshot.br.zone &&
      brSnapshot.br.zone.x === 0 &&
      brSnapshot.br.zone.z === 0 &&
      brSnapshot.br.zone.r === 50 &&
      brSnapshot.br.zone.nextX === 10 &&
      brSnapshot.br.zone.nextZ === -5 &&
      brSnapshot.br.zone.nextR === 40 &&
      brSnapshot.br.zone.phase === 'closing' &&
      brSnapshot.br.zone.shrinkLeft === 30 &&
      brSnapshot.br.alive === 2 &&
      brSnapshot.br.winner === null &&
      brSnapshot.br.phase === 'live' &&
      brSnapshot.players[0].team === 'alpha' &&
      brSnapshot.players[0].hp === 100 &&
      brSnapshot.players[0].alive === true &&
      brSnapshot.players[1].team === 'bravo' &&
      brSnapshot.players[1].hp === 80,
    JSON.stringify(brSnapshot)
  );

  brClients[0].send({ t: 'start', mode: 'br' });
  const brStart = await brClients[1].waitFor(
    (message) => message.t === 'start',
    { label: 'BR start on client' }
  );
  check('BR start: mode 回环为 br', brStart.mode === 'br', JSON.stringify(brStart));

  brClients[1].send({
    t: 'fire',
    seq: 9,
    ox: 1,
    oy: 2,
    oz: 3,
    dx: 0.1,
    dy: 0,
    dz: -0.1,
    weapon: 'AR',
  });
  const brFire = await brClients[0].waitFor(
    (message) => message.t === 'fire' && message.id === brPeerId,
    { label: 'BR fire reaches host' }
  );
  check(
    'BR fire: 射线参数到达 host 且带来源 id',
    brFire.ox === 1 && brFire.oy === 2 && brFire.oz === 3 &&
      brFire.dx === 0.1 && brFire.dz === -0.1 && brFire.weapon === 'AR',
    JSON.stringify(brFire)
  );

  brClients[0].send({ t: 'event', kind: 'damage', target: brPeerId, amount: 25 });
  const brDamage = await brClients[1].waitFor(
    (message) => message.t === 'event' && message.kind === 'damage',
    { label: 'BR damage on client' }
  );
  check(
    'BR damage: host 事件带 target/amount 到达 client',
    brDamage.id === brHostId && brDamage.target === brPeerId && brDamage.amount === 25,
    JSON.stringify(brDamage)
  );

  for (const brClient of brClients) brClient.close();
  await sleep(250);

  // --- rate limit ---------------------------------------------------------
  // Burst past the inbound budget; the budget itself is imported so this test
  // tracks LAN_RATE_LIMIT_PER_SEC rather than a frozen number.
  const rate = new TestClient(`ws://127.0.0.1:${port}/?room=RATE`);
  await rate.open();
  rate.send({ t: 'join', room: 'RATE', name: 'SPAM' });
  await rate.waitFor((message) => message.t === 'welcome', { label: 'welcome for rate client' });
  for (let i = 0; i < LAN_RATE_LIMIT_PER_SEC + 40; i += 1) {
    rate.send({ t: 'event', kind: 'noop', i });
  }
  const rateClose = await rate.waitClose(5000);
  check(
    `rate limit: 超过 ${LAN_RATE_LIMIT_PER_SEC} 条/秒被关闭（4029）`,
    rateClose.code === 4029,
    JSON.stringify(rateClose)
  );

  // --- 16 KB payload cap --------------------------------------------------
  const big = new TestClient(`ws://127.0.0.1:${port}/?room=BIG`);
  await big.open();
  big.send({ t: 'join', room: 'BIG', name: 'BIG' });
  await big.waitFor((message) => message.t === 'welcome', { label: 'welcome for big client' });
  big.rawSend('x'.repeat(17_000));
  const bigClose = await big.waitClose(5000);
  check('payload cap: 17KB 消息被关闭（1009）', bigClose.code === 1009, JSON.stringify(bigClose));
}

let exitCode = 1;
try {
  await main();
  exitCode = failures > 0 ? 1 : 0;
} catch (error) {
  failures += 1;
  console.error(`FAIL  lan smoke crashed — ${error && error.message ? error.message : error}`);
  if (stderrTail) console.error(`[server stderr]\n${stderrTail}`);
  if (stdoutTail) console.error(`[server stdout]\n${stdoutTail}`);
  exitCode = 1;
} finally {
  await stopServer();
  console.log(`[lan-smoke] ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(exitCode);
}
