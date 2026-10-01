// Low mist lying on Stillwater: three stacked translucent sheets on the lake polygon with drifting fbm, denser at
// grazing view angles (more mist along the line of sight), faded out near the eye, tinted warm where the floating
// lanterns and the Spire light it from below and cool moonlit blue elsewhere. Cheap stand-in for a sliced fog
// volume (webgl_volume_cloud / webgpu_volume_cloud ray-march), a few ALU per pixel and three draws.
import * as THREE from 'three';

export function buildMist({ lake, waterY, uTime, motion = 1, layers = 3 }) {
  const shape = new THREE.Shape(lake.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ShapeGeometry(shape, 4);
  geo.rotateX(-Math.PI / 2);                     // Blender (x, y) -> three (x, 0, -y)
  const grp = new THREE.Group(); grp.name = 'fx-mist';
  const uDensity = { value: 1.5 };
  for (let i = 0; i < layers; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uMotion: { value: motion }, uLayer: { value: i }, uDensity },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uMotion, uLayer, uDensity; varying vec3 vW;
        float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.07 + 7.3; a *= 0.5; } return s; }
        void main(){
          float t = uTime * uMotion;
          vec2 p = vW.xz * 0.045 + vec2(t * 0.012, t * 0.006) * (1.0 + uLayer * 0.4) + uLayer * 3.7;
          float n = fbm(p);
          n = smoothstep(0.35, 0.8, n + 0.15 * sin(t * 0.07 + uLayer));
          vec3 v = cameraPosition - vW; float dist = length(v);
          float graze = clamp(0.12 / max(abs(v.y) / dist, 0.02), 0.0, 3.0);
          float a = n * 0.2 * graze * smoothstep(3.0, 30.0, dist) * (1.0 - 0.35 * uLayer) * uDensity;
          a = min(a, 0.5);
          float r = length(vW.xz);
          vec3 warm = vec3(0.10, 0.060, 0.025) * (0.5 + 0.5 * smoothstep(90.0, 20.0, r)) + vec3(0.09, 0.07, 0.04) * exp(-r * 0.06);
          vec3 c = mix(vec3(0.075, 0.085, 0.15), warm * 2.2, 0.6);
          gl_FragColor = vec4(c * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = waterY + 0.35 + i * 0.85; m.renderOrder = 4 + i * 0.01;
    grp.add(m);
  }
  grp.userData.density = uDensity;
  return grp;
}
