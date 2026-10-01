// Lanternfall as a living cycle: every lantern is released from the Spire's gallery, spirals up into the canopy,
// hangs and drifts there, settles onto Stillwater, floats, burns out and is relit. Stateless: each lantern's position
// is a closed-form function of (time, its own phase), evaluated in the vertex shader, so it is one instanced draw call
// and renders identically in the water-reflection pass. Seeded from the baked composition in extras.bin
// (position, colour, strength, size): canopy lanterns keep their own spot as their hang anchor, floating ones their
// spot on the lake, so the time-averaged picture matches the static composition.
// Technique: instanced camera-facing quads (three.js webgl_buffergeometry_instancing_billboards) with a procedural
// paper-lantern sprite instead of round point sprites (webgl_points_sprites), premultiplied "emissive + paper" blending.
import * as THREE from 'three';

const PERIOD = 300;            // seconds for one lantern's whole life
const WAVES = 24;              // release waves per period (one every 12.5 s)
// fractions of the life spent in each state (sum 1): rise, hang, descend, float, dark
const F = { rise: 0.04, hang: 0.765, desc: 0.085, float: 0.09 };

function hash(i, s) { let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(s + 0x632be5ab, 0xc2b2ae35); x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d); x ^= x >>> 12; return (x >>> 0) / 4294967296; }

