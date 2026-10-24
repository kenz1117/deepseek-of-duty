import * as THREE from 'three';

/* =========================================================================
   Procedural PBR texture library.
   Everything is generated on <canvas> at load time so the game ships with
   zero external asset downloads. Noise is tileable, normals are derived from
   height fields, and grime/cracks/wear are composited in 2D for speed.
   ========================================================================= */

const SIZE = 512;

/* ---------- deterministic RNG + tileable value noise ---------- */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rnd(); }
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  function hash(ix, iy, period) {
    ix = ((ix % period) + period) % period;
    iy = ((iy % period) + period) % period;
    return vals[(perm[(perm[ix & 255] + iy) & 255]) & 255];
  }
  function smooth(t) { return t * t * (3 - 2 * t); }

  return function noise(x, y, period) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const a = hash(x0, y0, period), b = hash(x0 + 1, y0, period);
    const c = hash(x0, y0 + 1, period), d = hash(x0 + 1, y0 + 1, period);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

function fbmFactory(seed) {
  const n = makeNoise(seed);
  return function fbm(u, v, oct = 5, base = 4, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, p = base;
    for (let i = 0; i < oct; i++) {
      sum += n(u * p, v * p, p) * amp;
      norm += amp; amp *= gain; p *= 2;
    }
    return sum / norm;
  };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/* ---------- canvas helpers ---------- */
function cv(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function tex(canvas, { srgb = false, aniso = 8, repeat = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

/** height (Uint8Array size*size) -> normal map canvas */
function normalFromHeight(h, size, strength = 2.2) {
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const H = (x, y) => h[(((y + size) % size) * size + ((x + size) % size))] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grayCanvas(h, size) {
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = h[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================ MATERIAL BUILDERS ============================ */

/** worn concrete / sidewalk */
function concreteSet(seed, { tint = [128, 124, 116], stains = 0.5, cracks = 0.55, size = SIZE } = {}) {
  const fbm = fbmFactory(seed), rnd = mulberry32(seed + 91);
  const h = new Uint8Array(size * size);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbm(u, v, 5, 4, 0.55);
      const n2 = fbm(u, v, 4, 16, 0.5);
      const grain = rnd() * 0.10;
      let val = 0.58 + (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.22 + (grain - 0.05) * 0.34;
      val = Math.max(0.3, Math.min(0.96, val));
      const i = (y * size + x) * 4;
      const shade = val * (0.8 + n2 * 0.3);
      d[i] = tint[0] * shade; d[i + 1] = tint[1] * shade; d[i + 2] = tint[2] * shade; d[i + 3] = 255;
      h[y * size + x] = Math.min(255, val * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  // cracks
  ctx.lineCap = 'round';
  const nCracks = Math.floor(6 + cracks * 14);
  for (let k = 0; k < nCracks; k++) {
    let x = rnd() * size, y = rnd() * size;
    let ang = rnd() * Math.PI * 2;
    const len = 30 + rnd() * 150;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < len; s += 4) {
      ang += (rnd() - 0.5) * 0.7;
      x += Math.cos(ang) * 4; y += Math.sin(ang) * 4;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(20,18,16,${0.22 + rnd() * 0.34})`;
    ctx.lineWidth = 0.6 + rnd() * 1.3;
    ctx.stroke();
    // darken height along crack
    ctx.strokeStyle = `rgba(0,0,0,0.42)`; ctx.lineWidth = 1.8; ctx.stroke();
  }
  // stains / water streaks / damp patches
  for (let k = 0; k < 30; k++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 12 + rnd() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() > 0.4;
    g.addColorStop(0, dark ? `rgba(28,24,20,${0.14 * stains})` : `rgba(196,190,176,${0.09 * stains})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // aggregate speckle - small, low contrast (no more giant white confetti)
  for (let k = 0; k < 5200; k++) {
    const x = rnd() * size, y = rnd() * size, a = 0.03 + rnd() * 0.07;
    ctx.fillStyle = rnd() > 0.55 ? `rgba(232,228,216,${a})` : `rgba(12,11,10,${a})`;
    ctx.fillRect(x, y, 0.7 + rnd() * 1.3, 0.7 + rnd() * 1.3);
  }
  // fine grit
  const fin = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    h[i] = (fin[i * 4] * 0.32 + fin[i * 4 + 1] * 0.5 + fin[i * 4 + 2] * 0.18);
  }
  const rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) rough[i] = 176 + (255 - h[i]) * 0.24;

  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 1.25)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** asphalt road — dark, fine chip seal, tar seams, patches, oil stains.
 *  No repeating "puddle sheen" blob (that used to tile into a visible grid). */
function asphaltSet(seed) {
  const fbm = fbmFactory(seed), rnd = mulberry32(seed + 3);
  const size = SIZE;
  const h = new Uint8Array(size * size);
  const rough = new Uint8Array(size * size);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbm(u, v, 4, 3, 0.55);
      const n2 = fbm(u, v, 3, 13, 0.5);
      const n3 = fbm(u, v, 2, 46, 0.5);
      const dust = smoothstep(0.5, 0.78, fbm(u, v, 2, 2, 0.6));
      let val = 0.5 + (n1 - 0.5) * 0.30 + (n2 - 0.5) * 0.17 + (n3 - 0.5) * 0.10;
      val = Math.max(0.30, Math.min(0.9, val));
      const i = (y * size + x) * 4;
      // cold gray aggregate with warm settled dust in the hollows
      let r = (104 + dust * 50) * val;
      let g = (100 + dust * 44) * val;
      let b = (94 + dust * 36) * val;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      h[y * size + x] = Math.min(255, val * 200 + dust * 20);
      rough[y * size + x] = 228 + (1 - n1) * 22 - dust * 14 + (n2 - 0.5) * 8;
    }
  }
  ctx.putImageData(img, 0, 0);

  // ---- chip-seal aggregate: tiny, dense, low contrast
  for (let k = 0; k < 26000; k++) {
    const x = rnd() * size, y = rnd() * size, r = 0.35 + rnd() * 0.95;
    const a = 0.035 + rnd() * 0.11;
    ctx.fillStyle = rnd() > 0.62 ? `rgba(196,190,178,${a})` : `rgba(10,10,9,${a})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // sparse larger stones
  for (let k = 0; k < 900; k++) {
    const x = rnd() * size, y = rnd() * size, r = 1.1 + rnd() * 1.6;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(168,162,150,${0.05 + rnd() * 0.07})` : `rgba(14,13,12,${0.08 + rnd() * 0.10})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }

  // ---- repair patches: straight-edged darker asphalt pours
  for (let k = 0; k < 4; k++) {
    const x = rnd() * size, y = rnd() * size;
    const w = 40 + rnd() * 110, hh = 24 + rnd() * 90;
    ctx.fillStyle = `rgba(34,33,31,${0.16 + rnd() * 0.18})`;
    ctx.fillRect(x, y, w, hh);
    ctx.strokeStyle = `rgba(20,19,18,${0.28})`; ctx.lineWidth = 1.4;
    ctx.strokeRect(x + 1, y + 1, w - 2, hh - 2);
    // slightly smoother (shinier) inside
    for (let i = 0; i < w * hh; i += 7) {
      const px = Math.floor(x + (i % w)), py = Math.floor(y + ((i / w) | 0));
      if (px < size && py < size) {
        const idx = py * size + px;
        rough[idx] = Math.max(160, rough[idx] - 20);
      }
    }
  }

  // ---- long tar crack seams (rubberized repair)
  ctx.lineCap = 'round';
  for (let k = 0; k < 7; k++) {
    let x = rnd() * size, y = rnd() * size, ang = rnd() * 7;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 90 + rnd() * 200; s += 6) {
      ang += (rnd() - 0.5) * 0.42;
      x += Math.cos(ang) * 6; y += Math.sin(ang) * 6; ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(12,11,10,.62)'; ctx.lineWidth = 1.2 + rnd() * 2.2; ctx.stroke();
    ctx.strokeStyle = 'rgba(58,55,50,.16)'; ctx.lineWidth = 3.6; ctx.stroke();
  }
  // ---- fine fatigue cracks
  for (let k = 0; k < 16; k++) {
    let x = rnd() * size, y = rnd() * size, ang = rnd() * 7;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 20 + rnd() * 60; s += 3) {
      ang += (rnd() - 0.5) * 0.9; x += Math.cos(ang) * 3; y += Math.sin(ang) * 3; ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(16,15,14,${0.3 + rnd() * 0.25})`; ctx.lineWidth = 0.6 + rnd() * 0.8; ctx.stroke();
  }

  // ---- oil / fluid stains: dark, multi-lobe, slightly glossy
  const oilMat = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(20,20,22,${a})`);
    g.addColorStop(0.55, `rgba(26,25,26,${a * 0.7})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    for (let i = 0; i < 120; i++) {
      const a2 = rnd() * 7, rr = Math.sqrt(rnd()) * r;
      const px = Math.round(x + Math.cos(a2) * rr), py = Math.round(y + Math.sin(a2) * rr);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const idx = py * size + px;
      rough[idx] = Math.max(120, rough[idx] - 58);
    }
  };
  for (let k = 0; k < 7; k++) {
    const x = rnd() * size, y = rnd() * size, r = 22 + rnd() * 54;
    oilMat(x, y, r, 0.22 + rnd() * 0.24);
    for (let l = 0; l < 3; l++) oilMat(x + (rnd() - 0.5) * r * 1.6, y + (rnd() - 0.5) * r * 1.6, r * (0.3 + rnd() * 0.4), 0.14 + rnd() * 0.16);
  }
  // subtle blue-rainbow sheen in the biggest stain
  const sg = ctx.createRadialGradient(size * 0.62, size * 0.35, 2, size * 0.62, size * 0.35, 70);
  sg.addColorStop(0, 'rgba(60,70,86,.10)'); sg.addColorStop(0.7, 'rgba(38,40,44,.05)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(size * 0.62, size * 0.35, 70, 0, 7); ctx.fill();

  const fin = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    h[i] = fin[i * 4] * 0.55 + fin[i * 4 + 1] * 0.45;
    rough[i] = Math.max(238, rough[i]);
  }

  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 0.22)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** plaster / stucco wall for the close-up buildings.
 *  Low contrast trowel mottle + damp stains + hairline cracks + rain streaks. */
function plasterSet(seed, { base = [156, 146, 128], warm = 1.0, chipped = 0.5 } = {}) {
  const size = SIZE;
  const fbm = fbmFactory(seed), rnd = mulberry32(seed + 29);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbm(u, v, 4, 3, 0.6);
      const n2 = fbm(u, v, 4, 17, 0.5);
      const n3 = fbm(u, v, 2, 60, 0.5);
      let val = 0.9 + (n1 - 0.5) * 0.17 + (n2 - 0.5) * 0.10 + (n3 - 0.5) * 0.045;
      const i = (y * size + x) * 4;
      d[i] = base[0] * val * warm;
      d[i + 1] = base[1] * val;
      d[i + 2] = base[2] * val * (2 - warm);
      d[i + 3] = 255;
      h[y * size + x] = Math.min(255, 120 + (n1 - 0.5) * 30 + (n2 - 0.5) * 60 + (n3 - 0.5) * 40);
    }
  }
  ctx.putImageData(img, 0, 0);

  // trowel patches (slightly different tone, thin dark edge)
  for (let k = 0; k < 22; k++) {
    const x = rnd() * size, y = rnd() * size, w = 30 + rnd() * 120, hh = 20 + rnd() * 80;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(220,210,192,.055)` : `rgba(96,88,76,.06)`;
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, hh * 0.5, rnd() * 0.4, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(60,54,44,.07)'; ctx.lineWidth = 1;
    ctx.stroke();
  }
  // damp / mould stains
  for (let k = 0; k < 26; k++) {
    const x = rnd() * size, y = rnd() * size, r = 16 + rnd() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(58,52,42,${0.07 + rnd() * 0.10})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // chipped plaster showing darker render underneath
  for (let k = 0; k < 20 * chipped; k++) {
    const x = rnd() * size, y = rnd() * size, r = 2 + rnd() * 9;
    ctx.fillStyle = `rgba(${base[0] * 0.62},${base[1] * 0.6},${base[2] * 0.58},.28)`;
    ctx.beginPath();
    for (let a = 0; a < 7; a++) {
      const ang = (a / 7) * Math.PI * 2, rr = r * (0.55 + rnd() * 0.7);
      const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
      a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,36,30,.22)'; ctx.lineWidth = 0.8; ctx.stroke();
  }
  // hairline cracks
  ctx.lineCap = 'round';
  for (let k = 0; k < 12; k++) {
    let x = rnd() * size, y = rnd() * size, ang = rnd() * 7;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 40 + rnd() * 120; s += 4) {
      ang += (rnd() - 0.5) * 0.55; x += Math.cos(ang) * 4; y += Math.sin(ang) * 4; ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(52,46,38,${0.16 + rnd() * 0.18})`; ctx.lineWidth = 0.7 + rnd() * 0.8; ctx.stroke();
  }
  // vertical rain streaks
  for (let k = 0; k < 18; k++) {
    const x = rnd() * size;
    const grd = ctx.createLinearGradient(0, 0, 0, size);
    grd.addColorStop(0, `rgba(44,40,34,${0.04 + rnd() * 0.08})`);
    grd.addColorStop(0.7, 'rgba(44,40,34,.02)');
    grd.addColorStop(1, 'rgba(44,40,34,0)');
    ctx.fillStyle = grd; ctx.fillRect(x, 0, 1.5 + rnd() * 5, size);
  }
  // fine grit
  for (let k = 0; k < 6000; k++) {
    const x = rnd() * size, y = rnd() * size, a = 0.02 + rnd() * 0.05;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,250,236,${a})` : `rgba(20,18,16,${a})`;
    ctx.fillRect(x, y, 0.7 + rnd() * 1.4, 0.7 + rnd() * 1.4);
  }

  const fin = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.35 + fin[i * 4 + 1] * 0.45 + fin[i * 4 + 2] * 0.2;
    h[i] = Math.min(255, h[i] * 0.55 + lum * 0.45);
  }
  const rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) rough[i] = 214 + (255 - h[i]) * 0.1;
  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 1.05)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** distant facade tile: (optionally) multi-floor window grid with real recess
 *  shading, sills, lintels, AC boxes, boarded/broken/lit variants.
 *  Used with a world-space module size so proportions stay correct. */
function facadeSet(seed, opt = {}) {
  const {
    base = [126, 120, 108], floors = 2, cols = 3, litChance = 0.16,
    windowColor = [16, 21, 26], trim = [150, 144, 130], boardChance = 0.05,
    acChance = 0.28, balconyChance = 0.22, brokenChance = 0.10,
  } = opt;
  const size = SIZE;
  const fbm = fbmFactory(seed), rnd = mulberry32(seed + 17);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const hc = cv(size), hctx = hc.getContext('2d', { willReadFrequently: true });
  hctx.fillStyle = '#8a8a8a'; hctx.fillRect(0, 0, size, size);

  // wall base noise
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbm(u, v, 5, 4, 0.55), n2 = fbm(u, v, 4, 24, 0.5);
      let val = 0.88 + (n1 - 0.5) * 0.26 + (n2 - 0.5) * 0.12 + (rnd() - 0.5) * 0.04;
      val = Math.max(0.58, Math.min(1.1, val));
      const i = (y * size + x) * 4;
      d[i] = base[0] * val; d[i + 1] = base[1] * val; d[i + 2] = base[2] * val; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const fw = size / cols, fh = size / floors;
  const winW = fw * 0.46, winH = fh * 0.45;

  for (let fy = 0; fy < floors; fy++) {
    for (let cx = 0; cx < cols; cx++) {
      const ox = cx * fw + (fw - winW) / 2, oy = fy * fh + fh * 0.20;
      const lit = rnd() < litChance;
      const boarded = rnd() < boardChance;
      const broken = rnd() < brokenChance;

      // ---- recess shadow / reveal (5px parallax band, dark on top-left)
      ctx.fillStyle = 'rgba(24,20,16,.62)';
      ctx.fillRect(ox - 7, oy - 7, winW + 14, winH + 14);
      ctx.fillStyle = 'rgba(120,112,98,.30)';
      ctx.fillRect(ox - 7, oy + winH + 5, winW + 14, 3);

      // ---- lintel band + sill
      ctx.fillStyle = `rgba(${trim[0]},${trim[1]},${trim[2]},.92)`;
      ctx.fillRect(ox - 9, oy + winH + 2, winW + 18, 8);
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.fillRect(ox - 9, oy + winH + 10, winW + 18, 3);
      ctx.fillStyle = `rgba(${trim[0] + 12},${trim[1] + 12},${trim[2] + 10},.55)`;
      ctx.fillRect(ox - 5, oy - 8, winW + 10, 2);

      // ---- glass
      if (boarded) {
        ctx.fillStyle = 'rgba(34,30,25,1)';
        ctx.fillRect(ox, oy, winW, winH);
        for (let b = 0; b < 4; b++) {
          const by = oy + 4 + b * (winH - 8) / 4;
          ctx.fillStyle = `rgba(${92 + rnd() * 26},${72 + rnd() * 22},${48 + rnd() * 16},.92)`;
          ctx.fillRect(ox - 4, by, winW + 8, (winH - 8) / 4 * 0.72);
          ctx.fillStyle = 'rgba(30,22,14,.5)';
          ctx.fillRect(ox - 4, by + (winH - 8) / 4 * 0.72, winW + 8, 2);
        }
      } else if (lit) {
        const gg = ctx.createLinearGradient(ox, oy, ox + winW * 0.6, oy + winH);
        gg.addColorStop(0, 'rgba(255,206,140,.88)');
        gg.addColorStop(0.6, 'rgba(226,158,86,.82)');
        gg.addColorStop(1, 'rgba(150,96,48,.85)');
        ctx.fillStyle = gg; ctx.fillRect(ox, oy, winW, winH);
        // curtain edge + interior silhouette
        ctx.fillStyle = 'rgba(72,44,24,.55)';
        ctx.fillRect(ox + winW * 0.72, oy, winW * 0.28, winH);
        ctx.fillRect(ox, oy, winW * 0.12, winH);
        ctx.fillStyle = 'rgba(80,54,30,.5)';
        ctx.fillRect(ox + winW * 0.24, oy + winH * 0.42, winW * 0.22, winH * 0.58);
      } else if (broken) {
        ctx.fillStyle = 'rgba(6,7,8,1)'; ctx.fillRect(ox, oy, winW, winH);
        ctx.fillStyle = 'rgba(150,164,172,.16)';
        ctx.beginPath();
        ctx.moveTo(ox, oy); ctx.lineTo(ox + winW * 0.42, oy + winH * 0.34);
        ctx.lineTo(ox + winW * 0.18, oy + winH); ctx.lineTo(ox, oy + winH); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(190,205,212,.30)'; ctx.lineWidth = 1;
        for (let s = 0; s < 4; s++) {
          ctx.beginPath();
          ctx.moveTo(ox + rnd() * winW, oy + rnd() * winH);
          ctx.lineTo(ox + rnd() * winW, oy + rnd() * winH);
          ctx.stroke();
        }
      } else {
        const gg = ctx.createLinearGradient(ox, oy, ox + winW, oy + winH);
        gg.addColorStop(0, `rgba(${windowColor[0] + 22},${windowColor[1] + 26},${windowColor[2] + 28},1)`);
        gg.addColorStop(0.55, `rgba(${windowColor[0] + 4},${windowColor[1] + 8},${windowColor[2] + 8},1)`);
        gg.addColorStop(1, 'rgba(8,11,13,1)');
        ctx.fillStyle = gg; ctx.fillRect(ox, oy, winW, winH);
        // sky reflection streak
        ctx.fillStyle = 'rgba(196,208,214,.10)';
        ctx.beginPath(); ctx.moveTo(ox, oy + winH); ctx.lineTo(ox + winW * 0.5, oy);
        ctx.lineTo(ox + winW * 0.76, oy); ctx.lineTo(ox + winW * 0.22, oy + winH); ctx.closePath(); ctx.fill();
        // dull curtain in some
        if (rnd() < 0.35) {
          ctx.fillStyle = `rgba(${86 + rnd() * 30},${76 + rnd() * 26},${58 + rnd() * 20},.72)`;
          const cw = winW * (0.22 + rnd() * 0.3);
          ctx.fillRect(ox + (rnd() > 0.5 ? 0 : winW - cw), oy, cw, winH);
        }
      }

      // ---- frame: outer casing + vertical mullion
      ctx.fillStyle = 'rgba(44,40,34,.92)';
      ctx.fillRect(ox + winW / 2 - 1.6, oy, 3.2, winH);
      ctx.fillRect(ox, oy + 2, 2.4, winH);
      ctx.fillRect(ox + winW - 2.4, oy + 2, 2.4, winH);
      ctx.fillRect(ox, oy + 1, winW, 2.2);
      // horizontal transom bar
      ctx.fillStyle = 'rgba(52,47,40,.86)';
      ctx.fillRect(ox, oy + winH * 0.30, winW, 2.6);

      // ---- Juliet balcony railing on some
      if (rnd() < balconyChance) {
        ctx.strokeStyle = 'rgba(26,24,21,.85)'; ctx.lineWidth = 2;
        const ry = oy + winH * 0.60;
        ctx.beginPath(); ctx.moveTo(ox - 12, ry); ctx.lineTo(ox + winW + 12, ry); ctx.stroke();
        for (let b = 0; b < 9; b++) {
          const bx = ox - 10 + b * (winW + 20) / 8;
          ctx.beginPath(); ctx.moveTo(bx, ry); ctx.lineTo(bx, oy + winH + 6); ctx.stroke();
        }
      }

      // ---- AC box under some sills
      if (rnd() < acChance) {
        const aw = Math.min(winW * 0.7, 54), ah = 26;
        const ax = ox + (winW - aw) / 2, ay = oy + winH + 14;
        ctx.fillStyle = 'rgba(128,126,116,.9)'; ctx.fillRect(ax, ay, aw, ah);
        ctx.fillStyle = 'rgba(52,52,48,.8)';
        for (let g = 0; g < 5; g++) ctx.fillRect(ax + 3, ay + 4 + g * 4.4, aw - 6, 1.6);
        ctx.fillStyle = 'rgba(20,18,16,.35)'; ctx.fillRect(ax, ay + ah, aw, 4);
        // rust drip
        const gd = ctx.createLinearGradient(0, ay + ah, 0, ay + ah + 26);
        gd.addColorStop(0, 'rgba(86,46,22,.22)'); gd.addColorStop(1, 'rgba(86,46,22,0)');
        ctx.fillStyle = gd; ctx.fillRect(ax + aw * 0.3, ay + ah, 2, 26);
      }

      // ---- grime streaks below sill
      for (let s = 0; s < 4; s++) {
        const sx = ox + rnd() * winW;
        const grd = ctx.createLinearGradient(0, oy + winH + 10, 0, oy + winH + 34 + rnd() * 40);
        grd.addColorStop(0, 'rgba(32,28,22,.22)'); grd.addColorStop(1, 'rgba(32,28,22,0)');
        ctx.fillStyle = grd; ctx.fillRect(sx, oy + winH + 10, 1.5 + rnd() * 3, 36);
      }

      // ---- height map for the reveal
      hctx.fillStyle = boarded ? '#7a7a7a' : '#262626';
      hctx.fillRect(ox, oy, winW, winH);
      hctx.fillStyle = '#9a9a9a';
      hctx.fillRect(ox + winW / 2 - 2, oy, 3, winH);
      hctx.fillStyle = '#d0d0d0';
      hctx.fillRect(ox - 9, oy + winH + 2, winW + 18, 8);
    }
    // floor string course
    ctx.fillStyle = 'rgba(255,250,240,.05)';
    ctx.fillRect(0, fy * fh + fh - 4, size, 3);
    ctx.fillStyle = 'rgba(0,0,0,.16)';
    ctx.fillRect(0, fy * fh + fh - 1, size, 2);
    hctx.fillStyle = '#a4a4a4'; hctx.fillRect(0, fy * fh + fh - 4, size, 3);
  }

  // stains, moss, chipped paint
  for (let k = 0; k < 40; k++) {
    const x = rnd() * size, y = rnd() * size, r = 8 + rnd() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(26,22,17,${0.09 + rnd() * 0.13})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  for (let k = 0; k < 10; k++) {
    const x = rnd() * size, y = rnd() * size, w = 6 + rnd() * 40, hh = 4 + rnd() * 22;
    ctx.fillStyle = `rgba(${base[0] - 30},${base[1] - 28},${base[2] - 26},.55)`;
    ctx.beginPath(); ctx.ellipse(x, y, w, hh, rnd() * 3, 0, 7); ctx.fill();
  }
  // vertical water streaks along wall
  for (let k = 0; k < 16; k++) {
    const x = rnd() * size;
    const grd = ctx.createLinearGradient(0, 0, 0, size);
    grd.addColorStop(0, `rgba(30,26,20,${0.04 + rnd() * 0.09})`);
    grd.addColorStop(1, 'rgba(30,26,20,0)');
    ctx.fillStyle = grd; ctx.fillRect(x, 0, 2 + rnd() * 6, size);
  }
  // fine speckle
  for (let k = 0; k < 4000; k++) {
    const x = rnd() * size, y = rnd() * size, a = 0.02 + rnd() * 0.05;
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,250,240,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, 1, 1 + rnd() * 1.5);
  }

  const fin = ctx.getImageData(0, 0, size, size).data;
  const hfin = hctx.getImageData(0, 0, size, size).data;
  const h = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) h[i] = hfin[i * 4];
  const rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.3 + fin[i * 4 + 1] * 0.59 + fin[i * 4 + 2] * 0.11;
    rough[i] = Math.min(255, 206 + (150 - lum) * 0.18);
  }
  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 2.2)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** painted / rusted metal */
function metalSet(seed, { base = [70, 78, 62], rust = 0.5, painted = true } = {}) {
  const size = SIZE, fbm = fbmFactory(seed), rnd = mulberry32(seed + 5);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n1 = fbm(u, v, 5, 5, 0.55), n2 = fbm(u, v, 4, 20, 0.5);
      const val = 0.8 + (n1 - 0.5) * 0.35 + (n2 - 0.5) * 0.18;
      const i = (y * size + x) * 4;
      d[i] = base[0] * val; d[i + 1] = base[1] * val; d[i + 2] = base[2] * val; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (painted) {
    // paint chips reveal rust
    for (let k = 0; k < 140; k++) {
      const x = rnd() * size, y = rnd() * size, r = 1 + rnd() * 6;
      ctx.fillStyle = `rgba(${110 + rnd() * 40},${58 + rnd() * 20},${22 + rnd() * 14},${0.5 + rnd() * 0.45})`;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.5 + rnd()), rnd() * 3, 0, 7); ctx.fill();
    }
  }
  // rust blooms
  for (let k = 0; k < 16 * rust; k++) {
    const x = rnd() * size, y = rnd() * size, r = 8 + rnd() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(122,62,24,${0.28 + rnd() * 0.3})`);
    g.addColorStop(0.6, `rgba(88,46,20,${0.18})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // scratches
  for (let k = 0; k < 70; k++) {
    const x = rnd() * size, y = rnd() * size, len = 4 + rnd() * 40, ang = rnd() * 7;
    ctx.strokeStyle = `rgba(${190 + rnd() * 40},${190 + rnd() * 40},${190 + rnd() * 30},${0.03 + rnd() * 0.10})`;
    ctx.lineWidth = rnd() * 1.2; ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
  }
  // horizontal seam lines (painted panels)
  ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, size * 0.5); ctx.lineTo(size, size * 0.5); ctx.stroke();

  const fin = ctx.getImageData(0, 0, size, size).data;
  const h = new Uint8Array(size * size), rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.3 + fin[i * 4 + 1] * 0.5 + fin[i * 4 + 2] * 0.2;
    h[i] = lum;
    const r = fin[i * 4] / 255, g = fin[i * 4 + 1] / 255;
    rough[i] = 110 + r * 90 + (r - g) * 120;
  }
  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 1.2)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** roller shutter: horizontal slats, dents, rust bleed, bullet strikes */
function shutterSet(seed) {
  const size = SIZE, rnd = mulberry32(seed), fbm = fbmFactory(seed + 7);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  const slat = 15;
  for (let y = 0; y < size; y++) {
    const sy = y % slat;
    const t = sy / slat;
    // rounded slat profile: bright ridge then shadow groove
    const prof = 0.74 + Math.sin(t * Math.PI) * 0.20 - smoothstep(0.75, 1.0, t) * 0.24;
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, 3, 9, 0.5);
      const val = prof * (0.92 + (n - 0.5) * 0.16);
      const i = (y * size + x) * 4;
      d[i] = 102 * val; d[i + 1] = 106 * val; d[i + 2] = 98 * val; d[i + 3] = 255;
      h[y * size + x] = Math.min(255, 90 + Math.sin(t * Math.PI) * 110);
    }
  }
  ctx.putImageData(img, 0, 0);
  // slat seams every ~14 slats (panel join)
  ctx.strokeStyle = 'rgba(10,9,8,.5)'; ctx.lineWidth = 2;
  for (let y = 0; y < size; y += slat * 11) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke(); }
  // dents
  for (let k = 0; k < 10; k++) {
    const x = rnd() * size, y = rnd() * size, r = 10 + rnd() * 34;
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    g.addColorStop(0, 'rgba(200,200,190,.14)');
    g.addColorStop(0.55, 'rgba(30,30,28,.20)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // rust bleed from bottom + edges
  for (let k = 0; k < 12; k++) {
    const x = rnd() * size;
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(96,52,22,0)');
    g.addColorStop(1, `rgba(96,52,22,${0.12 + rnd() * 0.2})`);
    ctx.fillStyle = g; ctx.fillRect(x, 0, 2 + rnd() * 8, size);
  }
  const bg = ctx.createLinearGradient(0, size * 0.62, 0, size);
  bg.addColorStop(0, 'rgba(80,46,20,0)'); bg.addColorStop(1, 'rgba(80,46,20,.42)');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
  // bullet strikes
  for (let k = 0; k < 16; k++) {
    const x = rnd() * size, y = rnd() * size;
    ctx.fillStyle = 'rgba(232,226,210,.62)';
    ctx.beginPath(); ctx.arc(x, y, 1.6 + rnd() * 1.8, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(18,17,16,.86)';
    ctx.beginPath(); ctx.arc(x, y, 2.2 + rnd() * 2.4, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(210,200,180,.30)';
    ctx.beginPath(); ctx.arc(x - 1, y - 1, 0.9, 0, 7); ctx.fill();
  }
  // grime gradient + bottom rail
  const gr = ctx.createLinearGradient(0, 0, 0, size);
  gr.addColorStop(0, 'rgba(20,18,15,.10)'); gr.addColorStop(0.6, 'rgba(20,18,15,0)'); gr.addColorStop(1, 'rgba(20,18,15,.26)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, size, size);
  const fin = ctx.getImageData(0, 0, size, size).data;
  const rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.4 + fin[i * 4 + 1] * 0.4 + fin[i * 4 + 2] * 0.2;
    h[i] = Math.min(255, h[i] * 0.7 + lum * 0.3);
    rough[i] = 96 + (255 - lum) * 0.35;
  }
  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 2.4)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** faded painted shop sign / poster wall: blocky pseudo-script, peeling paint */
function signSet(seed, { bg = [46, 74, 68], fg = [222, 214, 190], accent = [176, 82, 48] } = {}) {
  const size = 256, rnd = mulberry32(seed), fbm = fbmFactory(seed + 3);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  ctx.fillRect(0, 0, size, size);
  // brushy background variance
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.86 + (rnd() - 0.5) * 0.18;
    d[i * 4] *= v; d[i * 4 + 1] *= v; d[i * 4 + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);
  // border
  ctx.strokeStyle = `rgba(${fg[0]},${fg[1]},${fg[2]},.75)`;
  ctx.lineWidth = 6; ctx.strokeRect(8, 8, size - 16, size - 16);
  // pseudo arabic glyph row: bars, dots, curves
  const rows = 2;
  for (let r = 0; r < rows; r++) {
    const cy = size * (0.34 + r * 0.34);
    let x = 26;
    while (x < size - 26) {
      const w = 13 + rnd() * 26;
      ctx.fillStyle = rnd() < 0.82 ? `rgba(${fg[0]},${fg[1]},${fg[2]},.92)` : `rgba(${accent[0]},${accent[1]},${accent[2]},.9)`;
      const kind = rnd();
      if (kind < 0.34) {
        ctx.fillRect(x, cy - 5, w, 9);          // thick horizontal stroke
      } else if (kind < 0.62) {
        ctx.fillRect(x, cy - 16, 6, 26);        // vertical ascender
        ctx.fillRect(x, cy + 4, w * 0.7, 7);
      } else if (kind < 0.82) {
        ctx.beginPath(); ctx.arc(x + w * 0.3, cy, 8, 0, 7); ctx.fill();  // bowl
        ctx.fillRect(x + w * 0.62, cy - 12, 5, 22);
      } else {
        ctx.fillRect(x, cy - 2, w, 5);
        ctx.beginPath(); ctx.arc(x + w * 0.2, cy - 14, 3.2, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(x + w * 0.5, cy - 14, 3.2, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(x + w * 0.8, cy - 14, 3.2, 0, 7); ctx.fill();
      }
      x += w + 10 + rnd() * 8;
    }
  }
  // peeling paint / chips
  for (let k = 0; k < 150; k++) {
    const x = rnd() * size, y = rnd() * size, r = 1 + rnd() * 8;
    ctx.fillStyle = `rgba(${bg[0] + 26},${bg[1] + 24},${bg[2] + 20},${0.4 + rnd() * 0.5})`;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.4 + rnd()), rnd() * 3, 0, 7); ctx.fill();
  }
  // rust streaks + grime
  for (let k = 0; k < 16; k++) {
    const x = rnd() * size;
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, `rgba(96,54,24,${0.10 + rnd() * 0.18})`);
    g.addColorStop(1, 'rgba(96,54,24,0)');
    ctx.fillStyle = g; ctx.fillRect(x, 0, 1.5 + rnd() * 6, size);
  }
  const gr = ctx.createLinearGradient(0, 0, 0, size);
  gr.addColorStop(0, 'rgba(16,14,12,.16)'); gr.addColorStop(1, 'rgba(16,14,12,.34)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, size, size);
  return { map: tex(c, { srgb: true }) };
}

/** weathered canvas awning / tarp: stripes + stains + tears */
function awningSet(seed, { a = [158, 149, 128], b = [116, 101, 82] } = {}) {
  const size = 256, rnd = mulberry32(seed), fbm = fbmFactory(seed + 5);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const stripe = 32;
  for (let x = 0; x < size; x++) {
    const i = Math.floor(x / stripe) % 2;
    const col = i ? b : a;
    const t = (x % stripe) / stripe;
    const shade = 0.88 + Math.sin(t * Math.PI) * 0.12;
    ctx.fillStyle = `rgb(${col[0] * shade | 0},${col[1] * shade | 0},${col[2] * shade | 0})`;
    ctx.fillRect(x, 0, 1, size);
  }
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.85 + (rnd() - 0.5) * 0.24;
    d[i * 4] *= v; d[i * 4 + 1] *= v; d[i * 4 + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);
  // weave + stains
  for (let k = 0; k < 22; k++) {
    const x = rnd() * size, y = rnd() * size, r = 8 + rnd() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(46,36,22,${0.10 + rnd() * 0.16})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // dust + seam folds
  const gr = ctx.createLinearGradient(0, 0, 0, size);
  gr.addColorStop(0, 'rgba(30,24,16,.10)'); gr.addColorStop(0.5, 'rgba(30,24,16,.02)'); gr.addColorStop(1, 'rgba(30,24,16,.28)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, size, size);
  return { map: tex(c, { srgb: true }) };
}

/** worn road paint: albedo + erode alpha map (single texture object pair) */
function paintSet(seed) {
  const size = 256, rnd = mulberry32(seed), fbm = fbmFactory(seed + 11);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u, v, 4, 6, 0.55), n2 = fbm(u, v, 2, 30, 0.5);
      const base = 146 + (n - 0.5) * 36 + (n2 - 0.5) * 30;
      const i = (y * size + x) * 4;
      d[i] = base; d[i + 1] = base * 0.985; d[i + 2] = base * 0.94; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // grime / tyre polish
  for (let k = 0; k < 14; k++) {
    const x = rnd() * size, y = rnd() * size, r = 10 + rnd() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(44,42,38,${0.12 + rnd() * 0.2})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  // alpha: erode with noise + big chips + linear wear
  const ac = cv(size), actx = ac.getContext('2d', { willReadFrequently: true });
  const aimg = actx.createImageData(size, size), ad = aimg.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u, v, 4, 8, 0.6), n2 = fbm(u, v, 2, 3, 0.5);
      let a = smoothstep(0.40, 0.66, n * 0.7 + n2 * 0.42) * 0.72;
      // painted-over/dusty patches
      a *= 0.35 + 0.65 * smoothstep(0.30, 0.68, fbm(u, v, 2, 5, 0.5));
      const i = (y * size + x) * 4;
      const val = a * 255;
      ad[i] = ad[i + 1] = ad[i + 2] = val; ad[i + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);
  return { map: tex(c, { srgb: true }), alpha: tex(ac) };
}

/** tyre skid mark: soft dark ribbon texture (streak runs along V) */
function skidSet(seed) {
  const size = 256, rnd = mulberry32(seed), fbm = fbmFactory(seed + 13);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const cx = 0.5 + Math.sin(v * 7.3) * 0.05;
      const edge = Math.exp(-Math.pow((u - cx) / 0.19, 2));
      const tread = 0.62 + 0.38 * (Math.sin(v * 62) * 0.5 + 0.5);
      const n = fbm(u, v, 3, 9, 0.5);
      let a = edge * tread * (0.55 + n * 0.7);
      a *= smoothstep(0.0, 0.08, v) * smoothstep(1.0, 0.9, v);
      const i = (y * size + x) * 4;
      d[i] = 12; d[i + 1] = 12; d[i + 2] = 13;
      d[i + 3] = Math.min(255, a * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: tex(c, { srgb: true }) };
}

/** single torn paper scrap (transparent background) */
function paperSet(seed) {
  const size = 128, rnd = mulberry32(seed), fbm = fbmFactory(seed + 3);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  const pts = 13;
  ctx.beginPath();
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const r = size * (0.30 + rnd() * 0.13);
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.8;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(206,199,182,.96)';
  ctx.fill();
  ctx.clip();
  // print / newsprint mottle
  for (let k = 0; k < 90; k++) {
    ctx.fillStyle = `rgba(${40 + rnd() * 40},${40 + rnd() * 40},${40 + rnd() * 36},${0.05 + rnd() * 0.12})`;
    ctx.fillRect(-size / 2 + rnd() * size, -size / 2 + rnd() * size, 1 + rnd() * 9, 1 + rnd() * 3);
  }
  for (let k = 0; k < 8; k++) {
    ctx.fillStyle = `rgba(120,110,96,${0.08 + rnd() * 0.1})`;
    ctx.beginPath(); ctx.arc(-size / 2 + rnd() * size, -size / 2 + rnd() * size, 2 + rnd() * 8, 0, 7); ctx.fill();
  }
  ctx.restore();
  return { map: tex(c, { srgb: true }) };
}

/** dry weeds / grass tuft cluster (alpha cut-out) */
function weedSet(seed) {
  const size = 128, rnd = mulberry32(seed);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  for (let k = 0; k < 26; k++) {
    const x0 = size * (0.5 + (rnd() - 0.5) * 0.5);
    const bend = (rnd() - 0.5) * 0.9;
    const len = size * (0.35 + rnd() * 0.6);
    const w = 1.1 + rnd() * 2.2;
    const hue = rnd();
    ctx.strokeStyle = hue > 0.6
      ? `rgba(${132 + rnd() * 30},${122 + rnd() * 24},${76 + rnd() * 20},.95)`
      : `rgba(${96 + rnd() * 26},${92 + rnd() * 22},${58 + rnd() * 18},.95)`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, size);
    for (let t = 0.1; t <= 1; t += 0.1) {
      const px = x0 + bend * len * t * t;
      const py = size - len * t;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  return { map: tex(c, { srgb: true }) };
}

/** graffiti tags (transparent paper-plane for wall decals) */
function graffitiSet(seed) {
  const size = 512, rnd = mulberry32(seed);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const cols = ['rgba(196,66,58,.82)', 'rgba(72,96,138,.80)', 'rgba(210,196,86,.74)', 'rgba(84,120,92,.78)'];
  for (let t = 0; t < 3; t++) {
    const cx = size * (0.22 + t * 0.3), cy = size * (0.3 + rnd() * 0.45);
    const col = cols[(rnd() * cols.length) | 0];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rnd() - 0.5) * 0.35);
    ctx.strokeStyle = col; ctx.lineWidth = 7 + rnd() * 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let x = -size * 0.1;
    ctx.beginPath(); ctx.moveTo(x, 0);
    for (let s = 0; s < 9; s++) {
      x += size * (0.02 + rnd() * 0.028);
      const y = (rnd() - 0.5) * size * 0.11;
      ctx.lineTo(x, y);
      if (rnd() < 0.3) ctx.lineTo(x + size * 0.01, y + size * 0.05);
    }
    ctx.stroke();
    // spray speckle around
    for (let s = 0; s < 70; s++) {
      const a = rnd() * 7, rr = Math.sqrt(rnd()) * size * 0.12;
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.10 + rnd() * 0.2;
      ctx.fillRect(Math.cos(a) * rr, Math.sin(a) * rr * 0.5, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  return { map: tex(c, { srgb: true }) };
}

/** brick / masonry for rubble + patched walls */
function brickSet(seed) {
  const size = 512, rnd = mulberry32(seed);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#8b8272'; ctx.fillRect(0, 0, size, size);
  const rows = 16, bh = size / rows, bw = size / 8;
  const h = new Uint8Array(size * size);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let b = -1; b < 9; b++) {
      const x = b * bw + off + 2, y = r * bh + 2;
      const w = bw - 4, hh = bh - 4;
      const tone = 0.72 + rnd() * 0.42;
      ctx.fillStyle = `rgb(${118 * tone | 0},${82 * tone | 0},${66 * tone | 0})`;
      ctx.fillRect(x, y, w, hh);
      // brick face noise
      for (let k = 0; k < 22; k++) {
        ctx.fillStyle = rnd() > 0.5 ? `rgba(255,240,220,${0.02 + rnd() * 0.05})` : `rgba(20,12,8,${0.03 + rnd() * 0.07})`;
        ctx.fillRect(x + rnd() * w, y + rnd() * hh, 1 + rnd() * 4, 1 + rnd() * 2);
      }
      // chipped corner
      if (rnd() < 0.16) {
        ctx.fillStyle = 'rgba(150,140,120,.85)';
        ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w - 6, y); ctx.lineTo(x + w, y + 6); ctx.closePath(); ctx.fill();
      }
    }
  }
  // mortar grime + overall dirt
  for (let k = 0; k < 24; k++) {
    const x = rnd() * size, y = rnd() * size, r2 = 10 + rnd() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r2);
    g.addColorStop(0, `rgba(38,30,22,${0.10 + rnd() * 0.16})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r2, 0, 7); ctx.fill();
  }
  const fin = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.4 + fin[i * 4 + 1] * 0.4 + fin[i * 4 + 2] * 0.2;
    h[i] = Math.min(255, lum);
  }
  return { map: tex(c, { srgb: true }), normalMap: tex(normalFromHeight(h, size, 1.6)) };
}

