// One full-screen pass that ends the post chain: AO apply (linear), depth-of-field composite, bloom, fog smear,
// exposure + tone mapping (ACES or AgX, fx/light/look.js), sRGB, the optional grade, vignette and grain.
// Natural bloom (fx/bloom.js NatBloomPass): the picture is blended *towards* the blurred pyramid (no threshold), and
// fogged pixels blend further by their fog share (from depth, the same height-thinned fog as the materials), so fog
// smears light instead of only hiding it. '#show=hdr' paints scene values over white in a colour per stop (grey below
// 1.0), '#show=card' puts an 18 % grey card in the middle of the frame (it should land near pixel 128).
// Replaces OutputPass + the grade ShaderPass (two full-res passes) and the bloom copy-blend.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depthtex.js';
import { AO_UPSAMPLE } from './ao.js';
import { LOOK, FOG_GLSL } from './light/look.js';


export class FinalPass extends Pass {
  constructor(opts = {}) {
    super();
    this.__name = 'Final';
    this.camera = opts.camera;
    this.uniforms = Object.assign(depthUniforms(), {
      tDiffuse: { value: null }, toneMappingExposure: { value: 1 },
      tAO: { value: null }, tDepth: { value: null }, tBloom: { value: null }, tDof: { value: null },
      uBloom: { value: 1 }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVignette: { value: 0.32 },
      uAOStrength: { value: 1 }, uAOProtect: { value: new THREE.Vector2(0.9, 4.0) }, uCA: { value: 0 },
      uDofAmount: { value: 0 }, uBloomNorm: { value: 1 }, uCamW: { value: new THREE.Matrix4() }, uFogD: LOOK.uFogD || { value: 2.4e-7 },
      uExposure: LOOK.uExposure, uTM: LOOK.uTM, uGrade: LOOK.uGrade, uBloomMix: LOOK.uBloomMix, uFogSmear: LOOK.uFogSmear, uShow: LOOK.uShow,
      uFogK: LOOK.uFogK, uFogH: LOOK.uFogH, uFogBase: LOOK.uFogBase,
    });
    this.opts = opts;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, depthTest: false, depthWrite: false,
      defines: {}, fragmentShader: this._frag(), toneMapped: false,
    });
    this._fsQuad = new FullScreenQuad(this.material);
    this.ao = null; this.bloom = null; this.dof = null;      // producer passes (set by the builder)
    this.setOptions(opts);
  }
  setOptions(o) {
    const d = o.renderer ? depthDefines(o.renderer) : {};
    if (o.ao) d.USE_AO = '';
    if (o.bloom) d.USE_BLOOM = '';
    if (o.natural) d.USE_NATBLOOM = '';
    if (o.fogSmear) d.USE_FOGSMEAR = '';
    if (o.dof) d.USE_DOF = '';
    if (o.grain) d.USE_GRAIN = '';
    if (o.ca) d.USE_CA = '';
    if (o.aoDebug) d.AO_DEBUG = '';
    if (o.sharpen) d.USE_SHARPEN = '';
    this.material.defines = d; this.material.needsUpdate = true;
  }
  _frag() {
    return /* glsl */`
      precision highp float; precision highp sampler2D;
      uniform sampler2D tDiffuse, tAO, tBloom, tDof, tDepth;
      uniform float uBloom, uTime, uGrain, uVignette, uAOStrength, uCA, uDofAmount;
      uniform vec2 uAOProtect;
      uniform float uExposure, uTM, uGrade, uBloomMix, uFogSmear, uShow, uBloomNorm, uFogD; uniform mat4 uCamW;
      ${FOG_GLSL}
      // '#show=hdr': grey below 1.0, then one colour per stop: blue, cyan, green, yellow, orange, red, magenta, white
      vec3 hdrFalse(vec3 c){
        float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
        if (L < 1.0) return vec3(pow(L, 1.0 / 2.2) * 0.8);
        float s = floor(log2(L));
        return s < 1.0 ? vec3(0.1, 0.25, 1.0) : s < 2.0 ? vec3(0.0, 0.85, 0.95) : s < 3.0 ? vec3(0.1, 0.85, 0.15) : s < 4.0 ? vec3(0.95, 0.9, 0.1)
             : s < 5.0 ? vec3(1.0, 0.5, 0.0) : s < 6.0 ? vec3(0.95, 0.05, 0.05) : s < 7.0 ? vec3(0.9, 0.1, 0.9) : vec3(1.0);
      }
      varying vec2 vUv;
      #include <tonemapping_pars_fragment>
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      ${DEPTH_GLSL}
      ${AO_UPSAMPLE}
      float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec4 src = texture2D(tDiffuse, vUv);
        vec3 c = src.rgb;
        #ifdef USE_SHARPEN
          // light unsharp mask after TAA (which softens a little); done in a compressed space so bulbs do not halo
          ivec2 ip = ivec2(gl_FragCoord.xy);
          vec3 nb = texelFetch(tDiffuse, ip + ivec2(1, 0), 0).rgb + texelFetch(tDiffuse, ip - ivec2(1, 0), 0).rgb
                  + texelFetch(tDiffuse, ip + ivec2(0, 1), 0).rgb + texelFetch(tDiffuse, ip - ivec2(0, 1), 0).rgb;
          vec3 tc = c / (1.0 + c), tn = (nb * 0.25) / (1.0 + nb * 0.25);
          tc = clamp(tc + (tc - tn) * 0.35, 0.0, 0.999); c = tc / (1.0 - tc);
        #endif
        #ifdef USE_CA
          vec2 dd = (vUv - 0.5) * uCA;
          c.r = texture2D(tDiffuse, vUv - dd).r; c.b = texture2D(tDiffuse, vUv + dd).b;
        #endif
        #ifdef USE_AO
          // tAO: r = upsampled AO already (0 occluded .. 1 open). Emissive and lantern light are kept out of it:
          // bright pixels (bulbs, lit windows) by luminance, lantern sprites by the glow they add to alpha.
          float ao = aoUpsample(tAO, tDepth, vUv, vec2(textureSize(tDiffuse, 0)));
          float L = lum(c);
          float glow = clamp((src.a - 1.0) / max(L, 1e-4), 0.0, 1.0);
          float keep = max(smoothstep(uAOProtect.x, uAOProtect.y, L), glow);
          ao = mix(1.0, ao, uAOStrength * (1.0 - keep));
          #ifdef AO_DEBUG
            gl_FragColor = vec4(vec3(ao), 1.0); return;
          #endif
          c *= ao;
        #endif
        #ifdef USE_DOF
          vec4 dof = texture2D(tDof, vUv);           // rgb blurred (premultiplied by coverage), a = blur weight
          c = mix(c, dof.rgb, smoothstep(0.4, 2.0, dof.a) * uDofAmount);
        #endif
        #ifdef USE_NATBLOOM
          {
            float mixk = uBloomMix * uBloom;
            #ifdef USE_FOGSMEAR
              float dz = texture2D(tDepth, vUv).x;
              vec3 vp = viewPos(vUv, isSky(dz) ? 0.5 : dz);
              vec3 wp = (uCamW * vec4(vp, 1.0)).xyz, cp = uCamW[3].xyz;
              float fd = isSky(dz) ? 600.0 : length(vp);
              if (isSky(dz)) wp = cp + normalize(wp - cp) * 600.0;
              mixk += lookFog(fd, cp.y, wp.y, uFogD) * uFogSmear * step(0.001, uBloom);
            #endif
            c = mix(c, texture2D(tBloom, vUv).rgb * uBloomNorm, clamp(mixk, 0.0, 1.0));
          }
        #elif defined(USE_BLOOM)
          c += texture2D(tBloom, vUv).rgb * uBloom;
        #endif
        if (uShow > 1.5 && max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) < 0.04) c = vec3(0.18);     // '#show=card'
        c *= uExposure;
        if (uShow > 0.5 && uShow < 1.5) { gl_FragColor = vec4(hdrFalse(c), 1.0); return; }
        float gr = uGrade;
        if (uTM < 0.5) { c = AgXToneMapping(c); gr = 0.42; }       // the old look: AgX, then the S-curve grade
        else if (uTM < 1.5) c = AgXToneMapping(c);
        else c = ACESFilmicToneMapping(c);
        c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
        vec3 s = c * c * (3.0 - 2.0 * c); c = mix(c, s, gr);                      // optional S-curve grade (the old look: 0.42)
        float l = lum(c); c = mix(vec3(l), c, 1.0 + gr / 3.0);
        vec2 q = vUv - 0.5; c *= 1.0 - uVignette * dot(q, q);
        #ifdef USE_GRAIN
          float n = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5;
          c += n * uGrain * (0.35 + 0.65 * (1.0 - l));                              // grain sits mostly in the shadows
        #else
          c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;                             // 8-bit dither: no banding in the night sky
        #endif
        // never negative: the saturation boost and the dither push dark saturated pixels a little below zero, which the
        // half-float target keeps, and SMAA's blend pass raises colour to the power 2.2 (pow of a negative is NaN)
        gl_FragColor = vec4(max(c, 0.0), 1.0);
      }`;
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.toneMappingExposure.value = 1;                         // exposure is applied here (uExposure, fx/light/look.js)
    renderer.toneMappingExposure = u.uExposure.value;        // the direct (no float target) path follows the knob
    if (LOOK.uFogD) u.uFogD = LOOK.uFogD;
    this.lastSrc = readBuffer;
    u.uTime.value = performance.now() / 1000;
    if (this.ao || this.opts.fogSmear) { u.tDepth.value = readBuffer.depthTexture; updateDepthUniforms(u, this.camera); u.uCamW.value.copy(this.camera.matrixWorld); }
    if (this.ao) u.tAO.value = this.ao.texture;
    if (this.bloom) { u.tBloom.value = this.bloom.texture; if (this.bloom.norm) u.uBloomNorm.value = this.bloom.norm; }
    if (this.opts.natural) u.uBloom.value = this.bloom && this.bloom.enabled ? 1 : 0;   // Fast turns the pyramid off
    if (this.dof) { u.tDof.value = this.dof.texture; u.uDofAmount.value = this.dof.amount; }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this._fsQuad.dispose(); }
}
