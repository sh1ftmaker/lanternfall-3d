// Tiling PBR materials on the park's surfaces (the LanternTown skill's procedural materials, baked offline by
// tools/materials/build.py into one KTX2 texture array; transcoded on the device to ASTC 4x4 / BC7 / ETC2).
//
// The park has no UVs: each triangle carries a material slot (web_export/pack.py MATSLOTS, the optional "mat" plane,
// attribute aMat; names in manifest.matslots), and the texture is projected in world space by the flat face normal:
//   - floors (|n.y| > 0.7): world XZ; paving (class 1) is laid along the ring like fx/surface.js detail();
//   - walls: the same major-axis plane as detail(), V up (courses horizontal);
//   - roof layers on sloped faces: U along the eave, V up the slope (courses follow the pitch).
// One texture read per pixel (RGBA: R = sqrt(luminance ratio / 4), GB = normal xy, A = roughness), with explicit
// gradients from the world-position derivatives, so the projection seams never pick a wrong mip. At '// @surface':
//   dt.x  albedo multiplier = texture luminance / layer mean (x AO), so the baked light and the vertex albedo (the theme
//         colours) stay right: the texture only modulates them (the skill's albedo * tint / mean_albedo);
//   dt.y  a height proxy (joints low), as before;
//   nb    the normal map in the face's frame, so the moon, the sun and the wet reflections respond;
//   matRough  roughness 0..1 of the material under the pixel, -1 where there is none (for the wet look: modules after
//         '// @surface' may read it, e.g. gloss = 1.0 - matRough);
//   matOn 1 where a material was applied (the class bump of fx/surface.js is skipped there).
// Far away the mips average the pattern out and the effect fades to the plain baked colour before it can alias.
//
// Knobs (URL hash): #u_mat=0 off, #u_matamt=1 (albedo strength), #u_matbump=1 (normal strength), #u_matres=256 (512 if built),
// #u_matscale=1 (tile size multiplier), #u_matoff=moss+hedge (layers left to the procedural pattern; default moss+slate). window.__park.materials: { uniforms, setLayers(off) }.
import * as THREE from 'three';

const MAX_SLOTS = 32, MAX_LAYERS = 24;
// layers drawn with the roof frame on sloped faces
const ROOF = new Set(['roof_tile_clay', 'roof_slate', 'wood_shingle']);
// a wall material seen on an up-facing face uses this layer instead (wall tops, stone floors laid in a wall material)
const FLOOR = { ashlar_limestone: 'flagstone_york', brick_red: 'flagstone_york', rubble_fieldstone: 'cobble_granite', plaster_lime: '', wood_weathered: 'wood_planks' };
// per-layer strength (albedo, normal); hedges and moss are high-contrast in the skill's bake: quieter here
const GAIN = { hedge: [0.55, 0.6], moss: [0.6, 0.7], soil: [0.7, 0.8], gravel: [0.8, 0.9], plaster_lime: [1.0, 1.4],
  flagstone_york: [1.25, 1], cobble_granite: [1.15, 1], sett_basalt: [1.2, 1] };
// tile size x this: the stylised park reads better with bolder units than the skill's true-scale setts and cobbles
const SCALE = { sett_basalt: 1.8, cobble_granite: 1.4 };
// left to the procedural pattern by default (judged worse on the park's low-poly forms; see the report)
const OFF_DEFAULT = ['moss', 'slate'];

const DECL = /* glsl */`
  uniform highp sampler2DArray tMat;
  uniform float uMatOn, uMatAmt, uMatBump, uMatRes;
  uniform float uMatL[${MAX_SLOTS}], uMatF[${MAX_SLOTS}];
  uniform vec4 uMatT[${MAX_LAYERS}];     // 1/tileW, 1/tileH, albedo gain, normal gain
  uniform vec2 uMatQ[${MAX_LAYERS}];     // far-mean of the sqrt-coded ratio (Jensen correction), roof frame flag
`;

