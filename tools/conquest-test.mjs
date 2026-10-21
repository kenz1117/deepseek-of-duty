#!/usr/bin/env node
/**
 * Conquest unit tests (Phase 4b — round-based versus with control points).
 *
 * systems/conquest.js is pure logic, so the whole round state machine runs
 * headlessly: kills and hold income toward 25 points, the 90 s clock, side
 * swaps, sudden-death overtime, best-of-3 (max 5) series, capture flips with
 * contest freezing, the bot-only rubber band and the safe respawn picker.
 *
 * Run: node tools/conquest-test.mjs
 */

import { createConquest, botRubberBand, pickRespawnPoint, CONQUEST } from '../src/systems/conquest.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const seq = (n) => { let i = 0; return () => { i = (i + 1) % n; return i / n; }; };

const PTS = [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 30, z: 0 }, { id: 'c', x: 60, z: 0 }];

/* ---- rounds & sides ------------------------------------------------------- */
{
  const c = createConquest({ points: PTS });
  check('idle before the first round', c.state.phase === 'idle' && c.kill(0) === null);
  const r1 = c.startRound();
  check('round 1 starts live on the home side', r1.round === 1 && r1.swap === 0 && c.state.phase === 'live'
    && c.state.t === CONQUEST.ROUND_S);
  // 25 kills end the round for the killers
  let ev = null;
  for (let i = 0; i < 25; i++) ev = c.kill(1);
  check('first to 25 points wins the round', ev && ev.type === 'roundEnd' && ev.winner === 1
    && c.state.wins[1] === 1 && c.state.phase === 'inter');
  check('kills during intermission are ignored', c.kill(0) === null && c.state.pts[0] === 0);
  // intermission runs out → host is told to start the next round
  const evs = c.tick(CONQUEST.INTERMISSION_S + 0.1);
  check('intermission over event fires', evs.some((e) => e.type === 'intermissionOver'));
  const r2 = c.startRound();
  check('round 2 swaps sides and resets points', r2.round === 2 && r2.swap === 1
    && c.state.pts[0] === 0 && c.state.pts[1] === 0 && c.state.points.every((p) => p.owner === null));
  for (let i = 0; i < 25; i++) ev = c.kill(1);
  check('second round win = series over (best of 3)', ev.done === true && ev.matchWinner === 1
    && c.state.phase === 'done');
}

/* ---- clock, leader, overtime ---------------------------------------------- */
{
  const c = createConquest({ points: [] });
  c.startRound();
  c.kill(0); c.kill(0); c.kill(1);
  const evs = c.tick(CONQUEST.ROUND_S + 1);
  check('clock expiry hands the round to the leader', evs.some((e) => e.type === 'roundEnd' && e.winner === 0));

  const d = createConquest({ points: [] });
  d.startRound();
  d.kill(0); d.kill(1);
  const ot = d.tick(CONQUEST.ROUND_S + 1);
  check('a tied clock goes to overtime', ot.some((e) => e.type === 'overtime') && d.state.phase === 'over'
    && d.state.t === CONQUEST.OVERTIME_S);
  const sd = d.kill(1);
  check('overtime is sudden death: first lead ends the round', sd && sd.type === 'roundEnd' && sd.winner === 1);

  const e = createConquest({ points: [] });
  e.startRound();
  e.tick(CONQUEST.ROUND_S + 1);              // → overtime, 0:0
  const cap = e.tick(CONQUEST.OVERTIME_S + 1);
  check('overtime cap with no lead is a drawn round (no win awarded)',
    cap.some((x) => x.type === 'roundEnd' && x.winner === null) && e.state.wins[0] === 0 && e.state.wins[1] === 0);
}

/* ---- series cap ----------------------------------------------------------- */
{
  const c = createConquest({ points: [] });
  // five drawn rounds hit MAX_ROUNDS → match is a draw
  let last = null;
  for (let r = 0; r < CONQUEST.MAX_ROUNDS; r++) {
    c.startRound();
    c.tick(CONQUEST.ROUND_S + 1);
    const evs = c.tick(CONQUEST.OVERTIME_S + 1);
    last = evs.find((e) => e.type === 'roundEnd');
    if (c.state.phase === 'inter') c.tick(CONQUEST.INTERMISSION_S + 1);
  }
  check('five drawn rounds end the series as a draw', last && last.done && last.matchWinner === null);
}

