import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* =========================================================================
   Cinematic post stack:
   Render -> Unreal bloom -> ACES tonemap/sRGB -> final grade pass
   (lens: CA, vignette, grain, sharpen, screen-space god rays, sprint zoom blur,
    damage tint, hit flash)
   ========================================================================= */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.8) },
    uSunColor: { value: new THREE.Color(1.0, 0.82, 0.6) },
    uSunVisible: { value: 1 },
    uGodrays: { value: 1 },
    uGrain: { value: 0.028 },
    uCA: { value: 0.0016 },
    uVignette: { value: 0.45 },
    uContrast: { value: 1.10 },
    uSaturation: { value: 0.90 },
    uLift: { value: new THREE.Color(0.017, 0.021, 0.030) },
    uGain: { value: new THREE.Color(1.06, 1.0, 0.935) },
    uSprint: { value: 0 },
    uDamage: { value: 0 },
    uHitFlash: { value: 0 },
    uSharpness: { value: 0.20 },
    uLowHealth: { value: 0 },
    uOpacity: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec2 uSunScreen;
    uniform vec3 uSunColor;
    uniform float uSunVisible, uGodrays, uGrain, uCA, uVignette;
    uniform float uContrast, uSaturation, uSprint, uDamage, uHitFlash, uSharpness, uLowHealth, uOpacity;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    vec3 sampleC(vec2 uv){ return texture2D(tDiffuse, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb; }

    void main(){
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---------- sprint zoom blur (radial, cheap) ----------
      vec3 c;
      if (uSprint > 0.001) {
        c = vec3(0.0);
        float total = 0.0;
        for (int i = 0; i < 5; i++) {
          float t = float(i) / 4.0;
          vec2 off = centered * (t * 0.030 * uSprint);
          float w = 1.0 - t * 0.55;
          c += sampleC(uv - off) * w;
          total += w;
        }
        c /= total;
      } else {
        c = sampleC(uv);
      }

      // ---------- chromatic aberration (radial) ----------
      float ca = uCA * (0.35 + r2 * 2.0);
      c.r = mix(c.r, sampleC(uv + centered * ca).r, 0.85);
      c.b = mix(c.b, sampleC(uv - centered * ca).b, 0.85);

      // ---------- screen space god rays ----------
      if (uGodrays > 0.001 && uSunVisible > 0.001) {
        vec2 delta = (uSunScreen - uv) * (0.90 / 14.0);
        vec2 suv = uv;
        float illum = 0.0;
        for (int i = 0; i < 14; i++) {
          vec3 s = sampleC(suv);
          float lum = dot(s, vec3(0.30, 0.55, 0.15));
          illum += max(0.0, lum - 0.80);
          suv += delta;
        }
        illum *= uSunVisible / 14.0;
        float edge = smoothstep(0.0, 0.22, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        c += uSunColor * illum * uGodrays * 0.85 * edge;
      }

      // ---------- lens: sun glow + anamorphic streak ----------
      if (uSunVisible > 0.001) {
        vec2 sp = uSunScreen;
        vec2 dv = (uv - sp) * vec2(1.0, 1.55);
        float d2 = dot(dv, dv);
        float glow = exp(-d2 * 70.0) * 0.07 + exp(-d2 * 900.0) * 0.11;
        float streak = exp(-abs(uv.y - sp.y) * 130.0) * exp(-abs(uv.x - sp.x) * 2.2) * 0.05;
        c += uSunColor * uSunVisible * (glow + streak);
      }

      // ---------- grade ----------
      c = max(c, 0.0);
      // contrast around mid grey
      c = (c - 0.5) * uContrast + 0.5;
      // lift / gain
      c = c * uGain + uLift * (1.0 - c);
      // soft highlight shoulder: roll off clipped whites instead of hard clipping
      c -= max(c - 0.86, 0.0) * 0.45;
      // split tone: cool shadows, warm highlights
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c *= mix(vec3(0.925, 1.0, 1.085), vec3(1.055, 1.0, 0.925), smoothstep(0.10, 0.80, lum));
      // saturation
      c = mix(vec3(lum), c, uSaturation);

      // ---------- unsharp mask (counteract TAA/AA softness) ----------
      if (uSharpness > 0.001) {
        vec2 px = 1.0 / uResolution;
        vec3 blur = (
          sampleC(uv + vec2(px.x, 0.0)) + sampleC(uv - vec2(px.x, 0.0)) +
          sampleC(uv + vec2(0.0, px.y)) + sampleC(uv - vec2(0.0, px.y))
        ) * 0.25;
        c += (c - blur) * uSharpness;
      }

      // ---------- vignette ----------
      float vig = smoothstep(1.30, 0.28, length(centered * vec2(1.02, 0.86)) * 1.32);
      c *= mix(1.0, vig, uVignette);

      // ---------- low health pulse ----------
      if (uLowHealth > 0.001) {
        float pulse = 0.5 + 0.5 * sin(uTime * 5.2);
        c *= 1.0 - uLowHealth * (0.18 + pulse * 0.20) * smoothstep(0.05, 0.85, r2 * 2.2);
        c.r += uLowHealth * 0.045 * pulse;
      }

      // ---------- damage vignette ----------
      if (uDamage > 0.001) {
        float edge = smoothstep(0.06, 0.62, r2 * 2.0);
        c.r = mix(c.r, min(1.25, c.r * 1.9 + 0.10), edge * uDamage * 0.85);
        c.g *= 1.0 - edge * uDamage * 0.42;
        c.b *= 1.0 - edge * uDamage * 0.48;
      }
      // ---------- hit flash ----------
      c += vec3(1.0, 0.95, 0.86) * uHitFlash * 0.07;

      // ---------- film grain (luma weighted, animated) ----------
      float g = hash(gl_FragCoord.xy + vec2(uTime * 91.7, uTime * 47.3)) - 0.5;
      float gl = hash(gl_FragCoord.xy * 0.5 + vec2(uTime * 13.1, uTime * 7.7)) - 0.5;
      float grainAmt = uGrain * (0.45 + 0.55 * (1.0 - smoothstep(0.05, 0.9, lum)));
      c += g * grainAmt;
      c += gl * grainAmt * 0.45;

      gl_FragColor = vec4(c, 1.0 * uOpacity);
    }
  `,
};

export function createPost(renderer, scene, camera, quality = 'high') {
  const q = presets(quality);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: q.msaa,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
  });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), q.bloomStrength, 0.58, 1.15);
  bloom.enabled = q.bloom;
  composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  const finalPass = new ShaderPass(FinalShader);
  finalPass.uniforms.uGrain.value = q.grain;
  finalPass.uniforms.uGodrays.value = q.godrays;
  finalPass.uniforms.uCA.value = q.ca;
  finalPass.renderToScreen = true;
  composer.addPass(finalPass);

  const state = { quality, q };

  function resize(w, h, pr) {
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    bloom.setSize(w * pr, h * pr);
    finalPass.uniforms.uResolution.value.set(w * pr, h * pr);
  }
  resize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());

  return {
    composer,
    bloom,
    finalPass,
    renderPass,
    uniforms: finalPass.uniforms,
    resize,
    render(dt) {
      finalPass.uniforms.uTime.value += dt;
      composer.render(dt);
    },
    setGrade(g) {
      if (!g) return;
      const u = finalPass.uniforms;
      if (g.contrast !== undefined) u.uContrast.value = g.contrast;
      if (g.saturation !== undefined) u.uSaturation.value = g.saturation;
      if (g.lift) u.uLift.value.setRGB(g.lift[0], g.lift[1], g.lift[2]);
      if (g.gain) u.uGain.value.setRGB(g.gain[0], g.gain[1], g.gain[2]);
      if (g.vignette !== undefined) u.uVignette.value = g.vignette;
      if (g.grain !== undefined) u.uGrain.value = g.grain;
      if (g.bloom !== undefined) bloom.strength = g.bloom;
    },
    applyQuality(next) {
      const nq = presets(next);
      state.quality = next; state.q = nq;
      bloom.enabled = nq.bloom;
      bloom.strength = nq.bloomStrength;
      finalPass.uniforms.uGrain.value = nq.grain;
      finalPass.uniforms.uGodrays.value = nq.godrays;
      finalPass.uniforms.uCA.value = nq.ca;
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(window.innerWidth, window.innerHeight);
      bloom.setSize(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
      finalPass.uniforms.uResolution.value.set(
        window.innerWidth * renderer.getPixelRatio(),
        window.innerHeight * renderer.getPixelRatio()
      );
      return nq;
    },
    get quality() { return state.quality; },
  };
}

export function presets(quality) {
  switch (quality) {
    case 'low':
      return { msaa: 0, bloom: true, bloomStrength: 0.28, godrays: 0, grain: 0.02, ca: 0, shadows: 1024, pixelRatio: 1, ssao: false };
    case 'medium':
      return { msaa: 2, bloom: true, bloomStrength: 0.38, godrays: 0.5, grain: 0.024, ca: 0.0010, shadows: 2048, pixelRatio: 1, ssao: false };
    case 'ultra':
      return { msaa: 4, bloom: true, bloomStrength: 0.46, godrays: 1.25, grain: 0.034, ca: 0.0020, shadows: 4096, pixelRatio: 2, ssao: true };
    case 'high':
    default:
      return { msaa: 4, bloom: true, bloomStrength: 0.40, godrays: 1.0, grain: 0.028, ca: 0.0016, shadows: 2048, pixelRatio: 1.5, ssao: true };
  }
}
