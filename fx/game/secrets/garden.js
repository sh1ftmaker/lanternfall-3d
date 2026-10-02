// 5. The rooftop garden. On the flat roof of the Neon Arcade in Meridian (z = 6.1, not on the walk grid): a few planters, a bench, a lantern and
// a cat. Only Wick can get there: run at the arcade's east wall from about 28 m away and triple-jump (tools/game/secrets.test.mjs does exactly that).
// Arriving on the roof finds it.
import { partsBuilder } from './figure.js';

const C = [80.6, 118.2], Z = 6.1; // the garden's centre on the roof
const R = 5.5;

export function init(S) {
  const { game, THREE } = S;
  const root = new THREE.Group(); game.v3(C[0], C[1], Z, root.position); game.scene.add(root);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.62, 0.66, 0.78), fog: false });
  const mk = (b, x, z, ry = 0) => { const m = new THREE.Mesh(b.finish(), mat); m.position.set(x, 0, -z); m.rotation.y = ry; root.add(m); return m; };   // x, z in the garden's frame: three axes, y up
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl = (a, b, h, n) => new THREE.CylinderGeometry(a, b, h, n);
  const wood = [0.34, 0.18, 0.09], dark = [0.1, 0.08, 0.07], leaf = [0.1, 0.34, 0.12], leaf2 = [0.16, 0.42, 0.14], bloom = [[0.9, 0.2, 0.35], [0.95, 0.6, 0.15], [0.8, 0.75, 0.9]];

  // planters: long boxes of soil, bushes, a few blooms
  { const b = partsBuilder(THREE);
    for (const [px, pz, ry, n] of [[-2.1, 0.6, 0.3, 3], [-0.2, 1.6, 0.05, 2], [2.2, 0.8, -0.35, 3]]) {
      const c = Math.cos(ry), s = Math.sin(ry);
      b.add(box(1.5, 0.5, 0.55), wood, px, 0.25, pz, { ry: -ry });
      b.add(box(1.38, 0.06, 0.43), dark, px, 0.52, pz, { ry: -ry });
      for (let i = 0; i < n; i++) { const o = (i - (n - 1) / 2) * 0.46; b.add(new THREE.IcosahedronGeometry(0.27 + 0.04 * ((i * 7) % 3), 0), i % 2 ? leaf2 : leaf, px + o * c, 0.74, pz - o * s, { sy: 0.9 }); }
      for (let i = 0; i < n + 1; i++) { const o = (i - n / 2) * 0.4 + 0.06; b.add(new THREE.IcosahedronGeometry(0.075, 0), bloom[(i + n) % 3], px + o * c, 1.0 + 0.04 * (i % 2), pz - o * s + 0.07, {}); }
    }
    mk(b, 0, 0); }
  // the bench: seat, back, legs, set back from the planters
  { const b = partsBuilder(THREE);
    b.add(box(1.7, 0.07, 0.48), wood, 0, 0.5, 0); b.add(box(1.7, 0.4, 0.06), wood, 0, 0.8, -0.22, { rx: -0.12 });
    for (const sx of [-0.75, 0.75]) { b.add(box(0.07, 0.5, 0.42), dark, sx, 0.25, 0); b.add(box(0.07, 0.34, 0.06), dark, sx, 0.78, -0.21); }
    const m = mk(b, -0.4, -1.6, 0.2); m.name = 'bench'; }
  // the lantern: a post with a paper lantern on a hook, glowing
  { const b = partsBuilder(THREE);
    b.add(cyl(0.035, 0.05, 1.7, 6), dark, 0, 0.85, 0); b.add(box(0.5, 0.03, 0.03), dark, 0.2, 1.62, 0);
    b.add(cyl(0.12, 0.12, 0.28, 8), [1.6, 0.95, 0.45], 0.42, 1.44, 0); b.add(cyl(0.06, 0.12, 0.05, 8), dark, 0.42, 1.62, 0);
    mk(b, 1.5, -1.5); }
  // the cat: sitting on the bench's end, tail curled
  const cat = new THREE.Group(); cat.position.set(0.35, 0.53, 1.6); root.add(cat);
  { const b = partsBuilder(THREE), fur = [0.75, 0.38, 0.1], white = [0.8, 0.78, 0.74];
    b.add(new THREE.IcosahedronGeometry(0.16, 0), fur, 0, 0.14, 0, { sy: 1.15, sz: 1.25 }); b.add(new THREE.IcosahedronGeometry(0.1, 0), fur, 0, 0.3, 0.1);
    b.add(new THREE.IcosahedronGeometry(0.075, 0), white, 0, 0.3, 0.2, { sz: 0.8 });                                  // muzzle
    b.add(new THREE.ConeGeometry(0.035, 0.09, 4), fur, -0.05, 0.4, 0.09); b.add(new THREE.ConeGeometry(0.035, 0.09, 4), fur, 0.05, 0.4, 0.09);
    for (const sx of [-1, 1]) b.add(box(0.05, 0.1, 0.06), white, sx * 0.07, 0.04, 0.12);                                // front paws
    const m = new THREE.Mesh(b.finish(), mat); cat.add(m);
    const tb = partsBuilder(THREE); tb.add(cyl(0.025, 0.03, 0.3, 5), fur, 0, 0.15, 0, { rz: 0 }); const tail = new THREE.Mesh(tb.finish(), mat); tail.position.set(0.1, 0.04, -0.1); tail.rotation.z = -0.9; cat.add(tail); cat.userData.tail = tail; }
  cat.rotation.y = 0.5;
  // faces: the whole garden sits turned toward the plaza
  root.rotation.y = 0.35;
  const glow = game.props.glow({ x: C[0] + 1.5, y: C[1] - 1.5, z: Z + 1.75, color: [1.0, 0.6, 0.28], size: 3.2 });
  const warm = game.props.glow({ x: C[0] + 1.5, y: C[1] - 1.5, z: Z + 2.6, color: [0.3, 0.18, 0.09], size: 5 });
  let t = 0;
  game.on('frame', ({ dt }) => {
    t += dt; const tail = cat.userData.tail; if (tail && !game.reduceMotion) tail.rotation.z = -0.9 + 0.25 * Math.sin(t * 1.6);
    glow.sprite.material.opacity = 0.8 + 0.2 * Math.sin(t * 2.3) * Math.sin(t * 0.7);
    if (S.isFound('garden')) return;
    const p = game.player;
    if (p.mode === 'walk' && p.wick && Math.hypot(p.x - C[0], p.y - C[1]) < R && Math.abs(p.z - Z) < 1.4) S.found('garden');
  });
  return { centre: [C[0], C[1], Z], root };
}
