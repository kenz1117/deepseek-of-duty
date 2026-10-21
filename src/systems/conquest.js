/* =========================================================================
 * CONQUEST — round-based versus with control points (Phase 4b, plan §5.2).
 *
 * The old versus was an endless team deathmatch with gas as the only pacer:
 * no rounds, no side swap, no reason to move except the ring. Conquest-lite
 * replaces it:
 *
 *   • ROUNDS — best of 3 (max 5), each 90 s or first to 25 points. Sides
 *     swap every round so neither faction keeps the better half of the map.
 *   • CONTROL POINTS — three per district. Stand on one uncontested for 6 s
 *     to flip it; every owned point ticks +1 team point every 2 s and acts
 *     as a forward respawn. Holding ground beats hunting kills.
 *   • OVERTIME — a tied round goes to sudden death: the first point scored
 *     wins, and THAT is when the gas comes in (fast ring) to force the end.
 *   • RUBBER BAND — on the BOT side only: fill bots on the trailing faction
 *     get a modest accuracy boost; humans are never touched.
 *
 * Pure logic: no three.js, DOM or timers. The host owns one instance as the
 * authority and broadcasts snapshot(); clients hold a mirror for the HUD and
 * for the side-swap spawn rule. Tested by tools/conquest-test.mjs.
 * ========================================================================= */

export const CONQUEST = Object.freeze({
  ROUND_POINTS: 25,          // round ends at this many team points
  ROUND_S: 90,               // ...or when the clock runs out
  ROUNDS_TO_WIN: 2,          // best of 3
  MAX_ROUNDS: 5,             // hard cap (draw rounds can extend a series)
  INTERMISSION_S: 6,         // result card between rounds
  DEPLOY_S: 8,               // no-fire deployment at the start of a round
  OVERTIME_S: 60,            // sudden-death cap
  OVERTIME_GAS_DELAY_S: 12,  // the fast ring arms this long into overtime
  CAP_RADIUS: 7,             // stand this close to a point to contest it
  CAP_TIME_S: 6,             // uncontested seconds to flip ownership
  CAP_TICK_S: 2,             // +1 point per owned control point per tick
  SPAWN_GRACE_S: 2,          // post-respawn invulnerability
  ENEMY_SPAWN_CLEAR_M: 15,   // prefer respawns farther than this from hostiles
});

