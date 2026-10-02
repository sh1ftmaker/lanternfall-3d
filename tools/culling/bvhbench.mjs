// three-mesh-bvh as an occlusion source for the park: build cost, size, ray throughput, and how well a ray-sampled
// visible set matches the exact one. Needs three@0.186.1 and three-mesh-bvh@0.9.15 (npm i in any folder, run there
// with NODE_PATH or copy this folder next to node_modules).
//   node bvhbench.mjs <data dir> <poses.json> [raysX raysY]
// poses.json: [{ name, mw, pm, w, h, ids }] = camera matrixWorld / projectionMatrix elements and the exact visible
// chunk ids (an ID-buffer render at full resolution, see README.md).
import * as THREE from 'three';
import { MeshBVH, SAH, CENTER } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';
import { loadPark } from './park.mjs';

const [dataDir, posesFile, RX = '192', RY = '108'] = process.argv.slice(2);
const t0 = performance.now();
const { chunks } = loadPark(dataDir);
const t1 = performance.now();
// occluders: every opaque chunk at full detail (what the main view draws near the camera) and at base detail only
function soup(lod) {
  let nt = 0, nv = 0; for (const c of chunks) if (c.kind !== 'glass') { nt += (lod ? c.n0 : c.ni) / 3; nv += c.pos.length / 3; }
  const pos = new Float32Array(nv * 3), idx = new Uint32Array(nt * 3), owner = new Uint16Array(nt); let vo = 0, to = 0;
  for (const c of chunks) {
    if (c.kind === 'glass') continue;
    pos.set(c.pos, vo * 3); const n = lod ? c.n0 : c.ni;
    for (let k = 0; k < n; k++) idx[to * 3 + k] = c.idx[k] + vo;
    owner.fill(c.i, to, to + n / 3); to += n / 3; vo += c.pos.length / 3;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return { g, owner, nt };
}
const poses = JSON.parse(readFileSync(posesFile, 'utf8'));
console.log(`decode ${(t1 - t0).toFixed(0)} ms, ${chunks.length} chunks`);
for (const lod of [false, true]) {
  const { g, owner, nt } = soup(lod);
  for (const strategy of [CENTER, SAH]) {
    const b0 = performance.now(); const bvh = new MeshBVH(g, { strategy, indirect: true, targetLeafSize: 8 }); const b1 = performance.now();
    const ser = MeshBVH.serialize(bvh, { cloneBuffers: false }); const bytes = ser.roots.reduce((s, r) => s + r.byteLength, 0) + (ser.indirectBuffer ? ser.indirectBuffer.byteLength : 0);
    console.log(`\n${lod ? 'base detail' : 'full detail'} ${(nt / 1e6).toFixed(2)} M tris, ${strategy === SAH ? 'SAH' : 'CENTER'}: build ${(b1 - b0).toFixed(0)} ms, BVH ${(bytes / 1e6).toFixed(1)} MB (+ positions ${(g.attributes.position.array.byteLength / 1e6).toFixed(1)} MB, index ${(g.index.array.byteLength / 1e6).toFixed(1)} MB)`);
    if (strategy !== SAH) continue;
    const ray = new THREE.Ray(), cam = new THREE.PerspectiveCamera(), v = new THREE.Vector3(), nx = +RX, ny = +RY;
    for (const p of poses) {
      cam.matrixWorld.fromArray(p.mw); cam.matrixWorldInverse.copy(cam.matrixWorld).invert(); cam.projectionMatrix.fromArray(p.pm); cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      const seen = new Set(), r0 = performance.now();
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        ray.origin.setFromMatrixPosition(cam.matrixWorld);
        v.set(((i + 0.5) / nx) * 2 - 1, ((j + 0.5) / ny) * 2 - 1, 0.5).unproject(cam); ray.direction.copy(v).sub(ray.origin).normalize();
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide); if (hit) seen.add(owner[hit.faceIndex]);    // indirect: faceIndex is the original triangle
      }
      const ms = performance.now() - r0, exact = new Set(p.ids.filter((id) => chunks[id].kind !== 'glass'));
      const missed = [...exact].filter((id) => !seen.has(id)), extra = [...seen].filter((id) => !exact.has(id));
      console.log(`  ${p.name.padEnd(7)} ${nx * ny} rays ${ms.toFixed(1)} ms (${(nx * ny / ms).toFixed(0)} rays/ms): found ${seen.size}, exact ${exact.size}, MISSED ${missed.length}${missed.length ? ' [' + missed.slice(0, 8).join(',') + ']' : ''}, extra ${extra.length}`);
    }
  }
}
console.log(`\npeak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB, total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
