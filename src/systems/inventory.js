/* =========================================================================
   INVENTORY — pickup catalogue + carry/use state, in the style of a
   battle-royale loadout.

   Pure logic: no three.js, no DOM. main.js feeds key presses and per-frame
   dt; this module owns the rules. Mirrors systems/streaks.js on purpose.

   Two item families
   -----------------
   GEAR (wearable, level-exclusive): armor and helmets in three tiers. You
   can hold exactly ONE of each family — equipping a higher tier replaces
   the lower one (fresh durability), and a lower tier is refused outright
   when the equipped one is equal or better. That is the "different levels
   are mutually exclusive" rule: the catalog decides, not the caller.

   CONSUMABLES (carried, used on a key press with a channel time): picking
   one up adds it to the pack; using it starts a channel that can be
   cancelled by pressing the same key again. Nothing applies instantly —
   the effect lands only when the channel completes.

   Effects live here as data (heal amounts, damage reduction), but the
   caller applies them — this module never touches G/hp directly.
   ========================================================================= */

/** Catalogue. `family: 'gear'` items are level-exclusive; `family: 'use'`
    items stack in the pack up to `cap` and channel for `channelTime` s. */
export const ITEMS = {
  armor1: { family: 'gear', slot: 'armor', level: 1, armorMax: 50, label: '一级甲' },
  armor2: { family: 'gear', slot: 'armor', level: 2, armorMax: 75, label: '二级甲' },
  armor3: { family: 'gear', slot: 'armor', level: 3, armorMax: 100, label: '三级甲' },
  helmet1: { family: 'gear', slot: 'helmet', level: 1, damageReduction: 0.08, label: '一级盔' },
  helmet2: { family: 'gear', slot: 'helmet', level: 2, damageReduction: 0.15, label: '二级盔' },
  helmet3: { family: 'gear', slot: 'helmet', level: 3, damageReduction: 0.22, label: '三级盔' },
  bandage: { family: 'use', cap: 5, channelTime: 2.5, heal: 25, healCap: 75, label: '绷带', key: '4' },
  medkit: { family: 'use', cap: 2, channelTime: 5.0, heal: 100, healCap: 100, label: '急救包', key: '5' },
  drink: { family: 'use', cap: 4, channelTime: 1.2, heal: 20, healCap: 100, speedBoost: 0.08, boostTime: 10, label: '能量饮料', key: '6' },
};

/** Decide whether a gear pickup may be equipped.
    Returns { ok, reason, replaced } — ok=false means "leave it on the ground". */
export function tryEquip(gear, item) {
  const def = ITEMS[item];
  if (!def || def.family !== 'gear') return { ok: false, reason: 'not_gear' };
  const current = gear[def.slot] || 0;
  if (def.level <= current) return { ok: false, reason: 'worse_or_equal' };
  return { ok: true, reason: 'upgrade', replaced: current > 0, level: def.level };
}

export function createInventory() {
  const pack = { bandage: 0, medkit: 0, drink: 0 };
  const gear = { armor: 0, helmet: 0 };   // equipped tier per slot (0 = none)
  let channel = null;                      // { item, t }

  /** Pick a consumable up. Returns false when the pack slot is full. */
  function add(item, n = 1) {
    const def = ITEMS[item];
    if (!def || def.family !== 'use') return false;
    const next = Math.min(def.cap, pack[item] + n);
    if (next === pack[item]) return false;          // already full
    pack[item] = next;
    return true;
  }

  /** Key press on a consumable: start its channel, or cancel the running one.
      Refuses to start when the pack is empty, the player is already at the
      heal cap this item can reach, or another channel is running. */
  function press(item, hp = 100, maxHp = 100) {
    const def = ITEMS[item];
    if (!def || def.family !== 'use') return { ok: false, reason: 'not_usable' };
    if (channel && channel.item === item) {         // same key: cancel
      channel = null;
      return { ok: true, reason: 'cancelled' };
    }
    if (channel) return { ok: false, reason: 'busy' };
    if (pack[item] <= 0) return { ok: false, reason: 'empty' };
    const healCeiling = Math.min(def.healCap, maxHp);
    if (hp >= healCeiling) return { ok: false, reason: 'no_need' };
    channel = { item, t: 0 };
    return { ok: true, reason: 'started' };
  }

  /** Per-frame channel progress. Returns the finished item when the channel
      completes (the caller applies the effect and decrements the count), or
      null while it is still running / when nothing is running. */
  function update(dt) {
    if (!channel) return null;
    const def = ITEMS[channel.item];
    channel.t += dt;
    if (channel.t + 1e-6 >= def.channelTime) {
      const done = channel.item;
      pack[done] = Math.max(0, pack[done] - 1);
      channel = null;
      return done;
    }
    return null;
  }

  function cancel() { channel = null; }

  /** Effect of a finished consumable, resolved here so the caller does not
      need catalogue knowledge. `speedBoost` is a multiplier delta. */
  function effectOf(item) {
    const def = ITEMS[item];
    if (!def) return null;
    return {
      heal: def.heal || 0,
      healCap: def.healCap ?? 100,
      speedBoost: def.speedBoost || 0,
      boostTime: def.boostTime || 0,
    };
  }

  /** Gear: apply the tryEquip verdict to the held tiers. */
  function equip(item) {
    const verdict = tryEquip(gear, item);
    if (!verdict.ok) return verdict;
    const def = ITEMS[item];
    gear[def.slot] = def.level;
    return verdict;
  }

  function gearStats() {
    const armorDef = Object.values(ITEMS).find(
      (d) => d.slot === 'armor' && d.level === gear.armor
    );
    const helmDef = Object.values(ITEMS).find(
      (d) => d.slot === 'helmet' && d.level === gear.helmet
    );
    return {
      armorLevel: gear.armor,
      armorMax: armorDef ? armorDef.armorMax : 0,
      helmetLevel: gear.helmet,
      damageReduction: helmDef ? helmDef.damageReduction : 0,
    };
  }

  function snapshot() {
    return {
      pack: { ...pack },
      gear: { ...gear },
      channel: channel ? { item: channel.item, t: channel.t, need: ITEMS[channel.item].channelTime } : null,
    };
  }

  function reset() {
    pack.bandage = 0; pack.medkit = 0; pack.drink = 0;
    gear.armor = 0; gear.helmet = 0;
    channel = null;
  }

  return {
    add, press, update, cancel, equip, gearStats, effectOf, reset,
    snapshot,
    get channel() { return channel ? { ...channel } : null; },
    get pack() { return { ...pack }; },
    get gear() { return { ...gear }; },
  };
}

export default createInventory;