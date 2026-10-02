// Lanternfall 3D — the Blender park, baked and flown through with three.js.
// Geometry + baked Cycles lighting come from data/*.bin (see Blender-Park/web_export).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createDepth, depthTargetOptions } from './fx/depth.js';
import { readFx } from './fx/settings.js';
import { buildFx, fxActive } from './fx/post.js';
import { makeProfiler } from './fx/prof.js';
import { createWater } from './fx/water.js';
import * as FX from './fx/index.js';
import { createSurface } from './fx/surface.js';
import { trackDisposables, watchContext } from './fx/context.js';
import { veilFail, probe, loadPrefs, buildSettings } from './fx/ui.js';
import { createGuests } from './fx/guests/render.js';      // guests hook (fx/guests/)
import { createSound } from './fx/audio/index.js';      // sound: button, settings entries, lazy engine (fx/audio/)
import { createWeather } from './fx/weather/index.js';  // weather hook: Clear / Mist / Rain / Storm / Snow (fx/weather/)
import { createCull } from './fx/cull/index.js';          // culling hook: per-camera frustum culling of chunks + forest cells (fx/cull/)

const DATA = 'data/';
// a script error while starting up can mean mixed old and new files just after a deploy: refresh them once
addEventListener('error', (e) => { if (!window.__park || !window.__park.loaded) { if (e.error) refreshCode('boot-error'); } });
const $ = (s) => document.querySelector(s);
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(innerWidth, innerHeight) < 620;
const mobile = coarse || small;
const PREFS = loadPrefs();                                   // settings sheet choices (fx/ui.js), if any were saved
let reduceMotion = PREFS.reduceMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
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
// Walk-mode arrival point per chip, Blender (x, y) + yaw: picked with a nav-grid sight-line search and checked in
// screenshots (open view of the place's landmark, no pylon, wall or balustrade in front)
const WALK_AT = {
  park: [300, 0, Math.PI], gate: [288, 0, Math.PI], spire: [85.5, 31.1, -2.79],
  guildhollow: [-149.9, 36.1, -2.36], frostmere: [-65.0, 107.5, 3.14], meridian: [81.7, 93.8, 2.36], wanderers: [139.9, 48.2, 0.39],
  brinewatch: [114.9, -81.5, 0.39], 'lantern-row': [-16.6, -118.5, -0.26], rosewick: [-136.6, -57.6, -1.18],
};
const MOON = new THREE.Vector3(-0.507, 0.616, 0.604).normalize();
const FOG = new THREE.Color(0.016, 0.018, 0.046);

/* ───────────────────────── renderer ───────────────────────── */
const stage = $('#stage');
const CAN = probe();                              // WebGL2, DecompressionStream, reversed depth, HDR targets (fx/ui.js)
if (CAN.fail) { veilFail(CAN.fail.title, CAN.fail.text, false); await new Promise(() => {}); }
trackDisposables(THREE);                           // context-loss hygiene (fx/context.js)
// Reversed depth (EXT_clip_control; three falls back to the standard mapping without it, e.g. on most phones). It pays
// off in the HD composer, whose target gets a 32-bit float depth buffer (fx/depth.js). '#norz' turns it off.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: CAN.clip && !/norz/.test(location.hash) });
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 2.1;
renderer.setClearColor(0x05040f);
stage.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.6, 5000);
camera.position.copy(B(150, -470, 250)); camera.lookAt(0, 8, 0);

const Q = { dpr: Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2), maxPixels: mobile ? 1.5e6 : 2.4e6, hd: true, mirrorEvery: mobile ? 2 : 1, mirrorLite: mobile, bloom: true, lod: mobile ? 1.8 : 1, forest: mobile ? 0.55 : 1 };
Q.post = readFx();                     // post-processing tokens from the URL hash (fx/settings.js)
let composer, bloomPass, composerSamples = -1, fxOut = null;
// z-fighting: per-frame near plane from the camera's clearance to the park (fx/depth.js); '#fixednear' turns it off
const depth = createDepth(THREE, camera, { on: !/fixednear/.test(location.hash) });
// Stillwater, the lake (fx/water.js): settings below; '#nosim' and '#noboat' turn its ripple simulation and punt off.
const HASH = new Set(location.hash.slice(1).split(/[&,+]/));
// waterMirror (HD) / waterMirrorLow (non-HD): 2 = full planar mirror, 1 = captured lands + planar Spire layer + reflected lantern sprites, 0 = capture + sprites
Object.assign(Q, { waterMirror: mobile ? 1 : 2, waterMirrorLow: 1, mirrorScale: 0.5, mirrorBoost: 1.5, mirrorLod: 1.5,
  mirrorEveryLow: 1, mirrorScaleLow: mobile ? 0.5 : 0.4, waterSim: HASH.has('nosim') ? 0 : mobile ? 1 : 2, waterSimHz: mobile ? 30 : 60, waterGloss: mobile ? 3 : 5, waterTap: true, waterBoat: !HASH.has('noboat'), waterScanBudget: 250000, waterEnv: true, waterPools: true, waterEnvSize: mobile ? 256 : 512 });
