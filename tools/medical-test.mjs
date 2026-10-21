#!/usr/bin/env node
/**
 * Downed/revive unit tests (Phase 4a — LAN co-op medical layer).
 *
 * systems/medical.js is pure logic: the registry is what the HOST treats as
 * authority and every client mirrors from events. These pin the rules the
 * feature lives or dies by: bleed-out expiry, revive range, and the squad
 * wipe condition ("nobody standing" — downed counts as not standing).
 *
 * Run: node tools/medical-test.mjs
 */

import {
  createDownedRegistry,
  DOWN_BLEED_S, REVIVE_RANGE_M, REVIVE_HOLD_S, REVIVE_HP_FRAC, WIPE_RESPAWN_S,
} from '../src/systems/medical.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const T0 = 1_000_000;

check('constants are the tuned co-op values',
  DOWN_BLEED_S === 30 && REVIVE_RANGE_M === 3.5 && REVIVE_HOLD_S === 2
  && REVIVE_HP_FRAC === 0.5 && WIPE_RESPAWN_S === 5);

const reg = createDownedRegistry();
reg.down('p1', 10, 20, T0);
check('down registers the player and position', reg.isDown('p1')
  && reg.posOf('p1').x === 10 && reg.posOf('p1').z === 20);
check('clear unregisters', !(() => { reg.down('p2', 0, 0, T0); reg.clear('p2'); return reg.isDown('p2'); })());

// revive range: inside 3.5 (+0.5 grace) yes, outside no
check('canRevive accepts the 3.5 m ring (+ grace)',
  reg.canRevive('p1', { x: 13, z: 20 }, T0 + 1000)     // 3.0 m
  && reg.canRevive('p1', { x: 13.8, z: 20 }, T0 + 1000) // 3.8 m — inside grace
  && !reg.canRevive('p1', { x: 15, z: 20 }, T0 + 1000)); // 5.0 m — too far
check('canRevive rejects a cleared target', !reg.canRevive('p2', { x: 0, z: 0 }, T0));

// bleed-out: exactly 30 s still alive, 30.001 s expired and swept
check('bleed-out keeps the player revivable just inside 30 s',
  reg.canRevive('p1', { x: 10, z: 20 }, T0 + DOWN_BLEED_S * 1000 - 1));
const expired = reg.expired(T0 + (DOWN_BLEED_S + 0.5) * 1000);
check('expired sweeps past the 30 s clock', expired.includes('p1') && !reg.isDown('p1'));

// wipe: nobody standing among 2+ humans
const w = createDownedRegistry();
w.down('a', 0, 0, T0);
w.down('b', 5, 5, T0);
check('wipe: two downed players = squad wiped',
  w.isWipe([{ id: 'a', alive: true }, { id: 'b', alive: true }]));
check('wipe: downed + dead = squad wiped too',
  w.isWipe([{ id: 'a', alive: true }, { id: 'b', alive: false }]));
check('wipe: one teammate still standing = fight on',
  !w.isWipe([{ id: 'a', alive: true }, { id: 'b', alive: true }, { id: 'c', alive: true }]));
w.clear('a');
check('wipe: downed counts as NOT standing after their revive is cleared',
  !w.isWipe([{ id: 'a', alive: true }, { id: 'b', alive: true }]));
check('wipe: a lone operator never triggers it (just bleeds out)',
  !w.isWipe([{ id: 'a', alive: true }]) && !w.isWipe([]));

process.exit(failures ? 1 : 0);
