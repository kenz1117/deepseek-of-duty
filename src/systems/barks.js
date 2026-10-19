/* =========================================================================
 * BARKS — hostile voice callouts.
 *
 * Design rule borrowed from shooters that do this well: a bark must tell the
 * player something they can act on *now* (a grenade is coming, a flank is
 * opening), arrive before the action, and never spam. So:
 *
 *   • one squad-level cooldown per kind, not per soldier,
 *   • a subtitle always matches the audio cue,
 *   • the audio is synthesized radio chatter (squelch + formant bursts), not
 *     VO: the project ships no enemy voice assets, and fake words would be
 *     worse than a clean "enemy radio" cue + readable subtitle.
 *
 * If real VO is recorded later, `say()` is the single injection point: replace
 * `audio.enemyBark` with a clip lookup and keep the subtitles as they are.
 * ========================================================================= */

const LINES = {
  contact:  ['发现目标！', '那边有人！', '接敌！'],
  frag:     ['手雷——散开！', '投弹！', '小心手雷！'],
  flash:    ['闪光弹！闭眼！', '闪光！'],
  smoke:    ['放烟！', '烟幕掩护！'],
  breach:   ['破门！', '把门踹开！'],
  flank:    ['我从侧面上去！', '包抄他！'],
  suppress: ['压制住他！', '别让他抬头！'],
  down:     ['有人倒了！', '失去一个兄弟！'],
};

const COOLDOWN = {
  contact: 6500,
  frag: 8000,
  flash: 8000,
  smoke: 10000,
  breach: 9000,
  flank: 8500,
  suppress: 9000,
  down: 9000,
};

import * as THREE from 'three';

const _right = new THREE.Vector3();

export function createBarks({ hud, audio, camera, enabled = true } = {}) {
  let on = !!enabled;
  const last = Object.create(null);
  const pickIndex = Object.create(null);
  let sayCount = 0;
  let seq = 1;

  /** Stereo pan for a world position, using the camera's right vector. */
  function panFor(pos) {
    if (!pos || !camera) return 0;
    const dx = pos.x - camera.position.x;
    const dz = pos.z - camera.position.z;
    const len = Math.hypot(dx, dz) || 1;
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    return Math.max(-1, Math.min(1, (dx / len) * _right.x + (dz / len) * _right.z));
  }

  function distanceTo(pos) {
    if (!pos || !camera) return 0;
    return Math.hypot(pos.x - camera.position.x, pos.z - camera.position.z);
  }

  /**
   * Say a line if its squad cooldown has elapsed.
   * @returns {boolean} whether it actually played
   */
  function say(kind, pos, opts = {}) {
    if (!on) return false;
    const lines = LINES[kind];
    if (!lines) return false;
    const now = performance.now();
    const cd = opts.force ? 0 : (COOLDOWN[kind] || 8000);
    if (now - (last[kind] || -1e9) < cd) return false;
    last[kind] = now;
    const i = (pickIndex[kind] | 0) % lines.length;
    pickIndex[kind] = i + 1;
    const text = lines[i];
    const pan = panFor(pos);
    const dist = pos ? distanceTo(pos) : 12;
    if (audio && audio.enemyBark) audio.enemyBark(pan, dist, (seq = (seq * 73 + kind.length * 17) % 9973));
    if (hud && hud.bark) hud.bark(text, opts.who || '敌军');
    sayCount++;
    return true;
  }

  function reset() {
    for (const k of Object.keys(last)) delete last[k];
    sayCount = 0;
  }

  return {
    say, reset, panFor,
    setEnabled(v) { on = !!v; },
    get count() { return sayCount; },
  };
}
