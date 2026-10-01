// Small local emitters at spots found in the Blender dumps (materials `*_steam`, `*_flame`, objects
// `brinewatch_smokehouse`, `guildhollow_smithy`; triangle centroids clustered, converted to three coordinates):
//  - steam curling off Lantern Row's dumpling stalls and Frostmere's cider kettles
//  - chimney smoke from the Brinewatch smokehouse and the Guildhollow smithy, leaning with the breeze
//  - flicker halos + rising embers on Guildhollow's braziers/torches and Lantern Row's shrine flames
// One THREE.Points draw (~1k sprites). Steam/smoke are premultiplied "over" puffs, flames/embers are additive
// (alpha 0 under ONE / ONE_MINUS_SRC_ALPHA blending).
import * as THREE from 'three';

const FLAME = [[-195.0,1.6,9.5],[-195.0,1.6,-9.5],[-196.5,1.6,24.0],[-196.5,1.6,-24.0],[-180.2,1.4,45.9],[-181.1,1.2,45.5],[-171.0,3.1,17.0],[-190.0,3.1,40.0],[-186.0,3.1,17.0],[-171.5,3.1,43.5],[-175.5,4.1,-22.5],[-175.5,4.1,-41.5],[-190.5,4.1,-22.5],[-190.5,4.1,-41.5],[-108.5,1.6,8.5],[-108.5,1.6,-8.5],[-207.5,1.6,26.0],[-207.5,1.6,-26.0],[-213.5,1.6,-0.0],[-201.5,5.6,33.6],[-201.5,5.6,25.1],[-201.5,5.6,16.6],[-201.5,5.6,8.1],[-201.5,5.6,-12.4],[-201.5,5.6,-20.9],[-201.5,5.6,-29.4],[-201.5,5.6,-37.9],[-200.7,5.3,3.2],[-200.2,5.5,8.2],[-200.7,5.3,-3.2],[-200.2,5.5,-8.2],[-165.1,4.1,4.0],[-165.1,4.1,-4.0],[-168.8,3.8,31.3],[-168.8,3.8,25.7],[-180.7,3.8,-22.1],[-185.3,3.8,-22.1],[-165.9,3.8,-23.9],[-165.9,3.8,-29.1],[-154.4,4.2,-3.2],[-154.4,4.2,3.2],[46.7,1.6,130.8],[52.3,1.3,148.5],[35.2,1.6,134.4],[50.7,1.6,143.8],[39.2,1.6,147.3],[51.8,1.6,147.4],[40.3,1.6,151.0],[49.8,1.7,120.5],[25.9,1.7,124.6],[40.5,1.3,152.1],[52.6,3.5,156.8],[44.9,3.5,159.1],[53.5,3.5,159.6],[45.8,3.5,162.0],[90.4,4.3,150.3],[77.0,4.3,154.5],[94.5,4.3,163.7],[81.1,4.3,167.8],[37.4,1.2,107.0],[29.4,1.2,109.5],[35.7,1.2,101.3],[27.6,1.2,103.8],[33.9,1.2,95.5],[25.9,1.2,98.0],[29.2,1.2,80.3],[21.1,1.2,82.7],[27.4,1.2,74.5],[19.4,1.2,77.0]];
const STEAM = [[45.9,2.6,67.2],[37.5,2.6,70.7],[31.7,2.6,72.1],[13.2,2.6,73.1],[-6.4,2.6,70.8],[34.6,2.6,139.5],[24.3,2.6,148.5],[9.4,2.6,153.1],[-10.0,2.6,153.3],[-20.5,2.6,162.3],[-11.6,2.6,131.6],[-3.7,2.6,137.5],[-8.0,2.6,143.1],[17.9,2.6,166.6],[-1.6,2.6,172.7],[-21.1,2.6,178.7],[13.1,2.6,174.0],[0.1,2.6,178.0],[-32.2,2.6,188.7],[10.3,2.6,176.3],[-18.9,2.6,185.3],[-32.3,2.6,190.0],[5.5,2.6,183.7],[-17.3,2.6,190.8],[9.1,2.6,184.0],[-13.6,2.6,191.1],[10.7,2.6,189.3],[-2.2,2.6,193.4],[-120.6,3.1,-89.7],[-119.4,3.1,-91.0]];
const SMOKE = [[168.7,9.8,119.2],[-180.4,9.0,46.7]];

