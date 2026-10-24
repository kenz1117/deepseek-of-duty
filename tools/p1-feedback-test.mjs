#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeInput } from '../src/net/lanProtocol.js';
import { sanitizeSettings } from '../src/core/settings.js';

const input = makeInput({ speed: 4.2, crouch: 1, ads: 0.75, weapon: 'm4' });
assert.equal(input.speed, 4.2);
assert.equal(input.crouch, 1);
assert.equal(input.ads, 0.75);
assert.equal(input.weapon, 'm4');
assert.equal(makeInput({ speed: -2, crouch: 4, ads: Infinity }).speed, 0);
assert.equal(makeInput({ crouch: 4 }).crouch, 1);
assert.equal(makeInput({ ads: Infinity }).ads, 0);

const defaults = sanitizeSettings();
assert.equal(defaults.lensEffects, true);
assert.equal(defaults.highContrast, false);
assert.equal(sanitizeSettings({ lensEffects: false, highContrast: true }).lensEffects, false);
assert.equal(sanitizeSettings({ highContrast: true }).highContrast, true);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.js');
const avatar = read('src/entities/netRemote.js');
const post = read('src/core/postfx.js');
const hud = read('src/ui/hud.js');
const html = read('index.html');
const css = read('src/style.css');

assert.match(main, /team: G\.versusMode \? \(p\.team \?\? 0\) : null/);
assert.match(main, /speed: controller\.state\.speedMs/);
assert.match(main, /crouch: controller\.state\.crouching \? 1 : 0/);
assert.match(main, /speed: r\.speed, crouch: r\.crouch, aim: r\.ads/);
assert.match(main, /engine\.post\.setLensEffects\(G\.settings\.lensEffects\)/);
assert.match(avatar, /emissiveIntensity: 0\.22/);
assert.match(avatar, /deathT \+ step \* 3\.8/);
assert.match(avatar, /label\.visible = alive/);
assert.match(avatar, /crouch: THREE\.MathUtils\.clamp/);
assert.match(post, /setLensEffects\(enabled\)/);
assert.match(post, /state\.lensEffects \? state\.grain : 0/);
assert.match(post, /state\.grain = nq\.grain; state\.ca = nq\.ca/);
assert.match(hud, /bindSwitch\('set-lensEffects', 'lensEffects'\)/);
assert.match(hud, /bindSwitch\('set-highContrast', 'highContrast'\)/);
assert.match(html, /id="set-lensEffects"/);
assert.match(html, /id="set-highContrast"/);
assert.match(css, /html\.high-contrast #hud/);

console.log('[p1-feedback] protocol, settings and presentation wiring passed');
