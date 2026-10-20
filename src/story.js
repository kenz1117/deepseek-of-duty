/* =========================================================================
   OPERATIONS — the campaign layer.

   Fourteen missions reuse the existing modes (survival / defend / extract) so the
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
    bossIntro: 'hassan_intro',
    bossName: '副官 · 哈桑',
    zoneLabel: '南院车场',
    threat: 'CRITICAL',
    brief: '副官的指挥车停在南院。抓住他，问出指挥官的位置。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op5_1', text: '车场里停着副官的指挥车。哈桑就在车上——别让他跑了。' },
      { at: 2, speaker: 'VEGA', voice: 'op5_2', text: '他们把重装部队调过来了。找掩体，别硬顶。' },
      { at: 3, speaker: 'VEGA', voice: 'op5_3', text: '哈桑下车了——重甲，正面打不动。绕后，或者打头。' },
      { at: 4, speaker: 'VEGA', voice: 'op5_4', text: '副官死了。搜他的车——我要知道指挥官在哪。' },
    ],
    debrief: '哈桑到死没开口。车里只有一张北门通行令——指挥官在北边。',
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
      { at: 'start', speaker: 'DISPATCH', voice: 'dispatch_1', text: '北门车队，两分钟内到闸口，把路让开。' },
      { at: 2, speaker: 'VEGA', voice: 'op6_2', text: '他们从后墙翻进来了。别让任何人靠近闸门。' },
    ],
    debrief: '车队被拦下了。指挥官没走成——他退进了北楼。',
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
    bossName: '指挥官替身',
    zoneLabel: '北检查站',
    threat: 'CRITICAL',
    brief: '指挥官在北门露了面。这一次，别让他再离开。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op7_1', text: '北门传来消息——指挥官本人出现了。这次别让他再离开。' },
      { at: 'start', speaker: 'DISPATCH', voice: 'dispatch_3', text: '指挥官车队已过北门，重复，已过北门。' },
      { at: 2, speaker: 'VEGA', voice: 'op7_2', text: '重装部队下车了。撑住。' },
      { at: 3, speaker: 'VEGA', voice: 'op7_3', text: '他下车了——重甲。解决他。' },
    ],
    debrief: '不对。这是个替身。真的指挥官已经进了北楼。',
  },
  {
    id: 8,
    code: 'OP 08',
    name: '北门',
    en: 'NORTH GATE',
    mode: 'extract',
    waves: 2,
    atmosphere: 'storm',
    zone: { x: 0, z: -88, r: 7.0 },
    zoneLabel: '北门',
    threat: 'CRITICAL',
    brief: '暴雨里北门还开着。清空检查站，把门夺下来。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op8_1', text: '北门还开着。清空检查站，把门夺下来——别让车队出去。' },
      { at: 2, speaker: 'VEGA', voice: 'op8_2', text: '车队想冲门。守住闸口。' },
    ],
    debrief: '门夺下来了。指挥官被堵在北楼里，跑不掉。',
  },
  {
    id: 9,
    code: 'OP 09',
    name: '北楼',
    en: 'NORTH HQ',
    mode: 'survival',
    waves: 2,
    atmosphere: 'bluehour',
    start: { x: 10.4, z: -77.4, yaw: Math.PI },
    spawnRect: { x0: 6.1, x1: 14.9, z0: -75, z1: -65 },
    bossWave: 2,
    bossIntro: 'karim_intro',
    bossSpawn: { x: 12.1, z: -68.6 },
    bossName: '指挥官 · 卡里姆',
    bossHp: 760,
    bossScale: 1.22,
    zoneLabel: '北楼',
    threat: 'CRITICAL',
    brief: '卡里姆在北楼里。破门进去，结束这一切。',
    radio: [
      { at: 'start', speaker: 'MOTH', voice: 'moth_1', text: '无人机在你头顶。北楼里有两个热源，一个在办公室。' },
      { at: 'start', speaker: 'VEGA', voice: 'op9_1', text: '他在北楼里，身边只剩卫队。结束这件事。' },
      { at: 2, speaker: 'VEGA', voice: 'op9_2', text: '卡里姆出来了——这次是真的。' },
    ],
    debrief: '卡里姆倒在办公室里。北楼的电台还在响，但已经没人回答了。',
  },
  {
    id: 10,
    code: 'OP 10',
    name: '余烬',
    en: 'EMBER',
    mode: 'extract',
    waves: 1,
    atmosphere: 'storm',
    start: { x: 40.0, z: -84.0, yaw: Math.PI },
    zone: { x: 43.5, z: -81.0, r: 4.5 },
    zoneLabel: '东码头',
    threat: 'CRITICAL',
    brief: '从东码头撤出去。车队的残部还在外面。',
    radio: [
      { at: 'start', speaker: 'MOTH', voice: 'moth_2', text: '东码头有一辆卡车，钥匙在驾驶室。动作快。' },
      { at: 'start', speaker: 'VEGA', voice: 'fin_1', text: '指挥官倒了。车队正在撤离，这一区暂时安全。' },
    ],
    debrief: '卡车开出码头。后视镜里，北楼的火还在烧。',
    outro: 'finale',
  },
  {
    id: 11,
    code: 'OP 11',
    name: '老城',
    en: 'THE SOUK',
    mode: 'survival',
    waves: 3,
    atmosphere: 'dusk',
    start: { x: -96, z: 46, yaw: 1.7 },
    spawnRect: { x0: -116, x1: -40, z0: -42, z1: 72 },
    intro: 'souk_intro',
    zoneLabel: '老城集市',
    threat: 'HIGH',
    brief: '车队退进老城。穿过集市，把他们的前哨清掉。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '离开码头之后，车队把货转进了老城。窄巷、棚顶、两层铺面——别走直线。', voice: 'op3_4' },
      { at: 2, speaker: '灰狼', text: '他们在屋顶架了枪。我从摊位下面过去。', voice: 'op3_5' },
      { at: 3, speaker: 'VEGA', text: '集市清空，北站的门就开了。', voice: 'op3_6' },
    ],
    debrief: '集市安静下来。北边的货场整夜亮着灯。',
  },
  {
    id: 12,
    code: 'OP 12',
    name: '北站',
    en: 'RAILHEAD',
    mode: 'defend',
    waves: 2,
    atmosphere: 'night',
    hold: 60,
    start: { x: 0, z: -155, yaw: Math.PI },
    spawnRect: { x0: -38, x1: 42, z0: -194, z1: -106 },
    zone: { x: 4, z: -150, r: 7 },
    intro: 'rail_intro',
    zoneLabel: '北站货场',
    threat: 'SEVERE',
    brief: '守住站台下的调度台 60 秒，让车队拿不到那批弹药。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '北站整夜都在卸货。站台高、仓库深，别让他们把你压进死角。', voice: 'op6_3' },
      { at: 2, speaker: 'MOTH', text: '热源从站台两侧接近。一个在集装箱后面。', voice: 'op6_4' },
    ],
    debrief: '调度台还在我们手里。港区的吊臂开始转动，船在等货。',
  },
  {
    id: 13,
    code: 'OP 13',
    name: '港区',
    en: 'CONTAINER YARD',
    mode: 'extract',
    waves: 3,
    atmosphere: 'storm',
    start: { x: 80, z: -80, yaw: 3.7 },
    spawnRect: { x0: 48, x1: 122, z0: -98, z1: 34 },
    zone: { x: 98, z: -44, r: 6 },
    intro: 'port_intro',
    zoneLabel: '东港集装箱场',
    threat: 'CRITICAL',
    brief: '穿过集装箱阵，把撤离点从车队手里抢下来。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '港区是他们的最后一站。集装箱之间只有几条缝，手雷会比子弹先到。', voice: 'op7_4' },
      { at: 2, speaker: '灰狼', text: '起重机上有反光。我先去清高台。', voice: 'op7_5' },
      { at: 3, speaker: 'VEGA', text: '撤离点就在吊臂下面。别让他们把货装船。', voice: 'op7_6' },
    ],
    debrief: '吊臂停了。指挥官还在港区，他知道船走不了。',
  },
  {
    id: 14,
    code: 'OP 14',
    name: '最后一吊',
    en: 'LAST CRANE',
    mode: 'survival',
    waves: 4,
    atmosphere: 'bluehour',
    start: { x: 80, z: -80, yaw: 3.6 },
    spawnRect: { x0: 48, x1: 122, z0: -98, z1: 34 },
    bossWave: 3,
    bossIntro: 'finale2_intro',
    bossSpawn: { x: 98, z: -44 },
    bossName: '指挥官 · 萨利姆',
    bossHp: 900,
    bossScale: 1.2,
    outro: 'ending2',
    zoneLabel: '东港 · 起重机',
    threat: 'CRITICAL',
    brief: '萨利姆在吊臂下。结束这条线，我们才能离开这座城。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '萨利姆就在吊臂下面。他把最后的货和人全压在这一场。', voice: 'op9_3' },
      { at: 2, speaker: 'MOTH', text: '港区外围有热源在集结。他们会从水边绕过来。', voice: 'op9_4' },
      { at: 3, speaker: 'VEGA', text: '萨利姆出来了——重甲，和卡里姆一样。打头，或者绕后。', voice: 'op9_5' },
      { at: 4, speaker: '灰狼', text: '结束了。让船开走。', voice: 'op9_6' },
    ],
    debrief: '吊臂停在半空。船离港的时候，天刚亮。',
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
