// Lanternfall 3D — the Blender park, baked and flown through with three.js.
// Geometry + baked Cycles lighting come from data/*.bin (see Blender-Park/web_export).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Water } from 'three/addons/objects/Water.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createWater } from './fx/water.js';

const DATA = 'data/';
const $ = (s) => document.querySelector(s);
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 620;
const mobile = coarse || small;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const B = (x, y, z) => new THREE.Vector3(x, z, -y);          // Blender (x, y, z-up) -> three (x, y-up, z)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

const ATTRACTIONS = {
  guildhollow: 'Armory Square · The Training Yard · Guild Fair Midway',
  frostmere: 'The Frost Fair · Snowbound Gate · The Crystal Court',
  meridian: 'The Meridian Loop · Signal Plaza · Launch Deck',
  wanderers: 'The Paper Doors · The Signing Tables · The Lost & Found',
  brinewatch: 'The Brine & Barrel · Bounty Board · Harbor Cruise',
  'lantern-row': 'Shrine of Wishes · Rooftop Chase · The Night Market',
  rosewick: 'The Moonlit Promenade · Pavilion of Wings · Blossom Lane',
};
const MOON = new THREE.Vector3(-0.507, 0.616, 0.604).normalize();
const FOG = new THREE.Color(0.016, 0.018, 0.046);

/* ───────────────────────── renderer ───────────────────────── */
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 2.1;
renderer.setClearColor(0x05040f);
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.6, 5000);
camera.position.copy(B(150, -470, 250)); camera.lookAt(0, 8, 0);

const Q = { dpr: Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2), maxPixels: mobile ? 1.5e6 : 2.4e6, hd: true, mirrorEvery: mobile ? 2 : 1, mirrorSize: mobile ? 512 : 1024, mirrorLite: mobile, bloom: true, lod: mobile ? 1.8 : 1, forest: mobile ? 0.55 : 1 };
// Stillwater (fx/water.js). '#oldwater' brings back the three.js Water from the ocean example for comparison.
const HASH = new Set(location.hash.slice(1).split(/[&,+]/));
Object.assign(Q, { water: HASH.has('oldwater') ? 'old' : 'new', waterMirror: 2, waterMirrorLow: 1, mirrorScale: mobile ? 0.4 : 0.5, mirrorBoost: 1.5, mirrorLod: 1.5,
  mirrorEveryLow: 1, mirrorScaleLow: 0.35, waterSim: HASH.has('nosim') ? 0 : mobile ? 1 : 2, waterSimHz: mobile ? 30 : 60, waterGloss: mobile ? 3 : 5, waterTap: true, waterBoat: !HASH.has('noboat'), waterScanBudget: 250000, waterEnv: true, waterPools: true, waterEnvSize: mobile ? 256 : 512 });
let composer, bloomPass, composerSamples = -1;
// HD cost is pixel-bound (half-float MSAA target + bloom), so cap the drawn pixels instead of trusting devicePixelRatio.
function effDpr(w, h) { return Math.max(0.6, Math.min(Q.dpr, Math.sqrt(Q.maxPixels / Math.max(1, w * h)))); }
function buildComposer() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  composerSamples = (!mobile && renderer.getPixelRatio() <= 1.3) ? 4 : 0;       // MSAA only where pixels are scarce
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: composerSamples });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.10, 0.35, 1.8);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`uniform sampler2D tDiffuse; varying vec2 vUv;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
        vec3 s = c * c * (3.0 - 2.0 * c); c = mix(c, s, 0.42);                       // gentle S-curve: deeper night, same highlights
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.14);
        vec2 q = vUv - 0.5; c *= 1.0 - 0.32 * dot(q, q);                              // soft vignette
        gl_FragColor = vec4(c, 1.0); }` }));
}
let baseFov = 52;
function applyFov() {     // keep a useful horizontal field of view on tall phone screens
  const k = Math.max(1, 1.3 / camera.aspect);
  camera.fov = Math.min(baseFov + 26, 2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) * k) * 180 / Math.PI);
  camera.updateProjectionMatrix();
}
function resize() {
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  const pr = effDpr(w, h);
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  camera.aspect = w / h; applyFov();
  if (composer) {
    const want = (!mobile && pr <= 1.3) ? 4 : 0;
    if (want !== composerSamples) { composer.dispose(); buildComposer(); }
    composer.setPixelRatio(pr); composer.setSize(w, h);
  }
}
resize(); buildComposer(); resize();
addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);

