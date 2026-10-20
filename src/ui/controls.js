/* =========================================================================
   One source of truth for the control scheme.

   The pre-mission briefing, the in-game pause panel and the README all talk
   about the same keys; hardcoding the grid in three places is how "M" ended
   up missing from the tutorial after the minimap shipped.

   `renderControls()` also mounts the visual key map into the sibling
   `#controls-keyboard` / `#manual-keyboard` host, so main.js does not need a
   second call to keep the diagram and the text reference in sync.
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
      [{ keys: ['4'], label: '绷带', en: 'BANDAGE' }, { keys: ['5'], label: '急救包', en: 'MEDKIT' }, { keys: ['6'], label: '能量饮料', en: 'DRINK' }],
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

const KEY_INFO = {
  ESC:   { fn: '暂停', group: 'systems', hero: true, size: 'esc' },
  '1':   { fn: '步枪', group: 'combat', hero: true },
  '2':   { fn: 'MK18', group: 'combat', hero: true },
  '3':   { fn: '霰弹', group: 'combat', hero: true },
  '4':   { fn: '绷带', group: 'combat', hero: true },
  '5':   { fn: '急救包', group: 'combat', hero: true },
  '6':   { fn: '饮料', group: 'combat', hero: true },
  Q:     { fn: '上一把', group: 'combat', hero: true },
  W:     { fn: '前进', group: 'move', hero: true },
  E:     { fn: '交互', group: 'systems', hero: true },
  R:     { fn: '换弹', group: 'combat', hero: true },
  T:     { fn: '', group: 'move', inert: true },
  Y:     { fn: '', group: 'move', inert: true },
  U:     { fn: '', group: 'move', inert: true },
  I:     { fn: '', group: 'move', inert: true },
  O:     { fn: '', group: 'move', inert: true },
  P:     { fn: '暂停', group: 'systems', hero: true },
  A:     { fn: '左移', group: 'move', hero: true },
  S:     { fn: '后退', group: 'move', hero: true },
  D:     { fn: '右移', group: 'move', hero: true },
  F:     { fn: '检视', group: 'combat', hero: true },
  G:     { fn: '手雷', group: 'combat', hero: true },
  H:     { fn: '', group: 'move', inert: true },
  J:     { fn: '', group: 'move', inert: true },
  K:     { fn: '', group: 'move', inert: true },
  L:     { fn: '', group: 'move', inert: true },
  Z:     { fn: '', group: 'move', inert: true },
  X:     { fn: '', group: 'move', inert: true },
  C:     { fn: '蹲伏', group: 'move', hero: true },
  V:     { fn: '', group: 'move', inert: true },
  B:     { fn: '', group: 'move', inert: true },
  N:     { fn: '', group: 'move', inert: true },
  M:     { fn: '地图', group: 'systems', hero: true },
  CTRL:  { fn: '蹲伏', group: 'move', hero: true, size: 'ctrl' },
  ALT:   { fn: '', group: 'move', inert: true, size: 'alt' },
  SPACE: { fn: '跳跃', group: 'move', hero: true, size: 'space' },
  SHIFT: { fn: '冲刺', group: 'move', hero: true, size: 'shift' },
  LMB:   { fn: '开火', group: 'combat', hero: true, mouse: true },
  RMB:   { fn: '瞄准', group: 'combat', hero: true, mouse: true },
};

const KEY_ROWS = [
  { cls: 'kbd-row--top', keys: ['ESC', null, '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] },
  { cls: 'kbd-row--home', keys: ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'] },
  { cls: 'kbd-row--asdf', keys: ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'] },
  { cls: 'kbd-row--zxcv', keys: ['Z', 'X', 'C', 'V', 'B', 'N', 'M'] },
  { cls: 'kbd-row--bottom', keys: ['CTRL', 'ALT', 'SPACE', 'SHIFT'] },
];

const NUMBER_FILLER = new Set(['7', '8', '9', '0']);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function makeKey(name) {
  const info = KEY_INFO[name];
  if (!info || NUMBER_FILLER.has(name)) {
    const filler = el('span', 'key key-inert');
    filler.textContent = name;
    filler.setAttribute('aria-hidden', 'true');
    return filler;
  }
  const isInert = !!info.inert;
  const node = isInert ? el('span', 'key key-inert') : el('button', 'key');
  if (!isInert) node.type = 'button';
  node.classList.add('key--' + info.group);
  if (info.size) node.classList.add('key--' + info.size);
  if (info.hero) node.classList.add('key--hero');
  if (info.mouse) node.classList.add('key--mouse');
  if (isInert) {
    node.textContent = name;
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  node.dataset.key = name;
  node.setAttribute('aria-label', name + ' ' + info.fn);
  const cap = el('b', null, name);
  const fn = el('span', 'key-fn', info.fn);
  node.append(cap, fn);
  return node;
}

function makeMouse() {
  const wrap = el('div', 'kbd-mouse');
  wrap.appendChild(el('div', 'kbd-side-label', 'MOUSE 鼠标'));
  const shell = el('div', 'mouse-shell');
  const lmb = makeKey('LMB');
  lmb.classList.add('key--lmb');
  const rmb = makeKey('RMB');
  rmb.classList.add('key--rmb');
  const wheel = el('i', 'mouse-wheel');
  wheel.setAttribute('aria-hidden', 'true');
  shell.append(lmb, rmb, wheel);
  wrap.appendChild(shell);
  wrap.appendChild(el('p', 'mouse-note', '左键开火 · 右键瞄准'));
  return wrap;
}

function paintLinkState(stageRoot, listRoot, keys) {
  const set = new Set(keys);
  stageRoot.querySelectorAll('.key.is-hot').forEach((n) => n.classList.remove('is-hot'));
  listRoot?.querySelectorAll('.pc-item.is-link').forEach((n) => n.classList.remove('is-link'));
  stageRoot.querySelectorAll('[data-key]').forEach((n) => {
    if (set.has(n.dataset.key)) n.classList.add('is-hot');
  });
  listRoot?.querySelectorAll('.pc-item[data-keys]').forEach((n) => {
    const hit = n.dataset.keys.split(/\s+/).some((k) => set.has(k));
    if (hit) n.classList.add('is-link');
  });
}

function wireKeyLinks(stageRoot, listRoot) {
  if (!listRoot) return;
  const keyEls = Array.from(stageRoot.querySelectorAll('[data-key]'));
  const items = Array.from(listRoot.querySelectorAll('.pc-item[data-keys]'));
  let pinned = null;

  const restore = () => {
    if (pinned) paintLinkState(stageRoot, listRoot, [pinned]);
    else clear();
  };
  const clear = () => {
    stageRoot.querySelectorAll('.key.is-hot').forEach((n) => n.classList.remove('is-hot'));
    listRoot.querySelectorAll('.pc-item.is-link').forEach((n) => n.classList.remove('is-link'));
  };
  const paintKeys = (keys) => paintLinkState(stageRoot, listRoot, keys);

  for (const keyEl of keyEls) {
    const key = keyEl.dataset.key;
    keyEl.addEventListener('pointerenter', () => paintKeys([key]));
    keyEl.addEventListener('pointerleave', restore);
    keyEl.addEventListener('focus', () => paintKeys([key]));
    keyEl.addEventListener('blur', restore);
    keyEl.addEventListener('click', () => {
      pinned = pinned === key ? null : key;
      if (pinned) paintKeys([key]);
      else clear();
    });
  }

  for (const item of items) {
    const keys = item.dataset.keys.split(/\s+/);
    item.addEventListener('pointerenter', () => paintKeys(keys));
    item.addEventListener('pointerleave', restore);
    item.addEventListener('focus', () => paintKeys(keys));
    item.addEventListener('blur', restore);
    item.addEventListener('click', () => {
      pinned = null;
      paintKeys(keys);
    });
  }

  stageRoot.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    pinned = null;
    clear();
  });
}

export function renderKeymap(root, { listRoot = null } = {}) {
  if (!root) return;
  root.textContent = '';
  root.classList.add('kbd-host');

  const stage = el('div', 'kbd-stage');
  const main = el('div', 'kbd-main');
  const head = el('div', 'kbd-map-head');
  head.append(
    el('span', 'kbd-map-tag', 'KEYBOARD MAP'),
    el('b', 'kbd-map-title', '键位图'),
    el('i', 'kbd-map-rule'),
    el('span', 'kbd-map-hint', '悬停 / 点按键帽 ↔ 下方功能'),
  );
  main.appendChild(head);

  const board = el('div', 'kbd-board');
  for (const row of KEY_ROWS) {
    const r = el('div', 'kbd-row ' + row.cls);
    for (const key of row.keys) {
      if (!key) {
        r.appendChild(el('span', 'kbd-spacer kbd-spacer--esc'));
        continue;
      }
      r.appendChild(makeKey(key));
    }
    board.appendChild(r);
  }
  main.appendChild(board);
  stage.append(main, makeMouse());

  const legend = el('div', 'kbd-legend');
  legend.append(
    el('span', 'kbd-legend-item kbd-legend--move', '移动'),
    el('span', 'kbd-legend-item kbd-legend--combat', '战斗'),
    el('span', 'kbd-legend-item kbd-legend--systems', '系统'),
    el('span', 'kbd-callout', '按住 SHIFT 冲刺 · SPACE 跳跃'),
  );
  stage.appendChild(legend);

  root.appendChild(stage);
  root.appendChild(el('p', 'kbd-note', '1–3 切枪 · 4/5/6 绷带/急救/饮料 · Q 上一把 · E 交互 · M 地图 · ESC/P 暂停'));

  wireKeyLinks(root, listRoot);
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
        const itemEl = el('div', 'pc-item');
        itemEl.dataset.keys = item.keys.join(' ');
        itemEl.tabIndex = 0;
        const keys = el('span', 'pc-keys');
        for (const k of item.keys) keys.appendChild(el('kbd', null, k));
        const label = el('span', 'pc-label');
        label.append(document.createTextNode(item.label + ' '));
        label.appendChild(el('em', null, item.en));
        itemEl.append(keys, label);
        r.appendChild(itemEl);
      }
      root.appendChild(r);
    }
  }

  const mapId = root.id === 'controls-grid' ? 'controls-keyboard'
    : root.id === 'manual-controls' ? 'manual-keyboard' : '';
  if (mapId) renderKeymap(document.getElementById(mapId), { listRoot: root });
}

function openKeymapModal() {
  const modal = document.getElementById('controls');
  if (!modal) return;
  const host = document.getElementById('controls-keyboard');
  const list = document.getElementById('controls-grid');
  if (host && !host.childElementCount) renderKeymap(host, { listRoot: list });
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const first = host?.querySelector('.key');
    if (first) first.focus({ preventScroll: true });
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const trigger = event.target && event.target.closest && event.target.closest('[data-open-keymap]');
    if (!trigger) return;
    event.preventDefault();
    openKeymapModal();
  });
}
