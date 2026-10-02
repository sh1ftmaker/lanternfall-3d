// A small seated figure, faceted like the park's guests (a 1.72 m adult, simple blocks and prisms, no textures), as one merged geometry.
// Built facing +x with y up and the origin at the seat (between the hips). Vertex colour carries the shading; `aTone` marks the parts the
// instance colour tints (the coat), so one InstancedMesh gives each rider their own coat.
// The guests' own figures live in fx/guests/assets.js (a skinned "uber" mesh); this is a cheap static stand-in in the same proportions
// (head about 0.2 m, shoulders about 0.4 m, seat to crown about 0.88 m).
import * as THREE from 'three';

const LIGHT = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
const TROUSERS = ['#2b3346', '#3d3a36', '#4a3a2c', '#25302b'];
export const COATS = ['#8a2f45', '#2f6f78', '#c28a2c', '#2c3f7a', '#6b3f7a', '#3e6b3c', '#b8532f', '#d0c7b4'];

export function buildFigure(variant = 0) {
  const pos = [], col = [], tone = [];
  const c = new THREE.Color();
  const push = (a, b, cc, d, color, t) => {       // a quad, wound so that the normal faces away from the shape's centre (given by caller via order)
    const n = new THREE.Vector3().subVectors(cc, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    const sh = 0.58 + 0.42 * Math.max(0, n.dot(LIGHT)) - (n.y < -0.5 ? 0.15 : 0);
    c.set(color);
    for (const v of [a, b, cc, a, cc, d]) { pos.push(v.x, v.y, v.z); col.push(c.r * sh, c.g * sh, c.b * sh); tone.push(t); }
  };
  // a prism/frustum between two rings of `n` points (ring centres p0, p1; radii r0, r1 in the two axes u, v)
  const prism = (p0, p1, u, v, r0, r1, n, color, t = 0, scale = [1, 1]) => {
    const ring = (p, r) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + Math.PI / n; return p.clone().addScaledVector(u, Math.cos(a) * r * scale[0]).addScaledVector(v, Math.sin(a) * r * scale[1]); });
    const A = ring(p0, r0), B = ring(p1, r1);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; push(A[i], A[j], B[j], B[i], color, t); }
    for (const [R, p, flip] of [[B, p1, 0], [A, p0, 1]]) for (let i = 1; i + 1 < n; i++) { const tri = flip ? [R[0], R[i + 1], R[i]] : [R[0], R[i], R[i + 1]]; push(tri[0], tri[1], tri[2], tri[2], color, t); }
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1);
  // a limb: 4-sided prism from p0 to p1, thickness w0 -> w1
  const limb = (p0, p1, w0, w1, color, t = 0) => {
    const ax = new THREE.Vector3().subVectors(p1, p0).normalize(), u = new THREE.Vector3().crossVectors(ax, Z).normalize(), v = new THREE.Vector3().crossVectors(ax, u).normalize();
    prism(p0, p1, u, v, w0 * 0.7071, w1 * 0.7071, 4, color, t);
  };
  const skin = '#b97d5c', hair = '#6a4a30', trousers = TROUSERS[(variant * 5) % TROUSERS.length];
  const white = '#ffffff';
  // legs astride the horse: thigh out and forward, shin down; shoes
  for (const s of [-1, 1]) {
    limb(V(0, 0.07, s * 0.1), V(0.24, -0.1, s * 0.2), 0.15, 0.12, trousers);
    limb(V(0.24, -0.1, s * 0.2), V(0.2, -0.46, s * 0.23), 0.11, 0.09, trousers);
    limb(V(0.19, -0.5, s * 0.23), V(0.33, -0.52, s * 0.23), 0.1, 0.1, '#241d1a');
  }
  prism(V(0, 0.04, 0), V(0, 0.2, 0), X, Z, 0.17, 0.17, 6, trousers, 0, [1, 1.1]);          // hips
  prism(V(0, 0.2, 0), V(0.01, 0.6, 0), X, Z, 0.17, 0.16, 6, white, 1, [1, 1.3]);           // coat
  prism(V(0.01, 0.6, 0), V(0.01, 0.66, 0), X, Z, 0.15, 0.07, 6, white, 1, [0.9, 1.5]);      // shoulders
  prism(V(0.015, 0.64, 0), V(0.02, 0.7, 0), X, Z, 0.05, 0.05, 6, skin, 2);                     // neck
  // arms forward to the pole
  for (const s of [-1, 1]) {
    limb(V(0, 0.57, s * 0.24), V(0.17, 0.4, s * 0.25), 0.1, 0.085, white, 1);
    limb(V(0.17, 0.4, s * 0.25), V(0.34, 0.42, s * 0.17), 0.08, 0.07, white, 1);
    limb(V(0.34, 0.42, s * 0.17), V(0.39, 0.42, s * 0.14), 0.07, 0.07, skin, 2);
  }
  prism(V(0.025, 0.69, 0), V(0.03, 0.88, 0), X, Z, 0.1, 0.095, 6, skin, 2, [1, 0.95]);       // head
  prism(V(0.015, 0.8, 0), V(0.015, 0.92, 0), X, Z, 0.108, 0.09, 6, hair, 3, [1.02, 0.98]);   // hair
  prism(V(-0.07, 0.72, 0), V(-0.07, 0.88, 0), X, Z, 0.07, 0.07, 6, hair, 3, [1, 1.1]);       // back of the head
  limb(V(0.12, 0.77, 0), V(0.15, 0.76, 0), 0.04, 0.03, skin, 2);                                // nose: tells front from back
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('aTone', new THREE.Float32BufferAttribute(tone, 1));
  return g;
}

// per instance: instanceColor tints the coat; aVar = (skin brightness, hair brightness)
export function figureMaterial() {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'attribute float aTone; attribute vec2 aVar;\nvoid main() {')
      .replace('#include <color_vertex>', `vColor = vec4( color.rgb, 1.0 );
      #ifdef USE_INSTANCING_COLOR
        if (aTone > 0.5 && aTone < 1.5) vColor.rgb *= instanceColor.rgb; else if (aTone > 1.5 && aTone < 2.5) vColor.rgb *= aVar.x; else if (aTone > 2.5) vColor.rgb *= aVar.y;
      #endif`);
  };
  return m;
}
