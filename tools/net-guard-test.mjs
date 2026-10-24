#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createFixedStepper, SIM_STEP_S, MAX_SIM_STEPS } from '../src/core/timing.js';
import {
  isNewerSequence, isNewerSnapshot, movementAllowance,
  validFirePacket, validMovementPacket,
} from '../src/net/guards.js';
import { makeFire, makeInput } from '../src/net/lanProtocol.js';
import { WEAPONS } from '../src/core/weapons.js';

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

// 30/120 Hz rendering must produce the same 60 Hz simulation rate.
for (const hz of [30, 60, 120]) {
  const stepper = createFixedStepper();
  let ticks = 0;
  for (let i = 0; i < hz; i += 1) stepper.advance(1 / hz, () => { ticks += 1; });
  check(`fixed step: ${hz} Hz render -> 60 Hz simulation`, Math.abs(ticks - 60) <= 1);
}
{
  const stepper = createFixedStepper();
  let ticks = 0;
  stepper.advance(0.2, () => { ticks += 1; });
  check('fixed step: long frame catch-up is bounded', ticks === MAX_SIM_STEPS && stepper.pending < SIM_STEP_S);
}

check('sequence: monotonic packet accepted', isNewerSequence(8, 7));
check('sequence: duplicate/old packet rejected', !isNewerSequence(7, 7) && !isNewerSequence(6, 7));
check('snapshot: monotonic tick accepted', isNewerSnapshot(2, 1));
check('snapshot: new authority can reset local cursor', isNewerSnapshot(1, -1));

const remote = { x: 0, y: 0, z: 0, alive: true, moveEpoch: 0, lastInputAt: 10, lastInputSeq: 1 };
const move = { seq: 2, x: 0.3, y: 0, z: 0, yaw: 0, pitch: 0, moveEpoch: 0 };
check('movement: ordinary 20 Hz step accepted', validMovementPacket(move, remote, 10.05));
check('movement: teleport without redeploy rejected', !validMovementPacket({ ...move, x: 8 }, remote, 10.05));
check('movement: delayed packet gets bounded time allowance', movementAllowance(0.5) > movementAllowance(0.05));
check('movement: explicit redeploy accepted', validMovementPacket({ ...move, x: 80, moveEpoch: 1 }, remote, 10.05));
check('movement: old redeploy epoch rejected', !validMovementPacket({ ...move, moveEpoch: -1 }, remote, 10.05));
check('movement: stale sequence rejected', !validMovementPacket({ ...move, seq: 1 }, remote, 10.05));

const shooter = { x: 2, y: 0, z: 3, alive: true, lastFireSeq: -1, lastFireAt: -1e9 };
const fire = { seq: 4, ox: 2, oy: 1.68, oz: 3, dx: 0, dy: 0, dz: -1, fireRate: 1 };
check('fire: plausible shot accepted', validFirePacket(fire, shooter, 20, WEAPONS[0]));
check('fire: duplicate shot rejected', !validFirePacket(fire, { ...shooter, lastFireSeq: 4, lastFireAt: 20 }, 20.1, WEAPONS[0]));
check('fire: rapid-fire flood rejected', !validFirePacket({ ...fire, seq: 5 }, { ...shooter, lastFireSeq: 4, lastFireAt: 20 }, 20.01, WEAPONS[0]));
check('fire: legal cadence accepted', validFirePacket({ ...fire, seq: 5 }, { ...shooter, lastFireSeq: 4, lastFireAt: 20 }, 20.09, WEAPONS[0]));
check('fire: remote origin spoof rejected', !validFirePacket({ ...fire, ox: 20 }, shooter, 20, WEAPONS[0]));
check('fire: dead shooter rejected', !validFirePacket(fire, { ...shooter, alive: false }, 20, WEAPONS[0]));

check('protocol: redeploy epoch survives serialization', makeInput({ moveEpoch: 3 }).moveEpoch === 3);
check('protocol: fire-rate multiplier is bounded', makeFire({ fireRate: 99 }).fireRate === 3);

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
check('wiring: LAN menus continue fixed-step simulation', /netBackground = net\.started/.test(mainSrc) && /fixedStepper\.advance\(dt, updateGame\)/.test(mainSrc));
check('wiring: host applies movement/fire guards', /validMovementPacket\(msg, r, now\)/.test(mainSrc) && /validFirePacket\(msg, shooter/.test(mainSrc));
check('wiring: clients reject old snapshots', /isNewerSnapshot\(snap\.tick, net\.lastSnapshotTick\)/.test(mainSrc));

if (failures) {
  console.error(`[net-guard] ${failures} check(s) failed`);
  process.exit(1);
}
console.log('[net-guard] all checks passed');
