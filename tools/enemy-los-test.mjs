#!/usr/bin/env node
/**
 * Enemy LOS / shot-path geometry tests (pure function, no three.js needed).
 *
 * The load-bearing regression: the old 1.15 m sampled line march let thin
 * walls disappear (both samples land on either side), which read as AI
 * wallhacks. The analytic slab test must be exact for every thickness.
 *
 * Run: node tools/enemy-los-test.mjs
 */

import { segmentBlockedByColliders } from '../src/entities/enemy.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// eye at 1.62 m, target chest at 1.4 m — the game's constants
const EYE = 1.62, CHEST = 1.4;
const path = (ax, az, bx, bz, colliders, opts = {}) =>
  segmentBlockedByColliders(ax, opts.ay ?? EYE, az, bx, opts.by ?? CHEST, bz, colliders, opts.occluders || [], opts.host || null);

/* --- THE regression: thin wall must block --------------------------------- */
{
  const cols = [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 3.0 }];   // 0.5 m thick
  check('thin wall (0.5 m) blocks the shot path', path(0, 0, 10, 0, cols).blocked === true);
  check('thin wall blocks vision (the old wallhack leak)', path(0, 0, 10, 0, cols).blocked === true);
  check('diagonal ray through thin wall blocks too',
    path(0, 0, 9, 9, [{ x0: 4.5, x1: 5.0, z0: 4.5, z1: 5.0, top: 3 }]).blocked === true);
}

/* --- clear paths ---------------------------------------------------------- */
{
  check('open ground is clear', path(0, 0, 12, 0, []).blocked === false);
  check('two walls with a gap: the line through the gap is clear',
    path(0, 0, 12, 0, [
      { x0: 4.75, x1: 5.25, z0: -10, z1: -2, top: 3 },
      { x0: 4.75, x1: 5.25, z0: 2, z1: 10, top: 3 },
    ]).blocked === false);
}

/* --- height handling ------------------------------------------------------ */
{
  const low = [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 0.9 }];
  check('low wall (0.9 m) is passed over by the eye line', path(0, 0, 10, 0, low).blocked === false);
  // a crouched SHOOTER (eye 0.9) firing at a crouched chest (0.7) IS blocked:
  // the whole line runs below the wall top
  check('crouched shooter -> crouched target is blocked by the 0.9 m wall',
    path(0, 0, 10, 0, low, { ay: 0.9, by: 0.7 }).blocked === true);
  const tall = [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 3.0 }];
  check('shooter above the wall top clears it', path(0, 0, 10, 0, tall, { ay: 5 }).blocked === false);
}

/* --- roof shooter: own footprint ignored, far walls still block ----------- */
{
  const host = { x0: -2, x1: 2, z0: -2, z1: 2, top: 5.5 };
  const far = { x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 9 };
  check('roof shooter: own footprint ignored, far wall blocks',
    path(0, 0, 10, 0, [host, far], { ay: EYE + 6, host }).blocked === true);
  check('roof shooter: open sky is clear',
    path(0, 0, 10, 0, [host], { ay: EYE + 6, host }).blocked === false);
}

/* --- roof decks (3D occluders) -------------------------------------------- */
{
  const deck = { x0: 4, x1: 8, z0: -4, z1: 4, y: 3.0 };
  check('roof deck blocks seeing into the room below',
    path(0, 0, 6, 0, [], { occluders: [deck], ay: EYE + 6 }).blocked === true);
  check('roof deck does not block a line above it',
    path(0, 0, 12, 0, [], { occluders: [deck], ay: EYE + 6, by: EYE + 6 }).blocked === false);
}

/* --- tEnd truncation ------------------------------------------------------ */
{
  const cols = [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 3 }];
  const r = path(0, 0, 10, 0, cols);
  check('tEnd lands at the wall (tracer truncates, not at target)',
    r.blocked === true && r.tEnd > 0.3 && r.tEnd < 0.7, `tEnd=${r.tEnd}`);
  check('clear path reports tEnd=1', path(0, 0, 10, 0, []).tEnd === 1);
}

/* --- degenerate geometry must not crash ----------------------------------- */
{
  check('zero-length ray inside a wall reports cleanly',
    Number.isFinite(path(5, 0, 5, 0, [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 3 }]).tEnd));
  check('axis-aligned ray through a wall blocks',
    path(0, 0, 10, 0, [{ x0: 4.75, x1: 5.25, z0: -3, z1: 3, top: 3 }]).blocked === true);
}

/* --- CROUCH vs STAND: the eye height has to matter ----------------------
   The AI used to trace its sight line to the target's FEET, so a crouched
   player and a standing one produced the identical ray — crouching bought
   nothing. These pin the fix at the geometry level (deterministic, no
   browser): the same crate hides a crouched player and not a standing one. */
{
  const crate = [{ x0: 9.4, x1: 10.6, z0: -1, z1: 1, top: 1.2 }];  // 1.2 m crate at x=10
  const shooter = { x: 0, z: 0 };
  const player = { x: 11, z: 0 };    // right behind the crate
  const stand = path(shooter.x, shooter.z, player.x, player.z, crate, { ay: 1.685, by: 1.68 });
  const crouch = path(shooter.x, shooter.z, player.x, player.z, crate, { ay: 1.685, by: 1.05 });
  check('a 1.2 m crate hides a CROUCHED player right behind it', crouch.blocked === true);
  check('the same crate does NOT hide a STANDING player', stand.blocked === false);
  // the feet-height ray (the old, broken target) hides both
  const feet = path(shooter.x, shooter.z, player.x, player.z, crate, { ay: 1.685, by: 0 });
  check('the old feet-height ray hid a STANDING player too (that was the bug)',
    feet.blocked === true && stand.blocked === false);
  // at range the sight line clears a low crate for both postures
  const farStand = path(0, 0, 40, 0, crate, { ay: 1.685, by: 1.68 });
  const farCrouch = path(0, 0, 40, 0, crate, { ay: 1.685, by: 1.05 });
  check('at range the sight line clears a low crate for both postures',
    farStand.blocked === false && farCrouch.blocked === false);
}

console.log(failures === 0 ? '\n[enemy-los] all checks passed' : `\n[enemy-los] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
