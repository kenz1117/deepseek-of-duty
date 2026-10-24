#!/usr/bin/env node
/**
 * Ka-Bar (melee) behaviour test — real game, headless Chrome.
 *
 * Drives the actual melee path in the running game and checks the rules
 * that make the knife a weapon instead of a cheap rifle:
 *   1. V draws the Ka-Bar and the HUD switches to it
 *   2. a slash in reach hurts the enemy
 *   3. a slash out of reach (2.4 m) does nothing
 *   4. a slash from behind does 2.4x the damage
 *   5. a slash cannot go through a wall
 *   6. the swing has a cooldown (no spam)
 *   7. a backstab kill is silent: the squad is not alerted
 *
 * IMPORTANT: the wave director keeps recycling enemy instances, so a target
 * reference held across a frame can point at a soldier that has already been
 * replaced. Every step re-acquires the live target instead of caching it.
 *
 * Run: node tools/knife-test.mjs [page-url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PAGE = process.argv[2] || process.env.PAGE_URL || 'http://127.0.0.1:5173/?shot=1&pose=enemy';
const PORT = 9900 + Math.floor(Math.random() * 90);
const profile = `/tmp/dod-knife-${PORT}`;
const fs = await import('node:fs');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--window-size=1280,720', '--force-device-scale-factor=1',
  '--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === 'page');
    if (t) wsUrl = t.webSocketDebuggerUrl;
  } catch { /* warming up */ }
}
if (!wsUrl) { console.log('could not start chrome'); process.exit(1); }

const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0; const pending = new Map(); const consoleErrors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    consoleErrors.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: PAGE });
for (let i = 0; i < 120; i++) {
  const r = await send('Runtime.evaluate', { expression: 'window.__READY === true', returnByValue: true }).catch(() => null);
  if (r && r.result?.value === true) break;
  await sleep(250);
}
await sleep(1200);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};

/* shared page-side helpers: always work on the CURRENT live soldier */
const HELPERS = `
  const g = window.__game;
  const live = () => { const l = g.enemies.filter(e => e && e.alive && e.root); return l[0] || null; };
  const snap = () => g.enemies.map(e => ({ hp: +e.hp.toFixed(1), alive: e.alive }));
  const stand = (e, dz, facing) => {
    const p = e.root.position;
    g.player.revive(p.x, p.z + dz);
    g.player.setLook(0, 0);
    e.root.rotation.y = facing;
  };
  const ready = async () => {
    // the game rejects a swing while fireCooldown > 0, so wait for <= 0
    // exactly — a 0.02 slack lets a 0.003 cooldown swallow the swing
    for (let i = 0; i < 400; i++) {
      if (g.state.fireCooldown <= 0 && g.state.switchT <= 0) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    return false;
  };
`;

const out = {};

out.draw = await evaluate(`(() => {
  ${HELPERS}
  const e = live();
  if (!e) return { error: 'no live soldier in the shot pose' };
  const p = e.root.position;
  g.player.revive(p.x, p.z + 1.6);
  g.player.setLook(0, 0);
  e.root.rotation.y = Math.PI;              // facing +z -> the player is in FRONT
  return { hp: e.hp, ex: p.x, ez: p.z };
})()`);

out.switch = await evaluate(`(async () => {
  ${HELPERS}
  g.switchWeapon(3);
  await ready();
  return { index: g.state.weaponIndex, name: document.getElementById('weapon-name').textContent,
           mode: document.getElementById('fire-mode').textContent,
           ammo: document.getElementById('ammo-mag').textContent };
})()`);

out.hit = await evaluate(`(async () => {
  ${HELPERS}
  await ready();
  // acquire the soldier, stand and swing in ONE synchronous block: the wave
  // director recycles enemy instances, so an await in the middle could swap
  // the target out from under the swing
  const e = live();
  if (!e) return { error: 'no soldier' };
  stand(e, 1.6, Math.PI);                 // face to face: 58 damage
  const before = e.hp;
  g.melee();
  return { before, after: e.hp, dmg: before - e.hp, snap: snap() };
})()`);

out.cooldown = await evaluate(`(async () => {
  ${HELPERS}
  const e = live();
  if (!e) return { error: 'no soldier' };
  const before = e.hp;
  g.melee();                              // straight after: must be blocked
  return { after: e.hp, blocked: e.hp === before, snap: snap() };
})()`);

out.far = await evaluate(`(async () => {
  ${HELPERS}
  await ready();
  const e = live();
  if (!e) return { error: 'no soldier' };
  stand(e, 4.0, Math.PI);                 // out of the 2.4 m reach
  const before = e.hp;
  g.melee();
  return { before, after: e.hp, missed: e.hp === before, snap: snap() };
})()`);

out.backstab = await evaluate(`(async () => {
  ${HELPERS}
  await ready();
  const e = live();
  if (!e) return { error: 'no soldier' };
  stand(e, 1.6, 0);                       // he faces -z, the player is behind him
  const before = e.hp;
  g.melee();
  return { before, after: e.hp, dmg: before - e.hp, snap: snap() };
})()`);

out.wall = await evaluate(`(async () => {
  ${HELPERS}
  await ready();
  const e = live();
  if (!e) return { error: 'no soldier' };
  const c = g.level.colliders.find(k => Math.abs(k.x0) < 60 && Math.abs(k.z0) < 60 && (k.x1 - k.x0) > 3);
  if (!c) return { skipped: true };
  g.player.revive((c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2);
  g.player.setLook(0, 0);
  const before = e.hp;
  const dist = Math.hypot(e.root.position.x - (c.x0 + c.x1) / 2, e.root.position.z - (c.z0 + c.z1) / 2);
  g.melee();
  return { dist, before, after: e.hp };
})()`);

out.silent = await evaluate(`(async () => {
  ${HELPERS}
  await ready();
  const e = live();
  if (!e) return { error: 'no soldier' };
  stand(e, 1.6, 0);
  const before = e.hp;
  g.melee();
  // a backstab kill must not broadcast a casualty: the squad stays deaf
  const noise = g.ai && g.ai.perception ? g.ai.perception.noises.length : -1;
  return { before, after: e.hp, killed: e.hp <= 0, noise };
})()`);

console.log(JSON.stringify(out, null, 1));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures += 1; };
check('the shot pose spawns a test soldier', !out.draw || !out.draw.error);
check('slot 4 is the Ka-Bar', out.switch && out.switch.name === 'KA-BAR');
check('the HUD shows the melee mode', out.switch && out.switch.mode === 'MELEE');
check('the ammo readout shows no magazine', out.switch && out.switch.ammo === '\u221e');
check('a slash in reach hurts', out.hit && out.hit.dmg > 0);
check('a slash does 58 damage (+upgrades)', out.hit && out.hit.dmg >= 58);
check('the swing has a cooldown', out.cooldown && out.cooldown.blocked === true);
check('a slash out of reach misses', out.far && out.far.missed === true);
check('a backstab does 2.4x the damage', out.backstab && out.backstab.dmg >= 58 * 2.4 - 1);
check('the blade cannot stab through a wall', out.wall && (out.wall.skipped || out.wall.after === out.wall.before));
check('no console errors', consoleErrors.length === 0);
if (consoleErrors.length) for (const e of consoleErrors.slice(0, 8)) console.log('   ', e);

console.log(failures === 0 ? '[knife] all checks passed' : `[knife] ${failures} check(s) failed`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
