// The Meridian Loop: board at the south platform, ride a lap in the front seat of the next train, step off where you got on.
// The trains never stop (app.js updateTrains runs them at a steady 8.5 m/s), so the camera simply joins and leaves a moving train.
const SPEED = 8.5;                  // app.js TRAIN_SPEED
const SEAT = [3.8, 1.85, 0];        // front of the lead car, car-local (x forward, y up): behind the glass nose, above the window sill
const PLAT_D = 4.7;                 // the south platform is 1.9 to 7.4 m from the beam; the middle of it
const mod = (a, n) => ((a % n) + n) % n;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// the same ellipse and arc-length table as app.js (initRail / railAt)
function makeRail(a, b, n = 2048) {
  const acc = new Float32Array(n + 1); let px = a, py = 0;
  for (let i = 1; i <= n; i++) { const t = (i / n) * Math.PI * 2, x = a * Math.cos(t), y = b * Math.sin(t); acc[i] = acc[i - 1] + Math.hypot(x - px, y - py); px = x; py = y; }
  const len = acc[n];
  return {
    len,
    at(s) {
      s = mod(s, len); let lo = 0, hi = n;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acc[mid] <= s) lo = mid; else hi = mid; }
      const f = (s - acc[lo]) / (acc[lo + 1] - acc[lo] || 1), t = ((lo + f) / n) * Math.PI * 2, tx = -a * Math.sin(t), ty = b * Math.cos(t), l = Math.hypot(tx, ty);
      return { x: a * Math.cos(t), y: b * Math.sin(t), tx: tx / l, ty: ty / l };
    },
    sOf(x, y) {
      const t = mod(Math.atan2(y / b, x / a), Math.PI * 2), f = (t / (Math.PI * 2)) * n, i = Math.min(n - 1, Math.floor(f));
      return acc[i] + (acc[i + 1] - acc[i]) * (f - i);
    },
  };
}

export function createMonorail(game, session, { count }) {
  const { THREE } = game, man = game.manifest, rail = makeRail(man.rail.a, man.rail.b), top = man.rail.top;
  const mer = man.lands.find((l) => l.id === 'meridian');
  // the station: the point of the loop nearest Meridian's centre (as the Blender station script finds it)
  let s0 = 0, best = 1e9; for (let s = 0; s < rail.len; s += 0.25) { const p = rail.at(s), d = Math.hypot(p.x - mer.center[0], p.y - mer.center[1]); if (d < best) { best = d; s0 = s; } }
  const st = rail.at(s0); let N = [-st.ty, st.tx]; if (N[1] < 0) N = [-N[0], -N[1]];            // normal towards +y (the north side)
  // the south platform (top at z = 10), level with the beam's shoulder
  const board = { x: st.x - N[0] * PLAT_D, y: st.y - N[1] * PLAT_D, z: 10 };
  const faceYaw = Math.atan2(st.ty, st.tx);                                // Blender heading of the trains here
  const eye = new THREE.Vector3(board.x, board.z + 1.62, -board.y);
  const tmp = new THREE.Vector3(), seat = new THREE.Vector3();

  const leads = () => game.ctx.getTrains().filter((g) => /car0$/.test(g.userData.name));
  const seatOf = (g, out) => { g.updateMatrixWorld(true); return g.localToWorld(out.set(SEAT[0], SEAT[1], SEAT[2])); };
  const distTo = (g) => { seatOf(g, tmp); return mod(s0 - rail.sOf(tmp.x, -tmp.z), rail.len); };      // metres until the seat reaches the station
  const lands = man.lands;
  const landName = (x, y) => { let b = null, bd = 1e9; for (const l of lands) { const d = Math.hypot(l.center[0] - x, l.center[1] - y); if (d < bd) { bd = d; b = l; } } return b ? b.name : ''; };

  let it = null, run = null;
  function begin() {
    const ls = leads(); if (!ls.length || session.active) return;
    let lead = null, bd = 1e9; for (const g of ls) { const d = distTo(g); if (d < bd) { bd = d; lead = g; } }
    run = { lead, phase: 'wait', left: false, yaw: 0, pitch: -0.05, lastTxt: '', first: true };
    const def = {
      id: 'monorail', name: 'the Meridian Loop', leave: 'Get off at the next stop', look: { yaw: 1.75, pitch: 0.8 }, sway: 1, blendIn: 0.9, blendOut: 1.0,
      frame, exit,
      onEnd(why) { game.track('rides', null); if (run) run.lead.visible = true; run = null; },
    };
    if (!session.start(def)) { run = null; return; }
    game.track('rides', 'Meridian Loop: waiting on the platform', { order: 1 });
    game.toast('Wait here. A train will come in.', { ms: 3000 });
  }
  function exit() {
    const cp = new THREE.Vector3(eye.x, eye.y, eye.z);
    return { x: board.x, y: board.y, z: board.z, yaw: faceYaw, pos: cp, cyaw: Math.atan2(-Math.cos(faceYaw), Math.sin(faceYaw)), cpitch: -0.03 };
  }
  function frame(dt, pose) {
    const r = run, g = r.lead, d = distTo(g);
    if (r.phase === 'wait') {
      const eta = d / SPEED, txt = eta < 2.5 ? 'The train is coming in' : `The next train is ${Math.round(eta)} seconds away`;
      if (txt !== r.lastTxt) { r.lastTxt = txt; game.track('rides', 'Meridian Loop: ' + txt.toLowerCase(), { order: 1 }); session.setLeave('Never mind'); }
      // watch it come in: the train once it is near, else the stretch of beam it will arrive along
      let tx, ty, tz;
      if (d < 110) { seatOf(g, seat); tx = seat.x; ty = seat.y; tz = seat.z; } else { const p = rail.at(s0 - 70); tx = p.x; ty = top + 1.5; tz = -p.y; }
      const dx = tx - eye.x, dz = tz - eye.z, wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(ty - eye.y, Math.hypot(dx, dz));
      if (r.first) { r.yaw = wantYaw; r.pitch = wantPitch; r.first = false; }
      else { const k = Math.min(1, dt * 3); r.yaw += angDiff(wantYaw, r.yaw) * k; r.pitch += (wantPitch - r.pitch) * k; }
      pose.pos.copy(eye); pose.yaw = r.yaw; pose.pitch = r.pitch;
      if (d < 2.2) { r.phase = 'ride'; r.left = false; g.visible = false;   // the car's own nose is opaque seen from inside (0.6 m ahead of the seat): the lead car is hidden for the rider, who sees the park ahead
       pose.blend = 0.8; count('monorail'); game.emit('rides:board', { ride: 'monorail' }); session.setLeave('Get off at the next stop'); }
      return;
    }
    // riding: the front seat of the lead car, looking along the track
    seatOf(g, pose.pos);
    pose.yaw = g.rotation.y - Math.PI / 2; pose.pitch = -0.04;
    if (d > rail.len * 0.5) r.left = true;
    const p = rail.at(rail.sOf(pose.pos.x, -pose.pos.z)), name = landName(p.x, p.y);
    if (name !== r.land) { r.land = name; game.track('rides', `Meridian Loop: over ${name}`, { order: 1 }); }
    if (r.left && d < 3) session.end('done');
  }
  it = game.interact({ id: 'rides:monorail', x: board.x, y: board.y, z: board.z, r: 3.6, label: 'Board the Meridian Loop', show: () => !game.cameraHeld, use: begin });
  return { board, faceYaw, s0, rail, begin, get run() { return run; }, distTo, leads };
}
