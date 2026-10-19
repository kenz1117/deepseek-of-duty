/* =========================================================================
   OPERATIONS — the campaign layer.

   Five missions reuse the existing modes (survival / defend / extract) so the
   leaderboard, objectives and wave director keep working untouched. What a
   mission adds: a fixed mode + length, an atmosphere, radio traffic, and an
   optional boss beat. Progress is local, like the rest of the single-player
   meta (dod.campaign.v1).
   ========================================================================= */

export const OPERATIONS = [
  {
    id: 1,
    code: 'OP 01',
    name: '抵达',
    en: 'ARRIVAL',
    mode: 'survival',
    waves: 3,
    atmosphere: 'dusk',
    intro: 'op01_intro',
    zoneLabel: 'AL-MAZRAH 街区',
    threat: 'HIGH',
    brief: '街区已失守。清出三条街，让后续车队能进来。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op1_1', text: '灰狼，这里是 VEGA。整条街只剩你还在推进，先清出一条路。' },
      { at: 2, speaker: 'VEGA', voice: 'op1_2', text: '敌方增援从南边压上来了。别在开阔地停留。' },
      { at: 3, speaker: 'VEGA', voice: 'op1_3', text: '最后一批。清完这条街，我们去市场。' },
    ],
    debrief: '街区打通了。车队会在十分钟后跟进——先去市场把补给拿到手。',
  },
  {
    id: 2,
    code: 'OP 02',
    name: '市场',
    en: 'THE MARKET',
    mode: 'defend',
    waves: 2,
    atmosphere: 'dusk',
    hold: 45,
    zone: { x: 20.8, z: -10.7, r: 3.6 },
    zoneLabel: '后院市场',
    threat: 'HIGH',
    brief: '市场里有我们需要的补给。守住摊位区 45 秒。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op2_1', text: '市场里有我们需要的补给。守住摊位区 45 秒，别让他们靠近。' },
      { at: 2, speaker: 'VEGA', voice: 'op2_2', text: '他们开始绕后了。盯住两个入口。' },
    ],
    debrief: '补给到手。下一站是后院货仓——他们在那藏了一台通讯车。',
  },
  {
    id: 3,
    code: 'OP 03',
    name: '后院',
    en: 'BACKLOT',
    mode: 'survival',
    waves: 3,
    atmosphere: 'storm',
    zoneLabel: '后院 · 货仓',
    threat: 'SEVERE',
    brief: '暴雨压住了他们的无人机。趁现在穿过后院，找通讯车。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op3_1', text: '暴雨把他们的无人机压在地面。趁现在，穿过后院。' },
      { at: 2, speaker: 'VEGA', voice: 'op3_2', text: '货仓里有他们的通讯设备。打掉它，我们就能听见他们的调度。' },
      { at: 3, speaker: 'VEGA', voice: 'op3_3', text: '通讯断了。南院的车队会来找你，做好准备。' },
    ],
    debrief: '通讯车报废，我们截到了一段调度。南院车场有一支车队正在集结。',
  },
  {
    id: 4,
    code: 'OP 04',
    name: '撤离',
    en: 'EXFIL',
    mode: 'extract',
    waves: 2,
    atmosphere: 'bluehour',
    zone: { x: -19.2, z: 3.0, r: 3.5 },
    zoneLabel: '公寓正门',
    threat: 'SEVERE',
    brief: '天黑之前离开这一区。清空街区，到公寓正门集合。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op4_1', text: '天黑之前必须离开这一区。清空街区，到公寓正门集合。' },
      { at: 2, speaker: 'VEGA', voice: 'op4_2', text: '撤离点已经标出来了。别恋战。' },
    ],
    debrief: '上车。最后一站，南院车场——他们的指挥官在那里。',
  },
  {
    id: 5,
    code: 'OP 05',
    name: '南院',
    en: 'THE YARD',
    mode: 'survival',
    waves: 4,
    atmosphere: 'dusk',
    bossWave: 3,
    bossIntro: 'boss_reveal',
    zoneLabel: '南院车场',
    threat: 'CRITICAL',
    brief: '指挥官在指挥车上。重甲护卫会先下车。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op5_1', text: '车场里停着他们的指挥车。指挥官就在车上。' },
      { at: 2, speaker: 'VEGA', voice: 'op5_2', text: '他们把重装部队调过来了。找掩体，别硬顶。' },
      { at: 3, speaker: 'VEGA', voice: 'op5_3', text: '指挥官下车了——重甲，正面打不动。绕后，或者打头。' },
      { at: 4, speaker: 'VEGA', voice: 'op5_4', text: '车队撤了。这一区，暂时是我们的。' },
    ],
    debrief: '指挥官阵亡，车队撤离。街区暂时安全——但这只是开始。',
  },
  {
    id: 6,
    code: 'OP 06',
    name: '检查站',
    en: 'CHECKPOINT',
    mode: 'defend',
    waves: 2,
    atmosphere: 'storm',
    hold: 60,
    zone: { x: 0, z: -82, r: 8.0 },
    zoneLabel: '北检查站',
    threat: 'CRITICAL',
    brief: '车队要从北门撤出。守住检查站 60 秒，别让他们碰到闸门。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op6_1', text: '检查站是我们的退路。守住它 60 秒，让车队通过。' },
      { at: 2, speaker: 'VEGA', voice: 'op6_2', text: '他们从后墙翻进来了。别让任何人靠近闸门。' },
    ],
    debrief: '车队通过了。最后一个坐标：南院车场。指挥官还在那里。',
  },
  {
    id: 7,
    code: 'OP 07',
    name: '终局',
    en: 'ENDGAME',
    mode: 'survival',
    waves: 3,
    atmosphere: 'bluehour',
    bossWave: 3,
    bossIntro: 'boss_reveal',
    outro: 'finale',
    zoneLabel: '北检查站',
    threat: 'CRITICAL',
    brief: '指挥官回到了车场。这一次，别让他再离开。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op7_1', text: '这是最后一战。指挥车在车场正中，四周都是他们的人。' },
      { at: 2, speaker: 'VEGA', voice: 'op7_2', text: '重装部队下车了。撑住。' },
      { at: 3, speaker: 'VEGA', voice: 'op7_3', text: '指挥官亲自来了——解决他，我们就能回家。' },
    ],
    debrief: '战斗结束。街区安静下来，只有风声和远处的火。',
  },
];

const STORE_KEY = 'dod.campaign.v1';

export function loadCampaign() {
  const fallback = { done: [0], selected: 1 };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    const done = Array.isArray(data.done)
      ? data.done.filter((n) => Number.isInteger(n) && n >= 1 && n <= OPERATIONS.length)
      : [];
    const selected = OPERATIONS.some((o) => o.id === data.selected) ? data.selected : 1;
    return { done: Array.from(new Set([0, ...done])), selected };
  } catch (e) {
    return fallback;
  }
}

export function saveCampaign(progress) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(progress));
  } catch (e) { /* private mode */ }
}

export function operationById(id) {
  return OPERATIONS.find((o) => o.id === id) || OPERATIONS[0];
}

export function isUnlocked(progress, id) {
  if (id <= 1) return true;
  return progress.done.includes(id - 1);
}

export function completeOperation(progress, id) {
  if (!progress.done.includes(id)) progress.done.push(id);
  saveCampaign(progress);
  return progress;
}
