// Headless crowd harness: runs the real simulation (fx/guests/sim.js, main-thread variant, synchronous) in Node, no
// rendering, for many simulated minutes and measures how the crowd behaves.
//
//   node tools/guests-sim/harness.mjs [--sim <path to sim.js>] [--data <data dir>] [--out <dir>] [--tag name]
//        [--minutes 20] [--warm 2] [--count 2400] [--scen ordinary,frostfair,stories,prefall,fall] [--fps 60]
//        [--focus x,y,z,mode] [--crop x,y,r[,name]]...
//
// Scenarios set the clock module's crowd bias (fx/game/clock/crowd.js BIASES) and, for 'fall', the silent four minutes
// (params.hush) from minute 8 to minute 12. Per scenario it writes <out>/<tag>-<scen>.json and a density heat map
// <out>/<tag>-<scen>-heat.png (mean guests per 2 m square over the run, log scale, over the walk grid), and prints a
// one-line summary. Metrics (sampled after the warm-up):
//   stuck      share of guests that want to walk (GO / FOLLOW with a desired speed > 0.3 m/s) but moved < 0.6 m in the
//              last 5 s (stuck5), and < 1.5 m in the last 20 s (stuck20), averaged over samples (every 0.5 s)
//   overlaps   pairs of standing-or-walking guests (not both seated) closer than 0.35 m, mean per sample; other-party only
//   passes     pass-throughs per minute: pairs from different parties whose centres come closer than 0.2 m (one event
//              until they part beyond 0.5 m); ghost = the sim's own pass-through mode activations per minute
//   density    guests per 2 m square over occupied squares (median, p95, max), share of guests in squares with >= 5
//              (crowd, > 1.25 / m2), walkers only too
//   poi        per site kind: slot utilisation (time-mean occupied slots / slots), share of sites never used, share of
//              sites full >= 50 % of the time, Gini of use per site
//   regions    entries per minute and mean occupancy for interiors and cut-off areas (the tavern, the castle courtyard,
//              the Rose Maze: whole diamond and its centre) and the lake rail
//   trips      leaders' trips to a goal: completed per minute, mean walked length / straight distance, mean speed made
//              good (straight / time), abandoned per minute (goal changed while far from it)
//   (the adaptive level-of-detail budget is off by default so that runs are repeatable; --adapt turns on the Worker's 2 ms)
//   cost       update() ms per step: mean, p50, p99, max (Node; the Worker runs the same code), local-field pump ms
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, deflateSync, crc32 } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const crops = []; for (let i = 0; i < args.length; i++) if (args[i] === '--crop') crops.push(args[i + 1]);
const ROOT = resolve(HERE, '../..');
const SIM = resolve(opt('sim', ROOT + '/fx/guests/sim.js')), DATA = resolve(opt('data', ROOT + '/data'));
const OUT = resolve(opt('out', '.')), TAG = opt('tag', 'run'), MIN = +opt('minutes', 20), WARM = +opt('warm', 2), COUNT = +opt('count', 2400), FPS = +opt('fps', 60);
const SCEN = opt('scen', 'ordinary').split(',');
const FOC = opt('focus', '40,-20,45,orbit').split(','), focus = { x: +FOC[0], y: +FOC[1], z: +FOC[2], mode: FOC[3] || 'orbit', tour: -1 };
mkdirSync(OUT, { recursive: true });

