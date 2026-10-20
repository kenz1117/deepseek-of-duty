/* =========================================================================
 * WORLD LABELS — diegetic-ish location tags for the important places.
 *
 * The wayfinder only ever names the next objective (usually the apartment
 * door), so players could not tell the HQ from a warehouse. These labels are
 * screen-space DOM tags anchored to world coordinates: nearest few, front
 * facing, distance-gated, with a subtle occlusion check.
 *
 * Deliberately self-contained (inline styles) so it does not fight the HUD
 * stylesheet.
 * ========================================================================= */

import * as THREE from 'three';

const POIS = [
  { id: 'hq', name: '北楼', en: 'NORTH HQ', x: 10, z: -72, y: 7.5, r: 85 },
  { id: 'checkpoint', name: '北检查站', en: 'CHECKPOINT', x: 0, z: -86, y: 4.5, r: 78 },
  { id: 'dock', name: '东码头', en: 'EAST DOCK', x: 42, z: -82, y: 4.2, r: 78 },
  { id: 'market', name: '后院市场', en: 'MARKET', x: 19, z: -10, y: 3.8, r: 58 },
  { id: 'yard', name: '南院车场', en: 'SOUTH YARD', x: 0, z: 72, y: 4.2, r: 70 },
  { id: 'apartment', name: '公寓正门', en: 'APARTMENTS', x: -19, z: 3, y: 4.0, r: 42 },
  { id: 'souk_gate', name: '老城入口', en: 'SOUK GATE', x: -34, z: 24, y: 4.6, r: 42 },
  { id: 'souk', name: '老城集市', en: 'OLD SOUK', x: -90, z: 42, y: 6.0, r: 70 },
  { id: 'minaret', name: '宣礼塔', en: 'MINARET', x: -110, z: 48, y: 7.0, r: 72 },
  { id: 'rail_gate', name: '北站入口', en: 'RAIL GATE', x: 6, z: -101, y: 4.6, r: 42 },
  { id: 'rail', name: '北站货场', en: 'RAIL DEPOT', x: 0, z: -170, y: 5.2, r: 72 },
  { id: 'platform', name: '高架站台', en: 'PLATFORM', x: 0, z: -150, y: 7.0, r: 58 },
  { id: 'port_gate', name: '港区入口', en: 'PORT GATE', x: 47, z: -80, y: 4.6, r: 42 },
  { id: 'port', name: '东港集装箱场', en: 'CONTAINER YARD', x: 80, z: -72, y: 5.4, r: 72 },
  { id: 'crane', name: '龙门吊', en: 'GANTRY', x: 100, z: -48, y: 7.0, r: 68 },
];

const CSS = {
  box: 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);pointer-events:none;' +
    'display:flex;align-items:center;gap:6px;padding:3px 7px 4px;white-space:nowrap;' +
    'background:linear-gradient(180deg,rgba(6,10,12,.72),rgba(6,10,12,.42));' +
    'border-left:2px solid rgba(226,180,92,.85);color:#e9e1d2;' +
    'font:600 10px/1.15 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.06em;' +
    'text-shadow:0 1px 2px rgba(0,0,0,.8);opacity:0;will-change:transform,opacity;',
  cn: 'font:700 11px/1.1 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;letter-spacing:.02em;',
  en: 'font:500 8px/1.1 "IBM Plex Mono",ui-monospace,monospace;opacity:.62;letter-spacing:.12em;',
  dist: 'font:600 9px/1.1 "IBM Plex Mono",ui-monospace,monospace;color:rgba(226,180,92,.9);margin-left:2px;',
};

