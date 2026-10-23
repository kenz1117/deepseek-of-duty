/* =========================================================================
   Tactical minimap.

   North-up, player-centred, 150 px square. Range cycles 42 m / 70 m; the
   wider setting is persisted so the expanded Season 3 map reads well.
   Walls come from level.colliders (the same boxes the player collides with),
   so the map can never drift from the real level. Enemies are only revealed
   when they are close, actively firing, or the UAV is up.
   ========================================================================= */

const RANGES = [42, 70];   // metres from centre to edge
const RANGE_KEY = 'dod.minimapRange';
const DRAW_HZ = 10;

export function createMinimap({ level }) {
  const wrap = document.getElementById('minimap-wrap');
  const canvas = document.getElementById('minimap');
  const regionEl = document.getElementById('mm-region');
  if (!wrap || !canvas) return {
    update() {}, toggle() {}, setVisible() {}, draw() {},
    cycleZoom() { return 42; }, get range() { return 42; },
    get visible() { return false; },
  };
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  let zoomBtn = document.getElementById('mm-zoom');
  if (!zoomBtn) {
    zoomBtn = document.createElement('button');
    zoomBtn.id = 'mm-zoom';
    zoomBtn.className = 'mm-zoom';
    zoomBtn.type = 'button';
    zoomBtn.setAttribute('aria-label', '切换小地图范围 42 米 / 70 米');
    zoomBtn.title = '小地图范围 42m / 70m';
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

  // DOM overlays kept outside the canvas so the scale stays crisp at 166 px.
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
  let scaleKey = '';

  function updateScaleBar() {
    const cssW = wrap.clientWidth || 166;
    const meters = range >= 70 ? 20 : 10;
    const px = Math.max(8, Math.round((cssW / (range * 2)) * meters));
    const key = `${range}:${cssW}:${meters}`;
    if (key === scaleKey) return;
    scaleKey = key;
    if (scaleLine) scaleLine.style.width = `${px}px`;
    if (scaleLabel) scaleLabel.textContent = `${meters}m`;
  }

  function updateObjectiveDistance(obj, px, pz) {
    if (!objDistEl) return;
    if (range < 70 || !obj || !obj.zone) {
      objDistEl.hidden = true;
      return;
    }
    const dist = Math.round(Math.hypot(obj.zone.x - px, obj.zone.z - pz));
    objDistEl.hidden = false;
    objDistEl.textContent = `OBJ ${dist}m`;
    objDistEl.classList.toggle('is-done', !!obj.done);
  }

  function paintZoom() {
    if (zoomBtn) zoomBtn.textContent = `${range}m`;
    updateScaleBar();
  }
  paintZoom();

  // pre-filter the collider list once: low kerbs and decals do not belong.
  // tiny footprint / tiny height junk is also dropped in the 70m view only.
  const walls = (level && level.colliders ? level.colliders : [])
    .filter((c) => (c.top == null ? 10 : c.top) >= 1.2)
    .map((c) => {
      const top = c.top == null ? 10 : c.top;
      return {
        x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1,
        tall: top >= 6,
        tiny: (c.x1 - c.x0) < 1.2 && (c.z1 - c.z0) < 1.2,
      };
    });

  /* Walls are static for the whole session, so rasterize them ONCE into an
     offscreen world-space sheet; every redraw is then a single drawImage blit.
     (The old path issued up to ~3k fillRect per redraw at 10 Hz — the biggest
     2D canvas cost in the HUD.) */
  let wallBake = null;
  if (walls.length) {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const c of walls) {
      if (c.x0 < bx0) bx0 = c.x0;
      if (c.x1 > bx1) bx1 = c.x1;
      if (c.z0 < bz0) bz0 = c.z0;
      if (c.z1 > bz1) bz1 = c.z1;
    }
    bx0 -= 2; bz0 -= 2; bx1 += 2; bz1 += 2;
    const k = Math.min(6, 2048 / Math.max(bx1 - bx0, bz1 - bz0));
    const bc = document.createElement('canvas');
    bc.width = Math.max(1, Math.ceil((bx1 - bx0) * k));
    bc.height = Math.max(1, Math.ceil((bz1 - bz0) * k));
    const bctx = bc.getContext('2d');
    // low cover first (translucent), tall walls on top (solid) — same stacking
    // as the live pass, with a compromise alpha between the 42m/70m stylings
    bctx.fillStyle = 'rgba(106,118,126,0.30)';
    for (const c of walls) {
      if (c.tall) continue;
      bctx.fillRect((c.x0 - bx0) * k, (c.z0 - bz0) * k,
        Math.max(0.35 * k, (c.x1 - c.x0) * k), Math.max(0.35 * k, (c.z1 - c.z0) * k));
    }
    bctx.fillStyle = 'rgba(160,178,188,0.72)';
    for (const c of walls) {
      if (!c.tall) continue;
      bctx.fillRect((c.x0 - bx0) * k, (c.z0 - bz0) * k,
        Math.max(0.6 * k, (c.x1 - c.x0) * k), Math.max(0.6 * k, (c.z1 - c.z0) * k));
    }
    wallBake = { c: bc, x0: bx0, z0: bz0, k };
  }

  let on = true;
  try { on = localStorage.getItem('dod.minimap') !== '0'; } catch (e) { /* ignore */ }
  let acc = 0;
  let lastRegion = '';

  function setVisible(v) {
    on = !!v;
    wrap.classList.toggle('hidden', !on);
    try { localStorage.setItem('dod.minimap', on ? '1' : '0'); } catch (e) { /* ignore */ }
    if (on) draw({ x: 0, z: 0, heading: 0, enemies: [], uav: false }, 0);
  }
  if (!on) wrap.classList.add('hidden');

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

  function draw(s, time) {
    lastState = s;
    lastTime = time;
    const px = s.x;
    const pz = s.z;
    const toX = (x) => W / 2 + (x - px) * scale;
    const toY = (z) => H / 2 + (z - pz) * scale;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,13,0.72)';
    ctx.fillRect(0, 0, W, H);

    // grid: 42m keeps the original single 10m grid; 70m gets a brighter
    // 10m grid + 20m major lines so the larger view still has a sense of scale.
    function drawGrid(step, stroke, width) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      const gx0 = Math.floor((px - range) / step) * step;
      const gz0 = Math.floor((pz - range) / step) * step;
      for (let gx = gx0; gx <= px + range; gx += step) {
        const x = toX(gx);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let gz = gz0; gz <= pz + range; gz += step) {
        const y = toY(gz);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }
    if (range >= 70) {
      drawGrid(10, 'rgba(150,180,190,0.18)', 1);
      drawGrid(20, 'rgba(150,180,190,0.30)', 1.4);
    } else {
      drawGrid(10, 'rgba(150,180,190,0.13)', 1);
    }

    updateScaleBar();

    // walls: one blit from the static bake (see above); the source rect maps
    // world [px-range, px+range] onto the full canvas, matching toX/toY exactly
    if (wallBake) {
      const bs = range * 2 * wallBake.k;
      ctx.drawImage(wallBake.c,
        (px - range - wallBake.x0) * wallBake.k, (pz - range - wallBake.z0) * wallBake.k, bs, bs,
        0, 0, W, H);
    }

    // safe-zone ring (versus): darken everything outside the current ring,
    // stroke the ring itself, then preview the next ring as a dashed white
    // circle — the battle-royale read. Drawn before objectives so beacons
    // stay on top.
    const zone = s.zone;
    if (zone && Number.isFinite(zone.x) && Number.isFinite(zone.r)) {
      const zx = toX(zone.x);
      const zy = toY(zone.z);
      const zr = Math.max(4, zone.r * scale);

      // outside-darkening: even-odd fill between the full canvas and the ring
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);   // reverse winding -> hole
      ctx.fillStyle = 'rgba(20,60,66,0.34)';
      ctx.fill();
      ctx.restore();

      // current ring edge
      ctx.beginPath();
      ctx.arc(zx, zy, zr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(89,214,201,0.92)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // next ring preview (only while the match still has phases to run)
      if (!zone.finished && Number.isFinite(zone.nextR) && zone.nextR > 1) {
        const nx = toX(zone.nextX);
        const ny = toY(zone.nextZ);
        const nr = Math.max(3, zone.nextR * scale);
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.arc(nx, ny, nr, 0, Math.PI * 2);
        ctx.strokeStyle = zone.shrinking ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // objective zone
    const obj = s.objective;
    updateObjectiveDistance(obj, px, pz);
    if (obj && obj.zone) {
      const zx = toX(obj.zone.x);
      const zy = toY(obj.zone.z);
      const wide = range >= 70;
      const zr = Math.max(wide ? 5 : 3, obj.zone.r * scale);
      const inView = zx > -zr && zx < W + zr && zy > -zr && zy < H + zr;
      if (inView) {
        ctx.beginPath();
        ctx.arc(zx, zy, zr, 0, Math.PI * 2);
        ctx.strokeStyle = obj.done ? 'rgba(157,255,168,0.9)' : 'rgba(255,178,94,0.9)';
        ctx.lineWidth = wide ? 3 : 2;
        ctx.stroke();
        ctx.fillStyle = obj.done ? 'rgba(157,255,168,0.14)' : 'rgba(255,178,94,0.14)';
        ctx.fill();
        if (wide) {
          ctx.beginPath();
          ctx.arc(zx, zy, Math.max(2, zr * 0.32), 0, Math.PI * 2);
          ctx.fillStyle = obj.done ? 'rgba(157,255,168,0.9)' : 'rgba(255,178,94,0.9)';
          ctx.fill();
        }
      } else {
        // clamp the objective marker to the map edge so it still points the way
        let dx = zx - W / 2;
        let dy = zy - H / 2;
        const len = Math.hypot(dx, dy) || 1;
        const k = (W / 2 - 10) / len;
        dx *= k; dy *= k;
        ctx.beginPath();
        ctx.arc(W / 2 + dx, H / 2 + dy, wide ? 6 : 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,178,94,0.95)';
        ctx.fill();
      }
    }

    // enemies: nearby, firing, or UAV
    if (s.enemies) {
      for (const e of s.enemies) {
        if (!e.alive) continue;
        const ex = e.root ? e.root.position.x : e.pos.x;
        const ez = e.root ? e.root.position.z : e.pos.z;
        const dist = Math.hypot(ex - px, ez - pz);
        // enemies: nearby, firing, or UAV. The "engaged" radius used to be
        // 46 m, which turned the radar into a wallhack: any soldier that
        // opened up lit up on the map well outside the player's own reach.
        const engaged = (e.burstLeft > 0) || e.warnActive || e.isBoss;
        if (!(dist < 20 || (s.uav && dist < 55) || (engaged && dist < 38))) continue;
        const x = toX(ex);
        const y = toY(ez);
        if (x < -6 || y < -6 || x > W + 6 || y > H + 6) continue;
        ctx.beginPath();
        ctx.arc(x, y, e.isBoss ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = e.isBoss ? 'rgba(255,90,90,1)' : 'rgba(255,86,70,0.95)';
        ctx.fill();
        if (engaged) {
          ctx.beginPath();
          ctx.arc(x, y, e.isBoss ? 9 : 6.5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,86,70,0.35)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // player: view cone + arrow
    const heading = (s.heading || 0) * Math.PI / 180;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(18, 20);
    ctx.lineTo(0, 11);
    ctx.lineTo(-18, 20);
    ctx.closePath();
    ctx.fillStyle = 'rgba(111,227,255,0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7.5, 8);
    ctx.lineTo(0, 4.5);
    ctx.lineTo(-7.5, 8);
    ctx.closePath();
    ctx.fillStyle = '#6fe3ff';
    ctx.fill();
    ctx.restore();

    // scan line
    const sy = (time * 26) % H;
    const grad = ctx.createLinearGradient(0, sy - 30, 0, sy + 2);
    grad.addColorStop(0, 'rgba(111,227,255,0)');
    grad.addColorStop(1, 'rgba(111,227,255,0.07)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, sy - 30, W, 32);

    // region label
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
