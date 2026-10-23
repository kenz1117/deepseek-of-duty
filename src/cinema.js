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

  /* OP 05 — Hassan, the deputy, talks before the shield escort dismounts.
     STAGE: the south yard (南院车场, z 55.8–82.2). The old shot stood on
     the main street 40 m away, so the reveal happened nowhere the player was. */
  hassan_intro: {
    duration: 8.6,
    fadeIn: 0.6,
    fadeOut: 0.8,
    actors: [
      { variant: 2, archetype: 'shield', x: -6, z: 66, yaw: Math.PI, pose: 'walk', walk: true, scale: 1.16 },
      { variant: 0, archetype: 'rifleman', x: -8, z: 66, yaw: Math.PI, pose: 'aim' },
      { variant: 0, archetype: 'rifleman', x: -4, z: 66, yaw: Math.PI, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [-6.4, 2.9, 57.5], look: [-6, 1.45, 65.8] },
      { t: 4.4, pos: [-6.2, 1.95, 60.5], look: [-6, 1.45, 65.9] },
      { t: 8.6, pos: [-6.0, 1.78, 62.6], look: [-6, 1.40, 66.0] },
    ],
    lines: [
      { t: 0.4, speaker: '哈桑', voice: 'hassan_1', text: 'VEGA 的人？车场是我哈桑的地盘。你走不出去。' },
      { t: 5.2, speaker: 'VEGA', voice: 'hassan_vega', text: '哈桑在车上——解决他，别让他把货带走。' },
    ],
  },

  /* OP 09 — Karim, inside the north HQ office. */
  karim_intro: {
    duration: 10.4,
    fadeIn: 0.5,
    fadeOut: 0.7,
    actors: [
      { variant: 2, archetype: 'shield', x: 12.1, z: -68.6, yaw: Math.PI, pose: 'aim', scale: 1.22 },
      { variant: 0, archetype: 'rifleman', x: 8.0, z: -73.0, yaw: 0, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [10.5, 2.5, -73.8], look: [12.0, 1.75, -68.4] },
      { t: 4.2, pos: [10.4, 1.95, -71.4], look: [12.1, 1.7, -68.5] },
      { t: 10.4, pos: [10.9, 1.8, -70.4], look: [12.2, 1.65, -68.6] },
    ],
    lines: [
      { t: 0.4, speaker: '卡里姆', voice: 'karim_1', text: '灰狼。你进了我的楼，就别想再出去。' },
      { t: 4.4, speaker: 'VEGA', voice: 'op9_3b', text: '桌上那份命令是手写的——灰狼进入街区后，不要拦截，让他到北楼来。他一直在放你走。' },
      { t: 7.8, speaker: 'VEGA', voice: 'op9_2', text: '卡里姆出来了——这次是真的。' },
    ],
  },

  /* OP 11 — the old souk: minaret, awnings, narrow lanes. Silent camera tour. */
  souk_intro: {
    duration: 9.0,
    fadeIn: 0.7,
    fadeOut: 0.8,
    actors: [
      { variant: 0, archetype: 'rifleman', x: -84.0, z: 26.0, yaw: 1.4, pose: 'walk', walk: true },
      { variant: 1, archetype: 'rifleman', x: -80.0, z: 18.0, yaw: 2.2, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [-104, 4.6, 54], look: [-74, 3.2, 12] },
      { t: 4.5, pos: [-94, 2.6, 44], look: [-74, 2.3, 14] },
      { t: 9.0, pos: [-86, 1.9, 36], look: [-76, 1.8, 18] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', text: '老城。五百年的巷子，两米宽的门洞。', silent: true },
      { t: 5.0, speaker: '灰狼', voice: 'op3_5', text: '他们在屋顶架了枪。我从摊位下面过去。' },
    ],
  },

  /* OP 12 — the railhead at night. */
  rail_intro: {
    duration: 9.0,
    fadeIn: 0.7,
    fadeOut: 0.8,
    actors: [
      { variant: 2, archetype: 'rifleman', x: 2.0, z: -160.0, yaw: 0.2, pose: 'walk', walk: true },
      { variant: 0, archetype: 'rifleman', x: -3.0, z: -150.0, yaw: 0.8, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [0, 5.2, -188], look: [0, 3.0, -150] },
      { t: 4.5, pos: [0.5, 3.0, -176], look: [0, 2.4, -142] },
      { t: 9.0, pos: [0.2, 2.0, -164], look: [0.4, 1.8, -138] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', text: '北站。站台比街面高四米，仓库能藏下一整列货车。', silent: true },
      { t: 5.0, speaker: 'MOTH', voice: 'op6_4', text: '热源从站台两侧接近。一个在集装箱后面。' },
    ],
  },

  /* OP 13 — container yard in the storm. */
  port_intro: {
    duration: 9.0,
    fadeIn: 0.7,
    fadeOut: 0.8,
    actors: [
      { variant: 1, archetype: 'rifleman', x: 88.0, z: -60.0, yaw: -0.8, pose: 'aim' },
      { variant: 0, archetype: 'rifleman', x: 92.0, z: -52.0, yaw: -0.6, pose: 'walk', walk: true },
    ],
    camera: [
      { t: 0, pos: [68, 6.5, -94], look: [96, 4.0, -44] },
      { t: 4.5, pos: [76, 3.4, -82], look: [98, 2.8, -44] },
      { t: 9.0, pos: [84, 2.1, -70], look: [100, 2.0, -46] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', text: '港区。龙门吊停在半空，舱单一半对不上船期。', silent: true },
      { t: 5.0, speaker: '灰狼', voice: 'op7_5', text: '起重机上有反光。我先上高台。' },
    ],
  },

  /* OP 14 — the last crane at dawn. */
  finale2_intro: {
    duration: 10.0,
    fadeIn: 0.8,
    fadeOut: 1.0,
    actors: [
      { variant: 2, archetype: 'shield', x: 98.0, z: -44.0, yaw: Math.PI, pose: 'aim', scale: 1.2 },
      { variant: 0, archetype: 'rifleman', x: 92.0, z: -48.0, yaw: Math.PI, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [86, 5.8, -74], look: [98, 2.2, -44] },
      { t: 5.0, pos: [92, 3.0, -60], look: [98, 2.0, -44] },
      { t: 10.0, pos: [96, 2.0, -52], look: [98, 1.9, -44] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', voice: 'op14_2', text: '他在用卡里姆的频率。卡里姆死了，接线的人还在替他把货装船。' },
      { t: 5.4, speaker: 'MOTH', voice: 'op14_3', text: '热源在吊臂下面。三个，还有一个在船上。' },
    ],
  },

  ending2: {
    duration: 12.0,
    fadeIn: 1.0,
    fadeOut: 1.8,
    actors: [
      { variant: 0, archetype: 'rifleman', x: 94.0, z: -36.0, yaw: -2.4, pose: 'walk', walk: true },
    ],
    camera: [
      { t: 0, pos: [96, 7.5, -44], look: [122, 2.0, -20] },
      { t: 6.0, pos: [100, 4.2, -38], look: [122, 1.8, -24] },
      { t: 12.0, pos: [104, 2.2, -30], look: [122, 1.6, -18] },
    ],
    lines: [
      { t: 0.8, speaker: 'VEGA', voice: 'end_1', text: '吊臂停了。船离港的时候，天刚亮。' },
      { t: 5.4, speaker: '灰狼', voice: 'end_2', text: '货没上船。三箱文件，两箱在我们手里。' },
      { t: 8.0, speaker: 'VEGA', voice: 'end_3', text: '让他到北楼来——那是他的命令。现在他死了。北楼那台没人应答的电台，第二次响了。' },
    ],
  },

  /* OP 07 — the decoy steps off the APC at the north gate. STAGE: the north
     checkpoint (北检查站, z −96…−66). This scene used to reuse OP05's south-yard
     camera verbatim, so the "commander" surfaced a hundred metres away. */
  boss_reveal: {
    duration: 9.5,
    fadeIn: 0.6,
    fadeOut: 0.8,
    actors: [
      { variant: 2, archetype: 'shield', x: 0, z: -86, yaw: 0, pose: 'walk', walk: true, scale: 1.16 },
      { variant: 0, archetype: 'rifleman', x: -4, z: -86, yaw: 0, pose: 'aim' },
      { variant: 0, archetype: 'rifleman', x: 4, z: -86, yaw: 0, pose: 'aim' },
    ],
    camera: [
      { t: 0, pos: [-1.8, 2.85, -76.5], look: [0, 1.55, -85.6] },
      { t: 4.5, pos: [0.4, 1.95, -79.6], look: [0, 1.50, -85.6] },
      { t: 9.5, pos: [1.0, 1.80, -82.2], look: [0, 1.45, -85.7] },
    ],
    lines: [
      { t: 0.4, speaker: 'VEGA', voice: 'boss_1', text: '指挥车停了。重装护卫先下车——别被他们的盾骗了。' },
      { t: 4.2, speaker: 'VEGA', voice: 'boss_2', text: '正面打不穿，绕后，或者打头。' },
      { t: 7.6, speaker: 'VEGA', voice: 'boss_3', text: '指挥官在最后。解决他，这条街就结束了。' },
    ],
  },

  /* Finale — dust settles, the squad pulls out. STAGE: the east dock
     (东码头, x 30–46 / z −92…−70), where OP10's truck actually is. */
  finale: {
    duration: 12,
    fadeIn: 1.0,
    fadeOut: 1.6,
    actors: [
      { variant: 0, archetype: 'rifleman', x: 36, z: -84, yaw: 0.6, pose: 'walk', walk: true },
      { variant: 1, archetype: 'rifleman', x: 40, z: -88, yaw: 0.9, pose: 'walk', walk: true },
    ],
    camera: [
      { t: 0, pos: [36.0, 2.70, -90.5], look: [43.0, 1.80, -83.5] },
      { t: 6, pos: [37.2, 2.10, -88.8], look: [43.5, 1.65, -82.5] },
      { t: 12, pos: [38.6, 1.85, -87.0], look: [44.5, 1.55, -81.5] },
    ],
    lines: [
      { t: 0.6, speaker: 'VEGA', voice: 'fin_4', text: '卡里姆没死在北楼。他上了卡车，从东码头跑了。' },
      { t: 4.4, speaker: '灰狼', voice: 'fin_6', text: '那批货呢？' },
      { t: 7.4, speaker: 'VEGA', voice: 'fin_5', text: '还在。撤离清单上写着三箱文件——他们会回来拿。' },
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
    if (!played && !line.silent) speak(`${line.speaker || 'VEGA'}。${line.text || ''}`);
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