FX.fxConfig(Q, { mobile, reduceMotion });     // atmosphere / particle systems (fx/index.js) -> Q.fx
for (const k of ['fireworks', 'mist', 'beams']) if (typeof PREFS[k] === 'boolean' && !HASH.has(k) && !HASH.has('no-' + k)) Q.fx[k] = PREFS[k];
// picture quality: 'fast' (no bloom, DPR 1), 'hd' (bloom chain), 'cinematic' (fx/post.js chain: AO, mip bloom, SMAA).
// A '#fx=' token in the URL wins over the saved choice.
const hasFxToken = /(^|[#,&])fx=/.test(location.hash);
Q.hdr = CAN.hdr;            // without float colour targets: no post chain, 8-bit water targets, no ripple simulation
let quality = !Q.hdr ? 'fast' : hasFxToken ? (Q.post.preset === 'legacy' || Q.post.preset === 'off' ? 'hd' : 'cinematic') : (PREFS.quality || (mobile ? 'hd' : 'cinematic'));   // Cinematic by default on desktop: same frame time, richer neon/glow (see the finish report)
if (!hasFxToken && quality === 'cinematic') Q.post = readFx('#fx=hd');
// HD cost is pixel-bound (half-float MSAA target + bloom), so cap the drawn pixels instead of trusting devicePixelRatio.
function effDpr(w, h) { return Math.max(0.6, Math.min(Q.dpr, Math.sqrt(Q.maxPixels / Math.max(1, w * h)))); }
function buildComposer() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  composerSamples = (Q.bloom && !mobile && renderer.getPixelRatio() <= 1.3) ? 4 : 0;       // MSAA only where pixels are scarce (not in Fast)
  if (fxActive(Q.post)) {                                                          // fx/post.js: AO, mip bloom, final pass, AA ...
    fxOut = buildFx({ renderer, scene, camera, Q, size, samples: composerSamples, mobile, lanterns: () => lanterns, water: () => fxWater && fxWater.mesh, focus: () => camLook, tour: () => mode === 'tour' });
    composer = fxOut.composer; bloomPass = fxOut.bloomPass; prof.wrapComposer(composer); return;
  }
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: composerSamples, ...depthTargetOptions(THREE, renderer, size.x, size.y) });
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
  prof.wrapComposer(composer);
}
function disposeComposer() {      // EffectComposer.dispose() frees only its own two targets: the passes hold the rest
  if (!composer) return;
  for (const p of composer.passes) if (p.dispose) p.dispose();
  composer.dispose(); composer = null; bloomPass = null; fxOut = null;
}
let baseFov = 52;
// Where the interface covers the scene (caption and dock on a phone), the projection centre is moved up into the free
// part of the screen with a view offset, so what the camera looks at is not hidden behind the caption.
const view = { w: 1, h: 1, dy: 0, want: 0 };
function applyFov() {     // keep a useful horizontal field of view on tall phone screens
  const { w, h } = view, dy = Math.round(view.dy), H = h + 2 * dy;
  const k = Math.max(1, 1.3 / (w / h));
  const fv = Math.min(baseFov + 26, 2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) * k) * 180 / Math.PI);   // visible window
  camera.fov = 2 * Math.atan(Math.tan(fv * Math.PI / 360) * H / h) * 180 / Math.PI;                              // the taller virtual image
  camera.aspect = w / H;
  if (dy > 0) camera.setViewOffset(w, H, 0, 2 * dy, w, h); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
function coveredBand() {  // px of the screen bottom covered by interface, minus the top bar, halved: the shift that centres the free band
  const W = view.w, H = view.h, dock = $('.dock'), cap = $('#caption'), top = $('.hud.top');
  if (!dock || mode === 'walk') return 0;
  const cr = cap.getBoundingClientRect(), dr = dock.getBoundingClientRect();
  let bottom = H - dr.top;
  if (cr.width > 0.6 * W && cr.height > 0) bottom = H - Math.min(cr.top, dr.top);
  const t = top.getBoundingClientRect().bottom;
  return clamp((bottom - t) / 2, 0, H * 0.18);
}
function resize() {
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  const pr = effDpr(w, h);
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  view.w = w; view.h = h; applyFov();
  if (composer) {
    const want = (Q.bloom && !mobile && pr <= 1.3) ? 4 : 0;
    if (want !== composerSamples) { disposeComposer(); buildComposer(); }
    composer.setPixelRatio(pr); composer.setSize(w, h);
  }
}
const prof = makeProfiler(renderer);
resize(); buildComposer(); resize();
addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);
// context loss (fx/context.js): stop drawing while lost; on restore three re-uploads everything, the app re-validates
// what lived only on the GPU (water simulation, environment capture, temporal history, pending timer queries)
const glCtx = watchContext(renderer, { onRestored() {
  perf.n = Math.min(perf.n, 0);                                       // shaders recompile: do not count those frames
  prof.restore();
  if (fxWater) fxWater.contextRestored();
  if (fxOut && fxOut.passes.taa) fxOut.passes.taa.first = true;
  if (ready) moonShadow();                                            // the moon's shadow map (fx/surface.js) is rendered once
} });

/* ───────────────────────── materials ───────────────────────── */
const uTime = { value: 0 };
// Surface material (fx/surface.js): baked light + per-pixel procedural detail + shadow-mapped moonlight.
// '#nodetail' and '#noshadow' turn those parts off.
const surface = createSurface({ FOG, fogD: 2.4e-7, moonDir: MOON, mobile });
const bakedMat = surface.material;
if (/nodetail/.test(location.hash)) surface.uniforms.uDetail.value = 0;
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
// The mesh format this code reads. The host caches files for minutes, so right after a deploy a browser can hold old
// code with new data (or the reverse). Data files are fetched with the manifest's build id so they always match the
// manifest; if the manifest is newer than this code, refreshCode() re-downloads the page's scripts and reloads once.
const DATA_FORMAT = 2;
let dataTag = '';
async function refreshCode(why) {
  let tried = null; try { tried = sessionStorage.getItem('lf-refresh'); } catch (e) { /* storage unavailable */ }
  if (tried === why) return false;                       // already tried for this build: do not loop
  try { sessionStorage.setItem('lf-refresh', why); } catch (e) { return false; }
  const urls = new Set([location.pathname]);
  for (const e of performance.getEntriesByType('resource')) if (e.name.startsWith(location.origin) && /\.(js|html)(\?|$)/.test(e.name)) urls.add(e.name);
  await Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload(); return true;
}
async function fetchBin(file) {
  const res = await fetch(DATA + file + (B64 ? '.txt' : '') + dataTag);
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
  let aux = null;
  if (m.aux) {                                         // albedo rgb (sqrt-encoded) + surface class, for fx/surface.js
    aux = new Uint8Array(nv * 4);
    for (let c = 0; c < 4; c++) { const o = off + c * nv; let acc = 0; for (let i = 0; i < nv; i++) { const zz = u8[o + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; aux[i * 4 + c] = acc; } }
    off += nv * 4;
  }
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let mx = -1; const p1 = off + ni, p2 = p1 + ni, p3 = p2 + ni;
  for (let i = 0; i < ni; i++) {
    const code = (u8[off + i] | (u8[p1 + i] << 8) | (u8[p2 + i] << 16) | (u8[p3 + i] << 24)) >>> 0;
    const v = mx + 1 - code; if (v > mx) mx = v; idx[i] = v;
  }
  off += ni * 4;
  const g = new THREE.BufferGeometry();
  if (m.lay) {                     // optional coplanar-priority plane (zigzag-delta u8 per vertex): a higher rank wins ties
    const lay = new Uint8Array(nv); let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[off + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; lay[i] = acc; }
    off += nv; g.setAttribute('aLay', new THREE.BufferAttribute(lay, 1)); bakedMat.uniforms.uZBias.value.y = 0;   // ranks replace the brightness guess
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3, false));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 4, true));
  if (aux) g.setAttribute('aAux', new THREE.BufferAttribute(aux, 4, true));
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
let manifest, nav = null, trains = [], lanterns = null, forest = [], fxWater = null;
let guests = null;                                   // park guests (fx/guests/render.js); '#no-guests' turns them off
const cull = createCull({ THREE, renderer, scene, camera, park, on: !HASH.has('no-cull') });   // culling hook ('#no-cull' turns it off)

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
        // a sprite in front of the (dynamic) near plane is drawn on it instead of being clipped: it is closer than any geometry
        #ifdef USE_REVERSED_DEPTH_BUFFER
        if (gl_Position.w > 0.0) gl_Position.z = min(gl_Position.z, gl_Position.w);
        #else
        if (gl_Position.w > 0.0) gl_Position.z = max(gl_Position.z, -gl_Position.w);
        #endif
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
    forest.push(im); scene.add(im); depth.addInstanced(im);
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

