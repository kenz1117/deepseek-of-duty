import * as THREE from 'three';
import { mulberry32 } from '../core/materials.js';

/* =========================================================================
   Procedural weapon material library.

   Everything is painted on <canvas> at boot: black-oxide phosphate coating
   with machining grain + bare-aluminium scratches, stippled polymer, worn
   leather gloves, ripstop sleeve fabric and nylon webbing. No external maps.
   ========================================================================= */

const TS = 256;

function cnv(size = TS) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function makeTex(c, { srgb = false, repeat = 1, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

function normalFromHeight(h, size, strength = 2.0) {
  const c = cnv(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
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

function grayCanvas(vals, size) {
  const c = cnv(size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, vals[i]));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const frac = (x) => x - Math.floor(x);
const hash2 = (x, y) => frac(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/* --------------------------------------------------------------- black oxide */
/* parkerised / anodised receiver: near-black, machining bands, bare metal digs */
function blackOxideSet() {
  const size = TS, rnd = mulberry32(90210);
  const alb = cnv(size), actx = alb.getContext('2d', { willReadFrequently: true });
  const img = actx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const grain = hash2(x * 0.71, y * 0.93);
      const band = Math.sin(v * Math.PI * 2 * 42 + Math.sin(u * 8.0) * 0.9) * 0.5 + 0.5;
      const mottle = Math.sin(u * 11.3 + 1.7) * Math.sin(v * 7.9) * 0.5 + 0.5;
      let val = 0.175 + grain * 0.032 + band * 0.022 + mottle * 0.018;
      const i = (y * size + x) * 4;
      const c = Math.round(val * 255);
      d[i] = c * 0.93; d[i + 1] = c * 0.97; d[i + 2] = c * 1.02;
      d[i + 3] = 255;
      h[y * size + x] = 150 + grain * 26 + band * 12;
    }
  }
  actx.putImageData(img, 0, 0);

  // bare-aluminium digs on hard edges (thumb safety, magwell lip, port hinge)
  for (let k = 0; k < 210; k++) {
    const x = rnd() * size, y = rnd() * size;
    const len = 1.5 + rnd() * 22;
    const ang = (rnd() > 0.55 ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.6;
    const a = 0.05 + rnd() * 0.28;
    actx.strokeStyle = `rgba(${168 + rnd() * 55},${172 + rnd() * 52},${176 + rnd() * 48},${a})`;
    actx.lineWidth = 0.5 + rnd() * 1.0;
    actx.beginPath();
    actx.moveTo(x, y);
    actx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    actx.stroke();
  }
  // carbon fouling blotches
  for (let k = 0; k < 18; k++) {
    const x = rnd() * size, y = rnd() * size, r = 6 + rnd() * 34;
    const g = actx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${0.10 + rnd() * 0.16})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    actx.fillStyle = g;
    actx.beginPath(); actx.arc(x, y, r, 0, 7); actx.fill();
  }
  const fin = actx.getImageData(0, 0, size, size).data;
  const rough = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.35 + fin[i * 4 + 1] * 0.45 + fin[i * 4 + 2] * 0.2;
    h[i] = Math.min(255, lum * 1.9);
    rough[i] = 126 + (255 - lum) * 0.36;
  }
  return {
    map: makeTex(alb, { srgb: true, repeat: 2 }),
    normalMap: makeTex(normalFromHeight(h, size, 1.25)),
    roughnessMap: makeTex(grayCanvas(rough, size)),
  };
}

/* ------------------------------------------------------------------ polymer */
function polymerSet(base, seed, stipple = 1) {
  const size = TS, rnd = mulberry32(seed);
  const alb = cnv(size), actx = alb.getContext('2d', { willReadFrequently: true });
  const img = actx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  const pitch = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / pitch), gy = Math.floor(y / pitch);
      const cx = gx * pitch + 2 + hash2(gx, gy) * 4;
      const cy = gy * pitch + 2 + hash2(gy + 17, gx + 3) * 4;
      const dist = Math.hypot(x - cx, y - cy);
      const bump = Math.max(0, 1 - dist / (2.1 + stipple * 0.4));
      const grain = hash2(x * 1.31, y * 1.77);
      const v = 0.80 + grain * 0.10 - bump * 0.10;
      const i = (y * size + x) * 4;
      d[i] = base[0] * v;
      d[i + 1] = base[1] * v;
      d[i + 2] = base[2] * v;
      d[i + 3] = 255;
      h[y * size + x] = 120 + bump * 95 + grain * 10;
    }
  }
  actx.putImageData(img, 0, 0);
  // scuffs
  for (let k = 0; k < 60; k++) {
    const x = rnd() * size, y = rnd() * size, len = 3 + rnd() * 20, ang = rnd() * 6.28;
    actx.strokeStyle = `rgba(${base[0] + 42},${base[1] + 40},${base[2] + 34},${0.05 + rnd() * 0.14})`;
    actx.lineWidth = 0.6 + rnd() * 1.1;
    actx.beginPath(); actx.moveTo(x, y); actx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); actx.stroke();
  }
  const rough = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / pitch), gy = Math.floor(y / pitch);
      const cx = gx * pitch + 2 + hash2(gx, gy) * 4;
      const cy = gy * pitch + 2 + hash2(gy + 17, gx + 3) * 4;
      const bump = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / (2.1 + stipple * 0.4));
      rough[y * size + x] = 196 + bump * 38 + hash2(x * 1.31, y * 1.77) * 20;
    }
  }
  return {
    map: makeTex(alb, { srgb: true, repeat: 3 }),
    normalMap: makeTex(normalFromHeight(h, size, 2.4)),
    roughnessMap: makeTex(grayCanvas(rough, size)),
  };
}

