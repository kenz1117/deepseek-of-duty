/* =========================================================================
   Recorded voice lines (MiniMax speech-02-hd).

   Casting: VEGA = male-qn-badao-jingpin (speed 1.30, pitch -3) — low, clipped
   commander; 灰狼 = male-qn-jingying-jingpin (speed 1.25, pitch -1) — younger
   operator. The two sit ~20 Hz apart in median F0 so they read as different
   people on radio. Hassan (deputy) = Unrestrained_Young_Man at 1.12x, the
   convoy dispatcher = Radio_Host at 1.35x (clipped, compressed). Audio is stored as real MP3 (the API returns hex, not b64).

   Voice prints (median F0, measured from the recordings themselves with an
   autocorrelation pass — this is how a new line is matched to a character):

     VEGA       ~90-103 Hz   male-qn-badao-jingpin     1.30 / -3
     灰狼       ~123 Hz      male-qn-jingying-jingpin  1.25 / -1
     哈桑       ~80 Hz       Unrestrained_Young_Man    1.12 / -2
     DISPATCH   ~131 Hz      Radio_Host                1.35 / -1
     卡里姆     ~90-98 Hz    Reliable_Executive         0.95 / -3
     MOTH       ~222 Hz      Chinese (Mandarin)_Crisp_Girl  1.0 / 0   (measured 210)

   The files live in public/audio/voice and are generated once; every line has
   a stable id so the story data only stores `voice: 'op2_1'`. If a file is
   missing or playback fails, the cinema falls back to browser TTS — the game
   never goes silent-and-stuck because of an asset. The browser fallback reads
   the entry's `text` field and is voiced per speaker (see SPEAKER_PROFILE),
   so a line without a recording still sounds like its character.
   ========================================================================= */

const BASE = '/audio/voice/';

/* The casting table, as data. tools/gen-voices.mjs reads it, so a line is
 * always regenerated with the same voice it was cast with. The voice prints
 * (median F0) in the header comment are the reference each new line is
 * matched against.
 */
export const VOICE_CAST = {
  VEGA: { voice_id: 'male-qn-badao-jingpin', speed: 1.30, pitch: -3 },
  灰狼: { voice_id: 'male-qn-jingying-jingpin', speed: 1.25, pitch: -1 },
  哈桑: { voice_id: 'Chinese (Mandarin)_Unrestrained_Young_Man', speed: 1.12, pitch: -2 },
  卡里姆: { voice_id: 'Chinese (Mandarin)_Reliable_Executive', speed: 0.95, pitch: -3 },
  MOTH: { voice_id: 'Chinese (Mandarin)_Crisp_Girl', speed: 1.0, pitch: 0 },
  DISPATCH: { voice_id: 'Chinese (Mandarin)_Radio_Host', speed: 1.35, pitch: -1 },
};

/* Browser-TTS fallback profiles. When a line has no recording yet, the game
 * still speaks it — but in the character's register, so a missing mp3 reads
 * as "same radio, new transmission" instead of a different narrator. */
