// 6. The lake bed: a sunken carousel horse with a faint glow, some way out from the Rosewick shore. Only a faint shimmer on the surface
// above it gives it away. Found by diving (Wick) within a few metres of it.
import { partsBuilder } from './figure.js';

const POS = [-37.8, -35.7];            // about 20 m out from the shore below Rosewick (the shore is at r = 72.7 toward -137 degrees)
const BED = -4.8, SURF = -0.8;
const FOUND_R = 3.4;

export function init(S) {
  const { game, THREE } = S;
  const [x, y] = POS, g3 = new THREE.Group(); game.v3(x, y, BED, g3.position); game.scene.add(g3);

  /* the horse, tipped over on its side and half silted in: cream paint, a brass pole, gold mane */
  const { add, finish } = partsBuilder(THREE);
  const cream = [0.6, 0.52, 0.4], gold = [0.8, 0.55, 0.15], dark = [0.2, 0.17, 0.14];
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d), cyl = (a, b, h, n) => new THREE.CylinderGeometry(a, b, h, n);
  add(box(0.95, 0.4, 0.34), cream, 0, 0.62, 0);                                    // barrel
  add(new THREE.IcosahedronGeometry(0.22, 0), cream, 0.5, 0.64, 0, { sy: 1.1 });   // chest
  add(new THREE.IcosahedronGeometry(0.22, 0), cream, -0.5, 0.62, 0, { sy: 1.0 });  // rump
  add(box(0.22, 0.62, 0.22), cream, 0.66, 0.98, 0, { rz: -0.35 });                // neck
  add(box(0.44, 0.2, 0.2), cream, 0.92, 1.3, 0, { rz: -0.25 });                    // head
  add(box(0.1, 0.16, 0.05), cream, 0.8, 1.45, 0.07); add(box(0.1, 0.16, 0.05), cream, 0.8, 1.45, -0.07);   // ears
  add(box(0.08, 0.6, 0.06), gold, 0.58, 1.0, 0, { rz: -0.35 });                    // mane
  add(box(0.25, 0.14, 0.34), gold, 0.15, 0.85, 0);                                  // saddle
  for (const [lx, lz, rz] of [[0.4, 0.14, 0.5], [0.4, -0.14, -0.3], [-0.4, 0.14, -0.4], [-0.4, -0.14, 0.4]]) add(cyl(0.05, 0.04, 0.62, 6), cream, lx, 0.25, lz, { rz: rz * 0.5 });    // legs, one bent each way
  add(cyl(0.035, 0.035, 3.0, 6), gold, 0.1, 1.3, 0, { rz: 0.1 });                  // the pole, still standing
  add(box(0.5, 0.06, 0.5), dark, 0.1, -0.1, 0);                                     // a plank of the platform
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(0.38, 0.62, 0.7), fog: false });
  const horse = new THREE.Mesh(finish(), mat); horse.rotation.set(0, 0.7, 1.35); horse.position.y = -0.28; g3.add(horse);
  const glow = game.props.glow({ x, y, z: BED + 0.7, color: [0.08, 0.32, 0.36], size: 3.6 });

  /* the shimmer: a soft ring of sparkles on the surface, additive, barely there */
  const sm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uT: game.uTime ? game.uTime : { value: 0 }, uK: { value: 1 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vP; uniform float uT, uK;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        float r = length(vP), f = smoothstep(2.1, 0.3, r);
        float ring = 0.5 + 0.5 * sin(r * 9.0 - uT * 1.4);
        vec2 q = vP * 4.0, c = floor(q), j = vec2(h(c + 1.7), h(c + 9.1)) * 0.5 + 0.25;
        float dot_ = smoothstep(0.17, 0.0, length(fract(q) - j)) * step(0.6, h(c)) * (0.5 + 0.5 * sin(uT * 2.2 + h(c + 3.0) * 6.28));
        float a = f * (0.09 * ring + 1.0 * dot_ * f) * uK;
        gl_FragColor = vec4(vec3(0.55, 0.85, 0.95) * a, a);
      }`,
  });
  const shim = new THREE.Mesh(new THREE.CircleGeometry(2.2, 28), sm); shim.rotation.x = -Math.PI / 2; game.v3(x, y, SURF + 0.03, shim.position); shim.renderOrder = 7; shim.frustumCulled = false; game.scene.add(shim);
  let t = 0;
  game.on('frame', ({ dt }) => {
    t += dt;
    const p = game.player, near = Math.hypot(p.x - x, p.y - y);
    glow.set({ color: [0.07 + 0.02 * Math.sin(t * 1.3), 0.3 + 0.05 * Math.sin(t * 1.3), 0.34 + 0.05 * Math.sin(t * 1.3)] });
    sm.uniforms.uK.value = game.reduceMotion ? 0.7 : 1; if (!game.uTime) sm.uniforms.uT.value = t;
    if (!S.isFound('lakebed') && p.mode === 'walk' && p.wick && p.z < SURF - 1.2 && near < FOUND_R && Math.abs(p.z + 1 - BED) < 4) S.found('lakebed');
  });
  return { pos: [x, y, BED], horse, shim };
}
