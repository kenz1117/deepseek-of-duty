import * as THREE from 'three';

/* =========================================================================
   WEATHER SYSTEM — 标准天气组件（风 / 雨 / 雾 / 雷电）

   设计目标：
   - 把原本散落在 ATMOSPHERES 里的"天色"与真正的"天气"解耦：
     天色（大气/光照/调色）仍由 engine.applyAtmosphere 负责；
     天气（风、雨、雾密度、雷电）由本组件叠加，可与任意天色组合。
   - 所有状态是连续数值，天气切换用 6 秒左右的平滑过渡，
     不会出现突变切屏感。
   - 全部粒子 GPU 驱动（跟随相机的包裹网格），CPU 每帧零逐粒子开销。
     图层：
       1) 雨幕     —— 斜向拉伸的雨丝点精灵，方向随风力/风向倾斜
       2) 风尘     —— 强风时出现的横向飞尘/碎屑拖尾
       3) 雾       —— 调制 scene.fog 的密度与颜色 + 曝光微调
       4) 天空     —— 在天色预设基础上增强云量（雨/暴风）
       5) 雷电     —— 暴风天气随机闪电：曝光尖峰 + 天空太阳强度脉冲

   API：
     createWeatherSystem({ scene, engine })
       .set(key | null)      切换天气（null = 关闭叠加，恢复纯天色）
       .update(dt)           每帧驱动（主循环调用一次即可）
       .state                当前插值中的连续参数（调试/HUD 用）
       .label                当前天气标签
   ========================================================================= */

export const WEATHER_ORDER = ['clear', 'breeze', 'fog', 'rain', 'storm'];

const WEATHERS = {
  clear: {
    label: 'CLEAR',
    wind: 0.6, windDir: 0.6,
    rain: 0,
    fogMul: 1.0, fogTint: [1.0, 1.0, 1.0],
    cloudAdd: 0.0,
    sunMul: 1.0, exposureAdd: 0.0,
    lightning: 0, // 每秒期望闪电次数
    gust: 0.25,
  },
  breeze: {
    label: 'WINDY',
    wind: 4.6, windDir: 1.15,
    rain: 0,
    fogMul: 0.88, fogTint: [1.02, 1.0, 0.96],
    cloudAdd: 0.10,
    sunMul: 0.98, exposureAdd: 0.0,
    lightning: 0,
    gust: 0.85,
  },
  fog: {
    label: 'FOG',
    wind: 0.5, windDir: 0.3,
    rain: 0,
    fogMul: 2.35, fogTint: [0.92, 0.95, 1.0],
    cloudAdd: 0.18,
    sunMul: 0.82, exposureAdd: 0.06,
    lightning: 0,
    gust: 0.1,
  },
  rain: {
    label: 'RAIN',
    wind: 3.1, windDir: 2.1,
    rain: 0.55,
    fogMul: 1.55, fogTint: [0.86, 0.9, 0.97],
    cloudAdd: 0.30,
    sunMul: 0.72, exposureAdd: 0.05,
    lightning: 0.01,
    gust: 0.55,
  },
  storm: {
    label: 'STORM',
    wind: 8.6, windDir: 2.5,
    rain: 1.0,
    fogMul: 2.0, fogTint: [0.78, 0.82, 0.9],
    cloudAdd: 0.45,
    sunMul: 0.55, exposureAdd: 0.08,
    lightning: 0.28,
    gust: 1.0,
  },
};

const RAIN_BOX = new THREE.Vector3(46, 26, 46);
const WIND_BOX = new THREE.Vector3(40, 12, 40);
const TRANSITION = 1 / 6.0; // 每秒接近目标的比例

