// Fake remote visitors for developing and testing fx/multiplayer/avatars.js without a server.
//
//   await __park.mpSim(8)        // eight visitors walk near you (Walk mode or wherever the camera is)
//   await __park.mpSim(0)        // they leave
//   (await __park.mpSim(8, { teleport: true, measure: true })).report()   // as the test runs it
//
// Each visitor walks a chain of straight legs between walk-grid points near the start (legs checked on the grid at
// 0.5 m steps) and pauses at each point (a Wick sometimes jumps there). It ticks 10 times a second like a client and
// sends its state when it has moved, turned, stopped or changed animation, else every 500 ms, stamped with its own
// clock (a random offset from ours). Delivery takes a base latency plus exponential jitter (and, with `spikes`, that
// share of packets 150 ms late) and keeps order, like a WebSocket. One visitor in four is first person ('fp', anim -1).
// With `teleport`, visitor 0 jumps 40 m away after 6 s. With `measure`, every frame compares each drawn avatar with
// where its sender was 120 ms + the base latency ago (report() gives mean, p95, max per sender, and any snaps).
import * as THREE from 'three';
import { createAvatars } from './avatars.js';
import { ID, LEN } from '../platformer/anims.js';

const NAMES = ['Amber Moth', 'Quiet Heron', 'Paper Fox', 'Lamp Wren', 'Slow Comet', 'Night Otter', 'Tin Lantern', 'Rose Finch', 'Brine Gull', 'Frost Hare',
  'Velvet Owl', 'Copper Newt', 'Ember Kite', 'Mist Badger', 'Pale Lynx', 'Ink Sparrow', 'Moss Deer', 'Cinder Crow', 'Tide Seal', 'Ash Wolf',
  'Reed Swan', 'Glass Carp', 'Oak Mouse', 'Plum Bat', 'Dusk Robin', 'Salt Crab', 'Fern Toad', 'Gold Beetle', 'Coal Cat', 'Moth <b>&amp;</b> Co'];
const DELAY = 120;

let current = null;
export async function mpSim(park, n = 8, opts = {}) {
  if (current) { current.stop(); current = null; }
  if (!n) return null;
  current = createSim(park, n, opts);
  return current;
}

