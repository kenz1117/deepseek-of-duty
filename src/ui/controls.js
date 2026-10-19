/* =========================================================================
   One source of truth for the control scheme.

   The pre-mission briefing, the in-game pause panel and the README all talk
   about the same keys; hardcoding the grid in three places is how "M" ended
   up missing from the tutorial after the minimap shipped.
   ========================================================================= */

export const CONTROL_GROUPS = [
  {
    id: 'movement',
    label: '移动 MOVEMENT',
    rows: [
      [{ keys: ['W', 'A', 'S', 'D'], label: '移动', en: 'MOVE' }, { keys: ['SHIFT'], label: '冲刺', en: 'SPRINT' }],
      [{ keys: ['CTRL', 'C'], label: '蹲伏', en: 'CROUCH' }, { keys: ['SPACE'], label: '跳跃', en: 'JUMP' }],
    ],
  },
  {
    id: 'combat',
    label: '战斗 COMBAT',
    rows: [
      [{ keys: ['LMB'], label: '射击', en: 'FIRE' }, { keys: ['RMB'], label: '瞄准', en: 'ADS' }],
      [{ keys: ['R'], label: '换弹', en: 'RELOAD' }, { keys: ['G'], label: '手雷', en: 'GRENADE' }],
      [{ keys: ['1', '2', '3'], label: '切换武器', en: 'SWAP' }, { keys: ['Q'], label: '上一把', en: 'LAST' }],
      [{ keys: ['F'], label: '检视武器', en: 'INSPECT' }],
    ],
  },
  {
    id: 'systems',
    label: '系统 SYSTEMS',
    rows: [
      [{ keys: ['M'], label: '小地图', en: 'MINIMAP' }, { keys: ['E'], label: '交互 / 破门', en: 'INTERACT' }],
      [{ keys: ['ESC', 'P'], label: '暂停', en: 'PAUSE' }],
    ],
  },
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function renderControls(root, { showGroups = true } = {}) {
  if (!root) return;
  root.textContent = '';
  for (const group of CONTROL_GROUPS) {
    if (showGroups) {
      const head = el('div', 'pc-head');
      head.append(el('span', 'pc-head-label', group.label));
      root.appendChild(head);
    }
    for (const row of group.rows) {
      const r = el('div', 'pc-row');
      for (const item of row) {
        const keys = el('span', 'pc-keys');
        for (const k of item.keys) keys.appendChild(el('kbd', null, k));
        const label = el('span', 'pc-label');
        label.append(document.createTextNode(item.label + ' '));
        label.appendChild(el('em', null, item.en));
        r.append(keys, label);
      }
      root.appendChild(r);
    }
  }
}
