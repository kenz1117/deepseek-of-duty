/**
 * Direct (P2P) transport for LAN co-op, browser edition.
 *
 * Browsers cannot open raw UDP/TCP sockets, so "pure LAN" here means WebRTC
 * DataChannel between host and clients. Signaling (offer/answer/ICE) still
 * travels over the existing WS relay (a few KB per connection, once); after
 * that the 20 Hz game traffic (snapshot / input / fire) flows peer-to-peer and
 * skips the relay hop entirely — that hop is the added latency in relay mode.
 *
 * Honest limits:
 * - ICE uses host candidates only (no STUN/TURN servers). This works on the
 *   same LAN; across the internet it will usually fail and callers must fall
 *   back to the WS relay (lanClient routes per-peer automatically).
 * - Everything is JSON over one reliable ordered channel per peer. Message
 *   budget stays within LAN_MAX_MESSAGE_BYTES (16 KB), same as the relay.
 */

import { LAN_MAX_MESSAGE_BYTES } from './lanProtocol.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** One peer connection + its data channel, with ICE candidate buffering. */
function createPeer(remoteId) {
  const peer = {
    id: remoteId,
    pc: null,
    dc: null,
    open: false,
    pendingIce: [],
    hasRemoteDesc: false,
  };
  return { peer };
}

/**
 * @param {object} opts
 * @param {string} opts.selfId
 * @param {boolean} opts.isHost True when this endpoint is the room host.
 * @param {(kind:string, to:string|null, payload:object)=>void} opts.sendSignal
 *   Deliver a signaling message. The caller forwards it over the WS relay
 *   (host -> broadcast, client -> host only — the relay already routes it).
 * @param {(fromId:string, message:object)=>void} opts.onPeerMessage
 * @param {(peerId:string, open:boolean)=>void} [opts.onPeerState]
 */
export function createP2P({ selfId, isHost, sendSignal, onPeerMessage, onPeerState } = {}) {
  // Accept plain values or getters: host identity can change mid-session
  // (host migration promotes a client), so lanClient passes functions.
  const selfIdOf = typeof selfId === 'function' ? selfId : () => selfId;
  const isHostOf = typeof isHost === 'function' ? isHost : () => Boolean(isHost);
  const peers = new Map(); // remoteId -> peer record

  function notify(remoteId) {
    const p = peers.get(remoteId);
    if (p && typeof onPeerState === 'function') {
      try { onPeerState(remoteId, p.open); } catch { /* UI hook */ }
    }
  }

  function wireChannel(remoteId, dc) {
    const p = peers.get(remoteId);
    if (!p) return;
    p.dc = dc;
    dc.onopen = () => { p.open = true; notify(remoteId); };
    dc.onclose = () => { p.open = false; notify(remoteId); };
    dc.onerror = () => { p.open = false; notify(remoteId); };
    dc.onmessage = (event) => {
      let text = typeof event.data === 'string' ? event.data : null;
      if (!text && event.data) {
        try { text = new TextDecoder().decode(event.data); } catch { return; }
      }
      if (!text || text.length > LAN_MAX_MESSAGE_BYTES) return;
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (isPlainObject(message) && typeof onPeerMessage === 'function') {
        try { onPeerMessage(remoteId, message); } catch { /* game hook */ }
      }
    };
  }

  function createConnection(remoteId) {
    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates only
    const p = createPeer(remoteId).peer;
    p.pc = pc;
    peers.set(remoteId, p);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try { sendSignal('p2p_ice', remoteId, event.candidate.toJSON()); } catch { /* relay gone */ }
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        p.open = false;
        notify(remoteId);
      }
    };
    return p;
  }

  /** Host side: proactively offer a direct channel to one client. */
  function ensurePeer(remoteId) {
    if (!isHostOf()) return;
    const id = String(remoteId);
    if (id === String(selfIdOf()) || peers.has(id)) return;
    if (typeof RTCPeerConnection === 'undefined') return;

    const p = createConnection(id);
    const dc = p.pc.createDataChannel('dod');
    wireChannel(id, dc);
    p.pc.createOffer()
      .then((offer) => p.pc.setLocalDescription(offer))
      .then(() => {
        sendSignal('p2p_offer', id, { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp });
      })
      .catch(() => { peers.delete(id); });
  }

  /** Ensure a peer record exists for inbound signaling (client answer side). */
  function ensureAnswerer(remoteId) {
    const id = String(remoteId);
    if (peers.has(id) || typeof RTCPeerConnection === 'undefined') return peers.get(id) || null;
    const p = createConnection(id);
    p.pc.ondatachannel = (event) => {
      if (event.channel) wireChannel(id, event.channel);
    };
    return p;
  }

  /** Feed one signaling message relayed over WS. kind: p2p_offer|p2p_answer|p2p_ice. */
  function handleSignal(fromId, kind, payload) {
    const id = String(fromId);
    if (id === String(selfIdOf())) return;

    if (kind === 'p2p_offer') {
      if (isHostOf()) return; // host already offered; duplicate offers are ignored
      const p = ensureAnswerer(id);
      if (!p || !p.pc) return;
      p.pc.setRemoteDescription(payload)
        .then(() => { p.hasRemoteDesc = true; drainPeer(p); return p.pc.createAnswer(); })
        .then((answer) => p.pc.setLocalDescription(answer))
        .then(() => {
          sendSignal('p2p_answer', id, { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp });
        })
        .catch(() => { peers.delete(id); });
      return;
    }

    if (kind === 'p2p_answer') {
      if (!isHostOf()) return;
      const p = peers.get(id);
      if (!p || !p.pc || p.hasRemoteDesc) return;
      p.pc.setRemoteDescription(payload)
        .then(() => { p.hasRemoteDesc = true; drainPeer(p); })
        .catch(() => { peers.delete(id); });
      return;
    }

    if (kind === 'p2p_ice') {
      const p = peers.get(id) || (!isHostOf() ? ensureAnswerer(id) : null);
      if (!p || !p.pc) return;
      if (p.hasRemoteDesc) {
        try { p.pc.addIceCandidate(payload); } catch { /* stale */ }
      } else {
        p.pendingIce.push(payload);
      }
    }
  }

  function drainPeer(p) {
    const queue = p.pendingIce;
    p.pendingIce = [];
    for (const cand of queue) {
      try { p.pc.addIceCandidate(cand); } catch { /* stale */ }
    }
  }

  function isOpen(remoteId) {
    const p = peers.get(String(remoteId));
    return Boolean(p && p.open && p.dc && p.dc.readyState === 'open');
  }

  /** All currently open remote ids (host uses this for fan-out decisions). */
  function openPeers() {
    const out = [];
    for (const [id, p] of peers) {
      if (p.open && p.dc && p.dc.readyState === 'open') out.push(id);
    }
    return out;
  }

  function knownPeers() {
    return Array.from(peers.keys());
  }

  function send(remoteId, message) {
    const p = peers.get(String(remoteId));
    if (!p || !p.open || !p.dc || p.dc.readyState !== 'open') return false;
    try {
      const text = JSON.stringify(message);
      if (!text || text.length > LAN_MAX_MESSAGE_BYTES) return false;
      p.dc.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function close() {
    for (const p of peers.values()) {
      p.open = false;
      try { if (p.dc) p.dc.close(); } catch { /* ignore */ }
      try { if (p.pc) p.pc.close(); } catch { /* ignore */ }
    }
    peers.clear();
  }

  return { ensurePeer, handleSignal, isOpen, openPeers, knownPeers, send, close };
}
