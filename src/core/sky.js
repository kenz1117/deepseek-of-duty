import * as THREE from 'three';

/* =========================================================================
   Atmospheric sky: analytic sun + raymarch-free fbm clouds on a dome,
   plus a PMREM environment map generated from the same sky so PBR materials
   receive physically plausible image based lighting.
   ========================================================================= */

const vert = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uTime;
  uniform float uCloudCover;
  uniform float uSunIntensity;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.86, 0.5, -0.5, 0.86);
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = rot * p * 2.03 + 11.7;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float sunDot = max(dot(d, uSunDir), 0.0);

    // ---- base gradient: dusty horizon -> cool zenith
    float grad = pow(clamp(h, 0.0, 1.0), 0.48);
    vec3 col = mix(uHorizon, uZenith, grad);

    // ---- horizon haze band (thick dust)
    float haze = pow(1.0 - clamp(abs(h) * 3.0, 0.0, 1.0), 5.0);
    col = mix(col, uHorizon * 1.10, haze * 0.52);

    // ---- ground hemisphere (slightly warm bounce, avoids black void)
    if (h < 0.0) {
      float g = clamp(-h * 4.0, 0.0, 1.0);
      col = mix(uHorizon * 0.52, vec3(0.045, 0.04, 0.036), g);
    }

    // ---- sun disk + halo
    float disk = pow(sunDot, 4200.0);
    float halo = pow(sunDot, 30.0) * 0.14 + pow(sunDot, 5.0) * 0.05;
    col += uSunColor * (disk * 6.5 + halo) * uSunIntensity;

    // ---- clouds (only above horizon)
    if (h > 0.008) {
      vec2 p = d.xz / (h + 0.10) * 0.62;
      p += vec2(uTime * 0.0035, uTime * 0.0015);
      float base = fbm(p * 1.05);
      float detail = fbm(p * 2.7 + 4.0);
      float cover = smoothstep(0.37, 0.64, base * 1.05 - 0.12 + detail * 0.28);
      cover *= smoothstep(0.008, 0.16, h) * uCloudCover;
      float lit = smoothstep(0.15, 0.9, (base * 0.7 + detail * 0.3) + sunDot * 0.35);
      vec3 cloudShadow = mix(vec3(0.20, 0.20, 0.22), uHorizon * 0.8, 0.45);
      vec3 cloudLit = mix(uSunColor * 0.82, vec3(0.86, 0.82, 0.78), 0.35);
      vec3 cc = mix(cloudShadow, cloudLit, lit);
      cc += uSunColor * pow(sunDot, 9.0) * 0.55 * cover;
      // silver lining toward the sun
      cc += uSunColor * pow(sunDot, 3.0) * 0.07 * cover;
      col = mix(col, cc, cover * 0.92);
    }

    // ---- subtle vertical dust motes / aerial perspective in sky
    col += uHorizon * 0.03 * pow(1.0 - abs(h), 12.0);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

export function createSky(renderer, opts = {}) {
  const sunDir = new THREE.Vector3(0.12, 0.185, -0.975).normalize();
  const uniforms = {
    uSunDir: { value: sunDir.clone() },
    uSunColor: { value: new THREE.Color(1.0, 0.79, 0.55) },
    uHorizon: { value: new THREE.Color(0.56, 0.395, 0.225) },
    uZenith: { value: new THREE.Color(0.038, 0.072, 0.140) },
    uTime: { value: 0 },
    uCloudCover: { value: opts.cloudCover ?? 1.0 },
    uSunIntensity: { value: opts.sunIntensity ?? 1.0 },
  };

  const geo = new THREE.SphereGeometry(1500, 48, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.name = 'sky';

  // ---- environment map from the same sky
  let envTexture = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(
      new THREE.SphereGeometry(500, 32, 20),
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    envScene.add(envDome);
    // ground bounce card
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(480, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.16, 0.14, 0.11) })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -8;
    envScene.add(ground);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 2000);
    envTexture = rt.texture;
    pmrem.dispose();
  } catch (e) {
    console.warn('PMREM env generation failed', e);
  }

  function setPreset(p) {
    if (!p) return;
    if (p.sunDir) {
      sunDir.set(p.sunDir[0], p.sunDir[1], p.sunDir[2]).normalize();
      uniforms.uSunDir.value.copy(sunDir);
    }
    if (p.horizon) uniforms.uHorizon.value.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
    if (p.zenith) uniforms.uZenith.value.setRGB(p.zenith[0], p.zenith[1], p.zenith[2]);
    if (p.sunColor) uniforms.uSunColor.value.setRGB(p.sunColor[0], p.sunColor[1], p.sunColor[2]);
    if (p.sunIntensity !== undefined) uniforms.uSunIntensity.value = p.sunIntensity;
    if (p.cloud !== undefined) uniforms.uCloudCover.value = p.cloud;
  }

  return {
    dome,
    sunDir,
    setPreset,
    sunColor: new THREE.Color(1.0, 0.86, 0.68),
    envTexture,
    update(t) { uniforms.uTime.value = t; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
