// Guests: navigation preprocessing on the walk grid (pure JS: runs on the main thread, in a Worker or in Node).
//
// Input: the viewer's decoded walk grid `{w, h, x0, y0, cell, A, B}` (0.5 m cells, Uint16 height codes, 0 = not
// walkable, height = (code - 1) / 100 - 2). Only level A is used: guests walk on the lower level.
//
// Built here:
//  - `clr`   fine grid (0.5 m) clearance: chamfer distance from a cell centre to the nearest blocked cell centre, in
//            units of 1/6 m (3 per cell, 4 per diagonal), capped at 255 (42 m). A cell is blocked when it is not
//            walkable or when a 4-neighbour is lower by more than STEP (the top of a ledge: a seat, a stage edge, a terrace).
//  - coarse grid (1 m, 2 x 2 fine cells): passable cells get a compact index; each stores the height and fine cell
//            of its most open fine cell, and an integer travel cost (paving 1, lawn 3, bare ground 2, plus a penalty
//            near obstacles so routes keep to the middle of paths).
//  - flow fields (`field()`): multi-source Dijkstra (bucket queue) on the coarse grid; per passable cell the
//            direction (0..7) of the next cell toward the nearest source, 8 at a source, 255 unreachable. Optional
//            window (local fields around one point of interest).
export const STEP = 0.36;            // m: largest height step between neighbouring fine cells a guest walks over
export const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];   // the 8 directions (coarse cells)

const navH = (v) => (v - 1) / 100 - 2;

