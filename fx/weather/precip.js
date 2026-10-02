// Rain and snow: one instanced draw each, every drop placed and moved in the vertex shader. Drops live in two boxes
// that wrap around the camera (a dense near one and a sparse far one, so the air has depth), are cut off by the
// top-down cover map (no rain under roofs, arcades or the viaduct; a streak ends on the surface it hits) and are lit by
// the cover map's baked light: streaks glow near lanterns and neon, and all but vanish in the dark. Splash rings are a
// third instanced draw, each ring born at a hashed spot on the topmost surface. Layer 2: not in the lake's mirror,
// the environment capture or the shadow / cover passes.
import * as THREE from 'three';
import { COVER_GLSL } from './cover.js';

const LAYER = 2;

const COMMON = /* glsl */`
  uniform float uTime, uAmount; uniform vec3 uCam; uniform vec2 uVP; uniform float uCovOn;
  ${COVER_GLSL}
  float hs(float n){ return fract(sin(n) * 43758.5453); }
  // wrap a world point into the box of size b around the camera
  vec3 wrapBox(vec3 p, vec3 b){ return mod(p - uCam + b * 0.5, b) + uCam - b * 0.5; }
  // the drop's light: the baked light of the surface under it (blurred), plus a little sky
  vec3 dropLight(vec3 p){ vec3 l = uCovOn > 0.5 ? covL(p.xz, 4.5) : vec3(0.02); return l * (0.7 + 0.6 * smoothstep(12.0, 0.0, p.y - covH(p.xz))) + vec3(0.010, 0.012, 0.020); }`;

