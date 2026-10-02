// The harbor cruise: a small launch waits at a jetty on the Brinewatch shore; the visitor sits under its canopy while it crosses Stillwater to the Spire,
// circles the island once and comes back (about two and a half minutes). The baked moored cruise boat at the wharf cannot move, so this is a run-time prop.
import * as THREE from 'three';

const PHI = (-38 * Math.PI) / 180;       // bearing of the jetty from the lake's centre: an open stretch of quay south of the wharf, where the walk grid meets the water
const SPEED = 2.7;                       // m/s
const R0 = 27, R1 = 31;                  // the circuit round the Spire (the lantern punt keeps further out, 34 m and more)
const WATER = -0.8;
const SEAT = [0.35, 1.55, 0.45];             // boat-local eye position (x forward, y up)
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

// ── a tiny faceted-mesh builder: vertex colours with the shading baked in (the park is flat-shaded and lit by baked light, not by lights) ──
const LIGHT = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
function builder(tint) {
  const pos = [], col = [], c = new THREE.Color(), V = (x, y, z) => new THREE.Vector3(x, y, z);
  const quad = (a, b, cc, d, color) => {
    const n = new THREE.Vector3().subVectors(cc, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    const sh = 0.55 + 0.45 * Math.max(0, n.dot(LIGHT)) - (n.y < -0.5 ? 0.12 : 0);
    c.set(color);
    for (const v of [a, b, cc, a, cc, d]) { pos.push(v.x, v.y, v.z); col.push(c.r * sh * tint[0], c.g * sh * tint[1], c.b * sh * tint[2]); }
  };
  // a box between two corners (axis-aligned in the builder's frame), optionally with its own rotation about y
  const box = (x0, y0, z0, x1, y1, z1, color) => {
    const P = (x, y, z) => V(x, y, z);
    quad(P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), color);           // top
    quad(P(x0, y0, z1), P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), color);           // bottom
    quad(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), color);           // +x
    quad(P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), P(x0, y0, z0), color);           // -x
    quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), color);           // +z
    quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), color);           // -z
  };
  return { quad, box, V, geometry() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); return g; } };
}

