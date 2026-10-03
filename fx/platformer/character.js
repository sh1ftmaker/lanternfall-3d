// "Wick", the Platformer's character: a small lamplighter of Lanternfall in a hooded indigo coat with an amber scarf,
// carrying a hooked lantern pole with a paper lantern. Original design, built here in code: low-poly rigid parts on
// a 19-bone rig (rest pose = the shapes below), posed by fx/platformer/animator.js, skinned in the vertex shader.
//
// Character space: metres, y up, z forward, x = the character's left. Feet on y = 0. Height to the hood top 1.58 m.
// Lit like the guests: the park's ground-light grid + the moon's shadow map + hemisphere shaping + rim, plus its own
// lantern (a warm point term on the body, an emissive paper lantern that the bloom picks up, a soft pool of light on
// the ground) and a contact shadow. No real-time lights.
import { DN_DECL, DN_LAMP } from '../game/daynight/uniforms.js';      // game hook: daynight
export const BONES = ['hips', 'chest', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'pole', 'lantern', 'cape', 'hoodTip'];
export const B = Object.fromEntries(BONES.map((n, i) => [n, i]));
export const PARENT = [-1, 0, 1, 1, 3, 4, 1, 6, 7, 0, 9, 10, 0, 12, 13, 8, -1, 1, 2];
export const PIVOT = [
  [0, 0.80, 0], [0, 0.95, 0], [0, 1.27, 0.0],
  [0.165, 1.19, -0.01], [0.175, 0.93, -0.01], [0.18, 0.69, 0.0],
  [-0.165, 1.19, -0.01], [-0.175, 0.93, -0.01], [-0.18, 0.69, 0.0],
  [0.09, 0.78, 0], [0.09, 0.42, 0.0], [0.09, 0.085, -0.01],
  [-0.09, 0.78, 0], [-0.09, 0.42, 0.0], [-0.09, 0.085, -0.01],
  [-0.18, 0.66, 0.03], [0, 0, 0], [0, 1.22, -0.10], [0, 1.47, -0.10],
];
export const POLE = { below: 0.36, above: 1.22, hook: 0.16 };      // pole: grip at the right hand, along +y in rest pose; hook reaches forward
export const LANTERN_DROP = 0.05;                                  // wire from the hook to the lantern's top

const C = {   // sRGB palette
  coat: '#2c3266', coatDark: '#1d2148', trim: '#d9a542', scarf: '#e0782e', skin: '#f0c6a0', cheek: '#e89c86', eye: '#1b1420',
  trousers: '#2a2730', boot: '#5a3a24', sole: '#2a1c14', glove: '#3d2b22', wood: '#4a3020', brass: '#c79a46', paper: '#ffb45c', satchel: '#7a4a2a', belt: '#6b4326',
};
const lin = (h) => { const c = parseInt(h.slice(1), 16), f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return [f(c >> 16), f((c >> 8) & 255), f(c & 255)]; };

