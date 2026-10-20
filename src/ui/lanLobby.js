/* =========================================================================
   LAN CO-OP lobby overlay.

   Pure UI: no websocket code here. The host/join callbacks are wired by the
   net layer, while setStatus()/setPlayers() are called from LAN client events.

     const lobby = createLanLobby({ onHost, onJoin, onStart, onLeave });
     lobby.open(); lobby.close();
     lobby.setStatus('connected', '房间已创建');
     lobby.setPlayers([{ id, name, ready, host, self }]);
     lobby.isOpen
   ========================================================================= */

const $ = (id) => document.getElementById(id);
/* Single source of truth for the lobby slot count. Importing the protocol
   constant keeps the UI honest when LAN_MAX_PLAYERS changes; the previous
   hard-coded 4 let the server accept more players than the lobby could show. */
import { LAN_MAX_PLAYERS } from '../net/lanProtocol.js';

const KNOWN_STATES = new Set(['idle', 'connecting', 'connected', 'hosting', 'joined', 'error', 'closed']);
const STATE_KIND = {
  idle: 'idle', closed: 'idle', standby: 'idle',
  connecting: 'busy', connecting: 'busy',
  connected: 'ok', hosting: 'ok', joined: 'ok',
  error: 'error',
};

const STORE = {
  server: 'dod.lan.server.v1',
  room: 'dod.lan.room.v1',
  p2p: 'dod.lan.p2p.v1',
  versus: 'dod.lan.versus.v1',
};

