/* =========================================================================
 * MEDICAL — the downed/revive decision layer for LAN co-op (Phase 4a).
 *
 * Getting shot to 0 HP no longer means a 4-second spectator break: the
 * player is DOWNED and bleeds out while teammates can run over and pick
 * them up. Wipe the whole squad and everyone respawns together. This is the
 * emotional core of co-op — the difference between "I died" and "hold on,
 * I'm coming".
 *
 * Pure logic, no three.js/DOM/timers: the registry is keyed by player id
 * and every call passes an explicit `now` (Date.now() in the game), so the
 * host and every client can hold their own copy driven by events, and the
 * tests run headlessly. The HOST's registry is the authority; clients keep
 * a mirror just for mounting revive prompts.
 * ========================================================================= */

/* Downed-state budget. The old numbers (30 s bleed, revive at 50 % HP) made
   dying nearly free: a player could trade a wave for a free second life at
   half health with no cost at all, and the four-player squad could farm
   waves without ever being threatened. 18 s and a third of the health keep
   the "hold on, I'm coming" promise while making the trade a real cost. */
export const DOWN_BLEED_S = 18;      // seconds from downed to dead
export const REVIVE_RANGE_M = 3.5;   // reviver must be this close
export const REVIVE_HOLD_S = 2.0;    // interact channel time
export const REVIVE_HP_FRAC = 0.35;  // pick up at a third of your health
export const WIPE_RESPAWN_S = 5;     // squad-wiped redeploy delay

export function createDownedRegistry({ bleedS = DOWN_BLEED_S, range = REVIVE_RANGE_M } = {}) {
  /** id → { x, z, at } — at = epoch ms when the player went down */
  const map = new Map();

  function down(id, x, z, at) {
    map.set(String(id), { x: Number(x) || 0, z: Number(z) || 0, at: Number(at) || 0 });
  }

  function clear(id) {
    return map.delete(String(id));
  }

  function isDown(id) {
    return map.has(String(id));
  }

  function posOf(id) {
    const r = map.get(String(id));
    return r ? { x: r.x, z: r.z } : null;
  }

  function ids() {
    return Array.from(map.keys());
  }

  /** Ids whose bleed-out clock has run out at `now` (and clears them). */
  function expired(now) {
    const out = [];
    for (const [id, r] of map) {
      if (now - r.at >= bleedS * 1000) out.push(id);
    }
    for (const id of out) map.delete(id);
    return out;
  }

  /** May `reviverPos` pick up `targetId` right now? Range-checked with a
      small grace (positions are 20 Hz mirrors). */
  function canRevive(targetId, reviverPos, now) {
    const r = map.get(String(targetId));
    if (!r || !reviverPos) return false;
    if (now - r.at >= bleedS * 1000) return false;
    const d = Math.hypot(reviverPos.x - r.x, reviverPos.z - r.z);
    return d <= range + 0.5;
  }

  /**
   * Squad wipe: every live human is downed or dead. `humans` is
   * [{ id, alive }] from the authority's point of view (playing OR downed
   * counts as alive here — a wipe means nobody is standing).
   */
  function isWipe(humans) {
    const list = Array.isArray(humans) ? humans : [];
    if (list.length < 2) return false;          // a lone operator just bleeds out
    return list.every((h) => !h || !h.alive || map.has(String(h.id)));
  }

  function clearAll() {
    map.clear();
  }

  return { down, clear, clearAll, isDown, posOf, ids, expired, canRevive, isWipe };
}
