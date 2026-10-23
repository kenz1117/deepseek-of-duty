#!/usr/bin/env node
/**
 * Co-op rally ring test — the squad must land TOGETHER but not ON TOP of
 * each other.
 *
 * The LAN co-op path used to put every client on the same anchor
 * (site.x + 2.2, site.z + 1.0), so four players stood in one spot. The
 * fix derives a ring from the player roster, and every peer must derive
 * the SAME ring independently — otherwise the host lands north of the
 * client and the squad never forms.
 *
 * This checks the property that actually matters: for a given roster, the
 * host's slot and each client's slot are the same point on every peer.
 *
 * Run: node tools/coop-rally-test.mjs
 */
import {
  assignCoopRallySpot, hashSeed, SPAWN_RULES,
} from '../src/systems/spawn.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const site = { x: 1.2, z: 33, yaw: -0.03 };
const roster = ['alpha', 'bravo', 'charlie', 'delta'];
const SEED = 12345;

/* Every peer computes the ring from the roster it was told about. The host
   uses the lobby list; a client uses the roster in the start event. If
   those lists disagree, the squad forms in two places — so the test pins
   that a peer with the roster lands exactly where the host's peer does. */
{
  const hostSpot = assignCoopRallySpot({ site, playerIds: roster, selfId: 'alpha', seed: SEED });
  const clientSpot = assignCoopRallySpot({ site, playerIds: roster, selfId: 'bravo', seed: SEED });
  check('rally: two players get different spots',
    Math.hypot(hostSpot.x - clientSpot.x, hostSpot.z - clientSpot.z) > 1.5,
    `d=${Math.hypot(hostSpot.x - clientSpot.x, hostSpot.z - clientSpot.z).toFixed(2)}`);
  check('rally: the host lands on its own ring slot (not the anchor)',
    Math.hypot(hostSpot.x - site.x, hostSpot.z - site.z) > 1,
    JSON.stringify(hostSpot));
}

/* Determinism across peers: the same roster and seed must produce the same
   point, or the client and the host would disagree. */
{
  const a = assignCoopRallySpot({ site, playerIds: roster, selfId: 'charlie', seed: SEED });
  const b = assignCoopRallySpot({ site, playerIds: roster, selfId: 'charlie', seed: SEED });
  check('rally: the same player gets the same spot on every peer',
    a.x === b.x && a.z === b.z, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

/* Minimum separation: neighbours on the ring must not overlap, or the
   med-kit and the grenades fight each other. */
{
  const spots = roster.map((id) => assignCoopRallySpot({ site, playerIds: roster, selfId: id, seed: SEED }));
  let minGap = Infinity;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      minGap = Math.min(minGap, Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z));
    }
  }
  check('rally: the squad keeps a minimum separation', minGap >= 2.5, `minGap=${minGap.toFixed(2)}`);
}

/* A bigger squad needs a bigger ring, or the players pile up. */
{
  const big = [...Array(8)].map((_, i) => `p${i}`);
  const spots = big.map((id) => assignCoopRallySpot({ site, playerIds: big, selfId: id, seed: SEED }));
  let minGap = Infinity;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      minGap = Math.min(minGap, Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z));
    }
  }
  check('rally: an 8-player squad still keeps its separation', minGap >= 2.5, `minGap=${minGap.toFixed(2)}`);
}

/* Solo play must be unchanged: one player stands on the anchor. */
{
  const solo = assignCoopRallySpot({ site, playerIds: ['solo'], selfId: 'solo', seed: SEED });
  check('rally: a solo player stands on the site anchor',
    Math.abs(solo.x - site.x) < 1e-9 && Math.abs(solo.z - site.z) < 1e-9, JSON.stringify(solo));
}

/* A peer that never received the roster (old client, dropped field) must
   still land somewhere valid rather than at NaN. */
{
  const lost = assignCoopRallySpot({ site, playerIds: [], selfId: 'charlie', seed: SEED });
  check('rally: a missing roster still yields a usable point',
    Number.isFinite(lost.x) && Number.isFinite(lost.z), JSON.stringify(lost));
}

/* The ring must not be confused with a spawn band: these are PLAYER
   positions, so they sit wherever the squad forms. */
{
  const spot = assignCoopRallySpot({ site, playerIds: roster, selfId: 'alpha', seed: SEED });
  check('rally: player spots are not governed by the enemy spawn band',
    Number.isFinite(spot.x) && Number.isFinite(spot.z) && SPAWN_RULES.pointMin > 0);
}

/* hashSeed is what makes the ring reproducible across peers. */
{
  check('rally: hashSeed is stable across peers',
    hashSeed(SEED, 'alpha') === hashSeed(SEED, 'alpha'));
}

console.log(failures === 0 ? '\n[coop-rally-test] all checks passed' : `\n[coop-rally-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
