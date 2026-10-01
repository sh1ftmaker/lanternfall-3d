// Real-time ("lit") shading for Lanternfall 3D: per-pixel analytic lights from a world-space 3D light grid,
// layered on top of the baked vertex colour, plus optional procedural surface detail.
//
// Lights: data/lit/lights.bin (tools/gen_lights.py) = Blender point/spot lights + ~24k virtual point lights made by
// clustering the emissive triangles. The grid (cell -> short list of light ids, nearest/strongest first) is built here
// at enable time. Per-vertex albedo + material class come from data/lit/aux_<part>.bin (tools/gen_aux.py).
//
// Modes (uMode):
//   0 'ratio'  C' = C * (Lpix + k) / (Lvert + k)     detail transfer: keeps the baked shadows/indirect/colour, adds the
//                                                   sub-vertex shape of every light pool. Needs no extra vertex data.
//   1 'add'    C' = C + albedo * (Lpix - Lvert)       same idea, additive (needs per-vertex albedo)
//   2 'full'   C' = albedo * (max(C/albedo - Lvert, 0) + Lpix)  direct light fully dynamic, unshadowed (light leaks!)
//   3 'off'    baked colour only (used with tex = procedural detail alone)
// Lvert = the same analytic light evaluated per vertex in the vertex shader (normals computed on the CPU from the
// geometry), interpolated like the bake. Lpix = evaluated per pixel with a flat normal from screen-space derivatives.
import * as THREE from 'three';

const MODES = { ratio: 0, add: 1, full: 2, off: 3, dbgp: 4, dbgv: 5, dbgc: 6 };

const GLSL_LIGHTS = /* glsl */`
  uniform highp sampler2D tLights; uniform highp usampler3D tGrid; uniform highp usampler2D tIdx;
  uniform vec3 uGMin; uniform vec3 uGInv; uniform ivec3 uGDim; uniform int uMaxL; uniform float uSpecK;
  // returns diffuse irradiance (baked-light units); spec accumulates a Blinn-Phong lobe if shin > 0
  vec3 lightAt(vec3 p, vec3 n, vec3 v, float shin, inout vec3 spec){
    ivec3 c = ivec3(floor((p - uGMin) * uGInv));
    if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, uGDim))) return vec3(0.0);
    uint e = texelFetch(tGrid, c.xzy, 0).r;
    int off = int(e >> 8u), cnt = min(int(e & 255u), uMaxL);
    vec3 sum = vec3(0.0);
    for (int k = 0; k < 64; k++){
      if (k >= cnt) break;
      int o = off + k;
      int li = int(texelFetch(tIdx, ivec2(o & 4095, o >> 12), 0).r);
      ivec2 t = ivec2((li & 511) << 2, li >> 9);
      vec4 L0 = texelFetch(tLights, t, 0);
      vec3 dv = L0.xyz - p; float d2 = dot(dv, dv);
      if (d2 >= L0.w * L0.w) continue;
      vec4 L1 = texelFetch(tLights, t + ivec2(1, 0), 0);
      vec4 L2 = texelFetch(tLights, t + ivec2(2, 0), 0);
      vec4 L3 = texelFetch(tLights, t + ivec2(3, 0), 0);
      float d = sqrt(d2); vec3 l = dv / max(d, 1e-4);
      float ndl = max(dot(n, l), 0.0);
      float q = d2 / (L0.w * L0.w); float win = clamp(1.0 - q * q, 0.0, 1.0); win *= win;
      float ca = -dot(l, L2.xyz);
      float ang = (L2.w + L3.z * max(ca, 0.0)) * smoothstep(L3.x, L3.y, ca);
      vec3 li3 = L1.rgb * (ang * win / (d2 + L1.w * L1.w));
      sum += li3 * ndl;
      if (shin > 0.0) { vec3 h = normalize(l + v); spec += li3 * ndl * pow(max(dot(n, h), 0.0), shin); }
    }
    return sum;
  }`;

