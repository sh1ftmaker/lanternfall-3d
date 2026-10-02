// Micro scenarios for the crowd steering: a few parties set up by hand on the real walk grid, no background crowd.
//   node tools/guests-sim/micro.mjs [--sim path] [--out dir] [--scen headon,door,cross,file] [--shots 1]
// Prints per scenario: seconds until every party arrived (or "timeout"), the closest approach between guests of
// different parties, guest-seconds blocked, and give-ups; --shots writes a picture every second (<out>/<scen>-<t>.png).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, deflateSync, crc32 } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SIM = resolve(opt('sim', ROOT + '/fx/guests/sim.js')), DATA = resolve(opt('data', ROOT + '/data')), OUT = resolve(opt('out', '.')), SHOTS = +opt('shots', 0);
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(DATA + '/manifest.json', 'utf8'));
const gz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);
const u8 = new Uint8Array(gz(readFileSync(DATA + '/' + manifest.nav.file)));
const NV = manifest.nav, W = NV.w, H = NV.h, lv = [];
for (let l = 0; l < 2; l++) { const a = new Uint16Array(W * H), lo = l * 2 * W * H, hi = lo + W * H; for (let j = 0; j < H; j++) { let acc = 0; for (let i = 0; i < W; i++) { const k = j * W + i; acc = (acc + (u8[lo + k] | (u8[hi + k] << 8))) & 0xFFFF; a[k] = acc; } } lv.push(a); }
const pois = JSON.parse(readFileSync(DATA + '/guests.json', 'utf8'));
const ground = pois.ground ? { w: pois.ground.w, h: pois.ground.h, classes: pois.ground.classes, data: new Uint8Array(gz(readFileSync(DATA + '/' + pois.ground.file))) } : null;
const { createCrowd } = await import(pathToFileURL(SIM).href);
const { clearance, cellAt } = await import(pathToFileURL(dirname(SIM) + '/sim-nav.js').href);

