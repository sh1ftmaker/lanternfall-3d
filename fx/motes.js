// Air that moves: snow over Frostmere Keep ("always the first night of winter"), cherry-blossom petals drifting
// through Rosewick Gardens and Lantern Row, fireflies over Rosewick's lawns and the green gaps between the lands.
// One THREE.Points draw call. Particles live in two world-anchored, wrapping boxes that follow the camera
// (webgl_points_sprites-style procedural sprites; the wrap trick keeps them fixed in the world as the camera moves):
//   near layer: small box around the eye, dense (what you walk through);
//   far layer:  big box pushed ahead of the camera, sparse, so the tour's land shots see the weather too.
// What a particle *is* comes from where it is (land sector from the polar angle), so it costs nothing to add zones.
import * as THREE from 'three';

export function buildMotes({ lands, uTime, motion = 1, scale = 1 }) {
  const N = Math.round(33000 * scale);                       // every 3rd particle is in the near layer
  const a = new Float32Array(N * 3), w = new Float32Array(N); let s = 77;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < N; i++) { a.set([rnd(), rnd(), rnd()], i * 3); w[i] = (i % 3 === 0 ? 0 : 1) + rnd() * 0.999; }   // w: 0..1 near, 1..2 far
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  g.setAttribute('aW', new THREE.BufferAttribute(w, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const phi = (id) => { const l = lands.find((x) => x.id === id); return l ? l.phi : 0; };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uMotion: { value: motion }, uScale: { value: 500 },
      uNear: { value: new THREE.Vector3() }, uFar: { value: new THREE.Vector3() },
      uLands: { value: new THREE.Vector4(phi('frostmere'), phi('rosewick'), phi('lantern-row'), 0.0) },
      uAll: { value: lands.map((l) => l.phi).concat(new Array(Math.max(0, 8 - lands.length)).fill(99)).slice(0, 8) },
      uGain: { value: 1 } },
    vertexShader: /* glsl */`
      uniform float uTime, uMotion, uScale, uGain; uniform vec3 uNear, uFar; uniform vec4 uLands; uniform float uAll[8];
      attribute float aW; varying vec4 vC; varying float vKind, vSpin;
      float adiff(float a, float b){ return abs(mod(a - b + 3.14159265, 6.2831853) - 3.14159265); }
      float sector(float ang, float c){ return 1.0 - smoothstep(0.30, 0.38, adiff(ang, c)); }
      void main(){
        vec4 s = vec4(position, aW);
        bool far = s.w >= 1.0;
        float hs = far ? 110.0 : 22.0;                         // half size of the box
        vec3 c = far ? uFar : uNear;
        float t = uTime * uMotion;
        float id = fract(s.w) * 1000.0;
        // world-anchored wrap in xz (drift added before the wrap so flakes stream through the box)
        vec2 drift = vec2(0.35, 0.12) * t;
        vec2 xz = c.xz + (fract(s.xz + (drift - c.xz) / (2.0 * hs)) - 0.5) * 2.0 * hs;
        float r = length(xz), ang = atan(-xz.y, xz.x);         // Blender-frame polar angle
        float land = smoothstep(96.0, 104.0, r) * (1.0 - smoothstep(250.0, 270.0, r));
        float snow = sector(ang, uLands.x) * land;
        float petal = max(sector(ang, uLands.y), sector(ang, uLands.z)) * land;
        float gapw = 1.0; for (int i = 0; i < 8; i++) gapw = min(gapw, smoothstep(0.36, 0.44, adiff(ang, uAll[i])));
        float fly = max(sector(ang, uLands.y), gapw) * smoothstep(100.0, 112.0, r) * (1.0 - smoothstep(235.0, 250.0, r));
        // one kind per particle, chosen by a stable hash, weighted by what the place wants
        float h = fract(id * 0.6180339 + s.y * 7.13);
        float kind = 0.0, w = 0.0; vec3 p; vec3 col; float size;
        float wsum = snow + petal * 0.55 + fly * 0.10;
        if (wsum < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        float pick = h * max(1.0, wsum);
        float ph = s.y * 6.2831853;
        if (pick < snow) {                                     // snow: falls ~1 m/s, wobbles, settles out of sight
          kind = 0.0; w = 1.0;
          float H = far ? 46.0 : 26.0, y0 = far ? -1.0 : c.y - 12.0;
          p = vec3(xz.x, y0 + fract(s.y - t * 1.05 / H) * H, xz.y);
          p.xz += 0.5 * vec2(sin(t * 0.9 + ph * 3.0), cos(t * 0.7 + ph * 5.0));
          col = vec3(0.62, 0.66, 0.80); size = 0.05;
        } else if (pick < snow + petal * 0.55) {               // petals: slow tumbling fall, carried by the breeze
          kind = 1.0; w = 1.0;
          float H = far ? 22.0 : 16.0, y0 = far ? -1.0 : max(c.y - 8.0, -1.0);
          p = vec3(xz.x, y0 + fract(s.y - t * 0.38 / H) * H, xz.y);
          p.xz += vec2(sin(t * 0.4 + ph) * 1.6, cos(t * 0.33 + ph * 2.0) * 1.6) + vec2(0.6, 0.2) * sin(t * 1.3 + ph * 7.0) * 0.3;
          col = mix(vec3(1.0, 0.30, 0.50), vec3(1.0, 0.50, 0.66), fract(ph * 3.7)) * 0.5; size = 0.085;
        } else {                                               // fireflies: hover low over the lawns and blink
          kind = 2.0; w = 1.0;
          p = vec3(xz.x, 0.35 + s.y * 2.6, xz.y);
          p += vec3(sin(t * 0.37 + ph * 4.0), 0.4 * sin(t * 0.61 + ph * 2.0), cos(t * 0.29 + ph * 3.0)) * 1.2;
          float blink = smoothstep(0.55, 0.9, sin(t * (0.8 + fract(ph) * 0.9) + ph * 11.0));
          col = vec3(0.75, 1.0, 0.35) * (0.1 + 2.6 * blink) * mix(1.0, 0.3, 1.0 - uMotion); size = 0.05;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = max(-mv.z, 0.05);
        float px = size * uScale / d;
        float sz = max(px, kind == 2.0 ? 2.5 : 1.5);
        float e = (px * px) / (sz * sz);                       // keep energy when clamped to a minimum size
        // fade at the edge of each box (where the wrap would pop) and very close to the eye
        vec2 q = abs(xz - c.xz) / hs;
        float edge = 1.0 - smoothstep(0.75, 1.0, max(q.x, q.y));
        float nearF = far ? smoothstep(16.0, 24.0, d) : 1.0 - smoothstep(17.0, 22.0, d);
        float a = edge * nearF * smoothstep(0.25, 0.8, d);
        vC = vec4(col * e, (kind == 2.0 ? 0.0 : 0.75 * min(1.0, e * 1.5))) * a * uGain;
        vKind = kind; vSpin = sin(t * (2.0 + fract(ph * 9.1) * 3.0) + ph * 5.0);
        if (kind == 2.0 && far) vC *= 0.7;
        gl_PointSize = min(sz, kind == 2.0 ? 14.0 : 40.0);
        gl_Position = projectionMatrix * mv;
        if (a <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec4 vC; varying float vKind, vSpin;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float m;
        if (vKind == 1.0) {                                    // a petal: an ellipse that flips as it tumbles
          vec2 r = vec2(q.x * 0.8 + q.y * 0.6, -q.x * 0.6 + q.y * 0.8);
          r.x /= max(abs(vSpin), 0.25);
          m = smoothstep(0.5, 0.3, length(r * vec2(1.0, 1.7)));
        } else if (vKind == 2.0) {
          float d = length(q); m = smoothstep(0.5, 0.0, d); m = m * m * (0.5 + 2.0 * smoothstep(0.18, 0.0, d));
        } else { m = smoothstep(0.5, 0.15, length(q)); }
        if (m < 0.01) discard;
        gl_FragColor = vec4(vC.rgb * m, vC.a * m);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false; pts.renderOrder = 7;
  pts.onBeforeRender = (r, sc, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
  const dir = new THREE.Vector3();
  pts.userData.update = (camera) => {           // call with the main camera once per frame
    mat.uniforms.uNear.value.copy(camera.position);
    camera.getWorldDirection(dir); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0); dir.normalize();
    mat.uniforms.uFar.value.copy(camera.position).addScaledVector(dir, 80);
  };
  pts.userData.setScale = (k) => g.setDrawRange(0, Math.round(N * Math.min(1, k)));
  return pts;
}
