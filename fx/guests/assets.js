// Park guests: procedural low-poly figures (no downloaded assets, nothing to license).
//
// One "uber" mesh per level of detail holds every body part, hair style, hat, skirt, coat tail and carried item;
// each instance switches the optional parts on with a bit mask and re-proportions the body in the vertex shader
// (girth, shoulder/hip shape, belly, leg length, head size, overall height). Parts are rigid on a small skeleton of
// 13 bones + 3 "pseudo-bones" for carried things that hang or float (balloon, paper lantern, phone), posed
// procedurally in the vertex shader (fx/guests/render.js). Faceted like the park: every quad has its own vertices
// and the fragment shader derives flat normals from screen-space derivatives.
//
// Character space: x = the figure's left, y = up, z = forward; metres for a 1.72 m reference adult (scaled per guest).
//
// Vertex attributes (all Float32):
//   position  bone-local axis point (relative to the bone's reference pivot, see PIV)
//   aOff      radial offset from that axis (scaled by girth / shape morphs)
//   aInfo     (region, group, boneA, boneB)       region = colour slot, group = optional-part bit (0 = always)
//   aW        (wB, girthW, shapeW, frontW)        wB: weight of boneB (skirts follow the thighs a little)
//             girthW: how much girth widens this vertex; shapeW: +hips / -shoulders for the "shape" morph;
//             frontW: >0 belly push, <0 bust push (forward)

export const BONE = { pelvis: 0, chest: 1, head: 2, uaL: 3, faL: 4, uaR: 5, faR: 6, thL: 7, shL: 8, thR: 9, shR: 10, ftL: 11, ftR: 12, balloon: 13, hang: 14, phone: 15 };
// reference pivots in character space (adult, before morphs)
export const PIV = [
  [0, 0.95, 0], [0, 0.98, 0], [0, 1.47, -0.01],
  [0.185, 1.395, -0.01], [0.205, 1.115, -0.02], [-0.185, 1.395, -0.01], [-0.205, 1.115, -0.02],
  [0.092, 0.90, 0], [0.095, 0.485, 0.01], [-0.092, 0.90, 0], [-0.095, 0.485, 0.01],
  [0.097, 0.075, -0.005], [-0.097, 0.075, -0.005], [0, 0, 0], [0, 0, 0], [0, 0, 0],
];
// colour slots (resolved per guest in the shader)
export const REG = { skin: 0, hair: 1, top: 2, bottom: 3, shoes: 4, accent: 5, inner: 6, legs: 7, wood: 8, glow: 9, balloon: 10, cup: 11, dark: 12, screen: 13, string: 14, forearm: 15, upperarm: 16, thigh: 17, shin: 18, skirt: 19, face: 20 };
// optional parts (bit index in the per-guest mask; 0 = always drawn)
export const GRP = { body: 0, hairCap: 1, hairBob: 2, hairLong: 3, hairBun: 4, hairPony: 5, beanie: 6, brimHat: 7, cap: 8, skirt: 9, coat: 10, scarf: 11, stickLantern: 12, handLantern: 13, balloon: 14, cup: 15, phone: 16, longSkirt: 17, hood: 18 };

const TAU = Math.PI * 2;

class Builder {
  constructor() { this.pos = []; this.off = []; this.info = []; this.w = []; this.idx = []; this.n = 0; }
  // v: {p:[x,y,z] char-space axis point, o:[x,y,z] offset, reg, grp, bone, boneB, wB, gw, sw, fw}
  vert(v) {
    const pv = PIV[v.bone];
    this.pos.push(v.p[0] - pv[0], v.p[1] - pv[1], v.p[2] - pv[2]);
    this.off.push(v.o[0], v.o[1], v.o[2]);
    this.info.push(v.reg, v.grp || 0, v.bone, v.boneB ?? v.bone);
    this.w.push(v.wB || 0, v.gw ?? 1, v.sw || 0, v.fw || 0);
    return this.n++;
  }
  // polygon of vertex specs (convex, in order); flips the winding so the face normal points along `out`
  poly(vs, out, both = false) {
    const P = vs.map((v) => [v.p[0] + v.o[0], v.p[1] + v.o[1], v.p[2] + v.o[2]]);
    let nx = 0, ny = 0, nz = 0;                                    // Newell normal
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]); }
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    const ids = vs.map((v) => this.vert(v));
    const tri = (a, b, c) => { if (flip) this.idx.push(a, c, b); else this.idx.push(a, b, c); };
    for (let i = 1; i + 1 < ids.length; i++) tri(ids[0], ids[i], ids[i + 1]);
    if (both) { const ids2 = vs.map((v) => this.vert(v)); for (let i = 1; i + 1 < ids2.length; i++) { if (flip) this.idx.push(ids2[0], ids2[i], ids2[i + 1]); else this.idx.push(ids2[0], ids2[i + 1], ids2[i]); } }
  }
}

