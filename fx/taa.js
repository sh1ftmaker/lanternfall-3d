// Temporal AA for thin lantern strings, railings and distant bulbs (TRAA idea from webgpu_postprocessing_traa,
// written for WebGL; three's TAARenderPass re-renders the scene N times per frame, which a 3.5 M-triangle
// scene cannot afford). The camera gets a sub-pixel Halton jitter (TAAJitterPass, before the scene render),
// and TAAPass reprojects last frame's resolved image with depth + the previous view-projection (camera
// motion only: the park is static, lantern drift and trains are handled by the neighbourhood clamp),
// clamps it to the 3x3 colour range (in a tone-mapped space so HDR bulbs do not dominate) and blends.
// Works in linear HDR, before bloom and the final pass. Costs one full-res resolve + one copy.
// On every preset (the LanternTown lesson: pixel ratio 1 everywhere, TAA doing the smoothing; '#traa=0' only for
// debugging). Things that move without the camera (guests, the monorail, drifting lantern sprites, fireworks) have no
// motion vectors: where the history had to be clamped hard the blend leans on the current frame (uReact), so a moving
// edge leaves no trail. In the Fast / HD chain (no FinalPass) the copy back into the scene buffer adds the light
// unsharp mask FinalPass does in Cinematic ('#u_taasharp=0.3'; the history itself stays unsharpened).
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depthtex.js';

const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const SEQ = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

const RESOLVE = /* glsl */`
  precision highp float; precision highp sampler2D;
  uniform sampler2D tCur, tHist, tDepth; uniform mat4 uCamWorld, uPrevVP; uniform vec2 uJitter; uniform float uAlpha, uReset, uReact, uDepthRej;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  // blend and clamp in a compressed space so one HDR speck does not flicker, but only above uHdrK: compressing all of
  // it (K = 1) averaged a sub-pixel emitter (the monorail's light strip, 1 px or less at ratio 1) down to a fraction of
  // its energy, and its glow went with it
  uniform float uHdrK;
  vec3 tm(vec3 c){ return c / (1.0 + max(c.r, max(c.g, c.b)) / uHdrK); }
  vec3 itm(vec3 c){ return c / max(1e-4, 1.0 - max(c.r, max(c.g, c.b)) / uHdrK); }
  // 5-tap Catmull-Rom history fetch (sharper than bilinear, so the image does not go soft)
  vec3 histCR(vec2 uv){
    vec2 sz = vec2(textureSize(tHist, 0)), p = uv * sz, t1 = floor(p - 0.5) + 0.5, f = p - t1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2, tc12 = (t1 + w2 / w12) / sz, tc0 = (t1 - 1.0) / sz, tc3 = (t1 + 2.0) / sz;
    vec3 r = texture2D(tHist, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y) + texture2D(tHist, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)
           + texture2D(tHist, tc12).rgb * (w12.x * w12.y) + texture2D(tHist, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y)
           + texture2D(tHist, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);
    float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return max(r / ws, 0.0);
  }
  void main(){
    ivec2 ip = ivec2(gl_FragCoord.xy), mx = textureSize(tCur, 0) - 1;
    vec4 cur4 = texelFetch(tCur, ip, 0);
    vec3 cur = tm(cur4.rgb), mn = cur, mxc = cur, m1 = vec3(0.0), m2 = vec3(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 s = tm(texelFetch(tCur, clamp(ip + ivec2(x, y), ivec2(0), mx), 0).rgb);
      mn = min(mn, s); mxc = max(mxc, s); m1 += s; m2 += s * s;
    }
    m1 /= 9.0; vec3 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
    mn = max(mn, m1 - 1.25 * sd); mxc = min(mxc, m1 + 1.25 * sd);           // variance-tightened box
    float d = texelFetch(tDepth, ip, 0).r;
    vec3 vp = viewPos(vUv, d);                                         // uProjInv is the jittered one: exact for this pixel
    vec4 prev = uPrevVP * (uCamWorld * vec4(vp, 1.0));
    vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
    bool off = any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0))) || uReset > 0.5;
    // the history keeps each pixel's view distance in alpha: where the reprojected point was at another distance last
    // frame, something moved across it (a guest, the monorail, Wick) or it was hidden: no history there
    bool sky = isSky(d);
    float vz = sky ? 60000.0 : -vp.z;
    if (!off && uDepthRej > 0.0) {
      float pz = texelFetch(tHist, clamp(ivec2(puv * vec2(textureSize(tHist, 0))), ivec2(0), textureSize(tHist, 0) - 1), 0).a;
      if (pz >= 59000.0) off = !sky;                                                  // was sky, now something
      else if (!sky) off = abs(pz - prev.w) > uDepthRej * prev.w + 0.05;            // prev.w: its distance from last frame's camera
    }
    vec3 h0 = tm(histCR(puv)), h = off ? cur : clamp(h0, mn, mxc);
    // history far outside this frame's neighbourhood = something moved here (no motion vectors): lean on the current frame
    float clampd = length(h0 - h) / (length(mxc - mn) + 0.02);
    float a = off ? 1.0 : mix(uAlpha, 0.6, clamp(clampd * uReact, 0.0, 1.0));
    gl_FragColor = vec4(itm(mix(h, cur, a)), vz);
  }`;
