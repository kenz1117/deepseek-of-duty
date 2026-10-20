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
  regroup:  ['重组！', '换位置！', '走！撤到掩体！'],
  takingFire: ['被压制！', '火力太猛！'],
};

const VOICE_BASE = '/audio/voice/enemy/';
const VOICE_FILES = {
  contact:  ['contact_1.mp3', 'contact_2.mp3'],
  frag:     ['frag_1.mp3', 'frag_2.mp3'],
  flash:    ['flash_1.mp3'],
  smoke:    ['smoke_1.mp3'],
  breach:   ['breach_1.mp3'],
  flank:    ['flank_1.mp3'],
  suppress: ['suppress_1.mp3'],
  down:     ['down_1.mp3'],
  regroup:  ['regroup_1.mp3'],
  takingFire: ['taking_fire_1.mp3'],
};

const COOLDOWN = {
  contact: 6500,
  frag: 8000,
  flash: 8000,
  smoke: 10000,
  breach: 9000,
  flank: 8500,
  suppress: 9000,
  down: 7000,
  regroup: 9000,
  takingFire: 7500,
};

import * as THREE from 'three';

const _right = new THREE.Vector3();

export function createBarks({ hud, audio, camera, enabled = true } = {}) {
  let on = !!enabled;
  const last = Object.create(null);
  const pickIndex = Object.create(null);
  const buffers = new Map();
  let sayCount = 0;
  let seq = 1;
  let preloaded = false;

  /** Decode the bark clips once the audio context exists (after START). */
  function preload() {
    if (preloaded || !audio || !audio.loadBuffer || !audio.ctx) return;
    preloaded = true;
    for (const files of Object.values(VOICE_FILES)) {
      for (const f of files) {
        const url = VOICE_BASE + f;
        audio.loadBuffer(url).then((buf) => { if (buf) buffers.set(url, buf); }).catch(() => {});
      }
    }
  }

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
    const files = VOICE_FILES[kind] || [];
    const fileUrl = files.length ? VOICE_BASE + files[i % files.length] : null;
    const buf = fileUrl ? buffers.get(fileUrl) : null;
    const gain = Math.max(0.2, Math.min(0.95, 1 - dist / 75));
    if (buf && audio.playBuffer) {
      audio.playBuffer(buf, { pan, gain, send: 0.18 });
    } else if (audio && audio.enemyBark) {
      // fallback until the clips decode (or if the files are missing)
      audio.enemyBark(pan, dist, (seq = (seq * 73 + kind.length * 17) % 9973));
    }
    if (hud && hud.bark) hud.bark(text, opts.who || '敌军');
    sayCount++;
    return true;
  }

  function reset() {
    for (const k of Object.keys(last)) delete last[k];
    sayCount = 0;
  }

  return {
    say, reset, panFor, preload,
    setEnabled(v) { on = !!v; },
    get count() { return sayCount; },
    get ready() { return buffers.size; },
  };
}
