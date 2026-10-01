// Stillwater: a calm night lake for Lanternfall 3D.
//
//  - planar mirror (own implementation, see renderMirror): aspect-matched target at a fraction of the screen,
//    frustum cropped to the lake's screen rectangle, coarse LOD and no far meshes / forest in the mirror pass,
//    optional every-Nth-frame update (the texture matrix is kept with the texture, so stale frames reproject);
//  - surface normal = long swell + two scrolling wind-ripple layers modulated by drifting calm/ruffled patches
//    + an interactive height-field simulation (ping-pong half-float target, after webgl_gpgpu_water) that the
//    floating lanterns, a slow lantern punt and taps on the water excite, with walls taken from the real geometry;
//  - glossy reflection: the reflected ray is projected into the mirror at a nominal distance and smeared along
//    the view direction by the local roughness, which gives the long vertical light streaks of still water;
//  - Schlick Fresnel (F0 = 0.02), moon glitter, a soft contact line and shallow tint from a shore distance field;
//  - no-mirror tier: analytic sky + the lantern sprites reflected about the water plane (drawn on the plane).
import * as THREE from 'three';

const BASIN = [[126.01,-30.32],[125.78,-30.98],[123.01,-29.99],[122.99,-29.99],[120.01,-28.93],[117.01,-27.86],[114.57,-26.99],[114.01,-26.79],[112.59,-26.28],[113.41,-23.99],[114.01,-22.28],[114.47,-20.99],[115.54,-17.99],[116.61,-14.99],[117.01,-13.86],[117.68,-11.99],[118.63,-9.33],[120.01,-9.82],[123.01,-10.89],[126.01,-11.96],[126.1,-11.99],[129.01,-13.02],[131.82,-14.02],[131.47,-14.99],[130.4,-17.99],[129.34,-20.99],[129.01,-21.89],[128.27,-23.99],[127.2,-26.99],[126.13,-29.99]];
function inPoly(pl, x, y) { let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/* ───────── generated textures ───────── */
function rippleTexture(N = 256, seed = 3) {
  // tileable wind ripples: many short crests, wave vectors within ±70° of the wind; stores the slope (dh/du, dh/dv)
  const waves = []; let s = seed;
  const rnd = () => hash(s++);
  for (let i = 0; i < 40; i++) {
    const a = (rnd() - 0.5) * 2.4, k = 3 + Math.floor(rnd() * 26);
    const fx = Math.round(Math.cos(a) * k), fy = Math.round(Math.sin(a) * k + (rnd() - 0.5) * 6);
    if (!fx && !fy) continue;
    waves.push([fx, fy, rnd() * 6.283, Math.pow(Math.hypot(fx, fy), -1.25)]);
  }
  const data = new Uint8Array(N * N * 4), sx = new Float32Array(N * N), sy = new Float32Array(N * N); let mx = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let dx = 0, dy = 0; const u = (i / N) * 6.2831853, v = (j / N) * 6.2831853;
    for (const [fx, fy, ph, am] of waves) { const c = Math.cos(fx * u + fy * v + ph) * am; dx += c * fx; dy += c * fy; }
    sx[j * N + i] = dx; sy[j * N + i] = dy; mx = Math.max(mx, Math.abs(dx), Math.abs(dy));
  }
  for (let k = 0; k < N * N; k++) { data[k * 4] = (sx[k] / mx * 0.5 + 0.5) * 255; data[k * 4 + 1] = (sy[k] / mx * 0.5 + 0.5) * 255; data[k * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
function noiseTexture(N = 128) {
  // tileable value-noise fbm, for the calm / ruffled patches
  const g = (i, j, o) => hash(((i % o) + o) % o * 57 + (((j % o) + o) % o) * 131 + o * 7);
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let v = 0, a = 0.55, f = 4;
    for (let o = 0; o < 4; o++) {
      const x = (i / N) * f, y = (j / N) * f, ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const n = (g(ix, iy, f) * (1 - fx) + g(ix + 1, iy, f) * fx) * (1 - fy) + (g(ix, iy + 1, f) * (1 - fx) + g(ix + 1, iy + 1, f) * fx) * fy;
      v += a * n; a *= 0.5; f *= 2;
    }
    data[(j * N + i) * 4] = Math.min(255, v / 1.03 * 255); data[(j * N + i) * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

/* ───────── shared GLSL ───────── */
const SKY = /* glsl */`
  vec3 skyCol(vec3 d, vec3 moon){
    float h = clamp(d.y, -0.2, 1.0);
    vec3 zen = vec3(0.007, 0.010, 0.036), mid = vec3(0.030, 0.036, 0.105), hor = vec3(0.075, 0.062, 0.145);
    vec3 col = mix(hor, mid, smoothstep(0.0, 0.16, h)); col = mix(col, zen, smoothstep(0.10, 0.62, h));
    col += vec3(0.060, 0.034, 0.016) * exp(-max(h, 0.0) * 13.0);
    float ang = acos(clamp(dot(d, moon), -1.0, 1.0));
    col += vec3(0.56, 0.66, 0.92) * (0.050 * exp(-ang * 9.0) + 0.22 * exp(-ang * 42.0));
    return col;
  }`;
const DRIFT = /* glsl */`
  vec3 lanternDrift(vec3 p, float t, float water, out float ph){
    ph = fract(sin(dot(p.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    float air = smoothstep(water + 0.6, water + 3.0, p.y);
    p.x += (sin(t * 0.21 + ph) * 0.9 + sin(t * 0.53 + ph * 2.0) * 0.25) * mix(0.25, 1.0, air);
    p.z += (cos(t * 0.17 + ph * 1.3) * 0.9 + cos(t * 0.47 + ph) * 0.25) * mix(0.25, 1.0, air);
    p.y += sin(t * 0.31 + ph * 1.7) * mix(0.03, 0.7, air);
    return p;
  }`;

/* ───────── module ───────── */
export function createWater(ctx) {
  const { renderer, scene, camera, Q, manifest, uTime, MOON, FOG } = ctx;
  const W0 = manifest.water_z;
  const lake = manifest.lake;                     // Blender (x, y); three = (x, -y)
  // other water at the lake's level that shares the plane (and so the mirror): Brinewatch's tavern basin, outline
  // traced from the 'brinewatch_basin_water' triangles of part__brinewatch.npz (z = -0.80). A pipeline version would
  // put such outlines into the manifest (see the report); the mesh there is baked flat and is covered by ours.
  const extra = Q.waterPools ? [BASIN] : [];
  const polys = [lake, ...extra];
  const caps = renderer.capabilities, ext = renderer.extensions;
  const canSim = caps.isWebGL2 && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));

  // sim / mask domain over the lake, in three (x, z)
  let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (const [x, y] of polys.flat()) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const X0 = bx0 - 4, X1 = bx1 + 4, Z0 = -by1 - 4, Z1 = -by0 + 4;
  const SX = X1 - X0;
  const ENV_Y = W0 + 4, ENV_A = 172, ENV_B = 132, ENV_NEAR = 16;   // capture point and the ring of lands it stands for
  const SW = Math.round(SX / (Q.waterSim >= 2 ? 0.4 : 0.8) / 4) * 4;             // 0.4 m cells (0.8 m on phones)
  const dx = SX / SW, SH = Math.round((Z1 - Z0) / dx / 4) * 4, SZ = SH * dx;     // square cells
  const dom = new THREE.Vector4(X0, Z0, 1 / SX, 1 / SZ);

  /* lake mask + shore distance (R = distance / 8 m, G = water) */
  const water = new Uint8Array(SW * SH);          // 1 = inside the lake polygon
  const wall = new Uint8Array(SW * SH), polyId = new Uint8Array(SW * SH);           // 1 = geometry crosses the water plane here
  {
    for (let pi = 0; pi < polys.length; pi++) for (let j = 0, pz = polys[pi].map(([x, y]) => [x, -y]); j < SH; j++) {
      const zz = Z0 + (j + 0.5) * SZ / SH; const xs = [];
      for (let k = 0; k < pz.length; k++) {
        const a = pz[k], b = pz[(k + 1) % pz.length];
        if ((a[1] <= zz) !== (b[1] <= zz)) xs.push(a[0] + (zz - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - X0) / dx - 0.5)), i1 = Math.min(SW - 1, Math.floor((xs[k + 1] - X0) / dx - 0.5));
        for (let i = i0; i <= i1; i++) { water[j * SW + i] = 1; polyId[j * SW + i] = pi; }
      }
    }
  }
  const maskData = new Uint8Array(SW * SH * 4);
  const maskTex = new THREE.DataTexture(maskData, SW, SH, THREE.RGBAFormat);
  maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter;
  const dist = new Float32Array(SW * SH), open = new Uint8Array(SW * SH);
  function rebuildMask() {
    const INF = 1e9, D1 = dx, D2 = dx * Math.SQRT2;
    // open water = lake cells reachable from the widest point without crossing a wall (drops the island and hull interiors)
    open.fill(0); let lab = 1, bestN = 0, bestL = 0;
    const comp = new Int32Array(SW * SH), st = [];
    for (let k0 = 0; k0 < SW * SH; k0++) {
      if (comp[k0] || !water[k0] || wall[k0]) continue;
      lab++; let n = 0; comp[k0] = lab; st.push(k0);
      while (st.length) { const k = st.pop(), i = k % SW; n++;
        for (const q of [i > 0 ? k - 1 : -1, i < SW - 1 ? k + 1 : -1, k - SW, k + SW]) if (q >= 0 && q < SW * SH && !comp[q] && water[q] && !wall[q]) { comp[q] = lab; st.push(q); } }
      if (n > bestN) { bestN = n; bestL = lab; }
    }
    const keep = new Set([bestL]);
    for (let pi = 1; pi < polys.length; pi++) {                // the largest component inside each extra pool
      const cnt = new Map(); let bl = 0, bn = 0;
      for (let k = 0; k < SW * SH; k++) if (polyId[k] === pi && comp[k]) { const n = (cnt.get(comp[k]) || 0) + 1; cnt.set(comp[k], n); if (n > bn) { bn = n; bl = comp[k]; } }
      if (bl) keep.add(bl);
    }
    for (let k = 0; k < SW * SH; k++) open[k] = keep.has(comp[k]) ? 1 : 0;
    for (let k = 0; k < SW * SH; k++) dist[k] = open[k] ? INF : 0;
    for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
      const k = j * SW + i; let d = dist[k]; if (!d) continue;
      if (i > 0) d = Math.min(d, dist[k - 1] + D1);
      if (j > 0) { d = Math.min(d, dist[k - SW] + D1); if (i > 0) d = Math.min(d, dist[k - SW - 1] + D2); if (i < SW - 1) d = Math.min(d, dist[k - SW + 1] + D2); }
      dist[k] = d;
    }
    for (let j = SH - 1; j >= 0; j--) for (let i = SW - 1; i >= 0; i--) {
      const k = j * SW + i; let d = dist[k]; if (!d) continue;
      if (i < SW - 1) d = Math.min(d, dist[k + 1] + D1);
      if (j < SH - 1) { d = Math.min(d, dist[k + SW] + D1); if (i < SW - 1) d = Math.min(d, dist[k + SW + 1] + D2); if (i > 0) d = Math.min(d, dist[k + SW - 1] + D2); }
      dist[k] = d;
    }
    for (let k = 0; k < SW * SH; k++) {
      // distance from the cell centre to the wall face ~ d - dx/2
      maskData[k * 4] = Math.round(Math.min(1, Math.max(0, dist[k] - dx * 0.5) / 8) * 255);
      maskData[k * 4 + 1] = open[k] ? 255 : 0;
      maskData[k * 4 + 3] = 255;
    }
    maskTex.needsUpdate = true;
  }
  rebuildMask();

  /* waterline scan: every triangle that crosses the water plane marks a wall cell (quay, island, piles, hulls, torii) */
  const scanned = new WeakSet(), queue = [], spireSet = []; let cur = null, curTri = 0, maskDirty = false, maskTimer = 0;
  const box = new THREE.Box3();
  function enqueue() {
    for (const m of ctx.park.children) {
      if (!m.isMesh || scanned.has(m)) continue; scanned.add(m);
      const g = m.geometry; if (!g.boundingBox) continue;
      box.copy(g.boundingBox).applyMatrix4(m.matrix);          // matrixWorld is not updated until the next render
      if (box.min.x <= 0 && box.max.x >= 0 && box.min.z <= 0 && box.max.z >= 0 && box.max.y > 5 && !ctx.landMeshes.includes(m)) { m.layers.enable(1); spireSet.push(m); }   // the Spire + island
      if (box.min.y > W0 + 0.02 || box.max.y < W0 - 0.02 || box.max.x < X0 || box.min.x > X1 || box.max.z < Z0 || box.min.z > Z1) continue;
      queue.push(m);
    }
  }
  function mark(x, z) { const i = Math.floor((x - X0) / dx), j = Math.floor((z - Z0) / dx); if (i >= 0 && j >= 0 && i < SW && j < SH) wall[j * SW + i] = 1; }
  function scanStep(budget) {
    let n = 0;
    while (n < budget) {
      if (!cur) { cur = queue.shift(); curTri = 0; if (!cur) return; }
      const g = cur.geometry, p = g.attributes.position.array, idx = g.index.array, T = idx.length / 3;
      const o = cur.position, s = cur.scale.x, qw = (W0 - o.y) / s, flat = 0.04 / s;
      // a core paving sheet at y = 0 runs over the Brinewatch basin in the export: drop those triangles (pools only)
      const cover = extra.length && !ctx.landMeshes.includes(cur), cy0 = 0.6 / s, cy1 = 1.0 / s;
      const end = Math.min(T, curTri + (budget - n));
      for (let t = curTri; t < end; t++) {
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        const ya = p[a + 1] - qw, yb = p[b + 1] - qw, yc = p[c + 1] - qw;
        if (cover && ya > cy0 && ya < cy1 && Math.abs(ya - yb) < flat && Math.abs(ya - yc) < flat) {
          const x = o.x + s * (p[a] + p[b] + p[c]) / 3, z = o.z + s * (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
          if (extra.some((pl) => inPoly(pl, x, -z))) { idx[t * 3 + 1] = idx[t * 3 + 2] = idx[t * 3]; g.index.needsUpdate = true; continue; }
        }
        if ((ya > 0 && yb > 0 && yc > 0) || (ya < 0 && yb < 0 && yc < 0)) continue;
        if (Math.max(Math.abs(ya), Math.abs(yb), Math.abs(yc)) < flat) continue;      // lies in the plane (a baked water surface)
        // the two edge crossings
        const pts = []; const E = [[a, ya, b, yb], [b, yb, c, yc], [c, yc, a, ya]];
        for (const [i0, y0, i1, y1] of E) {
          if ((y0 <= 0) !== (y1 <= 0)) { const f = y0 / (y0 - y1); pts.push(o.x + s * (p[i0] + f * (p[i1] - p[i0])), o.z + s * (p[i0 + 2] + f * (p[i1 + 2] - p[i0 + 2]))); }
        }
        if (pts.length < 4) { if (pts.length === 2) mark(pts[0], pts[1]); continue; }
        const L = Math.hypot(pts[2] - pts[0], pts[3] - pts[1]), steps = Math.max(1, Math.ceil(L / (dx * 0.5)));
        for (let k = 0; k <= steps; k++) { const f = k / steps; mark(pts[0] + f * (pts[2] - pts[0]), pts[1] + f * (pts[3] - pts[1])); }
      }
      n += end - curTri; curTri = end; maskDirty = true;
      if (curTri >= T) cur = null;
    }
  }

  /* lake geometry (a little skirt so the edge tucks under the quay) */
  const geo = new THREE.ShapeGeometry(polys.map((pl) => new THREE.Shape(pl.map(([x, y]) => new THREE.Vector2(x, y)))));
  geo.clearGroups();                              // one material for every pool

  /* ───────── mirror ───────── */
  const mirror = {
    rt: null, w: 0, h: 0, mat: new THREE.Matrix4(), rectMax: new THREE.Vector2(1, 1), valid: false, frame: 0,
    cam: new THREE.PerspectiveCamera(),
  };
  mirror.cam.matrixAutoUpdate = false;
  function ensureRT() {
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    const sc = tier() >= 2 ? Q.mirrorScale : Q.mirrorScaleLow, w = Math.max(64, Math.round(db.x * sc)), h = Math.max(64, Math.round(db.y * sc));
    if (mirror.rt && mirror.w === w && mirror.h === h) return;
    if (mirror.rt) mirror.rt.dispose();
    mirror.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 });
    mirror.rt.texture.minFilter = THREE.LinearFilter; mirror.rt.texture.generateMipmaps = false;
    mirror.w = w; mirror.h = h; mirror.valid = false;
    if (mat) mat.uniforms.tMirror.value = mirror.rt.texture;
  }
  const _v = new THREE.Vector3(), _v4 = new THREE.Vector4(), _m = new THREE.Matrix4(), _q = new THREE.Vector4(), _c = new THREE.Vector4();
  const _col = new THREE.Color(), _plane = new THREE.Plane(), _n = new THREE.Vector3(0, 1, 0), _inv = new THREE.Matrix4();
  const lakePts = lake.map(([x, y]) => new THREE.Vector3(x, W0, -y));
  const extraPts = extra.map((pl) => pl.map(([x, y]) => new THREE.Vector3(x, W0, -y)));
  const savedRanges = new Map();

  // NDC rectangle of the lake as seen by `cam` (polygon clipped to the near plane in view space)
  function lakeRect(view, proj, near) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
    const zc = -near * 1.001;
    const emit = (p) => { _v4.set(p.x, p.y, p.z, 1).applyMatrix4(proj); const x = _v4.x / _v4.w, y = _v4.y / _v4.w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); any = true; };
    for (const pts of [lakePts, ...extraPts]) {
      const vp = pts.map((p) => _v.copy(p).applyMatrix4(view).clone());
      for (let k = 0; k < vp.length; k++) {
        const a = vp[k], b = vp[(k + 1) % vp.length], ina = a.z <= zc, inb = b.z <= zc;
        if (ina) emit(a);
        if (ina !== inb) { const f = (zc - a.z) / (b.z - a.z); emit(new THREE.Vector3().lerpVectors(a, b, f)); }
      }
    }
    if (!any) return null;
    const m = 0.06;
    x0 = Math.max(-1, x0 - m); x1 = Math.min(1, x1 + m); y0 = Math.max(-1, y0 - m); y1 = Math.min(1, y1 + m);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, x1, y0, y1];
  }

  // Oblique near plane (Lengyel), for the standard [-1,1] and the reversed [1,0] depth conventions.
  function obliqueClip(P, planeView, reversed) {
    const e = P.elements;
    _inv.copy(P).invert();
    _c.set(planeView.normal.x, planeView.normal.y, planeView.normal.z, planeView.constant);
    // far corner of the frustum opposite the plane, in view space
    _q.set(Math.sign(_c.x), Math.sign(_c.y), reversed ? 0 : 1, 1).applyMatrix4(_inv);
    const r4 = [e[3], e[7], e[11], e[15]];
    const r4q = r4[0] * _q.x + r4[1] * _q.y + r4[2] * _q.z + r4[3] * _q.w, cq = _c.dot(_q);
    if (!reversed) { const a = 2 * r4q / cq; e[2] = a * _c.x - r4[0]; e[6] = a * _c.y - r4[1]; e[10] = a * _c.z - r4[2]; e[14] = a * _c.w - r4[3]; }
    else { const a = r4q / cq; e[2] = r4[0] - a * _c.x; e[6] = r4[1] - a * _c.y; e[10] = r4[2] - a * _c.z; e[14] = r4[3] - a * _c.w; }
  }

  function renderMirror(overlay) {
    const cam = camera;
    if (cam.position.y <= W0 + 0.05) { mirror.valid = false; return; }
    ensureRT();
    const mc = mirror.cam;
    // mirrored camera: proper rotation (reflected position / target / up), as in Water.js / Reflector.js
    cam.updateMatrixWorld();
    const pos = _v.setFromMatrixPosition(cam.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld), up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorld);
    const mp = new THREE.Vector3(pos.x, 2 * W0 - pos.y, pos.z);
    mc.position.copy(mp); mc.up.set(up.x, -up.y, up.z);
    mc.lookAt(mp.x + fwd.x, mp.y - fwd.y, mp.z + fwd.z);
    mc.updateMatrix(); mc.updateMatrixWorld(true); mc.matrixWorldInverse.copy(mc.matrixWorld).invert();
    const reversed = !!(renderer.state.buffers.depth.getReversed && renderer.state.buffers.depth.getReversed());
    mc._reversedDepth = reversed || cam.reversedDepth;            // or the renderer would rebuild (and lose) our projection
    mc.near = cam.near; mc.far = cam.far;
    if (overlay) mc.layers.set(1); else mc.layers.set(0);
    const rect = lakeRect(mc.matrixWorldInverse, cam.projectionMatrix, cam.near);
    if (!rect) { mirror.valid = false; return; }
    const [x0, x1, y0, y1] = rect, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
    // crop the projection to the lake rectangle; render into a sub-viewport with the same pixel aspect
    const k = Math.min(1 / Math.max(hx, hy), Q.mirrorBoost);
    const vw = Math.max(16, Math.round(mirror.w * hx * k)), vh = Math.max(16, Math.round(mirror.h * hy * k));
    _m.set(1 / hx, 0, 0, -cx / hx, 0, 1 / hy, 0, -cy / hy, 0, 0, 1, 0, 0, 0, 0, 1);
    mc.projectionMatrix.multiplyMatrices(_m, cam.projectionMatrix);
    // texture matrix (before the oblique change: x, y, w rows are not affected by it)
    mirror.mat.set(0.5 * vw / mirror.w, 0, 0, 0.5 * vw / mirror.w, 0, 0.5 * vh / mirror.h, 0, 0.5 * vh / mirror.h, 0, 0, 1, 0, 0, 0, 0, 1)
      .multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
    mirror.rectMax.set((vw - 0.75) / mirror.w, (vh - 0.75) / mirror.h);
    _plane.setFromNormalAndCoplanarPoint(_n, _v.set(0, W0, 0)).applyMatrix4(mc.matrixWorldInverse);
    obliqueClip(mc.projectionMatrix, _plane, mc._reversedDepth);
    mc.projectionMatrixInverse.copy(mc.projectionMatrix).invert();

    // what goes into the mirror
    const hide = [];
    const hideAll = (list) => { for (const m of list) if (m.visible) { m.visible = false; hide.push(m); } };
    hideAll(ctx.farMeshes); hideAll(ctx.forest);
    if (Q.mirrorLite) hideAll(ctx.landMeshes);
    hideAll([waterMesh, spriteRefl, boat.glowRefl].filter(Boolean));
    // coarse LOD for the smaller mirror image
    const scale = vh * 0.5 * mc.projectionMatrix.elements[5] / (1.35 * Q.lod * Q.mirrorLod);
    const d2 = 0.22 * scale, d1 = 0.6 * scale;
    for (const e of ctx.lodMeshes) {
      const g = e.mesh.geometry; savedRanges.set(g, g.drawRange.count);
      const d = Math.max(0, mp.distanceTo(e.c) - e.r);
      g.setDrawRange(0, d > d1 ? e.m.n0 : d > d2 ? e.m.n1 : e.m.ni);
    }
    const L = ctx.getLanterns();
    let lob = null;
    if (L) { lob = L.onBeforeRender; L.onBeforeRender = (r, s, c) => { L.material.uniforms.uScale.value = vh * 0.5 * c.projectionMatrix.elements[5]; }; }

    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevXR = renderer.xr.enabled;
    const pcc = renderer.getClearColor(_col), pca = renderer.getClearAlpha();
    if (overlay) renderer.setClearColor(0x000000, 0);
    mirror.rt.viewport.set(0, 0, vw, vh); mirror.rt.scissor.set(0, 0, vw, vh); mirror.rt.scissorTest = true;
    renderer.xr.enabled = false; renderer.autoClear = true;
    renderer.setRenderTarget(mirror.rt);
    renderer.state.buffers.depth.setMask(true);
    renderer.render(scene, mc);
    renderer.setRenderTarget(prevRT); renderer.autoClear = prevAuto; renderer.xr.enabled = prevXR;
    if (overlay) renderer.setClearColor(pcc, pca);

    if (L) L.onBeforeRender = lob;
    for (const e of ctx.lodMeshes) { const g = e.mesh.geometry; g.setDrawRange(0, savedRanges.get(g)); }
    for (const m of hide) m.visible = true;
    mat.uniforms.uTexMat.value.copy(mirror.mat); mat.uniforms.uRectMax.value.copy(mirror.rectMax);
    mirror.valid = true;
  }

  /* ───────── height-field simulation ───────── */
  const sim = { on: canSim && Q.waterSim > 0, a: null, b: null, t: 0, acc: 0, events: [] };
  const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const stepMat = new THREE.ShaderMaterial({
    uniforms: { tState: { value: null }, tMask: { value: maskTex }, uTexel: { value: new THREE.Vector2(1 / SW, 1 / SH) }, uK: { value: 0 }, uDamp: { value: 0.985 } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tState, tMask; uniform vec2 uTexel; uniform float uK, uDamp;
      float nb(vec2 uv, float h){ float m = texture2D(tMask, uv).g; return mix(h, texture2D(tState, uv).r, step(0.5, m)); }  // walls reflect (Neumann)
      void main(){
        vec2 uv = gl_FragCoord.xy * uTexel;
        vec4 s = texture2D(tState, uv); float h = s.r, hp = s.g;
        float lap = nb(uv + vec2(uTexel.x, 0.0), h) + nb(uv - vec2(uTexel.x, 0.0), h) + nb(uv + vec2(0.0, uTexel.y), h) + nb(uv - vec2(0.0, uTexel.y), h) - 4.0 * h;
        float hn = (h + (h - hp) * uDamp + uK * lap) * 0.9992;
        hn *= step(0.5, texture2D(tMask, uv).g);
        gl_FragColor = vec4(hn, h, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quadScene = new THREE.Scene(); const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stepMat); quad.frustumCulled = false; quadScene.add(quad);
  const splatScene = new THREE.Scene();
  const splatBlend = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation, depthTest: false, depthWrite: false, transparent: true };
  // event splats (taps, the punt's hull)
  const MAXEV = 64, evPos = new Float32Array(MAXEV * 3), evAmp = new Float32Array(MAXEV * 2);
  const evGeo = new THREE.BufferGeometry();
  evGeo.setAttribute('position', new THREE.BufferAttribute(evPos, 3)); evGeo.setAttribute('aAR', new THREE.BufferAttribute(evAmp, 2));
  const SPLAT_VS = /* glsl */`
    uniform vec4 uDom; uniform float uCell;
    vec4 simClip(vec3 p){ vec2 uv = (p.xz - uDom.xy) * uDom.zw; return vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
  const SPLAT_FS = /* glsl */`
    varying float vAmp;
    void main(){ vec2 q = gl_PointCoord - 0.5; float d2 = dot(q, q) * 4.0; if (d2 > 1.0) discard;
      gl_FragColor = vec4(vAmp * (1.0 - d2) * (1.0 - d2), 0.0, 0.0, 0.0); }`;
  const evMat = new THREE.ShaderMaterial({
    uniforms: { uDom: { value: dom }, uCell: { value: dx } },
    vertexShader: SPLAT_VS + /* glsl */`
      attribute vec2 aAR; varying float vAmp;
      void main(){ gl_Position = simClip(position); gl_PointSize = max(1.0, 2.0 * aAR.y / uCell); vAmp = aAR.x; }`,
    fragmentShader: SPLAT_FS, ...splatBlend,
  });
  const evPts = new THREE.Points(evGeo, evMat); evPts.frustumCulled = false; splatScene.add(evPts);
  // floating lanterns: each bobs, and now and then gets nudged (or a new one "lands") and sends out a ring
  let lanternSplat = null;
  function buildLanternSplat(L) {
    const src = L.geometry.attributes.position, ib = src.data.array, stride = src.data.stride, pts = [];
    for (let i = 0; i < src.count; i++) { const y = ib[i * stride + 1]; if (y < W0 + 0.6) pts.push(ib[i * stride], y, ib[i * stride + 2]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const m = new THREE.ShaderMaterial({
      uniforms: { uDom: { value: dom }, uCell: { value: dx }, uT: { value: 0 }, uDt: { value: 1 / 60 }, uWater: { value: W0 }, uAmp: { value: 1 } },
      vertexShader: SPLAT_VS + DRIFT + /* glsl */`
        uniform float uT, uDt, uWater, uAmp; varying float vAmp;
        void main(){
          float ph; vec3 p = lanternDrift(position, uT, uWater, ph);
          gl_Position = simClip(p); gl_PointSize = max(1.0, 2.0 * 0.75 / uCell);
          float per = 9.0 + 14.0 * fract(ph * 7.31), tau = mod(uT + ph * 3.7, per);
          float pulse = tau < 0.35 ? sin(tau / 0.35 * 3.14159) : 0.0;
          float big = step(0.86, fract(floor((uT + ph * 3.7) / per) * 0.618 + ph));   // an occasional bigger "landing" ring
          vAmp = uAmp * uDt * (-0.10 * pulse * (1.0 + 2.5 * big) + 0.012 * cos(uT * 1.9 + ph * 3.0));
        }`,
      fragmentShader: SPLAT_FS, ...splatBlend,
    });
    lanternSplat = new THREE.Points(g, m); lanternSplat.frustumCulled = false; splatScene.add(lanternSplat);
  }
  function simAlloc() {
    sim.a = new THREE.WebGLRenderTarget(SW, SH, rtOpts); sim.b = new THREE.WebGLRenderTarget(SW, SH, rtOpts);
    const prev = renderer.getRenderTarget(), pc = renderer.getClearColor(new THREE.Color()), pa = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [sim.a, sim.b]) { renderer.setRenderTarget(t); renderer.clear(true, false, false); }
    renderer.setRenderTarget(prev); renderer.setClearColor(pc, pa);
  }
  function simStep(h) {
    const c = 1.7;                                             // wave speed, m/s
    stepMat.uniforms.uK.value = Math.min(0.45, (c * h / dx) ** 2);
    stepMat.uniforms.uDamp.value = Math.pow(0.55, h);          // velocity keeps 55 % per second
    stepMat.uniforms.tState.value = sim.a.texture;
    renderer.setRenderTarget(sim.b); renderer.render(quadScene, quadCam);
    // splats
    let n = 0;
    for (const e of sim.events) { if (n >= MAXEV) break; evPos.set([e.x, W0, e.z], n * 3); evAmp[n * 2] = e.amp * (e.cont ? h : 1); evAmp[n * 2 + 1] = e.r; n++; }
    sim.events = sim.events.filter((e) => e.cont);           // continuous sources stay for this frame's other steps
    evGeo.setDrawRange(0, n); evGeo.attributes.position.needsUpdate = true; evGeo.attributes.aAR.needsUpdate = true;
    evPts.visible = n > 0;
    if (lanternSplat) { const u = lanternSplat.material.uniforms; u.uT.value = sim.t; u.uDt.value = h; }
    renderer.render(splatScene, quadCam);
    const t = sim.a; sim.a = sim.b; sim.b = t;
    sim.t += h;
  }
  function simUpdate(dt) {
    if (!sim.on) return;
    if (!sim.a) simAlloc();
    const h = Q.waterSimHz >= 60 ? 1 / 60 : 1 / 30;
    sim.acc = Math.min(sim.acc + dt, h * 3);
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    let steps = 0;
    while (sim.acc >= h && steps < 2) { simStep(h); sim.acc -= h; steps++; }
    renderer.autoClear = prevAuto; renderer.setRenderTarget(prevRT);
    sim.events.length = 0;
    mat.uniforms.tSim.value = sim.a.texture;
  }
  function splash(x, z, amp = -0.05, r = 1.0) { sim.events.push({ x, z, amp, r, cont: false }); }

  /* ───────── water material ───────── */
  const ripple = rippleTexture(), noise = noiseTexture();
  const mat = new THREE.ShaderMaterial({
    defines: { TAPS: Q.waterGloss },
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,      // wins over baked surfaces at the same level (the basin)
    uniforms: {
      tMirror: { value: null }, uTexMat: { value: new THREE.Matrix4() }, uRectMax: { value: new THREE.Vector2(1, 1) }, uMirror: { value: 0 },
      tSim: { value: null }, uSimOn: { value: 0 }, tMask: { value: maskTex }, tRipple: { value: ripple }, tNoise: { value: noise },
      uDom: { value: dom }, uSimTexel: { value: new THREE.Vector2(1 / SW, 1 / SH) }, uCell: { value: dx },
      uTime: uTime, uMoon: { value: MOON }, uFog: { value: FOG }, uFogD: { value: 2.4e-7 }, uD: { value: 45 },
      uWind: { value: 1 }, uRough: { value: 1 },
      tEnv: { value: null }, uEnvOn: { value: 0 }, uEnvC: { value: new THREE.Vector3(0, ENV_Y, 0) }, uEnvAB: { value: new THREE.Vector2(ENV_A, ENV_B) },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D tMirror, tSim, tMask, tRipple, tNoise;
      uniform mat4 uTexMat; uniform vec2 uRectMax, uSimTexel; uniform vec4 uDom;
      uniform float uMirror, uSimOn, uTime, uFogD, uD, uWind, uRough, uCell; uniform vec3 uMoon, uFog;
      uniform samplerCube tEnv; uniform float uEnvOn; uniform vec3 uEnvC; uniform vec2 uEnvAB;
      // static capture of the lands from the middle of the lake, parallax-corrected against an elliptic cylinder
      vec3 envRefl(vec3 P, vec3 R){
        vec2 p = P.xz / uEnvAB, d = R.xz / uEnvAB;
        float a = dot(d, d), b = dot(p, d), c = dot(p, p) - 1.0;
        float t = (-b + sqrt(max(b * b - a * c, 0.0))) / max(a, 1e-6);
        return textureCube(tEnv, P + R * min(t, 4000.0) - uEnvC).rgb;
      }
      varying vec3 vW;
      ${SKY}
      vec2 mirrorUV(vec3 x){ vec4 c = uTexMat * vec4(x, 1.0); return clamp(c.xy / max(c.w, 1e-4), vec2(0.0), uRectMax); }
      void main(){
        vec3 toCam = cameraPosition - vW; float dist = length(toCam); vec3 V = toCam / dist;
        vec2 suv = (vW.xz - uDom.xy) * uDom.zw;
        vec4 mk = texture2D(tMask, suv); float shore = mk.r * 8.0;
        float t = uTime;
        // calm and ruffled patches drifting with the breeze
        float n1 = texture2D(tNoise, vW.xz * 0.0045 + t * vec2(0.0021, 0.0009)).r;
        float n2 = texture2D(tNoise, vW.xz * 0.013 + t * vec2(-0.0012, 0.0026)).r;
        float wind = smoothstep(0.47, 0.82, n1 * 0.75 + n2 * 0.4) * uWind;
        wind *= smoothstep(0.3, 5.0, shore) * 0.7 + 0.3;
        float rough = mix(0.06, 1.0, wind);
        // fine wind ripples, faded with distance (mip-averaging would only flatten them; the glossy blur keeps the roughness)
        float fade = 1.0 / (1.0 + dist * 0.012);
        vec2 r1 = texture2D(tRipple, vW.xz / 7.0 + t * vec2(0.035, 0.012)).xy * 2.0 - 1.0;
        vec2 r2 = texture2D(tRipple, vW.xz / 2.6 + t * vec2(-0.05, 0.041)).xy * 2.0 - 1.0;
        vec2 slope = (r1 * 0.65 + r2 * 0.35) * rough * 0.04 * fade;
        // long, very low swell
        vec2 d1 = vec2(0.80, 0.60), d2 = vec2(-0.45, 0.89), d3 = vec2(0.96, -0.28);
        slope += d1 * 0.0035 * cos(dot(d1, vW.xz) * 0.157 - t * 1.24);
        slope += d2 * 0.0030 * cos(dot(d2, vW.xz) * 0.273 - t * 1.63 + 1.7);
        slope += d3 * 0.0022 * cos(dot(d3, vW.xz) * 0.483 - t * 2.17 + 4.1);
        // interactive height field
        float hs = 0.0;
        if (uSimOn > 0.5) {
          hs = texture2D(tSim, suv).r;
          float hx = texture2D(tSim, suv + vec2(uSimTexel.x, 0.0)).r - texture2D(tSim, suv - vec2(uSimTexel.x, 0.0)).r;
          float hz = texture2D(tSim, suv + vec2(0.0, uSimTexel.y)).r - texture2D(tSim, suv - vec2(0.0, uSimTexel.y)).r;
          slope += vec2(hx, hz) / (2.0 * uCell);
        }
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        float NV = max(dot(N, V), 0.0);
        float F = 0.02 + 0.98 * pow(1.0 - NV, 5.0);
        vec3 R = reflect(-V, N); R.y = max(R.y, 0.004); R = normalize(R);
        vec3 refl;
        // glossy spread of the reflection: tilt the normal along the view direction by the local roughness
        float sig = (0.004 + 0.022 * rough) * uRough;
        vec2 fh = normalize(-V.xz + vec2(1e-5));
        vec3 Ra = normalize(reflect(-V, normalize(N + vec3(fh.x, 0.0, fh.y) * sig)));
        vec3 Rb = normalize(reflect(-V, normalize(N - vec3(fh.x, 0.0, fh.y) * sig)));
        Ra.y = max(Ra.y, 0.004); Rb.y = max(Rb.y, 0.004);
        vec4 mir = vec4(0.0);
        if (uMirror > 0.5) {
          vec2 ua = mirrorUV(vW + Ra * uD), ub = mirrorUV(vW + Rb * uD), uc = mirrorUV(vW + R * uD);
          vec4 acc = texture2D(tMirror, uc) * 2.0; float wsum = 2.0;
          for (int i = 0; i < TAPS; i++) {
            float f = (float(i) + 0.5) / float(TAPS);
            float w = 1.0 - abs(f - 0.5) * 1.4;
            acc += texture2D(tMirror, mix(ua, ub, f)) * w; wsum += w;
          }
          mir = acc / wsum;
        }
        if (uMirror > 0.5 && uMirror < 1.5) refl = mir.rgb;
        else {
          vec3 bg;
          if (uEnvOn > 0.5) bg = (envRefl(vW, R) * 2.0 + envRefl(vW, Ra) + envRefl(vW, Rb)) * 0.25;
          else bg = (skyCol(R, uMoon) * 2.0 + skyCol(Ra, uMoon) + skyCol(Rb, uMoon)) * 0.25;
          refl = bg * (1.0 - clamp(mir.a, 0.0, 1.0)) + mir.rgb;     // overlay: the Spire layer over the captured lands
        }
        // moon glitter: sharp glints on ruffled water plus a soft path
        float md = max(dot(R, uMoon), 0.0);
        float glit = pow(md, 2400.0) * (0.04 + rough) * 6.0 + pow(md, 120.0) * 0.006 * (0.2 + rough);
        // body colour: black in open water, a faint peaty tint where it is shallow by the quay
        float shallow = 1.0 - smoothstep(0.4, 7.0, shore);
        vec3 body = mix(vec3(0.0010, 0.0014, 0.0030), vec3(0.0060, 0.0070, 0.0062), shallow);
        vec3 col = body * (1.0 - F) + refl * F + vec3(0.62, 0.70, 0.95) * glit * F * 3.0;
        // contact line: damp darkening against walls, a thin lift where ripples break on them
        float contact = 1.0 - smoothstep(0.0, 0.55, shore);
        col *= 1.0 - 0.55 * contact;
        col += vec3(0.010, 0.011, 0.014) * smoothstep(0.35, 0.0, shore) * (0.6 + clamp(abs(hs) * 60.0, 0.0, 2.0)) * smoothstep(0.0, 0.08, shore);
        float fogf = 1.0 - exp(-dist * dist * uFogD);
        gl_FragColor = vec4(mix(col, uFog, fogf), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const waterMesh = new THREE.Mesh(geo, mat);
  waterMesh.rotation.x = -Math.PI / 2; waterMesh.position.y = W0; waterMesh.renderOrder = 1;   // after the opaque park: lets the sprites depth-test against it
  scene.add(waterMesh);

  /* ───────── static environment capture for the no-mirror tier (5 cube faces, one per frame, once the park is in) ───────── */
  const env = { rt: null, cam: null, face: -1, done: false, parts: -1 };
  function envStep() {
    if (!Q.waterEnv) return;
    const n = ctx.park.children.length;
    if (env.face < 0) {                                      // (re)start once loading has finished, or the park grew since
      if (!ctx.isLoaded() || n === env.parts) return;
      env.parts = n; env.face = 0;
      if (!env.rt) {
        env.rt = new THREE.WebGLCubeRenderTarget(Q.waterEnvSize, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter });
        env.cam = new THREE.CubeCamera(ENV_NEAR, 3000, env.rt); env.cam.position.set(0, ENV_Y, 0); env.cam.updateMatrixWorld(true);
      }
    }
    const faces = [0, 1, 2, 4, 5];                             // +x -x +y +z -z (never -y)
    const cams = env.cam.children, f = faces[env.face];
    if (env.cam.coordinateSystem !== renderer.coordinateSystem) { env.cam.coordinateSystem = renderer.coordinateSystem; env.cam.updateCoordinateSystem(); env.cam.updateMatrixWorld(true); }
    const hide = [];
    for (const o of [waterMesh, spriteRefl, ctx.getLanterns(), boat.grp, ...spireSet]) if (o && o.visible) { o.visible = false; hide.push(o); }
    const prev = renderer.getRenderTarget(), pa = renderer.autoClear; renderer.autoClear = true;
    renderer.setRenderTarget(env.rt, f); renderer.render(scene, cams[f]);
    renderer.setRenderTarget(prev); renderer.autoClear = pa;
    for (const o of hide) o.visible = true;
    if (++env.face >= faces.length) { env.face = -1; env.done = true; mat.uniforms.tEnv.value = env.rt.texture; mat.uniforms.uEnvOn.value = 1; }
  }

  /* ───────── reflected lantern sprites (no-mirror tier) ───────── */
  let spriteRefl = null;
  function buildSpriteRefl(L) {
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime, uScale: { value: 500 }, uWater: { value: W0 }, tMask: { value: maskTex }, uDom: { value: dom }, uStretch: { value: 2.6 } },
      vertexShader: DRIFT + /* glsl */`
        attribute vec3 aCol; attribute vec2 aPar; uniform float uTime, uScale, uWater, uStretch; uniform sampler2D tMask; uniform vec4 uDom;
        varying vec3 vCol; varying float vStr;
        void main(){
          float ph; vec3 p = lanternDrift(position, uTime, uWater, ph);
          vec3 m = vec3(p.x, 2.0 * uWater - p.y, p.z);              // mirror image below the plane
          vec3 c = cameraPosition;
          float t = (c.y - uWater) / max(c.y - m.y, 1e-3);
          vec3 s = c + (m - c) * (t * 0.997);                       // where the reflected ray meets the water (pulled a hair toward the eye)
          vec4 mk = texture2D(tMask, (s.xz - uDom.xy) * uDom.zw);
          vec4 mvm = viewMatrix * vec4(m, 1.0);
          vec4 mv = viewMatrix * vec4(s, 1.0); gl_Position = projectionMatrix * mv;
          float dm = max(-mvm.z, 0.1);
          float px = aPar.y * 1.4 * uScale / dm;
          float sz = clamp(px, 2.0, 40.0);
          float flick = 0.86 + 0.14 * sin(uTime * (2.0 + fract(ph * 3.3) * 3.0) + ph * 9.0);
          vec3 V = normalize(c - s); float F = 0.02 + 0.98 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
          float ok = step(0.5, mk.g) * step(0.0, c.y - uWater) * step(p.y, 200.0) * step(uWater + 0.25, p.y);
          vCol = aCol * aPar.x * flick * min(1.0, (px * px) / (sz * sz) * 2.0 + 0.10) * mix(0.34, 0.13, smoothstep(3.0, 22.0, px)) * smoothstep(1.2, 6.0, dm) * F * ok;
          float st = 1.0 + uStretch * smoothstep(0.6, 0.05, V.y);  // longer streaks at grazing angles
          vStr = st; gl_PointSize = ok > 0.0 ? min(sz * st, 64.0) : 0.0;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol; varying float vStr;
        void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q * vec2(1.25 * vStr, 1.0));
          float a = smoothstep(0.5, 0.15, d); if (a < 0.01) discard;
          gl_FragColor = vec4(vCol * a * (0.8 + 0.8 * smoothstep(0.3, 0.0, d)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
    });
    spriteRefl = new THREE.Points(L.geometry, m); spriteRefl.renderOrder = 7; spriteRefl.frustumCulled = false;
    spriteRefl.onBeforeRender = (r, s, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; m.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
    scene.add(spriteRefl);
  }

  /* ───────── lantern punt: a slow boat with a lamp, gliding round the island and leaving a wake ───────── */
  const boat = { grp: null, glowRefl: null, s: 0 };
  function buildBoat() {
    if (!Q.waterBoat) return;
    const grp = new THREE.Group();
    // hull: a lofted punt, dark lacquered wood with a warm lamp-lit sheen on the inboard side
    const L = 4.2, Wd = 1.15, Hh = 0.55, segs = 10, pos = [], col = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const u = i / segs, x = (u - 0.5) * L, taper = Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + u * 0.88)), 0.55), w = Wd / 2 * taper;
      const rise = 0.18 * Math.pow(Math.abs(u - 0.5) * 2, 3);
      const ring = [[x, rise + Hh, -w], [x, 0.02 + rise * 0.5, -w * 0.82], [x, 0.02 + rise * 0.5, w * 0.82], [x, rise + Hh, w]];
      for (const p of ring) pos.push(...p);
      const lit = 0.5 + 0.5 * u;
      col.push(0.035 * lit, 0.018 * lit, 0.009 * lit, 0.012, 0.007, 0.004, 0.02 * lit, 0.011 * lit, 0.006 * lit, 0.05 * lit, 0.026 * lit, 0.012 * lit);
    }
    for (let i = 0; i < segs; i++) for (let k = 0; k < 3; k++) { const a = i * 4 + k, b = a + 4; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const hull = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    grp.add(hull);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5), new THREE.MeshBasicMaterial({ color: 0x1a0f08 }));
    pole.position.set(1.6, 1.3, 0); grp.add(pole);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6.0, 3.2, 1.1) }));
    lamp.position.set(1.6, 2.15, 0); lamp.scale.y = 1.3; grp.add(lamp);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ color: new THREE.Color(1.2, 0.62, 0.22), map: haloTex(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.scale.setScalar(2.4); halo.position.copy(lamp.position); halo.renderOrder = 8; grp.add(halo);
    grp.traverse((o) => o.layers.enable(1)); boat.grp = grp; scene.add(grp);
  }
  function haloTex() {
    const N = 64, d = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const r = Math.hypot(i - N / 2 + 0.5, j - N / 2 + 0.5) / (N / 2); const v = Math.max(0, Math.exp(-r * r * 6) - 0.0025); d.set([255, 255, 255, Math.round(v * 255)], (j * N + i) * 4); }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.needsUpdate = true; t.magFilter = t.minFilter = THREE.LinearFilter; return t;
  }
  // path: a slow loop between the island and the quay (Blender-frame ellipse, checked against the wall mask)
  const BA = 46, BB = 40, BCX = -12, BCY = 2, BSPEED = 1.15;
  function boatAt(s, out) {
    const per = 2 * Math.PI * Math.sqrt((BA * BA + BB * BB) / 2), a = (s / per) * 2 * Math.PI;
    const x = BA * Math.cos(a) + BCX, y = BB * Math.sin(a) + BCY;
    out.set(x, W0, -y); return Math.atan2(-BB * Math.cos(a), -BA * Math.sin(a));   // heading in three's xz
  }
  const _bp = new THREE.Vector3();
  function boatUpdate(dt, time) {
    if (!boat.grp) return;
    boat.s += dt * BSPEED;
    const hd = boatAt(boat.s, _bp);
    const bob = Math.sin(time * 1.3) * 0.035, roll = Math.sin(time * 0.9 + 1) * 0.025, pitch = Math.sin(time * 1.1) * 0.018;
    boat.grp.position.set(_bp.x, W0 - 0.18 + bob, _bp.z);
    boat.grp.rotation.set(roll, -hd, pitch, 'YXZ');
    if (sim.on) {
      const c = Math.cos(hd), s = Math.sin(hd);
      // the hull pushes water aside: bow and quarters, scaled by speed; a moving source draws its own V wake
      for (const [f, amp, r] of [[1.9, -0.11, 0.75], [0.8, -0.06, 0.9], [-0.6, -0.04, 0.9], [-1.9, 0.04, 0.7]]) sim.events.push({ x: _bp.x + c * f, z: _bp.z + s * f, amp: amp * BSPEED, r, cont: true });
    }
  }

  /* ───────── taps on the water ───────── */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3(), wplane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -W0);
  let down = null;
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; }, { passive: true });
  el.addEventListener('pointerup', (e) => {
    if (!down || !sim.on || !Q.waterTap) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dtm = performance.now() - down.t; down = null;
    if (moved > 8 || dtm > 450 || ctx.getMode() === 'tour') return;
    const r = el.getBoundingClientRect();
    tapAt((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }, { passive: true });
  function tapAt(nx, ny) {
    ndc.set(nx, ny); ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(wplane, hit)) return false;
    const i = Math.floor((hit.x - X0) / dx), j = Math.floor((hit.z - Z0) / dx);
    if (i < 0 || j < 0 || i >= SW || j >= SH || !water[j * SW + i] || wall[j * SW + i]) return false;
    splash(hit.x, hit.z, -0.14, 1.0);
    return true;
  }

  /* ───────── GPU timing (EXT_disjoint_timer_query_webgl2), for measurements: __park.fxWater().prof(true) ───────── */
  const gl = renderer.getContext(), tq = gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const prof = { on: false, cur: null, pending: [], data: {} };
  function qBegin(name) { if (!prof.on || !tq || prof.cur) return; const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); prof.cur = { q, name }; }
  function qEnd() { if (!prof.cur) return; gl.endQuery(tq.TIME_ELAPSED_EXT); prof.pending.push(prof.cur); prof.cur = null; }
  function qPoll() {
    const disjoint = tq && gl.getParameter(tq.GPU_DISJOINT_EXT);
    prof.pending = prof.pending.filter(({ q, name }) => {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) (prof.data[name] ||= []).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q); return false;
    });
  }
  function profResult() { const o = {}; for (const [k, a] of Object.entries(prof.data)) { const b = [...a].sort((x, y) => x - y); o[k] = +b[b.length >> 1].toFixed(3); o[k + '_n'] = b.length; } return o; }

  /* ───────── per frame ───────── */
  let hd = true;
  function setHD(on) { hd = on; applyTier(); }
  // tier: 2 = full planar mirror, 1 = captured lands + planar Spire layer + reflected sprites, 0 = captured lands + sprites
  function tier() { return hd ? Q.waterMirror : Q.waterMirrorLow; }
  function applyTier() {
    const t = tier(), full = t >= 2;
    mat.uniforms.uMirror.value = t > 0 && mirror.valid ? (full ? 1 : 2) : 0;
    if (spriteRefl) spriteRefl.visible = waterMesh.visible && !(full && mirror.valid);
    return t;
  }
  let lastT = 0;
  function update(dt, time) {
    qEnd(); qPoll();                                          // closes the previous frame's 'main' query
    if (!waterMesh.visible) { qBegin('main'); return; }
    const L = ctx.getLanterns();
    if (L && !spriteRefl) buildSpriteRefl(L);
    if (L && sim.on && !lanternSplat) buildLanternSplat(L);
    // waterline scan, a few hundred thousand triangles per frame while the park streams in
    enqueue(); if (cur || queue.length) scanStep(Q.waterScanBudget);
    maskTimer -= dt;
    if (maskDirty && maskTimer <= 0 && !cur && !queue.length) { rebuildMask(); maskDirty = false; maskTimer = 1.0; }
    boatUpdate(dt, time);
    qBegin('sim'); simUpdate(dt); qEnd();
    mat.uniforms.uSimOn.value = sim.on && sim.a ? 1 : 0;
    const t = tier();
    if (t < 2) envStep();
    if (t > 0) {
      const every = hd ? Q.mirrorEvery : Math.max(Q.mirrorEvery, Q.mirrorEveryLow);
      if ((mirror.frame++ % every) === 0 || !mirror.valid || mirror.mode !== t) { qBegin('mirror'); renderMirror(t < 2); qEnd(); mirror.mode = t; }
    }
    applyTier();
    lastT = time;
    qBegin('main');
  }
  buildBoat();
  return {
    mesh: waterMesh, material: mat, update, setHD, splash, tapAt, mirror, sim, boat,
    get visible() { return waterMesh.visible; },
    set visible(v) { waterMesh.visible = v; applyTier(); },
    debugMask() {
      const c = document.createElement('canvas'); c.width = SW; c.height = SH; const g = c.getContext('2d'), im = g.createImageData(SW, SH);
      for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) { const k = j * SW + i, o = ((SH - 1 - j) * SW + i) * 4; im.data[o] = wall[k] * 255; im.data[o + 1] = maskData[k * 4]; im.data[o + 2] = water[k] * 120; im.data[o + 3] = 255; }
      g.putImageData(im, 0, 0); return c.toDataURL();
    },
    // synchronous micro-benchmark of the water's own passes (ms per call; readPixels syncs the GPU)
    bench(n = 20) {
      const px = new Uint8Array(4), sync = () => { renderer.setRenderTarget(null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
      const time = (f) => { sync(); const t = performance.now(); for (let i = 0; i < n; i++) f(); sync(); return +((performance.now() - t) / n).toFixed(3); };
      const t = tier(), o = { mirror: t ? time(() => renderMirror(t < 2)) : 0 };
      if (sim.on && sim.a) { const pa = renderer.autoClear; renderer.autoClear = false; o.sim = time(() => simStep(1 / 60)); renderer.autoClear = pa; }
      return o;
    },
    prof(on) { if (on !== undefined) { prof.on = !!on; prof.data = {}; } return profResult(); },
    pathClearance() { let mn = 1e9; for (let s = 0; s < 400; s += 0.5) { boatAt(s, _bp); const i = Math.floor((_bp.x - X0) / dx), j = Math.floor((_bp.z - Z0) / dx); mn = Math.min(mn, open[j * SW + i] ? dist[j * SW + i] : 0); } return mn; },
    info: () => ({ SW, SH, dx, scanned: queue.length, mirror: [mirror.w, mirror.h], sim: sim.on }),
  };
}
