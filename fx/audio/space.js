// Where the listener is, in sound terms: zone weights (which ambience and how much of it), the reverb of the place,
// the ground under the walker's feet and how crowded it is nearby. All in the Blender frame (x east, y north, z up),
// pure functions of position, cheap enough to run every frame.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The park: Stillwater is roughly an ellipse (a 100 m east-west, b 63 m north-south, centred on the Spire); seven
// lands are sectors of the ring round it (centres and angles from data/manifest.json); the East Gate avenue runs along
// y = 0 from x = 108 to 338 between the Wanderers' Hall and Brinewatch; the green gaps are the ring between lands.
export function makeZoner(lands) {
  const L = lands.map((l) => ({ id: l.id, phi: Math.atan2(l.center[1], l.center[0]), c: l.center }));
  const ids = [...L.map((l) => l.id), 'lake', 'gate', 'gap'];
  const out = Object.fromEntries(ids.map((k) => [k, 0]));
  // weights at ground point (x, y): sums to 1 over lands + lake + gate + gap
  function weights(x, y) {
    const r = Math.hypot(x, y), re = Math.hypot(x / 100, y / 63), phi = Math.atan2(y, x);
    const lake = 1 - smoothstep(0.92, 1.3, re);
    const ring = smoothstep(0.95, 1.45, re) * (1 - smoothstep(270, 340, r));
    const wide = Math.max(0, x - 225) * 0.5;
    const gate = Math.exp(-((y / (13 + wide)) ** 2)) * smoothstep(108, 150, x);
    let sum = lake + gate;
    for (const l of L) { const d = wrap(phi - l.phi), a = Math.exp(-((d / 0.30) ** 2)) * ring * (1 - 0.85 * gate); out[l.id] = a; sum += a; }
    const gap = 0.22 * ring + 0.35 * (1 - ring) * (1 - lake) + 0.02;                // the green ring between lands; open ground outside the park
    out.lake = lake; out.gate = gate; out.gap = gap; sum += gap;
    for (const k of ids) out[k] /= sum;
    return out;
  }
  return { ids, weights };
}

// Reverb sends for a ground point: [short/bright, long/dark] send levels. Long in the Wanderers' glass pavilion and
// the castle courtyard, short and bright on Meridian's plaza, nearly dry on the open lake.
const HALL = [167.6, 59.7, 30], COURT = [-186, 0, 45], PLAZA = [30, 140, 45];
export function reverbFor(w, x, y, air) {
  const near = (p) => 1 - smoothstep(p[2] * 0.6, p[2], Math.hypot(x - p[0], y - p[1]));
  let short = 0.10, long = 0.07;
  short += 0.30 * (w.meridian || 0) + 0.30 * near(PLAZA);
  long += 0.25 * (w.wanderers || 0) * 0.5 + 0.38 * near(HALL) + 0.22 * (w.guildhollow || 0) + 0.18 * near(COURT);
  short += 0.06 * ((w['lantern-row'] || 0) + (w.brinewatch || 0));
  const dry = 1 - 0.85 * (w.lake || 0);                                            // open water: almost no reflections
  short *= dry; long *= dry;
  return [short * (1 - air), long * (1 - air) + 0.12 * air];                        // from the air: only a far, soft wash
}

