// Collision for the Platformer: the park's own triangles, streamed in windows around the player.
//
// The park is 3.4 M triangles; the movement library needs a static triangle set in its units (here 1 unit = 1 cm, axes
// as three.js, which share the library's convention: y up, counter-clockwise = front). This module
//   1. prepare(): once, when the Platformer is first chosen, walks every chunk's BASE-detail triangles (the `n0` range
//      the viewer draws from far away), de-quantises them, drops what the player can never stand on or bump into
//      (degenerate slivers, wall pieces under 0.16 m^2 (posts, rails, trim), floor pieces under 0.015 m^2, anything above
//      50 m, anything outside the park; tools/platformer/validate-collision.mjs checks the floors that remain against
//      the walk grid), and files a reference to each kept triangle in a 16 m bucket grid by its centroid (time-sliced);
//   2. gather(x, z): packs the triangles of the buckets around a point into the library's surface records, adding
//      what the visual data lacks: a lake bed 4 m under Stillwater's surface (so the player can swim across to the
//      Spire), invisible walls along the park's perimeter, and the ice rink at Frostmere as an ice surface.
// Floors whose winding faces down are emitted both ways (as a ceiling, and turned over as a floor): the park is drawn
// double-sided, so a downward-facing floor in the data is a floor all the same.
//
// The Worker (pf-worker.js) loads a window, ticks the library and casts camera rays against the same triangles.
const BUCKET = 16;                 // m
const X0 = -292, X1 = 352, Z0 = -240, Z1 = 240;          // three.js x / z bounds of everything the player can reach
const YMAX = 50;                   // m: nothing above this is reachable
export const UNITS = 100;          // library units per metre
const SURF_ICE = 0x2E, TERRAIN_GRASS = 0, TERRAIN_STONE = 1, TERRAIN_SNOW = 2, TERRAIN_WATER = 5;