export function createSim(park, n, { latency = 40, jitter = 18, spikes = 0.03, teleport = false, measure = false, radius = 18, center = null, seed = 7, fpEvery = 4, avatars: given = null } = {}) {
  const game = park.game;
  let rs = seed >>> 0 || 1; const rnd = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
  const av = given || createAvatars({ THREE, scene: park.scene, surface: park.surface, guests: park.guests, manifest: game.manifest, game });
  const P = game.player, c0 = center || [P.x, P.y];
  const ground = (x, y, z) => game.ground(x, y, z);
  // a walkable straight leg: grid under every 0.5 m step, no step up or down over 0.45 m
  function legOk(ax, ay, az, bx, by) {
    const L = Math.hypot(bx - ax, by - ay), k = Math.max(1, Math.ceil(L / 0.5)); let z = az;
    for (let i = 1; i <= k; i++) { const g = ground(ax + (bx - ax) * i / k, ay + (by - ay) * i / k, z); if (g === null || Math.abs(g - z) > 0.45) return null; z = g; }
    return z;
  }
  function pick(x, y, z, r) {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, d = 3 + rnd() * r, bx = x + Math.cos(a) * d, by = y + Math.sin(a) * d;
      if (Math.hypot(bx - c0[0], by - c0[1]) > radius * 1.6) continue;
      const bz = legOk(x, y, z, bx, by); if (bz !== null) return [bx, by, bz];
    }
    return null;
  }
  function startPoint() {
    for (let k = 0; k < 200; k++) { const a = rnd() * Math.PI * 2, d = 2 + rnd() * radius, x = c0[0] + Math.cos(a) * d, y = c0[1] + Math.sin(a) * d, z = ground(x, y, P.z); if (z !== null && Math.abs(z - P.z) < 3) return [x, y, z]; }
    return [c0[0], c0[1], ground(c0[0], c0[1], P.z) ?? P.z];
  }
  const t0 = performance.now();
  const senders = [];
  for (let i = 0; i < n; i++) {
    const kind = fpEvery && i % fpEvery === fpEvery - 1 ? 'fp' : 'wick';
    const [x, y, z] = startPoint();
    const speed = kind === 'fp' ? (rnd() < 0.5 ? 4.6 : 2.4) : (rnd() < 0.4 ? 5.5 : 1.6);
    senders.push({ id: 'sim' + i, name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (i / NAMES.length | 0) : ''), kind, speed,
      clock: (rnd() - 0.5) * 2e6, legs: [{ ta: t0, tb: t0 + 300 + rnd() * 1500, ax: x, ay: y, az: z, bx: x, by: y, bz: z, still: true, jump: false, yaw: rnd() * 6.28 }],
      nextSend: t0 + rnd() * 100, lastDeliver: 0, queue: [], gone: false, tp: teleport && i === 0 ? t0 + 6000 : 0, err: [], slid: 0 });
  }
  // extend a sender's legs so they reach time t
  function extend(s, t) {
    let L = s.legs[s.legs.length - 1];
    while (L.tb < t + 1000) {
      const ta = L.tb;
      if (s.tp && ta >= s.tp && !s.tpDone) {        // teleport: a far point (40 m away or so), then carry on there
        s.tpDone = true;
        let q = null; for (let k = 0; k < 200 && !q; k++) { const a = rnd() * 6.28, x = L.bx + Math.cos(a) * 40, y = L.by + Math.sin(a) * 40, z = ground(x, y, L.bz); if (z !== null) q = [x, y, z]; }
        if (q) { s.tpAt = ta; s.tpFrom = [L.bx, L.by, L.bz]; s.tpTo = q; L = { ta, tb: ta + 800, ax: q[0], ay: q[1], az: q[2], bx: q[0], by: q[1], bz: q[2], still: true, jump: false, yaw: L.yaw }; s.legs.push(L); continue; }
      }
      if (L.still) {
        const q = pick(L.bx, L.by, L.bz, 9);
        if (!q) { L = { ...L, ta, tb: ta + 1000, ax: L.bx, ay: L.by, az: L.bz }; s.legs.push(L); continue; }
        const d = Math.hypot(q[0] - L.bx, q[1] - L.by);
        L = { ta, tb: ta + (d / s.speed) * 1000, ax: L.bx, ay: L.by, az: L.bz, bx: q[0], by: q[1], bz: q[2], still: false, jump: false, yaw: Math.atan2(q[1] - L.by, q[0] - L.bx) };
      } else {
        const jump = s.kind === 'wick' && rnd() < 0.5;
        L = { ta, tb: ta + (jump ? 1300 : 600 + rnd() * 2200), ax: L.bx, ay: L.by, az: L.bz, bx: L.bx, by: L.by, bz: L.bz, still: true, jump, yaw: L.yaw };
      }
      s.legs.push(L);
    }
    while (s.legs.length > 4 && s.legs[1].tb < t - 4000) s.legs.shift();
  }
  // the sender's true state at our time t
  function at(s, t, out) {
    extend(s, t);
    let L = s.legs[0]; for (const l of s.legs) { if (l.ta <= t) L = l; else break; }
    const f = L.tb > L.ta ? Math.min(1, Math.max(0, (t - L.ta) / (L.tb - L.ta))) : 1;
    out.x = L.ax + (L.bx - L.ax) * f; out.y = L.ay + (L.by - L.ay) * f; out.yaw = L.yaw; out.moving = !L.still;
    out.z = L.still ? L.az : (ground(out.x, out.y, L.az + (L.bz - L.az) * f) ?? L.az + (L.bz - L.az) * f);
    const e = (t - L.ta) / 1000;
    if (s.kind === 'fp') { out.anim = -1; out.frame = 0; return out; }
    if (L.jump && e < 0.8) {           // a jump in place: up and down in 0.8 s, then the landing
      const h = 4.2 * e - 5.25 * e * e; out.z += Math.max(0, h); out.anim = ID.jump; out.frame = Math.min(LEN[ID.jump] - 1, e * 30 * 1.3); out.moving = true; return out;
    }
    if (L.jump && e < 1.07) { out.anim = ID.land; out.frame = Math.min(LEN[ID.land] - 1, (e - 0.8) * 30); return out; }
    if (L.still) { out.anim = ID.idleLook; out.frame = Math.min(LEN[ID.idleLook] - 1, e * 30); return out; }
    const run = s.speed > 3, len = LEN[run ? ID.run : ID.walk], dist = s.speed * (t - L.ta) / 1000;
    out.anim = run ? ID.run : ID.walk; out.frame = (dist / 0.04) % len; return out;
  }
  const st = { x: 0, y: 0, z: 0, yaw: 0, anim: 0, frame: 0, moving: false };
  const lat = () => latency + (-Math.log(1 - rnd() * 0.999) * jitter) + (rnd() < spikes ? 150 : 0);
  const stats = { frames: 0, sent: 0, delivered: 0 };
  function frame({ dt, time }) {
    const now = performance.now();
    for (const s of senders) {
      if (s.gone) continue;
      // send what the sender has to say up to now
      // a client ticks 10 times a second and sends when it has moved, turned, stopped or changed animation, else every 500 ms
      while (s.nextSend <= now) {
        const ts = s.nextSend; at(s, ts, st); s.nextSend = ts + 100;
        const L = s.last, moved = !L || Math.hypot(st.x - L.x, st.y - L.y, st.z - L.z) > 0.01 || st.yaw !== L.yaw || st.anim !== L.anim || st.moving !== L.moving;      // so a stop is sent at once
        if (!moved && ts - L.ts < 480) continue;
        const msg = { name: s.name, kind: s.kind, x: st.x, y: st.y, z: st.z, yaw: st.yaw, anim: st.anim, frame: st.frame, t: ts + s.clock };
        s.last = { x: st.x, y: st.y, z: st.z, yaw: st.yaw, anim: st.anim, moving: st.moving, ts };
        const due = Math.max(s.lastDeliver, ts + lat()); s.lastDeliver = due; s.queue.push([due, msg]); stats.sent++;
      }
      // deliver what has arrived (in order)
      while (s.queue.length && s.queue[0][0] <= now) { av.upsert(s.id, s.queue.shift()[1]); stats.delivered++; }
    }
    av.update(dt, time, park.camera);
    stats.frames++;
    if (measure) for (const s of senders) {
      const d = av.debug(s.id); if (!d || !d.drawn) continue;
      // a snap: the drawn avatar moving further in one frame than the sender could (plus 0.25 m), outside a teleport
      if (s.prev && dt > 0 && !(s.tpAt && Math.abs(now - latency - DELAY - s.tpAt) < 400)) {
        const step = Math.hypot(d.x - s.prev[0], d.y - s.prev[1], d.z - s.prev[2]) - (s.speed * 1.6 + 5) * dt;
        if (step > (s.maxStep || 0)) s.maxStep = step;
      }
      s.prev = [d.x, d.y, d.z];
      const ts = now - latency - DELAY; at(s, ts, st);
      const e = Math.hypot(d.x - st.x, d.y - st.y, d.z - st.z);
      if (s.tpAt && Math.abs(ts - s.tpAt) < 400) {           // around the teleport: on one side or the other, never between
        const a = Math.hypot(d.x - s.tpFrom[0], d.y - s.tpFrom[1]), b = Math.hypot(d.x - s.tpTo[0], d.y - s.tpTo[1]);
        if (a > 3 && b > 3) s.slid++;
        continue;
      }
      if (now - t0 > 1500) {
        s.err.push(e);
        if (e > 0.4 && (s.big = s.big || []).length < 12) s.big.push([Math.round(now - t0), +e.toFixed(2), d.extrap, d.corr, Math.round(d.play - s.clock), Math.round(d.off - s.clock), s.queue.length, Math.round(dt * 1000)]);
        if (!s.worst || e > s.worst.e) { let L = s.legs[0]; for (const l of s.legs) { if (l.ta <= ts) L = l; else break; }
          s.worst = { e: +e.toFixed(3), legT: Math.round(ts - L.ta), legLen: Math.round(L.tb - L.ta), still: L.still, jump: L.jump, dz: +(d.z - st.z).toFixed(2), corr: d.corr, extrap: d.extrap, q: s.queue.length }; }
      }
    }
  }
  const off = game.on('frame', frame);
  const sim = {
    avatars: av, senders, stats,
    leave(i) { const s = senders[i]; if (s && !s.gone) { s.gone = true; av.remove(s.id); } },
    stop() {      // they fade out over a second (the frame hook keeps running for that), then everything is freed
      for (const s of senders) if (!s.gone) { s.gone = true; av.remove(s.id); }
      setTimeout(() => { off(); if (!given) av.dispose(); }, 1300);
    },
    report() {
      const per = senders.map((s) => { const e = s.err.slice().sort((a, b) => a - b); const q = (p) => (e.length ? +e[Math.min(e.length - 1, Math.floor(p * e.length))].toFixed(3) : null);
        return { id: s.id, kind: s.kind, speed: s.speed, n: e.length, mean: e.length ? +(e.reduce((a, b) => a + b, 0) / e.length).toFixed(3) : null, p95: q(0.95), max: q(1 - 1e-9), teleported: !!s.tpAt, slid: s.slid, snap: +((s.maxStep || 0).toFixed(3)), worst: s.worst, big: s.big }; });
      return { frames: stats.frames, sent: stats.sent, delivered: stats.delivered, per };
    },
  };
  return sim;
}