/* ------------------------------------------------------------------- leather */
function leatherSet(base, seed) {
  const size = TS, rnd = mulberry32(seed);
  const alb = cnv(size), actx = alb.getContext('2d', { willReadFrequently: true });
  actx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  actx.fillRect(0, 0, size, size);
  const img = actx.getImageData(0, 0, size, size), d = img.data;
  const h = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const g = hash2(x * 0.83, y * 1.07);
      const v = 0.80 + g * 0.30;
      d[i] *= v; d[i + 1] *= v; d[i + 2] *= v;
      h[y * size + x] = 100 + g * 70;
    }
  }
  actx.putImageData(img, 0, 0);
  // creases / grain wrinkles
  for (let k = 0; k < 130; k++) {
    let x = rnd() * size, y = rnd() * size;
    let ang = rnd() * 6.28;
    actx.strokeStyle = `rgba(12,10,7,${0.08 + rnd() * 0.22})`;
    actx.lineWidth = 0.6 + rnd() * 1.4;
    actx.beginPath(); actx.moveTo(x, y);
    const seg = 3 + (rnd() * 5 | 0);
    for (let s = 0; s < seg; s++) {
      ang += (rnd() - 0.5) * 1.1;
      x += Math.cos(ang) * (2 + rnd() * 6);
      y += Math.sin(ang) * (2 + rnd() * 6);
      actx.lineTo(x, y);
    }
    actx.stroke();
  }
  // raised scuff highlights
  for (let k = 0; k < 70; k++) {
    const x = rnd() * size, y = rnd() * size, r = 0.8 + rnd() * 3;
    actx.fillStyle = `rgba(${base[0] + 40},${base[1] + 36},${base[2] + 26},${0.05 + rnd() * 0.16})`;
    actx.beginPath(); actx.arc(x, y, r, 0, 7); actx.fill();
  }
  const fin = actx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const lum = fin[i * 4] * 0.4 + fin[i * 4 + 1] * 0.4 + fin[i * 4 + 2] * 0.2;
    h[i] = 80 + lum * 0.5;
  }
  return {
    map: makeTex(alb, { srgb: true, repeat: 2 }),
    normalMap: makeTex(normalFromHeight(h, size, 1.9)),
  };
}

/* --------------------------------------------------------------- sleeve cloth */
function fabricSet(base, seed, ripstop = true) {
  const size = TS, rnd = mulberry32(seed);
  const alb = cnv(size), actx = alb.getContext('2d', { willReadFrequently: true });
  const img = actx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = (Math.sin(x * 2.3) * 0.5 + 0.5) * (Math.sin(y * 2.3) * 0.5 + 0.5);
      const grain = hash2(x * 1.7, y * 1.3);
      const grid = ripstop && ((x % 16) < 1.4 || (y % 16) < 1.4) ? -0.10 : 0;
      const v = 0.80 + weave * 0.16 + grain * 0.12 + grid;
      const i = (y * size + x) * 4;
      d[i] = base[0] * v; d[i + 1] = base[1] * v; d[i + 2] = base[2] * v; d[i + 3] = 255;
      h[y * size + x] = 110 + weave * 60 + grain * 25 + (grid ? -45 : 0);
    }
  }
  actx.putImageData(img, 0, 0);
  // dust / mud
  for (let k = 0; k < 26; k++) {
    const x = rnd() * size, y = rnd() * size, r = 8 + rnd() * 42;
    const g = actx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(84,70,48,${0.04 + rnd() * 0.12})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    actx.fillStyle = g; actx.beginPath(); actx.arc(x, y, r, 0, 7); actx.fill();
  }
  return {
    map: makeTex(alb, { srgb: true, repeat: 2 }),
    normalMap: makeTex(normalFromHeight(h, size, 1.3)),
  };
}

