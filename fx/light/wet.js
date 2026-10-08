// Lamps, lanterns, windows and neon mirrored in the wet paving as long broken streaks, on every preset, without a
// mirror render: each frame the CPU picks the few lights that matter around the eye from a light list (WET_N at
// most, fewer on phones and Fast) and the surface shader (patched in by fx/weather/shade.js) adds, per pixel, an
// anisotropic GGX lobe for each, stretched toward the viewer, broken by the setts and the rain micro-normals.
// No popping: a light's weight is a smooth function of its rank metric against the metric of the first light left
// out (a continuous function of the eye position), so the set changes without a visible switch; in the shader every
// light also fades with its horizontal distance from the pixel. There are no grid cells, so nothing can seam.
// The light list: data/lights.json from the bake (every light the bake used, at its visible fitting); without it the
// emissive (class 7) and glowing glass triangles of the park are clustered here, a few frames' work after loading.

export const WET_N = 12;
const knob = (k, d) => { const m = new RegExp('(?:^|[#,&+])u_' + k + '=([-\\d.]+)').exec(location.hash); return m ? +m[1] : d; };                         // the most lights per pixel (desktop); see counts()

export const WET_GLSL = /* glsl */`
  #define WET_N ${WET_N}
  uniform vec4 uWL[WET_N], uWC[WET_N];          // xyz position, w source radius (m); rgb intensity x weight, a: none
  uniform int uWetN; uniform float uWetGain, uWetOcc, uWetLite;      // lite: 1 phone (no rain micro-normals), 2 Fast (no occlusion either)
  // the lights mirrored at P (normal N, toward the eye V), roughness a, stretch s toward the viewer; occ: cover-map test
  vec3 wetStreaks(vec3 P, vec3 N, vec3 V, float a, float s, bool occ){
    vec3 sum = vec3(0.0);
    float nv = max(dot(N, V), 0.04);
    vec3 T = V - N * dot(V, N); float tl = dot(T, T); T = tl > 1e-6 ? T * inversesqrt(tl) : vec3(1.0, 0.0, 0.0);
    vec3 B = cross(N, T);
    s *= 1.0 - nv;                                    // the stretch belongs to grazing views; seen from above a lamp stays a pool
    for (int i = 0; i < WET_N; i++) {
      if (i >= uWetN) break;
      vec3 d = uWL[i].xyz - P; float d2 = dot(d, d), id = inversesqrt(d2); vec3 L = d * id;
      float nl = dot(L, N), g = 1.0 - smoothstep(9.0, 26.0, length(d.xz));      // per pixel: fades with distance from the light
      if (nl <= 0.0 || g <= 0.0) continue;
      vec3 H = normalize(L + V);
      float w = uWL[i].w * id * 0.5;                                               // source size widens the lobe
      float at = a * (1.0 + s) + w, ab = a + w;
      float ht = dot(H, T) / at, hb = dot(H, B) / ab, hn = dot(H, N), den = ht * ht + hb * hb + hn * hn;
      float D = 1.0 / (3.14159 * at * ab * den * den);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
      vec3 c = uWC[i].rgb * (uWetGain * F * D * g * id * id / (4.0 * nv));
      if (occ && max(c.r, max(c.g, c.b)) > 0.002) {                              // a wall between the floor and the light
        // a coarse mip of the height: festoon strings and wires average away, walls and roofs stay
        vec3 m = P + d * 0.5; c *= smoothstep(-1.2, 0.4, m.y + 8.0 - textureLod(tCover, covUV(m.xz), uWetOcc).a * uCovK.y);
      }
      sum += c;
    }
    return sum;
  }`;

// lights per pixel by preset: Fast 4, phone HD 6, desktop 12 (degrade steps take some away)
export const lite = ({ hd, mobile }) => (!hd ? 2 : mobile ? 1 : 0);
export function counts({ hd, mobile, degrade = 0 }) {
  let n = !hd ? 4 : mobile ? 6 : WET_N;
  if (degrade >= 2) n = Math.min(n, mobile ? 4 : 8);
  if (degrade >= 4) n = Math.min(n, 4);
  return n;
}

