// A small closed-loop driver for Wick, used by the trials test and the route search (same code in both, so a route found
// in the fast offline simulation is the route the test drives in the real page). Works from the library's state
// (`s`: pos [x, y, z] in 1/100 m, three.js axes; action; vel), never from timing, so it does not care about frame rate.
// A route is a list of legs: { kind: 'walk' | 'single' | 'long' | 'triple', L: [x, z3] launch point (three.js x, z),
// h: heading in the air (face angle: (sin h, cos h) in x, z), to: [x, y, z3] where the leg should end }.
// 'walk' legs just run at `to`. The others run at L, then jump along h; the leg ends when Wick stands within `r` of `to`.
const GROUP = 0x1C0, STAT = 0x000, MOVING = 0x040, AIR = 0x080;
export function makeAgent(route) {
  const A = { i: 0, phase: 'run', jumps: 0, air: false, ticks: 0, failed: false, log: [] };
  const dirTo = (p, q) => { const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  A.step = (s, dt = 0) => {          // dt: seconds since the last call (frames are longer than the library's 1/30 s ticks; lead the jump by half a frame)
    const leg = route[A.i]; if (!leg || A.failed) return {};
    if (A.wait > 0 || A.settling) { if (A.wait > 0) A.wait--; if (A.wait > 0 || Math.abs(s.fwd) > 0.5) return {}; A.settling = false; }
    const px = s.pos[0] / 100, py = s.pos[1] / 100, pz = s.pos[2] / 100, g = s.action & GROUP, grounded = g === STAT || g === MOVING, vy = s.vel[1];
    const r = leg.r || 2.2, hd = Math.hypot(leg.to[0] - px, leg.to[2] - pz), dy = Math.abs(leg.to[1] - py);
    // a walk also ends where the wall stops him (the route search let a walk run its course, however far it got)
    if (leg.kind === 'walk' && grounded && A.ticks > 15) {
      if (!A.mark || Math.hypot(A.mark[0] - px, A.mark[1] - pz) > 0.25) A.mark = [px, pz, 0]; else A.mark[2]++;
      A.stall = A.mark[2];
    } else { A.stall = 0; A.mark = null; }
    if (grounded && ((hd < r && dy < (leg.dy || 1.6)) || (leg.kind === 'walk' && A.stall > 20)) && (leg.kind === 'walk' || A.phase !== 'run')) { A.log.push([A.i, +px.toFixed(2), +py.toFixed(2), +pz.toFixed(2), A.ticks]); A.i++; A.phase = 'run'; A.jumps = 0; A.air = false; A.ticks = 0; A.wait = leg.wait === undefined ? 40 : leg.wait; A.settling = true; A.placed = false; return {}; }
    if (++A.ticks > 900) { A.failed = true; A.landed = [px, py, pz]; return {}; }
    if (leg.kind === 'walk') { const d = dirTo([px, pz], [leg.to[0], leg.to[2]]); return { world: d }; }
    if (leg.from && !A.placed) {              // start every jump from the same standing spot, as the route search did
      const fd = Math.hypot(leg.from[0] - px, leg.from[1] - pz);
      if (fd > 0.45 && grounded) { const d = dirTo([px, pz], leg.from); const k = Math.min(0.5, 0.2 + fd * 0.2); return { world: [d[0] * k, d[1] * k] }; }
      if (Math.abs(s.fwd) > 0.5) return {};
      A.placed = true;
    }
    const lead = Math.min(1.2, Math.abs(s.fwd) * 0.3 * dt * 0.5), fwd = [Math.sin(leg.h), Math.cos(leg.h)], dl = Math.hypot(leg.L[0] - px, leg.L[1] - pz), toL = dirTo([px, pz], leg.L);
    if (A.phase === 'run') {
      // along the heading once at the launch point, at it before; the crouch for a long jump starts a metre early
      if (leg.kind === 'long') {
        const along = (leg.L[0] - px) * fwd[0] + (leg.L[1] - pz) * fwd[1];
        if (along < 0.5 + lead && grounded) { A.phase = 'air'; A.air = false; return { world: fwd, z: true, a: true }; }
        if (along < 1.4 + 2 * lead) return { world: fwd, z: true };
        return { world: dl > 1.5 ? toL : fwd };
      }
      const along = (leg.L[0] - px) * fwd[0] + (leg.L[1] - pz) * fwd[1];
      if (along < 0.4 + lead && grounded) { A.phase = 'air'; A.air = false; return { world: fwd, a: true }; }
      return { world: dl > 1.5 ? toL : fwd };
    }
    // in the air or landing: keep heading; release the jump button once he is falling; a triple jump presses again at each landing
    if (!grounded) A.air = true;
    if (grounded && A.air && !(leg.kind === 'triple' && A.jumps < 2)) { A.failed = true; A.landed = [px, py, pz]; return {}; }
    if (leg.kind === 'triple' && grounded && A.air && A.jumps < 2) { A.jumps++; A.air = false; return { world: fwd, a: true }; }
    if (!grounded && A.air && A.phase === 'air' && A.jumps === 0 && vy < 0 && leg.kind === 'triple') A.jumps = 0;
    const holdA = !grounded && vy > 0 && leg.kind !== 'long' ? (leg.holdA !== false) : false;
    const toTo = dirTo([px, pz], [leg.to[0], leg.to[2]]);
    return { world: leg.steer ? toTo : fwd, a: holdA || (grounded && !A.air) };
  };
  return A;
}
