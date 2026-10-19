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
     setSpread(px,ads), setHeading(deg), state,
     bindSettings(s,onChange), openSettings(), closeSettings(), isSettingsOpen,
     showUpgrades(cards,onPick), hideUpgrades(),
     showTutorial(text,keyLabel), hideTutorial(), setAtmosphere(label),
     setMode(label,sub), setModeProgress(pct,text,active), setZoneDistance(m), hideMode(),
     bindModeSelect(current,onChange), setModeSelect(mode),
     setStreak(n,nextAt), setStreakReward(label), setUav(active,secondsLeft), uavPing(worldPos,camera,life),
     toast(text)
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
    weaponName: $('weapon-name'), weaponTag: $('weapon-tag'), ammoMag: $('ammo-mag'), ammoReserve: $('ammo-reserve'),
    weaponSlots: $('weapon-slots'),
    fireMode: $('fire-mode'), grenades: $('grenade-count'), magPips: $('mag-pips'),
    reload: $('reload-prompt'), hint: $('hint'),
    compass: $('compass'),
    // extras (optional, guarded)
    vitals: document.querySelector('#hud .vitals'),
    atmo: $('atmosphere-tag'), atmoValue: $('atmosphere-value'),
    tutorial: $('tutorial'), tutorialText: $('tutorial-text'), tutorialKey: $('tutorial-key'),
    settings: $('settings'), settingsPanel: document.querySelector('#settings .settings-panel'),
    upgrades: $('upgrades'), upgradeCards: $('upgrade-cards'),
    modeHud: $('mode-hud'), modeLabel: $('mode-label'), modeSub: $('mode-sub'),
    modeFill: $('mode-progress-fill'), modeProgressText: $('mode-progress-text'),
    modeZone: $('zone-distance'), modeZoneText: $('zone-distance-text'),
    modeSelect: $('mode-select'), modeSelectCurrent: $('mode-select-current'),
    modeSelectBtns: Array.from(document.querySelectorAll('#mode-select-pills button')),
    streak: $('hud-streak'), streakN: $('streak-n'), streakNext: $('streak-next'),
    streakNextWrap: $('streak-next-wrap'),
    uav: $('hud-uav'), uavTime: $('uav-time'),
    reward: $('hud-reward'), rewardLabel: $('hud-reward-label'),
    toast: $('hud-toast'), toastText: $('hud-toast-text'),
    radio: $('hud-radio'), radioSpeaker: $('hud-radio-speaker'), radioText: $('hud-radio-text'),
    areaTag: $('area-tag'), areaName: $('area-name'), areaEn: $('area-en'),
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
  let areaKey = '';
  let areaHold = 0;
  let chDpr = 0;
  let compassW = 0, compassH = 56, compassDpr = 0;
  let compassDirty = true;
  let lastHeadingDrawn = 999;
  let frames = 0;
  let hintHold = 0;   // brief grace so per-frame `setHint('')` cannot wipe wave notices

  const MAX_ARMOR_PIPS = 6;
  let armorPips = [];

  const DEFAULT_SETTINGS = {
    sensitivity: 1, adsSens: 0.75, fov: 90, invertY: false,
    master: 0.8, reduceMotion: false, quality: 'high',
  };
  let settings = { ...DEFAULT_SETTINGS };
  let settingsOnChange = null;
  let settingsOpen = false;
  let settingsWired = false;

  let upgradeData = [];
  let upgradeOnPick = null;
  let upgradeChosen = false;
  let upgradeTimer = 0;
  let modeClearTimer = 0;
  let rewardTimer = 0;
  let toastTimer = 0;
  const MODE_SELECT_VALUES = ['rotation', 'survival', 'defend', 'extract'];
  let modeSelectValue = 'rotation';
  let modeSelectOnChange = null;
  let modeSelectWired = false;

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

  function setArmorPips(count) {
    const n = Math.max(0, Math.min(MAX_ARMOR_PIPS, count | 0));
    // adopt the markup placeholders once, then grow/reuse the pool lazily
    if (!armorPips.length) armorPips = Array.from(el.armor.children);
    while (armorPips.length < n) {
      const p = document.createElement('i');
      el.armor.appendChild(p);
      armorPips.push(p);
    }
    for (let i = 0; i < armorPips.length; i++) {
      armorPips[i].classList.remove('off');
      armorPips[i].style.display = i < n ? '' : 'none';
    }
    el.armor.classList.toggle('empty', n === 0);
  }

  function setHealth(hp, armor = 2) {
    state.hp = Math.max(0, hp);
    state.armor = Math.max(0, armor | 0);
    const pct = clamp01(state.hp / state.maxHp);
    el.hpFill.style.width = `${pct * 100}%`;
    el.hpNum.textContent = String(Math.ceil(state.hp));
    const low = state.hp < 45;
    el.hpFill.classList.toggle('low', low);
    if (el.vitals) el.vitals.classList.toggle('critical', state.hp < 35);

    setArmorPips(state.armor);

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

  /* 1/2/3 slot strip: names + live ammo + active highlight */
  function setSlots(list) {
    if (!el.weaponSlots) return;
    const rows = el.weaponSlots.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const d = list[i];
      if (!d) { row.classList.add('hidden'); continue; }
      row.classList.remove('hidden');
      const n = row.querySelector('.wslot-n');
      const a = row.querySelector('.wslot-a');
      if (n) n.textContent = d.name;
      if (a) a.textContent = d.locked ? 'LOCKED' : `${d.mag}/${d.reserve}`;
      row.classList.toggle('is-active', !!d.active);
      row.classList.toggle('is-empty', !d.locked && d.mag === 0);
      row.classList.toggle('is-locked', !!d.locked);
    }
  }

  function setWeaponTag(tag) {
    if (el.weaponTag && tag) el.weaponTag.innerHTML = tag;
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

  /* location tag: fades in on every region change, then hides itself again */
  function setArea(name, en) {
    if (!el.areaTag || !name) return;
    const key = name + '|' + (en || '');
    if (key === areaKey) return;
    areaKey = key;
    if (el.areaName) el.areaName.textContent = name;
    if (el.areaEn) el.areaEn.textContent = en || '';
    el.areaTag.classList.remove('show');
    void el.areaTag.offsetWidth;
    el.areaTag.classList.add('show');
    areaHold = 3.6;
  }
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
    state.pings.push({ bearing, life, max: life, kind: 'fire' });
    if (state.pings.length > 8) state.pings.shift();
    compassDirty = true;
  }

  /* campaign radio: a small queue so simultaneous story beats do not overlap */
  let radioQueue = [];
  let radioTimer = 0;
  let radioHold = false;
  let voicePlayer = null;
  function setVoicePlayer(fn) { voicePlayer = typeof fn === 'function' ? fn : null; }
  function nextRadio() {
    if (!el.radio) return;
    const item = radioQueue.shift();
    if (!item) { el.radio.classList.remove('show'); radioHold = false; return; }
    radioHold = true;
    if (el.radioSpeaker) el.radioSpeaker.textContent = item.speaker;
    if (el.radioText) el.radioText.textContent = item.text;
    el.radio.classList.add('show');
    if (item.voice && voicePlayer) voicePlayer(item.voice);
    clearTimeout(radioTimer);
    radioTimer = setTimeout(nextRadio, item.ms);
  }
  function radio(speaker, text, ms = 4400, voiceId = null) {
    if (!el.radio || !text) return;
    radioQueue.push({ speaker: speaker || 'VEGA', text: String(text), ms, voice: voiceId });
    if (!radioHold) nextRadio();
  }
  function clearRadio() {
    radioQueue = [];
    radioHold = false;
    clearTimeout(radioTimer);
    if (el.radio) el.radio.classList.remove('show');
  }

  function setSpread(px, ads) {
    state.spreadPx = Math.max(0, px);
    state.ads = !!ads;
  }

  /* ------------------------------------------------------------ streak / uav / toast */
  function setStreak(n, nextAt) {
    if (!el.streak) return;
    const cur = Math.max(0, Math.floor(Number(n) || 0));
    if (cur < 2) { el.streak.classList.add('hidden'); return; }
    el.streak.classList.remove('hidden');
    if (el.streakN && el.streakN.textContent !== String(cur)) el.streakN.textContent = String(cur);
    const next = Number(nextAt);
    if (el.streakNextWrap && el.streakNext) {
      if (Number.isFinite(next) && next > 0) {
        el.streakNextWrap.classList.remove('hidden');
        const txt = String(next);
        if (el.streakNext.textContent !== txt) el.streakNext.textContent = txt;
      } else {
        el.streakNextWrap.classList.add('hidden');
      }
    }
  }

  function setStreakReward(label) {
    if (!el.reward) return;
    const text = String(label == null ? '' : label).trim();
    if (!text) {
      clearTimeout(rewardTimer);
      el.reward.classList.remove('show');
      return;
    }
    if (el.rewardLabel) el.rewardLabel.textContent = text;
    el.reward.classList.add('show');
    clearTimeout(rewardTimer);
    rewardTimer = setTimeout(() => { if (el.reward) el.reward.classList.remove('show'); }, 2000);
  }

  function setUav(active, secondsLeft) {
    if (!el.uav) return;
    if (!active) { el.uav.classList.add('hidden'); return; }
    const sec = Math.max(0, Math.ceil(Number(secondsLeft) || 0));
    el.uav.classList.remove('hidden');
    if (el.uavTime) {
      const txt = sec > 0 ? `${sec}s` : 'ACTIVE';
      if (el.uavTime.textContent !== txt) el.uavTime.textContent = txt;
    }
  }

  function uavPing(worldPos, camera, life = 1.4) {
    if (!worldPos || !camera || !camera.position) return;
    const dx = Number(worldPos.x) - Number(camera.position.x);
    const dz = Number(worldPos.z) - Number(camera.position.z);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const bearing = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
    const l = Math.max(0.2, Math.min(4, Number(life) || 1.4));
    state.pings.push({ bearing, life: l, max: l, kind: 'uav' });
    if (state.pings.length > 10) state.pings.shift();
    compassDirty = true;
  }

  function toast(text, ms) {
    if (!el.toast) return;
    const msg = String(text == null ? '' : text).trim();
    if (!msg) {
      clearTimeout(toastTimer);
      el.toast.classList.remove('show');
      return;
    }
    if (el.toastText) el.toastText.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (el.toast) el.toast.classList.remove('show'); }, ms || 1600);
  }

  /* ------------------------------------------------------------ objective mode */
  function modeVariant(label) {
    const k = String(label).toLowerCase();
    if (k.includes('extract') || k.includes('exfil') || k.includes('撤离')) return 'extract';
    if (k.includes('defend') || k.includes('hold') || k.includes('zone') ||
        k.includes('防守') || k.includes('坚守')) return 'defend';
    return 'survival';
  }

  function setMode(label, sub) {
    const text = String(label == null ? '' : label).trim();
    if (!text) { hideMode(); return; }
    if (!el.modeHud) return;
    clearTimeout(modeClearTimer);
    el.modeLabel.textContent = text;
    const subText = String(sub == null ? '' : sub).trim();
    el.modeSub.textContent = subText;
    el.modeSub.classList.toggle('empty', !subText);
    el.modeHud.classList.toggle('no-sub', !subText);
    el.modeHud.dataset.mode = modeVariant(text);
    el.modeHud.classList.remove('inactive');
    // main.js drives progress every frame; clear stale values until then
    if (el.modeFill) el.modeFill.style.width = '0%';
    if (el.modeProgressText) el.modeProgressText.textContent = '';
    if (el.modeZone) el.modeZone.classList.add('hidden');
    if (el.modeZoneText) el.modeZoneText.textContent = '';
    el.modeHud.classList.add('show');
    el.modeHud.setAttribute('aria-hidden', 'false');
  }

  function setModeProgress(pct, text, active = true) {
    if (!el.modeHud || !el.modeHud.classList.contains('show')) return;
    let v = Number(pct);
    if (!Number.isFinite(v)) v = 0;
    if (v > 1) v /= 100;          // accept both 0..1 and 0..100
    v = clamp01(v);
    if (el.modeFill) el.modeFill.style.width = `${(v * 100).toFixed(2)}%`;

    const isActive = !(active === false || active === 0);
    const label = String(text == null ? '' : text).trim();
    if (el.modeProgressText) {
      el.modeProgressText.textContent = label || (isActive ? '' : '返回区域');
    }
    if (el.modeHud) el.modeHud.classList.toggle('inactive', !isActive);
  }

  function setZoneDistance(m) {
    if (!el.modeZone || !el.modeZoneText) return;
    const n = typeof m === 'number' ? m : parseFloat(m);
    if (!Number.isFinite(n) || n <= 0) {
      el.modeZone.classList.add('hidden');
      el.modeZoneText.textContent = '';
      return;
    }
    el.modeZoneText.textContent = `ZONE ${n < 10 ? n.toFixed(1) : Math.round(n)}m`;
    el.modeZone.classList.remove('hidden');
  }

  function hideMode() {
    if (!el.modeHud) return;
    el.modeHud.classList.remove('show');
    el.modeHud.setAttribute('aria-hidden', 'true');
    // let the strip fade out with its content, then clear it
    clearTimeout(modeClearTimer);
    modeClearTimer = setTimeout(() => {
      if (!el.modeHud || el.modeHud.classList.contains('show')) return;
      el.modeHud.classList.remove('inactive');
      el.modeHud.dataset.mode = '';
      if (el.modeLabel) el.modeLabel.textContent = '';
      if (el.modeSub) { el.modeSub.textContent = ''; el.modeSub.classList.add('empty'); }
      el.modeHud.classList.add('no-sub');
      if (el.modeFill) el.modeFill.style.width = '0%';
      if (el.modeProgressText) el.modeProgressText.textContent = '';
      if (el.modeZone) el.modeZone.classList.add('hidden');
      if (el.modeZoneText) el.modeZoneText.textContent = '';
    }, 320);
  }

  /* ------------------------------------------------------- deploy mode select */
  function normalizeModeSelect(value) {
    const k = String(value == null ? '' : value).trim().toLowerCase();
    return MODE_SELECT_VALUES.includes(k) ? k : 'rotation';
  }

  function paintModeSelect(mode) {
    const m = normalizeModeSelect(mode);
    if (el.modeSelectCurrent) el.modeSelectCurrent.textContent = m.toUpperCase();
    if (!el.modeSelectBtns) return;
    for (const btn of el.modeSelectBtns) {
      const on = btn.dataset.mode === m;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function setModeSelect(mode) {
    const m = normalizeModeSelect(mode);
    modeSelectValue = m;
    paintModeSelect(m);
  }

  function wireModeSelect() {
    if (modeSelectWired || !el.modeSelectBtns) return;
    modeSelectWired = true;
    for (const btn of el.modeSelectBtns) {
      btn.addEventListener('click', () => {
        const mode = normalizeModeSelect(btn.dataset.mode);
        if (mode === modeSelectValue) return;
        modeSelectValue = mode;
        paintModeSelect(mode);
        if (!modeSelectOnChange) return;
        try { modeSelectOnChange(mode); }
        catch (err) { console.error('[hud] mode select onChange failed', err); }
      });
    }
  }

  function bindModeSelect(current, onChange) {
    modeSelectOnChange = typeof onChange === 'function' ? onChange : null;
    wireModeSelect();
    setModeSelect(current);
  }

  wireModeSelect();
  paintModeSelect(modeSelectValue);

  /* ------------------------------------------------------------ settings */
  function clampNum(v, lo, hi, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }
  const fmt2 = (v) => Number(v).toFixed(2);
  const fmtPct = (v) => `${Math.round(Number(v) * 100)}%`;
  const fmtInt = (v) => String(Math.round(Number(v)));

  function setRangeValue(id, outId, value, formatter) {
    const input = $(id), out = $(outId);
    if (input) input.value = String(value);
    if (out) out.textContent = formatter(value);
  }
  function setSwitch(id, on) {
    const b = $(id);
    if (!b) return;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    const stateEl = b.querySelector('.sw-state');
    if (stateEl) stateEl.textContent = on ? 'ON' : 'OFF';
  }
  function setQualityState(q) {
    document.querySelectorAll('.quality-pills button').forEach((b) => {
      const v = b.dataset.q || b.dataset.pq;
      if (v) b.classList.toggle('active', v === q);
    });
  }
  function syncSettingsUI() {
    setRangeValue('set-sensitivity', 'out-sensitivity', settings.sensitivity, fmt2);
    setRangeValue('set-ads', 'out-ads', settings.adsSens, fmt2);
    setRangeValue('set-fov', 'out-fov', settings.fov, fmtInt);
    setRangeValue('set-master', 'out-master', settings.master, fmtPct);
    setSwitch('set-invertY', !!settings.invertY);
    setSwitch('set-reduceMotion', !!settings.reduceMotion);
    setSwitch('set-wayfinder', settings.wayfinder !== false);
    setSwitch('set-voice', settings.voice !== false);
    setQualityState(settings.quality);
    document.documentElement.classList.toggle('reduce-motion', !!settings.reduceMotion);
  }
  // main.js contract: onChange(key, value)
  function emitSetting(key, value) {
    if (!settingsOnChange) return;
    try { settingsOnChange(key, value); }
    catch (err) { console.error('[hud] settings onChange failed', err); }
  }

  function wireSettings() {
    if (settingsWired) return;
    settingsWired = true;

    const bindRange = (id, key, formatter) => {
      const input = $(id);
      if (!input) return;
      const out = $(`out-${id.replace('set-', '')}`);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        settings[key] = v;
        if (out) out.textContent = formatter(v);
        emitSetting(key, v);
      });
    };
    bindRange('set-sensitivity', 'sensitivity', fmt2);
    bindRange('set-ads', 'adsSens', fmt2);
    bindRange('set-fov', 'fov', fmtInt);
    bindRange('set-master', 'master', fmtPct);

    const bindSwitch = (id, key) => {
      const b = $(id);
      if (!b) return;
      b.addEventListener('click', () => {
        const v = !settings[key];
        settings[key] = v;
        setSwitch(id, v);
        if (key === 'reduceMotion') document.documentElement.classList.toggle('reduce-motion', v);
        emitSetting(key, v);
      });
    };
    bindSwitch('set-invertY', 'invertY');
    bindSwitch('set-reduceMotion', 'reduceMotion');
    bindSwitch('set-wayfinder', 'wayfinder');
    bindSwitch('set-voice', 'voice');

    // quality reuses the same pill markup as menu/pause; main.js also binds those buttons
    if (el.settings) {
      el.settings.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('.quality-pills button') : null;
        if (!b) return;
        const q = b.dataset.q || b.dataset.pq;
        if (!q) return;
        settings.quality = q;
        setQualityState(q);
        emitSetting('quality', q);
      });
    }

    const closeAndNotify = () => {
      if (!settingsOpen) return;
      closeSettings();
      window.dispatchEvent(new CustomEvent('dod-settings-close'));
    };
    const closeBtn = $('settings-close');
    if (closeBtn) closeBtn.addEventListener('click', closeAndNotify);
    const doneBtn = $('settings-done');
    if (doneBtn) doneBtn.addEventListener('click', closeAndNotify);
    if (el.settings) {
      el.settings.addEventListener('click', (e) => {
        if (e.target === el.settings) closeAndNotify();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (!settingsOpen) return;
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAndNotify();
      }
    }, true);
  }

  function openSettings() {
    if (settingsOpen) return;
    wireSettings();
    // menu/pause quality pills are also driven by main.js; adopt whatever is active
    const activeQ = document.querySelector('.quality-pills button.active');
    if (activeQ) {
      const q = activeQ.dataset.q || activeQ.dataset.pq;
      if (q) settings.quality = q;
    }
    settingsOpen = true;
    syncSettingsUI();
    if (el.settingsPanel) el.settingsPanel.scrollTop = 0;
    if (el.settings) {
      el.settings.classList.remove('hidden');
      el.settings.setAttribute('aria-hidden', 'false');
    }
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    if (el.settings) {
      el.settings.classList.add('hidden');
      el.settings.setAttribute('aria-hidden', 'true');
    }
  }

  function bindSettings(next, onChange) {
    if (next && typeof next === 'object') {
      settings = {
        sensitivity: clampNum(next.sensitivity, 0.2, 3, DEFAULT_SETTINGS.sensitivity),
        adsSens: clampNum(next.adsSens, 0.2, 1, DEFAULT_SETTINGS.adsSens),
        fov: clampNum(next.fov, 70, 100, DEFAULT_SETTINGS.fov),
        invertY: !!next.invertY,
        master: clampNum(next.master, 0, 1, DEFAULT_SETTINGS.master),
        reduceMotion: !!next.reduceMotion,
        wayfinder: next.wayfinder !== false,
        quality: String(next.quality || DEFAULT_SETTINGS.quality),
        voice: next.voice !== false,
      };
    }
    if (typeof onChange === 'function') settingsOnChange = onChange;
    wireSettings();
    syncSettingsUI();
  }

  // fallback open: main.js owns the pause/pointer-lock side via [data-open-settings]
  document.addEventListener('click', (e) => {
    const trigger = e.target && e.target.closest ? e.target.closest('[data-open-settings]') : null;
    if (!trigger) return;
    setTimeout(() => { if (!settingsOpen) openSettings(); }, 0);
  });

  /* ------------------------------------------------------------ upgrades */
  function showUpgrades(cards, onPick) {
    upgradeData = Array.isArray(cards) ? cards.slice(0, 3) : [];
    upgradeOnPick = typeof onPick === 'function' ? onPick : null;
    upgradeChosen = false;
    clearTimeout(upgradeTimer);
    buildUpgradeCards();
    if (el.upgrades) {
      el.upgrades.classList.remove('hidden');
      el.upgrades.setAttribute('aria-hidden', 'false');
    }
  }

  function buildUpgradeCards() {
    if (!el.upgradeCards) return;
    el.upgradeCards.innerHTML = '';
    const fallbackIcons = ['✦', '◈', '⬢'];
    upgradeData.forEach((c, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'upgrade-card';
      card.dataset.index = String(i);
      if (c && c.id !== undefined) card.dataset.id = String(c.id);

      const key = document.createElement('span');
      key.className = 'up-key';
      key.textContent = c && c.key != null ? String(c.key) : String(i + 1);
      const icon = document.createElement('span');
      icon.className = 'up-icon';
      const glyph = c && c.icon ? String(c.icon) : fallbackIcons[i % fallbackIcons.length];
      icon.textContent = glyph;
      if (/^[A-Za-z0-9+/\- ]{2,6}$/.test(glyph)) icon.classList.add('code');
      const title = document.createElement('span');
      title.className = 'up-title';
      title.textContent = c && c.title ? String(c.title) : `UPGRADE ${i + 1}`;
      const desc = document.createElement('span');
      desc.className = 'up-desc';
      desc.textContent = c && c.desc ? String(c.desc) : '';
      const pick = document.createElement('span');
      pick.className = 'up-pick';
      pick.textContent = 'SELECT';

      card.append(key, icon, title, desc, pick);
      card.addEventListener('click', () => pickUpgrade(i));
      el.upgradeCards.appendChild(card);
    });
  }

  function pickUpgrade(index) {
    if (upgradeChosen) return;
    const card = upgradeData[index];
    if (!card) return;
    upgradeChosen = true;
    const nodes = el.upgradeCards ? el.upgradeCards.querySelectorAll('.upgrade-card') : [];
    nodes.forEach((n, i) => {
      n.classList.toggle('chosen', i === index);
      n.disabled = true;
    });
    const id = card.id !== undefined ? card.id : index;
    if (upgradeOnPick) {
      try { upgradeOnPick(id); }
      catch (err) { console.error('[hud] upgrade onPick failed', err); }
    }
    // main.js owns the lifecycle and calls hideUpgrades() on pick. This is only a
    // long safety net so the player is never permanently stuck on the overlay.
    clearTimeout(upgradeTimer);
    upgradeTimer = setTimeout(() => {
      if (el.upgrades && !el.upgrades.classList.contains('hidden')) hideUpgrades();
    }, 30000);
  }

  function hideUpgrades() {
    clearTimeout(upgradeTimer);
    if (el.upgrades) {
      el.upgrades.classList.add('hidden');
      el.upgrades.setAttribute('aria-hidden', 'true');
    }
    if (el.upgradeCards) el.upgradeCards.innerHTML = '';
    upgradeData = [];
    upgradeOnPick = null;
    upgradeChosen = false;
  }

  /* ------------------------------------------------------------ tutorial / atmosphere */
  function showTutorial(text, keyLabel) {
    const t = String(text == null ? '' : text).trim();
    if (!t) { hideTutorial(); return; }
    if (el.tutorialText) el.tutorialText.textContent = t;
    const key = keyLabel == null ? '' : String(keyLabel).trim();
    if (el.tutorialKey) el.tutorialKey.textContent = key;
    if (el.tutorial) {
      el.tutorial.classList.toggle('no-key', !key);
      el.tutorial.classList.add('show');
    }
  }
  function hideTutorial() {
    if (el.tutorial) el.tutorial.classList.remove('show');
  }
  function setAtmosphere(label) {
    const text = String(label == null ? '' : label).trim();
    if (!el.atmo) return;
    if (!text) { el.atmo.classList.add('hidden'); return; }
    if (el.atmoValue) el.atmoValue.textContent = text;
    el.atmo.classList.remove('hidden');
    const k = text.toLowerCase();
    let mode = 'dusk';
    if (k.includes('storm') || k.includes('rain') || k.includes('雷')) mode = 'storm';
    else if (k.includes('blue') || k.includes('night') || k.includes('蓝')) mode = 'blue';
    else if (k.includes('noon') || k.includes('day') || k.includes('clear') || k.includes('正午')) mode = 'noon';
    el.atmo.dataset.mode = mode;
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

    // enemy fire / UAV markers
    for (const p of state.pings) {
      const delta = norm180(p.bearing - heading);
      if (Math.abs(delta) > COMPASS_RANGE) continue;
      const x = cx + delta * pxPerDeg;
      const isUav = p.kind === 'uav';
      // UAV diamonds fade out sooner than fire triangles
      const alive = clamp01(p.life / (isUav ? 0.55 : 0.32));
      const edge = 1 - Math.abs(delta) / COMPASS_RANGE;
      const a = alive * edge;
      if (a <= 0) continue;
      const ty = baseline - 15;
      c.save();
      c.shadowColor = `rgba(232,74,58,${0.9 * a})`;
      c.shadowBlur = isUav ? 12 : 9;
      c.fillStyle = `rgba(255,86,74,${(0.98 * a).toFixed(3)})`;
      if (isUav) {
        c.beginPath();
        c.moveTo(x, ty - 7);
        c.lineTo(x + 5.5, ty);
        c.lineTo(x, ty + 7);
        c.lineTo(x - 5.5, ty);
        c.closePath();
        c.fill();
        c.shadowBlur = 0;
        c.strokeStyle = `rgba(3,5,7,${(0.55 * a).toFixed(3)})`;
        c.lineWidth = 1;
        c.stroke();
      } else {
        c.beginPath();
        c.moveTo(x, ty + 8);
        c.lineTo(x - 5, ty);
        c.lineTo(x + 5, ty);
        c.closePath();
        c.fill();
        c.fillRect(x - 0.5, ty - 6, 1, 6);
      }
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

    if (areaHold > 0) {
      areaHold -= dt;
      if (areaHold <= 0 && el.areaTag) el.areaTag.classList.remove('show');
    }

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
    closeSettings();
    hideUpgrades();
    hideTutorial();
    hideMode();
    if (el.streak) el.streak.classList.add('hidden');
    if (el.uav) el.uav.classList.add('hidden');
    if (el.reward) el.reward.classList.remove('show');
    if (el.toast) { el.toast.classList.remove('show'); if (el.toastText) el.toastText.textContent = ''; }
    if (el.areaTag) el.areaTag.classList.remove('show');
    areaKey = '';
    areaHold = 0;
    clearTimeout(rewardTimer);
    clearTimeout(toastTimer);
    compassDirty = true;
  }

  return {
    el, show, update, reset,
    setHealth, setAmmo, setWeaponName, setWeaponTag, setSlots, setWave, setWaveProgress, setObjective,
    setScore, setGrenades, hit, addKillFeed, setDamage, flashDamage,
    setReloadPrompt, setHint, ping, setSpread, radio, clearRadio, setVoicePlayer,
    setHeading(h) { state.heading = h; },
    bindSettings, openSettings, closeSettings,
    get isSettingsOpen() { return settingsOpen; },
    showUpgrades, hideUpgrades, showTutorial, hideTutorial, setAtmosphere,
    setMode, setModeProgress, setZoneDistance, hideMode,
    bindModeSelect, setModeSelect,
    setStreak, setStreakReward, setUav, uavPing, toast, setArea,
    get state() { return state; },
  };
}
