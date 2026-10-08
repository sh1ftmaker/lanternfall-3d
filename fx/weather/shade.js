// Weather inside the park's existing shaders, patched in by string anchors before they first compile (as fx/sky.js
// does). Every addition sits behind a uniform test that is false in Clear, so Clear runs the original code path.
//  - fx/surface.js: wet ground (darker, more saturated, Fresnel sheen; puddles on flat paving mirror the sky and the
//    coloured light found along the reflected ray in the cover map), snow settling on up-facing surfaces, the
//    lightning flash on everything open to the sky. Covered ground (cover map) stays dry and clean.
//  - fx/water.js: rain rings on the lake near the eye, no moon glitter under cloud, cloudy sky in the analytic tier.
//  - the sky dome: a cloud deck lit warm from below by the park, which hides stars and moon; the flash inside it.
//  - fog density and colour on every fogged material, the lake mist, the moonlight (and so the moon shadows).
//  - lightning (Storm): a soft, slow flash at most every ~8 s; none at all with Reduce motion.
import { COVER_GLSL } from './cover.js';
import { WET_GLSL } from '../light/wet.js';

const SURF_DECL = /* glsl */`
  uniform vec4 uWx; uniform vec3 uWxSky, uWxFlash; uniform float uCovOn, uTime;   // uWx: wet, snow, flash, rain
  uniform vec4 uWet;                       // x: the ground's wetness in every weather ("just after rain"), y: roughness, z: streak stretch, w: puddles
  ${COVER_GLSL}
  ${WET_GLSL}
  vec3 wxSurface(vec3 col, vec3 nbIn, float hgt){
    vec3 dx = dFdx(vW), dy = dFdy(vW), n = normalize(cross(dx, dy));                // faces the viewer
    float up = n.y, fw = max(length(dx), length(dy));                              // pixel footprint (m)
    float hc = covH(vW.xz + n.xz * 0.45);                                            // walls: the air in front of them
    // 0 under a roof, arcade, viaduct. Floors read a coarse mip (~1.5 m) so festoon strings and wires do not leave
    // dry stripes, and softly, so the dry edge under a viaduct or eaves is a gradual one
    float hcm = up > 0.55 && uCovOn > 0.5 ? textureLod(tCover, covUV(vW.xz), uWetOcc).a * uCovK.y - 8.0 : hc;
    float expo = uCovOn > 0.5 ? mix(smoothstep(-0.4, -0.12, vW.y - hc), smoothstep(-1.6, -0.3, vW.y - hcm), smoothstep(0.55, 0.9, n.y)) : 1.0;
    if (vCls > 6.5) return col + vAlb * uWxFlash * expo;
    // wetness: rain soaks everything open to the sky (porous more); the permanent film sits on floors: paving, setts,
    // flagstones and plaza stone most, decks a little less, grass and roofs hardly; walls only darken at the foot
    float flatk = smoothstep(0.82, 0.97, up), floork = smoothstep(0.55, 0.9, up);
    float porous = vCls < 0.5 ? 0.6 : vCls < 3.5 ? 1.0 : vCls < 4.5 ? 0.7 : vCls < 5.5 ? 0.55 : 0.3;
    float clsk = vCls < 0.5 ? 0.75 : vCls < 1.5 ? 1.0 : vCls < 2.5 ? 0.85 : vCls < 3.5 ? 0.9 : vCls < 4.5 ? 0.12 : 0.0;
    float wr = uWx.x * expo;
    float wb = uWet.x * expo * clsk * floork;
    float foot = (1.0 - floork) * (vCls < 3.5 ? 1.0 : 0.0) * (1.0 - smoothstep(0.0, 0.7, vW.y - hc)) * uWet.x * expo * 0.5;
    float w = max(wr, wb);
    if (w + foot > 0.0) {
      col *= 1.0 - 0.45 * max(max(wr * porous, wb * 0.85), foot);
      float sk = max(wr * porous, wb * 0.8);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722)); col = max(mix(vec3(l), col, 1.0 + 0.4 * sk), 0.0);
      // puddles in the low spots of flat ground: small (the noise is ~1.3 m across, so a pool stays under ~2 m), edges
      // feathered over 15 cm measured in metres, following the joints (which fill first), a darker damp ring round
      // each; more and larger while it rains and where the ground sags
      float pud = 0.0, halo = 0.0;
      if (flatk > 0.0 && vCls < 3.5 && fw < 0.6 && uWet.w > 0.0) {
        float water = max(wr, wb * 0.55) * uWet.w;
        vec2 q = vW.xz;
        float pn = vn(q * 0.75) * 0.6 + vn(q * 2.1 + 3.1) * 0.4 + 0.06 * (1.0 - hgt);
        float sag = vn(q * 0.13 + 7.7);
        float t = 0.86 - 0.2 * water - 0.12 * sag, fp = fwidth(pn), fe = max(0.15 * fp / max(fw, 1e-4), fp);
        float fade = smoothstep(0.6, 0.15, fw) * flatk * step(0.02, water);
        pud = smoothstep(t, t + fe, pn) * fade;
        halo = smoothstep(t - fe * 1.2, t, pn) * (1.0 - pud) * fade;
      }
      col *= 1.0 - 0.3 * halo * w;
      vec3 V = normalize(cameraPosition - vW), N = n;
      if (pud > 0.01 && uWx.w > 0.0 && fw < 0.03) {                                  // raindrops ringing the puddles
        vec2 q = vW.xz * 2.2, c = floor(q), o = vec2(fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453), fract(sin(dot(c, vec2(269.5, 183.3))) * 43758.5453));
        float ph = fract(uTime * 1.3 + o.x * 9.0), d = length(q - c - o * 0.6 - 0.2), x = d - ph * 0.9;
        N = normalize(N + vec3((q - c - o * 0.6 - 0.2) / max(d, 1e-3), 0.0).xzy * sin(x * 30.0) * exp(-x * x * 90.0) * (1.0 - ph) * 0.25 * min(uWx.w, 1.0) * smoothstep(0.03, 0.01, fw));
      }
      float F = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
      float gloss = vCls < 3.5 ? (vCls > 1.5 && vCls < 2.5 ? 0.6 : 1.0) : vCls < 4.5 ? 0.2 : 0.8;     // grass barely, wood less
      float k = F * mix(w * (0.08 + 0.5 * flatk) * gloss, 1.0, pud);
      vec3 R = reflect(-V, N), rl = vec3(0.0);
      if (uCovOn > 0.5 && R.y > 0.015 && k > 0.012) {                                // glow of lamps and signs along the reflected ray
        vec2 rd = R.xz / R.y; float rl2 = dot(rd, rd); if (rl2 > 900.0) rd *= 30.0 * inversesqrt(rl2);
        float lod = mix(2.6, 1.0, pud);
        rl = covL(vW.xz + rd * 1.6, lod) * 0.5 + covL(vW.xz + rd * 4.5, lod + 0.6) * 0.75;
        if (pud > 0.3) rl = rl * 0.7 + covL(vW.xz + rd * 2.8, lod) * 0.35;
      }
      vec3 refl = uWxSky * (0.7 + 0.6 * max(R.y, 0.0)) + rl * 0.6;              // (the lamps themselves: below)
      col = col * (1.0 - 0.35 * pud) * (1.0 - k) + refl * k;
      // the lamps themselves, as streaks (fx/light/wet.js): rough film broken by setts and rain micro-normals, a
      // near-mirror in the puddles
      float sa = mix(w * gloss * floork, 1.0, pud);
      if (uWetN > 0 && sa > 0.02) {
        vec3 Nb = dot(nbIn, n) < 0.0 ? -nbIn : nbIn;
        vec2 q = vW.xz;
        vec2 tilt = (vec2(vn(q * 2.7), vn(q * 2.7 + 5.2)) - 0.5) * 0.09;                           // sett-sized tilts: dashes
        if (uWetLite < 0.5 && fw < 0.03) tilt += (vec2(vn(q * 17.0), vn(q * 17.0 + 3.3)) - 0.5) * 0.05 * (1.0 - smoothstep(0.008, 0.03, fw));   // rain micro-normals
        vec3 Ns = normalize(mix(Nb, N, pud) + vec3(tilt.x, 0.0, tilt.y) * (1.0 - 0.8 * pud));
        float brk = vCls > 0.5 && vCls < 2.5 ? mix(0.12, 1.0, smoothstep(0.3, 0.75, hgt)) : 1.0;       // dry-ish joints
        float a = mix(uWet.y * (vCls > 1.5 && vCls < 2.5 ? 1.6 : vCls > 3.5 ? 2.5 : 1.0), 0.05, pud);
        col += wetStreaks(vW, Ns, V, a, uWet.z, uCovOn > 0.5 && uWetLite < 1.5) * sa * mix(brk, 1.0, pud);
      }
    }
    if (uWx.y > 0.0) {                                                               // snow settling on what faces up
      float s = uWx.y * expo * smoothstep(0.3, 0.8, up) * (0.7 + 0.3 * vn(vW.xz * 2.7));
      vec3 L = min(vCol / max(vAlb, vec3(0.05)), vec3(3.0));
      vec3 sc = L * 0.8 + uMoonCol * uMoonOn * max(dot(n, uMoon), 0.0) * 0.9;
      col = mix(col, sc, s);
    }
    return col + max(vAlb, vec3(0.03)) * uWxFlash * expo * (0.35 + 0.65 * max(up, 0.0));
  }`;

