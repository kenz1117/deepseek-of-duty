/* =========================================================================
   Recorded voice lines (MiniMax speech-02-hd).

   Casting: VEGA = male-qn-badao-jingpin (speed 1.30, pitch -3) — low, clipped
   commander; 灰狼 = male-qn-jingying-jingpin (speed 1.25, pitch -1) — younger
   operator. The two sit ~20 Hz apart in median F0 so they read as different
   people on radio. Hassan (deputy) = Unrestrained_Young_Man at 1.12x, the
   convoy dispatcher = Radio_Host at 1.35x (clipped, compressed). Audio is stored as real MP3 (the API returns hex, not b64).

   The files live in public/audio/voice and are generated once; every line has
   a stable id so the story data only stores `voice: 'op2_1'`. If a file is
   missing or playback fails, the cinema falls back to browser TTS — the game
   never goes silent-and-stuck because of an asset.
   ========================================================================= */

const BASE = '/audio/voice/';

export const VOICE_LINES = {
  op01_1: { file: 'op01_1.mp3', speaker: 'VEGA' },
  op01_2: { file: 'op01_2.mp3', speaker: 'VEGA' },
  op01_3: { file: 'op01_3.mp3', speaker: 'VEGA' },
  boss_1: { file: 'boss_1.mp3', speaker: 'VEGA' },
  boss_2: { file: 'boss_2.mp3', speaker: 'VEGA' },
  boss_3: { file: 'boss_3.mp3', speaker: 'VEGA' },
  fin_1: { file: 'fin_1.mp3', speaker: 'VEGA' },
  fin_2: { file: 'fin_2.mp3', speaker: '灰狼' },
  fin_3: { file: 'fin_3.mp3', speaker: 'VEGA' },
  op1_1: { file: 'op1_1.mp3', speaker: 'VEGA' },
  op1_2: { file: 'op1_2.mp3', speaker: 'VEGA' },
  op1_3: { file: 'op1_3.mp3', speaker: 'VEGA' },
  op2_1: { file: 'op2_1.mp3', speaker: 'VEGA' },
  op2_2: { file: 'op2_2.mp3', speaker: 'VEGA' },
  op3_1: { file: 'op3_1.mp3', speaker: 'VEGA' },
  op3_2: { file: 'op3_2.mp3', speaker: 'VEGA' },
  op3_3: { file: 'op3_3.mp3', speaker: 'VEGA' },
  op4_1: { file: 'op4_1.mp3', speaker: 'VEGA' },
  op4_2: { file: 'op4_2.mp3', speaker: 'VEGA' },
  op5_1: { file: 'op5_1.mp3', speaker: 'VEGA' },
  op5_2: { file: 'op5_2.mp3', speaker: 'VEGA' },
  op5_3: { file: 'op5_3.mp3', speaker: 'VEGA' },
  op5_4: { file: 'op5_4.mp3', speaker: 'VEGA' },
  op6_1: { file: 'op6_1.mp3', speaker: 'VEGA' },
  op6_2: { file: 'op6_2.mp3', speaker: 'VEGA' },
  op7_1: { file: 'op7_1.mp3', speaker: 'VEGA' },
  op7_2: { file: 'op7_2.mp3', speaker: 'VEGA' },
  op7_3: { file: 'op7_3.mp3', speaker: 'VEGA' },
  op8_1: { file: 'op8_1.mp3', speaker: 'VEGA' },
  op8_2: { file: 'op8_2.mp3', speaker: 'VEGA' },
  op9_1: { file: 'op9_1.mp3', speaker: 'VEGA' },
  op9_2: { file: 'op9_2.mp3', speaker: 'VEGA' },
  hassan_1: { file: 'hassan_1.mp3', speaker: '哈桑' },
  hassan_vega: { file: 'hassan_vega.mp3', speaker: 'VEGA' },
  dispatch_1: { file: 'dispatch_1.mp3', speaker: 'DISPATCH' },
  dispatch_2: { file: 'dispatch_2.mp3', speaker: 'DISPATCH' },
  dispatch_3: { file: 'dispatch_3.mp3', speaker: 'DISPATCH' },
  karim_1: { file: 'karim_1.mp3', speaker: '卡里姆' },
  karim_2: { file: 'karim_2.mp3', speaker: '卡里姆' },
  moth_1: { file: 'moth_1.mp3', speaker: 'MOTH' },
  moth_2: { file: 'moth_2.mp3', speaker: 'MOTH' },
  moth_3: { file: 'moth_3.mp3', speaker: 'MOTH' },
};

export function createVoice() {
  let enabled = true;
  let el = null;
  let volume = 0.9;

  function stop() {
    if (el) {
      try { el.pause(); } catch (e) { /* ignore */ }
      el = null;
    }
  }

  function play(id) {
    if (!enabled || !id) return false;
    const line = VOICE_LINES[id];
    if (!line) return false;
    stop();
    try {
      el = new Audio(BASE + line.file);
      el.preload = 'auto';
      el.volume = volume;
      const p = el.play();
      if (p && p.catch) p.catch(() => { el = null; });
      return true;
    } catch (e) {
      return false;
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) stop();
  }

  function setVolume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); if (el) el.volume = volume; }

  return {
    play, stop, setEnabled, setVolume,
    get enabled() { return enabled; },
  };
}
