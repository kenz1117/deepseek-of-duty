/* =========================================================================
   Archive data: character dossiers, intel documents and the mission log.
   Characters unlock from campaign progress; intel is picked up in the world.
   ========================================================================= */

const STORE = 'dod.codex.v1';

export const CHARACTERS = [
  { id: 'vega', name: 'VEGA', role: '指挥官 / 无线电', mission: 1,
    text: '负责这次清剿的现场指挥。声音低、语速快，习惯用最短的句子下命令。' },
  { id: 'wolf', name: '灰狼', role: '行动员', mission: 1,
    text: '你。整条防线只剩你还在推进，VEGA 把你当成了最后一张牌。' },
  { id: 'hassan', name: '哈桑', role: '副官', mission: 5,
    text: '卡里姆的副手，负责南院车队。重甲、近战、不信任何人；死前没有开口。' },
  { id: 'dispatch', name: 'DISPATCH', role: '车队调度', mission: 6,
    text: '北门车队的话务员。只在频道里出现，语速极快，背景永远是引擎和雨声。' },
  { id: 'moth', name: 'MOTH', role: '无人机操作员', mission: 8,
    text: '你的眼睛。负责 UAV 侦察和撤离路线，说话冷静，习惯先报坐标再报结论。' },
  { id: 'karim', name: '卡里姆', role: '敌方指挥官', mission: 9,
    text: '这条街的实际控制者。北楼办公室是他的指挥所，替身、副官和车队都只是他的缓冲。' },
];

export const INTEL = [
  { id: 'pass', title: '北门通行令', area: '南院车场',
    text: '一张盖着北门检查站钢印的通行令，签发人是卡里姆。哈桑到死都把它揣在内袋里。' },
  { id: 'manifest', title: '市场补给单', area: '后院市场',
    text: '补给单上的数字对不上：入库三百箱，出库四百二十箱。多出来的部分没有记录。' },
  { id: 'radio_log', title: '通讯车日志', area: '左巷工坊',
    text: '通讯车最后一段录音只有一句：「北楼收到，替身已就位。」时间戳在车队出发前十分钟。' },
  { id: 'roster', title: '检查站值班表', area: '北检查站',
    text: '值班表被人用笔改过：原本守北门的一个班被调去了北楼，理由是「指挥官需要」。' },
  { id: 'order', title: '卡里姆的命令', area: '北楼办公室',
    text: '一页手写的命令：「灰狼进入街区后，不要拦截。让他到北楼来。」下面没有签名。' },
  { id: 'exfil', title: '撤离清单', area: '东码头',
    text: '码头卡车上的清单：三箱文件、一台电台、两个座位。名单上只有卡里姆和一个代号「M」。' },
  { id: 'souk_ledger', title: '集市的暗账', area: '老城集市',
    text: '水井边货摊的私账：每月十五号，一车「香料」从西口进、北站出，收货人只写一个字母「S」。' },
  { id: 'souk_route', title: '走私路线图', area: '老城集市',
    text: '手绘的街巷图，用炭笔标出三条绕开检查站的通道，全部终点指向东港的集装箱阵。' },
  { id: 'rail_waybill', title: '货场运单', area: '北站货场',
    text: '运单货名写着「农机零件」，重量栏却是军规弹药的标准配重。发运站没有盖章。' },
  { id: 'rail_signal', title: '站台调度记录', area: '北站货场',
    text: '调度台的最后一条记录：「0230，吊臂预热，等船。」落款时间在港区撤离计划的前一天。' },
  { id: 'port_tally', title: '集装箱舱单', area: '东港集装箱场',
    text: '舱单上的柜号有一半不存在于任何船期表。备注栏只有一句话：「夜航，勿点灯。」' },
  { id: 'port_note', title: '萨利姆的字条', area: '东港集装箱场',
    text: '一张被油渍浸透的字条：「如果我不上船，把货凿沉。谁也不许带走。」签名被划掉了。' },
];

export function loadCodex() {
  const fallback = { intel: [] };
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return fallback;
    const d = JSON.parse(raw);
    const intel = Array.isArray(d.intel) ? d.intel.filter((id) => INTEL.some((i) => i.id === id)) : [];
    return { intel: Array.from(new Set(intel)) };
  } catch (e) {
    return fallback;
  }
}

export function saveCodex(codex) {
  try { localStorage.setItem(STORE, JSON.stringify(codex)); } catch (e) { /* private mode */ }
}

export function characterUnlocked(c, progress) {
  return !!(progress && progress.done && progress.done.includes(c.mission));
}
