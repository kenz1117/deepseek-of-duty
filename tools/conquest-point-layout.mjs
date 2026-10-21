/**
 * Evaluates candidate control-point layouts for the conquest round.
 *
 * Option chosen by the user: "place the control points between the two
 * teams' spawn points" — so a point must be reachable by BOTH factions in
 * the same round, and it must sit in the contested ground rather than at a
 * spawn.
 *
 * Metric per candidate p:
 *   d0 = distance to the nearest BLUE anchor   (team 0 spawn band)
 *   d1 = distance to the nearest RED  anchor   (team 1 spawn band)
 *   cost = max(d0, d1)  -> the worse-served faction's walk
 *
 * Run: node tools/conquest-point-layout.mjs
 */
const VERSUS_MAP_SPAWNS = [
  { x: 1, z: 33 },      // street
  { x: -96, z: 46 },    // old souk
  { x: 0, z: -165 },    // rail depot
  { x: 80, z: -80 },    // container yard
  { x: -190, z: 24 },   // west foothills
  { x: 130, z: -12 },   // dock
  { x: 98, z: -44 },    // port objective
  { x: -74, z: 12 },    // souk centre
];
const BLUE = VERSUS_MAP_SPAWNS.slice(0, 4);
const RED = VERSUS_MAP_SPAWNS.slice(4, 8);
const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// every (blue, red) pair gives one "between the spawns" midpoint
const cands = [];
for (const a of BLUE) {
  for (const b of RED) {
    const p = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const d0 = Math.min(...BLUE.map((q) => d(p, q)));
    const d1 = Math.min(...RED.map((q) => d(p, q)));
    cands.push({ p, d0, d1, cost: Math.max(d0, d1), pair: `${a.x},${a.z} | ${b.x},${b.z}` });
  }
}
cands.sort((p, q) => p.cost - q.cost);

console.log('=== 16 个「两队出生点中点」候选，按最差一方路程排序 ===');
console.log('  point            d0(蓝)  d1(红)  cost   paired anchors');
for (const c of cands) {
  console.log(`  (${String(Math.round(c.p.x)).padStart(5)},${String(Math.round(c.p.z)).padStart(6)})  `
    + `${c.d0.toFixed(1).padStart(6)}  ${c.d1.toFixed(1).padStart(6)}  ${c.cost.toFixed(1).padStart(6)}   ${c.pair}`);
}

// greedy: cheapest first, then maximise the spread from what is already chosen
function pick(budget, minSep) {
  const chosen = [];
  const pool = cands.filter((c) => c.cost <= budget);
  const first = pool[0];
  if (!first) return null;
  chosen.push(first);
  while (chosen.length < 3) {
    let best = null, bestSep = -1;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      const sep = Math.min(...chosen.map((k) => d(c.p, k.p)));
      if (sep > bestSep) { bestSep = sep; best = c; }
    }
    if (!best || bestSep < minSep) break;
    chosen.push(best);
  }
  return chosen;
}

console.log('\n=== 贪心选点（先最省，再最大化间距）===');
for (const budget of [70, 80, 90, 100, 120, 999]) {
  const sel = pick(budget, 18);
  if (!sel) { console.log(`  budget=${budget}: 无候选`); continue; }
  const worst = Math.max(...sel.map((c) => c.cost));
  const spread = sel.length >= 2 ? Math.min(...sel.slice(1).map((c, i) => d(c.p, sel[i].p))) : 0;
  console.log(`  budget=${budget}m -> ${sel.length} 个点  最差路程=${worst.toFixed(1)}m  最小间距=${spread.toFixed(1)}m`);
  for (const c of sel) {
    console.log(`      (${String(Math.round(c.p.x)).padStart(5)},${String(Math.round(c.p.z)).padStart(6)})  d0=${c.d0.toFixed(1)}  d1=${c.d1.toFixed(1)}  cost=${c.cost.toFixed(1)}`);
  }
}

// what the CURRENT layout costs, for comparison
const SITE = { x: 1, z: 33 };
console.log('\n=== 对照：当前布局（site 中心 + 两个 objective spot）===');
console.log(`  当前 'mid' 落在 (${SITE.x},${SITE.z})：d0=${Math.min(...BLUE.map((q) => d(SITE, q))).toFixed(1)}m  d1=${Math.min(...RED.map((q) => d(SITE, q))).toFixed(1)}m`);
console.log('  实测中最远点距出生点 78m —— runner 约 1.5 m/s，一个 90s 回合走不到再加 6s 占领。');
console.log('\n两队出生锚点：');
console.log('  蓝:', BLUE.map((p) => `(${p.x},${p.z})`).join(' '));
console.log('  红:', RED.map((p) => `(${p.x},${p.z})`).join(' '));