class Geo {
  constructor() { this.p = []; this.c = []; this.b = []; this.e = []; this.i = []; this.n = 0; }
  v(p, bone, col, em = 0) { this.p.push(p[0], p[1], p[2]); const c = lin(col); this.c.push(c[0], c[1], c[2]); this.b.push(bone); this.e.push(em); return this.n++; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  // loft along a local frame: rings [{y, rx, rz, x?, z?}] around axis +y, `sides` around (phase puts a face at the front)
  loft(bone, rings, sides, col, { capA = false, capB = false, em = 0, arc = null, both = false, colFn = null } = {}) {
    const S = sides, ids = [];
    for (let r = 0; r < rings.length; r++) {
      const R = rings[r], row = [];
      for (let k = 0; k <= S; k++) {
        const a = arc ? arc[0] + (arc[1] - arc[0]) * k / S : (k / S) * Math.PI * 2 + Math.PI / 2 + Math.PI / S;
        row.push(this.v([(R.x || 0) + R.rx * Math.cos(a), R.y, (R.z || 0) + R.rz * Math.sin(a)], bone, colFn ? colFn(r, k) : (R.col || col), R.em ?? em));
      }
      ids.push(row);
    }
    for (let r = 0; r + 1 < rings.length; r++) for (let k = 0; k < S; k++) {
      const a = ids[r][k], b = ids[r][k + 1], c = ids[r + 1][k + 1], d = ids[r + 1][k];
      this.quad(a, d, c, b); if (both) this.quad(a, b, c, d);
    }
    const cap = (row, R, up) => { const c = this.v([R.x || 0, R.y, R.z || 0], bone, R.col || col, R.em ?? em); for (let k = 0; k < S; k++) { if (up) this.tri(c, row[k + 1], row[k]); else this.tri(c, row[k], row[k + 1]); } };
    if (capA) cap(ids[0], rings[0], false);
    if (capB) cap(ids[rings.length - 1], rings[rings.length - 1], true);
  }
  // tube between points a and b (any direction)
  tube(bone, a, b, r0, r1, sides, col, { capA = true, capB = true, em = 0 } = {}) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d); const n = d.map((x) => x / L);
    let u = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]; const dot = u[0] * n[0] + u[1] * n[1] + u[2] * n[2]; u = u.map((x, i) => x - dot * n[i]); const ul = Math.hypot(...u); u = u.map((x) => x / ul);
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const ring = (p, r) => { const out = []; for (let k = 0; k < sides; k++) { const t = (k / sides) * Math.PI * 2; out.push(this.v([0, 1, 2].map((i) => p[i] + r * (Math.cos(t) * u[i] + Math.sin(t) * w[i])), bone, col, em)); } return out; };
    const A = ring(a, r0), Bb = ring(b, r1);
    for (let k = 0; k < sides; k++) { const k1 = (k + 1) % sides; this.quad(A[k], A[k1], Bb[k1], Bb[k]); }
    if (capA) { const c = this.v(a, bone, col, em); for (let k = 0; k < sides; k++) this.tri(c, A[(k + 1) % sides], A[k]); }
    if (capB) { const c = this.v(b, bone, col, em); for (let k = 0; k < sides; k++) this.tri(c, Bb[k], Bb[(k + 1) % sides]); }
  }
  ball(bone, c, r, col, { seg = 6, ring = 5, sy = 1, em = 0, sz = 1 } = {}) {
    const rings = []; for (let j = 0; j <= ring; j++) { const t = -Math.PI / 2 + Math.PI * j / ring; rings.push({ y: c[1] + Math.sin(t) * r * sy, rx: Math.max(1e-4, Math.cos(t) * r), rz: Math.max(1e-4, Math.cos(t) * r * sz), x: c[0], z: c[2] }); }
    this.loft(bone, rings, seg, col, { em });
  }
  box(bone, c, s, col, em = 0) {
    const [x, y, z] = c, [hx, hy, hz] = s.map((v) => v / 2), P = (a, b, d) => this.v([x + a * hx, y + b * hy, z + d * hz], bone, col, em);
    const q = (p) => this.quad(...p);
    const v = [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)];
    q([v[4], v[5], v[6], v[7]]); q([v[1], v[0], v[3], v[2]]); q([v[5], v[1], v[2], v[6]]); q([v[0], v[4], v[7], v[3]]); q([v[7], v[6], v[2], v[3]]); q([v[0], v[1], v[5], v[4]]);
  }
}

