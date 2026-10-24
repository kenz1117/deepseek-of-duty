import * as THREE from 'three';
import { createSky } from './sky.js';
import { createPost, presets } from './postfx.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { buildMaterials } from './materials.js';

/* Half-resolution SSAO: the normal/depth/SSAO/blur targets render at half
   size, while the final multiply still covers the full read buffer. */
class HalfSSAOPass extends SSAOPass {
  setSize(w, h) {
    super.setSize(Math.max(1, Math.floor(w * 0.5)), Math.max(1, Math.floor(h * 0.5)));
  }
  // Decals, glass, sky and particles have no meaningful normals; feeding them
  // to the normal pass creates halos (the puddle ring). Hide them from AO.
  // The base implementation traverses the WHOLE scene twice per frame
  // (override + restore, with a Map write per object). The hide-set changes
  // only when the scene does, so classify into a cached list rebuilt a few
  // times per second and just flip visibility on the members.
  overrideVisibility() {
    const now = performance.now();
    if (!this._aoList || now - this._aoListAt > 400) {
      this._aoListAt = now;
      const list = [];
      this.scene.traverse((object) => {
        if (object.isPoints || object.isLine) { list.push(object); return; }
        if (object.userData && object.userData.noAO) { list.push(object); return; }
        const m = Array.isArray(object.material) ? object.material[0] : object.material;
        if (m && (m.transparent || m.depthWrite === false || m.alphaTest > 0)) list.push(object);
      });
      this._aoList = list;
    }
    const changed = this._aoChanged || (this._aoChanged = []);
    changed.length = 0;
    for (const o of this._aoList) {
      if (o.visible) { o.visible = false; changed.push(o); }
    }
  }
  restoreVisibility() {
    const changed = this._aoChanged;
    if (!changed) return;
    for (const o of changed) o.visible = true;
    changed.length = 0;
  }
}

/* =========================================================================
   Engine: renderer, scene, camera, sun + shadow rig, sky IBL, post stack.
   ========================================================================= */


/* =========================================================================
   Atmosphere presets: one street, four moods. Applied at wave start.
   ========================================================================= */
export const ATMOSPHERES = {
  dusk: {
    label: 'DUSK',
    sunDir: [0.12, 0.185, -0.975],
    sunColor: 0xffd0a6, sunIntensity: 2.60, fill: 1.18, hemi: 1.15, env: 1.45,
    fog: [0x66717a, 0.0064], exposure: 1.10, bloom: 0.34,
    sky: { horizon: [0.48, 0.40, 0.30], zenith: [0.055, 0.10, 0.18], sunColor: [1.0, 0.82, 0.64], sunIntensity: 1.0, cloud: 0.92 },
    grade: { contrast: 1.06, saturation: 0.96, lift: [0.018, 0.024, 0.034], gain: [1.03, 1.01, 0.99], vignette: 0.32, grain: 0.018 },
  },
  noon: {
    label: 'NOON',
    sunDir: [0.22, 0.82, -0.53],
    sunColor: 0xfff2dd, sunIntensity: 3.30, fill: 0.55, hemi: 1.15, env: 1.55,
    fog: [0x9aa7b0, 0.0055], exposure: 0.98, bloom: 0.30,
    sky: { horizon: [0.66, 0.72, 0.80], zenith: [0.14, 0.28, 0.52], sunColor: [1.0, 0.97, 0.90], sunIntensity: 1.25, cloud: 0.8 },
    grade: { contrast: 1.05, saturation: 0.92, lift: [0.008, 0.012, 0.018], gain: [1.02, 1.0, 0.98], vignette: 0.32, grain: 0.020 },
  },
  storm: {
    label: 'STORM',
    sunDir: [0.18, 0.42, -0.89],
    sunColor: 0xc3cdd6, sunIntensity: 1.15, fill: 0.95, hemi: 1.25, env: 1.15,
    fog: [0x4b4e52, 0.017], exposure: 1.10, bloom: 0.32,
    sky: { horizon: [0.26, 0.28, 0.30], zenith: [0.085, 0.10, 0.125], sunColor: [0.72, 0.78, 0.85], sunIntensity: 0.55, cloud: 1.0 },
    grade: { contrast: 1.14, saturation: 0.78, lift: [0.014, 0.017, 0.022], gain: [1.0, 1.0, 1.02], vignette: 0.52, grain: 0.045 },
  },
  night: {
    label: 'NIGHT',
    sunDir: [0.04, 0.10, -0.994],
    sunColor: 0x7f96c8, sunIntensity: 0.38, fill: 0.30, hemi: 0.42, env: 0.62,
    fog: [0x0a0f18, 0.0145], exposure: 1.62, bloom: 0.62,
    sky: { horizon: [0.035, 0.05, 0.085], zenith: [0.004, 0.009, 0.024], sunColor: [0.34, 0.46, 0.78], sunIntensity: 0.20, cloud: 0.85 },
    grade: { contrast: 1.16, saturation: 0.86, lift: [0.014, 0.020, 0.034], gain: [0.96, 1.0, 1.10], vignette: 0.58, grain: 0.038 },
  },
  bluehour: {
    label: 'BLUE HOUR',
    sunDir: [0.08, 0.11, -0.99],
    sunColor: 0x9ab4e0, sunIntensity: 0.75, fill: 0.40, hemi: 0.55, env: 0.80,
    fog: [0x101722, 0.011], exposure: 1.45, bloom: 0.55,
    sky: { horizon: [0.10, 0.13, 0.20], zenith: [0.012, 0.022, 0.055], sunColor: [0.55, 0.68, 0.92], sunIntensity: 0.35, cloud: 0.9 },
    grade: { contrast: 1.12, saturation: 0.85, lift: [0.020, 0.026, 0.040], gain: [0.98, 1.0, 1.08], vignette: 0.55, grain: 0.035 },
  },
};