const WATER_DECL = /* glsl */`
  uniform vec4 uWx; uniform vec3 uWxSky;                                            // uWx: rain, cloud, flash
  vec2 wxRings(vec2 p, float t){                                                     // expanding rings, one drop per cell
    vec2 s = vec2(0.0), q = p * 1.6, i0 = floor(q);
    for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
      vec2 c = i0 + vec2(float(j), float(k));
      float h = fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453), h2 = fract(h * 13.71 + 0.37);
      float ph = fract(t * 0.9 + h * 7.0);
      vec2 v = q - c - vec2(h, h2); float d = length(v), x = d - ph * 1.3;
      s += v / max(d, 1e-3) * sin(x * 22.0) * exp(-x * x * 30.0) * (1.0 - ph) * (1.0 - ph);
    }
    return s * 0.10;
  }`;

const SKY_DECL = /* glsl */`uniform float uWxCloud, uWxWind; uniform vec3 uWxFlash, uWxBolt, uWxGlow;
    float wxN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453), b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5453);
      float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5453), d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5453);
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }`;
const SKY_CODE = /* glsl */`
      if (uWxCloud > 0.0) {                                // weather: a low deck lit from below by the park
        vec2 cp = cuv * 0.55 + vec2(uTime * 0.006, uTime * 0.002) * (1.0 + 4.0 * uWxWind);
        float dk = wxN(cp * 2.0) * 0.55 + wxN(cp * 4.1 + 7.3) * 0.3 + wxN(cp * 8.3 + 2.1) * 0.15;
        vec3 deck = mix(vec3(0.008, 0.009, 0.015), vec3(0.026, 0.024, 0.032), smoothstep(0.25, 0.75, dk));
        deck += uWxGlow * exp(-max(h, 0.0) * 6.0) * (0.55 + 0.7 * dk);
        float ba = acos(clamp(dot(d, uWxBolt), -1.0, 1.0));
        deck += uWxFlash * (0.25 + 1.1 * dk) * (0.35 + exp(-ba * 2.2));
        col = mix(col, deck, smoothstep(0.0, 0.75, uWxCloud));      // overcast hides stars and moon
      }
      `;