export function buildLanternFall({ f32, count, waterY, uTime, motion = 1, scale = 1 }) {
  const canopy = [], water = [];
  for (let i = 0; i < count; i++) { const y = f32[i * 8 + 1]; if (y > 30) canopy.push(i); else if (y < waterY + 0.3) water.push(i); }
  // per-instance life data: aC = hang anchor (xyz) + phase, aW = float anchor (xz) + gallery angle + kind flag
  const n = Math.max(1, Math.round(count * scale));
  const life = new Float32Array(n * 8), seed = new Float32Array(n * 8);
  for (let k = 0; k < n; k++) {
    const i = Math.floor(k * count / n);
    seed.set(f32.subarray(i * 8, i * 8 + 8), k * 8);
    const y = f32[i * 8 + 1];
    let cx, cy, cz;
    if (y > 30) { cx = f32[i * 8]; cy = y; cz = f32[i * 8 + 2]; }
    else { const j = canopy[Math.floor(hash(i, 1) * canopy.length)]; cx = f32[j * 8] + (hash(i, 2) - 0.5) * 6; cy = f32[j * 8 + 1] + (hash(i, 3) - 0.5) * 4; cz = f32[j * 8 + 2] + (hash(i, 4) - 0.5) * 6; }
    let wx, wz;
    if (y < waterY + 0.3) { wx = f32[i * 8]; wz = f32[i * 8 + 2]; }
    else { const j = water[Math.floor(hash(i, 5) * water.length)]; wx = f32[j * 8] + (hash(i, 6) - 0.5) * 3; wz = f32[j * 8 + 2] + (hash(i, 7) - 0.5) * 3; }
    // phase: lanterns leave in waves; the state the baked lantern was in picks where in its life it is "now" at t = 0,
    // so the opening frame is close to the authored composition.
    const wave = Math.floor(hash(i, 8) * WAVES), inWave = hash(i, 9) * 0.45;
    let ph = -(wave + inWave) / WAVES;
    const door = Math.floor(hash(i, 10) * 4);
    const gal = door * Math.PI / 2 + Math.PI / 4 + (hash(i, 11) - 0.5) * 0.25;
    life.set([cx, cy, cz, ph, wx, wz, gal, hash(i, 12)], k * 8);
  }
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  const sb = new THREE.InstancedInterleavedBuffer(seed, 8), lb = new THREE.InstancedInterleavedBuffer(life, 8);
  quad.setAttribute('aSeed', new THREE.InterleavedBufferAttribute(sb, 3, 0));
  quad.setAttribute('aCol', new THREE.InterleavedBufferAttribute(sb, 3, 3));
  quad.setAttribute('aPar', new THREE.InterleavedBufferAttribute(sb, 2, 6));
  quad.setAttribute('aC', new THREE.InterleavedBufferAttribute(lb, 4, 0));
  quad.setAttribute('aW', new THREE.InterleavedBufferAttribute(lb, 4, 4));
  quad.instanceCount = n;
  quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 40, 0), 170);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uScale: { value: 500 }, uWater: { value: waterY }, uMotion: { value: motion }, uPeriod: { value: PERIOD },
      uF: { value: new THREE.Vector4(F.rise, F.rise + F.hang, F.rise + F.hang + F.desc, F.rise + F.hang + F.desc + F.float) }, uGain: { value: 1 },
      uStretch: { value: 2.6 }, tMask: { value: null }, uDom: { value: new THREE.Vector4(0, 0, 1, 1) } },
    vertexShader: /* glsl */`
      attribute vec3 aSeed, aCol; attribute vec2 aPar; attribute vec4 aC, aW;
      uniform float uTime, uScale, uWater, uMotion, uPeriod, uGain; uniform vec4 uF;
      varying vec2 vQ; varying vec3 vCol; varying float vShape, vK, vFlame, vAlpha;
      #ifdef REFL
        uniform float uStretch; uniform sampler2D tMask; uniform vec4 uDom;     // reflection on the lake (see makeReflection)
      #endif
      const float TAU = 6.2831853;
      float hh(float n){ return fract(sin(n) * 43758.5453); }
      vec3 wander(float t, float ph, float amp){
        return amp * vec3(sin(t * 0.071 + ph) + 0.4 * sin(t * 0.23 + ph * 2.3), 0.35 * sin(t * 0.13 + ph * 1.7), cos(t * 0.063 + ph * 1.3) + 0.4 * cos(t * 0.19 + ph * 3.1));
      }
      vec3 hangAt(float s, float t, float ph){                 // canopy: drift with the night breeze around the anchor
        float r = length(aC.xz), a = atan(aC.z, aC.x) + (s - 0.5) * 0.55 * (40.0 / max(r, 25.0));
        return vec3(r * cos(a), aC.y, r * sin(a)) + wander(t, ph, 1.6);
      }
      vec3 floatAt(float s, float t, float ph){                // on the water: slow drift, a little bob
        vec3 p = vec3(aW.x, uWater + 0.36, aW.y);
        p.xz += vec2(sin(t * 0.05 + ph), cos(t * 0.043 + ph * 1.9)) * 1.4 + vec2(cos(ph), sin(ph)) * s * 2.0;
        p.y += 0.035 * sin(t * 1.3 + ph * 5.0);
        return p;
      }
      void main(){
        float ph = hh(aC.w * 91.7 + aW.w * 13.1) * TAU;
        float t = uTime;
        float u = fract(t / uPeriod + aC.w);
        vec3 p; float lit = 1.0, sway = 1.0;
        if (u < uF.x) {                                        // rise: spiral up out of the gallery, spread into the canopy
          float s = u / uF.x;
          vec3 tgt = hangAt(0.0, t, ph);
          float rt = length(tgt.xz), at = atan(tgt.z, tgt.x);
          float a0 = aW.z, da = mod(at - a0, TAU) + TAU * 0.6;
          float er = smoothstep(0.0, 0.8, s), ea = 1.0 - (1.0 - s) * (1.0 - s);
          float r = mix(5.6, rt, er), a = a0 + da * ea;
          float y = mix(45.6, tgt.y, smoothstep(0.0, 1.0, s) * 0.7 + 0.3 * s);
          p = vec3(r * cos(a), y, r * sin(a));
          p = mix(p, tgt, smoothstep(0.85, 1.0, s));
          lit = smoothstep(0.0, 0.05, s); sway = 1.6;
        } else if (u < uF.y) {
          p = hangAt((u - uF.x) / (uF.y - uF.x), t, ph);
        } else if (u < uF.z) {                                 // descend: settle onto the lake, rocking a little
          float s = (u - uF.y) / (uF.z - uF.y);
          vec3 a = hangAt(1.0, t, ph), b = floatAt(0.0, t, ph);
          float ey = s * s * (3.0 - 2.0 * s), ex = smoothstep(0.0, 0.9, s);
          p = vec3(mix(a.x, b.x, ex), mix(a.y, b.y, ey), mix(a.z, b.z, ex));
          p.xz += vec2(sin(t * 0.6 + ph), cos(t * 0.5 + ph)) * 1.2 * sin(3.14159 * s);
          sway = 1.4;
        } else if (u < uF.w) {
          float s = (u - uF.z) / (uF.w - uF.z);
          p = floatAt(s, t, ph); lit = 1.0 - smoothstep(0.55, 1.0, s) * 0.92; sway = 0.5;
        } else { p = floatAt(1.0, t, ph); lit = 0.0; }
        p = mix(aSeed, p, uMotion);
        lit = mix(1.0, lit, uMotion);
        float reflK = 1.0, stretch = 1.0;
        #ifdef REFL
          // image of the lantern in the lake: mirror it about the water plane, draw it where the reflected ray meets the
          // surface, sized by the mirrored distance, faded by Fresnel and masked to open water
          vec3 mp = vec3(p.x, 2.0 * uWater - p.y, p.z), cp = cameraPosition;
          float tw = (cp.y - uWater) / max(cp.y - mp.y, 1e-3);
          vec3 sp = cp + (mp - cp) * (tw * 0.997);
          vec4 mk = texture2D(tMask, (sp.xz - uDom.xy) * uDom.zw);
          vec3 Vw = normalize(cp - sp);
          reflK = step(0.5, mk.g) * step(0.0, cp.y - uWater) * step(uWater + 0.25, p.y) * (0.02 + 0.98 * pow(1.0 - clamp(Vw.y, 0.0, 1.0), 5.0));
          stretch = 1.0 + uStretch * smoothstep(0.6, 0.05, Vw.y);
          float dmir = max(-(viewMatrix * vec4(mp, 1.0)).z, 0.1);
          p = sp;
        #endif
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float distP = max(-mv.z, 0.05);
        #ifdef REFL
          float dist = dmir;
        #else
          float dist = distP;
        #endif
        float px = aPar.y * 1.4 * uScale / dist;                // nominal glow diameter in pixels (as the old sprite)
        float sz = clamp(px, 2.0, 1e4);
        float flick = 0.86 + 0.14 * sin(t * (2.0 + fract(ph * 3.3) * 3.0) + ph * 9.0);
        float gain = aPar.x * flick * min(1.0, (px * px) / (sz * sz) * 2.0 + 0.10) * mix(0.34, 0.13, smoothstep(3.0, 22.0, px));
        // lanterns closer than a few metres fade out instead of filling the screen
        gain *= smoothstep(1.0, 4.0, dist) * lit * uGain * reflK;
        vCol = aCol * gain;
        vShape = smoothstep(9.0, 20.0, px);                     // far: glow dot; near: paper lantern
        #ifdef REFL
          vShape = 0.0; sz = min(sz, 40.0);
        #endif
        // camera-facing quad whose "up" follows world up projected on the screen
        vec2 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy; float k = length(up);
        up = k > 1e-3 ? up / k : vec2(0.0, 1.0);
        float sw = sin(t * (0.7 + fract(ph * 7.1) * 0.5) + ph * 3.0) * 0.07 * sway * uMotion;
        float cs = cos(sw), sn = sin(sw); up = vec2(cs * up.x - sn * up.y, sn * up.x + cs * up.y);
        vec2 rt = vec2(up.y, -up.x);
        float hs = 0.5 * sz * distP / uScale * mix(1.0, 1.6, vShape);      // world half-size of the quad
        mv.xy += (position.x * rt + position.y * up * stretch) * hs;
        vQ = position.xy * mix(1.0, 1.6, vShape);
        vK = k; vFlame = 0.75 + 0.25 * sin(t * 11.0 + ph * 17.0) * sin(t * 7.3 + ph);
        vAlpha = smoothstep(1.0, 4.0, dist) * lit;
        gl_Position = projectionMatrix * mv;
        if (gain <= 1e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vQ; varying vec3 vCol; varying float vShape, vK, vFlame, vAlpha;
      void main(){
        // far: the soft round glow of the original sprites
        float d = length(vQ * vec2(1.25, 1.0));
        float a0 = smoothstep(1.0, 0.44, d), core0 = smoothstep(0.68, 0.0, d);
        vec3 glow = vCol * (0.6 + 1.6 * core0 * core0) * a0;
        vec3 col = glow; float alpha = 0.0;
        if (vShape > 0.0) {
          // near: a paper sky-lantern, wider at the top, lit from a flame in its open bottom
          vec2 q = vQ / 1.5;
          float k = clamp(vK, 0.0, 1.0);
          // side view (k = 1): rounded trapezoid; seen from below (k = 0): a disc with the flame in the middle
          float y = q.y / max(k, 0.25);
          float hw = mix(0.30, 0.42, smoothstep(-0.62, 0.55, y)) ;
          float side = max(abs(q.x) - hw, abs(y - 0.0) - 0.62);
          float top = length(vec2(max(abs(q.x) - hw + 0.12, 0.0), max(y - 0.5, 0.0))) - 0.12;
          side = max(side, top);
          float disc = length(q) - 0.40;
          float sdf = mix(disc, side, smoothstep(0.15, 0.6, k));
          float body = smoothstep(0.03, -0.05, sdf);
          float yb = mix(0.0, (y + 0.62) / 1.24, smoothstep(0.15, 0.6, k));      // 0 at the opening, 1 at the top
          float rad = mix(length(q) / 0.40, abs(q.x) / hw, smoothstep(0.15, 0.6, k));
          float paper = (1.25 - 0.85 * yb) * (1.0 - 0.45 * rad * rad);
          float rib = 1.0 - 0.18 * smoothstep(0.05, 0.0, abs(abs(q.x) - hw * 0.45)) * smoothstep(0.15, 0.6, k);
          vec3 pc = vCol * 0.8 * paper * rib;
          vec2 fq = mix(q, vec2(q.x, y + 0.5), smoothstep(0.15, 0.6, k));
          float fl = exp(-dot(fq * vec2(9.0, 6.0), fq * vec2(9.0, 6.0))) * vFlame;
          vec3 flame = vec3(1.0, 0.86, 0.62) * fl * 2.4 * max(vCol.r, max(vCol.g, vCol.b));
          float halo = exp(-max(sdf, 0.0) * 11.0) * (1.0 - body);
          vec3 near = pc * body + flame * body + vCol * 0.3 * halo;
          col = mix(glow, near, vShape);
          alpha = body * vShape * 0.85 * vAlpha;
          if (max(max(col.r, col.g), col.b) < 1e-3 && alpha < 0.01) discard;
        } else if (a0 < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(quad, mat);
  mesh.renderOrder = 8; mesh.frustumCulled = false;
  mesh.onBeforeRender = (r, s, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
  // A second draw of the same instances as their reflections on the lake, for water tiers without a planar mirror
  // (fx/water.js calls this with its open-water mask). Shares every uniform with the lanterns, so it follows the life cycle.
  mesh.userData.makeReflection = ({ tMask, dom, stretch = 2.6 }) => {
    const m2 = mat.clone();
    m2.uniforms = { ...mat.uniforms, uScale: { value: 500 }, tMask: { value: tMask }, uDom: { value: dom }, uStretch: { value: stretch } };
    m2.defines = { REFL: '' }; m2.blending = THREE.AdditiveBlending; m2.depthTest = true; m2.depthWrite = false; m2.needsUpdate = true;
    const refl = new THREE.Mesh(quad, m2); refl.renderOrder = 7; refl.frustumCulled = false;
    refl.onBeforeRender = (r, s, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; m2.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
    return refl;
  };
  return mesh;
}
