// The Pavilion of Wings: a dozen riders on the carousel's horses, locked to its turn and its rise and fall, and a prompt to ride one for a minute.
// The carousel itself is moved by a vertex shader (fx/animate.js: CAROUSEL, CAROUSEL_MOTION, carouselHorse); the riders are an InstancedMesh whose
// matrices are rebuilt each frame from the same clock (uTime) and parameters, so they cannot drift from the horses.
import * as THREE from 'three';
import { CAROUSEL, CAROUSEL_MOTION, horseAngleDeg } from '../../animate.js';
import { buildFigure, figureMaterial, COATS } from './figure.js';

const SADDLE = 2.62;                // height of the seat above the ground, at the top of a horse's back (measured from the baked mesh; deck at 0.5)
const BACK = 0.12;                   // the rider sits this far behind the horse's middle (the saddle is aft of the shoulders)
const OUTER_R = 8.15, INNER_R = 6.25;
const FACE = -1;                     // the horses face decreasing shader angle (anticlockwise in the Blender frame), which is the way the carousel turns
const RIDE_S = 60;

export function createCarousel(game, session, { count }) {
  const fx = () => game.ctx.getFx().animated;                     // { uniforms: { uFxTime, uFxMotion } } once the carousel has been made to move
  // which horses carry a rider: ring, index (the shader's k), radius
  const seats = [];
  for (const k of [1, 3, 5, 7, 9, 11, 13, 15]) seats.push({ ring: 'outer', k, r: OUTER_R });
  for (const n of [1, 4, 7, 10]) seats.push({ ring: 'inner', k: n + 0.5, r: INNER_R });
  const freeOuter = [0, 2, 4, 6, 8, 10, 12, 14].map((k) => ({ ring: 'outer', k, r: OUTER_R }));
  const N = seats.length;
  const geo = buildFigure(0), mat = figureMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, N); mesh.frustumCulled = false; mesh.visible = false; mesh.name = 'carousel riders';
  const aVar = new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2); geo.setAttribute('aVar', aVar);
  const tint = new THREE.Color(0.62, 0.55, 0.5), col = new THREE.Color(), scales = [];
  for (let i = 0; i < N; i++) {
    col.set(COATS[(i * 3 + 1) % COATS.length]).multiply(tint); mesh.setColorAt(i, col);
    const h = (Math.sin(i * 12.9898) * 43758.5453) % 1, hh = Math.abs(h);
    aVar.setXY(i, (0.55 + 0.7 * hh) * tint.r, (0.35 + 1.5 * Math.abs((Math.sin(i * 78.233) * 12345.6789) % 1)) * tint.r);
    scales.push(i % 4 === 3 ? 0.72 : 1);               // a few children
  }
  mesh.instanceColor.needsUpdate = true; aVar.needsUpdate = true;
  game.scene.add(mesh);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const cam = game.camera;

  // where the horse is now (three.js x, y, z) and the way it faces (yaw about y for a figure that faces +x)
  function horse(s, time, motion, out) {
    const a = -(horseAngleDeg(s.ring, s.k) * Math.PI) / 180 + time * CAROUSEL_MOTION.spin * motion;
    out.p.set(CAROUSEL.x + s.r * Math.cos(a) - FACE * BACK * Math.sin(a), SADDLE + CAROUSEL_MOTION.bob * Math.sin(time * CAROUSEL_MOTION.rate + s.k * CAROUSEL_MOTION.phase) * motion, CAROUSEL.z + s.r * Math.sin(a) + FACE * BACK * Math.cos(a));
    out.yaw = Math.atan2(-FACE * Math.cos(a), -FACE * Math.sin(a));       // forward = FACE * (-sin a, cos a) in (x, z)
    return out;
  }
  const H = { p: new THREE.Vector3(), yaw: 0 };
  let near = false;
  function update() {
    const f = fx(); if (!f) { mesh.visible = false; return; }
    const d = Math.hypot(cam.position.x - CAROUSEL.x, cam.position.z - CAROUSEL.z);
    near = d < 240; mesh.visible = near; if (!near) return;
    const time = f.uniforms.uFxTime.value, motion = f.uniforms.uFxMotion.value;
    for (let i = 0; i < N; i++) {
      horse(seats[i], time, motion, H);
      q.setFromAxisAngle(up, H.yaw); sc.setScalar(scales[i]);
      mesh.setMatrixAt(i, M.compose(H.p, q, sc));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  game.on('frame', update);

  // ride a horse for a minute: the nearest empty horse, looking the way it travels
  const board = { x: CAROUSEL.x + 9.4 * Math.cos(-0.73), y: -(CAROUSEL.z + 9.4 * Math.sin(-0.73)) };   // three (x, z) -> Blender (x, -z); the side facing Rosewick's centre
  let run = null;
  const eyeP = new THREE.Vector3();
  function begin() {
    if (session.active || !fx()) return;
    const me = game.player, from = { x: me.x, y: me.y, yaw: me.yaw, z: me.z };
    // pick the empty horse nearest the visitor
    const f = fx(), time = f.uniforms.uFxTime.value, motion = f.uniforms.uFxMotion.value;
    let best = null, bd = 1e9; for (const s of freeOuter) { horse(s, time, motion, H); const d = Math.hypot(H.p.x - me.x, H.p.z + me.y); if (d < bd) { bd = d; best = s; } }
    run = { seat: best, t0: time, left: -1 };
    const def = {
      id: 'carousel', name: 'the carousel', leave: 'Get off the carousel', look: { yaw: 2.2, pitch: 0.8 }, sway: 0.5, blendIn: 1.0, blendOut: 0.9,
      frame(dt, pose) {
        const ff = fx(); if (!ff) { session.end('button'); return; }
        const tm = ff.uniforms.uFxTime.value, mo = ff.uniforms.uFxMotion.value;
        horse(run.seat, tm, mo, H);
        pose.pos.copy(H.p); pose.pos.y += 0.95; pose.yaw = H.yaw - Math.PI / 2; pose.pitch = -0.08;
        // sit a little forward of the saddle's middle, not inside the rider-less horse's neck: the camera looks along the travel direction
        pose.pos.x += Math.cos(H.yaw) * 0.0; pose.pos.z -= Math.sin(H.yaw) * 0.0;
        const left = Math.max(0, Math.ceil(RIDE_S - (performance.now() - run.start) / 1000));
        if (left !== run.left) { run.left = left; game.track('rides', `Pavilion of Wings: ${left} s left`, { order: 1 }); }
        if (left <= 0) session.end('done');
      },
      exit: () => ({ x: from.x, y: from.y, z: from.z, yaw: from.yaw, pos: eyeP.set(from.x, from.z + 1.68, -from.y), cyaw: Math.atan2(-Math.cos(from.yaw), Math.sin(from.yaw)), cpitch: 0 }),
      onEnd() { game.track('rides', null); run = null; },
    };
    if (!session.start(def)) { run = null; return; }
    run.start = performance.now();
    count('carousel'); game.emit('rides:board', { ride: 'carousel' });
  }
  const it = game.interact({ id: 'rides:carousel', x: board.x, y: board.y, z: 0.7, r: 5.2, label: 'Ride the carousel', show: () => !game.cameraHeld && !!fx(), use: begin });
  return { mesh, seats, horse: (i, time, motion) => horse(seats[i], time, motion, { p: new THREE.Vector3(), yaw: 0 }), board, begin };
}
