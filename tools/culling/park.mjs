// Reads the packed park (data/manifest.json + data/<part>.bin) in node, the same way app.js decodeMesh() does.
// Returns one entry per chunk: world-space positions in the three.js frame, the index buffer and the LOD counts.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export function loadPark(dataDir) {
  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8'));
  const chunks = [];
  for (const part of manifest.parts) {
    let u8 = readFileSync(join(dataDir, part.file));
    if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = gunzipSync(u8);
    let off = 0;
    for (const m of part.meshes) {
      const nv = m.nv, ni = m.ni, pos = new Float32Array(nv * 3);
      for (let c = 0; c < 3; c++) {
        const lo = off + c * 2 * nv, hi = lo + nv; let acc = 0;
        for (let i = 0; i < nv; i++) { const zz = u8[lo + i] | (u8[hi + i] << 8); acc = (acc + ((zz >>> 1) ^ -(zz & 1))) & 0xFFFF; pos[i * 3 + c] = m.origin[c] + acc * m.step; }
      }
      off += nv * 6 + nv * 4 + (m.aux ? nv * 4 : 0);              // positions, colours, albedo/class
      const idx = new Uint32Array(ni); let mx = -1; const p1 = off + ni, p2 = p1 + ni, p3 = p2 + ni;
      for (let i = 0; i < ni; i++) { const code = (u8[off + i] | (u8[p1 + i] << 8) | (u8[p2 + i] << 16) | (u8[p3 + i] << 24)) >>> 0; const v = mx + 1 - code; if (v > mx) mx = v; idx[i] = v; }
      off += ni * 4 + (m.lay ? nv : 0) + (m.mat ? nv : 0);         // + optional rank and material-slot planes
      chunks.push({ part: part.id, i: chunks.length, kind: m.kind, pos, idx, n0: m.n0, n1: m.n1, ni, bbox: m.bbox });
    }
  }
  return { manifest, chunks };
}
