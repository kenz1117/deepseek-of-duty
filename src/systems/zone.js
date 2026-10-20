/* =========================================================================
   ZONE — staged shrinking safe area, in the style of a battle-royale ring.

   Pure logic: no three.js, no DOM, no timers. The owner feeds dt and the
   player position, and reads state. This mirrors systems/streaks.js and
   systems/milestones.js so all match logic stays testable off-browser.

   Geometry
   --------
   The map bounds (level.js) are x -118..124, z -196..128 — a 242 x 324
   rectangle, NOT a square. A single map-centred circle large enough to cover
   it would cut off the playable area at three of the four sites (souk sits
   at x -116, rail at z -194). So the ring is anchored to the *site* rect
   instead, and each site's inscribed radius bounds the start/end sizes:

     street 72x110 -> inscribed r 36.0
     souk   76x114 -> inscribed r 38.0
     rail   80x88  -> inscribed r 40.0
     port   74x132 -> inscribed r 37.0

   The first circle starts at 0.85 * inscribed (so it stays inside the rect)
   and shrinks toward ~0.30 * inscribed for the final duel.

   Rules
   -----
   - Each phase is `wait` (ring holds, next ring is previewed) then `shrink`
     (the radius interpolates to the new size).
   - The next centre is offset from the current centre by at most
     `R_current - R_next`, so the new ring is always fully contained in the
     old one. This is the rule that makes the ring readable and fair.
   - Outside damage ramps per phase; it is applied by the owner, not here.
   ========================================================================= */

/** Damage per second outside the ring, per phase index. */
const DEFAULT_DPS = [1.0, 2.0, 3.5, 5.5, 8.0, 11.0, 14.0, 18.0];

/** Number of ring phases a match runs. Exported so tests track the design,
    not a magic number that silently drifts. */
export const ZONE_PHASE_COUNT = 7;

/**
 * Default phase plan for a site.
 *
 * Start wide, end tight. `start` is sized to cover the whole playable rect so
 * nobody begins the match already outside the ring — a ring that clips the
 * spawn area reads as a bug, not as pressure. Each later phase steps inward
 * until the last one is a small duel circle.
 *
 * @param {number} rectW  playable rect width
 * @param {number} rectH  playable rect height
 */
export function defaultPhases(rectW = 72, rectH = 110) {
  // Radius needed to cover the rect from its centre: half the diagonal.
  const cover = Math.hypot(rectW, rectH) / 2;
  const finalR = Math.max(10, Math.min(rectW, rectH) * 0.07);
  const count = 7;
  const phases = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i + 1) / count;
    // Ease-in: the early ring barely moves, the last phases snap closed.
    // Phase 1 is forced to cover the whole rect (plus 3% so a spawn in a
    // corner is safely inside rather than on the exact circle edge); easing it
    // would leave rect corners outside the opening ring, spawning in the gas.
    const r = i === 0 ? Math.max(10, cover * 0.94) : cover + (finalR - cover) * (t * t * 0.7 + t * 0.3);
    phases.push({
      wait: Math.max(8, 20 - i * 2),       // seconds the ring is announced
      shrink: Math.max(6, 24 - i * 3),     // seconds to interpolate inward
      radius: Number(r.toFixed(2)),
      dps: DEFAULT_DPS[Math.min(i, DEFAULT_DPS.length - 1)],
    });
  }
  return phases;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Create a zone controller.
 *
 * @param {object}   opts
 * @param {object}   opts.rect       playable rect {x0,x1,z0,z1} for this site
 * @param {object}   [opts.center]   initial centre; defaults to rect centre
 * @param {number}   [opts.inscribed] max circle radius fitting the rect
 * @param {function} [opts.rng]
 * @param {function} [opts.onPhase]  (phaseIndex, phase) when a phase starts
 * @param {function} [opts.onShrink] (phaseIndex) when shrinking begins
 * @param {function} [opts.onFinal]  () when the ring reaches its last size
 */
