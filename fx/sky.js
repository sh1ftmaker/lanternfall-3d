// Sky additions, patched into the existing procedural sky shader (no extra draw):
//  - shooting stars: two meteor slots, each a short streak along a great circle every ~10 s
//  - the moon gets a correct lit phase (waxing gibbous: the sun is below the western horizon) with faint earthshine
//  - clouds catch the park's warm glow from below near the horizon
//  - optional aurora (#aurora): slow green/violet curtains low in the north-west sky
// Patches are applied by string match and skipped silently if the sky shader no longer has the anchor lines.
import * as THREE from 'three';

const DECL = /* glsl */`
  uniform float uFxMotion, uFxAurora; uniform vec3 uFxSun;
  float fxMeteor(vec3 d, float t, float k){
    float P = 9.0 + k * 4.3, cyc = floor((t + k * 5.1) / P), u = ((t + k * 5.1) - cyc * P) / 0.85;
    if (u < 0.0 || u > 1.0) return 0.0;
    float s1 = fract(sin(cyc * 12.9898 + k * 78.233) * 43758.5453), s2 = fract(sin(cyc * 39.346 + k * 11.135) * 24634.6345);
    float az = s1 * 6.2831853, el = 0.45 + 0.6 * s2;
    vec3 a = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
    vec3 b = normalize(cross(a, vec3(0.0, 1.0, 0.0))) * (s2 > 0.5 ? 1.0 : -1.0);
    b = normalize(b - vec3(0.0, 0.45, 0.0));            // falling
    b = normalize(b - a * dot(a, b));
    vec3 n = cross(a, b);
    float phi = atan(dot(d, b), dot(d, a));
    float head = u * 0.30;
    float along = clamp((phi - (head - 0.10)) / 0.10, 0.0, 1.0) * step(phi, head) * step(head - 0.10, phi);
    float w = smoothstep(0.0022, 0.0, abs(dot(d, n))) * step(0.0, dot(d, a) + 0.5);
    return along * along * w * sin(3.14159 * u) * 2.2;
  }
  vec3 fxAurora(vec3 d, float t){
    if (d.y < 0.02) return vec3(0.0);
    vec2 p = d.xz / (d.y + 0.15);
    vec2 dir = normalize(vec2(-0.6, -0.8));
    float x = dot(p, vec2(dir.y, -dir.x)), y = dot(p, dir);
    float c = 0.0;
    for (int i = 0; i < 3; i++){ float fi = float(i);
      float curve = 1.6 + fi * 0.45 + 0.25 * sin(x * (0.7 + fi * 0.3) + t * 0.05 + fi * 2.0) + 0.1 * sin(x * 2.3 - t * 0.09);
      float band = exp(-pow((y - curve) * (5.0 - fi), 2.0));
      float rays = 0.55 + 0.45 * sin(x * 22.0 + sin(x * 3.0 + t * 0.2) * 3.0 + t * 0.3);
      c += band * rays * (1.0 - fi * 0.25); }
    float h = smoothstep(0.02, 0.15, d.y) * smoothstep(0.75, 0.25, d.y);
    return (vec3(0.05, 0.45, 0.24) * c + vec3(0.25, 0.08, 0.35) * c * c * 0.25 * smoothstep(0.1, 0.4, d.y)) * h * 0.22;
  }
`;

export function patchSky(scene, { uTime, motion = 1, aurora = false, moonDir }) {
  let sky = null;
  scene.traverse((o) => { if (!sky && o.isMesh && o.renderOrder === -1000 && o.material && o.material.fragmentShader && o.material.fragmentShader.includes('uMoon')) sky = o; });
  if (!sky) return null;
  const m = sky.material; let fs = m.fragmentShader; const done = [];
  // sun direction for the moon phase: ~130 deg from the moon, below the horizon
  const M = moonDir.clone().normalize();
  const down = new THREE.Vector3(-M.x, -0.9, -M.z).addScaledVector(M, -0.0); down.addScaledVector(M, -down.dot(M)).normalize();
  const el = THREE.MathUtils.degToRad(130), S = M.clone().multiplyScalar(Math.cos(el)).addScaledVector(down, Math.sin(el)).normalize();
  m.uniforms.uFxMotion = { value: motion }; m.uniforms.uFxAurora = { value: aurora ? 1 : 0 }; m.uniforms.uFxSun = { value: S };
  fs = fs.replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => DECL + '\n' + s);
  const moonRe = /crater\s*\*\s*\(0\.45 \+ 0\.75 \* limb\)/;
  if (moonRe.test(fs)) { fs = fs.replace(moonRe, (s) => `${s} * mix(0.045, 1.0, smoothstep(-0.06, 0.08, dot(mref * muv.x + mup * muv.y - uMoon * limb, uFxSun)))`); done.push('moon'); }
  const cloudRe = /col \+= cloud \* \(vec3\(0\.018, 0\.022, 0\.046\)/;
  if (cloudRe.test(fs)) { fs = fs.replace(cloudRe, 'col += cloud * vec3(0.075, 0.042, 0.018) * smoothstep(0.42, 0.04, h);\n      $&'); done.push('clouds'); }
  const tailRe = /col = mix\(col, hor \* 0\.55, smoothstep\(0\.0, -0\.12, d\.y\)\);/;
  if (tailRe.test(fs)) {
    fs = fs.replace(tailRe, `{ float tm = uTime * uFxMotion; float mt = (fxMeteor(d, tm, 0.0) + fxMeteor(d, tm, 1.0)) * smoothstep(0.02, 0.2, h) * veil;
        col += vec3(0.85, 0.9, 1.0) * mt;
        if (uFxAurora > 0.5) col += fxAurora(d, tm) * veil; }
      $&`);
    done.push('meteors');
  }
  m.fragmentShader = fs; m.needsUpdate = true;
  return { sky, done, uniforms: m.uniforms };
}
