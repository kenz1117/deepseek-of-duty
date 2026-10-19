/* =========================================================================
   Tactical minimap.

   North-up, player-centred, 150 px square showing ~84 m around the player.
   Walls come from level.colliders (the same boxes the player collides with),
   so the map can never drift from the real level. Enemies are only revealed
   when they are close, actively firing, or the UAV is up.
   ========================================================================= */

const RANGE = 42;          // metres from centre to edge
const DRAW_HZ = 10;

export function createMinimap({ level }) {
  const wrap = document.getElementById('minimap-wrap');
  const canvas = document.getElementById('minimap');
  const regionEl = document.getElementById('mm-region');
  if (!wrap || !canvas) return { update() {}, toggle() {}, get visible() { return false; } };
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const scale = W / (RANGE * 2);

  // pre-filter the collider list once: low kerbs and decals do not belong
  const walls = (level && level.colliders ? level.colliders : [])
    .filter((c) => (c.top == null ? 10 : c.top) >= 1.2)
    .map((c) => ({ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1, tall: (c.top == null ? 10 : c.top) >= 6 }));

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

  function draw(s, time) {
    const px = s.x;
    const pz = s.z;
    const toX = (x) => W / 2 + (x - px) * scale;
    const toY = (z) => H / 2 + (z - pz) * scale;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,10,13,0.72)';
    ctx.fillRect(0, 0, W, H);

    // 10 m grid
    ctx.strokeStyle = 'rgba(150,180,190,0.10)';
    ctx.lineWidth = 1;
    const gx0 = Math.floor((px - RANGE) / 10) * 10;
    const gz0 = Math.floor((pz - RANGE) / 10) * 10;
    for (let gx = gx0; gx <= px + RANGE; gx += 10) {
      const x = toX(gx);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let gz = gz0; gz <= pz + RANGE; gz += 10) {
      const y = toY(gz);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // walls
    for (const c of walls) {
      const x = toX(c.x0);
      const y = toY(c.z0);
      const w = (c.x1 - c.x0) * scale;
      const h = (c.z1 - c.z0) * scale;
      if (x > W || y > H || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = c.tall ? 'rgba(126,138,146,0.55)' : 'rgba(96,106,112,0.4)';
      ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
    }

    // objective zone
    const obj = s.objective;
    if (obj && obj.zone) {
      const zx = toX(obj.zone.x);
      const zy = toY(obj.zone.z);
      const zr = Math.max(3, obj.zone.r * scale);
      const inView = zx > -zr && zx < W + zr && zy > -zr && zy < H + zr;
      if (inView) {
        ctx.beginPath();
        ctx.arc(zx, zy, zr, 0, Math.PI * 2);
        ctx.strokeStyle = obj.done ? 'rgba(157,255,168,0.85)' : 'rgba(255,178,94,0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = obj.done ? 'rgba(157,255,168,0.12)' : 'rgba(255,178,94,0.12)';
        ctx.fill();
      } else {
        // clamp the objective marker to the map edge so it still points the way
        let dx = zx - W / 2;
        let dy = zy - H / 2;
        const len = Math.hypot(dx, dy) || 1;
        const k = (W / 2 - 10) / len;
        dx *= k; dy *= k;
        ctx.beginPath();
        ctx.arc(W / 2 + dx, H / 2 + dy, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,178,94,0.9)';
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
        const engaged = (e.burstLeft > 0) || e.warnActive || e.isBoss;
        if (!(dist < 20 || (s.uav && dist < 55) || (engaged && dist < 46))) continue;
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

  return {
    update,
    toggle,
    setVisible,
    draw: (s) => draw(s, 0),
    get visible() { return on; },
  };
}