function quadGeometry(count, kind) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const seed = new Float32Array(count * 4); let s = kind * 7919 + 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  for (let i = 0; i < count * 4; i++) seed[i] = rnd();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export function createPrecip({ scene, camera, uTime, cover, mobile }) {
  const MAX_RAIN = mobile ? 14000 : 36000, MAX_SNOW = mobile ? 9000 : 24000, MAX_SPLASH = mobile ? 900 : 2400;
  const shared = { uTime, uCam: { value: new THREE.Vector3() }, uVP: { value: new THREE.Vector2(1, 1) }, uCovOn: { value: 0 }, ...cover.uniforms };
  const blend = { transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };

  /* rain streaks */
  const rainU = { ...shared, uAmount: { value: 0 }, uWind: { value: new THREE.Vector2(1.5, 0.5) }, uSpeed: { value: 9.0 }, uLen: { value: 0.05 }, uBright: { value: 1 }, uGain: { value: 5 } };
  const rainMat = new THREE.ShaderMaterial({
    uniforms: rainU, ...blend,
    vertexShader: /* glsl */`
      ${COMMON}
      uniform vec2 uWind; uniform float uSpeed, uLen, uBright, uGain; attribute vec4 aSeed; varying vec3 vC; varying vec2 vQ;
      void main(){
        bool far = aSeed.w > 0.55;
        vec3 box = far ? vec3(110.0, 60.0, 110.0) : vec3(34.0, 26.0, 34.0);
        float sp = uSpeed * (0.85 + 0.3 * fract(aSeed.w * 37.0));
        vec3 vel = vec3(uWind.x, -sp, uWind.y);
        vec3 p = wrapBox(aSeed.xyz * box + vel * uTime, box);
        float h = uCovOn > 0.5 ? covH(p.xz) : -1.0;
        vec3 tail = p - vel * uLen * (far ? 1.6 : 1.0);
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vC = vec3(0.0); vQ = vec2(0.0);
        if (p.y < h - 0.02 && tail.y < h) return;                     // under a roof or below the ground: gone
        p.y = max(p.y, h);
        vec4 c0 = projectionMatrix * viewMatrix * vec4(p, 1.0), c1 = projectionMatrix * viewMatrix * vec4(tail, 1.0);
        if (c0.w < 0.5 || c1.w < 0.5) return;
        vec2 s0 = c0.xy / c0.w * uVP, s1 = c1.xy / c1.w * uVP;           // in pixels (x 0.5)
        vec2 d = s1 - s0; float l = length(d); d = l > 1e-4 ? d / l : vec2(0.0, 1.0);
        float wpx = 0.0016 * uVP.y * projectionMatrix[1][1] / c0.w;      // the drop's true width in (half) pixels
        float w = max(wpx, 0.55);
        vec4 c = mix(c0, c1, position.y);
        c.xy += vec2(-d.y, d.x) * position.x * w / uVP * c.w;
        gl_Position = c;
        float dist = c0.w;
        float fade = smoothstep(0.6, 2.0, dist) * (1.0 - smoothstep(far ? 45.0 : 14.0, far ? 55.0 : 17.0, length(p.xz - uCam.xz)));
        vC = dropLight(p) * uBright * uGain * fade * min(1.0, wpx / w) * (far ? 1.6 : 1.0);
        vQ = position.xy;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying vec2 vQ;
      void main(){ float a = (1.0 - vQ.x * vQ.x) * smoothstep(0.0, 0.25, vQ.y) * smoothstep(1.0, 0.6, vQ.y);
        gl_FragColor = vec4(vC * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const rain = new THREE.Mesh(quadGeometry(MAX_RAIN, 1), rainMat);

  /* snow flakes: camera-facing soft dots drifting down */
  const snowU = { ...shared, uAmount: { value: 0 }, uWind: { value: new THREE.Vector2(0.6, 0.2) }, uMotion: { value: 1 } };
  const snowMat = new THREE.ShaderMaterial({
    uniforms: snowU, ...blend,
    vertexShader: /* glsl */`
      ${COMMON}
      uniform vec2 uWind; uniform float uMotion; attribute vec4 aSeed; varying vec3 vC; varying vec2 vQ;
      void main(){
        bool far = aSeed.w > 0.6;
        vec3 box = far ? vec3(80.0, 44.0, 80.0) : vec3(26.0, 20.0, 26.0);
        float t = uTime * uMotion, ph = aSeed.w * 61.0;
        vec3 vel = vec3(uWind.x, -(0.75 + 0.5 * fract(aSeed.w * 23.0)), uWind.y);
        vec3 p = aSeed.xyz * box + vel * t;
        p.x += 0.45 * sin(t * 0.9 + ph) + 0.2 * sin(t * 2.3 + ph * 1.7); p.z += 0.45 * cos(t * 0.7 + ph * 1.3);
        p = wrapBox(p, box);
        float h = uCovOn > 0.5 ? covH(p.xz) : -1.0;
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vC = vec3(0.0); vQ = vec2(0.0);
        if (p.y < h) return;
        vec4 c = projectionMatrix * viewMatrix * vec4(p, 1.0);
        if (c.w < 0.4) return;
        float rpx = 0.012 * uVP.y * projectionMatrix[1][1] / c.w, r = max(rpx, 0.8);
        c.xy += (position.xy * 2.0 - vec2(0.0, 1.0)) * r / uVP * c.w;
        gl_Position = c;
        float fade = smoothstep(0.4, 1.5, c.w) * (1.0 - smoothstep(far ? 34.0 : 11.0, far ? 40.0 : 13.0, length(p.xz - uCam.xz)));
        vC = (dropLight(p) * 2.2 + vec3(0.03, 0.035, 0.05)) * fade * min(1.0, rpx * rpx / (r * r) + 0.15);
        vQ = vec2(position.x, position.y * 2.0 - 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying vec2 vQ;
      void main(){ float d = dot(vQ, vQ); if (d > 1.0) discard; float a = (1.0 - d); a *= a;
        gl_FragColor = vec4(vC * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const snow = new THREE.Mesh(quadGeometry(MAX_SNOW, 2), snowMat);

  /* splash rings on whatever is on top (needs the cover map) */
  const splU = { ...shared, uAmount: { value: 0 } };
  const splMat = new THREE.ShaderMaterial({
    uniforms: splU, ...blend,
    vertexShader: /* glsl */`
      ${COMMON}
      attribute vec4 aSeed; varying vec3 vC; varying vec2 vQ; varying float vR;
      void main(){
        float per = 0.45 + 0.4 * aSeed.w, k = uTime / per + aSeed.z * 7.0, id = floor(k), u = fract(k);
        vec3 box = vec3(22.0, 1.0, 22.0);
        vec3 p = wrapBox(vec3((aSeed.x + hs(id * 1.37 + aSeed.y * 91.0)) * box.x, 0.0, (aSeed.y + hs(id * 2.11 + aSeed.x * 53.0)) * box.z), box);
        p.y = covH(p.xz) + 0.03;
        float r = 0.02 + 0.075 * sqrt(u);
        vec4 c = projectionMatrix * viewMatrix * vec4(p + vec3(position.x, 0.0, position.y * 2.0 - 1.0) * r, 1.0);
        gl_Position = c; vQ = vec2(position.x, position.y * 2.0 - 1.0); vR = u;
        float dist = length(p - cameraPosition);
        vC = dropLight(p) * 0.9 * (1.0 - u) * smoothstep(0.0, 0.08, u) * smoothstep(11.0, 4.0, dist) * uCovOn;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying vec2 vQ; varying float vR;
      void main(){ float d = length(vQ); float ring = smoothstep(0.62, 0.86, d) * smoothstep(1.0, 0.88, d) + 0.5 * smoothstep(0.3, 0.0, d) * (1.0 - vR);
        if (ring < 0.01) discard;
        gl_FragColor = vec4(vC * ring, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const splash = new THREE.Mesh(quadGeometry(MAX_SPLASH, 3), splMat);

  const grp = new THREE.Group(); grp.name = 'weather-precip';
  for (const m of [rain, snow, splash]) {
    m.frustumCulled = false; m.renderOrder = 9; m.layers.set(LAYER); m.visible = false;
    m.onBeforeRender = (r) => { const rt = r.getRenderTarget(); const w = rt ? rt.width : r.domElement.width, h = rt ? rt.height : r.domElement.height; shared.uVP.value.set(w * 0.5, h * 0.5); };
    grp.add(m);
  }
  scene.add(grp); camera.layers.enable(LAYER);

  // amounts 0..~1.6; scale = the quality ladder's particle budget
  function update({ rainAmt, snowAmt, wind, scale, motion }) {
    shared.uCam.value.copy(camera.position);
    shared.uCovOn.value = cover.ready ? 1 : 0;
    const nr = Math.floor(MAX_RAIN * Math.min(1, rainAmt / 1.6) * scale), ns = Math.floor(MAX_SNOW * Math.min(1, snowAmt) * scale);
    rain.geometry.instanceCount = nr; rain.visible = nr > 0;
    snow.geometry.instanceCount = ns; snow.visible = ns > 0;
    const np = cover.ready ? Math.floor(MAX_SPLASH * Math.min(1, rainAmt / 1.6) * scale) : 0;
    splash.geometry.instanceCount = np; splash.visible = np > 0;
    rainU.uWind.value.set(1.2 + 6.5 * wind, 0.4 + 2.6 * wind);
    rainU.uSpeed.value = 9.0 * (motion ? 1 : 0.3);
    rainU.uBright.value = 0.8 + 0.2 * Math.min(1, rainAmt);
    snowU.uWind.value.set(0.4 + 2.5 * wind, 0.15 + 1.0 * wind); snowU.uMotion.value = motion ? 1 : 0.35;
  }
  function dispose() { scene.remove(grp); for (const m of [rain, snow, splash]) { m.geometry.dispose(); m.material.dispose(); } }
  return { group: grp, rain, snow, splash, update, dispose, max: { rain: MAX_RAIN, snow: MAX_SNOW, splash: MAX_SPLASH } };
}
