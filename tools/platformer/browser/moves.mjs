// Drives the real movement library in the park and measures the move set. node run.mjs moves.mjs [--only a,b] [--shots]
import fs from 'node:fs';
const OUT = '/tmp/claude-1000/-home-zalo/253e908b-4e3c-4d12-a43e-a8b3b88482f6/scratchpad/agents/platformer';
export default async (page, ctx) => {
  const only = (ctx.opt('only', '') || '').split(',').filter(Boolean), shots = ctx.args.includes('--shots');
  await page.evaluate(() => __park.setMode('walk', { at: [288, 0], yaw: Math.PI }));
  await ctx.sleep(500);
  await page.evaluate(() => __park.togglePlatformer());
  await page.waitForFunction(() => __park.platformer && __park.platformer.active && __park.platformer.S.latest > 5, { timeout: 90000 });
  // helpers inside the page
  await page.evaluate(() => {
    const pf = __park.platformer, A = {};
    window.__mv = A;
    A.names = null;
    A.place = (x, y, z, face, camYaw) => { pf.test.input = () => ({}); pf.teleport(x, y, z, face); pf.S.cam.yaw = camYaw ?? face + Math.PI; pf.test.trace = []; };
    A.start = (fn) => { if (!pf.test.trace) pf.test.trace = []; const t0 = pf.S.t; pf.test.input = (t, v) => fn(t - t0, v); };
    A.stop = () => { const t = pf.test.trace; pf.test.trace = null; pf.test.input = () => ({}); return t; };
    // depth clearance grid column top (three x, z)
    const D = __park.depth; A.top = (x, z) => { const i = Math.floor((x + D.HALF) / D.CELL), j = Math.floor((z + D.HALF) / D.CELL); return D.grid[j * D.N + i]; };
    const nav = __park.nav; A.nav = (x, z) => { const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((-z - nav.y0) / nav.cell); if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) return null; const v = nav.A[j * nav.w + i]; return v ? (v - 1) / 100 - 2 : null; };
    // find a spot on walkable ground facing a wall whose top rises between lo and hi metres above the ground, wall 1.5-3 m ahead
    A.findWall = (cx, cz, R, lo, hi, seed = 1) => {
      let r = seed;
      const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
      for (let k = 0; k < 20000; k++) {
        const x = cx + (rnd() * 2 - 1) * R, z = cz + (rnd() * 2 - 1) * R, h = A.nav(x, z); if (h === null) continue;
        const a = rnd() * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
        let ok = true; for (let s = 0.5; s <= 1.5; s += 0.5) { const hh = A.nav(x + dx * s, z + dz * s); if (hh === null || Math.abs(hh - h) > 0.15) ok = false; }
        if (!ok) continue;
        const wx = x + dx * 2.6, wz = z + dz * 2.6, t = A.top(wx, wz) - h, n2 = A.nav(wx, wz);
        if (n2 !== null && Math.abs(n2 - h) < 0.3) continue;      // walkable at the same level: not a wall
        if (!(t > lo && t < hi && A.top(x, z) - h < 0.6)) continue;
        if (hi < 6) {          // a ledge: walkable ground on top of it, 1 - 2 m past the wall face, at the wall's height
          let up = null; for (let s = 2.9; s <= 4.2; s += 0.3) { const hh = A.nav(x + dx * s, z + dz * s); if (hh !== null && hh - h > lo - 0.3 && hh - h < hi) { up = hh; break; } }
          if (up === null) continue;
          return { x, z, h, face: Math.atan2(dx, dz), top: t, upper: up };
        }
        return { x, z, h, face: Math.atan2(dx, dz), top: t };
      }
      return null;
    };
  });
  // a second copy of the library on the page, used only to probe the collision for walls and ledges
  await page.evaluate(async () => {
    const A = window.__mv, pf = __park.platformer;
    const { loadSM64 } = await import('/fx/platformer/sm64.js'); const { animTable } = await import('/fx/platformer/anims.js');
    const sm = await loadSM64('/fx/platformer/sm64.wasm'); sm.init(animTable()); A.sm = sm; A.win = null;
    A.load = (x, z) => { const g = pf.col.gather(x, z, 30); sm.loadSurfaces(g.packed, g.count); A.win = [x, z]; };
    const U = 100, pushed = (x, y, z) => { const r = sm.findWall(x * U, y * U, z * U, 0, 30); return r[3] > 0; };
    // wall: from walkable ground, a wall within 0.6 - 3 m that blocks at 1 m and at `minTop` m above the ground (top above minTop)
    // ledge: blocks at 1 m, clear at top + 0.3, with a floor on top between lo and hi above the ground
    A.probe = (cx, cz, R, kind, lo, hi, seed = 1, minDist = 0.6, maxDist = 3) => {
      A.load(cx, cz); let r = seed; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
      for (let k = 0; k < 6000; k++) {
        const x = cx + (rnd() * 2 - 1) * R, z = cz + (rnd() * 2 - 1) * R, h = sm.findFloor(x * U, 3000, z * U) / U; if (h < -50) continue;
        if (Math.abs(sm.findFloor(x * U, (h + 1) * U, z * U) / U - h) > 0.05) continue;       // standing room
        const a = rnd() * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
        let s0 = -1; for (let s = 0.6; s <= maxDist; s += 0.2) { if (pushed(x + dx * s, h + 1, z + dz * s)) { s0 = s; break; } const f = sm.findFloor((x + dx * s) * U, (h + 1) * U, (z + dz * s) * U) / U; if (Math.abs(f - h) > 0.1) { s0 = -2; break; } }
        if (s0 < minDist) continue;
        const wx = x + dx * (s0 + 0.35), wz = z + dz * (s0 + 0.35);
        if (kind === 'wall') { let ok = true; for (let y = 2; y <= lo; y += 1) if (!pushed(x + dx * s0, h + y, z + dz * s0)) ok = false; if (ok) return { x, z, h, face: Math.atan2(dx, dz), dist: s0 }; continue; }
        const top = sm.findFloor((x + dx * (s0 + 0.8)) * U, (h + hi + 0.5) * U, (z + dz * (s0 + 0.8)) * U) / U - h;
        if (top > lo && top < hi && !pushed(x + dx * s0, h + top + 0.4, z + dz * s0)) return { x, z, h, face: Math.atan2(dx, dz), dist: s0, top };
      }
      return null;
    };
  });
  const res = {};
  const run = async (name, setup, fn, ms) => {
    if (only.length && !only.includes(name)) return;
    const info = await page.evaluate(`(${setup})()`);
    await ctx.sleep(900);
    await page.evaluate(`__mv.start(${fn})`);
    let shot = null;
    if (shots) { await ctx.sleep(ms * 0.45); shot = await ctx.shot('mv_' + name); await ctx.sleep(ms * 0.55); } else await ctx.sleep(ms);
    const tr = await page.evaluate(() => __mv.stop());
    res[name] = { info, ...summarize(tr) };
  };
  const summarize = (tr) => {
    if (!tr.length) return { empty: true };
    const acts = [], y0 = tr[0].y; let peak = -1e9, minY = 1e9, maxV = 0;
    const names = (a) => a;
    for (const e of tr) { peak = Math.max(peak, e.y); minY = Math.min(minY, e.y); maxV = Math.max(maxV, Math.abs(e.fwd)); if (!acts.length || acts[acts.length - 1].a !== e.act) acts.push({ a: e.act, t: e.t, anim: e.anim, f: e.seq }); }
    const first = tr[0], last = tr[tr.length - 1];
    return { ticks: tr.length, peakAbove: +(peak - y0).toFixed(2), drop: +(y0 - minY).toFixed(2), maxSpeed: +maxV.toFixed(2), dist: +Math.hypot(last.x - first.x, last.z - first.z).toFixed(2),
      start: [first.x, first.y, first.z].map((v) => +v.toFixed(2)), end: [last.x, last.y, last.z].map((v) => +v.toFixed(2)), acts: acts.map((q) => q.a), actTimes: acts.map((q) => q.f), anims: acts.map((q) => q.anim), surfaces: last.n };
  };
  // ── scenarios (positions: three.js metres; face: library angle, 0 = +z, pi = -z / north; gate avenue runs along -x) ──
  const G = '(() => { __mv.place(288, 0.4, 0, -Math.PI / 2); return 1; })';   // gate plaza, facing west (-x)
  await run('idle', G, '(t) => ({})', 2500);
  await run('walk', G, '(t) => ({ world: [-0.45, 0] })', 3000);
  await run('run', G, '(t) => ({ world: [-1, 0] })', 3500);
  await run('skid', G, '(t) => ({ world: t < 2.2 ? [-1, 0] : [1, 0] })', 3500);
  await run('singleJump', G, '(t) => ({ a: t < 1.0 })', 2200);
  await run('runningJump', G, '(t) => ({ world: [-1, 0], a: t > 1.2 && t < 2.0 })', 3200);
  await run('tripleJump', '(() => { __mv.place(320, 0.4, 0, -Math.PI / 2); return 1; })', `(t, v) => { const act = v && v.s ? v.s.action : 0; const air = act & 0x800; if (!window.__tj) window.__tj = { n: 0, hold: 0, wasAir: false };
      const T = window.__tj; if (t < 0.05) { T.n = 0; T.hold = 0; T.wasAir = false; }
      if (T.wasAir && !air && T.n < 3) { T.hold = 0.22; T.n++; } T.wasAir = !!air; if (t > 1.0 && T.n === 0) { T.n = 1; T.hold = 0.3; }
      if (T.hold > 0) { T.hold -= 1 / 60; return { world: [-1, 0], a: true }; } return { world: [-1, 0] }; }`, 6500);
  await run('longJump', G, '(t) => ({ world: [-1, 0], z: t > 1.4 && t < 1.7, a: t > 1.5 && t < 1.7 })', 3800);
  await run('backflip', G, '(t) => ({ z: t > 0.3, a: t > 0.6 && t < 0.8 })', 2600);
  await run('sideFlip', G, '(t) => ({ world: t < 1.2 ? [-1, 0] : [1, 0], a: t > 1.32 && t < 1.5 })', 3200);
  await run('groundPound', G, '(t) => ({ a: t < 0.5, z: t > 0.5 && t < 0.7 })', 2600);
  await run('dive', G, '(t) => ({ world: [-1, 0], b: t > 1.5 && t < 1.65 })', 4200);
  await run('punches', G, '(t) => ({ b: (t > 0.2 && t < 0.3) || (t > 0.45 && t < 0.55) || (t > 0.7 && t < 0.8) })', 2400);
  await run('crouchCrawl', G, '(t) => ({ z: t < 3.5, world: t > 0.8 && t < 3.0 ? [-0.8, 0] : [0, 0] })', 4500);
  await run('slideKick', G, '(t) => ({ world: [-1, 0], z: t > 1.4 && t < 1.6, b: t > 1.5 && t < 1.6 })', 3800);
  // a real park wall: kick between it and nothing (single kick), measured from the trace
  await run('wallKick', '(() => { const w = __mv.probe(240, 0, 25, "wall", 7, 0, 7); if (!w) return null; __mv.place(w.x, w.h + 0.3, w.z, w.face); window.__w = w; return w; })',
    `(t, v) => { const w = window.__w; if (!w) return {}; const d = [Math.sin(w.face), Math.cos(w.face)]; const act = v && v.s ? v.s.action : 0;
      if (!window.__wk) window.__wk = { k: 0, last: -1 }; const K = window.__wk; if (t < 0.05) { K.k = 0; K.hit = -1; }
      if (act === 0x000008A7 && K.hit < 0) K.hit = t;
      if (K.hit > 0 && t - K.hit < 0.1) return { world: [-d[0], -d[1]], a: true };
      return { world: d, a: t > 0.15 && t < 0.4 }; }`, 3500);
  // a real ledge (2.3 - 3.3 m high, a floor on top): run at it, jump, hang, climb. Tries several candidates.
  if (!only.length || only.includes('ledge')) {
    for (let k = 0; k < 8; k++) {
      const spots = [[250, 0], [140, 48], [-150, 36], [41, -134], [-116, -108], [168, -60], [-116, 108], [41, 134]];
      const [cx, cz] = spots[k];
      const info = await page.evaluate((cx, cz, k) => { const w = __mv.probe(cx, -cz, 30, 'ledge', 2.2, 3.2, 3 + k, 0.8, 1.8); if (!w) return null; __mv.place(w.x, w.h + 0.3, w.z, w.face); window.__w = w; return w; }, cx, cz, k);
      if (!info) continue;
      await ctx.sleep(900);
      await page.evaluate(`__mv.start((t) => { const w = window.__w; const d = [Math.sin(w.face), Math.cos(w.face)]; return { world: t > 1.6 && t < 2.6 ? [0, 0] : t > 2.6 ? d : [d[0] * 0.45, d[1] * 0.45], a: t > 0.15 && t < 0.7 }; })`);
      let shot = null; await ctx.sleep(1500); if (shots) shot = await ctx.shot('mv_ledge_' + k); await ctx.sleep(2500);
      const tr = await page.evaluate(() => __mv.stop());
      const r = { info, ...summarize(tr) }; res['ledge_try' + k] = r;
      if (tr.some((e) => e.act === 0x0800034B)) { res.ledge = r; break; }
    }
  }
  // swimming: from the lake promenade at (104, 0) Blender into the water, west toward the Spire island
  await run('swim', '(() => { __mv.place(103, 0.4, 0, -Math.PI / 2); return 1; })', `(t, v) => { const sw = v && v.s && (v.s.action & 0x1C0) === 0xC0; return sw ? { a: (t % 0.5) < 0.15 } : { world: [-1, 0] }; }`, 22000);
  // falling off something tall: drop from 12 m above the gate plaza (the library ignores falls under 11.5 m)
  // swim to the Spire island and climb out: strokes west, then at the island push forward with A (water jump / ledge)
  await run('swimToIsland', '(() => { __mv.place(103, 0.4, 0, -Math.PI / 2); return 1; })', `(t, v) => { const s = v && v.s; if (!s) return {}; const sw = (s.action & 0x1C0) === 0xC0, x = v.pos.x;
      if (!sw && x > 60) return { world: [-1, 0] };
      if (sw && x > 22) return { a: (t % 0.5) < 0.15 };
      return { world: [-1, 0], a: (t % 1.0) < 0.2 }; }`, 30000);
  // stairs and slopes from the walk grid: a straight 6 m line of walkable cells climbing 1 - 3 m; stairs rise in steps
  // of 10 cm or more between neighbouring cells, slopes in smaller increments
  for (const kind of ['stairs', 'slope']) {
    if (only.length && !only.includes(kind)) continue;
    const info = await page.evaluate((kind) => {
      let r = kind === 'stairs' ? 11 : 29; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
      for (let k = 0; k < 400000; k++) {
        const x = -270 + rnd() * 610, z = -220 + rnd() * 440, a = rnd() * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
        const h0 = __mv.nav(x, z); if (h0 === null) continue;
        let ok = true, prev = h0, jumps = 0, maxJump = 0;
        for (let s = 0.25; s <= 6; s += 0.25) { const h = __mv.nav(x + dx * s, z + dz * s); if (h === null || h < prev - 0.02) { ok = false; break; } const d = h - prev; if (d >= 0.1) jumps++; maxJump = Math.max(maxJump, d); prev = h; }
        if (!ok) continue; const rise = prev - h0; if (rise < (kind === 'slope' ? 0.5 : 1) || rise > 3) continue;
        // sideways room too
        if (__mv.nav(x + dz * 0.5, z - dx * 0.5) === null || __mv.nav(x - dz * 0.5, z + dx * 0.5) === null) continue;
        if (kind === 'stairs' && (jumps < 4 || maxJump > 0.45)) continue;
        if (kind === 'slope' && (jumps > 0 || maxJump > 0.08)) continue;
        __mv.place(x, h0 + 0.3, z, Math.atan2(dx, dz)); window.__st = { x, z, h0, rise, face: Math.atan2(dx, dz), jumps };
        return window.__st;
      }
      return null;
    }, kind);
    if (!info) { res[kind] = { notFound: true }; continue; }
    await ctx.sleep(900);
    await page.evaluate(`__mv.start((t) => { const w = window.__st; return { world: [Math.sin(w.face) * 0.6, Math.cos(w.face) * 0.6] }; })`);
    await ctx.sleep(3500);
    const tr = await page.evaluate(() => __mv.stop());
    res[kind] = { info, ...summarize(tr), climbed: +(Math.max(...tr.map((e) => e.y)) - info.h0).toFixed(2) };
  }
  // Frostmere's skating rink is an ice surface: run across it and let go
  await run('iceRink', '(() => { __mv.place(-99.5, 0.5, -64.5, 1.2); return 1; })', '(t) => ({ world: t < 1.0 ? [Math.sin(1.2), Math.cos(1.2)] : [0, 0] })', 4000);
  await run('stopOnStone', G, '(t) => ({ world: t < 1.0 ? [-1, 0] : [0, 0] })', 4000);
  // Frostmere snow: standing still long enough (three idle beats) turns into warming the hands at the lantern
  await run('snowIdle', `(() => { const g = __park.platformer.col.gather(-100, -90, 25), A = g.packed; let best = null;
      for (let i = 0; i < g.count; i++) { const o = i * 11; if (A[o + 1] !== 2) continue; const y = Math.max(A[o + 3], A[o + 6], A[o + 9]) - Math.min(A[o + 3], A[o + 6], A[o + 9]); if (y > 3) continue;
        const x = (A[o + 2] + A[o + 5] + A[o + 8]) / 300, z = (A[o + 4] + A[o + 7] + A[o + 10]) / 300, h = A[o + 3] / 100;
        if (__mv.nav(x, z) === null || h > 1) continue;
        if (!__mv.win || __mv.win[0] !== -100) __mv.load(-100, -90);
        const f = __mv.sm.findFloor(x * 100, (h + 0.5) * 100, z * 100) / 100; if (Math.abs(f - h) > 0.03) continue;
        if (!best || Math.abs(x + 100) + Math.abs(z + 90) < Math.abs(best[0] + 100) + Math.abs(best[1] + 90)) best = [x, z, h]; }
      if (!best) return null; __mv.place(best[0], best[2] + 0.4, best[1], 0); return best; })`, '(t) => ({})', 76000);
  await run('fall14m', '(() => { __mv.place(284, 14.2, 0, 0); return 1; })', '(t) => ({})', 3000);
  await run('fall32m', '(() => { __mv.place(284, 32.2, 0, 0); return 1; })', '(t) => ({})', 6000);
  // the park boundary at the east end of the gate plaza
  await run('boundary', '(() => { __mv.place(328, 0.4, 0, Math.PI / 2); return 1; })', '(t) => ({ world: [1, 0] })', 4000);
  // the whole lake promenade at a run: collision windows reload all the way round; frame times are recorded
  if (!only.length || only.includes('ring')) {
    await page.evaluate(() => {
      const lake = __park.platformer.col, L = window.__lakePoly;
      window.__ring = { frames: [], last: performance.now(), phi0: null, lap: 0, stuck: 0 };
      const R = window.__ring; const tick = () => { if (!R.on) return; const n = performance.now(); R.frames.push(n - R.last); R.last = n; requestAnimationFrame(tick); }; R.on = true; requestAnimationFrame(tick);
    });
    const info = await page.evaluate(async () => {
      const m = await (await fetch('/data/manifest.json')).json(); const pl = m.lake;
      window.__rl = (phi) => { // lake radius along phi (Blender)
        let best = 0; const dx = Math.cos(phi), dy = Math.sin(phi);
        for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [ax, ay] = pl[j], [bx, by] = pl[i], ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue; const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den; if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t); }
        return best; };
      // a ring of waypoints on walkable ground just outside the lake (walk grid), every 2 degrees
      const wp = [];
      for (let k = 0; k < 180; k++) { const phi = k * Math.PI / 90, rl = window.__rl(phi); let pick = null;
        for (let r = rl + 3; r < rl + 25 && !pick; r += 0.5) { const x = r * Math.cos(phi), y = r * Math.sin(phi); let ok = true; for (let q = 0; q < 4; q++) { const h = __mv.nav(x + q * 0.5 * Math.cos(phi), -(y + q * 0.5 * Math.sin(phi))); if (h === null || Math.abs(h) > 2.5) ok = false; } if (ok) pick = [x + Math.cos(phi), y + Math.sin(phi)]; }
        wp.push(pick || [ (rl + 6) * Math.cos(phi), (rl + 6) * Math.sin(phi) ]); }
      window.__wp = wp;
      __mv.place(wp[0][0], 0.6, -wp[0][1], Math.PI); return { r0: Math.hypot(...wp[0]), waypoints: wp.length };
    });
    await ctx.sleep(1200);
    await page.evaluate(`__mv.start((t, v) => { if (!v || !v.pos) return {}; const x = v.pos.x, y = -v.pos.z, phi = Math.atan2(y, x), wp = window.__wp;
      let k = Math.round(((phi + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 90)) + 3; const [tx, ty] = wp[k % 180]; let dx = tx - x, dy = ty - y; const l = Math.hypot(dx, dy) || 1;
      const R = window.__ring; const sp = Math.hypot(v.vel.x, v.vel.z); R.stuck = sp < 1.5 ? R.stuck + 1 / 60 : 0;
      return { world: [dx / l, -dy / l], a: R.stuck > 0.6 && (t % 0.8) < 0.3 }; })`);
    const t0 = Date.now(); let done = false;
    while (!done && Date.now() - t0 < 110000) { await ctx.sleep(2000); done = await page.evaluate(() => { const tr = __park.platformer.test.trace; if (!tr || tr.length < 60) return false; let a = 0; for (let i = 1; i < tr.length; i++) { const p0 = Math.atan2(-tr[i - 1].z, tr[i - 1].x), p1 = Math.atan2(-tr[i].z, tr[i].x); let d = p1 - p0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; a += d; } return Math.abs(a) > Math.PI * 2; }); }
    const tr = await page.evaluate(() => __mv.stop());
    const R = await page.evaluate(() => { const R = window.__ring; R.on = false; const f = R.frames.slice(5).sort((a, b) => a - b); const pf = __park.platformer;
      return { frames: f.length, p50: f[f.length >> 1], p99: f[Math.floor(f.length * 0.99)], max: f[f.length - 1], over25: f.filter((x) => x > 25).length, loads: pf.S.loads, events: pf.S.events.slice(-4), respawns: pf.S.respawns }; });
    let ang = 0; for (let i = 1; i < tr.length; i++) { const p0 = Math.atan2(-tr[i - 1].z, tr[i - 1].x), p1 = Math.atan2(-tr[i].z, tr[i].x); let d = p1 - p0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; ang += d; }
    let len = 0; for (let i = 1; i < tr.length; i++) len += Math.hypot(tr[i].x - tr[i - 1].x, tr[i].z - tr[i - 1].z);
    res.ring = { info, seconds: (Date.now() - t0) / 1000, turnedDeg: Math.round(ang * 180 / Math.PI), pathM: Math.round(len), ...R, acts: [...new Set(tr.map((e) => e.act))], maxSurfaces: Math.max(...tr.map((e) => e.n)) };
  }
  fs.writeFileSync(OUT + '/moves.json', JSON.stringify(res, null, 1));
  return res;
};
