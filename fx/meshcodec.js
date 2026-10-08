// The park's mesh format (Blender-Park/web_export/pack.py), decoded to typed arrays. Shared by the loader's worker
// (fx/meshcodec-worker.js: a land's part is gunzipped and decoded off the main thread, so the walk does not hitch while
// lands stream in) and app.js (in-thread fallback, and the monorail cars). No three.js here: app.js makes the
// BufferGeometry from what this returns.
//   positions: Uint16 xyz (grid units; mesh.position = origin, scale = step), zigzag-delta per plane
//   aCol: RGBM u8 x4 (baked HDR light), aAux: albedo rgb + surface class u8 x4 (optional), indices: u32 "high-water
//   mark" code, aLay: optional per-vertex coplanar rank u8, aMat: optional tiling-material slot u8
export function decodeMeshArrays(u8, off, m) {
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
  let lay = null;
  if (m.lay) {                     // optional coplanar-priority plane (zigzag-delta u8 per vertex): a higher rank wins ties
    lay = new Uint8Array(nv); let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[off + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; lay[i] = acc; }
    off += nv;
  }
  let mat = null;
  if (m.mat) {                     // optional tiling-material slot plane (zigzag-delta u8 per vertex; fx/light/materials.js)
    mat = new Uint8Array(nv); let acc = 0;
    for (let i = 0; i < nv; i++) { const zz = u8[off + i]; acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFF; mat[i] = acc; }
    off += nv;
  }
  return { pos, col, aux, idx, lay, mat, next: off };
}

// every mesh of a part, in order
export function decodePart(u8, meshes) {
  const out = []; let off = 0;
  for (const m of meshes) { const d = decodeMeshArrays(u8, off, m); off = d.next; out.push(d); }
  return out;
}

export async function gunzip(buf) {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}