// Loft a tube along rings. ring: {c:[x,y,z], rx, rz, tilt?, gw?, sw?, fw?, wB?(fn of angle), boneB?}
// opt: {bone, sides, phase, reg (or fn(seg, side)), grp, capA, capB, skip(fn side->bool), both, arc:[a0,a1]}
function loft(B, opt, rings) {
  const S = opt.sides, arc = opt.arc;
  const ang = (k) => arc ? arc[0] + (arc[1] - arc[0]) * k / S : (opt.phase || 0) + TAU * k / S;
  const vtx = (r, k, reg) => {
    const a = ang(k), ca = Math.cos(a), sa = Math.sin(a);
    const fw = r.fw ? r.fw * Math.max(0, sa) : 0;                // push only the front half
    const wB = r.wB ? r.wB(ca, sa) : 0;
    return { p: [r.c[0], r.c[1] + (r.tilt || 0) * sa, r.c[2]], o: [r.rx * ca, 0, r.rz * sa], reg, grp: opt.grp, bone: opt.bone,
      boneB: wB > 0 ? (typeof r.boneB === 'function' ? r.boneB(ca, sa) : r.boneB) : opt.bone, wB, gw: r.gw ?? opt.gw ?? 1, sw: r.sw || 0, fw };
  };
  const nseg = arc ? S : S;
  for (let i = 0; i + 1 < rings.length; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < nseg; k++) {
      if (opt.skip && opt.skip(k)) continue;
      const reg = typeof opt.reg === 'function' ? opt.reg(i, k) : opt.reg;
      const am = ang(k + 0.5), out = [Math.cos(am), 0, Math.sin(am)];
      if (opt.inward) { out[0] = -out[0]; out[2] = -out[2]; }
      B.poly([vtx(r0, k, reg), vtx(r0, k + 1, reg), vtx(r1, k + 1, reg), vtx(r1, k, reg)], out, opt.both);
    }
  }
  const cap = (r, out, reg) => { const vs = []; for (let k = 0; k < S; k++) vs.push(vtx(r, k, reg)); B.poly(vs, out); };
  if (opt.capA) cap(rings[0], [0, -1, 0], opt.capRegA ?? (typeof opt.reg === 'function' ? opt.reg(0, 0) : opt.reg));
  if (opt.capB) cap(rings[rings.length - 1], [0, 1, 0], opt.capRegB ?? (typeof opt.reg === 'function' ? opt.reg(rings.length - 2, 0) : opt.reg));
}

// straight tube from a to b (any direction), radii r0 -> r1
function tube(B, a, b, r0, r1, sides, opt) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d); d[0] /= l; d[1] /= l; d[2] /= l;
  let u = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dot = u[0] * d[0] + u[1] * d[1] + u[2] * d[2]; u = [u[0] - dot * d[0], u[1] - dot * d[1], u[2] - dot * d[2]];
  const ul = Math.hypot(...u); u = u.map((x) => x / ul);
  const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const off = (ang, r) => [0, 1, 2].map((i) => r * (Math.cos(ang) * u[i] + Math.sin(ang) * w[i]));
  const V = (p, o) => ({ p, o, reg: opt.reg, grp: opt.grp, bone: opt.bone, gw: 0 });
  for (let k = 0; k < sides; k++) {
    const a0 = k * TAU / sides, a1 = (k + 1) * TAU / sides, am = (a0 + a1) / 2;
    B.poly([V(a, off(a0, r0)), V(a, off(a1, r0)), V(b, off(a1, r1)), V(b, off(a0, r1))], off(am, 1));
  }
  if (opt.capA) { const vs = []; for (let k = 0; k < sides; k++) vs.push(V(a, off(k * TAU / sides, r0))); B.poly(vs, d.map((x) => -x)); }
}

// box from 8 corner points (char space) given as [x0,x1] etc. with optional toe drop
function box(B, bone, reg, grp, x0, x1, y0, y1, z0, z1, opt = {}) {
  const yTopF = opt.yTopFront ?? y1;
  const c = (x, y, z) => ({ p: [x, y, z], o: [0, 0, 0], reg, grp, bone, gw: opt.gw ?? 0 });
  const yt = (z) => (z === z1 ? yTopF : y1);
  const P = { lbb: c(x0, y0, z0), rbb: c(x1, y0, z0), lbf: c(x0, y0, z1), rbf: c(x1, y0, z1), ltb: c(x0, yt(z0), z0), rtb: c(x1, yt(z0), z0), ltf: c(x0, yt(z1), z1), rtf: c(x1, yt(z1), z1) };
  if (!opt.noBottom) B.poly([P.lbb, P.rbb, P.rbf, P.lbf], [0, -1, 0]);
  B.poly([P.ltb, P.rtb, P.rtf, P.ltf], [0, 1, 0 + (yTopF < y1 ? 0.3 : 0)]);
  B.poly([P.lbf, P.rbf, P.rtf, P.ltf], [0, 0, 1]);
  B.poly([P.lbb, P.rbb, P.rtb, P.ltb], [0, 0, -1]);
  B.poly([P.lbb, P.lbf, P.ltf, P.ltb], [-1, 0, 0]);
  B.poly([P.rbb, P.rbf, P.rtf, P.rtb], [1, 0, 0]);
}