export function buildNav(nav, opt = {}) {
  const t0 = now();
  const W = nav.w, H = nav.h, A = nav.A, n = W * H;
  // ── blocked fine cells ──
  const clr = new Uint8Array(n);                 // first used as the blocked mask (0 blocked, 255 free)
  for (let k = 0; k < n; k++) clr[k] = A[k] ? 255 : 0;
  const stepCode = Math.round((opt.step || STEP) * 100);
  for (let j = 0; j < H; j++) {
    const r = j * W;
    for (let i = 0; i < W; i++) {
      const k = r + i, a = A[k]; if (!a) continue;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) { clr[k] = 0; continue; }
      const e = A[k + 1], s = A[k + W];
      // a ledge blocks its upper side only (a bench seat, a stage, a terrace edge): guests may stand right below it
      if (e && Math.abs(e - a) > stepCode) { if (e > a) clr[k + 1] = 0; else clr[k] = 0; }
      if (s && Math.abs(s - a) > stepCode) { if (s > a) clr[k + W] = 0; else clr[k] = 0; }
    }
  }
  // ── chamfer 3-4 distance transform, two passes ──
  for (let j = 1; j < H - 1; j++) {
    const r = j * W;
    for (let i = 1; i < W - 1; i++) {
      const k = r + i; let d = clr[k]; if (!d) continue;
      let v = clr[k - 1] + 3; if (v < d) d = v;
      v = clr[k - W] + 3; if (v < d) d = v;
      v = clr[k - W - 1] + 4; if (v < d) d = v;
      v = clr[k - W + 1] + 4; if (v < d) d = v;
      clr[k] = d;
    }
  }
  for (let j = H - 2; j > 0; j--) {
    const r = j * W;
    for (let i = W - 2; i > 0; i--) {
      const k = r + i; let d = clr[k]; if (!d) continue;
      let v = clr[k + 1] + 3; if (v < d) d = v;
      v = clr[k + W] + 3; if (v < d) d = v;
      v = clr[k + W + 1] + 4; if (v < d) d = v;
      v = clr[k + W - 1] + 4; if (v < d) d = v;
      clr[k] = d;
    }
  }
  const t1 = now();
  // ── coarse grid ──
  const cw = W >> 1, ch = H >> 1, cn = cw * ch;
  const cidx = new Int32Array(cn).fill(-1);
  const PASS = 4;                                 // best fine cell at least a diagonal away from any blocked cell (0.42 m to its edge)
  let m = 0;
  const bestOf = new Int32Array(cn);
  for (let J = 0; J < ch; J++) for (let I = 0; I < cw; I++) {
    const k0 = (2 * J) * W + 2 * I; let bk = k0, bv = clr[k0];
    let v = clr[k0 + 1]; if (v > bv) { bv = v; bk = k0 + 1; }
    v = clr[k0 + W]; if (v > bv) { bv = v; bk = k0 + W; }
    v = clr[k0 + W + 1]; if (v > bv) { bv = v; bk = k0 + W + 1; }
    const K = J * cw + I; bestOf[K] = bk;
    if (bv >= PASS) cidx[K] = m++;
  }
  const ccell = new Int32Array(m), cfine = new Int32Array(m), chgt = new Float32Array(m), ccost = new Uint8Array(m), csurf = new Uint8Array(m);
  for (let K = 0; K < cn; K++) {
    const c = cidx[K]; if (c < 0) continue;
    const fk = bestOf[K], h = navH(A[fk]);
    ccell[c] = K; cfine[c] = fk; chgt[c] = h;
    const surf = h < 0.045 ? 2 : (h < 0.09 ? 1 : 0);           // 0 paving / floors, 1 lawn, 2 bare ground (outer berm path, low shore)
    csurf[c] = surf;
    const e = clr[fk] / 6 - 0.25;                                // m from the best spot to the nearest obstacle edge
    const base = surf === 0 ? 1 : surf === 1 ? 3.2 : 2.2;
    const pen = Math.max(0, 1.4 - e) * 1.3;
    ccost[c] = Math.min(255, Math.round(10 * (base + pen)));
  }
  // neighbour mask per compact cell (bit d set = may step in direction d), with a height-step limit and no corner cutting
  const cnb = new Uint8Array(m);
  const CSTEP = opt.cstep || 0.6;
  for (let c = 0; c < m; c++) {
    const K = ccell[c], I = K % cw, J = (K / cw) | 0; let mask = 0;
    for (let d = 0; d < 8; d++) {
      const I2 = I + DX[d], J2 = J + DY[d]; if (I2 < 0 || J2 < 0 || I2 >= cw || J2 >= ch) continue;
      const c2 = cidx[J2 * cw + I2]; if (c2 < 0) continue;
      if (Math.abs(chgt[c2] - chgt[c]) > CSTEP) continue;
      if (d & 1) { if (cidx[J * cw + I2] < 0 || cidx[J2 * cw + I] < 0) continue; }
      mask |= 1 << d;
    }
    cnb[c] = mask;
  }
  const t2 = now();
  const N = { W, H, x0: nav.x0, y0: nav.y0, cell: nav.cell, A, clr, cw, ch, cidx, m, ccell, cfine, chgt, ccost, csurf, cnb,
    times: { clearance: t1 - t0, coarse: t2 - t1 } };
  return N;
}

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

// coarse cell (compact index) under a Blender-frame point, or -1
export function cellAt(N, x, y) {
  const I = Math.floor((x - N.x0) / (2 * N.cell)), J = Math.floor((y - N.y0) / (2 * N.cell));
  if (I < 0 || J < 0 || I >= N.cw || J >= N.ch) return -1;
  return N.cidx[J * N.cw + I];
}
// nearest passable coarse cell within r cells (spiral search), or -1
export function nearestCell(N, x, y, r = 6) {
  const I0 = Math.floor((x - N.x0) / (2 * N.cell)), J0 = Math.floor((y - N.y0) / (2 * N.cell));
  let best = -1, bd = 1e9;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const I = I0 + di, J = J0 + dj; if (I < 0 || J < 0 || I >= N.cw || J >= N.ch) continue;
    const c = N.cidx[J * N.cw + I]; if (c < 0) continue;
    const d = di * di + dj * dj; if (d < bd) { bd = d; best = c; }
  }
  return best;
}
// centre of a coarse cell (Blender x, y)
export function cellX(N, c) { return N.x0 + ((N.ccell[c] % N.cw) + 0.5) * 2 * N.cell; }
export function cellY(N, c) { return N.y0 + (((N.ccell[c] / N.cw) | 0) + 0.5) * 2 * N.cell; }

