import * as THREE from 'three';

/* =========================================================================
   ARTILLERY — off-map fire support: staggered shells, trails, impact FX.

   Shells are pre-allocated (geometry + materials shared, reusable state
   objects). The only per-frame work is advancing a handful of shells and
   scanning the pending schedule; nothing is allocated inside update().

   Visual pack per shell:
     - steady fall from ~46 m, capsule body + hot tip, thin additive trail
       (reuses fx.tracer)
     - impact: fx.explosion (flash / fireball / smoke / shock rings / debris)
       plus a scorch decal, one damageAt() call and one onShake() call.
   ========================================================================= */

const MAX_ACTIVE = 10;      // simultaneous shells in the air (hard cap)
const MAX_PENDING = 64;     // scheduled impacts waiting for a free shell slot
const MAX_PER_STRIKE = 12;
const FALL_HEIGHT = 46;     // metres above the impact point
const FALL_TIME = 0.62;     // seconds of visible descent
const STAGGER = 1.6;        // spread of impact times inside one strike
const DAMAGE_RADIUS = 5.5;
const DAMAGE_AMOUNT = 120;
const TAU = Math.PI * 2;

const UP = new THREE.Vector3(0, 1, 0);

// shared option objects: fx.tracer only reads them, so no allocation per frame
const TRAIL_OPTS = { color: 0xffb268, width: 0.032, life: 0.09 };
const DEFAULT_OPTS = { shells: 6, radius: 9, delay: 0.9, spread: 6, hurtPlayer: true, playerDamage: 1 };

