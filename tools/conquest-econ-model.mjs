/**
 * 1v7 conquest economy model — executable fairness simulation.
 *
 * Real rules (src/systems/conquest.js):
 *   - a kill is worth 1 point                     (cq.kill(team))
 *   - every owned control point pays +1 per 2 s    (CAP_TICK_S)
 *   - flipping an uncontested point takes 6 s      (CAP_TIME_S)
 *   - a round ends at 25 points or 90 s            (ROUND_POINTS / ROUND_S)
 *
 * Layout of the 1v7 solo match:
 *   team 0 = 1 human, team 1 = 7 bots.
 * The bots have NO objective behaviour (no control-point code anywhere under
 * src/systems/ai/ or src/entities/enemy.js), so their point income is purely
 * incidental: they cluster around the site centre and respawn on top of the
 * control points. The human must hold a point to earn the same income.
 *
 * Run: node tools/conquest-econ-model.mjs
 */
import { createConquest, CONQUEST } from '../src/systems/conquest.js';

const PTS = [
  { id: 'mid', x: 0, z: 0, r: 7 },
  { id: 'cp1', x: 30, z: 0, r: 7 },
  { id: 'cp2', x: -30, z: 0, r: 7 },
];

/**
 * @param {object} o
 * @param {number} o.humanKills     kills the human lands (7 = wipes the squad)
 * @param {number} o.humanKillT     when the last kill lands
 * @param {number} o.humanHolds     how many control points the human holds
 * @param {number} o.humanCapT      when the human finishes capturing them
 * @param {number} o.botsHold       control points the bots hold
 * @param {number} o.contestFromT   bots start contesting the human's point
 */
function simulate(o) {
  const cq = createConquest({ points: PTS.map((p) => ({ ...p })) });
  cq.startRound();
  const dt = 1 / 30;
  let t = 0;
  let killsDone = false;
  const traj = [];
  let outcome = { t: null, winner: null, pts: null };

  while (t <= CONQUEST.ROUND_S + 1) {
    const humanHas = o.humanHolds > 0 && t >= o.humanCapT;
    const contesting = humanHas && o.contestFromT != null && t >= o.contestFromT;

    // presence rows [nTeam0, nTeam1] per control point
    const presence = PTS.map((_, i) => {
      const humanOn = humanHas && i < o.humanHolds;
      if (humanOn) {
        if (contesting) return [1, 1];      // bot contests: frozen, no income
        return [1, 0];                      // human owns it outright
      }
      return [0, o.botsHold > i ? 1 : 0];
    });

    const ev = cq.tick(dt, presence, false);

    if (!killsDone && t >= o.humanKillT && o.humanKills > 0) {
      killsDone = true;
      for (let i = 0; i < o.humanKills; i += 1) {
        const kev = cq.kill(0);
        if (kev) { outcome = { t, winner: kev.winner, pts: kev.pts.slice() }; break; }
      }
    }

    for (const e of ev) {
      if (e.type === 'roundEnd' && !outcome.t) outcome = { t, winner: e.winner, pts: e.pts.slice() };
    }

    if (Math.round(t * 30) % 30 === 0) traj.push({ t: Math.round(t), pts: cq.state.pts.slice() });
    if (outcome.t != null) break;
    t += dt;
  }

  if (outcome.t == null) outcome = { t: Math.round(t), winner: null, pts: cq.state.pts.slice() };
  return { outcome, traj, final: cq.state.pts.slice() };
}

const scenarios = [
  {
    key: 'A',
    name: 'A · bot 占 3 点（人类不占点）',
    note: '7 个 bot 无占点行为，但会自然聚在场地中心与复活锚点，等于白占 3 点',
    o: { humanKills: 0, humanKillT: 0, humanHolds: 0, humanCapT: 0, botsHold: 3, contestFromT: null },
  },
  {
    key: 'B',
    name: 'B · 人类全歼 7 bot（7 分）+ 占 1 点',
    note: '人类拿下全部击杀分，并站住一个点；bot 在 t=20s 开始反抢该点',
    o: { humanKills: 7, humanKillT: 12, humanHolds: 1, humanCapT: 6, botsHold: 2, contestFromT: 20 },
  },
  {
    key: 'C',
    name: 'C · 人类全歼 7 bot（7 分）+ 0 点',
    note: '人类把 7 个 bot 全杀光，一分站点收入也没有',
    o: { humanKills: 7, humanKillT: 12, humanHolds: 0, humanCapT: 0, botsHold: 3, contestFromT: null },
  },
];

console.log(`conquest: ${CONQUEST.ROUND_POINTS} 分制 / ${CONQUEST.ROUND_S}s / 每点每 ${CONQUEST.CAP_TICK_S}s +1 / 占领需 ${CONQUEST.CAP_TIME_S}s`);
console.log('');
const results = {};
for (const s of scenarios) {
  const r = simulate(s.o);
  results[s.key] = r;
  const o = r.outcome;
  console.log(`${s.name}`);
  console.log(`   ${s.note}`);
  console.log(`   结果: t=${o.t}s  ${o.winner === 0 ? '蓝(人类)胜' : o.winner === 1 ? '红(bot)胜' : '平局/超时'}  比分 ${o.pts[0]}:${o.pts[1]}`);
  console.log('');
}

// chart-ready trajectory
console.log('TRAJECTORY');
for (const s of scenarios) {
  const r = results[s.key];
  const pts = r.traj.map((p) => `${p.t}s:${p.pts[0]}-${p.pts[1]}`);
  console.log(`  ${s.key}: ${pts.join(' ')}`);
}
console.log('');
console.log('TRAJ_JSON ' + JSON.stringify({
  A: results.A.traj, B: results.B.traj, C: results.C.traj,
  outcomes: {
    A: results.A.outcome, B: results.B.outcome, C: results.C.outcome,
  },
}));
