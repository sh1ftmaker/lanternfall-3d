// Crowd density run without a browser: the guest simulation (fx/guests/sim.js, synchronous, main-thread copy) on the
// repo's data, with the focus (camera) circling the park, sampled twice a second. Used to compare walk grids.
//
//   node tools/guests-sim/crowd-density.mjs [REPO] [OUT_PREFIX] [--secs 600] [--warm 90] [--count 2400] [--seed 1]
//
// Writes OUT_PREFIX.json (stats) and OUT_PREFIX.bin: three float32 grids on 1 m cells (the nav grid's x0, y0;
// w/2 x h/2): guest-seconds per cell, stuck-walker-seconds (walking state, speed < 0.15 m/s) and close-pair seconds
// (two guests' centres under 0.45 m apart: bodies overlapping).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2), flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const REPO = path.resolve(pos[0] || '.'), OUT = pos[1] || 'density';
const SECS = flag('--secs', 600), WARM = flag('--warm', 90), COUNT = flag('--count', 2400), SEED = flag('--seed', 1);
const { createCrowd } = await import(pathToFileURL(path.join(REPO, 'fx/guests/sim.js')).href);

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'data/manifest.json')));
let u8 = fs.readFileSync(path.join(REPO, 'data/nav.bin')); if (u8[0] === 0x1f) u8 = zlib.gunzipSync(u8);
const N = manifest.nav, W = N.w, H = N.h, lv = [];
for (let l = 0; l < 2; l++) { const a = new Uint16Array(W * H), lo = l * 2 * W * H, hi = lo + W * H; for (let j = 0; j < H; j++) { let acc = 0; for (let i = 0; i < W; i++) { const k = j * W + i; acc = (acc + (u8[lo + k] | (u8[hi + k] << 8))) & 0xFFFF; a[k] = acc; } } lv.push(a); }
const pois = JSON.parse(fs.readFileSync(path.join(REPO, 'data/guests.json')));
let ground = null;
if (pois.ground) { let g = fs.readFileSync(path.join(REPO, 'data', pois.ground.file)); if (g[0] === 0x1f) g = zlib.gunzipSync(g); ground = { w: pois.ground.w, h: pois.ground.h, classes: pois.ground.classes, data: new Uint8Array(g) }; }

const t0 = Date.now();
const crowd = createCrowd({ nav: { ...N, A: lv[0], B: lv[1] }, manifest, pois, count: COUNT, max: COUNT, seed: SEED, sync: true, manualLocal: true, ground });
if (!crowd.ready) { console.error('not ready', crowd.debug.error); process.exit(1); }
const prep = Date.now() - t0;
const CW = W >> 1, CH = H >> 1, dens = new Float32Array(CW * CH), stuck = new Float32Array(CW * CH), close = new Float32Array(CW * CH);
const dt = 1 / 60, frames = Math.round((SECS + WARM) / dt), every = 30;
const focus = { x: 0, y: 0, z: 2, mode: 'orbit', tour: -1 };
let samples = 0, nStuck = 0, nClose = 0, nGuests = 0, ghost0 = 0;
const animCount = {};
const cellOf = (x, y) => { const I = Math.floor((x - N.x0) / 1), J = Math.floor((y - N.y0) / 1); return I >= 0 && J >= 0 && I < CW && J < CH ? J * CW + I : -1; };
const hash = new Map();
for (let f = 0; f < frames; f++) {
  const t = f * dt, a = t / 240 * 2 * Math.PI;                  // the camera circles the lake ring every 4 minutes
  focus.x = 150 * Math.cos(a); focus.y = 110 * Math.sin(a);
  crowd.update(dt, t, focus); crowd.debug.pumpLocal(4);
  if (t < WARM) { ghost0 = crowd.debug.ev.ghost; continue; }
  if (f % every) continue;
  samples++;
  const S = crowd.state; hash.clear();
  for (let i = 0; i < crowd.count; i++) {
    const an = S[i * 8 + 5]; if (an === 255) continue;
    const x = S[i * 8], y = S[i * 8 + 1], c = cellOf(x, y); if (c < 0) continue;
    nGuests++; dens[c] += 0.5; animCount[an] = (animCount[an] || 0) + 1;
    if (an === 0 && S[i * 8 + 4] < 0.15) { stuck[c] += 0.5; nStuck++; }
    const k = (Math.floor(x) & 0xFFFF) * 65536 + (Math.floor(y) & 0xFFFF);
    let b = hash.get(k); if (!b) hash.set(k, b = []); b.push(i);
  }
  for (const [k, b] of hash) {
    const kx = Math.floor(k / 65536), ky = k % 65536;
    for (const i of b) {
      const x = S[i * 8], y = S[i * 8 + 1];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b2 = hash.get(((kx + dx) & 0xFFFF) * 65536 + ((ky + dy) & 0xFFFF)); if (!b2) continue;
        for (const j of b2) if (j > i) { const ex = S[j * 8] - x, ey = S[j * 8 + 1] - y; if (ex * ex + ey * ey < 0.45 * 0.45) { nClose++; const c = cellOf(x, y); if (c >= 0) close[c] += 0.5; } }
      }
    }
  }
}
const res = { secs: SECS, warm: WARM, count: COUNT, seed: SEED, prepMs: prep, runMs: Date.now() - t0, samples, meanActive: nGuests / samples,
  stuckFrac: nStuck / nGuests, closePairsPerGuest: nClose / nGuests, ghostsPerMin: (crowd.debug.ev.ghost - ghost0) / (SECS / 60), anim: animCount,
  frameMean: crowd.debug.frameMean, grid: { w: CW, h: CH, x0: N.x0, y0: N.y0, cell: 1 } };
fs.writeFileSync(OUT + '.json', JSON.stringify(res, null, 1));
fs.writeFileSync(OUT + '.bin', Buffer.concat([Buffer.from(dens.buffer), Buffer.from(stuck.buffer), Buffer.from(close.buffer)]));
console.log(JSON.stringify(res));