function png(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let j = 0; j < h; j++) { raw[j * (w * 3 + 1)] = 0; rgb.copy(raw, j * (w * 3 + 1) + 1, j * w * 3, (j + 1) * w * 3); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// scenarios: parties [x, y, size, toward: [x, y]] (each goes to the open site nearest `toward`, any kind but rail and gate)
const SCEN = {
  // two parties of four and two smaller ones meet on the Shore Promenade (south-west, rail on one side)
  headon: { shore: [-2.45, -2.25], parties: [[0, 4, 1], [1, 4, 0], [0, 2, 1], [1, 3, 0]] },
  // the same with eight single walkers, four each way (lanes should form)
  file: { shore: [-2.45, -2.25], parties: [[0, 1, 1], [0, 1, 1], [0, 1, 1], [0, 1, 1], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]] },
  // in and out of the Brine & Barrel's west door at once
  door: { c: [126, -21], r: 8, parties: [[117, -21, 3, [133, -26]], [117, -24, 2, [137, -17]], [130, -23, 4, [110, -22]], [128, -18, 2, [110, -17]]] },
  // where the Lamplighters' Walk meets the Shore Promenade: three flows cross
  cross: { c: [104, -2], r: 11, parties: [[113, -1, 4, [99, -14]], [99, -14, 4, [113, -1]], [99, 10, 3, [99, -14]], [99, -13, 3, [99, 10]], [113, 2, 2, [98, 9]], [98, 9, 2, [113, 2]]] },
};
const snap = (N, D, x, y) => { for (let r = 0; r <= 6; r += 0.25) for (let a = 0; a < 6.28; a += 0.3) { const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r, c = D.cellAt(N, px, py); if (c >= 0 && D.P.comp.lab[c] === D.P.main && clearance(N, px, py) > 0.7) return [px, py]; } return [x, y]; };
const out = {};
for (const name of opt('scen', 'headon,file,door,cross').split(',')) {
  const sc = { ...SCEN[name] };
  const crowd = createCrowd({ nav: { ...NV, A: lv[0], B: lv[1] }, manifest, pois, count: 0, max: 400, seed: 3, sync: true, manualLocal: true, ground });
  crowd.setParams({ budget: 2.0, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) });
  const dbg = crowd.debug, A = dbg.arrays, ST = dbg.ST, D = dbg.D, N = D.N, sites = D.P.sites;
  const leaders = [];
  D.cellAt = cellAt;
  if (sc.shore) {          // the two shore waypoints nearest the given polar angles: parties go from one to the other
    const sh = sites.filter((s) => s.open && s.kind === 'walk' && s.name === 'shore'), pick = (phi) => sh.reduce((b, s) => { const d = Math.abs(Math.atan2(s.y, s.x) - phi); return d < b[0] ? [d, s] : b; }, [9, null])[1];
    const ends = sc.shore.map(pick); sc.c = [(ends[0].x + ends[1].x) / 2, (ends[0].y + ends[1].y) / 2]; sc.r = Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y) / 2 + 3;
    sc.parties = sc.parties.map(([a, size, b], k) => [ends[a].x + (k % 3) * 0.9, ends[a].y + ((k >> 1) % 2) * 0.9, size, [ends[b].x, ends[b].y], ends[b].id]);
  }
  for (const [x, y, size, to, siteId] of sc.parties) {
    let best = -1, bd = 1e9; for (const s of sites) { if (!s.open || s.kind === 'rail' || s.kind === 'gate' || (s.kind !== 'walk' && s.slots.length < size)) continue; const d = Math.hypot(s.x - to[0], s.y - to[1]); if (d < bd) { bd = d; best = s.id; } }
    if (siteId !== undefined) best = siteId;
    const p = snap(N, D, x, y), L = dbg.spawnTest(p[0], p[1], Math.atan2(to[1] - y, to[0] - x), size, best); leaders.push(L);
    if (L < 0) console.log('  could not place a party at', x, y);
  }
  crowd.setCount(crowd.active);
  const first = leaders.map((L) => (L >= 0 ? A.SITE[L] : -1));
  const focus = { x: sc.c[0], y: sc.c[1], z: 1.7, mode: 'orbit', tour: -1 };
  let t = 0, done = -1, minD = 9, blocked = 0, repick0 = dbg.ev.repick || 0, ghost0 = dbg.ev.ghost;
  const party = (i) => (A.LEAD[i] >= 0 ? A.LEAD[i] : i);
  for (let f = 0; f < 60 * 90; f++) {
    crowd.update(1 / 60, t, focus); dbg.pumpLocal(4); t += 1 / 60;
    const act = []; for (let i = 0; i < crowd.count; i++) if (A.STT[i] !== ST.OFF) act.push(i);
    for (const i of act) { const st = A.STT[i]; if ((st === ST.GO || st === ST.FOLLOW) && A.WANT[i] > 0.3 && A.SPD[i] < 0.12) blocked += 1 / 60; for (const j of act) if (j > i && party(i) !== party(j)) { const d = Math.hypot(A.X[i] - A.X[j], A.Y[i] - A.Y[j]); if (d < minD) minD = d; } }
    const going = leaders.filter((L, k) => L >= 0 && A.SITE[L] === first[k] && A.STT[L] === ST.GO).length;
    if (process.env.DBG && f % 6 === 0 && t < 2) console.log(t.toFixed(2), leaders.map((L, k) => L + ":" + A.STT[L] + "/" + A.SITE[L] + "/" + first[k]).join(" "));
    if (!going && done < 0) done = t;
    if (SHOTS && f % 60 === 0 && t < 40) {
      const PX = 24, R = sc.r, w = Math.round(2 * R * PX), img = Buffer.alloc(w * w * 3);
      for (let py = 0; py < w; py++) for (let px = 0; px < w; px++) { const x = sc.c[0] - R + (px + 0.5) / PX, y = sc.c[1] + R - (py + 0.5) / PX, k = (((y - N.y0) / 0.5) | 0) * N.W + (((x - N.x0) / 0.5) | 0); const col = !N.A[k] ? [0, 0, 0] : !N.clr[k] ? [70, 30, 30] : [60, 60, 75]; const o = (py * w + px) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; }
      for (const i of act) {
        const pal = [[255, 80, 60], [80, 200, 255], [255, 220, 60], [140, 255, 120], [255, 120, 220], [200, 160, 255], [255, 170, 80], [120, 255, 230]];
        const col = pal[leaders.indexOf(party(i)) & 7] || [200, 200, 200], pxc = (A.X[i] - (sc.c[0] - R)) * PX, pyc = (sc.c[1] + R - A.Y[i]) * PX;
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { if (dx * dx + dy * dy > 36) continue; const X = Math.round(pxc + dx), Y = Math.round(pyc + dy); if (X < 0 || Y < 0 || X >= w || Y >= w) continue; const o = (Y * w + X) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; }
        for (let q = 0; q < 12; q++) { const X = Math.round(pxc + Math.cos(A.YAW[i]) * q), Y = Math.round(pyc - Math.sin(A.YAW[i]) * q); if (X < 0 || Y < 0 || X >= w || Y >= w) continue; const o = (Y * w + X) * 3; img[o] = img[o + 1] = img[o + 2] = 255; }
      }
      png(`${OUT}/${name}-${String(Math.round(t)).padStart(2, '0')}.png`, w, w, img);
    }
    if (done >= 0 && t > done + 2) break;
  }
  out[name] = { done: done < 0 ? 'timeout' : +done.toFixed(1), minDist: +minD.toFixed(2), blockedSec: +blocked.toFixed(1), repicks: (dbg.ev.repick || 0) - repick0, ghosts: dbg.ev.ghost - ghost0 };
  console.log(name, JSON.stringify(out[name]));
}