// the launch: 6 m, bow towards +x, origin at the waterline amidships
function buildBoat(tint) {
  const b = builder(tint), V = b.V;
  const L = 6, N = 10, hull = '#26405e', stripe = '#d8c9a6', wood = '#9c6b3b', dark = '#3a2a1e';
  const sec = (i) => {                             // section i of the hull: stern -> bow
    const u = i / N, x = (u - 0.5) * L, bow = Math.pow(Math.min(1, (1 - u) * 5.5 + 0.05), 0.7), stern = 0.55 + 0.45 * Math.min(1, u * 6);
    const w = 1.12 * bow * stern, rise = 0.5 + 0.35 * Math.pow(u, 3);       // half-beam at the gunwale, gunwale height (the bow lifts)
    return { x, tl: V(x, rise, -w), bl: V(x, -0.32, -w * 0.45), br: V(x, -0.32, w * 0.45), tr: V(x, rise, w), w, rise };
  };
  const S = Array.from({ length: N + 1 }, (_, i) => sec(i));
  for (let i = 0; i < N; i++) {
    const a = S[i], c = S[i + 1];
    b.quad(a.tl, a.bl, c.bl, c.tl, hull); b.quad(a.br, a.tr, c.tr, c.br, hull); b.quad(a.bl, a.br, c.br, c.bl, hull);              // port, starboard, bottom
    // a cream stripe along the top of each side, and inner faces of the sides (the cockpit is open)
    const k = 0.14, lift = (p, y) => V(p.x, p.y - y, p.z);
    b.quad(lift(a.tl, 0), lift(a.tl, k), lift(c.tl, k), lift(c.tl, 0), stripe); b.quad(lift(a.tr, k), lift(a.tr, 0), lift(c.tr, 0), lift(c.tr, k), stripe);
    const ins = 0.07;
    b.quad(V(a.x, a.rise, -a.w + ins), V(c.x, c.rise, -c.w + ins), V(c.x, 0.05, -c.w * 0.45 + ins), V(a.x, 0.05, -a.w * 0.45 + ins), wood);
    b.quad(V(a.x, a.rise, a.w - ins), V(a.x, 0.05, a.w * 0.45 - ins), V(c.x, 0.05, c.w * 0.45 - ins), V(c.x, c.rise, c.w - ins), wood);
    b.quad(V(a.x, 0.05, -a.w * 0.45 + ins), V(c.x, 0.05, -c.w * 0.45 + ins), V(c.x, 0.05, c.w * 0.45 - ins), V(a.x, 0.05, a.w * 0.45 - ins), '#7b5530');      // sole
  }
  const s0 = S[0], sN = S[N];
  b.quad(s0.tr, s0.br, s0.bl, s0.tl, hull);                                                                                      // transom
  // fore deck
  const fd = S[8]; b.quad(V(fd.x, fd.rise + 0.02, -fd.w), V(fd.x, fd.rise + 0.02, fd.w), V(sN.x, sN.rise + 0.02, sN.w), V(sN.x, sN.rise + 0.02, -sN.w), wood);
  // benches and a thwart
  b.box(-1.3, 0.28, -0.78, -0.8, 0.36, 0.78, wood); b.box(0.0, 0.28, -0.85, 0.6, 0.36, 0.85, wood); b.box(1.2, 0.28, -0.8, 1.7, 0.36, 0.8, wood);
  // canopy: four posts, a peaked roof in cream and rust stripes, a valance
  for (const px of [-1.5, 1.7]) for (const pz of [-0.95, 0.95]) b.box(px - 0.04, 0.45, pz - 0.04, px + 0.04, 2.25, pz + 0.04, dark);
  const roofY = 2.25, peak = 2.5;
  for (let k = 0; k < 6; k++) {
    const x0 = -1.75 + k * 0.6, x1 = x0 + 0.6, c = k % 2 ? '#c2482f' : '#e3d6b4';
    b.quad(V(x0, roofY, -1.15), V(x0, peak, 0), V(x1, peak, 0), V(x1, roofY, -1.15), c);
    b.quad(V(x0, peak, 0), V(x0, roofY, 1.15), V(x1, roofY, 1.15), V(x1, peak, 0), c);
    b.quad(V(x0, roofY - 0.16, -1.15), V(x0, roofY, -1.15), V(x1, roofY, -1.15), V(x1, roofY - 0.16, -1.15), c === '#c2482f' ? '#e3d6b4' : '#c2482f');
    b.quad(V(x0, roofY, 1.15), V(x0, roofY - 0.16, 1.15), V(x1, roofY - 0.16, 1.15), V(x1, roofY, 1.15), c === '#c2482f' ? '#e3d6b4' : '#c2482f');
  }
  // bow post and lantern frame (the lantern itself is a separate emissive mesh)
  b.box(sN.x - 0.5 - 0.03, sN.rise, -0.03, sN.x - 0.5 + 0.03, sN.rise + 0.85, 0.03, dark);
  b.box(sN.x - 0.5 - 0.11, sN.rise + 0.85, -0.11, sN.x - 0.5 + 0.11, sN.rise + 0.9, 0.11, dark);
  const g = b.geometry(), lantern = new THREE.BoxGeometry(0.17, 0.22, 0.17); lantern.translate(sN.x - 0.5, sN.rise + 0.74, 0);
  return { geometry: g, lantern, bow: new THREE.Vector3(sN.x - 0.5, sN.rise + 0.74, 0) };
}

function buildJetty(tint, len) {
  const b = builder(tint), plank = '#7d5a38', plank2 = '#6c4d30', post = '#3d2c20';
  // x along the jetty (0 = the land end), z across; the deck is 2.2 m wide, planks 0.5 m
  for (let x = 0, k = 0; x < len - 1e-6; x += 0.5, k++) b.box(x, -0.1, -1.1, Math.min(len, x + 0.48), 0.05, 1.1, k % 2 ? plank : plank2);
  for (const z of [-1.0, 1.0]) for (let x = 0.4; x <= len; x += 2.2) { b.box(x - 0.1, -1.7, z - 0.1, x + 0.1, 0.5, z + 0.1, post); }
  for (const z of [-1.0, 1.0]) b.box(0, 0.42, z - 0.04, len, 0.5, z + 0.04, post);                                      // hand rails
  b.box(0, -0.2, -1.2, len, -0.1, 1.2, '#4a3524');
  return b.geometry();
}

