// Ambient occlusion for a scene with no normals.
//
// 'lite' (the one to ship): horizon-based GTAO (the slice integral from three's GTAOShader / Intel XeGTAO),
// computed at half resolution straight from the composer's depth texture. Normals are rebuilt from depth
// (the least-discontinuous neighbour on each axis, as GTAOShader.computeNormalFromDepth does), so there
// is no second geometry pass. Radius is in metres; it is projected to pixels per pixel, so AO fades out by
// itself where the radius becomes sub-pixel (distant land), plus an explicit fade window.
// A 4x4 depth-aware blur removes the 4x4 rotation pattern; FinalPass does the depth-aware 2x upsample and
// multiplies AO into the linear HDR colour, keeping it off emissive pixels and lantern glow.
//
// The stock three.js passes ('gtaopass', 'ssao', 'sao') and N8AO ('n8') are here for comparison: they all
// need a normal + depth pre-pass (the whole 3.5 M-triangle scene again, with flatShading so the override
// material derives normals from dFdx/dFdy) except N8AO, which renders the scene itself and rebuilds normals.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depthtex.js';

const AO_FRAG = /* glsl */`
  precision highp float; precision highp sampler2D;
  uniform sampler2D tDepth; uniform vec2 uFull; uniform float uRadius, uMaxPx, uPower, uFade0, uFade1, uThin, uBias; uniform float uFrame;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  const float PI = 3.14159265, HALF_PI = 1.5707963;
  const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  vec3 P_at(ivec2 p){ p = clamp(p, ivec2(0), ivec2(uFull) - 1); return viewPos((vec2(p) + 0.5) / uFull, texelFetch(tDepth, p, 0).r); }
  float facos(float x){ float r = -0.156583 * abs(x) + HALF_PI; r *= sqrt(1.0 - abs(x)); return x >= 0.0 ? r : PI - r; }
  void main(){
    ivec2 hp = ivec2(gl_FragCoord.xy), fp = min(hp * STRIDE, ivec2(uFull) - 1);
    float d = texelFetch(tDepth, fp, 0).r;
    if (isSky(d)) { gl_FragColor = vec4(1.0, -65000.0, 0.0, 1.0); return; }
    vec3 P = viewPos((vec2(fp) + 0.5) / uFull, d);
    // normal from depth: pick the smoother side on each axis
    vec3 pl = P_at(fp - ivec2(1, 0)), pr = P_at(fp + ivec2(1, 0)), pb = P_at(fp - ivec2(0, 1)), pt = P_at(fp + ivec2(0, 1));
    vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
    vec3 dy = abs(pt.z - P.z) < abs(P.z - pb.z) ? pt - P : P - pb;
    vec3 V = normalize(-P);
    vec3 N = normalize(cross(dx, dy)); if (dot(N, V) < 0.0) N = -N;
    // world radius -> pixels (full-res)
    float rpx = uRadius * uProj[1][1] * 0.5 * uFull.y / max(-P.z, 1e-3);
    float fade = (1.0 - smoothstep(uFade0, uFade1, -P.z)) * smoothstep(1.5, 4.0, rpx);
    if (fade <= 0.0) { gl_FragColor = vec4(1.0, P.z, 0.0, 1.0); return; }
    float scale = min(1.0, uMaxPx / rpx); rpx = min(rpx, uMaxPx);
    float R = uRadius * scale;                       // the world radius actually covered after the pixel clamp
    // 4x4 interleaved noise (removed by the 4x4 blur), rotated per frame for temporal reuse
    int bi = (hp.x & 3) + 4 * (hp.y & 3);
    float noise = fract((float(BAYER[bi]) + 0.5) / 16.0 + uFrame * 0.618);
    float jitter = fract((float(BAYER[(bi + 5) & 15]) + 0.5) / 16.0 * 4.0 + uFrame * 0.381);
    float falloffRange = 0.6 * R, falloffFrom = R - falloffRange;
    float bias = uBias + 0.0015 * -P.z;
    float vis = 0.0;
    for (int s = 0; s < SLICES; s++) {
      float phi = (float(s) + noise) * PI / float(SLICES);
      vec2 omega = vec2(cos(phi), sin(phi));
      vec3 dirV = vec3(omega, 0.0);
      vec3 ortho = dirV - dot(dirV, V) * V;
      vec3 axis = normalize(cross(dirV, V));
      vec3 pn = N - axis * dot(N, axis); float pnLen = length(pn);
      float sgn = sign(dot(ortho, pn)); float cosN = clamp(dot(pn, V) / max(pnLen, 1e-4), 0.0, 1.0);
      float n = sgn * facos(cosN);
      float lo0 = cos(n + HALF_PI), lo1 = cos(n - HALF_PI);
      float h0c = lo0, h1c = lo1;
      for (int j = 0; j < STEPS; j++) {
        float t = (float(j) + jitter) / float(STEPS); t *= t;
        vec2 off = omega * max(t * rpx, float(j) + 1.0);
        vec3 s0 = P_at(fp + ivec2(off)) - P, s1 = P_at(fp - ivec2(off)) - P;
        float l0 = length(s0), l1 = length(s1);
        float c0 = dot(s0 / max(l0, 1e-4), V), c1 = dot(s1 / max(l1, 1e-4), V);
        float w0 = clamp((falloffFrom - l0) / falloffRange + 1.0, 0.0, 1.0), w1 = clamp((falloffFrom - l1) / falloffRange + 1.0, 0.0, 1.0);
        // ignore samples that barely rise above the tangent plane: stacked ground layers (mm-cm apart), quantised
        // vertex positions and depth precision would otherwise read as occluders and stripe the floors
        w0 *= smoothstep(bias, 2.0 * bias, dot(s0, N)); w1 *= smoothstep(bias, 2.0 * bias, dot(s1, N));
        h0c = max(h0c, mix(lo0, c0, w0)); h1c = max(h1c, mix(lo1, c1, w1));
      }
      // thin-occluder bias: pull horizons back a little (railings and lantern strings are not walls)
      h0c = mix(lo0, h0c, uThin); h1c = mix(lo1, h1c, uThin);
      float h0 = n + clamp(-facos(h1c) - n, -HALF_PI, HALF_PI);
      float h1 = n + clamp(facos(h0c) - n, -HALF_PI, HALF_PI);
      float a0 = (cosN + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) * 0.25;
      float a1 = (cosN + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) * 0.25;
      vis += pnLen * (a0 + a1);
    }
    vis = clamp(vis / float(SLICES), 0.0, 1.0);
    float ao = mix(1.0, pow(vis, uPower), fade);
    gl_FragColor = vec4(ao, P.z, 0.0, 1.0);
  }`;