export function createWorldLabels({ camera, level } = {}) {
  const host = typeof document !== 'undefined' ? document.getElementById('hud') : null;
  if (!host || !camera) {
    return { update() {}, setVisible() {}, get count() { return 0; } };
  }
  const layer = document.createElement('div');
  layer.id = 'world-labels';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4;';
  host.appendChild(layer);

  const tags = POIS.map((p) => {
    const el = document.createElement('div');
    el.style.cssText = CSS.box;
    const cn = document.createElement('span');
    cn.style.cssText = CSS.cn;
    cn.textContent = p.name;
    const en = document.createElement('span');
    en.style.cssText = CSS.en;
    en.textContent = p.en;
    const dist = document.createElement('span');
    dist.style.cssText = CSS.dist;
    dist.textContent = '—';
    el.append(cn, en, dist);
    layer.appendChild(el);
    return { p, el, dist, last: -1, visible: false };
  });

  const _fwd = new THREE.Vector3();
  const _proj = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _ray = new THREE.Raycaster();
  _ray.firstHitOnly = true;   // three-mesh-bvh: first hit per mesh is enough for occlusion
  const _blocked = new Map();
  let occlT = 0;
  let on = true;
  const visibleSet = new Set();
  // candidate pool: allocating {t,dist,dot} per POI per frame cost ~900 allocs/sec
  const _cand = [];
  const _candPool = [];
  let acc = 1;               // start hot so the first frame populates immediately
  const FRAME = 1 / 30;      // 30 Hz DOM projection — half the layout writes, still smooth

  function setVisible(v) {
    on = !!v;
    layer.style.display = on ? '' : 'none';
  }

  function update(dt, playerPos, cameraForward) {
    if (!on) return;
    acc += dt;
    if (acc < FRAME) return;
    acc = 0;
    const cam = camera;
    const fwd = cameraForward || cam.getWorldDirection(_fwd);
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    _cand.length = 0;
    for (const t of tags) {
      const dx = t.p.x - cam.position.x;
      const dz = t.p.z - cam.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > t.p.r) { t.visible = false; continue; }
      const inv = 1 / Math.max(0.001, dist);
      const dot = (dx * fwd.x + dz * fwd.z) * inv;
      if (dot < 0.12) { t.visible = false; continue; }
      const c = _candPool.pop() || { t: null, dist: 0, dot: 0 };
      c.t = t; c.dist = dist; c.dot = dot;
      t._d = Math.round(dist);
      _cand.push(c);
    }
    _cand.sort((a, b) => a.dist - b.dist);
    // Occlusion: a wall between the camera and the label hides it. This also
    // stops district tags leaking through the walls when the player is indoors.
    occlT -= FRAME;
    if (occlT <= 0) {
      occlT = 0.22;
      const objects = level && level.bulletTargets ? level.bulletTargets : null;
      if (objects) {
        _origin.copy(cam.position);
        const n = Math.min(_cand.length, 6);
        for (let i = 0; i < n; i++) {
          const c = _cand[i];
          _target.set(c.t.p.x, c.t.p.y, c.t.p.z);
          _ray.set(_origin, _target.sub(_origin).normalize());
          _ray.far = Math.max(1, c.dist - 0.8);
          const hit = _ray.intersectObjects(objects, false)[0];
          _blocked.set(c.t, !!hit);
        }
      }
    }
    visibleSet.clear();
    let kept = 0;
    for (const c of _cand) {
      if (kept >= 4) break;
      if (_blocked.get(c.t)) continue;
      visibleSet.add(c.t);
      kept++;
    }
    // recycle the candidate objects for the next frame
    for (const c of _cand) _candPool.push(c);
    for (const t of tags) {
      if (!visibleSet.has(t)) {
        if (t.visible) { t.el.style.opacity = '0'; t.visible = false; t._tx = null; }
        continue;
      }
      t.visible = true;
      _proj.set(t.p.x, t.p.y, t.p.z).project(cam);
      if (_proj.z > 1 || _proj.z < -1) {
        if (t._tx !== null) { t.el.style.opacity = '0'; t._tx = null; }
        continue;
      }
      // quantize to 0.5px / 0.01 so we only touch style when something moved
      const x = Math.round(((_proj.x * 0.5 + 0.5) * w) * 2) / 2;
      const y = Math.round(((-_proj.y * 0.5 + 0.5) * h) * 2) / 2;
      const d = t._d || 0;
      if (d !== t.last) { t.last = d; t.dist.textContent = `${d}m`; }
      const scale = Math.max(0.72, Math.min(1, Math.round((1.18 - d / 160) * 100) / 100));
      const op = Math.max(0.32, Math.min(0.92, Math.round((0.95 - d / 120) * 100) / 100));
      const key = x + ',' + y + ',' + scale;
      if (key !== t._tx) {
        t._tx = key;
        t.el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${scale.toFixed(2)})`;
      }
      if (op !== t._op) { t._op = op; t.el.style.opacity = op.toFixed(2); }
    }
  }

  return { update, setVisible, get count() { return tags.length; } };
}
