// Fireworks over Stillwater for the finale moments: shells are launched from barges on the lake, climb on a
// sparking trail and burst into peonies, golden willows and rings. Stateless GPU particles (one THREE.Points draw):
// every spark's position is a closed-form ballistic curve with drag, evaluated from its shell's launch time,
// so the JS side only keeps 10 shell slots (uniform arrays). Trails are the same spark re-drawn at a few time lags
// (cheap "webgl_trails"-style streaks). Additive; brightness is capped so the bloom pass blooms but never blows out.
import * as THREE from 'three';

const SLOTS = 10, SPARKS = 180, LAGS = 5;
const FLIGHT = 1.5;          // seconds from launch to burst

export function buildFireworks({ uTime, scale = 1 }) {
  const sparks = Math.max(60, Math.round(SPARKS * Math.min(1, scale)));
  const n = SLOTS * sparks * LAGS;
  const pos = new Float32Array(n * 3), aux = new Float32Array(n * 4);
  let s = 9; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let k = 0;
  for (let sl = 0; sl < SLOTS; sl++) for (let i = 0; i < sparks; i++) {
    // even-ish directions on the sphere (golden spiral) + jitter
    const z = 1 - 2 * (i + 0.5) / sparks, r = Math.sqrt(1 - z * z), a = i * 2.39996 + rnd() * 0.3;
    const dx = r * Math.cos(a), dy = z, dz = r * Math.sin(a), sp = 0.85 + 0.3 * rnd(), ph = rnd();
    for (let l = 0; l < LAGS; l++, k++) { pos.set([dx, dy, dz], k * 3); aux.set([sl, sp, l, i === 0 ? -1 : ph], k * 4); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAux', new THREE.BufferAttribute(aux, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 60, 0), 400);
  const shells = Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, 0, -1e4));
  const looks = Array.from({ length: SLOTS }, () => new THREE.Vector4(1, 0.6, 0.2, 0));
  const pads = Array.from({ length: SLOTS }, () => new THREE.Vector3());
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime, uScale: { value: 500 }, uShell: { value: shells }, uLook: { value: looks }, uPad: { value: pads }, uGain: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec4 aAux; uniform float uTime, uScale, uGain; uniform vec4 uShell[${SLOTS}], uLook[${SLOTS}]; uniform vec3 uPad[${SLOTS}];
      varying vec3 vC;
      void main(){
        int sl = int(aAux.x + 0.5);
        vec4 sh = uShell[sl]; vec4 lk = uLook[sl]; vec3 pad = uPad[sl];
        float lag = aAux.z, type = lk.w;
        float tb = sh.w;                                     // burst time
        float t = uTime - tb - lag * (type == 1.0 ? 0.09 : 0.045);
        vec3 p; float b = 0.0;
        if (t < 0.0) {                                       // climbing: only spark 0 draws, as the rocket and its trail
          float u = (t + ${FLIGHT.toFixed(2)}) / ${FLIGHT.toFixed(2)};
          if (aAux.w < 0.0 && u > 0.0) { float e = 1.0 - (1.0 - u) * (1.0 - u); p = mix(pad, sh.xyz, e); b = 1.6 * (1.0 - lag / ${LAGS}.0); }
        } else {
          float life = type == 1.0 ? 3.4 : 2.3;
          float v0 = (type == 1.0 ? 26.0 : 36.0) * aAux.y, kd = type == 1.0 ? 1.3 : 1.55;
          vec3 d = position;
          if (type == 2.0) { d = normalize(vec3(d.x, d.y * 0.08, d.z)); }     // ring
          float fall = type == 1.0 ? 6.0 : 3.5;
          p = sh.xyz + d * v0 * (1.0 - exp(-kd * t)) / kd - vec3(0.0, fall * t * t * 0.5, 0.0);
          float u = t / life;
          b = (1.0 - smoothstep(0.55, 1.0, u)) * (u < 0.04 ? 3.0 : 1.0) * (1.0 - lag / ${LAGS}.0 * 0.85);
          if (u > 0.5) b *= 0.55 + 0.45 * step(0.5, fract(aAux.w * 37.0 + uTime * 9.0));   // crackle as it dies
          if (u >= 1.0) b = 0.0;
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(-mv.z, 0.1);
        float px = 0.9 * uScale / dist, sz = max(px, 2.0);
        vC = lk.rgb * b * min(1.0, px * px / (sz * sz) * 2.0 + 0.25) * uGain;
        gl_PointSize = min(sz, 24.0);
        gl_Position = projectionMatrix * mv;
        if (b <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC;
      void main(){ float d = length(gl_PointCoord - 0.5); float m = smoothstep(0.5, 0.0, d); m *= m;
        if (m < 0.01) discard;
        gl_FragColor = vec4(vC * m * (1.0 + 2.0 * smoothstep(0.2, 0.0, d)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 9;
  pts.onBeforeRender = (r, sc, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };

  const PALETTE = [[1.0, 0.12, 0.18], [0.15, 1.0, 0.35], [0.22, 0.5, 1.0], [0.7, 0.25, 1.0], [1.0, 0.25, 0.75], [0.3, 0.95, 1.0], [1.0, 1.0, 1.0]];
  let next = 0, rng = 1234;
  const r1 = () => { rng = (rng * 16807) % 2147483647; return rng / 2147483647; };
  function launch(now, opt = {}) {
    const sl = next; next = (next + 1) % SLOTS;
    const a = r1() * Math.PI * 2, rr = 20 + r1() * 40;
    pads[sl].set(Math.cos(a) * rr, -0.5, Math.sin(a) * rr);
    const ba = a + (r1() - 0.5) * 0.6, br = rr * (0.2 + r1() * 0.5);
    shells[sl].set(Math.cos(ba) * br, opt.h || (64 + r1() * 26), Math.sin(ba) * br, now + FLIGHT);
    const c = PALETTE[Math.floor(r1() * PALETTE.length)], type = r1() < 0.25 ? 1 : r1() < 0.2 ? 2 : 0;
    const gain = type === 1 ? 1.4 : 1.8;
    looks[sl].set(type === 1 ? 1.0 * gain : c[0] * gain, type === 1 ? 0.62 * gain : c[1] * gain, type === 1 ? 0.25 * gain : c[2] * gain, type);
  }
  // schedule: during the tour's Spire shot and its finale pull-back; occasional volleys elsewhere
  let acc = 0, volley = 0, quiet = 25;
  pts.userData.update = (now, dt, ctx) => {
    let rate = 0;
    if (ctx.tour >= 0) { const t = ctx.tour; if ((t > 34 && t < 49) || (t > 146.5 && t < 158)) rate = 1.6; }
    else if (pts.userData.finale) rate = 1.3;                    // clock hook: the closing volleys of the evening (23:34 on)
    else if (ctx.always) { quiet -= dt; if (quiet < 0) { volley = 4 + Math.floor(r1() * 5); quiet = 45 + r1() * 40; } if (volley > 0) rate = 1.3; }
    if (!rate) { acc = 0; return; }
    acc += dt * rate;
    while (acc >= 1) { acc -= 1 + (r1() - 0.5) * 0.6; launch(now); if (volley > 0) volley--; }
  };
  pts.userData.launch = launch;
  return pts;
}