export function createZone({
  rect = { x0: -30, x1: 30, z0: -30, z1: 30 },
  center = null,
  rng = Math.random,
  startDelay = 0,
  warnAt = 15,
  onPhase = null,
  onShrink = null,
  onWarning = null,
  onFinal = null,
} = {}) {
  const rand = typeof rng === 'function' ? rng : Math.random;

  const w = Math.abs(rect.x1 - rect.x0);
  const d = Math.abs(rect.z1 - rect.z0);
  const maxInscribed = Math.max(6, Math.min(w, d) / 2);

  const phases = defaultPhases(w, d);
  // Opening circle must cover the map; phase 0 shrinks inward from here.
  const startR = Math.max(phases[0].radius, Math.hypot(w, d) / 2 * 1.03);
  const preDelay = Math.max(0, Number(startDelay) || 0);
  const warnLead = Math.max(1, Number(warnAt) || 15);
  let started = preDelay <= 0;
  let preT = 0;
  let warned = false;

  // Centre clamping. Phase 1 is wide enough to cover the whole rect, so it must
  // stay pinned to the rect centre; once the ring is inside the rect the centre
  // may drift by (radius - inscribed) without ever clipping playable ground.
  // maxOffX/maxOffZ are the drift budget for the *current* radius.
  const cx0 = rect.x0;
  const cx1 = rect.x1;
  const cz0 = rect.z0;
  const cz1 = rect.z1;

  let phaseIndex = 0;
  let t = 0;
  let shrinking = false;
  let finished = false;

  const base = center || { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 };
  let cur = { x: clamp(base.x, cx0, cx1), z: clamp(base.z, cz0, cz1), r: startR };
  let from = { ...cur };
  let next = pickNext(cur, startR);

  /** Clamp a centre so a circle of `radius` stays inside the rect. */
  function clampCentre(x, z, radius) {
    const lo = radius <= maxInscribed ? radius : maxInscribed;
    return {
      x: clamp(x, rect.x0 + lo, rect.x1 - lo),
      z: clamp(z, rect.z0 + lo, rect.z1 - lo),
    };
  }

  /** Pick a centre offset so the next ring nests inside the current one. */
  function pickNext(current, nextRadius) {
    const slack = Math.max(0, current.r - nextRadius);
    let cx = current.x;
    let cz = current.z;
    if (slack > 0.001) {
      // sqrt keeps the distribution uniform over the disc
      const a = rand() * Math.PI * 2;
      const dist = Math.sqrt(rand()) * slack;
      cx += Math.cos(a) * dist;
      cz += Math.sin(a) * dist;
    }
    const clamped = clampCentre(cx, cz, nextRadius);
    return { x: clamped.x, z: clamped.z, r: nextRadius };
  }

  function radiusFor(index) {
    const p = phases[index];
    return p ? p.radius : Math.max(8, cur.r * 0.8);
  }

  function phaseState() {
    const p = phases[phaseIndex] || null;
    return {
      phase: phaseIndex,
      total: phases.length,
      x: cur.x,
      z: cur.z,
      r: cur.r,
      nextX: next.x,
      nextZ: next.z,
      nextR: next.r,
      // seconds until the ring starts moving again (or until it finishes)
      eta: p ? (shrinking ? Math.max(0, p.shrink - t) : Math.max(0, p.wait - t)) : 0,
      started,
      delayLeft: started ? 0 : Math.max(0, preDelay - preT),
      startDelay: preDelay,
      shrinking,
      finished,
      dps: p ? p.dps : 0,
      inside: null,   // filled in by lastStatus()
    };
  }

  /** Pure containment test used by the owner to apply damage. */
  function contains(x, z, radius = cur.r, cx = cur.x, cz = cur.z) {
    return Math.hypot(x - cx, z - cz) <= radius;
  }

  /** Signed distance outside the ring (0 when safe, meters when unsafe). */
  function outsideDistance(x, z) {
    const d = Math.hypot(x - cur.x, z - cur.z);
    return Math.max(0, d - cur.r);
  }

  function lastStatus() {
    const s = phaseState();
    s.distance = lastDistance;
    s.inside = lastDistance <= 0;
    return s;
  }

  let lastDistance = 0;

  function enterPhase(i) {
    phaseIndex = i;
    t = 0;
    shrinking = false;
    const last = i >= phases.length;
    if (last) {
      finished = true;
      next = { x: cur.x, z: cur.z, r: cur.r };
      if (typeof onFinal === 'function') onFinal();
      return;
    }
    from = { x: cur.x, z: cur.z, r: cur.r };
    next = pickNext(cur, radiusFor(i));
    if (typeof onPhase === 'function') onPhase(i, phases[i]);
  }

  function update(dt, px = null, pz = null) {
    if (!started) {
      preT += dt;
      if (!warned && preDelay > 0 && preT >= preDelay - warnLead) {
        warned = true;
        if (typeof onWarning === 'function') onWarning();
      }
      if (preT >= preDelay) {
        started = true;
        preT = preDelay;
      } else {
        if (Number.isFinite(px) && Number.isFinite(pz)) lastDistance = 0;
        return lastStatus();
      }
    }
    if (finished) {
      if (Number.isFinite(px) && Number.isFinite(pz)) lastDistance = outsideDistance(px, pz);
      return lastStatus();
    }
    const p = phases[phaseIndex];
    if (!p) return lastStatus();
    t += dt;

    if (!shrinking) {
      if (t >= p.wait) {
        shrinking = true;
        t = 0;
        from = { x: cur.x, z: cur.z, r: cur.r };
        if (typeof onShrink === 'function') onShrink(phaseIndex);
      }
    } else {
      const k = clamp(t / Math.max(0.001, p.shrink), 0, 1);
      // smoothstep for a readable, non-linear-in-time squeeze
      const e = k * k * (3 - 2 * k);
      let x = from.x + (next.x - from.x) * e;
      let z = from.z + (next.z - from.z) * e;
      const r = from.r + (next.r - from.r) * e;
      // The endpoint centre is clamped for the target radius, but mid-shrink
      // radii are larger than the target — re-clamp every frame or the
      // intermediate circle clips the rect on its way in.
      const clamped = clampCentre(x, z, r);
      cur = { x: clamped.x, z: clamped.z, r };
      if (k >= 1) {
        cur = { x: next.x, z: next.z, r: next.r };
        enterPhase(phaseIndex + 1);
      }
    }

    if (Number.isFinite(px) && Number.isFinite(pz)) lastDistance = outsideDistance(px, pz);
    return lastStatus();
  }

  function reset() {
    phaseIndex = 0;
    started = preDelay <= 0;
    preT = 0;
    warned = false;
    t = 0;
    shrinking = false;
    finished = false;
    cur = {
      x: clamp(base.x, cx0, cx1),
      z: clamp(base.z, cz0, cz1),
      r: startR,
    };
    enterPhase(0);
    lastDistance = 0;
    return lastStatus();
  }

  /** Compact wire form for the LAN snapshot (16 KB budget). */
  function serialize() {
    const s = lastStatus();
    return {
      phase: s.phase,
      total: s.total,
      started: s.started,
      delayLeft: Number(s.delayLeft.toFixed(1)),
      startDelay: Number(s.startDelay.toFixed(1)),
      x: Number(s.x.toFixed(2)),
      z: Number(s.z.toFixed(2)),
      r: Number(s.r.toFixed(2)),
      nextX: Number(s.nextX.toFixed(2)),
      nextZ: Number(s.nextZ.toFixed(2)),
      nextR: Number(s.nextR.toFixed(2)),
      eta: Number(s.eta.toFixed(1)),
      shrinking: s.shrinking,
      finished: s.finished,
      dps: s.dps,
    };
  }

  /** Client-side mirror: adopt the host's ring, never simulate it. */
  function applyRemote(data) {
    if (!data || typeof data !== 'object') return lastStatus();
    const n = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    cur.x = n(data.x, cur.x);
    cur.z = n(data.z, cur.z);
    cur.r = n(data.r, cur.r);
    next = { x: n(data.nextX, cur.x), z: n(data.nextZ, cur.z), r: n(data.nextR, cur.r) };
    phaseIndex = n(data.phase, phaseIndex);
    started = data.started !== false;
    if (Number.isFinite(Number(data.startDelay))) {
      preDelay = Math.max(0, Number(data.startDelay));
    }
    preT = started ? preDelay : Math.max(0, preDelay - n(data.delayLeft, 0));
    warned = started || n(data.delayLeft, 0) <= 15;
    shrinking = data.shrinking === true;
    finished = data.finished === true;
    t = 0;
    return lastStatus();
  }

  enterPhase(0);

  return {
    update,
    contains,
    outsideDistance,
    serialize,
    applyRemote,
    reset,
    get state() {
      return lastStatus();
    },
    get rect() {
      return { ...rect };
    },
    get phases() {
      return phases.map((p) => ({ ...p }));
    },
    get isFinal() {
      return finished;
    },
  };
}

export default createZone;