// moon shadows: one depth map of everything opaque, rendered from the moon ('#noshadow' skips it)
function moonShadow() {
  if (!surface.uniforms.uMoonOn.value || /noshadow/.test(location.hash)) return;
  const casters = park.children.filter((o) => o.isMesh && o.material !== glassMat && o.geometry.attributes.aCol);
  for (const g of trains) for (const o of g.children) if (o.isMesh && o.material !== glassMat) casters.push(o);
  surface.buildShadow(renderer, scene, casters);
}
async function load() {
  manifest = await (await fetch(DATA + 'manifest.json', { cache: 'no-cache' })).json();
  if ((manifest.format || 1) > DATA_FORMAT && await refreshCode('f' + manifest.format + (manifest.build || ''))) return new Promise(() => {});   // reloading
  if (manifest.build) dataTag = '?v=' + manifest.build;
  const ex = manifest.extras;
  totalBytes = manifest.parts.reduce((s, p) => s + p.bytes, 0) + ex.file.bytes + (ex.train_file ? ex.train_file.bytes : 0) + (manifest.nav ? manifest.nav.bytes : 0);
  if (manifest.b64) { B64 = true; totalBytes = Math.ceil(totalBytes * 4 / 3); }
  bakedMat.uniforms.uRange.value = manifest.range;
  if (manifest.moon && !manifest.moon.baked) {         // moonlight is added per pixel (it is not in the baked colours)
    surface.uniforms.uMoon.value.fromArray(manifest.moon.dir).normalize(); surface.uniforms.uMoonCol.value.fromArray(manifest.moon.col);
    surface.uniforms.uMoonOn.value = 1;
  }
  initRail(manifest.rail.a, manifest.rail.b); depth.addRail(manifest.rail.a, manifest.rail.b, manifest.rail.top);
  fxWater = createWater({ renderer, scene, camera, Q, manifest, uTime, MOON, FOG, park, farMeshes, landMeshes, forest, lodMeshes, getLanterns: () => lanterns, getMode: () => mode, isLoaded: () => loaded });
  setupPlaces();
  FX.fxScene(Q, { scene, lands: manifest.lands, uTime, lake: manifest.lake, waterY: manifest.water_z, moon: MOON });
  const exU8 = await fetchBin(ex.file.file);
  if (ex.lanterns) {
    const lf = new Float32Array(exU8.buffer, exU8.byteOffset + ex.lanterns.span[0], ex.lanterns.count * 8).slice();
    lanterns = FX.fxLanterns(Q, { f32: lf, count: ex.lanterns.count, waterY: manifest.water_z, uTime });
    if (lanterns) scene.add(lanterns); else buildLanterns(lf, ex.lanterns.count);
  }
  if (ex.forest) { buildForest(exU8, ex.forest); cull.splitForest(forest); }      // culling hook: one instance buffer per species, drawn by visible cell
  const names = { core: 'Filling Stillwater', transit: 'Raising the monorail' };
  const pill = $('#loadpill');
  for (const part of manifest.parts) {
    const land = manifest.lands.find((l) => l.id === part.id);
    const label = (names[part.id] || ('Lighting ' + (land ? land.name : part.id))) + '…';
    veilMsg.textContent = label; pill.textContent = label;
    const u8 = await fetchBin(part.file); let off = 0;
    for (const m of part.meshes) {
      const d = decodeMesh(u8, off, m); off = d.next;
      const mesh = meshFrom(d.geometry, m); park.add(mesh); depth.addMesh(mesh); 
      const cx = (m.bbox[0] + m.bbox[3]) / 2, cz = (m.bbox[2] + m.bbox[5]) / 2;
      if (Math.hypot(cx, cz) > 420) farMeshes.push(mesh);
      if (part.id !== 'core') landMeshes.push(mesh);
      if (m.kind !== 'glass' && m.n0 < m.ni) lodMeshes.push({ mesh, m, c: new THREE.Vector3(cx, (m.bbox[1] + m.bbox[4]) / 2, cz), r: 0.5 * Math.hypot(m.bbox[3] - m.bbox[0], m.bbox[4] - m.bbox[1], m.bbox[5] - m.bbox[2]) });
    }
    await new Promise((r) => setTimeout(r, 0));
    if (part.id === 'transit' && !ready) {            // the lake, Spire and monorail are in: open the park, keep lighting lands
      if (ex.train_file) buildTrains(await fetchBin(ex.train_file.file), ex);
      if (manifest.nav) decodeNav(await fetchBin(manifest.nav.file), manifest.nav);
      // ── guests hook ── (fx/guests/render.js draws a stand-in crowd until fx/guests/sim.js is wired in)
      if (!HASH.has('no-guests')) {
        const focus = () => (mode === 'walk' ? { x: walk.x, y: walk.y, z: walk.z, mode } : { x: camera.position.x, y: -camera.position.z, z: camera.position.y, mode, tour: mode === 'tour' ? tourClock % tourLen : -1 });
        const gWant = [...HASH].map((h) => /^guests=(\d+)$/.exec(h)).find(Boolean);
        const gCount = gWant ? Math.min(+gWant[1], 4000) : 2400, gPool = Math.ceil(Math.max(gCount, 400) * 1.7);   // the simulation keeps spare pool entries
        guests = createGuests({ THREE, scene, crowd: null, standIn: HASH.has('guests-standin'), max: gPool, uTime, Q, manifest, DATA, fetchBin, surface, mobile, renderer, camera, depth, nav, reduceMotion, focus });
        if (PREFS.guests === false) guests.setVisible(false);
        // the crowd simulation (fx/guests/sim.js, in a Worker) drives the guests; '#guests-standin' keeps the renderer's
        // built-in random walkers instead, '#guests=N' sets the crowd size
        if (!HASH.has('guests-standin')) import('./fx/guests/sim.js').then(async (S) => {
          const r = await fetch(DATA + 'guests.json' + dataTag).catch(() => null); const pois = r && r.ok ? await r.json().catch(() => null) : null;
          guests.setCrowd(S.createCrowd({ nav, manifest, pois, count: gCount, max: gPool, seed: 1, reduceMotion, fetchBin }), { drive: true });
        }).catch((e) => { console.warn('guests: no simulation, using the stand-in crowd', e); guests.allowStandIn(); });
      }
      ready = true; tourClock = 0; perf.n = -600; moonShadow();
      if (mode === 'orbit') { controls.target.set(0, 8, 0); controls.enabled = true; setCaption(places[0]); }
      $('#veil').classList.add('done'); pill.hidden = false; showHint();
    }
  }
  FX.fxPark(Q, { park, uTime });
  bar.style.width = '100%'; pill.hidden = true; loaded = true; perf.n = 0; moonShadow();
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
  buildTour();                       // the tour's land shots orbit the original targets: build it before the overrides
  for (const p of places) {
    const w = WALK_AT[p.id]; if (w) { p.walk = [w[0], w[1]]; p.yaw = w[2]; }
    // Explore vantage for a land: from behind it, looking in across the land towards the lake, so the lantern canopy over
    // the water is the backdrop instead of a curtain between the camera and the land
    if (p.land) { const c = p.land.center, lk = p.lake; p.target = B(c[0] + lk[0] * 22, c[1] + lk[1] * 22, 4); p.pos = B(c[0] - lk[0] * 105, c[1] - lk[1] * 105, 62); }
  }
  // chips in the order the tour visits the lands (round the lake), not the manifest's
  const order = ['park', 'gate', 'spire', 'wanderers', 'meridian', 'frostmere', 'guildhollow', 'rosewick', 'lantern-row', 'brinewatch'];
  for (const id of order) { const p = places.find((q) => q.id === id); if (p) chips.appendChild(p.chip); }
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
// clean view: hide the whole interface for an unobstructed picture (H, the eye button; Esc or the faint corner handle restores)
let clean = false;
function setClean(on) {
  if (on === clean) return; clean = on;
  if (on && settings.open) settings.close();
  document.body.classList.toggle('clean', on); $('#btn-show').hidden = !on;
  clearTimeout(hintTimer);
  if (on) { hintEl.textContent = coarse ? 'Tap the corner to bring the controls back' : 'Press H to bring the controls back'; hintEl.classList.remove('off'); hintTimer = setTimeout(() => hintEl.classList.add('off'), 2600); }
  else showHint();
}
$('#btn-hide').addEventListener('click', () => setClean(true));
$('#btn-show').addEventListener('click', () => setClean(false));
function showHint() {
  if (clean) return;
  const txt = mode === 'tour' ? (coarse ? 'Drag to explore yourself · tap a place to fly there' : 'Drag to take over · pick a place to fly there')
    : mode === 'orbit' ? (coarse ? 'Drag to orbit · pinch to zoom · two fingers to pan' : 'Drag to orbit · scroll to zoom · right-drag or Shift+arrows to pan')
    : (coarse ? 'Left thumb walks · right thumb looks' : 'WASD or arrows to walk · drag to look · Shift to run · Space to hop');
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
  shots.push({ place: P('park'), dur: 13, f: orbitShot(O, 455, 395, 235, 192, rad(-112), rad(-62), 8, 8) });     // ends where the pull-back ends: seamless loop
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
      shots.push({ place: p, dur: 13, f: orbitShot(ship, 84, 68, 32, 18, base + rad(95), base + rad(-12), 11, 14) });     // ends with the whole rig in frame
    } else shots.push({ place: p, dur: 11.5, f: orbitShot(ctr, 118, 86, 58, 27, base - rad(40), base + rad(34), 9, 8) });
  }
  shots.push({ place: { id: 'loop', kicker: 'An elevated circuit over every land', title: 'The Meridian Loop', text: 'Best view of the finale is from the top of the line.', color: '#7ff0d8', chip: document.createElement('i') }, dur: 15, f: (u, out, t) => {
    const lead = trains.find((g) => g.userData.name.includes('lanternrow_car0')) || trains[0];
    const s = (lead ? lead.userData.s : 0) + t * TRAIN_SPEED, a = railAt(s - 66 + u * 8), b = railAt(s + 6);
    out.p.set(a.x * 1.022, manifest.rail.top + 9.5 - u * 2.0, -a.y * 1.022); out.l.set(b.x, manifest.rail.top + 1.2, -b.y); } });
  shots.push({ place: P('park'), dur: 12, f: orbitShot(O, 210, 455, 70, 235, rad(-175), rad(-112), 14, 8) });
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
  $('#stick').hidden = true; hopBtn.hidden = !(m === 'walk' && coarse && !pfWant);
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
    if (pfWant) enterPlatformer();            // platformer hook: Walk is the lamplighter unless first person was chosen
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
  if (mode === 'walk') { spawnWalk(p.walk[0], p.walk[1], p.yaw); if (pfWant) enterPlatformer(); return; }
  if (mode === 'tour') { setMode('orbit', { keepTarget: true }); controls.target.copy(camLook); }
  fly.on = true; fly.t = 0; fly.dur = reduceMotion ? 0.01 : 2.2; fly.p0.copy(camera.position); fly.t0.copy(controls.target); fly.p1.copy(p.pos); fly.t1.copy(p.target);
  controls.enabled = false; idle = 0;
}
$('#m-tour').addEventListener('click', () => setMode('tour'));
$('#m-orbit').addEventListener('click', () => setMode('orbit'));
$('#m-walk').addEventListener('click', () => setMode('walk'));

