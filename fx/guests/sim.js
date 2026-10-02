// Guests: the crowd simulation. Where park guests are, where they go and what they do.
//
//   const crowd = createCrowd({ nav, manifest, pois, count, seed, reduceMotion });
//   crowd.update(dt, time, focus);        // every frame; focus = {x, y, z, mode} of the camera / walker (Blender frame)
//   crowd.state                           // Float32Array, stride 8 per guest: [x, y, z, yaw, speed, anim, phase, seed]
//   crowd.count                           // number of guest slots in `state` (hidden slots have anim = 255)
//   crowd.setCount(n)                     // active guests wanted; changes are smooth (arrivals walk in at the gate,
//                                         // leavers walk out or vanish far from the camera)
//
// Blender frame: x east, y north, z up; yaw about +z, forward = (cos yaw, sin yaw). anim: 0 walk, 1 stand, 2 look /
// photo, 3 wave / point, 4 sit (z = seat height, yaw = facing), 5 lean on a rail, 255 hidden. phase: walking = distance
// / 1.4 m (one cycle = two steps); otherwise time-based (cycles at about 0.3 Hz). It wraps at 256.
//
// How it works: the walk grid is turned into a clearance field and a 1 m coarse graph (sim-nav.js); points of interest
// become sites with slots (sim-poi.js); sites are clustered into hubs and each hub gets a flow field (sim-prep.js, in
// a Worker). A guest picks a site, follows its hub's field (with a lookahead and a lane offset, keeping right), then the
// site's local field, walks straight to the slot's approach point, settles into the slot and does the activity. Groups
// of 2-4 walk in formation behind a leader and take neighbouring slots. Local avoidance: uniform hash grid, a few
// neighbours, time-to-collision steering plus separation; walls via the clearance field. Behaviour is updated every
// frame near the camera and every 2nd-8th frame farther away.
import { cellAt, nearestCell, cellX, cellY, clearance, ground, lineClearQ as lineClear, fget, DX, DY } from './sim-nav.js';
import { ANIM } from './sim-poi.js';
import { prepare, localField, mulberry, LOCAL_HALF } from './sim-prep.js';

export { ANIM };
const TAU = Math.PI * 2;
const PATH = new Int32Array(16);
const HB = 8191, hb = (x, y) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & HB;
const clrByte = (N, x, y) => { const i = ((x - N.x0) / N.cell) | 0, j = ((y - N.y0) / N.cell) | 0; return (i < 0 || j < 0 || i >= N.W || j >= N.H) ? 0 : N.clr[j * N.W + i]; };
const MIN_D = 0.42, LOCAL_MAX = 512, LOCAL_REQ = 110;              // m: walkers never closer than this to anyone (position correction)
// centre of the most open fine cell of a coarse cell
const fineX = (N, c) => N.x0 + ((N.cfine[c] % N.W) + 0.5) * N.cell, fineY = (N, c) => N.y0 + (((N.cfine[c] / N.W) | 0) + 0.5) * N.cell;
const wrapA = (a) => { if (a > Math.PI) { a -= TAU; if (a > Math.PI) a = ((a + Math.PI) % TAU) - Math.PI; } else if (a < -Math.PI) { a += TAU; if (a < -Math.PI) a = ((a - Math.PI) % TAU) + Math.PI; } return a; };

// tunables (exposed as crowd.params; read every frame)
export const PARAMS = {
  speedMin: 0.9, speedMax: 1.45,     // m/s, per-guest preferred walking speed
  turnRate: 2.4,                     // rad/s at walking speed (faster when standing)
  accel: 1.1, decel: 1.8,            // m/s^2
  radius: 0.24,                      // body radius used against walls
  personal: 0.75,                    // m, separation distance between walkers
  lane: 1.6,                         // m, max lane offset to the right of a route (keep right)
  lookahead: 3,                      // coarse cells along the flow field
  groupMix: [0.36, 0.36, 0.17, 0.11],// share of parties of 1, 2, 3, 4
  railShare: 0.3, siteShare: 0.5, walkShare: 0.14, leaveShare: 0.03,
  arrivalEvery: 3.5,                 // s between parties arriving at the gate (a party far from the camera leaves for each)
  reach: 45,                         // m: sites this far away are picked e^-1 as often as next-door ones
  lodNear: 35, lodMid: 90, lodFar: 200,    // m from the focus: think every 2 / 4 / 6 / 10 frames
  integrateNear: 25, integrateFar: 120,   // m: movement integrated every frame / every 2nd frame / only when thinking
  budget: 0.4,                       // ms per frame: the LOD distances shrink (down to 40 %) while the sim costs more
};

const ST = { OFF: 0, GO: 1, SETTLE: 2, ACT: 3, UNSETTLE: 4, QUEUE: 5, FOLLOW: 6, PAUSE: 7, WAIT: 8 };
const LAND_POP = { 'lantern-row': 1.35, meridian: 1.25, wanderers: 1.2, brinewatch: 1.1, frostmere: 1.0, rosewick: 0.95, guildhollow: 0.85, gate: 1.3, ring: 1, lake: 1 };

