/* =========================================================================
   Tactical minimap.

   North-up, player-centred. Two ranges (42 m / 70 m), the wider one is
   persisted so the expanded Season 3 map reads well. Walls come from
   level.colliders (the same boxes the player collides with), so the map can
   never drift from the real level.

   Visual contract (the "less dizzy" pass):
     · ONE flat background. No translucent haze stacked on top of it.
     · Walls are a calm height ramp, not bright slabs.
     · The storm mask is neutral — never a colour wash over the whole panel.
     · No sweeping scan band: the old one strobed the entire map.
     · Only three things are allowed to be bright: you, hostiles, the goal.
     · Motion is limited to a slow pulse on the objective marker.

   Fog of war: hostiles are revealed only when they are close AND in line of
   sight, when they are shooting (gunfire pings through walls), or while the
   UAV is up. Loot uses the same line of sight, so the map is not a wallhack.
   ========================================================================= */

import { segmentBlockedByColliders } from '../systems/ai/geom.js';

const RANGES = [42, 70];
const WIDE_RANGE = RANGES[RANGES.length - 1];
const RANGE_KEY = 'dod.minimapRange';
const DRAW_HZ = 10;

const EYE_Y = 1.55;              // eye height used for the reveal line of sight
const REVEAL_NEAR = 20;          // m — close and visible
const REVEAL_ENGAGED = 38;       // m — soldiers that are shooting at you
const REVEAL_UAV = 55;           // m — while the UAV is up
const LOOT_REVEAL = 46;          // m — loot with a clear line of sight
const LOOT_REVEAL_CLOSE = 13;    // m — loot in plain sight, walls or not

const P = {
  bg: '#070b0f',
  grid: 'rgba(122,158,172,0.10)',
  gridMajor: 'rgba(122,158,172,0.17)',
  /* Wall mask: the bake is drawn with "lighten", so overlapping buildings
     take the brightest tone instead of stacking alpha into a white blob.
     The sheet is then laid over the map with one flat alpha, which is what
     keeps a dense city block from turning into a grey smear. */
  wallMask: [
    'rgb(58,68,76)',             // low cover / crates
    'rgb(112,132,146)',          // mid walls
    'rgb(168,192,206)',          // tall buildings
  ],
  wallMaskEdge: 'rgb(214,236,248)',
  wallAlpha: 0.34,
  storm: 'rgba(2,5,8,0.52)',
  ring: 'rgba(94,222,208,0.72)',
  ringGlow: 'rgba(94,222,208,0.10)',
  nextRing: 'rgba(226,240,244,0.30)',
  player: '#6fe3ff',
  playerEdge: 'rgba(4,16,22,0.9)',
  enemy: '#ff5646',
  enemySoft: 'rgba(255,86,70,0.30)',
  ally: '#8bff9f',
  obj: '#ffb25e',
  objDone: '#9dffa8',
  frame: 'rgba(233,238,240,0.10)',
  bracket: 'rgba(111,227,255,0.24)',
};

/* Loot markers: colour + shape, so the map reads without a big legend. */
const LOOT = {
  ammo: { c: '#ffab4d', s: 'square' },
  armor: { c: '#6ea9d4', s: 'triangle' },
  grenade: { c: '#8fbc84', s: 'dot' },
  supply: { c: '#d8d2c4', s: 'diamond' },
  armor1: { c: '#7fa8c9', s: 'hex' },
  armor2: { c: '#59c2f0', s: 'hex' },
  armor3: { c: '#bfe94f', s: 'hex' },
  helmet1: { c: '#9aa8b5', s: 'hex' },
  helmet2: { c: '#6fe3ff', s: 'hex' },
  helmet3: { c: '#d7b34f', s: 'hex' },
  bandage: { c: '#e8e2d2', s: 'bar' },
  medkit: { c: '#ff6a5e', s: 'cross' },
  drink: { c: '#7fe08a', s: 'dot' },
};

const NOOP = {
  update() {}, toggle() { return false; }, setVisible() {}, draw() {},
  cycleZoom() { return RANGES[0]; },
  get range() { return RANGES[0]; },
  get visible() { return false; },
};