export function createCruise(game, session, { count }) {
  const man = game.manifest, lake = man.lake, ctx = game.ctx;
  const inLake = (x, y) => { let c = false; for (let i = 0, j = lake.length - 1; i < lake.length; j = i++) { const [xi, yi] = lake[i], [xj, yj] = lake[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  // the shore crossing on our bearing, and which way is out
  const dir = [-Math.cos(PHI), -Math.sin(PHI)], perp = [-dir[1], dir[0]];      // dir points to the lake's centre; perp is to its left
  let S = null; for (let r = 95; r > 40; r -= 0.1) { const x = r * Math.cos(PHI), y = r * Math.sin(PHI); if (inLake(x, y)) { S = [x, y]; break; } }
  if (!S) return null;
  // the walk grid ends a little before the water: the jetty starts on its last walkable cell
  let land = null; for (let t = 0; t < 8; t += 0.25) { const x = S[0] - dir[0] * t, y = S[1] - dir[1] * t; if (game.ground(x, y) !== null) { land = [x, y]; break; } }
  if (!land) return null;
  const deckZ = (game.ground(land[0], land[1]) ?? 0.1) + 0.0;
  const LEN = 10.5, jx0 = land[0] - dir[0] * 0.6, jy0 = land[1] - dir[1] * 0.6;       // the jetty runs from just landward of the last walkable cell out over the water
  const light = game.lightAt(S[0], S[1]) || [0.04, 0.04, 0.05];
  const tint = [Math.min(0.9, light[0] * 3 + 0.2), Math.min(0.9, light[1] * 3 + 0.19), Math.min(0.9, light[2] * 3 + 0.2)];
  const scene = game.scene;

  // jetty
  const jetty = new THREE.Mesh(buildJetty(tint, LEN), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  jetty.position.copy(game.v3(jx0, jy0, deckZ - 0.02)); jetty.rotation.y = Math.atan2(dir[1], dir[0]); jetty.name = 'harbor jetty'; scene.add(jetty);       // local +x runs out along dir: three yaw of Blender heading h about y is +h
  const lampSpot = [jx0 + dir[0] * (LEN - 0.4) + perp[0] * 0.95, jy0 + dir[1] * (LEN - 0.4) + perp[1] * 0.95];
  const lamp = game.props.glow({ x: lampSpot[0], y: lampSpot[1], z: deckZ + 1.35, color: [1.5, 0.9, 0.4], size: 0.8 });
  // a lamp post at the tip
  const postGeo = new THREE.BoxGeometry(0.1, 1.3, 0.1); postGeo.translate(0, 0.65, 0);
  const post = new THREE.Mesh(postGeo, new THREE.MeshBasicMaterial({ color: 0x2b1f17, fog: false })); post.position.copy(game.v3(lampSpot[0], lampSpot[1], deckZ)); scene.add(post);

  // the boat
  const bt = buildBoat(tint), boat = new THREE.Group(); boat.name = 'harbor cruise boat';
  boat.add(new THREE.Mesh(bt.geometry, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })));
  const lanternMesh = new THREE.Mesh(bt.lantern, new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3, 1.1), fog: false })); lanternMesh.position.set(0, 0, 0); boat.add(lanternMesh);
  const glow = game.props.glow({ x: 0, y: 0, z: 0, color: [2, 1.2, 0.5], size: 0.8 });
  scene.add(boat);
  // rest pose: alongside the jetty, towards the tip, bow to the shore
  const alongTip = LEN - 3.2, restX = jx0 + dir[0] * alongTip + perp[0] * 2.45, restY = jy0 + dir[1] * alongTip + perp[1] * 2.45;
  const mooredHead = Math.atan2(-dir[1], -dir[0]);                                       // Blender heading, bow to the shore
  const pose = { x: restX, y: restY, head: mooredHead };

  // the route (Blender frame): out from the jetty, round the Spire once (a gentle spiral outwards), and home again
  const A = [restX + dir[0] * 9 + perp[0] * 2.5, restY + dir[1] * 9 + perp[1] * 2.5];     // clear water off the jetty
  const dA = Math.hypot(A[0], A[1]), phiA = Math.atan2(A[1], A[0]);
  const aIn = Math.acos(R0 / dA), aOut = Math.acos(R1 / dA);
  const thIn = phiA + aIn, thOut = phiA - aOut, sweep = mod(thOut - thIn, Math.PI * 2) + Math.PI * 2;
  const pts = [new THREE.Vector3(restX, 0, -restY), new THREE.Vector3(restX + dir[0] * 4.5 + perp[0] * 0.5, 0, -(restY + dir[1] * 4.5 + perp[1] * 0.5))];
  pts.push(new THREE.Vector3(A[0], 0, -A[1]));
  const nSp = Math.ceil((sweep * 180) / Math.PI / 15);
  for (let i = 0; i <= nSp; i++) { const u = i / nSp, th = thIn + sweep * u, r = R0 + (R1 - R0) * u; pts.push(new THREE.Vector3(r * Math.cos(th), 0, -r * Math.sin(th))); }
  pts.push(new THREE.Vector3(A[0] + perp[0] * 0.0, 0, -A[1]));
  pts.push(new THREE.Vector3(restX + dir[0] * 4.5 + perp[0] * 0.5, 0, -(restY + dir[1] * 4.5 + perp[1] * 0.5)));
  pts.push(new THREE.Vector3(restX, 0, -restY));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const LCURVE = curve.getLength(), samples = curve.getSpacedPoints(Math.ceil(LCURVE / 1.5));
  // the legs share their first and last 9 m: keep the spiral's outward drift from crossing the outbound leg
  const _p = new THREE.Vector3(), _t = new THREE.Vector3();
  const at = (s, p, t) => { const u = Math.min(1, Math.max(0, s / LCURVE)); curve.getPointAt(u, p); curve.getTangentAt(u, t); };

  const _boatPos = new THREE.Vector3(), seatV = new THREE.Vector3();
  let run = null, clockT = 0;
  function place(headBlender, x, y, time, k) {              // k: 0 at rest ... 1 under way (scales the bob and roll)
    const calm = game.reduceMotion ? 0 : 1;
    const bob = Math.sin(time * 1.3) * 0.035 * calm, roll = Math.sin(time * 0.9 + 1) * (0.02 + 0.012 * k) * calm, pitch = Math.sin(time * 1.1) * 0.018 * calm;
    boat.position.set(x, WATER + 0.12 + bob, -y); boat.rotation.set(roll, headBlender, pitch, 'YXZ');
    boat.updateMatrixWorld(true);
    lanternMesh.position.copy(bt.bow); glow.sprite.position.copy(boat.localToWorld(_boatPos.copy(bt.bow)));
  }
  place(pose.head, pose.x, pose.y, 0, 0);

  const phaseText = (r, rr) => { if (rr < 38) r.circled = true; return r.s < 20 ? 'leaving the jetty' : rr < 38 ? 'circling the Spire' : r.circled ? 'heading home' : 'crossing Stillwater'; };
  function frame(dt, cp) {
    const r = run, w = ctx.getWater && ctx.getWater(), time = game.uTime.value;
    const remain = LCURVE - r.s, v = SPEED * Math.min(1, 0.22 + Math.min(r.s, remain) / 14);        // easing off at both ends
    r.s = Math.min(LCURVE, r.s + v * dt); r.v = v;
    at(r.s, _p, _t);
    let head = Math.atan2(-_t.z, _t.x);                         // Blender heading of the path (three z = -y)
    // at the start the boat leaves with its bow to the shore and swings the bow out over its outboard side; at the end the path itself brings it in bow to shore
    if (r.s < 14) { const delta = mod(mooredHead - head, Math.PI * 2); head = mooredHead - delta * smooth((r.s - 1.5) / 11); }
    place(head, _p.x, -_p.z, time, 1);
    // the visitor's seat
    boat.localToWorld(cp.pos.set(SEAT[0], SEAT[1], SEAT[2]));
    cp.yaw = head - Math.PI / 2; cp.pitch = -0.03;
    // water: the hull pushes it aside, as the lantern punt does
    if (w && w.sim && w.sim.on) { const c = Math.cos(-head), s = Math.sin(-head); for (const [f, amp, rr] of [[2.4, -0.11, 0.8], [1.0, -0.06, 0.95], [-0.8, -0.04, 0.95], [-2.4, 0.04, 0.75]]) w.sim.events.push({ x: _p.x + c * f, z: _p.z + s * f, amp: amp * v * 0.6, r: rr, cont: true }); }
    const txt = phaseText(r, Math.hypot(_p.x, _p.z)); if (txt !== r.txt) { r.txt = txt; game.track('rides', 'Harbor cruise: ' + txt, { order: 1 }); }
    if (r.s >= LCURVE - 0.01) session.end('done');
  }
  function exit() {
    const x = land[0] - dir[0] * 0.8, y = land[1] - dir[1] * 0.8, yaw = Math.atan2(dir[1], dir[0]);
    return { x, y, z: deckZ, yaw, pos: new THREE.Vector3(x, deckZ + 1.68, -y), cyaw: Math.atan2(-Math.cos(yaw), Math.sin(yaw)), cpitch: -0.05 };
  }
  function begin() {
    if (session.active || run) return;
    run = { s: 0, v: 0, txt: '' };
    const def = { id: 'cruise', name: 'the harbor cruise', leave: 'Return to the jetty', look: { yaw: 2.4, pitch: 0.8 }, sway: 0.4, blendIn: 1.1, blendOut: 1.0, frame, exit,
      onEnd(why) { game.track('rides', null); run = null; at(0, _p, _t); place(pose.head, pose.x, pose.y, game.uTime.value, 0); } };
    if (!session.start(def)) { run = null; return; }
    count('cruise'); game.emit('rides:board', { ride: 'cruise' });
    game.toast('Take a seat under the canopy. The cruise takes about two and a half minutes.', { ms: 4200 });
  }
  // at rest the boat rocks gently on the water
  game.on('frame', () => { if (run) return; const near = Math.hypot(game.camera.position.x - pose.x, game.camera.position.z + pose.y) < 220; boat.visible = near; glow.sprite.visible = near && true; lamp.sprite.visible = near; if (near) place(pose.head, pose.x, pose.y, game.uTime.value, 0); });
  const it = game.interact({ id: 'rides:cruise', x: land[0], y: land[1], z: deckZ, r: 3.4, label: 'Take the harbor cruise', show: () => !game.cameraHeld && !run, use: begin });
  return { board: { x: land[0], y: land[1], z: deckZ }, jetty, boat, begin, length: LCURVE, get run() { return run; }, path: () => samples };
}
