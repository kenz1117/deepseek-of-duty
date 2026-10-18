import * as THREE from 'three';
import { createAtmosphere } from './atmosphere.js';

/* =========================================================================
   FX — AAA-flavoured combat effects, all pooled and batched.

   Systems (draw calls):
     - spark streaks ........ 1  (instanced velocity-stretched billboards)
     - additive softpool .... 1  (fire, flash, star bursts)
     - normal softpool ...... 1  (dust, smoke, blood mist)
     - tracers .............. 1  (instanced beam + bright core, 2 quads/inst)
     - bullet holes ......... 1  (instanced, per-instance tint)
     - metal scrapes ........ 1  (instanced additive)
     - blood decals ......... 1
     - shock rings .......... 4 meshes
     - shock shells ......... 2 meshes
     - debris ............... 1  (instanced, lit, tumbling)
     - atmosphere ........... 2  (motes + haze shell)
     - 2 point lights (no shadows)

   All sizes are real-world metres. Point sprites are converted with the real
   projection matrix, so nothing turns into a screen-filling "potato".
   ========================================================================= */

const MAX_SPARKS = 900;
const MAX_SOFT_ADD = 224;
const MAX_SOFT_NORM = 320;
const MAX_TRACERS = 30;
const MAX_HOLES = 180;
const MAX_BLOOD_DECALS = 48;
const MAX_SCRAPES = 48;
const MAX_RINGS = 4;
const MAX_SHELLS = 2;
const MAX_DEBRIS = 64;

const ATLAS = { PUFF: 0, STAR: 1, GLOW: 2, FIRE: 3 };

const rnd = (a, b) => a + Math.random() * (b - a);
const rndS = () => Math.random() * 2 - 1;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _axis = new THREE.Vector3();
const Z_UP = new THREE.Vector3(0, 1, 0);
const Z_FWD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

function getCamera() {
  try {
    const g = window.__game;
    return (g && g.engine && g.engine.camera) || null;
  } catch (e) {
    return null;
  }
}

