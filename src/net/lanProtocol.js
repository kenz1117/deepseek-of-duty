/**
 * Shared LAN protocol helpers for deepseek-of-duty.
 *
 * This module is intentionally dependency-free and safe to import from both
 * the browser client and the Node WebSocket server. It only contains plain
 * data helpers; it never touches the DOM and never throws for bad input.
 *
 * Message schema (JSON over WebSocket):
 *   c->s join     { t:'join', room, name }
 *   c->s input    { t:'input', seq, x, z, yaw, pitch, hp, alive }
 *   c->s fire     { t:'fire', seq, ox, oy, oz, dx, dy, dz, weapon }
 *   c->s event    { t:'event', kind, ... }
 *   s->c welcome  { t:'welcome', id, host, room, players }
 *   s->c lobby    { t:'lobby', players:[{id,name,ready,host}] }
 *   s->c snapshot { t:'snapshot', tick, players, enemies, wave, kills, objective }
 *   s->c event    { t:'event', kind, ... }
 *
 * The server stamps relayed input/fire/event messages with the sender's `id`.
 */

export const LAN_PROTOCOL_VERSION = 1;
export const LAN_DEFAULT_PORT = 8790;
export const LAN_DEFAULT_URL = `ws://127.0.0.1:${LAN_DEFAULT_PORT}`;
export const LAN_MAX_PLAYERS = 4;
export const LAN_SNAPSHOT_HZ = 20;
export const LAN_TICK_MS = 1000 / LAN_SNAPSHOT_HZ;
export const LAN_MAX_MESSAGE_BYTES = 16 * 1024;
export const LAN_RATE_LIMIT_PER_SEC = 60;
export const LAN_RATE_BURST = 60;
export const LAN_HEARTBEAT_MS = 20_000;
export const LAN_RECONNECT_TRIES = 3;
export const LAN_RECONNECT_DELAYS_MS = [1000, 2000, 4000];

export const LAN_CLOSE_CODES = Object.freeze({
  BAD_MESSAGE: 4000,
  ROOM_FULL: 4004,
  RATE_LIMITED: 4029,
  SERVER_SHUTDOWN: 1001,
  TOO_LARGE: 1009,
});

/** Close codes that must not trigger an automatic reconnect. */
export const LAN_FATAL_CLOSE_CODES = new Set([
  LAN_CLOSE_CODES.BAD_MESSAGE,
  LAN_CLOSE_CODES.ROOM_FULL,
  LAN_CLOSE_CODES.RATE_LIMITED,
  LAN_CLOSE_CODES.TOO_LARGE,
]);

export const LAN_EVENT = Object.freeze({
  ERROR: 'error',
  READY: 'ready',
  HOST_CHANGE: 'host_change',
  LEAVE: 'leave',
});

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029]/g;
const NAME_STRIP_RE = /[<>{}[\]\\"'`]/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * Remove control/injection characters, collapse whitespace, trim and cap at
 * 16 code points. Empty names become OPERATOR.
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'OPERATOR';
  let value = raw
    .replace(CONTROL_RE, '')
    .replace(NAME_STRIP_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(value);
  if (chars.length > 16) value = chars.slice(0, 16).join('').trim();
  return value.length > 0 ? value : 'OPERATOR';
}

/** Room codes are short, URL-friendly and case-sensitive. */
export function sanitizeRoom(raw) {
  if (typeof raw !== 'string') return 'lobby';
  const value = raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return value.length > 0 ? value : 'lobby';
}

export function sanitizeEventKind(raw) {
  if (typeof raw !== 'string') return 'event';
  const value = raw.trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 32);
  return value.length > 0 ? value : 'event';
}

/**
 * Parse one WebSocket text/binary frame. Returns a message object with a
 * non-empty string `t`, or null for anything malformed.
 */
export function decodeMessage(data) {
  let text = null;
  try {
    if (typeof data === 'string') {
      text = data;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      text = data.toString('utf8');
    } else if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data);
    }
  } catch {
    return null;
  }

  if (typeof text !== 'string' || text.length === 0 || text.length > LAN_MAX_MESSAGE_BYTES) {
    return null;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isPlainObject(value) || typeof value.t !== 'string' || value.t.length === 0) {
    return null;
  }
  return value;
}

/**
 * Serialize one message, refusing anything over the 16 KB cap. Returns null for
 * circular/unserializable values or oversized payloads.
 */
export function encodeMessage(message) {
  if (!isPlainObject(message)) return null;
  let text;
  try {
    text = JSON.stringify(message);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > LAN_MAX_MESSAGE_BYTES) {
    return null;
  }
  return text;
}

export function makeJoin(room, name) {
  return { t: 'join', room: sanitizeRoom(room), name: sanitizeName(name) };
}

export function makeInput(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    t: 'input',
    seq: toInteger(source.seq, 0),
    x: toFiniteNumber(source.x, 0),
    z: toFiniteNumber(source.z, 0),
    yaw: toFiniteNumber(source.yaw, 0),
    pitch: toFiniteNumber(source.pitch, 0),
    hp: toFiniteNumber(source.hp, 100),
    alive: source.alive !== false,
  };
}

export function makeFire(fire) {
  const source = isPlainObject(fire) ? fire : {};
  return {
    t: 'fire',
    seq: toInteger(source.seq, 0),
    ox: toFiniteNumber(source.ox, 0),
    oy: toFiniteNumber(source.oy, 0),
    oz: toFiniteNumber(source.oz, 0),
    dx: toFiniteNumber(source.dx, 0),
    dy: toFiniteNumber(source.dy, 0),
    dz: toFiniteNumber(source.dz, 0),
    weapon: typeof source.weapon === 'string' ? source.weapon.slice(0, 32) : 'unknown',
  };
}

export function makeEvent(kind, data) {
  const payload = isPlainObject(data) ? data : {};
  return { ...payload, t: 'event', kind: sanitizeEventKind(kind) };
}

export function makeSnapshot(snapshot) {
  const payload = isPlainObject(snapshot) ? snapshot : {};
  return { ...payload, t: 'snapshot' };
}

/** Normalize a welcome/lobby player list; invalid records are dropped. */
export function normalizePlayers(rawList) {
  if (!Array.isArray(rawList)) return [];
  const players = [];
  for (const raw of rawList) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : '';
    if (!id) continue;
    players.push({
      id,
      name: sanitizeName(raw.name),
      ready: raw.ready === true,
      host: raw.host === true,
    });
  }
  return players;
}

/** True when a decoded message type is one of the protocol messages. */
export function isLanMessageType(type) {
  return type === 'join' || type === 'input' || type === 'fire' ||
    type === 'event' || type === 'welcome' || type === 'lobby' ||
    type === 'snapshot';
}
