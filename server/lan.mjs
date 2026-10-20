#!/usr/bin/env node
/**
 * LAN co-op relay for deepseek-of-duty (Season 3, Track B).
 *
 * Architecture:
 * - Host-authoritative enemies/waves. The host client simulates the world and
 *   sends 20 Hz `snapshot` messages; the server relays them to the other
 *   players in the same room.
 * - Client movement is local and trusted (LAN co-op). Clients send `input` and
 *   `fire`; the server relays those to the host.
 * - The server is a JSON WebSocket relay only. It does not serve static files,
 *   simulate gameplay, validate hit geometry, persist state, or provide
 *   anti-cheat. A modified client can lie; this is a LAN trust model.
 * - Host migration: the relay keeps the latest snapshot per room (16 KB max)
 *   and hands it to the promoted host via `host_change.resume`, so the new
 *   host can rebuild the world instead of resetting it. Still relay-only —
 *   the snapshot is the host's own data, not server simulation.
 * - Discovery: prints its LAN addresses on boot and broadcasts a tiny UDP
 *   beacon (port LAN_BEACON_PORT, every 3 s) for native helpers. Browsers
 *   cannot receive UDP; the game page prefills `ws://<page-host>:8790` as the
 *   practical discovery path.
 *
 * Run: `npm run lan` (listens on port 8790 by default, LAN_PORT overrides).
 * Clients open the Vite app with `?lan=ws://HOST:8790`.
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import {
  LAN_BEACON_PORT,
  LAN_BR_MAX_PLAYERS,
  LAN_CLOSE_CODES,
  LAN_COOP_MAX_PLAYERS,
  LAN_DEFAULT_MODE,
  LAN_DEFAULT_PORT,
  LAN_EVENT,
  LAN_HEARTBEAT_MS,
  LAN_MAX_MESSAGE_BYTES,
  LAN_RATE_BURST,
  LAN_RATE_LIMIT_PER_SEC,
  decodeMessage,
  encodeMessage,
  roomCapacity,
  sanitizeMode,
  sanitizeName,
  sanitizeRoom,
} from '../src/net/lanProtocol.js';

const PORT = parsePort(process.env.LAN_PORT);
const HOST = '0.0.0.0'; // LAN co-op must be reachable from other devices.

/** room name -> { name, mode, hostId, players:[Player], lastSnapshot, started } */
const rooms = new Map();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      // Internal = loopback; IPv6 link-local is useless for game clients.
      if (ni.internal || ni.family !== 'IPv4') continue;
      if (/^169\.254\./.test(ni.address)) continue;
      out.push(ni.address);
    }
  }
  return out;
}

/** UDP discovery beacon for native helpers; browsers cannot receive this. */
function startBeacon(port) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => {
    try { sock.close(); } catch { /* already closed */ }
  });
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch { /* best effort */ }
    const payload = Buffer.from(JSON.stringify({ app: 'dod-lan', port }));
    const timer = setInterval(() => {
      try { sock.send(payload, LAN_BEACON_PORT, '255.255.255.255'); }
      catch { /* broadcast can fail on some networks; harmless */ }
    }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
  });
  if (typeof sock.unref === 'function') sock.unref();
}

function parsePort(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isInteger(value) && value >= 0 && value < 65536) return value;
  if (raw !== undefined && String(raw) !== '') {
    console.warn(`[lan] invalid LAN_PORT=${raw}, falling back to ${LAN_DEFAULT_PORT}`);
  }
  return LAN_DEFAULT_PORT;
}

function send(ws, message) {
  if (!ws || ws.readyState !== 1) return false;
  const text = encodeMessage(message);
  if (!text) return false;
  try {
    ws.send(text);
    return true;
  } catch {
    return false;
  }
}

function sendError(ws, code, message) {
  send(ws, { t: 'event', kind: LAN_EVENT.ERROR, code, message });
}

function sendAndClose(ws, message, code, reason) {
  const text = encodeMessage(message);
  if (text && ws.readyState === 1) {
    try {
      ws.send(text, () => {
        try {
          ws.close(code, reason);
        } catch {
          /* socket already gone */
        }
      });
      return;
    } catch {
      /* fall through to close */
    }
  }
  try {
    ws.close(code, reason);
  } catch {
    /* ignore */
  }
}

function broadcast(room, message, exceptId = null) {
  for (const player of room.players) {
    if (exceptId !== null && player.id === exceptId) continue;
    send(player.ws, message);
  }
}

function lobbyPlayers(room) {
  return room.players.map((player) => ({
    id: player.id,
    name: player.name,
    ready: player.ready === true,
    host: player.id === room.hostId,
  }));
}

function broadcastLobby(room) {
  broadcast(room, { t: 'lobby', mode: room.mode, players: lobbyPlayers(room) });
}

function findHost(room) {
  return room.players.find((player) => player.id === room.hostId) || null;
}