export function createEngine(canvas, quality = 'high') {
  const q = presets(quality);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0x77685a);
  scene.fog = new THREE.FogExp2(fogColor, 0.0082);
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.04, 4000);
  camera.position.set(0, 1.7, 34);
  camera.rotation.order = 'YXZ';

  // ---------- sky + IBL ----------
  const sky = createSky(renderer);
  scene.add(sky.dome);
  if (sky.envTexture) {
    scene.environment = sky.envTexture;
    scene.environmentIntensity = 1.35;
  }

  // ---------- sun ----------
  const sun = new THREE.DirectionalLight(0xffc79a, 2.75);
  sun.position.copy(sky.sunDir).multiplyScalar(70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.shadows, q.shadows);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  const S = 44;
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.06;
  sun.shadow.radius = 1.7;
  scene.add(sun);
  scene.add(sun.target);

  // cool bounce fill from opposite side (no shadows)
  const fill = new THREE.DirectionalLight(0x7d95ab, 0.85);
  fill.position.set(-sky.sunDir.x * 40, 24, -sky.sunDir.z * 40);
  scene.add(fill);

  // subtle warm bounce from the ground toward the horizon
  const bounce = new THREE.HemisphereLight(0x8fa1b5, 0x5c4c38, 0.95);
  scene.add(bounce);

  // ---------- materials ----------
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const mats = buildMaterials(Math.min(8, maxAniso));

  // ---------- post ----------
  const post = createPost(renderer, scene, camera, quality);

  const state = {
    quality, fps: 60, frame: 0,
    // dynamic resolution: scales the preset pixel ratio to hold the frame budget
    renderScale: 1, basePR: Math.min(window.devicePixelRatio || 1, q.pixelRatio),
    emaMs: 16.7, lastAdjust: 0,
    // frame budget tracks the fps cap: capping at 30 fps makes frames ~33 ms,
    // which must NOT read as "slow frame" or resolution would degrade for nothing
    frameBudgetMs: 16.7,
  };

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(state.basePR * state.renderScale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.resize(w, h, renderer.getPixelRatio());
  }
  window.addEventListener('resize', onResize);

  const _sunWorld = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _proj = new THREE.Vector3();
  // shadow snapping (light space, see update())
  const _shadowBasis = new THREE.Matrix4();
  const _lightEye = new THREE.Vector3();
  const _zero = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _lx = new THREE.Vector3();
  const _ly = new THREE.Vector3();

  /* Snap the shadow camera target to the light's texel grid.
     Snapping world X/Z is wrong for an oblique sun: the shadow map's texels
     are aligned to the light camera, not to the world axes, so the grid slides
     under every window frame while you walk and the shadows shimmer. */
  function snapShadowFocus(focus, out) {
    const texel = (S * 2) / sun.shadow.mapSize.x;
    _lightEye.copy(sky.sunDir).multiplyScalar(70);
    _shadowBasis.lookAt(_lightEye, _zero, _worldUp);
    _lx.setFromMatrixColumn(_shadowBasis, 0);
    _ly.setFromMatrixColumn(_shadowBasis, 1);
    // keep the full 3D correction: the light's up axis has a Y component, so
    // clamping the target to y=0 would re-introduce sub-texel drift
    const a = focus.dot(_lx);
    const b = focus.dot(_ly);
    const da = a - Math.round(a / texel) * texel;
    const db = b - Math.round(b / texel) * texel;
    out.copy(focus)
      .addScaledVector(_lx, -da)
      .addScaledVector(_ly, -db);
    return out;
  }
  const _snapPos = new THREE.Vector3();

  function update(dt, focus, sunOccluded = false) {
    state.frame++;
    sky.update(performance.now() / 1000);
    // shadow frustum follows the player, snapped to the light's texel grid
    if (focus) {
      snapShadowFocus(focus, _snapPos);
      sun.target.position.copy(_snapPos);
      sun.position.set(
        _snapPos.x + sky.sunDir.x * 70,
        sky.sunDir.y * 70,
        _snapPos.z + sky.sunDir.z * 70
      );
      sun.target.updateMatrixWorld();
    }

    // project the sun for screen space god rays
    _sunWorld.copy(sky.sunDir).multiplyScalar(800).add(camera.position);
    _proj.copy(_sunWorld).project(camera);
    const onScreen = _proj.z > 0 && _proj.x > -1.2 && _proj.x < 1.2 && _proj.y > -1.2 && _proj.y < 1.2;
    camera.getWorldDirection(_camDir);
    const facing = Math.max(0, _camDir.dot(sky.sunDir));
    post.uniforms.uSunScreen.value.set(_proj.x * 0.5 + 0.5, _proj.y * 0.5 + 0.5);
    post.uniforms.uSunVisible.value = (onScreen && !sunOccluded) ? Math.pow(facing, 2.2) : 0;
    post.uniforms.uSunColor.value.copy(sky.sunColor);
  }

  /* Dynamic resolution: if frames run long, drop render scale in small steps;
     recover when there is headroom again. Only geometry/post buffers scale —
     the HUD is DOM, so text stays crisp at 1x. */
  function applyDynamicResolution(dt) {
    if (!(dt > 0)) return;
    state.emaMs = state.emaMs * 0.94 + dt * 1000 * 0.06;
    if (state.quality === 'low') return;
    const now = performance.now();
    if (now - state.lastAdjust < 1600) return;
    const budget = state.frameBudgetMs;
    let next = state.renderScale;
    if (state.emaMs > budget * 1.17 && next > 0.72) next = Math.max(0.72, next - 0.08);
    else if (state.emaMs < budget * 0.75 && next < 1) next = Math.min(1, next + 0.05);
    state.lastAdjust = now;
    if (Math.abs(next - state.renderScale) < 0.001) return;
    state.renderScale = next;
    renderer.setPixelRatio(state.basePR * next);
    post.resize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  }

  function setFrameBudget(fpsCap) {
    state.frameBudgetMs = fpsCap > 0 ? 1000 / fpsCap : 16.7;
    // reset the EMA too: it still carries the OLD cap's frame time, which
    // would otherwise read as "slow frames" and trigger phantom downscaling
    state.emaMs = state.frameBudgetMs;
    state.lastAdjust = performance.now();
  }

  function render(dt) {
    renderer.info.reset();
    applyDynamicResolution(dt);
    post.render(dt);
  }

  function setQuality(next) {
    const nq = presets(next);
    state.quality = next;
    state.basePR = Math.min(window.devicePixelRatio || 1, nq.pixelRatio);
    state.renderScale = 1;
    state.emaMs = 16.7;
    state.lastAdjust = performance.now();
    renderer.setPixelRatio(state.basePR);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    sun.shadow.mapSize.set(nq.shadows, nq.shadows);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    post.applyQuality(next);
    if (ssaoPass) ssaoPass.enabled = !!nq.ssao;
  }

  function applyAtmosphere(name) {
    const a = ATMOSPHERES[name] || ATMOSPHERES.dusk;
    sky.setPreset({ ...a.sky, sunDir: a.sunDir });
    sun.color.setHex(a.sunColor);
    sun.intensity = a.sunIntensity;
    fill.intensity = a.fill;
    bounce.intensity = a.hemi;
    scene.environmentIntensity = a.env;
    scene.fog.color.setHex(a.fog[0]);
    scene.fog.density = a.fog[1];
    renderer.toneMappingExposure = a.exposure;
    post.setGrade({ ...a.grade, bloom: a.bloom });
    return a.label;
  }

  let ssaoPass = null;
  function enableSSAO() {
    if (ssaoPass) return ssaoPass;
    ssaoPass = new HalfSSAOPass(scene, camera, window.innerWidth, window.innerHeight);
    ssaoPass.kernelRadius = 7.0;
    ssaoPass.minDistance = 0.0015;
    ssaoPass.maxDistance = 0.10;
    ssaoPass.output = SSAOPass.OUTPUT.Default;
    ssaoPass.enabled = !!presets(state.quality).ssao;
    // insert directly after the world render, before the viewmodel overlay
    post.composer.insertPass(ssaoPass, 1);
    ssaoPass.setSize(window.innerWidth, window.innerHeight);
    return ssaoPass;
  }

  function addOverlay(overlayScene, overlayCamera) {
    const pass = new RenderPass(overlayScene, overlayCamera);
    pass.clear = false;
    pass.clearDepth = true;
    post.composer.insertPass(pass, 1);
    return pass;
  }

  return {
    renderer, scene, camera, sky, sun, fill, mats, post, state, addOverlay, applyAtmosphere, enableSSAO,
    update, render, setQuality, setFrameBudget, onResize,
    get renderScale() { return state.renderScale; },
    get quality() { return state.quality; },
    resize: onResize,
  };
}