// Connected components of the coarse graph (Int32 label per compact cell); label of the biggest is returned too.
export function components(N) {
  const lab = new Int32Array(N.m).fill(-1), stack = new Int32Array(N.m); let nl = 0;
  const sizes = [];
  for (let s = 0; s < N.m; s++) {
    if (lab[s] >= 0) continue;
    let sp = 0; stack[sp++] = s; lab[s] = nl; let size = 0;
    while (sp) {
      const c = stack[--sp]; size++;
      const K = N.ccell[c], I = K % N.cw, J = (K / N.cw) | 0, mask = N.cnb[c];
      for (let d = 0; d < 8; d++) if (mask & (1 << d)) {
        const c2 = N.cidx[(J + DY[d]) * N.cw + I + DX[d]];
        if (lab[c2] < 0) { lab[c2] = nl; stack[sp++] = c2; }
      }
    }
    sizes.push(size); nl++;
  }
  return { lab, sizes };
}

// Flow field toward `sources` (array of compact cells). `win` = {I0, J0, I1, J1} limits the search to a coarse-cell
// window (local fields). Returns Uint8Array(N.m) (global) or, windowed, {I0, J0, w, h, dir: Uint8Array(w*h)} indexed by
// window cell. Dijkstra with a bucket queue (integer costs; linked lists in typed arrays, reused between calls).
const INF = 0xFFFFFFFF, NB = 256;
let Q = null;
function queue(n) {
  if (!Q || Q.cap < n) Q = { cap: n, next: new Int32Array(n), cell: new Int32Array(n), head: new Int32Array(NB) };
  return Q;
}
export function field(N, sources, win = null) {
  const cw = N.cw, cidx = N.cidx, ccell = N.ccell, cnb = N.cnb, ccost = N.ccost;
  let I0 = 0, J0 = 0, ww = cw, wh = N.ch, size;
  if (win) { I0 = Math.max(0, win.I0); J0 = Math.max(0, win.J0); ww = Math.min(cw, win.I1) - I0; wh = Math.min(N.ch, win.J1) - J0; size = ww * wh; }
  else size = N.m;
  const dir = new Uint8Array(size).fill(255), dist = new Uint32Array(size).fill(INF);
  const q = queue(Math.max(1024, size * 3)); let used = 0;
  const head = q.head; head.fill(-1);
  let next = q.next, cellA = q.cell;
  const at = (c) => { if (!win) return c; const K = ccell[c], I = K % cw - I0, J = ((K / cw) | 0) - J0; return (I < 0 || J < 0 || I >= ww || J >= wh) ? -1 : J * ww + I; };
  let pending = 0;
  for (let i = 0; i < sources.length; i++) {
    const c = sources[i]; if (c < 0) continue;
    const s = at(c); if (s < 0 || dist[s] === 0) continue;
    dist[s] = 0; dir[s] = 8; cellA[used] = c; next[used] = head[0]; head[0] = used++; pending++;
  }
  let cur = 0;
  while (pending > 0) {
    const b = cur & (NB - 1), e = head[b];
    if (e < 0) { cur++; continue; }
    head[b] = next[e]; pending--;
    const c = cellA[e];
    const K = ccell[c], I = K % cw, J = (K / cw) | 0;
    const s = win ? (J - J0) * ww + (I - I0) : c;
    if (dist[s] !== cur) continue;                   // stale entry
    const mask = cnb[c], cc = ccost[c];
    for (let d = 0; d < 8; d++) {
      if (!(mask & (1 << d))) continue;
      const I2 = I + DX[d], J2 = J + DY[d];
      let s2;
      const c2 = cidx[J2 * cw + I2];
      if (win) { const i2 = I2 - I0, j2 = J2 - J0; if (i2 < 0 || j2 < 0 || i2 >= ww || j2 >= wh) continue; s2 = j2 * ww + i2; } else s2 = c2;
      let w = (cc + ccost[c2]) >> 1; if (d & 1) w = (w * 181) >> 7;   // diagonal: x 1.414
      const nd = cur + w;
      if (nd < dist[s2]) {
        dist[s2] = nd; dir[s2] = (d + 4) & 7;
        if (used >= q.cap) {                                        // grow the node pool
          const cap = q.cap * 2, n2 = new Int32Array(cap), c3 = new Int32Array(cap); n2.set(next); c3.set(cellA);
          q.cap = cap; q.next = next = n2; q.cell = cellA = c3;
        }
        const bb = nd & (NB - 1); cellA[used] = c2; next[used] = head[bb]; head[bb] = used++; pending++;
      }
    }
  }
  return win ? { I0, J0, w: ww, h: wh, dir } : dir;
}

