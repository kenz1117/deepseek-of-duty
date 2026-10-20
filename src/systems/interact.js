/* =========================================================================
   E-interaction: intel documents and breach doors.

   Targets are plain records { x, z, r, label, hold?, onUse, done }. A target
   without `hold` fires on press; with `hold` it fills while E is held. The HUD
   prompt is driven from update() so there is exactly one "nearest" target.
   ========================================================================= */

export function createInteract({ hud, input, onUse } = {}) {
  const targets = [];
  let current = null;
  let hold = 0;

  function add(t) {
    if (!t) return null;
    const rec = { r: 2.0, done: false, ...t };
    targets.push(rec);
    return rec;
  }

  function remove(t) {
    const i = targets.indexOf(t);
    if (i >= 0) targets.splice(i, 1);
    if (current === t) { current = null; hold = 0; }
  }

  function update(dt, pos) {
    let best = null;
    let bestD = Infinity;
    for (const t of targets) {
      if (t.done || t.disabled) continue;
      const d = Math.hypot(t.x - pos.x, t.z - pos.z);
      if (d <= t.r && d < bestD) { best = t; bestD = d; }
    }
    if (best !== current) { current = best; hold = 0; }
    if (!current) {
      if (hud && hud.setInteract) hud.setInteract(null);
      return;
    }
    if (current.hold) {
      if (input && input.down('KeyE')) hold += dt;
      else hold = Math.max(0, hold - dt * 2.5);
      if (hold >= current.hold) {
        const t = current;
        hold = 0;
        use(t);
        return;
      }
      if (hud && hud.setInteract) {
        hud.setInteract(current.label || '按住 E 交互', Math.min(1, hold / current.hold));
      }
    } else if (hud && hud.setInteract) {
      hud.setInteract(current.label || 'E 交互', null);
    }
  }

  function use(t) {
    if (!t || (t.done && !t.repeat)) return;
    if (!t.repeat) t.done = true;
    if (hud && hud.setInteract) hud.setInteract(null);
    if (onUse) onUse(t);
    if (t.onUse) t.onUse(t);
    // repeat targets are re-armed immediately (doors/windows/shutters)
    current = null;
  }

  function press() {
    if (current && !current.hold) use(current);
  }

  return {
    add, remove, update, press,
    get current() { return current; },
    get count() { return targets.length; },
  };
}
