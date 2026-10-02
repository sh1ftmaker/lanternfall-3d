// fx/game/bounty/art.js: small low-poly props built in code (no assets). Each builder returns a THREE.Group with its
// origin at the base centre, +y up (three.js axes), size in metres. Colours are tinted once by the baked light at the spot.
export function createArt(game) {
  const { THREE: T, scene } = game;
  const G = {};
  const geo = (k, f) => G[k] || (G[k] = f());
  const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new T.BoxGeometry(w, h, d));
  const cyl = (rt, rb, h, s = 10) => geo(`c${rt},${rb},${h},${s}`, () => new T.CylinderGeometry(rt, rb, h, s));
  const sph = (r, s = 12) => geo(`s${r},${s}`, () => new T.SphereGeometry(r, s, Math.max(6, s >> 1)));
  const tor = (r, t, s = 12) => geo(`t${r},${t}`, () => new T.TorusGeometry(r, t, 6, s));

  // a tint from the baked light at a spot (like game.props.mesh), so props sit in the night rather than glow flat
  function tintAt(x, y) {
    const L = game.lightAt(x, y); const k = L ? [L[0] + 0.03, L[1] + 0.034, L[2] + 0.05] : [0.34, 0.28, 0.22];
    return [Math.min(1, k[0] * 2.4), Math.min(1, k[1] * 2.4), Math.min(1, k[2] * 2.4)];
  }
  // One shared vertex-coloured material for every merged prop (one draw call per prop, one material for the day-night code);
  // only parts that need their own colour later (a post's flag) or alpha (the net) are separate meshes.
  const shared = new T.MeshBasicMaterial({ vertexColors: true, fog: false });
  const reg = (m) => { const set = game.props && game.props.materials; if (set && !set.has(m)) { set.add(m); game.emit('prop', { material: m, kind: 'mesh' }); } };
  const unreg = (m) => { const set = game.props && game.props.materials; if (set) set.delete(m); };
  reg(shared);
  const tmpO = new T.Object3D();
  function merge(parts) {
    let nv = 0, ni = 0; for (const p of parts) { nv += p.geometry.attributes.position.count; ni += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count; }
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni), v = new T.Vector3(); let vo = 0, io = 0;
    for (const p of parts) {
      const pa = p.geometry.attributes.position, n = pa.count, ix = p.geometry.index;
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(p.matrix); pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z; col[(vo + i) * 3] = p.color.r; col[(vo + i) * 3 + 1] = p.color.g; col[(vo + i) * 3 + 2] = p.color.b; }
      if (ix) for (let i = 0; i < ix.count; i++) idx[io++] = ix.getX(i) + vo; else for (let i = 0; i < n; i++) idx[io++] = vo + i;
      vo += n;
    }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(col, 3)); g.setIndex(new T.BufferAttribute(idx, 1)); g.computeBoundingSphere(); return g;
  }
  function builder(tint) {
    const g = new T.Group(), mats = [], parts = [];
    const add = (geometry, hex, x = 0, y = 0, z = 0, o = {}) => {
      const c = new T.Color(hex);
      if (!o.glow) { c.r *= tint[0]; c.g *= tint[1]; c.b *= tint[2]; }
      tmpO.position.set(x, y, z); tmpO.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0); if (o.s) tmpO.scale.set(...o.s); else tmpO.scale.set(1, 1, 1); tmpO.updateMatrix();
      if (o.alpha === undefined && !o.sep) { parts.push({ geometry, matrix: tmpO.matrix.clone(), color: c }); return null; }
      const m = new T.MeshBasicMaterial({ color: c, fog: false, transparent: o.alpha !== undefined, opacity: o.alpha ?? 1, side: o.alpha !== undefined ? T.DoubleSide : T.FrontSide, depthWrite: o.alpha === undefined });
      mats.push(m); reg(m);
      const mesh = new T.Mesh(geometry, m); mesh.position.set(x, y, z); mesh.rotation.copy(tmpO.rotation); mesh.scale.copy(tmpO.scale);
      g.add(mesh); return mesh;
    };
    const finish = () => { g.traverse((o) => { o.userData.bounty = 1; }); if (!parts.length) return null; const geo = merge(parts), mesh = new T.Mesh(geo, shared); mesh.userData.bounty = 1; g.add(mesh); return geo; };
    return { g, add, mats, finish };
  }

  const MODELS = {
    // ── things to find ──
    balloon(b, o) {
      const L = o.len || 1.1;
      b.add(cyl(0.006, 0.006, L, 4), 0xd8d0c0, 0, L / 2, 0);
      b.add(sph(0.3), 0xe04040, 0, L + 0.3, 0, { s: [1, 1.2, 1], glow: true });
      b.add(cyl(0.02, 0.06, 0.08, 6), 0xe04040, 0, L - 0.05, 0, { glow: true });
      b.add(box(0.05, 0.03, 0.05), 0xffb0a0, -0.1, L + 0.5, 0.18, { glow: true });
    },
    plank(b) { b.add(box(6.6, 0.06, 0.36), 0x7a5a3a, 0, 0, 0); b.add(box(6.7, 0.03, 0.04), 0xc8a050, 0, 0.035, 0.19); },
    mitten(b) {
      b.add(box(0.14, 0.04, 0.17), 0xd03a3a, 0, 0.03, 0);
      b.add(sph(0.075, 8), 0xd03a3a, 0, 0.04, -0.09, { s: [1, 0.5, 0.9] });
      b.add(box(0.05, 0.035, 0.09), 0xd03a3a, 0.09, 0.03, -0.02, { ry: 0.5 });
      b.add(box(0.15, 0.045, 0.05), 0xf0ead8, 0, 0.032, 0.11);
    },
    crown(b) {
      b.add(cyl(0.12, 0.12, 0.07, 14), 0xe8d9a0, 0, 0.04, 0);
      for (let i = 0; i < 6; i++) { const a = i / 6 * 6.283; b.add(cyl(0, 0.045, 0.1, 4), 0xe8d9a0, Math.cos(a) * 0.115, 0.12, Math.sin(a) * 0.115); }
      b.add(sph(0.025, 6), 0xd04848, 0.12, 0.05, 0);
    },
    sword(b) {
      b.add(box(0.5, 0.012, 0.05), 0xb8bfd0, 0, 0.012, 0);
      b.add(box(0.04, 0.02, 0.18), 0x7a4a2a, -0.2, 0.014, 0);
      b.add(box(0.2, 0.018, 0.035), 0x7a4a2a, -0.31, 0.014, 0, { ry: 0 });
      b.add(cyl(0.012, 0.012, 0.12, 6), 0x4a2a1a, -0.4, 0.016, 0, { rz: 1.5708 });
    },
    ticket(b) {
      b.add(box(0.17, 0.006, 0.075), 0xf0e6c8, 0, 0.004, 0);
      b.add(box(0.03, 0.007, 0.075), 0x40c8b0, 0.05, 0.005, 0, { glow: true });
      b.add(box(0.1, 0.007, 0.012), 0x403828, -0.02, 0.005, 0.02);
    },
    cap(b) {
      b.add(cyl(0.12, 0.13, 0.05, 14), 0xf0f0f4, 0, 0.03, 0);
      b.add(cyl(0.125, 0.125, 0.03, 14), 0x2a3a6a, 0, 0.012, 0);
      b.add(cyl(0.13, 0.13, 0.012, 14), 0x20263a, 0, 0.06, 0, { s: [1, 1, 1] });
      b.add(box(0.14, 0.01, 0.07), 0x20263a, 0.13, 0.025, 0, { ry: 0 });
    },
    tag(b) {
      b.add(box(0.12, 0.012, 0.09), 0xc9985a, 0, 0.008, 0);
      b.add(cyl(0, 0.045, 0.012, 5), 0xc9985a, 0.08, 0.008, 0, { rz: -1.5708 });
      b.add(tor(0.035, 0.004), 0xd04040, -0.07, 0.01, 0, { rx: 1.5708 });
      b.add(box(0.07, 0.014, 0.012), 0x403020, 0, 0.012, 0);
    },
    net(b) {
      b.add(cyl(0.012, 0.012, 1.1, 6), 0x8a5a30, 0, 0.012, 0, { rz: 1.5708 });
      b.add(tor(0.14, 0.008, 14), 0xc8c8d0, 0.6, 0.02, 0, { ry: 1.5708 });
      b.add(cyl(0.14, 0.02, 0.28, 10), 0xe8e4f0, 0.74, 0.02, 0, { rz: 1.5708, alpha: 0.35 });
    },
    postcard(b) {
      b.add(box(0.16, 0.005, 0.11), 0xf2ecd8, 0, 0.004, 0, { ry: 0.3 });
      b.add(box(0.03, 0.006, 0.035), 0xc84a4a, 0.05, 0.005, -0.03, { ry: 0.3 });
      b.add(box(0.07, 0.006, 0.01), 0x3a5a9a, -0.03, 0.005, 0.02, { ry: 0.3 });
    },
    bow(b) {
      b.add(cyl(0.008, 0.008, 0.72, 5), 0x6a3a1a, 0, 0.012, 0, { rz: 1.5708 });
      b.add(cyl(0.0035, 0.0035, 0.7, 4), 0xf4f0e0, 0, 0.026, 0.012, { rz: 1.5708 });
      b.add(box(0.05, 0.03, 0.03), 0x1a1a1a, 0.34, 0.015, 0);
      b.add(box(0.04, 0.012, 0.01), 0xd6c070, -0.33, 0.015, 0);
    },
    letter(b) {
      b.add(box(0.2, 0.012, 0.13), 0xf4eede, 0, 0.008, 0);
      b.add(cyl(0.025, 0.025, 0.012, 8), 0xb02828, 0, 0.016, 0);
    },
    cup(b) {
      b.add(cyl(0.05, 0.04, 0.1, 10), 0xc8a070, 0, 0.05, 0);
      b.add(cyl(0.046, 0.046, 0.005, 10), 0xd8602a, 0, 0.1, 0, { glow: true });
      b.add(tor(0.03, 0.007, 8), 0xc8a070, 0.06, 0.055, 0);
    },
    logbook(b) {
      b.add(box(0.26, 0.045, 0.19), 0x5a3420, 0, 0.025, 0);
      b.add(box(0.24, 0.03, 0.17), 0xeae0c4, 0.005, 0.03, 0);
      b.add(box(0.28, 0.048, 0.02), 0xc8a050, 0, 0.026, -0.1);
    },
    candle(b) {
      b.add(cyl(0.035, 0.04, 0.16, 8), 0xf4ead0, 0, 0.08, 0);
      b.add(cyl(0.0, 0.016, 0.06, 6), 0xffcc66, 0, 0.19, 0, { glow: true });
    },
    boat(b) {
      b.add(box(0.7, 0.2, 2.1), 0x6a4a2a, 0, 0.1, 0);
      b.add(cyl(0, 0.35, 0.6, 4), 0x6a4a2a, 0, 0.1, 1.35, { rx: 1.5708, ry: 0.785, s: [1, 1, 0.4] });
      b.add(box(0.62, 0.02, 1.9), 0xa87a48, 0, 0.21, 0);
      b.add(box(0.74, 0.04, 2.14), 0xd8c8a0, 0, 0.2, 0);
      b.add(cyl(0.012, 0.012, 1.2, 5), 0x3a2a1a, 0, 0.8, 0.5);
      b.add(sph(0.06, 6), 0xffc060, 0, 1.4, 0.5, { glow: true });
    },
    post(b, o) {   // stamp post: wooden pole, brass cap, a flag in the land's colour, a little lantern
      b.add(cyl(0.07, 0.09, 2.2, 8), 0x6a4a2c, 0, 1.1, 0);
      b.add(cyl(0.11, 0.11, 0.1, 10), 0xc8a050, 0, 2.2, 0);
      const flag = b.add(box(0.8, 0.5, 0.02), o.color, 0.46, 1.8, 0, { glow: true, sep: true });
      b.add(box(0.9, 0.05, 0.03), 0xc8a050, 0.46, 2.07, 0);
      b.add(box(0.2, 0.2, 0.2), 0x403828, 0, 0.4, 0);       // the ink pad box at the foot
      b.add(box(0.14, 0.015, 0.14), o.color, 0, 0.505, 0, { glow: true });
      const lamp = b.add(box(0.14, 0.18, 0.14), 0xffd890, -0.2, 2.15, 0, { glow: true });
      return { flag, lamp };
    },
    figure(b, o) { // a person: legs, coat, head, hat
      b.add(box(0.24, 0.8, 0.16), 0x2a2a3a, 0, 0.4, 0);
      b.add(box(0.42, 0.66, 0.24), o.coat, 0, 1.12, 0);
      b.add(sph(0.15, 10), 0xe0b090, 0, 1.64, 0);
      if (o.hat) b.add(cyl(0.0, 0.17, 0.2, 8), o.hat, 0, 1.84, 0);
      if (o.scale) b.g.scale.setScalar(o.scale);
    },
    stool(b) {
      b.add(cyl(0.2, 0.2, 0.05, 8), 0x7a4a2a, 0, 0.45, 0);
      for (let i = 0; i < 3; i++) { const a = i * 2.094; b.add(cyl(0.02, 0.02, 0.45, 5), 0x4a2a1a, Math.cos(a) * 0.14, 0.22, Math.sin(a) * 0.14); }
    },
    tray(b) {
      b.add(box(0.5, 0.05, 0.34), 0x5a3a24, 0, 0.7, 0);
      b.add(cyl(0.025, 0.04, 0.7, 6), 0x3a2a1a, 0, 0.35, 0);
      b.add(box(0.42, 0.012, 0.26), 0xf4eede, 0, 0.73, 0);
    },
  };

  // build(kind, { x, y, z, yaw, scale, color, coat, hat }) -> { g, parts, remove(), visible, near }. `visible` is the module's own
  // show/hide; `near` is set by the distance and mode cull; the prop shows only when both are on.
  function build(kind, o = {}) {
    const b = builder(o.tint || tintAt(o.x, o.y));
    const parts = MODELS[kind](b, o) || {}, geo = b.finish();
    const g = b.g; g.position.set(o.x, o.z ?? 0, -o.y); g.rotation.y = o.yaw || 0; if (o.scale) g.scale.setScalar(o.scale);
    scene.add(g); let vis = true, nr = true;
    return { g, parts, mats: b.mats, kind, remove() { scene.remove(g); if (geo) geo.dispose(); for (const m of b.mats) { unreg(m); m.dispose(); } },
      set visible(v) { vis = !!v; g.visible = vis && nr; }, get visible() { return vis; }, set near(v) { nr = !!v; g.visible = vis && nr; }, get near() { return nr; } };
  }
  return { build, tintAt, models: Object.keys(MODELS) };
}