// look knobs ('#u_wet=0.6' etc. in the URL; live: __park.weather.shade.U.uWet.value)
const knob = (k, d) => { const m = new RegExp('(?:^|[#,&+])u_' + k + '=([-\\d.]+)').exec(location.hash); return m ? +m[1] : d; };

export function createShade({ THREE, scene, surface, cover, wet, getWater, getFx, FOG, uTime }) {
  const U = { uWet: { value: new THREE.Vector4(knob('wet', 0.75), knob('wetrough', 0.06), knob('streak', 7), knob('puddle', 1)) }, uTime, uWx: { value: new THREE.Vector4() }, uWxSky: { value: new THREE.Vector3(0.012, 0.013, 0.022) }, uWxFlash: { value: new THREE.Vector3() }, uCovOn: { value: 0 } };
  const done = [], orig = new Map();          // material -> its shader before patching (tests: unpatch())
  // fx/surface.js
  {
    const m = surface.material; let fs = m.fragmentShader;
    const fogLine = 'float f = 1.0 - exp(-vDist * vDist * uFogD);';
    if (fs.includes(fogLine) && /void main\(\)\{/.test(fs)) {
      fs = fs.replace(/void main\(\)\{/, SURF_DECL + '\n      void main(){');
      fs = fs.replace(fogLine, 'if (uWx.x + uWx.y + uWx.z + uWet.x > 0.0) col = wxSurface(col, nb, dt.y);       // weather (fx/weather/shade.js)\n        ' + fogLine);
      orig.set(m, ['surface', m.fragmentShader]); Object.assign(m.uniforms, U, cover.uniforms, wet.U); m.fragmentShader = fs; m.needsUpdate = true; done.push('surface');
    }
  }
  // the sky dome (app.js), after fx/sky.js has patched it or not
  let sky = null; const SU = { uWxCloud: { value: 0 }, uWxWind: { value: 0 }, uWxFlash: { value: new THREE.Vector3() }, uWxBolt: { value: new THREE.Vector3(0, 0.3, 1).normalize() }, uWxGlow: { value: new THREE.Vector3(0.07, 0.042, 0.024) } };
  function patchSky() {
    if (sky) return;
    scene.traverse((o) => { if (!sky && o.isMesh && o.renderOrder === -1000 && o.material && o.material.fragmentShader && o.material.fragmentShader.includes('uMoon')) sky = o; });
    if (!sky) return;
    const m = sky.material; let fs = m.fragmentShader;
    const tail = /col = mix\(col, hor \* 0\.55, smoothstep\(0\.0, -0\.12, d\.y\)\);/;
    if (!tail.test(fs) || !fs.includes('vec2 cuv')) { sky = { material: null }; return; }
    fs = fs.replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => SKY_DECL + '\n    ' + s).replace(tail, (s) => SKY_CODE + s);
    orig.set(m, ['sky', null]); Object.assign(m.uniforms, SU); m.fragmentShader = fs; m.needsUpdate = true; done.push('sky');
  }
  patchSky();
  // fx/water.js (created once the manifest is in: patched in the first update after that, before its first render)
  const WU = { uWx: { value: new THREE.Vector4() }, uWxSky: U.uWxSky };
  let water = null, wBase = null;
  function patchWater() {
    const w = getWater && getWater(); if (!w || water) return;
    water = w; const m = w.material; let fs = m.fragmentShader;
    const nLine = 'vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));';
    const skyLine = 'else bg = (skyCol(R, uMoon) * 2.0 + skyCol(Ra, uMoon) + skyCol(Rb, uMoon)) * 0.25;';
    const glitLine = 'float md = max(dot(R, uMoon), 0.0);';
    const fogLine = 'float fogf = 1.0 - exp(-dist * dist * uFogD);';
    if (![nLine, skyLine, glitLine, fogLine].every((l) => fs.includes(l))) return;
    fs = fs.replace(/void main\(\)\{/, WATER_DECL + '\n      void main(){')
      .replace(nLine, 'if (uWx.x > 0.0 && dist < 70.0) slope += wxRings(vW.xz, t) * uWx.x * smoothstep(70.0, 20.0, dist);   // weather: rain\n        ' + nLine)
      .replace(skyLine, 'else bg = mix((skyCol(R, uMoon) * 2.0 + skyCol(Ra, uMoon) + skyCol(Rb, uMoon)) * 0.25, uWxSky, uWx.y * 0.85);')
      .replace(glitLine, 'float md = max(dot(R, uMoon), 0.0) * (1.0 - 0.2 * uWx.y);')
      .replace(fogLine, 'if (uWx.z > 0.0) col += vec3(0.30, 0.33, 0.42) * uWx.z * F;\n        ' + fogLine);
    orig.set(m, ['water', m.fragmentShader]); Object.assign(m.uniforms, WU); m.fragmentShader = fs; m.needsUpdate = true; done.push('water');
    wBase = { wind: m.uniforms.uWind.value, rough: m.uniforms.uRough.value };
  }

  /* fog on every material that has it (the park, glass, forest, lake, guests share some of these uniforms) */
  const fogBase = new Map(); let fogScan = 0;
  const fogCol0 = FOG.clone(), moon0 = surface.uniforms.uMoonCol.value.clone();
  function scanFog() {
    scene.traverse((o) => { const m = o.material; if (!m || !m.uniforms) return; for (const mm of Array.isArray(m) ? m : [m]) { const u = mm.uniforms && mm.uniforms.uFogD; if (u && !fogBase.has(u)) fogBase.set(u, u.value); } });
  }

  /* lightning */
  const L = { next: 6 + Math.random() * 6, t: -1, amp: 0, dist: 800, dir: new THREE.Vector3(), seq: 0, last: null };
  function flash(t) {             // soft and slow: 0.15 s rise, a gentle second swell, ~1.5 s decay; never a hard strobe
    if (t < 0) return 0;
    const rise = Math.min(1, t / 0.15), e = rise * rise * (3 - 2 * rise);
    return e * (Math.exp(-t / 0.55) + 0.35 * Math.exp(-Math.pow((t - 0.45) / 0.18, 2)));
  }

  const fogCol = FOG.clone(), tmpC = new THREE.Color();
  function update(dt, time, now, { reduceMotion, state, wxFog }) {
    U.uCovOn.value = cover.ready ? 1 : 0;
    // lightning: only in Storm, only with motion allowed, at most one every ~8 s
    let fl = 0;
    if (now.storm > 0.5) {                     // with Reduce motion the storm still rolls (thunder) but never flashes
      L.next -= dt;
      if (L.next <= 0) {
        L.next = 8 + Math.random() * 14; L.t = 0; L.amp = 0.6 + 0.4 * Math.random(); L.dist = 350 + Math.random() * 1600; L.seq++;
        const a = Math.random() * Math.PI * 2, el = 0.12 + Math.random() * 0.4; L.dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
        L.last = { seq: L.seq, time, dist: L.dist, dir: L.dir.clone(), amp: L.amp };
      }
    } else L.next = Math.max(L.next, 4);
    // (fl stays 0 with Reduce motion: see below)
    if (L.t >= 0) { L.t += dt; fl = reduceMotion ? 0 : flash(L.t) * L.amp * Math.min(1, now.storm); if (L.t > 3) L.t = -1; }
    const fk = fl * Math.min(1, 900 / L.dist);
    // surface
    U.uWx.value.set(now.wet, now.dust, fk > 0.001 ? fk : 0, now.rain);
    U.uWxFlash.value.set(0.55, 0.6, 0.8).multiplyScalar(fk * 0.32);
    const c = now.cloud;
    U.uWxSky.value.set(0.010 + 0.012 * c, 0.011 + 0.012 * c, 0.020 + 0.010 * c).addScaledVector(U.uWxFlash.value, 1.2);
    // sky
    SU.uWxCloud.value = c; SU.uWxWind.value = now.wind; SU.uWxBolt.value.copy(L.dir); SU.uWxFlash.value.set(0.55, 0.6, 0.85).multiplyScalar(fl * 0.10);
    // lake
    if (water && wBase) {
      WU.uWx.value.set(now.rain > 0.001 ? Math.min(1.3, now.rain) : 0, c, fk > 0.001 ? fk : 0, 0);
      water.material.uniforms.uWind.value = wBase.wind * (1 + 0.8 * now.wind + 0.4 * Math.min(1, now.rain));
      water.material.uniforms.uRough.value = wBase.rough * (1 + 0.6 * Math.min(1, now.rain) + 0.5 * now.wind);
    }
    // moonlight behind cloud (and with it the moon shadows)
    surface.uniforms.uMoonCol.value.copy(moon0).multiplyScalar(1 - 0.85 * c);
    // fog: density everywhere, colour toward the weather's (lighter, greyer) air
    if ((fogScan -= dt) < 0) { fogScan = 2; scanFog(); }
    for (const [u, v] of fogBase) u.value = v * now.fog;
    if (wxFog) tmpC.setRGB(wxFog[0], wxFog[1], wxFog[2]); else tmpC.copy(fogCol0);
    fogCol.lerp(tmpC, Math.min(1, dt / 3));
    if (Math.abs(fogCol.r - tmpC.r) + Math.abs(fogCol.g - tmpC.g) + Math.abs(fogCol.b - tmpC.b) < 3e-5) fogCol.copy(tmpC);
    if (!wxFog && now.fog === 1) fogCol.copy(fogCol0);       // Clear: exactly the park's own fog
    FOG.copy(fogCol);
    const fx = getFx && getFx();
    if (fx && fx.mist && fx.mist.userData.density) { const u = fx.mist.userData.density; if (u.base === undefined) u.base = u.value; u.value = u.base * now.mist; }
    return L.t < 0 && fogCol.equals(fogCol0);
  }
  // the lake and the sky are patched as soon as they exist (also in Clear, where the additions are switched off), so
  // the first change of weather does not recompile them
  const patch = () => { if (!water) patchWater(); if (!sky) patchSky(); return !!water; };
  // (the sky is patched by fx/sky.js too, possibly later: only our insertions are taken out of it)
  const unpatch = (only) => { for (const [m, [n, f]] of orig) if (!only || only === n) { m.fragmentShader = f !== null ? f : m.fragmentShader.replace(SKY_DECL + '\n    ', '').replace(SKY_CODE, ''); m.needsUpdate = true; orig.delete(m); } };
  return { update, patch, unpatch, done, U, SU, WU, lightning: L };
}