export function createArtillery({ scene, level, fx = null, audio = null, damageAt, onShake }) {
  const group = new THREE.Group();
  group.name = 'artillery';
  scene.add(group);

  /* ------------------------------------------------------------ resources */
  const shellGeo = new THREE.CapsuleGeometry(0.075, 0.5, 3, 8);
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x3c4046, roughness: 0.5, metalness: 0.82,
  });
  const tipGeo = new THREE.SphereGeometry(0.075, 8, 6);
  const tipMat = new THREE.MeshBasicMaterial({ color: 0xffc078, toneMapped: false });

  /* ------------------------------------------------------------ shell pool */
  const shells = [];
  for (let i = 0; i < MAX_ACTIVE; i++) {
    const mesh = new THREE.Mesh(shellGeo, shellMat);
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    // hot tip so the projectile reads as a streak even against bright sky
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = 0.33;
    mesh.add(tip);
    group.add(mesh);
    shells.push({
      used: false,
      t: 0,
      dur: FALL_TIME,
      mesh,
      pending: null,
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      prev: new THREE.Vector3(),
    });
  }

  /* ------------------------------------------------------------ schedules */
  const pending = [];
  for (let i = 0; i < MAX_PENDING; i++) {
    pending.push({
      used: false,
      fired: false,
      at: 0,
      spread: 0,
      // per-strike damage policy: a strike the PLAYER earned must never hurt
      // the player (see hurtPlayer), and a strike aimed AT the player scales
      // its own damage so the counter window stays readable.
      hurtPlayer: true,
      playerDamage: 1,
      point: new THREE.Vector3(),
      shell: null,
    });
  }

  let time = 0;
  let activeCount = 0;

  const groundHeight = level && typeof level.groundHeight === 'function'
    ? (x, z, y) => level.groundHeight(x, z, y)
    : () => 0;
  const bounds = level && level.bounds ? level.bounds : null;

  /* ------------------------------------------------------------ scratch */
  const _cur = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  function claimShell() {
    for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (!s.used) {
        s.used = true;
        activeCount += 1;
        return s;
      }
    }
    return null;
  }

  function freePending() {
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (!p.used) return p;
    }
    return null;
  }

  /* ------------------------------------------------------------ impact */
  function detonate(point, p) {
    if (fx && fx.explosion) fx.explosion(point, 0.95 + Math.random() * 0.2);
    if (fx && fx.addDecal) fx.addDecal(point, UP, 0.16 + Math.random() * 0.1, 'hole');
    if (damageAt) {
      damageAt(point, DAMAGE_RADIUS, DAMAGE_AMOUNT, {
        hurtPlayer: p ? p.hurtPlayer !== false : true,
        playerDamage: p && p.playerDamage != null ? p.playerDamage : 1,
      });
    }
    if (onShake) onShake(0.5 + Math.random() * 0.3);
    if (audio && audio.explosion) audio.explosion((Math.random() - 0.5) * 0.5, 26);
    if (p) {
      p.fired = true;
      p.used = false;
      p.shell = null;
    }
  }

  function impact(s) {
    const p = s.pending;
    s.pending = null;
    s.used = false;
    s.mesh.visible = false;
    activeCount = Math.max(0, activeCount - 1);
    detonate(s.end, p);
  }

  /* ------------------------------------------------------------ fall */
  function startFall(s, p) {
    const ang = Math.random() * TAU;
    const rad = Math.random() * p.spread * 0.5;
    s.start.set(
      p.point.x + Math.cos(ang) * rad,
      p.point.y + FALL_HEIGHT + Math.random() * 6,
      p.point.z + Math.sin(ang) * rad
    );
    s.end.copy(p.point);
    s.t = 0;
    s.dur = FALL_TIME;
    s.mesh.visible = true;
    s.mesh.position.copy(s.start);
    s.mesh.quaternion.identity();
    s.prev.copy(s.start);
    s.pending = p;
    p.shell = s;
  }

  function advance(s, dt) {
    s.t += dt;
    const k = Math.min(1, s.t / s.dur);
    const e = k * k; // gravity feel: accelerates into the ground
    _cur.lerpVectors(s.start, s.end, e);
    s.mesh.position.copy(_cur);
    _dir.subVectors(_cur, s.prev);
    if (_dir.lengthSq() > 1e-8) {
      _dir.normalize();
      _q.setFromUnitVectors(UP, _dir);
      s.mesh.quaternion.copy(_q);
    }
    if (fx && fx.tracer) fx.tracer(s.prev, _cur, TRAIL_OPTS);
    s.prev.copy(_cur);
    if (k >= 1) impact(s);
  }

  /* ------------------------------------------------------------ api */
  function strike(center, opts) {
    const o = opts || DEFAULT_OPTS;
    const wanted = o.shells === undefined ? DEFAULT_OPTS.shells : o.shells;
    const n = Math.max(1, Math.min(MAX_PER_STRIKE, wanted | 0));
    const radius = Math.max(0, o.radius === undefined ? DEFAULT_OPTS.radius : o.radius);
    const delay = Math.max(0, o.delay === undefined ? DEFAULT_OPTS.delay : o.delay);
    const spread = Math.max(0, o.spread === undefined ? DEFAULT_OPTS.spread : o.spread);
    const hurtPlayer = o.hurtPlayer === undefined ? DEFAULT_OPTS.hurtPlayer : !!o.hurtPlayer;
    const playerDamage = o.playerDamage === undefined ? DEFAULT_OPTS.playerDamage : Number(o.playerDamage);

    let scheduled = 0;
    for (let i = 0; i < n; i++) {
      const p = freePending();
      if (!p) break;

      const ang = Math.random() * TAU;
      const r = radius * Math.sqrt(Math.random()); // even coverage of the footprint
      let x = center.x + Math.cos(ang) * r;
      let z = center.z + Math.sin(ang) * r;
      if (bounds) {
        x = Math.max(bounds.x0 + 1, Math.min(bounds.x1 - 1, x));
        z = Math.max(bounds.z0 + 1, Math.min(bounds.z1 - 1, z));
      }
      // sample from high altitude so rooftops win over the street when overhead
      const y = groundHeight(x, z, 60);
      p.point.set(x, y + 0.04, z);
      p.spread = spread;
      p.hurtPlayer = hurtPlayer;
      p.playerDamage = playerDamage;
      p.at = time + delay + (i / n) * STAGGER + Math.random() * 0.12;
      p.used = true;
      p.fired = false;
      p.shell = null;
      scheduled += 1;
    }
    return scheduled;
  }

  function update(dt) {
    if (!(dt > 0)) return;
    time += dt;

    // 1) advance shells already in the air
    for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (s.used) advance(s, dt);
    }

    // 2) claim air slots for scheduled impacts
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (!p.used || p.fired || p.shell) continue;

      if (time >= p.at) {
        // schedule slipped behind the active cap: resolve without a ghost shell
        detonate(p.point, p);
        continue;
      }
      if (time < p.at - FALL_TIME) continue;

      const s = claimShell();
      if (!s) {
        p.at += 0.15; // all slots busy: retry shortly, keeps the impact alive
        continue;
      }
      startFall(s, p);
    }
  }

  function reset() {
    for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      s.used = false;
      s.t = 0;
      s.pending = null;
      s.mesh.visible = false;
      s.mesh.quaternion.identity();
    }
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      p.used = false;
      p.fired = false;
      p.at = 0;
      p.spread = 0;
      p.shell = null;
    }
    activeCount = 0;
    time = 0;
  }

  return {
    strike,
    update,
    reset,
    get active() {
      return activeCount;
    },
  };
}