function makeRain(count) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * RAIN_BOX.x;
    pos[i * 3 + 1] = Math.random() * RAIN_BOX.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX.z;
    phase[i] = Math.random() * 6.2831853;
    speed[i] = 0.8 + Math.random() * 0.45;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRate: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uFogDensity: { value: 0.0092 },
      uPixelRatio: { value: 1 },
      uBox: { value: RAIN_BOX.clone() },
    },
    vertexShader: /* glsl */`
      attribute float aPhase;
      attribute float aSpeed;
      uniform float uTime;
      uniform float uRate;
      uniform vec2 uWind;
      uniform float uFogDensity;
      uniform float uPixelRatio;
      uniform vec3 uBox;
      varying float vAlpha;
      varying float vSlant;

      void main() {
        vec3 p = position;
        float fall = (12.0 + 8.0 * aSpeed);
        p.y -= uTime * fall * aSpeed;
        p.x += uWind.x * uTime * 0.9 + sin(uTime * 3.0 + aPhase) * 0.12;
        p.z += uWind.y * uTime * 0.9 + cos(uTime * 2.6 + aPhase) * 0.12;

        vec3 cam = cameraPosition;
        vec3 rel = mod(p - cam + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 world = cam + rel;

        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(0.2, -mv.z);
        gl_PointSize = clamp(uPixelRatio * 90.0 / depth, 1.0, 4.5) * (0.7 + 0.6 * aSpeed);

        float windLen = max(length(uWind), 0.001);
        // 风越大雨丝越斜（用比例近似 slant，供片元内拉伸）
        vSlant = clamp(windLen / 10.0, 0.0, 1.4);
        float nearFade = smoothstep(0.4, 2.0, length(rel));
        float farFade = 1.0 - smoothstep(14.0, 22.5, length(rel));
        float fogF = 1.0 - exp(-pow(uFogDensity * depth, 2.0));
        // 只点亮一部分粒子，密度由 uRate 控制（哈希式，无需 CPU 重排）
        float on = step(fract(aPhase * 13.37), uRate);
        vAlpha = on * nearFade * farFade * (0.32 + 0.5 * aSpeed) * (1.0 - fogF * 0.6);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying float vAlpha;
      varying float vSlant;
      void main() {
        // 点精灵内画一条斜雨丝：按风向旋转 + 拉长
        vec2 d = gl_PointCoord - 0.5;
        float c = clamp(vSlant, 0.0, 1.0);
        float s = sqrt(1.0 - c * c);
        vec2 r = vec2(d.x * s - d.y * c, d.x * c + d.y * s);
        r.y *= 1.0 / (1.0 + vSlant * 1.6); // 斜得越厉害，丝越长
        float a = smoothstep(0.16, 0.0, abs(r.x)) * smoothstep(0.5, 0.05, abs(r.y));
        if (a * vAlpha < 0.004) discard;
        gl_FragColor = vec4(vec3(0.72, 0.78, 0.86), a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.name = 'weather-rain';
  return { points, mat };
}

function makeWindDust(count) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * WIND_BOX.x;
    pos[i * 3 + 1] = Math.random() * WIND_BOX.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * WIND_BOX.z;
    phase[i] = Math.random() * 6.2831853;
    sizes[i] = 0.004 + Math.pow(Math.random(), 2.2) * 0.016;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uStrength: { value: 0 },
      uPixelRatio: { value: 1 },
      uBox: { value: WIND_BOX.clone() },
    },
    vertexShader: /* glsl */`
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform vec2 uWind;
      uniform float uStrength;
      uniform float uPixelRatio;
      uniform vec3 uBox;
      varying float vAlpha;

      void main() {
        vec3 p = position;
        // 沿风向快速掠过 + 上下颠簸
        p.x += uWind.x * uTime * (2.4 + fract(aPhase) * 1.6);
        p.z += uWind.y * uTime * (2.4 + fract(aPhase) * 1.6);
        p.y += sin(uTime * 2.2 + aPhase * 2.9) * 0.5;

        vec3 cam = cameraPosition;
        vec3 rel = mod(p - cam + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 world = cam + rel;

        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(0.2, -mv.z);
        gl_PointSize = clamp(aSize * uPixelRatio * 380.0 / depth, 0.8, 3.4);

        float dist = length(rel);
        float nearFade = smoothstep(0.6, 1.8, dist);
        float farFade = 1.0 - smoothstep(11.0, 18.5, dist);
        vAlpha = uStrength * nearFade * farFade * (0.18 + 0.3 * fract(aPhase * 3.1));
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        float a = smoothstep(0.5, 0.05, r);
        if (a * vAlpha < 0.004) discard;
        gl_FragColor = vec4(vec3(0.78, 0.72, 0.6), a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.name = 'weather-wind';
  return { points, mat };
}

export function createWeatherSystem({ scene, engine, audio = null }) {
  const group = new THREE.Group();
  group.name = 'weather';
  scene.add(group);

  const rain = makeRain(2400);
  const wind = makeWindDust(600);
  group.add(rain.points, wind.points);

  const fogBase = new THREE.Color();
  const fogTint = new THREE.Color(1, 1, 1);
  let baseDensity = scene.fog ? scene.fog.density : 0.0092;
  let baseExposure = engine.renderer.toneMappingExposure;
  let baseCloud = 1.0;
  let baseSunSky = 1.0;
  let baseSun = 2.75;

  // 连续插值状态（cur → target）
  const cur = { wind: 0.6, windDir: 0.6, rain: 0, fogMul: 1, cloudAdd: 0, sunMul: 1, exposureAdd: 0, lightning: 0, gust: 0.25 };
  const tgt = { ...cur };
  const tintCur = new THREE.Color(1, 1, 1);
  const tintTgt = new THREE.Color(1, 1, 1);

  let time = 0;
  let flash = 0;          // 闪电剩余强度 0..1
  let lightningTimer = 3;

  function set(key) {
    const p = WEATHERS[key];
    if (!p) { // null / 未知：回到 clear 且清零叠加
      Object.assign(tgt, { wind: 0.5, windDir: 0.6, rain: 0, fogMul: 1, cloudAdd: 0, sunMul: 1, exposureAdd: 0, lightning: 0, gust: 0.25 });
      tintTgt.setRGB(1, 1, 1);
      stateKey = 'clear';
      return 'CLEAR';
    }
    tgt.wind = p.wind; tgt.windDir = p.windDir; tgt.rain = p.rain;
    tgt.fogMul = p.fogMul; tgt.cloudAdd = p.cloudAdd;
    tgt.sunMul = p.sunMul; tgt.exposureAdd = p.exposureAdd;
    tgt.lightning = p.lightning; tgt.gust = p.gust;
    tintTgt.setRGB(p.fogTint[0], p.fogTint[1], p.fogTint[2]);
    stateKey = key;
    return p.label;
  }

  let stateKey = 'clear';

  /* 天色预设刚被 engine.applyAtmosphere 重设后调用：把当前值快照为
     "大气基线"，天气叠加在其上，避免与天色系统互相覆盖。 */
  function syncBase() {
    baseDensity = scene.fog ? scene.fog.density : baseDensity;
    baseExposure = engine.renderer.toneMappingExposure;
    if (scene.fog) fogBase.copy(scene.fog.color);
    const u = engine.sky && engine.sky.dome ? engine.sky.dome.material.uniforms : null;
    if (u && u.uCloudCover) baseCloud = u.uCloudCover.value;
    if (u && u.uSunIntensity) baseSunSky = u.uSunIntensity.value;
    if (engine.sun) {
      engine.sun.userData.baseIntensity = engine.sun.intensity;
      baseSun = engine.sun.intensity;
    }
    // 基线快照后立即按当前插值状态落一遍，防止一帧跳变
    apply(0);
  }

  const windVec = new THREE.Vector2();
  function apply(dt) {
    const k = 1 - Math.exp(-TRANSITION * 3 * (dt || 0.016));
    for (const key of Object.keys(cur)) cur[key] += (tgt[key] - cur[key]) * k;
    tintCur.lerp(tintTgt, k);

    const gustNoise = 0.75 + 0.35 * Math.sin(time * 0.7) * Math.sin(time * 1.9 + 1.3);
    const windNow = cur.wind * (0.8 + 0.4 * gustNoise * cur.gust);
    windVec.set(Math.cos(cur.windDir), Math.sin(cur.windDir)).multiplyScalar(windNow);

    // fog
    if (scene.fog) {
      scene.fog.density = baseDensity * cur.fogMul;
      scene.fog.color.copy(fogBase).multiply(tintCur);
    }
    // exposure
    engine.renderer.toneMappingExposure = baseExposure * cur.sunMul + cur.exposureAdd;
    // sky cloud / sun（每帧从基线重建，闪电脉冲可自然恢复）
    const u = engine.sky && engine.sky.dome ? engine.sky.dome.material.uniforms : null;
    if (u && u.uCloudCover) u.uCloudCover.value = Math.min(1.6, baseCloud + cur.cloudAdd);
    if (u && u.uSunIntensity) u.uSunIntensity.value = baseSunSky * cur.sunMul;
    if (engine.sun) engine.sun.intensity = baseSun * cur.sunMul;

    // particles
    rain.mat.uniforms.uTime.value = time;
    rain.mat.uniforms.uRate.value = cur.rain;
    rain.mat.uniforms.uWind.value.copy(windVec);
    rain.mat.uniforms.uFogDensity.value = scene.fog ? scene.fog.density : 0.0092;
    rain.mat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.5);

    wind.mat.uniforms.uTime.value = time;
    wind.mat.uniforms.uWind.value.copy(windVec);
    wind.mat.uniforms.uStrength.value = Math.max(0, (windNow - 1.4) / 8.0);
    wind.mat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.5);
  }

  function lightning(dt) {
    if (flash > 0) {
      flash = Math.max(0, flash - dt * 6.5);
      // 双峰闪烁
      const f = flash * (0.55 + 0.45 * Math.abs(Math.sin(flash * 26.0)));
      engine.renderer.toneMappingExposure += f * 0.9;
      const u = engine.sky && engine.sky.dome ? engine.sky.dome.material.uniforms : null;
      if (u && u.uSunIntensity) u.uSunIntensity.value += f * 2.2;
      // 太阳强度脉冲会在下一帧被 apply 恢复 —— 闪电只在当帧生效即可
    }
    if (cur.lightning <= 0) return;
    lightningTimer -= dt;
    if (lightningTimer <= 0) {
      lightningTimer = 2.5 + Math.random() * 9 / Math.max(0.05, cur.lightning);
      flash = 0.8 + Math.random() * 0.5;
      // 雷声延迟跟随距离（近雷紧、远雷迟），与闪电错开
      if (audio && audio.thunder) {
        const dist = Math.random();
        const delay = 0.25 + dist * 2.4;
        if (typeof setTimeout === 'function') setTimeout(() => { try { audio.thunder(dist); } catch (e) { /* optional */ } }, delay * 1000);
      }
    }
  }

  function updateAudio() {
    if (!audio) return;
    try {
      if (audio.setRainLevel) audio.setRainLevel(cur.rain);
      if (audio.setWindLevel) audio.setWindLevel(Math.min(1, cur.wind / 9));
    } catch (e) { /* audio optional */ }
  }

  function update(dt) {
    time += dt;
    apply(dt);
    lightning(dt);
    updateAudio();
  }

  return {
    set,
    syncBase,
    update,
    get state() { return cur; },
    get label() { return (WEATHERS[stateKey] || WEATHERS.clear).label; },
    get key() { return stateKey; },
    group,
  };
}