export function createConquest({ points = [], cfg = CONQUEST } = {}) {
  const C = cfg;
  let round = 0;
  let wins = [0, 0];
  let pts = [0, 0];
  let t = 0;                   // seconds left in the live round / overtime
  let phase = 'idle';          // idle | live | over | inter | done
  let interT = 0;
  let capTickT = 0;
  let swap = 0;                // 0/1: which faction holds the "home" side
  let matchWinner = null;      // 0 | 1 | null (draw) once phase === 'done'
  let lastRound = null;        // { round, winner, pts:[..] }
  const cps = points.map((p, i) => ({
    id: p.id != null ? String(p.id) : String(i),
    x: Number(p.x) || 0, z: Number(p.z) || 0, r: Number(p.r) || C.CAP_RADIUS,
    owner: null, prog: 0, progTeam: null,
  }));

  function resetPoints() {
    for (const cp of cps) { cp.owner = null; cp.prog = 0; cp.progTeam = null; }
    capTickT = 0;
  }

  function resetMatch() {
    round = 0; wins = [0, 0]; pts = [0, 0]; t = 0; phase = 'idle';
    interT = 0; swap = 0; matchWinner = null; lastRound = null;
    resetPoints();
  }

  /** Begin the next round: fresh points, swapped sides, full clock. */
  function startRound() {
    round += 1;
    pts = [0, 0];
    t = C.ROUND_S;
    phase = 'live';
    swap = (round - 1) % 2;      // round 1 home, round 2 swapped, ...
    resetPoints();
    return { round, swap };
  }

  function leader() {
    if (pts[0] === pts[1]) return null;
    return pts[0] > pts[1] ? 0 : 1;
  }

  function endRound(winner) {
    if (winner === 0 || winner === 1) wins[winner] += 1;
    lastRound = { round, winner, pts: pts.slice() };
    if (wins[0] >= C.ROUNDS_TO_WIN || wins[1] >= C.ROUNDS_TO_WIN) {
      matchWinner = wins[0] > wins[1] ? 0 : 1;
      phase = 'done';
    } else if (round >= C.MAX_ROUNDS) {
      matchWinner = wins[0] === wins[1] ? null : (wins[0] > wins[1] ? 0 : 1);
      phase = 'done';
    } else {
      phase = 'inter';
      interT = C.INTERMISSION_S;
    }
    return { type: 'roundEnd', round, winner, pts: pts.slice(), wins: wins.slice(), matchWinner, done: phase === 'done' };
  }

  /** Score checks shared by kills and capture ticks. Returns an event or null. */
  function checkRound() {
    if (phase === 'live') {
      if (pts[0] >= C.ROUND_POINTS || pts[1] >= C.ROUND_POINTS) return endRound(leader());
      return null;
    }
    if (phase === 'over') {
      const l = leader();
      if (l !== null) return endRound(l);   // sudden death: first lead wins
    }
    return null;
  }

  /** A kill for `team` (0/1). Ignored when the round is not being played. */
  function kill(team) {
    if ((phase !== 'live' && phase !== 'over') || (team !== 0 && team !== 1)) return null;
    pts[team] += 1;
    return checkRound();
  }

  /**
   * Advance the round by `dt`. `presence[i] = [nTeam0, nTeam1]` is who is
   * standing on control point i. `paused` freezes clock + capture (deploy
   * grace). Returns the events that fired this tick, in order.
   */
  function tick(dt, presence = [], paused = false) {
    const events = [];
    if (phase === 'inter') {
      interT -= dt;
      if (interT <= 0) { interT = 0; events.push({ type: 'intermissionOver' }); }
      return events;
    }
    if (phase !== 'live' && phase !== 'over') return events;
    if (paused) return events;

    // ---- capture progress
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const pr = presence[i] || [0, 0];
      const n0 = pr[0] | 0, n1 = pr[1] | 0;
      if (n0 > 0 && n1 > 0) continue;                        // contested: frozen
      const team = n0 > 0 ? 0 : n1 > 0 ? 1 : null;
      if (team === null) {
        // nobody here: a half-finished flip fades
        cp.prog = Math.max(0, cp.prog - dt / (C.CAP_TIME_S * 2));
        if (cp.prog === 0) cp.progTeam = null;
        continue;
      }
      if (cp.owner === team) { cp.prog = 0; cp.progTeam = null; continue; }
      if (cp.progTeam !== team) { cp.progTeam = team; cp.prog = 0; }
      cp.prog = Math.min(1, cp.prog + dt / C.CAP_TIME_S);
      if (cp.prog >= 1) {
        const prev = cp.owner;
        cp.owner = team; cp.prog = 0; cp.progTeam = null;
        events.push({ type: 'capture', point: cp.id, team, from: prev });
      }
    }

    // ---- hold income
    capTickT += dt;
    while (capTickT >= C.CAP_TICK_S) {
      capTickT -= C.CAP_TICK_S;
      for (const cp of cps) if (cp.owner === 0 || cp.owner === 1) pts[cp.owner] += 1;
      const ev = checkRound();
      if (ev) { events.push(ev); return events; }
    }

    // ---- clock
    t -= dt;
    if (t <= 0) {
      t = 0;
      if (phase === 'live') {
        const l = leader();
        if (l !== null) events.push(endRound(l));
        else {
          phase = 'over';
          t = C.OVERTIME_S;
          events.push({ type: 'overtime', round });
        }
      } else {
        // overtime cap reached with no lead: the round is a draw
        events.push(endRound(leader()));
      }
    }
    return events;
  }

  /** Owned control points for `team` — forward respawn candidates. */
  function ownedPoints(team) {
    return cps.filter((cp) => cp.owner === team).map((cp) => ({ id: cp.id, x: cp.x, z: cp.z, r: cp.r }));
  }

  /** Compact wire form (fits the 16 KB snapshot budget many times over). */
  function snapshot() {
    return {
      rd: round, w: wins.slice(), p: pts.slice(), t: Number(t.toFixed(1)),
      ph: phase, sw: swap, mw: matchWinner,
      cp: cps.map((cp) => [cp.owner === null ? -1 : cp.owner, Number(cp.prog.toFixed(2)), cp.progTeam === null ? -1 : cp.progTeam]),
    };
  }

  /** Client mirror: adopt the host's state wholesale. */
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return;
    const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    round = n(s.rd, round);
    if (Array.isArray(s.w) && s.w.length === 2) wins = [n(s.w[0], 0), n(s.w[1], 0)];
    if (Array.isArray(s.p) && s.p.length === 2) pts = [n(s.p[0], 0), n(s.p[1], 0)];
    t = n(s.t, t);
    if (typeof s.ph === 'string') phase = s.ph;
    swap = n(s.sw, swap) ? 1 : 0;
    matchWinner = s.mw === 0 || s.mw === 1 ? s.mw : null;
    if (Array.isArray(s.cp)) {
      for (let i = 0; i < cps.length && i < s.cp.length; i++) {
        const row = s.cp[i] || [];
        const o = n(row[0], -1), g = n(row[1], 0), gt = n(row[2], -1);
        cps[i].owner = o === 0 || o === 1 ? o : null;
        cps[i].prog = Math.max(0, Math.min(1, g));
        cps[i].progTeam = gt === 0 || gt === 1 ? gt : null;
      }
    }
  }

  return {
    resetMatch, startRound, tick, kill, ownedPoints, snapshot, applySnapshot,
    get state() {
      return {
        round, wins: wins.slice(), pts: pts.slice(), t, phase, swap, matchWinner, lastRound,
        points: cps.map((cp) => ({ ...cp })),
      };
    },
    get cfg() { return C; },
  };
}

