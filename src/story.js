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
    /* The scripted campaign must own its geography. Without an explicit
       start/spawnRect the op inherits the rotating free-play district, so
       "OP05 南院" could be fought in the old souk. Every op pins both. */
    start: { x: 1.2, z: 33, yaw: -0.03 },
    spawnRect: { x0: -28, x1: 44, z0: -28, z1: 82 },
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
    waves: 4,
    atmosphere: 'dusk',
    hold: 45,
    zone: { x: 20.8, z: -10.7, r: 3.6 },
    zoneLabel: '后院市场',
    threat: 'HIGH',
    brief: '市场里有我们需要的补给。潜入、夺取、守住、带装备撤离。',
    start: { x: 8, z: -12, yaw: -Math.PI / 2 },
    spawnRect: { x0: -28, x1: 44, z0: -28, z1: 82 },
    /* Phase 3 beat chain: ghost the market (garrison patrol — killing is
       optional), seize the yard, hold it through a two-axis counterattack,
       then run the interceptors gauntlet back to the apartment gate. */
    beats: [
      { type: 'infil', name: '潜入', text: '潜入市场 · 别惊动守军', ai: 'garrison', enemies: 3,
        zone: { x: 20.8, z: -10.7, r: 4.2 }, hold: 2.5 },
      { type: 'assault', name: '夺取', text: '清空摊位区守军 · 占住后院', ai: 'assault', enemies: 5 },
      { type: 'defend', name: '驻守', text: '守住摊位区 45 秒 · 他们会从两个入口反扑', ai: 'assault', enemies: 6,
        zone: { x: 20.8, z: -10.7, r: 3.6 }, hold: 45 },
      { type: 'extract', name: '撤离', text: '带上补给 · 到公寓正门撤离', ai: 'interceptor', enemies: 4,
        zone: { x: -19.2, z: 3.0, r: 3.5 }, hold: 3 },
    ],
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op2_1', text: '市场里有我们需要的补给。守军还没进入警戒——能不开枪就别开枪。' },
      { at: 3, speaker: 'VEGA', voice: 'op2_2', text: '他们开始反扑了。盯住两个入口。' },
      { at: 4, speaker: 'VEGA', text: '补给到手就撤。他们会在巷子里设拦截线。', voice: 'op2_3' },
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
    start: { x: 16, z: -12, yaw: -Math.PI / 2 },
    spawnRect: { x0: -28, x1: 44, z0: -28, z1: 82 },
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
    start: { x: 2, z: -12, yaw: Math.PI / 2 },
    spawnRect: { x0: -28, x1: 44, z0: -28, z1: 82 },
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
    bossIntro: 'hassan_intro',
    bossName: '副官 · 哈桑',
    zoneLabel: '南院车场',
    threat: 'CRITICAL',
    brief: '副官的指挥车停在南院。搜车、顶住警卫、抓住哈桑。',
    start: { x: -8, z: 60, yaw: Math.PI },
    spawnRect: { x0: -24, x1: 24, z0: 50, z1: 82 },
    /* Phase 3: search the command car (interact) → the alarm trips and the
       yard guards rush in → Hassan enters WITH a shield escort (he resists
       half damage while the escort lives) and charges at half health → mop
       up. The spots are literal yard coordinates: the op pins its own start,
       so 'site' (the rotating free-play district) would move the car and the
       boss to whatever district the cursor happened to land on. */
    beats: [
      { type: 'interact', name: '搜索', text: '找到指挥车 · 搜出情报', label: '按住 E 搜查指挥车', spot: { x: -12, z: 66, r: 2.8 } },
      { type: 'assault', name: '暴露', text: '警报触发 · 清掉集结的卫队', ai: 'assault', enemies: 6 },
      { type: 'boss', name: '哈桑', text: '哈桑带卫队进场 · 击杀副官', ai: 'assault', enemies: 0,
        boss: { hp: 560, scale: 1.16, name: '副官 · 哈桑', spawn: { x: -6, z: 66 } } },
      { type: 'survival', name: '收尾', text: '清掉车场残部', ai: 'hunter', enemies: 4 },
    ],
    bossPhases: [
      { atHpFrac: 1, action: 'warden', escorts: 2, archetype: 'shield', resist: 0.5,
        radioText: '卫队贴着他——先拆盾，不然他扛伤。' },
      { atHpFrac: 0.5, action: 'charge', mult: 1.45,
        radioText: '哈桑急了——他冲过来了！' },
    ],
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op5_1', text: '车场里停着副官的指挥车。搜他的车——别让他跑了。' },
      { at: 2, speaker: '灰狼', voice: 'op5_5', text: '车里没有指挥官。只有一张北门通行令——他往北去了。' },
      { at: 2, speaker: 'VEGA', voice: 'op5_2', text: '警报响了。卫队全压上来了——找掩体，别硬顶。' },
      { at: 3, speaker: 'VEGA', voice: 'op5_3', text: '哈桑下车了——重甲，正面打不动。绕后，或者打头。' },
    ],
    debrief: '哈桑到死没开口。通行令上签的是卡里姆——他一直就在北边。',
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
    start: { x: 0, z: -76, yaw: 0 },
    spawnRect: { x0: -28, x1: 28, z0: -94, z1: -68 },
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op6_1b', text: '守住检查站六十秒。别让他们碰到闸门——指挥官就在车队里。' },
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
    /* The HUD must believe the same lie the radio does: before the kill the
       target reads as the commander, the reveal is the dialogue after it. */
    bossAlias: '指挥官 · 重甲',
    bossSpawn: { x: 0, z: -86 },
    zoneLabel: '北检查站',
    threat: 'CRITICAL',
    brief: '指挥官在北门露了面。这一次，别让他再离开。',
    start: { x: 0, z: -76, yaw: 0 },
    spawnRect: { x0: -28, x1: 28, z0: -94, z1: -68 },
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op7_1', text: '北门传来消息——指挥官本人出现了。这次别让他再离开。' },
      { at: 'start', speaker: 'DISPATCH', voice: 'dispatch_4', text: '指挥官车队已就位，重复，已就位。' },
      { at: 2, speaker: 'VEGA', voice: 'op7_2', text: '重装部队下车了。撑住。' },
      { at: 3, speaker: 'VEGA', voice: 'op7_3', text: '他下车了——重甲。解决他。' },
    ],
    debrief: '不对。这是个替身。真的指挥官退进了北楼——他打算自己从北门突围。',
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
    start: { x: 0, z: -78, yaw: 0 },
    spawnRect: { x0: -28, x1: 28, z0: -94, z1: -68 },
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op8_1b', text: '北门还开着。卡里姆要自己冲出来——把门夺下来。' },
      { at: 2, speaker: 'VEGA', voice: 'op8_2', text: '车队想冲门。守住闸口。' },
    ],
    debrief: '门夺下来了。卡里姆被关在北楼里，出不来了。',
  },
  {
    id: 9,
    code: 'OP 09',
    name: '北楼',
    en: 'NORTH HQ',
    mode: 'survival',
    waves: 3,
    atmosphere: 'bluehour',
    start: { x: 10.4, z: -77.4, yaw: Math.PI },
    spawnRect: { x0: 6.1, x1: 14.9, z0: -75, z1: -65 },
    bossIntro: 'karim_intro',
    bossName: '指挥官 · 卡里姆',
    zoneLabel: '北楼',
    threat: 'CRITICAL',
    brief: '卡里姆在北楼里。破门、逐房清理，在办公室找到那份命令——然后结束这一切。',
    /* Phase 3: breach & clear the ground floor room by room (garrison first,
       then hunters), then the Karim standoff: he relocates twice through the
       office floor (70% / 40% HP) and each move calls in reinforcements. */
    beats: [
      { type: 'assault', name: '破门', text: '破开大门 · 清一层守卫', ai: 'garrison', enemies: 4 },
      { type: 'assault', name: '清房', text: '逐房清理 · 向办公室推进', ai: 'hunter', enemies: 4 },
      { type: 'boss', name: '卡里姆', text: '办公室对峙 · 击杀卡里姆', ai: 'assault', enemies: 0,
        boss: { hp: 760, scale: 1.22, name: '指挥官 · 卡里姆', spawn: { x: 12.1, z: -68.6 } } },
    ],
    bossPhases: [
      { atHpFrac: 0.7, action: 'relocate', to: { x: 8.2, z: -69.0 }, reinforcements: 2,
        radioText: '卡里姆退进夹层了——追！' },
      { atHpFrac: 0.4, action: 'relocate', to: { x: 12.5, z: -72.5 }, reinforcements: 2,
        radioText: '他在作战室——最后一口气。' },
    ],
    radio: [
      { at: 'start', speaker: 'MOTH', voice: 'moth_1', text: '无人机在你头顶。北楼里有两个热源，一个在办公室。' },
      { at: 'start', speaker: 'VEGA', voice: 'op9_1', text: '他在北楼里，身边只剩卫队。结束这件事。' },
    ],
    debrief: '卡里姆倒在办公室里。桌上那份手写命令写着：「灰狼进入街区后，不要拦截。让他到北楼来。」这一路，他都在放你走。北楼的电台还在响，但已经没人回答了。',
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
    spawnRect: { x0: 30, x1: 46, z0: -92, z1: -70 },
    zone: { x: 43.5, z: -81.0, r: 4.5 },
    zoneLabel: '东码头',
    threat: 'CRITICAL',
    brief: '从东码头撤出去。车队的残部还在外面。',
    radio: [
      { at: 'start', speaker: 'VEGA', voice: 'op10_1', text: '卡里姆上了卡车。但货没跟着走——撤离清单上那批货还在城里。' },
      { at: 'start', speaker: 'MOTH', voice: 'moth_2', text: '东码头有一辆卡车，钥匙在驾驶室。动作快。' },
    ],
    debrief: '卡车开出码头。后视镜里，北楼的火还在烧。但清单上那批货还在城里——他们会回来拿。',
    /* The street arc's ending is a FALSE ending: the command escapes, the
       cargo does not. The final video is reserved for OP14. */
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
    /* The intro cutscene used to swallow the wave-1 radio (and those lines
       were silent), so the only explanation of why the campaign moves to the
       old souk never reached the player. Now the radio plays. */
    radioAtStart: true,
    zoneLabel: '老城集市',
    threat: 'HIGH',
    brief: '车队把货转进了老城。穿过集市，把他们的前哨清掉。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '离开码头之后，车队把货转进了老城。窄巷、棚顶、两层铺面——别走直线。', voice: 'op3_4' },
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
    radioAtStart: true,
    zoneLabel: '北站货场',
    threat: 'SEVERE',
    brief: '守住站台下的调度台 60 秒，让车队拿不到那批弹药。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '北站整夜都在卸货。站台高、仓库深，别让他们把你压进死角。', voice: 'op6_3' },
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
    radioAtStart: true,
    zoneLabel: '东港集装箱场',
    threat: 'CRITICAL',
    brief: '穿过集装箱阵，把撤离点从车队手里抢下来。',
    radio: [
      { at: 'start', speaker: 'VEGA', text: '港区是他们的最后一站。集装箱之间只有几条缝，手雷会比子弹先到。', voice: 'op7_4' },
      { at: 3, speaker: 'VEGA', text: '撤离点就在吊臂下面。别让他们把货装船。', voice: 'op7_6' },
    ],
    debrief: '吊臂停了。接管卡里姆频道的那个人还在港区——萨利姆。',
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
    bossIntro: 'finale2_intro',
    /* The title 指挥官 belongs to Karim alone. Salim runs the port on Karim's
       radio, which is why he can still command a convoy with his boss dead. */
    bossName: '萨利姆 · 卡里姆的接线员',
    outro: 'ending2',
    outroVideo: true,
    zoneLabel: '东港 · 起重机',
    threat: 'CRITICAL',
    brief: '港区推进、顶住水边侧袭、击杀萨利姆，在吊臂下登船。他用的是卡里姆的频率。',
    /* Phase 3: push the container axes → waterside flank must be held →
       Salim: at 60% he walks artillery onto you from the crane (the player
       killstreak system, fired by the enemy), at 30% his shield guard
       commits → board the boat under the crane. */
    beats: [
      { type: 'survival', name: '推进', text: '沿集装箱阵推进 · 清出射界', ai: 'hunter', enemies: 6 },
      { type: 'assault', name: '侧袭', text: '水边有侧袭 · 守住吊臂区', ai: 'assault', enemies: 5 },
      { type: 'boss', name: '萨利姆', text: '击杀萨利姆 · 结束这条线', ai: 'assault', enemies: 0,
        boss: { hp: 900, scale: 1.2, name: '萨利姆 · 卡里姆的接线员', spawn: { x: 98, z: -44 } } },
      { type: 'extract', name: '登船', text: '到吊臂下撤离点 · 登船', ai: 'interceptorPursuit', enemies: 4,
        zone: { x: 98, z: -44, r: 6 }, hold: 3 },
    ],
    bossPhases: [
      { atHpFrac: 0.6, action: 'artillery', shells: 4,
        radioText: '吊臂在给他标射——离开弹着区！' },
      { atHpFrac: 0.3, action: 'escort', archetype: 'shield', count: 2,
        radioText: '亲卫队顶上来了！' },
    ],
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

/* --------------------------------------------------------- beat checkpoints
 * §4.4: a campaign op saves its progress PER BEAT, so dying at the boss does
 * not replay the whole mission (14 ops × 10 min of full restarts is where
 * single-player campaigns die). The checkpoint holds the beat you are ON —
 * it is written when the beat starts and cleared when the op finishes. */
const BEAT_KEY = 'dod.campaign.beat.v1';

export function saveBeatCheckpoint(opId, beat) {
  try {
    localStorage.setItem(BEAT_KEY, JSON.stringify({ opId, beat }));
  } catch (e) { /* private mode */ }
}

export function loadBeatCheckpoint() {
  try {
    const raw = localStorage.getItem(BEAT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Number.isInteger(data.opId) || !Number.isInteger(data.beat)) return null;
    return { opId: data.opId, beat: data.beat };
  } catch (e) {
    return null;
  }
}

export function clearBeatCheckpoint() {
  try {
    localStorage.removeItem(BEAT_KEY);
  } catch (e) { /* private mode */ }
}