/* ============================== ATLAS ============================== */
/** 2x2 sprite atlas: soft puff, star flash, radial glow, fire puff. */
function buildAtlas(mats) {
  const Q = 256, S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  const put = (idx, img) => {
    if (!img) return;
    const x = (idx % 2) * Q;
    const y = Math.floor(idx / 2) * Q;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, Q, Q);
    ctx.clip();
    ctx.drawImage(img, x, y, Q, Q);
    ctx.restore();
  };
  const sp = mats.sprites || {};
  put(ATLAS.PUFF, sp.smoke && sp.smoke.image);
  put(ATLAS.STAR, sp.flash && sp.flash.image);
  put(ATLAS.GLOW, sp.glow && sp.glow.image);
  put(ATLAS.FIRE, sp.smoke && sp.smoke.image);

  // hot, uneven core for the fire puff (idx 3 -> bottom-right quadrant)
  const ox = Q, oy = Q;
  const cx = ox + Q * 0.5, cy = oy + Q * 0.5;
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, Q * 0.33);
  g.addColorStop(0, 'rgba(255,250,235,0.98)');
  g.addColorStop(0.34, 'rgba(255,190,110,0.62)');
  g.addColorStop(1, 'rgba(255,110,30,0)');
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, Q, Q); ctx.clip();
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, Q * 0.33, 0, Math.PI * 2); ctx.fill();
  // tear holes so the fireball is not a perfect ball
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * Q * 0.26;
    const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    const rr = 6 + Math.random() * 18;
    const gg = ctx.createRadialGradient(px, py, 0, px, py, rr);
    gg.addColorStop(0, 'rgba(0,0,0,0.55)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(px, py, rr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/* ============================== GEOMETRY HELPERS ============================== */
function quadBase() {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** streak base: position.x = 0 (head) .. 1 (tail), position.y = -1/1 (sides) */
function streakBase(parts) {
  const g = new THREE.InstancedBufferGeometry();
  const n = parts * 4;
  const pos = new Float32Array(n * 3);
  const part = new Float32Array(n);
  const idx = [];
  const corners = [[0, 1], [0, -1], [1, 1], [1, -1]];
  for (let p = 0; p < parts; p++) {
    const o = p * 4;
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      pos[(o + i) * 3] = c[0];
      pos[(o + i) * 3 + 1] = c[1];
      pos[(o + i) * 3 + 2] = 0;
      part[o + i] = p;
    }
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/* ============================== FX ============================== */
export function createFX(scene, mats) {
  const group = new THREE.Group();
  group.name = 'fx';
  scene.add(group);

  const fog = scene.fog;
  const fogColor = fog ? fog.color : new THREE.Color(0x5d564b);
  const fogDensity = fog ? fog.density : 0.0092;

  const U = {
    res: { value: new THREE.Vector2(1600, 900) },
    fogColor: { value: fogColor.clone() },
    fogDensity: { value: fogDensity },
  };
  const atlas = buildAtlas(mats);

  /* ------------------------------------------------------------------ lights */
  const muzzleLight = new THREE.PointLight(0xffb173, 0, 14, 2);
  muzzleLight.castShadow = false;
  group.add(muzzleLight);
  const muzzleL = { light: muzzleLight, t: 0, dur: 0.06, peak: 16 };

  const boomLight = new THREE.PointLight(0xff8f45, 0, 30, 2);
  boomLight.castShadow = false;
  group.add(boomLight);
  const boomL = { light: boomLight, t: 0, dur: 0.34, peak: 120 };

  function flashLight(state, peak) {
    state.peak = peak;
    state.t = state.dur;
    state.light.intensity = peak;
  }

  /* ------------------------------------------------------------------ soft pools */
  // Additive points (fire, flash, stars): fade is baked into the per-particle
  // colour, so the shader can use a constant alpha and still bloom correctly.
  function createAddPool(max, tex, renderOrder) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const sz = new Float32Array(max);
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aColor = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
    const aSize = new THREE.BufferAttribute(sz, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aColor', aColor);
    geo.setAttribute('aSize', aSize);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uResolution: U.res,
        uFogDensity: U.fogDensity,
      },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        uniform vec2 uResolution;
        uniform float uFogDensity;
        varying vec3 vColor;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float depth = max(0.05, -mv.z);
          gl_PointSize = clamp(aSize * 0.5 * uResolution.y * projectionMatrix[1][1] / depth, 1.0, 720.0);
          float fog = 1.0 - exp(-pow(uFogDensity * depth, 2.0));
          vColor = aColor * (1.0 - fog * 0.9);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec3 vColor;
        void main(){
          vec4 t = texture2D(uMap, gl_PointCoord);
          float a = t.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * t.rgb, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    group.add(points);

    const vel = new Float32Array(max * 3);
    const base = new Float32Array(max * 3);
    const life = new Float32Array(max);
    const maxLife = new Float32Array(max);
    const size0 = new Float32Array(max);
    const size1 = new Float32Array(max);
    const fadeAmt = new Float32Array(max);
    const fadeIn = new Float32Array(max);
    const fadePow = new Float32Array(max);
    const drag = new Float32Array(max);
    const rise = new Float32Array(max);
    const grav = new Float32Array(max);
    let cursor = 0;

    function spawn(o) {
      const i = cursor;
      cursor = (cursor + 1) % max;
      const i3 = i * 3;
      pos[i3] = o.x; pos[i3 + 1] = o.y; pos[i3 + 2] = o.z;
      vel[i3] = o.vx || 0; vel[i3 + 1] = o.vy || 0; vel[i3 + 2] = o.vz || 0;
      life[i] = maxLife[i] = o.life;
      size0[i] = o.size;
      size1[i] = o.sizeEnd !== undefined ? o.sizeEnd : o.size;
      fadeAmt[i] = o.alpha !== undefined ? o.alpha : 0.8;
      fadeIn[i] = o.fadeIn !== undefined ? o.fadeIn : 0.08;
      fadePow[i] = o.fadePow !== undefined ? o.fadePow : 1.2;
      drag[i] = o.drag !== undefined ? o.drag : 0.8;
      rise[i] = o.rise !== undefined ? o.rise : 0;
      grav[i] = o.grav !== undefined ? o.grav : 0;
      _c.setHex(o.color !== undefined ? o.color : 0xffffff);
      const k = o.intensity !== undefined ? o.intensity : 1;
      base[i3] = _c.r * k; base[i3 + 1] = _c.g * k; base[i3 + 2] = _c.b * k;
      col[i3] = 0; col[i3 + 1] = 0; col[i3 + 2] = 0;
      sz[i] = o.size;
    }

    function update(dt) {
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) continue;
        const i3 = i * 3;
        life[i] -= dt;
        if (life[i] <= 0) {
          life[i] = 0;
          col[i3] = 0; col[i3 + 1] = 0; col[i3 + 2] = 0;
          sz[i] = 0;
          continue;
        }
        const t = 1 - life[i] / maxLife[i];
        const e = 1 - (1 - t) * (1 - t);
        sz[i] = size0[i] + (size1[i] - size0[i]) * e;
        const fin = fadeIn[i] > 0 ? Math.min(1, t / fadeIn[i]) : 1;
        const fade = fadeAmt[i] * fin * Math.pow(1 - t, fadePow[i]);
        col[i3] = base[i3] * fade;
        col[i3 + 1] = base[i3 + 1] * fade;
        col[i3 + 2] = base[i3 + 2] * fade;

        const damp = Math.max(0, 1 - drag[i] * dt);
        vel[i3] *= damp;
        vel[i3 + 1] = vel[i3 + 1] * damp + rise[i] * dt;
        vel[i3 + 2] *= damp;
        vel[i3 + 1] -= grav[i] * dt;
        pos[i3] += vel[i3] * dt;
        pos[i3 + 1] += vel[i3 + 1] * dt;
        pos[i3 + 2] += vel[i3 + 2] * dt;
        if (pos[i3 + 1] < 0.015 && grav[i] > 0) {
          pos[i3 + 1] = 0.015;
          vel[i3 + 1] *= -0.25;
          vel[i3] *= 0.6; vel[i3 + 2] *= 0.6;
        }
      }
      aPos.needsUpdate = true;
      aColor.needsUpdate = true;
      aSize.needsUpdate = true;
    }

    return { spawn, update };
  }

  // Smoke / dust / blood mist: real alpha-blended sprites with per-sprite opacity.
  const MAX_SMOKE = 72;
  const smokePool = [];
  for (let i = 0; i < MAX_SMOKE; i++) {
    const mat = new THREE.SpriteMaterial({
      map: mats.sprites.smoke, color: 0x8f887c, transparent: true,
      depthWrite: false, opacity: 0,
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.renderOrder = 5;
    group.add(s);
    smokePool.push({
      s, life: 0, maxLife: 1, size0: 0.1, size1: 0.4, op: 0.3,
      fadeIn: 0.12, fadePow: 1.3, drag: 1.4, rise: 0.3, grav: 0,
      vel: new THREE.Vector3(),
    });
  }
  let smokeCursor = 0;

  function normSpawn(o) {
    const p = smokePool[smokeCursor];
    smokeCursor = (smokeCursor + 1) % MAX_SMOKE;
    p.s.visible = true;
    p.s.position.set(o.x, o.y, o.z);
    p.vel.set(o.vx || 0, o.vy || 0, o.vz || 0);
    p.life = p.maxLife = o.life;
    p.size0 = o.size;
    p.size1 = o.sizeEnd !== undefined ? o.sizeEnd : o.size;
    p.op = o.alpha !== undefined ? o.alpha : 0.3;
    p.fadeIn = o.fadeIn !== undefined ? o.fadeIn : 0.12;
    p.fadePow = o.fadePow !== undefined ? o.fadePow : 1.3;
    p.drag = o.drag !== undefined ? o.drag : 1.4;
    p.rise = o.rise !== undefined ? o.rise : 0.3;
    p.grav = o.grav !== undefined ? o.grav : 0;
    p.s.material.color.setHex(o.color !== undefined ? o.color : 0x8f887c);
    p.s.material.rotation = o.rot !== undefined ? o.rot : Math.random() * 6.2832;
    p.spin = o.spin !== undefined ? o.spin : 0;
    p.s.material.opacity = 0;
    p.s.scale.setScalar(o.size);
  }

  function normUpdate(dt) {
    for (const p of smokePool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.life = 0;
        p.s.visible = false;
        continue;
      }
      const t = 1 - p.life / p.maxLife;
      const e = 1 - (1 - t) * (1 - t);
      const sz = p.size0 + (p.size1 - p.size0) * e;
      p.s.scale.setScalar(sz);
      p.s.material.opacity = p.op * Math.min(1, t / p.fadeIn) * Math.pow(1 - t, p.fadePow);
      p.s.material.rotation += (p.spin || 0) * dt;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vel.multiplyScalar(damp);
      p.vel.y += p.rise * dt - p.grav * dt * 0.02;
      p.s.position.addScaledVector(p.vel, dt);
      if (p.s.position.y < 0.02 && p.grav > 0) {
        p.s.position.y = 0.02;
        p.vel.y *= -0.25;
      }
    }
  }

  const addStar = createAddPool(40, mats.sprites.flash, 6);
  const addFire = createAddPool(MAX_SOFT_ADD, mats.sprites.smoke, 6);

  // facade used by the effect code: route by atlas to the star or fire pool
  const addPool = {
    spawn(o) {
      if (o.atlas === ATLAS.STAR) addStar.spawn(o);
      else addFire.spawn(o);
    },
    update(dt) {
      addStar.update(dt);
      addFire.update(dt);
    },
  };

  // facade for the normal-blend pool (sprites), same call signature
  const normPool = {
    spawn(o) { normSpawn(o); },
    update(dt) { normUpdate(dt); },
  };

  /* ------------------------------------------------------------------ sparks */
  const sparkGeo = new THREE.BufferGeometry();
  const spPos = new Float32Array(MAX_SPARKS * 3);
  const spCol = new Float32Array(MAX_SPARKS * 3);
  const spSizeArr = new Float32Array(MAX_SPARKS);
  const spPosAttr = new THREE.BufferAttribute(spPos, 3).setUsage(THREE.DynamicDrawUsage);
  const spColAttr = new THREE.BufferAttribute(spCol, 3).setUsage(THREE.DynamicDrawUsage);
  const spSizeAttr = new THREE.BufferAttribute(spSizeArr, 1).setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('position', spPosAttr);
  sparkGeo.setAttribute('aColor', spColAttr);
  sparkGeo.setAttribute('aSize', spSizeAttr);
  sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uResolution: U.res,
      uFogDensity: U.fogDensity,
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      uniform vec2 uResolution;
      uniform float uFogDensity;
      varying vec3 vColor;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(0.05, -mv.z);
        gl_PointSize = clamp(aSize * 0.5 * uResolution.y * projectionMatrix[1][1] / depth, 1.0, 24.0);
        float fog = 1.0 - exp(-pow(uFogDensity * depth, 2.0));
        vColor = aColor * (1.0 - fog * 0.85);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        float core = smoothstep(0.5, 0.02, r);
        float a = core * core;
        if (a < 0.004) discard;
        vec3 col = vColor * (1.0 + 2.4 * smoothstep(0.22, 0.0, r));
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.renderOrder = 7;
  group.add(sparkPoints);

  const sparkVel = new Float32Array(MAX_SPARKS * 3);
  const sparkBase = new Float32Array(MAX_SPARKS * 3);
  const sparkLife = new Float32Array(MAX_SPARKS);
  const sparkMax = new Float32Array(MAX_SPARKS);
  const sparkGrav = new Float32Array(MAX_SPARKS);
  const sparkDrag = new Float32Array(MAX_SPARKS);
  const sparkBounce = new Uint8Array(MAX_SPARKS);
  let sparkCursor = 0;

  function spawnSpark(x, y, z, vx, vy, vz, o) {
    o = o || {};
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
    const i3 = i * 3;
    spPos[i3] = x; spPos[i3 + 1] = y; spPos[i3 + 2] = z;
    sparkVel[i3] = vx; sparkVel[i3 + 1] = vy; sparkVel[i3 + 2] = vz;
    const life = o.life !== undefined ? o.life : rnd(0.18, 0.42);
    sparkLife[i] = sparkMax[i] = life;
    spSizeArr[i] = (o.width !== undefined ? o.width : 0.015) * 2.6;
    sparkGrav[i] = o.grav !== undefined ? o.grav : 9.8;
    sparkDrag[i] = o.drag !== undefined ? o.drag : 0.5;
    sparkBounce[i] = o.bounce === false ? 0 : 1;
    _c.setHex(o.color !== undefined ? o.color : 0xffcb82);
    const k = o.intensity !== undefined ? o.intensity : 1;
    sparkBase[i3] = _c.r * k; sparkBase[i3 + 1] = _c.g * k; sparkBase[i3 + 2] = _c.b * k;
  }

  function updateSparks(dt) {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (sparkLife[i] <= 0) continue;
      const i3 = i * 3;
      sparkLife[i] -= dt;
      if (sparkLife[i] <= 0) {
        sparkLife[i] = 0;
        spCol[i3] = 0; spCol[i3 + 1] = 0; spCol[i3 + 2] = 0;
        spSizeArr[i] = 0;
        continue;
      }
      sparkVel[i3 + 1] -= sparkGrav[i] * dt;
      const damp = Math.max(0, 1 - sparkDrag[i] * dt);
      sparkVel[i3] *= damp;
      sparkVel[i3 + 2] *= damp;
      spPos[i3] += sparkVel[i3] * dt;
      spPos[i3 + 1] += sparkVel[i3 + 1] * dt;
      spPos[i3 + 2] += sparkVel[i3 + 2] * dt;
      if (sparkBounce[i] && spPos[i3 + 1] < 0.02) {
        spPos[i3 + 1] = 0.02;
        sparkVel[i3 + 1] *= -0.32;
        sparkVel[i3] *= 0.55;
        sparkVel[i3 + 2] *= 0.55;
      }
      const k = sparkLife[i] / sparkMax[i];
      const fade = smoothstep01(0, 0.12, 1 - k) * Math.pow(k, 0.6);
      spCol[i3] = sparkBase[i3] * fade;
      spCol[i3 + 1] = sparkBase[i3 + 1] * fade;
      spCol[i3 + 2] = sparkBase[i3 + 2] * fade;
    }
    spPosAttr.needsUpdate = true;
    spColAttr.needsUpdate = true;
    spSizeAttr.needsUpdate = true;
  }

  function smoothstep01(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* ------------------------------------------------------------------ tracers */
  // Thin additive line segments: bright beam + brighter short core.
  const tracerGeo = new THREE.BufferGeometry();
  const TR_VERTS = 4;
  const trPos = new Float32Array(MAX_TRACERS * TR_VERTS * 3);
  const trCol = new Float32Array(MAX_TRACERS * TR_VERTS * 3);
  const trPosAttr = new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage);
  const trColAttr = new THREE.BufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage);
  tracerGeo.setAttribute('position', trPosAttr);
  tracerGeo.setAttribute('color', trColAttr);
  tracerGeo.setDrawRange(0, 0);
  tracerGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const tracerMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  });
  const tracerLines = new THREE.LineSegments(tracerGeo, tracerMat);
  tracerLines.frustumCulled = false;
  tracerLines.renderOrder = 7;
  group.add(tracerLines);

  const tracerData = [];
  for (let i = 0; i < MAX_TRACERS; i++) {
    tracerData.push({
      fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0,
      life: 0, max: 1, r: 1, g: 1, b: 1,
    });
  }
  let tracerCursor = 0;

  function tracer(from, to, opts) {
    opts = opts || {};
    const t = tracerData[tracerCursor];
    tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
    t.fx = from.x; t.fy = from.y; t.fz = from.z;
    t.tx = to.x; t.ty = to.y; t.tz = to.z;
    const life = opts.life !== undefined ? opts.life : 0.07;
    t.life = t.max = life;
    _c.setHex(opts.color !== undefined ? opts.color : 0xffd7a0);
    const k = opts.intensity !== undefined ? opts.intensity : 2.2;
    t.r = _c.r * k; t.g = _c.g * k; t.b = _c.b * k;
  }

  function updateTracers(dt) {
    let n = 0;
    for (const t of tracerData) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.life = 0; continue; }
      const k = t.life / t.max;
      const fade = Math.min(1, (1 - k) * 8) * Math.pow(k, 0.5);
      const o = n * TR_VERTS * 3;
      trPos[o] = t.fx; trPos[o + 1] = t.fy; trPos[o + 2] = t.fz;
      trPos[o + 3] = t.tx; trPos[o + 4] = t.ty; trPos[o + 5] = t.tz;
      trPos[o + 6] = t.fx + (t.tx - t.fx) * 0.62;
      trPos[o + 7] = t.fy + (t.ty - t.fy) * 0.62;
      trPos[o + 8] = t.fz + (t.tz - t.fz) * 0.62;
      trPos[o + 9] = t.tx; trPos[o + 10] = t.ty; trPos[o + 11] = t.tz;
      const beam = 0.95 * fade;
      const core = 3.4 * fade;
      for (let v = 0; v < 6; v += 3) {
        trCol[o + v] = t.r * beam;
        trCol[o + v + 1] = t.g * beam;
        trCol[o + v + 2] = t.b * beam;
      }
      for (let v = 6; v < 12; v += 3) {
        trCol[o + v] = t.r * core;
        trCol[o + v + 1] = t.g * core;
        trCol[o + v + 2] = t.b * core;
      }
      n++;
    }
    tracerGeo.setDrawRange(0, n * TR_VERTS);
    trPosAttr.needsUpdate = true;
    trColAttr.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ decals */
  const decalGeo = new THREE.PlaneGeometry(1, 1);

  const holeMat = new THREE.MeshBasicMaterial({
    map: mats.sprites.hole, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const holes = new THREE.InstancedMesh(decalGeo, holeMat, MAX_HOLES);
  holes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  holes.frustumCulled = false;
  holes.renderOrder = 2;
  group.add(holes);
  let holeCursor = 0;

  const scrapeMat = new THREE.MeshBasicMaterial({
    map: mats.sprites.glow, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.55,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
  });
  const scrapes = new THREE.InstancedMesh(decalGeo, scrapeMat, MAX_SCRAPES);
  scrapes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scrapes.frustumCulled = false;
  scrapes.renderOrder = 3;
  group.add(scrapes);
  let scrapeCursor = 0;

  const bloodMat = new THREE.MeshBasicMaterial({
    map: mats.sprites.blood, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const bloodDecals = new THREE.InstancedMesh(decalGeo, bloodMat, MAX_BLOOD_DECALS);
  bloodDecals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bloodDecals.frustumCulled = false;
  bloodDecals.renderOrder = 2;
  group.add(bloodDecals);
  let bloodCursor = 0;

  const WHITE = new THREE.Color(1, 1, 1);
  function initInstanced(mesh, n) {
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) {
      mesh.setMatrixAt(i, _m4);
      mesh.setColorAt(i, WHITE);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  initInstanced(holes, MAX_HOLES);
  initInstanced(scrapes, MAX_SCRAPES);
  initInstanced(bloodDecals, MAX_BLOOD_DECALS);

  function placeDecal(mesh, idx, point, normal, sx, sy, tint, roll) {
    _p.copy(point).addScaledVector(normal, 0.006);
    _q.setFromUnitVectors(Z_FWD, normal);
    _q2.setFromAxisAngle(normal, roll !== undefined ? roll : Math.random() * Math.PI * 2);
    _q.premultiply(_q2);
    _s.set(sx, sy, 1);
    _m4.compose(_p, _q, _s);
    mesh.setMatrixAt(idx, _m4);
    if (tint) {
      _c.setHex(tint);
      mesh.setColorAt(idx, _c);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** public decal API — kind: 'hole' | 'blood' | 'scrape' | 'bloodfloor' */
  function addDecal(point, normal, size, kind) {
    kind = kind || 'hole';
    const n = normal || UP;
    if (kind === 'blood' || kind === 'bloodfloor') {
      const i = bloodCursor; bloodCursor = (bloodCursor + 1) % MAX_BLOOD_DECALS;
      placeDecal(bloodDecals, i, point, kind === 'bloodfloor' ? UP : n,
        size * rnd(0.85, 1.15), size * rnd(0.85, 1.15), undefined, Math.random() * 6.28);
    } else if (kind === 'scrape') {
      const i = scrapeCursor; scrapeCursor = (scrapeCursor + 1) % MAX_SCRAPES;
      // elongate the scrape along a tangent of the surface
      _v3.copy(n).cross(UP);
      if (_v3.lengthSq() < 0.01) _v3.set(1, 0, 0);
      _v3.normalize();
      _v2.copy(n).cross(_v3).normalize();
      _q.setFromUnitVectors(Z_FWD, n);
      _q2.setFromAxisAngle(n, Math.random() * Math.PI * 2);
      _q.premultiply(_q2);
      _p.copy(point).addScaledVector(n, 0.008);
      _s.set(size * rnd(1.8, 2.6), size * 0.35, 1);
      _m4.compose(_p, _q, _s);
      scrapes.setMatrixAt(i, _m4);
      scrapes.instanceMatrix.needsUpdate = true;
    } else {
      const i = holeCursor; holeCursor = (holeCursor + 1) % MAX_HOLES;
      placeDecal(holes, i, point, n, size, size, kind === 'metal' ? 0xc8d0d8 : kind === 'wood' ? 0x9c7a52 : 0xffffff,
        Math.random() * 6.28);
    }
  }

  /* ------------------------------------------------------------------ shock rings */
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 96, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ringGeoDust = new THREE.RingGeometry(0.35, 1.0, 72, 1);
  ringGeoDust.rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) {
    const dust = i >= 2;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(dust ? 0xb9ac97 : 0xffd8a6) },
        uAlpha: { value: 0 },
        uInner: { value: dust ? 0.35 : 0.8 },
        uOuter: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        varying float vR;
        void main(){ vR = length(position.xz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uAlpha; uniform float uInner; uniform float uOuter;
        varying float vR;
        void main(){
          float band = (uOuter - uInner);
          float a = smoothstep(uInner, uInner + band * 0.45, vR) * (1.0 - smoothstep(uOuter - band * 0.55, uOuter, vR));
          if (a * uAlpha < 0.003) discard;
          gl_FragColor = vec4(uColor, a * uAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: dust ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(dust ? ringGeoDust : ringGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    group.add(mesh);
    rings.push({ mesh, mat, life: 0, max: 1, r0: 0, r1: 1, a0: 0.5, y: 0 });
  }
  let ringCursor = 0;

  function spawnRing(x, y, z, r0, r1, life, alpha, dust) {
    const start = dust ? 2 : 0;
    let r = null;
    for (let k = 0; k < 2; k++) {
      const cand = rings[start + ((ringCursor + k) % 2)];
      if (!cand || cand.life <= 0) { r = cand; break; }
    }
    if (!r) return;
    ringCursor = (ringCursor + 1) % 2;
    r.mesh.visible = true;
    r.mesh.position.set(x, y, z);
    r.life = r.max = life;
    r.r0 = r0; r.r1 = r1; r.a0 = alpha;
    r.mesh.scale.setScalar(r0);
    r.mat.uniforms.uAlpha.value = alpha;
  }

  function updateRings(dt) {
    for (const r of rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.life = 0; r.mesh.visible = false; continue; }
      const t = 1 - r.life / r.max;
      const e = 1 - Math.pow(1 - t, 2.4);
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * e);
      r.mat.uniforms.uAlpha.value = r.a0 * Math.pow(1 - t, 1.8) * Math.min(1, t * 12);
    }
  }

  /* ------------------------------------------------------------------ shock shells */
  const shellGeo = new THREE.SphereGeometry(1, 32, 20);
  const shells = [];
  for (let i = 0; i < MAX_SHELLS; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffd9ae) }, uAlpha: { value: 0 } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uAlpha;
        varying vec3 vN; varying vec3 vV;
        void main(){
          float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
          if (f * uAlpha < 0.003) discard;
          gl_FragColor = vec4(uColor, f * uAlpha);
        }`,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(shellGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    group.add(mesh);
    shells.push({ mesh, mat, life: 0, max: 1, r0: 0.3, r1: 4, a0: 0.3 });
  }
  let shellCursor = 0;

  function spawnShell(x, y, z, r0, r1, life, alpha) {
    const s = shells[shellCursor];
    shellCursor = (shellCursor + 1) % MAX_SHELLS;
    s.mesh.visible = true;
    s.mesh.position.set(x, y, z);
    s.life = s.max = life;
    s.r0 = r0; s.r1 = r1; s.a0 = alpha;
    s.mesh.scale.setScalar(r0);
    s.mat.uniforms.uAlpha.value = 0;
  }

  function updateShells(dt) {
    for (const s of shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.life = 0; s.mesh.visible = false; continue; }
      const t = 1 - s.life / s.max;
      const e = 1 - Math.pow(1 - t, 3);
      s.mesh.scale.setScalar(s.r0 + (s.r1 - s.r0) * e);
      s.mat.uniforms.uAlpha.value = s.a0 * Math.pow(1 - t, 2.2) * Math.min(1, t * 14);
    }
  }

  /* ------------------------------------------------------------------ debris */
  const debrisGeo = new THREE.IcosahedronGeometry(1, 0);
  const debrisMat = new THREE.MeshStandardMaterial({ color: 0x3a352e, roughness: 0.95, metalness: 0.05 });
  const debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, MAX_DEBRIS);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.frustumCulled = false;
  debrisMesh.castShadow = false;
  debrisMesh.receiveShadow = false;
  group.add(debrisMesh);
  const deb = [];
  for (let i = 0; i < MAX_DEBRIS; i++) {
    deb.push({
      p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      av: new THREE.Vector3(), size: new THREE.Vector3(), life: 0, max: 1,
    });
    _m4.makeScale(0, 0, 0);
    debrisMesh.setMatrixAt(i, _m4);
  }
  debrisMesh.instanceMatrix.needsUpdate = true;
  let debrisCursor = 0;

  function spawnDebris(x, y, z, speed, size) {
    const d = deb[debrisCursor];
    debrisCursor = (debrisCursor + 1) % MAX_DEBRIS;
    d.p.set(x, y, z);
    _v.set(rndS(), rnd(0.2, 1.0), rndS()).normalize().multiplyScalar(speed * rnd(0.35, 1));
    d.v.copy(_v).setY(Math.abs(_v.y) * rnd(0.6, 1.4) + rnd(1, 4));
    d.q.setFromAxisAngle(_v.set(rndS(), rndS(), rndS()).normalize(), Math.random() * 6.28);
    d.av.set(rndS() * 14, rndS() * 14, rndS() * 14);
    const s = size * rnd(0.4, 1.3);
    d.size.set(s * rnd(0.6, 1.6), s * rnd(0.4, 1.0), s * rnd(0.6, 1.4));
    d.life = d.max = rnd(1.1, 2.4);
  }

  function updateDebris(dt) {
    let any = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = deb[i];
      if (d.life <= 0) continue;
      any = true;
      d.life -= dt;
      if (d.life <= 0) {
        _m4.makeScale(0, 0, 0);
        debrisMesh.setMatrixAt(i, _m4);
        continue;
      }
      d.v.y -= 16 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < 0.03) {
        d.p.y = 0.03;
        d.v.y *= -0.28;
        d.v.x *= 0.62; d.v.z *= 0.62;
        d.av.multiplyScalar(0.6);
      }
      _axis.copy(d.av).normalize();
      _q2.setFromAxisAngle(_axis, d.av.length() * dt);
      d.q.premultiply(_q2);
      const fade = Math.min(1, d.life / 0.35);
      _s.copy(d.size).multiplyScalar(fade);
      _m4.compose(d.p, d.q, _s);
      debrisMesh.setMatrixAt(i, _m4);
    }
    if (any) debrisMesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ atmosphere */
  let atmosphere = null;
  try {
    atmosphere = createAtmosphere(scene, mats);
  } catch (e) {
    console.warn('atmosphere init failed', e);
  }

  /* ============================== EFFECTS ============================== */

  const _lastMuzzle = new THREE.Vector3();

  function muzzleFlash(worldPos, opts) {
    opts = opts || {};
    const cam = getCamera();
    _v.set(0, 0, -1);
    if (cam) cam.getWorldDirection(_v);
    const s = opts.scale !== undefined ? opts.scale : rnd(0.88, 1.12);
    const near = cam ? worldPos.distanceTo(cam.position) < 3.2 : true;

    // the passed muzzle position is the geometric centre: everything that is
    // meant to read as the flash is spawned exactly here (no lateral offset)
    _lastMuzzle.copy(worldPos);

    // restrained world-space light: brief, tight radius, never floods the frame
    muzzleL.light.position.set(worldPos.x, worldPos.y, worldPos.z);
    flashLight(muzzleL, (near ? 7.5 : 6) * s);
    muzzleL.dur = 0.048;
    muzzleL.light.distance = near ? 8 : 11;

    const px = worldPos.x, py = worldPos.y, pz = worldPos.z;
    const rot = Math.random() * 6.2832;

    // 1) white-hot core star — small (<= 60 px at the player's muzzle), short
    addPool.spawn({
      x: px, y: py, z: pz,
      size: 0.052 * s, sizeEnd: 0.072 * s, life: 0.042, alpha: 1.0,
      color: 0xfff6de, intensity: 2.5, atlas: ATLAS.STAR,
      rot, drag: 9, fadeIn: 0.015, fadePow: 0.85,
    });
    // 2) small orange star for shape, sits on the same centre
    addPool.spawn({
      x: px, y: py, z: pz,
      size: 0.032 * s, sizeEnd: 0.050 * s, life: 0.056, alpha: 0.85,
      color: 0xff9a34, intensity: 1.5, atlas: ATLAS.STAR,
      rot: rot + 0.9, drag: 9, fadeIn: 0.015, fadePow: 1.05,
    });
    // 3) short forward cone: 3 soft tongues, centroid ~6 px forward of centre
    for (let i = 0; i < 3; i++) {
      const d = i * 0.010; // 0 / 1 / 2 cm forward
      addPool.spawn({
        x: px + _v.x * d, y: py + _v.y * d, z: pz + _v.z * d,
        vx: _v.x * 0.35, vy: _v.y * 0.35 + 0.05, vz: _v.z * 0.35,
        size: (0.040 + i * 0.011) * s, sizeEnd: (0.052 + i * 0.014) * s,
        life: 0.046 + i * 0.008, alpha: 0.62 - i * 0.08,
        color: i === 0 ? 0xffd68a : 0xffa03c, intensity: 1.15,
        atlas: ATLAS.FIRE, rot: rot + i * 0.7, drag: 9,
        fadeIn: 0.015, fadePow: 1.0,
      });
    }
    // 4) muzzle smoke — kept but thin so it never blocks the sightline
    for (let i = 0; i < 3; i++) {
      const d = rnd(0.01, 0.05);
      normPool.spawn({
        x: px + _v.x * d + rndS() * 0.012,
        y: py + _v.y * d + rnd(-0.008, 0.02),
        z: pz + _v.z * d + rndS() * 0.012,
        vx: _v.x * rnd(0.25, 0.7) + rndS() * 0.08,
        vy: rnd(0.05, 0.22),
        vz: _v.z * rnd(0.25, 0.7) + rndS() * 0.08,
        size: rnd(0.022, 0.036) * s, sizeEnd: rnd(0.09, 0.16) * s,
        life: rnd(0.38, 0.72), alpha: rnd(0.10, 0.145),
        color: 0x9a938a,
        drag: rnd(2.0, 3.0), rise: rnd(0.12, 0.3), spin: rndS() * 0.4,
        fadeIn: 0.05, fadePow: 1.4,
      });
    }
    // 5) round sparks, small and centred on the muzzle
    for (let i = 0; i < 5; i++) {
      _v3.set(
        _v.x * rnd(0.55, 1.0) + rndS() * 0.3,
        _v.y * rnd(0.55, 1.0) + rndS() * 0.3 + 0.1,
        _v.z * rnd(0.55, 1.0) + rndS() * 0.3
      ).normalize();
      spawnSpark(px, py, pz,
        _v3.x * rnd(2.2, 5.5), _v3.y * rnd(2.2, 5.5), _v3.z * rnd(2.2, 5.5),
        { width: rnd(0.0035, 0.007), life: rnd(0.08, 0.16), grav: 5, drag: 1.7, color: i === 0 ? 0xfff0c8 : 0xffab5c });
    }
  }

  function impact(point, normal, kind, power) {
    const n = normal ? _v.copy(normal).normalize() : _v.set(0, 1, 0);
    const nx = n.x, ny = n.y, nz = n.z;
    const px = point.x + nx * 0.02, py = point.y + ny * 0.02, pz = point.z + nz * 0.02;
    const pw = power === undefined ? 1 : power;

    // tangent basis on the surface
    _v2.set(nz, 0, -nx);
    if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
    _v2.normalize();
    _v3.copy(n).cross(_v2).normalize();
    const t1x = _v2.x, t1y = _v2.y, t1z = _v2.z;
    const t2x = _v3.x, t2y = _v3.y, t2z = _v3.z;

    if (kind === 'flesh') {
      return blood(point, n, null);
    }

    if (kind === 'metal') {
      // dense orange-white spark burst, some skip along the surface
      const count = Math.round(20 * pw);
      for (let i = 0; i < count; i++) {
        const ricochet = Math.random() < 0.35;
        const sx = nx * (ricochet ? 0.25 : rnd(0.4, 1.0)) + t1x * rndS() * 0.8 + t2x * rndS() * 0.8;
        const sy = ny * (ricochet ? 0.8 : rnd(0.4, 1.0)) + (ricochet ? rnd(0.2, 0.9) : rndS() * 0.8);
        const sz = nz * (ricochet ? 0.25 : rnd(0.4, 1.0)) + t1z * rndS() * 0.8 + t2z * rndS() * 0.8;
        const sp = rnd(3.5, ricochet ? 12 : 7.5) * (0.7 + pw * 0.3);
        spawnSpark(px, py, pz, sx * sp, sy * sp, sz * sp, {
          width: rnd(0.007, 0.016),
          life: ricochet ? rnd(0.35, 0.72) : rnd(0.16, 0.4),
          grav: ricochet ? 11 : 7,
          drag: ricochet ? 0.25 : 0.9,
          color: Math.random() < 0.55 ? 0xfff4d2 : (Math.random() < 0.6 ? 0xffc06a : 0xff8a2e),
        });
      }
      // tiny bright puffs of vaporised metal
      for (let i = 0; i < 2; i++) {
        addPool.spawn({
          x: px, y: py, z: pz,
          vx: nx * rnd(0.4, 1.2), vy: ny * rnd(0.4, 1.2) + 0.15, vz: nz * rnd(0.4, 1.2),
          size: rnd(0.05, 0.09), sizeEnd: rnd(0.16, 0.24), life: rnd(0.1, 0.2), alpha: 0.55,
          color: 0xffb066, intensity: 1.5, atlas: ATLAS.FIRE, aspect: rnd(0.7, 1.2),
          drag: 3, fadeIn: 0.02, fadePow: 1.1,
        });
      }
      // thin smoke wisp
      normPool.spawn({
        x: px, y: py, z: pz,
        vx: nx * 0.5 + rndS() * 0.2, vy: ny * 0.4 + 0.25, vz: nz * 0.5 + rndS() * 0.2,
        size: 0.03, sizeEnd: rnd(0.14, 0.22), life: rnd(0.3, 0.55), alpha: 0.2,
        color: 0x8d8a82, drag: 2, rise: 0.2, fadeIn: 0.08,
      });
      addDecal(point, n, rnd(0.05, 0.09) * bw(pw), 'metal');
      addDecal(point, n, rnd(0.05, 0.11) * bw(pw), 'scrape');
      return;
    }

    if (kind === 'wood') {
      for (let i = 0; i < 7; i++) {
        const sp = rnd(1.6, 4.2);
        normPool.spawn({
          x: px, y: py, z: pz,
          vx: (nx * 0.6 + t1x * rndS() * 0.9 + t2x * rndS() * 0.5) * sp,
          vy: (ny * 0.6 + rnd(0.2, 0.8)) * sp,
          vz: (nz * 0.6 + t1z * rndS() * 0.9 + t2z * rndS() * 0.5) * sp,
          size: rnd(0.02, 0.035), sizeEnd: rnd(0.03, 0.05), life: rnd(0.35, 0.6), alpha: 0.95,
          color: 0x6b4f30, aspect: rnd(0.5, 1.6), grav: 12, drag: 1.2, spin: rndS() * 4,
          fadeIn: 0.01, fadePow: 1.0,
        });
      }
      for (let i = 0; i < 3; i++) {
        normPool.spawn({
          x: px, y: py, z: pz,
          vx: nx * rnd(0.5, 1.3) + rndS() * 0.4, vy: ny * rnd(0.4, 1.0) + 0.2, vz: nz * rnd(0.5, 1.3) + rndS() * 0.4,
          size: 0.05, sizeEnd: rnd(0.22, 0.36), life: rnd(0.3, 0.55), alpha: 0.3,
          color: 0x9a886c, drag: 2.2, rise: 0.25, spin: rndS() * 0.6, fadeIn: 0.08,
        });
      }
      for (let i = 0; i < 4; i++) {
        spawnSpark(px, py, pz,
          (nx * 0.6 + t1x * rndS()) * rnd(2, 4), (ny * 0.6 + rnd(0.3, 0.8)) * rnd(2, 4), (nz * 0.6 + t1z * rndS()) * rnd(2, 4),
          { width: rnd(0.005, 0.01), life: rnd(0.1, 0.22), grav: 9, drag: 1.4, color: 0x8a6440 });
      }
      addDecal(point, n, rnd(0.05, 0.09), 'wood');
      return;
    }

    // ---- concrete / plaster (default)
    // dense white-grey dust that blooms out of the hole
    for (let i = 0; i < 4; i++) {
      normPool.spawn({
        x: px + t1x * rnd(-0.02, 0.02), y: py + t1y * rnd(-0.02, 0.02), z: pz + t1z * rnd(-0.02, 0.02),
        vx: nx * rnd(0.5, 1.7) + t1x * rndS() * 0.8 + t2x * rndS() * 0.6,
        vy: ny * rnd(0.5, 1.7) + rnd(0.1, 0.55),
        vz: nz * rnd(0.5, 1.7) + t1z * rndS() * 0.8 + t2z * rndS() * 0.6,
        size: rnd(0.05, 0.10) * (0.8 + pw * 0.2), sizeEnd: rnd(0.30, 0.62) * (0.8 + pw * 0.2),
        life: rnd(0.4, 0.85) * (0.85 + pw * 0.15), alpha: rnd(0.30, 0.46),
        color: i % 3 === 0 ? 0xd6cfc0 : 0xb4ac9c, aspect: rnd(0.75, 1.35),
        drag: rnd(1.8, 2.8), rise: rnd(0.15, 0.4), grav: 0.4, spin: rndS() * 0.8,
        fadeIn: 0.07, fadePow: 1.5,
      });
    }
    // tight, brighter puff right at the hole
    normPool.spawn({
      x: px, y: py, z: pz,
      vx: nx * 1.6, vy: ny * 1.6 + 0.2, vz: nz * 1.6,
      size: 0.035, sizeEnd: 0.14, life: rnd(0.22, 0.34), alpha: 0.55,
      color: 0xe4ddcf, drag: 3.2, rise: 0.2, fadeIn: 0.03, fadePow: 1.4,
    });
    // chips
    for (let i = 0; i < 5; i++) {
      const sp = rnd(1.8, 4.6);
      normPool.spawn({
        x: px, y: py, z: pz,
        vx: (nx * 0.5 + t1x * rndS() * 0.9 + t2x * rndS() * 0.5) * sp,
        vy: (ny * 0.5 + rnd(0.35, 1.0)) * sp,
        vz: (nz * 0.5 + t1z * rndS() * 0.9 + t2z * rndS() * 0.5) * sp,
        size: rnd(0.014, 0.03), sizeEnd: rnd(0.018, 0.034), life: rnd(0.3, 0.55), alpha: 0.9,
        color: 0x4d473d, aspect: rnd(0.5, 1.7), grav: 13, drag: 0.9, spin: rndS() * 6,
        fadeIn: 0.01, fadePow: 0.8,
      });
    }
    // sparks
    const sc = Math.round(8 * pw);
    for (let i = 0; i < sc; i++) {
      const sp = rnd(2.2, 6.0);
      spawnSpark(px, py, pz,
        (nx * 0.55 + t1x * rndS() * 0.8 + t2x * rndS() * 0.5) * sp,
        (ny * 0.55 + rnd(0.2, 0.9)) * sp,
        (nz * 0.55 + t1z * rndS() * 0.8 + t2z * rndS() * 0.5) * sp,
        { width: rnd(0.005, 0.012), life: rnd(0.14, 0.34), grav: 9.8, drag: 0.8, color: Math.random() < 0.4 ? 0xfff0c8 : 0xffb36a });
    }
    addDecal(point, n, rnd(0.06, 0.125) * bw(pw), 'hole');
  }

  function bw(pw) { return 0.85 + (pw - 1) * 0.25; }

  function blood(point, normal, dir) {
    const n = normal ? _v.copy(normal).normalize() : _v.set(0, 1, 0);
    const dn = dir ? _v2.copy(dir).normalize() : _v2.copy(n);
    const px = point.x, py = point.y, pz = point.z;

    // dark mist
    for (let i = 0; i < 5; i++) {
      normPool.spawn({
        x: px, y: py, z: pz,
        vx: dn.x * rnd(0.6, 2.2) + rndS() * 0.9,
        vy: dn.y * rnd(0.6, 2.2) + rnd(0.1, 0.9),
        vz: dn.z * rnd(0.6, 2.2) + rndS() * 0.9,
        size: rnd(0.06, 0.12), sizeEnd: rnd(0.28, 0.52), life: rnd(0.3, 0.6), alpha: rnd(0.32, 0.5),
        color: i % 2 === 0 ? 0x3d0808 : 0x2a0505, aspect: rnd(0.7, 1.4),
        drag: 2.6, rise: 0.1, grav: 2.5, spin: rndS() * 0.6, fadeIn: 0.05, fadePow: 1.6,
      });
    }
    // droplets
    for (let i = 0; i < 9; i++) {
      normPool.spawn({
        x: px, y: py, z: pz,
        vx: dn.x * rnd(1.2, 3.5) + rndS() * 1.6,
        vy: dn.y * rnd(1.2, 3.5) + rnd(0.2, 1.8),
        vz: dn.z * rnd(1.2, 3.5) + rndS() * 1.6,
        size: rnd(0.012, 0.026), sizeEnd: rnd(0.01, 0.02), life: rnd(0.35, 0.6), alpha: 0.95,
        color: 0x4d0808, aspect: rnd(0.5, 1.4), grav: 14, drag: 0.6, spin: rndS() * 5,
        fadeIn: 0.01, fadePow: 0.7,
      });
    }
    // surface splat + a ground pool under the impact
    addDecal(point, n, rnd(0.18, 0.3), 'blood');
    if (py > 0.45) {
      _v3.set(px + rndS() * 0.25, 0.017, pz + rndS() * 0.25);
      addDecal(_v3, UP, rnd(0.35, 0.62), 'bloodfloor');
    }
  }

  function explosion(pos, scale) {
    const s = scale || 1;
    const px = pos.x, py = pos.y, pz = pos.z;

    // point light: bright, short, decays in ~0.3 s
    boomL.light.position.set(px, py + 0.35 * s, pz);
    flashLight(boomL, 105 * s);
    boomL.dur = 0.30;
    boomL.light.distance = 26 * s;

    // white flash (very short, drives the bloom)
    addPool.spawn({
      x: px, y: py + 0.2 * s, z: pz, size: 0.9 * s, sizeEnd: 1.6 * s,
      life: 0.075, alpha: 1.0, color: 0xffffff, intensity: 3.6,
      atlas: ATLAS.GLOW, aspect: 1, rot: Math.random() * 6.28, drag: 4, fadeIn: 0.01, fadePow: 0.8,
    });
    addPool.spawn({
      x: px, y: py + 0.2 * s, z: pz, size: 1.4 * s, sizeEnd: 2.4 * s,
      life: 0.05, alpha: 0.8, color: 0xfff0d0, intensity: 3.0,
      atlas: ATLAS.STAR, aspect: 1, rot: Math.random() * 6.28, drag: 4, fadeIn: 0.01, fadePow: 0.8,
    });

    // fireball: many small tongues, hot core then orange/deep red edge
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      const r = Math.pow(Math.random(), 0.55) * 0.55 * s;
      const dx = Math.cos(a) * Math.sqrt(1 - up * 0.5);
      const dz = Math.sin(a) * Math.sqrt(1 - up * 0.5);
      const dy = up * 0.75 + 0.1;
      const hot = i < 5;
      addPool.spawn({
        x: px + dx * r, y: py + dy * r + 0.15 * s, z: pz + dz * r,
        vx: dx * rnd(1.2, 4.2) * s, vy: rnd(0.8, 3.2) * s, vz: dz * rnd(1.2, 4.2) * s,
        size: rnd(0.32, 0.62) * s, sizeEnd: rnd(1.05, 2.1) * s,
        life: rnd(0.24, 0.56) * (0.8 + s * 0.2), alpha: rnd(0.6, 0.95),
        color: hot ? 0xfff0c4 : (Math.random() < 0.5 ? 0xffa844 : 0xff6a1c),
        intensity: hot ? 2.4 : rnd(1.3, 1.9),
        atlas: ATLAS.FIRE, aspect: rnd(0.7, 1.3),
        drag: rnd(1.4, 2.4), rise: rnd(0.8, 2.2), spin: rndS() * 1.2,
        fadeIn: 0.03, fadePow: 1.1,
      });
    }
    // dark smoke column (normal blend — gives the fireball its dark side)
    for (let i = 0; i < 13; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6) * 0.9 * s;
      const t = i / 13;
      normPool.spawn({
        x: px + Math.cos(a) * r, y: py + rnd(0.1, 0.8) * s, z: pz + Math.sin(a) * r,
        vx: Math.cos(a) * rnd(0.4, 1.6), vy: rnd(0.7, 1.9) * s, vz: Math.sin(a) * rnd(0.4, 1.6),
        size: rnd(0.8, 1.3) * s, sizeEnd: rnd(3.4, 5.8) * s,
        life: rnd(2.2, 3.8), alpha: rnd(0.72, 0.92),
        color: t < 0.45 ? 0x4a4238 : 0x2e2822,
        aspect: rnd(0.75, 1.3), drag: rnd(0.7, 1.1), rise: rnd(0.9, 1.5),
        spin: rndS() * 0.5, fadeIn: 0.08, fadePow: 1.35,
      });
    }
    // low ground dust kicked outward
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      normPool.spawn({
        x: px + Math.cos(a) * rnd(0.1, 1.0) * s, y: Math.max(0.06, py - 0.35 * s) + rnd(0, 0.2),
        z: pz + Math.sin(a) * rnd(0.1, 1.0) * s,
        vx: Math.cos(a) * rnd(1.5, 4.5) * s, vy: rnd(0.1, 0.9), vz: Math.sin(a) * rnd(1.5, 4.5) * s,
        size: rnd(0.5, 0.9) * s, sizeEnd: rnd(2.4, 4.2) * s,
        life: rnd(1.2, 2.2), alpha: rnd(0.42, 0.6),
        color: 0xb3a894, aspect: rnd(0.6, 1.4), drag: rnd(1.0, 1.7), rise: 0.15,
        spin: rndS() * 0.4, fadeIn: 0.06, fadePow: 1.5,
      });
    }
    // lingering embers / flame tongues
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      addPool.spawn({
        x: px + Math.cos(a) * rnd(0, 0.7) * s, y: py + rnd(0.05, 0.6) * s, z: pz + Math.sin(a) * rnd(0, 0.7) * s,
        vx: Math.cos(a) * rnd(0.2, 0.8), vy: rnd(0.6, 1.6), vz: Math.sin(a) * rnd(0.2, 0.8),
        size: rnd(0.25, 0.5) * s, sizeEnd: rnd(0.4, 0.8) * s,
        life: rnd(0.7, 1.2), alpha: rnd(0.35, 0.6),
        color: Math.random() < 0.5 ? 0xff7a22 : 0xffb055, intensity: 1.2,
        atlas: ATLAS.FIRE, drag: 1.2, rise: 0.8, fadeIn: 0.05, fadePow: 1.4,
      });
    }
    // sparks + embers
    for (let i = 0; i < 55; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.pow(Math.random(), 0.7);
      const sp = rnd(6, 26) * s;
      spawnSpark(px, py + 0.1, pz,
        Math.cos(a) * sp * (1 - up * 0.5), up * sp * 0.9 + rnd(0, 5), Math.sin(a) * sp * (1 - up * 0.5),
        {
          width: rnd(0.008, 0.02), life: rnd(0.4, 1.1), grav: 10, drag: rnd(0.15, 0.5),
          color: Math.random() < 0.35 ? 0xfff0cc : (Math.random() < 0.6 ? 0xffb45c : 0xff7a24),
        });
    }
    // chunks
    for (let i = 0; i < 16; i++) spawnDebris(px, py + 0.15, pz, rnd(4, 13) * s, 0.055 * s);

    // shock wave: hot air ring + dust ring + pressure shell
    spawnRing(px, Math.max(0.06, py - 0.1), pz, 0.4 * s, 7.5 * s, 0.32, 0.75, false);
    spawnRing(px, 0.05, pz, 0.3 * s, 5.2 * s, 0.7, 0.5, true);
    spawnShell(px, py + 0.25 * s, pz, 0.5 * s, 4.8 * s, 0.3, 0.32);
  }

  /* ------------------------------------------------------------------ update */
  let clock = 0;
  function update(dt) {
    clock += dt;
    const pr = Math.min(window.devicePixelRatio || 1, 1.5);
    U.res.value.set(window.innerWidth * pr, window.innerHeight * pr);

    updateSparks(dt);
    addPool.update(dt);
    normPool.update(dt);
    updateTracers(dt);
    updateRings(dt);
    updateShells(dt);
    updateDebris(dt);

    // lights decay deterministically (quadratic ease)
    if (muzzleL.t > 0) {
      muzzleL.t -= dt;
      const k = Math.max(0, muzzleL.t / muzzleL.dur);
      muzzleL.light.intensity = muzzleL.peak * k * k;
      if (muzzleL.t <= 0) muzzleL.light.intensity = 0;
    }
    if (boomL.t > 0) {
      boomL.t -= dt;
      const k = Math.max(0, boomL.t / boomL.dur);
      boomL.light.intensity = boomL.peak * k * k;
      if (boomL.t <= 0) boomL.light.intensity = 0;
    }

    if (atmosphere) atmosphere.update(dt);
  }

  return {
    update, impact, blood, tracer, muzzleFlash, explosion, group, addDecal, atmosphere,
    get lastMuzzle() { return _lastMuzzle.clone(); },
    // debug / tooling
    get time() { return clock; },
  };
}
