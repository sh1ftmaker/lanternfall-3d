// Shared loader for the many-light experiments: decodes the park parts (as app.js decodeMesh) and the light list.
// Every function takes the THREE namespace in use (three or three/webgpu) so both renderers can share it.
export const DATA = '../../data/';
export const Q = Object.fromEntries(new URLSearchParams(location.search));
export async function fetchBin(file) {
  const res = await fetch(DATA + file); if (!res.ok) throw new Error(file + ': ' + res.status);
  let buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return buf;
}
// posMode 'u16' keeps the quantised Uint16 positions (as the viewer does), 'f32' converts them to Float32 on the CPU.
function decodeMesh(THREE, u8, off, m, posMode) {
  const nv = m.nv, ni = m.ni; const pos = new Uint16Array(nv * 3);
  for (let c = 0; c < 3; c++) { const lo = off + c * 2 * nv, hi = lo + nv; let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[lo + i] | (u8[hi + i] << 8); acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFFFF; pos[i * 3 + c] = acc; } }
  off += nv * 6; const col = new Uint8Array(nv * 4);
  for (let c = 0; c < 4; c++) { const o = off + c * nv; let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[o + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; col[i * 4 + c] = acc; } }
  off += nv * 4;
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni); let mx = -1; const p1 = off + ni, p2 = p1 + ni, p3 = p2 + ni;
  for (let i = 0; i < ni; i++) { const code = (u8[off + i] | (u8[p1 + i] << 8) | (u8[p2 + i] << 16) | (u8[p3 + i] << 24)) >>> 0; const v = mx + 1 - code; if (v > mx) mx = v; idx[i] = v; }
  off += ni * 4;
  // albedo = baked HDR colour (rgb * a * 32) clamped to 1, stored as RGB8 'color'
  const alb = new Uint8Array(nv * 4);
  for (let i = 0; i < nv; i++) { const k = col[i * 4 + 3] * 32 / 255; for (let c = 0; c < 3; c++) alb[i * 4 + c] = Math.min(255, col[i * 4 + c] * k); alb[i * 4 + 3] = 255; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', posMode === 'f32' ? new THREE.BufferAttribute(Float32Array.from(pos), 3) : new THREE.BufferAttribute(pos, 3, false));
  g.setAttribute('color', new THREE.BufferAttribute(alb, 4, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const o = m.origin, s = m.step, bb = m.bbox;
  g.boundingBox = new THREE.Box3(new THREE.Vector3((bb[0] - o[0]) / s, (bb[1] - o[1]) / s, (bb[2] - o[2]) / s), new THREE.Vector3((bb[3] - o[0]) / s, (bb[4] - o[1]) / s, (bb[5] - o[2]) / s));
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geometry: g, next: off };
}
export async function loadPark(THREE, material, parts, posMode) {
  const manifest = await (await fetch(DATA + 'manifest.json')).json();
  const grp = new THREE.Group(); let tris = 0;
  for (const part of manifest.parts) {
    if (parts !== 'all' && !parts.split(',').includes(part.id)) continue;
    const u8 = await fetchBin(part.file); let off = 0;
    for (const m of part.meshes) {
      const d = decodeMesh(THREE, u8, off, m, posMode); off = d.next; tris += m.ni / 3;
      const mesh = new THREE.Mesh(d.geometry, material); mesh.position.fromArray(m.origin); mesh.scale.setScalar(m.step);
      mesh.matrixAutoUpdate = false; mesh.updateMatrix(); grp.add(mesh);
    }
  }
  return { grp, tris };
}
// Light list: N x 16 floats [p.xyz, range][col.rgb, soft][axis.xyz, a][e0, e1, b, kind]. Pick K by relevance to the
// main avenue (segment x 0..288 at z 0, where the walk camera stands): brightness / (distance to segment)^2.
export async function loadLights(THREE, K) {
  const f = new Float32Array((await fetchBin('lit/lights.bin')).buffer); const N = f.length / 16;
  const order = Array.from({ length: N }, (_, i) => i);
  if (K < N) {
    const sc = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = f[i * 16], y = f[i * 16 + 1], z = f[i * 16 + 2], cx = Math.max(0, Math.min(288, x));
      const d2 = (x - cx) ** 2 + (y - 1.8) ** 2 + z * z; sc[i] = Math.max(f[i * 16 + 4], f[i * 16 + 5], f[i * 16 + 6]) / Math.max(4, d2); }
    order.sort((a, b) => sc[b] - sc[a]);
  }
  const lights = [];
  for (const i of order.slice(0, K)) {
    const r = f[i * 16 + 4], g = f[i * 16 + 5], b = f[i * 16 + 6], m = Math.max(r, g, b, 1e-6);
    // three.js physical: diffuse = albedo/PI * color*intensity * ndotl / d^2 * window -> intensity = PI * max channel
    const L = new THREE.PointLight(new THREE.Color(r / m, g / m, b / m), Math.PI * m, f[i * 16 + 3], 2);
    L.position.set(f[i * 16], f[i * 16 + 1], f[i * 16 + 2]); L.matrixAutoUpdate = false; L.updateMatrix(); lights.push(L);
  }
  return { lights, N };
}
export const CAMS = { walk: { p: [288, 1.8, 0], t: [0, 1.8, 0], near: 0.22 }, aerial: { p: [150, 250, 470], t: [0, 8, 0], near: 0.6 } };
export function setCam(camera, name) { const c = CAMS[name]; camera.position.fromArray(c.p); camera.lookAt(...c.t); camera.near = c.near; camera.updateProjectionMatrix(); }
