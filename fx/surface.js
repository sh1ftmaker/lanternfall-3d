// The park's surface material: baked light + crisp per-pixel detail.
//
// Each vertex carries a baked HDR colour (lanterns, lamps, windows, sky; everything except the moon), its albedo and a
// surface class (web_export/pack.py). On top of that this shader adds, per pixel:
//   - procedural surface detail chosen by class (paving setts, planks, masonry courses, roof tiles, organic mottling),
//     with a bump that catches the moonlight; it fades out before it can alias;
//   - moonlight, shadow-mapped: one depth map of the whole park rendered once from the moon (the moon does not move).
// Normals come from screen-space derivatives (flat, which suits the low-poly park), so the data needs none.
// Old data without the albedo/class attribute renders as plain baked colour (class 255 = "leave alone").
import * as THREE from 'three';
import { DN_DECL, DN_LAMP, createDayUniforms } from './game/daynight/uniforms.js';      // game hook: daynight

const GLSL_DETAIL = /* glsl */`
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
  // running bond of blocks s (m) with joint width g: returns (tone per block, joint mask)
  vec2 bond(vec2 uv, vec2 s, float g, float fw){
    vec2 q = uv / s; q.x += 0.5 * floor(q.y); vec2 id = floor(q); vec2 f = fract(q) * s;
    vec2 e = min(f, s - f); float gm = 1.0 - smoothstep(g - fw, g + fw, min(e.x, e.y));
    return vec2(h21(id), gm);
  }
  // (albedo multiplier, height 0..1) for surface class cls at world point p with geometric normal n; fw = pixel footprint (m)
  vec2 detail(float cls, vec3 p, vec3 n, float fw){
    vec3 an = abs(n);
    bool up = an.y > 0.7;
    vec2 uv = up ? p.xz : (an.x > an.z ? p.zy : p.xy);
    float m = 1.0, h = 0.5, f = 0.0;
    if (cls < 0.5) {                                   // plain (plaster, cloth, paint): faint mottling
      m = 0.95 + 0.10 * vn(uv * 2.3); f = 1.0 - smoothstep(0.08, 0.4, fw);
    } else if (cls < 1.5) {                            // paving: setts in running bond, laid along the ring around the lake
      if (up) {                                         // laid along the ring: one orientation per 1/28 sector round the lake
        float a = (floor(atan(p.z, p.x) / 0.2244 + 0.5)) * 0.2244; float c = cos(a), s = sin(a); uv = vec2(c * p.x + s * p.z, -s * p.x + c * p.z);
      }
      vec2 b = bond(uv, vec2(0.42, 0.28), 0.028, fw * 0.7);
      float nz = vn(uv * 7.0), big = vn(uv * 0.35);
      m = (0.76 + 0.42 * b.x) * (1.0 - 0.6 * b.y) * (0.88 + 0.24 * nz) * (0.9 + 0.2 * big) * 1.16; h = (1.0 - b.y) * (0.8 + 0.2 * nz);
      f = 1.0 - smoothstep(0.03, 0.14, fw);
    } else if (cls < 2.5) {                            // wood: planks with grain
      float w = 0.16, pl = floor(uv.y / w), t = h21(vec2(pl, 3.1));
      float e = abs(fract(uv.y / w) - 0.5) * 2.0, gm = smoothstep(0.86 - fw * 6.0, 0.98, e);
      float ends = smoothstep(0.985 - fw * 2.0, 1.0, abs(fract(uv.x / 2.4 + t * 7.0) - 0.5) * 2.0);
      float grain = 0.92 + 0.16 * vn(vec2(uv.x * 1.3, uv.y * 40.0 + pl * 7.0));
      gm = max(gm, ends);
      m = (0.82 + 0.3 * t) * grain * (1.0 - 0.45 * gm) * 1.03; h = 1.0 - gm; f = 1.0 - smoothstep(0.03, 0.14, fw);
    } else if (cls < 3.5) {                            // masonry: coursed blocks on walls, mottled on top
      if (up) { m = 0.90 + 0.22 * vn(uv * 1.7) * vn(uv * 6.0 + 3.0); f = 1.0 - smoothstep(0.1, 0.5, fw); }
      else {
        vec2 b = bond(uv, vec2(0.62, 0.31), 0.018, fw * 0.7);
        m = (0.84 + 0.3 * b.x) * (1.0 - 0.42 * b.y) * (0.92 + 0.16 * vn(uv * 9.0)) * 1.06; h = 1.0 - b.y;
        f = 1.0 - smoothstep(0.035, 0.16, fw);
      }
    } else if (cls < 4.5) {                            // organic: grass, foliage, snow, soil
      m = 0.74 + 0.28 * vn(uv * 1.1) + 0.16 * vn(uv * 5.3 + 7.0) + 0.08 * vn(uv * 23.0); f = 1.0 - smoothstep(0.15, 0.9, fw);
    } else if (cls < 5.5) {                            // roof: overlapping tile courses
      float r = fract(p.y / 0.2), c = floor(uv.x / 0.3 + 0.5 * floor(p.y / 0.2));
      m = (0.72 + 0.42 * r) * (0.88 + 0.22 * h21(vec2(c, floor(p.y / 0.2)))); h = r; f = 1.0 - smoothstep(0.03, 0.14, fw);
    }
    return vec2(mix(1.0, m, f), mix(0.5, h, f));
  }
  // perturb normal n by a scalar height field (as three.js bump mapping, from screen-space derivatives)
  vec3 bumpN(vec3 p, vec3 n, float hgt){
    vec3 dpx = dFdx(p), dpy = dFdy(p); float dhx = dFdx(hgt), dhy = dFdy(hgt);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1);
    vec3 g = sign(det) * (dhx * r1 + dhy * r2);
    float gl = length(g), lim = 0.75 * abs(det);            // keep the tilt bounded; derivatives spike at triangle edges
    if (gl > lim) g *= lim / gl;
    vec3 r = abs(det) * n - g; float l = dot(r, r);
    return l > 1e-20 ? r * inversesqrt(l) : n;
  }`;

