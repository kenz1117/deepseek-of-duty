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
 *
 * Run: `npm run lan` (listens on port 8790 by default, LAN_PORT overrides).
 * Clients open the Vite app with `?lan=ws://HOST:8790`.
 */

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  LAN_CLOSE_CODES,
  LAN_DEFAULT_PORT,
  LAN_EVENT,
  LAN_HEARTBEAT_MS,
  LAN_MAX_MESSAGE_BYTES,
  LAN_MAX_PLAYERS,
  LAN_RATE_BURST,
  LAN_RATE_LIMIT_PER_SEC,
  decodeMessage,
  encodeMessage,
  sanitizeName,
  sanitizeRoom,
} from '../src/net/lanProtocol.js';

const PORT = parsePort(process.env.LAN_PORT);
const HOST = '0.0.0.0'; // LAN co-op must be reachable from other devices.

/** room name -> { name, hostId, players:[Player] } */
const rooms = new Map();

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
  broadcast(room, { t: 'lobby', players: lobbyPlayers(room) });
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
  let room = rooms.get(roomName);
  if (!room) {
    room = { name: roomName, hostId: null, players: [] };
    rooms.set(roomName, room);
  }

  if (room.players.length >= LAN_MAX_PLAYERS) {
    sendAndClose(
      ws,
      {
        t: 'event',
        kind: LAN_EVENT.ERROR,
        code: 'room_full',
        message: `房间已满（最多 ${LAN_MAX_PLAYERS} 人）`,
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
    players: lobbyPlayers(room),
  });
  broadcastLobby(room);

  console.log(`[lan] ${player.name} (${player.id}) joined "${room.name}" (${room.players.length}/${LAN_MAX_PLAYERS})`);
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
      broadcast(ws.room, message, ws.player.id);
      break;
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

  console.log(`[lan] ${player.name} (${player.id}) left "${room.name}" (${room.players.length}/${LAN_MAX_PLAYERS})`);

  if (room.players.length === 0) {
    rooms.delete(room.name);
    return;
  }

  broadcast(room, { t: 'event', kind: LAN_EVENT.LEAVE, id: player.id }, player.id);

  if (room.hostId === player.id) {
    room.hostId = room.players[0].id;
    broadcastLobby(room);
    broadcast(room, { t: 'event', kind: LAN_EVENT.HOST_CHANGE, host: room.hostId });
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
  console.log(
    `[lan] rooms: max ${LAN_MAX_PLAYERS} players, 16 KB messages, ` +
    `${LAN_RATE_LIMIT_PER_SEC} messages/s, ${LAN_HEARTBEAT_MS / 1000}s heartbeat`
  );
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
