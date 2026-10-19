import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeStatic } from '../core/geo.js';
import { makeGunMaterials } from './gunmaterials.js';

/* =========================================================================
   First-person weapon viewmodel — M4A1-pattern carbine (M-LOK handguard)
   with a hollow EOTech-pattern holographic sight.

   • Gun space: origin at the rear of the upper receiver, bore on y = 0,
     -Z toward the muzzle, +Z toward the stock.
   • Rendered in its own scene/camera (engine overlay pass) so it can never
     intersect the world.
   • Static meshes are merged by material with mergeStatic() → ~30 draw calls.
     Only the magazine, charging handle and support arm stay independent.
   • Every animation channel is time / critically-damped-spring driven.

   Returned API is the one main.js expects:
     { scene, camera, root, gun, update, fire, startReload, inspect,
       setWeapon, setAspect, state, reloading, adsAmount }
   ========================================================================= */

const BASE_FOV = 58;
const ADS_FOV = 48;
const ADS_DIST = 0.24;             // eye → reticle distance in ADS
const RELOAD_DUR = 2.05;
const INSPECT_DUR = 2.7;
const GUN_SCALE = 0.68;

/* reticle centre in gun space; the whole ADS transform is solved from it */
const OPTIC = new THREE.Vector3(0, 0.088, -0.0348);

const HIP_POS = new THREE.Vector3(0.315, -0.255, -0.82);
const HIP_ROT = new THREE.Euler(0.12, 0.22, -0.1, 'YXZ');
const ADS_ROT = new THREE.Euler(0.012, -0.01, -0.016, 'YXZ');
const STOCK_TIP = new THREE.Vector3(0, -0.012, 0.303);

const LEFT_REST = new THREE.Vector3(-0.041, -0.014, -0.357);