export function createWetLights({ THREE, getPark, glassMat }) {
  const U = { uWL: { value: Array.from({ length: WET_N }, () => new THREE.Vector4()) }, uWC: { value: Array.from({ length: WET_N }, () => new THREE.Vector4()) }, uWetN: { value: 0 }, uWetGain: { value: knob('wetglow', 16) }, uWetOcc: { value: 2 }, uWetLite: { value: 0 } };
  // the list: px, py, pz, radius, r, g, b, rank scale (grows with the log of the intensity)
  let L = new Float32Array(0), n = 0, source = 'none';
  const B = new Map(), bkey = (i, j) => (i + 512) * 1024 + (j + 512);
  const st = { scanned: new WeakSet(), cells: new Map(), dirty: false, quiet: 0, tris: 0 };

  // from the bake (data/lights.json, Blender-Park/web_export/lights.py, format 1): rows with fields x y z r g b i rad kind
  // fx fy fz part src size up. A floor mirrors what glows, so each light sits at its visible fitting (globe, lantern
  // glass, flame, pane); helper lights with no fitting (facade washes, fills) are left out. i is in baked units at
  // 1 m (radiance x area / 4 pi): the list keeps radiance x area, as the scan below does.
  fetch('data/lights.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (!j || j.format !== 1 || !j.rows || !j.fields) return;
    const F = Object.fromEntries(j.fields.map((f, i) => [f, i])), out = new Float32Array(j.rows.length * 8); let k = 0;
    for (const row of j.rows) {
      if (row[F.fx] === null || row[F.fx] === undefined) continue;
      const e = row[F.i] * 4 * Math.PI, sz = row[F.size] || 2 * row[F.rad] || 0.3;
      out.set([row[F.fx], row[F.fy], row[F.fz], Math.min(0.9, Math.max(0.08, sz * 0.5)), row[F.r] * e, row[F.g] * e, row[F.b] * e, 0], k++ * 8);
    }
    if (k) setList(out, k, 'lights.json');
  }).catch(() => {});

  function setList(arr, count, src) {
    for (let i = 0; i < count; i++) { const s = arr[i * 8 + 4] + arr[i * 8 + 5] + arr[i * 8 + 6]; arr[i * 8 + 7] = Math.min(2.5, 0.4 + 0.35 * Math.log2(1 + s)); }
    L = arr; n = count; source = src;
    // 20 m buckets, so a frame visits only the lights within reach (~1/20 of the park)
    B.clear(); for (let i = 0; i < count; i++) { const key = bkey(Math.floor(arr[i * 8] / 20), Math.floor(arr[i * 8 + 2] / 20)); let b = B.get(key); if (!b) B.set(key, b = []); b.push(i); }
  }

  // provisional: cluster the emissive triangles on a 3 m grid (one light per lamp head or window group: centre
  // weighted by light, radiance x area)
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  function scanMesh(o, budget) {
    const g = o.geometry, A = g.attributes, col = A.aCol, aux = A.aAux, pos = A.position, idx = g.index;
    if (!col || !pos || !idx) return 0;
    const glass = !aux && o.material && o.material.transparent;
    if (!aux && !glass) return 0;
    o.updateWorldMatrix(true, false);                 // (streamed meshes are scanned before their first render)
    const ca = col.array, xa = aux ? aux.array : null, pa = pos.array, ia = idx.array, M = o.matrixWorld.elements;
    const W = (i, v) => { const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2]; return v.set(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]); };
    const R = 32 / 255;
    for (let t = 0; t < ia.length; t += 3) {
      const a = ia[t];
      let r, gg, b;
      if (glass) { const k = (ca[a * 4 + 3] / 255) * 1.4 / (255 * 255); r = ca[a * 4] ** 2 * k; gg = ca[a * 4 + 1] ** 2 * k; b = ca[a * 4 + 2] ** 2 * k; if (r + gg + b < 0.6) continue; }
      else { if (xa[a * 4 + 3] !== 7) continue; const m = ca[a * 4 + 3] * R / 255; r = ca[a * 4] * m; gg = ca[a * 4 + 1] * m; b = ca[a * 4 + 2] * m; if (r + gg + b < 0.5) continue; }
      W(a, v0); W(ia[t + 1], v1); W(ia[t + 2], v2);
      const ar = e1.subVectors(v1, v0).cross(e2.subVectors(v2, v0)).length() * 0.5; if (ar < 1e-5) continue;
      const cx = (v0.x + v1.x + v2.x) / 3, cy = (v0.y + v1.y + v2.y) / 3, cz = (v0.z + v1.z + v2.z) / 3;
      const key = Math.floor(cx / 3) + ',' + Math.floor(cy / 3) + ',' + Math.floor(cz / 3);
      let c = st.cells.get(key); if (!c) st.cells.set(key, c = [0, 0, 0, 0, 0, 0, 0, 0]);
      const wi = (r + gg + b) * ar; c[0] += cx * wi; c[1] += cy * wi; c[2] += cz * wi; c[3] += ar; c[7] += wi; c[4] += r * ar; c[5] += gg * ar; c[6] += b * ar;
    }
    st.tris += ia.length / 3;
    return ia.length / 3;
  }
  function finishScan() {
    const cs = [...st.cells.values()].filter((c) => c[4] + c[5] + c[6] > 0.3);
    const out = new Float32Array(cs.length * 8);
    cs.forEach((c, i) => out.set([c[0] / c[7], c[1] / c[7], c[2] / c[7], Math.min(0.9, Math.sqrt(c[3] / Math.PI)), c[4], c[5], c[6], 0], i * 8));
    setList(out, cs.length, 'scan');
  }

  // selection
  const best = new Int32Array(WET_N + 1), bm = new Float32Array(WET_N + 1);
  const fwd = new THREE.Vector3();
  function update(camera, count) {
    // the scan: a mesh or two per frame while the park streams in; the list is rebuilt once it has been quiet a second
    if (source !== 'lights.json') {
      const park = getPark();
      if (park) {
        let budget = 400000;
        for (const o of park.children) { if (budget <= 0) break; if (!o.isMesh || st.scanned.has(o)) continue; st.scanned.add(o); budget -= scanMesh(o, budget) + 1000; st.dirty = true; st.quiet = 0; }
        if (st.dirty && ++st.quiet > 60) { st.dirty = false; finishScan(); }
      }
    }
    count = Math.min(api.forceN >= 0 ? api.forceN : count, WET_N);       // forceN: tests and cost runs
    U.uWetN.value = n ? count : 0;
    if (!n || !count) return;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    camera.getWorldDirection(fwd); const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
    // metric: distance, shortened for strong lights, lengthened behind the eye (their streaks fall behind it too)
    let k = 0; const K = count + 1;
    const bi = Math.floor(cx / 20), bj = Math.floor(cz / 20);
    for (let u = bi - 7; u <= bi + 7; u++) for (let v = bj - 7; v <= bj + 7; v++) {
      const bl = B.get(bkey(u, v)); if (!bl) continue;
      for (const i of bl) {
      const o = i * 8, dx = L[o] - cx, dy = L[o + 1] - cy, dz = L[o + 2] - cz, d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.25);
      if (d > 150) continue;
      const dh = Math.hypot(dx, dz), cosf = (dx * fx + dz * fz) / Math.max(1, dh);
      // a light straight overhead is mirrored under the eye, out of sight: closer than ~4 m counts as farther
      const x = Math.min(1, Math.max(0, (dh - 1) / 4)), m = Math.max(d * 0.8, (d + 6 * (1 - x * x * (3 - 2 * x))) * (1 + 0.8 * Math.max(0, -cosf)) / L[o + 7]);
      if (m >= 120) continue;                                // (120 = the reach: weight 0 there, see cut; doubled from 60 at the owner's request)
      if (k < K) { let j = k++; while (j > 0 && bm[j - 1] > m) { bm[j] = bm[j - 1]; best[j] = best[j - 1]; j--; } bm[j] = m; best[j] = i; }
      else if (m < bm[K - 1]) { let j = K - 1; while (j > 0 && bm[j - 1] > m) { bm[j] = bm[j - 1]; best[j] = best[j - 1]; j--; } bm[j] = m; best[j] = i; }
      }
    }
    const cut = k === K ? bm[K - 1] : 120;                   // metric of the first light left out (or the reach)
    for (let j = 0; j < WET_N; j++) {
      const P = U.uWL.value[j], C = U.uWC.value[j];
      if (j >= Math.min(k, count)) { C.set(0, 0, 0, 0); P.set(0, -1000, 0, 0); continue; }
      const o = best[j] * 8, x = Math.min(1, Math.max(0, (cut - bm[j]) / (0.25 * cut))), w = x * x * (3 - 2 * x);
      P.set(L[o], L[o + 1], L[o + 2], L[o + 3]); C.set(L[o + 4] * w, L[o + 5] * w, L[o + 6] * w, w);
    }
  }
  const api = { forceN: -1, U, update, get count() { return n; }, get source() { return source; }, get list() { return L.subarray(0, n * 8); }, setList, st };
  return api;
}