export function buildCharacterGeometry() {
  const g = new Geo();
  // ── legs: trousers, boots ──
  for (const s of [1, -1]) {
    const th = s > 0 ? B.thighL : B.thighR, sh = s > 0 ? B.shinL : B.shinR, ft = s > 0 ? B.footL : B.footR, x = 0.09 * s;
    g.tube(th, [x, 0.80, 0], [x, 0.41, 0.005], 0.072, 0.056, 6, C.trousers);
    g.ball(sh, [x, 0.42, 0.005], 0.056, C.trousers, { seg: 6, ring: 3 });
    g.tube(sh, [x, 0.42, 0.005], [x, 0.13, -0.005], 0.054, 0.047, 6, C.trousers, { capB: false });
    // boot: cuff + foot box with a raised toe
    g.loft(ft, [{ y: 0.06, rx: 0.058, rz: 0.06, x, z: -0.005 }, { y: 0.19, rx: 0.06, rz: 0.062, x, z: -0.005 }, { y: 0.21, rx: 0.068, rz: 0.07, x, z: -0.005, col: C.boot }], 7, C.boot, { capB: true });
    g.box(ft, [x, 0.045, 0.05], [0.11, 0.09, 0.25], C.boot);
    g.box(ft, [x, 0.008, 0.05], [0.116, 0.016, 0.26], C.sole);
    g.ball(ft, [x, 0.05, 0.16], 0.055, C.boot, { seg: 6, ring: 3, sy: 0.8 });
  }
  // ── hips, belt, short coat skirt ──
  g.loft(B.hips, [{ y: 0.70, rx: 0.15, rz: 0.11 }, { y: 0.80, rx: 0.165, rz: 0.12 }, { y: 0.92, rx: 0.155, rz: 0.115 }], 8, C.trousers, { capA: true });
  g.loft(B.hips, [{ y: 0.88, rx: 0.172, rz: 0.13 }, { y: 0.95, rx: 0.17, rz: 0.128 }], 8, C.belt, { capA: false });
  g.box(B.hips, [0, 0.915, 0.128], [0.06, 0.05, 0.02], C.brass);
  g.loft(B.hips, [{ y: 0.92, rx: 0.178, rz: 0.135 }, { y: 0.76, rx: 0.215, rz: 0.17 }, { y: 0.66, rx: 0.235, rz: 0.19, col: C.trim }], 10, C.coat, { both: true, arc: [Math.PI * 0.62, Math.PI * 2.38] });   // open at the front
  // satchel on the left hip with a strap
  g.box(B.hips, [0.2, 0.78, 0.02], [0.06, 0.15, 0.17], C.satchel);
  g.box(B.hips, [0.233, 0.82, 0.02], [0.012, 0.07, 0.14], C.brass);
  // ── chest: coat with gold trim, scarf ──
  g.loft(B.chest, [{ y: 0.90, rx: 0.16, rz: 0.12 }, { y: 1.06, rx: 0.165, rz: 0.125 }, { y: 1.18, rx: 0.175, rz: 0.12 }, { y: 1.25, rx: 0.12, rz: 0.09 }], 8, C.coat, { capB: true,
    colFn: (r, k) => (k === 0 || k === 8 ? C.trim : C.coat) });
  for (const y of [0.98, 1.06, 1.14]) g.ball(B.chest, [0, y, 0.128], 0.016, C.brass, { seg: 4, ring: 2 });
  g.loft(B.chest, [{ y: 1.18, rx: 0.135, rz: 0.115 }, { y: 1.24, rx: 0.14, rz: 0.12 }, { y: 1.32, rx: 0.115, rz: 0.1 }, { y: 1.35, rx: 0.09, rz: 0.08 }], 8, C.scarf, { capB: true });
  g.box(B.chest, [0.07, 1.06, 0.12], [0.07, 0.24, 0.025], C.scarf);         // scarf tail at the front-left
  g.box(B.chest, [0.07, 0.935, 0.122], [0.075, 0.03, 0.03], C.trim);
  // ── cape: back panel from the shoulders to the knees ──
  { const top = 1.22, bot = 0.5, z = -0.13, w0 = 0.15, w1 = 0.25, S = 6, rows = [];
    for (let r = 0; r <= 3; r++) { const t = r / 3, y = top + (bot - top) * t, w = w0 + (w1 - w0) * t, row = [];
      for (let k = 0; k <= S; k++) { const u = k / S, x = -w + 2 * w * u; row.push(g.v([x, y, z - 0.03 * t - 0.04 * Math.sin(u * Math.PI)], B.cape, r === 3 ? C.trim : C.coatDark)); }
      rows.push(row); }
    for (let r = 0; r < 3; r++) for (let k = 0; k < S; k++) { const a = rows[r][k], b = rows[r][k + 1], c = rows[r + 1][k + 1], d = rows[r + 1][k]; g.quad(a, b, c, d); g.quad(a, d, c, b); } }
  // ── arms: sleeves, cuffs, gloves ──
  for (const s of [1, -1]) {
    const ua = s > 0 ? B.armL : B.armR, fa = s > 0 ? B.foreL : B.foreR, hd = s > 0 ? B.handL : B.handR, x = 0.165 * s;
    g.ball(ua, [x, 1.19, -0.01], 0.07, C.coat, { seg: 6, ring: 4 });
    g.tube(ua, [x, 1.19, -0.01], [x + 0.01 * s, 0.93, -0.01], 0.058, 0.05, 6, C.coat);
    g.ball(fa, [x + 0.01 * s, 0.93, -0.01], 0.05, C.coat, { seg: 6, ring: 3 });
    g.tube(fa, [x + 0.01 * s, 0.93, -0.01], [x + 0.015 * s, 0.73, 0.0], 0.049, 0.06, 6, C.coat, { capB: false });
    g.loft(fa, [{ y: 0.72, rx: 0.062, rz: 0.062, x: x + 0.015 * s }, { y: 0.76, rx: 0.064, rz: 0.064, x: x + 0.015 * s }], 6, C.trim);
    g.ball(hd, [x + 0.015 * s, 0.66, 0.012], 0.047, C.glove, { seg: 6, ring: 4, sy: 1.15, sz: 0.85 });
    g.box(hd, [x + 0.005 * s, 0.665, 0.05], [0.03, 0.05, 0.03], C.glove);    // thumb
  }
  // ── head: face, eyes, cheeks, nose; hood with a soft tip ──
  g.ball(B.head, [0, 1.405, 0.015], 0.122, C.skin, { seg: 8, ring: 6, sy: 1.02 });
  for (const s of [1, -1]) {
    g.box(B.head, [0.045 * s, 1.425, 0.128], [0.022, 0.036, 0.012], C.eye);
    g.ball(B.head, [0.072 * s, 1.375, 0.105], 0.022, C.cheek, { seg: 5, ring: 2, sz: 0.5 });
  }
  g.ball(B.head, [0, 1.395, 0.135], 0.022, C.cheek, { seg: 5, ring: 3, sz: 0.9 });
  // hood: a shell around the head, open at the face (arc), lined with gold at the rim
  const hoodRings = [{ y: 1.27, rx: 0.15, rz: 0.15, z: -0.01 }, { y: 1.38, rx: 0.162, rz: 0.165, z: -0.012 }, { y: 1.49, rx: 0.15, rz: 0.155, z: -0.02 }, { y: 1.56, rx: 0.1, rz: 0.11, z: -0.035 }, { y: 1.585, rx: 0.03, rz: 0.04, z: -0.05 }];
  g.loft(B.head, hoodRings, 10, C.coat, { arc: [Math.PI * 0.68, Math.PI * 2.32], both: true, colFn: (r, k) => (k === 0 || k === 10 ? C.trim : C.coat) });
  g.loft(B.head, [{ y: 1.49, rx: 0.15, rz: 0.155, z: -0.02 }, { y: 1.56, rx: 0.1, rz: 0.11, z: -0.035 }, { y: 1.585, rx: 0.03, rz: 0.04, z: -0.05 }], 10, C.coat, { arc: [Math.PI * 0.32, Math.PI * 0.68], both: true });
  // hood tip (its own bone, flops back)
  g.loft(B.hoodTip, [{ y: 1.47, rx: 0.07, rz: 0.06, z: -0.11 }, { y: 1.47, rx: 0.045, rz: 0.04, z: -0.21 }, { y: 1.45, rx: 0.02, rz: 0.02, z: -0.29 }].map((r) => ({ ...r })), 6, C.coat, { capB: true });
  g.ball(B.hoodTip, [0, 1.445, -0.30], 0.028, C.trim, { seg: 5, ring: 3 });
  // ── lantern pole (right hand) with a brass hook ──
  { const [gx, gy, gz] = PIVOT[B.pole];
    g.tube(B.pole, [gx, gy - POLE.below, gz], [gx, gy + POLE.above, gz], 0.017, 0.015, 5, C.wood);
    g.ball(B.pole, [gx, gy - POLE.below, gz], 0.024, C.brass, { seg: 5, ring: 3 });
    g.loft(B.pole, [{ y: gy + POLE.above - 0.02, rx: 0.024, rz: 0.024, x: gx, z: gz }, { y: gy + POLE.above + 0.05, rx: 0.02, rz: 0.02, x: gx, z: gz }], 5, C.brass, { capB: true });
    g.tube(B.pole, [gx, gy + POLE.above, gz], [gx, gy + POLE.above + 0.05, gz + POLE.hook], 0.011, 0.01, 4, C.brass);
    g.tube(B.pole, [gx, gy + POLE.above + 0.05, gz + POLE.hook], [gx, gy + POLE.above - 0.01, gz + POLE.hook + 0.015], 0.009, 0.008, 4, C.brass); }
  // ── paper lantern (own bone: origin = the hook point, hangs along -y) ──
  { const top = -LANTERN_DROP;
    g.tube(B.lantern, [0, 0, 0], [0, top, 0], 0.004, 0.004, 3, C.brass, { capA: false, capB: false });
    g.loft(B.lantern, [{ y: top, rx: 0.035, rz: 0.035 }, { y: top - 0.02, rx: 0.045, rz: 0.045 }], 6, C.brass, { capA: true });
    g.loft(B.lantern, [{ y: top - 0.02, rx: 0.055, rz: 0.055 }, { y: top - 0.075, rx: 0.088, rz: 0.088 }, { y: top - 0.15, rx: 0.088, rz: 0.088 }, { y: top - 0.2, rx: 0.06, rz: 0.06 }], 8, C.paper, { em: 1 });
    g.loft(B.lantern, [{ y: top - 0.2, rx: 0.045, rz: 0.045 }, { y: top - 0.225, rx: 0.035, rz: 0.035 }], 6, C.brass, { capB: true });
    g.box(B.lantern, [0, top - 0.245, 0], [0.012, 0.035, 0.012], C.scarf);
  }
  return { position: new Float32Array(g.p), color: new Float32Array(g.c), bone: new Float32Array(g.b), emit: new Float32Array(g.e), index: new Uint16Array(g.i), tris: g.i.length / 3 };
}
export const LANTERN_CENTER = -LANTERN_DROP - 0.11;    // y of the paper's centre in the lantern bone