/* ------------------------------------------------------------------ helpers */
const geoCache = new Map();
function rbox(w, h, d, r = 0.004, seg = 2) {
  const key = `b${w}|${h}|${d}|${r}|${seg}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) * 0.48));
    geoCache.set(key, g);
  }
  return g;
}
function cylGeo(rTop, rBot, h, seg = 12, open = false) {
  const key = `c${rTop}|${rBot}|${h}|${seg}|${open}`;
  let g = geoCache.get(key);
  if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open); geoCache.set(key, g); }
  return g;
}

function part(parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}
/** create N meshes sharing one geometry; mergeStatic() turns them into 1 draw */
function repeatPart(parent, geo, mat, list) {
  for (const t of list) {
    const m = part(parent, geo, mat, t.p[0], t.p[1], t.p[2],
      t.r ? t.r[0] : 0, t.r ? t.r[1] : 0, t.r ? t.r[2] : 0);
    if (t.s) m.scale.set(t.s[0], t.s[1], t.s[2]);
  }
}

const _up = new THREE.Vector3(0, 1, 0);
/** rounded box stretched from point a to point b (fingers, pads) */
function bone(parent, mat, a, b, w, d, r = 0.004) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.001, dir.length());
  const m = new THREE.Mesh(rbox(w, len, d, Math.min(r, w * 0.45)), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_up, dir.normalize());
  parent.add(m);
  return m;
}
/** tapered cylinder between two points */
function limb(parent, mat, a, b, r1, r2, seg = 10) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = Math.max(0.001, dir.length());
  const m = new THREE.Mesh(cylGeo(r2, r1, len, seg), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_up, dir.normalize());
  parent.add(m);
  return m;
}
function pv(x, y, z) { return new THREE.Vector3(x, y, z); }

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeIn = (x) => x * x * x;

/* ======================================================================= */
export function createViewmodel(engineMats, envTexture) {
  const scene = new THREE.Scene();
  scene.fog = null;
  if (envTexture) {
    scene.environment = envTexture;
    scene.environmentIntensity = 0.95;
  }

  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.008, 4);

  /* --------------------------------------------------------------- lighting */
  // Own three-point rig: warm key carves the top faces, cold rim draws the
  // silhouette, warm bounce keeps black-oxide parts from crushing to black.
  const key = new THREE.DirectionalLight(0xfff0de, 2.2);
  key.position.set(-0.9, 1.8, 1.2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x9dc5ea, 2.7);
  rim.position.set(1.3, 0.9, -1.2);
  scene.add(rim);

  const rim2 = new THREE.DirectionalLight(0xffa870, 0.9);
  rim2.position.set(0.2, -0.8, 0.9);
  scene.add(rim2);

  // low, cool right-rear edge light: lifts receiver bevels / knuckle silhouettes
  // without blowing highlights (kept well below the key and main rim)
  const rimBack = new THREE.DirectionalLight(0xb6d4f0, 0.8);
  rimBack.position.set(1.25, 0.55, 1.15);
  scene.add(rimBack);

  const hemi = new THREE.HemisphereLight(0xa9bed6, 0x2b241b, 0.5);
  scene.add(hemi);

  const fill = new THREE.DirectionalLight(0xcfd8e2, 1.5);
  fill.position.set(0.9, 0.4, 1.5);
  scene.add(fill);

  const fillWarm = new THREE.DirectionalLight(0xffd8b4, 0.55);
  fillWarm.position.set(-1.4, 0.2, 1.1);
  scene.add(fillWarm);

  const muzzleLight = new THREE.PointLight(0xffb066, 0, 1.6, 2);
  scene.add(muzzleLight);

  const root = new THREE.Group();
  scene.add(root);
  const gun = new THREE.Group();
  gun.rotation.order = 'YXZ';
  root.add(gun);

  /* -------------------------------------------------------------- materials */
  const M = makeGunMaterials(envTexture, 8);

  const magGroup = new THREE.Group();
  magGroup.position.set(0, -0.078, -0.062);
  gun.add(magGroup);
  const magInner = new THREE.Group();

  let chargeHandle = null;
  let leftPivot = null;
  let reticleMesh = null;
  let stockGroup = null;
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0, -0.703);
  gun.add(muzzleAnchor);

  const furnitureHosts = [];

  /* ============================================================== geometry */
  function buildRifle(variant = 'black') {
    const F = M.furnitureFor(variant);
    const body = new THREE.Group();
    const stockParts = new THREE.Group();

    /* ------------------------------------------------- upper + lower receiver */
    part(body, rbox(0.04, 0.052, 0.232, 0.006), M.receiver, 0, 0.0, -0.108);
    part(body, rbox(0.038, 0.06, 0.168, 0.006), M.receiver, 0, -0.05, -0.062);
    part(body, rbox(0.043, 0.036, 0.09, 0.005), M.receiver, 0, -0.088, -0.074);
    part(body, rbox(0.042, 0.003, 0.082, 0.0015), M.receiver, 0, -0.105, -0.074);

    // ejection port: dark cavity + closed dust cover + brass deflector
    part(body, new THREE.BoxGeometry(0.004, 0.024, 0.062), M.blackSteel, 0.0214, 0.008, -0.078);
    part(body, rbox(0.0045, 0.032, 0.064, 0.0015), M.receiver, 0.0228, 0.008, -0.078);
    part(body, rbox(0.006, 0.026, 0.028, 0.004), M.receiver, 0.024, 0.016, -0.043);
    // forward assist
    part(body, cylGeo(0.0072, 0.0072, 0.013, 10), M.wornSteel, 0.0235, 0.021, -0.026, 0, 0, Math.PI / 2);
    // bolt catch (left) / mag release (right)
    part(body, rbox(0.006, 0.018, 0.024, 0.002), M.receiverMatte, -0.0225, -0.038, -0.026);
    part(body, cylGeo(0.0072, 0.0072, 0.008, 8), M.wornSteel, 0.0225, -0.056, -0.055, 0, 0, Math.PI / 2);
    // safety selector
    part(body, cylGeo(0.0058, 0.0058, 0.006, 8), M.blackSteel, -0.0235, -0.046, -0.038, 0, 0, Math.PI / 2);
    part(body, rbox(0.006, 0.007, 0.028, 0.002), M.receiverMatte, -0.0245, -0.046, -0.027, 0, 0.25, 0);

    /* ---------------------------------------------------------------- trigger */
    part(body, new THREE.TorusGeometry(0.024, 0.0032, 6, 16, Math.PI * 1.18), M.receiver, 0, -0.079, -0.003, Math.PI / 2, 0, -0.55);
    part(body, rbox(0.005, 0.021, 0.009, 0.002), M.wornSteel, 0, -0.075, -0.006, -0.28);

    /* --------------------------------------------------------- pistol grip */
    part(body, rbox(0.028, 0.1, 0.044, 0.01, 4), M.stockPoly, 0, -0.121, 0.048, -0.34);
    part(body, rbox(0.029, 0.088, 0.012, 0.005, 3), M.rubber, 0, -0.124, 0.069, -0.34);
    part(body, rbox(0.03, 0.012, 0.048, 0.003), M.rubber, 0, -0.171, 0.063, -0.34);

    /* --------------------------------------------------------- buffer + stock */
    // kept in its own group: in ADS the buttstock sits behind the eye and is
    // culled, which removes the near-plane "bare stock" artefact entirely.
    part(stockParts, cylGeo(0.0165, 0.0165, 0.175, 14), M.blackSteel, 0, -0.004, 0.095, Math.PI / 2);
    part(stockParts, cylGeo(0.021, 0.021, 0.018, 12), M.blackSteel, 0, -0.004, 0.024, Math.PI / 2);
    part(stockParts, rbox(0.042, 0.074, 0.132, 0.014, 4), M.stockPoly, 0, -0.016, 0.222);
    part(stockParts, rbox(0.036, 0.02, 0.098, 0.009, 3), M.stockPoly, 0, 0.028, 0.212);
    part(stockParts, rbox(0.046, 0.092, 0.014, 0.006, 3), M.rubber, 0, -0.012, 0.294);
    part(stockParts, rbox(0.0025, 0.028, 0.062, 0.002), M.blackSteel, 0.0212, -0.018, 0.215);
    part(stockParts, rbox(0.0018, 0.016, 0.03, 0.001), M.rubber, 0.0225, -0.018, 0.215);
    part(stockParts, rbox(0.026, 0.011, 0.052, 0.004), M.blackSteel, 0, -0.058, 0.19);
    part(stockParts, new THREE.TorusGeometry(0.009, 0.0022, 6, 14), M.blackSteel, 0.026, -0.002, 0.255, 0, Math.PI / 2, 0);
    part(stockParts, new THREE.BoxGeometry(0.0012, 0.004, 0.1), M.blackSteel, -0.0212, -0.01, 0.22);
    part(stockParts, new THREE.BoxGeometry(0.0012, 0.004, 0.1), M.blackSteel, 0.0212, -0.01, 0.22);

    // panel lines / fastener rows (high-frequency detail energy)
    part(body, new THREE.BoxGeometry(0.0012, 0.004, 0.15), M.blackSteel, -0.0204, -0.008, -0.09);
    part(body, new THREE.BoxGeometry(0.0012, 0.004, 0.15), M.blackSteel, 0.0204, -0.008, -0.09);
    part(body, new THREE.BoxGeometry(0.0012, 0.028, 0.0014), M.blackSteel, -0.0204, -0.04, -0.145);
    part(body, new THREE.BoxGeometry(0.0012, 0.028, 0.0014), M.blackSteel, 0.0204, -0.04, -0.145);
    part(body, new THREE.BoxGeometry(0.0012, 0.004, 0.2), M.blackSteel, -0.0267, 0.008, -0.365);
    part(body, new THREE.BoxGeometry(0.0012, 0.004, 0.2), M.blackSteel, 0.0267, 0.008, -0.365);

    // worn bevels: thin bare-aluminium strips on the high-wear edges
    part(body, new THREE.BoxGeometry(0.0012, 0.0014, 0.224), M.receiverMatte, -0.0197, 0.0262, -0.108);
    part(body, new THREE.BoxGeometry(0.0012, 0.0014, 0.224), M.receiverMatte, 0.0197, 0.0262, -0.108);
    part(body, new THREE.BoxGeometry(0.0016, 0.0018, 0.16), M.receiverMatte, -0.0202, -0.022, -0.062);
    part(body, new THREE.BoxGeometry(0.0016, 0.0018, 0.16), M.receiverMatte, 0.0202, -0.022, -0.062);
    part(body, new THREE.BoxGeometry(0.043, 0.0012, 0.0022), M.receiverMatte, 0, -0.085, -0.116);
    part(body, new THREE.BoxGeometry(0.0015, 0.002, 0.26), M.receiverMatte, -0.0272, 0.026, -0.365);
    part(body, new THREE.BoxGeometry(0.0015, 0.002, 0.26), M.receiverMatte, 0.0272, 0.026, -0.365);
    part(body, new THREE.BoxGeometry(0.0015, 0.002, 0.26), M.receiverMatte, 0, -0.036, -0.365);

    /* --------------------------------------------------------- handguard */
    part(body, cylGeo(0.0265, 0.0275, 0.275, 8, false), F, 0, -0.002, -0.365, Math.PI / 2, 0, Math.PI / 8);
    part(body, cylGeo(0.029, 0.029, 0.012, 8), M.receiverMatte, 0, -0.002, -0.506, Math.PI / 2, 0, Math.PI / 8);
    part(body, rbox(0.022, 0.006, 0.26, 0.002), M.receiver, 0, -0.0315, -0.365);

    const slots = [];
    for (let i = 0; i < 5; i++) {
      const z = -0.265 - i * 0.048;
      slots.push({ p: [-0.0258, -0.002, z] });
      slots.push({ p: [0.0258, -0.002, z] });
    }
    for (let i = 0; i < 4; i++) slots.push({ p: [0, -0.0305, -0.29 - i * 0.052], r: [0, 0, Math.PI / 2] });
    repeatPart(body, new THREE.BoxGeometry(0.0045, 0.014, 0.03), M.blackSteel, slots);

    /* ------------------------------------------------------------- top rail */
    part(body, new THREE.BoxGeometry(0.024, 0.006, 0.52), M.receiver, 0, 0.029, -0.243);
    const teeth = [];
    for (let i = 0; i < 25; i++) teeth.push({ p: [0, 0.0345, 0.008 - i * 0.021] });
    repeatPart(body, new THREE.BoxGeometry(0.026, 0.0042, 0.012), M.receiverMatte, teeth);

    /* --------------------------------------------------------- barrel + muzzle */
    part(body, cylGeo(0.0093, 0.0102, 0.135, 18), M.barrelSteel, 0, 0, -0.573, Math.PI / 2);
    part(body, cylGeo(0.0116, 0.0116, 0.007, 16), M.blackSteel, 0, 0, -0.545, Math.PI / 2);
    part(body, cylGeo(0.0112, 0.0112, 0.006, 16), M.blackSteel, 0, 0, -0.6, Math.PI / 2);
    part(body, rbox(0.024, 0.028, 0.042, 0.004), M.receiverMatte, 0, 0.011, -0.505);
    part(body, cylGeo(0.0035, 0.0035, 0.25, 6), M.blackSteel, 0, 0.024, -0.38, Math.PI / 2);
    // muzzle brake (birdcage)
    part(body, cylGeo(0.0148, 0.0158, 0.07, 16), M.barrelSteel, 0, 0, -0.668, Math.PI / 2);
    part(body, cylGeo(0.0165, 0.0165, 0.006, 16), M.blackSteel, 0, 0, -0.636, Math.PI / 2);
    part(body, cylGeo(0.0152, 0.0152, 0.005, 16), M.wornSteel, 0, 0, -0.699, Math.PI / 2);
    const ports = [];
    for (let i = 0; i < 3; i++) ports.push({ p: [0, 0, -0.652 - i * 0.016] });
    repeatPart(body, new THREE.BoxGeometry(0.032, 0.013, 0.007), M.blackSteel, ports);
    part(body, cylGeo(0.0095, 0.0095, 0.01, 10), M.blackSteel, 0, 0, -0.7035, Math.PI / 2);

    // folded front back-up sight
    part(body, rbox(0.028, 0.008, 0.036, 0.003), M.receiverMatte, 0, 0.041, -0.462);
    part(body, rbox(0.024, 0.006, 0.03, 0.002), M.receiverMatte, 0, 0.048, -0.466);

    /* ---------------------------------------------------- holographic sight */
    // mount + throw-lever clamp
    part(body, rbox(0.042, 0.012, 0.1, 0.004), M.hoodMatte, 0, 0.041, -0.068);
    part(body, rbox(0.05, 0.013, 0.028, 0.003), M.hoodMatte, 0, 0.034, -0.068);
    part(body, rbox(0.005, 0.016, 0.03, 0.002), M.receiverMatte, 0.027, 0.049, -0.06, 0.35, 0, 0);
    // hollow window: four slim bars + top hood. Nothing closes the front or
    // back, so the red reticle reads against the world through the glass.
    part(body, new THREE.BoxGeometry(0.046, 0.005, 0.056), M.hoodMatte, 0, 0.0695, -0.068);
    part(body, new THREE.BoxGeometry(0.046, 0.005, 0.056), M.hoodMatte, 0, 0.1065, -0.068);
    part(body, new THREE.BoxGeometry(0.005, 0.042, 0.056), M.hoodMatte, -0.0195, 0.088, -0.068);
    part(body, new THREE.BoxGeometry(0.005, 0.042, 0.056), M.hoodMatte, 0.0195, 0.088, -0.068);
    // hood: matte top cover with a recessed rib (no bright flat top face)
    part(body, new THREE.BoxGeometry(0.05, 0.006, 0.075), M.hoodMatte, 0, 0.1125, -0.079);
    part(body, new THREE.BoxGeometry(0.042, 0.0012, 0.068), M.hoodMatte, 0, 0.1158, -0.079);
    // rear / front glass
    const rearGlass = part(body, new THREE.PlaneGeometry(0.033, 0.031), M.glass, 0, 0.088, -0.0362);
    rearGlass.renderOrder = 3; rearGlass.userData.noMerge = true;
    const frontGlass = part(body, new THREE.PlaneGeometry(0.032, 0.03), M.glass, 0, 0.088, -0.0965);
    frontGlass.renderOrder = 2; frontGlass.userData.noMerge = true;
    // red reticle just in front of the rear pane, ring ≈ 53% of window height
    const reticle = part(body, new THREE.PlaneGeometry(0.026, 0.026), M.reticleMat, 0, 0.088, -0.0348);
    reticle.renderOrder = 5; reticle.userData.noMerge = true;
    reticleMesh = reticle;
    // brightness buttons
    repeatPart(body, cylGeo(0.0042, 0.0042, 0.005, 8), M.rubber, [
      { p: [-0.0245, 0.078, -0.052], r: [0, 0, Math.PI / 2] },
      { p: [-0.0245, 0.078, -0.041], r: [0, 0, Math.PI / 2] },
    ]);

    /* ------------------------------------------------------ charging handle */
    chargeHandle = new THREE.Group();
    const chBody = new THREE.Mesh(rbox(0.032, 0.011, 0.03, 0.003), M.receiver);
    chBody.position.set(0, 0.021, 0.003);
    const chLatch = new THREE.Mesh(rbox(0.017, 0.008, 0.022, 0.002), M.receiverMatte);
    chLatch.position.set(0.02, 0.021, 0.007);
    chargeHandle.add(chBody, chLatch);
    gun.add(chargeHandle);

    /* ---------------------------------------------------------- magazine */
    magInner.children.length = 0;
    const magUpper = new THREE.Mesh(rbox(0.026, 0.075, 0.062, 0.004), F);
    magUpper.position.set(0, -0.044, -0.004);
    magUpper.rotation.x = 0.02;
    const magMid = new THREE.Mesh(rbox(0.025, 0.07, 0.06, 0.004), F);
    magMid.position.set(0, -0.104, -0.018);
    magMid.rotation.x = 0.07;
    const magLower = new THREE.Mesh(rbox(0.024, 0.052, 0.058, 0.004), F);
    magLower.position.set(0, -0.157, -0.038);
    magLower.rotation.x = 0.14;
    const magFloor = new THREE.Mesh(rbox(0.028, 0.008, 0.062, 0.003), M.rubber);
    magFloor.position.set(0, -0.186, -0.05);
    magFloor.rotation.x = 0.16;
    magInner.add(magUpper, magMid, magLower, magFloor);
    const ribs = [];
    for (let i = 0; i < 3; i++) {
      ribs.push({ p: [-0.0128, -0.07 - i * 0.038, -0.012 - i * 0.01] });
      ribs.push({ p: [0.0128, -0.07 - i * 0.038, -0.012 - i * 0.01] });
    }
    repeatPart(magInner, new THREE.BoxGeometry(0.0015, 0.006, 0.05), M.rubber, ribs);

    /* --------------------------------------------------------------- sling */
    const slingCurve = new THREE.CatmullRomCurve3([
      pv(0.03, -0.002, 0.255),
      pv(0.055, -0.07, 0.15),
      pv(0.048, -0.115, 0.0),
      pv(0.012, -0.1, -0.22),
      pv(-0.032, -0.04, -0.36),
      pv(-0.04, -0.028, -0.43),
    ]);
    part(body, new THREE.TubeGeometry(slingCurve, 34, 0.0055, 6, false), M.sling);
    part(body, new THREE.TorusGeometry(0.008, 0.0021, 6, 12), M.wornSteel, 0.03, -0.002, 0.255, 0, Math.PI / 2, 0);
    part(body, new THREE.TorusGeometry(0.008, 0.0021, 6, 12), M.wornSteel, -0.04, -0.028, -0.43, 0, Math.PI / 2, 0);
    part(body, rbox(0.01, 0.018, 0.026, 0.002), M.blackSteel, 0.052, -0.075, 0.105, 0.3);

    // stencil markings (facing the camera-side flank)
    const decal = part(body, new THREE.PlaneGeometry(0.062, 0.031), M.stencil, -0.0214, -0.006, 0.214, 0, -Math.PI / 2, 0);
    decal.renderOrder = 4; decal.userData.noMerge = true;
    const decal2 = part(body, new THREE.PlaneGeometry(0.045, 0.0225), M.stencil, -0.0224, -0.098, -0.072, 0, -Math.PI / 2, 0);
    decal2.renderOrder = 4; decal2.userData.noMerge = true;

    /* -------------------------------------------------------------- screws */
    const screws = [];
    for (const [x, y, z] of [
      [0.015, 0.051, -0.108], [-0.015, 0.051, -0.108],
      [0.015, 0.051, -0.03], [-0.015, 0.051, -0.03],
      [-0.024, 0.0, -0.3], [0.024, 0.0, -0.3],
      [-0.024, 0.0, -0.414], [0.024, 0.0, -0.414],
      [0.019, -0.06, 0.19], [-0.019, -0.06, 0.19],
    ]) screws.push({ p: [x, y, z], r: [0, 0, Math.PI / 2] });
    repeatPart(body, cylGeo(0.0024, 0.0024, 0.003, 6), M.blackSteel, screws);

    /* ------------------------------------------------- right (trigger) hand */
    buildTriggerHand(body);

    return { body, stock: stockParts };
  }

  /* ------------------------------------------------------------- right hand */
  // authored in gun space, then merged into the static body (it does not move)
  function buildTriggerHand(parent) {
    const G = M.glove, GD = M.gloveDark, P = M.glovePad, C = M.cuff, S = M.sleeve;

    // back of hand: 3.5 cm thick, 7.8 cm across the knuckles, 7.6 cm long
    part(parent, rbox(0.035, 0.078, 0.076, 0.014), G, 0.032, -0.126, 0.06, -0.26, 0.12, -0.16);
    part(parent, rbox(0.013, 0.056, 0.028, 0.007), P, 0.05, -0.126, 0.072, -0.2, 0.1, -0.16);
    // wrist + cuff + sleeve
    limb(parent, G, pv(0.04, -0.15, 0.074), pv(0.058, -0.188, 0.118), 0.026, 0.029, 9);
    limb(parent, C, pv(0.053, -0.178, 0.108), pv(0.064, -0.2, 0.134), 0.035, 0.038, 10);
    limb(parent, S, pv(0.062, -0.196, 0.128), pv(0.15, -0.3, 0.235), 0.029, 0.039, 12);

    // four fingers wrapping the front of the grip
    const ys = [-0.098, -0.116, -0.134, -0.152];
    ys.forEach((y, i) => {
      const spread = i * 0.0035;
      const p0 = pv(0.045 + spread, y, 0.035);
      const p1 = pv(0.018 + spread * 0.6, y - 0.002, 0.024);
      const p2 = pv(0.0, y - 0.005, 0.008);
      bone(parent, G, p0, p1, 0.018, 0.021, 0.007);
      bone(parent, GD, p1, p2, 0.0165, 0.019, 0.007);
      part(parent, rbox(0.014, 0.016, 0.013, 0.006), P, 0.05 + spread, y, 0.043, 0, 0, 0.18);
    });

    // thumb on the left flank, darker tip
    bone(parent, G, pv(0.004, -0.101, 0.03), pv(-0.026, -0.08, 0.024), 0.016, 0.016, 0.006);
    bone(parent, GD, pv(-0.026, -0.08, 0.024), pv(-0.03, -0.06, 0.044), 0.0145, 0.014, 0.006);
  }

  /* -------------------------------------------------------------- left hand */
  // C-clamp support grip; built in gun space, merged, then hung under a pivot so
  // the reload animation can move it to the magwell.
  function buildSupportHand() {
    const inner = new THREE.Group(); // unparented → identity matrix
    inner.position.set(0, -0.006, -0.175);
    const G = M.glove, GD = M.gloveDark, P = M.glovePad, C = M.cuff, S = M.sleeve;

    // palm: 3.4 cm thick, 7.4 cm tall, 8.6 cm along the handguard
    part(inner, rbox(0.03, 0.066, 0.08, 0.013), G, -0.043, -0.016, -0.357, 0.06, 0.04, 0.28);
    part(inner, rbox(0.013, 0.05, 0.05, 0.007), P, -0.061, -0.02, -0.357, 0.06, 0.04, 0.28);

    // fingers wrap over the top toward the right side
    const zs = [-0.331, -0.355, -0.379, -0.403];
    zs.forEach((z) => {
      const p0 = pv(-0.033, 0.002, z);
      const p1 = pv(-0.006, 0.031, z + 0.002);
      const p2 = pv(0.019, 0.012, z + 0.002);
      bone(inner, G, p0, p1, 0.0185, 0.0215, 0.007);
      bone(inner, GD, p1, p2, 0.017, 0.0195, 0.007);
      part(inner, rbox(0.014, 0.013, 0.015, 0.006), P, 0.006, 0.0375, z + 0.002);
    });

    // thumb thrown forward over the top
    bone(inner, G, pv(-0.028, 0.018, -0.334), pv(-0.016, 0.042, -0.306), 0.016, 0.016, 0.006);
    bone(inner, GD, pv(-0.016, 0.042, -0.306), pv(0.0, 0.032, -0.286), 0.0145, 0.014, 0.006);

    // wrist / cuff / sleeve — forearm r 3.3→4.7 cm, exits bottom-left
    limb(inner, G, pv(-0.052, -0.046, -0.33), pv(-0.076, -0.088, -0.292), 0.022, 0.025, 9);
    limb(inner, C, pv(-0.07, -0.078, -0.3), pv(-0.086, -0.104, -0.272), 0.029, 0.032, 10);
    limb(inner, S, pv(-0.086, -0.104, -0.272), pv(-0.29, -0.26, -0.20), 0.016, 0.024, 12);

    const merged = mergeStatic(inner);
    leftPivot = new THREE.Group();
    leftPivot.position.copy(LEFT_REST);
    merged.position.copy(LEFT_REST).multiplyScalar(-1);
    leftPivot.add(merged);
    gun.add(leftPivot);
  }

  /* -------------------------------------------------------------- assembly */
  const built = buildRifle('black');
  const mergedBody = mergeStatic(built.body);
  mergedBody.name = 'rifle';
  gun.add(mergedBody);

  /* ------------------------------------------------------------------ M870
     A separate silhouette so 3 can be a real shotgun: long barrel + tube
     magazine, walnut stock/forend, sliding pump, bead sight. */
  const PUMP_REST_Z = -0.30;
  function buildShotgun() {
    const body = new THREE.Group();
    const wood = M.furnitureFor('wood');
    // receiver + top tang
    part(body, rbox(0.048, 0.052, 0.20, 0.006), M.receiver, 0, -0.004, -0.06);
    part(body, rbox(0.04, 0.014, 0.22, 0.004), M.blackSteel, 0, 0.022, -0.06);
    // barrel (axis along z) + magazine tube + muzzle
    part(body, cylGeo(0.0115, 0.0115, 0.50, 12), M.blackSteel, 0, 0.021, -0.40, Math.PI / 2);
    part(body, cylGeo(0.0098, 0.0098, 0.46, 12), M.blackSteel, 0, -0.006, -0.38, Math.PI / 2);
    part(body, cylGeo(0.0105, 0.0105, 0.055, 12), M.wornSteel, 0, 0.021, -0.665, Math.PI / 2);
    // barrel band + bead
    part(body, rbox(0.052, 0.036, 0.02, 0.004), M.blackSteel, 0, 0.006, -0.60);
    part(body, new THREE.SphereGeometry(0.0055, 8, 6), M.wornSteel, 0, 0.038, -0.655);
    // walnut buttstock + grip + butt pad
    part(body, rbox(0.042, 0.078, 0.20, 0.012), wood, 0, -0.030, 0.115, -0.07);
    part(body, rbox(0.046, 0.086, 0.024, 0.008), M.rubber, 0, -0.046, 0.215, -0.07);
    part(body, rbox(0.038, 0.072, 0.075, 0.010), wood, 0, -0.062, 0.006, 0.28);
    // trigger guard + trigger
    part(body, rbox(0.03, 0.008, 0.07, 0.003), M.blackSteel, 0, -0.092, -0.006);
    part(body, rbox(0.008, 0.022, 0.012, 0.002), M.wornSteel, 0, -0.080, -0.014, 0.2);
    // pump slide (animated along z)
    const pump = new THREE.Group();
    pump.position.set(0, -0.030, PUMP_REST_Z);
    part(pump, rbox(0.056, 0.050, 0.18, 0.014), wood);
    for (let i = 0; i < 5; i++) {
      part(pump, rbox(0.058, 0.006, 0.008, 0.002), M.rubber, 0, 0.012, -0.06 + i * 0.03);
    }
    body.add(pump);
    // right hand bridges from the AR grip to the shotgun grip
    const handHost = new THREE.Group();
    handHost.position.set(0, 0.052, -0.055);
    buildTriggerHand(handHost);
    body.add(handHost);
    body.userData.pump = pump;
    return body;
  }
  const shotgunGroup = new THREE.Group();
  shotgunGroup.name = 'shotgun';
  const shotgunBody = buildShotgun();
  shotgunGroup.add(shotgunBody);
  shotgunGroup.visible = false;
  gun.add(shotgunGroup);
  const pumpGroup = shotgunBody.userData.pump;

  stockGroup = mergeStatic(built.stock);
  stockGroup.name = 'stock';
  gun.add(stockGroup);

  const mergedMag = mergeStatic(magInner);
  magGroup.add(mergedMag);

  buildSupportHand();

  // Overlay gun is authored at 1:1 in metres, then scaled down a touch so the
  // silhouette sits in the classic 30-35 % hip-fire footprint.
  gun.scale.setScalar(GUN_SCALE);

  gun.traverse((o) => {
    if (o.isMesh && o.material === M.polymer) furnitureHosts.push(o);
  });

  /* --------------------------------------------------------------- muzzle fx */
  const sprites = engineMats && engineMats.sprites ? engineMats.sprites : null;
  const flashMat = new THREE.SpriteMaterial({
    map: sprites ? sprites.flash : null,
    color: 0xfff1d2, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, toneMapped: false, opacity: 0,
  });
  const flashSprite = new THREE.Sprite(flashMat);
  flashSprite.scale.setScalar(0.34);
  flashSprite.position.copy(muzzleAnchor.position);
  flashSprite.visible = false;
  gun.add(flashSprite);

  const glowMat = new THREE.SpriteMaterial({
    map: sprites ? sprites.glow : null,
    color: 0xffb066, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, toneMapped: false, opacity: 0,
  });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.setScalar(0.2);
  glowSprite.position.copy(muzzleAnchor.position);
  glowSprite.visible = false;
  gun.add(glowSprite);

  muzzleLight.position.copy(muzzleAnchor.position);
  gun.add(muzzleLight);

  const smokeSprites = [];
  for (let i = 0; i < 2; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sprites ? sprites.smoke : null,
      color: 0xb8b0a2, transparent: true, depthWrite: false, toneMapped: false, opacity: 0,
    }));
    s.visible = false;
    scene.add(s);
    smokeSprites.push({ s, life: 0, vel: new THREE.Vector3() });
  }

  const shellGeo = new THREE.CylinderGeometry(0.0034, 0.0041, 0.018, 6);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xb08a3e, metalness: 0.95, roughness: 0.28, envMapIntensity: 1.4 });
  const shells = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(shellGeo, shellMat);
    m.visible = false;
    m.rotation.z = Math.PI / 2;
    scene.add(m);
    shells.push({ m, life: 0, vel: new THREE.Vector3(), rot: new THREE.Vector3() });
  }

  /* --------------------------------------------------------------- animation */
  const ADS_POS = new THREE.Vector3(0, 0, -ADS_DIST)
    .sub(OPTIC.clone().multiplyScalar(GUN_SCALE).applyEuler(ADS_ROT));

  const state = {
    time: 0,
    ads: 0, adsTarget: 0,
    sprint: 0, sprintTarget: 0,
    dead: false, deadAmt: 0,
    bobT: 0, speed: 0,
    sway: new THREE.Vector2(), swayTarget: new THREE.Vector2(),
    recoilPos: new THREE.Vector3(), recoilVel: new THREE.Vector3(),
    recoilRot: new THREE.Vector3(), recoilRotVel: new THREE.Vector3(),
    reloading: false, reloadT: 0, reloadDur: RELOAD_DUR,
    inspectT: 0, inspectDur: INSPECT_DUR,
    flashT: 0,
    fov: BASE_FOV,
    swap: 0, swapTarget: 0,       // 0 = up, 1 = lowered (weapon swap)
    shotgun: false, noOptic: false,
    pumpT: 0, pumpDur: 0.34,
  };

  const _p = new THREE.Vector3();
  const _r = new THREE.Euler(0, 0, 0, 'YXZ');
  const _magRestY = magGroup.position.y;

  function fire(strength = 1) {
    if (state.reloading || state.dead) return;
    state.recoilVel.z += 0.85 * strength;
    state.recoilVel.y += 0.2 * strength;
    state.recoilVel.x += (Math.random() - 0.5) * 0.12 * strength;
    state.recoilRotVel.x += 1.55 * strength;
    state.recoilRotVel.y += (Math.random() - 0.5) * 0.7 * strength;
    state.recoilRotVel.z += (Math.random() - 0.5) * 1.0 * strength;

    state.flashT = 0.045;
    flashSprite.visible = true;
    glowSprite.visible = true;
    flashSprite.material.rotation = Math.random() * Math.PI * 2;
    const s = 0.24 + Math.random() * 0.14;
    flashSprite.scale.set(s * (0.75 + Math.random() * 0.6), s, 1);
    glowSprite.scale.setScalar(s * 0.95);
    muzzleLight.intensity = 9 + Math.random() * 5;

    const puff = smokeSprites.find((p) => p.life <= 0) || smokeSprites[0];
    puff.life = 0.7;
    puff.s.visible = true;
    gun.updateWorldMatrix(true, true);
    muzzleAnchor.getWorldPosition(puff.s.position);
    puff.vel.set((Math.random() - 0.5) * 0.3, 0.08 + Math.random() * 0.1, -0.45);
    puff.s.scale.setScalar(0.05);
    puff.s.material.opacity = 0.2;

    if (state.shotgun) state.pumpT = state.pumpDur;
    const sh = shells.find((x) => x.life <= 0) || shells[0];
    sh.life = 1.0;
    sh.m.visible = true;
    const ep = new THREE.Vector3(0.045, 0.03, -0.07);
    gun.localToWorld(ep);
    sh.m.position.copy(ep);
    sh.vel.set(1.25 + Math.random() * 0.5, 1.0 + Math.random() * 0.5, 0.35 + Math.random() * 0.4);
    sh.rot.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
  }

  function startReload() {
    if (state.reloading || state.dead) return;
    state.reloading = true;
    state.reloadT = 0;
  }

  function inspect() {
    if (state.inspectT > 0 || state.reloading) return;
    state.inspectT = INSPECT_DUR;
  }

  function setWeapon(variant) {
    const F = M.furnitureFor(variant);
    for (const m of furnitureHosts) m.material = F;
    const shot = variant === 'wood';
    state.shotgun = shot;
    state.noOptic = shot;
    mergedBody.visible = !shot;
    if (stockGroup) stockGroup.visible = !shot && state.ads < 0.65;
    magGroup.visible = !shot;
    shotgunGroup.visible = shot;
  }

  /** 0 = weapon up, 1 = lowered (used by the swap transition) */
  function setSwap(t) {
    state.swapTarget = Math.max(0, Math.min(1, t));
  }

  function setAspect(aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  function integrateSpring(pos, vel, K, D, dt) {
    vel.addScaledVector(pos, -K * dt);
    vel.addScaledVector(vel, -D * dt);
    pos.addScaledVector(vel, dt);
  }

  /* ------------------------------------------------------------------ update */
  function update(dt, opts = {}) {
    dt = Math.min(dt, 0.05);
    state.time += dt;
    state.speed = opts.speed ?? 0;
    state.dead = !!opts.dead;
    state.sprintTarget = opts.sprinting ? 1 : 0;
    state.adsTarget = opts.ads && !opts.sprinting && !state.reloading && !state.dead ? 1 : 0;

    if (state.reloading) {
      state.reloadT += dt;
      if (state.reloadT >= state.reloadDur) {
        state.reloading = false;
        state.reloadT = 0;
      }
    }
    if (state.inspectT > 0) state.inspectT = Math.max(0, state.inspectT - dt);

    // smooth blends
    state.ads += (state.adsTarget - state.ads) * (1 - Math.pow(0.000035, dt));
    if (Math.abs(state.adsTarget - state.ads) < 1e-4) state.ads = state.adsTarget;
    state.sprint += (state.sprintTarget - state.sprint) * (1 - Math.pow(0.0002, dt));
    state.deadAmt += ((state.dead ? 1 : 0) - state.deadAmt) * (1 - Math.pow(0.0005, dt));

    // look sway
    if (opts.lookDX !== undefined) {
      state.swayTarget.x = THREE.MathUtils.clamp(-opts.lookDX * 0.0006, -0.05, 0.05);
      state.swayTarget.y = THREE.MathUtils.clamp(opts.lookDY * 0.0006, -0.05, 0.05);
    }
    state.sway.x += (state.swayTarget.x - state.sway.x) * (1 - Math.pow(0.002, dt));
    state.sway.y += (state.swayTarget.y - state.sway.y) * (1 - Math.pow(0.002, dt));
    state.swayTarget.multiplyScalar(1 - dt * 5);

    const ads = state.ads;
    const poseAds = ads * ads * (3 - 2 * ads);   // eased blend, exact at both ends
    const settle = 1 - poseAds;                  // 0 when fully aimed
    const sprint = state.sprint;
    const dead = state.deadAmt;
    const speed = THREE.MathUtils.clamp(state.speed, 0, 1.4);

    // walk bob + breathing, both forced to zero at full ADS so the reticle sits
    // exactly on the optical axis
    state.bobT += dt * (7.4 + speed * 3.2);
    const bobAmp = speed * 0.0085 * settle * (1 + sprint * 0.7);
    const bobX = Math.sin(state.bobT) * bobAmp;
    const bobY = -Math.abs(Math.cos(state.bobT)) * bobAmp * 0.85;
    const breath = state.time * 1.35;
    const breathAmp = 0.0024 * settle * settle;
    const breathY = Math.sin(breath) * breathAmp;
    const breathX = Math.sin(breath * 0.63 + 0.9) * breathAmp * 0.6;
    const swayX = state.sway.x * (1 - 0.75 * poseAds);
    const swayY = state.sway.y * (1 - 0.75 * poseAds);

    // sprint: tuck the carbine diagonally across the chest
    const spPosX = 0.02 * sprint, spPosY = -0.055 * sprint, spPosZ = 0.08 * sprint;
    const spRotX = 0.2 * sprint, spRotY = 0.5 * sprint, spRotZ = -0.3 * sprint;

    // reload pose: roll the weapon inboard so the magwell faces the camera
    let rlPosX = 0, rlPosY = 0, rlPosZ = 0;
    let rlRotX = 0, rlRotY = 0, rlRotZ = 0;
    let magY = 0, magRot = 0, magVisible = true;
    let chPull = 0;
    let handReload = 0;
    if (state.reloading) {
      const t = THREE.MathUtils.clamp(state.reloadT / state.reloadDur, 0, 1);
      const env = smoothstep(0, 0.13, t) * (1 - smoothstep(0.86, 1, t));
      rlRotX = 0.32 * env;
      rlRotY = -0.4 * env;
      rlRotZ = 0.6 * env;
      rlPosX = 0.03 * env;
      rlPosY = -0.03 * env;
      rlPosZ = 0.055 * env;

      // magazine out, free-fall, new magazine pushed home
      if (t >= 0.16 && t < 0.36) {
        const u = easeIn((t - 0.16) / 0.2);
        magY = -0.42 * u;
        magRot = -0.7 * u;
      } else if (t >= 0.36 && t < 0.5) {
        magY = -0.44; magRot = -0.8; magVisible = false;
      } else if (t >= 0.5 && t < 0.74) {
        const u = easeOut((t - 0.5) / 0.24);
        magY = -0.36 * (1 - u);
        magRot = -0.3 * (1 - u);
      }
      handReload = smoothstep(0.1, 0.2, t) * (1 - smoothstep(0.68, 0.82, t));
      if (t > 0.78 && t < 0.9) {
        const u = (t - 0.78) / 0.12;
        chPull = Math.sin(u * Math.PI) * 0.052;
      }
    }
    magGroup.position.y = _magRestY + magY;
    magGroup.rotation.x = magRot;
    for (const c of magGroup.children) c.visible = magVisible;
    if (chargeHandle) chargeHandle.position.z = chPull;
    if (leftPivot) {
      leftPivot.position.copy(LEFT_REST);
      leftPivot.position.x += 0.035 * handReload;
      leftPivot.position.y += 0.012 * handReload;
      leftPivot.position.z += 0.3 * handReload;
      leftPivot.rotation.set(0.15 * handReload, -0.25 * handReload, -0.2 * handReload);
    }

    // buttstock is behind the eye in ADS → cull it to avoid near-plane artefacts
    if (stockGroup) stockGroup.visible = !state.shotgun && state.ads < 0.65;
    // holographic reticle only exists once the sight is actually up
    if (reticleMesh) {
      const show = state.ads >= 0.8 && !state.noOptic;
      reticleMesh.visible = show;
      M.reticleMat.opacity = show ? 0.95 * smoothstep(0.8, 0.92, state.ads) : 0;
    }

    // inspect: rotate the weapon to show the optic and receiver from both sides
    let insRotX = 0, insRotY = 0, insRotZ = 0, insY = 0;
    if (state.inspectT > 0) {
      const t = 1 - state.inspectT / state.inspectDur;
      const env = Math.pow(Math.sin(Math.PI * THREE.MathUtils.clamp(t * 1.04, 0, 1)), 0.75);
      insRotY = env * 1.2;
      insRotX = env * 0.36;
      insRotZ = env * 0.3;
      insY = env * 0.022;
    }

    // swap (lower/raise) + pump slide
    state.swap += (state.swapTarget > state.swap ? 1 : -1) * Math.min(Math.abs(state.swapTarget - state.swap), dt * 5.5);
    if (state.pumpT > 0) {
      state.pumpT = Math.max(0, state.pumpT - dt);
      const u = 1 - state.pumpT / state.pumpDur;
      if (pumpGroup) pumpGroup.position.z = PUMP_REST_Z + Math.sin(u * Math.PI) * 0.055;
    } else if (pumpGroup) {
      pumpGroup.position.z = PUMP_REST_Z;
    }

    // recoil springs (substepped so high K stays stable at low fps)
    const steps = dt > 0.02 ? 2 : 1;
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      integrateSpring(state.recoilPos, state.recoilVel, 165, 17, sdt);
      integrateSpring(state.recoilRot, state.recoilRotVel, 150, 16, sdt);
    }

    // ---- final transform: lerp hip → ads, then add secondary channels
    _p.copy(HIP_POS).lerp(ADS_POS, poseAds);
    _p.x += bobX + breathX + swayX + spPosX + rlPosX;
    _p.y += bobY + breathY + swayY + spPosY + rlPosY + insY * 0.4 - dead * 0.22;
    _p.z += spPosZ + rlPosZ + dead * 0.05;
    // swap: drop the weapon out of frame, then bring the new one up
    _p.y -= 0.30 * state.swap;
    _p.z += 0.08 * state.swap;
    _p.x += state.recoilPos.x;
    _p.y += state.recoilPos.y;
    _p.z += state.recoilPos.z;

    _r.set(
      THREE.MathUtils.lerp(HIP_ROT.x, ADS_ROT.x, poseAds) + swayY * 1.5 + spRotX + rlRotX + insRotX + state.recoilRot.x - dead * 0.5 + state.swap * 0.9,
      THREE.MathUtils.lerp(HIP_ROT.y, ADS_ROT.y, poseAds) + swayX * 1.5 + spRotY + rlRotY + insRotY + state.recoilRot.y,
      THREE.MathUtils.lerp(HIP_ROT.z, ADS_ROT.z, poseAds) + spRotZ + rlRotZ + insRotZ + state.recoilRot.z + dead * 0.35
    );

    gun.position.copy(_p);
    gun.rotation.copy(_r);

    // slight ADS magnification on the viewmodel camera only
    const fov = THREE.MathUtils.lerp(BASE_FOV, ADS_FOV, poseAds);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    state.fov = camera.fov;

    // muzzle flash decay
    if (state.flashT > 0) {
      state.flashT -= dt;
      const a = Math.max(0, state.flashT / 0.045);
      flashMat.opacity = a;
      glowMat.opacity = a * 0.75;
      if (state.flashT <= 0) { flashSprite.visible = false; glowSprite.visible = false; }
    } else {
      flashSprite.visible = false;
      glowSprite.visible = false;
    }
    muzzleLight.intensity *= Math.pow(0.00002, dt);
    if (muzzleLight.intensity < 0.05) muzzleLight.intensity = 0;

    // smoke + casings
    for (const p of smokeSprites) {
      if (p.life > 0) {
        p.life -= dt;
        p.s.position.addScaledVector(p.vel, dt);
        p.vel.y += 0.3 * dt;
        p.vel.multiplyScalar(1 - dt * 1.2);
        p.s.scale.setScalar(0.05 + (0.7 - p.life) * 0.14);
        p.s.material.opacity = Math.max(0, p.life / 0.7) * 0.18;
        if (p.life <= 0) p.s.visible = false;
      }
    }
    for (const s of shells) {
      if (s.life > 0) {
        s.life -= dt;
        s.vel.y -= 9.8 * dt;
        s.m.position.addScaledVector(s.vel, dt);
        s.m.rotation.x += s.rot.x * dt;
        s.m.rotation.y += s.rot.y * dt;
        s.m.rotation.z += s.rot.z * dt;
        if (s.life <= 0) s.m.visible = false;
      }
    }
  }

  /* ------------------------------------------------------------- diagnostics */
  function debug() {
    let meshes = 0, sprites = 0, tris = 0;
    const materials = new Set();
    scene.traverse((o) => {
      if (o.isSprite) sprites++;
      if (o.isMesh) {
        meshes++;
        if (o.material) materials.add(o.material.uuid);
        if (o.geometry && o.geometry.index) tris += o.geometry.index.count / 3;
        else if (o.geometry && o.geometry.attributes.position) tris += o.geometry.attributes.position.count / 3;
      }
    });
    camera.updateMatrixWorld(true);
    gun.updateWorldMatrix(true, true);
    const retW = OPTIC.clone().applyMatrix4(gun.matrixWorld);
    const ndc = retW.clone().project(camera);
    const stockW = STOCK_TIP.clone().applyMatrix4(gun.matrixWorld);

    // projected screen bounds of the weapon (for coverage / centre checks)
    const mn = new THREE.Vector2(1e9, 1e9), mx = new THREE.Vector2(-1e9, -1e9);
    const corner = new THREE.Vector3();
    const view = new THREE.Vector3();
    const pv3 = new THREE.Vector3();
    gun.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        corner.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        view.copy(corner).applyMatrix4(camera.matrixWorldInverse);
        if (view.z > -0.03) continue;
        pv3.copy(corner).project(camera);
        if (pv3.x < -1.4 || pv3.x > 1.4 || pv3.y < -1.4 || pv3.y > 1.4) continue;
        mn.x = Math.min(mn.x, pv3.x); mn.y = Math.min(mn.y, pv3.y);
        mx.x = Math.max(mx.x, pv3.x); mx.y = Math.max(mx.y, pv3.y);
      }
    });
    const screenPct = (v) => +(((v + 1) * 50).toFixed(1));
    const widthPct = +(((mx.x - mn.x) * 50).toFixed(1));
    const heightPct = +(((mx.y - mn.y) * 50).toFixed(1));
    const coversCentre = mn.x < 0 && mx.x > 0 && mn.y < 0 && mx.y > 0;

    return {
      coverage: { widthPct, heightPct, x: [screenPct(mn.x), screenPct(mx.x)], y: [screenPct(mn.y), screenPct(mx.y)] },
      coversCentre,
      meshes,
      sprites,
      materialDraws: materials.size,
      atlasMs: M.atlasMs != null ? +M.atlasMs.toFixed(1) : null,
      atlasSize: M.atlasSize ?? null,
      tris: Math.round(tris),
      ads: +state.ads.toFixed(4),
      fov: +camera.fov.toFixed(2),
      reticleNDC: [+ndc.x.toFixed(4), +ndc.y.toFixed(4)],
      reticleZ: +retW.z.toFixed(4),
      stockZ: +stockW.z.toFixed(4),
      reticleVisible: reticleMesh ? reticleMesh.visible : null,
      stockVisible: stockGroup ? stockGroup.visible : null,
      gunPos: gun.position.toArray().map((v) => +v.toFixed(4)),
      gunRot: [gun.rotation.x, gun.rotation.y, gun.rotation.z].map((v) => +v.toFixed(4)),
    };
  }

  return {
    scene, camera, root, gun,
    update, fire, startReload, inspect, setWeapon, setSwap, setAspect,
    state,
    get reloading() { return state.reloading; },
    get adsAmount() { return state.ads; },
    _debug: debug,
    // World-space muzzle point for FX: take the *real* muzzleAnchor, project it
    // through the viewmodel camera, then unproject that NDC through the main
    // camera onto a point 1.0 m in front of the player. This makes world muzzle
    // flash / tracer origins line up with the rendered weapon at any pose.
    muzzleWorld(mainCamera, out = new THREE.Vector3()) {
      const ndc = this.muzzleNDC(new THREE.Vector2());
      mainCamera.updateMatrixWorld(true);
      const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
        .unproject(mainCamera)
        .sub(mainCamera.position)
        .normalize();
      out.copy(mainCamera.position).addScaledVector(dir, 1.0);
      return out;
    },
    // NDC of the drawn muzzle in the viewmodel camera (x right, y up, [-1,1])
    muzzleNDC(out = new THREE.Vector2()) {
      gun.updateWorldMatrix(true, true);
      const v = new THREE.Vector3();
      muzzleAnchor.getWorldPosition(v);
      camera.updateMatrixWorld(true);
      v.project(camera);
      out.set(v.x, v.y);
      return out;
    },
  };
}
