// The Platformer's simulation thread: the movement library (sm64.wasm), the current collision window, camera rays.
// Messages in:  init | surfaces {packed, count, seq} | spawn {x, y, z, yaw, action?} | tick {input, water, cam?} | teleport {...}
// Messages out: ready {layout} | loaded {seq, count, ms} | state {...} | error {message}
import { loadSM64 } from './sm64.js';
import { animTable } from './anims.js';

let sm = null, id = -1, ray = null, tickMs = 0, loadMs = 0;
const post = (m, t) => self.postMessage(m, t || []);

// camera rays: a 2 m grid over the window's triangles (x/z), segment test per cell along the ray
function buildRayGrid(P, n) {
  const C = 200; let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) { const o = i * 11 + 2; for (let k = 0; k < 9; k += 3) { const x = P[o + k], z = P[o + k + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } }
  const W = Math.max(1, Math.ceil((x1 - x0) / C) + 1), H = Math.max(1, Math.ceil((z1 - z0) / C) + 1);
  const cnt = new Uint32Array(W * H + 1), cells = (i, fn) => {
    const o = i * 11 + 2; const xa = Math.min(P[o], P[o + 3], P[o + 6]), xb = Math.max(P[o], P[o + 3], P[o + 6]), za = Math.min(P[o + 2], P[o + 5], P[o + 8]), zb = Math.max(P[o + 2], P[o + 5], P[o + 8]);
    for (let j = Math.floor((za - z0) / C); j <= Math.floor((zb - z0) / C); j++) for (let k = Math.floor((xa - x0) / C); k <= Math.floor((xb - x0) / C); k++) fn(j * W + k);
  };
  for (let i = 0; i < n; i++) cells(i, (c) => cnt[c + 1]++);
  for (let c = 0; c < W * H; c++) cnt[c + 1] += cnt[c];
  const items = new Uint32Array(cnt[W * H]), fill = cnt.slice(0, W * H);
  for (let i = 0; i < n; i++) cells(i, (c) => { items[fill[c]++] = i; });
  ray = { P, n, C, x0, z0, W, H, start: cnt, items, stamp: new Uint32Array(n), sid: 0 };
}
// nearest hit fraction along a -> b (library units), 1 = clear; both faces count
function castRay(ax, ay, az, bx, by, bz) {
  if (!ray) return 1;
  const R = ray, P = R.P; let best = 1; if (++R.sid === 0xffffffff) { R.stamp.fill(0); R.sid = 1; }
  const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dz), steps = Math.max(1, Math.ceil(len / (R.C * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, x = ax + dx * t, z = az + dz * t;
    const ci = Math.floor((x - R.x0) / R.C), cj = Math.floor((z - R.z0) / R.C);
    if (ci < 0 || cj < 0 || ci >= R.W || cj >= R.H) continue;
    const c = cj * R.W + ci;
    for (let q = R.start[c]; q < R.start[c + 1]; q++) {
      const i = R.items[q]; if (R.stamp[i] === R.sid) continue; R.stamp[i] = R.sid;
      const o = i * 11 + 2;
      // Moller-Trumbore, two-sided
      const e1x = P[o + 3] - P[o], e1y = P[o + 4] - P[o + 1], e1z = P[o + 5] - P[o + 2], e2x = P[o + 6] - P[o], e2y = P[o + 7] - P[o + 1], e2z = P[o + 8] - P[o + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-6) continue;
      const inv = 1 / det, tx = ax - P[o], ty = ay - P[o + 1], tz = az - P[o + 2], u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv; if (tt > 0 && tt < best) best = tt;
    }
  }
  return best;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      sm = await loadSM64(m.wasm || new URL('./sm64.wasm', import.meta.url));
      sm.init(animTable());
      post({ type: 'ready', layout: sm.layout, memory: sm.memoryBytes });
    } else if (m.type === 'surfaces') {
      const t0 = performance.now();
      sm.loadSurfaces(m.packed, m.count);
      loadMs = performance.now() - t0;
      const old = ray && ray.P;
      buildRayGrid(m.packed, m.count);
      // the previous window's buffer goes back to the main thread for reuse (the current one stays for camera rays)
      post({ type: 'loaded', seq: m.seq, count: m.count, ms: Math.round(loadMs * 10) / 10, rayMs: Math.round((performance.now() - t0 - loadMs) * 10) / 10, memory: sm.memoryBytes, back: old ? old.buffer : null }, old ? [old.buffer] : []);
    } else if (m.type === 'spawn' || m.type === 'teleport') {
      if (id < 0) id = sm.create(m.x, m.y, m.z);
      sm.setPosition(id, m.x, m.y, m.z); sm.setVelocity(id, 0, 0, 0); sm.setForwardVel(id, 0);
      if (m.yaw !== undefined) sm.setFaceAngle(id, m.yaw);
      sm.setAction(id, m.action ?? 0x0C400201);
      sm.setInvincibility(id, 0);
    } else if (m.type === 'tick') {
      if (id < 0) return;
      const t0 = performance.now();
      Object.assign(sm.input, m.input);
      sm.setWaterLevel(id, m.water);
      sm.setHealth(id, 0x880);                       // no damage, no drowning, no death sequences in the park
      const s = sm.tick(id);
      let cam = 1;
      if (m.cam) cam = castRay(...m.cam);
      tickMs = tickMs * 0.9 + (performance.now() - t0) * 0.1;
      post({ type: 'state', seq: m.seq, cam, tickMs, s: { ...s, pos: s.pos.slice(), vel: s.vel.slice(), floorN: s.floorN.slice() } });
    }
  } catch (err) { post({ type: 'error', message: String(err && err.stack || err) }); }
};
