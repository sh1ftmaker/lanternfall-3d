// Temporal AA for thin lantern strings, railings and distant bulbs (TRAA idea from webgpu_postprocessing_traa,
// written for WebGL; three's TAARenderPass re-renders the scene N times per frame, which a 3.5 M-triangle
// scene cannot afford). The camera gets a sub-pixel Halton jitter (TAAJitterPass, before the scene render),
// and TAAPass reprojects last frame's resolved image with depth + the previous view-projection (camera
// motion only: the park is static, lantern drift and trains are handled by the neighbourhood clamp),
// clamps it to the 3x3 colour range (in a tone-mapped space so HDR bulbs do not dominate) and blends.
// Works in linear HDR, before bloom and the final pass. Costs one full-res resolve + one copy.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depth.js';

const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const SEQ = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

const RESOLVE = /* glsl */`
  precision highp float; precision highp sampler2D;
  uniform sampler2D tCur, tHist, tDepth; uniform mat4 uCamWorld, uPrevVP; uniform vec2 uJitter; uniform float uAlpha, uReset;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  vec3 tm(vec3 c){ return c / (1.0 + max(c.r, max(c.g, c.b))); }
  vec3 itm(vec3 c){ return c / max(1e-4, 1.0 - max(c.r, max(c.g, c.b))); }
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
    vec3 h = off ? cur : clamp(tm(histCR(puv)), mn, mxc);
    float a = off ? 1.0 : uAlpha;
    gl_FragColor = vec4(itm(mix(h, cur, a)), cur4.a);
  }`;
const COPY = /* glsl */`precision highp float; uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }`;

export class TAAJitterPass extends Pass {
  constructor(camera, taa) { super(); this.__name = 'TAAJitter'; this.needsSwap = false; this.camera = camera; this.taa = taa; }
  render(renderer, writeBuffer, readBuffer) {
    const t = this.taa, cam = this.camera, j = SEQ[t.index++ % SEQ.length];
    t.saved.copy(cam.projectionMatrix);
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
    this.u = Object.assign(depthUniforms(), { tCur: { value: null }, tHist: { value: null }, tDepth: { value: null }, uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uJitter: { value: new THREE.Vector2() }, uAlpha: { value: 0.1 }, uReset: { value: 1 } });
    this.m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: RESOLVE, uniforms: this.u, defines: depthDefines(ctx.renderer || { capabilities: {} }), depthTest: false, depthWrite: false });
    this.mCopy = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY, uniforms: { tSrc: { value: null } }, depthTest: false, depthWrite: false });
    this.q = new FullScreenQuad(null);
    this.jitterPass = new TAAJitterPass(camera, this);
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
    const ac = renderer.autoClear; renderer.autoClear = false; this.q.render(renderer); renderer.autoClear = ac;   // keep the scene depth
    this.cur = 1 - this.cur;
    // un-jitter for everything after (bloom, final, the next frame's LOD maths) and remember this frame's VP
    cam.projectionMatrix.copy(this.saved); cam.projectionMatrixInverse.copy(this.saved).invert();
    this.prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }
  dispose() { for (const r of this.hist) r.dispose(); this.m.dispose(); this.mCopy.dispose(); this.q.dispose(); }
}