/* ───────────────────────── materials ───────────────────────── */
const uTime = { value: 0 };
const bakedMat = new THREE.ShaderMaterial({
  uniforms: { uRange: { value: 32 }, uFog: { value: FOG }, uFogD: { value: 2.4e-7 } },
  vertexShader: /* glsl */`
    attribute vec4 aCol; uniform float uRange; varying vec3 vCol; varying float vDist;
    void main(){ vCol = aCol.rgb * (aCol.a * uRange);
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    uniform vec3 uFog; uniform float uFogD; varying vec3 vCol; varying float vDist;
    void main(){ float f = 1.0 - exp(-vDist * vDist * uFogD);
      gl_FragColor = vec4(mix(vCol, uFog, f), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  side: THREE.DoubleSide,
});
const glassMat = new THREE.ShaderMaterial({
  uniforms: { uFog: { value: FOG }, uFogD: { value: 2.4e-7 } },
  vertexShader: /* glsl */`
    attribute vec4 aCol; varying vec4 vCol; varying float vDist;
    void main(){ vCol = vec4(aCol.rgb * aCol.rgb, aCol.a);
      vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    uniform vec3 uFog; uniform float uFogD; varying vec4 vCol; varying float vDist;
    void main(){ float f = 1.0 - exp(-vDist * vDist * uFogD);
      gl_FragColor = vec4(mix(vCol.rgb * 1.4, uFog, f), vCol.a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  side: THREE.DoubleSide, transparent: true, depthWrite: false,
});

/* ───────────────────────── sky ───────────────────────── */
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
  uniforms: { uTime, uMoon: { value: MOON } },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position * 100.0, 1.0); p.z = p.w * 0.99995; gl_Position = p; }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform float uTime; uniform vec3 uMoon; varying vec3 vDir;
    float h1(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h1(i), h1(i + vec3(1,0,0)), f.x), mix(h1(i + vec3(0,1,0)), h1(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(h1(i + vec3(0,0,1)), h1(i + vec3(1,0,1)), f.x), mix(h1(i + vec3(0,1,1)), h1(i + vec3(1,1,1)), f.x), f.y), f.z); }
    float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
    float stars(vec3 d, float scale, float density){
      vec3 p = d * scale, ip = floor(p), fp = fract(p) - 0.5;
      float r = h1(ip);
      vec3 off = vec3(h1(ip + 3.1), h1(ip + 7.7), h1(ip + 13.3)) - 0.5;
      float s = smoothstep(0.34, 0.0, length(fp - off * 0.55));
      float tw = 0.72 + 0.28 * sin(uTime * (0.8 + r * 3.0) + r * 60.0);
      return step(1.0 - density, r) * s * s * tw * (0.4 + 2.2 * fract(r * 91.7));
    }
    void main(){
      vec3 d = normalize(vDir);
      float h = clamp(d.y, -0.2, 1.0);
      vec3 zen = vec3(0.007, 0.010, 0.036), mid = vec3(0.030, 0.036, 0.105), hor = vec3(0.075, 0.062, 0.145);
      vec3 col = mix(hor, mid, smoothstep(0.0, 0.16, h)); col = mix(col, zen, smoothstep(0.10, 0.62, h));
      col += vec3(0.060, 0.034, 0.016) * exp(-max(h, 0.0) * 13.0);                      // warm park glow on the horizon
      // moon
      float md = dot(d, uMoon); float ang = acos(clamp(md, -1.0, 1.0));
      float disc = smoothstep(0.0215, 0.0195, ang);
      vec3 mref = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0))); vec3 mup = cross(mref, uMoon);
      vec2 muv = vec2(dot(d, mref), dot(d, mup)) / 0.021;
      float crater = 0.72 + 0.28 * fbm(vec3(muv * 2.6, 3.0)) - 0.22 * smoothstep(0.5, 0.2, length(muv - vec2(0.25, 0.2)) + 0.25 * vnoise(vec3(muv * 5.0, 1.0)));
      float limb = sqrt(max(1.0 - dot(muv, muv), 0.0));
      col += vec3(0.56, 0.66, 0.92) * (0.050 * exp(-ang * 9.0) + 0.22 * exp(-ang * 42.0));
      // milky way + stars
      vec3 gn = normalize(vec3(0.35, 0.42, -0.84));
      float band = exp(-pow(dot(d, gn) * 3.4, 2.0));
      float dust = fbm(d * 5.5 + 3.0);
      col += vec3(0.034, 0.036, 0.062) * band * (0.35 + 1.5 * dust * dust) * smoothstep(-0.02, 0.3, h);
      float st = stars(d, 150.0, 0.045 + 0.05 * band) + 0.55 * stars(d.zxy, 310.0, 0.07 + 0.09 * band * dust);
      vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.74, 0.86, 1.0), h1(floor(d * 150.0) + 5.0));
      // clouds: thin moonlit wisps
      vec2 cuv = d.xz / (abs(d.y) + 0.32);
      float cl = fbm(vec3(cuv * 1.25 + vec2(uTime * 0.004, uTime * 0.0015), 7.0));
      float cloud = smoothstep(0.50, 0.86, cl) * smoothstep(0.02, 0.22, h);
      float veil = 1.0 - 0.8 * cloud;
      col += tint * st * 1.25 * smoothstep(0.015, 0.14, h) * veil * (1.0 - disc);
      col += cloud * (vec3(0.018, 0.022, 0.046) + vec3(0.11, 0.13, 0.20) * exp(-ang * 3.2));
      col = mix(col, vec3(1.10, 1.14, 1.22) * crater * (0.45 + 0.75 * limb), disc * (1.0 - 0.55 * cloud));
      col = mix(col, hor * 0.55, smoothstep(0.0, -0.12, d.y));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  side: THREE.BackSide, depthTest: false, depthWrite: false,
}));
sky.frustumCulled = false; sky.renderOrder = -1000;
scene.add(sky);

/* ───────────────────────── data loading ───────────────────────── */
const bar = $('#bar'), veilMsg = $('#veil-msg');
let loadedBytes = 0, totalBytes = 1;
let B64 = false;      // hosts that only serve text: the same gzip bytes, base64-encoded in <name>.txt
async function fetchBin(file) {
  const res = await fetch(DATA + file + (B64 ? '.txt' : ''));
  if (!res.ok) throw new Error(file + ': ' + res.status);
  let buf;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; loadedBytes += value.length; bar.style.width = (100 * Math.min(1, loadedBytes / totalBytes)).toFixed(1) + '%'; }
    buf = new Uint8Array(n); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else buf = new Uint8Array(await res.arrayBuffer());
  if (B64) {
    const txt = new TextDecoder('latin1').decode(buf).trim();
    if (Uint8Array.fromBase64) buf = Uint8Array.fromBase64(txt);
    else { const bin = atob(txt), n = bin.length; buf = new Uint8Array(n); for (let i = 0; i < n; i++) buf[i] = bin.charCodeAt(i); }
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return buf;
}
function decodeMesh(u8, off, m) {
  const nv = m.nv, ni = m.ni;
  const pos = new Uint16Array(nv * 3);
  for (let c = 0; c < 3; c++) {
    const lo = off + c * 2 * nv, hi = lo + nv; let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[lo + i] | (u8[hi + i] << 8); acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFFFF; pos[i * 3 + c] = acc; }
  }
  off += nv * 6;
  const col = new Uint8Array(nv * 4);
  for (let c = 0; c < 4; c++) {
    const o = off + c * nv; let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[o + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; col[i * 4 + c] = acc; }
  }
  off += nv * 4;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let mx = -1; const p1 = off + ni, p2 = p1 + ni, p3 = p2 + ni;
  for (let i = 0; i < ni; i++) {
    const code = (u8[off + i] | (u8[p1 + i] << 8) | (u8[p2 + i] << 16) | (u8[p3 + i] << 24)) >>> 0;
    const v = mx + 1 - code; if (v > mx) mx = v; idx[i] = v;
  }
  off += ni * 4;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3, false));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 4, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const o = m.origin, s = m.step, bb = m.bbox;
  g.boundingBox = new THREE.Box3(new THREE.Vector3((bb[0] - o[0]) / s, (bb[1] - o[1]) / s, (bb[2] - o[2]) / s), new THREE.Vector3((bb[3] - o[0]) / s, (bb[4] - o[1]) / s, (bb[5] - o[2]) / s));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geometry: g, next: off };
}
function meshFrom(geometry, m) {
  const mesh = new THREE.Mesh(geometry, m.kind === 'glass' ? glassMat : bakedMat);
  mesh.position.fromArray(m.origin); mesh.scale.setScalar(m.step);
  if (m.kind === 'glass') mesh.renderOrder = 5;
  mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  return mesh;
}