const COPY = /* glsl */`precision highp float; uniform sampler2D tSrc; uniform float uSharp; varying vec2 vUv;
  void main(){ ivec2 ip = ivec2(gl_FragCoord.xy); vec4 c = texelFetch(tSrc, ip, 0);
    #ifdef SHARPEN
    // light unsharp mask in a compressed space (as FinalPass's), so bulbs do not halo
    ivec2 mx = textureSize(tSrc, 0) - 1;
    vec3 a = texelFetch(tSrc, min(ip + ivec2(1, 0), mx), 0).rgb, b = texelFetch(tSrc, max(ip - ivec2(1, 0), ivec2(0)), 0).rgb,
         e = texelFetch(tSrc, min(ip + ivec2(0, 1), mx), 0).rgb, f = texelFetch(tSrc, max(ip - ivec2(0, 1), ivec2(0)), 0).rgb;
    vec3 nb = (a + b + e + f) * 0.25, lo = min(c.rgb, min(min(a, b), min(e, f))), hi = max(c.rgb, max(max(a, b), max(e, f)));
    vec3 tc = c.rgb / (1.0 + c.rgb), tn = nb / (1.0 + nb);
    // never past the local range: an overshoot on a bulb would be an HDR spike, and bloom spreads it over the frame
    tc = clamp(tc + (tc - tn) * uSharp, lo / (1.0 + lo), hi / (1.0 + hi)); c.rgb = tc / (1.0 - tc);
    #endif
    gl_FragColor = c; }`;

