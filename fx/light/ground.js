// Ground maps: contact occlusion and lamp-shadow detail on the walkable ground (the LanternTown skill's gao / gsh).
//
// Per-vertex light cannot hold the dark rim where a bench meets the paving or the thin shadow of a lamp post: ground
// vertices are metres apart. Blender-Park web_export/ground.py bakes, on a 12.5 cm top-down grid over the walk grid's
// 16 m tiles, R = Cycles AO with 1 m rays (contact occlusion) and G = the lamp light that arrives with shadows / without,
// deepened against its own 1.5 m blur (only shadows smaller than the vertex spacing; the vertices hold the rest).
// web_export/groundmap.py packs the tiles that are not all 1 into data/ground.bin (planar R then G, 2.4 MB; ground_lo.bin
// at 25 cm for phones, 0.8 MB).
//
// Runtime: an atlas of tiles (RG8, 4096 x 2944 at most; 2048 x 1472 on phones) + a tile index + the walk grid's heights
// (RG8, nearest). At '// @light', on up-facing pixels within 0.3 m of the walk-grid height (so bench seats and balconies
// are left alone), the baked light is multiplied by
//     groundOcc(xz) = mix(1, ao^uGaoPow, uGao) * mix(1, c, uGsh)
// Cost: three texture reads (index, height, atlas) on floor pixels only.
//
// For other modules (wet reflections): after this module has patched the shader,
//     float groundOcc(vec2 xz)            occlusion at world xz (three.js), 1 outside the maps; ungated
//     float groundOccAt(vec3 p, vec3 n)   the same, gated to up-facing points at the ground: 1 elsewhere, and when off
// are declared before main(); multiply mirror strength / glints by groundOccAt(vW, ng) (the skill: on wet night paving
// diffuse-only occlusion is invisible).
//
// Knobs (URL hash): #u_gnd=0 off, #u_gao=0.6 (contact strength), #u_gaopow=3, #u_gsh=0.7 (lamp-shadow strength),
// #u_gndlo=1 (the 25 cm maps on desktop too). window.__park.ground: { uniforms, info }.
import * as THREE from 'three';

const DECL = /* glsl */`
  uniform sampler2D tGnd, tGndIdx, tGndNav;
  uniform vec4 uGndG;      // Blender x0, y0 of the tile grid, tile size (m), tile size (texels)
  uniform vec4 uGndA;      // tile grid width, height (tiles), atlas width, height (texels)
  uniform vec4 uGndN;      // walk grid x0, y0, cell (m), on (0/1)
  uniform float uGao, uGaoPow, uGsh;
  vec2 groundRG(vec2 b){                                   // b = Blender (x, y)
    vec2 t = (b - uGndG.xy) / uGndG.z, ti = floor(t);
    if (ti.x < 0.0 || ti.y < 0.0 || ti.x >= uGndA.x || ti.y >= uGndA.y) return vec2(1.0);
    vec2 s = texelFetch(tGndIdx, ivec2(ti), 0).rg * 255.0;
    if (s.x < 0.5) return vec2(1.0);
    vec2 f = clamp(fract(t) * uGndG.w, vec2(0.5), vec2(uGndG.w - 0.5));
    return texture(tGnd, ((s - 1.0) * uGndG.w + f) / uGndA.zw).rg;
  }
  float groundOcc(vec2 xz){
    if (uGndN.w < 0.5) return 1.0;
    vec2 g = groundRG(vec2(xz.x, -xz.y));
    return mix(1.0, pow(g.r, uGaoPow), uGao) * mix(1.0, g.g, uGsh);
  }
  float groundNear(vec3 p){                                // 1 at the walk-grid height, 0 from 0.3 m above or below
    ivec2 c = ivec2(floor((vec2(p.x, -p.z) - uGndN.xy) / uGndN.z));
    ivec2 sz = textureSize(tGndNav, 0);
    if (c.x < 0 || c.y < 0 || c.x >= sz.x || c.y >= sz.y) return 0.0;
    vec2 h = texelFetch(tGndNav, c, 0).rg * 255.0; float hv = h.x + h.y * 256.0;
    if (hv < 0.5) return 0.0;
    return 1.0 - smoothstep(0.15, 0.3, abs(p.y - ((hv - 1.0) / 100.0 - 2.0)));
  }
  float groundOccAt(vec3 p, vec3 n){
    if (uGndN.w < 0.5 || n.y < 0.7) return 1.0;
    float k = groundNear(p);
    return k > 0.0 ? mix(1.0, groundOcc(p.xz), k) : 1.0;
  }
`;
const CODE = /* glsl */`
        if (uGndN.w > 0.5 && vCls < 6.5) col *= groundOccAt(vW, ng);     // ground maps (fx/light/ground.js)
`;

