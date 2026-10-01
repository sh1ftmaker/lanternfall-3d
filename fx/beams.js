// Visible light in the night air, as cheap additive cones (no ray-marching, no depth texture):
//  - the Brinewatch harbour light (lake, Blender (49.7, -10.3, 11.8)) sweeps a lighthouse beam pair over Stillwater
//  - two searchlights on Meridian's launch beacon (Blender (61.7, 145.6, 44.1)) sway across the sky for the Neon Run
// Each beam is an open cone; brightness falls off along its length and towards its silhouette (view-angle term),
// with slow drifting "dust" so the beam reads as lit haze. Ideas from webgl_postprocessing_godrays /
// webgpu_volumetric_lighting, reduced to geometry: one draw per beam, a few hundred triangles.
import * as THREE from 'three';

function beamMaterial(color, strength, uTime) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime, uColor: { value: new THREE.Color(...color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */`
      varying float vAlong; varying vec3 vN, vV, vW;
      void main(){ vAlong = position.y; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z)); vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uStrength; uniform vec3 uColor; varying float vAlong; varying vec3 vN, vV, vW;
      float h1(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h1(i), h1(i + vec3(1,0,0)), f.x), mix(h1(i + vec3(0,1,0)), h1(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h1(i + vec3(0,0,1)), h1(i + vec3(1,0,1)), f.x), mix(h1(i + vec3(0,1,1)), h1(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        float along = clamp(vAlong, 0.0, 1.0);
        float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.5);    // brightest through the beam's middle
        edge = 1.0 - edge;
        float fall = pow(1.0 - along, 2.2) * smoothstep(0.0, 0.03, along);
        float dust = 0.65 + 0.35 * vnoise(vW * 0.08 + vec3(uTime * 0.2, 0.0, uTime * 0.1));
        vec3 c = uColor * uStrength * edge * fall * dust;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}
function cone(len, r0, r1) {   // unit "along" in position.y (0 at the lamp, 1 at the far end), scaled by the mesh
  const g = new THREE.CylinderGeometry(r1, r0, 1, 24, 8, true);
  g.translate(0, 0.5, 0);
  const m = new THREE.Mesh(g); m.scale.set(1, len, 1);
  return m;
}

export function buildBeams({ uTime, motion = 1 }) {
  const root = new THREE.Group(); root.name = 'fx-beams';
  // harbour lighthouse: two opposite beams, one turn per 14 s
  const harbour = new THREE.Group(); harbour.position.set(49.7, 11.9, 10.3);
  const hm = beamMaterial([1.0, 0.82, 0.55], 0.20, uTime);
  for (const s of [1, -1]) {
    const b = cone(150, 0.35, 7.5); b.material = hm; b.rotation.z = -Math.PI / 2 * s + s * 0.05; b.frustumCulled = false;
    harbour.add(b);
  }
  root.add(harbour);
  // Meridian searchlights: two beams swaying up into the sky
  const mer = new THREE.Group(); mer.position.set(61.7, 44.6, -145.6);
  const sm = [beamMaterial([0.45, 1.0, 0.92], 0.07, uTime), beamMaterial([0.95, 0.5, 1.0], 0.07, uTime)];
  const lights = sm.map((m) => { const b = cone(260, 0.3, 9); b.material = m; b.frustumCulled = false; const p = new THREE.Group(); p.add(b); mer.add(p); return p; });
  root.add(mer);
  root.userData.update = (t) => {
    const tt = t * motion;
    harbour.rotation.y = tt * (Math.PI * 2 / 14);
    lights.forEach((p, i) => {
      const ph = tt * 0.23 + i * 2.6;
      p.rotation.set(0.42 * Math.sin(ph) + (i ? 0.25 : -0.25), tt * 0.11 * (i ? 1 : -1) + i * 1.9, 0.0, 'YXZ');
      p.rotation.x = 0.30 + 0.25 * Math.sin(ph * 1.3);
      p.rotation.z = 0.35 * Math.cos(ph) * (i ? 1 : -1);
    });
  };
  root.userData.update(0);
  return root;
}