// Surface under the feet. With a ground-class grid (guests-data's guestground.bin: 0 none, 1 paved, 2 lawn, 3 bed,
// 4 gravel, 5 wood, 6 snow, 7 ice, 8 floor, 9 stairs, 10 bridge, 11 pier, 12 water) the cell decides; otherwise a guess
// from the land and the walk height (paving sits at z ~ 0.12, lawns ~ 0.06; piers stand in the lake).
const CLASS_SOUND = ['stone', 'stone', 'grass', 'grass', 'gravel', 'wood', 'snow', 'stone', 'wood', 'stone', 'wood', 'wood', 'splash'];
export function groundType(x, y, z, w, grid, inLake) {
  if (grid) {
    const i = Math.floor((x - grid.x0) / grid.cell), j = Math.floor((y - grid.y0) / grid.cell);
    if (i >= 0 && j >= 0 && i < grid.w && j < grid.h) { const c = grid.data[j * grid.w + i]; if (c) return CLASS_SOUND[c] || 'stone'; }
  }
  if (inLake && inLake(x, y)) return 'wood';
  if ((w.frostmere || 0) > 0.45) return 'snow';
  if ((w.brinewatch || 0) > 0.45 && z < 0.5) return 'wood';
  if ((w['lantern-row'] || 0) > 0.5 && z < 0.1) return 'gravel';
  if (z > 0.02 && z < 0.095) return 'grass';
  return 'stone';
}

// How many people are near: 0 (nobody) .. 1 (packed). Without a crowd, a map of where a park is busy: the gate plaza
// and the avenue, the lake rail, the land hearts. With the guests' crowd state (stride 8: x, y, z, yaw, speed, anim,
// phase, seed; anim 255 = unused) a coarse grid of 8 m cells is recounted a few times a second.
export function makeDensity(lands) {
  const hearts = lands.map((l) => [l.center[0] * 0.92, l.center[1] * 0.92]);
  const G = { x0: -280, y0: -230, cell: 8, w: 80, h: 58 }, grid = new Float32Array(G.w * G.h);
  let crowd = null, timer = 0, have = false;
  function fallback(x, y) {
    let d = 0;
    if (x > 108 && x < 345) d = Math.max(d, Math.exp(-((y / 9) ** 2)) * (0.55 + 0.45 * Math.exp(-(((x - 255) / 40) ** 2))));
    const re = Math.hypot(x / 100, y / 63); d = Math.max(d, 0.5 * Math.exp(-(((re - 1.05) / 0.07) ** 2)));
    for (const h of hearts) d = Math.max(d, 0.7 * Math.exp(-((Math.hypot(x - h[0], y - h[1]) / 32) ** 2)));
    return d;
  }
  function recount() {
    grid.fill(0); const s = crowd.state, n = crowd.count ?? (s.length >> 3);
    for (let k = 0; k < n; k++) {
      const o = k * 8; if (s[o + 5] === 255) continue;
      const i = Math.floor((s[o] - G.x0) / G.cell), j = Math.floor((s[o + 1] - G.y0) / G.cell);
      if (i >= 0 && j >= 0 && i < G.w && j < G.h) grid[j * G.w + i]++;
    }
    have = true;
  }
  function fromGrid(x, y) {        // people within ~20 m, weighted by distance, mapped to 0..1 (40 people = busy)
    const ci = (x - G.x0) / G.cell - 0.5, cj = (y - G.y0) / G.cell - 0.5; let n = 0;
    for (let j = Math.floor(cj) - 3; j <= Math.floor(cj) + 3; j++) for (let i = Math.floor(ci) - 3; i <= Math.floor(ci) + 3; i++) {
      if (i < 0 || j < 0 || i >= G.w || j >= G.h) continue;
      const d = Math.hypot(i - ci, j - cj) * G.cell; n += grid[j * G.w + i] * Math.exp(-((d / 14) ** 2));
    }
    const pop = typeof crowd.active === 'number' && crowd.active > 0 ? crowd.active : (crowd.count || 2400);
    return 1 - Math.exp(-(n * 2400 / Math.max(300, pop)) / 28);       // phones draw fewer guests: same busy-ness
  }
  return {
    setCrowd(c) { crowd = c && c.state ? c : null; have = false; },
    get live() { return !!crowd; },
    at(x, y, dt) {
      if (crowd) { timer -= dt; if (timer <= 0) { timer = 0.25; recount(); } if (have) return fromGrid(x, y); }
      return fallback(x, y);
    },
  };
}