/** sandbag / canvas fabric */
function fabricSet(seed, { base = [122, 106, 78], weave = 1.0, stains = 0.5 } = {}) {
  const size = SIZE, fbm = fbmFactory(seed), rnd = mulberry32(seed + 11);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u, v, 4, 8, 0.5);
      const w = (Math.sin(x * 1.9) * 0.5 + 0.5) * (Math.sin(y * 1.9) * 0.5 + 0.5);
      const val = 0.78 + (n - 0.5) * 0.32 + (w - 0.25) * 0.16 * weave + (rnd() - 0.5) * 0.06;
      const i = (y * size + x) * 4;
      d[i] = base[0] * val; d[i + 1] = base[1] * val; d[i + 2] = base[2] * val; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 22; k++) {
    const x = rnd() * size, y = rnd() * size, r = 10 + rnd() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(42,34,22,${0.16 * stains})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  const fin = ctx.getImageData(0, 0, size, size).data;
  const h = new Uint8Array(size * size), rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.4 + fin[i * 4 + 1] * 0.4 + fin[i * 4 + 2] * 0.2;
    h[i] = lum;
    rough[i] = 225;
  }
  return {
    map: tex(c, { srgb: true }),
    normalMap: tex(normalFromHeight(h, size, 1.1)),
    roughnessMap: tex(grayCanvas(rough, size)),
  };
}