export function buildEmitters({ uTime, motion = 1, scale = 1 }) {
  const rows = [];                       // x y z kind seed
  const PS = Math.max(4, Math.round(12 * scale)), PK = Math.max(10, Math.round(36 * scale)), PE = Math.max(1, Math.round(4 * scale));
  for (const p of STEAM) for (let i = 0; i < PS; i++) rows.push([...p, 0, (i + 0.5) / PS]);
  for (const p of SMOKE) for (let i = 0; i < PK; i++) rows.push([...p, 1, (i + 0.5) / PK]);
  for (const p of FLAME) { rows.push([...p, 2, Math.random()]); for (let i = 0; i < PE; i++) rows.push([...p, 3, (i + 0.5) / PE]); }
  const n = rows.length, pos = new Float32Array(n * 3), aux = new Float32Array(n * 2);
  rows.forEach((r, i) => { pos.set(r.slice(0, 3), i * 3); aux.set([r[3], r[4]], i * 2); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAux', new THREE.BufferAttribute(aux, 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uMotion: { value: motion }, uScale: { value: 500 }, uGain: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec2 aAux; uniform float uTime, uMotion, uScale, uGain;
      varying vec4 vC; varying float vKind, vSoft;
      float hh(float n){ return fract(sin(n) * 43758.5453); }
      void main(){
        float kind = aAux.x, sd = aAux.y;
        float t = uTime * uMotion + hh(dot(position.xz, vec2(1.7, 9.2))) * 40.0;
        vec3 p = position; float size; vec4 c; float soft = 1.0;
        float idh = hh(sd * 71.3 + position.x);
        if (kind == 0.0) {                     // steam: 3.5 s puffs rising and widening
          float u = fract(t / 3.5 + sd);
          p += vec3((idh - 0.5) * 0.6 + sin(u * 4.0 + sd * 20.0) * 0.25 * u, u * 2.1, (hh(idh) - 0.5) * 0.6 + 0.35 * u);
          size = mix(0.35, 1.5, u);
          float a = smoothstep(0.0, 0.15, u) * (1.0 - smoothstep(0.45, 1.0, u)) * 0.38;
          c = vec4(vec3(0.95, 0.86, 0.78) * a, a);
        } else if (kind == 1.0) {              // chimney smoke: slow, long, leaning downwind
          float u = fract(t / 14.0 + sd);
          p += vec3(u * u * 9.0 + sin(u * 6.0 + sd * 30.0) * 0.6, u * 11.0, u * 3.0 + cos(u * 5.0 + sd * 17.0) * 0.6);
          size = mix(0.7, 4.8, sqrt(u));
          float a = smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.35, 1.0, u)) * 0.30;
          c = vec4(vec3(0.075, 0.075, 0.09) * a, a);
        } else if (kind == 2.0) {              // flame halo: flickers like the fire under it
          float f = 0.65 + 0.2 * sin(t * 13.0 + sd * 40.0) + 0.15 * sin(t * 23.0 + sd * 13.0);
          p.y += 0.35;
          size = 2.0 * (0.9 + 0.1 * f);
          c = vec4(vec3(1.0, 0.45, 0.12) * 0.40 * f, 0.0);
          soft = 0.0;
        } else {                               // embers
          float u = fract(t / 1.8 + sd + idh * 0.3);
          p += vec3(sin(u * 7.0 + idh * 30.0) * 0.25 * u, 0.25 + u * 2.2, cos(u * 6.0 + idh * 20.0) * 0.25 * u);
          size = 0.06;
          float a = (1.0 - u) * (0.6 + 0.4 * sin(t * 30.0 + idh * 50.0));
          c = vec4(vec3(1.0, 0.5, 0.15) * 3.0 * a, 0.0);
          soft = -1.0;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = max(-mv.z, 0.05);
        float px = size * uScale / d, sz = max(px, kind == 3.0 ? 1.5 : 1.0);
        vC = c * min(1.0, px * px / (sz * sz)) * smoothstep(0.5, 2.0, d) * uGain;
        vKind = kind; vSoft = soft;
        gl_PointSize = min(sz, 256.0);
        gl_Position = projectionMatrix * mv;
        if (px < 0.15 || vC.r + vC.a < 1e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec4 vC; varying float vKind, vSoft;
      void main(){
        vec2 q = gl_PointCoord - 0.5; float d = length(q);
        float m = vSoft > 0.5 ? smoothstep(0.5, 0.05, d) : vSoft < -0.5 ? smoothstep(0.5, 0.1, d) : exp(-d * d * 18.0) * smoothstep(0.5, 0.35, d);
        if (vSoft > 0.5) m *= 0.75 + 0.25 * sin(q.x * 9.0 + q.y * 7.0 + vKind);    // a little lumpiness
        if (m < 0.004) discard;
        gl_FragColor = vC * m;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 6;
  pts.onBeforeRender = (r, sc, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
  return pts;
}
