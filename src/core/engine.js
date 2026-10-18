import * as THREE from 'three';
import { createSky } from './sky.js';
import { createPost, presets } from './postfx.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { buildMaterials } from './materials.js';

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
    sunColor: 0xffc79a, sunIntensity: 2.75, fill: 0.85, hemi: 0.95, env: 1.35,
    fog: [0x77685a, 0.0082], exposure: 1.08, bloom: 0.40,
    sky: { horizon: [0.56, 0.395, 0.225], zenith: [0.038, 0.072, 0.14], sunColor: [1.0, 0.78, 0.55], sunIntensity: 1.0, cloud: 1.0 },
    grade: { contrast: 1.10, saturation: 0.90, lift: [0.017, 0.021, 0.030], gain: [1.06, 1.0, 0.935], vignette: 0.45, grain: 0.028 },
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
  const S = 52;
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

  const state = { quality, fps: 60, frame: 0 };

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, presets(state.quality).pixelRatio));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.resize(w, h, renderer.getPixelRatio());
  }
  window.addEventListener('resize', onResize);

  const _sunWorld = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _proj = new THREE.Vector3();

  function update(dt, focus, sunOccluded = false) {
    state.frame++;
    sky.update(performance.now() / 1000);
    // shadow frustum follows the player, snapped to texel grid to reduce shimmer
    if (focus) {
      const texel = (S * 2) / sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel;
      const fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx + sky.sunDir.x * 70, sky.sunDir.y * 70, fz + sky.sunDir.z * 70);
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

  function render(dt) {
    renderer.info.reset();
    post.render(dt);
  }

  function setQuality(next) {
    const nq = presets(next);
    state.quality = next;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, nq.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    sun.shadow.mapSize.set(nq.shadows, nq.shadows);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    post.applyQuality(next);
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

  function addOverlay(overlayScene, overlayCamera) {
    const pass = new RenderPass(overlayScene, overlayCamera);
    pass.clear = false;
    pass.clearDepth = true;
    post.composer.insertPass(pass, 1);
    return pass;
  }

  return {
    renderer, scene, camera, sky, sun, fill, mats, post, state, addOverlay, applyAtmosphere,
    update, render, setQuality, onResize,
    get quality() { return state.quality; },
    resize: onResize,
  };
}