/** sandbag pile texture: deep folds / burlap */
function burlapSet(seed) {
  const size = SIZE, rnd = mulberry32(seed);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#8d7a55'; ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = 0.8 + (rnd() - 0.5) * 0.3;
    d[i * 4] *= v; d[i * 4 + 1] *= v; d[i * 4 + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);
  for (let k = 0; k < 8000; k++) {
    const x = rnd() * size, y = rnd() * size;
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(230,218,190,.10)' : 'rgba(40,32,20,.12)';
    ctx.fillRect(x, y, 1 + rnd() * 3, 1);
  }
  return { map: tex(c, { srgb: true }) };
}

/** wood crate / plank: vertical boards, grain, nails */
function woodSet(seed) {
  const size = SIZE, rnd = mulberry32(seed), fbm = fbmFactory(seed + 2);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const h = new Uint8Array(size * size);
  // base boards
  const boards = 5, bw = size / boards;
  for (let b = 0; b < boards; b++) {
    const tone = 0.82 + rnd() * 0.3;
    ctx.fillStyle = `rgb(${104 * tone | 0},${76 * tone | 0},${46 * tone | 0})`;
    ctx.fillRect(b * bw, 0, bw, size);
    // long grain
    for (let k = 0; k < 46; k++) {
      const gx = b * bw + rnd() * bw;
      ctx.strokeStyle = rnd() > 0.5
        ? `rgba(${42 + rnd() * 30},${28 + rnd() * 20},${14 + rnd() * 14},${0.10 + rnd() * 0.22})`
        : `rgba(${190 + rnd() * 40},${150 + rnd() * 30},${100 + rnd() * 26},${0.04 + rnd() * 0.10})`;
      ctx.lineWidth = 0.7 + rnd() * 1.8;
      ctx.beginPath();
      let yy = 0, xx = gx;
      ctx.moveTo(xx, yy);
      while (yy < size) {
        yy += 12 + rnd() * 26;
        xx += (rnd() - 0.5) * 3;
        ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
    // knot
    if (rnd() < 0.6) {
      const kx = b * bw + bw * (0.3 + rnd() * 0.4), ky = size * rnd();
      for (let r = 10; r > 1; r -= 2.4) {
        ctx.strokeStyle = `rgba(44,28,14,${0.2 + rnd() * 0.2})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.ellipse(kx, ky, r, r * 1.7, 0, 0, 7); ctx.stroke();
      }
    }
    // plank gap
    ctx.fillStyle = 'rgba(14,9,5,.72)';
    ctx.fillRect(b * bw - 1.2, 0, 2.4, size);
    ctx.fillStyle = 'rgba(220,190,150,.08)';
    ctx.fillRect(b * bw + 1.2, 0, 1.4, size);
    // nails
    for (let n = 0; n < 3; n++) {
      const nx = b * bw + 6 + rnd() * (bw - 12), ny = 14 + n * (size / 3);
      ctx.fillStyle = 'rgba(28,26,24,.85)';
      ctx.beginPath(); ctx.arc(nx, ny, 2.4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(180,176,164,.35)';
      ctx.beginPath(); ctx.arc(nx - 0.7, ny - 0.7, 1.1, 0, 7); ctx.fill();
    }
  }
  // grime + wear
  for (let k = 0; k < 22; k++) {
    const x = rnd() * size, y = rnd() * size, r = 10 + rnd() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(22,16,10,${0.06 + rnd() * 0.14})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  const fin = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.4 + fin[i * 4 + 1] * 0.4 + fin[i * 4 + 2] * 0.2;
    h[i] = Math.min(255, lum * 1.05);
  }
  return { map: tex(c, { srgb: true }), normalMap: tex(normalFromHeight(h, size, 1.1)) };
}

/** soft vertical grime/soot streaks used as a transparent wall decal */
function grimeSet(seed) {
  const size = 256, rnd = mulberry32(seed), fbm = fbmFactory(seed + 4);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  for (let k = 0; k < 34; k++) {
    const x = rnd() * size, w = 2 + rnd() * 22;
    const top = rnd() * size * 0.5, len = size * (0.3 + rnd() * 0.7);
    const g = ctx.createLinearGradient(0, top, 0, top + len);
    g.addColorStop(0, `rgba(22,19,15,${0.12 + rnd() * 0.3})`);
    g.addColorStop(0.55, `rgba(22,19,15,${0.05 + rnd() * 0.12})`);
    g.addColorStop(1, 'rgba(22,19,15,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, top, w, len);
  }
  for (let k = 0; k < 12; k++) {
    const x = rnd() * size, y = rnd() * size * 0.7, r = 10 + rnd() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(18,16,13,${0.10 + rnd() * 0.14})`);
    g.addColorStop(1, 'rgba(18,16,13,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  const img = ctx.getImageData(0, 0, size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = fbm(x / size, y / size, 3, 7, 0.55);
      const edge = smoothstep(0, 0.10, x / size) * smoothstep(1, 0.90, x / size)
        * smoothstep(0, 0.08, y / size) * smoothstep(1, 0.86, y / size);
      d[i + 3] = d[i + 3] * (0.25 + n * 0.9) * edge;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: tex(c, { srgb: true }) };
}

/** dusty palm frond (alpha cut-out) */
function frondSet(seed) {
  const size = 256, rnd = mulberry32(seed);
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(104,96,64,.95)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(4, size / 2); ctx.lineTo(size - 4, size / 2); ctx.stroke();
  for (let i = 0; i < 46; i++) {
    const t = i / 46;
    const x = 8 + t * (size - 16);
    const len = (size * 0.46) * Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.8 + rnd() * 0.3);
    const tone = 0.7 + rnd() * 0.5;
    ctx.strokeStyle = `rgba(${92 * tone | 0},${88 * tone | 0},${48 * tone | 0},${0.85 + rnd() * 0.15})`;
    ctx.lineWidth = 1.6 + rnd() * 1.6;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, size / 2);
      ctx.quadraticCurveTo(x + len * 0.35, size / 2 + sgn * len * 0.55, x + len * 0.62, size / 2 + sgn * len);
      ctx.stroke();
    }
  }
  return { map: tex(c, { srgb: true }) };
}

/* ---------- sprites (particles, decals, muzzle flash) ---------- */
function radialSprite(size, stops) {
  const c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [p, col] of stops) g.addColorStop(p, col);
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return c;
}

