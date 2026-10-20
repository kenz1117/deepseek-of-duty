/**
 * Browser LAN client for deepseek-of-duty.
 *
 * The client is deliberately thin:
 * - It never simulates enemies or authoritative world state.
 * - `broadcastSnapshot()` / `broadcastEvent()` are only useful on the host.
 * - All callbacks and sends are wrapped so a network error or a throwing UI
 *   callback can never escape into the game loop.
 *
 * Typical host usage:
 *   const lan = createLanClient({ url, room, name, onLobby, onSnapshot, onEvent, onStatus });
 *   await lan.connect();
 *   // every 50 ms (20 Hz), while lan.isHost:
 *   lan.broadcastSnapshot({ tick, players, enemies, wave, kills, objective });
 *
 * Typical client usage:
 *   lan.sendInput({ seq, x, z, yaw, pitch, hp, alive });
 *   lan.sendFire({ seq, ox, oy, oz, dx, dy, dz, weapon });
 */

import {
  LAN_CLOSE_CODES,
  LAN_DEFAULT_URL,
  LAN_EVENT,
  LAN_FATAL_CLOSE_CODES,
  LAN_RECONNECT_DELAYS_MS,
  LAN_RECONNECT_TRIES,
  decodeMessage,
  encodeMessage,
  makeEvent,
  makeFire,
  makeInput,
  makeJoin,
  makeSnapshot,
  makeStart,
  normalizePlayers,
  sanitizeEventKind,
  sanitizeMode,
  sanitizeName,
  sanitizeRoom,
} from './lanProtocol.js';
import { createP2P } from './lanP2P.js';

const P2P_SIGNAL_KINDS = new Set(['p2p_offer', 'p2p_answer', 'p2p_ice']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildSocketUrl(rawUrl, room) {
  const fallback = LAN_DEFAULT_URL;
  let base = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : fallback;
  if (base.startsWith('http://')) base = `ws://${base.slice('http://'.length)}`;
  else if (base.startsWith('https://')) base = `wss://${base.slice('https://'.length)}`;

  try {
    const origin = typeof location !== 'undefined' && location.href
      ? location.href
      : 'http://127.0.0.1/';
    const url = new URL(base, origin);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return `${fallback}/?room=${encodeURIComponent(room)}`;
    }
    url.searchParams.set('room', room);
    return url.toString();
  } catch {
    return `${fallback}/?room=${encodeURIComponent(room)}`;
  }
}

/**
 * Create one LAN client instance.
 *
 * @param {object} options
 * @param {string} [options.url] WebSocket base URL, e.g. `ws://192.168.1.10:8790`.
 * @param {string} [options.room] Room code.
 * @param {string} [options.name] Callsign (sanitized, max 16 chars).
 * @param {'coop'|'br'} [options.mode] Room mode; defaults to `coop`.
 * @param {(players:Array)=>void} [options.onLobby]
 * @param {(snapshot:object)=>void} [options.onSnapshot]
 * @param {(message:object)=>void} [options.onEvent] Relayed messages:
 *   `{t:'event'}`, `{t:'start'}`, plus `{t:'input'}` / `{t:'fire'}` when the
 *   peer is the host.
 * @param {(status:object)=>void} [options.onStatus]
 */