// 4x4 depth-aware box blur at AO resolution; also blends with the previous frame when the camera holds still
const BLUR_FRAG = /* glsl */`
  precision highp float; uniform sampler2D tAO; varying vec2 vUv;
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy), mx = textureSize(tAO, 0) - 1;
    vec2 c = texelFetch(tAO, p, 0).rg;
    if (c.g < -6e4) { gl_FragColor = vec4(1.0, c.g, 0.0, 1.0); return; }
    float sum = 0.0, wsum = 0.0, tol = 0.035 * abs(c.g) + 0.05;
    for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
      vec2 s = texelFetch(tAO, clamp(p + ivec2(x, y), ivec2(0), mx), 0).rg;
      float w = max(0.0, 1.0 - abs(s.g - c.g) / tol);
      sum += s.r * w; wsum += w;
    }
    gl_FragColor = vec4(wsum > 1e-3 ? sum / wsum : c.r, c.g, 0.0, 1.0);
  }`;

// full-res depth-aware upsample, run by FinalPass via the AO_UPSAMPLE chunk below
export const AO_UPSAMPLE = /* glsl */`
  float aoUpsample(sampler2D tAO, sampler2D tDepth, vec2 uv, vec2 full){
    vec2 hres = vec2(textureSize(tAO, 0));
    float z = viewZ(uv, texture2D(tDepth, uv).r);
    vec2 h = (gl_FragCoord.xy - 0.5) * hres / full;  // AO texel i was computed at full-res pixel i * full / hres
    vec2 f = fract(h); ivec2 b = ivec2(floor(h));
    float s = 0.0, ws = 0.0, best = 1.0, bd = 1e9;
    for (int i = 0; i < 4; i++) {
      ivec2 o = ivec2(i & 1, i >> 1);
      vec2 t = texelFetch(tAO, clamp(b + o, ivec2(0), ivec2(hres) - 1), 0).rg;
      float bw = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
      float dz = abs(t.g - z);
      float w = bw / (1e-3 + dz / (0.02 * abs(z) + 0.02));
      s += t.r * w; ws += w;
      if (dz < bd) { bd = dz; best = t.r; }
    }
    return ws > 1e-4 ? s / ws : best;
  }`;

