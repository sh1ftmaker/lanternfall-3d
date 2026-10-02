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
const hyp = (a, b) => Math.sqrt(a * a + b * b);        // Math.hypot is several times slower
const PATH = new Int32Array(16);
const HB = 8191, hb = (x, y) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & HB;
const clrByte = (N, x, y) => { const i = ((x - N.x0) / N.cell) | 0, j = ((y - N.y0) / N.cell) | 0; return (i < 0 || j < 0 || i >= N.W || j >= N.H) ? 0 : N.clr[j * N.W + i]; };
const MIN_D = 0.42, LOCAL_MAX = 768, LOCAL_REQ = 110;              // m: walkers never closer than this to anyone (position correction)
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
  lookahead: 4,                      // coarse cells along the flow field
  groupMix: [0.36, 0.36, 0.17, 0.11],// share of parties of 1, 2, 3, 4
  railShare: 0.38, siteShare: 0.5, walkShare: 0.14, leaveShare: 0.03,
  arrivalEvery: 3.5,                 // s between parties arriving at the gate (a party far from the camera leaves for each)
  reach: 45,                         // m: sites this far away are picked e^-1 as often as next-door ones
  lodNear: 35, lodMid: 90, lodFar: 200,    // m from the focus: think every 2 / 4 / 6 / 10 frames
  integrateNear: 25, integrateFar: 120,   // m: movement integrated every frame / every 2nd frame / only when thinking
  ghostAfter: 20,                    // s blocked before a guest may slip through others (the last resort, after impatience, sidestepping and a new goal)
  budget: 0.4,                       // ms per frame: the LOD distances shrink (down to 40 %) while the sim costs more
  hush: false,                       // game hook: clock: the silent four minutes: walkers inside the lake ring stop and face the Spire
  bias: null,                        // game hook: clock: where the evening draws people: { lands: { id: k }, pts: [{ x, y, r, k }], rail: k } (weights on picking a goal; null = none)
};

const ST = { OFF: 0, GO: 1, SETTLE: 2, ACT: 3, UNSETTLE: 4, QUEUE: 5, FOLLOW: 6, PAUSE: 7, WAIT: 8 };
const LAND_POP = { 'lantern-row': 1.35, meridian: 1.25, wanderers: 1.2, brinewatch: 1.1, frostmere: 1.0, rosewick: 0.95, guildhollow: 0.85, gate: 1.3, ring: 1, lake: 1 };

export function createCrowd(opts = {}) {
  const { nav, manifest, sync = false, mainThread = false } = opts;
  // the simulation runs in a module Worker when the browser has one: the main thread only posts the focus and copies
  // the state array back (one frame of latency). Without a Worker (or when it fails) it runs here.
  if (!sync && !mainThread && nav && nav.A && manifest && typeof Worker !== 'undefined' && typeof window !== 'undefined') {
    try { return remoteCrowd(opts); } catch (err) { /* fall through to the main thread */ }
  }
  return localCrowd(opts);
}

function capOf(count, max) { return Math.max(16, max || Math.ceil(Math.max(count, 400) * 1.7)); }
function groundFetch(pois, fetchBin) {
  if (!(pois && pois.ground && pois.ground.file && typeof fetchBin === 'function')) return null;
  return Promise.resolve().then(() => fetchBin(pois.ground.file)).then((u8) => ({ w: pois.ground.w, h: pois.ground.h, classes: pois.ground.classes, data: u8 })).catch(() => null);
}

// ── the Worker side's proxy ──
function remoteCrowd({ nav, manifest, pois = null, count = 1200, seed = 1, reduceMotion = false, max = 0, ground = null, fetchBin = null, onReady = null }) {
  const CAP = capOf(count, max);
  const state = new Float32Array(CAP * 8);
  for (let i = 0; i < CAP; i++) state[i * 8 + 5] = 255;
  const debug = { remote: true, version: 0, ready: false, error: null, times: {}, mainMs: 0, mainMean: 0, frameMean: 0, frameMax: 0, lodK: 1, thinkers: 0, counts: {}, steps: 0, dropped: 0 };
  const crowd = { count: CAP, state, active: 0, want: Math.min(count, CAP), params: { ...PARAMS }, debug, ready: false };
  let worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  let inFlight = 0, acc = 0, disposed = false, local = null;
  const msg = { type: 'step', dt: 0, time: 0, want: 0, focus: { x: 0, y: 0, z: 0, mode: 'tour', tour: -1 } };
  const fail = (why) => {                       // the Worker failed: carry on with a main-thread simulation
    if (local || disposed) return;
    debug.error = why; try { worker.terminate(); } catch (e) { /* gone */ } worker = null;
    local = localCrowd({ nav, manifest, pois, count: crowd.want, seed, reduceMotion, max: CAP, ground, fetchBin, onReady });
    crowd.state = local.state; crowd.debug.local = local.debug;
  };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'state') {
      const t0 = now(); inFlight--;
      if (m.buf.length === state.length) state.set(m.buf);
      worker.postMessage({ type: 'buf', buf: m.buf }, [m.buf.buffer]);           // the buffer goes back for the next step
      crowd.active = m.active; if (m.stats) Object.assign(debug, m.stats); debug.version++;
      debug.mainMs += now() - t0;
    } else if (m.type === 'ready') { crowd.ready = debug.ready = !!m.ready; debug.times = m.times; if (m.error) debug.error = m.error; if (onReady) onReady(crowd); }
    else if (m.type === 'error') fail(m.error);
  };
  worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fail((e && e.message) || 'worker failed'); };
  // the init message carries the parameters set so far: setParams() calls made before it (the clock's bias, sent as
  // soon as the crowd exists, while guestground.bin is still loading) reached a Worker that had no crowd yet and were lost
  const init = (g) => { if (!worker) return; worker.postMessage({ type: 'init', opts: { nav: { w: nav.w, h: nav.h, x0: nav.x0, y0: nav.y0, cell: nav.cell, A: nav.A }, manifest: { lake: manifest.lake, shore: manifest.shore, lands: manifest.lands, rail: manifest.rail }, pois, count: crowd.want, seed, reduceMotion, max: CAP, ground: g || ground, params: setSoFar } }); };
  const setSoFar = {};
  const gp = ground ? null : groundFetch(pois, fetchBin);
  if (gp) gp.then(init); else init(null);
  crowd.update = (dt, time, focus) => {
    if (local) { local.want = crowd.want; local.update(dt, time, focus); crowd.active = local.active; crowd.ready = local.ready; return; }
    if (!crowd.ready || !worker) return;
    const t0 = now();
    acc += dt > 0 ? dt : 0;
    if (inFlight >= 2) { debug.dropped++; return; }               // the worker is behind: send the time with the next step
    msg.dt = Math.min(acc, 0.1); acc = 0; msg.time = time; msg.want = crowd.want;
    const f = msg.focus; if (focus) { f.x = +focus.x || 0; f.y = +focus.y || 0; f.z = +focus.z || 0; f.mode = focus.mode || 'tour'; f.tour = focus.tour !== undefined ? +focus.tour : -1; }
    worker.postMessage(msg); inFlight++; debug.steps++;
    const ms = now() - t0 + debug.mainMs; debug.mainMs = 0;
    debug.mainMean += (ms - debug.mainMean) * 0.02;
  };
  crowd.setCount = (n) => { crowd.want = Math.max(0, Math.min(CAP, n | 0)); if (local) local.setCount(crowd.want); };
  crowd.setParams = (o) => { Object.assign(crowd.params, o); Object.assign(setSoFar, o); if (local) Object.assign(local.params, o); else if (worker) worker.postMessage({ type: 'params', params: o }); };
  crowd.setReduceMotion = (b) => { reduceMotion = !!b; if (local) local.setReduceMotion(b); else if (worker) worker.postMessage({ type: 'motion', on: reduceMotion }); };
  crowd.dispose = () => { disposed = true; if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } worker = null; } if (local) local.dispose(); };
  return crowd;
}