// Blender land frame (park_common.py _frame2d): origin = land centre, +Y outward, +X right when facing outward
function landFrame(land) { const [cx, cy] = land.center, d = Math.hypot(cx, cy), uy = [cx / d, cy / d], ux = [uy[1], -uy[0]]; return { cx, cy, ux, uy }; }
function toLocal(F, x, y) { const dx = x - F.cx, dy = y - F.cy; return [dx * F.ux[0] + dy * F.ux[1], dx * F.uy[0] + dy * F.uy[1]]; }
export function inPoly(pl, x, y) { let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function distToPoly(pl, x, y) { let best = 1e18; for (let a = 0, b = pl.length - 1; a < pl.length; b = a++) { const [ax, ay] = pl[a], [bx, by] = pl[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), ex = ax + t * dx - x, ey = ay + t * dy - y; best = Math.min(best, ex * ex + ey * ey); } return Math.sqrt(best); }

export function createCollision({ park, lodMeshes, manifest, nav, flipDown = true, minWall = 0.16, minFloor = 0.015 }) {
  const lod = new Map(lodMeshes.map((e) => [e.mesh, e.m]));
  const meshes = park.children.filter((m) => m.isMesh && m.geometry.attributes.aCol && !m.material.transparent && m.geometry.index);
  const NBX = Math.ceil((X1 - X0) / BUCKET), NBZ = Math.ceil((Z1 - Z0) / BUCKET);
  const st = { ready: false, progress: 0, prepMs: 0, kept: 0, seen: 0, dropped: { outside: 0, high: 0, degenerate: 0, smallWall: 0, tinyFloor: 0 }, big: 0, buckets: NBX * NBZ, lastGather: null };
  let refs = null, bucketStart = null;          // refs: (meshIdx << 22 | triIdx), sorted by bucket
  const big = [];                               // triangles wider than a bucket: always considered
  const water = manifest.water_z ?? -0.8, lake = manifest.lake || [];
  const frost = manifest.lands.find((l) => l.id === 'frostmere'), FF = frost ? landFrame(frost) : null;
  const RINK = [-18, -47, 12, 7];               // Frostmere skating rink (land frame: centre x, y, semi-axes; parts/frostmere.py)

  // ── 1. prepare: one pass over the base triangles, time-sliced ──
  function* prepareSteps(budgetMs = 6) {
    const t0 = performance.now(); let tSlice = performance.now();
    let tmpRef = new Uint32Array(1 << 20), tmpB = new Uint16Array(1 << 20), n = 0;
    const push = (ref, b) => {
      if (n === tmpRef.length) { const r = new Uint32Array(n * 2); r.set(tmpRef); tmpRef = r; const q = new Uint16Array(n * 2); q.set(tmpB); tmpB = q; }
      tmpRef[n] = ref; tmpB[n] = b; n++;
    };
    const total = meshes.reduce((s, m) => s + (lod.get(m)?.n0 ?? m.geometry.index.count), 0); let done = 0;
    for (let mi = 0; mi < meshes.length; mi++) {
      const m = meshes[mi], g = m.geometry, p = g.attributes.position.array, idx = g.index.array, s = m.scale.x, o = m.position;
      const end = lod.get(m)?.n0 ?? idx.length, bb = g.boundingBox;
      if (o.x + bb.max.x * s < X0 || o.x + bb.min.x * s > X1 || o.z + bb.max.z * s < Z0 || o.z + bb.min.z * s > Z1 || o.y + bb.min.y * s > YMAX) { done += end; continue; }
      for (let t = 0; t < end; t += 3) {
        if ((t & 4095) === 0 && performance.now() - tSlice > budgetMs) { st.progress = done / total; yield; tSlice = performance.now(); }
        done += 3; st.seen++;
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ax = o.x + p[a] * s, ay = o.y + p[a + 1] * s, az = o.z + p[a + 2] * s;
        const bx = o.x + p[b] * s, by = o.y + p[b + 1] * s, bz = o.z + p[b + 2] * s;
        const cx = o.x + p[c] * s, cy = o.y + p[c + 1] * s, cz = o.z + p[c + 2] * s;
        const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
        if (mx < X0 || mx >= X1 || mz < Z0 || mz >= Z1) { st.dropped.outside++; continue; }
        if (Math.min(ay, by, cy) > YMAX) { st.dropped.high++; continue; }
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz), area = l / 2;
        if (area < 1e-4) { st.dropped.degenerate++; continue; }
        const yn = ny / l;
        if (Math.abs(yn) <= 0.5) { if (area < minWall) { st.dropped.smallWall++; continue; } }
        else if (area < minFloor) { st.dropped.tinyFloor++; continue; }
        const ref = (mi << 22) | (t / 3);
        const ext = Math.max(Math.max(ax, bx, cx) - Math.min(ax, bx, cx), Math.max(az, bz, cz) - Math.min(az, bz, cz));
        if (ext > BUCKET) { big.push(ref); st.big++; continue; }
        push(ref, Math.floor((mx - X0) / BUCKET) + Math.floor((mz - Z0) / BUCKET) * NBX);
      }
    }
    // counting sort by bucket
    bucketStart = new Uint32Array(NBX * NBZ + 1);
    for (let i = 0; i < n; i++) bucketStart[tmpB[i] + 1]++;
    for (let i = 0; i < NBX * NBZ; i++) bucketStart[i + 1] += bucketStart[i];
    refs = new Uint32Array(n); const fill = bucketStart.slice(0, NBX * NBZ);
    for (let i = 0; i < n; i++) refs[fill[tmpB[i]]++] = tmpRef[i];
    st.kept = n + big.length; st.ready = true; st.progress = 1; st.prepMs = Math.round(performance.now() - t0);
    buildExtras();
  }

  // ── extras the visual data lacks ──
  let perimeter = [], bed = [];          // [x0, z0, x1, z1] wall segments (three.js x/z), bed cells
  const reach = { w: 0, h: 0, cell: 4, x0: X0, z0: Z0, g: null };
  function buildExtras() {
    // reachable area: the walk grid's walkable cells and the lake, dilated by 8 m, on a 4 m grid (three.js x / z)
    const C = reach.cell, W = Math.ceil((X1 - X0) / C), H = Math.ceil((Z1 - Z0) / C), g = new Uint8Array(W * H);
    reach.w = W; reach.h = H; reach.g = g;
    if (nav) for (let j = 0; j < nav.h; j += 2) for (let i = 0; i < nav.w; i += 2) {
      const k = j * nav.w + i; if (!nav.A[k] && !nav.B[k]) continue;
      const x = nav.x0 + (i + 0.5) * nav.cell, z = -(nav.y0 + (j + 0.5) * nav.cell);
      const gi = Math.floor((x - X0) / C), gj = Math.floor((z - Z0) / C); if (gi >= 0 && gj >= 0 && gi < W && gj < H) g[gj * W + gi] = 1;
    }
    for (let gj = 0; gj < H; gj++) for (let gi = 0; gi < W; gi++) { const x = X0 + (gi + 0.5) * C, z = Z0 + (gj + 0.5) * C; if (lake.length && inPoly(lake, x, -z)) g[gj * W + gi] = 1; }
    for (let pass = 0; pass < 2; pass++) {          // dilate twice (8 m)
      const src = g.slice();
      for (let gj = 0; gj < H; gj++) for (let gi = 0; gi < W; gi++) {
        if (src[gj * W + gi]) continue;
        for (let dj = -1; dj <= 1 && !g[gj * W + gi]; dj++) for (let di = -1; di <= 1; di++) { const a = gi + di, b = gj + dj; if (a >= 0 && b >= 0 && a < W && b < H && src[b * W + a]) { g[gj * W + gi] = 1; break; } }
      }
    }
    // perimeter: an edge between a reachable and an unreachable cell gets a wall facing into the reachable side
    perimeter = [];
    const R = (i, j) => i >= 0 && j >= 0 && i < W && j < H && g[j * W + i] === 1;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!R(i, j)) continue;
      const x0 = X0 + i * C, z0 = Z0 + j * C, x1 = x0 + C, z1 = z0 + C;
      if (!R(i - 1, j)) perimeter.push([x0, z1, x0, z0]);     // wall on the west edge, facing +x (each segment's direction sets its facing)
      if (!R(i + 1, j)) perimeter.push([x1, z0, x1, z1]);
      if (!R(i, j - 1)) perimeter.push([x0, z0, x1, z0]);
      if (!R(i, j + 1)) perimeter.push([x1, z1, x0, z1]);
    }
    // lake bed: 4 m cells inside the lake or within 6 m of its edge (so the bed reaches under the quays)
    bed = [];
    if (lake.length) for (let gj = 0; gj < H; gj++) for (let gi = 0; gi < W; gi++) {
      const x = X0 + (gi + 0.5) * C, z = Z0 + (gj + 0.5) * C;
      if (Math.hypot(x, z) > 140) continue;
      if (inPoly(lake, x, -z) || distToPoly(lake, x, -z) < 6) bed.push([X0 + gi * C, Z0 + gj * C]);
    }
    st.perimeter = perimeter.length; st.bedCells = bed.length;
  }
  const inReach = (x, z) => { const i = Math.floor((x - X0) / reach.cell), j = Math.floor((z - Z0) / reach.cell); return !!(reach.g && i >= 0 && j >= 0 && i < reach.w && j < reach.h && reach.g[j * reach.w + i]); };

  // ── 2. gather a window ──
  const BED_Y = water - 4.0;
  // gatherSteps: a generator that yields whenever `budgetMs` of work is done (the caller resumes it next frame);
  // gather(): the same, run to the end at once.
  function gather(cx, cz, R = 30) { const it = gatherSteps(cx, cz, R, Infinity); let r; do r = it.next(); while (!r.done); return r.value; }
  function* gatherSteps(cx, cz, R = 30, budgetMs = 3) {
    const t0 = performance.now(); let tS = t0, work = 0;
    const out = []; let n = 0;
    let buf = new Int32Array(11 * 65536);
    const emit = (type, terrain, x1, y1, z1, x2, y2, z2, x3, y3, z3) => {
      if ((n + 1) * 11 > buf.length) { const b2 = new Int32Array(buf.length * 2); b2.set(buf); buf = b2; }
      const o = n * 11; buf[o] = type & 0xffff; buf[o + 1] = terrain;
      const X1 = buf[o + 2] = Math.round(x1 * UNITS), Y1 = buf[o + 3] = Math.round(y1 * UNITS), Z1 = buf[o + 4] = Math.round(z1 * UNITS);
      const X2 = buf[o + 5] = Math.round(x2 * UNITS), Y2 = buf[o + 6] = Math.round(y2 * UNITS), Z2 = buf[o + 7] = Math.round(z2 * UNITS);
      const X3 = buf[o + 8] = Math.round(x3 * UNITS), Y3 = buf[o + 9] = Math.round(y3 * UNITS), Z3 = buf[o + 10] = Math.round(z3 * UNITS);
      // rounding to whole units can collapse a sliver: the library rejects those, so do not send them
      const ux = X2 - X1, uy = Y2 - Y1, uz = Z2 - Z1, vx = X3 - X1, vy = Y3 - Y1, vz = Z3 - Z1;
      if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) return;
      n++;
    };
    const counts = { floors: 0, flipped: 0, walls: 0, ceils: 0, ice: 0, perimeter: 0, bed: 0 };
    const doTri = (ref) => {
      const mi = ref >>> 22, t = (ref & 0x3fffff) * 3, m = meshes[mi], g = m.geometry, p = g.attributes.position.array, idx = g.index.array, s = m.scale.x, o = m.position;
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = o.x + p[a] * s, ay = o.y + p[a + 1] * s, az = o.z + p[a + 2] * s;
      const bx = o.x + p[b] * s, by = o.y + p[b + 1] * s, bz = o.z + p[b + 2] * s;
      const qx = o.x + p[c] * s, qy = o.y + p[c + 1] * s, qz = o.z + p[c + 2] * s;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, yn = ny / Math.hypot(nx, ny, nz);
      let type = 0, terrain = TERRAIN_STONE;
      if (Math.abs(yn) > 0.5) {
        // terrain + surface type by place: Frostmere's rink is ice, its open ground snow
        if (FF) {
          const mx = (ax + bx + qx) / 3, mz = (az + bz + qz) / 3, [lx, ly] = toLocal(FF, mx, -mz);
          if (Math.abs(lx) < 90 && Math.abs(ly) < 90) {
            const ex = (lx - RINK[0]) / RINK[2], ey = (ly - RINK[1]) / RINK[3];
            if (ex * ex + ey * ey < 1 && Math.abs(Math.max(ay, by, qy) - (Math.min(ay, by, qy))) < 0.05 && yn > 0) { type = SURF_ICE; counts.ice++; }
            else if (g.attributes.aAux) { const cls = g.attributes.aAux.array[idx[t] * 4 + 3]; if (cls === 4) terrain = TERRAIN_SNOW; }
          }
        }
        if (yn > 0) { emit(type, terrain, ax, ay, az, bx, by, bz, qx, qy, qz); counts.floors++; }
        else { emit(0, terrain, ax, ay, az, bx, by, bz, qx, qy, qz); counts.ceils++; if (flipDown) { emit(type, terrain, ax, ay, az, qx, qy, qz, bx, by, bz); counts.flipped++; } }
      } else { emit(0, terrain, ax, ay, az, bx, by, bz, qx, qy, qz); counts.walls++; }
    };
    // buckets hold triangles by centroid and no kept triangle is wider than a bucket, so a half-bucket margin covers
    // every triangle that reaches into the window
    const M = BUCKET / 2;
    const i0 = Math.max(0, Math.floor((cx - R - M - X0) / BUCKET)), i1 = Math.min(NBX - 1, Math.floor((cx + R + M - X0) / BUCKET));
    const j0 = Math.max(0, Math.floor((cz - R - M - Z0) / BUCKET)), j1 = Math.min(NBZ - 1, Math.floor((cz + R + M - Z0) / BUCKET));
    let active = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const b = j * NBX + i;
      for (let k = bucketStart[b]; k < bucketStart[b + 1]; k++) {
        doTri(refs[k]);
        if ((++work & 1023) === 0 && performance.now() - tS > budgetMs) { active += performance.now() - tS; yield; tS = performance.now(); }
      }
    }
    for (const ref of big) {           // wide triangles: only if their bbox meets the window
      const mi = ref >>> 22, t = (ref & 0x3fffff) * 3, m = meshes[mi], g = m.geometry, p = g.attributes.position.array, idx = g.index.array, s = m.scale.x, o = m.position;
      let xa = 1e9, xb = -1e9, za = 1e9, zb = -1e9;
      for (let q = 0; q < 3; q++) { const v = idx[t + q] * 3, x = o.x + p[v] * s, z = o.z + p[v + 2] * s; xa = Math.min(xa, x); xb = Math.max(xb, x); za = Math.min(za, z); zb = Math.max(zb, z); }
      if (xb >= cx - R && xa <= cx + R && zb >= cz - R && za <= cz + R) doTri(ref);
    }
    // perimeter walls (60 m tall, from 15 m below the water) facing into the park
    for (const [x0, z0, x1, z1] of perimeter) {
      if (Math.max(x0, x1) < cx - R || Math.min(x0, x1) > cx + R || Math.max(z0, z1) < cz - R || Math.min(z0, z1) > cz + R) continue;
      const yb = -15, yt = 45;
      // quad (p0 bottom, p1 bottom, p1 top, p0 top) faces the reachable side for the segment directions chosen above
      emit(0, TERRAIN_STONE, x0, yb, z0, x1, yb, z1, x1, yt, z1); emit(0, TERRAIN_STONE, x0, yb, z0, x1, yt, z1, x0, yt, z0); counts.perimeter += 2;
    }
    // lake bed
    for (const [x0, z0] of bed) {
      if (x0 + 4 < cx - R || x0 > cx + R || z0 + 4 < cz - R || z0 > cz + R) continue;
      const x1 = x0 + 4, z1 = z0 + 4;
      emit(0, TERRAIN_WATER, x0, BED_Y, z1, x1, BED_Y, z1, x1, BED_Y, z0); emit(0, TERRAIN_WATER, x0, BED_Y, z1, x1, BED_Y, z0, x0, BED_Y, z0); counts.bed += 2;
    }
    const packed = buf.slice(0, n * 11);
    active += performance.now() - tS;
    st.lastGather = { ms: Math.round(active * 10) / 10, wall: Math.round((performance.now() - t0)), count: n, ...counts, cx, cz, R };
    return { packed, count: n, stats: st.lastGather };
  }
  return { prepareSteps, gather, gatherSteps, stats: st, inReach, lakeContains: (x, z) => lake.length > 2 && inPoly(lake, x, -z), bedY: BED_Y, waterY: water, bounds: { X0, X1, Z0, Z1 } };
}