export class TAAJitterPass extends Pass {
  constructor(camera, taa) { super(); this.__name = 'TAAJitter'; this.needsSwap = false; this.camera = camera; this.taa = taa; }
  render(renderer, writeBuffer, readBuffer) {
    const t = this.taa, cam = this.camera, j = SEQ[t.index++ % SEQ.length];
    t.saved.copy(cam.projectionMatrix);
    t.hideLate();
    const w = readBuffer.width, h = readBuffer.height;
    t.jitter.set(j[0] / w, j[1] / h);
    cam.projectionMatrix.elements[8] += 2 * t.jitter.x; cam.projectionMatrix.elements[9] += 2 * t.jitter.y;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
}

export class TAAPass extends Pass {
  constructor(camera, ctx = {}) {
    super();
    this.__name = 'TAA'; this.needsSwap = false; this.camera = camera;
    this.index = 0; this.saved = new THREE.Matrix4(); this.jitter = new THREE.Vector2(); this.prevVP = new THREE.Matrix4(); this.first = true;
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.hist = [rt(), rt()]; this.cur = 0;
    this.u = Object.assign(depthUniforms(), { tCur: { value: null }, tHist: { value: null }, tDepth: { value: null }, uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uJitter: { value: new THREE.Vector2() }, uAlpha: { value: 0.1 }, uReset: { value: 1 }, uReact: { value: ctx.react ?? 1 }, uDepthRej: { value: ctx.depthRej ?? 0.04 }, uHdrK: { value: hashNum('u_taahdr', 32) } });
    this.m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: RESOLVE, uniforms: this.u, defines: depthDefines(ctx.renderer || { capabilities: {} }), depthTest: false, depthWrite: false });
    this.mCopy = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY, uniforms: { tSrc: { value: null }, uSharp: { value: ctx.sharpen || 0 } }, defines: ctx.sharpen ? { SHARPEN: '' } : {}, depthTest: false, depthWrite: false });
    this.q = new FullScreenQuad(null);
    this.scene = ctx.scene || null; this.late = []; this.lateAge = 1e9; this.hidden = [];
    this.lateOn = !/(?:^|[#,&])taalate=0/.test(typeof location !== 'undefined' ? location.hash : '');
    this.jitterPass = new TAAJitterPass(camera, this);
  }
  // Additive / premultiplied glows that move on their own (paper lanterns, motes, fireworks, rain, their reflections on the lake)
  // have no depth and no motion vectors: accumulated, a drifting sprite smears into a blob. They are left out of the
  // jittered scene render and drawn after the resolve, unjittered, into the scene buffer (depth-tested against it),
  // as engines draw particles after TAA. Draw order among additive glows does not matter. '#taalate=0' compares.
  hideLate() {
    if (!this.lateOn || !this.scene) return;
    if (++this.lateAge > 30) {                                      // the set is re-collected twice a second
      this.lateAge = 0; this.late = [];
      const glow = (m) => m.blending === THREE.AdditiveBlending || (m.blending === THREE.CustomBlending && m.blendSrc === THREE.OneFactor);   // additive or premultiplied (the paper lanterns)
      const isLate = (o) => { const m = o.material; return !!m && !Array.isArray(m) && m.transparent && !m.depthWrite && glow(m) && (o.isPoints || o.isMesh); };
      this.scene.traverse((o) => { if (isLate(o)) { for (let p = o.parent; p; p = p.parent) if (isLate(p)) return; this.late.push(o); } });
    }
    for (const o of this.late) if (o.visible) { o.visible = false; this.hidden.push(o); }
  }
  drawLate(renderer, target) {
    if (!this.hidden.length) return;
    const ac = renderer.autoClear; renderer.autoClear = false; renderer.setRenderTarget(target);
    for (const o of this.hidden) { o.visible = true; renderer.render(o, this.camera); }
    renderer.autoClear = ac; this.hidden.length = 0;
  }
  setSize(w, h) { for (const r of this.hist) r.setSize(w, h); this.first = true; }
  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera, u = this.u;
    u.tCur.value = readBuffer.texture; u.tHist.value = this.hist[1 - this.cur].texture; u.tDepth.value = readBuffer.depthTexture;
    updateDepthUniforms(u, cam);                                    // jittered: matches the depth buffer
    u.uCamWorld.value.copy(cam.matrixWorld); u.uPrevVP.value.copy(this.prevVP); u.uJitter.value.copy(this.jitter);
    u.uReset.value = this.first ? 1 : 0; this.first = false;
    this.q.material = this.m; renderer.setRenderTarget(this.hist[this.cur]); this.q.render(renderer);
    this.mCopy.uniforms.tSrc.value = this.hist[this.cur].texture; this.q.material = this.mCopy; renderer.setRenderTarget(readBuffer);
    // colour only: the scene's alpha stays (FinalPass reads lantern glow from it), the history's alpha is its depth
    const gl = renderer.getContext(), cb = renderer.state.buffers.color;
    cb.setMask(true); gl.colorMask(true, true, true, false); cb.setLocked(true);                 // three would reset the mask
    const ac = renderer.autoClear; renderer.autoClear = false; this.q.render(renderer); renderer.autoClear = ac;   // keep the scene depth
    cb.setLocked(false); gl.colorMask(true, true, true, true);    // = three's cached state (setMask(true) above)
    this.cur = 1 - this.cur;
    // un-jitter for everything after (bloom, final, the next frame's LOD maths) and remember this frame's VP
    cam.projectionMatrix.copy(this.saved); cam.projectionMatrixInverse.copy(this.saved).invert();
    this.prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.drawLate(renderer, readBuffer);
  }
  dispose() { for (const r of this.hist) r.dispose(); this.m.dispose(); this.mCopy.dispose(); this.q.dispose(); }
}

// Fast / HD chain (app.js buildComposer): jitter in front of the scene render, resolve right after it, before bloom.
// The scene target needs a depth texture (app.js gives it one when Q.taa is on).
export function addTAA(composer, camera, { renderer, scene, mobile, sharpen = 0.3 } = {}) {
  const p = new TAAPass(camera, { mobile, renderer, scene, sharpen, react: hashNum('u_taareact', 1) });
  p.mCopy.uniforms.uSharp.value = hashNum('u_taasharp', sharpen);
  const i = composer.passes.findIndex((q) => q.constructor.name === 'RenderPass' || q.__name === 'Scene');
  composer.insertPass(p.jitterPass, 0); composer.insertPass(p, i + 2);
  return p;
}
function hashNum(k, d) { const m = new RegExp('(?:^|[#,&])' + k + '=([-\\d.]+)').exec(location.hash); return m ? +m[1] : d; }