function newPlayerId(room) {
  let id;
  do {
    id = `p_${crypto.randomBytes(4).toString('hex')}`;
  } while (room.players.some((player) => player.id === id));
  return id;
}

function allowMessage(ws) {
  const now = Date.now();
  const elapsed = Math.max(0, (now - ws.rateAt) / 1000);
  ws.rateTokens = Math.min(
    LAN_RATE_BURST,
    ws.rateTokens + elapsed * LAN_RATE_LIMIT_PER_SEC
  );
  ws.rateAt = now;
  if (ws.rateTokens < 1) return false;
  ws.rateTokens -= 1;
  return true;
}

function relayToHost(room, player, message) {
  const host = findHost(room);
  if (!host || host.id === player.id) return;
  send(host.ws, { ...message, id: player.id });
}

function relayFromHost(room, player, message) {
  if (player.id !== room.hostId) return;
  broadcast(room, message, player.id);
}

function handleJoin(ws, message) {
  if (ws.joined) {
    sendError(ws, 'already_joined', '该连接已经加入房间');
    return;
  }

  const roomName = sanitizeRoom(ws.queryRoom || message.room);
  const requestedMode = message.mode === undefined || message.mode === null
    ? null
    : sanitizeMode(message.mode);

  let room = rooms.get(roomName);
  if (!room) {
    room = {
      name: roomName,
      mode: requestedMode || LAN_DEFAULT_MODE,
      hostId: null,
      players: [],
      lastSnapshot: null,
      started: false,
    };
    rooms.set(roomName, room);
  } else if (requestedMode && requestedMode !== room.mode) {
    sendAndClose(
      ws,
      {
        t: 'event',
        kind: LAN_EVENT.ERROR,
        code: 'mode_mismatch',
        message: `房间 "${room.name}" 是 ${room.mode}，不能用 ${requestedMode} 加入`,
      },
      LAN_CLOSE_CODES.MODE_MISMATCH,
      'mode_mismatch'
    );
    return;
  }

  const capacity = roomCapacity(room.mode);
  if (room.players.length >= capacity) {
    sendAndClose(
      ws,
      {
        t: 'event',
        kind: LAN_EVENT.ERROR,
        code: 'room_full',
        message: `房间已满（${room.mode} 最多 ${capacity} 人）`,
      },
      LAN_CLOSE_CODES.ROOM_FULL,
      'room_full'
    );
    return;
  }

  const player = {
    id: newPlayerId(room),
    name: sanitizeName(message.name),
    ready: false,
    ws,
    joinedAt: Date.now(),
  };

  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;

  ws.joined = true;
  ws.player = player;
  ws.room = room;

  send(ws, {
    t: 'welcome',
    id: player.id,
    host: room.hostId,
    room: room.name,
    mode: room.mode,
    players: lobbyPlayers(room),
  });
  broadcastLobby(room);

  console.log(
    `[lan] ${player.name} (${player.id}) joined "${room.name}" ` +
    `[${room.mode}] (${room.players.length}/${capacity})`
  );
}

function handleEvent(ws, message) {
  const { room, player } = ws;
  if (!room || !player) return;

  if (message.kind === LAN_EVENT.READY) {
    player.ready = message.ready === true;
    broadcastLobby(room);
  }

  const relayed = {
    ...message,
    t: 'event',
    kind: typeof message.kind === 'string' ? message.kind : 'event',
    id: player.id,
  };

  // The host's events are authoritative and go to every client. A client's
  // events are requests/notifications for the host only.
  if (player.id === room.hostId) {
    broadcast(room, relayed, player.id);
  } else {
    relayToHost(room, player, relayed);
  }
}

