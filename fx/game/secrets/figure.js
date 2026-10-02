// A simple low-poly standing figure for the secrets (the guest in the red coat, the shape in the keep window).
// Proportions follow the park's guests (fx/guests/assets.js: a 1.72 m adult, hips 0.95 m, shoulders 1.40 m, head centre 1.58 m),
// flat-shaded: every face has its own vertices and one colour. Three.js axes, y up, front = +z, feet at y = 0.
// pal: { coat, hat (or null), skin, trousers, shoes, long } linear rgb; the colour is baked into vertex colours.
// A flat-shaded part builder: add(geometry, rgb, x, y, z, {rx, ry, rz, sx, sy, sz}) bakes a face colour into vertex colours; finish() gives one geometry.
export function partsBuilder(THREE) {
  const pos = [], col = [], LIGHT = new THREE.Vector3(0.35, 0.8, 0.5).normalize();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const add = (geo, rgb, x, y, z, { rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) => {
    const g = geo.index ? geo.toNonIndexed() : geo; q.setFromEuler(e.set(rx, ry, rz)); m.compose(p.set(x, y, z), q, s.set(sx, sy, sz)); g.applyMatrix4(m);
    const P = g.attributes.position;
    for (let i = 0; i + 2 < P.count; i += 3) {
      a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();           // per-face shade, like the guests' derivative normals
      const k = 0.5 + 0.5 * Math.max(0, n.dot(LIGHT)) - 0.12 * Math.max(0, -n.y);
      for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); col.push(rgb[0] * k, rgb[1] * k, rgb[2] * k); }
    }
    geo.dispose();
  };
  const finish = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); return g; };
  return { add, finish };
}
export function buildFigure(THREE, pal) {
  const { add, finish } = partsBuilder(THREE);
  const cyl = (rt, rb, h, sides) => new THREE.CylinderGeometry(rt, rb, h, sides, 1, false);
  const long = pal.long !== false;
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.1, 0.08, 0.25), pal.shoes, sx * 0.097, 0.04, 0.03);                            // shoes
    add(cyl(0.055, 0.062, 0.5, 6), pal.trousers, sx * 0.095, 0.3, 0);                                           // legs
  }
  // the coat: skirt to the shins (long) or the hips, chest, collar
  add(cyl(0.19, long ? 0.33 : 0.25, long ? 0.78 : 0.4, 8), pal.coat, 0, long ? 0.74 : 0.82, 0);
  add(cyl(0.17, 0.2, 0.46, 8), pal.coat, 0, 1.17, 0, { sz: 0.8 });
  add(new THREE.BoxGeometry(0.5, 0.12, 0.21), pal.coat, 0, 1.4, 0);                                              // shoulders
  add(cyl(0.12, 0.15, 0.1, 8), pal.coat, 0, 1.5, 0);                                                            // collar
  for (const sx of [-1, 1]) {
    add(cyl(0.05, 0.06, 0.56, 6), pal.coat, sx * 0.265, 1.12, 0.01, { rz: sx * 0.07 });                          // arms
    add(new THREE.IcosahedronGeometry(0.05, 0), pal.skin, sx * 0.29, 0.8, 0.02);                                // hands
  }
  add(new THREE.IcosahedronGeometry(0.115, 1), pal.skin, 0, 1.6, 0.0, { sy: 1.1 });                              // head
  if (pal.hat) {
    add(cyl(0.22, 0.22, 0.02, 10), pal.hat, 0, 1.67, 0);                                                         // brim
    add(cyl(0.095, 0.125, 0.15, 8), pal.hat, 0, 1.75, 0);                                                        // crown
    add(cyl(0.128, 0.128, 0.03, 8), pal.coat, 0, 1.69, 0);                                                       // band
  }
  return finish();
}
export const RED_COAT = { coat: [0.6, 0.025, 0.035], hat: [0.4, 0.02, 0.03], skin: [0.45, 0.3, 0.23], trousers: [0.05, 0.04, 0.05], shoes: [0.03, 0.02, 0.02], long: true };
export const SHADOW = { coat: [0.008, 0.008, 0.012], hat: null, skin: [0.01, 0.01, 0.014], trousers: [0.008, 0.008, 0.012], shoes: [0.008, 0.008, 0.012], long: true };