// ── the simulation itself (main thread, Node, or inside the Worker) ──
function localCrowd({ nav, manifest, pois = null, count = 1200, seed = 1, reduceMotion = false, max = 0, ground: groundGrid = null, fetchBin = null, sync = false, manualLocal = false, onReady = null } = {}) {
  const CAP = capOf(count, max);
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
  const pendingLocal = [];
  // every site object gets the same shape (fast, monomorphic property access in the per-frame code)
  const normSite = (o) => ({ id: o.id | 0, type: String(o.type), kind: String(o.kind), x: +o.x, y: +o.y, z: +o.z || 0, yaw: +o.yaw || 0, land: String(o.land || ''), cap: o.cap | 0,
    name: String(o.name || ''), hub: o.hub | 0, slots: Int32Array.from(o.slots), weight: +o.weight || 1, open: !!o.open, dance: !!o.dance, pop: LAND_POP[o.land] || 1 });
  const startSim = (prep) => { if (!prep.N.A) prep.N.A = nav.A; prep.P.sites = prep.P.sites.map(normSite); prep.P.gate = prep.P.sites[prep.P.gate.id]; D = prep; LUSE = new Int32Array(prep.P.sites.length); debug.times = prep.times; init(); debug.ready = crowd.ready = true; if (onReady) onReady(crowd); };

  // ── preparation: at once (Node, inside the Worker) or after the current frame (main thread) ──
  const groundP = !groundGrid && !sync ? groundFetch(pois, fetchBin) : null;
  const start = () => {
    const run = () => { if (disposed) return; try { startSim(prepare(nav, manifest, pois, seed, groundGrid)); } catch (err) { debug.error = String(err && err.stack || err); } };
    if (sync) run(); else setTimeout(run, 0);
  };
  // Local fields: computed on request (one per Worker step, nearest requests first is not needed: they are cheap), kept
  // while used. Pending requests never count against the cache, and a field is only forgotten when it has not been
  // used for a few seconds (before, a full cache evicted every new field at once and the guests waiting for it stood
  // still for good).
  let localN = 0;
  function trimLocal() {
    if (localN <= LOCAL_MAX) return;
    const cut = frameNo - 180, old = [];
    for (const [k, v] of local) if (v && LUSE[k] < cut) old.push(k);
    old.sort((a, b) => LUSE[a] - LUSE[b]);
    for (let q = 0; q < old.length && localN > LOCAL_MAX * 0.85; q++) { local.delete(old[q]); localN--; }
  }
  function requestLocal(site) {
    if (local.has(site)) { LUSE[site] = frameNo; return; }
    local.set(site, null); LUSE[site] = frameNo;
    pendingLocal.push(site);
  }
  function pumpOne() {                  // compute the oldest pending field still wanted; false when none was pending
    while (pendingLocal.length) {
      const s = pendingLocal.shift();
      if (!local.has(s) || local.get(s)) continue;
      if (LUSE[s] < frameNo - 600) { local.delete(s); continue; }       // nobody asked for it for 10 s
      local.set(s, localField(D.N, D.P, s)); localN++; trimLocal(); return true;
    }
    return false;
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
  const GXA = new Float32Array(CAP), GYA = new Float32Array(CAP), IMP = new Float32Array(CAP), PRI = new Float32Array(CAP), PROGD = new Float32Array(CAP).fill(1e9), PAX = new Float32Array(CAP), PAY = new Float32Array(CAP), FILE = new Float32Array(CAP), CALM = new Uint8Array(CAP), NBL = new Int32Array(CAP * 4).fill(-1);   // own goal point; impatience (0..1) while blocked
  const BLK = new Uint8Array(CAP), WANT = new Float32Array(CAP);      // blocked at the last think; the speed wanted before avoidance
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
      const x = cellX(N, c), y = cellY(N, c), r = hyp(x / 160, y / 119);
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
    STUCK[i] = 0; JAM[i] = 0; GHOST[i] = 0; IMP[i] = 0; FILE[i] = 0; GK[i] = -1; ACC[i] = 0; LOD[i] = 1; SIDE[i] = rnd() < 0.5 ? 1 : -1; LEAVING[i] = 0; VX[i] = VY[i] = 0; AVX[i] = AVY[i] = 0; DFOC[i] = 0; PX[i] = x; PY[i] = y;
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
    const g = D.P.gate, fd = hyp(focus.x - g.x, focus.y - g.y);
    let x, y;
    if (atGate || fd > 60 || rnd() < 0.15) { const S = D.P.slots, k = g.slots[(rnd() * g.slots.length) | 0]; x = S.x[k] + (rnd() - 0.5); y = S.y[k] + (rnd() - 0.5); }
    else { let c = randomSpawnCell(); for (let t = 0; t < 12; t++) { const cx = cellX(D.N, c), cy = cellY(D.N, c); if (hyp(cx - focus.x, cy - focus.y) > 90) break; c = randomSpawnCell(); } x = cellX(D.N, c); y = cellY(D.N, c); }
    if (clearance(D.N, x, y) < 0.4) { const c = nearestCell(D.N, x, y, 4); if (c < 0) return -1; x = cellX(D.N, c); y = cellY(D.N, c); }
    const L = spawnParty(x, y, Math.PI, size); if (L < 0) return -1;
    const fromGate = hyp(x - g.x, y - g.y) < 20;
    if (!pickGoal(L, 0, fromGate ? 90 : 0)) { STT[L] = ST.WAIT; TIMER[L] = 2; }    // from the gate: somewhere well inside the park
    return L;
  }
  // the gate: a steady trickle of arrivals walking in; to keep the count, a party far from the camera goes home
  let arriveT = 2;
  function gateTick(dt) {
    arriveT -= dt; if (arriveT > 0) return;
    // the tour's overview flies high over the park just before the gate walk: more arrivals then, so the avenue has a
    // stream of people walking in when the camera comes down to it (pops at the gate are invisible from up there)
    const pre = focus.tour >= 0 && (focus.tour < 12 || focus.tour > 148);
    arriveT = params.arrivalEvery * (pre ? 0.3 : 1) * (0.6 + 0.8 * rnd());
    const g = D.P.gate; if (focus.mode === 'walk' && hyp(focus.x - g.x, focus.y - g.y) < 25) return;
    const size = partySize();
    if (crowd.active + size > crowd.want) {
      let best = -1, bd = 130;
      for (let t = 0; t < 40; t++) {
        const i = (rnd() * CAP) | 0; if (STT[i] !== ST.GO || LEAD[i] >= 0) continue;
        const d = hyp(X[i] - focus.x, Y[i] - focus.y); if (d > bd && hyp(X[i] - g.x, Y[i] - g.y) > 100) { bd = d; best = i; }
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
  let biasRef = null, biasL = { site: [], walk: [] };
  function biasLists(sites, B, want) {   // game hook: clock: open sites of the favoured lands, by what the guest is looking for
    if (biasRef !== B) { biasRef = B; const ids = Object.keys(B.lands || {}); biasL = { site: ids.map((id) => sites.filter((x) => x.land === id && x.open && x.kind !== 'walk' && x.kind !== 'rail' && x.kind !== 'gate')).filter((l) => l.length), walk: ids.map((id) => sites.filter((x) => x.land === id && x.open && x.kind === 'walk')).filter((l) => l.length) }; }
    return biasL[want];
  }
  // a slow drift toward the lake. In the tour (a 158 s loop) the rail should be lined for the Spire shot (32-49 s):
  // walking there takes a minute or two, so guests start heading for the lake from ~90 s and those who arrive from
  // ~130 s stay long. Elsewhere a gentle 150 s swell.
  function rhythm() {              // wish to go to the lake
    const t = focus.tour;
    if (t >= 0) return t > 85 || t < 25 ? 1 : 0.25;
    return 0.5 + 0.5 * Math.sin(simTime * TAU / 150);
  }
  function rhythmStay() {          // how long to stay at the rail
    const t = focus.tour;
    if (t >= 0) return t > 120 || t < 45 ? 1 : 0.3;
    return 0.5 + 0.5 * Math.sin(simTime * TAU / 150 + 1);
  }
  function pickGoal(L, avoidSite, minDist = 0) {
    debug.ev.goal++;
    const P = D.P, sites = P.sites, size = GS[L];
    // leaving: the population is too big, or a party simply goes home
    let want = 'site';
    if (LEAVING[L] || crowd.active > crowd.want + 2) { want = 'gate'; LEAVING[L] = 1; }
    else {
      const lv = params.leaveShare * (0.3 + 8 * Math.exp(-hyp(X[L] - P.gate.x, Y[L] - P.gate.y) / 80));   // mostly those near the gate go home
      const rr = params.railShare * (0.5 + 1.5 * rhythm()) * (params.bias && params.bias.rail || 1), r = rnd() * (rr + params.siteShare + params.walkShare + lv);
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
      // game hook: clock: a few more candidates from the lands the evening favours, so the pull reaches guests far away
      const B = params.bias, bl = B && B.lands && (want === 'site' || want === 'walk') ? biasLists(sites, B, want) : null, extra = bl && bl.length ? 10 : 0;
      for (let t = 0; t < nn + 12 + extra && n < (extra ? 62 : 56); t++) {
        let s;
        if (t < nn) { const r = t + ((rnd() * (nn - t)) | 0), id = near[r]; near[r] = near[t]; near[t] = id; s = sites[id]; }
        else if (t < nn + 12) s = sites[(rnd() * sites.length) | 0];
        else { const lst = bl[(rnd() * bl.length) | 0]; s = lst[(rnd() * lst.length) | 0]; }
        if (!s.open || s.id === avoidSite || s.kind === 'gate') continue;
        if (want === 'rail' ? s.kind !== 'rail' : want === 'walk' ? s.kind !== 'walk' : (s.kind === 'rail' || s.kind === 'walk')) continue;
        if (freeSlots(s, size) < 0) continue;
        const d = hyp(s.x - X[L], s.y - Y[L]);
        if (d < minDist) continue;
        const kl = B && B.lands && B.lands[s.land] || 1;                                  // game hook: clock: a favoured land is reached from further away
        // the lake rail is one long feature: guests spread along it (a longer reach) instead of all taking the nearest stretch
        let w = s.weight * s.pop * (Math.exp(-d / (params.reach * kl * (s.kind === 'rail' ? 1.8 : 1))) + 0.05) * kl;
        // capacity and crowding: a spot that is nearly full, or in a crowded square, is chosen less (it would only fill
        // up and the people walking there would press into the crowd)
        if (s.kind !== 'walk') { const sl = s.slots; let fr = 0; for (let q = 0; q < sl.length; q++) if (D.P.slots.occ[sl[q]] < 0) fr++; const ff = fr / sl.length; w *= 0.15 + 0.85 * ff * ff; }
        { const dn = densAt(s.x, s.y); if (dn > 6) w /= 1 + ((dn - 6) / 8) * ((dn - 6) / 8); }
        if (want === 'walk' && d < 25) w *= 0.1;
        if (B) { if (B.pts) for (const q of B.pts) { const dq = hyp(s.x - q.x, s.y - q.y); if (dq < q.r * 3) w *= 1 + (q.k - 1) * Math.exp(-dq / q.r); } }   // game hook: clock
        if (focus.mode === 'walk' && hyp(s.x - focus.x, s.y - focus.y) < 3) w *= 0.05;    // not in the walker's face
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
      if (site.kind === 'walk' || site.kind === 'gate') {
        SLOT[i] = site.slots[(rnd() * site.slots.length) | 0];
        // a waypoint is a place, not a point: each party aims somewhere within a few metres of it (before, everyone
        // bound for a waypoint walked to the same spot and they knotted there)
        let gx = S.ax[SLOT[i]], gy = S.ay[SLOT[i]];
        if (q === 0) for (let t = 0; t < 5; t++) {
          const a = rnd() * TAU, r = 1 + rnd() * (site.kind === 'gate' ? 2 : 3.5), x = gx + Math.cos(a) * r, y = gy + Math.sin(a) * r;
          const c = cellAt(D.N, x, y); if (c >= 0 && D.P.comp.lab[c] === D.P.main && clearance(D.N, x, y) > 0.6) { gx = x; gy = y; break; }
        } else { gx = GXA[L]; gy = GYA[L]; }
        GXA[i] = gx; GYA[i] = gy;
      } else { const s = site.slots[Math.min(site.slots.length - 1, k0 + q)]; SLOT[i] = s; S.occ[s] = i; GXA[i] = S.ax[s]; GYA[i] = S.ay[s]; }
    }
    STT[L] = ST.GO; MODE[L] = 0; RT[L] = 0;
    for (let q = 0; q < members.length; q++) { const m = members[q]; STUCK[m] = 0; PROGD[m] = 1e9; PAX[m] = X[m]; PAY[m] = Y[m]; }
    for (let q = 1; q < members.length; q++) { const f = members[q]; if (STT[f] !== ST.FOLLOW) { STT[f] = ST.FOLLOW; } }
    if (hyp(site.x - X[L], site.y - Y[L]) < LOCAL_REQ) requestLocal(site.id);
    return true;
  }
  function releaseSlot(i) { const s = SLOT[i]; if (s >= 0 && D && D.P.slots.occ[s] === i) D.P.slots.occ[s] = -1; SLOT[i] = -1; }
  function releaseParty(L) { releaseSlot(L); for (let k = 0; k < 4; k++) { const f = MEM[L * 4 + k]; if (f >= 0) releaseSlot(f); } }
  function dwell(kind) {
    switch (kind) {
      case 'sit': return 45 + rnd() * 100;
      case 'rail': return (45 + rnd() * 100) * (0.6 + 0.9 * rhythmStay()) * Math.max(1, params.bias && params.bias.rail || 1);   // game hook: clock: they stay for the show
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
    if (site.kind === 'stage') return rnd() < (site.dance ? 0.35 : 0.1) ? ANIM.wave : ANIM.stand;    // the dance floor sways (wave = sway there)
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
    if (pendingLocal.length && !manualLocal) pumpOne();
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
        else if (WANT[i] > 0.3 && SPD[i] < 0.2) { JAM[i] += dt; if (JAM[i] > params.ghostAfter) { JAM[i] = 0; GHOST[i] = 1.6; debug.ev.ghost++; if (debug.onGhost) debug.onGhost(i); } }   // the last resort, after impatience and a new goal
        else if (JAM[i] > 0) JAM[i] = Math.max(0, JAM[i] - dt * 2);
      } else if (GHOST[i] > 0) GHOST[i] = 0;
      // level of detail: distance to the focus, refreshed every 8th frame (staggered)
      if (((frameNo + i) & 7) === 0 || DFOC[i] === 0) { const dx = X[i] - focus.x, dy = Y[i] - focus.y, dz = Z[i] - focus.z; DFOC[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01; }
      // think less often with nobody near and nothing in the way (CALM, set by the steering)
      const d = DFOC[i] * lodInv, iv = (d < p.lodNear ? 2 : d < p.lodMid ? 4 : d < p.lodFar ? 6 : 10) << CALM[i];
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
  // head count per 6 m square (all guests), refreshed twice a second: goal choice avoids crowded squares
  let DG = null, DGW = 0;
  function densAt(x, y) { const i = ((x - D.N.x0) / 6) | 0, j = ((y - D.N.y0) / 6) | 0; return i < 0 || j < 0 || i >= DGW || j * DGW >= DG.length ? 0 : DG[j * DGW + i]; }
  function buildGrid() {
    const head = HG.head, next = HG.next, gw = HG.w, gh = HG.h, x0 = D.N.x0, y0 = D.N.y0;
    head.fill(-1);
    if (!DG) { DGW = Math.ceil(D.N.W * D.N.cell / 6); DG = new Uint16Array(DGW * Math.ceil(D.N.H * D.N.cell / 6)); }
    if (frameNo % 30 === 1) { DG.fill(0); for (let i = 0; i < CAP; i++) { if (STT[i] === ST.OFF) continue; const a = ((X[i] - x0) / 6) | 0, b = ((Y[i] - y0) / 6) | 0; if (a >= 0 && b >= 0 && a < DGW) { const k = b * DGW + a; if (k < DG.length && DG[k] < 65535) DG[k]++; } } }
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
      const d = hyp(X[i] - focus.x, Y[i] - focus.y); if (d > bd) { bd = d; best = i; }
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
        cx /= n; cy /= n; if (hyp(cx - X[i], cy - Y[i]) > 0.15) YAW[i] = DYAW[i] = Math.atan2(cy - Y[i], cx - X[i]);
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
    let vx = tx - X[i], vy = ty - Y[i]; const L = hyp(vx, vy) || 1;
    vx = vx / L * speed; vy = vy / L * speed;
    avoid(i, vx, vy);
  }
  function goStep(i, dt) {
    const N = D.N, P = D.P, S = P.slots, s = SLOT[i]; if (s < 0) { STT[i] = ST.WAIT; TIMER[i] = 1; return; }
    const site = P.sites[SITE[i]], gx = GXA[i], gy = GYA[i];
    const dx = gx - X[i], dy = gy - Y[i], d = hyp(dx, dy);
    const isFollowerGoing = LEAD[i] >= 0;
    if (isFollowerGoing && (SITE[LEAD[i]] !== SITE[i] || STT[LEAD[i]] === ST.OFF)) { STT[i] = ST.FOLLOW; return; }
    const arriveR = site.kind === 'walk' ? 1.6 : site.kind === 'gate' ? 2.5 : 0.22;
    // the gate: anywhere across the avenue's end; a spot: close enough when someone stands at its approach point
    if (d < arriveR || (site.kind === 'gate' && hyp(site.x - X[i], site.y - Y[i]) < 7) || (d < 0.9 && IMP[i] > 0.4 && site.kind !== 'walk')) { arrive(i, site); return; }
    RT[i] -= dt;
    const replan = RT[i] <= 0 || hyp(TX[i] - X[i], TY[i] - Y[i]) < 1.1;
    if (replan && d < LOCAL_REQ && !local.has(site.id)) requestLocal(site.id);
    // the last metres: straight to the own spot once it is in plain sight. A site's local field leads to the nearest of
    // its spots (fields are shared by everyone bound for the site), so a guest who reached one of them walks on to its
    // own spot from there (before, the field pulled it back to the nearest spot and it paced to and fro)
    if (replan && MODE[i] !== 2 && (d < 6 || (d < 14 && atSource(i, site))) && lineClear(N, X[i], Y[i], gx, gy, 0.22)) MODE[i] = 2;
    else if (replan && MODE[i] === 2 && (d > 16 || !lineClear(N, X[i], Y[i], gx, gy, 0.12))) MODE[i] = 0;
    let tx, ty, speed = PREF[i];
    if (MODE[i] !== 2 && !replan) { tx = TX[i]; ty = TY[i]; }
    else if (MODE[i] === 2) {
      tx = gx; ty = gy; speed = Math.min(PREF[i], 0.25 + d * 0.8);
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
          // Where to head: the route's next metres moved sideways to start where I am (so a crowd keeps its spread across
          // a promenade instead of everyone aiming at the same spot), the farthest such point in plain sight; failing
          // that, the farthest cell of the route in plain sight (the most open spot of each 1 m cell)
          const R = 0.2, ax = fineX(N, PATH[0]), ay = fineY(N, PATH[0]);
          let k = steps, ok = false;
          for (; k > 1 && !ok; k--) { tx = fineX(N, PATH[k]) - ax + X[i]; ty = fineY(N, PATH[k]) - ay + Y[i]; ok = lineClear(N, X[i], Y[i], tx, ty, R); }
          if (!ok) {
            k = steps; tx = fineX(N, PATH[k]); ty = fineY(N, PATH[k]);
            for (; k > 1; k--) { tx = fineX(N, PATH[k]); ty = fineY(N, PATH[k]); if (lineClear(N, X[i], Y[i], tx, ty, R)) break; }
            if (k === 1) { tx = fineX(N, PATH[1]); ty = fineY(N, PATH[1]); }
          }
          // keep right: offset the target to the right of the route, as far as clearance allows
          const rx = ty - Y[i], ry = -(tx - X[i]), rl = hyp(rx, ry) || 1;
          for (let lane = LANE[i]; lane > 0.3; lane *= 0.5) {
            const ox = tx + rx / rl * lane, oy = ty + ry / rl * lane;
            if (clearance(N, ox, oy) > 0.6 && lineClear(N, X[i], Y[i], ox, oy, 0.28)) { tx = ox; ty = oy; break; }
          }
        }
      }
      TX[i] = tx; TY[i] = ty; RT[i] = 0.45 + rnd() * 0.3;
    }
    // a party leader waits for stragglers
    if (GS[i] > 1 && LEAD[i] < 0) {
      let far = 0; for (let k = 0; k < 4; k++) { const f = MEM[i * 4 + k]; if (f >= 0 && STT[f] === ST.FOLLOW) far = Math.max(far, hyp(X[f] - X[i], Y[f] - Y[i])); }
      if (far > 3.5) speed *= Math.max(0.35, 1 - (far - 3.5) * 0.25);
    }
    steerTo(i, tx, ty, speed);
    // stuck: wanting to move but not moving for a while
    if (params.hush && X[i] * X[i] + Y[i] * Y[i] < 14884) { WANT[i] = 0; STUCK[i] = 0; PAX[i] = X[i]; PAY[i] = Y[i]; return; }   // game hook: clock: standing still on purpose
    // no progress (blocked, or pacing round a knot): measured as the distance to the goal not shrinking by half a
    // metre for a while. A party then picks somewhere else (a spot that cannot be reached now is given up)
    const ax = X[i] - PAX[i], ay = Y[i] - PAY[i];
    if (d < PROGD[i] - 0.5 || ax * ax + ay * ay > 6.25) { PROGD[i] = Math.min(PROGD[i], d); PAX[i] = X[i]; PAY[i] = Y[i]; STUCK[i] = 0; }   // closer, or 2.5 m on along the route
    else if (WANT[i] > 0.2 || SPD[i] > 0.2) {
      STUCK[i] += dt;
      if (STUCK[i] > 8 && !isFollowerGoing) { STUCK[i] = 0; MODE[i] = 0; debug.ev.repick = (debug.ev.repick || 0) + 1; if (debug.trace) debug.trace.push(X[i], Y[i], site.id); if (debug.onRepick) debug.onRepick(i); if (!pickGoal(i, SITE[i])) { STT[i] = ST.WAIT; TIMER[i] = 2; } }
    }
  }
  // within 3 m of one of the site's approach points (its local field's sources)
  function atSource(i, site) {
    const S = D.P.slots, sl = site.slots, x = X[i], y = Y[i];
    for (let k = 0; k < sl.length; k++) { const dx = S.ax[sl[k]] - x, dy = S.ay[sl[k]] - y; if (dx * dx + dy * dy < 9) return true; }
    return false;
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
    const L = hyp(S.x[s] - X[i], S.y[s] - Y[i]);
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
        S.occ[sl[k]] = -1; S.occ[sl[w]] = a; SLOT[a] = sl[w]; GXA[a] = S.ax[sl[w]]; GYA[a] = S.ay[sl[w]];
        // walk up to the new place
        if (STT[a] === ST.QUEUE || STT[a] === ST.ACT || STT[a] === ST.SETTLE) { STT[a] = ST.SETTLE; SX[a] = X[a]; SY[a] = Y[a]; SZ[a] = Z[a]; ST0[a] = 0; STT2[a] = Math.max(0.4, hyp(S.x[sl[w]] - X[a], S.y[sl[w]] - Y[a]) / 0.55); }
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
    // single file: in a narrow place, when people come the other way (the leader saw them), or when the side-by-side
    // place is not walkable. Parties walking abreast closed lanes and two of them meeting made a wall
    if (FILE[L] > 0 || (clrByte(N, tx, ty) < 7 && clearance(N, tx, ty) < 0.35) || (clrByte(N, (tx + X[L]) * 0.5, (ty + Y[L]) * 0.5) < 7 && clearance(N, (tx + X[L]) * 0.5, (ty + Y[L]) * 0.5) < 0.3)) { tx = X[L] - c * 0.8 * GI[i]; ty = Y[L] - s * 0.8 * GI[i]; }
    const dx = tx - X[i], dy = ty - Y[i], d = hyp(dx, dy), dl = hyp(X[L] - X[i], Y[L] - Y[i]);
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
    let sp = hyp(vx, vy); const cap = Math.max(PREF[i] * 1.35, lsp * 1.3);
    if (sp > cap) sp = cap;
    if (sp < 0.05) { DSPD[i] = 0; return; }
    const L2 = hyp(vx, vy) || 1;
    avoid(i, vx / L2 * sp, vy / L2 * sp);
  }

  // ── local avoidance ──
  // Vision-based steering (after Moussaid, Helbing & Theraulaz 2011): a guest looks along a fan of headings round the
  // way it wants to go, and for each one finds how far it could walk before touching someone (each neighbour moving
  // at its current velocity: anticipation, not last-moment pushing) or a wall. It takes the heading that gets it
  // closest to where it wants to be after `horizon` metres, with a slight preference for the right (two streams form
  // lanes), and walks only as fast as it can still stop before the first contact (it waits instead of pressing on).
  // Bodies never overlap: closer than MIN_D, positions are corrected (shared with walking neighbours). Guests far from
  // the camera look at fewer headings. Party members keep apart with a soft spacing only (they walk side by side).
  const NBX = new Float32Array(16), NBY = new Float32Array(16), NBU = new Float32Array(16), NBV = new Float32Array(16), NBR = new Float32Array(16);   // up to 12 neighbours (+ the walker)
  // fans of headings, ordered by angle from the wanted one (0, +a, -a, +2a, ...): the search stops as soon as no wider
  // heading can beat the best so far. FANK = signed step index (positive = to the left)
  const FANC = [], FANS = [], FANK = [];
  for (const [n, st] of [[6, 0.26], [4, 0.33], [2, 0.5], [12, 0.2618]]) {      // near, mid, far; the last one is a full circle (someone blocked)
    const c = [], s = [], kk = [];
    for (let m = 0; m <= 2 * n; m++) { const k = m === 0 ? 0 : (m & 1 ? (m + 1) >> 1 : -(m >> 1)); c.push(Math.cos(k * st)); s.push(Math.sin(k * st)); kk.push(k); }
    FANC.push(c); FANS.push(s); FANK.push(kk);
  }
  function wallFree(N, x, y, ux, uy, dmax) {     // metres free along (ux, uy) before the body touches a wall
    const thr = (params.radius + 0.25) * 3 / N.cell, ix = 1 / N.cell, W = N.W, clr = N.clr;
    for (let s = 0.25; s <= dmax; s += 0.25) {
      const fi = ((x + ux * s - N.x0) * ix) | 0, fj = ((y + uy * s - N.y0) * ix) | 0;
      if (fi < 0 || fj < 0 || fi >= W || fj >= N.H || clr[fj * W + fi] < thr) return s - 0.25;
    }
    return dmax;
  }
  function avoid(i, vx, vy) {
    const xi = X[i], yi = Y[i], head = HG.head, next = HG.next, gw = HG.w, gh = HG.h, N = D.N;
    const gx = Math.floor((xi - N.x0) / 2), gy = Math.floor((yi - N.y0) / 2);
    const want = hyp(vx, vy); WANT[i] = want;
    let fx = 0, fy = 0, nb = 0, cxs = 0, cys = 0, oncoming = false, calm = 0;
    NBL[i * 4] = NBL[i * 4 + 1] = NBL[i * 4 + 2] = NBL[i * 4 + 3] = -1;
    const ghost = GHOST[i] > 0;
    const lead = LEAD[i] >= 0 ? LEAD[i] : i;
    const ux0 = want > 1e-3 ? vx / want : Math.cos(YAW[i]), uy0 = want > 1e-3 ? vy / want : Math.sin(YAW[i]);
    const imp = IMP[i];          // impatience: someone blocked for a while accepts closer contact, a wider fan and creeping
    const pri = PRI[i] = (MODE[i] === 2 ? 2 : 0) + (imp > 0.5 ? 1 : 0) + SEED[i] * 0.9;
    if (!ghost) for (let oy = -1; oy <= 1; oy++) {
      const yy = gy + oy; if (yy < 0 || yy >= gh) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox; if (xx < 0 || xx >= gw) continue;
        for (let j = head[hb(xx, yy)]; j >= 0; j = next[j]) {
          if (j === i) continue;
          const px = X[j] - xi, py = Y[j] - yi, r2 = px * px + py * py;
          if (r2 > 10.24 || Math.abs(Z[j] - Z[i]) > 1.2) continue;
          const same = (LEAD[j] >= 0 ? LEAD[j] : j) === lead;
          if (r2 < 0.36) {
            const r = Math.sqrt(r2) || 0.01;
            // a soft spacing (party members 0.5 m, others 0.6 m): side by side walkers drift apart instead of brushing
            const sp0 = same ? 0.5 : 0.6; if (r < sp0) { const k = (sp0 - r) / sp0 * Math.max(0.6, want) * (same ? 1 : 0.8); fx -= px / r * k; fy -= py / r * k; }
            if (r < MIN_D) { const share = (STT[j] === ST.GO || STT[j] === ST.FOLLOW) ? 0.5 : 1.0, k = (MIN_D - r) * share; cxs -= px / r * k; cys -= py / r * k; }
          }
          if (same) continue;
          if (r2 < 1.44) { let q = 0, far = -1, fr = r2; for (; q < 4; q++) { const k = NBL[i * 4 + q]; if (k < 0) { far = q; fr = 99; break; } const d2 = (X[k] - xi) * (X[k] - xi) + (Y[k] - yi) * (Y[k] - yi); if (d2 > fr) { fr = d2; far = q; } } if (far >= 0) NBL[i * 4 + far] = j; }
          // make way: someone with right of way coming at me from close by pushes me aside, off their line
          if (r2 < 1.44 && PRI[j] > PRI[i] && WANT[j] > 0.3) {
            const sj = STT[j];
            if (sj === ST.GO || sj === ST.FOLLOW) {
              const vl = hyp(VX[j], VY[j]) || 1, cj = VX[j] / vl, sn = VY[j] / vl, ahead = -(px * cj + py * sn), lat = -(px * -sn + py * cj);   // my position in their frame
              if (ahead > 0 && ahead < 1.2 && lat > -0.7 && lat < 0.7) { const side = lat > 0.05 ? 1 : lat < -0.05 ? -1 : SIDE[i], k = (0.7 - Math.abs(lat)) * 0.9 * (1.2 - ahead); fx += -sn * side * k; fy += cj * side * k; }
            }
          }
          // behind me and not coming at me: ignore
          if (px * ux0 + py * uy0 < -0.3 && (AVX[j] * ux0 + AVY[j] * uy0) <= 0.3) continue;
          // right of way: someone with a lower priority who also wants to walk will make room (they see me at full size), so I
          // give them less room. Priority: on the last metres to a spot, then impatience, then a fixed per-guest rank. In a
          // knot of people who all wait for each other, the one with the highest priority moves first and the rest follow.
          let R = SPD[j] < 0.1 ? 0.5 : 0.56;
          const sj = STT[j]; if ((sj === ST.GO || sj === ST.FOLLOW) && WANT[j] > 0.3 && PRI[j] < pri) R -= 0.06;
          // keep the 12 nearest (in a crush, the one at my elbow must not be the one left out)
          let q = nb;
          if (nb >= 12) { let fq = -1, fd = r2; for (let t = 0; t < 12; t++) { const d2 = NBX[t] * NBX[t] + NBY[t] * NBY[t]; if (d2 > fd) { fd = d2; fq = t; } } if (fq < 0) continue; q = fq; } else nb++;
          NBX[q] = px; NBY[q] = py; NBU[q] = AVX[j]; NBV[q] = AVY[j]; NBR[q] = R - imp * 0.06;
          if (GS[i] > 1 && lead === i) { const ah = px * ux0 + py * uy0, la = px * uy0 - py * ux0; if (ah > 0 && ah < 4.5 && la < 1.6 && la > -1.6 && (AVX[j] * ux0 + AVY[j] * uy0 < -0.2 || SPD[j] < 0.1)) oncoming = true; }
        }
      }
    }
    // the walker (Walk mode) is a neighbour too, given more room
    if (focus.mode === 'walk') {
      const px = focus.x - xi, py = focus.y - yi, r2 = px * px + py * py;
      if (r2 < 16 && nb < 16) { NBX[nb] = px; NBY[nb] = py; NBU[nb] = focus.vx; NBV[nb] = focus.vy; NBR[nb] = 0.9; nb++; if (r2 < 0.81) { const r = Math.sqrt(r2) || 0.01, k = (0.9 - r) / 0.9 * 1.5; fx -= px / r * k; fy -= py / r * k; } }
    }
    let bux = ux0, buy = uy0, sp = want;
    if (want > 0.05) {
      const horizon = Math.min(4, 1.2 + want * 2.2);
      const fi = ((xi - N.x0) / N.cell) | 0, fj = ((yi - N.y0) / N.cell) | 0;
      const open = clrByte(N, xi, yi) >= 3 * (horizon + params.radius + 0.25) / N.cell;      // no wall within the horizon
      if (nb === 0 && (open || wallFree(N, xi, yi, ux0, uy0, horizon) >= horizon)) { calm = open && imp === 0 ? 1 : 0; }
      else {
        // someone blocked for a while looks all round, and values free room for itself: it sidesteps, slides along a wall
        // or turns away instead of waiting for good (the plain measure never prefers a step that does not get closer)
        const dl = DFOC[i] * lodInv, fan = imp > 0.25 ? 3 : dl < params.lodNear ? 0 : dl < params.lodMid ? 1 : 2, C = FANC[fan], S = FANS[fan], K = FANK[fan], h2 = horizon * horizon, kf = imp * 1.6 * horizon;
        let best = 1e9, bf = 0;
        for (let k = 0; k < C.length; k++) {
          if (h2 * S[k] * S[k] - kf * horizon > best && C[k] > -0.99) { if (!kf) break; continue; }   // no wider heading can do better
          const ux = ux0 * C[k] - uy0 * S[k], uy = ux0 * S[k] + uy0 * C[k];
          let f = horizon;
          // neighbours: first contact along u at my speed, with each one moving at its velocity
          for (let q = 0; q < nb; q++) {
            const px = NBX[q], py = NBY[q], d2 = px * px + py * py, wx = NBU[q] - ux * want, wy = NBV[q] - uy * want;
            // contact = closer than the comfort distance, or (already closer, in a crush) than we are now: sliding past
            // and stepping back stay possible, so a packed group never locks up
            let R = NBR[q]; if (d2 < R * R) R = Math.sqrt(d2) - 0.04;
            const c0 = d2 - R * R, b = px * wx + py * wy;
            if (b >= 0) continue;                                                          // moving apart
            const a = wx * wx + wy * wy, disc = b * b - a * c0; if (disc <= 0 || a < 1e-6) continue;
            const t = (-b - Math.sqrt(disc)) / a, dist = t * want; if (dist < f) f = dist;
          }
          if (f > 0 && !open) f = Math.min(f, wallFree(N, xi, yi, ux, uy, f));
          // distance left to the point `horizon` ahead on the wanted line; turning left costs a little more
          let dd = h2 + f * f - 2 * horizon * f * C[k] - kf * f;
          if (K[k] > 0) dd += 0.06 * horizon * K[k]; else if (K[k] === 0) dd -= 0.02 * horizon;
          if (dd < best) { best = dd; bux = ux; buy = uy; bf = f; }
        }
        // walk only as fast as one can stop before the first contact (0.6 s), and slow round sharp turns
        sp = Math.min(want, Math.max(0, bf - 0.15) / 0.6);
        if (bf > 0.06 && sp < imp * 0.4) sp = Math.min(want, imp * 0.4);
      }
    }
    // a party leader puts the party in single file for a while when people come the other way or the way narrows
    if (GS[i] > 1 && lead === i) { if (oncoming || clrByte(N, xi, yi) < 8) FILE[i] = 2.5; else if (FILE[i] > 0) FILE[i] -= thinkDt; }
    // impatience grows while blocked (full after ~3 s) and fades when walking again
    const blk = want > 0.3 && sp < want * 0.35;
    IMP[i] = blk ? Math.min(1, imp + thinkDt / 3) : Math.max(0, imp - thinkDt / 2);
    // walls: push away from obstacles closer than 0.45 m (clearance gradient)
    const c0 = clrByte(N, xi, yi) >= 9 ? 1 : clearance(N, xi, yi);     // 9 units = 1.5 m between cell centres: open ground
    if (c0 < 0.45) {
      const gxw = clearance(N, xi + 0.25, yi) - clearance(N, xi - 0.25, yi), gyw = clearance(N, xi, yi + 0.25) - clearance(N, xi, yi - 0.25), gl = hyp(gxw, gyw);
      if (gl > 1e-3) { const k = (0.45 - c0) * 1.2; fx += gxw / gl * k; fy += gyw / gl * k; }
    }
    if (cxs !== 0 || cys !== 0) {
      const cl = hyp(cxs, cys), cap = 0.03 + thinkDt * 0.3; if (cl > cap) { cxs *= cap / cl; cys *= cap / cl; }
      const nx = xi + cxs, ny = yi + cys; if (canStand(i, nx, ny)) { X[i] = nx; Y[i] = ny; }
    }
    vx = bux * sp + fx; vy = buy * sp + fy;
    let s2 = hyp(vx, vy);
    if (s2 > want * 1.1 + 0.05) s2 = want * 1.1 + 0.05;
    // the heading follows a low-passed desired velocity (no wiggle when the neighbours change)
    const ks = thinkDt / (0.18 + thinkDt);
    VX[i] += (vx - VX[i]) * ks; VY[i] += (vy - VY[i]) * ks;
    if (VX[i] * VX[i] + VY[i] * VY[i] > 4e-4) DYAW[i] = Math.atan2(VY[i], VX[i]);
    else if (s2 > 0.02) DYAW[i] = Math.atan2(vy, vx);
    DSPD[i] = s2;
    if (params.hush && xi * xi + yi * yi < 14884) WANT[i] = 0;      // game hook: clock: the silent minutes (not blocked: standing on purpose)
    BLK[i] = blk ? 1 : 0;      // blocked by people or a wall this think
    CALM[i] = calm && !ghost && focus.mode !== 'walk' ? 1 : 0;
  }

  // ── movement (every frame near the camera) ──
  function integrate(i, dt) {
    if (dt <= 0) return;
    const st = STT[i], N = D.N, p = params;
    if (st === ST.SETTLE || st === ST.UNSETTLE) { AVX[i] = AVY[i] = 0; settleStep(i, dt); return; }
    if (p.hush && (st === ST.GO || st === ST.FOLLOW || st === ST.PAUSE || st === ST.WAIT) && X[i] * X[i] + Y[i] * Y[i] < 14884) { DSPD[i] = 0; DYAW[i] = Math.atan2(-Y[i], -X[i]); }   // game hook: clock
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
      if (bodyBlocks(i, nx, ny)) { SPD[i] *= 0.6; }           // a step into someone close by (between two thinks): wait
      else if ((fi > 0 && fj > 0 && fi < N.W - 1 && fj < N.H - 1 && N.clr[fk] >= 7 && !OCC[fk] && fk === GK[i]) || canStand(i, nx, ny)) { X[i] = nx; Y[i] = ny; moved = step; }
      else {
        // blocked (a wall, a standing guest): take the free direction closest to the heading — the wall's tangent or a
        // side-step, own side first — turning toward it within this frame's turn budget, and move only as far as the
        // heading allows (never sideways, never backwards)
        const gxw = clearance(N, X[i] + 0.25, Y[i]) - clearance(N, X[i] - 0.25, Y[i]), gyw = clearance(N, X[i], Y[i] + 0.25) - clearance(N, X[i], Y[i] - 0.25), gl = hyp(gxw, gyw);
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
  // the nearest people of other parties seen at the last think: a move between thinks that comes closer
  // to one of them (0.31 m: bodies touching), and closer than before, is not made (nobody walks through anybody between two looks round)
  function bodyBlocks(i, x, y) {
    if (GHOST[i] > 0) return false;
    for (let q = 0; q < 4; q++) {
      const j = NBL[i * 4 + q]; if (j < 0) break; if (STT[j] === ST.OFF) continue;
      const dx = X[j] - x, dy = Y[j] - y, d2 = dx * dx + dy * dy;
      if (d2 < 0.0961) { const ox = X[j] - X[i], oy = Y[j] - Y[i]; if (d2 < ox * ox + oy * oy - 0.002) return true; }
    }
    return false;
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
    // near a wall: keep most of the body clear (a 1 m doorway leaves 0.25 m each side), or at least do not get closer
    if (cv < (params.radius + 0.25 + 0.36) * 6) { const c = clearance(N, x, y); if (c < params.radius * 0.7 && c < clearance(N, X[i], Y[i]) + 0.002) return false; }
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
      const L = hyp(tx - ax, ty - ay);
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
      const moved = hyp(X[i] - px, Y[i] - py);
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
  crowd.dispose = () => { disposed = true; };
  crowd.setParams = (o) => Object.assign(params, o);
  // debug access for the overlay and the tests
  Object.defineProperty(debug, 'D', { get: () => D });
  Object.assign(debug, {
    local, ST, arrays: { X, Y, Z, YAW, SPD, ANI, STT, SITE, SLOT, LEAD, GS, MODE, DSPD, DYAW, GHOST, DFOC, WANT, BLK, TX, TY, VX, VY, AVX, AVY, GXA, GYA, PRI, IMP, FILE },
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
            const d = hyp(X[j] - X[i], Y[j] - Y[i]); if (d < 0.35 && Math.abs(Z[j] - Z[i]) < 1) pairs++;
          }
        }
      }
      return { pairs, inside };
    },
    pumpLocal(n = 1e9) { while (n-- > 0 && pumpOne()); },   // tests: the Worker's job, outside the timed frame
    // tests: a party of `size` at (x, y) facing `yaw`, bound for site `siteId` (or the walk site nearest (gx, gy)); returns its leader
    spawnTest(x, y, yaw, size, siteId) { const L = spawnParty(x, y, yaw, size); if (L < 0) return -1; if (!assign(L, D.P.sites[siteId])) { removeParty(L); return -1; } return L; },
    countStates() { const c = {}; const names = Object.keys(ST); for (let i = 0; i < CAP; i++) { if (STT[i] === ST.OFF) continue; const n = names[STT[i]]; c[n] = (c[n] || 0) + 1; } return c; },
  });
  if (groundP) groundP.then((g) => { groundGrid = g; if (!disposed) start(); }); else start();
  return crowd;
}

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