const CODE = /* glsl */`
          float matRough = -1.0, matOn = 0.0;
          if (uMatOn > 0.5 && vMat > 0.5) {
            int ms = int(vMat + 0.5);
            vec3 an = abs(ng); bool up = an.y > 0.7;
            float lay = up ? uMatF[ms] : uMatL[ms];
            if (lay > -0.5) {
              int li = int(lay + 0.5); vec4 tp = uMatT[li]; vec2 tq = uMatQ[li];
              vec3 T, B;
              if (tq.y > 0.5 && an.y > 0.05 && an.y < 0.995) {          // roof: U along the eave, V up the slope
                B = normalize(vec3(0.0, 1.0, 0.0) - ng * ng.y); T = cross(B, ng);
              } else if (up) {                                           // floor: world XZ (paving along the ring)
                float a = 0.0;
                if (vCls > 0.5 && vCls < 1.5) a = (floor(atan(vW.z, vW.x) / 0.2244 + 0.5)) * 0.2244;
                T = vec3(cos(a), 0.0, sin(a)); B = cross(vec3(0.0, sign(ng.y), 0.0), T);
              } else {                                                   // wall: the major-axis plane, V up
                vec3 na = an.x > an.z ? vec3(sign(ng.x), 0.0, 0.0) : vec3(0.0, 0.0, sign(ng.z));
                B = vec3(0.0, 1.0, 0.0); T = cross(B, na);
              }
              vec2 sc = tp.xy;
              vec2 uv = vec2(dot(vW, T), dot(vW, B)) * sc;
              vec2 gx = vec2(dot(dx, T), dot(dx, B)) * sc, gy = vec2(dot(dy, T), dot(dy, B)) * sc;
              float lod = log2(max(max(length(gx), length(gy)) * uMatRes, 1e-6));
              float fade = 1.0 - smoothstep(5.0, 7.5, lod);              // a pixel over 32..180 texels: fade out
              if (fade > 0.0) {
                vec4 tx = textureGrad(tMat, vec3(fract(uv), lay), gx, gy);
                float q = tx.r * tx.r * 4.0;
                float ratio = q / mix(1.0, tq.x, smoothstep(1.0, 6.0, lod));
                float big = up ? 0.9 + 0.2 * vn(vW.xz * 0.31 + 7.0) : 1.0;  // breaks the tile repeat on wide floors
                float k = uMatAmt * tp.z * fade;
                dt = vec2(max(mix(1.0, ratio * big, k), 0.04), mix(0.5, smoothstep(0.25, 1.1, ratio), fade));
                vec2 nxy = (tx.gb * 2.0 - 1.0) * (uMatBump * tp.w * fade);
                vec3 Tn = normalize(T - ng * dot(T, ng)), Bn = cross(ng, Tn);
                nb = normalize(Tn * nxy.x + Bn * nxy.y + ng * sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
                matRough = mix(0.8, tx.a, fade); matOn = 1.0;
              }
            }
          }
`;

