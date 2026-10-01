// Mip-chain bloom (Jimenez 2014, "Next generation post processing in Call of Duty"; the same scheme as
// learnopengl's physically based bloom and pmndrs' MipmapBlurPass): a 13-tap downsample chain with a soft
// threshold + Karis average on the first level, then a 3x3 tent upsample chain. Every pass runs at half
// resolution or below and there is no full-resolution pass: FinalPass adds `texture` while tone mapping.
// Optional: anamorphic streaks (a horizontal-only chain on the same prefiltered image) for the lantern bulbs.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT } from './depth.js';

const DOWN = /* glsl */`
  precision highp float; uniform sampler2D tSrc; uniform vec2 uTexel; uniform vec4 uThresh; varying vec2 vUv;
  float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  vec3 S(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
  #ifdef PREFILTER
  // soft-knee threshold (uThresh = threshold, knee, 1/(4 knee), clamp) and Karis weighting against fireflies
  vec3 pre(vec3 c){ float br = max(c.r, max(c.g, c.b)); float rq = clamp(br - uThresh.x + uThresh.y, 0.0, 2.0 * uThresh.y);
    rq = rq * rq * uThresh.z; float w = max(rq, br - uThresh.x) / max(br, 1e-4); c = min(c * w, vec3(uThresh.w)); return c; }
  vec3 K(vec3 a, vec3 b, vec3 c, vec3 d){ a = pre(a); b = pre(b); c = pre(c); d = pre(d);
    float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
    return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd); }
  #endif
  void main(){
    vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2)), d = S(vec2(-2, 0)), e = S(vec2(0)), f = S(vec2(2, 0)),
         g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2)), j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));
    #ifdef PREFILTER
      vec3 o = K(j, k, l, m) * 0.5 + (K(a, b, d, e) + K(b, c, e, f) + K(d, e, g, h) + K(e, f, h, i)) * 0.125;
    #else
      vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    #endif
    gl_FragColor = vec4(o, 1.0);
  }`;
const UP = /* glsl */`
  precision highp float; uniform sampler2D tSrc, tBase; uniform vec2 uTexel; uniform float uRadius, uBaseW; varying vec2 vUv;
  vec3 S(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
  void main(){
    vec3 t = (S(vec2(-1, 1)) + S(vec2(1, 1)) + S(vec2(-1, -1)) + S(vec2(1, -1))) * 0.0625
           + (S(vec2(0, 1)) + S(vec2(-1, 0)) + S(vec2(1, 0)) + S(vec2(0, -1))) * 0.125 + S(vec2(0)) * 0.25;
    gl_FragColor = vec4(texture2D(tBase, vUv).rgb * uBaseW + t, 1.0);
  }`;
// horizontal streak: 1D downsample / upsample on the prefiltered level
const HDOWN = /* glsl */`
  precision highp float; uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){ vec3 o = vec3(0.0);
    o += texture2D(tSrc, vUv + vec2(-3.0, 0.0) * uTexel).rgb * 0.12; o += texture2D(tSrc, vUv + vec2(-1.0, 0.0) * uTexel).rgb * 0.38;
    o += texture2D(tSrc, vUv + vec2(1.0, 0.0) * uTexel).rgb * 0.38; o += texture2D(tSrc, vUv + vec2(3.0, 0.0) * uTexel).rgb * 0.12;
    gl_FragColor = vec4(o, 1.0); }`;
const HUP = /* glsl */`
  precision highp float; uniform sampler2D tSrc, tBase; uniform vec2 uTexel; uniform float uBaseW; varying vec2 vUv;
  void main(){ vec3 o = texture2D(tSrc, vUv + vec2(-1.5, 0.0) * uTexel).rgb * 0.25 + texture2D(tSrc, vUv).rgb * 0.5 + texture2D(tSrc, vUv + vec2(1.5, 0.0) * uTexel).rgb * 0.25;
    gl_FragColor = vec4(texture2D(tBase, vUv).rgb * uBaseW + o, 1.0); }`;