// ── the figure ──
// lod 0: full (~300 triangles for a typical guest), lod 1: cheap (~70)
export function buildGuestGeometry(lod = 0) {
  const B = new Builder();
  const hi = lod === 0;
  const S8 = hi ? 8 : 4, S6 = hi ? 6 : 4, S5 = hi ? 5 : 3;
  const front8 = Math.PI / 2 - Math.PI / S8;                        // phase that centres face 0 on +z (forward)

  // pelvis (bottom colour, or the dress)
  loft(B, { bone: 0, sides: S8, phase: front8, reg: REG.bottom, capA: true }, hi ? [
    { c: [0, 0.80, 0], rx: 0.14, rz: 0.098, sw: 0.10 },
    { c: [0, 0.90, 0], rx: 0.17, rz: 0.113, sw: 0.13 },
    { c: [0, 1.00, 0], rx: 0.156, rz: 0.108, sw: 0.06, fw: 0.3 },
  ] : [
    { c: [0, 0.80, 0], rx: 0.14, rz: 0.1, sw: 0.1 },
    { c: [0, 1.02, 0], rx: 0.16, rz: 0.11, sw: 0.08 },
  ]);
  // chest: top colour; jackets and coats show the shirt underneath on the front face
  const chestReg = (seg, k) => (hi && k === 0 && seg < 3 ? REG.inner : REG.top);
  loft(B, { bone: 1, sides: S8, phase: front8, reg: chestReg, capB: true, capRegB: REG.top }, hi ? [
    { c: [0, 0.97, 0], rx: 0.154, rz: 0.106, sw: 0.05 },
    { c: [0, 1.14, 0.004], rx: 0.15, rz: 0.106, fw: 0.9 },
    { c: [0, 1.355, -0.004], rx: 0.19, rz: 0.115, fw: -0.7, sw: -0.09 },
    { c: [0, 1.465, -0.01], rx: 0.085, rz: 0.066, gw: 0.4, sw: -0.05 },
  ] : [
    { c: [0, 0.98, 0], rx: 0.148, rz: 0.10, fw: 0.6 },
    { c: [0, 1.42, -0.008], rx: 0.17, rz: 0.10, sw: -0.1, fw: -0.3 },
  ]);
  // neck + head (head bone); the face column points forward
  const front6 = Math.PI / 2 - Math.PI / S6;
  if (hi) loft(B, { bone: 2, sides: S6, phase: front6, reg: REG.skin, gw: 0.3 }, [
    { c: [0, 1.43, -0.012], rx: 0.05, rz: 0.052 }, { c: [0, 1.53, -0.005], rx: 0.048, rz: 0.05 },
  ]);
  loft(B, { bone: 2, sides: S6, phase: front6, reg: (seg) => (hi && seg === 1 ? REG.face : REG.skin), capA: true, capB: true, gw: 0 }, hi ? [
    { c: [0, 1.495, 0.025], rx: 0.055, rz: 0.06 },
    { c: [0, 1.545, 0.012], rx: 0.084, rz: 0.094 },
    { c: [0, 1.625, 0.004], rx: 0.093, rz: 0.106 },
    { c: [0, 1.69, -0.002], rx: 0.086, rz: 0.099 },
    { c: [0, 1.735, -0.006], rx: 0.048, rz: 0.056 },
  ] : [
    { c: [0, 1.48, 0.01], rx: 0.075, rz: 0.085 },
    { c: [0, 1.73, -0.005], rx: 0.088, rz: 0.098 },
  ]);
  if (hi) {   // nose: a small wedge so the head reads which way it faces
    const n = (x, y, z) => ({ p: [x, y, z], o: [0, 0, 0], reg: REG.face, bone: 2, gw: 0 });
    const a = n(0, 1.635, 0.104), b = n(-0.016, 1.592, 0.108), c = n(0.016, 1.592, 0.108), t = n(0, 1.598, 0.128);
    B.poly([a, b, t], [-0.5, 0, 1]); B.poly([a, t, c], [0.5, 0, 1]); B.poly([b, c, t], [0, -1, 0.4]);
  }

  // hair (head bone)
  const hairCap = hi ? [
    { c: [0, 1.618, -0.004], rx: 0.1, rz: 0.114, tilt: 0.05 },
    { c: [0, 1.70, -0.006], rx: 0.095, rz: 0.109, tilt: 0.012 },
    { c: [0, 1.758, -0.008], rx: 0.05, rz: 0.06 },
  ] : [{ c: [0, 1.62, -0.004], rx: 0.1, rz: 0.112, tilt: 0.04 }, { c: [0, 1.75, -0.006], rx: 0.06, rz: 0.07 }];
  loft(B, { bone: 2, sides: S8, phase: front8, reg: REG.hair, grp: GRP.hairCap, capB: true, gw: 0 }, hairCap);
  if (hi) {
    // bob: sides and back down to the jaw (open at the front)
    loft(B, { bone: 2, sides: 5, arc: [Math.PI * 0.82 - Math.PI * 2, Math.PI * 0.18], reg: REG.hair, grp: GRP.hairBob, both: true, gw: 0 }, [
      { c: [0, 1.53, -0.012], rx: 0.108, rz: 0.118 }, { c: [0, 1.64, -0.006], rx: 0.103, rz: 0.116 },
    ]);
    // long: down the back to the shoulder blades
    loft(B, { bone: 2, sides: 4, arc: [Math.PI * 0.85 - Math.PI * 2, Math.PI * 0.15], reg: REG.hair, grp: GRP.hairLong, both: true, gw: 0 }, [
      { c: [0, 1.30, -0.06], rx: 0.105, rz: 0.075 }, { c: [0, 1.46, -0.035], rx: 0.112, rz: 0.1 }, { c: [0, 1.63, -0.006], rx: 0.104, rz: 0.116 },
    ]);
    // bun
    loft(B, { bone: 2, sides: 5, reg: REG.hair, grp: GRP.hairBun, capA: true, capB: true, gw: 0 }, [
      { c: [0, 1.695, -0.118], rx: 0.03, rz: 0.03 }, { c: [0, 1.725, -0.128], rx: 0.048, rz: 0.045 }, { c: [0, 1.765, -0.125], rx: 0.026, rz: 0.026 },
    ]);
    // ponytail
    loft(B, { bone: 2, sides: 4, reg: REG.hair, grp: GRP.hairPony, capA: true, gw: 0 }, [
      { c: [0, 1.40, -0.15], rx: 0.018, rz: 0.018 }, { c: [0, 1.55, -0.14], rx: 0.035, rz: 0.035 }, { c: [0, 1.665, -0.11], rx: 0.03, rz: 0.03 },
    ]);
    // beanie (accent colour)
    loft(B, { bone: 2, sides: S8, phase: front8, reg: REG.accent, grp: GRP.beanie, capB: true, gw: 0 }, [
      { c: [0, 1.632, -0.004], rx: 0.108, rz: 0.121, tilt: 0.035 }, { c: [0, 1.66, -0.004], rx: 0.108, rz: 0.121, tilt: 0.035 },
      { c: [0, 1.735, -0.008], rx: 0.1, rz: 0.112 }, { c: [0, 1.80, -0.012], rx: 0.048, rz: 0.054 },
    ]);
    // brimmed hat: crown + brim
    loft(B, { bone: 2, sides: S8, phase: front8, reg: REG.accent, grp: GRP.brimHat, capB: true, gw: 0 }, [
      { c: [0, 1.672, -0.006], rx: 0.102, rz: 0.114, tilt: 0.012 }, { c: [0, 1.80, -0.008], rx: 0.088, rz: 0.098 }, { c: [0, 1.818, -0.008], rx: 0.06, rz: 0.066 },
    ]);
    loft(B, { bone: 2, sides: S8, phase: front8, reg: REG.accent, grp: GRP.brimHat, both: true, gw: 0 }, [
      { c: [0, 1.672, -0.006], rx: 0.102, rz: 0.114, tilt: 0.012 }, { c: [0, 1.665, -0.006], rx: 0.18, rz: 0.19, tilt: 0.02 },
    ]);
    // cap with a visor
    loft(B, { bone: 2, sides: S8, phase: front8, reg: REG.accent, grp: GRP.cap, capB: true, gw: 0 }, [
      { c: [0, 1.645, -0.004], rx: 0.104, rz: 0.118, tilt: 0.025 }, { c: [0, 1.725, -0.008], rx: 0.097, rz: 0.108 }, { c: [0, 1.775, -0.01], rx: 0.05, rz: 0.056 },
    ]);
    { const v = (x, y, z) => ({ p: [x, y, z], o: [0, 0, 0], reg: REG.accent, grp: GRP.cap, bone: 2, gw: 0 });
      B.poly([v(-0.075, 1.672, 0.09), v(0.075, 1.672, 0.09), v(0.06, 1.655, 0.20), v(-0.06, 1.655, 0.20)], [0, 1, 0], true); }
    // scarf (chest bone, accent) + a tail hanging at the front
    loft(B, { bone: 1, sides: 6, phase: front6, reg: REG.accent, grp: GRP.scarf, gw: 0.5 }, [
      { c: [0, 1.405, -0.012], rx: 0.085, rz: 0.08 }, { c: [0, 1.49, -0.012], rx: 0.07, rz: 0.07 },
    ]);
    box(B, 1, REG.accent, GRP.scarf, 0.02, 0.075, 1.18, 1.42, 0.09, 0.115, { gw: 0 });
  }

  // arms (upper arm: sleeve; forearm: sleeve or skin; hand: skin)
  for (const s of [1, -1]) {
    const ua = s > 0 ? 3 : 5, fa = s > 0 ? 4 : 6;
    if (hi) {
      loft(B, { bone: ua, sides: S5, phase: Math.PI / 2, reg: REG.upperarm, capA: true, capB: true, gw: 0.7 }, [
        { c: [s * 0.183, 1.425, -0.01], rx: 0.054, rz: 0.056 }, { c: [s * 0.205, 1.115, -0.02], rx: 0.042, rz: 0.045 },
      ]);
      loft(B, { bone: fa, sides: S5, phase: Math.PI / 2, reg: REG.forearm, capA: true, gw: 0.55 }, [
        { c: [s * 0.205, 1.14, -0.02], rx: 0.043, rz: 0.046 }, { c: [s * 0.215, 0.875, -0.005], rx: 0.032, rz: 0.035 },
      ]);
      loft(B, { bone: fa, sides: S5, phase: Math.PI / 2, reg: REG.skin, capB: false, capA: true, gw: 0.25 }, [
        { c: [s * 0.215, 0.885, -0.004], rx: 0.024, rz: 0.037 }, { c: [s * 0.218, 0.765, 0.006], rx: 0.014, rz: 0.03 },
      ]);
    } else {
      // one rigid piece on the upper-arm bone, the forearm piece on the forearm bone (elbows still bend)
      // one rigid piece per arm on the upper-arm bone
      loft(B, { bone: ua, sides: S5, phase: Math.PI / 2, reg: REG.upperarm, gw: 0.7 }, [
        { c: [s * 0.185, 1.42, -0.01], rx: 0.05, rz: 0.05 }, { c: [s * 0.215, 0.80, -0.0], rx: 0.03, rz: 0.035 },
      ]);
    }
  }
  // legs
  for (const s of [1, -1]) {
    const th = s > 0 ? 7 : 9, sh = s > 0 ? 8 : 10, ft = s > 0 ? 11 : 12;
    loft(B, { bone: th, sides: hi ? 6 : 3, phase: Math.PI / 2, reg: REG.thigh, gw: 0.8 }, hi ? [
      { c: [s * 0.088, 0.93, 0], rx: 0.094, rz: 0.098 }, { c: [s * 0.095, 0.475, 0.01], rx: 0.062, rz: 0.066 },
    ] : [{ c: [s * 0.088, 0.93, 0], rx: 0.08, rz: 0.08 }, { c: [s * 0.095, 0.475, 0.01], rx: 0.055, rz: 0.058 }]);
    loft(B, { bone: sh, sides: hi ? 6 : 3, phase: Math.PI / 2, reg: REG.shin, capB: false, capA: !hi, gw: 0.6 }, hi ? [
      { c: [s * 0.095, 0.505, 0.008], rx: 0.061, rz: 0.064 }, { c: [s * 0.097, 0.085, -0.004], rx: 0.04, rz: 0.044 },
    ] : [{ c: [s * 0.095, 0.505, 0.008], rx: 0.054, rz: 0.057 }, { c: [s * 0.097, 0.03, 0.01], rx: 0.04, rz: 0.06 }]);
    if (hi) box(B, ft, REG.shoes, 0, s * 0.097 - 0.042, s * 0.097 + 0.042, 0.0, 0.095, -0.05, 0.16, { yTopFront: 0.05, gw: 0.15, noBottom: true });
  }

  // skirt (pelvis bone; the hem follows the thighs a little) and long skirt / dress
  const hemW = (k) => (ca) => Math.min(1, Math.abs(ca) * k);
  const hemB = (ca) => (ca > 0 ? 7 : 9);
  loft(B, { bone: 0, sides: S8, phase: front8, reg: REG.skirt, grp: GRP.skirt, both: true, gw: 0.9 }, hi ? [
    { c: [0, 1.0, 0], rx: 0.156, rz: 0.11, sw: 0.06 }, { c: [0, 0.88, 0], rx: 0.182, rz: 0.13, sw: 0.12 },
    { c: [0, 0.60, 0.005], rx: 0.215, rz: 0.17, sw: 0.1, wB: hemW(0.55), boneB: hemB },
  ] : [{ c: [0, 1.0, 0], rx: 0.16, rz: 0.11 }, { c: [0, 0.60, 0], rx: 0.215, rz: 0.17, wB: hemW(0.5), boneB: hemB }]);
  if (hi) loft(B, { bone: 0, sides: S8, phase: front8, reg: REG.skirt, grp: GRP.longSkirt, both: true, gw: 0.9 }, [
    { c: [0, 1.0, 0], rx: 0.156, rz: 0.11, sw: 0.06 }, { c: [0, 0.86, 0], rx: 0.185, rz: 0.135, sw: 0.12 },
    { c: [0, 0.24, 0.01], rx: 0.235, rz: 0.2, sw: 0.08, wB: hemW(0.7), boneB: hemB },
  ]);
  // coat tail: open at the front
  if (hi) loft(B, { bone: 0, sides: S8, phase: front8, reg: REG.top, grp: GRP.coat, both: true, gw: 0.9, skip: (k) => k === 0 }, [
    { c: [0, 1.0, 0], rx: 0.158, rz: 0.112, sw: 0.06, fw: 0.3 }, { c: [0, 0.86, 0], rx: 0.178, rz: 0.125, sw: 0.1 },
    { c: [0, 0.52, -0.005], rx: 0.205, rz: 0.15, sw: 0.08, wB: hemW(0.5), boneB: hemB },
  ]);

  // ── carried things (left hand), phone (right hand) ──
  // hand centre of the left forearm in rest pose: (0.217, 0.80, 0.0)
  if (hi) {
    // stick: from the hand, forward and up once the elbow is bent ~90 degrees (rest direction (0, -0.6, 0.8))
    const h0 = [0.217, 0.84, -0.03], d = [0, -0.6, 0.8], L = 0.82;
    const tip = [h0[0], h0[1] + d[1] * L, h0[2] + d[2] * L];
    tube(B, h0, tip, 0.009, 0.007, 3, { reg: REG.wood, grp: GRP.stickLantern, bone: 4 });
    // paper lantern hanging from the tip (pseudo-bone 14, origin = the hang point)
    const lantern = (grp, r, y0, y1) => {
      loft(B, { bone: 14, sides: 6, reg: REG.glow, grp, capA: true, capB: true, capRegA: REG.dark, capRegB: REG.dark, gw: 0 }, [
        { c: [0, y1, 0], rx: r * 0.7, rz: r * 0.7 }, { c: [0, (y0 + y1) / 2, 0], rx: r, rz: r }, { c: [0, y0, 0], rx: r * 0.75, rz: r * 0.75 },
      ]);
      const s = (y) => ({ p: [0, y, 0], o: [0, 0, 0], reg: REG.string, grp, bone: 14, gw: 0 });
      B.poly([{ ...s(0), o: [-0.004, 0, 0] }, { ...s(0), o: [0.004, 0, 0] }, { ...s(y0), o: [0.004, 0, 0] }, { ...s(y0), o: [-0.004, 0, 0] }], [0, 0, 1], true);
    };
    lantern(GRP.stickLantern, 0.085, -0.07, -0.27);
    lantern(GRP.handLantern, 0.055, -0.07, -0.21);
    // balloon (pseudo-bone 13 at the balloon's bottom) + string from the left hand
    loft(B, { bone: 13, sides: 6, reg: REG.balloon, grp: GRP.balloon, capA: true, capB: true, gw: 0 }, [
      { c: [0, 0.02, 0], rx: 0.04, rz: 0.04 }, { c: [0, 0.12, 0], rx: 0.13, rz: 0.13 }, { c: [0, 0.27, 0], rx: 0.145, rz: 0.145 }, { c: [0, 0.38, 0], rx: 0.08, rz: 0.08 },
    ]);
    { const a = { p: [0.217, 0.79, 0.0], o: [-0.003, 0, 0], reg: REG.string, grp: GRP.balloon, bone: 4, gw: 0 };
      const b = { p: [0, 0.02, 0], o: [-0.003, 0, 0], reg: REG.string, grp: GRP.balloon, bone: 13, gw: 0 };
      B.poly([a, { ...a, o: [0.003, 0, 0] }, { ...b, o: [0.003, 0, 0] }, b], [0, 0, 1], true); }
    // cup in the left hand (upright when the forearm points forward: rest axis = +z)
    tube(B, [0.217, 0.80, -0.02], [0.217, 0.80, 0.095], 0.03, 0.037, 5, { reg: REG.cup, grp: GRP.cup, bone: 4, capA: true });
    // phone (pseudo-bone 15: at the right hand, upright, screen facing back towards the guest)
    { const v = (x, y, z, reg) => ({ p: [x, y, z], o: [0, 0, 0], reg, grp: GRP.phone, bone: 15, gw: 0 });
      box(B, 15, REG.dark, GRP.phone, -0.036, 0.036, -0.06, 0.085, -0.006, 0.006, { gw: 0 });
      B.poly([v(-0.031, -0.052, -0.0075, REG.screen), v(0.031, -0.052, -0.0075, REG.screen), v(0.031, 0.078, -0.0075, REG.screen), v(-0.031, 0.078, -0.0075, REG.screen)], [0, 0, -1]); }
  } else {
    // cheap versions of the glowing things only (they are what reads from afar)
    loft(B, { bone: 14, sides: 4, reg: REG.glow, grp: GRP.stickLantern, capA: true, capB: true, gw: 0 }, [{ c: [0, -0.27, 0], rx: 0.08, rz: 0.08 }, { c: [0, -0.07, 0], rx: 0.07, rz: 0.07 }]);
    loft(B, { bone: 14, sides: 4, reg: REG.glow, grp: GRP.handLantern, capA: true, capB: true, gw: 0 }, [{ c: [0, -0.21, 0], rx: 0.055, rz: 0.055 }, { c: [0, -0.07, 0], rx: 0.05, rz: 0.05 }]);
    loft(B, { bone: 13, sides: 4, reg: REG.balloon, grp: GRP.balloon, capA: true, capB: true, gw: 0 }, [{ c: [0, 0.03, 0], rx: 0.05, rz: 0.05 }, { c: [0, 0.2, 0], rx: 0.15, rz: 0.15 }, { c: [0, 0.38, 0], rx: 0.07, rz: 0.07 }]);
    box(B, 15, REG.screen, GRP.phone, -0.036, 0.036, -0.06, 0.085, -0.006, 0.006, { gw: 0 });
  }
  return { position: new Float32Array(B.pos), aOff: new Float32Array(B.off), aInfo: new Float32Array(B.info), aW: new Float32Array(B.w), index: B.idx.length / 3 > 21845 ? new Uint32Array(B.idx) : new Uint16Array(B.idx), verts: B.n, tris: B.idx.length / 3, groupTris: groupTris(B) };
}
function groupTris(B) {
  const g = {};
  for (let t = 0; t < B.idx.length; t += 3) { const k = B.info[B.idx[t] * 4 + 1]; g[k] = (g[k] || 0) + 1; }
  return g;
}