export function createLanClient({
  url = LAN_DEFAULT_URL,
  room = 'lobby',
  name = 'OPERATOR',
  mode = 'coop',
  p2p = false,
  onLobby,
  onSnapshot,
  onEvent,
  onStatus,
} = {}) {
  const roomName = sanitizeRoom(room);
  const playerName = sanitizeName(name);
  const socketUrl = buildSocketUrl(url, roomName);
  let roomMode = sanitizeMode(mode);

  let socket = null;
  let manualClose = false;
  let joined = false;
  let selfId = null;
  let hostId = null;
  let players = [];
  let status = 'idle';
  let lastError = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let connectPromise = null;
  let connectResolve = null;
  let connectSettled = true;

  /* ---- direct transport (WebRTC), signaling over this WS relay ---------- */
  let p2pMgr = null;

  function p2pSendSignal(kind, to, payload) {
    // The relay routes events by role: host -> broadcast, client -> host.
    // That is exactly the signaling topology we need; `to` rides along so the
    // peer can match, and the receiving side filters by selfId.
    sendRaw(makeEvent(kind, { to, ...payload }));
  }

  function p2pEnsure() {
    if (!p2p) return null;
    if (!p2pMgr) {
      p2pMgr = createP2P({
        selfId: () => selfId,
        isHost: () => Boolean(selfId && hostId === selfId),
        sendSignal: p2pSendSignal,
        onPeerMessage: (fromId, message) => {
          // Game traffic arriving peer-to-peer feeds the same dispatch path
          // as relayed WS frames.
          dispatchMessage(message, fromId);
        },
      });
    }
    return p2pMgr;
  }

  /**
   * Route the 20 Hz bulk messages over the direct channel when possible.
   * Policy: use P2P only when EVERY relevant remote peer's channel is open —
   * otherwise fall back to the WS relay for the whole message so nobody is
   * left with a half-updated world. Lobby/events/host_change always stay on
   * the relay (they must survive even when peers have no direct path).
   */
  function p2pReady() {
    const mgr = p2pMgr;
    if (!mgr) return { any: false, all: true, ids: [] };
    const known = mgr.knownPeers();
    if (!known.length) return { any: false, all: true, ids: [] };
    const open = mgr.openPeers();
    return { any: open.length > 0, all: open.length >= known.length, ids: open };
  }

  function safeCall(callback, ...args) {
    if (typeof callback !== 'function') return;
    try {
      callback(...args);
    } catch {
      /* A UI callback must never tear down the network loop. */
    }
  }

  function emitStatus(state, extra = {}) {
    status = state;
    safeCall(onStatus, {
      state,
      room: roomName,
      mode: roomMode,
      id: selfId,
      host: hostId,
      attempt: reconnectAttempts,
      error: lastError,
      ...extra,
    });
  }

  function playerList() {
    return players.map((player) => ({ ...player }));
  }

  function settleConnect(result) {
    if (connectSettled) return;
    connectSettled = true;
    const resolve = connectResolve;
    connectResolve = null;
    if (resolve) resolve(result);
  }

  function hostFromPlayers() {
    const host = players.find((player) => player.host);
    return host ? host.id : null;
  }

  function handleMessage(raw) {
    const message = decodeMessage(raw);
    if (!message) return;
    dispatchMessage(message);
  }

  /** Shared dispatch for relayed WS frames and direct DataChannel messages. */
  function dispatchMessage(message) {
    switch (message.t) {
      case 'welcome': {
        if (typeof message.id === 'string' && message.id) selfId = message.id;
        if (typeof message.host === 'string' && message.host) hostId = message.host;
        if (typeof message.mode === 'string') roomMode = sanitizeMode(message.mode);
        players = normalizePlayers(message.players);
        joined = true;
        reconnectAttempts = 0;
        lastError = null;
        p2pOfferToPeers();
        emitStatus('joined');
        safeCall(onLobby, playerList());
        settleConnect({ ok: true, id: selfId, host: hostId });
        break;
      }
      case 'lobby': {
        if (typeof message.mode === 'string') roomMode = sanitizeMode(message.mode);
        players = normalizePlayers(message.players);
        const host = hostFromPlayers();
        if (host) hostId = host;
        p2pOfferToPeers();
        safeCall(onLobby, playerList());
        break;
      }
      case 'snapshot': {
        if (typeof message.mode === 'string') roomMode = sanitizeMode(message.mode);
        safeCall(onSnapshot, message);
        break;
      }
      case 'start': {
        if (typeof message.mode === 'string') roomMode = sanitizeMode(message.mode);
        safeCall(onEvent, message);
        break;
      }
      case 'input':
      case 'fire':
      case 'event': {
        // `onEvent` is the generic relayed-message channel. The host receives
        // client `input`/`fire` here; clients receive host `event`s and host
        // input/fire presentation messages here. Inspect `message.t`.
        if (message.t === 'event' && P2P_SIGNAL_KINDS.has(message.kind)) {
          // WebRTC signaling: consumed here, never forwarded to the game.
          const mgr = p2pEnsure();
          if (mgr) mgr.handleSignal(message.id, message.kind, message);
          return;
        }
        if (message.t === 'event' &&
            message.kind === LAN_EVENT.HOST_CHANGE &&
            typeof message.host === 'string') {
          hostId = message.host;
        }
        safeCall(onEvent, message);
        break;
      }
      default:
        break;
    }
  }

  /** Host only: offer a direct channel to every other lobby member. */
  function p2pOfferToPeers() {
    if (!p2p || !joined) return;
    const mgr = p2pEnsure();
    if (!mgr || selfId === null || selfId !== hostId) return;
    for (const player of players) {
      if (String(player.id) !== String(selfId)) mgr.ensurePeer(player.id);
    }
  }

  function sendRaw(message) {
    if (manualClose) return false;
    if (!socket || socket.readyState !== 1) return false;
    const text = encodeMessage(message);
    if (!text) return false;
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    if (manualClose) return;
    if (reconnectAttempts >= LAN_RECONNECT_TRIES) {
      lastError = lastError || 'reconnect_failed';
      emitStatus('error');
      settleConnect({ ok: false, error: lastError });
      return;
    }

    reconnectAttempts += 1;
    const delayIndex = Math.min(
      reconnectAttempts - 1,
      LAN_RECONNECT_DELAYS_MS.length - 1
    );
    const delay = LAN_RECONNECT_DELAYS_MS[delayIndex];
    emitStatus('reconnecting', { attempt: reconnectAttempts });
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket(true);
    }, delay);
  }

  function handleClose(code) {
    socket = null;
    joined = false;

    if (manualClose) {
      lastError = null;
      emitStatus('closed');
      settleConnect({ ok: false, error: 'closed' });
      return;
    }

    if (LAN_FATAL_CLOSE_CODES.has(code)) {
      if (code === LAN_CLOSE_CODES.ROOM_FULL) lastError = 'room_full';
      else if (code === LAN_CLOSE_CODES.MODE_MISMATCH) lastError = 'mode_mismatch';
      else if (code === LAN_CLOSE_CODES.RATE_LIMITED) lastError = 'rate_limited';
      else if (code === LAN_CLOSE_CODES.TOO_LARGE) lastError = 'message_too_large';
      else lastError = 'bad_message';
      emitStatus('error');
      settleConnect({ ok: false, error: lastError });
      return;
    }

    lastError = lastError || 'disconnected';
    scheduleReconnect();
  }

  function openSocket(isReconnect) {
    if (manualClose) return;

    const WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null;
    if (!WebSocketImpl) {
      lastError = 'no_websocket';
      emitStatus('error');
      settleConnect({ ok: false, error: lastError });
      return;
    }

    let ws;
    try {
      ws = new WebSocketImpl(socketUrl);
    } catch {
      lastError = 'network';
      scheduleReconnect();
      return;
    }
    socket = ws;
    if (!isReconnect) {
      emitStatus('connecting', { attempt: reconnectAttempts });
    }

    try {
      ws.onopen = () => {
        if (socket !== ws) return;
        emitStatus('open');
        sendRaw(makeJoin(roomName, playerName, roomMode));
      };
      ws.onmessage = (event) => {
        if (socket !== ws) return;
        handleMessage(event && event.data);
      };
      ws.onerror = () => {
        if (socket !== ws) return;
        lastError = 'network';
      };
      ws.onclose = (event) => {
        if (socket !== ws) return;
        const code = event && Number.isInteger(event.code) ? event.code : 1006;
        handleClose(code);
      };
    } catch {
      lastError = 'network';
      scheduleReconnect();
    }
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      return connectPromise || Promise.resolve({ ok: true, id: selfId, host: hostId });
    }
    if (connectPromise && !connectSettled) return connectPromise;

    manualClose = false;
    reconnectAttempts = 0;
    lastError = null;
    joined = false;
    connectSettled = false;
    connectPromise = new Promise((resolve) => {
      connectResolve = resolve;
    });
    openSocket(false);
    return connectPromise;
  }

  function close() {
    manualClose = true;
    if (p2pMgr) { try { p2pMgr.close(); } catch { /* ignore */ } }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    joined = false;
    lastError = null;
    if (ws) {
      try {
        ws.close(1000, 'client_close');
      } catch {
        /* ignore */
      }
    }
    emitStatus('closed');
    settleConnect({ ok: false, error: 'closed' });
  }

  function sendInput(input) {
    if (!joined) return false;
    try {
      const message = makeInput(input);
      if (p2p && hostId && selfId !== hostId && p2pMgr && p2pMgr.isOpen(hostId)) {
        return p2pMgr.send(hostId, message);
      }
      return sendRaw(message);
    } catch {
      return false;
    }
  }

  function sendFire(fire) {
    if (!joined) return false;
    try {
      const message = makeFire(fire);
      if (p2p && hostId && selfId !== hostId && p2pMgr && p2pMgr.isOpen(hostId)) {
        return p2pMgr.send(hostId, message);
      }
      return sendRaw(message);
    } catch {
      return false;
    }
  }

  function sendEvent(kind, data = null) {
    if (!joined) return false;
    try {
      if (isPlainObject(kind)) {
        return sendRaw(makeEvent(kind.kind, kind));
      }
      return sendRaw(makeEvent(sanitizeEventKind(kind), data));
    } catch {
      return false;
    }
  }

  function sendStart(startMode = roomMode) {
    if (!joined || !hostId || hostId !== selfId) return false;
    try {
      return sendRaw(makeStart(startMode));
    } catch {
      return false;
    }
  }

  function broadcastEvent(kind, data = null) {
    if (!joined || !hostId || hostId !== selfId) return false;
    try {
      if (isPlainObject(kind)) {
        return sendRaw(makeEvent(kind.kind, kind));
      }
      return sendRaw(makeEvent(sanitizeEventKind(kind), data));
    } catch {
      return false;
    }
  }

  function broadcastSnapshot(snapshot) {
    if (!joined || !hostId || hostId !== selfId) return false;
    try {
      const message = makeSnapshot(snapshot, roomMode);
      if (p2p) {
        const state = p2pReady();
        if (state.any && state.all) {
          // Every peer has a direct channel: skip the relay hop entirely.
          let sent = 0;
          for (const id of state.ids) {
            if (p2pMgr.send(id, message)) sent += 1;
          }
          return sent > 0;
        }
        // Mixed/partial: relay so nobody is left with a half-updated world.
      }
      return sendRaw(message);
    } catch {
      return false;
    }
  }

  return {
    connect,
    close,
    sendInput,
    sendFire,
    sendEvent,
    sendStart,
    broadcastSnapshot,
    broadcastEvent,
    get isHost() {
      return Boolean(joined && selfId && hostId && selfId === hostId);
    },
    get id() {
      return selfId;
    },
    get host() {
      return hostId;
    },
    get mode() {
      return roomMode;
    },
    get players() {
      return playerList();
    },
    get status() {
      return status;
    },
  };
}
