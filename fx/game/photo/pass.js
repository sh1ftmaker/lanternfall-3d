// Photo mode's one post pass: focus blur (gather scaled by the circle of confusion), a look (colour matrix / curve)
// and a vignette centred on the crop. It is the LAST pass of the composer and only exists while photo mode needs it
// (fx/post.js and app.js call Q.photo.build). Depth comes from the scene buffer, caught by a tiny pass after the scene pass.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VERT, DEPTH_GLSL, depthDefines, depthUniforms, updateDepthUniforms } from '../../depthtex.js';

export const LOOKS = {   // sat, gain (rgb), lift (rgb, added toward the shadows), contrast (+ S-curve, - flatter)
  natural: { name: 'Natural', short: 'Natural', sat: 1, gain: [1, 1, 1], lift: [0, 0, 0], con: 0 },
  warm: { name: 'Warm lantern', short: 'Lantern', sat: 1.08, gain: [1.1, 1.0, 0.82], lift: [0.025, 0.01, -0.012], con: 0.12 },
  cold: { name: 'Cold moon', short: 'Moon', sat: 0.88, gain: [0.86, 0.98, 1.14], lift: [-0.006, 0.006, 0.03], con: 0.08 },
  faded: { name: 'Faded print', short: 'Faded', sat: 0.7, gain: [1.03, 1.0, 0.95], lift: [0.085, 0.075, 0.066], con: -0.22 },
  mono: { name: 'Black and white', short: 'Mono', sat: 0, gain: [1, 1, 1], lift: [0.01, 0.01, 0.01], con: 0.3 },
};

// Two shaders from one source. GATHER (focus blur only): a golden-angle gather scaled by the circle of confusion, the sample
// pattern turned per pixel by interleaved gradient noise. FINAL: for blur, a small rotated smoothing weighted by blur size that
// averages the gather's noise away (the first version was visibly grainy), then the look and the vignette.
const FRAG = /* glsl */`
  precision highp float; precision highp sampler2D;
  uniform sampler2D tDiffuse, tZ; uniform vec2 uFocusUV, uRes; uniform float uAperture, uVig, uSat, uCon;
  uniform vec3 uGain, uLift; uniform vec4 uCrop; varying vec2 vUv;
  float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  #ifdef USE_DOF
  float zAt(vec2 uv){ return texture2D(tZ, uv).r; }
  float cocOf(float z, float zf){ return clamp(uAperture * (1.0 - zf / z), -uAperture * 1.6, uAperture); }   // px, signed: < 0 in front of the focus plane
  #endif
  void main(){
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    #ifdef STAGE_GATHER
      if (uAperture > 0.3) {
        float zf = zAt(uFocusUV), z0 = zAt(vUv), r0 = cocOf(z0, zf), ar0 = abs(r0);
        vec3 acc = c; float wsum = 1.0;
        float maxr = uAperture * 1.6;
        float rot = ign(gl_FragCoord.xy) * 6.2831853;
        const float GA = 2.39996323;
        for (int i = 1; i < TAPS; i++) {
          float fi = float(i), rr = sqrt(fi / float(TAPS)) * maxr;
          float a = fi * GA + rot;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * rr / uRes;
          float rs = cocOf(zAt(uv), zf), ars = abs(rs);
          // the sample's own blur disc must reach this pixel; a sharp subject is not smeared by the background
          float w = smoothstep(rr - 1.0, rr + 0.6, rs < 0.0 ? ars : min(ars, ar0 + 1.0));
          vec3 s = texture2D(tDiffuse, uv).rgb;
          if (any(isnan(s)) || any(isinf(s))) continue;           // a stray bad pixel in the frame must not smear into a disc
          w *= 1.0 + 3.0 * pow(clamp(lum(s), 0.0, 1.0), 4.0);          // bright lights bloom into discs
          acc += s * w; wsum += w;
        }
        vec3 b = acc / wsum;
        c = mix(c, b, smoothstep(0.3, 1.5, ar0 + 0.0));
      }
      gl_FragColor = vec4(c, 1.0);
    #else
    #if defined(USE_DOF) && !defined(NO_SMOOTH)
      if (uAperture > 0.3) {
        float zf = zAt(uFocusUV), r0 = cocOf(zAt(vUv), zf), ar0 = abs(r0);
        float rad = clamp(ar0 * 0.3, 0.0, 3.5) * smoothstep(0.5, 1.5, ar0);
        if (rad > 0.05) {
          vec3 acc = c; float wsum = 1.0, rot = hash12(gl_FragCoord.xy + 5.0) * 6.2831853;
          for (int i = 0; i < SMOOTH; i++) {
            float a = (float(i) + 0.5) * 6.2831853 / float(SMOOTH) + rot, rr = rad * (0.45 + 0.55 * fract(float(i) * 0.618 + rot));
            vec2 uv = vUv + vec2(cos(a), sin(a)) * rr / uRes;
            float w = 1.0 - smoothstep(0.8, 2.5, abs(abs(cocOf(zAt(uv), zf)) - ar0));      // not across a depth edge
            acc += texture2D(tDiffuse, uv).rgb * w; wsum += w;
          }
          c = acc / wsum;
        }
      }
    #endif
    float l = lum(c); c = mix(vec3(l), c, uSat); c *= uGain; c = uLift + c * (1.0 - uLift);
    c = clamp(c, 0.0, 1.0);
    c = uCon >= 0.0 ? mix(c, c * c * (3.0 - 2.0 * c), uCon) : mix(c, vec3(0.5), -uCon * 0.4);
    vec2 q = (vUv - uCrop.xy - uCrop.zw * 0.5) / (uCrop.zw * 0.5);
    c *= 1.0 - uVig * smoothstep(0.35, 1.45, length(q));
    c += (hash12(gl_FragCoord.xy + 17.0) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
    #endif
  }`;

