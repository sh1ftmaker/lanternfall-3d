// Tour-only "miniature" depth of field (tilt-shift look) focused on the tour's look target.
// The idea is BokehPass (webgl_postprocessing_dof) made cheap: everything runs at half resolution:
//   1. downsample HDR colour, CoC from depth in alpha (thin lens: coc = aperture * |1 - zFocus / z|)
//   2. 24-tap golden-angle gather where a sample only contributes if its own CoC reaches this pixel
//      (so a sharp subject does not smear onto a blurred background) -> rgb blurred, a = this pixel's CoC
// FinalPass mixes the blur in by CoC. A large aperture relative to the scene is what makes a model village.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depthtex.js';

const PRE = /* glsl */`
  precision highp float; precision highp sampler2D;
  uniform sampler2D tColor, tDepth; uniform float uFocus, uAperture, uMaxCoc; varying vec2 vUv;
  ${DEPTH_GLSL}
  void main(){
    vec3 c = texture2D(tColor, vUv).rgb;                       // bilinear at the half-res centre = 2x2 average
    float d = texture2D(tDepth, vUv).r;
    float z = isSky(d) ? 1e5 : -viewZ(vUv, d);
    float coc = uAperture * (1.0 - uFocus / z);                 // signed: < 0 in front of the focus plane
    coc = clamp(coc, -0.5 * uMaxCoc, uMaxCoc);                 // keep the foreground blur modest (bright bulbs smear)
    c *= 1.0 / (1.0 + 0.04 * dot(c, vec3(0.2126, 0.7152, 0.0722)));   // tame fireflies before the gather
    gl_FragColor = vec4(c, coc);
  }`;
const GATHER = /* glsl */`
  precision highp float; uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){
    vec4 c = texture2D(tSrc, vUv);
    float r0 = abs(c.a);
    vec3 acc = c.rgb; float wsum = 1.0;
    const float GA = 2.39996323;
    for (int i = 1; i < TAPS; i++) {
      float fi = float(i), rr = sqrt(fi / float(TAPS)) * MAXR;
      vec2 o = vec2(cos(fi * GA), sin(fi * GA)) * rr;
      vec4 s = texture2D(tSrc, vUv + o * uTexel);
      float rs = abs(s.a);
      // the sample's blur disc must reach us; foreground (negative CoC) may spill over sharper background
      float w = smoothstep(rr - 1.0, rr + 0.5, s.a < 0.0 ? rs : min(rs, r0 + 1.0));
      acc += s.rgb * w; wsum += w;
    }
    vec3 o = acc / wsum; o *= 1.0 / max(1e-4, 1.0 - 0.04 * dot(o, vec3(0.2126, 0.7152, 0.0722)));
    gl_FragColor = vec4(o, r0);
  }`;

export class TiltShiftPass extends Pass {
  constructor(camera, ctx) {
    super();
    this.__name = 'TiltShift'; this.needsSwap = false; this.camera = camera; this.ctx = ctx;
    this.amount = 0; this.target = 0; this.aperture = 5.5; this.maxCoc = 9;         // CoC in half-res pixels
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.a = rt(); this.b = rt();
    this.uPre = Object.assign(depthUniforms(), { tColor: { value: null }, tDepth: { value: null }, uFocus: { value: 100 }, uAperture: { value: 4 }, uMaxCoc: { value: 9 } });
    this.mPre = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: PRE, uniforms: this.uPre, defines: depthDefines(ctx.renderer), depthTest: false, depthWrite: false });
    this.mGather = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: GATHER, uniforms: { tSrc: { value: this.a.texture }, uTexel: { value: new THREE.Vector2() } },
      defines: { TAPS: ctx.mobile ? 16 : 24, MAXR: '9.0' }, depthTest: false, depthWrite: false });
    this.q = new FullScreenQuad(null);
    this._fwd = new THREE.Vector3(); this._d = new THREE.Vector3(); this._last = performance.now();
  }
  get texture() { return this.b.texture; }
  setSize(w, h) { const x = Math.ceil(w / 2), y = Math.ceil(h / 2); this.a.setSize(x, y); this.b.setSize(x, y); this.mGather.uniforms.uTexel.value.set(1 / x, 1 / y); }
  render(renderer, writeBuffer, readBuffer) {
    const now = performance.now(), dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    const cam = this.camera;
    // only on the tour, and only once the camera is up in the air (the gate walk stays sharp)
    this.target = (this.ctx.tour && this.ctx.tour()) ? THREE.MathUtils.smoothstep(cam.position.y, 16, 55) : 0;
    this.amount += (this.target - this.amount) * Math.min(1, dt * 2.5);
    if (this.amount < 0.01) { this.amount = 0; return; }
    const f = this.ctx.focus && this.ctx.focus();
    cam.getWorldDirection(this._fwd);
    const zf = f ? Math.max(5, this._d.copy(f).sub(cam.position).dot(this._fwd)) : 120;
    const u = this.uPre;
    u.tColor.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture; updateDepthUniforms(u, cam);
    u.uFocus.value = zf; u.uAperture.value = this.aperture * readBuffer.height / 800; u.uMaxCoc.value = this.maxCoc;
    this.q.material = this.mPre; renderer.setRenderTarget(this.a); this.q.render(renderer);
    this.q.material = this.mGather; renderer.setRenderTarget(this.b); this.q.render(renderer);
  }
  dispose() { this.a.dispose(); this.b.dispose(); this.mPre.dispose(); this.mGather.dispose(); this.q.dispose(); }
}