const SPEAKER_PROFILE = {
  VEGA: { rate: 1.3, pitch: 0.35 },
  灰狼: { rate: 1.25, pitch: 0.55 },
  哈桑: { rate: 1.12, pitch: 0.5 },
  卡里姆: { rate: 0.95, pitch: 0.3 },
  MOTH: { rate: 1.0, pitch: 0.62 },
  DISPATCH: { rate: 1.35, pitch: 0.7 },
};

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
  op3_4: { file: 'op3_4.mp3', speaker: 'VEGA' },
  op3_5: { file: 'op3_5.mp3', speaker: '灰狼' },
  op3_6: { file: 'op3_6.mp3', speaker: 'VEGA' },
  op6_3: { file: 'op6_3.mp3', speaker: 'VEGA' },
  op6_4: { file: 'op6_4.mp3', speaker: 'MOTH' },
  op7_4: { file: 'op7_4.mp3', speaker: 'VEGA' },
  op7_5: { file: 'op7_5.mp3', speaker: '灰狼' },
  op7_6: { file: 'op7_6.mp3', speaker: 'VEGA' },
  op9_3: { file: 'op9_3.mp3', speaker: 'VEGA' },
  op9_4: { file: 'op9_4.mp3', speaker: 'MOTH' },
  op9_5: { file: 'op9_5.mp3', speaker: 'VEGA' },
  op9_6: { file: 'op9_6.mp3', speaker: '灰狼' },
  stage_clear: { file: 'stage_clear.mp3', speaker: 'VEGA' },
  cmd_disembark: { file: 'cmd_disembark.mp3', speaker: 'VEGA' },
  cmd_down: { file: 'cmd_down.mp3', speaker: 'VEGA' },
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
  zone_warning: { file: 'zone_warning.mp3', speaker: 'VEGA', text: '毒圈将在十五秒后开始收缩，立即向安全区转移。' },

  /* ---- campaign rewrite lines (2026-10-23 narrative pass).
     These ids have NO recording yet: the `text` field is what the browser
     TTS fallback speaks, so subtitle and voice stay in sync until the mp3s
     are re-recorded. Marked 待补录 in docs/CAMPAIGN-NARRATIVE-REVIEW.md. */
  op2_3: { file: 'op2_3.mp3', speaker: 'VEGA', text: '补给到手就撤。他们会在巷子里设拦截线。' },
  op5_5: { file: 'op5_5.mp3', speaker: '灰狼', text: '车里没有指挥官。只有一张北门通行令——他往北去了。' },
  op6_1b: { file: 'op6_1b.mp3', speaker: 'VEGA', text: '守住检查站六十秒。别让他们碰到闸门——指挥官就在车队里。' },
  dispatch_4: { file: 'dispatch_4.mp3', speaker: 'DISPATCH', text: '指挥官车队已就位，重复，已就位。' },
  op8_1b: { file: 'op8_1b.mp3', speaker: 'VEGA', text: '北门还开着。卡里姆要自己冲出来——把门夺下来。' },
  op9_3b: { file: 'op9_3b.mp3', speaker: 'VEGA', text: '桌上那份命令是手写的——灰狼进入街区后，不要拦截，让他到北楼来。他一直在放你走。' },
  op10_1: { file: 'op10_1.mp3', speaker: 'VEGA', text: '卡里姆上了卡车。但货没跟着走——撤离清单上那批货还在城里。' },
  fin_4: { file: 'fin_4.mp3', speaker: 'VEGA', text: '卡里姆没死在北楼。他上了卡车，从东码头跑了。' },
  fin_5: { file: 'fin_5.mp3', speaker: 'VEGA', text: '还在。撤离清单上写着三箱文件——他们会回来拿。' },
  fin_6: { file: 'fin_6.mp3', speaker: '灰狼', text: '那批货呢？' },
  op12_1: { file: 'op12_1.mp3', speaker: 'MOTH', text: '他们的频道有杂音。信号在北边和东边同时出现。' },
  op14_2: { file: 'op14_2.mp3', speaker: 'VEGA', text: '他在用卡里姆的频率。卡里姆死了，接线的人还在替他把货装船。' },
  op14_3: { file: 'op14_3.mp3', speaker: 'MOTH', text: '热源在吊臂下面。三个，还有一个在船上。' },
  end_1: { file: 'end_1.mp3', speaker: 'VEGA', text: '吊臂停了。船离港的时候，天刚亮。' },
  end_2: { file: 'end_2.mp3', speaker: '灰狼', text: '货没上船。三箱文件，两箱在我们手里。' },
  end_3: { file: 'end_3.mp3', speaker: 'VEGA', text: '让他到北楼来——那是他的命令。现在他死了。北楼那台没人应答的电台，第二次响了。' },
  boss_down_hassan: { file: 'boss_down_hassan.mp3', speaker: 'VEGA', text: '哈桑死了。到死一个字都没说。' },
  boss_down_decoy: { file: 'boss_down_decoy.mp3', speaker: 'VEGA', text: '车上那个不是他。真的指挥官已经进北楼了。' },
  karim_down: { file: 'karim_down.mp3', speaker: '卡里姆', text: '你以为你在追我？让他到北楼来——那句话，是我写的。' },
  boss_down_salim: { file: 'boss_down_salim.mp3', speaker: 'VEGA', text: '电台安静了。船不会开。' },
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

  function speakFallback(text, speaker) {
    if (!text || typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      const p = SPEAKER_PROFILE[speaker] || { rate: 1.05, pitch: 0.6 };
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = p.rate;
      u.pitch = p.pitch;
      u.volume = Math.max(0.2, Math.min(1, volume));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* optional */ }
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
      let fellBack = false;
      const onFail = () => {
        if (fellBack) return;
        fellBack = true;
        el = null;
        speakFallback(line.text, line.speaker);
      };
      el.onerror = onFail;
      const p = el.play();
      if (p && p.catch) p.catch(onFail);
      return true;
    } catch (e) {
      speakFallback(line.text, line.speaker);
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
