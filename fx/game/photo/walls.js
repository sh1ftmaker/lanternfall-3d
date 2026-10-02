// Photo mode's camera stop: the camera may not pass through the park's walls, roofs and floors.
// The platformer's own collision lives in a worker and is not reachable from here, so this gathers the same triangles
// (the baked, opaque park chunks at their base level of detail, as fx/platformer/collision.js reads them) from a window
// around the camera, time-sliced, into a 4 m grid, and clips each move against them: stop short of the surface by a
// margin, then slide along it for what is left of the move. The window is rebuilt as the camera drifts from its centre
// (a ride carries the camera along a track), and the old one serves until the new one is ready.
const CELL = 4, HALF = 15, MARGIN = 0.35, REBUILD = 6;

export function createWalls(THREE, getPark, getLod) {
  let cur = null, building = null;
  const V = new THREE.Vector3();

  function* gatherSteps(cx, cy, cz, budgetMs = 6) {
    const park = getPark(); if (!park) return null;
    const lod = new Map((getLod() || []).map((e) => [e.mesh, e.m]));
    const x0 = cx - HALF, x1 = cx + HALF, z0 = cz - HALF, z1 = cz + HALF, y0 = cy - HALF, y1 = cy + HALF;
    const pos = [], grid = new Map(), big = [];
    let slice = performance.now();
    for (const m of park.children) {
      if (!m.isMesh || !m.geometry.attributes.aCol || m.material.transparent || !m.geometry.index) continue;
      const g = m.geometry, bb = g.boundingBox || (g.computeBoundingBox(), g.boundingBox), s = m.scale.x, o = m.position;
      if (o.x + bb.max.x * s < x0 || o.x + bb.min.x * s > x1 || o.z + bb.max.z * s < z0 || o.z + bb.min.z * s > z1 || o.y + bb.max.y * s < y0 || o.y + bb.min.y * s > y1) continue;
      const p = g.attributes.position.array, idx = g.index.array, end = lod.get(m)?.n0 ?? idx.length;
      for (let t = 0; t < end; t += 3) {
        if ((t & 8191) === 0 && performance.now() - slice > budgetMs) { yield; slice = performance.now(); }
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ax = o.x + p[a] * s, ay = o.y + p[a + 1] * s, az = o.z + p[a + 2] * s, bx = o.x + p[b] * s, by = o.y + p[b + 1] * s, bz = o.z + p[b + 2] * s, cx2 = o.x + p[c] * s, cy2 = o.y + p[c + 1] * s, cz2 = o.z + p[c + 2] * s;
        const mnx = Math.min(ax, bx, cx2), mxx = Math.max(ax, bx, cx2), mnz = Math.min(az, bz, cz2), mxz = Math.max(az, bz, cz2), mny = Math.min(ay, by, cy2), mxy = Math.max(ay, by, cy2);
        if (mxx < x0 || mnx > x1 || mxz < z0 || mnz > z1 || mxy < y0 || mny > y1) continue;
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx2 - ax, vy = cy2 - ay, vz = cz2 - az;
        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 2e-3) continue;           // degenerate and sub-centimetre slivers
        const n = pos.length / 9; pos.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2);
        if (mxx - mnx > CELL * 2 || mxz - mnz > CELL * 2) { big.push(n); continue; }
        for (let i = Math.floor(mnx / CELL); i <= Math.floor(mxx / CELL); i++) for (let j = Math.floor(mnz / CELL); j <= Math.floor(mxz / CELL); j++) { const k = i * 65536 + j; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); }
      }
    }
    return { cx, cy, cz, pos: new Float32Array(pos), grid, big, stamp: new Uint32Array(pos.length / 9), tick: 0 };
  }

  // nearest hit of the segment o + d * t, t in [0, len], on the two-sided triangle set w: { t, n } or null
  const hit = { t: 0, nx: 0, ny: 0, nz: 0 };
  function cast(w, ox, oy, oz, dx, dy, dz, len) {
    const P = w.pos, ex = ox + dx * len, ez = oz + dz * len, i0 = Math.floor(Math.min(ox, ex) / CELL), i1 = Math.floor(Math.max(ox, ex) / CELL), j0 = Math.floor(Math.min(oz, ez) / CELL), j1 = Math.floor(Math.max(oz, ez) / CELL);
    let best = len + 1, found = false; w.tick++;
    const test = (n) => {
      if (w.stamp[n] === w.tick) return; w.stamp[n] = w.tick;
      const k = n * 9, ax = P[k], ay = P[k + 1], az = P[k + 2], e1x = P[k + 3] - ax, e1y = P[k + 4] - ay, e1z = P[k + 5] - az, e2x = P[k + 6] - ax, e2y = P[k + 7] - ay, e2z = P[k + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-9) return;
      const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az, u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv; if (t < 0 || t > len || t >= best) return;
      best = t; found = true; hit.nx = e1y * e2z - e1z * e2y; hit.ny = e1z * e2x - e1x * e2z; hit.nz = e1x * e2y - e1y * e2x;
    };
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const l = w.grid.get(i * 65536 + j); if (l) for (let q = 0; q < l.length; q++) test(l[q]); }
    for (let q = 0; q < w.big.length; q++) test(w.big[q]);
    if (!found) return false;
    const nl = Math.hypot(hit.nx, hit.ny, hit.nz) || 1; hit.nx /= nl; hit.ny /= nl; hit.nz /= nl; hit.t = best; return true;
  }

  // per frame: keep a window around `at` (a Vector3 in three.js axes); gather a little each frame
  function update(at) {
    if (!building && (!cur || Math.hypot(at.x - cur.cx, at.z - cur.cz) > REBUILD || Math.abs(at.y - cur.cy) > REBUILD)) building = gatherSteps(at.x, at.y, at.z);
    if (building) { const r = building.next(); if (r.done) { if (r.value) cur = r.value; building = null; } }
  }
  // the camera wants to go from a to b (both Vector3, three.js axes): writes the allowed end point into out. Slides along what it meets.
  function clip(a, b, out) {
    out.copy(b); const w = cur; if (!w) return false;
    let ox = a.x, oy = a.y, oz = a.z, rx = b.x - a.x, ry = b.y - a.y, rz = b.z - a.z, blocked = false;
    for (let it = 0; it < 3; it++) {
      const len = Math.hypot(rx, ry, rz); if (len < 1e-6) break;
      const dx = rx / len, dy = ry / len, dz = rz / len;
      if (!cast(w, ox, oy, oz, dx, dy, dz, len + MARGIN)) { ox += rx; oy += ry; oz += rz; out.set(ox, oy, oz); return blocked; }
      blocked = true;
      const tt = Math.max(0, Math.min(len, hit.t - MARGIN)); ox += dx * tt; oy += dy * tt; oz += dz * tt;
      const left = len - tt, dn = (dx * hit.nx + dy * hit.ny + dz * hit.nz) * left;          // what is left of the move, minus its part into the surface
      rx = dx * left - hit.nx * dn; ry = dy * left - hit.ny * dn; rz = dz * left - hit.nz * dn;
      if (it === 2) { out.set(ox, oy, oz); return true; }
    }
    out.set(ox, oy, oz); return blocked;
  }
  return { update, clip, get ready() { return !!cur; }, get count() { return cur ? cur.pos.length / 9 : 0 }, get window() { return cur ? [cur.cx, cur.cy, cur.cz] : null }, reset() { cur = null; building = null; } };
}
