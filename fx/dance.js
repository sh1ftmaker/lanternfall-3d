// Signal Plaza's dance floor "that lights up underfoot": an LED-tile overlay laid 1.5 cm over the baked floor
// (material `meridian_dance`: centre Blender (18.96, 146.18), 18.1 x 12.2 m, axes from a PCA of its triangles),
// cycling through ripple / sweep / checker patterns. One quad, one draw.
import * as THREE from 'three';

const C = [18.959, 146.183], U = [-0.95259, 0.30427], V = [-0.30427, -0.95259], HU = 9.05, HV = 6.09, Y = 0.262;

export function buildDanceFloor({ uTime, motion = 1 }) {
  const corner = (a, b) => { const x = C[0] + a * U[0] + b * V[0], y = C[1] + a * U[1] + b * V[1]; return [x, Y, -y]; };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...corner(-HU, -HV), ...corner(HU, -HV), ...corner(HU, HV), ...corner(-HU, HV)]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([-HU, -HV, HU, -HV, HU, HV, -HU, HV]), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uMotion: { value: motion }, uGain: { value: 1 } },
    vertexShader: `varying vec2 vUv; varying float vDist; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uMotion, uGain; varying vec2 vUv; varying float vDist;
      vec3 hue(float h){ return clamp(abs(fract(h + vec3(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
      void main(){
        float t = uTime * uMotion;
        vec2 cell = vec2(${(2 * HU / 18).toFixed(4)}, ${(2 * HV / 12).toFixed(4)});
        vec2 id = floor((vUv + vec2(${HU}, ${HV})) / cell), f = fract((vUv + vec2(${HU}, ${HV})) / cell);
        vec2 c = id - vec2(8.5, 5.5);
        float mode = mod(floor(t / 9.0), 3.0), beat = fract(t * 2.0);
        float v; float h;
        if (mode < 0.5) { float r = length(c); v = 0.5 + 0.5 * sin(r * 1.1 - t * 4.0); h = r * 0.04 + t * 0.05; }
        else if (mode < 1.5) { v = smoothstep(0.6, 1.0, sin((c.x + c.y) * 0.6 - t * 5.0) * 0.5 + 0.5); h = (c.x - c.y) * 0.03 + t * 0.07 + 0.3; }
        else { float k = mod(id.x + id.y + floor(t * 2.0), 2.0); v = mix(0.25, 1.0, k) * (1.0 - 0.5 * beat); h = floor(t * 2.0) * 0.17 + id.y * 0.02; }
        float grout = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x) * smoothstep(0.0, 0.06, f.y) * smoothstep(1.0, 0.94, f.y);
        vec3 col = mix(vec3(0.02, 0.02, 0.03), (0.15 + 1.1 * v) * mix(vec3(1.0), hue(h), 0.85), grout) * uGain;
        col = mix(col, vec3(0.016, 0.018, 0.046), 1.0 - exp(-vDist * vDist * 2.4e-7));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(g, mat); m.name = 'fx-dance';
  return m;
}
