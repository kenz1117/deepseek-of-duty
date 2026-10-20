#!/usr/bin/env node
/**
 * Safe-zone unit tests.
 *
 * The load-bearing property is geometric: every ring circle must stay inside
 * the site rect, otherwise the ring would slice playable area off the map.
 * Run: node tools/zone-test.mjs
 */

import { createZone, defaultPhases, ZONE_PHASE_COUNT } from '../src/systems/zone.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function seeded(seed = 1) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

/* The four real MAP_SITES rects from main.js:89-114, with their inscribed radii. */
const SITES = [
  { id: 'street', rect: { x0: -28, x1: 44, z0: -28, z1: 82 } },
  { id: 'souk', rect: { x0: -116, x1: -40, z0: -42, z1: 72 } },
  { id: 'rail', rect: { x0: -38, x1: 42, z0: -194, z1: -106 } },
  { id: 'port', rect: { x0: 48, x1: 122, z0: -98, z1: 34 } },
];

/* --- default phase shape ------------------------------------------------- */
{
  const phases = defaultPhases(72, 110);
  check('phases: stage count matches the exported design constant', phases.length === ZONE_PHASE_COUNT, `${phases.length} vs ${ZONE_PHASE_COUNT}`);
  check('phases: radius shrinks monotonically',
    phases.every((p, i) => i === 0 || p.radius < phases[i - 1].radius),
    JSON.stringify(phases.map((p) => p.radius)));
  check('phases: final radius is a duel-sized circle', phases[5].radius <= 25, `${phases[5].radius}`);
  check('phases: dps escalates', phases.every((p, i) => i === 0 || p.dps > phases[i - 1].dps));
  check('phases: every stage has wait+shrink time', phases.every((p) => p.wait > 0 && p.shrink > 0));
  // The opening ring must cover the whole rect so nobody spawns outside it.
  const cover = Math.hypot(72, 110) / 2;
  check('phases: opening ring covers the whole playable rect', phases[0].radius >= cover - 0.01,
    `start=${phases[0].radius} cover=${cover.toFixed(1)}`);
}

/* --- GEOMETRY: the ring must never leave the rect ------------------------ */
for (const site of SITES) {
  for (const seed of [1, 2, 3, 99, 12345]) {
    const z = createZone({ rect: site.rect, rng: seeded(seed) });
    let worstClip = 0;
    let worstFirstPhaseClip = 0;
    let samples = 0;
    for (let i = 0; i < 6000 && !z.isFinal; i += 1) {
      const s = z.update(0.25, site.rect.x0, site.rect.z0);
      samples += 1;
      // Once the ring is small enough to fit, it must be fully inside the rect.
      const fitted = s.r <= Math.min(site.rect.x1 - site.rect.x0, site.rect.z1 - site.rect.z0) / 2;
      if (fitted) {
        const margin = Math.min(
          s.x - site.rect.x0, site.rect.x1 - s.x,
          s.z - site.rect.z0, site.rect.z1 - s.z,
        );
        const clip = s.r - margin;
        if (clip > worstClip) worstClip = clip;
        if (s.phase === 0 && clip > worstFirstPhaseClip) worstFirstPhaseClip = clip;
      }
    }
    check(
      `${site.id}(seed ${seed}): fitted ring never clips the rect`,
      worstClip <= 0.001,
      `clip ${worstClip.toFixed(3)}m over ${samples} samples`
    );
  }
}

/* --- the opening ring must contain the whole playable rect --------------- */
for (const site of SITES) {
  const z = createZone({ rect: site.rect, rng: seeded(5) });
  const s = z.state;
  // every corner of the rect must be inside the opening ring
  const corners = [
    [site.rect.x0, site.rect.z0], [site.rect.x1, site.rect.z0],
    [site.rect.x0, site.rect.z1], [site.rect.x1, site.rect.z1],
  ];
  const outside = corners.filter(([x, zz]) => Math.hypot(x - s.x, zz - s.z) > s.r);
  check(`${site.id}: no player spawns outside the opening ring`, outside.length === 0,
    `${outside.length} corner(s) outside (r=${s.r.toFixed(1)})`);
}

/* --- the whole match actually completes --------------------------------- */
{
  const z = createZone({ rect: SITES[0].rect, rng: seeded(7) });
  let guard = 0;
  while (!z.isFinal && guard < 20000) { z.update(0.25, 0, 0); guard += 1; }
  check('match: reaches the final ring', z.isFinal === true, `guard=${guard}`);
  const total = z.phases.reduce((a, p) => a + p.wait + p.shrink, 0);
  check('match: total duration is a sane round length (3-9 min)', total > 180 && total < 540, `${total.toFixed(0)}s`);
}

