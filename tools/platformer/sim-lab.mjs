// Runs the real movement library (fx/platformer/sm64.wasm) in Node on the synthetic test level and measures the move set.
// usage: node tools/platformer/sim-lab.mjs [scenario ...] [--trace]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSM64 } from '../../fx/platformer/sm64.js';
import { animTable, CLIP } from '../../fx/platformer/anims.js';
import { actionName } from '../../fx/platformer/actions.js';
import { testLevel, S } from './testworld.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sm = await loadSM64(fs.readFileSync(path.join(here, '../../fx/platformer/sm64.wasm')));
sm.init(animTable());
const lvl = testLevel();
let t0 = performance.now(); sm.loadSurfaces(lvl.packed, lvl.count); const loadMs = performance.now() - t0;
const id = sm.create(0, 100, 0);
const args = process.argv.slice(2), TRACE = args.includes('--trace');
const r2 = (v) => Math.round(v * 100) / 100;

function reset(x = 0, z = 0, face = Math.PI, y = 0) {        // face: library angle (0 = +z); pi = -z (north)
  sm.setPosition(id, x * S, y * S + 1, z * S); sm.setVelocity(id, 0, 0, 0); sm.setForwardVel(id, 0); sm.setFaceAngle(id, face);
  sm.setAction(id, 0x0C400201); for (let i = 0; i < 4; i++) step({});
}
// input: { x, y (stick, y up = away from the camera, x right), a, b, z }. The library takes the camera -> player
// direction negated (camLook = player -> camera in x/z) and a stick whose x is positive to the LEFT.
let camLook = [0, 1];       // camera south of the player: stick up = north (-z)
function step(inp) {
  const I = sm.input; I.camLookX = camLook[0]; I.camLookZ = camLook[1]; I.stickX = -(inp.x || 0); I.stickY = inp.y || 0; I.a = inp.a; I.b = inp.b; I.z = inp.z;
  // keep the park's rules: water only inside the pool, health topped up
  const p = sm.exports && st ? st.pos : [0, 0, 0];
  sm.setWaterLevel(id, inPool(p) ? lvl.pool.water : -1e4);
  sm.setHealth(id, 0x880);
  const s = sm.tick(id);
  return s;
}
let st = null;
const inPool = (p) => p[0] > lvl.pool.x0 - 50 && p[0] < lvl.pool.x1 + 50 && p[2] > lvl.pool.z0 - 50 && p[2] < lvl.pool.z1 + 50;
function run(frames, inp, log) {
  for (let i = 0; i < frames; i++) {
    st = step(typeof inp === 'function' ? inp(i) : inp);
    log.push({ f: log.length, x: st.pos[0] / S, y: st.pos[1] / S, z: st.pos[2] / S, act: actionName(st.action), anim: CLIP[st.animID], fr: st.animFrame, v: st.fwd, vy: st.vel[1], floor: st.floorY / S });
  }
  return st;
}
const summary = (log) => {
  const y0 = log[0].y; let peak = -1e9; for (const e of log) peak = Math.max(peak, e.y);
  const acts = []; for (const e of log) if (!acts.length || acts[acts.length - 1][0] !== e.act) acts.push([e.act, e.f, e.anim]);
  return { peak: r2(peak - y0), acts: acts.map(([a, f, n]) => `${f}:${a}(${n})`).join(' > ') };
};
const dist = (a, b) => r2(Math.hypot(b.x - a.x, b.z - a.z));