// ── data, as app.js decodes it ──
const manifest = JSON.parse(readFileSync(DATA + '/manifest.json', 'utf8'));
const gz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);
const u8 = new Uint8Array(gz(readFileSync(DATA + '/' + manifest.nav.file)));
const NV = manifest.nav, W = NV.w, H = NV.h, lv = [];
for (let l = 0; l < 2; l++) { const a = new Uint16Array(W * H), lo = l * 2 * W * H, hi = lo + W * H; for (let j = 0; j < H; j++) { let acc = 0; for (let i = 0; i < W; i++) { const k = j * W + i; acc = (acc + (u8[lo + k] | (u8[hi + k] << 8))) & 0xFFFF; a[k] = acc; } } lv.push(a); }
const nav = { ...NV, A: lv[0], B: lv[1] };
const pois = JSON.parse(readFileSync(DATA + '/guests.json', 'utf8'));
const ground = pois.ground ? { w: pois.ground.w, h: pois.ground.h, classes: pois.ground.classes, data: new Uint8Array(gz(readFileSync(DATA + '/' + pois.ground.file))) } : null;
const { createCrowd } = await import(pathToFileURL(SIM).href);

// the clock's biases (fx/game/clock/crowd.js), by scenario
const STAGE = [33.6, -181];
const BIAS = {
  ordinary: null,
  frostfair: { lands: { frostmere: 5 }, rail: 0.6 },
  stories: { lands: { 'lantern-row': 5 }, rail: 0.6, pts: [{ x: STAGE[0], y: STAGE[1], r: 25, k: 3 }] },
  prefall: { lands: { lake: 2.5 }, rail: 1.7 },
  fall: { lands: { lake: 4 }, rail: 2.4 },
};
// regions (Blender xy): [name, test(x, y, z)]
const REG = [
  ['tavern', (x, y) => x > 124 && x < 146 && y > -31 && y < -11],
  ['courtyard', (x, y) => Math.hypot(x + 212, y - 1) < 9],
  ['maze', (x, y) => Math.abs(x + 92) + Math.abs(y + 150.7) < 21],          // the Rose Maze: a diamond centred (-92, -150.7) in the walk grid, about 23 m to a corner
  ['mazecore', (x, y) => Math.hypot(x + 92, y + 150.7) < 6],
  ['frostmere', (x, y) => landOf(x, y) === 'frostmere'],
  ['lantern-row', (x, y) => landOf(x, y) === 'lantern-row'],
  ['stage', (x, y) => Math.hypot(x - STAGE[0], y - STAGE[1]) < 25],
  ['shore', (x, y) => Math.hypot(x, y) < 122],
];
const TAU = Math.PI * 2;
function landOf(x, y) {
  const phi = Math.atan2(y, x), r = Math.hypot(x, y); if (r < 112) return 'lake';
  let best = null, bd = 1e9; for (const l of manifest.lands) { const d = Math.abs(((phi - l.phi + Math.PI * 3) % TAU) - Math.PI); if (d < bd) { bd = d; best = l.id; } }
  if (x > 150 && Math.abs(y) < 40) return 'gate';
  return bd < 0.34 ? best : 'ring';
}