const GLSL_DETAIL = /* glsl */`
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
  // bond pattern: returns (tone, groutMask) for running-bond blocks of size s with grout width g (in metres)
  vec2 bond(vec2 uv, vec2 s, float g, float fw){
    vec2 q = uv / s; q.x += 0.5 * floor(q.y); vec2 id = floor(q); vec2 f = fract(q) * s;
    vec2 e = min(f, s - f); float gm = 1.0 - smoothstep(g - fw, g + fw, min(e.x, e.y));
    return vec2(h21(id), gm);
  }
  // procedural detail for material class cls: returns (albedo multiplier, height in [0,1]); n = flat normal,
  // p = world position, fw = pixel footprint (m). Detail fades out before it can alias.
  vec2 detail(float cls, vec3 p, vec3 n, float fw){
    vec3 an = abs(n);
    bool up = an.y > 0.7;
    vec2 uv = up ? p.xz : (an.x > an.z ? p.zy : p.xy);
    float m = 1.0, h = 0.0, f = 0.0;
    if (cls < 0.5) {                                   // plain: faint mottling
      m = 0.94 + 0.12 * vn(uv * 2.3); h = 0.5; f = 1.0 - smoothstep(0.08, 0.4, fw);
    } else if (cls < 1.5) {                            // paving: setts in running bond
      vec2 b = bond(uv, vec2(0.40, 0.27), 0.03, fw * 0.7);
      float nz = vn(uv * 7.0);
      m = (0.74 + 0.46 * b.x) * (1.0 - 0.6 * b.y) * (0.88 + 0.24 * nz); h = (1.0 - b.y) * (0.8 + 0.2 * nz); m *= 1.18;
      f = 1.0 - smoothstep(0.025, 0.12, fw);
    } else if (cls < 2.5) {                            // wood: planks
      float pl = floor(uv.y / 0.16); float t = h21(vec2(pl, 3.1));
      float e = abs(fract(uv.y / 0.16) - 0.5) * 2.0; float gm = smoothstep(0.86 - fw * 6.0, 0.98, e);
      float grain = 0.92 + 0.16 * vn(vec2(uv.x * 1.3, uv.y * 40.0 + pl * 7.0));
      m = (0.82 + 0.3 * t) * grain * (1.0 - 0.45 * gm) * 1.03; h = 1.0 - gm; f = 1.0 - smoothstep(0.025, 0.12, fw);
    } else if (cls < 3.5) {                            // masonry: ashlar blocks on walls, mottled tops
      if (up) { m = 0.88 + 0.24 * vn(uv * 1.7) * vn(uv * 6.0 + 3.0); h = 0.5; f = 1.0 - smoothstep(0.1, 0.5, fw); }
      else {
        vec2 b = bond(uv, vec2(0.58, 0.29), 0.018, fw * 0.7);
        m = (0.84 + 0.3 * b.x) * (1.0 - 0.45 * b.y) * (0.92 + 0.16 * vn(uv * 9.0)) * 1.06; h = 1.0 - b.y;
        f = 1.0 - smoothstep(0.03, 0.14, fw);
      }
    } else if (cls < 4.5) {                            // organic: grass / foliage / snow mottling
      m = 0.70 + 0.3 * vn(uv * 1.1) + 0.18 * vn(uv * 5.3 + 7.0); h = 0.5; f = 1.0 - smoothstep(0.15, 0.9, fw);
    } else if (cls < 5.5) {                            // roof: overlapping tile rows (world height bands)
      float r = fract(p.y / 0.2); float c = floor(uv.x / 0.3 + 0.5 * floor(p.y / 0.2));
      m = (0.72 + 0.42 * r) * (0.88 + 0.22 * h21(vec2(c, floor(p.y / 0.2)))); h = r; f = 1.0 - smoothstep(0.03, 0.12, fw);
    }
    return vec2(mix(1.0, m, f), h * f);
  }
  // bump the flat normal by a scalar height field (metres), screen-space derivatives (as three.js bumpmap)
  vec3 bumpN(vec3 p, vec3 n, float hgt){
    vec3 dpx = dFdx(p), dpy = dFdy(p); float dhx = dFdx(hgt), dhy = dFdy(hgt);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1);
    vec3 g = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * n - g);
  }`;

