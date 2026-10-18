import * as THREE from 'three';

/* =========================================================================
   ATMOSPHERE — cheap world-space ambience on top of the level's static haze.

   Two draw calls total:
     1) sun-lit dust motes: GPU-animated points that wrap around the camera in
        a fixed grid, brighten when they sit inside the sun shaft, twinkle and
        drift with a light breeze. No per-frame CPU work.
     2) a camera-following haze shell (open cylinder): horizontal strata that
        fade with height, denser near the ground, warmer toward the sun and
        slowly breathing. Rendered back-side only so it never tints geometry
        closer to the camera than the shell itself.
   ========================================================================= */

const BOX = new THREE.Vector3(44, 16, 44);

export function createAtmosphere(scene, mats) {
  const group = new THREE.Group();
  group.name = 'atmosphere';
  scene.add(group);

  const fog = scene.fog;
  const fogColor = fog ? fog.color : new THREE.Color(0x5d564b);
  const fogDensity = fog ? fog.density : 0.0092;

  // match the sky rig's sun; fall back to the level's key light direction
  const sunDir = new THREE.Vector3(0.42, 0.30, -0.86).normalize();
  const sunColor = new THREE.Color(1.0, 0.86, 0.68);
  try {
    const g = window.__game;
    if (g && g.engine && g.engine.sky) {
      if (g.engine.sky.sunDir) sunDir.copy(g.engine.sky.sunDir);
      if (g.engine.sky.sunColor) sunColor.copy(g.engine.sky.sunColor);
    }
  } catch (e) { /* headless / menu boot */ }

  /* ------------------------------------------------------------ dust motes */
  const MOTE_COUNT = 1100;
  const moteGeo = new THREE.BufferGeometry();
  const basePos = new Float32Array(MOTE_COUNT * 3);
  const phase = new Float32Array(MOTE_COUNT);
  const sizes = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    basePos[i * 3] = (Math.random() - 0.5) * BOX.x;
    basePos[i * 3 + 1] = Math.random() * BOX.y;
    basePos[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    phase[i] = Math.random() * 6.2831853;
    // a few bigger flakes, most fine dust
    sizes[i] = 0.004 + Math.pow(Math.random(), 3.0) * 0.022;
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(basePos, 3));
  moteGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  moteGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  moteGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const moteMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: sunColor.clone() },
      uFogDensity: { value: fogDensity },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.5) },
      uBox: { value: BOX.clone() },
    },
    vertexShader: /* glsl */`
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uFogDensity;
      uniform float uPixelRatio;
      uniform vec3 uBox;
      varying vec3 vColor;
      varying float vAlpha;

      void main(){
        vec3 cam = cameraPosition;
        float ph = aPhase;
        vec3 p = position;
        // slow breeze + individual bob (world space, independent of camera)
        p.x += sin(uTime * 0.21 + ph * 1.7) * 0.85 + uTime * 0.11;
        p.y += sin(uTime * 0.14 + ph * 2.3) * 0.28 + uTime * 0.035;
        p.z += cos(uTime * 0.18 + ph * 1.1) * 0.85 + uTime * 0.06;

        // wrap around a grid locked to the camera so motes stay around the player
        vec3 rel = mod(p - cam + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 world = cam + rel;

        vec4 mv = modelViewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(0.15, -mv.z);
        float px = aSize * uPixelRatio * 450.0 * projectionMatrix[1][1] / depth;
        gl_PointSize = clamp(px, 0.9, 5.0);

        float dist = length(rel);
        float nearFade = smoothstep(0.7, 2.6, dist);
        float farFade = 1.0 - smoothstep(13.0, 21.0, dist);
        float twinkle = 0.55 + 0.45 * sin(uTime * 1.9 + ph * 3.7);
        vec3 viewDir = normalize(world - cam);
        float shaft = pow(max(0.0, dot(viewDir, uSunDir)), 6.0);
        float fogF = 1.0 - exp(-pow(uFogDensity * depth, 2.0));

        vAlpha = nearFade * farFade * twinkle * (0.10 + 0.85 * shaft) * (1.0 - fogF * 0.7);
        vColor = mix(vec3(0.86, 0.80, 0.70), uSunColor * 1.6, shaft);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        float a = smoothstep(0.5, 0.02, r);
        a *= a;
        if (a * vAlpha < 0.002) discard;
        gl_FragColor = vec4(vColor, a * vAlpha);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  motes.renderOrder = 1;
  group.add(motes);

  /* ------------------------------------------------------------ haze shell */
  const HAZE_R = 46, HAZE_H = 30;
  const hazeGeo = new THREE.CylinderGeometry(HAZE_R, HAZE_R, HAZE_H, 64, 1, true);
  hazeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const hazeMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: sunColor.clone() },
      uDensity: { value: 0.085 },
      uFogColor: { value: fogColor.clone() },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      varying float vH;
      varying vec3 vWorld;
      varying float vAng;
      void main(){
        vec3 p = position;
        vec3 cam = cameraPosition;
        vec3 world = vec3(cam.x + p.x, (cam.y - 1.7) + (p.y + ${(HAZE_H * 0.5).toFixed(1)}), cam.z + p.z);
        world.y += sin(uTime * 0.05) * 0.35;
        vWorld = world;
        vH = p.y + ${(HAZE_H * 0.5).toFixed(1)};
        vAng = atan(p.x, p.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uDensity;
      uniform vec3 uFogColor;
      varying float vH;
      varying vec3 vWorld;
      varying float vAng;
      void main(){
        float h = max(vH, 0.0);
        // strata: broad density bands that breathe + fine heat waviness
        float band = 0.58 + 0.42 * sin(h * 0.52 + vAng * 1.4 - uTime * 0.05);
        band *= 0.88 + 0.12 * sin(h * 2.1 + vAng * 4.0 + uTime * 0.9);
        float low = exp(-h * 0.30);
        float vertical = smoothstep(0.0, 2.0, vH) * (1.0 - smoothstep(8.0, 23.0, vH));
        float a = uDensity * (0.30 + 1.05 * low) * band * vertical;
        vec3 dir = normalize(vWorld - cameraPosition);
        float sun = max(0.0, dot(dir, uSunDir));
        vec3 col = mix(uFogColor * 0.85, uSunColor * 1.35, pow(sun, 2.2));
        col += uSunColor * pow(sun, 10.0) * 0.5;
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  const haze = new THREE.Mesh(hazeGeo, hazeMat);
  haze.frustumCulled = false;
  haze.renderOrder = 1;
  group.add(haze);

  /* ------------------------------------------------------------ api */
  let time = 0;
  function update(dt) {
    time += dt;
    moteMat.uniforms.uTime.value = time;
    hazeMat.uniforms.uTime.value = time;
    moteMat.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.5);
  }

  function setIntensity(k) {
    hazeMat.uniforms.uDensity.value = 0.085 * k;
  }

  return { update, setIntensity, group, motes, haze };
}