export function createMinimap({ level } = {}) {
  const wrap = document.getElementById('minimap-wrap');
  const canvas = document.getElementById('minimap');
  const regionEl = document.getElementById('mm-region');
  if (!wrap || !canvas) return NOOP;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  /* ---------------------------------------------------------------- chrome */
  let zoomBtn = document.getElementById('mm-zoom');
  if (!zoomBtn) {
    zoomBtn = document.createElement('button');
    zoomBtn.id = 'mm-zoom';
    zoomBtn.className = 'mm-zoom';
    zoomBtn.type = 'button';
    wrap.appendChild(zoomBtn);
  }

  let range = RANGES[0];
  try {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    if (RANGES.includes(saved)) range = saved;
  } catch (e) { /* ignore */ }
  let scale = W / (range * 2);
  let lastState = { x: 0, z: 0, heading: 0, enemies: [], uav: false };
  let lastTime = 0;

  // DOM overlays kept outside the canvas so the type stays crisp at 166 px.
  let scaleEl = document.getElementById('mm-scale');
  if (!scaleEl) {
    scaleEl = document.createElement('span');
    scaleEl.id = 'mm-scale';
    scaleEl.className = 'mm-scale';
    scaleEl.setAttribute('aria-hidden', 'true');
    const line = document.createElement('i');
    const label = document.createElement('b');
    scaleEl.append(line, label);
    wrap.appendChild(scaleEl);
  }
  const scaleLine = scaleEl.querySelector('i');
  const scaleLabel = scaleEl.querySelector('b');

  let objDistEl = document.getElementById('mm-objdist');
  if (!objDistEl) {
    objDistEl = document.createElement('span');
    objDistEl.id = 'mm-objdist';
    objDistEl.className = 'mm-objdist';
    objDistEl.hidden = true;
    wrap.appendChild(objDistEl);
  }

  // Loot legend — sits under the map, not on it.
  let legendEl = document.getElementById('mm-legend');
  if (!legendEl && wrap.parentNode) {
    legendEl = document.createElement('div');
    legendEl.id = 'mm-legend';
    legendEl.className = 'mm-legend';
    legendEl.setAttribute('aria-hidden', 'true');
    const rows = [
      ['ammo', '弹药'], ['armor', '护甲'], ['medkit', '医疗'], ['grenade', '手雷'], ['supply', '补给'],
    ];
    for (const [kind, label] of rows) {
      const item = document.createElement('span');
      const glyph = document.createElement('i');
      glyph.className = `mmk mmk-${kind}`;
      const text = document.createElement('em');
      text.textContent = label;
      item.append(glyph, text);
      legendEl.appendChild(item);
    }
    wrap.parentNode.insertBefore(legendEl, wrap.nextSibling);
  }
  let scaleKey = '';

  function updateScaleBar() {
    const cssW = wrap.clientWidth || 166;
    const meters = range >= WIDE_RANGE ? 20 : 10;
    const px = Math.max(8, Math.round((cssW / (range * 2)) * meters));
    const key = `${range}:${cssW}:${meters}`;
    if (key === scaleKey) return;
    scaleKey = key;
    if (scaleLine) scaleLine.style.width = `${px}px`;
    if (scaleLabel) scaleLabel.textContent = `${meters}m`;
  }

  function updateObjectiveDistance(obj, px, pz) {
    if (!objDistEl) return;
    if (!obj || !obj.zone) {
      objDistEl.hidden = true;
      return;
    }
    const dist = Math.round(Math.hypot(obj.zone.x - px, obj.zone.z - pz));
    objDistEl.hidden = false;
    objDistEl.textContent = obj.done ? '目标已完成' : `目标 ${dist}m`;
    objDistEl.classList.toggle('is-done', !!obj.done);
  }

  function paintZoom() {
    if (zoomBtn) {
      zoomBtn.textContent = `${range}m`;
      zoomBtn.setAttribute('aria-label', `小地图范围 ${range} 米，点击切换`);
      zoomBtn.title = `小地图范围 ${range}m / ${RANGES.filter((r) => r !== range).join('m / ')}m`;
    }
    updateScaleBar();
  }
  paintZoom();

  /* ---------------------------------------------------------------- walls */
  /* Low kerbs and decals do not belong on a tactical map; they are dropped
     and what remains is bucketed by height into a calm three-step ramp. */
  const colliders = level && level.colliders ? level.colliders : [];
  const walls = colliders
    .filter((c) => {
      const top = c.top == null ? 10 : c.top;
      if (top < 1.6) return false;                       // kerbs and decals
      // props smaller than a crate are grain, not structure
      return !((c.x1 - c.x0) < 1.2 && (c.z1 - c.z0) < 1.2);
    })
    .map((c) => {
      const top = c.top == null ? 10 : c.top;
      return {
        x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1,
        bucket: top >= 6 ? 2 : top >= 3 ? 1 : 0,
      };
    });

  /* Walls are static for the whole session, so they are rasterised ONCE per
     range into an offscreen world-space sheet; every redraw is then a single
     1:1 drawImage blit. The sheet is baked at exactly the on-screen scale of
     that range, so the edges stay pixel-crisp instead of shimmering while the
     player walks. */
  const bakes = new Map();
  function bakeFor(r) {
    const hit = bakes.get(r);
    if (hit) return hit;
    const out = { c: null, x0: 0, z0: 0, k: 1 };
    if (walls.length) {
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (const c of walls) {
        if (c.x0 < bx0) bx0 = c.x0;
        if (c.x1 > bx1) bx1 = c.x1;
        if (c.z0 < bz0) bz0 = c.z0;
        if (c.z1 > bz1) bz1 = c.z1;
      }
      bx0 -= 2; bz0 -= 2; bx1 += 2; bz1 += 2;
      const k = W / (r * 2);
      const bc = document.createElement('canvas');
      bc.width = Math.max(1, Math.ceil((bx1 - bx0) * k));
      bc.height = Math.max(1, Math.ceil((bz1 - bz0) * k));
      const bctx = bc.getContext('2d');
      // "lighten" keeps the brightest tone where buildings overlap, so a
      // block made of six boxes does not turn into one white slab
      bctx.globalCompositeOperation = 'lighten';
      for (let b = 0; b < 3; b++) {
        bctx.fillStyle = P.wallMask[b];
        for (const c of walls) {
          if (c.bucket !== b) continue;
          bctx.fillRect((c.x0 - bx0) * k, (c.z0 - bz0) * k,
            Math.max(0.4 * k, (c.x1 - c.x0) * k), Math.max(0.4 * k, (c.z1 - c.z0) * k));
        }
      }
      // a hairline edge on the tall blocks: without it a block reads as one
      // flat grey slab and the map looks like a checkerboard
      bctx.strokeStyle = P.wallMaskEdge;
      bctx.lineWidth = 1;
      for (const c of walls) {
        if (c.bucket !== 2) continue;
        const x = (c.x0 - bx0) * k;
        const z = (c.z0 - bz0) * k;
        const w = Math.max(0.4 * k, (c.x1 - c.x0) * k);
        const h = Math.max(0.4 * k, (c.z1 - c.z0) * k);
        bctx.strokeRect(x + 0.5, z + 0.5, w - 1, h - 1);
      }
      bctx.globalCompositeOperation = 'source-over';
      out.c = bc; out.x0 = bx0; out.z0 = bz0; out.k = k;
    }
    bakes.set(r, out);
    return out;
  }

  /** 1:1 blit of the baked wall sheet for the current viewport. */
  function blitWalls(px, pz) {
    const bake = bakeFor(range);
    if (!bake.c) return;
    const k = bake.k;
    const sx = (px - range - bake.x0) * k;
    const sy = (pz - range - bake.z0) * k;
    const sw = range * 2 * k;           // === W, so the scale factor is 1
    const sh = range * 2 * k;           // === H
    const ix = Math.floor(sx), iy = Math.floor(sy);
    const ix2 = Math.min(bake.c.width, Math.ceil(sx + sw));
    const iy2 = Math.min(bake.c.height, Math.ceil(sy + sh));
    if (ix2 <= ix || iy2 <= iy) return;
    const dx = (ix - sx) * (W / sw);
    const dy = (iy - sy) * (H / sh);
    const dw = (ix2 - ix) * (W / sw);
    const dh = (iy2 - iy) * (H / sh);
    ctx.save();
    ctx.globalAlpha = P.wallAlpha;
    ctx.drawImage(bake.c, ix, iy, ix2 - ix, iy2 - iy, dx, dy, dw, dh);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- state */
  let on = true;
  try { on = localStorage.getItem('dod.minimap') !== '0'; } catch (e) { /* ignore */ }
  let acc = 0;
  let lastRegion = '';

  function setVisible(v) {
    on = !!v;
    wrap.classList.toggle('hidden', !on);
    if (legendEl) legendEl.classList.toggle('hidden', !on);
    try { localStorage.setItem('dod.minimap', on ? '1' : '0'); } catch (e) { /* ignore */ }
    // repaint with the real state — the old path drew a map centred on the
    // world origin, which flashed a completely unrelated block of streets.
    if (on) draw(lastState, lastTime);
  }
  if (!on) {
    wrap.classList.add('hidden');
    if (legendEl) legendEl.classList.add('hidden');
  }

  function toggle() { setVisible(!on); return on; }

  function cycleZoom() {
    const i = RANGES.indexOf(range);
    range = RANGES[(i + 1) % RANGES.length];
    scale = W / (range * 2);
    try { localStorage.setItem(RANGE_KEY, String(range)); } catch (e) { /* ignore */ }
    paintZoom();
    if (on) draw(lastState, lastTime);
    return range;
  }

  /* ------------------------------------------------------------- helpers */
  function lineOfSight(px, pz, tx, tz, ty = EYE_Y) {
    if (!colliders.length) return true;
    return !segmentBlockedByColliders(px, EYE_Y, pz, tx, ty, tz, colliders).blocked;
  }

  function markerPath(shape, x, y, r) {
    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else if (shape === 'triangle') {
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r, y + r * 0.8);
      ctx.lineTo(x - r, y + r * 0.8);
      ctx.closePath();
    } else if (shape === 'diamond') {
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.1, y);
      ctx.lineTo(x, y + r * 1.2);
      ctx.lineTo(x - r * 1.1, y);
      ctx.closePath();
    } else if (shape === 'hex') {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px2 = x + Math.cos(a) * r * 1.1;
        const py2 = y + Math.sin(a) * r * 1.1;
        if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
      }
      ctx.closePath();
    } else if (shape === 'cross') {
      const t = r * 0.42;
      ctx.rect(x - r, y - t, r * 2, t * 2);
      ctx.rect(x - t, y - r, t * 2, r * 2);
    } else if (shape === 'bar') {
      ctx.rect(x - r * 1.2, y - r * 0.5, r * 2.4, r);
    } else {
      ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    }
  }

  function drawLoot(x, y, kind) {
    const def = LOOT[kind];
    if (!def) return;
    const r = range >= WIDE_RANGE ? 3.1 : 3.6;
    ctx.save();
    // dark halo first: keeps the marker readable on top of a bright wall
    ctx.strokeStyle = 'rgba(4,10,13,0.75)';
    ctx.lineWidth = 2.6;
    markerPath(def.s, x, y, r);
    ctx.stroke();
    ctx.fillStyle = def.c;
    markerPath(def.s, x, y, r);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- draw */
  function draw(s, time) {
    lastState = s;
    lastTime = time;
    const px = s.x;
    const pz = s.z;
    const toX = (x) => W / 2 + (x - px) * scale;
    const toY = (z) => H / 2 + (z - pz) * scale;

    ctx.clearRect(0, 0, W, H);

    /* -- base: one flat panel, no stacking of translucent layers ---------- */
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.62);
    glow.addColorStop(0, 'rgba(38,66,78,0.20)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    /* -- grid: one quiet lattice, matched to the range ------------------- */
    function drawGrid(step, stroke, width) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      const gx0 = Math.floor((px - range) / step) * step;
      const gz0 = Math.floor((pz - range) / step) * step;
      ctx.beginPath();
      for (let gx = gx0; gx <= px + range; gx += step) {
        const x = Math.round(toX(gx)) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (let gz = gz0; gz <= pz + range; gz += step) {
        const y = Math.round(toY(gz)) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    // the wide view drops to a 20 m lattice: a 10 m grid over 140 m of map is
    // graph paper, and the noise is exactly what makes the panel hard to read
    if (range >= WIDE_RANGE) drawGrid(20, P.gridMajor, 1);
    else drawGrid(10, P.grid, 1);

    updateScaleBar();

    /* -- walls: one 1:1 blit from the static bake ------------------------ */
    blitWalls(px, pz);

    /* -- storm: neutral mask outside the ring (no colour wash) ----------- */
    const zone = s.zone;
    if (zone && Number.isFinite(zone.x) && Number.isFinite(zone.r)) {
      const zx = toX(zone.x);
      const zy = toY(zone.z);
      const zr = Math.max(4, zone.r * scale);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);   // reverse winding -> hole
      ctx.fillStyle = P.storm;
      ctx.fill();
      ctx.restore();

      // current ring edge: a soft halo plus a crisp stroke
      ctx.beginPath();
      ctx.arc(zx, zy, zr, 0, Math.PI * 2);
      ctx.strokeStyle = P.ringGlow;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(zx, zy, zr, 0, Math.PI * 2);
      ctx.strokeStyle = P.ring;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      // next ring preview (only while the match still has phases to run)
      if (!zone.finished && Number.isFinite(zone.nextR) && zone.nextR > 1) {
        const nx = toX(zone.nextX);
        const ny = toY(zone.nextZ);
        const nr = Math.max(3, zone.nextR * scale);
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.strokeStyle = zone.shrinking ? 'rgba(226,240,244,0.22)' : P.nextRing;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }

    /* -- objective ------------------------------------------------------- */
    const obj = s.objective;
    updateObjectiveDistance(obj, px, pz);
    if (obj && obj.zone) {
      const zx = toX(obj.zone.x);
      const zy = toY(obj.zone.z);
      const wide = range >= WIDE_RANGE;
      const zr = Math.max(wide ? 5 : 3.5, obj.zone.r * scale);
      const inView = zx > -zr && zx < W + zr && zy > -zr && zy < H + zr;
      const tint = obj.done ? P.objDone : P.obj;
      if (inView) {
        ctx.beginPath();
        ctx.arc(zx, zy, zr, 0, Math.PI * 2);
        ctx.fillStyle = obj.done ? 'rgba(157,255,168,0.10)' : 'rgba(255,178,94,0.10)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(zx, zy, zr, 0, Math.PI * 2);
        ctx.strokeStyle = tint;
        ctx.lineWidth = wide ? 2.2 : 1.8;
        ctx.stroke();
        // a slow pulse, the only motion the panel is allowed
        const pulse = 0.5 + 0.5 * Math.sin((time || 0) * 2.2);
        ctx.beginPath();
        ctx.arc(zx, zy, zr + 3 + pulse * 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = obj.done ? 'rgba(157,255,168,0.20)' : 'rgba(255,178,94,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(zx, zy - 4.5);
        ctx.lineTo(zx + 4.5, zy);
        ctx.lineTo(zx, zy + 4.5);
        ctx.lineTo(zx - 4.5, zy);
        ctx.closePath();
        ctx.fillStyle = tint;
        ctx.fill();
      } else {
        // off the map: a chevron on the border that points the way
        const dx = zx - W / 2;
        const dy = zy - H / 2;
        const len = Math.hypot(dx, dy) || 1;
        const k = (W / 2 - 14) / len;
        const ex = W / 2 + dx * k;
        const ey = H / 2 + dy * k;
        const a = Math.atan2(dy, dx);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-5, 6);
        ctx.lineTo(-5, -6);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(4,10,13,0.85)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = tint;
        ctx.fill();
        ctx.restore();
      }
    }

    /* -- loot ------------------------------------------------------------ */
    if (s.pickups && s.pickups.length) {
      for (const it of s.pickups) {
        if (!it) continue;
        const dx = it.x - px;
        const dz = it.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist > LOOT_REVEAL) continue;
        if (dist > LOOT_REVEAL_CLOSE && !lineOfSight(px, pz, it.x, it.z)) continue;
        const x = toX(it.x);
        const y = toY(it.z);
        if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
        drawLoot(x, y, it.kind);
      }
    }

    /* -- allies ---------------------------------------------------------- */
    if (s.allies && s.allies.length) {
      for (const a of s.allies) {
        if (!a) continue;
        const x = toX(a.x);
        const y = toY(a.z);
        if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
        ctx.save();
        ctx.translate(x, y);
        if (Number.isFinite(a.yaw)) ctx.rotate(-a.yaw);
        ctx.beginPath();
        ctx.moveTo(0, -5.2);
        ctx.lineTo(4.2, 4.2);
        ctx.lineTo(0, 1.8);
        ctx.lineTo(-4.2, 4.2);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(4,14,10,0.8)';
        ctx.lineWidth = 2.4;
        ctx.stroke();
        ctx.fillStyle = P.ally;
        ctx.fill();
        ctx.restore();
      }
    }

    /* -- hostiles: close + visible, shooting, or under the UAV ----------- */
    if (s.enemies) {
      for (const e of s.enemies) {
        if (!e || !e.alive) continue;
        const ex = e.root ? e.root.position.x : e.pos.x;
        const ez = e.root ? e.root.position.z : e.pos.z;
        if (!Number.isFinite(ex) || !Number.isFinite(ez)) continue;
        // a soldier on a roof is seen over the roof, not through it
        const ey = (e.root ? e.root.position.y : 0) + 1.5;
        const dist = Math.hypot(ex - px, ez - pz);
        const engaged = (e.burstLeft > 0) || e.warnActive || e.isBoss;
        const revealed = (engaged && dist < REVEAL_ENGAGED)
          || (s.uav && dist < REVEAL_UAV)
          || (dist < REVEAL_NEAR && lineOfSight(px, pz, ex, ez, ey));
        if (!revealed) continue;
        const x = toX(ex);
        const y = toY(ez);
        if (x < -6 || y < -6 || x > W + 6 || y > H + 6) continue;
        if (e.isBoss) {
          ctx.beginPath();
          ctx.arc(x, y, 4.6, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(4,10,13,0.8)';
          ctx.lineWidth = 2.6;
          ctx.stroke();
          ctx.fillStyle = P.enemy;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, 7.6, 0, Math.PI * 2);
          ctx.strokeStyle = P.enemySoft;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(x, y - 4.4);
          ctx.lineTo(x + 3.6, y + 3.2);
          ctx.lineTo(x - 3.6, y + 3.2);
          ctx.closePath();
          ctx.strokeStyle = 'rgba(4,10,13,0.8)';
          ctx.lineWidth = 2.4;
          ctx.stroke();
          ctx.fillStyle = P.enemy;
          ctx.fill();
          if (engaged) {
            ctx.beginPath();
            ctx.arc(x, y, 6.4, 0, Math.PI * 2);
            ctx.strokeStyle = P.enemySoft;
            ctx.lineWidth = 1.3;
            ctx.stroke();
          }
        }
      }
    }

    /* -- you: arrow + a restrained view cone ------------------------------ */
    const heading = (s.heading || 0) * Math.PI / 180;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -30);
    ctx.lineTo(21, 23);
    ctx.lineTo(0, 12);
    ctx.lineTo(-21, 23);
    ctx.closePath();
    ctx.fillStyle = 'rgba(111,227,255,0.12)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(8.5, 9.5);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8.5, 9.5);
    ctx.closePath();
    ctx.strokeStyle = P.playerEdge;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = P.player;
    ctx.fill();
    ctx.restore();

    /* -- frame: corner brackets keep the panel looking like an instrument - */
    ctx.save();
    ctx.strokeStyle = P.bracket;
    ctx.lineWidth = 1.6;
    const inset = 4;
    const arm = 11;
    const corners = [
      [inset, inset, 1, 1], [W - inset, inset, -1, 1],
      [inset, H - inset, 1, -1], [W - inset, H - inset, -1, -1],
    ];
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of corners) {
      ctx.moveTo(cx + sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * arm);
    }
    ctx.stroke();
    ctx.strokeStyle = P.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.restore();

    /* -- region label ---------------------------------------------------- */
    if (level && level.regionAt) {
      const r = level.regionAt(px, pz);
      if (r && r.name !== lastRegion) {
        lastRegion = r.name;
        if (regionEl) regionEl.textContent = r.name;
      }
    }
  }

  function update(dt, s) {
    if (!on) return;
    acc += dt;
    if (acc < 1 / DRAW_HZ) return;
    const step = acc;
    acc = 0;
    draw(s, (s.time || 0) + step);
  }

  if (zoomBtn) {
    zoomBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleZoom();
    });
    zoomBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  return {
    update,
    toggle,
    setVisible,
    cycleZoom,
    draw: (s) => draw(s, 0),
    get visible() { return on; },
    get range() { return range; },
  };
}