// light shafts (webgl_postprocessing_godrays idea, on the bloom's bright-pass instead of an occlusion render):
// march from each pixel toward the light's screen position over the prefiltered image at 1/8 resolution.
const RAYS = /* glsl */`
  precision highp float; uniform sampler2D tSrc; uniform vec2 uLight; uniform float uDecay, uFade; varying vec2 vUv;
  void main(){
    vec2 d = (uLight - vUv) / 40.0; vec2 uv = vUv; vec3 acc = vec3(0.0); float w = 1.0;
    for (int i = 0; i < 40; i++) { uv += d; acc += texture2D(tSrc, uv).rgb * w; w *= uDecay; }
    gl_FragColor = vec4(acc * (uFade / 40.0), 1.0);
  }`;

const mat = (frag, uniforms, defines = {}) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false });

export class MipBloomPass extends Pass {
  // base: 2 = start at half resolution, 4 = quarter. levels: mips below the base.
  constructor({ base = 2, levels = 5, threshold = 1.8, knee = 0.7, radius = 1.0, strength = 0.32, streaks = false, type = THREE.HalfFloatType } = {}) {
    super();
    this.__name = 'MipBloom';
    this.needsSwap = false;
    Object.assign(this, { base, levels, threshold, knee, radius, strength, streaks, streakStrength: 0.12 });
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.down = Array.from({ length: levels }, rt);
    this.up = Array.from({ length: levels - 1 }, rt);
    this.mPre = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: new THREE.Vector4() } }, { PREFILTER: '' });
    this.mDown = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: new THREE.Vector4() } });
    this.mUp = mat(UP, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uBaseW: { value: 1 } });
    if (streaks) {
      this.sDown = Array.from({ length: 4 }, rt); this.sUp = Array.from({ length: 3 }, rt);
      this.mHDown = mat(HDOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
      this.mHUp = mat(HUP, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uBaseW: { value: 1 } });
      this.combine = rt();
      this.mAdd = mat(/* glsl */`precision highp float; uniform sampler2D tA, tB; uniform float uW; varying vec2 vUv;
        void main(){ gl_FragColor = vec4(texture2D(tA, vUv).rgb + texture2D(tB, vUv).rgb * uW * vec3(0.75, 0.85, 1.0), 1.0); }`, { tA: { value: null }, tB: { value: null }, uW: { value: 0.1 } });
    }
    this.q = new FullScreenQuad(null);
  }
  get texture() { return (this.streaks || this.rays) ? this.combine.texture : (this.up.length ? this.up[0].texture : this.down[0].texture); }
  // world-space light for shafts (the Spire beacon); call once after construction
  enableRays(worldPos, camera) {
    if (this.streaks) return;                                  // one or the other: both write `combine`
    this.rays = true; this.rayPos = worldPos.clone(); this.rayCam = camera; this.rayStrength = 0.35;
    this.rayRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.mRays = mat(RAYS, { tSrc: { value: null }, uLight: { value: new THREE.Vector2() }, uDecay: { value: 0.955 }, uFade: { value: 0 } });
    if (!this.combine) {
      this.combine = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
      this.mAdd = mat(/* glsl */`precision highp float; uniform sampler2D tA, tB; uniform float uW; varying vec2 vUv;
        void main(){ gl_FragColor = vec4(texture2D(tA, vUv).rgb + texture2D(tB, vUv).rgb * uW * vec3(0.75, 0.85, 1.0), 1.0); }`, { tA: { value: null }, tB: { value: null }, uW: { value: 0 } });
    }
    this.mAddR = mat(/* glsl */`precision highp float; uniform sampler2D tA, tB; uniform float uW; varying vec2 vUv;
      void main(){ gl_FragColor = vec4(texture2D(tA, vUv).rgb + texture2D(tB, vUv).rgb * uW, 1.0); }`, { tA: { value: null }, tB: { value: null }, uW: { value: 1 } });
    this._v = new THREE.Vector3();
  }
  setSize(w, h) {
    let x = Math.max(1, Math.round(w / this.base)), y = Math.max(1, Math.round(h / this.base));
    for (let i = 0; i < this.levels; i++) { this.down[i].setSize(x, y); if (i < this.up.length) this.up[i].setSize(x, y); x = Math.max(1, x >> 1); y = Math.max(1, y >> 1); }
    if (this.rays) { this.rayRT.setSize(Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(h / 8))); this.combine.setSize(Math.round(w / this.base), Math.round(h / this.base)); }
    if (this.streaks) {
      let sx = Math.max(1, Math.round(w / this.base)); const sy = Math.max(1, Math.round(h / this.base / 2));
      this.combine.setSize(Math.round(w / this.base), Math.round(h / this.base));
      for (let i = 0; i < 4; i++) { sx = Math.max(1, sx >> 1); this.sDown[i].setSize(sx, sy); if (i < 3) this.sUp[i].setSize(sx, sy); }
    }
  }
  _draw(renderer, m, target) { this.q.material = m; renderer.setRenderTarget(target); this.q.render(renderer); }
  render(renderer, writeBuffer, readBuffer) {
    const k = this.knee * this.threshold + 1e-4;
    this.mPre.uniforms.uThresh.value.set(this.threshold, k, 0.25 / k, 64.0);
    this.mPre.uniforms.tSrc.value = readBuffer.texture;
    this.mPre.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height).multiplyScalar(this.base / 2);
    this._draw(renderer, this.mPre, this.down[0]);
    for (let i = 1; i < this.levels; i++) {
      const s = this.down[i - 1];
      this.mDown.uniforms.tSrc.value = s.texture; this.mDown.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      this._draw(renderer, this.mDown, this.down[i]);
    }
    // upsample: up[i] = down[i] + tent(up[i+1])   (the smallest level seeds the chain)
    for (let i = this.levels - 2; i >= 0; i--) {
      const src = i === this.levels - 2 ? this.down[i + 1] : this.up[i + 1];
      const u = this.mUp.uniforms; u.tSrc.value = src.texture; u.tBase.value = this.down[i].texture;
      u.uTexel.value.set(1 / src.width, 1 / src.height); u.uRadius.value = this.radius;
      this._draw(renderer, this.mUp, this.up[i]);
    }
    if (this.streaks) {
      let src = this.down[0];
      for (let i = 0; i < 4; i++) { this.mHDown.uniforms.tSrc.value = src.texture; this.mHDown.uniforms.uTexel.value.set(1 / src.width, 0); this._draw(renderer, this.mHDown, this.sDown[i]); src = this.sDown[i]; }
      for (let i = 2; i >= 0; i--) {
        const s = i === 2 ? this.sDown[3] : this.sUp[i + 1];
        const u = this.mHUp.uniforms; u.tSrc.value = s.texture; u.tBase.value = this.sDown[i].texture; u.uTexel.value.set(1 / s.width, 0); u.uBaseW.value = 0.9;
        this._draw(renderer, this.mHUp, this.sUp[i]);
      }
      const a = this.mAdd.uniforms; a.tA.value = this.up[0].texture; a.tB.value = this.sUp[0].texture; a.uW.value = this.streakStrength / this.strength;
      this._draw(renderer, this.mAdd, this.combine);
    }
    if (this.rays) {
      const v = this._v.copy(this.rayPos).project(this.rayCam);
      const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
      // fade out as the light leaves the frame (and when it is behind the camera)
      const fade = (v.z > 1 || v.z < -1) ? 0 : this.rayStrength * THREE.MathUtils.clamp((1.6 - edge) / 0.6, 0, 1);
      const r = this.mRays.uniforms; r.tSrc.value = this.down[1].texture; r.uLight.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5); r.uFade.value = fade;
      this._draw(renderer, this.mRays, this.rayRT);
      const a = this.mAddR.uniforms; a.tA.value = this.up[0].texture; a.tB.value = this.rayRT.texture; a.uW.value = 1 / this.strength;
      this._draw(renderer, this.mAddR, this.combine);
    }
  }
  dispose() { for (const r of [...this.down, ...this.up, ...(this.sDown || []), ...(this.sUp || [])]) r.dispose(); this.combine?.dispose(); this.q.dispose(); }
}
