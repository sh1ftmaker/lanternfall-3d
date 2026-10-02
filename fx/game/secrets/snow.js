// 3. Snow-only: the footprints. While it snows, a trail of small footprints fades in on the Moonlit Promenade at Rosewick and leads off the
// paving to something half-buried at the pond's edge: a snow-dusted music box with a glow. Use it at the end of the trail to find it.
// In other weather the trail and the box are absent.
import { partsBuilder } from './figure.js';

const LAND = 'rosewick';
const START = [-2.5, -55.5], END = [-12.9, -61.7];               // land-local: from the fountain axis west to the pond's rim
const STEP = 0.62, SIDE = 0.1;

export function init(S) {
  const { game, lib, THREE } = S;
  /* the trail: alternating left and right prints along a gentle meander */
  const dx = END[0] - START[0], dy = END[1] - START[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const pts = []; const n = Math.floor(len / STEP);
  const centre = (t) => { const m = Math.sin(t * Math.PI * 2) * (1 - 0.3 * t); return [START[0] + dx * t + px * m, START[1] + dy * t + py * m]; };
  for (let i = 0; i <= n; i++) {
    const t = i / n, c = centre(t), c2 = centre(Math.min(1, t + 0.02)), c1 = centre(Math.max(0, t - 0.02)), side = (i % 2 ? 1 : -1) * SIDE;
    const hx = c2[0] - c1[0], hy = c2[1] - c1[1], hl = Math.hypot(hx, hy) || 1;
    const w = lib.world(LAND, c[0] - hy / hl * side, c[1] + hx / hl * side), w2 = lib.world(LAND, c[0] + hx / hl, c[1] + hy / hl);
    pts.push({ x: w[0], y: w[1], yaw: Math.atan2(w2[1] - lib.world(LAND, c[0], c[1])[1], w2[0] - lib.world(LAND, c[0], c[1])[0]) });
  }
  const { add, finish } = partsBuilder(THREE), ink = [0.02, 0.025, 0.04];
  const flat = new THREE.Euler(-Math.PI / 2, 0, 0);
  add(new THREE.CircleGeometry(1, 8), ink, 0, 0, 0.045, { rx: -Math.PI / 2, sx: 0.08, sy: 0.15 });        // the sole (CircleGeometry lies in XY: tipped flat, long axis along +z = forward)
  add(new THREE.CircleGeometry(1, 7), ink, 0, 0, -0.13, { rx: -Math.PI / 2, sx: 0.062, sy: 0.056 });         // the heel
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const prints = new THREE.InstancedMesh(finish(), mat, pts.length); prints.frustumCulled = false; prints.renderOrder = 3; prints.visible = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  pts.forEach((p, i) => {
    // the walk grid reports a bench top as ground: a print that lands on one (more than 0.4 m above the paving) moves to the nearest paving beside it
    let gz = game.ground(p.x, p.y);
    if (gz === null || gz > 0.4) {
      let best = null;
      for (let r = 0.3; r <= 2.4 && !best; r += 0.3) for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6, qx = p.x + Math.cos(a) * r, qy = p.y + Math.sin(a) * r, g = game.ground(qx, qy); if (g !== null && g < 0.3 && g > -0.1) { best = [qx, qy, g]; break; } }
      if (best) { p.x = best[0]; p.y = best[1]; gz = best[2]; } else gz = 0.12;
    }
    p.z = gz + 0.04;
    q.setFromAxisAngle(up, Math.atan2(Math.cos(p.yaw), -Math.sin(p.yaw)));
    m4.compose(game.v3(p.x, p.y, p.z, v), q, one); prints.setMatrixAt(i, m4);
  });
  prints.instanceMatrix.needsUpdate = true; game.scene.add(prints);

  /* the music box, half-buried: a wooden case with its lid up a little, snow banked over it, a warm glow */
  const bw = lib.world(LAND, END[0] - 0.5, END[1] - 0.3), bz = (game.ground(bw[0], bw[1]) ?? 0.12);
  const L = game.lightAt(bw[0], bw[1]), k = L ? Math.max(0.5, Math.min(1.6, (L[0] + L[1] + L[2]) / 1.2 + 0.4)) : 0.8;
  const bb = partsBuilder(THREE), wood = [0.3 * k, 0.12 * k, 0.06 * k], brass = [0.7 * k, 0.5 * k, 0.12 * k], snow = [0.7 * k, 0.78 * k, 0.95 * k];
  bb.add(new THREE.BoxGeometry(0.36, 0.17, 0.25), wood, 0, 0.05, 0);                                            // the case
  bb.add(new THREE.BoxGeometry(0.38, 0.03, 0.27), brass, 0, 0.145, 0);                                          // brass edging
  bb.add(new THREE.BoxGeometry(0.36, 0.03, 0.25), wood, 0.0, 0.26, -0.1, { rx: -0.8 });                          // the lid, propped open
  bb.add(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 5), brass, 0.2, 0.1, 0.0, { rz: Math.PI / 2 });         // the crank
  bb.add(new THREE.IcosahedronGeometry(0.3, 0), snow, -0.08, -0.02, 0.07, { sy: 0.5, sx: 1.25 });               // the bank of snow over one side
  bb.add(new THREE.IcosahedronGeometry(0.1, 0), snow, 0.14, 0.2, 0.04, { sy: 0.5 });                             // snow on the lid
  const box = new THREE.Mesh(bb.finish(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })); box.rotation.set(0.12, 0.5, -0.1); box.scale.setScalar(1.4); box.visible = false; game.v3(bw[0], bw[1], bz - 0.04, box.position); game.scene.add(box);
  const glow = game.props.glow({ x: bw[0], y: bw[1], z: bz + 0.55, color: [0.9, 0.55, 0.22], size: 1.1 }); glow.sprite.visible = false;
  const it = game.interact({
    id: 'secrets-musicbox', x: bw[0], y: bw[1], z: bz + 0.15, r: 1.9, label: 'Open the music box', show: () => box.visible && !game.cameraHeld,
    use() { game.toast('A thin little tune, a long way off.', { ms: 3500 }); S.found('snow'); },
  });
  let vis = 0, t = 0;
  game.on('frame', ({ dt }) => {
    const w = game.weather, on = w && w.state === 'snow' && (!w.now || w.now.snow > 0.3);
    vis += ((on ? 1 : 0) - vis) * Math.min(1, dt * 1.6); if (!on && vis < 0.03) vis = 0;
    const show = vis > 0; prints.visible = show; box.visible = show && vis > 0.5; glow.sprite.visible = box.visible;
    if (!show) { t = 0; return; }
    t += dt; mat.opacity = Math.min(1, vis) * Math.min(1, t / 3) * 0.78;
    glow.sprite.material.opacity = 0.65 + 0.35 * Math.sin(t * 1.7);
  });
  return { pts, box, it, get visible() { return prints.visible; }, boxPos: [bw[0], bw[1], bz] };
}
