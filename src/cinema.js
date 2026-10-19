import * as THREE from 'three';
import { buildSoldier, applyPose } from './entities/soldierParts.js';

/* =========================================================================
   CINEMA — small in-engine cutscene player.

   Everything is procedural: the camera is a keyframe path, actors are the
   same soldier rig the enemies use (posed by hand, never AI-controlled), and
   dialogue is a subtitle queue with optional browser speech synthesis. No
   video, no external audio, no mocap.

   A scene looks like:
     { duration, camera: [{t,pos,look}], actors: [{x,z,yaw,variant,pose}],
       lines: [{t,speaker,text}], fadeIn, fadeOut }
   ========================================================================= */

export const SCENES = {
  /* OP 01 — an ally squad holds the corner while VEGA talks you in. */
  op01_intro: {
    duration: 16.0,
    fadeIn: 0.8,
    fadeOut: 0.9,
    actors: [
      { variant: 0, archetype: 'rifleman', x: 1.2, z: 20.2, yaw: Math.PI * 0.94, pose: 'aim' },
      { variant: 1, archetype: 'rifleman', x: -2.4, z: 18.0, yaw: Math.PI * 0.78, pose: 'walk', walk: true },
      { variant: 2, archetype: 'rifleman', x: 4.2, z: 16.2, yaw: Math.PI * 1.1, pose: 'crouch' },
    ],
    camera: [
      { t: 0, pos: [5.6, 2.7, 30.5], look: [1.0, 1.9, 19] },
      { t: 5.8, pos: [3.0, 2.15, 27.5], look: [0.2, 1.8, 18] },
      { t: 10.4, pos: [1.2, 1.9, 25.0], look: [0.8, 1.72, 17] },
      { t: 16.0, pos: [0.2, 1.78, 23.4], look: [2.4, 1.62, 14] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', voice: 'op01_1', text: '灰狼，能听到吗？这里是 VEGA。街区已经失守，整条防线只剩你还在推进。' },
      { t: 6.8, speaker: 'VEGA', voice: 'op01_2', text: '我们的人在路口顶着。你从南边切进去，先把街面清出来。' },
      { t: 10.5, speaker: 'VEGA', voice: 'op01_3', text: '记住：别在开阔地停留。他们的狙击手喜欢屋顶。' },
    ],
  },

  /* OP 05 — Hassan, the deputy, talks before the shield escort dismounts. */
  hassan_intro: {
    duration: 8.6,
    fadeIn: 0.6,
    fadeOut: 0.8,
    actors: [
      { variant: 2, archetype: 'shield', x: 1.6, z: 16.5, yaw: 0, pose: 'walk', walk: true, scale: 1.16 },
      { variant: 0, archetype: 'rifleman', x: -2.6, z: 18.5, yaw: 0, pose: 'aim' },
      { variant: 0, archetype: 'rifleman', x: 4.4, z: 19.0, yaw: 0, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [0.2, 3.2, 30], look: [0.4, 1.35, 17] },
      { t: 4.4, pos: [0.6, 1.9, 24.5], look: [1.4, 1.45, 16.5] },
      { t: 8.6, pos: [0.9, 1.72, 22.0], look: [1.7, 1.45, 16] },
    ],
    lines: [
      { t: 0.4, speaker: '哈桑', voice: 'hassan_1', text: 'VEGA 的人？车场是我哈桑的地盘。你走不出去。' },
      { t: 5.2, speaker: 'VEGA', voice: 'hassan_vega', text: '哈桑在车上——解决他，别让他把货带走。' },
    ],
  },

  /* OP 05/07/09 — the armoured boss steps off the APC. */

  boss_reveal: {
    duration: 9.5,
    fadeIn: 0.6,
    fadeOut: 0.8,
    actors: [
      { variant: 2, archetype: 'shield', x: 1.6, z: 16.5, yaw: 0, pose: 'walk', walk: true, scale: 1.16 },
      { variant: 0, archetype: 'rifleman', x: -2.6, z: 18.5, yaw: 0, pose: 'aim' },
      { variant: 0, archetype: 'rifleman', x: 4.4, z: 19.0, yaw: 0, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [0.2, 3.2, 30], look: [0.4, 1.35, 17] },
      { t: 4.5, pos: [0.6, 1.9, 24.5], look: [1.4, 1.45, 16.5] },
      { t: 9.5, pos: [0.9, 1.72, 22.0], look: [1.7, 1.45, 16] },
    ],
    lines: [
      { t: 0.4, speaker: 'VEGA', voice: 'boss_1', text: '指挥车停了。重装护卫先下车——别被他们的盾骗了。' },
      { t: 4.2, speaker: 'VEGA', voice: 'boss_2', text: '正面打不穿，绕后，或者打头。' },
      { t: 7.6, speaker: 'VEGA', voice: 'boss_3', text: '指挥官在最后。解决他，这条街就结束了。' },
    ],
  },

  /* Finale — dust settles, the squad pulls out. */
  finale: {
    duration: 12,
    fadeIn: 1.0,
    fadeOut: 1.6,
    actors: [
      { variant: 0, archetype: 'rifleman', x: -1.4, z: 30, yaw: Math.PI * 0.2, pose: 'walk', walk: true },
      { variant: 1, archetype: 'rifleman', x: 2.2, z: 31.5, yaw: Math.PI * 0.15, pose: 'walk', walk: true },
    ],
    camera: [
      { t: 0, pos: [0.8, 2.6, 40], look: [0, 1.7, 28] },
      { t: 6, pos: [2.6, 2.0, 34], look: [-1.2, 1.5, 24] },
      { t: 12, pos: [5.5, 3.2, 28], look: [-2.0, 1.2, 16] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', voice: 'fin_1', text: '指挥官倒了。车队正在撤离，这一区暂时安全。' },
      { t: 4.8, speaker: '灰狼', voice: 'fin_2', text: '暂时。' },
      { t: 7.2, speaker: 'VEGA', voice: 'fin_3', text: '对，暂时。上车吧，我们还有下一座城。' },
    ],
  },
};

export function createCinema({ engine, viewmodel, hud, voice }) {
  let scene = null;
  let t = 0;
  let playing = false;
  let onDone = null;
  let voiceOn = true;
  let spoken = -1;
  let actors = [];
  const _look = new THREE.Vector3();
  const _pos = new THREE.Vector3();

  const el = {
    root: document.getElementById('cinema'),
    speaker: document.getElementById('cine-speaker'),
    text: document.getElementById('cine-text'),
    skip: document.getElementById('cine-skip'),
  };

  function speak(text) {
    if (!voiceOn || !text) return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.95;
      u.pitch = 0.82;
      u.volume = 0.9;
      synth.speak(u);
    } catch (e) { /* speech is optional */ }
  }

  function stopVoice() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }

  function setupActors(defs) {
    actors = [];
    if (!defs || !engine) return;
    for (const a of defs) {
      const rig = buildSoldier(engine.mats, a.variant || 0, a.archetype || 'rifleman');
      rig.root.position.set(a.x || 0, a.y || 0, a.z || 0);
      rig.root.rotation.y = a.yaw || 0;
      if (a.scale) rig.root.scale.setScalar(a.scale);
      engine.scene.add(rig.root);
      actors.push({ def: a, rig, phase: Math.random() * 6 });
    }
  }

  function disposeActors() {
    for (const a of actors) {
      try {
        engine.scene.remove(a.rig.root);
        if (a.rig.dispose) a.rig.dispose();
      } catch (e) { /* ignore */ }
    }
    actors = [];
  }

  function poseActors(time) {
    for (const a of actors) {
      const d = a.def;
      const walking = !!d.walk;
      const crouch = d.pose === 'crouch' ? 0.55 : 0.1;
      const aim = d.pose === 'aim' ? 1 : (d.pose === 'walk' ? 0.35 : 0.2);
      applyPose(a.rig, {
        time: time + a.phase,
        crouch,
        walkAmp: walking ? 0.75 : 0,
        walkPhase: walking ? (time + a.phase) * 3.4 : 0,
        aim,
        weaponLevel: d.pose === 'aim' ? 1 : 0,
        aimPitch: -0.03,
        lookYaw: Math.sin(time * 0.5 + a.phase) * 0.12,
        flinch: 0,
        recoil: 0,
        limp: 0,
        headRoll: 0.03,
        deathSide: 1,
      });
    }
  }

  function updateCamera(time) {
    const keys = scene.camera || [];
    if (!keys.length) return;
    let a = keys[0], b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (time >= keys[i].t && time <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
    }
    const span = Math.max(0.0001, b.t - a.t);
    const f = Math.min(1, Math.max(0, (time - a.t) / span));
    const e = f * f * (3 - 2 * f);
    _pos.set(
      a.pos[0] + (b.pos[0] - a.pos[0]) * e,
      a.pos[1] + (b.pos[1] - a.pos[1]) * e,
      a.pos[2] + (b.pos[2] - a.pos[2]) * e
    );
    _look.set(
      a.look[0] + (b.look[0] - a.look[0]) * e,
      a.look[1] + (b.look[1] - a.look[1]) * e,
      a.look[2] + (b.look[2] - a.look[2]) * e
    );
    const cam = engine.camera;
    cam.position.copy(_pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
  }

  function showLine(index) {
    const line = (scene.lines || [])[index];
    if (!line) return;
    if (el.speaker) el.speaker.textContent = line.speaker || 'VEGA';
    if (el.text) el.text.textContent = line.text || '';
    const played = voice && line.voice ? voice.play(line.voice) : false;
    if (!played) speak(`${line.speaker || 'VEGA'}。${line.text || ''}`);
  }

  function play(id, done) {
    const s = SCENES[id];
    if (!s || !engine) { if (done) done(); return; }
    if (playing) finish();
    scene = s;
    t = 0;
    playing = true;
    spoken = -1;
    onDone = done || null;
    setupActors(s.actors);
    if (viewmodel) viewmodel.root.visible = false;
    el.root?.classList.remove('hidden');
    el.root?.setAttribute('aria-hidden', 'false');
    updateCamera(0);
    if (s.lines && s.lines.length) {
      // speak the first line as soon as it is due, not at t=0
      const first = s.lines[0];
      if (first && first.t <= 0.01) { spoken = 0; showLine(0); }
    }
  }

  function finish() {
    if (!playing) return;
    playing = false;
    stopVoice();
    if (voice) voice.stop();
    disposeActors();
    el.root?.classList.add('hidden');
    el.root?.setAttribute('aria-hidden', 'true');
    if (el.text) el.text.textContent = '';
    const done = onDone;
    onDone = null;
    scene = null;
    if (done) done();
  }

  function update(dt) {
    if (!playing || !scene) return 0;
    t += dt;
    updateCamera(t);
    poseActors(t);
    const lines = scene.lines || [];
    for (let i = spoken + 1; i < lines.length; i++) {
      if (t >= lines[i].t) { spoken = i; showLine(i); }
    }
    if (t >= (scene.duration || 10)) finish();
    return t;
  }

  function skip() { finish(); }

  el.skip?.addEventListener('click', (e) => { e.preventDefault(); skip(); });

  return {
    play, update, skip, finish,
    get playing() { return playing; },
    get time() { return t; },
    setVoice(v) { voiceOn = !!v; if (!voiceOn) stopVoice(); },
    get voice() { return voiceOn; },
  };
}
