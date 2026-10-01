// Moving park hardware inside the baked, merged meshes: vertices inside a region are transformed in the vertex
// shader (world space), on a material variant used only by the few chunk meshes that overlap the region, so the
// rest of the park pays nothing. Baked lighting moves with the geometry, which is fine for symmetric rides.
//  - carousel: the Pavilion of Wings (Rosewick, land-local (0, 26)) turns, horses rise and fall.
import * as THREE from 'three';

// Rosewick land-local (0, 26) in three coordinates (Blender (-135.04, -125.18) -> three (x, -y)).
const CAROUSEL = { x: -135.04, z: 125.18, r: 10.65, y0: 0.5 };

const GLSL = /* glsl */`
  uniform float uFxTime; uniform float uFxMotion;
  vec3 fxAnim(vec3 w){
    // Pavilion of Wings: everything above the terrace within the canopy radius turns (one turn per ~26 s)
    vec2 d = w.xz - vec2(${CAROUSEL.x.toFixed(2)}, ${CAROUSEL.z.toFixed(2)});
    float r = length(d);
    if (r < ${CAROUSEL.r.toFixed(2)} && w.y > ${CAROUSEL.y0.toFixed(2)}) {
      float a0 = atan(d.y, d.x);
      // horses ride up and down: outer ring 16 at 22.5 deg, inner ring 12 at 30 deg (angles in Blender frame = -a0)
      if (w.y > 1.1 && w.y < 3.75 && r > 5.2 && r < 9.0) {
        float ab = degrees(-a0);
        float k = r > 7.2 ? floor((ab + 0.8) / 22.5 + 0.5) : floor((ab + 7.9) / 30.0 + 0.5) + 0.5;
        w.y += 0.22 * sin(uFxTime * 1.7 + k * 2.4) * uFxMotion;
      }
      float a = a0 + uFxTime * 0.24 * uFxMotion;
      w.xz = vec2(${CAROUSEL.x.toFixed(2)}, ${CAROUSEL.z.toFixed(2)}) + r * vec2(cos(a), sin(a));
    }
    return w;
  }
`;

const variants = new Map();
function variant(base, uFx) {
  if (variants.has(base)) return variants.get(base);
  const re = /modelViewMatrix\s*\*\s*vec4\(\s*position\s*,\s*1\.0\s*\)/;
  if (!re.test(base.vertexShader)) { variants.set(base, null); return null; }
  // a sibling material that shares the base uniform objects (fog, range, moon shadow map...); not clone(), which would
  // try to copy the uniforms' textures
  const m = new THREE.ShaderMaterial({ uniforms: { ...base.uniforms, ...uFx }, fragmentShader: base.fragmentShader, side: base.side,
    transparent: base.transparent, depthWrite: base.depthWrite, defines: { ...base.defines } });
  Object.assign(m.defaultAttributeValues, base.defaultAttributeValues);
  m.vertexShader = base.vertexShader.replace(/void\s+main\s*\(/, GLSL + '\nvoid main(').replace(re, 'viewMatrix * vec4(fxAnim((modelMatrix * vec4(position, 1.0)).xyz), 1.0)');
  variants.set(base, m); return m;
}

export function buildAnimated({ park, uTime, motion = 1 }) {
  const uFx = { uFxTime: uTime, uFxMotion: { value: motion } };
  const box = new THREE.Box3(), cyl = new THREE.Box3(new THREE.Vector3(CAROUSEL.x - CAROUSEL.r, 0, CAROUSEL.z - CAROUSEL.r), new THREE.Vector3(CAROUSEL.x + CAROUSEL.r, 40, CAROUSEL.z + CAROUSEL.r));
  let n = 0;
  park.traverse((o) => {
    if (!o.isMesh || !o.geometry.boundingBox) return;
    box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    if (!box.intersectsBox(cyl)) return;
    const v = variant(o.material, uFx); if (!v) return;
    o.material = v; n++;
  });
  return { meshes: n, uniforms: uFx };
}
