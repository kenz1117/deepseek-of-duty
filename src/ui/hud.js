/* =========================================================================
   HUD — compass, dynamic crosshair, ammo, vitals, kill feed, hit markers,
   damage direction, wave & objective readouts.

   Public API (must stay compatible with main.js):
     el, show, update(dt), reset,
     setHealth(hp,pips), setAmmo(mag,res,name,mode),
     setWeaponName(name,magSize,mode), setWave(n,total), setWaveProgress(p),
     setObjective(t), setScore(s,k), setGrenades(n), hit(headshot,killed),
     addKillFeed(who,headshot,weapon), setDamage(angleRad), flashDamage(a),
     setReloadPrompt(b), setHint(t), ping(worldPos,camera,life),
     setSpread(px,ads), setHeading(deg), state
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const MAX_DPR = 2;
const CH_SIZE = 220;          // crosshair canvas CSS size
const COMPASS_RANGE = 62;     // degrees visible to each side
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const norm180 = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

const FONT_UI = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';
const FONT_CARDINAL = `800 14px ${FONT_UI}`;
const FONT_INTER = `700 10.5px ${FONT_UI}`;
const FONT_DEG = `500 8px ${FONT_MONO}`;
const FONT_HDG = `700 9.5px ${FONT_MONO}`;

const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

export function createHUD() {
  const el = {
    hud: $('hud'),
    mission: $('mission-label'), objective: $('objective'),
    waveNum: $('wave-num'), waveTotal: $('wave-total'), waveBar: $('wave-bar-fill'),
    killfeed: $('killfeed'), score: $('score'), kills: $('kills'),
    crosshair: $('crosshair'), hitmarker: $('hitmarker'),
    headshot: $('headshot-tag'), killtag: $('kill-tag'),
    dmgDirs: $('damage-dirs'), dmgFlash: $('damage-flash'), lowhp: $('lowhp'),
    armor: $('armor-pips'), hpFill: $('hp-fill'), hpNum: $('hp-num'),
    weaponName: $('weapon-name'), ammoMag: $('ammo-mag'), ammoReserve: $('ammo-reserve'),
    fireMode: $('fire-mode'), grenades: $('grenade-count'), magPips: $('mag-pips'),
    reload: $('reload-prompt'), hint: $('hint'),
    compass: $('compass'),
    // extras (optional, guarded)
    vitals: document.querySelector('#hud .vitals'),
  };

  const ctxC = el.crosshair.getContext('2d');
  const ctxP = el.compass.getContext('2d');

  const state = {
    hp: 100, armor: 2, maxHp: 100,
    mag: 30, magSize: 30, reserve: 180,
    spreadPx: 10, spreadShown: 6, ads: false, firing: false,
    heading: 0,
    lowHp: false,
    dmgAngle: 0, dmgAlpha: 0,
    flashAlpha: 0,
    time: 0,
    pings: [],
    kills: 0,
  };

  let magPips = [];
  let chDpr = 0;
  let compassW = 0, compassH = 56, compassDpr = 0;
  let compassDirty = true;
  let lastHeadingDrawn = 999;
  let frames = 0;
  let hintHold = 0;   // brief grace so per-frame `setHint('')` cannot wipe wave notices

  /* ------------------------------------------------------------ canvas sizing */
  function syncCrosshairCanvas() {
    const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const px = Math.max(1, Math.round(CH_SIZE * d));
    if (chDpr !== d || el.crosshair.width !== px) {
      chDpr = d;
      el.crosshair.width = px;
      el.crosshair.height = px;
    }
  }

  function syncCompassCanvas() {
    const w = Math.round(el.compass.clientWidth);
    const h = Math.round(el.compass.clientHeight) || 56;
    const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w <= 0) return;
    if (w !== compassW || h !== compassH || d !== compassDpr) {
      compassW = w; compassH = h; compassDpr = d;
      el.compass.width = Math.max(1, Math.round(w * d));
      el.compass.height = Math.max(1, Math.round(h * d));
      compassDirty = true;
    }
  }

  syncCrosshairCanvas();
  window.addEventListener('resize', () => {
    syncCrosshairCanvas();
    syncCompassCanvas();
  });

  /* ------------------------------------------------------------ ammo pips */
  function buildMagPips(n) {
    n = Math.max(1, Math.min(60, n | 0));
    el.magPips.innerHTML = '';
    magPips = [];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      el.magPips.appendChild(p);
      magPips.push(p);
    }
    paintMagPips(state.mag);
  }

  function paintMagPips(mag) {
    const n = magPips.length;
    const live = Math.max(0, Math.min(n, mag));
    for (let i = 0; i < n; i++) {
      const spent = i >= live;
      magPips[i].classList.toggle('spent', spent);
      magPips[i].classList.toggle('next', live > 0 && i === live - 1);
    }
  }

  buildMagPips(30);

  /* ------------------------------------------------------------ show / reset */
  function show(v = true) { el.hud.classList.toggle('hidden', !v); }

  function setHealth(hp, armor = 2) {
    state.hp = Math.max(0, hp);
    state.armor = Math.max(0, armor | 0);
    const pct = clamp01(state.hp / state.maxHp);
    el.hpFill.style.width = `${pct * 100}%`;
    el.hpNum.textContent = String(Math.ceil(state.hp));
    const low = state.hp < 45;
    el.hpFill.classList.toggle('low', low);
    if (el.vitals) el.vitals.classList.toggle('critical', state.hp < 35);

    const pips = el.armor.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= state.armor);

    const critical = state.hp < 40;
    if (critical !== state.lowHp) {
      state.lowHp = critical;
      el.lowhp.style.opacity = critical ? '1' : '0';
    }
  }

  function setAmmo(mag, reserve, name, mode = 'AUTO') {
    state.mag = Math.max(0, mag | 0);
    state.reserve = Math.max(0, reserve | 0);
    if (magPips.length !== state.magSize) buildMagPips(state.magSize);

    el.ammoMag.textContent = String(state.mag);
    el.ammoReserve.textContent = String(state.reserve);
    el.ammoMag.classList.toggle('low', state.mag <= Math.max(3, Math.ceil(state.magSize * 0.2)));
    if (name) el.weaponName.textContent = name;
    if (mode) el.fireMode.textContent = mode;
    paintMagPips(state.mag);
  }

  function setWeaponName(name, magSize, mode) {
    el.weaponName.textContent = name;
    state.magSize = Math.max(1, magSize | 0);
    el.fireMode.textContent = mode || 'AUTO';
    buildMagPips(state.magSize);
    setAmmo(Math.min(state.mag, state.magSize), state.reserve, name, mode);
  }

  function setWave(n, total = '∞') {
    el.waveNum.textContent = String(n);
    el.waveTotal.textContent = String(total);
  }
  function setWaveProgress(p) {
    el.waveBar.style.width = `${clamp01(p) * 100}%`;
  }
  function setObjective(t) { if (t !== undefined && t !== null) el.objective.textContent = String(t); }
  function setScore(score, kills) {
    el.score.textContent = String(score);
    if (kills !== undefined) { el.kills.textContent = String(kills); state.kills = kills; }
  }
  function setGrenades(n) { el.grenades.textContent = String(n); }

  /* ------------------------------------------------------------ feedback */
  function replay(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  function hit(headshot = false, killed = false) {
    if (headshot) el.hitmarker.classList.add('hs');
    replay(el.hitmarker, 'show');
    if (headshot) {
      replay(el.headshot, 'show');
      // keep the .hs tint long enough for the marker animation
      clearTimeout(hit._hs);
      hit._hs = setTimeout(() => el.hitmarker.classList.remove('hs'), 260);
    }
    if (killed) {
      el.killtag.textContent = headshot ? '+150' : '+100';
      replay(el.killtag, 'show');
    }
  }

  function addKillFeed(who = 'HOSTILE', headshot = false, weapon = 'M4A1') {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const add = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      row.appendChild(s);
    };
    add('kf-you', 'YOU');
    add('kf-arrow', '›');
    add('kf-weapon', weapon);
    if (headshot) add('kf-hs', 'HEADSHOT');
    add('kf-target', who);
    el.killfeed.insertBefore(row, el.killfeed.firstChild);
    while (el.killfeed.children.length > 5) el.killfeed.lastChild.remove();
    setTimeout(() => {
      row.classList.add('fade');
      setTimeout(() => row.remove(), 480);
    }, 3800);
  }

  function setDamage(dirAngle) {
    state.dmgAngle = dirAngle;
    state.dmgAlpha = 1;
    el.dmgDirs.style.transform = `rotate(${dirAngle}rad)`;
    el.dmgDirs.style.opacity = '0.95';
  }

  function flashDamage(alpha = 0.55) {
    state.flashAlpha = Math.max(state.flashAlpha, alpha);
  }

  function setReloadPrompt(v) { el.reload.classList.toggle('show', !!v); }

  function setHint(text) {
    if (text) {
      const s = String(text);
      if (el.hint.textContent !== s) el.hint.textContent = s;
      el.hint.classList.add('show');
      hintHold = 1.2;
    } else if (hintHold <= 0) {
      el.hint.classList.remove('show');
    }
  }

  function ping(worldPos, camera, life = 1.6) {
    const dx = worldPos.x - camera.position.x;
    const dz = worldPos.z - camera.position.z;
    const bearing = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
    state.pings.push({ bearing, life, max: life });
    if (state.pings.length > 8) state.pings.shift();
    compassDirty = true;
  }

  function setSpread(px, ads) {
    state.spreadPx = Math.max(0, px);
    state.ads = !!ads;
  }

  /* ------------------------------------------------------------ crosshair */
  function strokeCross(c, cx, cy, gap, len) {
    c.beginPath();
    c.moveTo(cx - gap - len, cy); c.lineTo(cx - gap, cy);
    c.moveTo(cx + gap, cy); c.lineTo(cx + gap + len, cy);
    c.moveTo(cx, cy - gap - len); c.lineTo(cx, cy - gap);
    c.moveTo(cx, cy + gap); c.lineTo(cx, cy + gap + len);
    c.stroke();
  }

  function drawCrosshair() {
    const c = ctxC;
    const d = chDpr || 1;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, CH_SIZE, CH_SIZE);
    const cx = CH_SIZE / 2, cy = CH_SIZE / 2;

    if (state.ads) {
      // aiming: the optic reticle owns the screen, the HUD crosshair is hidden
      return;
    }

    const gap = 6.5 + state.spreadShown;
    const len = 7.5;
    c.lineCap = 'butt';
    // dark outline for readability on bright surfaces
    c.strokeStyle = 'rgba(0,0,0,.72)';
    c.lineWidth = 4.6;
    strokeCross(c, cx, cy, gap, len);
    // bright core
    c.strokeStyle = 'rgba(250,253,253,.98)';
    c.lineWidth = 2;
    strokeCross(c, cx, cy, gap, len);

    // center dot
    c.fillStyle = 'rgba(0,0,0,.7)';
    c.fillRect(cx - 2.2, cy - 2.2, 4.4, 4.4);
    c.fillStyle = 'rgba(255,255,255,.99)';
    c.fillRect(cx - 1.1, cy - 1.1, 2.2, 2.2);
  }

  /* ------------------------------------------------------------ compass */
  function drawCompass() {
    if (!compassW) return;
    const c = ctxP;
    const d = compassDpr || 1;
    const W = compassW, H = compassH;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, W, H);

    const cx = W / 2;
    const pxPerDeg = W / (COMPASS_RANGE * 2);
    const heading = ((state.heading % 360) + 360) % 360;
    const baseline = H * 0.66;
    const labelY = H * 0.33;
    const degY = H - 7;

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';

    // faint dark halo keeps type readable on a bright sky without a backing band
    const label = (text, x, y, fill, strokeW) => {
      if (strokeW) {
        c.lineWidth = strokeW;
        c.strokeStyle = 'rgba(3,5,7,.7)';
        c.strokeText(text, x, y);
      }
      c.fillStyle = fill;
      c.fillText(text, x, y);
    };

    // baseline: dark underlay + fine bright hairline
    c.fillStyle = 'rgba(2,4,6,.4)';
    c.fillRect(0, baseline - 1, W, 2.5);
    const lineG = c.createLinearGradient(0, 0, W, 0);
    lineG.addColorStop(0, 'rgba(233,238,240,0)');
    lineG.addColorStop(0.16, 'rgba(240,245,246,.44)');
    lineG.addColorStop(0.5, 'rgba(246,250,251,.56)');
    lineG.addColorStop(0.84, 'rgba(240,245,246,.44)');
    lineG.addColorStop(1, 'rgba(233,238,240,0)');
    c.fillStyle = lineG;
    c.fillRect(0, baseline, W, 1);

    for (let b = 0; b < 360; b += 5) {
      const delta = norm180(b - heading);
      if (Math.abs(delta) > COMPASS_RANGE) continue;
      const x = Math.round((cx + delta * pxPerDeg) * 2) / 2;
      const edge = 1 - Math.pow(Math.abs(delta) / COMPASS_RANGE, 1.8);
      if (edge <= 0.02) continue;

      const major = b % 45 === 0;
      const mid = !major && b % 15 === 0;
      const h = major ? 13 : mid ? 8 : 4.5;
      const w = major ? 1.5 : 1;

      // tick shadow (readability over bright surfaces)
      c.fillStyle = `rgba(2,4,6,${(0.42 * edge).toFixed(3)})`;
      c.fillRect(x - w / 2 - 0.7, baseline - h, w + 1.4, h);

      const a = (major ? 0.98 : mid ? 0.7 : 0.44) * edge;
      c.fillStyle = `rgba(242,246,247,${a.toFixed(3)})`;
      c.fillRect(x - w / 2, baseline - h, w, h);

      if (major) {
        const isCardinal = b % 90 === 0;
        c.font = isCardinal ? FONT_CARDINAL : FONT_INTER;
        c.letterSpacing = isCardinal ? '1.4px' : '0.8px';
        label(CARDINALS[b], x, labelY,
          isCardinal ? `rgba(250,253,253,${(0.99 * edge).toFixed(3)})` : `rgba(242,246,247,${(0.94 * edge).toFixed(3)})`,
          isCardinal ? 3.4 : 2.8);

        // degree tick labels (skip behind the center readout)
        if (Math.abs(x - cx) > 22) {
          c.font = FONT_DEG;
          c.letterSpacing = '0.4px';
          label(String(b).padStart(3, '0'), x, degY,
            `rgba(240,245,246,${(0.62 * edge).toFixed(3)})`, 2.2);
        }
      }
    }

    // enemy fire markers
    for (const p of state.pings) {
      const delta = norm180(p.bearing - heading);
      if (Math.abs(delta) > COMPASS_RANGE) continue;
      const x = cx + delta * pxPerDeg;
      const alive = clamp01(p.life / 0.32);
      const edge = 1 - Math.abs(delta) / COMPASS_RANGE;
      const a = alive * edge;
      if (a <= 0) continue;
      c.save();
      c.shadowColor = `rgba(232,74,58,${0.9 * a})`;
      c.shadowBlur = 9;
      c.fillStyle = `rgba(244,96,76,${(0.97 * a).toFixed(3)})`;
      const ty = baseline - 15;
      c.beginPath();
      c.moveTo(x, ty + 8);
      c.lineTo(x - 5, ty);
      c.lineTo(x + 5, ty);
      c.closePath();
      c.fill();
      c.fillRect(x - 0.5, ty - 6, 1, 6);
      c.restore();
    }

    // center lubber line + caret
    c.fillStyle = 'rgba(227,178,106,.4)';
    c.fillRect(Math.round(cx) - 0.5, labelY + 9, 1, baseline - labelY - 9);

    c.save();
    c.shadowColor = 'rgba(227,178,106,.9)';
    c.shadowBlur = 11;
    c.fillStyle = 'rgba(242,201,135,.99)';
    c.beginPath();
    c.moveTo(cx, 3);
    c.lineTo(cx - 5.5, 11);
    c.lineTo(cx + 5.5, 11);
    c.closePath();
    c.fill();
    c.restore();

    c.font = FONT_HDG;
    c.letterSpacing = '1px';
    label(String(Math.round(heading) % 360).padStart(3, '0'), cx, degY, 'rgba(242,201,135,.98)', 2.6);
  }

  /* ------------------------------------------------------------ update */
  function update(dt) {
    state.time += dt;
    frames++;

    if (!chDpr) syncCrosshairCanvas();
    if (compassW === 0 || (frames & 15) === 0) syncCompassCanvas();

    // smooth crosshair bloom
    const k = 1 - Math.exp(-16 * dt);
    state.spreadShown += (state.spreadPx - state.spreadShown) * k;

    drawCrosshair();

    const heading = ((state.heading % 360) + 360) % 360;
    if (compassDirty || state.pings.length > 0 || Math.abs(heading - lastHeadingDrawn) > 0.02) {
      drawCompass();
      lastHeadingDrawn = heading;
      compassDirty = false;
    }

    // damage direction fade
    if (state.dmgAlpha > 0) {
      state.dmgAlpha = Math.max(0, state.dmgAlpha - dt * 1.9);
      el.dmgDirs.style.opacity = (state.dmgAlpha * 0.95).toFixed(3);
    }

    // damage flash fade
    if (state.flashAlpha > 0) {
      state.flashAlpha = Math.max(0, state.flashAlpha - dt * 3.4);
      el.dmgFlash.style.opacity = state.flashAlpha.toFixed(3);
    }

    // pings expire (force one more compass pass so the last stale marker clears)
    for (let i = state.pings.length - 1; i >= 0; i--) {
      state.pings[i].life -= dt;
      if (state.pings[i].life <= 0) {
        state.pings.splice(i, 1);
        compassDirty = true;
      }
    }

    // hint clear-grace countdown (lets wave notices survive main.js's per-frame clear)
    if (hintHold > 0) hintHold = Math.max(0, hintHold - dt);
  }

  function reset() {
    state.hp = 100; state.armor = 2;
    state.mag = 30; state.magSize = 30; state.reserve = 180;
    state.spreadPx = 6; state.spreadShown = 6; state.ads = false;
    state.heading = 0; state.dmgAlpha = 0; state.flashAlpha = 0;
    state.lowHp = false; state.kills = 0;
    state.pings.length = 0;

    el.killfeed.innerHTML = '';
    el.dmgDirs.style.opacity = '0';
    el.dmgFlash.style.opacity = '0';
    el.lowhp.style.opacity = '0';
    el.reload.classList.remove('show');
    el.score.textContent = '0';
    el.kills.textContent = '0';
    el.magPips.innerHTML = '';
    magPips = [];
    buildMagPips(30);
    setHealth(100, 2);
    setAmmo(30, 180, 'M4A1', 'AUTO');
    hintHold = 0;
    setHint('');
    compassDirty = true;
  }

  return {
    el, show, update, reset,
    setHealth, setAmmo, setWeaponName, setWave, setWaveProgress, setObjective,
    setScore, setGrenades, hit, addKillFeed, setDamage, flashDamage,
    setReloadPrompt, setHint, ping, setSpread,
    setHeading(h) { state.heading = h; },
    get state() { return state; },
  };
}