const SC = {
  // stick up with camera looking north (-z): expect movement north
  direction() { reset(); const L = []; run(30, { y: 1 }, L); return { moved: [r2(L.at(-1).x), r2(L.at(-1).z)], ...summary(L) }; },
  walkRun() { reset(); const L = []; run(8, { y: 0.35 }, L); const a = L.at(-1); run(30, { y: 0.35 }, L); const walk = r2(L.at(-1).v * 30 / S);
    run(40, { y: 1 }, L); const run_ = r2(L.at(-1).v * 30 / S); return { walkSpeed: walk, runSpeed: run_, ...summary(L) }; },
  skid() { reset(0, 10); const L = []; run(40, { y: 1 }, L); run(30, { y: -1 }, L); return summary(L); },
  stop() { reset(0, 10); const L = []; run(40, { y: 1 }, L); run(30, {}, L); return summary(L); },
  singleJump() { reset(0, 20); const L = []; run(1, { a: 1 }, L); run(40, { a: 1 }, L); return { ...summary(L), airFrames: L.filter((e) => /jump$/.test(e.act)).length }; },
  jumpShort() { reset(0, 20); const L = []; run(1, { a: 1 }, L); run(40, {}, L); return summary(L); },
  tripleJump() { reset(0, 30); const L = []; run(25, { y: 1 }, L); const s = L.at(-1);
    let hold = 0, phase = 0, peaks = [];
    run(160, (i) => { const e = L.at(-1); const ground = /walk|land|idle/.test(e.act) && !/jump land stop/.test(e.act);
      if (phase < 3 && ground && i > 1 && !hold) { hold = 8; phase++; } if (hold) { hold--; return { y: 1, a: 1 }; } return { y: 1 }; }, L);
    return { dist: dist(s, L.at(-1)), ...summary(L) }; },
  longJump() { reset(0, 30); const L = []; run(30, { y: 1 }, L); const s = L.at(-1); run(2, { y: 1, z: 1 }, L); run(1, { y: 1, z: 1, a: 1 }, L); run(50, { y: 1 }, L);
    const land = L.findIndex((e, i) => i > 32 && !/long jump$/.test(e.act)); return { dist: land > 0 ? dist(s, L[land]) : null, ...summary(L) }; },
  backflip() { reset(0, 20); const L = []; run(4, { z: 1 }, L); run(1, { z: 1, a: 1 }, L); run(45, { z: 1 }, L); return { back: r2(L.at(-1).z - L[0].z), ...summary(L) }; },
  sideFlip() { reset(0, 20); const L = []; run(25, { y: 1 }, L); run(3, { y: -1 }, L); run(1, { y: -1, a: 1 }, L); run(45, { y: -1 }, L); return summary(L); },
  wallKick() { reset(0, -11.6, Math.PI); const L = []; let kicked = 0, wait = 0;
    run(150, (i) => { const e = L.at(-1); if (i < 3) return { y: 1 }; if (i === 3) return { y: 1, a: 1 };
      if (/air hit wall/.test(e.act) && kicked < 4 && !wait) { kicked++; wait = 3; camLook = [0, -camLook[1]]; return { y: 1, a: 1 }; }
      if (wait) { wait--; return { y: 1, a: 1 }; } return { y: 1 }; }, L);
    camLook = [0, 1]; return { kicks: L.filter((e, i) => i && e.act === 'wall kick air' && L[i - 1].act !== 'wall kick air').length, ...summary(L) }; },
  groundPound() { reset(0, 20); const L = []; run(1, { a: 1 }, L); run(10, { a: 1 }, L); run(1, { z: 1 }, L); run(50, {}, L); return summary(L); },
  diveSlide() { reset(0, 30); const L = []; run(45, { y: 1 }, L); run(1, { y: 1, b: 1 }, L); run(60, {}, L); return summary(L); },
  punches() { reset(0, 20); const L = []; run(1, { b: 1 }, L); run(4, {}, L); run(1, { b: 1 }, L); run(4, {}, L); run(1, { b: 1 }, L); run(30, {}, L); return summary(L); },
  crouchCrawl() { reset(0, 20); const L = []; run(20, { z: 1 }, L); run(40, { z: 1, y: 1 }, L); const c = L.at(-1); run(20, { z: 1 }, L); run(20, {}, L); return { crawlSpeed: r2(c.v * 30 / S), ...summary(L) }; },
  slideKick() { reset(0, 30); const L = []; run(30, { y: 1 }, L); run(1, { y: 1, z: 1 }, L); run(1, { y: 1, z: 1, b: 1 }, L); run(60, {}, L); return summary(L); },
  ledge() { reset(16, 3.4, Math.PI); const L = []; run(3, { y: 0.6 }, L); run(1, { y: 0.6, a: 1 }, L); run(30, { y: 0.6, a: 1 }, L); const g = L.findIndex((e) => /ledge grab/.test(e.act));
    run(10, {}, L); run(1, { y: 1 }, L); run(50, {}, L); return { grabbed: g >= 0, top: r2(L.at(-1).y), ...summary(L) }; },
  ledgeFast() { reset(16, 3.4, Math.PI); const L = []; run(3, { y: 0.6 }, L); run(1, { y: 0.6, a: 1 }, L); run(30, { y: 0.6, a: 1 }, L); run(4, {}, L); run(1, { a: 1 }, L); run(40, {}, L); return { top: r2(L.at(-1).y), ...summary(L) }; },
  swim() { reset(18, 0, Math.PI / 2); const L = []; run(40, { x: 1 }, L);   // run east into the pool
    camLook = [-1, 0]; run(60, (i) => ({ y: 1, a: i % 12 < 2 }), L); run(40, { y: 1 }, L); run(40, { y: 1, a: 1 }, L); camLook = [0, 1];
    return { end: [r2(L.at(-1).x), r2(L.at(-1).y)], ...summary(L) }; },
  stairs() { reset(-18, 3, 0); const L = []; camLook = [0, -1]; run(70, { y: 0.6 }, L); camLook = [0, 1]; return { top: r2(L.at(-1).y), ...summary(L) }; },
  ramp() { reset(-28, 3, 0); const L = []; camLook = [0, -1]; run(90, { y: 1 }, L); camLook = [0, 1]; return { top: r2(Math.max(...L.map((e) => e.y))), ...summary(L) }; },
  ice() { reset(-7, 32, Math.PI); const L = []; run(30, { y: 1 }, L); run(40, {}, L); return summary(L); },
  highFall() { reset(-36, -35, 0, 14.05); const L = []; camLook = [0, -1]; run(90, { y: 1 }, L); camLook = [0, 1]; return { end: [L[0].x, L[0].y, L[0].z, L.at(-1).x, L.at(-1).y, L.at(-1).z].map(r2), ...summary(L) }; },
  poolExit() { reset(26, 0, Math.PI / 2, -0.9); const L = []; camLook = [-1, 0]; run(150, (i) => ({ a: i % 10 < 3 }), L); run(40, { y: 1 }, L); camLook = [0, 1]; return { end: [r2(L.at(-1).x), r2(L.at(-1).y)], ...summary(L) }; },
  roofFall() { reset(37.5, -18.5, Math.PI, 6.1); const L = []; run(10, {}, L); run(60, { y: 1 }, L); run(90, {}, L); return summary(L); },
  sleep() { reset(0, 20); const L = []; run(30 * 70, {}, L); return summary(L); },
};

const want = args.filter((a) => !a.startsWith('--'));
const out = { surfaces: lvl.count, loadMs: r2(loadMs), memoryMB: r2(sm.memoryBytes / 1048576) };
for (const k of (want.length ? want : Object.keys(SC))) {
  const t = performance.now(); out[k] = SC[k](); out[k].ms = r2(performance.now() - t);
}
console.log(JSON.stringify(out, null, 1));
if (sm.log.length) console.log('wasm log:', sm.log.slice(0, 10));