export function createSurface({ FOG, fogD, moonDir, moonCol, mobile, DN = createDayUniforms() }) {
  const uniforms = {
    uRange: { value: 32 }, uFog: { value: FOG }, uFogD: { value: fogD }, uZBias: { value: new THREE.Vector3(0.0018, 0.0018, 0.0005) },
    uMoon: { value: moonDir.clone().normalize() }, uMoonCol: { value: new THREE.Vector3().fromArray(moonCol || [0.108, 0.129, 0.175]) },
    uMoonOn: { value: 0 },                       // 1 once the data says the moon is not baked in
    tShadow: { value: null }, uShadowM: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 }, uSSize: { value: 2048 }, uSTexel: { value: 0.3 },
    uDetail: { value: 1 }, uBump: { value: 0.012 },
    ...DN,                                       // game hook: daynight (sun, sky light, lamps; all at their night values until the module moves them)
    tShadowS: { value: null }, uShadowMS: { value: new THREE.Matrix4() }, uShadowOnS: { value: 0 }, uSSizeS: { value: 2048 }, uSTexelS: { value: 0.3 },   // the sun's shadow map
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aCol; attribute vec4 aAux; attribute float aLay; uniform float uRange; uniform vec3 uZBias;
      varying vec3 vCol; varying float vDist; varying vec3 vW; varying vec3 vAlb; varying float vCls;
      void main(){ vCol = aCol.rgb * (aCol.a * uRange);
        vAlb = aAux.rgb * aAux.rgb; vCls = floor(aAux.a * 255.0 + 0.5);
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv;
        vW = transpose(mat3(viewMatrix)) * (mv.xyz - viewMatrix[3].xyz);          // world position (follows animated variants)
        // z-fight tie-break for exactly coplanar floors (see fx/depth.js): depth is taken as if the vertex sat up to
        // 1.8 mm higher (brighter faces) or lower (pitch-black under-layers); less than the position quantum.
        float lum = dot(vCol, vec3(0.3, 0.5, 0.2)), dy = (vCol == vec3(0.0) ? -uZBias.x : uZBias.y * lum / (lum + 0.05)) + aLay * uZBias.z;
        vec4 cz = projectionMatrix * (mv + viewMatrix[1] * dy);
        if (cz.w * gl_Position.w > 1e-6) gl_Position.z = cz.z * (gl_Position.w / cz.w);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uFog; uniform float uFogD; uniform vec3 uMoon, uMoonCol; uniform float uMoonOn, uShadowOn, uSSize, uSTexel, uDetail, uBump;
      uniform sampler2D tShadow; uniform mat4 uShadowM;
      // game hook: daynight
      ${DN_DECL}
      uniform sampler2D tShadowS; uniform mat4 uShadowMS; uniform float uShadowOnS, uSSizeS, uSTexelS;
      ${DN_LAMP}
      varying vec3 vCol; varying float vDist; varying vec3 vW; varying vec3 vAlb; varying float vCls;
      #include <packing>
      ${GLSL_DETAIL}
      float shTap(vec2 uv, float z){ return step(z, unpackRGBAToDepth(texture2D(tShadow, uv))); }
      float shadowAt(vec3 p, vec3 n){
        vec4 sc = uShadowM * vec4(p + n * (uSTexel * 1.4), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
        if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
        float z = q.z - 0.00035;
        vec2 t = q.xy * uSSize - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSize, o = vec2(1.0 / uSSize, 0.0);
        return mix(mix(shTap(b, z), shTap(b + o.xy, z), f.x), mix(shTap(b + o.yx, z), shTap(b + o.xx, z), f.x), f.y);
      }
      float shTapS(vec2 uv, float z){ return step(z, unpackRGBAToDepth(texture2D(tShadowS, uv))); }
      float sunShadowAt(vec3 p, vec3 n){
        vec4 sc = uShadowMS * vec4(p + n * (uSTexelS * 1.4), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
        if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
        float z = q.z - 0.00035;
        vec2 t = q.xy * uSSizeS - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSizeS, o = vec2(1.0 / uSSizeS, 0.0);
        return mix(mix(shTapS(b, z), shTapS(b + o.xy, z), f.x), mix(shTapS(b + o.yx, z), shTapS(b + o.xx, z), f.x), f.y);
      }
      // sun + sky light on albedo (game hook: daynight)
      vec3 dnLight(vec3 nb, vec3 ng, vec3 p){
        float nl = max(dot(nb, uSunDir), 0.0);
        if (nl > 0.0 && uSunOn > 0.5 && uShadowOnS > 0.5) nl *= sunShadowAt(p, ng);
        vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
        return uSunCol * nl + mix(uAmbGnd, uAmbSky, nb.y * 0.5 + 0.5) + uAmbGlow * max(dot(nb, vec3(sh.x, 0.0, sh.y)), 0.0);
      }
      void main(){
        vec3 col = vCol;
        if (uDay > 0.0) {                                           // game hook: daynight (lamps: lit things fade up; unlit lamp housings, signs and windows are painted by the sky)
          float lk = dnLamp(vW.xz);
          col *= lk;
          if (vCls > 6.5 && lk < 1.0) col += max(vAlb, vec3(0.02)) * (uAmbSky * 1.1 + uSunCol * 0.12 + uAmbGnd * 0.3) * (1.0 - lk);
        }
        if (vCls < 6.5 && (uDetail > 0.5 || uMoonOn > 0.5 || uDay > 0.0)) {
          vec3 dx = dFdx(vW), dy = dFdy(vW);
          vec3 nv = normalize(cross(dx, dy));                    // faces the viewer
          vec3 ng = gl_FrontFacing ? nv : -nv;                   // the side the bake lit
          float fw = max(length(dx), length(dy));
          vec2 dt = vec2(1.0, 0.5);
          if (uDetail > 0.5 && vCls < 5.5) dt = detail(vCls, vW, ng, fw);
          col *= dt.x;
          if (uMoonOn > 0.5 || uDay > 0.0) {
            vec3 nb = ng;
            if (uDetail > 0.5 && vCls > 0.5 && vCls < 5.5 && (vCls < 3.5 || vCls > 4.5)) { nb = bumpN(vW, nv, dt.y * uBump); if (!gl_FrontFacing) nb = -nb; }   // only classes with joints
            if (uMoonOn > 0.5) {
              float ndl = max(dot(nb, uMoon), 0.0);
              if (ndl > 0.0 && uShadowOn > 0.5) ndl *= shadowAt(vW, ng);
              col += max(vAlb, vec3(0.015)) * dt.x * uMoonCol * ndl;
            }
            if (uDay > 0.0) col += max(vAlb, vec3(0.015)) * dt.x * dnLight(nb, ng, vW);       // game hook: daynight
          }
        }
        float f = 1.0 - exp(-vDist * vDist * uFogD);
        gl_FragColor = vec4(mix(col, uFog, f), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  material.defaultAttributeValues.aLay = [0];
  material.defaultAttributeValues.aAux = [0, 0, 0, 1];      // no albedo/class in the data: class 255, baked colour only

  // ── shadow maps: the whole park from one direction. The moon's is rendered once (again whenever more of the park has
  // loaded); the sun's (game hook: daynight) only while the sun is up, again when it has moved ──
  const shadow = { rt: null, size: mobile ? 2048 : 4096, ms: 0, count: 0 };
  const sunShadow = { rt: null, size: mobile ? 2048 : 4096, ms: 0, count: 0, dir: new THREE.Vector3() };
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { uShadowM: uniforms.uShadowM },
    vertexShader: `uniform mat4 uShadowM; varying float vZ;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vec4 c = uShadowM * w; vZ = c.z * 0.5 + 0.5; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `#include <packing>
      varying float vZ; void main(){ gl_FragColor = packDepthToRGBA(clamp(vZ, 0.0, 0.9999)); }`,
    side: THREE.DoubleSide,
  });
  const sunDepthMat = depthMat.clone(); sunDepthMat.uniforms = { uShadowM: uniforms.uShadowMS };
  function renderShadow(st, dirV, mat, U, renderer, scene, meshes) {
    const t0 = performance.now(), S = Math.min(st.size, renderer.capabilities.maxTextureSize);
    const moon = dirV;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
    cam.position.copy(moon).multiplyScalar(800); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse, v = new THREE.Vector3(), lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
    for (const x of [-372, 372]) for (const y of [-6, 72]) for (const z of [-372, 372]) { v.set(x, y, z).applyMatrix4(inv); lo.min(v); hi.max(v); }
    cam.left = lo.x; cam.right = hi.x; cam.bottom = lo.y; cam.top = hi.y; cam.near = -hi.z - 10; cam.far = -lo.z + 10; cam.updateProjectionMatrix();
    // our own standard (0..1 after *0.5+0.5) orthographic matrix, independent of the renderer's depth convention
    U.M.value.makeOrthographic(cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far).multiply(cam.matrixWorldInverse);
    if (!st.rt || st.rt.width !== S) {
      if (st.rt) st.rt.dispose();
      st.rt = new THREE.WebGLRenderTarget(S, S, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    }
    const set = new Set(meshes), hidden = [], swapped = [];
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.visible) return;
      if (set.has(o)) { swapped.push([o, o.material, o.geometry.drawRange.count]); o.material = mat; o.geometry.setDrawRange(0, Infinity); }
      else { o.visible = false; hidden.push(o); }
    });
    const prevRT = renderer.getRenderTarget(), prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
    const obr = scene.onBeforeRender, oar = scene.onAfterRender; scene.onBeforeRender = () => {}; scene.onAfterRender = () => {};
    renderer.setRenderTarget(st.rt); renderer.setClearColor(0xffffff, 1); renderer.autoClear = true; renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevCol, prevA); renderer.autoClear = prevAuto;
    scene.onBeforeRender = obr; scene.onAfterRender = oar;
    for (const o of hidden) o.visible = true;
    for (const [o, m, c] of swapped) { o.material = m; o.geometry.setDrawRange(0, c); }
    U.tex.value = st.rt.texture; U.size.value = S; U.texel.value = (hi.x - lo.x) / S; U.on.value = 1;
    st.ms = Math.round(performance.now() - t0); st.count++;
  }
  const moonU = { M: uniforms.uShadowM, tex: uniforms.tShadow, size: uniforms.uSSize, texel: uniforms.uSTexel, on: uniforms.uShadowOn };
  const sunU = { M: uniforms.uShadowMS, tex: uniforms.tShadowS, size: uniforms.uSSizeS, texel: uniforms.uSTexelS, on: uniforms.uShadowOnS };
  function buildShadow(renderer, scene, meshes) { renderShadow(shadow, uniforms.uMoon.value, depthMat, moonU, renderer, scene, meshes); }
  // game hook: daynight. The sun's map for direction dir (three.js axes); keeps a note of it in sunShadow.dir.
  function buildSunShadow(renderer, scene, meshes, dir) { sunShadow.dir.copy(dir); renderShadow(sunShadow, sunShadow.dir, sunDepthMat, sunU, renderer, scene, meshes); }
  return { material, uniforms, buildShadow, buildSunShadow, shadow, sunShadow, dn: DN };
}