/**
 * Bot-side rubber band: accuracy multiplier per faction for the FILL BOTS
 * only. The faction trailing in round points gets up to +30 % accuracy
 * (3 % per point behind); the leading faction stays at baseline. Humans are
 * never scaled — the hand on the scale is on the AI, where nobody feels it.
 */
export function botRubberBand(pts, { perPoint = 0.03, cap = 0.3 } = {}) {
  const a = Number(pts && pts[0]) || 0;
  const b = Number(pts && pts[1]) || 0;
  const diff = a - b;
  const boost = Math.min(cap, Math.abs(diff) * perPoint);
  return diff > 0 ? [1, 1 + boost] : diff < 0 ? [1 + boost, 1] : [1, 1];
}

/**
 * Pick a respawn point for `team`: owned control points are forward spawns;
 * the default slot is always a candidate. Prefer the candidate farthest
 * from the nearest live hostile, so nobody materialises inside an enemy's
 * 15 m view cone. Pure: positions in, position out.
 */
export function pickRespawnPoint({ team, fallback, owned = [], hostiles = [], clearM = CONQUEST.ENEMY_SPAWN_CLEAR_M, rng = Math.random }) {
  const candidates = [];
  for (const o of owned) candidates.push({ x: o.x, z: o.z, forward: true });
  if (fallback) candidates.push({ x: fallback.x, z: fallback.z, forward: false });
  if (!candidates.length) return null;
  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    let nearest = Infinity;
    for (const h of hostiles) {
      const d = Math.hypot(h.x - c.x, h.z - c.z);
      if (d < nearest) nearest = d;
    }
    // forward spawns are worth a little; being inside an enemy's sight is worth a lot less
    const score = Math.min(nearest, clearM * 2) + (c.forward ? 4 : 0) + rng() * 0.5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const jitter = 2.5;
  return {
    x: best.x + (rng() - 0.5) * jitter * 2,
    z: best.z + (rng() - 0.5) * jitter * 2,
    forward: best.forward,
  };
}