/* ───────────────────────── walking ───────────────────────── */
const walk = { x: 300, y: 0, z: 0.12, yaw: Math.PI, pitch: 0, eye: 1.68, bob: 0, hop: 0, vh: 0, cz: 0.12, slide: 1, blockT: 0, stuckT: 0, unsticks: 0 };
// Steps: the walker steps up or down onto any grid cell within WALK_STEP of its feet (nav.bin keeps neighbouring cells up
// to ~0.45-0.6 m apart connected; kerbs, stairs, terrace edges and bleacher tiers of 0.45 m included). A hop (Space, the
// touch Hop button) lifts the feet by up to ~0.6 m, so a cell up to WALK_STEP above the hop is reachable too.
const WALK_STEP = 0.6, HOP_V = 4.6, HOP_G = 18, SLIDE = [0.5, 1.0, 1.45], EDGE = [1.75];
const navH = (v) => (v - 1) / 100 - 2;
function navLevels(x, y) {
  const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((y - nav.y0) / nav.cell);
  if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) return null;
  const k = j * nav.w + i; return [nav.A[k], nav.B[k]];
}
function navHeight(x, y, zRef, tol = WALK_STEP) {
  const lv = navLevels(x, y); if (!lv) return null;
  let best = null, bd = tol;
  for (const v of lv) { if (!v) continue; const h = navH(v), d = Math.abs(h - zRef); if (d <= bd) { bd = d; best = h; } }
  return best;
}
function spawnWalk(x, y, yaw) {
  let found = null;
  for (let r = 0; r < 260 && !found; r++) {
    const n = Math.max(1, Math.round(r * 6));
    for (let k = 0; k < n; k++) { const a = (k / n) * 6.2831853, px = x + Math.cos(a) * r * 0.5, py = y + Math.sin(a) * r * 0.5; const lv = navLevels(px, py); if (lv && lv[0] && !inLake(px, py)) { found = [px, py, navH(lv[0])]; break; } }
  }
  if (!found) found = [300, 0, 0.12];
  walk.x = found[0]; walk.y = found[1]; walk.z = walk.cz = found[2]; walk.hop = walk.vh = 0; walk.stuckT = 0;
  walk.yaw = yaw !== undefined ? yaw : Math.atan2(-walk.y, -walk.x);   // face the lake
  walk.pitch = 0.04;
}
// the Spire island and the harbour-light rock are walkable but cut off: never drop a visitor there
function inLake(x, y) { const pl = manifest.lake; let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function walkCanStand(x, y, z, air = false) {     // air: in a hop, anything under the footprint lower than the feet is fine
  const r = 0.28; let h = navHeight(x, y, z); if (h === null) return null;
  const top = Math.max(h, z) + 0.75;
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    if (!air) { if (navHeight(x + dx, y + dy, h, 0.75) === null) return null; continue; }
    const lv = navLevels(x + dx, y + dy); if (!lv || !((lv[0] && navH(lv[0]) <= top) || (lv[1] && navH(lv[1]) <= top))) return null;
  }
  return h;
}
// a move of (mx, my) from where the walker is, feet at zr (ground + hop); lands it on the cell's height
function walkTry(mx, my, zr) {
  const h = walkCanStand(walk.x + mx, walk.y + my, zr, walk.hop > 0); if (h === null) return false;
  walk.x += mx; walk.y += my;
  if (walk.hop > 0 || walk.vh > 0) { walk.hop = Math.max(0, zr - h); if (!walk.hop) walk.vh = 0; }
  walk.z = h; return true;
}
function walkHop() { if (mode === 'walk' && walk.hop === 0 && walk.vh === 0 && !document.body.classList.contains('pf-on')) walk.vh = HOP_V; }
// touch: a Hop button on the right, above the dock (outside the canvas, so it never takes the stick's or the look's touch)
const hopBtn = document.createElement('button');
hopBtn.type = 'button'; hopBtn.id = 'hop'; hopBtn.textContent = 'Hop'; hopBtn.title = 'Hop'; hopBtn.hidden = true;
hopBtn.style.cssText = 'position:fixed;z-index:6;right:max(16px,env(safe-area-inset-right,0px));bottom:calc(env(safe-area-inset-bottom,0px) + 262px);width:62px;height:62px;border-radius:50%;' +
  'border:1px solid rgba(245,236,220,.22);background:rgba(13,11,38,.55);color:#f5ecdc;font:600 14px Figtree,system-ui,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)';
hopBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); walkHop(); });
hopBtn.addEventListener('contextmenu', (e) => e.preventDefault());
document.body.appendChild(hopBtn);
const keys = new Set(); const stick = { id: -1, x: 0, y: 0, ox: 0, oy: 0 }; const look = { id: -1, x: 0, y: 0 };
addEventListener('keydown', (e) => { if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; keys.add(e.code); if (mode !== 'tour' && /Arrow|Space|Page/.test(e.code)) e.preventDefault(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// shortcuts: 1 / 2 / 3 modes, F full screen, Esc closes the settings sheet or leaves Walk for Explore
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !ready) return;
  if (e.key === 'Escape') { if (settings.open) settings.close(); else if (clean) setClean(false); else if (mode === 'walk') setMode('orbit'); return; }
  if (e.repeat) return;
  if (e.code === 'Space' && mode === 'walk') { walkHop(); return; }
  const m = { Digit1: 'tour', Digit2: 'orbit', Digit3: 'walk' }[e.code];
  if (m) { if (m !== mode) setMode(m); return; }
  if (e.code === 'KeyF' && !fsBtn.hidden) fsBtn.click();
  if (e.code === 'KeyH') setClean(!clean);
});
function orbitKeys(dt) {          // Explore from the keyboard: arrows / WASD orbit and tilt, +/- zoom, Shift + arrows pan
  const c = controls, k = (a, b) => keys.has(a) || (b && keys.has(b)); if (!keys.size || typeof c._rotateLeft !== 'function') return;
  const sh = k('ShiftLeft', 'ShiftRight'), r = dt * 1.1, any = [];
  const L = k('ArrowLeft', 'KeyA'), R = k('ArrowRight', 'KeyD'), U = k('ArrowUp', 'KeyW'), D = k('ArrowDown', 'KeyS');
  if (sh) { if (L) c._pan(dt * 500, 0); if (R) c._pan(-dt * 500, 0); if (U) c._pan(0, dt * 500); if (D) c._pan(0, -dt * 500); }
  else { if (L) c._rotateLeft(-r); if (R) c._rotateLeft(r); if (U) c._rotateUp(-r * 0.6); if (D) c._rotateUp(r * 0.6); }
  if (k('Equal', 'NumpadAdd') || k('PageUp')) c._dollyIn(1 + dt * 1.5);
  if (k('Minus', 'NumpadSubtract') || k('PageDown')) c._dollyOut(1 + dt * 1.5);
  if (L || R || U || D || k('Equal', 'Minus') || k('NumpadAdd', 'NumpadSubtract') || k('PageUp', 'PageDown')) { idle = 0; c.autoRotate = false; if (fly.on) { fly.on = false; c.enabled = true; } }
}
function updateWalk(dt) {
  let fx = 0, fy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) fy += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) fy -= 1;
  if (keys.has('KeyD')) fx += 1; if (keys.has('KeyA')) fx -= 1;
  if (keys.has('ArrowLeft')) walk.yaw += dt * 1.9; if (keys.has('ArrowRight')) walk.yaw -= dt * 1.9;
  if (stick.id !== -1) { fx += stick.x; fy += -stick.y; }
  if (walk.vh || walk.hop > 0) { walk.vh -= HOP_G * dt; walk.hop += walk.vh * dt; if (walk.hop <= 0) { walk.hop = 0; walk.vh = 0; } }
  const mag = Math.hypot(fx, fy), x0 = walk.x, y0 = walk.y;
  if (mag > 0.02) {
    const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 9.5 : 4.6) * Math.min(1, mag) * (stick.id !== -1 ? 1.25 : 1);
    fx /= mag; fy /= mag;
    const c = Math.cos(walk.yaw), s = Math.sin(walk.yaw);        // yaw about +Z in the Blender frame; forward = (c, s)
    const dx = (fy * c + fx * s) * sp * dt, dy = (fy * s - fx * c) * sp * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.2));
    for (let k = 0; k < steps; k++) {
      const sx = dx / steps, sy = dy / steps, zr = walk.z + walk.hop;
      if (walkTry(sx, sy, zr)) continue;
      // blocked: slide along the obstacle, i.e. the move turned by 30, 60, 85 degrees (shortened to its part along the
      // wish), all on the side that worked last time before the other side; held up for a moment (the corner of an
      // obstacle in the way), also edge sideways (100 degrees, slowly) to get round it; then along the axes. In a
      // concave corner every one of these is blocked, so the walker rests there without jitter
      let ok = false;
      const turns = walk.blockT > 0.25 ? SLIDE.concat(EDGE) : SLIDE;
      for (const sg of [walk.slide, -walk.slide]) {
        for (const a of turns) {
          const kk = a > 1.5 ? 0.35 : Math.cos(a), ca = Math.cos(a * sg), sa = Math.sin(a * sg);
          if (walkTry((sx * ca - sy * sa) * kk, (sx * sa + sy * ca) * kk, zr)) { walk.slide = sg; ok = true; break; }
        }
        if (ok) break;
      }
      if (!ok && !walkTry(sx, 0, zr)) walkTry(0, sy, zr);
    }
    // progress along the wish: little of it for a while means an obstacle's corner is in the way
    const prog = ((walk.x - x0) * dx + (walk.y - y0) * dy) / (dx * dx + dy * dy);
    walk.blockT = prog < 0.25 ? walk.blockT + dt : Math.max(0, walk.blockT - dt * 0.5);
    walk.bob += Math.hypot(walk.x - x0, walk.y - y0) * 1.7;   // the bob follows the distance walked (none against a wall)
    // never stuck: input held for a second without moving and no way out at all -> to the nearest cell it can walk from
    walk.stuckT = Math.hypot(walk.x - x0, walk.y - y0) < 1e-3 * sp ? walk.stuckT + dt : 0;
    if (walk.stuckT > 1) { walk.stuckT = 0; walkUnstick(); }
  } else { walk.stuckT = 0; walk.blockT = 0; }
  // camera: eases over steps (and the hop's landing on a higher cell), follows a hop closely
  walk.cz += (walk.z + walk.hop - walk.cz) * Math.min(1, dt * (walk.hop > 0 ? 30 : 9));
  if (Math.abs(walk.cz - walk.z - walk.hop) > 3) walk.cz = walk.z + walk.hop;
  camera.position.set(walk.x, walk.cz + walk.eye + (walk.hop > 0 ? 0 : Math.sin(walk.bob) * 0.035), -walk.y);
  const cp = Math.cos(walk.pitch);
  camLook.set(walk.x + Math.cos(walk.yaw) * cp, camera.position.y + Math.sin(walk.pitch), -(walk.y + Math.sin(walk.yaw) * cp));
  camera.lookAt(camLook);
}
function walkUnstick() {
  const free = (x, y, z) => { const h = walkCanStand(x, y, z); if (h === null) return null; for (let q = 0; q < 8; q++) { const a = q * Math.PI / 4; if (walkCanStand(x + Math.cos(a) * 0.2, y + Math.sin(a) * 0.2, h) !== null) return h; } return null; };
  if (free(walk.x, walk.y, walk.z) !== null) return;            // just against a wall: not stuck
  for (let r = 1; r <= 12; r++) {
    for (let q = 0; q < r * 8; q++) {
      const a = q / (r * 8) * Math.PI * 2, x = walk.x + Math.cos(a) * r * 0.25, y = walk.y + Math.sin(a) * r * 0.25;
      for (const dz of [0, -0.6, -1.2]) { const h = free(x, y, walk.z + dz); if (h !== null) { walk.x = x; walk.y = y; walk.z = h; walk.hop = walk.vh = 0; walk.unsticks++; return; } }
    }
  }
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
  Q.hd = on;
  if (fxWater) fxWater.setHD(on);
  Q.bloom = on; Q.dpr = on ? Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2) : Math.min(devicePixelRatio || 1, 1, Q.dpr); resize();   // never raises what adapt() lowered
}
function setQuality(q, user) {
  quality = q; if (user) { perf.locked = true; undoAdapt(); }     // a visitor's choice is not overridden by adapt(), and gets the whole preset: what adapt() took away comes back
  {
    const want = readFx(q === 'cinematic' ? '#fx=hd' : '#fx=legacy');
    if (JSON.stringify(want) !== JSON.stringify(Q.post)) { Q.post = want; disposeComposer(); buildComposer(); resize(); }
  }
  setHD(q !== 'fast'); if (settings) settings.setQuality(q);
}
const QUALITIES = [
  { id: 'fast', label: 'Fast', note: 'No glow or mirror reflections; for older phones and laptops.' },
  { id: 'hd', label: 'HD', note: 'Glow around the lights and the lake as a mirror.' },
  { id: 'cinematic', label: 'Cinematic', note: 'HD plus contact shadows and a softer, wider glow. Same speed on most graphics cards.' },
];
if (!Q.hdr) for (const q of QUALITIES) if (q.id !== 'fast') q.disabled = 'This graphics driver cannot render the glow (no float render targets).';
let settings = null;
settings = buildSettings({ qualities: QUALITIES, quality, onQuality: (q) => setQuality(q, true),
  toggles: [
    { id: 'fireworks', label: 'Fireworks', on: Q.fx.fireworks },
    { id: 'mist', label: 'Mist on the lake', on: Q.fx.mist },
    { id: 'beams', label: 'Searchlights', on: Q.fx.beams },
    { id: 'guests', label: 'Guests', on: !HASH.has('no-guests') && PREFS.guests !== false },      // guests hook
    { id: 'reduceMotion', label: 'Reduce motion', on: reduceMotion },
  ],
  onToggle(id, on) {
    if (id === 'reduceMotion') { reduceMotion = on; FX.fxMotion(Q, !on); if (guests) guests.setReduceMotion(on); weather.setReduceMotion(on); if (on) controls.autoRotate = false; return; }   // weather hook
    if (id === 'guests') { if (guests) guests.setVisible(on); return; }      // guests hook
    FX.fxSet(Q, id, on);
  } });
