// The look: exposure, tone mapping, HDR emitters and one fog path, in one place (after the LanternTown skill's
// references/look.md). Everything here is a knob read from the URL hash (#u_<name>=value) and kept live on
// window.__park.look, so pictures are tuned on one loaded page with uniforms, not reloads.
//
//   - emitters: glowing pixels (surface class 7: lamp mantles, lit windows, signs) are expanded at run time,
//       k = min(glow * max(L / pivot, 1)^hot, max(top / L, 1)),
//     (the skill's formula with a pivot: this park's bake already puts lit windows ~1.6 stops over white) so the brighter a thing was baked the more it gains (mantles end 3-5 stops over white, windows 1-2) and bloom,
//     fog and wet streaks have real light to spread. Colours no flame has (not r >= g >= b: cyan, violet, pink) get
//     `neon` times the gain and the ceiling, so a neon tube does not end at the level of a lit window.
//   - fog: the park's squared-distance haze (exp(-d^2 D), so the first tens of metres stay clear) now thins with
//     height (scale height `fogh`, averaged along the line of sight), shared by the park surface, the sky dome, the
//     lake and the final pass (which smears light by the same fog share; fx/final.js). Density and colour stay the
//     uniforms the weather module drives (uFogD, uFog), so its fog keeps working.
// Hooked into fx/surface.js through the '// @decl' and '// @light' markers and the line after the fog line (left
// untouched for fx/weather/shade.js); app.js calls installLook() once, right after createSurface().
import * as THREE from 'three';
import { loadGlare } from './glare.js';