// Direction stored for compact cell c in a field (global Uint8Array or windowed object), 255 if none
export function fieldDir(N, f, c) {
  if (c < 0) return 255;
  if (f.dir === undefined) return f[c];
  const K = N.ccell[c], I = K % N.cw - f.I0, J = ((K / N.cw) | 0) - f.J0;
  if (I < 0 || J < 0 || I >= f.w || J >= f.h) return 255;
  return f.dir[J * f.w + I];
}
// the cell one step along direction d from compact cell c
export function stepCell(N, c, d) { const K = N.ccell[c]; return N.cidx[K + DY[d] * N.cw + DX[d]]; }

// ── fine-grid sampling ──
// clearance (m from the point to the nearest obstacle edge), bilinear over fine cell centres
export function clearance(N, x, y) {
  const fx = (x - N.x0) / N.cell - 0.5, fy = (y - N.y0) / N.cell - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= N.W - 1 || j >= N.H - 1) return -1;
  const u = fx - i, v = fy - j, k = j * N.W + i, c = N.clr;
  const a = c[k] + (c[k + 1] - c[k]) * u, b = c[k + N.W] + (c[k + N.W + 1] - c[k + N.W]) * u;
  return (a + (b - a) * v) / 6 * N.cell * 2 - 0.25;
}
// ground height under (x, y) on level A, or NaN where not walkable
export function ground(N, x, y) {
  const i = Math.floor((x - N.x0) / N.cell), j = Math.floor((y - N.y0) / N.cell);
  if (i < 0 || j < 0 || i >= N.W || j >= N.H) return NaN;
  const v = N.A[j * N.W + i]; return v ? (v - 1) / 100 - 2 : NaN;
}
// straight line from (x0, y0) to (x1, y1) keeps at least `r` m clearance (sampled every 0.25 m)
export function lineClear(N, x0, y0, x1, y1, r = 0.3) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / 0.25));
  for (let s = 0; s <= n; s++) { const t = s / n; if (clearance(N, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) < r) return false; }
  return true;
}
// faster line test for the per-frame code: nearest fine cell every 0.3 m, clearance threshold in chamfer units
export function lineClearQ(N, x0, y0, x1, y1, r = 0.3) {
  const thr = (r + 0.25) * 3 / N.cell, L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / 0.3));
  const ix = 1 / N.cell, W = N.W, H = N.H, clr = N.clr;
  for (let s = 0; s <= n; s++) {
    const t = s / n, i = ((x0 + (x1 - x0) * t - N.x0) * ix) | 0, j = ((y0 + (y1 - y0) * t - N.y0) * ix) | 0;
    if (i < 0 || j < 0 || i >= W || j >= H || clr[j * W + i] < thr) return false;
  }
  return true;
}