function handleFrame(ws, data) {
  if (!allowMessage(ws)) {
    sendAndClose(
      ws,
      {
        t: 'event',
        kind: LAN_EVENT.ERROR,
        code: 'rate_limited',
        message: `消息频率超过 ${LAN_RATE_LIMIT_PER_SEC}/s`,
      },
      LAN_CLOSE_CODES.RATE_LIMITED,
      'rate_limited'
    );
    return;
  }

  const message = decodeMessage(data);
  if (!message) {
    sendError(ws, 'bad_message', '消息不是合法 JSON 协议帧');
    return;
  }

  if (message.t === 'join') {
    handleJoin(ws, message);
    return;
  }

  if (!ws.joined || !ws.room || !ws.player) {
    sendError(ws, 'not_joined', '请先发送 join 加入房间');
    return;
  }

  switch (message.t) {
    case 'input':
    case 'fire': {
      const relayed = { ...message, id: ws.player.id };
      if (ws.player.id === ws.room.hostId) {
        // Host movement/fire is useful for client-side presentation; clients
        // still get the authoritative player state via snapshots.
        relayFromHost(ws.room, ws.player, relayed);
      } else {
        relayToHost(ws.room, ws.player, relayed);
      }
      break;
    }
    case 'event':
      handleEvent(ws, message);
      break;
    case 'snapshot':
      if (ws.player.id !== ws.room.hostId) {
        sendError(ws, 'not_host', '只有 host 能广播 snapshot');
        return;
      }
      {
        // Relay-only: keep the host's `br` zone/player data untouched and
        // canonicalize the room mode so clients always see a consistent mode.
        const snapshot = { ...message, mode: ws.room.mode };
        // Cache for host migration: when this host leaves, the promoted host
        // receives this snapshot back via `host_change.resume` and rebuilds.
        ws.room.lastSnapshot = snapshot;
        broadcast(ws.room, snapshot, ws.player.id);
      }
      break;
    case 'start': {
      if (ws.player.id !== ws.room.hostId) {
        sendError(ws, 'not_host', '只有 host 能开始对局');
        return;
      }
      const requestedMode = message.mode === undefined || message.mode === null
        ? ws.room.mode
        : sanitizeMode(message.mode);
      if (requestedMode !== ws.room.mode) {
        sendError(
          ws,
          'mode_mismatch',
          `房间是 ${ws.room.mode}，不能用 ${requestedMode} 开始`
        );
        return;
      }
      ws.room.started = true;
      broadcast(ws.room, { t: 'start', mode: ws.room.mode });
      break;
    }
    default:
      sendError(ws, 'unknown_type', `未知消息类型: ${String(message.t).slice(0, 32)}`);
      break;
  }
}

function handleLeave(ws) {
  const room = ws.room;
  const player = ws.player;
  if (!room || !player) return;

  ws.room = null;
  ws.player = null;
  ws.joined = false;

  const index = room.players.findIndex((candidate) => candidate.id === player.id);
  if (index < 0) return;
  room.players.splice(index, 1);

  console.log(
    `[lan] ${player.name} (${player.id}) left "${room.name}" ` +
    `[${room.mode}] (${room.players.length}/${roomCapacity(room.mode)})`
  );

  if (room.players.length === 0) {
    rooms.delete(room.name);
    return;
  }

  broadcast(room, { t: 'event', kind: LAN_EVENT.LEAVE, id: player.id }, player.id);

  if (room.hostId === player.id) {
    room.hostId = room.players[0].id;
    // Hand the world to the promoted host: last authoritative snapshot, or
    // null when the host left before the first snapshot (pre-game lobby).
    broadcastLobby(room);
    broadcast(room, {
      t: 'event',
      kind: LAN_EVENT.HOST_CHANGE,
      host: room.hostId,
      resume: room.lastSnapshot || null,
    });
  } else {
    broadcastLobby(room);
  }
}

const wss = new WebSocketServer({
  port: PORT,
  host: HOST,
  maxPayload: LAN_MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
});

wss.on('listening', () => {
  const address = wss.address();
  const actualPort = address && typeof address === 'object' ? address.port : PORT;
  console.log(`[lan] listening on ws://${HOST}:${actualPort}`);
  for (const ip of lanAddresses()) {
    console.log(`[lan] LAN address: ws://${ip}:${actualPort}`);
  }
  console.log(
    `[lan] rooms: coop max ${LAN_COOP_MAX_PLAYERS} / br max ${LAN_BR_MAX_PLAYERS}, ` +
    `16 KB messages, ${LAN_RATE_LIMIT_PER_SEC} messages/s, ` +
    `${LAN_HEARTBEAT_MS / 1000}s heartbeat, UDP beacon :${LAN_BEACON_PORT}`
  );
  startBeacon(actualPort);
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.rateTokens = LAN_RATE_BURST;
  ws.rateAt = Date.now();
  ws.joined = false;
  ws.player = null;
  ws.room = null;

  let queryRoom = null;
  try {
    const url = new URL(req.url || '/', 'ws://localhost');
    queryRoom = url.searchParams.get('room');
  } catch {
    queryRoom = null;
  }
  ws.queryRoom = queryRoom ? sanitizeRoom(queryRoom) : null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      handleFrame(ws, data);
    } catch (error) {
      // A bad frame must never take the relay down.
      console.error(`[lan] frame handler error: ${error && error.message ? error.message : error}`);
      sendError(ws, 'internal', '服务端处理消息失败');
    }
  });

  ws.on('close', () => {
    try {
      handleLeave(ws);
    } catch (error) {
      console.error(`[lan] leave handler error: ${error && error.message ? error.message : error}`);
    }
  });

  ws.on('error', () => {
    // `close` will clean up. Avoid logging per-socket noise.
  });
});

wss.on('error', (error) => {
  console.error(`[lan] server error: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, LAN_HEARTBEAT_MS);
if (typeof heartbeat.unref === 'function') heartbeat.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lan] received ${signal}, closing rooms`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close(LAN_CLOSE_CODES.SERVER_SHUTDOWN, 'server_shutdown');
    } catch {
      /* ignore */
    }
  }
  const finish = () => process.exit(0);
  wss.close(finish);
  setTimeout(finish, 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
