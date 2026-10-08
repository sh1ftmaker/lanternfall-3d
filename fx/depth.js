// Depth precision for Lanternfall 3D: a per-frame near plane chosen from the camera's clearance.
//
// A perspective depth buffer resolves about z^2 / (near * 2^24) metres at distance z, so precision is set almost
// entirely by the near plane. The park stacks floors 2 mm - 6 cm apart (terrain, land base, paving, decals), and with
// a fixed near of 0.6 m the aerial shots (camera 30-550 m away) cannot separate them. Here the near plane is pushed out
// to half the distance to the closest geometry every frame: tens of metres in the aerial tour and Explore views,
// back to the old fixed planes in Walk mode or when the gate walk passes under the arch. Works with any 24-bit depth
// buffer (phones included), costs ~0.05 ms per frame and needs no data changes.
//
// "Closest geometry" comes from a coarse clearance grid built while the park loads: for every 4 m cell the highest
// point of any triangle whose bounding box touches it (static meshes, tree crowns, a band above the monorail for the
// trains). Each cell is treated as a solid column down to -infinity, so the column distance is a lower bound on the
// true distance and the near plane can never cut into geometry. Lantern sprites do not count: their vertex shader
// pins a sprite that is closer than the near plane onto it (it is then closer than any geometry anyway).
export function createDepth(THREE, camera, opt = {}) {
  const CELL = opt.cell || 4, HALF = opt.half || 1504, N = Math.ceil((2 * HALF) / CELL);
  const floor = opt.floor ?? -0.8;                       // nothing in the park is lower than the lake surface
  const grid = new Float32Array(N * N).fill(floor);
  const st = { near: camera.near, far: camera.far, clearance: 0, jitter: 1, on: opt.on !== false,
    nearMin: opt.nearMin || 0.12, nearMax: opt.nearMax || 90, k: opt.k || 0.5, cap: Infinity };
  const ci = (v) => Math.min(N - 1, Math.max(0, Math.floor((v + HALF) / CELL)));
  function mark(x0, x1, z0, z1, h) {                    // raise every cell overlapping [x0,x1] x [z0,z1] to h
    const i0 = ci(x0), i1 = ci(x1), j0 = ci(z0), j1 = ci(z1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * N + i; if (grid[k] < h) grid[k] = h; }
  }
  // a decoded park/train chunk: Uint16 positions, mesh.position = origin, mesh.scale = step (see app.js meshFrom)
  function addMesh(mesh) {
    const g = mesh.geometry, p = g.attributes.position.array, idx = g.index.array, s = mesh.scale.x, o = mesh.position;
    // cell indices per vertex (ci is monotonic, so the cell of the smallest x is the smallest cell index: the same cells
    // as marking each triangle's float bounds, without three Math.min/max calls per corner; ~3x faster while loading)
    const nv = p.length / 3, ix = new Int32Array(nv), iz = new Int32Array(nv), vy = new Float32Array(nv);
    for (let v = 0; v < nv; v++) { ix[v] = ci(o.x + p[v * 3] * s); vy[v] = o.y + p[v * 3 + 1] * s; iz[v] = ci(o.z + p[v * 3 + 2] * s); }
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      let i0 = ix[a], i1 = i0, j0 = iz[a], j1 = j0, h = vy[a];
      const xb = ix[b], xc = ix[c], zb = iz[b], zc = iz[c];
      if (xb < i0) i0 = xb; else if (xb > i1) i1 = xb; if (xc < i0) i0 = xc; else if (xc > i1) i1 = xc;
      if (zb < j0) j0 = zb; else if (zb > j1) j1 = zb; if (zc < j0) j0 = zc; else if (zc > j1) j1 = zc;
      if (vy[b] > h) h = vy[b]; if (vy[c] > h) h = vy[c];
      for (let j = j0; j <= j1; j++) for (let k = j * N + i0, e = j * N + i1; k <= e; k++) if (grid[k] < h) grid[k] = h;
    }
  }
  // instanced trees: bounding sphere of the template per instance
  function addInstanced(im) {
    const g = im.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox, r = Math.max(bb.max.x, -bb.min.x, bb.max.z, -bb.min.z), M = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
    const n = im.userData.total || im.count;
    for (let i = 0; i < n; i++) { im.getMatrixAt(i, M); M.decompose(v, q, sc); const rr = r * sc.x; mark(v.x - rr, v.x + rr, v.z - rr, v.z + rr, v.y + bb.max.y * sc.y); }
  }
  // the monorail ellipse (Blender x = a cos t, y = b sin t -> three x, -y): room for the trains above the beam
  function addRail(a, b, top, clear = 6, w = 4) {
    for (let k = 0; k < 2048; k++) { const t = (k / 2048) * Math.PI * 2, x = a * Math.cos(t), z = -b * Math.sin(t); mark(x - w, x + w, z - w, z + w, top + clear); }
  }
  // lower bound on the distance from p to any geometry: nearest column within radius R (cells beyond R are ignored,
  // so the result is capped at R)
  function clearance(p, R) {
    const x = p.x + HALF, z = p.z + HALF, y = p.y;
    const i0 = Math.max(0, Math.floor((x - R) / CELL)), i1 = Math.min(N - 1, Math.floor((x + R) / CELL));
    const j0 = Math.max(0, Math.floor((z - R) / CELL)), j1 = Math.min(N - 1, Math.floor((z + R) / CELL));
    let best = R * R;
    for (let j = j0; j <= j1; j++) {
      const cz = j * CELL, dz = z < cz ? cz - z : z > cz + CELL ? z - cz - CELL : 0, dz2 = dz * dz;
      if (dz2 >= best) continue;
      for (let i = i0; i <= i1; i++) {
        const cx = i * CELL, dx = x < cx ? cx - x : x > cx + CELL ? x - cx - CELL : 0;
        const dy = y - grid[j * N + i], d2 = dx * dx + dz2 + (dy > 0 ? dy * dy : 0);
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  }
  // call once per frame before rendering. The near plane sits at k * clearance, and k = 0.5 keeps even the corners
  // of the near rectangle (up to ~1.7x further out at the widest phone field of view) clear of geometry.
  function update(nearFloor) {
    if (!st.on) return;
    const R = st.nearMax / st.k;
    st.clearance = clearance(camera.position, R);
    // st.cap: an upper bound set by moving things the grid does not know about (fx/guests/render.js: half the
    // distance to the nearest guest), so close figures are not cut by the near plane
    const near = Math.min(st.nearMax, Math.max(nearFloor ?? st.nearMin, Math.min(st.k * st.clearance, st.cap))) * st.jitter;
    if (Math.abs(near - camera.near) > 1e-6 * near) { camera.near = near; camera.updateProjectionMatrix(); }
    st.near = near;
  }
  return Object.assign(st, { addMesh, addInstanced, addRail, clearance, update, grid, N, CELL, HALF });
}

// ── Reversed depth ('#norz' disables): EXT_clip_control + a 32-bit float depth target in the HD composer. ──
// Render-target options for the composer: a float depth attachment is what makes reversed depth pay off (with the
// canvas' 24-bit fixed-point buffer it is no better than the standard mapping). Depth is never sampled: no resolve.
export function depthTargetOptions(THREE, renderer, w, h) {
  if (!renderer.state.buffers.depth.getReversed()) return {};
  return { depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType), resolveDepthBuffer: false };
}
// ── Data hook for coplanar faces (not emitted yet) ──
// bakedMat breaks exact-coplanar ties with a depth-only lift: pitch-black under-layers -1.8 mm, brighter faces up to
// +1.8 mm. A guess; the data can replace it. pack.py may set "lay": 1 on a mesh entry in manifest.json and append one
// u8 plane of nv bytes after the index planes (same zigzag-delta coding as the colour planes): a per-vertex layer rank
// (0 terrain, 1 land base, 2 paving, 3 paths, 4 decals/markings ...; all corners of a triangle equal, so do not weld
// across ranks). The viewer then lifts depth by rank * 0.5 mm and drops the brightness guess (app.js decodeMesh).
