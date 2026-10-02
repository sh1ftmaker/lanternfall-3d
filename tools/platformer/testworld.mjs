// A small synthetic level for testing the movement library in Node (tools/platformer/sim-lab.mjs): flat ground, a
// 1.2 m block (ledge grab), a tall wall (wall kicks), a pool 3.2 m deep below the -0.8 m water line (swimming),
// stairs, a 30 degree ramp and an ice patch. Units: library units (cm), three.js axes (x east, y up, z south).
export const S = 100;   // units per metre
export function builder() {
  const out = [];
  // triangle (a, b, c) wound counter-clockwise seen from the side it faces (three.js / library convention)
  const tri = (a, b, c, type = 0, terrain = 1) => out.push([type, terrain, ...a, ...b, ...c].map(Math.round));
  // quad a b c d counter-clockwise seen from the front; split into two triangles; long quads are subdivided
  const quad = (a, b, c, d, type, terrain, step = 500) => {
    const L = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const nu = Math.max(1, Math.ceil(L(a, b) / step)), nv = Math.max(1, Math.ceil(L(a, d) / step));
    const P = (u, v) => [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u + (d[k] - a[k]) * v + (c[k] - b[k] - d[k] + a[k]) * u * v);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const p00 = P(i / nu, j / nv), p10 = P((i + 1) / nu, j / nv), p11 = P((i + 1) / nu, (j + 1) / nv), p01 = P(i / nu, (j + 1) / nv);
      tri(p00, p10, p11, type, terrain); tri(p00, p11, p01, type, terrain);
    }
  };
  // axis-aligned box, faces outward
  const box = (x0, y0, z0, x1, y1, z1, type = 0, terrain = 1) => {
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], type, terrain);         // top (+y)
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], type, terrain);         // bottom
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], type, terrain);         // +z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], type, terrain);         // -z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], type, terrain);         // +x
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], type, terrain);         // -x
  };
  const pack = () => { const a = new Int32Array(out.length * 11); out.forEach((t, i) => { a[i * 11] = (t[0] & 0xffff) | (0 << 16); a[i * 11 + 1] = t[1]; for (let k = 0; k < 9; k++) a[i * 11 + 2 + k] = t[2 + k]; }); return a; };
  return { tri, quad, box, out, pack };
}

export function testLevel() {
  const B = builder(), m = S;
  // ground: 80 x 80 m at y = 0, with a 12 x 12 m pool cut out at x in [20, 32], z in [-6, 6]
  const G = 40 * m, P = { x0: 20 * m, x1: 32 * m, z0: -6 * m, z1: 6 * m, bed: -4 * m, water: -0.8 * m };
  const ground = (x0, z0, x1, z1) => B.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]);
  ground(-G, -G, P.x0, G); ground(P.x1, -G, G, G); ground(P.x0, -G, P.x1, P.z0); ground(P.x0, P.z1, P.x1, G);
  // pool: bed and inward-facing walls
  B.quad([P.x0, P.bed, P.z1], [P.x1, P.bed, P.z1], [P.x1, P.bed, P.z0], [P.x0, P.bed, P.z0]);
  B.quad([P.x0, P.bed, P.z0], [P.x1, P.bed, P.z0], [P.x1, 0, P.z0], [P.x0, 0, P.z0]);          // north wall faces +z (into the pool)
  B.quad([P.x1, P.bed, P.z1], [P.x0, P.bed, P.z1], [P.x0, 0, P.z1], [P.x1, 0, P.z1]);          // south wall faces -z
  B.quad([P.x0, P.bed, P.z1], [P.x0, P.bed, P.z0], [P.x0, 0, P.z0], [P.x0, 0, P.z1]);          // west wall faces +x
  B.quad([P.x1, P.bed, P.z0], [P.x1, P.bed, P.z1], [P.x1, 0, P.z1], [P.x1, 0, P.z0]);          // east wall faces -x
  // a 1.2 m block (ledge grab / climb) at x 8..12, z -2..2
  B.box(8 * m, 0, -2 * m, 12 * m, 1.2 * m, 2 * m);
  // a 2.4 m block (too tall to jump onto: ledge grab) at x 14..18, z -2..2
  B.box(14 * m, 0, -2 * m, 18 * m, 3 * m, 2 * m);
  // a 14 m tower to run off (fall damage: hard landing) at x -38..-34, z -38..-34; tests start on top
  B.box(-38 * m, 0, -38 * m, -34 * m, 14 * m, -34 * m);
  // a tall wall for wall kicks: x -10..10, z -15.5..-15, 8 m high, plus a facing wall 4 m away (z -11.5..-11) 6 m high
  B.box(-10 * m, 0, -15.5 * m, 10 * m, 8 * m, -15 * m);
  B.box(-10 * m, 0, -11.5 * m, 10 * m, 6 * m, -11 * m);
  // stairs up to 2.4 m: 12 steps of 0.2 x 0.4 m at x -20..-16, going south (+z) from z = 5
  for (let k = 0; k < 12; k++) B.box(-20 * m, 0, (5 + k * 0.4) * m, -16 * m, (k + 1) * 0.2 * m, (5 + (k + 1) * 0.4) * m);
  // 30 degree ramp at x -30..-26 from z = 5 rising south to 3 m, with a top landing
  const rl = 3 / Math.tan(Math.PI / 6);
  B.quad([-26 * m, 0, 5 * m], [-30 * m, 0, 5 * m], [-30 * m, 3 * m, (5 + rl) * m], [-26 * m, 3 * m, (5 + rl) * m]);
  B.quad([-30 * m, 3 * m, (5 + rl + 3) * m], [-26 * m, 3 * m, (5 + rl + 3) * m], [-26 * m, 3 * m, (5 + rl) * m], [-30 * m, 3 * m, (5 + rl) * m]);
  // ice patch (SURFACE_ICE 0x2E) raised 1 cm at x -12..-2, z 20..30
  B.quad([-12 * m, 1, 30 * m], [-2 * m, 1, 30 * m], [-2 * m, 1, 20 * m], [-12 * m, 1, 20 * m], 0x2E, 1);
  // a 6 m roof-like box to fall from: x 36..39, z -20..-17
  B.box(36 * m, 0, -20 * m, 39 * m, 6 * m, -17 * m);
  return { packed: B.pack(), count: B.out.length, pool: P };
}