// ── who is this guest: body, clothes, palette, carried item, all from the seed ──
// The renderer packs this into a float texture once per guest; the simulation may call guestLook(seed) too
// (e.g. for walking speed by body type: look.kind, look.child, look.height).
function hashf(seed, k) { let x = Math.imul((Math.floor(Math.fround(seed) * 4294967296) >>> 0) ^ Math.imul(k + 1, 0x9e3779b9), 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; }
const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
const hex = (s) => parseInt(s.replace('#', ''), 16);
// evening palettes (sRGB)
export const PAL = {
  skin: ['#f3d2bc', '#e8bb9a', '#d9a27f', '#c68863', '#a96d4a', '#8a5636', '#6b4029', '#4f2e1d'],
  hair: ['#1b1512', '#2b1d15', '#3d2a1c', '#5a3b22', '#7a4b26', '#9b6a3a', '#c79a5f', '#dcc08a', '#8f8a86', '#d7d3cf', '#7c2f22', '#b04a2b'],
  hairWild: ['#3b6f7a', '#8a3d6e', '#5a4aa0'],
  top: ['#2c3550', '#3e2a3f', '#6b2430', '#8a3a2b', '#3d6b4f', '#c9a14a', '#4f5d3a', '#2e4a45', '#3b5c73', '#d8cdb8', '#9a9187', '#1f1f24', '#5a2e5c', '#b84a4a', '#4a6a8a', '#6d7f99', '#e2b24c', '#2f6e6a', '#7a3b5e', '#e9e4da'],
  coat: ['#6e5236', '#8a6a44', '#2a2f3a', '#43372f', '#5e2a2a', '#3a4636', '#b39b77', '#1d2230', '#7a7068'],
  bottom: ['#22252e', '#2e3442', '#3a4560', '#4a5878', '#38302a', '#5b4a38', '#1c1c1f', '#6b6458', '#7d6a52', '#3f3a4f'],
  skirt: ['#2a2238', '#5a2232', '#1f2c3d', '#6d5a3a', '#3d4a2e', '#7a3a52', '#2b2b2f', '#a8503a'],
  shoes: ['#18171a', '#2a1f18', '#3d2c20', '#d8d4cc', '#55504a', '#7a2a24'],
  accent: ['#b33a32', '#d9a53b', '#e8dcc6', '#2f5c4a', '#5a3060', '#2a2d38', '#c6603a', '#3f6aa0', '#a8a39a', '#7c8f3d'],
  legs: ['#1c1a1f', '#2b2228', '#3a3036'],
  lantern: ['#ffb45c', '#ff8a4a', '#ffd27a', '#ff6a5a', '#ffc8a0'],
  balloon: ['#e84a5f', '#f2b134', '#4fb3d9', '#9b6bd6', '#5ccf8f', '#f27ab6', '#f5f0e6'],
};
// body types: [weight, height range, girth range, shape, belly, legs, head, stoop]
export const KINDS = [
  { id: 'tall',     w: 0.14, h: [1.03, 1.09], g: [0.86, 0.96], s: [-0.9, -0.3], b: [0, 0.1], lf: 1.03, hs: 0.98 },
  { id: 'average',  w: 0.20, h: [0.98, 1.04], g: [0.98, 1.1],  s: [-1, -0.6],  b: [0, 0.3], lf: 1.0,  hs: 1.0 },
  { id: 'broad',    w: 0.11, h: [0.97, 1.03], g: [1.22, 1.38], s: [-0.9, -0.5], b: [0.5, 1], lf: 0.98, hs: 1.02 },
  { id: 'slender',  w: 0.18, h: [0.93, 0.99], g: [0.88, 0.98], s: [0.6, 1],    b: [0, 0.1], lf: 1.0,  hs: 0.98 },
  { id: 'curvy',    w: 0.12, h: [0.92, 0.98], g: [1.1, 1.26],  s: [0.8, 1.1],  b: [0.1, 0.5], lf: 0.98, hs: 1.0 },
  { id: 'older',    w: 0.09, h: [0.9, 0.97],  g: [1.0, 1.15],  s: [-1, 1],     b: [0.2, 0.7], lf: 0.97, hs: 1.0, stoop: 0.14 },
  { id: 'child',    w: 0.10, h: [0.72, 0.8],  g: [0.92, 1.02], s: [-0.3, 0.3], b: [0, 0.2], lf: 0.92, hs: 1.2 },
  { id: 'small',    w: 0.06, h: [0.6, 0.66],  g: [0.98, 1.08], s: [-0.2, 0.2], b: [0.2, 0.4], lf: 0.86, hs: 1.32 },
];
export const ITEMS = ['none', 'stickLantern', 'handLantern', 'balloon', 'cup', 'phone'];
export const HAIRS = ['short', 'bob', 'long', 'bun', 'pony', 'shaved'];
export const TOPS = ['tee', 'sweater', 'jacket', 'coat', 'dress'];
export const LOWERS = ['trousers', 'shorts', 'skirt', 'longskirt', 'dress'];

export function guestLook(seed, opt = {}) {
  const r = (k) => hashf(seed, k);
  let acc = 0, u = r(1), kind = KINDS[KINDS.length - 1];
  const tot = KINDS.reduce((s, k) => s + k.w * (k.id === 'child' || k.id === 'small' ? (opt.children ?? 1) : 1), 0);
  for (const k of KINDS) { acc += k.w * (k.id === 'child' || k.id === 'small' ? (opt.children ?? 1) : 1) / tot; if (u < acc) { kind = k; break; } }
  if (opt.kind !== undefined) kind = KINDS[opt.kind];
  const lerp = (a, t) => a[0] + (a[1] - a[0]) * t;
  const child = kind.id === 'child' || kind.id === 'small';
  const fem = lerp(kind.s, r(3));
  const L = { kind: KINDS.indexOf(kind), kindId: kind.id, child, height: lerp(kind.h, r(2)), girth: lerp(kind.g, r(4)), shape: fem, belly: lerp(kind.b, r(5)), lf: kind.lf, hs: kind.hs, stoop: kind.stoop || 0 };
  // hair
  const hr = r(6);
  let hair = fem > 0.3 ? pick(['long', 'long', 'bob', 'bun', 'pony', 'short'], hr) : fem < -0.3 ? pick(['short', 'short', 'short', 'shaved', 'bob', 'pony'], hr) : pick(HAIRS, hr);
  if (child && hair === 'shaved') hair = 'short';
  L.hair = HAIRS.indexOf(hair);
  // hat (none for most)
  const hat = r(7) < (child ? 0.25 : 0.2) ? pick(['beanie', 'brimHat', 'cap'], r(8)) : 'none';
  L.hat = hat;
  // clothes
  let top = pick(child ? ['tee', 'sweater', 'sweater', 'jacket'] : ['tee', 'sweater', 'sweater', 'jacket', 'jacket', 'coat', 'coat'], r(9));
  let lower = pick(fem > 0.4 ? ['trousers', 'trousers', 'skirt', 'longskirt', 'dress'] : fem > -0.2 ? ['trousers', 'trousers', 'skirt', 'shorts'] : ['trousers', 'trousers', 'trousers', 'shorts'], r(10));
  if (lower === 'dress') top = r(11) < 0.5 ? 'dress' : 'coat';
  if (lower === 'shorts' && top === 'coat') top = 'jacket';
  L.top = TOPS.indexOf(top); L.lower = LOWERS.indexOf(lower);
  L.scarf = (top === 'coat' || top === 'jacket') && r(12) < 0.35;
  // carried item
  const ir = r(13);
  let item = ir < 0.11 ? 'stickLantern' : ir < 0.18 ? 'handLantern' : ir < 0.27 ? 'balloon' : ir < 0.34 ? 'cup' : ir < 0.40 ? 'phone' : 'none';
  if (child && item === 'cup') item = 'balloon';
  if (child && item === 'phone') item = 'stickLantern';
  if (opt.item !== undefined) item = ITEMS[opt.item] || opt.item;
  L.item = ITEMS.indexOf(item);
  L.balloonGlow = r(14) < 0.5;
  // arms at rest: 0 hang, 1 hands in pockets, 2 behind the back
  L.arms = top === 'jacket' || top === 'coat' ? (r(15) < 0.4 ? 1 : 0) : r(15) < 0.12 ? 2 : 0;
  // gait: arm swing and bounce
  L.swing = 0.75 + 0.5 * r(16); L.bounce = 0.7 + 0.6 * r(17);
  // colours
  const C = {};
  C.skin = hex(pick(PAL.skin, r(20)));
  C.hair = hex(r(21) < 0.04 && !child ? pick(PAL.hairWild, r(22)) : kind.id === 'older' && r(22) < 0.7 ? pick(['#8f8a86', '#d7d3cf', '#b9b4ad'], r(23)) : pick(PAL.hair.slice(0, child ? 8 : 10), r(23)));
  C.top = hex(pick(top === 'coat' ? PAL.coat : PAL.top, r(24)));
  C.inner = hex(pick(['#e8e2d4', '#c9c2b4', '#2a2a30', '#7d2a2a', '#3a4a66', '#d9b26b'], r(25)));
  C.bottom = hex(pick(PAL.bottom, r(26)));
  C.skirt = hex(lower === 'dress' ? (top === 'dress' ? '#' + C.top.toString(16).padStart(6, '0') : pick(PAL.skirt, r(27))) : pick(PAL.skirt, r(27)));
  C.shoes = hex(pick(PAL.shoes, r(28)));
  C.accent = hex(pick(PAL.accent, r(29)));
  C.legs = r(30) < 0.6 ? hex(pick(PAL.legs, r(31))) : C.skin;
  C.item = hex(item === 'balloon' ? pick(PAL.balloon, r(32)) : pick(PAL.lantern, r(32)));
  L.colors = C;
  return L;
}

// optional-part mask for a look
export function lookMask(L) {
  let m = 0; const on = (g) => { m |= 1 << g; };
  const hair = HAIRS[L.hair];
  if (hair !== 'shaved') on(GRP.hairCap);
  if (hair === 'bob') on(GRP.hairBob);
  if (hair === 'long') on(GRP.hairLong);
  if (hair === 'bun' && L.hat === 'none') on(GRP.hairBun);
  if (hair === 'pony' && L.hat !== 'brimHat') on(GRP.hairPony);
  if (L.hat !== 'none') on(GRP[L.hat]);
  const lower = LOWERS[L.lower], top = TOPS[L.top];
  if (lower === 'skirt') on(GRP.skirt);
  if (lower === 'longskirt' || lower === 'dress') on(GRP.longSkirt);
  if (top === 'coat' && lower !== 'longskirt' && lower !== 'dress') on(GRP.coat);
  if (L.scarf) on(GRP.scarf);
  const item = ITEMS[L.item];
  if (item !== 'none') on(GRP[item]);
  return m;
}