// ── PNG ──
function png(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let j = 0; j < h; j++) { raw[j * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, j * (w * 3 + 1) + 1, j * w * 3, (j + 1) * w * 3) : raw.set(rgb.subarray(j * w * 3, (j + 1) * w * 3), j * (w * 3 + 1) + 1); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// magma-like ramp, t in [0, 1]
const RAMP = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
const ramp = (t) => { t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1); const i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i, a = RAMP[i], b = RAMP[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };

// ── one scenario ──
const GC = 2, GW = Math.ceil(W * NV.cell / GC), GH = Math.ceil(H * NV.cell / GC);
function run(scen) {
  const crowd = createCrowd({ nav, manifest, pois, count: COUNT, max: Math.ceil(Math.max(COUNT, 400) * 1.7), seed: 1, sync: true, manualLocal: true, ground });
  if (!crowd.ready) throw new Error('not ready: ' + crowd.debug.error);
  crowd.setParams({ bias: BIAS[scen] || null, hush: false, budget: args.includes('--adapt') ? 2.0 : 1e9, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) });     // the Worker's budget (sim-worker.js)
  const dbg = crowd.debug, A = dbg.arrays, ST = dbg.ST, CAP = crowd.count, D = dbg.D, sites = D.P.sites, S = D.P.slots;
  const { X, Y, Z, STT, SITE, SLOT, LEAD, ANI } = A, DSPD = A.WANT || A.DSPD;      // the speed wanted before avoidance (older sims: after)
  const dt = 1 / FPS, steps = Math.round(MIN * 60 * FPS), warm = Math.round(WARM * 60 * FPS), every = Math.round(FPS / 2);
  const ms = [], pump = [], cpu = [];
  // per-agent tracking
  const HIST = 41, hx = new Float32Array(CAP * HIST), hy = new Float32Array(CAP * HIST), hs = new Uint8Array(CAP * HIST);   // 0.5 s samples, 20 s
  let hp = 0, nsamp = 0;
  const acc = { stuck5: 0, stuck20: 0, wantN: 0, over: 0, overParty: 0, dens: [], crowdShare: 0, crowdWalk: 0, walkN: 0, act: 0 };
  const heat = new Float32Array(GW * GH), cnt = new Uint16Array(GW * GH);
  const siteOcc = new Float32Array(sites.length), siteFull = new Float32Array(sites.length), siteUsed = new Uint8Array(sites.length);
  const inReg = new Uint8Array(CAP * REG.length), regEnt = new Float64Array(REG.length), regOcc = new Float64Array(REG.length);
  // trips (leaders)
  const tSite = new Int32Array(CAP).fill(-2), tX = new Float32Array(CAP), tY = new Float32Array(CAP), tT = new Float32Array(CAP), tLen = new Float32Array(CAP), lX = new Float32Array(CAP), lY = new Float32Array(CAP), tGX = new Float32Array(CAP), tGY = new Float32Array(CAP);
  const trips = { done: 0, len: 0, straight: 0, time: 0, abandoned: 0, ratioN: 0, ratio: 0 };
  // pass-throughs
  const close = new Map(), passWhy = {}; let repick0 = 0, passes = 0, ghost0 = 0, hushOn = false;
  const PG = new Int32Array(GW * GH).fill(-1), PN = new Int32Array(CAP);
  const party = (i) => (LEAD[i] >= 0 ? LEAD[i] : i);
  let t = 0;
  for (let f = 0; f < steps; f++) {
    if (scen === 'fall') { const want = f >= 8 * 60 * FPS && f < 12 * 60 * FPS; if (want !== hushOn) { hushOn = want; crowd.setParams({ hush: want }); } }
    const c0 = process.threadCpuUsage(), t0 = performance.now(); crowd.update(dt, t, focus); const t1 = performance.now(), c1 = process.threadCpuUsage(); dbg.pumpLocal(1); const t2 = performance.now();
    t += dt;
    const measuring = f >= warm;
    if (measuring) { ms.push(t1 - t0); pump.push(t2 - t1); cpu.push((c1.user + c1.system - c0.user - c0.system) / 1000); }
    if (f === warm) { ghost0 = dbg.ev.ghost; repick0 = dbg.ev.repick || 0; }
    // trips: path length every step for leaders
    for (let i = 0; i < CAP; i++) {
      const st = STT[i];
      if (st === ST.OFF) { tSite[i] = -2; continue; }
      if (LEAD[i] >= 0) continue;
      if (tSite[i] >= 0) { tLen[i] += Math.hypot(X[i] - lX[i], Y[i] - lY[i]); }
      lX[i] = X[i]; lY[i] = Y[i];
      const s = SITE[i], going = st === ST.GO;
      if (tSite[i] >= 0 && (s !== tSite[i] || !going)) {
        // trip over: arrived (settling / acting / pausing at a waypoint) or the goal changed
        const site = sites[tSite[i]], sl = SLOT[i];
        const own = s === tSite[i] && A.GXA, gx = own ? A.GXA[i] : sl >= 0 && s === tSite[i] ? S.ax[sl] : site.x, gy = own ? A.GYA[i] : sl >= 0 && s === tSite[i] ? S.ay[sl] : site.y;
        const ex = A.GXA ? tGX[i] : gx, ey = A.GXA ? tGY[i] : gy;         // the goal point the trip started with
        const near = Math.hypot(X[i] - ex, Y[i] - ey) < (site.kind === 'walk' ? 3 : site.kind === 'gate' ? 8 : 2.5) || st === ST.SETTLE || st === ST.ACT || st === ST.QUEUE || st === ST.PAUSE;
        if (measuring) {
          const straight = Math.hypot(X[i] - tX[i], Y[i] - tY[i]), time = t - tT[i];
          if (near && straight > 8) { trips.done++; trips.len += tLen[i]; trips.straight += straight; trips.time += time; trips.ratio += tLen[i] / straight; trips.ratioN++; }
          else if (!near) trips.abandoned++;
        }
        tSite[i] = -1;
      }
      if (going && tSite[i] !== s) { tSite[i] = s; tX[i] = X[i]; tY[i] = Y[i]; tT[i] = t; tLen[i] = 0; if (A.GXA) { tGX[i] = A.GXA[i]; tGY[i] = A.GYA[i]; } }
    }
    // pass-throughs every 3rd step
    if (measuring && f % 3 === 0) {
      PG.fill(-1);
      for (let i = 0; i < CAP; i++) { if (STT[i] === ST.OFF) continue; const gx = ((X[i] - NV.x0) / GC) | 0, gy = ((Y[i] - NV.y0) / GC) | 0; if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue; const g = gy * GW + gx; PN[i] = PG[g]; PG[g] = i; }
      for (const [k, v] of close) { const i = k >> 13, j = k & 8191; if (STT[i] === ST.OFF || STT[j] === ST.OFF || Math.hypot(X[i] - X[j], Y[i] - Y[j]) > 0.5) close.delete(k); }
      for (let i = 0; i < CAP; i++) {
        if (STT[i] === ST.OFF || ANI[i] !== 0) continue;           // a walker
        const gx = ((X[i] - NV.x0) / GC) | 0, gy = ((Y[i] - NV.y0) / GC) | 0, pi = party(i);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = gx + ox, yy = gy + oy; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
          for (let j = PG[yy * GW + xx]; j >= 0; j = PN[j]) {
            if (j === i || party(j) === pi || Math.abs(Z[j] - Z[i]) > 1) continue;
            if ((X[j] - X[i]) ** 2 + (Y[j] - Y[i]) ** 2 < 0.04) { const k = i < j ? (i << 13) | j : (j << 13) | i; if (!close.has(k)) { close.set(k, 1); passes++; const why = (A.GHOST[i] > 0 || A.GHOST[j] > 0) ? 'ghost' : (STT[i] === ST.SETTLE || STT[j] === ST.SETTLE || STT[i] === ST.UNSETTLE || STT[j] === ST.UNSETTLE) ? 'settle' : (STT[i] === ST.FOLLOW || STT[j] === ST.FOLLOW) ? 'follow' : 'walk'; passWhy[why] = (passWhy[why] || 0) + 1; } }
          }
        }
      }
    }
    if (f % every !== 0) continue;
    // ── sample (every 0.5 s) ──
    hp = (hp + 1) % HIST;
    for (let i = 0; i < CAP; i++) { const o = i * HIST + hp; hx[o] = X[i]; hy[o] = Y[i]; const st = STT[i]; hs[o] = st === ST.OFF ? 0 : (st === ST.GO || st === ST.FOLLOW) && DSPD[i] > 0.3 ? 2 : 1; }
    if (!measuring) continue;
    nsamp++;
    const p10 = (hp - 10 + HIST) % HIST, p40 = (hp + 1) % HIST;
    cnt.fill(0);
    let want = 0, s5 = 0, s20 = 0, active = 0;
    for (let i = 0; i < CAP; i++) {
      const o = i * HIST;
      if (STT[i] === ST.OFF) continue; active++;
      const gx = ((X[i] - NV.x0) / GC) | 0, gy = ((Y[i] - NV.y0) / GC) | 0; if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) cnt[gy * GW + gx]++;
      if (hs[o + hp] === 2) {
        want++;
        if (hs[o + p10] === 2 && Math.hypot(X[i] - hx[o + p10], Y[i] - hy[o + p10]) < 0.6) s5++;
        if (nsamp > 40 && hs[o + p40] >= 1 && Math.hypot(X[i] - hx[o + p40], Y[i] - hy[o + p40]) < 1.5) { let all = true; for (let q = 0; q < HIST; q += 5) if (hs[o + q] !== 2) { all = false; break; } if (all) s20++; }
      }
      for (let r = 0; r < REG.length; r++) { const k = i * REG.length + r, inside = REG[r][1](X[i], Y[i]) ? 1 : 0; if (inside) regOcc[r]++; if (inside && !inReg[k]) regEnt[r]++; inReg[k] = inside; }
    }
    acc.stuck5 += want ? s5 / want : 0; acc.stuck20 += want ? s20 / want : 0; acc.wantN += want; acc.act += active;
    // density
    const occ = [];
    let crowdG = 0, crowdW = 0, walkers = 0;
    for (let g = 0; g < cnt.length; g++) if (cnt[g]) { occ.push(cnt[g]); heat[g] += cnt[g]; }
    for (let i = 0; i < CAP; i++) { if (STT[i] === ST.OFF) continue; const gx = ((X[i] - NV.x0) / GC) | 0, gy = ((Y[i] - NV.y0) / GC) | 0; const c = gx >= 0 && gy >= 0 && gx < GW && gy < GH ? cnt[gy * GW + gx] : 0; if (c >= 5) crowdG++; if (ANI[i] === 0) { walkers++; if (c >= 5) crowdW++; } }
    acc.crowdShare += crowdG / Math.max(1, active); acc.crowdWalk += crowdW / Math.max(1, walkers); acc.walkN += walkers;
    occ.sort((a, b) => a - b); acc.dens.push(occ[occ.length >> 1], occ[Math.floor(occ.length * 0.95)], occ[occ.length - 1]);
    // overlaps (not both seated), other parties / same party
    let ov = 0, ovp = 0;
    for (let i = 0; i < CAP; i++) {
      if (STT[i] === ST.OFF) continue; const gx = ((X[i] - NV.x0) / GC) | 0, gy = ((Y[i] - NV.y0) / GC) | 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox, yy = gy + oy; if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
        for (let j = PG[yy * GW + xx]; j >= 0; j = PN[j]) {
          if (j <= i || (ANI[i] === 4 && ANI[j] === 4) || Math.abs(Z[j] - Z[i]) > 1) continue;
          if ((X[j] - X[i]) ** 2 + (Y[j] - Y[i]) ** 2 < 0.1225) { if (party(i) === party(j)) ovp++; else ov++; }
        }
      }
    }
    acc.over += ov; acc.overParty += ovp;
    // site use
    for (const s of sites) {
      if (!s.open || s.kind === 'walk' || s.kind === 'gate') continue;
      let o = 0; for (const k of s.slots) { const a = S.occ[k]; if (a >= 0 && (STT[a] === ST.ACT || STT[a] === ST.QUEUE || STT[a] === ST.SETTLE)) o++; }
      siteOcc[s.id] += o / s.slots.length; if (o >= s.slots.length) siteFull[s.id]++; if (o) siteUsed[s.id] = 1;
    }
  }
  // ── summary ──
  const n = nsamp, mins = (steps - warm) / FPS / 60;
  const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
  const dM = [], d95 = [], dMax = []; for (let k = 0; k < acc.dens.length; k += 3) { dM.push(acc.dens[k]); d95.push(acc.dens[k + 1]); dMax.push(acc.dens[k + 2]); }
  const poi = {};
  for (const kind of ['sit', 'queue', 'look', 'stage', 'rail']) {
    const ss = sites.filter((s) => s.open && s.kind === kind); if (!ss.length) continue;
    const use = ss.map((s) => siteOcc[s.id] / n).sort((a, b) => a - b), tot = use.reduce((a, b) => a + b, 0);
    let g = 0; for (let k = 0; k < use.length; k++) g += (2 * (k + 1) - use.length - 1) * use[k];
    poi[kind] = { sites: ss.length, slots: ss.reduce((a, s) => a + s.slots.length, 0), util: +(tot / ss.length).toFixed(3), never: +(ss.filter((s) => !siteUsed[s.id]).length / ss.length).toFixed(3), fullHalf: +(ss.filter((s) => siteFull[s.id] / n >= 0.5).length / ss.length).toFixed(3), gini: +(tot > 0 ? g / (use.length * tot) : 0).toFixed(3) };
  }
  ms.sort((a, b) => a - b); const mean = ms.reduce((a, b) => a + b, 0) / ms.length, pm = pump.reduce((a, b) => a + b, 0) / pump.length;
  const regions = {}; REG.forEach(([name], r) => { regions[name] = { entriesPerMin: +(regEnt[r] / mins).toFixed(2), meanIn: +(regOcc[r] / n).toFixed(1) }; });
  const res = {
    tag: TAG, scen, minutes: MIN, warm: WARM, count: COUNT, active: Math.round(acc.act / n), focus,
    stuck5: +(acc.stuck5 / n).toFixed(4), stuck20: +(acc.stuck20 / n).toFixed(4), wantWalk: Math.round(acc.wantN / n),
    overlapsOther: +(acc.over / n).toFixed(1), overlapsParty: +(acc.overParty / n).toFixed(1),
    passesPerMin: +(passes / mins).toFixed(1), passWhy: Object.fromEntries(Object.entries(passWhy).map(([k, v]) => [k, +(v / mins).toFixed(1)])), ghostPerMin: +((dbg.ev.ghost - ghost0) / mins).toFixed(1), giveUpPerMin: +(((dbg.ev.repick || 0) - repick0) / mins).toFixed(1),
    density: { median: q(dM, 0.5), p95: q(d95, 0.5), maxMedian: q(dMax, 0.5), maxMax: Math.max(...dMax), crowdShare: +(acc.crowdShare / n).toFixed(3), crowdShareWalkers: +(acc.crowdWalk / n).toFixed(3) },
    poi, regions,
    trips: { perMin: +(trips.done / mins).toFixed(1), meanLen: +(trips.len / Math.max(1, trips.done)).toFixed(1), detour: +(trips.ratio / Math.max(1, trips.ratioN)).toFixed(3), speedMadeGood: +(trips.straight / Math.max(1e-6, trips.time)).toFixed(3), meanTime: +(trips.time / Math.max(1, trips.done)).toFixed(1), abandonedPerMin: +(trips.abandoned / mins).toFixed(1) },
    cost: { lowHalf: +(ms.slice(0, ms.length >> 1).reduce((a, b) => a + b, 0) / (ms.length >> 1)).toFixed(3), mean: +mean.toFixed(3), p50: +q(ms, 0.5).toFixed(3), p99: +q(ms, 0.99).toFixed(3), max: +ms[ms.length - 1].toFixed(2), pumpMean: +pm.toFixed(3), cpuMean: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(3), cpuP50: +q(cpu, 0.5).toFixed(3) },
    ev: { ...dbg.ev },
  };
  writeFileSync(`${OUT}/${TAG}-${scen}.json`, JSON.stringify(res, null, 1));
  // heat map (2 m squares, scaled x2), walkable cells grey
  const SC = 2, iw = GW * SC, ih = GH * SC, img = Buffer.alloc(iw * ih * 3);
  const walk = new Uint8Array(GW * GH);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (nav.A[j * W + i]) walk[((j * NV.cell / GC) | 0) * GW + ((i * NV.cell / GC) | 0)]++;
  const vmax = Math.log1p(3);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const g = gy * GW + gx, v = heat[g] / n;
    let c = walk[g] ? [38, 38, 44] : [8, 8, 10];
    if (v > 0.01) c = ramp(0.12 + 0.88 * Math.log1p(v) / vmax);
    for (let sy = 0; sy < SC; sy++) for (let sx = 0; sx < SC; sx++) { const o = (((GH - 1 - gy) * SC + sy) * iw + gx * SC + sx) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; }
  }
  png(`${OUT}/${TAG}-${scen}-heat.png`, iw, ih, img);
  // hotspots: the 2 m squares with the highest mean count
  const hot = []; for (let g = 0; g < heat.length; g++) if (heat[g] / n > 1.2) hot.push([+(heat[g] / n).toFixed(2), Math.round(NV.x0 + ((g % GW) + 0.5) * GC), Math.round(NV.y0 + (((g / GW) | 0) + 0.5) * GC)]);
  hot.sort((a, b) => b[0] - a[0]); res.hot = hot.slice(0, 15);
  writeFileSync(`${OUT}/${TAG}-${scen}.json`, JSON.stringify(res, null, 1));
  return res;
}