/* --- containment + damage ------------------------------------------------ */
{
  const z = createZone({ rect: SITES[0].rect, rng: seeded(3) });
  const s = z.update(0.1, s0x(), s0z());
  function s0x() { return z.state.x; }
  function s0z() { return z.state.z; }
  check('containment: the centre is inside', z.contains(z.state.x, z.state.z) === true);
  check('containment: far outside is not', z.contains(z.state.x + 500, z.state.z + 500) === false);
  check('damage: outsideDistance is 0 when safe', z.outsideDistance(z.state.x, z.state.z) === 0);
  check('damage: outsideDistance grows outside',
    z.outsideDistance(z.state.x + z.state.r + 10, z.state.z) > 9);
}

/* --- phase sequencing ---------------------------------------------------- */
{
  const events = [];
  const z = createZone({
    rect: SITES[1].rect,
    rng: seeded(11),
    onPhase: (i) => events.push(`phase:${i}`),
    onShrink: (i) => events.push(`shrink:${i}`),
    onFinal: () => events.push('final'),
  });
  let guard = 0;
  while (!z.isFinal && guard < 20000) { z.update(0.25, 0, 0); guard += 1; }
  check('events: announces each phase', events.filter((e) => e.startsWith('phase:')).length === ZONE_PHASE_COUNT, JSON.stringify(events));
  check('events: announces each shrink', events.filter((e) => e.startsWith('shrink:')).length === ZONE_PHASE_COUNT);
  check('events: announces the final ring', events.includes('final'));
}

/* --- nested-ring rule ---------------------------------------------------- */
{
  // The next circle must be fully contained in the current one at the moment
  // a phase begins, which is what makes the ring readable instead of random.
  let violations = 0;
  for (const seed of [4, 5, 6, 21, 88]) {
    const z = createZone({ rect: SITES[2].rect, rng: seeded(seed) });
    for (let i = 0; i < 4000 && !z.isFinal; i += 1) {
      const before = { x: z.state.x, z: z.state.z, r: z.state.r };
      z.update(0.25, 0, 0);
      const after = z.state;
      if (after.eta <= 0 && after.nextR < after.r) {
        const d = Math.hypot(after.nextX - before.x, after.nextZ - before.z);
        if (d + after.nextR > before.r + 0.001) violations += 1;
      }
    }
  }
  check('nesting: next ring always fits inside the current one', violations === 0, `${violations} violations`);
}

/* --- LAN serialize round-trip ------------------------------------------- */
{
  const host = createZone({ rect: SITES[3].rect, rng: seeded(21) });
  for (let i = 0; i < 400; i += 1) host.update(0.25, 85, -32);
  const wire = host.serialize();
  check('serialize: compact keys', Object.keys(wire).length <= 13, JSON.stringify(Object.keys(wire)));
  check('serialize: size is tiny vs the 16 KB snapshot cap', JSON.stringify(wire).length < 300, `${JSON.stringify(wire).length}`);
  check('serialize: numbers are rounded for wire efficiency',
    Number.isFinite(wire.x) && String(wire.x).length <= 8);

  const client = createZone({ rect: SITES[3].rect, rng: seeded(999) });
  client.applyRemote(wire);
  check('applyRemote: client adopts host ring', Math.abs(client.state.x - wire.x) < 0.01);
  check('applyRemote: client adopts host radius', Math.abs(client.state.r - wire.r) < 0.01);
  check('applyRemote: client adopts host phase', client.state.phase === wire.phase);
}

/* --- reset --------------------------------------------------------------- */
{
  const z = createZone({ rect: SITES[0].rect, rng: seeded(13) });
  for (let i = 0; i < 3000; i += 1) z.update(0.25, 0, 0);
  const mid = z.state.phase;
  z.reset();
  check('reset: back to phase 0', z.state.phase === 0);
  check('reset: ring is large again', z.state.r > 25, `r=${z.state.r}`);
  check('reset: not finished', z.isFinal === false);
  void mid;
}

/* --- degenerate rect ------------------------------------------------------ */
{
  const z = createZone({ rect: { x0: 0, x1: 0, z0: 0, z1: 0 }, rng: seeded(2) });
  const s = z.update(0.1, 0, 0);
  check('degenerate: tiny rect still yields a usable positive radius', s.r > 0, `r=${s.r}`);
  check('degenerate: no NaN leaks into state', Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.r));
}

console.log(failures === 0 ? '\n[zone-test] all checks passed' : `\n[zone-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);