// ── shaders ──
const VS = /* glsl */`
  uniform mat4 uBones[${BONES.length}];
  attribute vec3 aCol; attribute float aBone; attribute float aEmit;
  varying vec3 vW, vAlb; varying float vEmit, vDist;
  void main(){
    mat4 M = uBones[int(aBone + 0.5)];
    vec4 w = M * vec4(position, 1.0);
    vW = w.xyz; vAlb = aCol; vEmit = aEmit;
    vDist = length(vW - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const FS = /* glsl */`
  precision highp float;
  uniform sampler2D tLight; uniform vec4 uLightXf; uniform float uLightRange, uLightOn; uniform vec3 uLightFallback;
  uniform sampler2D tShadow; uniform mat4 uShadowM; uniform float uShadowOn, uSSize, uMoonOn;
  uniform vec3 uFog, uMoon, uMoonCol; uniform float uFogD, uAmb, uRim;
  uniform vec3 uLantern, uLanternCol; uniform float uLanternK, uFlicker;
  varying vec3 vW, vAlb; varying float vEmit, vDist;
  ${DN_DECL}
  ${DN_LAMP}
  uniform sampler2D tShadowS; uniform mat4 uShadowMS; uniform float uShadowOnS, uSSizeS;     // game hook: daynight
  #include <packing>
  vec3 groundLight(vec2 bxy){ if (uLightOn < 0.5) return uLightFallback; vec4 t = texture2D(tLight, (bxy - uLightXf.xy) * uLightXf.zw); return t.rgb * t.a * uLightRange; }
  float shTap(vec2 uv, float z){ return step(z, unpackRGBAToDepth(texture2D(tShadow, uv))); }
  float moonShadow(vec3 p){
    if (uShadowOn < 0.5) return 1.0;
    vec4 sc = uShadowM * vec4(p + vec3(0.0, 0.2, 0.0), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
    if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
    float z = q.z - 0.0006; vec2 t = q.xy * uSSize - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSize, o = vec2(1.0 / uSSize, 0.0);
    return mix(mix(shTap(b, z), shTap(b + o.xy, z), f.x), mix(shTap(b + o.yx, z), shTap(b + o.xx, z), f.x), f.y);
  }
  float sunShadow(vec3 p){
    if (uShadowOnS < 0.5) return 1.0;
    vec4 sc = uShadowMS * vec4(p + vec3(0.0, 0.2, 0.0), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
    if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
    float z = q.z - 0.0006; vec2 t = q.xy * uSSizeS - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSizeS, o = vec2(1.0 / uSSizeS, 0.0);
    float a0 = step(z, unpackRGBAToDepth(texture2D(tShadowS, b))), a1 = step(z, unpackRGBAToDepth(texture2D(tShadowS, b + o.xy))), a2 = step(z, unpackRGBAToDepth(texture2D(tShadowS, b + o.yx))), a3 = step(z, unpackRGBAToDepth(texture2D(tShadowS, b + o.xx)));
    return mix(mix(a0, a1, f.x), mix(a2, a3, f.x), f.y);
  }
  void main(){
    vec3 dx = dFdx(vW), dy = dFdy(vW); vec3 n = normalize(cross(dx, dy));
    vec3 V = normalize(cameraPosition - vW); if (dot(n, V) < 0.0) n = -n;
    vec3 gl = groundLight(vec2(vW.x, -vW.z));
    if (uDay > 0.0) gl *= dnLamp(vW.xz);                                                // game hook: daynight
    float hemi = 0.68 + 0.32 * n.y;
    float sh = uMoonOn > 0.5 ? moonShadow(vW) : 0.0;
    vec3 L = uLantern - vW; float d2 = dot(L, L); float ln = max(dot(n, L * inversesqrt(max(d2, 1e-4))), 0.0) * 0.75 + 0.25;
    vec3 lant = uLanternCol * uLanternK * uFlicker * ln / (0.05 + d2);
    vec3 light = gl * hemi * uAmb + uMoonCol * max(dot(n, uMoon), 0.0) * sh * uMoonOn + lant;
    if (uDay > 0.0) {                                                                    // game hook: daynight
      vec2 sf = normalize(uSunDir.xz + vec2(1e-5));
      float ss = uSunOn > 0.5 ? sunShadow(vW) : 0.0;
      light += uSunCol * (max(dot(n, uSunDir), 0.0) * ss) + mix(uAmbGnd, uAmbSky, n.y * 0.5 + 0.5) + uAmbGlow * max(dot(n, vec3(sf.x, 0.0, sf.y)), 0.0);
    }
    vec3 col = vAlb * light;
    float fr = 1.0 - max(dot(n, V), 0.0); fr = fr * fr * fr;
    col += fr * uRim * (gl * 0.7 + uMoonCol * 0.6 * uMoonOn + lant * 0.5) * (0.3 + 0.7 * vAlb);
    vec3 emit = vAlb * vEmit * uFlicker * 3.2;
    col += emit;
    float f = 1.0 - exp(-vDist * vDist * uFogD);
    col = mix(col, uFog, f);
    gl_FragColor = vec4(col, 1.0 + dot(emit, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - f));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// glow halo around the paper lantern (camera-facing, additive) and the light it throws on the ground
const HALO_VS = /* glsl */`
  uniform vec3 uLantern; uniform float uSize; varying vec2 vQ;
  void main(){ vec4 mv = viewMatrix * vec4(uLantern, 1.0); float d = max(-mv.z, 0.1); mv.xyz *= (d - min(0.3, d * 0.5)) / d; mv.xy += position.xy * uSize; vQ = position.xy; gl_Position = projectionMatrix * mv; }`;
const HALO_FS = /* glsl */`
  uniform vec3 uLanternCol; uniform float uFlicker; varying vec2 vQ;
  void main(){ float d2 = dot(vQ, vQ); if (d2 > 1.0) discard; vec3 c = uLanternCol * exp(-d2 * 5.0) * (1.0 - d2) * 0.42 * uFlicker; gl_FragColor = vec4(c, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const POOL_VS = /* glsl */`
  uniform vec3 uGround; uniform float uR; varying vec2 vQ;
  void main(){ vQ = position.xy; gl_Position = projectionMatrix * viewMatrix * vec4(uGround + vec3(position.x * uR, 0.03, position.y * uR), 1.0); }`;
const POOL_FS = /* glsl */`
  uniform vec3 uLanternCol; uniform float uFlicker, uPoolK; varying vec2 vQ;
  void main(){ float d2 = dot(vQ, vQ); if (d2 > 1.0) discard; vec3 c = uLanternCol * uPoolK * uFlicker * exp(-d2 * 3.2) * (1.0 - d2); gl_FragColor = vec4(c, 0.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const SHADOW_VS = /* glsl */`
  uniform vec3 uGround; uniform float uR; varying vec2 vQ;
  void main(){ vQ = position.xy; gl_Position = projectionMatrix * viewMatrix * vec4(uGround + vec3(position.x * uR, 0.025, position.y * uR), 1.0); }`;
const SHADOW_FS = /* glsl */`
  uniform float uShadowK; varying vec2 vQ;
  void main(){ float d2 = dot(vQ, vQ); if (d2 > 1.0) discard; float k = uShadowK * exp(-d2 * 3.0) * (1.0 - d2); gl_FragColor = vec4(vec3(1.0 - k), 1.0); }`;

// shared with fx/multiplayer/avatars.js (remote visitors drawn as Wick with the same shaders)
export const SHADERS = { VS, FS, HALO_VS, HALO_FS, POOL_VS, POOL_FS, SHADOW_VS, SHADOW_FS };

export function createCharacter({ THREE, scene, surface, guests, manifest }) {
  const d = buildCharacterGeometry();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(d.color, 3));
  geo.setAttribute('aBone', new THREE.BufferAttribute(d.bone, 1));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(d.emit, 1));
  geo.setIndex(new THREE.BufferAttribute(d.index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const bones = Array.from({ length: BONES.length }, () => new THREE.Matrix4());
  const gU = guests && guests.uniforms;
  const fallbackLight = new THREE.DataTexture(new Uint8Array([40, 36, 52, 2]), 1, 1); fallbackLight.needsUpdate = true;
  const U = {
    uBones: { value: bones },
    tLight: gU ? gU.tLight : { value: fallbackLight }, uLightXf: gU ? gU.uLightXf : { value: new THREE.Vector4(0, 0, 1, 1) }, uLightRange: gU ? gU.uLightRange : { value: manifest.range || 32 },
    uLightOn: gU ? gU.uLightOn : { value: 0 }, uLightFallback: { value: new THREE.Vector3(0.05, 0.045, 0.065) },
    tShadow: surface.uniforms.tShadow, uShadowM: surface.uniforms.uShadowM, uShadowOn: surface.uniforms.uShadowOn, uSSize: surface.uniforms.uSSize,
    uMoonOn: surface.uniforms.uMoonOn, uMoon: surface.uniforms.uMoon, uMoonCol: surface.uniforms.uMoonCol, uFog: surface.uniforms.uFog, uFogD: surface.uniforms.uFogD,
    uAmb: { value: 1.6 }, uRim: { value: 0.55 },
    ...(surface.dn || {}), tShadowS: surface.uniforms.tShadowS, uShadowMS: surface.uniforms.uShadowMS, uShadowOnS: surface.uniforms.uShadowOnS, uSSizeS: surface.uniforms.uSSizeS,     // game hook: daynight
    uLantern: { value: new THREE.Vector3() }, uLanternCol: { value: new THREE.Vector3(1.0, 0.62, 0.28) }, uLanternK: { value: 0.11 }, uFlicker: { value: 1 },
    uSize: { value: 0.3 }, uGround: { value: new THREE.Vector3() }, uR: { value: 2.6 }, uPoolK: { value: 0.07 }, uShadowK: { value: 0.55 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VS, fragmentShader: FS });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.name = 'pf-character'; mesh.matrixAutoUpdate = false;
  const quad = () => { const q = new THREE.BufferGeometry(); q.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); q.setIndex([0, 1, 2, 0, 2, 3]); q.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); return q; };
  const add = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, transparent: true, depthWrite: false };
  const haloMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: HALO_VS, fragmentShader: HALO_FS, ...add }); haloMat.userData.glowMarked = true;
  const halo = new THREE.Mesh(quad(), haloMat); halo.frustumCulled = false; halo.renderOrder = 9; halo.matrixAutoUpdate = false;
  const poolMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: POOL_VS, fragmentShader: POOL_FS, ...add, blendSrcAlpha: THREE.ZeroFactor });
  const pool = new THREE.Mesh(quad(), poolMat); pool.frustumCulled = false; pool.renderOrder = 3; pool.matrixAutoUpdate = false;
  const shadowMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS, transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const shadow = new THREE.Mesh(quad(), shadowMat); shadow.frustumCulled = false; shadow.renderOrder = 2; shadow.matrixAutoUpdate = false;
  const group = new THREE.Group(); group.name = 'platformer'; group.add(mesh, shadow, pool, halo); group.visible = false; scene.add(group);
  return { group, mesh, uniforms: U, bones, tris: d.tris,
    setVisible(v) { group.visible = v; },
    dispose() { scene.remove(group); geo.dispose(); for (const o of [halo, pool, shadow]) o.geometry.dispose(); for (const m of [mat, haloMat, poolMat, shadowMat]) m.dispose(); fallbackLight.dispose(); } };
}