const park = new THREE.Group(); scene.add(park);
const farMeshes = [], landMeshes = [], lodMeshes = [];
let manifest, nav = null, trains = [], lanterns = null, water = null, flatWater = null, forest = [], fxWater = null;

/* rail (monorail ellipse) */
const rail = { a: 160, b: 119, n: 2048, acc: null, len: 0 };
function initRail(a, b) {
  rail.a = a; rail.b = b; rail.acc = new Float32Array(rail.n + 1);
  let px = a, py = 0;
  for (let i = 1; i <= rail.n; i++) { const t = (i / rail.n) * Math.PI * 2, x = a * Math.cos(t), y = b * Math.sin(t); rail.acc[i] = rail.acc[i - 1] + Math.hypot(x - px, y - py); px = x; py = y; }
  rail.len = rail.acc[rail.n];
}
function railAt(s) {   // Blender-frame x, y + unit tangent at arc length s
  s = ((s % rail.len) + rail.len) % rail.len;
  let lo = 0, hi = rail.n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rail.acc[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - rail.acc[lo]) / (rail.acc[lo + 1] - rail.acc[lo] || 1), t = ((lo + f) / rail.n) * Math.PI * 2;
  const tx = -rail.a * Math.sin(t), ty = rail.b * Math.cos(t), l = Math.hypot(tx, ty);
  return { x: rail.a * Math.cos(t), y: rail.b * Math.sin(t), tx: tx / l, ty: ty / l };
}