function smokeSprite() {
  const size = 128, c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const fbm = fbmFactory(77);
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u, v, 5, 4, 0.55);
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = Math.max(0, 1 - r) ** 1.7 * (0.35 + n * 0.9);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 250; d[i + 2] = 244;
      d[i + 3] = Math.min(255, a * 300);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function flashSprite() {
  const size = 256, c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(size / 2, size / 2);
  // star burst
  for (let i = 0; i < 9; i++) {
    ctx.save(); ctx.rotate((i / 9) * Math.PI * 2 + 0.2);
    const len = size * (0.22 + (i % 3) * 0.12);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,250,225,1)');
    g.addColorStop(0.4, 'rgba(255,196,90,.85)');
    g.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(len, 0); ctx.lineTo(0, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.3);
  g2.addColorStop(0, 'rgba(255,255,245,1)');
  g2.addColorStop(0.25, 'rgba(255,214,140,.95)');
  g2.addColorStop(0.6, 'rgba(255,140,40,.45)');
  g2.addColorStop(1, 'rgba(255,90,10,0)');
  ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(0, 0, size * 0.3, 0, 7); ctx.fill();
  return c;
}

function holeSprite() {
  const size = 128, c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const fbm = fbmFactory(9);
  const img = ctx.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const dx = u - 0.5, dy = v - 0.5;
      const rad = Math.hypot(dx, dy) * 2;
      const ang = Math.atan2(dy, dx);
      const n = fbm(u, v, 4, 6, 0.6);
      const edge = 0.34 + n * 0.16 + Math.sin(ang * 9) * 0.03;
      let a = 0, col = 0;
      if (rad < edge) { a = 1; col = 6 + n * 12; }
      else if (rad < edge + 0.28) {
        const t = 1 - (rad - edge) / 0.28;
        a = t * (0.55 + n * 0.4);
        col = 30 + n * 55;
      }
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = col;
      d[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function bloodSprite() {
  const size = 128, c = cv(size), ctx = c.getContext('2d', { willReadFrequently: true });
  const rnd = mulberry32(31);
  for (let k = 0; k < 26; k++) {
    const ang = rnd() * 7, dist = rnd() * size * 0.42;
    const x = size / 2 + Math.cos(ang) * dist, y = size / 2 + Math.sin(ang) * dist;
    const r = 2 + rnd() * 13 * (1 - dist / (size * 0.6));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(92,8,8,.95)');
    g.addColorStop(0.7, 'rgba(66,5,5,.7)');
    g.addColorStop(1, 'rgba(40,2,2,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  return c;
}

function laserSprite() {
  return radialSprite(64, [
    [0, 'rgba(255,70,50,1)'], [0.2, 'rgba(255,40,26,.9)'],
    [0.45, 'rgba(255,30,20,.35)'], [1, 'rgba(255,20,10,0)'],
  ]);
}

/* ============================ LIBRARY ============================ */
export function buildMaterials(maxAniso = 8) {
  const mk = (set, extra = {}, repeat = 1) => {
    const m = new THREE.MeshStandardMaterial({ ...set, ...extra });
    for (const k of ['map', 'normalMap', 'roughnessMap', 'alphaMap']) {
      if (m[k]) { m[k].anisotropy = maxAniso; m[k].repeat.set(repeat, repeat); }
    }
    return m;
  };

  const concrete = concreteSet(1201, { tint: [136, 132, 121] });
  const concreteDark = concreteSet(3102, { tint: [94, 92, 86], stains: 0.85 });
  const asphalt = asphaltSet(555);
  const plasterA = plasterSet(1401, { base: [158, 148, 128], warm: 1.02 });
  const plasterB = plasterSet(1402, { base: [139, 140, 136], warm: 0.99, chipped: 0.8 });
  const plasterC = plasterSet(1403, { base: [160, 132, 104], warm: 1.05 });
  const facadeA = facadeSet(701, { base: [138, 128, 108], floors: 2, cols: 3, litChance: 0.20 });
  const facadeB = facadeSet(1502, { base: [120, 122, 120], floors: 2, cols: 4, litChance: 0.07, trim: [132, 132, 126], acChance: 0.35 });
  const facadeC = facadeSet(2203, { base: [148, 120, 98], floors: 2, cols: 3, litChance: 0.14, trim: [162, 144, 122], balconyChance: 0.3 });
  const facadeD = facadeSet(2704, { base: [112, 108, 104], floors: 3, cols: 3, litChance: 0.09, trim: [120, 116, 110], brokenChance: 0.16, boardChance: 0.07 });
  const shop = shutterSet(881);
  const metal = metalSet(990, { base: [64, 74, 58], rust: 0.25 });
  const metalTan = metalSet(991, { base: [124, 104, 70], rust: 0.15 });
  const rust = metalSet(992, { base: [96, 62, 40], rust: 1.0, painted: false });
  const sandbag = (typeof fabricSet === 'function') ? fabricSet(993, { base: [124, 108, 78] }) : plasterSet(1993, { base: [124, 108, 78], warm: 0.75, chipped: 0.7 });
  const burlap = (typeof burlapSet === 'function') ? burlapSet(994) : plasterSet(1994, { base: [142, 122, 86], warm: 0.7, chipped: 0.6 });
  const wood = (typeof woodSet === 'function') ? woodSet(995) : plasterSet(1995, { base: [112, 84, 52], warm: 0.9, chipped: 0.5 });
  const awning = awningSet(1201);
  const signA = signSet(2101, { bg: [38, 60, 56], fg: [212, 204, 180], accent: [150, 74, 48] });
  const signB = signSet(2102, { bg: [92, 46, 40], fg: [214, 202, 176], accent: [58, 70, 58] });
  const signC = signSet(2103, { bg: [168, 154, 122], fg: [52, 48, 40], accent: [128, 58, 40] });
  const paint = paintSet(3301);
  const skid = skidSet(3302);
  const paper = paperSet(3303);
  const weed = weedSet(3304);
  const graffiti = graffitiSet(3305);
  const brick = brickSet(3306);
  const grime = grimeSet(3401);
  const frond = frondSet(3402);

  const lib = {
    // ---- surfaces
    concrete: mk(concrete, { roughness: 0.97, metalness: 0.0, envMapIntensity: 0.32 }),
    concreteDark: mk(concreteDark, { roughness: 0.98, metalness: 0.0, envMapIntensity: 0.28 }),
    asphalt: mk(asphalt, { roughness: 1.0, metalness: 0.0, envMapIntensity: 0.05 }),
    brick: mk(brick, { roughness: 0.95, metalness: 0.0, envMapIntensity: 0.45 }),
    plasterA: mk(plasterA, { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.5 }),
    plasterB: mk(plasterB, { roughness: 0.94, metalness: 0.0, envMapIntensity: 0.45 }),
    plasterC: mk(plasterC, { roughness: 0.92, metalness: 0.0, envMapIntensity: 0.5 }),
    facadeA: mk(facadeA, { roughness: 0.91, metalness: 0.0, envMapIntensity: 0.5 }),
    facadeB: mk(facadeB, { roughness: 0.93, metalness: 0.0, envMapIntensity: 0.45 }),
    facadeC: mk(facadeC, { roughness: 0.91, metalness: 0.0, envMapIntensity: 0.5 }),
    facadeD: mk(facadeD, { roughness: 0.93, metalness: 0.0, envMapIntensity: 0.45 }),
    shop: mk(shop, { roughness: 0.66, metalness: 0.5, envMapIntensity: 0.7 }),
    metal: mk(metal, { roughness: 0.48, metalness: 0.8, envMapIntensity: 1.0 }),
    metalTan: mk(metalTan, { roughness: 0.6, metalness: 0.5, envMapIntensity: 0.9 }),
    rust: mk(rust, { roughness: 0.82, metalness: 0.55, envMapIntensity: 0.7 }),
    sandbag: mk(sandbag, { roughness: 0.95, metalness: 0.0, envMapIntensity: 0.35 }),
    burlap: mk(burlap, { roughness: 0.96, metalness: 0.0, envMapIntensity: 0.3 }),
    wood: mk(wood, { roughness: 0.88, metalness: 0.0, envMapIntensity: 0.4 }),
    awning: mk(awning, { roughness: 0.93, metalness: 0.0, envMapIntensity: 0.4, side: THREE.DoubleSide }),
    signA: mk(signA, { roughness: 0.72, metalness: 0.15, envMapIntensity: 0.6 }),
    signB: mk(signB, { roughness: 0.72, metalness: 0.15, envMapIntensity: 0.6 }),
    signC: mk(signC, { roughness: 0.78, metalness: 0.1, envMapIntensity: 0.5 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0x453b30, roughness: 1, metalness: 0 }),

    // ---- flora: leaves, bark, blossoms, soil. Plants must never stop a
    // bullet and the small ones must not cost a shadow pass.
    leaf: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x4e6b38, roughness: 0.95, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.35,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    leafDeep: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x35502c, roughness: 0.96, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.3,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    leafDry: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x8a7a45, roughness: 0.97, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.3,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    bark: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x4a3a2b, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.25,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    blossomA: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xd9687a, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    blossomB: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xe8c05a, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    blossomC: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x9f86d8, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),
    soil: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x3a2b20, roughness: 1.0, metalness: 0.0, envMapIntensity: 0.2,
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      return m;
    })(),

    // ---- water: one shared surface, the normal map scrolls in the level
    // update so every basin ripples together.
    water: (() => {
      const size = 256;
      const h = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = (x / size) * Math.PI * 2;
          const v = (y / size) * Math.PI * 2;
          const a = Math.sin(u * 3 + Math.sin(v * 2) * 1.4);
          const b = Math.sin(v * 4.5 - u * 1.6);
          const c = Math.sin((u + v) * 7.5) * 0.35;
          h[y * size + x] = 128 + (a * 46 + b * 34 + c * 22);
        }
      }
      const nrm = tex(normalFromHeight(h, size, 1.5));
      nrm.repeat.set(3, 3);
      const m = new THREE.MeshStandardMaterial({
        color: 0x35666d, roughness: 0.06, metalness: 0.28,
        envMapIntensity: 2.2, transparent: true, opacity: 0.74,
        emissive: 0x0d2226, emissiveIntensity: 0.6,
        normalMap: nrm, normalScale: new THREE.Vector2(0.6, 0.6),
      });
      m.userData.noBullet = true; m.userData.noShadow = true;
      m.userData.scroll = { x: 0, y: 0 };
      return m;
    })(),

    // ---- windows / interiors
    windowGlass: new THREE.MeshStandardMaterial({
      color: 0x24333c, roughness: 0.18, metalness: 0.45, envMapIntensity: 1.3,
    }),
    windowLit: new THREE.MeshStandardMaterial({
      color: 0x241608, roughness: 0.55, metalness: 0.0,
      emissive: 0xffa45c, emissiveIntensity: 1.35, envMapIntensity: 0.2,
    }),
    windowLitDim: new THREE.MeshStandardMaterial({
      color: 0x1b120a, roughness: 0.6, metalness: 0.0,
      emissive: 0xe07834, emissiveIntensity: 0.55, envMapIntensity: 0.2,
    }),
    interior: new THREE.MeshStandardMaterial({
      color: 0x090a0b, roughness: 1, metalness: 0, envMapIntensity: 0.06, side: THREE.BackSide,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x18242c, roughness: 0.08, metalness: 0.35, envMapIntensity: 2.0,
      transparent: true, opacity: 0.9,
    }),
    glassBroken: new THREE.MeshStandardMaterial({
      color: 0x0d1418, roughness: 0.35, metalness: 0.2, envMapIntensity: 1.2,
      side: THREE.DoubleSide,
    }),

    // ---- street decals / litter (alpha-tested, merged into one draw call each)
    paint: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: paint.map, alphaMap: paint.alpha, transparent: false, alphaTest: 0.42,
        roughness: 0.95, metalness: 0.0, envMapIntensity: 0.18, color: 0x8b8474,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      m.map.anisotropy = maxAniso; m.alphaMap.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    skid: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: skid.map, transparent: true, depthWrite: false, roughness: 0.82, metalness: 0.0,
        color: 0x0b0b0c, opacity: 0.68, envMapIntensity: 0.2,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    paper: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: paper.map, alphaTest: 0.5, roughness: 0.95, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.4, color: 0xc9c2ae,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    weed: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: weed.map, alphaTest: 0.45, roughness: 0.96, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.35, color: 0x8d8a68,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    /* Hillside grass: a vertical blade plane points away from a low sun,
       so a plain standard material turns the tufts black at dusk. The
       emissive lift keeps them readable without washing them out. */
    grassTuft: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: weed.map, alphaTest: 0.45, roughness: 0.97, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.3, color: 0xa9a47c,
        emissive: 0x3b3a24, emissiveIntensity: 1.0,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    graffiti: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: graffiti.map, transparent: true, depthWrite: false, roughness: 0.85, metalness: 0.0,
        opacity: 0.92, envMapIntensity: 0.3, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    puddle: (() => {
      const m = new THREE.MeshStandardMaterial({
        color: 0x0a0f12, roughness: 0.22, metalness: 0.18, envMapIntensity: 0.55,
        transparent: true, opacity: 0.85,
      });
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    grime: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: grime.map, color: 0x2a241d, transparent: true, depthWrite: false,
        roughness: 1.0, metalness: 0.0, opacity: 0.72, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    frond: (() => {
      const m = new THREE.MeshStandardMaterial({
        map: frond.map, alphaTest: 0.42, roughness: 0.9, metalness: 0.0,
        side: THREE.DoubleSide, envMapIntensity: 0.3, color: 0xaba676,
        emissive: 0x1c1b10, emissiveIntensity: 0.6,
      });
      m.map.anisotropy = maxAniso;
      m.userData.noShadow = true; m.userData.noBullet = true;
      return m;
    })(),
    patch: new THREE.MeshStandardMaterial({ color: 0x24231f, roughness: 0.97, metalness: 0.02, envMapIntensity: 0.15 }),

    // ---- weapon materials (touched by viewmodel/enemy)
    gunMetal: new THREE.MeshStandardMaterial({
      color: 0x2b2d30, roughness: 0.34, metalness: 0.92, envMapIntensity: 1.25,
    }),
    gunMetalWorn: new THREE.MeshStandardMaterial({
      color: 0x3a3d40, roughness: 0.46, metalness: 0.88, envMapIntensity: 1.1,
    }),
    polymer: new THREE.MeshStandardMaterial({
      color: 0x1e2022, roughness: 0.72, metalness: 0.08, envMapIntensity: 0.6,
    }),
    polymerTan: new THREE.MeshStandardMaterial({
      color: 0x6d5a3c, roughness: 0.74, metalness: 0.05, envMapIntensity: 0.55,
    }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.95, metalness: 0.0 }),
    lens: new THREE.MeshPhysicalMaterial({
      color: 0x0a1418, roughness: 0.05, metalness: 0.1, transmission: 0.25,
      transparent: true, opacity: 0.9, envMapIntensity: 2.4, clearcoat: 1, clearcoatRoughness: 0.03,
    }),
    reticleDot: new THREE.MeshBasicMaterial({ color: 0xff3322, toneMapped: false }),
    glove: new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.82, metalness: 0.02 }),
    gloveTan: new THREE.MeshStandardMaterial({ color: 0x6b5a42, roughness: 0.85, metalness: 0.02 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x4a4a3c, roughness: 0.94, metalness: 0 }),
    // enemies
    uniform: new THREE.MeshStandardMaterial({ color: 0x4b4a3a, roughness: 0.93, metalness: 0.02 }),
    uniformDark: new THREE.MeshStandardMaterial({ color: 0x35362d, roughness: 0.95, metalness: 0.02 }),
    vest: new THREE.MeshStandardMaterial({ color: 0x3b3a2e, roughness: 0.88, metalness: 0.05 }),
    helmetMat: new THREE.MeshStandardMaterial({ color: 0x3f4034, roughness: 0.82, metalness: 0.12 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x6d5140, roughness: 0.72, metalness: 0 }),
    goggle: new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.25, metalness: 0.6, envMapIntensity: 1.4 }),
  };

  // shadow / bullet policy flags (surfaces only, decals excluded)
  lib.asphalt.castShadow = false;
  lib.windowGlass.userData.noShadow = true;
  lib.windowLit.userData.noShadow = true;
  lib.windowLitDim.userData.noShadow = true;
  lib.interior.userData.noShadow = true;
  lib.interior.userData.noBullet = true;
  lib.glass.userData.noShadow = true;
  lib.glassBroken.userData.noShadow = true;
  lib.dirt.userData.noShadow = true;

  // sprite textures
  lib.sprites = {
    smoke: tex(smokeSprite(), { srgb: true }),
    flash: tex(flashSprite(), { srgb: true }),
    hole: tex(holeSprite(), { srgb: true }),
    blood: tex(bloodSprite(), { srgb: true }),
    laser: tex(laserSprite(), { srgb: true }),
    spark: tex(radialSprite(64, [[0, 'rgba(255,255,235,1)'], [0.35, 'rgba(255,200,90,.9)'], [1, 'rgba(255,110,20,0)']]), { srgb: true }),
    glow: tex(radialSprite(128, [[0, 'rgba(255,255,255,.9)'], [0.45, 'rgba(255,255,255,.25)'], [1, 'rgba(255,255,255,0)']]), { srgb: true }),
  };
  // sprites must clamp
  for (const k in lib.sprites) {
    const t = lib.sprites[k];
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
  }
  return lib;
}