export function createMaterials({ surface, renderer, mobile, DATA = 'data/', hash = location.hash }) {
  const H = new URLSearchParams(hash.replace(/^#/, '').replace(/,/g, '&'));
  const num = (k, d) => (H.has(k) && H.get(k) !== '' && isFinite(+H.get(k)) ? +H.get(k) : d);
  const uniforms = {
    tMat: { value: null }, uMatOn: { value: 0 }, uMatAmt: { value: num('u_matamt', 1) }, uMatBump: { value: num('u_matbump', 1) },
    uMatRes: { value: 512 },
    uMatL: { value: new Array(MAX_SLOTS).fill(-1) }, uMatF: { value: new Array(MAX_SLOTS).fill(-1) },
    uMatT: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4(1, 1, 1, 1)) },
    uMatQ: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector2(1, 0)) },
  };
  const uScale = num('u_matscale', 1);
  const api = { uniforms, info: null, ok: false, setManifest() {}, setLayers() {} };
  if (num('u_mat', 1) === 0) return api;

  // ── patch the surface shader (before it first compiles) ──
  const m = surface.material;
  let vs = m.vertexShader, fs = m.fragmentShader;
  const vAnchor = 'vCls = floor(aAux.a * 255.0 + 0.5);';
  const bump = 'if (uDetail > 0.5 && vCls > 0.5 && vCls < 5.5 && (vCls < 3.5 || vCls > 4.5)) { nb = bumpN(';
  if (!vs.includes(vAnchor) || !fs.includes('// @surface') || !fs.includes('// @decl') || !fs.includes(bump)) { console.warn('materials: surface anchors not found'); return api; }
  vs = vs.replace('attribute vec4 aAux;', 'attribute vec4 aAux; attribute float aMat; varying float vMat;').replace(vAnchor, vAnchor + ' vMat = aMat;');
  fs = fs.replace('// @decl', DECL + '      varying float vMat;\n      // @decl')
    .replace(/\/\/ @surface[^\n]*\n/, (s) => s + CODE)
    .replace(bump, 'if (matOn < 0.5 && uDetail > 0.5 && vCls > 0.5 && vCls < 5.5 && (vCls < 3.5 || vCls > 4.5)) { nb = bumpN(');
  m.vertexShader = vs; m.fragmentShader = fs; Object.assign(m.uniforms, uniforms);
  m.defaultAttributeValues.aMat = [0];
  m.needsUpdate = true;

  // ── layers: slot names (manifest) -> texture layers (mat.json) ──
  let slots = null, layers = null;
  let off = new Set(H.has('u_matoff') ? H.get('u_matoff').split(/[+;| ]/).filter(Boolean) : OFF_DEFAULT);
  function apply() {
    if (!slots || !layers) return;
    const idx = new Map(layers.map((l, i) => [l.name, i]));
    const pick = (n) => (n && !off.has(n) && idx.has(n) ? idx.get(n) : -1);
    slots.forEach((n, s) => {
      if (s >= MAX_SLOTS) return;
      uniforms.uMatL.value[s] = pick(n);
      uniforms.uMatF.value[s] = n in FLOOR ? pick(FLOOR[n]) : pick(n);
    });
    layers.forEach((l, i) => {
      if (i >= MAX_LAYERS) return;
      const g = GAIN[l.name] || [1, 1];
      const k = (SCALE[l.name] || 1) * uScale; uniforms.uMatT.value[i].set(1 / (l.tile[0] * k), 1 / (l.tile[1] * k), g[0], g[1]);
      uniforms.uMatQ.value[i].set(l.msq || 1, ROOF.has(l.name) ? 1 : 0);
    });
  }
  api.setManifest = (man) => { slots = man.matslots || null; apply(); };
  api.setLayers = (list) => { off = new Set(list || []); apply(); };

  // ── the texture array: one KTX2 (UASTC), size by preset ──
  const res = num('u_matres', 256);              // 512 looked the same at walking height (report); build it with --res 512,256
  (async () => {
    try {
      const info = await (await fetch(DATA + 'mat/mat.json', { cache: 'no-cache' })).json();
      const f = info.files[String(res)] || Object.values(info.files)[0];
      const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
      const gl = renderer.getContext();
      while (gl.isContextLost()) await new Promise((r) => setTimeout(r, 250));
      const loader = new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/basis/').detectSupport(renderer);
      // ask the context directly: three caches a null extension seen during an early context loss, and the transcoder
      // would then fall back to uncompressed RGBA (4x the GPU memory)
      const has = (...n) => n.some((e) => !!gl.getExtension(e));
      Object.assign(loader.workerConfig, { astcSupported: has('WEBGL_compressed_texture_astc'), etc2Supported: has('WEBGL_compressed_texture_etc'),
        dxtSupported: has('WEBGL_compressed_texture_s3tc'), bptcSupported: has('EXT_texture_compression_bptc'), etc1Supported: has('WEBGL_compressed_texture_etc1') });
      const tex = await loader.loadAsync(DATA + 'mat/' + f.file + '?v=' + (f.bytes || 0));
      loader.dispose();
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(num('u_mataniso', mobile ? 2 : 8), renderer.capabilities.getMaxAnisotropy()); tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
      uniforms.tMat.value = tex; uniforms.uMatRes.value = tex.image.width || res;
      layers = info.layers; apply(); uniforms.uMatOn.value = 1;
      api.ok = true; api.info = { file: f.file, bytes: f.bytes, layers: layers.length, size: tex.image.width, format: tex.format, cfg: loader.workerConfig, compressed: !!tex.isCompressedArrayTexture, mipmaps: (tex.mipmaps || []).length };
    } catch (e) { console.warn('materials: not loaded', e); }
  })();
  return api;
}