// knob: [default, softer, stronger] (the report hands over all three)
export const KNOBS = {
  // emitters, bloom and glare calmed after the owner found the lamps themselves too bright and the bloom too strong (the
  // light they throw is baked and unchanged); the strongest column is the first shipped look
  exposure: [2.5, 2.1, 2.9],    // multiplies the scene before tone mapping (grey card 0.18 -> pixel 127 at 1.0 with ACES, 128 AgX;
                                // this park's bake is dim, paving 0.01-0.03; the owner asked for the old look's brightness, and 2.5
                                // matches the old captures' mean brightness view by view to within a few %; the old look sat at 169)
  tm: [2, 1, 0],                // 0 = the old look (AgX x2.1 + S-curve grade), 1 = AgX, 2 = ACES
  grade: [0, 0, 0.42],          // the old S-curve grade strength (saturation follows it)
  bloom: [0.10, 0.07, 0.14],    // natural bloom: blend towards the blurred pyramid
  fogsmear: [0.7, 0.5, 1.0],    // how much fogged pixels take the blurred picture instead of the sharp one
  glow: [0.85, 0.65, 1.2],        // emitter gain at and below the pivot
  hot: [2.0, 1.5, 2.5],         // how fast the gain rises with baked brightness above the pivot
  pivot: [3.0, 3.5, 2.5],       // baked value where the gain starts rising (this park bakes lit windows ~3, mantles and festoons ~5.6)
  top: [16, 8, 48],            // emitter ceiling (scene units)
  neon: [1.8, 1.4, 2.5],        // gain and ceiling factor for colours no flame has
  fog: [1.0, 0.6, 1.5],         // fog density multiplier (on top of the weather's)
  fogh: [18, 12, 30],           // fog scale height (m)
  fogfloor: [0.3, 0.5, 0.15],   // share of the haze that does not thin with height (views from high up keep some air; 0 = all thins)
  glare: [1.0, 0.6, 1.5],       // glare sprites on real fittings (fx/light/glare.js)
  // broad glowing panels (lit windows, podium fascias, ice crystals, over-lit white panels; the pack's panel code, see
  // panelGLSL below): their own soft ceiling instead of the lamp gain, so they keep colour and pattern
  bigtop: [0.38, 0.32, 0.5],    // panel ceiling (scene units; x exposure 2.5 ~ 0.95: bright, but below ACES white)
  bigdet: [1.0, 0.6, 1.3],      // strength of the panel pattern (panes, lattice, ice sheen, facet shading)
};
function readHash() {
  const out = {}; const h = location.hash.replace(/^#/, '');
  for (const t of h.split(/[&,]/)) { const m = /^u_([a-z]+)=(-?[\d.]+)$/.exec(t); if (m && m[1] in KNOBS) out[m[1]] = parseFloat(m[2]); }
  const s = /(?:^|[&,])show=(\w+)/.exec(h); out.show = s ? s[1] : '';
  return out;
}

// shared uniforms (one object per knob, so every material that uses one follows a change)
const H = readHash();
const v = (k) => ({ value: k in H ? H[k] : KNOBS[k][0] });
export const LOOK = {
  uGlow: v('glow'), uHot: v('hot'), uPivot: v('pivot'), uTop: v('top'), uNeon: v('neon'),
  uFogK: v('fog'), uFogH: v('fogh'), uFogFloor: v('fogfloor'), uFogBase: { value: 0 },
  uBloomMix: v('bloom'), uFogSmear: v('fogsmear'), uGrade: v('grade'), uTM: v('tm'), uExposure: v('exposure'), uGlare: v('glare'),
  uBigTop: v('bigtop'), uBigDet: v('bigdet'),
  uShow: { value: { hdr: 1, card: 2, emit: 3 }[H.show] || 0 },     // emit: glowing faces red (lamp gain) .. green (broad panel)
  uFogD: null,          // the surface's density uniform (weather-scaled), set by installLook
};

// fog share for a point at distance d and height y1 seen from height y0 (camera). The density falls as exp(-y / H);
// its mean along the segment multiplies the squared-distance optical depth.
export const FOG_GLSL = /* glsl */`
  uniform float uFogK, uFogH, uFogBase, uFogFloor;
  float lookFog(float d, float y0, float y1, float D){
    float a = max(y0 - uFogBase, 0.0) / uFogH, b = max(y1 - uFogBase, 0.0) / uFogH, e = b - a;
    float hf = abs(e) < 1e-3 ? exp(-a) : (exp(-a) - exp(-b)) / e;
    return 1.0 - exp(-d * d * D * uFogK * mix(hf, 1.0, uFogFloor));
  }`;

const EMIT_GLSL = /* glsl */`
  uniform float uGlow, uHot, uPivot, uTop, uNeon;
  // HDR emitters: gain for a glowing pixel of colour c (see the header)
  vec3 lookEmit(vec3 c){
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    // a flame is r >= g >= b; how far a colour is from that, relative to its brightness, with some saturation
    float off = max(c.g - c.r, c.b - c.g) / max(mx, 1e-4);
    float neon = smoothstep(0.03, 0.12, off) * smoothstep(0.15, 0.35, (mx - mn) / max(mx, 1e-4));
    float nk = mix(1.0, uNeon, neon);
    float k = min(uGlow * nk * pow(max(L / uPivot, 1.0), uHot), max(uTop * nk / max(L, 1e-4), 1.0));
    return c * k;
  }
  // Broad glowing panels. The pack (web_export/pack.py EMIT_STYLES) codes every glowing triangle in its material-slot
  // plane: code = style * 8 + big, big 0..7 from the width of the flat panel the triangle belongs to (windows, fascias,
  // crystal facets: broad; lamp mantles, neon tubes, letters: 0). A broad panel is rolled off on its brightest channel
  // to the ceiling uBigTop with a soft knee at half of it (the hue survives the tone mapping), then patterned by style
  // in world space (the park has no UVs): 0 plain (a little shading by facing and a slow mottle, so a fascia reads as
  // a form), 1 glazing (panes and mullions, each pane its own brightness), 2 ice (faces seen edge-on brighter, a deep
  // colour face-on, streaks), 3 paper screens (a fine lattice). Small emitters keep lookEmit exactly.
  uniform float uBigTop, uBigDet, uShow;
  float lkLine(float x, float s, float w, float fw){ float d = abs(fract(x / s + 0.5) - 0.5) * s; return smoothstep(w - fw, w + fw, d); }
  vec3 lookPanel(vec3 c, float sty, vec3 dx, vec3 dy){
    float m = max(c.r, max(c.g, c.b)), K = uBigTop * 0.5;
    float mo = m <= K ? m : K + (uBigTop - K) * (1.0 - exp(-(m - K) / (uBigTop - K)));
    c *= mo / max(m, 1e-5);
    c = max(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.2), 0.0);        // a little more colour: ACES pales a bright panel
    vec3 n = normalize(cross(dx, dy)); float fw = max(length(dx), length(dy));
    float nv = abs(dot(n, normalize(cameraPosition - vW)));
    vec2 uv = abs(n.y) > 0.7 ? vW.xz : vec2(dot(vW.xz, normalize(vec2(-n.z, n.x) + 1e-6)), vW.y);
    float k;
    if (sty < 0.5) {
      k = mix(0.8, 1.0, nv) * (0.93 + 0.14 * vn(uv * 1.7));
    } else if (sty < 1.5) {
      vec2 sz = vec2(0.6, 0.8), id = floor(uv / sz + 0.5);
      float far = smoothstep(0.02, 0.07, fw);                                   // mullions under ~half a pixel: their average
      float mul = min(lkLine(uv.x, sz.x, 0.03, fw), lkLine(uv.y, sz.y, 0.03, fw));
      float pane = 0.78 + 0.27 * h21(id + 3.1);                                  // rooms / blinds: each pane its own level
      float grad = 0.9 + 0.12 * smoothstep(0.5, -0.5, fract(uv.y / sz.y + 0.5) - 0.5);   // a little brighter low in the pane
      k = mix(mix(0.3, 1.0, mul) * pane * grad, 0.82, far);
    } else if (sty < 2.5) {
      float e = 1.0 - nv; e *= e;
      k = mix(0.55, 1.2, e) * (0.88 + 0.24 * vn(vec2(dot(uv, vec2(0.7, 0.2)) * 3.0, uv.y * 0.6)));
      c = mix(c, c * c / max(max(c.r, max(c.g, c.b)), 1e-4), 0.55 * nv);         // face-on: deeper, more saturated colour
    } else {
      float far = smoothstep(0.012, 0.05, fw);
      float lat = min(lkLine(uv.x, 0.3, 0.012, fw), lkLine(uv.y, 0.36, 0.012, fw));
      k = mix(mix(0.35, 1.0, lat) * (0.94 + 0.12 * vn(uv * 4.0)), 0.88, far);
    }
    return c * mix(1.0, k, uBigDet);
  }`;

let installed = null;
export function installLook({ surface, scene, renderer, getWater }) {
  if (installed) return installed;
  LOOK.uFogD = surface.uniforms.uFogD;
  // exposure + tone mapping: the final pass reads these; the direct (no float target) path uses the renderer's
  renderer.toneMappingExposure = LOOK.uExposure.value;
  renderer.toneMapping = LOOK.uTM.value === 2 ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
  if (LOOK.uTM.value === 0 && !('exposure' in H)) LOOK.uExposure.value = renderer.toneMappingExposure = 2.1;

  // ── the park surface ──
  const m = surface.material; let fs = m.fragmentShader; const done = [];
  const out = 'gl_FragColor = vec4(mix(col, uFog, f), 1.0);';
  if (fs.includes('// @decl') && fs.includes('// @light') && fs.includes(out)) {
    fs = fs.replace('// @decl', FOG_GLSL + EMIT_GLSL + '\n      // @decl')
      .replace('// @light', `vec3 lkDx = dFdx(vW), lkDy = dFdy(vW);
        if (vCls > 6.5 && vCls < 7.5) {                                   // HDR emitters and broad panels (fx/light/look.js)
          float lkBig = mod(vEmK + 0.5, 8.0) - 0.5, lkSty = floor((vEmK + 0.5) / 8.0);
          vec3 ce = lookEmit(col);
          if (lkBig > 0.5) ce = mix(ce, lookPanel(col, lkSty, lkDx, lkDy), lkBig / 7.0);
          if (uShow > 2.5) ce = mix(vec3(0.5, 0.02, 0.02), vec3(0.02, 0.5, 0.05), lkBig / 7.0);
          col = uDay > 0.0 ? mix(col, ce, dnLamp(vW.xz)) : ce;
        } else if (uShow > 2.5) col = vec3(dot(col, vec3(0.3, 0.5, 0.2)));
        // @light`)
      .replace(out, 'f = lookFog(vDist, cameraPosition.y, vW.y, uFogD);       // height-thinned fog (fx/light/look.js)\n        ' + out);
    // the panel code rides in the material-slot attribute (fx/light/materials.js declares it when it is on)
    let vs = m.vertexShader; const va = 'vCls = floor(aAux.a * 255.0 + 0.5);';
    if (!vs.includes('attribute float aMat;')) vs = vs.replace('attribute vec4 aAux;', 'attribute vec4 aAux; attribute float aMat;');
    vs = vs.replace('attribute vec4 aAux;', 'attribute vec4 aAux; varying float vEmK;').replace(va, va + ' vEmK = aMat;');
    fs = fs.replace('// @decl', 'varying float vEmK;\n      // @decl');
    if (!m.defaultAttributeValues.aMat) m.defaultAttributeValues.aMat = [0];
    Object.assign(m.uniforms, LOOK_U(), { uBigTop: LOOK.uBigTop, uBigDet: LOOK.uBigDet, uShow: LOOK.uShow });
    m.vertexShader = vs; m.fragmentShader = fs; m.needsUpdate = true; done.push('surface');
  }
  // ── the sky dome (app.js): fogged like a front 600 m away, so the horizon meets the far lands in the same haze ──
  let sky = null;
  scene.traverse((o) => { if (!sky && o.isMesh && o.renderOrder === -1000 && o.material && o.material.fragmentShader && o.material.fragmentShader.includes('uMoon')) sky = o; });
  if (sky) {
    const sm = sky.material; let s = sm.fragmentShader;
    const tail = 'gl_FragColor = vec4(col, 1.0);';
    if (s.includes(tail)) {
      s = s.replace(/void\s+main\s*\(\s*\)\s*\{/, (x) => `uniform vec3 uFog; uniform float uFogD;\n${FOG_GLSL}\n    ${x}`)
        .replace(tail, 'col = mix(col, uFog, lookFog(600.0, cameraPosition.y, cameraPosition.y + 600.0 * max(d.y, 0.0), uFogD));   // fog (fx/light/look.js)\n      ' + tail);
      Object.assign(sm.uniforms, LOOK_U(), { uFog: surface.uniforms.uFog, uFogD: surface.uniforms.uFogD });
      sm.fragmentShader = s; sm.needsUpdate = true; done.push('sky');
    }
  }
  if (getWater) { const t = setInterval(() => { const w = getWater(); if (w && patchWater(w)) { done.push('water'); clearInterval(t); } }, 300); }
  installed = { done, LOOK, KNOBS, set, glare: null };
  // glare sprites on real fittings (fx/light/glare.js), when the data has the bake's light list
  loadGlare({ scene, fog: { uFog: surface.uniforms.uFog, uFogD: surface.uniforms.uFogD } }).then((g) => { installed.glare = g; if (g) done.push('glare ' + g.count); });
  const t2 = setInterval(() => { if (window.__park) { window.__park.look = installed; clearInterval(t2); } }, 200);
  return installed;
}
// set a knob by name on the live page: __park.look.set('exposure', 1.1)
function set(k, x) {
  const u = { exposure: 'uExposure', tm: 'uTM', grade: 'uGrade', bloom: 'uBloomMix', fogsmear: 'uFogSmear', glow: 'uGlow', hot: 'uHot', pivot: 'uPivot', top: 'uTop', neon: 'uNeon', fog: 'uFogK', fogh: 'uFogH', fogfloor: 'uFogFloor', glare: 'uGlare', bigtop: 'uBigTop', bigdet: 'uBigDet', show: 'uShow' }[k];
  if (!u) return false; LOOK[u].value = x; return true;
}
const LOOK_U = () => ({ uGlow: LOOK.uGlow, uHot: LOOK.uHot, uPivot: LOOK.uPivot, uTop: LOOK.uTop, uNeon: LOOK.uNeon, uFogK: LOOK.uFogK, uFogH: LOOK.uFogH, uFogBase: LOOK.uFogBase, uFogFloor: LOOK.uFogFloor });

// the lake (fx/water.js), once it exists: same fog, after the line fx/weather/shade.js anchors on
function patchWater(w) {
  if (!w || !w.material || w.material.userData.look) return false;
  const m = w.material; let fs = m.fragmentShader;
  const out = 'gl_FragColor = vec4(mix(col, uFog, fogf), 1.0);';
  if (!fs.includes(out)) return false;
  fs = fs.replace(/void main\(\)\{/, FOG_GLSL + '\n      void main(){')
    .replace(out, 'fogf = lookFog(dist, cameraPosition.y, vW.y, uFogD);       // height-thinned fog (fx/light/look.js)\n        ' + out);
  Object.assign(m.uniforms, LOOK_U()); m.fragmentShader = fs; m.needsUpdate = true; m.userData.look = true;
  return true;
}