// crops of the walk grid (clearance) for looking at doorways: --crop x,y,r[,name]
for (const c of crops) {
  const [cx, cy, r, name] = c.split(','); const R = +r, sc = 4, n2 = Math.round(2 * R / NV.cell), img = Buffer.alloc(n2 * sc * n2 * sc * 3);
  for (let j = 0; j < n2; j++) for (let i = 0; i < n2; i++) {
    const x = +cx - R + (i + 0.5) * NV.cell, y = +cy - R + (j + 0.5) * NV.cell, fi = ((x - NV.x0) / NV.cell) | 0, fj = ((y - NV.y0) / NV.cell) | 0;
    const a = nav.A[fj * W + fi], b = nav.B[fj * W + fi], h = a ? (a - 1) / 100 - 2 : 0;
    const col = a ? [60 + Math.max(0, Math.min(150, (h + 1) * 40)), 90, b ? 200 : 60] : [0, 0, 0];
    for (let sy = 0; sy < sc; sy++) for (let sx = 0; sx < sc; sx++) { const o = (((n2 - 1 - j) * sc + sy) * n2 * sc + i * sc + sx) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; }
  }
  png(`${OUT}/crop-${name || cx + '_' + cy}.png`, n2 * sc, n2 * sc, img);
}
if (+opt('minutes', 20) > 0) for (const s of SCEN) {
  const T = Date.now(), r = run(s);
  console.log(`${TAG} ${s}: stuck5 ${(r.stuck5 * 100).toFixed(2)}% stuck20 ${(r.stuck20 * 100).toFixed(2)}% over ${r.overlapsOther}/${r.overlapsParty} pass ${r.passesPerMin}/min ghost ${r.ghostPerMin}/min dens med ${r.density.median} p95 ${r.density.p95} max ${r.density.maxMax} crowd ${r.density.crowdShare}/${r.density.crowdShareWalkers} tavern ${r.regions.tavern.entriesPerMin}/min (${r.regions.tavern.meanIn}) court ${r.regions.courtyard.meanIn} maze ${r.regions.maze.meanIn}/${r.regions.mazecore.meanIn} trips ${r.trips.perMin}/min detour ${r.trips.detour} vmg ${r.trips.speedMadeGood} aband ${r.trips.abandonedPerMin}/min giveup ${r.giveUpPerMin}/min cost ${r.cost.mean}/${r.cost.p99} ms cpu ${r.cost.cpuMean}/${r.cost.cpuP50} ms (${((Date.now() - T) / 1000).toFixed(0)} s)`);
}