function buildWater(lake, y) {
  const shape = new THREE.Shape(lake.map(([x, yy]) => new THREE.Vector2(x, yy)));
  const geo = new THREE.ShapeGeometry(shape);
  // tileable ripple normal map, generated (no texture download)
  const N = 256, data = new Uint8Array(N * N * 4), rnd = mulberry(11), waves = [];
  for (let i = 0; i < 26; i++) { const fx = Math.round((rnd() - 0.5) * 22), fy = Math.round((rnd() - 0.5) * 22); if (!fx && !fy) continue; waves.push([fx, fy, rnd() * 6.283, 1 / (1 + Math.hypot(fx, fy) * 0.55)]); }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let dx = 0, dy = 0; const u = (i / N) * 6.2831853, v = (j / N) * 6.2831853;
    for (const [fx, fy, ph, am] of waves) { const c = Math.cos(fx * u + fy * v + ph) * am; dx += c * fx; dy += c * fy; }
    const nx = -dx * 0.085, ny = -dy * 0.085, l = Math.hypot(nx, ny, 1), o = (j * N + i) * 4;
    data[o] = (nx / l * 0.5 + 0.5) * 255; data[o + 1] = (ny / l * 0.5 + 0.5) * 255; data[o + 2] = (1 / l * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
  water = new Water(geo, { textureWidth: Q.mirrorSize, textureHeight: Q.mirrorSize, waterNormals: tex, sunDirection: MOON.clone(), sunColor: 0x5b6fae, waterColor: 0x01030a, distortionScale: 0.75, alpha: 1.0 });
  const wm = water.material;
  wm.fragmentShader = wm.fragmentShader.replace('vec3( 0.1 )', 'vec3( 0.002, 0.003, 0.007 )');
  wm.uniforms.size.value = 9.0;
  water.rotation.x = -Math.PI / 2; water.position.y = y;
  const inner = water.onBeforeRender; let frame = 0;
  water.onBeforeRender = function (r, s, c) {
    if ((frame++ % Q.mirrorEvery) !== 0) return;
    const lite = Q.mirrorLite;
    for (const m of farMeshes) m.visible = false;
    for (const f of forest) f.visible = false;
    if (lite) for (const m of landMeshes) m.visible = false;
    inner.call(this, r, s, c);
    for (const m of farMeshes) m.visible = true;
    for (const f of forest) f.visible = Q.forest > 0;
    if (lite) for (const m of landMeshes) m.visible = true;
  };
  scene.add(water);
  flatWater = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: { uTime },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uTime; varying vec3 vW;
      void main(){ vec3 v = normalize(cameraPosition - vW); float fr = pow(1.0 - clamp(v.y, 0.0, 1.0), 4.0);
        float rp = sin(vW.x * 0.9 + uTime * 0.7) * sin(vW.z * 1.1 - uTime * 0.5);
        vec3 c = mix(vec3(0.004, 0.006, 0.016), vec3(0.05, 0.045, 0.10), fr) + vec3(0.03, 0.02, 0.008) * fr * (0.5 + 0.5 * rp);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  flatWater.rotation.x = -Math.PI / 2; flatWater.position.y = y; flatWater.visible = false; scene.add(flatWater);
}
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function buildLanterns(f32, count) {
  const g = new THREE.BufferGeometry();
  const ib = new THREE.InterleavedBuffer(f32, 8);
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  g.setAttribute('aCol', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  g.setAttribute('aPar', new THREE.InterleavedBufferAttribute(ib, 2, 6));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 40, 0), 160);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uScale: { value: 500 }, uWater: { value: manifest.water_z } },
    vertexShader: /* glsl */`
      attribute vec3 aCol; attribute vec2 aPar; uniform float uTime, uScale, uWater; varying vec3 vCol; varying float vSoft;
      void main(){
        float ph = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        vec3 p = position;
        float air = smoothstep(uWater + 0.6, uWater + 3.0, p.y);
        p.x += (sin(uTime * 0.21 + ph) * 0.9 + sin(uTime * 0.53 + ph * 2.0) * 0.25) * mix(0.25, 1.0, air);
        p.z += (cos(uTime * 0.17 + ph * 1.3) * 0.9 + cos(uTime * 0.47 + ph) * 0.25) * mix(0.25, 1.0, air);
        p.y += sin(uTime * 0.31 + ph * 1.7) * mix(0.03, 0.7, air);
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        float px = aPar.y * 1.4 * uScale / max(-mv.z, 0.1);
        float sz = clamp(px, 2.0, 44.0);
        float flick = 0.86 + 0.14 * sin(uTime * (2.0 + fract(ph * 3.3) * 3.0) + ph * 9.0);
        vCol = aCol * aPar.x * flick * min(1.0, (px * px) / (sz * sz) * 2.0 + 0.10) * mix(0.34, 0.13, smoothstep(3.0, 22.0, px)) * smoothstep(1.2, 6.0, -mv.z);
        vSoft = sz; gl_PointSize = sz;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vSoft;
      void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q * vec2(1.25, 1.0));
        float a = smoothstep(0.5, 0.22, d); if (a < 0.01) discard;
        float core = smoothstep(0.34, 0.0, d);
        gl_FragColor = vec4(vCol * (0.6 + 1.6 * core * core) * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  lanterns = new THREE.Points(g, mat); lanterns.renderOrder = 8;
  lanterns.onBeforeRender = (r, s, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
  scene.add(lanterns);
}

function buildForest(u8, list) {
  const f32 = (span) => new Float32Array(u8.buffer, u8.byteOffset + span[0], span[1] / 4);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMoon: { value: MOON }, uFog: { value: FOG }, uFogD: { value: 2.4e-7 } },
    vertexShader: /* glsl */`
      attribute vec3 aCol; uniform vec3 uMoon; varying vec3 vCol; varying float vDist;
      void main(){ mat4 im = instanceMatrix; vec3 n = normalize(mat3(im) * normal);
        float l = 0.085 + 0.36 * max(dot(n, uMoon), 0.0) + 0.05 * (n.y * 0.5 + 0.5);
        float tone = 0.8 + 0.4 * fract(sin(dot(im[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        vCol = aCol * l * tone * vec3(0.62, 0.74, 1.0);
        vec4 mv = modelViewMatrix * im * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFog; uniform float uFogD; varying vec3 vCol; varying float vDist;
      void main(){ float f = 1.0 - exp(-vDist * vDist * uFogD); gl_FragColor = vec4(mix(vCol, uFog, f), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
  for (const e of list) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f32(e.pos).slice(), 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(f32(e.col).slice(), 3));
    g.computeVertexNormals();
    const inst = f32(e.inst), im = new THREE.InstancedMesh(g, mat, e.count);
    const order = Array.from({ length: e.count }, (_, i) => i), rnd = mulberry(5);
    for (let i = e.count - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (let k = 0; k < e.count; k++) {
      const i = order[k];
      v.set(inst[i * 5], inst[i * 5 + 1], inst[i * 5 + 2]); q.setFromAxisAngle(up, inst[i * 5 + 3]); sc.setScalar(inst[i * 5 + 4]);
      im.setMatrixAt(k, M.compose(v, q, sc));
    }
    im.userData.total = e.count; im.count = Math.floor(e.count * Q.forest);
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.matrixAutoUpdate = false;
    forest.push(im); scene.add(im);
  }
}

function buildTrains(u8, ex) {
  let off = 0; const geos = {};
  for (const [name, ms] of Object.entries(ex.train_meshes)) {
    geos[name] = [];
    for (const m of ms) { const d = decodeMesh(u8, off, m); off = d.next; geos[name].push([d.geometry, m]); }
  }
  for (const t of ex.trains) {
    const grp = new THREE.Group();
    for (const [g, m] of geos[t.mesh] || []) { const mesh = meshFrom(g, m); grp.add(mesh); }
    grp.userData = t; trains.push(grp); scene.add(grp);
  }
}
const TRAIN_SPEED = 8.5;
function updateTrains(t) {
  for (const g of trains) {
    const d = g.userData, s = d.s + t * TRAIN_SPEED; let x, y, ang;
    if (d.chord) { const a = railAt(s - 3), b = railAt(s + 3); x = (a.x + b.x) / 2; y = (a.y + b.y) / 2; ang = Math.atan2(b.y - a.y, b.x - a.x); }
    else { const p = railAt(s); x = p.x; y = p.y; ang = Math.atan2(p.ty, p.tx); }
    g.position.set(x, d.z, -y); g.rotation.y = ang + (d.flip ? Math.PI : 0);
  }
}

function decodeNav(u8, n) {
  const W = n.w, H = n.h, out = [];
  for (let l = 0; l < 2; l++) {
    const a = new Uint16Array(W * H), lo = l * 2 * W * H, hi = lo + W * H;
    for (let j = 0; j < H; j++) { let acc = 0; for (let i = 0; i < W; i++) { const k = j * W + i; acc = (acc + (u8[lo + k] | (u8[hi + k] << 8))) & 0xFFFF; a[k] = acc; } }
    out.push(a);
  }
  nav = { ...n, A: out[0], B: out[1] };
}

async function load() {
  manifest = await (await fetch(DATA + 'manifest.json')).json();
  const ex = manifest.extras;
  totalBytes = manifest.parts.reduce((s, p) => s + p.bytes, 0) + ex.file.bytes + (ex.train_file ? ex.train_file.bytes : 0) + (manifest.nav ? manifest.nav.bytes : 0);
  if (manifest.b64) { B64 = true; totalBytes = Math.ceil(totalBytes * 4 / 3); }
  bakedMat.uniforms.uRange.value = manifest.range;
  initRail(manifest.rail.a, manifest.rail.b);
  if (Q.water === 'new') fxWater = createWater({ renderer, scene, camera, Q, manifest, uTime, MOON, FOG, park, farMeshes, landMeshes, forest, lodMeshes, getLanterns: () => lanterns, getMode: () => mode, isLoaded: () => loaded });
  else buildWater(manifest.lake, manifest.water_z);
  setupPlaces();
  const exU8 = await fetchBin(ex.file.file);
  if (ex.lanterns) buildLanterns(new Float32Array(exU8.buffer, exU8.byteOffset + ex.lanterns.span[0], ex.lanterns.count * 8).slice(), ex.lanterns.count);
  if (ex.forest) buildForest(exU8, ex.forest);
  const names = { core: 'Filling Stillwater', transit: 'Raising the monorail' };
  const pill = $('#loadpill');
  for (const part of manifest.parts) {
    const land = manifest.lands.find((l) => l.id === part.id);
    const label = (names[part.id] || ('Lighting ' + (land ? land.name : part.id))) + '…';
    veilMsg.textContent = label; pill.textContent = label;
    const u8 = await fetchBin(part.file); let off = 0;
    for (const m of part.meshes) {
      const d = decodeMesh(u8, off, m); off = d.next;
      const mesh = meshFrom(d.geometry, m); park.add(mesh);
      const cx = (m.bbox[0] + m.bbox[3]) / 2, cz = (m.bbox[2] + m.bbox[5]) / 2;
      if (Math.hypot(cx, cz) > 420) farMeshes.push(mesh);
      if (part.id !== 'core') landMeshes.push(mesh);
      if (m.kind !== 'glass' && m.n0 < m.ni) lodMeshes.push({ mesh, m, c: new THREE.Vector3(cx, (m.bbox[1] + m.bbox[4]) / 2, cz), r: 0.5 * Math.hypot(m.bbox[3] - m.bbox[0], m.bbox[4] - m.bbox[1], m.bbox[5] - m.bbox[2]) });
    }
    await new Promise((r) => setTimeout(r, 0));
    if (part.id === 'transit' && !ready) {            // the lake, Spire and monorail are in: open the park, keep lighting lands
      if (ex.train_file) buildTrains(await fetchBin(ex.train_file.file), ex);
      if (manifest.nav) decodeNav(await fetchBin(manifest.nav.file), manifest.nav);
      ready = true; tourClock = 0; perf.n = -600;
      if (mode === 'orbit') { controls.target.set(0, 8, 0); controls.enabled = true; setCaption(places[0]); }
      $('#veil').classList.add('done'); pill.hidden = false; showHint();
    }
  }
  bar.style.width = '100%'; pill.hidden = true; loaded = true; perf.n = 0;
}

/* ───────────────────────── places + captions ───────────────────────── */
const places = [];        // {id, name, color, kicker, text, target, pos, walk:[x,y]}
function setupPlaces() {
  places.push({ id: 'park', name: 'Whole park', color: '#f5ecdc', kicker: 'Seven lands around a still, black lake', title: 'Lanternfall', text: 'Ten thousand paper lanterns come down onto Stillwater at eleven.', target: new THREE.Vector3(0, 5, 0), pos: B(150, -470, 250), walk: [300, 0], yaw: Math.PI });
  places.push({ id: 'spire', name: 'The Spire', color: '#ffdd94', kicker: 'Stillwater · the finale at 23:00', title: 'The Spire', text: 'The lamplighters release the lanterns from the gallery. Nobody talks for about four minutes.', target: B(0, 0, 34), pos: B(-74, -62, 20), walk: [104.5, 0], yaw: Math.PI });
  places.push({ id: 'gate', name: 'East Gate', color: '#ffb547', kicker: 'Gates open 17:30', title: "The Lamplighters' Walk", text: 'The first lanterns are lit down the main avenue as the sun slips away.', target: B(240, 0, 8), pos: B(322, 26, 16), walk: [288, 0], yaw: Math.PI });
  for (const l of manifest.lands) {
    const c = l.center, d = Math.hypot(c[0], c[1]), lk = [-c[0] / d, -c[1] / d];
    const shift = l.id === 'brinewatch' ? 45 : 8;
    const wp = l.phi + 0.045, pr = (160 * 119) / Math.hypot(119 * Math.cos(wp), 160 * Math.sin(wp)) - 3.2;
    places.push({ id: l.id, land: l, name: l.name.replace('The ', ''), color: l.hex, kicker: l.theme, title: l.name, text: ATTRACTIONS[l.id] || '',
      target: B(c[0] + lk[0] * shift, c[1] + lk[1] * shift, 7), pos: B(c[0] + lk[0] * 150, c[1] + lk[1] * 150, 84), lake: lk,
      walk: [pr * Math.cos(wp), pr * Math.sin(wp)], yaw: l.phi });
  }
  const chips = $('#chips');
  for (const p of places) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = p.name; b.style.setProperty('--c', p.color); b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => gotoPlace(p)); p.chip = b; chips.appendChild(b);
  }
  buildTour();
}
let capKey = '';
function setCaption(p) {
  if (!p || capKey === p.id) return; capKey = p.id;
  const el = $('#caption'); el.classList.add('swap');
  setTimeout(() => {
    $('#cap-kicker').textContent = p.kicker; $('#cap-title').textContent = p.title; $('#cap-text').textContent = p.text;
    el.style.setProperty('--land', p.color); el.classList.remove('swap');
  }, reduceMotion ? 0 : 320);
  for (const q of places) q.chip.setAttribute('aria-pressed', String(q.id === p.id));
}
const hintEl = $('#hint'); let hintTimer = 0;
function showHint() {
  const txt = mode === 'tour' ? (coarse ? 'Drag to look around · tap a place to fly there' : 'Drag to take over · pick a place to fly there')
    : mode === 'orbit' ? (coarse ? 'Drag to orbit · pinch to zoom · two fingers to pan' : 'Drag to orbit · scroll to zoom · right-drag to pan')
    : (coarse ? 'Left thumb walks · right thumb looks' : 'WASD or arrows to walk · drag to look · Shift to run');
  hintEl.textContent = txt; hintEl.classList.remove('off'); clearTimeout(hintTimer); hintTimer = setTimeout(() => hintEl.classList.add('off'), 5200);
}

/* ───────────────────────── tour ───────────────────────── */
let shots = [], tourLen = 0, tourClock = 0;
const orbitShot = (c, r0, r1, h0, h1, a0, a1, l0, l1) => (u, out) => {
  const e = smooth(u), a = lerp(a0, a1, e), r = lerp(r0, r1, e);
  out.p.set(c.x + r * Math.cos(a), lerp(h0, h1, e), c.z - r * Math.sin(a));
  out.l.set(c.x, lerp(l0, l1, e), c.z);
};
function buildTour() {
  const P = (id) => places.find((p) => p.id === id);
  const O = new THREE.Vector3(0, 0, 0), rad = (d) => d * Math.PI / 180;
  shots = [];
  shots.push({ place: P('park'), dur: 13, f: orbitShot(O, 540, 470, 275, 225, rad(-112), rad(-62), 8, 8) });
  const gate = new THREE.CatmullRomCurve3([B(336, 0, 3.6), B(296, 0, 3.0), B(262, 0, 2.7), B(226, 0, 2.8), B(188, 0.4, 2.9), B(169, 7.6, 3.0), B(151, 7.6, 3.1), B(128, 1.2, 3.3), B(102, 0, 4.6), B(74, 0, 9.5)], false, 'centripetal');
  const spTop = B(0, 0, 44);
  shots.push({ place: P('gate'), dur: 19, f: (u, out) => {
    const e = u * u * (3 - 2 * u) * 0.35 + u * 0.65; gate.getPointAt(clamp(e, 0, 1), out.p);
    gate.getPointAt(clamp(e + 0.07, 0, 1), out.l); out.l.lerp(spTop, smooth((u - 0.45) / 0.5) * 0.85); } });
  shots.push({ place: P('spire'), dur: 17, f: orbitShot(O, 74, 60, 9.5, 48, rad(0), rad(215), 40, 54) });
  for (const id of ['wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'brinewatch']) {
    const p = P(id), c = p.land.center, base = Math.atan2(p.lake[1], p.lake[0]);
    const ctr = new THREE.Vector3(p.target.x, 0, p.target.z);
    if (id === 'brinewatch') {
      const ship = new THREE.Vector3(c[0] + p.lake[0] * 104, 0, -(c[1] + p.lake[1] * 104));        // the galleon, moored off the pier
      shots.push({ place: p, dur: 13, f: orbitShot(ship, 78, 58, 30, 13, base + rad(95), base + rad(-12), 11, 12) });
    } else shots.push({ place: p, dur: 11.5, f: orbitShot(ctr, 118, 86, 58, 27, base - rad(40), base + rad(34), 9, 8) });
  }
  shots.push({ place: { id: 'loop', kicker: 'An elevated circuit over every land', title: 'The Meridian Loop', text: 'Best view of the finale is from the top of the line.', color: '#7ff0d8', chip: document.createElement('i') }, dur: 15, f: (u, out, t) => {
    const lead = trains.find((g) => g.userData.name.includes('lanternrow_car0')) || trains[0];
    const s = (lead ? lead.userData.s : 0) + t * TRAIN_SPEED, a = railAt(s - 66 + u * 8), b = railAt(s + 6);
    out.p.set(a.x * 1.022, manifest.rail.top + 9.5 - u * 2.0, -a.y * 1.022); out.l.set(b.x, manifest.rail.top + 1.2, -b.y); } });
  shots.push({ place: P('park'), dur: 12, f: orbitShot(O, 210, 540, 70, 275, rad(-175), rad(-112), 14, 8) });
  tourLen = shots.reduce((s, x) => s + x.dur, 0);
}
const poseA = { p: new THREE.Vector3(), l: new THREE.Vector3() }, poseB = { p: new THREE.Vector3(), l: new THREE.Vector3() };
const camLook = new THREE.Vector3(0, 8, 0);
const blend = { on: false, t: 0, dur: 3, p: new THREE.Vector3(), l: new THREE.Vector3() };
let lastShot = -1;
function tourPose(tc, out, timeNow) {
  let t = tc % tourLen, i = 0;
  while (t > shots[i].dur) { t -= shots[i].dur; i++; }
  shots[i].f(t / shots[i].dur, out, timeNow);
  return i;
}
function startBlend(dur = 3) { blend.on = true; blend.t = 0; blend.dur = dur; blend.p.copy(camera.position); blend.l.copy(camLook); }
function applyPose(pose, dt) {
  if (blend.on) {
    blend.t += dt; const w = smooth(blend.t / blend.dur);
    const dist = blend.p.distanceTo(pose.p);
    camera.position.lerpVectors(blend.p, pose.p, w); camera.position.y += Math.sin(Math.PI * w) * Math.min(70, dist * 0.16);
    camLook.lerpVectors(blend.l, pose.l, w);
    if (blend.t >= blend.dur) blend.on = false;
  } else { camera.position.copy(pose.p); camLook.copy(pose.l); }
  camera.lookAt(camLook);
}

/* ───────────────────────── modes ───────────────────────── */
let mode = reduceMotion ? 'orbit' : 'tour', ready = false, loaded = false;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.07; controls.maxPolarAngle = Math.PI * 0.487; controls.minDistance = 10; controls.maxDistance = 1100;
controls.zoomSpeed = 0.9; controls.rotateSpeed = 0.55; controls.panSpeed = 0.9; controls.screenSpacePanning = false; controls.autoRotateSpeed = 0.35;
controls.enabled = false;
const fly = { on: false, t: 0, dur: 1.8, p0: new THREE.Vector3(), t0: new THREE.Vector3(), p1: new THREE.Vector3(), t1: new THREE.Vector3() };
let idle = 0;

function setMode(m, opts = {}) {
  if (m === 'walk' && !nav) return;
  const prev = mode; mode = m;
  for (const k of ['tour', 'orbit', 'walk']) $('#m-' + k).setAttribute('aria-pressed', String(k === m));
  controls.enabled = m === 'orbit'; fly.on = false;
  $('#stick').hidden = true;
  if (m === 'tour') { startBlend(prev === 'walk' ? 3.5 : 2.6); lastShot = -1; baseFov = 52; }
  if (m === 'orbit') {
    baseFov = 52;
    if (!opts.keepTarget) {
      // orbit about the point the camera is looking at on the ground
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
      let d = dir.y < -0.03 ? (camera.position.y - 6) / -dir.y : 160; d = clamp(d, 25, 700);
      controls.target.copy(camera.position).addScaledVector(dir, d); controls.target.y = clamp(controls.target.y, 2, 60);
      if (prev === 'walk') { fly.on = true; fly.t = 0; fly.dur = 2.0; fly.p0.copy(camera.position); fly.t0.copy(controls.target); fly.t1.copy(controls.target); fly.p1.copy(camera.position).addScaledVector(dir, -70); fly.p1.y = 55; controls.enabled = false; }
    }
    idle = 0;
  }
  if (m === 'walk') {
    baseFov = 66;
    const g = opts.at || groundUnder();
    spawnWalk(g[0], g[1], opts.yaw);
  }
  camera.near = m === 'walk' ? 0.22 : 0.6; applyFov();
  showHint();
}
function groundUnder() {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const src = mode === 'orbit' ? controls.target : camLook;
  if (mode === 'tour' && dir.y < -0.05) { const d = clamp(camera.position.y / -dir.y, 5, 400); const p = camera.position.clone().addScaledVector(dir, d); return [p.x, -p.z]; }
  return [src.x, -src.z];
}
function gotoPlace(p) {
  setCaption(p);
  if (mode === 'walk') { spawnWalk(p.walk[0], p.walk[1], p.yaw); return; }
  if (mode === 'tour') { setMode('orbit', { keepTarget: true }); controls.target.copy(camLook); }
  fly.on = true; fly.t = 0; fly.dur = reduceMotion ? 0.01 : 2.2; fly.p0.copy(camera.position); fly.t0.copy(controls.target); fly.p1.copy(p.pos); fly.t1.copy(p.target);
  controls.enabled = false; idle = 0;
}
$('#m-tour').addEventListener('click', () => setMode('tour'));
$('#m-orbit').addEventListener('click', () => setMode('orbit'));
$('#m-walk').addEventListener('click', () => setMode('walk'));

/* ───────────────────────── walking ───────────────────────── */
const walk = { x: 300, y: 0, z: 0.12, yaw: Math.PI, pitch: 0, eye: 1.68, bob: 0 };
const navH = (v) => (v - 1) / 100 - 2;
function navLevels(x, y) {
  const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((y - nav.y0) / nav.cell);
  if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) return null;
  const k = j * nav.w + i; return [nav.A[k], nav.B[k]];
}
function navHeight(x, y, zRef, tol = 0.6) {
  const lv = navLevels(x, y); if (!lv) return null;
  let best = null, bd = tol;
  for (const v of lv) { if (!v) continue; const h = navH(v), d = Math.abs(h - zRef); if (d <= bd) { bd = d; best = h; } }
  return best;
}
function spawnWalk(x, y, yaw) {
  let found = null;
  for (let r = 0; r < 260 && !found; r++) {
    const n = Math.max(1, Math.round(r * 6));
    for (let k = 0; k < n; k++) { const a = (k / n) * 6.2831853, px = x + Math.cos(a) * r * 0.5, py = y + Math.sin(a) * r * 0.5; const lv = navLevels(px, py); if (lv && lv[0]) { found = [px, py, navH(lv[0])]; break; } }
  }
  if (!found) found = [300, 0, 0.12];
  walk.x = found[0]; walk.y = found[1]; walk.z = found[2];
  walk.yaw = yaw !== undefined ? yaw : Math.atan2(-walk.y, -walk.x);   // face the lake
  walk.pitch = 0.04;
}
function walkCanStand(x, y, z) {
  const r = 0.28; let h = navHeight(x, y, z); if (h === null) return null;
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (navHeight(x + dx, y + dy, h, 0.75) === null) return null;
  return h;
}
const keys = new Set(); const stick = { id: -1, x: 0, y: 0, ox: 0, oy: 0 }; const look = { id: -1, x: 0, y: 0 };
addEventListener('keydown', (e) => { if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; keys.add(e.code); if (mode === 'walk' && /Arrow|Space/.test(e.code)) e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
function updateWalk(dt) {
  let fx = 0, fy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fy += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) fy -= 1;
  if (keys.has('KeyD')) fx += 1; if (keys.has('KeyA')) fx -= 1;
  if (keys.has('ArrowLeft')) walk.yaw += dt * 1.9; if (keys.has('ArrowRight')) walk.yaw -= dt * 1.9;
  if (stick.id !== -1) { fx += stick.x; fy += -stick.y; }
  const mag = Math.hypot(fx, fy);
  if (mag > 0.02) {
    const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 9.5 : 4.6) * Math.min(1, mag) * (stick.id !== -1 ? 1.25 : 1);
    fx /= mag; fy /= mag;
    const c = Math.cos(walk.yaw), s = Math.sin(walk.yaw);        // yaw about +Z in the Blender frame; forward = (c, s)
    const dx = (fy * c + fx * s) * sp * dt, dy = (fy * s - fx * c) * sp * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.2));
    for (let k = 0; k < steps; k++) {
      const sx = dx / steps, sy = dy / steps;
      let h = walkCanStand(walk.x + sx, walk.y + sy, walk.z);
      if (h !== null) { walk.x += sx; walk.y += sy; walk.z = h; continue; }
      h = walkCanStand(walk.x + sx, walk.y, walk.z); if (h !== null) { walk.x += sx; walk.z = h; continue; }
      h = walkCanStand(walk.x, walk.y + sy, walk.z); if (h !== null) { walk.y += sy; walk.z = h; }
    }
    walk.bob += dt * sp * 1.7;
  }
  const targetY = walk.z + walk.eye + Math.sin(walk.bob) * 0.035;
  camera.position.x = walk.x; camera.position.z = -walk.y;
  camera.position.y += (targetY - camera.position.y) * Math.min(1, dt * 9);
  if (Math.abs(camera.position.y - targetY) > 3) camera.position.y = targetY;
  const cp = Math.cos(walk.pitch);
  camLook.set(walk.x + Math.cos(walk.yaw) * cp, camera.position.y + Math.sin(walk.pitch), -(walk.y + Math.sin(walk.yaw) * cp));
  camera.lookAt(camLook);
}
let walkLandTimer = 0;
function nearestPlace() {
  const r = Math.hypot(walk.x, walk.y), phi = Math.atan2(walk.y, walk.x);
  if (r < 112) return places.find((p) => p.id === 'spire');
  let best = null, bd = 0.34;
  for (const p of places) if (p.land) { let d = Math.abs(((phi - p.land.phi + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (d < bd) { bd = d; best = p; } }
  return best || (walk.x > 150 && Math.abs(walk.y) < 40 ? places.find((p) => p.id === 'gate') : null);
}

/* ───────────────────────── pointer input ───────────────────────── */
const el = renderer.domElement;
el.addEventListener('pointerdown', (e) => {
  if (!ready) return;
  if (mode === 'tour') { setMode('orbit'); return; }
  if (mode === 'orbit') { idle = 0; controls.autoRotate = false; if (fly.on) { fly.on = false; controls.enabled = true; } return; }
  if (mode === 'walk') {
    el.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.45 && stick.id === -1) {
      stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY; stick.x = stick.y = 0;
      const s = $('#stick'); s.hidden = false; s.style.left = e.clientX + 'px'; s.style.top = e.clientY + 'px'; s.firstElementChild.style.transform = '';
    } else if (look.id === -1) { look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; }
  }
}, true);
el.addEventListener('pointermove', (e) => {
  if (mode !== 'walk') return;
  if (e.pointerId === stick.id) {
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy; const m = Math.hypot(dx, dy), R = 48;
    if (m > R) { dx *= R / m; dy *= R / m; }
    stick.x = dx / R; stick.y = dy / R; $('#stick').firstElementChild.style.transform = `translate(${dx}px,${dy}px)`;
  } else if (e.pointerId === look.id) {
    const k = (e.pointerType === 'touch' ? 0.0052 : 0.0034);
    walk.yaw -= (e.clientX - look.x) * k; walk.pitch = clamp(walk.pitch - (e.clientY - look.y) * k, -1.2, 1.3);
    look.x = e.clientX; look.y = e.clientY;
  }
});
const endPtr = (e) => { if (e.pointerId === stick.id) { stick.id = -1; stick.x = stick.y = 0; $('#stick').hidden = true; } if (e.pointerId === look.id) look.id = -1; };
el.addEventListener('pointerup', endPtr); el.addEventListener('pointercancel', endPtr);
el.addEventListener('wheel', (e) => { if (ready && mode === 'tour') setMode('orbit'); idle = 0; controls.autoRotate = false; }, { passive: true, capture: true });
el.addEventListener('contextmenu', (e) => e.preventDefault());

/* ───────────────────────── quality ───────────────────────── */
function setHD(on) {
  Q.hd = on; $('#btn-hd').setAttribute('aria-pressed', String(on));
  if (water) { water.visible = on; flatWater.visible = !on; }
  if (fxWater) fxWater.setHD(on);
  Q.bloom = on; Q.dpr = on ? Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2) : Math.min(devicePixelRatio || 1, 1); resize();
}
$('#btn-hd').addEventListener('click', () => { setHD(!Q.hd); perf.locked = true; });
const fsBtn = $('#btn-full');
if (!document.documentElement.requestFullscreen) fsBtn.hidden = true;
fsBtn.addEventListener('click', () => { const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); });
const perf = { ema: 16, n: 0, step: 0, locked: false, cool: 0 };
function setForest(f) { Q.forest = f; for (const im of forest) { im.count = Math.floor(im.userData.total * f); im.visible = f > 0; } }
function adapt(ms) {
  if (!loaded || document.hidden) return;
  perf.n++; if (perf.n < 90) return;                     // let shaders compile and uploads settle
  perf.ema += (Math.min(ms, 100) - perf.ema) * 0.04; perf.cool -= 1;
  if (perf.locked || perf.cool > 0 || perf.ema < 26) return;
  perf.cool = 150; perf.ema = 20; perf.step++;
  if (perf.step === 1) { Q.maxPixels *= 0.6; Q.mirrorEvery = Math.max(Q.mirrorEvery, 2); Q.mirrorLite = true; Q.lod = Math.max(Q.lod, 1.8); resize(); }
  else if (perf.step === 2) { Q.dpr = Math.max(1, Q.dpr - 0.5); setForest(Math.min(Q.forest, 0.5)); Q.lod = 2.4; resize(); }
  else if (perf.step === 3) { Q.mirrorEvery = 3; Q.dpr = Math.max(0.85, Q.dpr - 0.25); Q.lod = 3.2; resize(); }
  else if (perf.step === 4) { setHD(false); }
  else if (perf.step === 5) { setForest(0.25); Q.dpr = 0.75; resize(); }
}
let lodTick = 0;
function updateLOD() {
  if ((lodTick++ & 7) !== 0) return;
  const scale = renderer.domElement.height * 0.5 * camera.projectionMatrix.elements[5] / (1.35 * Q.lod);
  const d2 = 0.22 * scale, d1 = 0.6 * scale, p = camera.position;
  for (const e of lodMeshes) {
    const d = Math.max(0, p.distanceTo(e.c) - e.r);
    e.mesh.geometry.setDrawRange(0, d > d1 ? e.m.n0 : d > d2 ? e.m.n1 : e.m.ni);
  }
}

/* ───────────────────────── frame loop ───────────────────────── */
const clock = new THREE.Clock(); let time = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1); time += dt; uTime.value = time;
  if (document.hidden) return;
  if (water) water.material.uniforms.time.value = time * 0.32;
  if (ready) {
    updateTrains(time);
    if (mode === 'tour') {
      tourClock += dt;
      const i = tourPose(tourClock, poseA, time);
      if (i !== lastShot) { if (lastShot !== -1) startBlend(3.0); lastShot = i; setCaption(shots[i].place); }
      applyPose(poseA, dt);
    } else if (mode === 'orbit') {
      if (fly.on) {
        fly.t += dt; const w = smooth(fly.t / fly.dur);
        camera.position.lerpVectors(fly.p0, fly.p1, w); camera.position.y += Math.sin(Math.PI * w) * Math.min(60, fly.p0.distanceTo(fly.p1) * 0.12);
        controls.target.lerpVectors(fly.t0, fly.t1, w); camera.lookAt(controls.target);
        if (fly.t >= fly.dur) { fly.on = false; controls.enabled = true; }
      } else {
        idle += dt; controls.autoRotate = idle > 6 && !reduceMotion;
        controls.target.y = clamp(controls.target.y, 1, 70);
        const tr = Math.hypot(controls.target.x, controls.target.z); if (tr > 420) controls.target.multiplyScalar(420 / tr);
        controls.update(dt);
        if (camera.position.y < 2.2) camera.position.y = 2.2;
      }
      camLook.copy(controls.target);
    } else if (mode === 'walk') {
      updateWalk(dt);
      walkLandTimer -= dt; if (walkLandTimer < 0) { walkLandTimer = 0.6; const p = nearestPlace(); if (p) setCaption(p); }
    }
  } else { camera.position.copy(B(150 + Math.sin(time * 0.1) * 30, -470, 250)); camera.lookAt(0, 8, 0); }
  updateLOD();
  if (fxWater) fxWater.update(dt, time);
  if (Q.bloom) { bloomPass.enabled = true; composer.render(dt); } else renderer.render(scene, camera);
  adapt(dt * 1000);
}
window.__park = { lodMeshes, get loaded() { return loaded; }, scene, camera, renderer, controls, Q, setMode, gotoPlace, places, walk, get nav() { return nav; }, get mode() { return mode; }, setTour: (t) => { tourClock = t; lastShot = -1; blend.on = false; }, perf, bakedMat, bloom: () => bloomPass, water: () => water, fxWater: () => fxWater, lanterns: () => lanterns };
frame();
load().catch((err) => { console.error(err); veilMsg.textContent = 'The park could not be loaded: ' + err.message; });