export function createLit({ renderer, scene, bakedMat, DATA, fetchBin, Q, moon }) {
  const ok = renderer.capabilities.isWebGL2;
  const state = { mode: 'ratio', tex: true, spec: true, shadow: true, shadowSize: 4096, on: false, ready: false, scene, moonDir: moon || new THREE.Vector3(-0.5, 0.6, 0.6), moonCol: [0.62, 0.74, 1.0], moonStrength: 0.55, loading: null, meshes: [], cell: [4, 4], maxL: 8, k: 0.04, stats: {} };
  let lights = null, aux = null, mat = null, grid = null;
  const uniforms = THREE.UniformsUtils.merge([{
    uRange: { value: 32 }, uFog: { value: bakedMat.uniforms.uFog.value }, uFogD: { value: 2.4e-7 },
    tLights: { value: null }, tGrid: { value: null }, tIdx: { value: null },
    uGMin: { value: new THREE.Vector3() }, uGInv: { value: new THREE.Vector3() }, uGDim: { value: new THREE.Vector3() },
    uMaxL: { value: 8 }, uMode: { value: 0 }, uTex: { value: 1 }, uSpec: { value: 1 }, uK: { value: 0.04 }, uSpecK: { value: 1 },
    uVert: { value: 1 }, uBump: { value: 0.012 },
    tShadow: { value: null }, uShadowM: { value: new THREE.Matrix4() }, uShadow: { value: 0 }, uMoon: { value: new THREE.Vector3(0, 1, 0) },
    uMoonCol: { value: new THREE.Vector3() }, uSTexel: { value: 0.2 },
  }]);
  uniforms.uFog = bakedMat.uniforms.uFog; uniforms.uFogD = bakedMat.uniforms.uFogD; uniforms.uRange = bakedMat.uniforms.uRange;

  function makeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        precision highp float; precision highp int;
        attribute vec4 aCol; attribute vec3 aNrm; attribute vec4 aAux;
        uniform float uRange; uniform int uVert;
        uniform highp sampler2DShadow tShadow; uniform mat4 uShadowM; uniform int uShadow; uniform vec3 uMoon; uniform vec3 uMoonCol; uniform float uSTexel;
        float shadowAt(vec3 p, vec3 n, int taps){
          vec4 sc = uShadowM * vec4(p + n * (uSTexel * 1.5), 1.0); vec3 q = sc.xyz / sc.w * 0.5 + 0.5;
          if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
          q.z -= 0.0004;
          if (taps == 1) return texture(tShadow, q);
          vec2 o = vec2(1.0 / float(textureSize(tShadow, 0).x), 0.0);
          return (texture(tShadow, q) * 2.0 + texture(tShadow, q + o.xyy) + texture(tShadow, q - o.xyy) + texture(tShadow, q + o.yxy) + texture(tShadow, q - o.yxy)) / 6.0;
        }
        varying vec3 vCol; varying float vDist; varying vec3 vW; varying vec3 vN; varying vec3 vLv; varying vec3 vAlb; varying float vCls; varying float vMoonV;
        ${GLSL_LIGHTS}
        void main(){
          vCol = aCol.rgb * (aCol.a * uRange);
          vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
          vN = normalize(aNrm);
          vAlb = aAux.rgb * aAux.rgb; vCls = floor(aAux.a * 255.0 + 0.5);
          vec3 sp = vec3(0.0);
          vLv = (uVert == 1 && vCls < 6.5) ? lightAt(w.xyz + vN * 0.03, vN, vN, 0.0, sp) : vec3(0.0);
          vMoonV = (uShadow == 1 && vCls < 6.5) ? shadowAt(w.xyz, vN, 1) * max(dot(vN, uMoon), 0.0) : 0.0;
          vec4 mv = viewMatrix * w; vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        precision highp float; precision highp int;
        uniform vec3 uFog; uniform float uFogD; uniform int uMode; uniform int uTex; uniform float uBump; uniform int uSpec; uniform float uK;
        varying vec3 vCol; varying float vDist; varying vec3 vW; varying vec3 vN; varying vec3 vLv; varying vec3 vAlb; varying float vCls; varying float vMoonV;
        uniform highp sampler2DShadow tShadow; uniform mat4 uShadowM; uniform int uShadow; uniform vec3 uMoon; uniform vec3 uMoonCol; uniform float uSTexel;
        float shadowAt(vec3 p, vec3 n, int taps){
          vec4 sc = uShadowM * vec4(p + n * (uSTexel * 1.5), 1.0); vec3 q = sc.xyz / sc.w * 0.5 + 0.5;
          if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
          q.z -= 0.0004;
          if (taps == 1) return texture(tShadow, q);
          vec2 o = vec2(1.0 / float(textureSize(tShadow, 0).x), 0.0);
          return (texture(tShadow, q) * 2.0 + texture(tShadow, q + o.xyy) + texture(tShadow, q - o.xyy) + texture(tShadow, q + o.yxy) + texture(tShadow, q - o.yxy)) / 6.0;
        }
        ${GLSL_LIGHTS}
        ${GLSL_DETAIL}
        void main(){
          vec3 dx = dFdx(vW), dy = dFdy(vW);
          vec3 n = normalize(cross(dx, dy)); if (dot(n, vN) < 0.0) n = -n;
          float fw = max(length(dx), length(dy));
          vec3 col = vCol;
          bool emis = vCls > 6.5;
          vec2 dt = vec2(1.0, 0.0);
          if (uTex == 1) { dt = detail(vCls, vW, n, fw); if (emis) dt = vec2(1.0, 0.0); n = bumpN(vW, n, dt.y * uBump); }
          if (!emis && uMode != 3) {
            vec3 v = normalize(cameraPosition - vW);
            float shin = (uSpec == 1 && (vCls > 5.5 || (vCls > 0.5 && vCls < 1.5))) ? (vCls > 5.5 ? 40.0 : 24.0) : 0.0;
            vec3 spec = vec3(0.0);
            vec3 lp = lightAt(vW + n * 0.03, n, v, shin, spec);
            vec3 alb = max(vAlb, vec3(0.02));
            if (uMode == 0) col = vCol * clamp((lp + uK) / (vLv + uK), 0.15, 6.0);
            else if (uMode == 1) col = max(vCol + alb * (lp - vLv), 0.0);
            else if (uMode == 2) col = alb * (max(vCol / alb - vLv, 0.0) + lp);
            else if (uMode == 4) col = alb * lp;
            else if (uMode == 5) col = alb * vLv;
            else { ivec3 c = ivec3(floor((vW - uGMin) * uGInv)); uint e = texelFetch(tGrid, c.xzy, 0).r; float k = float(e & 255u) / 24.0;
              col = vec3(k, 1.0 - abs(k - 0.5) * 2.0, 1.0 - k) * 0.5; }
            if (shin > 0.0) {                 // glossy paving / metal; baked shadowing as visibility (C / (albedo * Lvert))
              float vis = clamp(dot(vCol, vec3(0.33)) / max(dot(alb * vLv, vec3(0.33)), 1e-3), 0.0, 1.0);
              col += spec * (vCls > 5.5 ? 0.5 : 0.22) * vis * (uMode == 2 ? 1.0 : vis);
            }
          }
          if (uShadow == 1 && !emis) {        // moonlight: per-pixel shadow-mapped term replaces the interpolated per-vertex one
            float mp = shadowAt(vW, n, 5) * max(dot(n, uMoon), 0.0);
            col = max(col + max(vAlb, vec3(0.02)) * uMoonCol * (mp - vMoonV), 0.0);
          }
          if (uTex == 1 && !emis) col *= dt.x;
          float f = 1.0 - exp(-vDist * vDist * uFogD);
          gl_FragColor = vec4(mix(col, uFog, f), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
    });
  }

  async function loadData() {
    const t0 = performance.now();
    const meta = await (await fetch(DATA + 'lit/aux.json')).json();
    const lb = await fetchBin('lit/lights.bin');
    lights = new Float32Array(lb.buffer, lb.byteOffset, lb.byteLength / 4).slice();
    aux = meta;
    state.stats.lights = lights.length / 16; state.stats.loadMs = performance.now() - t0;
  }

  function buildGrid(cellXZ, cellY, maxL) {
    const t0 = performance.now();
    const N = lights.length / 16;
    const gmin = [-372, -6, -372], gmax = [372, 58, 372];
    const D = [Math.ceil((gmax[0] - gmin[0]) / cellXZ), Math.ceil((gmax[1] - gmin[1]) / cellY), Math.ceil((gmax[2] - gmin[2]) / cellXZ)];
    const ncell = D[0] * D[1] * D[2];
    // pass 1: count candidates per cell; pass 2: fill (cell, importance) pairs
    const cellOf = (x, y, z) => x + D[0] * (z + D[2] * y);   // matches Data3DTexture(width=X, height=Z, depth=Y)
    const counts = new Uint32Array(ncell);
    const ranges = (i, f) => {
      const o = i * 16, px = lights[o], py = lights[o + 1], pz = lights[o + 2], r = lights[o + 3];
      const x0 = Math.max(0, Math.floor((px - r - gmin[0]) / cellXZ)), x1 = Math.min(D[0] - 1, Math.floor((px + r - gmin[0]) / cellXZ));
      const y0 = Math.max(0, Math.floor((py - r - gmin[1]) / cellY)), y1 = Math.min(D[1] - 1, Math.floor((py + r - gmin[1]) / cellY));
      const z0 = Math.max(0, Math.floor((pz - r - gmin[2]) / cellXZ)), z1 = Math.min(D[2] - 1, Math.floor((pz + r - gmin[2]) / cellXZ));
      const imax = (0.2126 * lights[o + 4] + 0.7152 * lights[o + 5] + 0.0722 * lights[o + 6]) * (lights[o + 11] + lights[o + 14]), s2 = lights[o + 7] ** 2;
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const bx0 = gmin[0] + x * cellXZ, by0 = gmin[1] + y * cellY, bz0 = gmin[2] + z * cellXZ;
        const dx = Math.max(bx0 - px, 0, px - bx0 - cellXZ), dy = Math.max(by0 - py, 0, py - by0 - cellY), dz = Math.max(bz0 - pz, 0, pz - bz0 - cellXZ);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) continue;
        f(cellOf(x, y, z), imax * (1 - (d2 / (r * r))) / (d2 + s2 + 0.25));
      }
    };
    for (let i = 0; i < N; i++) ranges(i, (c) => counts[c]++);
    const start = new Uint32Array(ncell + 1); for (let c = 0; c < ncell; c++) start[c + 1] = start[c] + counts[c];
    const total = start[ncell], ids = new Uint16Array(total), imp = new Float32Array(total), fill = start.slice(0, ncell);
    for (let i = 0; i < N; i++) ranges(i, (c, w) => { const k = fill[c]++; ids[k] = i; imp[k] = w; });
    // per cell: keep the maxL most important lights, strongest first
    const out = []; let outN = 0, capped = 0, maxc = 0, sum = 0, nonEmpty = 0;
    const gridArr = new Uint32Array(ncell);
    const tmp = [];
    const idxOut = new Uint16Array(Math.min(total, ncell * maxL));
    for (let c = 0; c < ncell; c++) {
      const a = start[c], n = counts[c]; if (!n) continue;
      nonEmpty++; maxc = Math.max(maxc, n);
      let keep = n;
      if (n > maxL) {
        capped++; tmp.length = 0; for (let k = a; k < a + n; k++) tmp.push(k);
        tmp.sort((p, q) => imp[q] - imp[p]); keep = maxL;
        for (let k = 0; k < keep; k++) idxOut[outN + k] = ids[tmp[k]];
      } else for (let k = 0; k < n; k++) idxOut[outN + k] = ids[a + k];
      gridArr[c] = (outN << 8) | keep; outN += keep; sum += keep;
    }
    const W = 4096, H = Math.max(1, Math.ceil(outN / W));
    const idxTex = new Uint16Array(W * H); idxTex.set(idxOut.subarray(0, outN));
    const tIdx = new THREE.DataTexture(idxTex, W, H, THREE.RedIntegerFormat, THREE.UnsignedShortType); tIdx.internalFormat = 'R16UI';
    const tGrid = new THREE.Data3DTexture(gridArr, D[0], D[2], D[1]); tGrid.format = THREE.RedIntegerFormat; tGrid.type = THREE.UnsignedIntType; tGrid.internalFormat = 'R32UI';
    for (const t of [tIdx, tGrid]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true; }
    if (grid) { grid.tIdx.dispose(); grid.tGrid.dispose(); }
    grid = { tIdx, tGrid };
    uniforms.tIdx.value = tIdx; uniforms.tGrid.value = tGrid;
    uniforms.uGMin.value.set(gmin[0], gmin[1], gmin[2]); uniforms.uGInv.value.set(1 / cellXZ, 1 / cellY, 1 / cellXZ);
    uniforms.uGDim.value.set(D[0], D[1], D[2]);
    state.stats.grid = { cells: ncell, dims: D, nonEmpty, capped, maxCandidates: maxc, avgKept: +(sum / Math.max(1, nonEmpty)).toFixed(1), entries: outN, ms: Math.round(performance.now() - t0), cellXZ, cellY, maxL };
  }

  function lightTexture() {
    const N = lights.length / 16, rows = Math.ceil(N / 512);
    const data = new Float32Array(2048 * rows * 4); data.set(lights);
    const t = new THREE.DataTexture(data, 2048, rows, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    uniforms.tLights.value = t;
  }

  function vertexNormals(g) {
    const pos = g.attributes.position.array, idx = g.index.array, nv = pos.length / 3;
    const acc = new Float32Array(nv * 3);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;   // area-weighted
      acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz; acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz; acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
    }
    const out = new Int8Array(nv * 3);
    for (let i = 0; i < nv * 3; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
      out[i] = Math.round(acc[i] / l * 127); out[i + 1] = Math.round(acc[i + 1] / l * 127); out[i + 2] = Math.round(acc[i + 2] / l * 127);
    }
    g.setAttribute('aNrm', new THREE.BufferAttribute(out, 3, true));
  }

  function decodeAux(u8, off, nv) {
    const out = new Uint8Array(nv * 4);
    for (let c = 0; c < 4; c++) { const o = off + c * nv; let acc = 0; for (let i = 0; i < nv; i++) { const zz = u8[o + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; out[i * 4 + c] = acc; } }
    return out;
  }

  function buildShadow(scene) {
    const t0 = performance.now(), S = state.shadowSize;
    const moon = state.moonDir.clone().normalize();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
    cam.position.copy(moon).multiplyScalar(800); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse, v = new THREE.Vector3(), lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
    for (const x of [-372, 372]) for (const y of [-6, 62]) for (const z of [-372, 372]) { v.set(x, y, z).applyMatrix4(inv); lo.min(v); hi.max(v); }
    cam.left = lo.x; cam.right = hi.x; cam.bottom = lo.y; cam.top = hi.y; cam.near = -hi.z - 10; cam.far = -lo.z + 10; cam.updateProjectionMatrix();
    const dt = new THREE.DepthTexture(S, S); dt.type = THREE.UnsignedIntType; dt.compareFunction = THREE.LessEqualCompare;
    dt.minFilter = dt.magFilter = THREE.LinearFilter;
    const rt = new THREE.WebGLRenderTarget(S, S, { depthTexture: dt, depthBuffer: true });
    const depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    const hidden = [];
    scene.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine) && o.visible) { const keep = (o.material && o.material.isShaderMaterial && state.meshes.some((e) => e.mesh === o && e.m.kind === 'opaque')) || o.isInstancedMesh; if (!keep) { o.visible = false; hidden.push(o); } } });
    const ranges = state.meshes.map((e) => [e.mesh.geometry.drawRange.count]); state.meshes.forEach((e) => e.mesh.geometry.setDrawRange(0, Infinity));
    const prevO = scene.overrideMaterial, prevRT = renderer.getRenderTarget(), prevBg = scene.background;
    scene.overrideMaterial = depthMat; renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
    scene.overrideMaterial = prevO; renderer.setRenderTarget(prevRT); scene.background = prevBg;
    for (const o of hidden) o.visible = true;
    state.meshes.forEach((e, i) => e.mesh.geometry.setDrawRange(0, ranges[i][0]));
    depthMat.dispose();
    uniforms.tShadow.value = dt; uniforms.uShadowM.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    uniforms.uMoon.value.copy(moon); uniforms.uSTexel.value = (hi.x - lo.x) / S;
    const c = state.moonCol; uniforms.uMoonCol.value.set(c[0], c[1], c[2]).multiplyScalar(state.moonStrength / Math.PI);
    state.stats.shadow = { size: S, texelM: +((hi.x - lo.x) / S).toFixed(3), ms: Math.round(performance.now() - t0) };
  }

  async function prepare() {
    if (state.ready) return;
    if (!ok) throw new Error('lit mode needs WebGL2');
    await loadData();
    lightTexture(); buildGrid(state.cell[0], state.cell[1], state.maxL);
    mat = makeMaterial();
    const t0 = performance.now();
    const byPart = {};
    for (const e of state.meshes) if (e.m.kind === 'opaque') (byPart[e.part] = byPart[e.part] || []).push(e);
    let nAttached = 0;
    for (const [part, list] of Object.entries(byPart)) {
      const info = aux.parts[part]; let u8 = null, off = 0;
      if (info) u8 = await fetchBin('lit/' + info.file);
      list.forEach((e, k) => {
        const nv = info ? info.nv[k] : 0, g = e.mesh.geometry;
        if (!nv || nv !== g.attributes.position.count) { if (nv) off += nv * 4; return; }
        g.setAttribute('aAux', new THREE.BufferAttribute(decodeAux(u8, off, nv), 4, true)); off += nv * 4;
        vertexNormals(g); e.lit = true; nAttached++;
      });
      await new Promise((r) => setTimeout(r, 0));
    }
    state.stats.attachMs = Math.round(performance.now() - t0); state.stats.attached = nAttached;
    if (state.scene) buildShadow(state.scene);
    state.ready = true;
  }

  function apply() {
    uniforms.uMode.value = MODES[state.mode] ?? 0; uniforms.uTex.value = state.tex ? 1 : 0; uniforms.uSpec.value = state.spec ? 1 : 0;
    uniforms.uK.value = state.k; uniforms.uBump.value = state.bump ?? 0.012; uniforms.uMaxL.value = state.maxL;
    uniforms.uVert.value = (state.mode === 'off' || state.vert === false) ? 0 : 1; uniforms.uShadow.value = state.shadow ? 1 : 0;
    const use = state.on && state.ready;
    for (const e of state.meshes) if (e.lit) e.mesh.material = use ? mat : bakedMat;
  }

  // Deferred-style probe: draw every light's range sphere (back faces, depth GREATER-EQUAL against the scene) additively
  // into a float target and count how many light volumes touch each visible pixel. This is the per-pixel light count a
  // light-volume accumulation pass would shade, and the pass time is a lower bound for its cost.
  function volumeProbe(scene, camera) {
    const N = lights.length / 16, geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }', side: THREE.BackSide, depthWrite: false, depthFunc: THREE.GreaterEqualDepth,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    const im = new THREE.InstancedMesh(geo, mat, N), M = new THREE.Matrix4();
    for (let i = 0; i < N; i++) { const o = i * 16, r = lights[o + 3] * 1.08; M.makeScale(r, r, r).setPosition(lights[o], lights[o + 1], lights[o + 2]); im.setMatrixAt(i, M); }
    im.frustumCulled = false;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2()), w = size.x >> 1, h = size.y >> 1;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: true });
    const prev = renderer.getRenderTarget(), vis = [];
    renderer.setRenderTarget(rt); renderer.render(scene, camera);            // scene depth
    scene.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints)) { vis.push(o); o.visible = false; } });
    const sc2 = new THREE.Scene(); sc2.add(im); renderer.autoClear = false; renderer.setClearColor(0, 0); renderer.clearColor();
    const g = renderer.getContext(); g.finish(); const t0 = performance.now();
    renderer.render(sc2, camera); g.finish(); const ms = performance.now() - t0;
    const px = new Float32Array(w * h * 4); renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.autoClear = true; renderer.setClearColor(0x05040f, 1); for (const o of vis) o.visible = true; renderer.setRenderTarget(prev);
    let sum = 0, mx = 0, lit = 0; for (let i = 0; i < w * h; i++) { const v = px[i * 4]; sum += v; mx = Math.max(mx, v); if (v > 0) lit++; }
    rt.dispose(); geo.dispose(); mat.dispose();
    return { avgVolumesPerPixel: +(sum / (w * h)).toFixed(2), maxPerPixel: mx, litFraction: +(lit / (w * h)).toFixed(2), passMsHalfRes: +ms.toFixed(2) };
  }

  return {
    state,
    volumeProbe: (scene, camera) => volumeProbe(scene, camera),
    register(mesh, m, part) { state.meshes.push({ mesh, m, part, lit: false }); },
    async set(opts = {}) {
      Object.assign(state, opts);
      if (opts.cell || opts.maxL) { if (state.ready) buildGrid(state.cell[0], state.cell[1], state.maxL); }
      if (state.on && !state.ready) { state.loading = state.loading || prepare(); await state.loading; }
      apply();
      return { mode: state.mode, tex: state.tex, on: state.on, stats: state.stats };
    },
  };
}

// URL hash: #lit (= local lights 'ratio' + moon shadows + procedural detail), #lit=ratio|add|full|off|dbgp|dbgv|dbgc,
// #tex (procedural detail only), #shadow (moon shadows only); modifiers notex, nospec, noshadow, k=0.04, maxl=8, cell=4x4
export function litFromHash(hash) {
  const h = (hash || '').replace(/^#/, '').split(/[&,]/);
  const o = {}; let any = false;
  for (const t of h) {
    const [k, v] = t.split('=');
    if (k === 'lit') { any = true; o.on = true; if (v) o.mode = v; }
    if (k === 'tex') { any = true; o.on = true; o.tex = true; if (!h.some((x) => x.startsWith('lit'))) o.mode = 'off'; }
    if (k === 'notex') o.tex = false;
    if (k === 'nospec') o.spec = false;
    if (k === 'noshadow') o.shadow = false;
    if (k === 'shadow') { any = true; o.on = true; o.shadow = true; if (!h.some((x) => x.startsWith('lit'))) o.mode = 'off'; }
    if (k === 'k') o.k = +v;
    if (k === 'maxl') o.maxL = +v;
    if (k === 'cell') o.cell = v.split('x').map(Number);
  }
  return any ? o : null;
}
