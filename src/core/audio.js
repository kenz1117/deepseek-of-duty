/* =========================================================================
   Fully procedural audio engine (no samples shipped).
   Layered synthesis for weapons, impacts, foley, ambience + convolution reverb
   from a generated impulse response.
   ========================================================================= */

export function createAudio() {
  let ctx = null, master, comp, reverb, reverbSend, noiseBuf, ambientOn = false, lowHpOn = false;
  let lowHpTimer = null, ambientTimer = null, drone = null;
  let started = false;

  function init() {
    if (started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    started = true;

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;

    master = ctx.createGain();
    master.gain.value = 0.62;
    master.connect(comp).connect(ctx.destination);

    // generate impulse response (outdoor urban slap-back + long tail)
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const decay = Math.pow(1 - t, 2.6);
        const early = i < ctx.sampleRate * 0.09 ? (Math.random() > 0.985 ? 1.4 : 0.15) : 0.25;
        d[i] = (Math.random() * 2 - 1) * decay * early * 0.7;
      }
    }
    reverb = ctx.createConvolver();
    reverb.buffer = ir;
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.30;
    reverbSend.connect(reverb).connect(master);

    // white noise buffer
    const nlen = ctx.sampleRate * 3;
    noiseBuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    if (ctx.state === 'suspended') ctx.resume();
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  function chain(pan = 0, send = 0.2, gain = 1) {
    const g = ctx.createGain();
    g.gain.value = gain;
    let last = g;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      last = p;
    }
    last.connect(master);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      last.connect(s).connect(reverbSend);
    }
    return g;
  }

  function noise({ dur = 0.1, type = 'lowpass', f0 = 2000, f1 = 500, Q = 0.8, gain = 0.3, pan = 0, send = 0.15, delay = 0, rate = 1 }) {
    if (!ctx) return;
    const t = now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = rate;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type; filt.Q.value = Q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = chain(pan, send, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.008, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g);
    src.start(t); src.stop(t + dur + 0.02);
    src.onended = () => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) { } };
  }

  function tone({ type = 'sine', f0 = 200, f1 = 60, dur = 0.12, gain = 0.3, pan = 0, send = 0.1, delay = 0, curve = 0.012 }) {
    if (!ctx) return;
    const t = now() + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = chain(pan, send, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + curve);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    osc.start(t); osc.stop(t + dur + 0.02);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) { } };
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ---------------- weapons ---------------- */
  function gunshot(pan = 0) {
    if (!ctx) return;
    const v = rand(0.9, 1.1);
    // body
    noise({ dur: 0.085, type: 'lowpass', f0: 5200 * v, f1: 700, Q: 0.7, gain: 0.62, pan, send: 0.42 });
    // crack
    noise({ dur: 0.028, type: 'highpass', f0: 2400, f1: 5200, Q: 0.5, gain: 0.30, pan, send: 0.25, rate: 1.4 });
    // sub thump
    tone({ type: 'sine', f0: 130 * v, f1: 42, dur: 0.17, gain: 0.42, pan, send: 0.18 });
    // mechanical
    noise({ dur: 0.012, type: 'highpass', f0: 3200, f1: 2600, gain: 0.13, pan, send: 0.05, delay: 0.006 });
    // tail slap
    noise({ dur: 0.34, type: 'lowpass', f0: 900, f1: 180, gain: 0.11, pan, send: 0.7, delay: 0.02 });
  }

  function enemyShot(pan = 0, distance = 40) {
    if (!ctx) return;
    const d = Math.min(120, distance);
    const g = Math.max(0.03, 1 - d / 140) * 0.5;
    const delay = Math.min(0.35, d / 343);
    noise({ dur: 0.09, type: 'lowpass', f0: 3200, f1: 420, gain: g * 0.55, pan, send: 0.5, delay });
    tone({ type: 'sine', f0: 110, f1: 40, dur: 0.16, gain: g * 0.3, pan, send: 0.2, delay });
    noise({ dur: 0.25, type: 'lowpass', f0: 700, f1: 150, gain: g * 0.14, pan, send: 0.8, delay: delay + 0.02 });
  }

  function whiz(pan = 0) {
    noise({ dur: 0.13, type: 'bandpass', f0: 900, f1: 2600, Q: 6, gain: 0.14, pan, send: 0.15, rate: 1.2 });
  }

  function reload(stage = 'magOut') {
    if (!ctx) return;
    switch (stage) {
      case 'magOut':
        noise({ dur: 0.035, type: 'bandpass', f0: 2600, f1: 1400, Q: 3, gain: 0.20, send: 0.1 });
        tone({ type: 'square', f0: 210, f1: 90, dur: 0.045, gain: 0.05, send: 0.05 });
        break;
      case 'magIn':
        noise({ dur: 0.05, type: 'bandpass', f0: 1800, f1: 900, Q: 2.5, gain: 0.30, send: 0.18 });
        tone({ type: 'sine', f0: 160, f1: 70, dur: 0.08, gain: 0.18, send: 0.08 });
        break;
      case 'charge':
        noise({ dur: 0.09, type: 'bandpass', f0: 3200, f1: 1200, Q: 4, gain: 0.24, send: 0.12 });
        noise({ dur: 0.04, type: 'highpass', f0: 4200, f1: 3000, gain: 0.10, send: 0.05, delay: 0.03 });
        break;
      case 'bolt':
        noise({ dur: 0.07, type: 'bandpass', f0: 2400, f1: 900, Q: 3, gain: 0.22, send: 0.1 });
        noise({ dur: 0.03, type: 'highpass', f0: 3600, f1: 2800, gain: 0.12, send: 0.05, delay: 0.05 });
        break;
      default: break;
    }
  }

  function shell() {
    if (!ctx) return;
    noise({ dur: 0.055, type: 'bandpass', f0: 5200, f1: 3400, Q: 8, gain: 0.09, pan: rand(-0.3, 0.3), send: 0.12, delay: rand(0.22, 0.4) });
  }

  /* ---------------- impacts ---------------- */
  function impact(kind = 'concrete', pan = 0, gain = 1) {
    if (!ctx) return;
    if (kind === 'metal') {
      noise({ dur: 0.05, type: 'bandpass', f0: 4200, f1: 2600, Q: 4, gain: 0.13 * gain, pan, send: 0.2 });
      tone({ type: 'triangle', f0: rand(1800, 2600), f1: 900, dur: 0.09, gain: 0.05 * gain, pan, send: 0.1 });
      tone({ type: 'sine', f0: rand(900, 1200), f1: 500, dur: 0.16, gain: 0.035 * gain, pan, send: 0.1 });
    } else if (kind === 'flesh') {
      noise({ dur: 0.06, type: 'lowpass', f0: 900, f1: 260, gain: 0.13 * gain, pan, send: 0.08 });
      tone({ type: 'sine', f0: 120, f1: 60, dur: 0.07, gain: 0.09 * gain, pan, send: 0.05 });
    } else {
      noise({ dur: 0.045, type: 'bandpass', f0: 3000, f1: 1200, Q: 1.2, gain: 0.14 * gain, pan, send: 0.2 });
      noise({ dur: 0.2, type: 'lowpass', f0: 700, f1: 180, gain: 0.05 * gain, pan, send: 0.3 });
    }
  }

  function ricochet(pan = 0) {
    tone({ type: 'sawtooth', f0: rand(2400, 3600), f1: rand(600, 900), dur: 0.30, gain: 0.05, pan, send: 0.35 });
  }

  function explosion(pan = 0, distance = 20) {
    if (!ctx) return;
    const g = Math.max(0.1, 1 - distance / 90);
    noise({ dur: 1.1, type: 'lowpass', f0: 2200, f1: 90, gain: 0.55 * g, pan, send: 0.8 });
    tone({ type: 'sine', f0: 78, f1: 22, dur: 0.9, gain: 0.6 * g, pan, send: 0.4 });
    noise({ dur: 0.12, type: 'highpass', f0: 3600, f1: 1200, gain: 0.22 * g, pan, send: 0.5 });
  }

  /* ---------------- foley / feedback ---------------- */
  function footstep(surface = 'concrete', intensity = 1) {
    if (!ctx) return;
    const f = surface === 'metal' ? 2400 : 900;
    noise({ dur: 0.075, type: 'lowpass', f0: f, f1: 200, gain: 0.075 * intensity, pan: rand(-0.12, 0.12), send: 0.12 });
    if (surface === 'metal') noise({ dur: 0.04, type: 'bandpass', f0: 2800, f1: 1800, Q: 3, gain: 0.04 * intensity, send: 0.15 });
  }

  function hitmarker(headshot = false) {
    if (!ctx) return;
    tone({ type: 'square', f0: headshot ? 1900 : 1300, f1: headshot ? 1500 : 1000, dur: 0.035, gain: 0.055, send: 0.02 });
    if (headshot) tone({ type: 'sine', f0: 2800, f1: 2200, dur: 0.05, gain: 0.03, delay: 0.01, send: 0.02 });
  }

  function killConfirm() {
    if (!ctx) return;
    tone({ type: 'sine', f0: 190, f1: 110, dur: 0.09, gain: 0.10, send: 0.08 });
    tone({ type: 'triangle', f0: 2400, f1: 1800, dur: 0.05, gain: 0.028, send: 0.03, delay: 0.01 });
  }

  function ui() {
    tone({ type: 'sine', f0: 620, f1: 480, dur: 0.05, gain: 0.04, send: 0.02 });
  }
  function uiConfirm() {
    tone({ type: 'sine', f0: 480, f1: 720, dur: 0.09, gain: 0.05, send: 0.05 });
    tone({ type: 'sine', f0: 960, f1: 1200, dur: 0.07, gain: 0.02, delay: 0.05, send: 0.05 });
  }

  function death() {
    tone({ type: 'sine', f0: 90, f1: 30, dur: 1.4, gain: 0.35, send: 0.4 });
    noise({ dur: 1.2, type: 'lowpass', f0: 900, f1: 80, gain: 0.12, send: 0.5 });
  }

  function hurt() {
    noise({ dur: 0.18, type: 'lowpass', f0: 500, f1: 120, gain: 0.16, send: 0.1 });
    tone({ type: 'sine', f0: 70, f1: 40, dur: 0.25, gain: 0.12, send: 0.1 });
  }

  /* ---------------- ambience ---------------- */
  function ambient() {
    if (!ctx || ambientOn) return;
    ambientOn = true;
    // wind bed
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 420; filt.Q.value = 0.4;
    const g = ctx.createGain(); g.gain.value = 0.030;
    src.connect(filt).connect(g).connect(master);
    src.start();
    // slow swell
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.016;
    lfo.connect(lfoGain).connect(g.gain); lfo.start();

    // low drone
    drone = ctx.createOscillator();
    drone.type = 'sine'; drone.frequency.value = 46;
    const dg = ctx.createGain(); dg.gain.value = 0.016;
    drone.connect(dg).connect(master); drone.start();

    const battle = () => {
      if (!ambientOn) return;
      const pan = rand(-0.9, 0.9);
      const dist = rand(60, 140);
      const bursts = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < bursts; i++) {
        setTimeout(() => {
          if (!ctx) return;
          noise({ dur: 0.07, type: 'lowpass', f0: 1400, f1: 300, gain: 0.055, pan, send: 0.9, delay: rand(0, 0.05) });
          tone({ type: 'sine', f0: 90, f1: 35, dur: 0.22, gain: 0.035, pan, send: 0.5 });
        }, i * rand(90, 160));
      }
      ambientTimer = setTimeout(battle, rand(1800, 5200));
      void dist;
    };
    ambientTimer = setTimeout(battle, 900);
  }

  function setLowHealth(on) {
    if (!ctx) return;
    if (on && !lowHpOn) {
      lowHpOn = true;
      const beat = () => {
        if (!lowHpOn || !ctx) return;
        tone({ type: 'sine', f0: 62, f1: 34, dur: 0.16, gain: 0.16, send: 0.03 });
        setTimeout(() => tone({ type: 'sine', f0: 54, f1: 30, dur: 0.13, gain: 0.10, send: 0.03 }), 190);
        lowHpTimer = setTimeout(beat, 1150);
      };
      beat();
    } else if (!on && lowHpOn) {
      lowHpOn = false;
      clearTimeout(lowHpTimer);
    }
  }

  function stopAmbient() {
    ambientOn = false;
    clearTimeout(ambientTimer);
    if (drone) { try { drone.stop(); } catch (e) { } drone = null; }
  }

  function setMasterVolume(v) { if (master) master.gain.value = v; }

  return {
    init, gunshot, enemyShot, whiz, reload, shell, impact, ricochet,
    explosion, footstep, hitmarker, ui, uiConfirm, death, hurt, killConfirm,
    ambient, stopAmbient, setLowHealth, setMasterVolume,
    get ctx() { return ctx; },
  };
}
