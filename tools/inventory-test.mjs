#!/usr/bin/env node
/**
 * Inventory unit tests — gear level-exclusivity + consumable channel rules.
 * Run: node tools/inventory-test.mjs
 */

import { ITEMS, tryEquip, createInventory } from '../src/systems/inventory.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* --- catalogue sanity ----------------------------------------------------- */
{
  check('catalogue: 9 item types (3 armor, 3 helmet, 3 consumables)',
    Object.keys(ITEMS).length === 9, `${Object.keys(ITEMS).length}`);
  check('catalogue: armor tiers are 50/75/100',
    ITEMS.armor1.armorMax === 50 && ITEMS.armor2.armorMax === 75 && ITEMS.armor3.armorMax === 100);
  check('catalogue: helmet reduction ramps 8/15/22%',
    ITEMS.helmet1.damageReduction === 0.08 && ITEMS.helmet2.damageReduction === 0.15
      && ITEMS.helmet3.damageReduction === 0.22);
  check('catalogue: consumables carry channel times and caps',
    ITEMS.bandage.channelTime === 2.5 && ITEMS.medkit.channelTime === 5
      && ITEMS.bandage.cap === 5 && ITEMS.medkit.cap === 2 && ITEMS.drink.cap === 4);
}

/* --- the mutual-exclusivity rule ------------------------------------------ */
{
  // empty -> any tier equips
  check('gear: empty slot accepts lv1', tryEquip({ armor: 0 }, 'armor1').ok === true);
  check('gear: empty slot accepts lv3', tryEquip({ armor: 0 }, 'armor3').ok === true);
  // upgrade path
  const up = tryEquip({ armor: 1 }, 'armor3');
  check('gear: lv1 -> lv3 is an upgrade', up.ok === true && up.replaced === true);
  // downgrade / equal refusals — the mutual-exclusivity core
  check('gear: lv3 refuses lv1 (mutual exclusivity)', tryEquip({ armor: 3 }, 'armor1').ok === false);
  check('gear: lv2 refuses lv2 (equal tier)', tryEquip({ armor: 2 }, 'armor2').ok === false);
  check('gear: helmet family is independent of armor family',
    tryEquip({ armor: 3, helmet: 0 }, 'helmet3').ok === true);
  check('gear: same slot, different family untouched',
    tryEquip({ armor: 3, helmet: 3 }, 'armor1').ok === false);
}

/* --- consumables: add / cap ----------------------------------------------- */
{
  const inv = createInventory();
  check('pack: starts empty', inv.pack.bandage === 0);
  for (let i = 0; i < 5; i += 1) check.after = null;
  check('pack: first bandage adds', inv.add('bandage') === true);
  check('pack: cap at 5 bandages', (() => {
    for (let i = 0; i < 9; i += 1) inv.add('bandage');
    return inv.pack.bandage === 5;
  })());
  check('pack: medkit cap is 2', (() => {
    inv.add('medkit'); inv.add('medkit');
    return inv.add('medkit') === false && inv.pack.medkit === 2;
  })());
}

/* --- consumables: channel start / cancel / complete ----------------------- */
{
  const inv = createInventory();
  inv.add('bandage');
  const refuse = inv.press('bandage', 100, 100);
  check('channel: refuses at full hp', refuse.ok === false && refuse.reason === 'no_need');
  const start = inv.press('bandage', 50, 100);
  check('channel: starts when hurt', start.ok === true && start.reason === 'started');
  const busy = inv.press('medkit', 50, 100);
  inv.add('medkit');
  check('channel: another key is refused while busy', busy.ok === false && busy.reason === 'busy');
  const cancel = inv.press('bandage', 50, 100);
  check('channel: same key cancels', cancel.ok === true && cancel.reason === 'cancelled');
  check('channel: cancelled consumes nothing', inv.pack.bandage === 1);

  inv.press('bandage', 50, 100);
  let done = null;
  for (let i = 0; i < 260 && !done; i += 1) done = inv.update(0.01);   // 2.6 s
  check('channel: completes after 2.5 s and returns the item', done === 'bandage');
  check('channel: completing consumes one', inv.pack.bandage === 0);
  const eff = inv.effectOf(done);
  check('effect: bandage heals 25 up to hp 75',
    eff.heal === 25 && eff.healCap === 75);
}

/* --- medkit + drink ------------------------------------------------------- */
{
  const inv = createInventory();
  inv.add('medkit'); inv.add('drink');
  inv.press('medkit', 30, 100);
  let done = null;
  for (let i = 0; i < 520 && !done; i += 1) done = inv.update(0.01);   // 5.2 s
  check('medkit: channels 5 s then completes', done === 'medkit');
  check('medkit: heals to full', inv.effectOf('medkit').healCap === 100);

  inv.press('drink', 90, 100);
  let done2 = null;
  for (let i = 0; i < 140 && !done2; i += 1) done2 = inv.update(0.01); // 1.4 s
  check('drink: fast channel, gives a speed buff', done2 === 'drink'
    && inv.effectOf('drink').speedBoost === 0.08 && inv.effectOf('drink').boostTime === 10);
}

/* --- gear integration: equip + stats -------------------------------------- */
{
  const inv = createInventory();
  check('gear stats: unequipped means zero reduction', inv.gearStats().damageReduction === 0);
  inv.equip('armor2'); inv.equip('helmet3');
  let st = inv.gearStats();
  check('gear stats: lv2 armor raises the cap to 75',
    st.armorMax === 75 && st.armorLevel === 2);
  check('gear stats: lv3 helmet gives 22% reduction',
    st.helmetLevel === 3 && st.damageReduction === 0.22);
  check('gear: lower tier refused while worn', inv.equip('armor1').ok === false);
  inv.equip('armor3');
  st = inv.gearStats();
  check('gear: upgrade replaces (cap 100)', st.armorMax === 100);
}

/* --- snapshot / reset ----------------------------------------------------- */
{
  const inv = createInventory();
  inv.add('drink'); inv.equip('helmet1'); inv.press('drink', 50, 100);
  const snap = inv.snapshot();
  check('snapshot: carries pack, gear and channel',
    snap.pack.drink === 1 && snap.gear.helmet === 1 && snap.channel && snap.channel.item === 'drink');
  inv.reset();
  check('reset: clears everything', inv.pack.drink === 0 && inv.gear.helmet === 0 && inv.channel === null);
}

console.log(failures === 0 ? '\n[inventory-test] all checks passed' : `\n[inventory-test] ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);