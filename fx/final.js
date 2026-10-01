// One full-screen pass that ends the HD chain: AO apply (linear), depth-of-field composite, bloom add,
// exposure + AgX, sRGB, the grade (S-curve, saturation), vignette and optional grain.
// Replaces OutputPass + the grade ShaderPass (two full-res passes) and the bloom copy-blend.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from './depth.js';
import { AO_UPSAMPLE } from './ao.js';


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
      uDofAmount: { value: 0 },
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
    if (o.dof) d.USE_DOF = '';
    if (o.grain) d.USE_GRAIN = '';
    if (o.ca) d.USE_CA = '';
    if (o.aoDebug) d.AO_DEBUG = '';
    this.material.defines = d; this.material.needsUpdate = true;
  }
  _frag() {
    return /* glsl */`
      precision highp float; precision highp sampler2D;
      uniform sampler2D tDiffuse, tAO, tBloom, tDof, tDepth;
      uniform float uBloom, uTime, uGrain, uVignette, uAOStrength, uCA, uDofAmount;
      uniform vec2 uAOProtect;
      varying vec2 vUv;
      #include <tonemapping_pars_fragment>
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      ${DEPTH_GLSL}
      ${AO_UPSAMPLE}
      float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec4 src = texture2D(tDiffuse, vUv);
        vec3 c = src.rgb;
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
        #ifdef USE_BLOOM
          c += texture2D(tBloom, vUv).rgb * uBloom;
        #endif
        c = AgXToneMapping(c);
        c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
        vec3 s = c * c * (3.0 - 2.0 * c); c = mix(c, s, 0.42);                    // the grade that used to be its own pass
        float l = lum(c); c = mix(vec3(l), c, 1.14);
        vec2 q = vUv - 0.5; c *= 1.0 - uVignette * dot(q, q);
        #ifdef USE_GRAIN
          float n = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5;
          c += n * uGrain * (0.35 + 0.65 * (1.0 - l));                              // grain sits mostly in the shadows
        #else
          c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;                             // 8-bit dither: no banding in the night sky
        #endif
        gl_FragColor = vec4(c, 1.0);
      }`;
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.toneMappingExposure.value = renderer.toneMappingExposure;
    u.uTime.value = performance.now() / 1000;
    if (this.ao) { u.tAO.value = this.ao.texture; u.tDepth.value = readBuffer.depthTexture; updateDepthUniforms(u, this.camera); }
    if (this.bloom) u.tBloom.value = this.bloom.texture;
    if (this.dof) { u.tDof.value = this.dof.texture; u.uDofAmount.value = this.dof.amount; }
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this._fsQuad.dispose(); }
}