if (quality === 'fast') setHD(false);
/* ── sound (fx/audio/): nothing audio is fetched before the sound button; the engine follows the camera ── */
const sound = createSound({ THREE, camera, manifest: () => manifest, DATA, Q, mobile, getMode: () => mode, getWalk: () => walk, getTrains: () => trains,
  fx: () => FX.fxState(), getTour: () => (ready && mode === 'tour' ? tourClock % tourLen : -1), getWater: () => fxWater,
  getCrowd: () => (guests && guests.crowd && guests.crowd.state ? guests.crowd : null) });     // murmur follows the guests' local density
/* ── end sound ── */
// ── weather hook ── (fx/weather/): Clear is the untouched park; '#weather=rain' etc.; window.__park.weather
const weather = createWeather({ THREE, scene, camera, renderer, Q, surface, uTime, mobile, reduceMotion, FOG, DATA, fetchBin,
  getPark: () => park, getWater: () => fxWater, getFx: () => FX.fxState(), manifest: () => manifest, getMode: () => mode, getWalk: () => walk, isReady: () => ready, isLoaded: () => loaded, glLost: () => glCtx.lost, getSound: () => (sound.on ? sound.engine : null) });
const fsBtn = $('#btn-full');
{ // full screen where the page may take it (not on iPhone Safari: no Fullscreen API for elements; Add to Home Screen instead)
  const de = document.documentElement, req = de.requestFullscreen || de.webkitRequestFullscreen, exit = document.exitFullscreen || document.webkitExitFullscreen;
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!req || document.fullscreenEnabled === false || document.webkitFullscreenEnabled === false) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => { const p = fsEl() ? exit.call(document) : req.call(de); if (p && p.catch) p.catch(() => {}); });
  const sync = () => { const on = !!fsEl(); fsBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen'); fsBtn.title = on ? 'Leave full screen' : 'Full screen'; };
  document.addEventListener('fullscreenchange', sync); document.addEventListener('webkitfullscreenchange', sync);
}
const perf = { ema: 16, n: 0, step: 0, locked: !!PREFS.quality, cool: 0 };     // a saved choice holds from the start
// what adapt() lowers, as configured: a picture setting chosen in the sheet starts again from these
const Q0 = (({ dpr, maxPixels, mirrorEvery, mirrorLite, waterMirror, lod, waterSimHz, forest }) => ({ dpr, maxPixels, mirrorEvery, mirrorLite, waterMirror, lod, waterSimHz, forest }))(Q);
function undoAdapt() {
  if (!perf.step) return;
  Object.assign(Q, Q0); perf.step = 0; perf.ema = 16; perf.cool = 0;
  setForest(Q.forest); if (fxWater && perf.simWas) fxWater.sim.on = true;
  FX.fxDegrade(Q, 0); if (guests) guests.degrade(0); weather.degrade(0);
}
function setForest(f) { Q.forest = f; for (const im of forest) { if (im.userData.setFraction) { im.userData.setFraction(f); continue; }   /* culling hook */ im.count = Math.floor(im.userData.total * f); im.visible = f > 0; } }
function adapt(ms) {
  if (!loaded || document.hidden) return;
  perf.n++; if (perf.n < 90) return;                     // let shaders compile and uploads settle
  perf.ema += (Math.min(ms, 100) - perf.ema) * 0.04; perf.cool -= 1;
  if (perf.locked || perf.cool > 0 || perf.ema < 26) return;
  perf.cool = 150; perf.ema = 20; perf.step++; FX.fxDegrade(Q, perf.step); if (guests) guests.degrade(perf.step); weather.degrade(perf.step);   // weather hook
  // the ladder: pixels and the mirror first, then the costly post passes (Cinematic's AO / temporal AA), resolution, the
  // lake's simulation, then Fast (no bloom, DPR 1); particles follow in FX.fxDegrade(), the settings sheet follows setQuality()
  if (perf.step === 1) {
    Q.maxPixels *= 0.6; Q.mirrorEvery = Math.max(Q.mirrorEvery, 2); Q.mirrorLite = true; Q.waterMirror = Math.min(Q.waterMirror, 1); Q.lod = Math.max(Q.lod, 1.8); Q.waterSimHz = 30;
    if (Q.post.ao || Q.post.aa === 'taa' || Q.post.tilt) { Q.post = { ...Q.post, ao: '', tilt: false, aa: Q.post.aa === 'taa' ? 'auto' : Q.post.aa }; disposeComposer(); buildComposer(); }
    resize();
  }
  else if (perf.step === 2) { Q.dpr = Math.max(1, Q.dpr - 0.5); setForest(Math.min(Q.forest, 0.5)); Q.lod = 2.4; resize(); }
  else if (perf.step === 3) { Q.mirrorEvery = 3; Q.dpr = Math.max(0.85, Q.dpr - 0.25); Q.lod = 3.2; if (fxWater) { perf.simWas = perf.simWas || fxWater.sim.on; fxWater.sim.on = false; } resize(); }
  else if (perf.step === 4) { setQuality('fast'); }
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
let lastNow = performance.now(), time = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), dt = Math.min(Math.max(now - lastNow, 0) / 1000, 0.1); lastNow = now; time += dt; uTime.value = time;
  if (document.hidden || glCtx.lost) return;
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
        orbitKeys(dt);
        idle += dt; controls.autoRotate = idle > 6 && !reduceMotion;
        controls.target.y = clamp(controls.target.y, 1, 70);
        const tr = Math.hypot(controls.target.x, controls.target.z); if (tr > 420) controls.target.multiplyScalar(420 / tr);
        controls.update(dt);
        if (camera.position.y < 2.2) camera.position.y = 2.2;
      }
      camLook.copy(controls.target);
    } else if (mode === 'walk') {
      if (pf && pf.active) pf.update(dt); else updateWalk(dt);       // platformer hook (fx/platformer/)
      walkLandTimer -= dt; if (walkLandTimer < 0) { walkLandTimer = 0.6; const p = nearestPlace(); if (p) setCaption(p); }
    }
  } else { camera.position.copy(B(150 + Math.sin(time * 0.1) * 30, -470, 250)); camera.lookAt(0, 8, 0); }
  if ((lodTick & 15) === 0) view.want = clean ? 0 : coveredBand();      // clean view: nothing covers the scene
  if (Math.abs(view.want - view.dy) > 0.5) { view.dy += (view.want - view.dy) * Math.min(1, dt * 4); if (Math.abs(view.want - view.dy) < 0.5) view.dy = view.want; applyFov(); }
  updateLOD(); FX.fxUpdate(Q, camera, { time, dt, tour: ready && mode === 'tour' ? tourClock % tourLen : -1 });
  if (pf) pf.frame(dt, mode);                                                 // platformer hook: leaves it when the mode changes
  if (guests) { camera.updateMatrixWorld(); guests.update(camera, dt); }     // guests hook: before the lake's mirror pass
  sound.update(dt, time);                                   // after the fireworks, before the lake consumes its tap splats
  weather.update(dt, time);                                 // weather hook: before the lake (rain splats) and the render
  if (fxWater) { if (fxWater.hd !== Q.hd) { fxWater.setHD(Q.hd); fxWater.hd = Q.hd; } fxWater.update(dt, time); }
  depth.update(mode === 'walk' ? 0.22 : 0.6);     // never nearer than the old fixed planes
  // Fast keeps the half-float target, tone mapping and grade (bloom off, DPR 1, no MSAA): drawn straight to the 8-bit
  // canvas, additive lanterns and beams would be tone-mapped one by one and clip to white. Direct only without HDR targets.
  if (Q.bloom || Q.hdr) { if (bloomPass) bloomPass.enabled = Q.bloom; composer.render(dt); } else { prof.seg('direct'); renderer.render(scene, camera); prof.seg(null); }
  prof.poll();
  adapt(dt * 1000);
}
window.__park = { sound, weather, get guests() { return guests; }, glCtx, depth, lodMeshes, get loaded() { return loaded; }, scene, camera, renderer, controls, Q, setMode, gotoPlace, places, walk, get nav() { return nav; }, get mode() { return mode; }, setTour: (t) => { tourClock = t; lastShot = -1; blend.on = false; }, perf, bakedMat, bloom: () => bloomPass, fxWater: () => fxWater, lanterns: () => lanterns, fx: FX, surface,
  post: { prof, get out() { return fxOut; }, rebuild: (h) => { if (h !== undefined) Q.post = readFx(h); disposeComposer(); buildComposer(); resize(); prof.wrapComposer(composer); } } };