export class LiteAOPass extends Pass {
  constructor(camera, renderer, opts = {}) {
    super();
    this.__name = 'AO';
    this.camera = camera; this.needsSwap = false; this.isTextureOnly = true;
    this.half = opts.half !== false;
    this.radius = opts.radius ?? 1.5; this.power = opts.power ?? 3.0;
    this.frame = 0; this.temporal = false;
    const t = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rtAO = t(); this.rtBlur = t();
    this.uAO = Object.assign(depthUniforms(), {
      tDepth: { value: null }, uFull: { value: new THREE.Vector2() }, uRadius: { value: this.radius }, uMaxPx: { value: 90 },
      uPower: { value: this.power }, uFade0: { value: opts.fade0 ?? 140 }, uFade1: { value: opts.fade1 ?? 320 }, uThin: { value: 0.9 }, uBias: { value: 0.04 }, uFrame: { value: 0 },
    });
    this.mAO = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: AO_FRAG, uniforms: this.uAO, depthTest: false, depthWrite: false,
      defines: Object.assign({ SLICES: opts.slices ?? 2, STEPS: opts.steps ?? 4, STRIDE: this.half ? 2 : 1 }, depthDefines(renderer)) });
    this.mBlur = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR_FRAG, uniforms: { tAO: { value: this.rtAO.texture } }, depthTest: false, depthWrite: false });
    this.q = new FullScreenQuad(null);
    this.texture = this.rtBlur.texture;
  }
  setSize(w, h) {
    const s = this.half ? 2 : 1, x = Math.ceil(w / s), y = Math.ceil(h / s);
    this.rtAO.setSize(x, y); this.rtBlur.setSize(x, y);
    this.uAO.uFull.value.set(w, h);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uAO;
    if (!this._marked && this.ctx) {          // lanterns and water load after the composer is built
      const l = this.ctx.lanterns && this.ctx.lanterns(), w = this.ctx.water && this.ctx.water();
      if (l) markGlow(l.material);
      if (w) w.material.uniforms.alpha.value = 64.0;     // water: alpha >> 1 reads as "all glow", so no AO on reflections
      this._marked = !!(l && w);
    }
    u.tDepth.value = readBuffer.depthTexture;
    u.uFull.value.set(readBuffer.width, readBuffer.height);
    updateDepthUniforms(u, this.camera);
    u.uRadius.value = this.radius; u.uPower.value = this.power;
    u.uFrame.value = this.temporal ? (this.frame++ % 16) : 0;
    this.q.material = this.mAO; renderer.setRenderTarget(this.rtAO); this.q.render(renderer);
    this.q.material = this.mBlur; renderer.setRenderTarget(this.rtBlur); this.q.render(renderer);
  }
  dispose() { this.rtAO.dispose(); this.rtBlur.dispose(); this.mAO.dispose(); this.mBlur.dispose(); this.q.dispose(); }
}

// Lantern sprites are additive and write no depth: AO would darken their glow where it crosses a wall.
// Make them add their luminance to the target's alpha (opaque surfaces write 1) so FinalPass can tell
// glow from surface. Colour blending is unchanged (src + dst).
export function markGlow(material) {
  if (!material || material.userData.glowMarked) return;
  material.userData.glowMarked = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation; material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation; material.blendSrcAlpha = THREE.OneFactor; material.blendDstAlpha = THREE.OneFactor;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev && prev(sh, r);
    sh.fragmentShader = sh.fragmentShader.replace(/}\s*$/, '  gl_FragColor.a = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n}');
  };
  material.customProgramCacheKey = () => 'glowMarked';
  material.needsUpdate = true;
}

export function makeAO(kind, ctx) {
  const { renderer, scene, camera, size } = ctx;
  if (kind === 'lite' || kind === true || kind === 'gtao') {
    const p = new LiteAOPass(camera, renderer, { half: ctx.Q.fx.aohalf !== false, slices: ctx.mobile ? 2 : 2, steps: ctx.mobile ? 3 : 4 });
    p.ctx = ctx;
    return p;
  }
  const flatNormals = (m) => { m.flatShading = true; m.needsUpdate = true; };
  if (kind === 'gtaopass') {
    const p = new GTAOPass(scene, camera, size.x, size.y);
    flatNormals(p.normalMaterial);
    p.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.5, thickness: 2.0, scale: 1.0, samples: 16, distanceFallOff: 1.0 });
    p.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 8, rings: 2, samples: 16 });
    p.__name = 'GTAOPass'; return p;
  }
  if (kind === 'ssao') {
    const p = new SSAOPass(scene, camera, size.x, size.y);
    flatNormals(p.normalMaterial);
    p.kernelRadius = 1.2; p.minDistance = 0.0000005; p.maxDistance = 0.0006;
    p.__name = 'SSAOPass'; return p;
  }
  if (kind === 'sao') {
    const p = new SAOPass(scene, camera, new THREE.Vector2(size.x, size.y));
    flatNormals(p.normalMaterial);
    Object.assign(p.params, { saoBias: 0.5, saoIntensity: 0.02, saoScale: 4, saoKernelRadius: 40, saoMinResolution: 0, saoBlur: true, saoBlurRadius: 8, saoBlurStdDev: 4, saoBlurDepthCutoff: 0.01 });
    p.__name = 'SAOPass'; return p;
  }
  return null;
}