/* ------------------------------------------------------------- nylon webbing */
function webbingSet(base, seed) {
  const size = 128, rnd = mulberry32(seed);
  const alb = cnv(size), actx = alb.getContext('2d', { willReadFrequently: true });
  const img = actx.createImageData(size, size), d = img.data;
  const h = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = Math.sin(y * 1.4) * 0.5 + 0.5;
      const weft = Math.sin(x * 3.1) * 0.5 + 0.5;
      const v = 0.72 + warp * 0.2 + weft * 0.16 + hash2(x, y) * 0.06;
      const i = (y * size + x) * 4;
      d[i] = base[0] * v; d[i + 1] = base[1] * v; d[i + 2] = base[2] * v; d[i + 3] = 255;
      h[y * size + x] = 90 + warp * 80 + weft * 40;
    }
  }
  actx.putImageData(img, 0, 0);
  void rnd;
  return {
    map: makeTex(alb, { srgb: true, repeat: 3 }),
    normalMap: makeTex(normalFromHeight(h, size, 1.8)),
  };
}

/* --------------------------------------------------------------- holo reticle */
function reticleTexture() {
  const size = 256;
  const c = cnv(size), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;

  // outer 68-MOA ring drawn with a soft glow so bloom picks it up
  ctx.save();
  ctx.shadowColor = 'rgba(255,46,26,0.95)';
  ctx.shadowBlur = 10;
  ctx.strokeStyle = 'rgba(255,64,38,0.95)';
  ctx.lineWidth = size * 0.020;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.295, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // thin inner ring keeps the reticle readable when the outer ring blooms
  ctx.strokeStyle = 'rgba(255,120,80,0.38)';
  ctx.lineWidth = size * 0.006;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.252, 0, Math.PI * 2); ctx.stroke();

  // centre dot: hot core + red bloom
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.075);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,120,80,1)');
  g.addColorStop(0.42, 'rgba(255,34,18,0.85)');
  g.addColorStop(1, 'rgba(255,20,10,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.075, 0, 7); ctx.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------- stencil decal */
function stencilTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 256);
  ctx.fillStyle = 'rgba(216,212,196,0.62)';
  ctx.font = 'bold 62px "Courier New", monospace';
  ctx.fillText('M4A1', 26, 86);
  ctx.font = 'bold 30px "Courier New", monospace';
  ctx.fillText('CAL 5.56 MM', 28, 136);
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillStyle = 'rgba(210,206,190,0.45)';
  ctx.fillText('SN 66-102938', 28, 176);
  // stencilled wear: punch random chips out of the paint
  const rnd = mulberry32(5150);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.25 + rnd() * 0.6})`;
    ctx.fillRect(rnd() * 512, rnd() * 256, 1 + rnd() * 5, 1 + rnd() * 3);
  }
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}


/* ============================================================ 1k PBR atlas
   One 1024² albedo + normal + roughness atlas, 2×2 tiles:
     (0,0) black-oxide / phosphate steel   (512,0) stippled polymer
     (0,512) leather glove                 (512,512) ripstop fabric / webbing
   Each material samples its tile through map.offset/repeat, so the existing
   box/cylinder UVs (0..1 per face) keep working with no re-UV.
   ======================================================================== */
const ATLAS_SIZE = 1024;
const ATLAS_TILE = 512;

function atlasGrayRead(canvas, size) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) out[i] = d[i * 4];
  return out;
}

function buildWeaponAtlas(aniso = 8) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const S = ATLAS_SIZE, T = ATLAS_TILE;
  const albedoCan = cnv(S);
  const actx = albedoCan.getContext('2d', { willReadFrequently: true });
  const roughCan = cnv(S);
  const rctx = roughCan.getContext('2d', { willReadFrequently: true });
  const height = new Uint8Array(S * S);

  const copyHeight = (src, ox, oy) => {
    for (let y = 0; y < T; y++) {
      height.set(src.subarray(y * T, (y + 1) * T), (oy + y) * S + ox);
    }
  };
  const putTile = (ox, oy, ac, rc, hc) => {
    actx.drawImage(ac, ox, oy);
    rctx.drawImage(rc, ox, oy);
    copyHeight(atlasGrayRead(hc, T), ox, oy);
  };

  /* ---------------------------------------------------------- oxide tile */
  {
    const ac = cnv(T), ca = ac.getContext('2d', { willReadFrequently: true });
    const hc = cnv(T), ch = hc.getContext('2d', { willReadFrequently: true });
    const rc = cnv(T), cr = rc.getContext('2d', { willReadFrequently: true });
    const rnd = mulberry32(90210);
    ch.fillStyle = '#808080'; ch.fillRect(0, 0, T, T);
    cr.fillStyle = 'rgb(152,152,152)'; cr.fillRect(0, 0, T, T);
    const img = ca.createImageData(T, T), d = img.data;
    const himg = ch.getImageData(0, 0, T, T), hd = himg.data;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const i = (y * T + x) * 4;
        const grain = rnd();
        const band = Math.sin(y * 0.42 + Math.sin(x * 0.021) * 1.1);
        const v = 0.80 + grain * 0.27;
        d[i] = 43 * v; d[i + 1] = 46 * v; d[i + 2] = 51 * v; d[i + 3] = 255;
        const hv = 128 + (grain - 0.5) * 42 + band * 7;
        hd[i] = hd[i + 1] = hd[i + 2] = hv; hd[i + 3] = 255;
      }
    }
    ca.putImageData(img, 0, 0); ch.putImageData(himg, 0, 0);
    // machining bands
    for (let k = 0; k < 40; k++) {
      const y = (k / 40) * T + rnd() * 3;
      ca.strokeStyle = `rgba(118,124,132,${0.035 + rnd() * 0.05})`;
      ca.lineWidth = 0.7 + rnd(); ca.beginPath(); ca.moveTo(0, y); ca.lineTo(T, y); ca.stroke();
      ch.strokeStyle = `rgba(196,196,196,${0.10 + rnd() * 0.12})`;
      ch.lineWidth = 1; ch.beginPath(); ch.moveTo(0, y); ch.lineTo(T, y); ch.stroke();
    }
    // fine scratches: bright alu edge, dark groove, glossier roughness
    for (let k = 0; k < 430; k++) {
      const x = rnd() * T, y = rnd() * T;
      const len = 3 + rnd() * 30;
      const ang = (rnd() > 0.62 ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.55;
      const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
      ca.strokeStyle = `rgba(${172 + rnd() * 52},${176 + rnd() * 48},${182 + rnd() * 44},${0.05 + rnd() * 0.22})`;
      ca.lineWidth = 0.4 + rnd() * 0.9;
      ca.beginPath(); ca.moveTo(x, y); ca.lineTo(x2, y2); ca.stroke();
      ch.strokeStyle = `rgba(46,46,46,${0.18 + rnd() * 0.3})`;
      ch.lineWidth = 0.5 + rnd();
      ch.beginPath(); ch.moveTo(x, y); ch.lineTo(x2, y2); ch.stroke();
      cr.strokeStyle = `rgba(104,104,104,${0.12 + rnd() * 0.25})`;
      cr.lineWidth = 0.6 + rnd();
      cr.beginPath(); cr.moveTo(x, y); cr.lineTo(x2, y2); cr.stroke();
    }
    // edge chips / worn bevels
    for (let k = 0; k < 54; k++) {
      const x = rnd() * T;
      const y = rnd() < 0.5 ? rnd() * 44 : T - rnd() * 44;
      const rr = 0.6 + rnd() * 3.4;
      ca.fillStyle = `rgba(190,195,202,${0.15 + rnd() * 0.35})`;
      ca.beginPath(); ca.arc(x, y, rr, 0, 7); ca.fill();
      ch.fillStyle = 'rgba(210,210,210,0.55)';
      ch.beginPath(); ch.arc(x, y, rr, 0, 7); ch.fill();
      cr.fillStyle = 'rgba(90,90,90,0.55)';
      cr.beginPath(); cr.arc(x, y, rr, 0, 7); cr.fill();
    }
    // oil / carbon grime along the lower edge (darker + glossier)
    for (let k = 0; k < 12; k++) {
      const x = rnd() * T, y = T * 0.62 + rnd() * T * 0.33;
      const w = 26 + rnd() * 90, h = 8 + rnd() * 30;
      const g = ca.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, `rgba(6,7,8,${0.12 + rnd() * 0.2})`);
      g.addColorStop(1, 'rgba(6,7,8,0)');
      ca.fillStyle = g;
      ca.beginPath(); ca.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, rnd() * 3, 0, 7); ca.fill();
      cr.fillStyle = `rgba(78,78,78,${0.12 + rnd() * 0.16})`;
      cr.beginPath(); cr.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, rnd() * 3, 0, 7); cr.fill();
    }
    // dust
    for (let k = 0; k < 420; k++) {
      ca.fillStyle = `rgba(162,152,132,${rnd() * 0.1})`;
      ca.fillRect(rnd() * T, rnd() * T, 1, 1);
    }
    putTile(0, 0, ac, rc, hc);
  }

  /* -------------------------------------------------------- polymer tile */
  {
    const ac = cnv(T), ca = ac.getContext('2d', { willReadFrequently: true });
    const hc = cnv(T), ch = hc.getContext('2d', { willReadFrequently: true });
    const rc = cnv(T), cr = rc.getContext('2d', { willReadFrequently: true });
    const rnd = mulberry32(55177);
    ch.fillStyle = '#808080'; ch.fillRect(0, 0, T, T);
    cr.fillStyle = 'rgb(198,198,198)'; cr.fillRect(0, 0, T, T);
    const img = ca.createImageData(T, T), d = img.data;
    const himg = ch.getImageData(0, 0, T, T), hd = himg.data;
    const pitch = 8;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const gx = (x / pitch) | 0, gy = (y / pitch) | 0;
        const cx = gx * pitch + 2 + hash2(gx, gy) * 4;
        const cy = gy * pitch + 2 + hash2(gy + 17, gx + 3) * 4;
        const bump = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / 2.35);
        const grain = rnd();
        const i = (y * T + x) * 4;
        const v = 0.86 + grain * 0.12 + bump * 0.05;
        d[i] = 59 * v; d[i + 1] = 60 * v; d[i + 2] = 64 * v; d[i + 3] = 255;
        const hv = 118 + bump * 96 + grain * 14;
        hd[i] = hd[i + 1] = hd[i + 2] = hv; hd[i + 3] = 255;
      }
    }
    ca.putImageData(img, 0, 0); ch.putImageData(himg, 0, 0);
    // anti-slip ribs along one edge
    for (let k = 0; k < 13; k++) {
      const y = T * 0.70 + k * 11;
      ca.strokeStyle = `rgba(${88 + rnd() * 16},${90 + rnd() * 16},${95 + rnd() * 16},0.45)`;
      ca.lineWidth = 3.2; ca.beginPath(); ca.moveTo(0, y); ca.lineTo(T, y); ca.stroke();
      ca.strokeStyle = 'rgba(14,15,17,0.55)';
      ca.lineWidth = 1.2; ca.beginPath(); ca.moveTo(0, y + 2.4); ca.lineTo(T, y + 2.4); ca.stroke();
      ch.strokeStyle = 'rgba(205,205,205,0.8)';
      ch.lineWidth = 3.4; ch.beginPath(); ch.moveTo(0, y); ch.lineTo(T, y); ch.stroke();
      cr.strokeStyle = 'rgba(232,232,232,0.8)';
      cr.lineWidth = 3.4; cr.beginPath(); cr.moveTo(0, y); cr.lineTo(T, y); cr.stroke();
    }
    // scuffs
    for (let k = 0; k < 90; k++) {
      const x = rnd() * T, y = rnd() * T, len = 2 + rnd() * 20, ang = rnd() * 6.28;
      ca.strokeStyle = `rgba(${110 + rnd() * 30},${112 + rnd() * 30},${118 + rnd() * 30},${0.06 + rnd() * 0.16})`;
      ca.lineWidth = 0.5 + rnd() * 1.2;
      ca.beginPath(); ca.moveTo(x, y); ca.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ca.stroke();
      cr.strokeStyle = `rgba(150,150,150,${0.1 + rnd() * 0.2})`;
      cr.lineWidth = 0.6 + rnd();
      cr.beginPath(); cr.moveTo(x, y); cr.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); cr.stroke();
    }
    // oil smears
    for (let k = 0; k < 8; k++) {
      const x = rnd() * T, y = rnd() * T;
      const w = 40 + rnd() * 100, h = 14 + rnd() * 40;
      const g = ca.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, `rgba(8,9,10,${0.14 + rnd() * 0.16})`);
      g.addColorStop(1, 'rgba(8,9,10,0)');
      ca.fillStyle = g;
      ca.beginPath(); ca.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, rnd() * 3, 0, 7); ca.fill();
      cr.fillStyle = `rgba(96,96,96,${0.12 + rnd() * 0.18})`;
      cr.beginPath(); cr.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, rnd() * 3, 0, 7); cr.fill();
    }
    putTile(T, 0, ac, rc, hc);
  }

  /* -------------------------------------------------------- leather tile */
  {
    const ac = cnv(T), ca = ac.getContext('2d', { willReadFrequently: true });
    const hc = cnv(T), ch = hc.getContext('2d', { willReadFrequently: true });
    const rc = cnv(T), cr = rc.getContext('2d', { willReadFrequently: true });
    const rnd = mulberry32(66101);
    ch.fillStyle = '#808080'; ch.fillRect(0, 0, T, T);
    cr.fillStyle = 'rgb(206,206,206)'; cr.fillRect(0, 0, T, T);
    const img = ca.createImageData(T, T), d = img.data;
    const himg = ch.getImageData(0, 0, T, T), hd = himg.data;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const i = (y * T + x) * 4;
        const grain = rnd();
        const v = 0.80 + grain * 0.34;
        d[i] = 72 * v; d[i + 1] = 67 * v; d[i + 2] = 54 * v; d[i + 3] = 255;
        const hv = 118 + grain * 52;
        hd[i] = hd[i + 1] = hd[i + 2] = hv; hd[i + 3] = 255;
      }
    }
    ca.putImageData(img, 0, 0); ch.putImageData(himg, 0, 0);
    // grain creases
    for (let k = 0; k < 150; k++) {
      let x = rnd() * T, y = rnd() * T, ang = rnd() * 6.28;
      ca.strokeStyle = `rgba(24,20,14,${0.16 + rnd() * 0.3})`;
      ca.lineWidth = 0.6 + rnd() * 1.3;
      ca.beginPath(); ca.moveTo(x, y);
      const seg = 3 + (rnd() * 5 | 0);
      for (let q = 0; q < seg; q++) {
        ang += (rnd() - 0.5) * 1.1;
        x += Math.cos(ang) * (2 + rnd() * 6);
        y += Math.sin(ang) * (2 + rnd() * 6);
        ca.lineTo(x, y);
        ch.strokeStyle = `rgba(44,44,44,${0.2 + rnd() * 0.3})`;
        ch.lineWidth = 0.8 + rnd();
        ch.beginPath(); ch.moveTo(x - 2, y - 2); ch.lineTo(x, y); ch.stroke();
      }
      ca.stroke();
    }
    // knuckle / contact wear (lighter, rougher)
    for (let k = 0; k < 7; k++) {
      const x = rnd() * T, y = rnd() * T, w = 30 + rnd() * 70, h = 18 + rnd() * 44;
      const g = ca.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.6);
      g.addColorStop(0, `rgba(120,108,86,${0.14 + rnd() * 0.16})`);
      g.addColorStop(1, 'rgba(120,108,86,0)');
      ca.fillStyle = g;
      ca.beginPath(); ca.ellipse(x, y, w / 2, h / 2, rnd() * 3, 0, 7); ca.fill();
      cr.fillStyle = `rgba(168,168,168,${0.12 + rnd() * 0.16})`;
      cr.beginPath(); cr.ellipse(x, y, w / 2, h / 2, rnd() * 3, 0, 7); cr.fill();
    }
    // stitching: two parallel dashed seams
    const stitch = (x0, y0, x1, y1) => {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 11);
      for (let q = 0; q <= n; q++) {
        const t = q / n;
        const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        ca.strokeStyle = 'rgba(196,180,146,0.9)';
        ca.lineWidth = 2.4; ca.beginPath();
        ca.moveTo(x - ux * 4, y - uy * 4); ca.lineTo(x + ux * 4, y + uy * 4); ca.stroke();
        ca.strokeStyle = 'rgba(20,16,12,0.5)';
        ca.lineWidth = 1; ca.beginPath();
        ca.moveTo(x - ux * 4 + 1.6, y - uy * 4 + 1.6); ca.lineTo(x + ux * 4 + 1.6, y + uy * 4 + 1.6); ca.stroke();
        ch.strokeStyle = 'rgba(220,220,220,0.85)';
        ch.lineWidth = 2.4; ch.beginPath();
        ch.moveTo(x - ux * 4, y - uy * 4); ch.lineTo(x + ux * 4, y + uy * 4); ch.stroke();
        cr.strokeStyle = 'rgba(232,232,232,0.6)';
        cr.lineWidth = 2.4; cr.beginPath();
        cr.moveTo(x - ux * 4, y - uy * 4); cr.lineTo(x + ux * 4, y + uy * 4); cr.stroke();
      }
    };
    stitch(70, 30, 70, 482);
    stitch(88, 30, 88, 482);
    stitch(112, 448, 456, 448);
    stitch(120, 120, 120, 400);
    stitch(132, 120, 132, 400);
    // dirt
    for (let k = 0; k < 24; k++) {
      const x = rnd() * T, y = rnd() * T, r = 8 + rnd() * 44;
      const g = ca.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(26,21,14,${0.08 + rnd() * 0.12})`);
      g.addColorStop(1, 'rgba(26,21,14,0)');
      ca.fillStyle = g; ca.beginPath(); ca.arc(x, y, r, 0, 7); ca.fill();
    }
    putTile(0, T, ac, rc, hc);
  }

  /* --------------------------------------------------------- fabric tile */
  {
    const ac = cnv(T), ca = ac.getContext('2d', { willReadFrequently: true });
    const hc = cnv(T), ch = hc.getContext('2d', { willReadFrequently: true });
    const rc = cnv(T), cr = rc.getContext('2d', { willReadFrequently: true });
    const rnd = mulberry32(77123);
    ch.fillStyle = '#808080'; ch.fillRect(0, 0, T, T);
    cr.fillStyle = 'rgb(232,232,232)'; cr.fillRect(0, 0, T, T);
    const img = ca.createImageData(T, T), d = img.data;
    const himg = ch.getImageData(0, 0, T, T), hd = himg.data;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const weave = (Math.sin(x * 2.3) * 0.5 + 0.5) * (Math.sin(y * 2.3) * 0.5 + 0.5);
        const grain = rnd();
        const grid = ((x % 32) < 1.6 || (y % 32) < 1.6) ? -0.18 : 0;
        const i = (y * T + x) * 4;
        const v = 0.80 + weave * 0.16 + grain * 0.14 + grid;
        d[i] = 74 * v; d[i + 1] = 78 * v; d[i + 2] = 67 * v; d[i + 3] = 255;
        const hv = 112 + weave * 58 + grain * 28 + (grid ? -50 : 0);
        hd[i] = hd[i + 1] = hd[i + 2] = hv; hd[i + 3] = 255;
      }
    }
    ca.putImageData(img, 0, 0); ch.putImageData(himg, 0, 0);
    // fold creases
    for (let k = 0; k < 12; k++) {
      const x = rnd() * T, y = rnd() * T, ang = rnd() * 6.28;
      const len = 60 + rnd() * 160;
      const g = ca.createLinearGradient(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      g.addColorStop(0, `rgba(20,22,17,${0.10 + rnd() * 0.12})`);
      g.addColorStop(0.5, 'rgba(20,22,17,0.02)');
      g.addColorStop(1, 'rgba(20,22,17,0)');
      ca.strokeStyle = g; ca.lineWidth = 3 + rnd() * 7;
      ca.beginPath(); ca.moveTo(x, y); ca.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ca.stroke();
      ch.strokeStyle = `rgba(50,50,50,${0.25 + rnd() * 0.2})`;
      ch.lineWidth = 2 + rnd() * 4;
      ch.beginPath(); ch.moveTo(x, y); ch.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ch.stroke();
    }
    // elastic cuff ribs along the lower edge
    for (let k = 0; k < 11; k++) {
      const y = T * 0.72 + k * 10;
      ca.strokeStyle = 'rgba(116,116,96,0.6)';
      ca.lineWidth = 2.6; ca.beginPath(); ca.moveTo(0, y); ca.lineTo(T, y); ca.stroke();
      ca.strokeStyle = 'rgba(18,19,15,0.55)';
      ca.lineWidth = 1.2; ca.beginPath(); ca.moveTo(0, y + 2); ca.lineTo(T, y + 2); ca.stroke();
      ch.strokeStyle = 'rgba(210,210,210,0.85)';
      ch.lineWidth = 2.8; ch.beginPath(); ch.moveTo(0, y); ch.lineTo(T, y); ch.stroke();
      cr.strokeStyle = 'rgba(210,210,210,0.8)';
      cr.lineWidth = 2.8; cr.beginPath(); cr.moveTo(0, y); cr.lineTo(T, y); cr.stroke();
    }
    // dirt
    for (let k = 0; k < 26; k++) {
      const x = rnd() * T, y = rnd() * T, r = 10 + rnd() * 54;
      const g = ca.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(58,48,32,${0.05 + rnd() * 0.12})`);
      g.addColorStop(1, 'rgba(58,48,32,0)');
      ca.fillStyle = g; ca.beginPath(); ca.arc(x, y, r, 0, 7); ca.fill();
    }
    putTile(T, T, ac, rc, hc);
  }

  const normalCan = normalFromHeight(height, S, 1.7);
  const albedoTex = makeTex(albedoCan, { srgb: true, repeat: 1, aniso });
  const normalTex = makeTex(normalCan, { repeat: 1, aniso });
  const roughTex = makeTex(roughCan, { repeat: 1, aniso });
  for (const t of [albedoTex, normalTex, roughTex]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    albedo: albedoTex, normal: normalTex, roughness: roughTex,
    tiles: {
      oxide: [0, 0.5], polymer: [0.5, 0.5],
      leather: [0, 0], fabric: [0.5, 0],
    },
    size: S, ms,
  };
}

function atlasSub(tex, u, v) {
  const t = tex.clone();
  t.offset.set(u, v);
  t.repeat.set(0.5, 0.5);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function tileMaps(atlas, key) {
  const [u, v] = atlas.tiles[key];
  return {
    map: atlasSub(atlas.albedo, u, v),
    normalMap: atlasSub(atlas.normal, u, v),
    roughnessMap: atlasSub(atlas.roughness, u, v),
  };
}

/* ---------------------------------------------------------------- assembly */
export function makeGunMaterials(envTexture, aniso = 8) {
  const atlas = buildWeaponAtlas(aniso);
  const oxideMaps = tileMaps(atlas, 'oxide');
  const polyMaps = tileMaps(atlas, 'polymer');
  const leatherMaps = tileMaps(atlas, 'leather');
  const fabricMaps = tileMaps(atlas, 'fabric');

  const std = (o) => {
    const m = new THREE.MeshStandardMaterial(o);
    m.envMapIntensity = o.envMapIntensity ?? 1.2;
    return m;
  };

  const receiver = std({
    color: 0xffffff, map: oxideMaps.map, normalMap: oxideMaps.normalMap,
    roughnessMap: oxideMaps.roughnessMap, roughness: 1.0, metalness: 0.82,
    normalScale: new THREE.Vector2(0.95, 0.95), envMapIntensity: 1.35,
    emissive: 0x0b1118, emissiveIntensity: 0.5,
  });
  const receiverMatte = std({
    color: 0x2a2c2f, normalMap: oxideMaps.normalMap, roughnessMap: oxideMaps.roughnessMap,
    roughness: 1.0, metalness: 0.04, normalScale: new THREE.Vector2(0.55, 0.55),
    envMapIntensity: 0.22,
  });
  const wornSteel = std({
    color: 0x9aa0a6, metalness: 0.95, roughness: 1.0, envMapIntensity: 1.3,
    normalMap: oxideMaps.normalMap, roughnessMap: oxideMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
  });
  const railWear = std({
    color: 0x646b72, metalness: 0.92, roughness: 1.0, envMapIntensity: 1.1,
    normalMap: oxideMaps.normalMap, roughnessMap: oxideMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
  });
  const barrelSteel = std({
    color: 0x2c3034, metalness: 0.86, roughness: 1.0, envMapIntensity: 0.95,
    normalMap: oxideMaps.normalMap, roughnessMap: oxideMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  const blackSteel = std({
    color: 0x25272a, metalness: 0.92, roughness: 0.48, envMapIntensity: 1.3,
    normalMap: oxideMaps.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
  });

  const polymer = std({
    color: 0x8e98a2, map: polyMaps.map, normalMap: polyMaps.normalMap,
    roughnessMap: polyMaps.roughnessMap, roughness: 1.0, metalness: 0.08,
    normalScale: new THREE.Vector2(1.0, 1.0), envMapIntensity: 0.6,
    emissive: 0x0a1016, emissiveIntensity: 0.42,
  });
  const polymerTan = std({
    color: 0xffe2b4, map: polyMaps.map, normalMap: polyMaps.normalMap,
    roughnessMap: polyMaps.roughnessMap, roughness: 1.0, metalness: 0.05,
    normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 0.55,
  });
  const rubber = std({
    color: 0x141517, roughness: 1.0, metalness: 0.02, envMapIntensity: 0.35,
    normalMap: polyMaps.normalMap, roughnessMap: polyMaps.roughnessMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
  });
  const stockPoly = std({
    color: 0x8a949e, map: polyMaps.map, normalMap: polyMaps.normalMap,
    roughnessMap: polyMaps.roughnessMap, roughness: 1.0, metalness: 0.04,
    normalScale: new THREE.Vector2(1.15, 1.15), envMapIntensity: 0.45,
    emissive: 0x0a1016, emissiveIntensity: 0.42,
  });
  const hoodMatte = std({
    color: 0x1b1d20, metalness: 0.28, roughness: 0.92,
    normalMap: oxideMaps.normalMap, normalScale: new THREE.Vector2(0.4, 0.4),
    envMapIntensity: 0.35,
  });

  const glove = std({
    color: 0x70766e, map: leatherMaps.map, normalMap: leatherMaps.normalMap,
    roughnessMap: leatherMaps.roughnessMap, roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.5, 1.5), envMapIntensity: 0.25,
  });
  const gloveDark = std({
    color: 0x585e56, map: leatherMaps.map, normalMap: leatherMaps.normalMap,
    roughnessMap: leatherMaps.roughnessMap, roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.25, 1.25), envMapIntensity: 0.18,
  });
  const glovePad = std({
    color: 0x1a1c1f, roughness: 0.78, metalness: 0.05, envMapIntensity: 0.4,
    normalMap: leatherMaps.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
  });
  const cuff = std({
    color: 0x7a7662, map: fabricMaps.map, normalMap: fabricMaps.normalMap,
    roughnessMap: fabricMaps.roughnessMap, roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.35, 1.35), envMapIntensity: 0.22,
  });
  const sleeve = std({
    color: 0x929a90, map: fabricMaps.map, normalMap: fabricMaps.normalMap,
    roughnessMap: fabricMaps.roughnessMap, roughness: 1.0, metalness: 0.0,
    normalScale: new THREE.Vector2(1.25, 1.25), envMapIntensity: 0.3,
  });
  const sling = std({
    color: 0x8d9388, map: fabricMaps.map, normalMap: fabricMaps.normalMap,
    roughnessMap: fabricMaps.roughnessMap, roughness: 1.0, metalness: 0.02,
    normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 0.3,
  });

  // optic glass: thin smoked pane with a bright clearcoat sheen. Transmission
  // is kept low because the viewmodel is drawn in its own overlay pass.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0a1216,
    metalness: 0.0,
    roughness: 0.06,
    transmission: 0.0,           // overlay pass → keep the world behind visible
    ior: 1.46,
    transparent: true,
    opacity: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 2.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (envTexture) glass.envMap = envTexture;

  const stencil = new THREE.MeshStandardMaterial({
    map: stencilTexture(), transparent: true, opacity: 0.7,
    roughness: 0.9, metalness: 0.0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    envMapIntensity: 0.2,
  });

  const reticleMat = new THREE.MeshBasicMaterial({
    map: reticleTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    opacity: 0.95,
  });

  return {
    receiver, receiverMatte, wornSteel, railWear, barrelSteel, blackSteel,
    polymer, polymerTan, rubber, stockPoly, hoodMatte, glove, glovePad, gloveDark, cuff, sleeve, sling,
    glass, reticleMat, stencil,
    atlasMs: atlas.ms,
    atlasSize: atlas.size,
    atlasTiles: atlas.tiles,
    // convenience for setWeapon()
    furnitureFor(variant) {
      return variant === 'tan' ? polymerTan : polymer;
    },
  };
}