// ── platformer hook ── (fx/platformer/: Walk mode's player is Wick the lamplighter in third person; #btn-pf or P
// switches to the first-person walker and back, and the choice is remembered; #fp starts in first person. Nothing of
// it is downloaded or built until Walk is first entered)
const PF_KEY = 'lanternfall-walk';
let pf = null, pfLoading = null, pfWant = !HASH.has('fp') && (() => { try { return localStorage.getItem(PF_KEY) !== 'fp'; } catch (e) { return true; } })();
function platformer() {
  if (!pfLoading) pfLoading = import('./fx/platformer/index.js').then((M) => M.createPlatformer({ THREE, scene, camera, renderer, park, lodMeshes, manifest, nav, depth, surface, walk, Q, mobile, coarse,
    guests: () => guests, reduceMotion: () => reduceMotion, setMode, setFov: (f) => { if (f) { baseFov = f; applyFov(); } },
    onEsc: () => { if (settings.open) settings.close(); else if (clean) setClean(false); else setMode('orbit'); }, onSwitch: () => setPlatformer(false),
    status: (t) => { const p = $('#loadpill'); p.hidden = !t; if (t) p.textContent = t; },
    hint: (t) => { hintEl.textContent = t; hintEl.classList.remove('off'); clearTimeout(hintTimer); hintTimer = setTimeout(() => hintEl.classList.add('off'), 6500); } })).then((p) => (pf = p))
    .catch((e) => { console.warn('platformer:', e); pfLoading = null; pfWant = false; $('#loadpill').hidden = true; if (mode === 'walk') hopBtn.hidden = !coarse; });
  return pfLoading;
}
// (re)spawns the lamplighter where the walker stands; the last call wins while the module is still loading
let pfEnterSeq = 0;
function enterPlatformer() { const k = ++pfEnterSeq; platformer().then((p) => { if (p && k === pfEnterSeq && mode === 'walk' && pfWant) p.enter(); }); }
function setPlatformer(on) {
  if (!ready || !nav) return;
  pfWant = on; try { localStorage.setItem(PF_KEY, on ? 'pf' : 'fp'); } catch (e) { /* private mode: not remembered */ }
  if (!on) { if (pf && pf.active) pf.exit(); else if (mode === 'walk') hopBtn.hidden = !coarse; return; }   // exit() puts the walker where the lamplighter stood
  if (mode !== 'walk') setMode('walk'); else { hopBtn.hidden = true; enterPlatformer(); }
}
const togglePlatformer = () => setPlatformer(!(mode === 'walk' && pfWant));
$('#btn-pf').addEventListener('click', togglePlatformer);
addEventListener('keydown', (e) => { if (e.code === 'KeyP' && mode === 'walk' && ready && !e.ctrlKey && !e.metaKey && !e.altKey && !(pf && pf.active)) { e.preventDefault(); if (!e.repeat) togglePlatformer(); } });
Object.defineProperty(window.__park, 'platformer', { get: () => pf });
window.__park.cull = cull;                                  // culling hook: .set(on), .stats
Object.assign(window.__park, { loadPlatformer: platformer, togglePlatformer, setPlatformer });
frame();
let loadFailed = false;
load().catch(async (err) => {
  const net = err instanceof TypeError || /network|fetch|\b[45]\d\d\b/i.test(err.message);
  if (!net && await refreshCode('load-error')) return;        // possibly mixed old and new files just after a deploy
  loadFailed = true; console.warn('Lanternfall: loading failed:', err);
  veilFail(net ? 'The download was interrupted.' : 'The park could not be loaded.', net ? 'Check the connection and try again.' : err.message);
});
{ // a download that stops without an error (stalled connection): offer a retry instead of an endless progress bar
  let seen = -1, still = 0;
  const watch = setInterval(() => {
    if (loaded || loadFailed) { clearInterval(watch); return; }
    if (glCtx.lost || loadedBytes !== seen) { seen = loadedBytes; still = 0; return; }
    if (++still === 25) veilFail('The download has stalled.', 'Nothing has arrived for 25 seconds. Check the connection and try again.');
  }, 1000);
}
