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

/* ---------------------------------------------------------------- assembly */
export function makeGunMaterials(envTexture, aniso = 8) {
  const oxide = blackOxideSet();
  const poly = polymerSet([44, 44, 47], 551, 1.0);
  const polyTan = polymerSet([116, 98, 68], 552, 1.1);
  const leather = leatherSet([34, 34, 30], 661);
  const fabric = fabricSet([40, 42, 37], 771, false);
  const webbing = webbingSet([40, 42, 35], 881);

  const std = (o) => {
    const m = new THREE.MeshStandardMaterial(o);
    m.envMapIntensity = o.envMapIntensity ?? 1.2;
    return m;
  };

  const receiver = std({
    color: 0xffffff, map: oxide.map, normalMap: oxide.normalMap,
    roughnessMap: oxide.roughnessMap, roughness: 1.0, metalness: 0.82,
    normalScale: new THREE.Vector2(0.65, 0.65), envMapIntensity: 1.4,
  });
  const receiverMatte = std({
    color: 0x27292c, map: oxide.map, normalMap: oxide.normalMap,
    roughnessMap: oxide.roughnessMap, roughness: 1.0, metalness: 0.04,
    normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 0.22,
  });
  // bare metal at the high-wear edges — slightly lighter, less rough
  const wornSteel = std({
    color: 0x8f959b, metalness: 0.95, roughness: 0.56, envMapIntensity: 1.2,
    normalMap: oxide.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
  });
  const railWear = std({
    color: 0x7d838a, metalness: 0.92, roughness: 0.55, envMapIntensity: 1.25,
    normalMap: oxide.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
  });
  const barrelSteel = std({
    color: 0x2c3034, metalness: 0.86, roughness: 0.62, envMapIntensity: 0.9,
    normalMap: oxide.normalMap, roughnessMap: oxide.roughnessMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });
  const blackSteel = std({
    color: 0x25272a, metalness: 0.92, roughness: 0.42, envMapIntensity: 1.4,
  });

  const polymer = std({
    color: 0xffffff, map: poly.map, normalMap: poly.normalMap,
    roughness: 0.76, metalness: 0.08, normalScale: new THREE.Vector2(0.8, 0.8),
    envMapIntensity: 0.75,
  });
  const polymerTan = std({
    color: 0xffffff, map: polyTan.map, normalMap: polyTan.normalMap,
    roughness: 0.8, metalness: 0.05, normalScale: new THREE.Vector2(0.7, 0.7),
    envMapIntensity: 0.55,
  });
  const rubber = std({
    color: 0x141517, roughness: 0.94, metalness: 0.02, envMapIntensity: 0.4,
    normalMap: poly.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
  });
  // unified stock / grip polymer: dark, stippled, with normal + roughness break-up
  const stockPoly = std({
    color: 0xcfcfcf, map: poly.map, normalMap: poly.normalMap, roughnessMap: poly.roughnessMap,
    roughness: 1.0, metalness: 0.04, normalScale: new THREE.Vector2(1.1, 1.1),
    envMapIntensity: 0.45,
  });
  // optic housing: matte, light-swallowing anodising (kills the white top face)
  const hoodMatte = std({
    color: 0x1b1d20, metalness: 0.28, roughness: 0.92,
    normalMap: oxide.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 0.35,
  });

  const glove = std({
    color: 0x2a2924, normalMap: leather.normalMap,
    roughness: 0.95, metalness: 0.0, normalScale: new THREE.Vector2(1.3, 1.3),
    envMapIntensity: 0.12,
  });
  const glovePad = std({
    color: 0x1f2124, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.5,
    normalMap: poly.normalMap, normalScale: new THREE.Vector2(0.5, 0.5),
  });
  // darker finger segments + thumb tips read as separate digits
  const gloveDark = std({
    color: 0x1e1d19, normalMap: leather.normalMap,
    roughness: 0.96, metalness: 0.0, normalScale: new THREE.Vector2(1.3, 1.3),
    envMapIntensity: 0.1,
  });
  // elastic cuff: warmer + lighter than the glove so the wrist reads clearly
  const cuff = std({
    color: 0x1c1b17, roughness: 0.96, metalness: 0.0,
    normalMap: fabric.normalMap, normalScale: new THREE.Vector2(1.4, 1.4),
    envMapIntensity: 0.15,
  });
  const sleeve = std({
    color: 0xffffff, map: fabric.map, normalMap: fabric.normalMap,
    roughness: 0.93, metalness: 0.0, normalScale: new THREE.Vector2(1.1, 1.1),
    envMapIntensity: 0.4,
  });
  const sling = std({
    color: 0xffffff, map: webbing.map, normalMap: webbing.normalMap,
    roughness: 0.9, metalness: 0.02, normalScale: new THREE.Vector2(0.8, 0.8),
    envMapIntensity: 0.45,
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
    // convenience for setWeapon()
    furnitureFor(variant) {
      return variant === 'tan' ? polymerTan : polymer;
    },
  };
}