export function createCrowd({ nav, manifest, pois = null, count = 1200, seed = 1, reduceMotion = false, max = 0, ground: groundGrid = null, fetchBin = null, sync = false, manualLocal = false, onReady = null } = {}) {
  const CAP = Math.max(16, max || Math.ceil(Math.max(count, 400) * 1.7));
  const state = new Float32Array(CAP * 8);
  for (let i = 0; i < CAP; i++) state[i * 8 + 5] = 255;
  const params = { ...PARAMS };
  const debug = { ev: { goal: 0, spawn: 0, ghost: 0 }, ready: false, error: null, times: {}, frameMs: 0, frameMean: 0, frameMax: 0, frames: 0, overlaps: 0, inside: 0, counts: {}, thinkers: 0 };
  const crowd = { count: CAP, state, active: 0, want: Math.min(count, CAP), params, debug, ready: false,
    update() {}, setCount(n) { crowd.want = Math.max(0, Math.min(CAP, n | 0)); }, setReduceMotion(b) { reduceMotion = !!b; }, dispose() {} };
  if (!nav || !nav.A || !manifest) return crowd;

  let D = null, disposed = false;     // prepared data: {N, P, hubF}
  const local = new Map();            // site id -> local field (null while pending); at most LOCAL_MAX, least recently used go
  let LUSE = new Int32Array(1);       // frame a site's local field was last used
  let worker = null, pendingLocal = [];
  // every site object gets the same shape (fast, monomorphic property access in the per-frame code)
  const normSite = (o) => ({ id: o.id | 0, type: String(o.type), kind: String(o.kind), x: +o.x, y: +o.y, z: +o.z || 0, yaw: +o.yaw || 0, land: String(o.land || ''), cap: o.cap | 0,
    name: String(o.name || ''), hub: o.hub | 0, slots: Int32Array.from(o.slots), weight: +o.weight || 1, open: !!o.open, dance: !!o.dance, pop: LAND_POP[o.land] || 1 });
  const startSim = (prep) => { if (!prep.N.A) prep.N.A = nav.A; prep.P.sites = prep.P.sites.map(normSite); prep.P.gate = prep.P.sites[prep.P.gate.id]; D = prep; LUSE = new Int32Array(prep.P.sites.length); debug.times = prep.times; init(); debug.ready = crowd.ready = true; if (onReady) onReady(crowd); };

  // ── preparation: Worker when possible ──
  // the surface-class grid (data/guestground.bin) when guests.json names one: given, or fetched with the app's fetchBin
  let groundP = null;
  if (!groundGrid && !sync && pois && pois.ground && pois.ground.file && typeof fetchBin === 'function') {
    groundP = Promise.resolve().then(() => fetchBin(pois.ground.file)).then((u8) => ({ w: pois.ground.w, h: pois.ground.h, classes: pois.ground.classes, data: u8 })).catch(() => null);
  }
  const canWorker = !sync && typeof Worker !== 'undefined' && typeof window !== 'undefined';
  const start = () => {
  if (canWorker) {
    try {
      worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') startSim(m.prep);
        else if (m.type === 'local') { if (local.has(m.site)) { local.set(m.site, m.f); trimLocal(); } }
        else if (m.type === 'error') { debug.error = m.error; fallback(); }
      };
      worker.onerror = (e) => { debug.error = (e && e.message) || 'worker failed'; e.preventDefault && e.preventDefault(); fallback(); };
      worker.postMessage({ type: 'prepare', nav: { w: nav.w, h: nav.h, x0: nav.x0, y0: nav.y0, cell: nav.cell, A: nav.A }, manifest: { lake: manifest.lake, shore: manifest.shore, lands: manifest.lands, rail: manifest.rail }, pois, seed, ground: groundGrid });
    } catch (err) { worker = null; }
  }
  if (!worker) fallback();
  };
  function fallback() {
    if (D) return;
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; }
    // main thread, after the current frame
    const run = () => { try { startSim(prepare(nav, manifest, pois, seed, groundGrid)); } catch (err) { debug.error = String(err && err.stack || err); } };
    if (sync) run(); else setTimeout(run, 0);
  }
  function trimLocal() {                // forget the least recently used local fields beyond LOCAL_MAX
    while (local.size > LOCAL_MAX) {
      let old = -1, ou = 2147483647; for (const [k, v] of local) if (v && LUSE[k] < ou) { ou = LUSE[k]; old = k; }
      if (old < 0) break; local.delete(old);
    }
  }
  function requestLocal(site) {
    if (local.has(site)) { LUSE[site] = frameNo; return; }
    local.set(site, null); LUSE[site] = frameNo;
    if (worker) worker.postMessage({ type: 'local', site });
    else pendingLocal.push(site);
  }

  // ── agents (struct of arrays) ──
  const X = new Float32Array(CAP), Y = new Float32Array(CAP), Z = new Float32Array(CAP), YAW = new Float32Array(CAP), SPD = new Float32Array(CAP);
  const PH = new Float32Array(CAP), SEED = new Float32Array(CAP), ANI = new Uint8Array(CAP).fill(255), STT = new Uint8Array(CAP);
  const PREF = new Float32Array(CAP), DYAW = new Float32Array(CAP), DSPD = new Float32Array(CAP), LANE = new Float32Array(CAP), TIMER = new Float32Array(CAP);
  const SITE = new Int32Array(CAP).fill(-1), SLOT = new Int32Array(CAP).fill(-1), LEAD = new Int32Array(CAP).fill(-1), GI = new Uint8Array(CAP), GS = new Uint8Array(CAP);
  const MEM = new Int32Array(CAP * 4).fill(-1);       // a leader's followers
  const MODE = new Uint8Array(CAP), STUCK = new Float32Array(CAP), ACC = new Float32Array(CAP), LOD = new Uint8Array(CAP), SIDE = new Int8Array(CAP);
  const SX = new Float32Array(CAP), SY = new Float32Array(CAP), SZ = new Float32Array(CAP), ST0 = new Float32Array(CAP), STT2 = new Float32Array(CAP);   // settle glide
  const ZT = new Float32Array(CAP), VX = new Float32Array(CAP), VY = new Float32Array(CAP), PX = new Float32Array(CAP), PY = new Float32Array(CAP);
  const GK = new Int32Array(CAP).fill(-1), OCCK = new Int32Array(CAP).fill(-1), STMASK = new Uint16Array(CAP), JAM = new Float32Array(CAP), GHOST = new Float32Array(CAP);       // fine cell where a standing guest stamped the occupancy grid
  let OCC = null;                                    // Uint8 per fine cell: standing guests (walkers steer round them)
  const TX = new Float32Array(CAP), TY = new Float32Array(CAP), RT = new Float32Array(CAP), DFOC = new Float32Array(CAP), AVX = new Float32Array(CAP), AVY = new Float32Array(CAP);
  const LEAVING = new Uint8Array(CAP), TACC = new Float32Array(CAP), UX = new Float32Array(CAP), UY = new Float32Array(CAP);
  const rnd = mulberry(seed * 104729 + 7);
  let frameNo = 0, simTime = 0, lodK = 1, lodInv = 1, costEma = 0, calmed = false;
  const free = [];                    // pool of unused agent indices
  // hash grid (2 m cells) over the walk grid
  let HG = null, SG = null;

  function init() {
    const { N } = D;
    // neighbour grid: 2 m cells hashed into 8192 buckets (a small table that stays in cache; distances filter collisions)
    HG = { cs: 2, w: Math.ceil(N.W * N.cell / 2), h: Math.ceil(N.H * N.cell / 2), head: new Int32Array(HB + 1).fill(-1), next: new Int32Array(CAP) };
    OCC = new Uint8Array(N.W * N.H);
    for (let i = CAP - 1; i >= 0; i--) free.push(i);
    // site grid (30 m cells) for picking nearby goals
    SG = { cs: 30, x0: N.x0, y0: N.y0, w: Math.ceil(N.W * N.cell / 30), h: Math.ceil(N.H * N.cell / 30), cells: [], near: new Int32Array(1024) };
    for (let k = 0; k < SG.w * SG.h; k++) SG.cells.push([]);
    for (const site of D.P.sites) { if (!site.open) continue; const i = Math.floor((site.x - SG.x0) / 30), j = Math.floor((site.y - SG.y0) / 30); if (i >= 0 && j >= 0 && i < SG.w && j < SG.h) SG.cells[j * SG.w + i].push(site.id); }
    // paving cells of the main component, for scattering guests at the start (promenades weigh more)
    const { comp, main } = D.P;
    spawnCells = [];
    let acc = 0;
    for (let c = 0; c < N.m; c += 1) {
      if (comp.lab[c] !== main || N.csurf[c] !== 0) continue;
      const e = N.clr[N.cfine[c]] / 6 - 0.25; if (e < 1.0) continue;
      const x = cellX(N, c), y = cellY(N, c), r = Math.hypot(x / 160, y / 119);
      let w = 1;
      if (Math.abs(r - 1) < 0.05) w = 3.2;                         // ring promenade under the monorail
      else if (r < 0.75) w = 2.6;                                  // shore promenade
      if (x > 105 && Math.abs(y) < 10) w = 3.6;                    // the Lamplighters' Walk
      if (x > 262) w = 0.6;                                        // outside the gate
      acc += w; spawnCells.push(c, acc);
    }
    spawnTotal = acc;
    populate(crowd.want, true);
  }
  let spawnCells = [], spawnTotal = 0;
  function randomSpawnCell() {
    const r = rnd() * spawnTotal; let lo = 0, hi = (spawnCells.length >> 1) - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (spawnCells[mid * 2 + 1] < r) lo = mid + 1; else hi = mid; }
    return spawnCells[lo * 2];
  }

  // ── parties ──
  function partySize() { const g = params.groupMix, r = rnd() * (g[0] + g[1] + g[2] + g[3]); return r < g[0] ? 1 : r < g[0] + g[1] ? 2 : r < g[0] + g[1] + g[2] ? 3 : 4; }
  function newAgent(x, y, z, yaw) {
    const i = free.pop(); if (i === undefined) return -1;
    X[i] = x; Y[i] = y; Z[i] = z; ZT[i] = z; YAW[i] = yaw; DYAW[i] = yaw; SPD[i] = 0; DSPD[i] = 0; PH[i] = rnd() * 4; SEED[i] = rnd();
    PREF[i] = params.speedMin + (params.speedMax - params.speedMin) * rnd(); LANE[i] = (0.25 + 0.75 * rnd()) * params.lane;
    ANI[i] = ANIM.stand; STT[i] = ST.WAIT; TIMER[i] = 0.3 + rnd(); SITE[i] = -1; SLOT[i] = -1; LEAD[i] = -1; GI[i] = 0; GS[i] = 1; MODE[i] = 0;
    STUCK[i] = 0; JAM[i] = 0; GHOST[i] = 0; GK[i] = -1; ACC[i] = 0; LOD[i] = 1; SIDE[i] = rnd() < 0.5 ? 1 : -1; LEAVING[i] = 0; VX[i] = VY[i] = 0; AVX[i] = AVY[i] = 0; DFOC[i] = 0; PX[i] = x; PY[i] = y;
    for (let k = 0; k < 4; k++) MEM[i * 4 + k] = -1;
    crowd.active++; orderDirty = true;
    return i;
  }
  function removeAgent(i) {
    releaseSlot(i); if (OCCK[i] >= 0) stamp(i, false);
    STT[i] = ST.OFF; ANI[i] = 255; state[i * 8 + 5] = 255; SITE[i] = -1; LEAD[i] = -1; GS[i] = 1;
    for (let k = 0; k < 4; k++) MEM[i * 4 + k] = -1;
    free.push(i); crowd.active--; orderDirty = true;
  }
  function removeParty(L) { for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0 && STT[f] !== ST.OFF) removeAgent(f); } removeAgent(L); }
  // a party at (x, y): leader + followers in formation; returns the leader or -1
  function spawnParty(x, y, yaw, size) {
    if (free.length < size) return -1;
    const z = ground(D.N, x, y), L = newAgent(x, y, isFinite(z) ? z : 0.12, yaw);
    GS[L] = size;
    for (let k = 1; k < size; k++) {
      const o = formation(size, k, SIDE[L]);
      let fx = x + Math.cos(yaw) * -o[1] + Math.sin(yaw) * o[0], fy = y + Math.sin(yaw) * -o[1] - Math.cos(yaw) * o[0];   // FO is reused: read at once
      if (clearance(D.N, fx, fy) < 0.3) { fx = x - Math.cos(yaw) * 0.9 * k; fy = y - Math.sin(yaw) * 0.9 * k; }
      if (clearance(D.N, fx, fy) < 0.3) { fx = x + (rnd() - 0.5) * 0.2; fy = y + (rnd() - 0.5) * 0.2; }
      const fz = ground(D.N, fx, fy);
      const f = newAgent(fx, fy, isFinite(fz) ? fz : Z[L], yaw);
      LEAD[f] = L; GI[f] = k; GS[f] = size; PREF[f] = PREF[L]; MEM[L * 4 + k - 1] = f; STT[f] = ST.FOLLOW; LANE[f] = LANE[L];
    }
    // the party walks at its slowest member's pace (a shared speed)
    return L;
  }
  // formation offsets [right, back] of member k in a party of `size`
  const FO = new Float32Array(2);
  function formation(size, k, side) {
    let a, b;
    if (size === 2) { a = 0.72 * side; b = 0.08; }
    else if (size === 3) { a = (k === 1 ? 0.72 : -0.72) * side; b = 0.12; }
    else if (k === 1) { a = 0.72 * side; b = 0.08; } else if (k === 2) { a = 0; b = 1.05; } else { a = 0.72 * side; b = 1.15; }
    FO[0] = a; FO[1] = b; return FO;
  }

  // ── population ──
  function populate(n, initial) {
    let guard = 0;
    while (crowd.active < n && free.length && guard++ < 5000) {
      const size = Math.min(partySize(), n - crowd.active, free.length);
      if (initial) {
        // scatter: a share starts in place at a site (rail, bench, view, queue), the rest walking on paving
        const c = randomSpawnCell(); let x = cellX(D.N, c) + (rnd() - 0.5) * 0.6, y = cellY(D.N, c) + (rnd() - 0.5) * 0.6;
        if (clearance(D.N, x, y) < 0.5) { x = cellX(D.N, c); y = cellY(D.N, c); }
        const L = spawnParty(x, y, rnd() * TAU, size); if (L < 0) break;
        if (!pickGoal(L, 0)) { STT[L] = ST.WAIT; TIMER[L] = 1 + rnd() * 3; }
        else if (rnd() < (reduceMotion ? 0.85 : 0.5) && D.P.sites[SITE[L]].kind !== 'walk' && D.P.sites[SITE[L]].kind !== 'gate') placeAtSite(L);
      } else spawnArrival(size);
    }
  }
  function spawnArrival(size, atGate = false) {
    debug.ev.spawn++;
    // arrivals: at the gate when the camera is not there (they walk in), else somewhere far from the camera
    const g = D.P.gate, fd = Math.hypot(focus.x - g.x, focus.y - g.y);
    let x, y;
    if (atGate || fd > 60 || rnd() < 0.15) { const S = D.P.slots, k = g.slots[(rnd() * g.slots.length) | 0]; x = S.x[k] + (rnd() - 0.5); y = S.y[k] + (rnd() - 0.5); }
    else { let c = randomSpawnCell(); for (let t = 0; t < 12; t++) { const cx = cellX(D.N, c), cy = cellY(D.N, c); if (Math.hypot(cx - focus.x, cy - focus.y) > 90) break; c = randomSpawnCell(); } x = cellX(D.N, c); y = cellY(D.N, c); }
    if (clearance(D.N, x, y) < 0.4) { const c = nearestCell(D.N, x, y, 4); if (c < 0) return -1; x = cellX(D.N, c); y = cellY(D.N, c); }
    const L = spawnParty(x, y, Math.PI, size); if (L < 0) return -1;
    const fromGate = Math.hypot(x - g.x, y - g.y) < 20;
    if (!pickGoal(L, 0, fromGate ? 90 : 0)) { STT[L] = ST.WAIT; TIMER[L] = 2; }    // from the gate: somewhere well inside the park
    return L;
  }
  // the gate: a steady trickle of arrivals walking in; to keep the count, a party far from the camera goes home
  let arriveT = 2;
  function gateTick(dt) {
    arriveT -= dt; if (arriveT > 0) return;
    arriveT = params.arrivalEvery * (0.6 + 0.8 * rnd());
    const g = D.P.gate; if (focus.mode === 'walk' && Math.hypot(focus.x - g.x, focus.y - g.y) < 25) return;
    const size = partySize();
    if (crowd.active + size > crowd.want) {
      let best = -1, bd = 130;
      for (let t = 0; t < 40; t++) {
        const i = (rnd() * CAP) | 0; if (STT[i] !== ST.GO || LEAD[i] >= 0) continue;
        const d = Math.hypot(X[i] - focus.x, Y[i] - focus.y); if (d > bd && Math.hypot(X[i] - g.x, Y[i] - g.y) > 100) { bd = d; best = i; }
      }
      if (best < 0) return;
      removeParty(best);
    }
    spawnArrival(Math.min(size, Math.max(1, crowd.want - crowd.active)), true);
  }
  function placeAtSite(L) {        // teleport a party into its slots (start of the simulation, reduce motion)
    const S = D.P.slots, site = D.P.sites[SITE[L]];
    for (let k = -1; k < 4; k++) {
      const i = k < 0 ? L : MEM[L * 4 + k]; if (i < 0 || SLOT[i] < 0) continue;
      const s = SLOT[i]; X[i] = S.x[s]; Y[i] = S.y[s]; Z[i] = ZT[i] = S.z[s]; YAW[i] = DYAW[i] = S.yaw[s]; SPD[i] = 0; DSPD[i] = 0;
      if (site.kind === 'queue') { STT[i] = (S.site[s] === site.id && site.slots.indexOf(s) === 0 && i === L) ? ST.ACT : ST.QUEUE; }
      else STT[i] = ST.ACT;
      ANI[i] = activityAnim(i); TIMER[i] = dwell(site.kind) * (0.2 + 0.8 * rnd());
    }
  }

  // ── goals ──
  const cand = new Int32Array(64), candW = new Float32Array(64);
  function rhythm() {             // a slow drift toward the lake: stronger every ~2.5 minutes, and before the tour's Spire shot
    const t = focus.tour;
    if (t >= 0 && t < 160) return t > 18 && t < 50 ? 1 : 0.25;
    return 0.5 + 0.5 * Math.sin(simTime * TAU / 150);
  }
  function pickGoal(L, avoidSite, minDist = 0) {
    debug.ev.goal++;
    const P = D.P, sites = P.sites, size = GS[L];
    // leaving: the population is too big, or a party simply goes home
    let want = 'site';
    if (LEAVING[L] || crowd.active > crowd.want + 2) { want = 'gate'; LEAVING[L] = 1; }
    else {
      const lv = params.leaveShare * (0.3 + 8 * Math.exp(-Math.hypot(X[L] - P.gate.x, Y[L] - P.gate.y) / 80));   // mostly those near the gate go home
      const rr = params.railShare * (0.75 + 0.6 * rhythm()), r = rnd() * (rr + params.siteShare + params.walkShare + lv);
      want = r < rr ? 'rail' : r < rr + params.siteShare ? 'site' : r < rr + params.siteShare + params.walkShare ? 'walk' : 'gate';
      if (want === 'gate') LEAVING[L] = 1;
    }
    let site = null;
    if (want === 'gate') site = P.gate;
    else {
      let n = 0, tot = 0;
      // candidates: the sites within ~90 m (site grid, random order), then a few from anywhere
      const gi = Math.floor((X[L] - SG.x0) / SG.cs), gj = Math.floor((Y[L] - SG.y0) / SG.cs), near = SG.near;
      let nn = 0;
      for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
        const ii = gi + di, jj = gj + dj; if (ii < 0 || jj < 0 || ii >= SG.w || jj >= SG.h) continue;
        const l = SG.cells[jj * SG.w + ii]; for (let q = 0; q < l.length && nn < near.length; q++) near[nn++] = l[q];
      }
      for (let t = 0; t < nn + 12 && n < 56; t++) {
        let s;
        if (t < nn) { const r = t + ((rnd() * (nn - t)) | 0), id = near[r]; near[r] = near[t]; near[t] = id; s = sites[id]; }
        else s = sites[(rnd() * sites.length) | 0];
        if (!s.open || s.id === avoidSite || s.kind === 'gate') continue;
        if (want === 'rail' ? s.kind !== 'rail' : want === 'walk' ? s.kind !== 'walk' : (s.kind === 'rail' || s.kind === 'walk')) continue;
        if (freeSlots(s, size) < 0) continue;
        const d = Math.hypot(s.x - X[L], s.y - Y[L]);
        if (d < minDist) continue;
        let w = s.weight * s.pop * (Math.exp(-d / params.reach) + 0.05);
        if (want === 'walk' && d < 25) w *= 0.1;
        if (focus.mode === 'walk' && Math.hypot(s.x - focus.x, s.y - focus.y) < 3) w *= 0.05;    // not in the walker's face
        cand[n] = s.id; candW[n] = w; tot += w; n++;
      }
      if (!n) return false;
      let r = rnd() * tot, k = 0; while (k < n - 1 && (r -= candW[k]) > 0) k++;
      site = sites[cand[k]];
    }
    return assign(L, site);
  }
  // first slot index (into site.slots) of `size` free neighbouring slots, or -1
  function freeSlots(s, size) {
    const S = D.P.slots, sl = s.slots;
    if (s.kind === 'walk' || s.kind === 'gate') return 0;
    if (s.kind === 'queue') { let n = 0; for (let k = 0; k < sl.length; k++) if (S.occ[sl[k]] >= 0) n = k + 1; return n + size <= sl.length ? n : -1; }
    const n = sl.length, start = (rnd() * n) | 0;
    for (let t = 0; t < n; t++) {
      const k0 = (start + t) % n; if (k0 + size > n) continue;
      let ok = true; for (let q = 0; q < size; q++) if (S.occ[sl[k0 + q]] >= 0) { ok = false; break; }
      if (ok) return k0;
    }
    return -1;
  }
  function assign(L, site) {
    const S = D.P.slots, size = GS[L];
    releaseParty(L);
    const k0 = freeSlots(site, size); if (k0 < 0) return false;
    const members = [L]; for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0) members.push(f); }
    for (let q = 0; q < members.length; q++) {
      const i = members[q];
      SITE[i] = site.id;
      if (site.kind === 'walk' || site.kind === 'gate') SLOT[i] = site.slots[(rnd() * site.slots.length) | 0];
      else { const s = site.slots[Math.min(site.slots.length - 1, k0 + q)]; SLOT[i] = s; S.occ[s] = i; }
    }
    STT[L] = ST.GO; MODE[L] = 0; STUCK[L] = 0; RT[L] = 0;
    for (let q = 1; q < members.length; q++) { const f = members[q]; if (STT[f] !== ST.FOLLOW) { STT[f] = ST.FOLLOW; } }
    if (Math.hypot(site.x - X[L], site.y - Y[L]) < LOCAL_REQ) requestLocal(site.id);
    return true;
  }
  function releaseSlot(i) { const s = SLOT[i]; if (s >= 0 && D && D.P.slots.occ[s] === i) D.P.slots.occ[s] = -1; SLOT[i] = -1; }
  function releaseParty(L) { releaseSlot(L); for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0) releaseSlot(f); } }
  function dwell(kind) {
    switch (kind) {
      case 'sit': return 45 + rnd() * 100;
      case 'rail': return (45 + rnd() * 100) * (0.7 + 0.6 * rhythm());
      case 'stage': return 40 + rnd() * 80;
      case 'queue': return 8 + rnd() * 9;          // service time at the front
      case 'look': return 10 + rnd() * 18;
      default: return 0;
    }
  }
  function activityAnim(i) {
    const s = SLOT[i]; if (s < 0) return ANIM.stand;
    const S = D.P.slots, site = D.P.sites[S.site[s]], a = S.anim[s];
    if (site.kind === 'rail') { const r = rnd(); return r < 0.62 ? ANIM.lean : r < 0.85 ? ANIM.look : r < 0.93 ? ANIM.stand : ANIM.wave; }
    if (site.kind === 'look') { if (LEAD[i] >= 0) return rnd() < 0.7 ? ANIM.stand : ANIM.look; return a === ANIM.lean ? ANIM.lean : rnd() < 0.65 ? ANIM.look : rnd() < 0.5 ? ANIM.stand : ANIM.wave; }
    if (site.kind === 'stage') return rnd() < 0.12 ? ANIM.wave : ANIM.stand;
    if (site.kind === 'queue') return rnd() < 0.25 ? ANIM.look : ANIM.stand;
    return a;
  }

  // ── per-frame state ──
  const focus = { x: 1e6, y: 1e6, z: 0, mode: 'tour', tour: -1, vx: 0, vy: 0, px: 1e6, py: 1e6 };
  let tPrev = 0;

  function update(dt, time, f) {
    if (!D || !HG) return;
    const t0 = now();
    if (!(dt > 0)) dt = 0; dt = Math.min(dt, 0.1);
    simTime += dt; frameNo++;
    if (f) {
      focus.mode = f.mode || 'tour'; focus.tour = f.tour !== undefined ? f.tour : -1;
      if (isFinite(f.x)) { focus.vx = dt > 0 ? (f.x - focus.x) / dt : 0; focus.vy = dt > 0 ? (f.y - focus.y) / dt : 0; if (Math.abs(focus.vx) > 30 || Math.abs(focus.vy) > 30) focus.vx = focus.vy = 0; focus.x = f.x; focus.y = f.y; focus.z = f.z || 0; }
    }
    // local fields computed on the main thread (no Worker): one per frame
    if (pendingLocal.length && !manualLocal) { const s = pendingLocal.shift(); if (local.has(s)) { local.set(s, localField(D.N, D.P, s)); trimLocal(); } }
    // population changes
    if (crowd.active < crowd.want && !reduceMotion && (frameNo % 7 === 0)) populate(Math.min(crowd.want, crowd.active + 4), false);
    if (crowd.active > crowd.want + 2 && frameNo % 5 === 0) shrink();
    if (!reduceMotion && crowd.want > 0) gateTick(dt);
    buildGrid();
    if (reduceMotion) { if (!calmed) { calm(); calmed = true; } writeState(); timing(t0); return; }
    calmed = false;
    const p = params;
    let thinkers = 0;
    // agents are visited in spatial order (re-sorted now and then): neighbours touch the same grid memory, which
    // matters more than the arithmetic once the renderer has flushed the caches
    if (orderDirty || (frameNo % 30) === 0) sortOrder();
    for (let q = 0; q < orderN; q++) {
      const i = ORDER[q], st = STT[i]; if (st === ST.OFF) continue;
      if (st === ST.ACT || st === ST.QUEUE) {
        // standing, sitting, leaning: a cheap path (think every 6th frame; the idle phase runs every frame)
        if (OCCK[i] < 0 && ANI[i] !== ANIM.sit) stamp(i, true);
        if (GHOST[i] > 0) GHOST[i] = 0;
        TACC[i] += dt; PH[i] = (PH[i] + dt * 0.3) % 256; ACC[i] = 0;
        if ((frameNo + i) % 6 === 0) { const t = TACC[i] > 0.5 ? 0.5 : TACC[i]; TACC[i] = 0; think(i, t); thinkers++; }
        if ((STT[i] === ST.ACT || STT[i] === ST.QUEUE) && SLOT[i] >= 0) { const dy = D.P.slots.yaw[SLOT[i]] - YAW[i]; if (dy > 0.002 || dy < -0.002) faceSlot(i, dt); }
        continue;
      }
      if (OCCK[i] >= 0) stamp(i, false);
      // jams (a narrow lane, two streams): someone who wants to walk but cannot for 2.5 s may pass through others briefly
      if (st === ST.GO || st === ST.FOLLOW) {
        if (GHOST[i] > 0) GHOST[i] -= dt;
        else if (DSPD[i] > 0.3 && SPD[i] < 0.2) { JAM[i] += dt; if (JAM[i] > 2.5) { JAM[i] = 0; GHOST[i] = 2.0; debug.ev.ghost++; } }
        else if (JAM[i] > 0) JAM[i] = Math.max(0, JAM[i] - dt * 2);
      } else if (GHOST[i] > 0) GHOST[i] = 0;
      // level of detail: distance to the focus, refreshed every 8th frame (staggered)
      if (((frameNo + i) & 7) === 0 || DFOC[i] === 0) { const dx = X[i] - focus.x, dy = Y[i] - focus.y, dz = Z[i] - focus.z; DFOC[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01; }
      const d = DFOC[i] * lodInv, iv = d < p.lodNear ? 2 : d < p.lodMid ? 4 : d < p.lodFar ? 6 : 10;
      ACC[i] += dt; TACC[i] += dt;
      const think_ = (frameNo + i) % iv === 0;
      if (think_) { think(i, TACC[i] > 0.5 ? 0.5 : TACC[i]); TACC[i] = 0; thinkers++; }
      // movement: every frame near the focus, every 2nd frame to integrateFar, else with the thinking
      if (d < p.integrateNear || (d < p.integrateFar ? ((frameNo + i) & 1) === 0 : think_)) { integrate(i, ACC[i] > 0.5 ? 0.5 : ACC[i]); ACC[i] = 0; }
    }
    debug.thinkers = thinkers;
    writeState();
    timing(t0);
  }
  const ORDER = new Int32Array(CAP), OKEY = new Float32Array(CAP);
  let orderN = 0, orderDirty = true;
  function sortOrder() {
    if (orderDirty) { orderN = 0; for (let i = 0; i < CAP; i++) if (STT[i] !== ST.OFF) ORDER[orderN++] = i; orderDirty = false; }
    for (let q = 0; q < orderN; q++) { const i = ORDER[q]; OKEY[i] = Math.floor((Y[i] + 400) / 8) * 1000 + (X[i] + 400) / 8; }
    for (let q = 1; q < orderN; q++) {           // insertion sort: the order barely changes between sorts
      const i = ORDER[q], k = OKEY[i]; let r = q - 1;
      while (r >= 0 && OKEY[ORDER[r]] > k) { ORDER[r + 1] = ORDER[r]; r--; }
      ORDER[r + 1] = i;
    }
  }
  function timing(t0) {
    const ms = now() - t0; debug.frameMs = ms; debug.frames++;
    // adaptive level of detail: keep the average cost near the budget (timer resolution is coarse: average over frames)
    costEma += (ms - costEma) * 0.02;
    if (debug.frames > 120) { if (costEma > params.budget) lodK = Math.max(0.4, lodK - 0.002); else if (costEma < params.budget * 0.8) lodK = Math.min(1, lodK + 0.001); lodInv = 1 / lodK; }
    debug.lodK = lodK;
    debug.frameMean += (ms - debug.frameMean) / Math.min(debug.frames, 300); if (ms > debug.frameMax) debug.frameMax = ms;
  }
  function writeState() {
    for (let i = 0; i < CAP; i++) {
      const o = i * 8;
      if (STT[i] === ST.OFF) { state[o + 5] = 255; continue; }
      state[o] = X[i]; state[o + 1] = Y[i]; state[o + 2] = Z[i]; state[o + 3] = YAW[i]; state[o + 4] = SPD[i]; state[o + 5] = ANI[i]; state[o + 6] = PH[i]; state[o + 7] = SEED[i];
    }
  }
  function buildGrid() {
    const head = HG.head, next = HG.next, gw = HG.w, gh = HG.h, x0 = D.N.x0, y0 = D.N.y0;
    head.fill(-1);
    for (let i = 0; i < CAP; i++) {
      if (STT[i] === ST.OFF) continue;
      const gx = Math.floor((X[i] - x0) / 2), gy = Math.floor((Y[i] - y0) / 2);
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) { next[i] = -1; continue; }
      const g = hb(gx, gy); next[i] = head[g]; head[g] = i;
    }
  }
  function shrink() {
    // too many guests: vanish far from the camera (whole parties), or walk out through the gate
    let best = -1, bd = 0;
    for (let i = 0; i < CAP; i++) {
      if (STT[i] === ST.OFF || LEAD[i] >= 0 || LEAVING[i]) continue;
      const d = Math.hypot(X[i] - focus.x, Y[i] - focus.y); if (d > bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    if (bd > 160 || reduceMotion) removeParty(best);
    else { LEAVING[best] = 1; if (STT[best] === ST.GO || STT[best] === ST.WAIT || STT[best] === ST.PAUSE) pickGoal(best, -1); }
  }

  // reduce motion: every guest stands, sits or leans where it is (walkers stop and stand; nobody frozen mid-stride)
  function calm() {
    // once, when motion is reduced: settling guests take their seats, walkers stop and stand; a party turns to face
    // its middle as if chatting. Then nothing moves (not even the idle phase) until motion is allowed again.
    const S = D.P.slots;
    for (let i = 0; i < CAP; i++) {
      const st = STT[i]; if (st === ST.OFF) continue;
      SPD[i] = 0; DSPD[i] = 0; AVX[i] = AVY[i] = 0;
      if (st === ST.ACT || st === ST.QUEUE) continue;
      if (st === ST.SETTLE) { const s = SLOT[i]; if (s >= 0) { X[i] = S.x[s]; Y[i] = S.y[s]; Z[i] = ZT[i] = S.z[s]; YAW[i] = S.yaw[s]; STT[i] = ST.ACT; ANI[i] = activityAnim(i); TIMER[i] = dwell(D.P.sites[S.site[s]].kind); continue; } }
      if (st === ST.UNSETTLE) { X[i] = UX[i]; Y[i] = UY[i]; const g = ground(D.N, X[i], Y[i]); if (g === g) Z[i] = ZT[i] = g; STT[i] = LEAD[i] < 0 ? ST.WAIT : ST.FOLLOW; TIMER[i] = 1; }
      ANI[i] = ANIM.stand;
      if (GS[i] > 1) {
        const L = LEAD[i] >= 0 ? LEAD[i] : i; let cx = X[L], cy = Y[L], n = 1;
        for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0 && STT[f] !== ST.ACT && STT[f] !== ST.QUEUE) { cx += X[f]; cy += Y[f]; n++; } }
        cx /= n; cy /= n; if (Math.hypot(cx - X[i], cy - Y[i]) > 0.15) YAW[i] = DYAW[i] = Math.atan2(cy - Y[i], cx - X[i]);
      }
    }
  }

  // ── behaviour (think) ──
  let thinkDt = 1 / 30;
  function think(i, dt) {
    const st = STT[i]; thinkDt = dt > 0.004 ? dt : 0.004;
    switch (st) {
      case ST.WAIT: case ST.PAUSE: {
        DSPD[i] = 0; TIMER[i] -= dt;
        if (TIMER[i] <= 0 && SPD[i] < 0.2) { if (LEAD[i] >= 0) { STT[i] = ST.FOLLOW; break; } if (!pickGoal(i, SITE[i])) TIMER[i] = 1 + rnd() * 2; }
        if (SPD[i] < 0.1 && ANI[i] === ANIM.walk) ANI[i] = ANIM.stand;
        break;
      }
      case ST.GO: goStep(i, dt); break;
      case ST.FOLLOW: followStep(i, dt); break;
      case ST.SETTLE: case ST.UNSETTLE: break;          // integrated per frame
      case ST.ACT: actStep(i, dt); break;
      case ST.QUEUE: queueStep(i, dt); break;
    }
  }
  function steerTo(i, tx, ty, speed) {
    // desired heading + speed toward (tx, ty), then local avoidance
    let vx = tx - X[i], vy = ty - Y[i]; const L = Math.hypot(vx, vy) || 1;
    vx = vx / L * speed; vy = vy / L * speed;
    avoid(i, vx, vy);
  }
  function goStep(i, dt) {
    const N = D.N, P = D.P, S = P.slots, s = SLOT[i]; if (s < 0) { STT[i] = ST.WAIT; TIMER[i] = 1; return; }
    const site = P.sites[SITE[i]], gx = S.ax[s], gy = S.ay[s];
    const dx = gx - X[i], dy = gy - Y[i], d = Math.hypot(dx, dy);
    const isFollowerGoing = LEAD[i] >= 0;
    if (isFollowerGoing && (SITE[LEAD[i]] !== SITE[i] || STT[LEAD[i]] === ST.OFF)) { STT[i] = ST.FOLLOW; return; }
    const arriveR = site.kind === 'walk' ? 1.6 : site.kind === 'gate' ? 2.5 : 0.22;
    if (d < arriveR) { arrive(i, site); return; }
    RT[i] -= dt;
    const replan = RT[i] <= 0 || Math.hypot(TX[i] - X[i], TY[i] - Y[i]) < 1.1;
    if (replan && d < LOCAL_REQ && !local.has(site.id)) requestLocal(site.id);
    if (replan && MODE[i] !== 2 && d < 6 && lineClear(N, X[i], Y[i], gx, gy, 0.22)) MODE[i] = 2;
    let tx, ty, speed = PREF[i];
    if (MODE[i] !== 2 && !replan) { tx = TX[i]; ty = TY[i]; }
    else if (MODE[i] === 2) {
      tx = gx; ty = gy; speed = Math.min(PREF[i], 0.25 + d * 0.8);
      if (d > 8) MODE[i] = 0;
    } else {
      const c = cellAt(N, X[i], Y[i]) >= 0 ? cellAt(N, X[i], Y[i]) : nearestCell(N, X[i], Y[i], 2);
      const lf = local.get(site.id);
      let f = null, isLocal = false;
      if (lf && c >= 0) { const I = (N.ccell[c] % N.cw) - lf.I0, J = ((N.ccell[c] / N.cw) | 0) - lf.J0; if (I >= 0 && J >= 0 && I < lf.w && J < lf.h && fget(lf.dir, J * lf.w + I) !== 15) { f = lf; isLocal = true; } LUSE[site.id] = frameNo; }
      if (!f) f = D.hubF[site.hub];
      if (c < 0 || !f) { tx = gx; ty = gy; }
      else {
        let cc = c, steps = 0; PATH[0] = c;
        for (; steps < params.lookahead; steps++) {
          let dd;
          if (isLocal) { const I = (N.ccell[cc] % N.cw) - f.I0, J = ((N.ccell[cc] / N.cw) | 0) - f.J0; dd = (I >= 0 && J >= 0 && I < f.w && J < f.h) ? fget(f.dir, J * f.w + I) : 15; }
          else dd = fget(f, cc);
          if (dd >= 8) {
            if (dd === 15 && steps === 0) {           // unreachable from here: try again later, else give up on this goal
              STUCK[i] += dt; if (STUCK[i] > 3) { STUCK[i] = 0; if (!isFollowerGoing) { STT[i] = ST.WAIT; TIMER[i] = 0.5; } }
            }
            if (dd === 8 && steps === 0 && !isLocal) { // at the hub but the local field is not ready: wait for it
              if (!lf) { DSPD[i] = 0; requestLocal(site.id); return; }
            }
            break;
          }
          const K = N.ccell[cc] + DY[dd] * N.cw + DX[dd]; const c2 = N.cidx[K]; if (c2 < 0) break; cc = c2; PATH[steps + 1] = cc;
        }
        if (steps === 0) { tx = gx; ty = gy; }
        else {
          // the farthest cell along the route in plain sight (targets = the most open spot of each 1 m cell)
          const R = params.radius + 0.04;
          let k = steps; tx = fineX(N, PATH[k]); ty = fineY(N, PATH[k]);
          for (; k > 1; k--) { tx = fineX(N, PATH[k]); ty = fineY(N, PATH[k]); if (lineClear(N, X[i], Y[i], tx, ty, R)) break; }
          if (k === 1) { tx = fineX(N, PATH[1]); ty = fineY(N, PATH[1]); }
          // keep right: offset the target to the right of the route, as far as clearance allows
          const rx = ty - Y[i], ry = -(tx - X[i]), rl = Math.hypot(rx, ry) || 1;
          for (let lane = LANE[i]; lane > 0.3; lane *= 0.5) {
            const ox = tx + rx / rl * lane, oy = ty + ry / rl * lane;
            if (clearance(N, ox, oy) > 0.6 && lineClear(N, X[i], Y[i], ox, oy, R)) { tx = ox; ty = oy; break; }
          }
        }
      }
      TX[i] = tx; TY[i] = ty; RT[i] = 0.45 + rnd() * 0.3;
    }
    // a party leader waits for stragglers
    if (GS[i] > 1 && LEAD[i] < 0) {
      let far = 0; for (let k = 0; k < 4; k++) { const f = MEM[i * 4 + k]; if (f >= 0 && STT[f] === ST.FOLLOW) far = Math.max(far, Math.hypot(X[f] - X[i], Y[f] - Y[i])); }
      if (far > 3.5) speed *= Math.max(0.35, 1 - (far - 3.5) * 0.25);
    }
    steerTo(i, tx, ty, speed);
    // stuck: wanting to move but not moving for a while
    if (DSPD[i] > 0.3 && SPD[i] < 0.12) { STUCK[i] += dt; if (STUCK[i] > 6) { STUCK[i] = 0; MODE[i] = 0; if (!isFollowerGoing) { if (!pickGoal(i, SITE[i])) { STT[i] = ST.WAIT; TIMER[i] = 2; } } } }
    else STUCK[i] = Math.max(0, STUCK[i] - dt);
  }
  function arrive(i, site) {
    const S = D.P.slots;
    if (site.kind === 'gate') {
      if (LEAD[i] >= 0) { STT[i] = ST.WAIT; TIMER[i] = 1; return; }
      // left the park: a new party arrives (the gate keeps a steady trickle in both directions)
      const size = GS[i]; removeParty(i);
      if (crowd.active < crowd.want) spawnArrival(Math.min(size, crowd.want - crowd.active));
      return;
    }
    if (site.kind === 'walk') {
      if (LEAD[i] >= 0) { STT[i] = ST.FOLLOW; return; }
      // pass through, sometimes pause to look round or take a photo
      if (rnd() < 0.22) { STT[i] = ST.PAUSE; TIMER[i] = 2 + rnd() * 5; DSPD[i] = 0; ANI[i] = ANIM.walk; pauseAnim[i] = rnd() < 0.5 ? ANIM.look : ANIM.stand; }
      else if (!pickGoal(i, site.id)) { STT[i] = ST.WAIT; TIMER[i] = 1; }
      return;
    }
    // settle into the slot
    const s = SLOT[i];
    STT[i] = ST.SETTLE; SX[i] = X[i]; SY[i] = Y[i]; SZ[i] = Z[i]; ST0[i] = 0;
    const L = Math.hypot(S.x[s] - X[i], S.y[s] - Y[i]);
    STT2[i] = site.kind === 'sit' ? 0.9 : Math.max(0.25, L / 0.6);
  }
  const pauseAnim = new Uint8Array(CAP), USIT = new Uint8Array(CAP);
  function actStep(i, dt) {
    const S = D.P.slots, s = SLOT[i]; if (s < 0) { STT[i] = ST.WAIT; return; }
    const site = D.P.sites[S.site[s]];
    DSPD[i] = 0; TIMER[i] -= dt;
    // change pose now and then (photo -> look -> point at the lanterns), never while sitting
    if (ANI[i] !== ANIM.sit && rnd() < dt * 0.04) ANI[i] = activityAnim(i);
    if (LEAD[i] >= 0) { const L = LEAD[i]; if (STT[L] === ST.OFF || SITE[L] !== S.site[s] || !(STT[L] === ST.SETTLE || STT[L] === ST.ACT || STT[L] === ST.QUEUE || STT[L] === ST.GO)) leaveSite(i, site); return; }   // followers leave with their leader
    if (TIMER[i] > 0) return;
    // queue: the front customer is served and leaves; the line moves up
    leaveSite(i, site);
  }
  function leaveSite(L, site) {
    const members = [L]; for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0) members.push(f); }
    const S = D.P.slots;
    for (const i of members) {
      const s = SLOT[i];
      if (s >= 0 && (STT[i] === ST.ACT || STT[i] === ST.QUEUE || STT[i] === ST.SETTLE)) { STT[i] = ST.UNSETTLE; ST0[i] = 0; STT2[i] = ANI[i] === ANIM.sit ? 0.9 : 0.35; SX[i] = X[i]; SY[i] = Y[i]; SZ[i] = Z[i]; UX[i] = S.ax[s]; UY[i] = S.ay[s]; USIT[i] = ANI[i] === ANIM.sit ? 1 : 0; }
      else if (LEAD[i] >= 0) STT[i] = ST.FOLLOW;
      releaseSlot(i);
    }
    if (site.kind === 'queue') advanceQueue(site);
  }
  function advanceQueue(site) {
    const S = D.P.slots, sl = site.slots;
    let w = 0;
    for (let k = 0; k < sl.length; k++) {
      const a = S.occ[sl[k]]; if (a < 0) continue;
      if (k !== w) {
        S.occ[sl[k]] = -1; S.occ[sl[w]] = a; SLOT[a] = sl[w];
        // walk up to the new place
        if (STT[a] === ST.QUEUE || STT[a] === ST.ACT || STT[a] === ST.SETTLE) { STT[a] = ST.SETTLE; SX[a] = X[a]; SY[a] = Y[a]; SZ[a] = Z[a]; ST0[a] = 0; STT2[a] = Math.max(0.4, Math.hypot(S.x[sl[w]] - X[a], S.y[sl[w]] - Y[a]) / 0.55); }
      }
      w++;
    }
  }
  function queueStep(i, dt) {
    DSPD[i] = 0;
    const S = D.P.slots, s = SLOT[i]; if (s < 0) { STT[i] = ST.WAIT; return; }
    const site = D.P.sites[S.site[s]];
    if (LEAD[i] >= 0) { const L = LEAD[i]; if (STT[L] === ST.OFF || SITE[L] !== S.site[s]) { leaveSite(i, site); return; } }
    else if (site.slots[0] === s) { STT[i] = ST.ACT; TIMER[i] = dwell('queue'); }
    if (rnd() < dt * 0.05) ANI[i] = activityAnim(i);
  }
  function followStep(i, dt) {
    const L = LEAD[i]; if (L < 0 || STT[L] === ST.OFF) { LEAD[i] = -1; GS[i] = 1; STT[i] = ST.WAIT; TIMER[i] = 0.5; return; }
    const ls = STT[L];
    // the leader settled at a site: go to my own slot there
    if ((ls === ST.SETTLE || ls === ST.ACT || ls === ST.QUEUE) && SLOT[i] >= 0 && SITE[i] === SITE[L]) {
      const site = D.P.sites[SITE[i]];
      if (site.kind !== 'walk' && site.kind !== 'gate') { STT[i] = ST.GO; MODE[i] = 0; RT[i] = 0; return; }
    }
    const lyaw = YAW[L], c = Math.cos(lyaw), s = Math.sin(lyaw);
    formation(GS[L], GI[i], SIDE[L]);
    let tx = X[L] + s * FO[0] - c * FO[1], ty = Y[L] - c * FO[0] - s * FO[1];
    const N = D.N;
    if ((clrByte(N, tx, ty) < 7 && clearance(N, tx, ty) < 0.35) || (clrByte(N, (tx + X[L]) * 0.5, (ty + Y[L]) * 0.5) < 7 && clearance(N, (tx + X[L]) * 0.5, (ty + Y[L]) * 0.5) < 0.3)) { tx = X[L] - c * 0.85 * GI[i]; ty = Y[L] - s * 0.85 * GI[i]; }
    const dx = tx - X[i], dy = ty - Y[i], d = Math.hypot(dx, dy), dl = Math.hypot(X[L] - X[i], Y[L] - Y[i]);
    if (dl > 10 || (d > 1.5 && !lineClear(N, X[i], Y[i], tx, ty, 0.2))) {
      // lost sight: take the leader's route (same goal)
      if (SITE[L] >= 0 && SLOT[i] >= 0 && SITE[i] === SITE[L]) { goStep(i, dt); if (STT[i] === ST.FOLLOW) return; return; }
    }
    const lsp = SPD[L];
    if (d < 0.3 && lsp < 0.1) { DSPD[i] = 0; DYAW[i] = YAW[L]; return; }
    // match the leader's velocity, close the gap
    const k = 1.1; let vx = Math.cos(lyaw) * lsp + dx * k, vy = Math.sin(lyaw) * lsp + dy * k;
    // never walk into the leader: close to them, drop the part of the velocity that points at them
    if (dl < 0.95 && dl > 1e-3) { const lx = (X[L] - X[i]) / dl, ly = (Y[L] - Y[i]) / dl, comp = vx * lx + vy * ly; if (comp > 0) { const f = Math.min(1, (0.95 - dl) / 0.4); vx -= lx * comp * f; vy -= ly * comp * f; } }
    let sp = Math.hypot(vx, vy); const cap = Math.max(PREF[i] * 1.35, lsp * 1.3);
    if (sp > cap) sp = cap;
    if (sp < 0.05) { DSPD[i] = 0; return; }
    const L2 = Math.hypot(vx, vy) || 1;
    avoid(i, vx / L2 * sp, vy / L2 * sp);
  }

  // ── local avoidance: neighbours from the hash grid, time-to-collision steering + separation; the focus too ──
  function avoid(i, vx, vy) {
    const xi = X[i], yi = Y[i], head = HG.head, next = HG.next, gw = HG.w, gh = HG.h, N = D.N;
    const gx = Math.floor((xi - N.x0) / 2), gy = Math.floor((yi - N.y0) / 2);
    const want = Math.hypot(vx, vy);
    let fx = 0, fy = 0, seen = 0, cxs = 0, cys = 0;
    const ghost = GHOST[i] > 0;
    const lead = LEAD[i] >= 0 ? LEAD[i] : i;
    for (let oy = ghost ? 2 : -1; oy <= 1; oy++) {
      const yy = gy + oy; if (yy < 0 || yy >= gh) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox; if (xx < 0 || xx >= gw) continue;
        for (let j = head[hb(xx, yy)]; j >= 0; j = next[j]) {
          if (j === i) continue;
          const px = X[j] - xi, py = Y[j] - yi, r2 = px * px + py * py;
          if (r2 > 4.84 || Math.abs(Z[j] - Z[i]) > 1.2) continue;
          const r = Math.sqrt(r2) || 0.01;
          const same = (LEAD[j] >= 0 ? LEAD[j] : j) === lead;
          const pers = same ? 0.6 : params.personal;
          // separation (force), and a hard minimum distance (position correction, shared with walking neighbours)
          if (r < pers) { const k = (pers - r) / pers * (same ? 1.0 : 1.6) * Math.max(0.6, want); fx -= px / r * k; fy -= py / r * k; }
          if (r < MIN_D) { const share = (STT[j] === ST.GO || STT[j] === ST.FOLLOW) ? 0.5 : 1.0, k = (MIN_D - r) * share; cxs -= px / r * k; cys -= py / r * k; }
          if (same) continue;
          // time to collision with j's current velocity
          const ujx = AVX[j], ujy = AVY[j];
          const rvx = vx - ujx, rvy = vy - ujy, rv2 = rvx * rvx + rvy * rvy;
          if (rv2 < 1e-4) continue;
          const t = (px * rvx + py * rvy) / rv2;
          if (t <= 0 || t > 3.0) continue;
          const cx = px - rvx * t, cy = py - rvy * t, cd = Math.hypot(cx, cy), R = SPD[j] < 0.1 ? 0.62 : 0.72;
          if (cd >= R) continue;
          let ax, ay;
          if (cd > 0.02) { ax = -cx / cd; ay = -cy / cd; }
          else { ax = vy / (want || 1); ay = -vx / (want || 1); }              // dead ahead: step right
          // head-on with a walker: both keep right
          if (SPD[j] > 0.3 && (ujx * vx + ujy * vy) < -0.4 * want * SPD[j]) { const rx = vy / (want || 1), ry = -vx / (want || 1); ax = ax * 0.5 + rx * 0.7; ay = ay * 0.5 + ry * 0.7; }
          const k = (R - cd) / R * Math.max(0.5, want) * 1.4 / (0.6 + t);
          fx += ax * k; fy += ay * k;
          if (++seen > 10) break;
        }
      }
    }
    // the walker (Walk mode): keep out of their way
    if (focus.mode === 'walk') {
      const px = focus.x - xi, py = focus.y - yi, r = Math.hypot(px, py);
      if (r < 4) {
        if (r < 1.3) { const k = (1.3 - r) / 1.3 * 2.0; fx -= px / (r || 0.01) * k; fy -= py / (r || 0.01) * k; }
        const rvx = vx - focus.vx, rvy = vy - focus.vy, rv2 = rvx * rvx + rvy * rvy;
        if (rv2 > 1e-3) { const t = (px * rvx + py * rvy) / rv2; if (t > 0 && t < 2.5) { const cx = px - rvx * t, cy = py - rvy * t, cd = Math.hypot(cx, cy); if (cd < 1.1) { const k = (1.1 - cd) * 1.5 / (0.5 + t); fx -= cx / (cd || 0.01) * k; fy -= cy / (cd || 0.01) * k; } } }
      }
    }
    // walls: push away from obstacles closer than 0.55 m (clearance gradient)
    const c0 = clrByte(N, xi, yi) >= 9 ? 1 : clearance(N, xi, yi);     // 9 units = 1.5 m between cell centres: open ground
    if (c0 < 0.55) {
      const gxw = clearance(N, xi + 0.25, yi) - clearance(N, xi - 0.25, yi), gyw = clearance(N, xi, yi + 0.25) - clearance(N, xi, yi - 0.25), gl = Math.hypot(gxw, gyw);
      if (gl > 1e-3) { const k = (0.55 - c0) * 2.0; fx += gxw / gl * k; fy += gyw / gl * k; }
    }
    if (cxs !== 0 || cys !== 0) {
      const cl = Math.hypot(cxs, cys), cap = 0.03 + thinkDt * 0.3; if (cl > cap) { cxs *= cap / cl; cys *= cap / cl; }
      const nx = xi + cxs, ny = yi + cys; if (canStand(i, nx, ny)) { X[i] = nx; Y[i] = ny; }
    }
    vx += fx; vy += fy;
    let sp = Math.hypot(vx, vy);
    if (sp > want * 1.15 + 0.05) sp = want * 1.15 + 0.05;
    // the heading follows a low-passed desired velocity (no wiggle when the neighbours change)
    const ks = thinkDt / (0.2 + thinkDt);
    VX[i] += (vx - VX[i]) * ks; VY[i] += (vy - VY[i]) * ks;
    if (VX[i] * VX[i] + VY[i] * VY[i] > 4e-4) DYAW[i] = Math.atan2(VY[i], VX[i]);
    else if (sp > 0.02) DYAW[i] = Math.atan2(vy, vx);
    DSPD[i] = sp;
  }

  // ── movement (every frame near the camera) ──
  function integrate(i, dt) {
    if (dt <= 0) return;
    const st = STT[i], N = D.N, p = params;
    if (st === ST.SETTLE || st === ST.UNSETTLE) { AVX[i] = AVY[i] = 0; settleStep(i, dt); return; }
    if (st === ST.ACT || st === ST.QUEUE) { faceSlot(i, dt); return; }
    // turn toward the desired heading (rate-limited, smoothed); slow down for sharp turns; never walk backwards
    const diff = wrapA(DYAW[i] - YAW[i]);
    const rate = SPD[i] < 0.3 ? p.turnRate * 1.4 : p.turnRate;
    let turn = diff * 4.0; if (turn > rate) turn = rate; else if (turn < -rate) turn = -rate;
    YAW[i] = wrapA(YAW[i] + turn * dt);
    const align = Math.cos(diff), target = DSPD[i] * (align > 0 ? align * align : 0);
    const dv = target - SPD[i];
    SPD[i] += dv > 0 ? Math.min(dv, p.accel * dt) : Math.max(dv, -p.decel * dt);
    if (SPD[i] < 0.02 && target < 0.02) SPD[i] = 0;
    else if (SPD[i] < 0.15 && target > 0.3) SPD[i] = 0.15;
    let moved = 0;
    if (SPD[i] > 0) {
      const c = Math.cos(YAW[i]), s = Math.sin(YAW[i]), step = SPD[i] * dt;
      let nx = X[i] + c * step, ny = Y[i] + s * step;
      // fast path: open ground, nobody standing there, same height band
      const fi = ((nx - N.x0) * 2) | 0, fj = ((ny - N.y0) * 2) | 0, fk = fj * N.W + fi;
      if ((fi > 0 && fj > 0 && fi < N.W - 1 && fj < N.H - 1 && N.clr[fk] >= 7 && !OCC[fk] && fk === GK[i]) || canStand(i, nx, ny)) { X[i] = nx; Y[i] = ny; moved = step; }
      else {
        // blocked (a wall, a standing guest): take the free direction closest to the heading — the wall's tangent or a
        // side-step, own side first — turning toward it within this frame's turn budget, and move only as far as the
        // heading allows (never sideways, never backwards)
        const gxw = clearance(N, X[i] + 0.25, Y[i]) - clearance(N, X[i] - 0.25, Y[i]), gyw = clearance(N, X[i], Y[i] + 0.25) - clearance(N, X[i], Y[i] - 0.25), gl = Math.hypot(gxw, gyw);
        let found = false, a = 0;
        if (gl > 1e-4) {
          const tx = -gyw / gl, ty = gxw / gl, along = c * tx + s * ty, sg = Math.abs(along) > 0.1 ? Math.sign(along) : SIDE[i];
          a = Math.atan2(ty * sg, tx * sg);
          if (canStand(i, X[i] + Math.cos(a) * step, Y[i] + Math.sin(a) * step)) found = true;
        }
        for (let t = 0; t < 4 && !found; t++) {
          a = YAW[i] + (t & 1 ? -1 : 1) * SIDE[i] * (t < 2 ? 0.6 : 1.2);
          if (canStand(i, X[i] + Math.cos(a) * step, Y[i] + Math.sin(a) * step)) found = true;
        }
        if (found) {
          const left = Math.max(0, rate * 1.15 * dt - Math.abs(turn * dt)), da = wrapA(a - YAW[i]);
          YAW[i] = wrapA(YAW[i] + (da > left ? left : da < -left ? -left : da));
          const off = Math.abs(wrapA(a - YAW[i])), fwd = Math.max(0, Math.cos(off) * 2 - 1);
          if (fwd > 0) { const k = step * fwd; X[i] += Math.cos(a) * k; Y[i] += Math.sin(a) * k; moved = k; }
          SPD[i] *= 0.96;
        } else SPD[i] *= 0.5;
      }
    }
    // a party keeps apart every frame (members walk close together and think at different times)
    if (GS[i] > 1) {
      const L = LEAD[i] >= 0 ? LEAD[i] : i;
      for (let k = -1; k < 4; k++) {
        const j = k < 0 ? L : MEM[L * 4 + k]; if (j < 0 || j === i || STT[j] === ST.OFF) continue;
        const dx = X[i] - X[j], dy = Y[i] - Y[j], r2 = dx * dx + dy * dy;
        if (r2 < 0.2025 && r2 > 1e-6) { const r = Math.sqrt(r2), k2 = Math.min(dt * 0.5, (0.45 - r) * 0.5), nx = X[i] + dx / r * k2, ny = Y[i] + dy / r * k2; if (canStand(i, nx, ny)) { X[i] = nx; Y[i] = ny; } }
      }
    }
    { const c = Math.cos(YAW[i]), s = Math.sin(YAW[i]); AVX[i] = c * SPD[i]; AVY[i] = s * SPD[i]; }
    { const fi = ((X[i] - N.x0) / N.cell) | 0, fj = ((Y[i] - N.y0) / N.cell) | 0, k = fj * N.W + fi;      // ground: read when the cell changes
      if (k !== GK[i]) { GK[i] = k; const v = N.A[k]; if (v) { const g = (v - 1) / 100 - 2; if (Math.abs(g - ZT[i]) < 0.6) ZT[i] = g; } } }
    Z[i] += (ZT[i] - Z[i]) * Math.min(1, dt * 10);
    PH[i] = (PH[i] + (moved > 0 ? moved / 1.4 : dt * 0.3)) % 256;
    if (SPD[i] > 0.12) ANI[i] = ANIM.walk;
    else if (ANI[i] === ANIM.walk && SPD[i] < 0.05) ANI[i] = (st === ST.PAUSE ? pauseAnim[i] || ANIM.stand : ANIM.stand);
  }
  // standing guests mark the fine cells within 0.4 m of them; walkers do not step into marked cells
  function stamp(i, add) {
    const N = D.N, W = N.W;
    if (add) { const fi = ((X[i] - N.x0) / N.cell) | 0, fj = ((Y[i] - N.y0) / N.cell) | 0; if (fi < 1 || fj < 1 || fi >= W - 1 || fj >= N.H - 1) return; OCCK[i] = fj * W + fi; }
    const k0 = OCCK[i]; if (k0 < 0) return;
    const ci = k0 % W, cj = (k0 / W) | 0, x = X[i], y = Y[i];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const k = k0 + dj * W + di;
      if (add) { const cx = N.x0 + (ci + di + 0.5) * N.cell, cy = N.y0 + (cj + dj + 0.5) * N.cell; if ((cx - x) * (cx - x) + (cy - y) * (cy - y) > 0.36 && (di || dj)) { continue; } if (OCC[k] < 255) OCC[k]++; STMASK[i] |= 1 << ((dj + 1) * 3 + di + 1); }
      else if (STMASK[i] & (1 << ((dj + 1) * 3 + di + 1))) { if (OCC[k]) OCC[k]--; }
    }
    if (!add) { OCCK[i] = -1; STMASK[i] = 0; }
  }
  // a move to (x, y) comes closer than 0.55 m to a standing guest (not of my party) and closer than before
  function standingBlocks(i, x, y) {
    const N = D.N, head = HG.head, next = HG.next, gw = HG.w, gx = Math.floor((x - N.x0) / 2), gy = Math.floor((y - N.y0) / 2);
    const party = LEAD[i] >= 0 ? LEAD[i] : i;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = gx + ox, yy = gy + oy; if (xx < 0 || yy < 0 || xx >= gw || yy >= HG.h) continue;
      for (let j = head[hb(xx, yy)]; j >= 0; j = next[j]) {
        if (OCCK[j] < 0 || (LEAD[j] >= 0 ? LEAD[j] : j) === party) continue;
        const d2 = (X[j] - x) * (X[j] - x) + (Y[j] - y) * (Y[j] - y);
        if (d2 < 0.3025 && d2 < (X[j] - X[i]) * (X[j] - X[i]) + (Y[j] - Y[i]) * (Y[j] - Y[i])) return true;
      }
    }
    return false;
  }
  function faceSlot(i, dt) {      // standing guests settle to the slot's facing (rate-limited)
    AVX[i] = AVY[i] = 0; SPD[i] = 0;
    const s = SLOT[i]; if (s < 0) return;
    const dy = wrapA(D.P.slots.yaw[s] - YAW[i]); if (dy > 0.002 || dy < -0.002) { let t = dy * Math.min(1, dt * 3); const m = 2.5 * dt; if (t > m) t = m; else if (t < -m) t = -m; YAW[i] = wrapA(YAW[i] + t); }
  }
  function canStand(i, x, y) {
    const N = D.N, fi = ((x - N.x0) / N.cell) | 0, fj = ((y - N.y0) / N.cell) | 0;
    if (fi < 1 || fj < 1 || fi >= N.W - 1 || fj >= N.H - 1) return false;
    const cv = N.clr[fj * N.W + fi];
    // near a wall: keep the body radius clear, or at least do not get any closer (so nobody is ever pinned)
    if (cv < (params.radius + 0.25 + 0.36) * 6) { const c = clearance(N, x, y); if (c < params.radius && c < clearance(N, X[i], Y[i]) + 0.002) return false; }
    if (OCC[fj * N.W + fi] && OCCK[i] < 0 && GHOST[i] <= 0 && standingBlocks(i, x, y)) return false;   // a standing guest there
    const g = ground(D.N, x, y); if (!(g === g) || Math.abs(g - Z[i]) > 0.45) return false;
    return true;
  }
  function settleStep(i, dt) {
    const S = D.P.slots, s = SLOT[i];
    ST0[i] += dt;
    if (STT[i] === ST.UNSETTLE) { unsettleStep(i, dt); return; }
    if (s < 0) { STT[i] = ST.WAIT; TIMER[i] = 0.5; return; }
    const site = D.P.sites[S.site[s]], sit = site.kind === 'sit' || S.anim[s] === ANIM.sit;
    {
      const tx = S.x[s], ty = S.y[s], ax = SX[i], ay = SY[i];
      // turn first: to face the slot (or, to sit down, to face away from the seat)
      const L = Math.hypot(tx - ax, ty - ay);
      const face = sit || L < 0.15 ? S.yaw[s] : Math.atan2(ty - ay, tx - ax);
      const diff = wrapA(face - YAW[i]);
      if (Math.abs(diff) > 0.12 && ST0[i] < 2.5 && STT2[i] > 0) {
        const rate = params.turnRate * 1.5; let turn = diff * 5; if (turn > rate) turn = rate; else if (turn < -rate) turn = -rate;
        YAW[i] = wrapA(YAW[i] + turn * dt); SPD[i] = Math.max(0, SPD[i] - params.decel * dt); ST0[i] = 0;
        PH[i] = (PH[i] + SPD[i] * dt / 1.4) % 256;
        if (SPD[i] < 0.05) { SPD[i] = 0; if (ANI[i] === ANIM.walk) ANI[i] = ANIM.stand; }
        return;
      }
      const u = Math.min(1, ST0[i] / STT2[i]);
      const px = X[i], py = Y[i];
      X[i] = ax + (tx - ax) * u; Y[i] = ay + (ty - ay) * u;
      const moved = Math.hypot(X[i] - px, Y[i] - py);
      if (sit) { ANI[i] = ANIM.sit; SPD[i] = 0; Z[i] = SZ[i] + (S.z[s] - SZ[i]) * u; YAW[i] = wrapA(YAW[i] + wrapA(S.yaw[s] - YAW[i]) * Math.min(1, dt * 6)); PH[i] = (PH[i] + dt * 0.3) % 256; }
      else {
        if (L >= 0.15) { ANI[i] = ANIM.walk; SPD[i] = moved / dt; PH[i] = (PH[i] + moved / 1.4) % 256; } else SPD[i] = 0;
        const g = ground(D.N, X[i], Y[i]); if (g === g) Z[i] += (g - Z[i]) * Math.min(1, dt * 10);
      }
      if (u >= 1) {
        SPD[i] = 0; X[i] = tx; Y[i] = ty; if (sit) Z[i] = S.z[s];
        const isQueue = site.kind === 'queue';
        if (isQueue) { STT[i] = (site.slots[0] === s && LEAD[i] < 0) ? ST.ACT : ST.QUEUE; TIMER[i] = dwell('queue'); ANI[i] = activityAnim(i); }
        else { STT[i] = ST.ACT; TIMER[i] = dwell(site.kind); ANI[i] = activityAnim(i); }
        ZT[i] = Z[i];
      }
    }
  }
  function unsettleStep(i, dt) {
    // stand up (sitters glide forward off the seat) / step back to the approach point, then walk on
    const u = Math.min(1, ST0[i] / STT2[i]);
    if (USIT[i]) { X[i] = SX[i] + (UX[i] - SX[i]) * u; Y[i] = SY[i] + (UY[i] - SY[i]) * u; const g = ground(D.N, UX[i], UY[i]); Z[i] = SZ[i] + ((g === g ? g : SZ[i]) - SZ[i]) * u; ANI[i] = u < 1 ? ANIM.sit : ANIM.stand; }
    else if (ANI[i] !== ANIM.walk) ANI[i] = ANIM.stand;
    SPD[i] = 0;
    if (u >= 1) {
      ZT[i] = Z[i];
      if (LEAD[i] < 0) { STT[i] = ST.WAIT; TIMER[i] = 0.4 + rnd() * 0.6; }
      else STT[i] = ST.FOLLOW;
    }
  }

  // ── reduce motion: settle everyone into calm poses at once ──
  crowd.update = update;
  crowd.setCount = (n) => { crowd.want = Math.max(0, Math.min(CAP, n | 0)); };
  crowd.setReduceMotion = (b) => { reduceMotion = !!b; };
  crowd.dispose = () => { disposed = true; if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; } };
  // debug access for the overlay and the tests
  Object.defineProperty(debug, 'D', { get: () => D });
  Object.assign(debug, {
    local, ST, arrays: { X, Y, Z, YAW, SPD, ANI, STT, SITE, SLOT, LEAD, GS, MODE, DSPD, DYAW },
    focus,
    measure() {          // pairs closer than 0.35 m (walkers involved) and walkers inside blocked cells
      let pairs = 0, inside = 0;
      const head = HG.head, next = HG.next, gw = HG.w, gh = HG.h, N = D.N;
      buildGrid();
      for (let i = 0; i < CAP; i++) {
        if (STT[i] === ST.OFF) continue;
        const walking = ANI[i] === ANIM.walk || ANI[i] === ANIM.stand && STT[i] !== ST.QUEUE && STT[i] !== ST.ACT;
        if (walking && clearance(N, X[i], Y[i]) < 0.0) inside++;
        const gx = Math.floor((X[i] - N.x0) / 2), gy = Math.floor((Y[i] - N.y0) / 2);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = gx + ox, yy = gy + oy; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          for (let j = head[hb(xx, yy)]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const d = Math.hypot(X[j] - X[i], Y[j] - Y[i]); if (d < 0.35 && Math.abs(Z[j] - Z[i]) < 1) pairs++;
          }
        }
      }
      return { pairs, inside };
    },
    pumpLocal(n = 1e9) { while (n-- > 0 && pendingLocal.length) { const s = pendingLocal.shift(); if (local.has(s)) { local.set(s, localField(D.N, D.P, s)); trimLocal(); } } },   // tests: the Worker's job, outside the timed frame
    countStates() { const c = {}; const names = Object.keys(ST); for (let i = 0; i < CAP; i++) { if (STT[i] === ST.OFF) continue; const n = names[STT[i]]; c[n] = (c[n] || 0) + 1; } return c; },
  });
  if (groundP) groundP.then((g) => { groundGrid = g; if (!disposed) start(); }); else start();
  return crowd;
}

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