function readStore(key, fallback = '') {
  try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
}
function writeStore(key, value) {
  try { if (value) localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

function defaultLanServer() {
  if (location.protocol === 'https:') return `wss://${location.host}/lan`;
  return `ws://${location.hostname || 'localhost'}:8790`;
}

function randomRoom() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  try {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    for (const n of buf) out += alphabet[n % alphabet.length];
  } catch (e) {
    for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out || 'ALPHA';
}

function menuCallsign() {
  const el = $('menu-callsign');
  const fromMenu = el ? String(el.textContent || '').trim() : '';
  if (fromMenu && fromMenu !== 'OPERATOR-0000') return fromMenu;
  const saved = readStore('dod.callsign.v1', '');
  return saved || fromMenu || 'OPERATOR-0000';
}

export function createLanLobby({ onHost, onJoin, onStart, onLeave } = {}) {
  const root = $('lan-lobby');
  const panel = root ? root.querySelector('.ll-panel') : null;
  const serverEl = $('lan-server');
  const roomEl = $('lan-room');
  const nameEl = $('lan-name');
  const hostBtn = $('lan-host');
  const joinBtn = $('lan-join');
  const startBtn = $('lan-start');
  const leaveBtn = $('lan-leave');
  const closeBtn = $('lan-close');
  const listEl = $('lan-player-list');
  const countEl = $('lan-count');
  const statusEl = $('lan-status');
  const statusTextEl = $('lan-status-text');
  const youEl = $('lan-you');
  const entry = $('lan-coop-open');
  const versusEntry = $('lan-versus-open');

  let isOpen = false;
  let localHost = false;
  let role = null;
  let lastFocus = null;
  let players = [];
  let keyHandler = null;

  /* Discovery, browser edition: we cannot receive UDP/mDNS beacons from a
     page, but when the game itself is served over the LAN the relay almost
     always lives on the same host. Prefill `ws://<page-host>:8790` unless a
     saved address exists, so players only need the room code. */
  try {
    if (serverEl && !serverEl.value && !readStore(STORE.server)) {
      const h = (typeof location !== 'undefined' && location.hostname) || '';
      if (h && h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('.local')) {
        serverEl.value = `ws://${h}:8790`;
      }
    }
  } catch (e) { /* storage disabled — leave the field empty */ }

  const api = {
    open,
    close,
    setStatus,
    setPlayers,
    setHost,
    get isOpen() { return isOpen; },
    get opened() { return isOpen; },
    getOpen() { return isOpen; },
  };

  if (!root || !panel) return api;

  function payload() {
    const server = normalizeServer(serverEl ? serverEl.value : '');
    const room = normalizeRoom(roomEl ? roomEl.value : '');
    const name = normalizeName(nameEl ? nameEl.value : '');
    const p2pEl = $('lan-p2p');
    const p2p = p2pEl ? p2pEl.checked : false;
    try { localStorage.setItem(STORE.p2p, p2p ? '1' : '0'); } catch (e) { /* ignore */ }
    const versusEl = $('lan-versus');
    const versus = versusEl ? versusEl.checked : false;
    try { localStorage.setItem(STORE.versus, versus ? '1' : '0'); } catch (e) { /* ignore */ }
    return { server, url: server, room, name, callsign: name, p2p, versus };
  }

  function normalizeServer(value) {
    let v = String(value || '').trim();
    if (!v) return '';
    if (!/^wss?:\/\//i.test(v)) v = `ws://${v}`;
    // HTTPS pages cannot open ws:// (mixed content). The hosted relay is
    // published at /lan on the same origin, so migrate the common
    // ws://<page-host>:8790 default to wss://<page-host>/lan automatically.
    if (location.protocol === 'https:') {
      try {
        const u = new URL(v);
        if (u.protocol === 'ws:' && u.hostname === location.hostname) {
          return `wss://${location.host}/lan`;
        }
      } catch (e) { /* let the connection attempt report it */ }
    }
    return v;
  }
  function normalizeRoom(value) {
    return String(value || '').trim().toUpperCase().slice(0, 8);
  }
  function normalizeName(value) {
    return String(value || '').trim().slice(0, 12);
  }

  function syncYou() {
    const self = players.find((p) => p && p.self);
    const name = self && self.name ? self.name : normalizeName(nameEl ? nameEl.value : '');
    if (youEl) youEl.textContent = name || 'OPERATOR-0000';
  }

  function setFieldError(field) {
    if (!field) return;
    field.classList.add('is-error');
    field.focus();
    setTimeout(() => field.classList.remove('is-error'), 1200);
  }

  function validate() {
    const data = payload();
    if (!data.server) {
      setStatus('error', 'ERROR · 请填写服务器地址');
      setFieldError(serverEl);
      return null;
    }
    if (location.protocol === 'https:' && /^ws:\/\//i.test(data.server)) {
      setStatus('error', 'ERROR · HTTPS 页面不能连 ws://；纯局域网请用 http://<房主IP>:5173 打开，或填 wss:// 地址');
      setFieldError(serverEl);
      return null;
    }
    if (!data.room) {
      setStatus('error', 'ERROR · 请填写房间码');
      setFieldError(roomEl);
      return null;
    }
    if (!data.name) {
      setStatus('error', 'ERROR · 请填写呼号');
      setFieldError(nameEl);
      return null;
    }
    if (serverEl) serverEl.value = data.server;
    if (roomEl) roomEl.value = data.room;
    if (nameEl) nameEl.value = data.name;
    writeStore(STORE.server, data.server);
    writeStore(STORE.room, data.room);
    return data;
  }

  function updateStart() {
    if (!startBtn) return;
    const busy = root.classList.contains('is-busy');
    startBtn.disabled = !localHost || busy;
    startBtn.title = !localHost ? '仅房主可以开始行动' : (busy ? '正在连接…' : '开始行动');
    startBtn.setAttribute('aria-disabled', startBtn.disabled ? 'true' : 'false');
  }

  function setBusy(on) {
    root.classList.toggle('is-busy', !!on);
    root.setAttribute('aria-busy', on ? 'true' : 'false');
    updateStart();
  }

  function setStatus(state = 'idle', message = '') {
    let kind = state;
    let text = message;
    if (!KNOWN_STATES.has(String(state)) && message === '') {
      kind = 'idle';
      text = String(state || '');
    }
    kind = String(kind || 'idle').toLowerCase();
    const cls = STATE_KIND[kind] || 'idle';
    if (statusEl) statusEl.dataset.state = cls;
    if (statusTextEl) statusTextEl.textContent = text || defaultStatus(kind);
    setBusy(cls === 'busy');
  }

  function defaultStatus(state) {
    if (state === 'connecting') return 'CONNECTING · 正在连接 LAN 服务器…';
    if (state === 'connected' || state === 'hosting' || state === 'joined') return 'CONNECTED · 等待玩家';
    if (state === 'error') return 'ERROR · 连接失败';
    return 'STANDBY · 输入地址后 HOST 或 JOIN';
  }

  function setHost(on, mark = true) {
    localHost = !!on;
    if (mark) role = localHost ? 'host' : 'join';
    root.classList.toggle('is-host', localHost);
    if (hostBtn) { hostBtn.classList.toggle('is-active', role === 'host'); hostBtn.setAttribute('aria-pressed', role === 'host' ? 'true' : 'false'); }
    if (joinBtn) { joinBtn.classList.toggle('is-active', role === 'join'); joinBtn.setAttribute('aria-pressed', role === 'join' ? 'true' : 'false'); }
    updateStart();
  }

  function playerRow(player, index) {
    const li = document.createElement('li');
    li.className = 'll-player';
    const slot = document.createElement('span');
    slot.className = 'll-slot';
    slot.textContent = String(index + 1).padStart(2, '0');
    li.appendChild(slot);

    const who = document.createElement('span');
    who.className = 'll-who';
    const name = document.createElement('b');
    const meta = document.createElement('em');
    if (!player) {
      li.classList.add('is-empty');
      name.textContent = 'OPEN SLOT';
      meta.textContent = '等待玩家';
      who.append(name, meta);
      li.appendChild(who);
      const empty = document.createElement('span');
      empty.className = 'll-state ll-state-empty';
      empty.textContent = '—';
      li.appendChild(empty);
      return li;
    }

    if (player.host) li.classList.add('is-host');
    if (player.ready) li.classList.add('is-ready');
    if (player.self) li.classList.add('is-you');
    name.textContent = player.name || 'OPERATOR';
    const bits = [];
    if (player.self) bits.push('YOU');
    if (player.host) bits.push('HOST');
    meta.textContent = bits.join(' · ') || 'SQUAD';
    who.append(name, meta);
    li.appendChild(who);

    const state = document.createElement('span');
    state.className = 'll-state';
    if (player.host) {
      const hostTag = document.createElement('span');
      hostTag.className = 'll-host-tag';
      hostTag.textContent = 'HOST';
      state.appendChild(hostTag);
    }
    const ready = document.createElement('span');
    ready.className = 'll-ready';
    ready.textContent = player.ready ? 'READY' : 'WAIT';
    state.appendChild(ready);
    li.appendChild(state);
    return li;
  }

  function capacity() {
    const ve = $('lan-versus');
    return (ve && ve.checked) ? 8 : 4;
  }

  function setPlayers(next, opts = {}) {
    let list = next;
    let options = opts || {};
    if (list && !Array.isArray(list) && Array.isArray(list.players)) {
      options = { ...list, ...(opts || {}) };
      list = list.players;
    }
    if (!Array.isArray(list)) list = [];
    players = list.slice(0, capacity()).map((p) => ({ ...p }));
    if (options.selfId != null) {
      for (const p of players) if (String(p.id) === String(options.selfId)) p.self = true;
    }
    if (options.isHost !== undefined) setHost(options.isHost);
    if (countEl) countEl.textContent = `${players.length}/${capacity()}`;
    if (listEl) {
      listEl.textContent = '';
      for (let i = 0; i < capacity(); i++) listEl.appendChild(playerRow(players[i], i));
    }
    syncYou();
  }

  function open() {
    if (isOpen) return api;
    isOpen = true;
    lastFocus = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : entry;
    if (serverEl && !serverEl.value) {
      const fromUrl = (() => {
        try { return new URLSearchParams(location.search).get('lan') || ''; } catch (e) { return ''; }
      })();
      serverEl.value = normalizeServer(readStore(STORE.server, fromUrl || defaultLanServer()));
    }
    if (roomEl && !roomEl.value) {
      const fromUrl = (() => {
        try { return new URLSearchParams(location.search).get('room') || ''; } catch (e) { return ''; }
      })();
      roomEl.value = readStore(STORE.room, fromUrl || randomRoom()).toUpperCase();
    }
    if (nameEl) nameEl.value = menuCallsign();
    const p2pEl = $('lan-p2p');
    if (p2pEl && !p2pEl.dataset.restored) {
      p2pEl.dataset.restored = '1';
      p2pEl.checked = readStore(STORE.p2p, '1') !== '0'; // default ON
    }
    const versusEl = $('lan-versus');
    if (versusEl && !versusEl.dataset.restored) {
      versusEl.dataset.restored = '1';
      versusEl.checked = readStore(STORE.versus, '0') === '1'; // default OFF
      versusEl.addEventListener('change', () => { setPlayers(players); });
    }
    syncYou();
    if (!players.length) setPlayers([]);
    setHost(localHost, false);
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    keyHandler = onKeyDown;
    document.addEventListener('keydown', keyHandler, true);
    requestAnimationFrame(() => {
      if (serverEl) { serverEl.focus(); serverEl.select(); }
    });
    return api;
  }

  function close() {
    if (!isOpen) return api;
    isOpen = false;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    root.classList.remove('is-busy');
    root.setAttribute('aria-busy', 'false');
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
    return api;
  }

  function focusables() {
    return Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
      .filter((el) => el.offsetParent !== null);
  }

  function onKeyDown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      leave();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function leave() {
    const data = payload();
    try { if (typeof onLeave === 'function') onLeave(data); }
    catch (err) { console.error('[lanLobby] onLeave failed', err); }
    setPlayers([]);
    setHost(false);
    setStatus('idle', defaultStatus('idle'));
    close();
  }

  function host() {
    const data = validate();
    if (!data) return;
    setHost(true);
    setStatus('connecting', 'HOSTING · 正在创建房间…');
    try {
      const result = typeof onHost === 'function' ? onHost(data) : null;
      if (result && typeof result.catch === 'function') {
        result.catch((err) => setStatus('error', `ERROR · ${err && err.message ? err.message : '创建失败'}`));
      }
    } catch (err) {
      setStatus('error', `ERROR · ${err && err.message ? err.message : '创建失败'}`);
    }
  }

  function join() {
    const data = validate();
    if (!data) return;
    setHost(false);
    setStatus('connecting', 'JOINING · 正在加入房间…');
    try {
      const result = typeof onJoin === 'function' ? onJoin(data) : null;
      if (result && typeof result.catch === 'function') {
        result.catch((err) => setStatus('error', `ERROR · ${err && err.message ? err.message : '加入失败'}`));
      }
    } catch (err) {
      setStatus('error', `ERROR · ${err && err.message ? err.message : '加入失败'}`);
    }
  }

  function start() {
    if (!localHost) {
      setStatus('error', 'ERROR · 只有房主可以开始行动');
      return;
    }
    const data = payload();
    try {
      if (typeof onStart === 'function') onStart({ ...data, players });
    } catch (err) {
      setStatus('error', `ERROR · ${err && err.message ? err.message : '无法开始'}`);
    }
  }

  if (hostBtn) hostBtn.addEventListener('click', host);
  if (joinBtn) joinBtn.addEventListener('click', join);
  if (startBtn) startBtn.addEventListener('click', start);
  if (leaveBtn) leaveBtn.addEventListener('click', leave);
  if (closeBtn) closeBtn.addEventListener('click', leave);
  root.addEventListener('click', (e) => {
    if (e.target === root) leave();
  });
  if (roomEl) {
    roomEl.addEventListener('input', () => { roomEl.value = normalizeRoom(roomEl.value); });
    roomEl.addEventListener('blur', () => { writeStore(STORE.room, normalizeRoom(roomEl.value)); });
    roomEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); host(); } });
  }
  if (serverEl) {
    serverEl.addEventListener('change', () => { writeStore(STORE.server, normalizeServer(serverEl.value)); });
    serverEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); host(); } });
  }
  if (nameEl) {
    nameEl.addEventListener('input', () => { syncYou(); });
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); host(); } });
  }
  if (versusEntry && !versusEntry.dataset.lanBound) {
    versusEntry.dataset.lanBound = '1';
    versusEntry.addEventListener('click', () => {
      const ve = $('lan-versus');
      if (ve) ve.checked = true;
      try { localStorage.setItem(STORE.versus, '1'); } catch (e) { /* ignore */ }
      open();
    });
  }
  if (entry && !entry.dataset.lanBound) {
    entry.dataset.lanBound = '1';
    entry.addEventListener('click', open);
  }

  setPlayers([]);
  setHost(false, false);
  setStatus('idle', defaultStatus('idle'));
  return api;
}

export default createLanLobby;