// taps and smoothing taps by the picture quality in force: Cinematic and HD gather more and then smooth; Fast gathers least and does not smooth
function tier(ctx) { const Q = ctx.Q || (window.__park && window.__park.Q) || {}; return !Q.bloom ? 'fast' : (Q.post && Q.post.ao) ? 'cinematic' : 'hd'; }
export const BLUR_COST = { cinematic: { taps: [144, 72], smooth: [12, 8] }, hd: { taps: [96, 56], smooth: [10, 6] }, fast: { taps: [36, 20], smooth: [0, 0] } };   // [desktop, phone]

// st: the module's live state { aperture 0..1, focus: [u, v], look, vig 0..1, crop: [x, y, w, h] in uv }
export function makePhotoPass(ctx, composer, st, dof) {
  const { renderer, camera } = ctx;
  // The composer's buffers are reused (and cleared) by the later passes, so the scene depth is turned into a view
  // distance (metres, sky = 3000) in a target of our own right after the scene pass.
  const cap = new Pass(); cap.__name = 'PhotoDepth'; cap.needsSwap = false;
  const zrt = new THREE.WebGLRenderTarget(ctx.size.x, ctx.size.y, { type: THREE.HalfFloatType, depthBuffer: false });
  const zu = Object.assign(depthUniforms(), { tDepth: { value: null } });
  const zmat = new THREE.ShaderMaterial({ vertexShader: VERT, uniforms: zu, defines: depthDefines(renderer), depthTest: false, depthWrite: false,
    fragmentShader: `precision highp float; precision highp sampler2D; uniform sampler2D tDepth; varying vec2 vUv; ${DEPTH_GLSL}
      void main(){ float d = texture2D(tDepth, vUv).r; gl_FragColor = vec4(isSky(d) ? 3000.0 : clamp(-viewZ(vUv, d), 0.05, 3000.0), 0.0, 0.0, 1.0); }` });
  const zq = new FullScreenQuad(zmat);
  cap.setSize = (w, h) => zrt.setSize(w, h);
  cap.render = (r, w, read) => {
    if (!read.depthTexture) return; zu.tDepth.value = read.depthTexture; updateDepthUniforms(zu, camera);
    const prev = r.getRenderTarget(); r.setRenderTarget(zrt); zq.render(r); r.setRenderTarget(prev);
  };
  cap.dispose = () => { zrt.dispose(); zmat.dispose(); zq.dispose(); };
  let i = composer.passes.findIndex((p) => p.__name === 'Scene' || p.__name === 'N8AO' || (p.scene && p.camera)); i = i < 0 ? 0 : i + 1;
  if (dof) composer.insertPass(cap, i);
  const u = Object.assign(depthUniforms(), {
    tDiffuse: { value: null }, tZ: { value: zrt.texture }, uFocusUV: { value: new THREE.Vector2(0.5, 0.5) }, uRes: { value: new THREE.Vector2(1, 1) },
    uAperture: { value: 0 }, uVig: { value: 0 }, uSat: { value: 1 }, uCon: { value: 0 }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uLift: { value: new THREE.Vector3() }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
  });
  const cost = BLUR_COST[tier(ctx)], mi = ctx.mobile ? 1 : 0, smooth = cost.smooth[mi];
  const defines = Object.assign(depthDefines(renderer), dof ? { USE_DOF: '', TAPS: cost.taps[mi], SMOOTH: Math.max(1, smooth) } : {});
  const mk = (extra) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: u, defines: { ...defines, ...extra }, depthTest: false, depthWrite: false, toneMapped: false });
  const feed = (r, readBuffer) => {
    const k = LOOKS[st.look] || LOOKS.natural, h = readBuffer.height;
    u.tDiffuse.value = readBuffer.texture; u.uRes.value.set(readBuffer.width, h);
    u.uFocusUV.value.set(st.focus[0], st.focus[1]);
    u.uAperture.value = dof ? Math.pow(st.aperture, 1.4) * 30 * h / 1080 : 0;
    u.uVig.value = st.vig * 0.85; u.uSat.value = k.sat; u.uCon.value = k.con; u.uGain.value.set(...k.gain); u.uLift.value.set(...k.lift); u.uCrop.value.set(...st.crop);
  };
  // first pass: the gather (always writes to a buffer); last pass: smoothing, look, vignette
  let gather = null;
  if (dof) {
    const gm = mk({ STAGE_GATHER: '' }), gq = new FullScreenQuad(gm); gather = new Pass(); gather.__name = 'PhotoBlur';
    gather.render = (r, writeBuffer, readBuffer) => { feed(r, readBuffer); r.setRenderTarget(writeBuffer); gq.render(r); };
    gather.dispose = () => { gm.dispose(); gq.dispose(); };
    composer.addPass(gather);
  }
  const mat = mk(dof && !smooth ? { NO_SMOOTH: '' } : {});
  const q = new FullScreenQuad(mat);
  const pass = new Pass(); pass.__name = 'Photo';
  pass.render = (r, writeBuffer, readBuffer) => { feed(r, readBuffer); r.setRenderTarget(pass.renderToScreen ? null : writeBuffer); q.render(r); };
  pass.dispose = () => { mat.dispose(); q.dispose(); };
  composer.addPass(pass);
  return pass;
}