/* ---- capture mechanics ---------------------------------------------------- */
{
  const c = createConquest({ points: PTS });
  c.startRound();
  // team 0 alone on point a for CAP_TIME → flip
  let flipped = null;
  for (let i = 0; i < 20 && !flipped; i++) {
    const evs = c.tick(0.5, [[1, 0], [0, 0], [0, 0]], false);
    flipped = evs.find((e) => e.type === 'capture');
  }
  check('uncontested presence flips a point after CAP_TIME', flipped && flipped.team === 0 && flipped.point === 'a'
    && c.state.points[0].owner === 0);
  // contested point does not progress
  const before = c.state.points[1].prog;
  c.tick(2, [[1, 0], [1, 1], [0, 0]]);
  check('contested points freeze', c.state.points[1].prog === before && c.state.points[1].owner === null);
  // hold income: owning a → +1 per 2 s
  const p0 = c.state.pts[0];
  c.tick(CONQUEST.CAP_TICK_S * 3 + 0.01, [[0, 0], [0, 0], [0, 0]]);
  check('owned points pay hold income', c.state.pts[0] === p0 + 3, `pts=${c.state.pts[0]} was ${p0}`);
  // pause freezes capture + clock + income
  const t0 = c.state.t, pts0 = c.state.pts[0];
  c.tick(5, [[0, 1], [0, 1], [0, 1]], true);
  check('paused tick changes nothing', c.state.t === t0 && c.state.pts[0] === pts0
    && c.state.points.every((p) => p.prog === 0));
  // an abandoned half-flip fades back to zero
  c.tick(3, [[0, 0], [0, 1], [0, 0]]);          // team 1 starts flipping b (3/6)
  check('a half flip is in progress', c.state.points[1].prog > 0.4 && c.state.points[1].progTeam === 1);
  c.tick(20, [[0, 0], [0, 0], [0, 0]]);
  check('abandoned flips fade out', c.state.points[1].prog === 0 && c.state.points[1].progTeam === null);
  // forward spawns list owned points only
  check('ownedPoints lists the faction\'s forward spawns', c.ownedPoints(0).length === 1 && c.ownedPoints(1).length === 0);
}

/* ---- snapshot round trip -------------------------------------------------- */
{
  const host = createConquest({ points: PTS });
  host.startRound(); host.kill(1); host.kill(1);
  host.tick(7, [[1, 0], [0, 0], [0, 0]]);
  const mirror = createConquest({ points: PTS });
  mirror.applySnapshot(JSON.parse(JSON.stringify(host.snapshot())));
  const h = host.state, m = mirror.state;
  check('snapshot round-trips round/points/clock/owners', m.round === h.round && m.pts[1] === 2
    && Math.abs(m.t - h.t) < 0.2 && m.points[0].owner === 0 && m.phase === 'live');
}

/* ---- rubber band (bot side only) ------------------------------------------ */
check('rubber band boosts only the trailing faction',
  JSON.stringify(botRubberBand([10, 4])) === JSON.stringify([1, 1.18])
  && JSON.stringify(botRubberBand([2, 9])) === JSON.stringify([1.21, 1])
  && JSON.stringify(botRubberBand([5, 5])) === JSON.stringify([1, 1]));
check('rubber band caps at +30 %', botRubberBand([0, 40])[0] === 1.3);

/* ---- respawn picker ------------------------------------------------------- */
{
  const rng = seq(7);
  const fallback = { x: 0, z: 0 };
  const owned = [{ x: 40, z: 0 }];
  // hostile camping the fallback: forward owned point wins
  const p1 = pickRespawnPoint({ team: 0, fallback, owned, hostiles: [{ x: 3, z: 0 }], rng });
  check('respawn avoids a hostile camping the default slot', p1.forward === true && Math.abs(p1.x - 40) < 3);
  // hostile camping the forward point: fall back
  const p2 = pickRespawnPoint({ team: 0, fallback, owned, hostiles: [{ x: 42, z: 0 }], rng });
  check('respawn avoids a hostile camping the forward point', p2.forward === false && Math.abs(p2.x) < 3);
  check('no candidates → null', pickRespawnPoint({ team: 0, fallback: null, owned: [], hostiles: [] }) === null);
}

process.exit(failures ? 1 : 0);
