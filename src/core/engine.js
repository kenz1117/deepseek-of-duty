import * as THREE from 'three';
import { createSky } from './sky.js';
import { createPost, presets } from './postfx.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { buildMaterials } from './materials.js';

/* =========================================================================
   Engine: renderer, scene, camera, sun + shadow rig, sky IBL, post stack.
   ========================================================================= */

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

  function addOverlay(overlayScene, overlayCamera) {
    const pass = new RenderPass(overlayScene, overlayCamera);
    pass.clear = false;
    pass.clearDepth = true;
    post.composer.insertPass(pass, 1);
    return pass;
  }

  return {
    renderer, scene, camera, sky, sun, fill, mats, post, state, addOverlay,
    update, render, setQuality, onResize,
    get quality() { return state.quality; },
    resize: onResize,
  };
}