export function createGround({ surface, renderer, mobile, hash = location.hash }) {
  const H = new URLSearchParams(hash.replace(/^#/, '').replace(/,/g, '&'));
  const num = (k, d) => (H.has(k) && H.get(k) !== '' && isFinite(+H.get(k)) ? +H.get(k) : d);
  const one = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGFormat); one.needsUpdate = true;
  const uniforms = {
    tGnd: { value: one }, tGndIdx: { value: one }, tGndNav: { value: one },
    uGndG: { value: new THREE.Vector4(0, 0, 16, 128) }, uGndA: { value: new THREE.Vector4(0, 0, 1, 1) }, uGndN: { value: new THREE.Vector4(0, 0, 0.5, 0) },
    uGao: { value: num('u_gao', 0.6) }, uGaoPow: { value: num('u_gaopow', 3) }, uGsh: { value: num('u_gsh', 0.7) },
  };
  const api = { uniforms, info: null, ok: false, load: async () => {} };
  const m = surface.material; let fs = m.fragmentShader;
  if (!fs.includes('// @decl') || !fs.includes('// @light')) { console.warn('ground: surface anchors not found'); return api; }
  fs = fs.replace('// @decl', DECL + '      // @decl').replace(/\/\/ @light[^\n]*\n/, (s) => s + CODE);
  m.fragmentShader = fs; Object.assign(m.uniforms, uniforms); m.needsUpdate = true;
  if (num('u_gnd', 1) === 0) return api;

  api.load = async (manifest, fetchBin, nav) => {
    const g = manifest.ground;
    if (!g || !nav) return;
    try {
      const lo = (mobile || num('u_gndlo', 0) === 1) && g.lo;
      const K = lo ? g.lo.tile : g.tile, u8 = await fetchBin(lo ? g.lo.file : g.file);
      const n = g.tiles.length, cols = Math.min(n, Math.floor(4096 / K)), rows = Math.ceil(n / cols);
      const AW = cols * K, AH = rows * K, atlas = new Uint8Array(AW * AH * 2), idx = new Uint8Array(g.tx * g.ty * 2);
      const G = n * K * K;                                   // planar file: every tile's R, then every tile's G
      for (let s = 0; s < n; s++) {
        const sx = (s % cols) * K, sy = Math.floor(s / cols) * K, src = s * K * K;
        for (let j = 0; j < K; j++) {
          let o = ((sy + j) * AW + sx) * 2; const r = src + j * K;
          for (let i = 0; i < K; i++, o += 2) { atlas[o] = u8[r + i]; atlas[o + 1] = u8[G + r + i]; }
        }
        const t = g.tiles[s]; idx[t * 2] = (s % cols) + 1; idx[t * 2 + 1] = Math.floor(s / cols) + 1;
      }
      const tex = (data, w, h, lin) => { const t = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
        t.minFilter = t.magFilter = lin ? THREE.LinearFilter : THREE.NearestFilter; t.generateMipmaps = false; t.unpackAlignment = 2; t.needsUpdate = true; return t; };
      const nv = new Uint8Array(nav.w * nav.h * 2);
      for (let k = 0; k < nav.w * nav.h; k++) { nv[k * 2] = nav.A[k] & 255; nv[k * 2 + 1] = nav.A[k] >> 8; }
      uniforms.tGnd.value = tex(atlas, AW, AH, true); uniforms.tGndIdx.value = tex(idx, g.tx, g.ty, false); uniforms.tGndNav.value = tex(nv, nav.w, nav.h, false);
      uniforms.uGndG.value.set(g.x0, g.y0, g.tile * g.texel, K); uniforms.uGndA.value.set(g.tx, g.ty, AW, AH);
      uniforms.uGndN.value.set(nav.x0, nav.y0, nav.cell, 1);
      api.ok = true; api.info = { tiles: n, texel: g.tile * g.texel / K, atlas: [AW, AH], gpuMB: +((AW * AH * 2 + nv.length) / 1e6).toFixed(1), bytes: lo ? g.lo.bytes : g.bytes };
    } catch (e) { console.warn('ground: not loaded', e); }
  };
  return api;
}
