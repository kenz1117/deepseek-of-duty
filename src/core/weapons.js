/* =========================================================================
 * WEAPONS — the player's three slots, in one testable place.
 *
 * Pure data + one pure falloff curve, so tools/diff-tier-test.mjs can assert
 * the numbers against the ones documented in README §武器. The M870 curve in
 * particular is the one players notice: at 12 m the shotgun must still kill
 * a 100 hp rifleman with one shell, otherwise every mid-range pull turns
 * into two pumps and the weapon feels broken.
 * ========================================================================= */

export const WEAPONS = [
  {
    id: 'm4', name: 'M4A1', tag: 'PRIMARY <i></i> AR', magSize: 30, reserve: 180, dmg: 30, rpm: 720,
    auto: true, spread: 0.0125, adsSpread: 0.0016, recoil: 1.0, variant: 'black', mode: 'AUTO',
  },
  {
    // close-range: harder hitting + faster, but kicks more and needs a tighter burst
    id: 'mk18', name: 'MK18', tag: 'PRIMARY <i></i> CQB', magSize: 25, reserve: 125, dmg: 36, rpm: 850,
    auto: true, spread: 0.0175, adsSpread: 0.0026, recoil: 1.35, variant: 'tan', mode: 'AUTO',
  },
  {
    // pump shotgun: 8 pellets, shell-by-shell reload.
    // Falloff used to floor at 30 % (20 m = 53 raw), which made the shotgun
    // feel broken in the 8-16 m band: one shell could not kill a 100 hp
    // rifleman, so every mid-range pull was two pumps. The floor is now 42 %
    // and the slope 0.05/m, so one shell still kills a rifleman out to ~13 m
    // and the shotgun stays a close-range weapon beyond that.
    id: 'm870', name: 'M870', tag: 'PRIMARY <i></i> SG', magSize: 6, reserve: 40, dmg: 22, rpm: 75,
    auto: false, spread: 0.045, adsSpread: 0.035, recoil: 1.6, variant: 'wood', mode: 'PUMP',
    pellets: 8, shell: true,
    falloff: (d) => (d <= 4 ? 1 : Math.max(0.42, 1 - (d - 4) * 0.05)),
  },
];

/** Raw damage of one shotgun shell at `d` metres (8 pellets × per-pellet). */
export function shotgunDamage(weapon, d) {
  if (!weapon || !weapon.pellets || !weapon.falloff) return 0;
  return weapon.pellets * weapon.dmg * weapon.falloff(d);
}
