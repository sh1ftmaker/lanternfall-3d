// Park guests: rendering (fx/guests/render.js).
//
// Reads the crowd state written by the simulation (fx/guests/sim.js; a small stand-in crowd is built here until it
// exists) and draws the guests with GPU instancing, no skeletons on the CPU:
//   - two procedural meshes (fx/guests/assets.js: ~300-400 triangles near, ~70 at mid range) posed by a procedural rig
//     in the vertex shader (fx/guests/assets-rig.js): walk (phase-locked so feet do not slide), stand idle, take a
//     photo, wave / point up at the lanterns, sit, lean on a rail; clip changes blend over uBlend seconds;
//   - camera-facing impostor cards far away, glowing dots for carried lanterns / balloons / phone screens (they stay
//     visible from the air), soft contact shadows (a blob plus a faint moon shadow) on the ground;
//   - lighting from the ground-light grid (data/guests.json -> guestlight.bin: the baked light a guest standing there
//     receives) + the park's shadow-mapped moonlight (fx/surface.js uniforms) + hemisphere shaping + rim + fog.
// Per frame the CPU sorts guests into LOD buckets (frustum + projected size) and uploads one float texture with the
// state; 5 instanced draw calls in all. Works in the lake's planar mirror (guests near the shore are drawn first so the
// mirror pass draws only that prefix), keeps glowing parts out of AO (alpha > 1 as fx/ao.js expects), caps the
// dynamic near plane (fx/depth.js) so close guests are not clipped, and survives a WebGL context loss (all GPU data is
// re-uploaded from CPU copies).
//
// API: const g = createGuests({ THREE, scene, crowd, uTime, Q, manifest, DATA, fetchBin, surface, mobile,
//                               renderer?, camera?, depth?, nav?, focus?, reduceMotion? })
//   g.update(camera, dt)            every frame, after the camera moved and before the lake's mirror pass
//   g.setVisible(b) / g.setDensity(0..1) / g.setReduceMotion(b) / g.degrade(adaptStep) / g.dispose()
//   g.setCrowd(crowd, { drive })    hand over a simulation (drive: g.update() also calls crowd.update(dt, time, focus))
//   g.stats, g.prof(true) + g.profResult() (GPU ms per draw), g.cfg (= Q.guests: LOD thresholds, ambient, rim ...)
// crowd = null: a stand-in crowd of random walkers is built from `nav` ('#guests=N' sets its size).
// Hash tokens: '#no-guests' (app.js), '#crowd' (app.js: real simulation), '#guests=N', '#guests-avenue'.
import { buildGuestGeometry, guestLook, lookMask, ITEMS } from './assets.js';
import { RIG, LIGHT } from './assets-rig.js';
import { DN_DECL, DN_LAMP } from '../game/daynight/uniforms.js';      // game hook: daynight
// the sun's shadow (surface.uniforms.tShadowS) and the lamp sweep, for the vertex stage; sun and sky light are added in the fragment stage
const DN_VS = /* glsl */`
  ${DN_DECL}
  ${DN_LAMP}
  uniform sampler2D tShadowS; uniform mat4 uShadowMS; uniform float uShadowOnS, uSSizeS;
  float shTapS(vec2 uv, float z){ return step(z, unpackRGBAToDepth(texture2D(tShadowS, uv))); }
  float sunShadowG(vec3 p){
    if (uShadowOnS < 0.5) return 1.0;
    vec4 sc = uShadowMS * vec4(p + vec3(0.0, 0.25, 0.0), 1.0); vec3 q = sc.xyz * 0.5 + 0.5;
    if (any(lessThan(q.xy, vec2(0.002))) || any(greaterThan(q.xy, vec2(0.998))) || q.z > 0.999) return 1.0;
    float z = q.z - 0.0006;
    vec2 t = q.xy * uSSizeS - 0.5, f = fract(t), b = (floor(t) + 0.5) / uSSizeS, o = vec2(1.0 / uSSizeS, 0.0);
    return mix(mix(shTapS(b, z), shTapS(b + o.xy, z), f.x), mix(shTapS(b + o.yx, z), shTapS(b + o.xx, z), f.x), f.y);
  }`;
const DN_LIGHT = /* glsl */`
  vec3 dnLightG(vec3 n, float sh){
    vec2 sf = normalize(uSunDir.xz + vec2(1e-5));
    return uSunCol * (max(dot(n, uSunDir), 0.0) * sh) + mix(uAmbGnd, uAmbSky, n.y * 0.5 + 0.5) + uAmbGlow * max(dot(n, vec3(sf.x, 0.0, sf.y)), 0.0);
  }`;

const TW = 1024;                         // float texture width (texels)
const DYN = 4, LOOKN = 8;                // texels per guest: state, look

// ── look -> 8 texels ──
function packLook(L, out, o) {
  out[o + 0] = L.height; out[o + 1] = L.girth; out[o + 2] = L.shape; out[o + 3] = L.belly;
  out[o + 4] = L.lf; out[o + 5] = L.hs; out[o + 6] = L.stoop; out[o + 7] = lookMask(L);
  out[o + 8] = L.hair; out[o + 9] = L.top; out[o + 10] = L.lower; out[o + 11] = L.item;
  out[o + 12] = L.arms; out[o + 13] = L.swing; out[o + 14] = L.bounce; out[o + 15] = (L.child ? 1 : 0) + (L.balloonGlow ? 0.75 : 0.25);
  const C = L.colors;
  out[o + 16] = C.skin; out[o + 17] = C.hair; out[o + 18] = C.top; out[o + 19] = C.inner;
  out[o + 20] = C.bottom; out[o + 21] = C.skirt; out[o + 22] = C.shoes; out[o + 23] = C.accent;
  out[o + 24] = C.legs; out[o + 25] = C.item; out[o + 26] = L.kind; out[o + 27] = 0;
}

// ── shaders ──
const COLORS = /* glsl */`
  vec3 lc(int gi, int k){ int c = k & 3; vec4 v = gL(gi, 4 + (k >> 2)); return unpackCol(c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w); }
  // look colour slots: 0 skin 1 hair 2 top 3 inner 4 bottom 5 skirt 6 shoes 7 accent 8 legs 9 item
  vec3 regionColor(int reg, int gi, G g, out vec3 emit){
    emit = vec3(0.0);
    if (reg == 0) return lc(gi, 0);
    if (reg == 20) return lc(gi, 0) * 1.08;
    if (reg == 1) return lc(gi, 1);
    if (reg == 2) return lc(gi, 2);
    if (reg == 3) return g.lower == 4 ? lc(gi, 5) : lc(gi, 4);
    if (reg == 4) return lc(gi, 6);
    if (reg == 5) return lc(gi, 7);
    if (reg == 6) return (g.top == 2 || g.top == 3) ? lc(gi, 3) : lc(gi, 2);
    if (reg == 7) return lc(gi, 8);
    if (reg == 8) return vec3(0.16, 0.10, 0.055);
    if (reg == 9) { vec3 c = lc(gi, 9); emit = c * c * vec3(2.6, 2.2, 1.9); return c * 0.5; }
    if (reg == 10) { vec3 c = lc(gi, 9); if (g.bglow > 0.5) emit = c * 0.55; return c; }
    if (reg == 11) return vec3(0.62, 0.58, 0.52);
    if (reg == 12) return vec3(0.02, 0.02, 0.025);
    if (reg == 13) { emit = vec3(0.42, 0.62, 1.0) * 1.15; return vec3(0.02); }
    if (reg == 14) return vec3(0.5, 0.48, 0.45);
    if (reg == 15) return (g.top == 0 || g.top == 4) ? lc(gi, 0) : lc(gi, 2);
    if (reg == 16) return g.top == 4 ? lc(gi, 0) : lc(gi, 2);
    if (reg == 17) return g.lower <= 1 ? lc(gi, 4) : lc(gi, 8);
    if (reg == 18) return g.lower == 0 ? lc(gi, 4) : g.lower == 1 ? lc(gi, 0) : lc(gi, 8);
    if (reg == 19) return (g.lower == 4 && g.top == 4) ? lc(gi, 2) : lc(gi, 5);
    return vec3(0.5);
  }`;

const BODY_VS = /* glsl */`
  ${RIG}
  ${LIGHT}
  ${DN_VS}
  ${COLORS}
  attribute vec3 aOff; attribute vec4 aInfo; attribute vec4 aW; attribute float aIdx;
  varying vec3 vW, vAlb, vGL, vEmit; varying float vSh, vDist, vSS;
  void main(){
    int gi = int(aIdx + 0.5);
    vec4 s0 = gS(gi, 0), s1 = gS(gi, 1), s2 = gS(gi, 2), s3 = gS(gi, 3);
    G g = look(gi, s1.w);
    int reg = int(aInfo.x + 0.5), grp = int(aInfo.y + 0.5), b0 = int(aInfo.z + 0.5), b1 = int(aInfo.w + 0.5);
    int anim = int(s1.y + 0.5), prevA = int(s2.x + 0.5);
    bool phoneOn = g.item == 5 || anim == 2 || (prevA == 2 && uTime - s2.z < uBlend);
    bool vis = grp == 0 || ((g.mask >> grp) & 1) == 1 || (grp == 16 && phoneOn);
    if (!vis) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vW = vec3(0.0); vAlb = vGL = vEmit = vec3(0.0); vSh = vDist = vSS = 0.0; return; }
    float bt;
    Pose P = guestPose(gi, s1, s2, s3, g, bt);
    vec3 lp = morph(position, aOff, aW, b0, g);
    vec3 cp = (boneM(b0, P, g) * vec4(lp, 1.0)).xyz;
    if (aW.x > 0.0) cp = mix(cp, (boneM(b1, P, g) * vec4(lp + pivRef(b0) - pivRef(b1), 1.0)).xyz, aW.x);
    vW = toWorld(cp, s0, g.h);
    vAlb = regionColor(reg, gi, g, vEmit);
    vGL = groundLight(s0.xy);
    if (uDay > 0.0) vGL *= dnLamp(vec2(s0.x, -s0.y));                              // game hook: daynight
    if (g.item == 1 || g.item == 2) {               // a carried paper lantern lights its bearer
      vec3 lw = toWorld((boneM(14, P, g) * vec4(0.0, -0.17, 0.0, 1.0)).xyz, s0, g.h);
      vec3 c = lc(gi, 9); float d2 = dot(vW - lw, vW - lw);
      vGL += c * c * 0.16 / (0.04 + d2);
    }
    if (phoneOn && b0 == 2 && anim == 2) vGL += vec3(0.05, 0.08, 0.14);                  // phone screen on the face
    vSh = uMoonOn > 0.5 ? moonShadow(vW) : 0.0;
    vSS = uSunOn > 0.5 ? sunShadowG(vW) : 0.0;                                      // game hook: daynight
    vDist = length(vW - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
  }`;
const BODY_FS = /* glsl */`
  uniform vec3 uFog, uMoon, uMoonCol; uniform float uFogD, uMoonOn, uAmb, uRim, uMoonK;
  ${DN_DECL}
  ${DN_LIGHT}
  varying vec3 vW, vAlb, vGL, vEmit; varying float vSh, vDist, vSS;
  void main(){
    vec3 dx = dFdx(vW), dy = dFdy(vW); vec3 n = normalize(cross(dx, dy));
    vec3 V = normalize(cameraPosition - vW); if (dot(n, V) < 0.0) n = -n;
    float hemi = 0.7 + 0.3 * n.y;
    vec3 light = vGL * hemi * uAmb + uMoonCol * (max(dot(n, uMoon), 0.0) * vSh * uMoonOn * uMoonK);
    if (uDay > 0.0) light += dnLightG(n, vSS);                                       // game hook: daynight
    vec3 col = vAlb * light;
    float fr = 1.0 - max(dot(n, V), 0.0); fr = fr * fr * fr;
    col += fr * uRim * (vGL * 0.7 + uMoonCol * 0.6 * uMoonOn) * (0.3 + 0.7 * vAlb);
    col += vEmit;
    float f = 1.0 - exp(-vDist * vDist * uFogD);
    col = mix(col, uFog, f);
    // alpha > 1 marks glow for the AO pass (fx/final.js keeps emissive pixels out of AO)
    gl_FragColor = vec4(col, 1.0 + dot(vEmit, vec3(0.2126, 0.7152, 0.0722)) * (1.0 - f));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// impostor: a camera-facing card with a painted silhouette (far away)
const IMP_VS = /* glsl */`
  ${RIG}
  ${LIGHT}
  ${DN_VS}
  attribute float aIdx;
  varying vec2 vP; varying vec3 vGL; varying float vSh, vDist, vSS;
  flat varying vec3 vSkin, vHair, vTop, vLow, vLeg, vShoe; flat varying vec4 vI;
  void main(){
    int gi = int(aIdx + 0.5);
    vec4 s0 = gS(gi, 0), s1 = gS(gi, 1);
    G g = look(gi, s1.w);
    int anim = int(s1.y + 0.5);
    float H = 1.78 * g.h, W = 0.31 * g.h * sqrt(g.girth);
    vec3 base = vec3(s0.x, s0.z, -s0.y);
    bool sit = anim == 4;
    if (sit) { base.y -= 0.45; H *= 0.8; }
    vec3 tc = cameraPosition - base; tc.y = 0.0; tc = length(tc) > 1e-4 ? normalize(tc) : vec3(0.0, 0.0, 1.0);
    vec3 right = vec3(tc.z, 0.0, -tc.x);
    vec3 w = base + right * position.x * W + vec3(0.0, position.y * H, 0.0);
    vP = vec2(position.x * 0.31 * sqrt(g.girth), position.y * 1.78);
    vSkin = unpackCol(gL(gi, 4).x); vHair = unpackCol(gL(gi, 4).y); vTop = unpackCol(gL(gi, 4).z);
    vec4 c5 = gL(gi, 5), c6 = gL(gi, 6);
    vLow = unpackCol(g.lower == 0 || g.lower == 1 ? c5.x : g.lower == 4 && g.top == 4 ? gL(gi, 4).z : c5.y);
    vLeg = unpackCol(g.lower == 0 ? c5.x : c6.x); vShoe = unpackCol(c5.z);
    float hat = ((g.mask >> 6) & 7) != 0 ? 1.0 : 0.0;
    vI = vec4(sqrt(g.girth), float(g.lower >= 2 ? 1 : 0) + (g.top == 3 ? 2.0 : 0.0), sit ? 1.0 : 0.0, hat + (g.hair == 5 ? 2.0 : 0.0));
    vGL = groundLight(s0.xy);
    if (uDay > 0.0) vGL *= dnLamp(vec2(s0.x, -s0.y));                              // game hook: daynight
    vSh = uMoonOn > 0.5 ? moonShadow(base + vec3(0.0, 1.2, 0.0)) : 0.0;
    vSS = uSunOn > 0.5 ? sunShadowG(base + vec3(0.0, 1.2, 0.0)) : 0.0;
    vDist = length(w - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`;
const IMP_FS = /* glsl */`
  uniform vec3 uFog, uMoonCol; uniform float uFogD, uMoonOn, uAmb;
  ${DN_DECL}
  varying vec2 vP; varying vec3 vGL; varying float vSh, vDist, vSS;
  flat varying vec3 vSkin, vHair, vTop, vLow, vLeg, vShoe; flat varying vec4 vI;
  void main(){
    float x = abs(vP.x), y = vP.y, gw = vI.x;
    if (vI.z > 0.5) y = y / 0.8;                       // seated: a shorter card, same bands
    vec3 c; bool hit = false;
    float hr = length(vec2(vP.x, y - 1.6));
    if (hr < 0.115) { c = (y > 1.6 || vI.w > 0.5) && vI.w < 1.5 ? vHair : vSkin; hit = true; }
    else if (y > 1.43 && y < 1.53 && x < 0.05) { c = vSkin; hit = true; }
    else {
      float tw = mix(0.15, 0.19, smoothstep(0.95, 1.38, y)) * gw;
      if (y > 0.86 && y < 1.47 && x < tw) { c = vTop; hit = true; }
      else if (y > 0.82 && y < 1.42 && x < tw + 0.075 && x > tw) { c = y < 0.9 ? vSkin : vTop; hit = true; }
      else if (mod(vI.y, 2.0) > 0.5 && y > 0.52 && y < 0.98 && x < mix(0.22, 0.16, (y - 0.52) / 0.46) * gw) { c = vLow; hit = true; }
      else if (vI.y > 1.5 && y > 0.5 && y < 0.98 && x < 0.2 * gw) { c = vTop; hit = true; }
      else if (y < 0.9 && x < 0.15 * gw && x > 0.02) { c = y < 0.08 ? vShoe : y > 0.5 ? vLow : vLeg; hit = true; }
    }
    if (!hit) discard;
    vec3 col = c * (vGL * uAmb * 0.85 + uMoonCol * 0.35 * vSh * uMoonOn);
    if (uDay > 0.0) col += c * (uSunCol * (0.4 * vSS) + mix(uAmbGnd, uAmbSky, 0.65) + uAmbGlow * 0.3);       // game hook: daynight
    float f = 1.0 - exp(-vDist * vDist * uFogD);
    gl_FragColor = vec4(mix(col, uFog, f), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// glow halos / far dots for things that shine: paper lanterns, glowing balloons, phone screens (+ the odd flash)
const GLOW_VS = /* glsl */`
  ${RIG}
  attribute float aIdx; uniform float uScale, uMinPx;
  varying vec2 vQ; varying vec3 vCol;
  void main(){
    int gi = int(aIdx + 0.5);
    vec4 s0 = gS(gi, 0), s1 = gS(gi, 1), s2 = gS(gi, 2), s3 = gS(gi, 3);
    G g = look(gi, s1.w);
    int anim = int(s1.y + 0.5);
    float bt; Pose P = guestPose(gi, s1, s2, s3, g, bt);
    vec3 ic = unpackCol(gL(gi, 6).y), col; vec3 a; float size;
    if (g.item == 1 || g.item == 2) { a = (boneM(14, P, g) * vec4(0.0, g.item == 1 ? -0.17 : -0.14, 0.0, 1.0)).xyz; col = ic * ic * vec3(0.8, 0.65, 0.55); size = g.item == 1 ? 0.5 : 0.36; }
    else if (g.item == 3 && g.bglow > 0.5) { a = (boneM(13, P, g) * vec4(0.0, 0.2, 0.0, 1.0)).xyz; col = ic * 0.12; size = 0.42; }
    else if (g.item == 5 || anim == 2) {
      a = (boneM(15, P, g) * vec4(0.0, 0.012, -0.02, 1.0)).xyz; col = vec3(0.3, 0.45, 0.8) * 0.2; size = 0.12;
      float u = fract(uTime * 0.09 * uMotion + g.seed * 13.7);
      float fl = anim == 2 ? smoothstep(0.0, 0.004, u) * (1.0 - smoothstep(0.006, 0.02, u)) : 0.0;          // a flash every ~11 s
      col += vec3(4.0, 3.9, 3.6) * fl; size += 0.9 * fl;
    } else { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vQ = vec2(0.0); vCol = vec3(0.0); return; }
    vec3 w = toWorld(a, s0, g.h);
    vec4 mv = viewMatrix * vec4(w, 1.0);
    float dist = max(-mv.z, 0.05);
    float px = size * uScale / dist;
    float k = px < uMinPx ? px * px / (uMinPx * uMinPx) : 1.0;
    float r = max(px, uMinPx) * dist / uScale;
    vCol = col * k * mix(1.0, 3.0, smoothstep(5.0, 1.2, px)) * mix(1.0, 0.3, smoothstep(25.0, 160.0, px)) * smoothstep(0.6, 1.5, dist);   // far dots a little brighter, near halos softer
    float pull = (dist - min(0.35, dist * 0.5)) / dist;   // pulled towards the eye along the view ray so the body does not cut it
    mv.xyz *= pull;
    mv.xy += position.xy * r * pull;
    gl_Position = projectionMatrix * mv;
    vQ = position.xy;
  }`;
const GLOW_FS = /* glsl */`
  varying vec2 vQ; varying vec3 vCol;
  void main(){
    float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
    float a = exp(-d2 * 4.5) * (1.0 - d2);
    vec3 c = vCol * a;
    gl_FragColor = vec4(c, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// contact shadow: a soft blob under the feet, darker where the ground is brightly lit, plus a faint moon shadow
const SHADOW_VS = /* glsl */`
  ${RIG}
  ${LIGHT}
  attribute float aIdx; uniform vec3 uMoon, uMoonCol; uniform float uFogD;
  varying vec2 vL; varying vec3 vK; varying float vMoonLen;
  void main(){
    int gi = int(aIdx + 0.5);
    vec4 s0 = gS(gi, 0), s1 = gS(gi, 1);
    G g = look(gi, s1.w);
    int anim = int(s1.y + 0.5);
    vec3 base = vec3(s0.x, s0.z, -s0.y);
    if (anim == 4) base.y -= 0.45;                                     // seat top -> floor (benches are ~0.45 m)
    vec2 d = -normalize(uMoon.xz); vec2 pp = vec2(d.y, -d.x);       // (d, pp) keeps the quad facing up
    float h = g.h, L = 1.6 * h * length(uMoon.xz) / max(uMoon.y, 0.2);       // h: height scale (1 = 1.72 m)
    float u0 = -0.75 * h, u1 = L + 0.25 * h, wv = 0.7 * h;
    float u = mix(u0, u1, position.x * 0.5 + 0.5), v = position.y * wv;
    vec3 w = base + vec3(d.x * u + pp.x * v, 0.03, d.y * u + pp.y * v);
    vL = vec2(u, v) / h; vMoonLen = L / h;
    vec3 gl = groundLight(s0.xy); float lg = dot(gl, vec3(0.3, 0.5, 0.2)), lm = dot(uMoonCol, vec3(0.3, 0.5, 0.2)) * uMoonOn;
    float sh = uMoonOn > 0.5 ? moonShadow(base + vec3(0.0, 1.0, 0.0)) : 0.0;
    float dist = length(w - cameraPosition), fog = exp(-dist * dist * uFogD);
    vK = vec3(mix(0.45, 0.8, smoothstep(0.015, 0.3, lg)), 0.55 * sh * lm / (lm + lg * 1.5 + 1e-4), anim == 4 ? 0.0 : 1.0) * fog;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`;
const SHADOW_FS = /* glsl */`
  varying vec2 vL; varying vec3 vK; varying float vMoonLen;
  void main(){
    float b = exp(-dot(vL * vec2(1.0, 1.25), vL * vec2(1.0, 1.25)) * 3.2);   // ~0.55 m soft footprint
    float t = clamp(vL.x / vMoonLen, 0.0, 1.0);
    float ds = length(vec2(vL.x - t * vMoonLen, vL.y));
    float m = smoothstep(0.17, 0.06, ds) * (1.0 - 0.7 * t) * smoothstep(-0.05, 0.12, vL.x) * vK.z;
    float k = max(vK.x * b, vK.y * m);
    if (k < 0.004) discard;
    gl_FragColor = vec4(vec3(1.0 - k), 1.0);
  }`;

// ── the stand-in crowd: random walkers on the walk grid + a few hand-placed figures (until fx/guests/sim.js) ──
export function createStandInCrowd({ nav, count = 1200, seed = 7, reduceMotion = false, places = [], avenue = false }) {
  const N = count, state = new Float32Array(N * 8);
  let rs = seed >>> 0; const rnd = () => { rs = (rs + 0x6d2b79f5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const navH = (v) => (v - 1) / 100 - 2;
  const level = (x, y, z) => {
    const i = Math.floor((x - nav.x0) / nav.cell), j = Math.floor((y - nav.y0) / nav.cell);
    if (i < 0 || j < 0 || i >= nav.w || j >= nav.h) return null;
    const k = j * nav.w + i, a = nav.A[k], b = nav.B[k];
    let best = null, bd = 0.45;
    for (const v of [a, b]) { if (!v) continue; const h = navH(v), dd = Math.abs(h - z); if (dd < bd) { bd = dd; best = h; } }
    return best;
  };
  const hot = (x, y) => {                       // busier on the avenue and the lake promenade
    const r = Math.hypot(x, y);
    if (x > 140 && x < 335 && Math.abs(y) < 22) return 1;
    if (avenue) return 0;                       // '#guests-avenue': everyone on the Lamplighters' Walk (crowd test)
    if (r > 98 && r < 130) return 0.8;
    return 0.12;
  };
  const spawn = (i) => {
    for (let t = 0; t < 400; t++) {
      const x = avenue ? 140 + rnd() * 195 : nav.x0 + rnd() * nav.w * nav.cell, y = avenue ? -22 + rnd() * 44 : nav.y0 + rnd() * nav.h * nav.cell;
      const ii = Math.floor((x - nav.x0) / nav.cell), jj = Math.floor((y - nav.y0) / nav.cell), v = nav.A[jj * nav.w + ii];
      if (!v || rnd() > hot(x, y)) continue;
      const o = i * 8; state[o] = x; state[o + 1] = y; state[o + 2] = navH(v); state[o + 3] = rnd() * Math.PI * 2;
      return true;
    }
    return false;
  };
  const ag = [];                                   // per-guest stand-in behaviour
  for (let i = 0; i < N; i++) {
    spawn(i);
    const o = i * 8;
    state[o + 4] = 0; state[o + 5] = 0; state[o + 6] = rnd() * 50; state[o + 7] = rnd();
    ag.push({ v: 0.95 + rnd() * 0.55, timer: rnd() * 20, stopT: 0, anim: 0, turn: 0, fixed: false });
  }
  // hand-placed figures: [x, y, z?, yaw, anim]
  const fixed = places;
  for (let k = 0; k < fixed.length && k < N; k++) {
    const [x, y, z, yaw, anim] = fixed[k], o = k * 8;
    state[o] = x; state[o + 1] = y; state[o + 2] = z ?? (level(x, y, 0) ?? 0); state[o + 3] = yaw; state[o + 5] = anim;
    ag[k].fixed = true; ag[k].anim = anim;
  }
  let active = N, motion = !reduceMotion;
  function update(dt, time) {
    dt = Math.min(dt, 0.1);
    for (let i = 0; i < N; i++) {
      const o = i * 8, a = ag[i];
      if (i >= active) { state[o + 5] = 255; continue; }
      if (a.fixed) { state[o + 5] = a.anim; state[o + 4] = 0; continue; }
      if (!motion) { state[o + 5] = a.anim === 0 ? 1 : a.anim; state[o + 4] = 0; continue; }
      a.timer -= dt;
      if (a.anim !== 0) {                                       // stopped: look, photo, wave
        state[o + 4] = 0; state[o + 5] = a.anim;
        if (a.timer < 0) { a.anim = 0; a.timer = 8 + rnd() * 30; }
        continue;
      }
      if (a.timer < 0) { const r = rnd(); a.anim = r < 0.5 ? 1 : r < 0.8 ? 2 : 3; a.timer = 3 + rnd() * 7; state[o + 4] = 0; state[o + 5] = a.anim; continue; }
      const sp = a.v, yaw = state[o + 3] + a.turn * dt;
      const nx = state[o] + Math.cos(yaw) * sp * dt, ny = state[o + 1] + Math.sin(yaw) * sp * dt;
      const z = state[o + 2], la = level(nx + Math.cos(yaw) * 0.6, ny + Math.sin(yaw) * 0.6, z), lb = level(nx, ny, z);
      if (la === null || lb === null) { state[o + 3] = yaw + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 2.2); state[o + 4] = 0.0; continue; }
      if (rnd() < dt * 0.15) a.turn = (rnd() - 0.5) * 0.6; else if (rnd() < dt * 0.3) a.turn = 0;
      state[o] = nx; state[o + 1] = ny; state[o + 2] = z + (lb - z) * Math.min(1, dt * 10); state[o + 3] = yaw;
      state[o + 4] = sp; state[o + 5] = 0; state[o + 6] += sp * dt / 1.4;
    }
  }
  return { count: N, state, update, want: N, setCount(n) { active = Math.max(0, Math.min(N, n)); }, setReduceMotion(b) { motion = !b; }, debug: { standIn: true } };
}

// ── the renderer ──
// opts: { THREE, scene, crowd, uTime, Q, manifest, DATA, fetchBin, surface, mobile,
//         renderer?, camera?, depth?, nav?, places?, mirror?: () => bool, reduceMotion?, count? }
export function createGuests(opts) {
  const { THREE, scene, uTime, Q, manifest, DATA, surface, mobile } = opts;
  let crowd = opts.crowd || null, ownCrowd = false;
  const MAXG = opts.max || (mobile ? 800 : 2400);
  const hash = typeof location !== 'undefined' ? decodeURIComponent(location.hash) : '';
  const cfg = Object.assign({
    count: mobile ? 400 : 1500,           // stand-in crowd size
    lod0Px: mobile ? 42 : 34,             // projected height (CSS px) above which the full mesh is drawn
    lod1Px: 7.5, impPx: 1.4,              // ... the cheap mesh, the impostor card; below: only glowing items
    blend: 0.35, amb: 1.6, rim: 0.6, moonK: 1.0, minDot: mobile ? 1.4 : 1.6, density: 1,
  }, Q.guests || {});
  { const m = /guests=(\d+)/.exec(hash); if (m) cfg.count = +m[1]; }
  Q.guests = cfg;
  const st = { visible: true, reduceMotion: !!opts.reduceMotion, step: 0, density: 1 };

  // float textures: per-guest state (4 texels) and look (8 texels)
  const rowsS = Math.ceil(MAXG * DYN / TW), rowsL = Math.ceil(MAXG * LOOKN / TW);
  const sData = new Float32Array(TW * rowsS * 4), lData = new Float32Array(TW * rowsL * 4);
  const mkTex = (data, rows) => { const t = new THREE.DataTexture(data, TW, rows, THREE.RGBAFormat, THREE.FloatType); t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
  const tState = mkTex(sData, rowsS), tLook = mkTex(lData, rowsL);
  // ground light (filled when data/guests.json arrives)
  let lightGrid = null;
  const tLight = new THREE.DataTexture(new Uint8Array([40, 36, 52, 2]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tLight.needsUpdate = true;
  const U = {
    tState: { value: tState }, tLook: { value: tLook }, uTime, uMotion: { value: st.reduceMotion ? 0 : 1 }, uBlend: { value: cfg.blend },
    tLight: { value: tLight }, uLightXf: { value: new THREE.Vector4(0, 0, 1, 1) }, uLightRange: { value: manifest.range || 32 }, uLightOn: { value: 0 },
    uLightFallback: { value: new THREE.Vector3(0.05, 0.045, 0.065) },
    tShadow: surface.uniforms.tShadow, uShadowM: surface.uniforms.uShadowM, uShadowOn: surface.uniforms.uShadowOn, uSSize: surface.uniforms.uSSize,
    uMoonOn: surface.uniforms.uMoonOn, uMoon: surface.uniforms.uMoon, uMoonCol: surface.uniforms.uMoonCol,
    ...(surface.dn || {}), tShadowS: surface.uniforms.tShadowS, uShadowMS: surface.uniforms.uShadowMS, uShadowOnS: surface.uniforms.uShadowOnS, uSSizeS: surface.uniforms.uSSizeS,   // game hook: daynight
    uFog: surface.uniforms.uFog, uFogD: surface.uniforms.uFogD,
    uAmb: { value: cfg.amb }, uRim: { value: cfg.rim }, uMoonK: { value: cfg.moonK },
    uScale: { value: 500 }, uMinPx: { value: cfg.minDot },
  };

  // geometries
  const idxAttrs = [];
  const instIdx = () => { const a = new THREE.InstancedBufferAttribute(new Float32Array(MAXG), 1); a.setUsage(THREE.DynamicDrawUsage); idxAttrs.push(a); return a; };
  function bodyGeo(lod) {
    const d = buildGuestGeometry(lod), g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
    g.setAttribute('aOff', new THREE.BufferAttribute(d.aOff, 3));
    g.setAttribute('aInfo', new THREE.BufferAttribute(d.aInfo, 4));
    g.setAttribute('aW', new THREE.BufferAttribute(d.aW, 4));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.setAttribute('aIdx', instIdx());
    g.instanceCount = 0; g.userData.tris = d.tris; g.userData.verts = d.verts;
    return g;
  }
  function quadGeo(y0 = -1) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, y0, 0, 1, y0, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]); g.setAttribute('aIdx', instIdx()); g.instanceCount = 0; return g;
  }
  const mat = (vs, fs, extra = {}) => new THREE.ShaderMaterial({ uniforms: U, vertexShader: vs, fragmentShader: fs, ...extra });
  const bodyMat = mat(BODY_VS, BODY_FS);
  const impMat = mat(IMP_VS, IMP_FS);
  const glowMat = mat(GLOW_VS, GLOW_FS, { transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
  glowMat.userData.glowMarked = true;            // fx/ao.js: already adds its luminance to alpha
  const shadowMat = mat(SHADOW_VS, SHADOW_FS, { transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });

  const mk = (geo, m, order, name) => { const o = new THREE.Mesh(geo, m); o.frustumCulled = false; o.renderOrder = order; o.name = 'guests-' + name; o.matrixAutoUpdate = false; o.userData.n = 0; o.userData.nm = 0; return o; };
  const M = {
    lod0: mk(bodyGeo(0), bodyMat, 0, 'lod0'), lod1: mk(bodyGeo(1), bodyMat, 0, 'lod1'), imp: mk(quadGeo(0), impMat, 0, 'imp'),
    shadow: mk(quadGeo(), shadowMat, 2, 'shadow'), glow: mk(quadGeo(), glowMat, 9, 'glow'),
  };
  const group = new THREE.Group(); group.name = 'guests';
  for (const k in M) group.add(M[k]);
  scene.add(group);
  let mainCam = opts.camera || null;
  // GPU timing of the guest draws (EXT_disjoint_timer_query_webgl2): guests.prof(true), read guests.profResult()
  const prof = { on: false, gl: null, ext: null, pending: [], acc: {}, frames: 0, cur: null };
  function profBegin(r, name) {
    if (!prof.on || prof.cur) return;
    if (!prof.gl) { prof.gl = r.getContext(); prof.ext = prof.gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
    if (!prof.ext) return;
    const q = prof.gl.createQuery(); prof.gl.beginQuery(prof.ext.TIME_ELAPSED_EXT, q); prof.cur = [name, q];
  }
  function profEnd() { if (!prof.cur) return; prof.gl.endQuery(prof.ext.TIME_ELAPSED_EXT); prof.pending.push([...prof.cur, prof.frames]); prof.cur = null; }
  function profPoll() {
    if (!prof.on || !prof.gl) return;
    prof.frames++;
    const gl = prof.gl, dis = gl.getParameter(prof.ext.GPU_DISJOINT_EXT), keep = [];
    for (const e of prof.pending) {
      if (!gl.getQueryParameter(e[1], gl.QUERY_RESULT_AVAILABLE)) { keep.push(e); continue; }
      if (!dis) { const f = (prof.acc[e[2]] ||= {}); f[e[0]] = (f[e[0]] || 0) + gl.getQueryParameter(e[1], gl.QUERY_RESULT) / 1e6; }
      gl.deleteQuery(e[1]);
    }
    prof.pending = keep;
  }
  // per pass: main view draws everything, the lake mirror only the shore prefix, cube captures nothing
  for (const k in M) {
    const o = M[k], g = o.geometry;
    o.onBeforeRender = (r, s, cam) => {
      const rt = r.getRenderTarget();
      let n = o.userData.n;
      if (rt && (rt.isWebGLCubeRenderTarget || rt.isCubeRenderTarget)) n = 0;
      else if (mainCam && cam !== mainCam) n = k === 'shadow' ? 0 : o.userData.nm;
      g.instanceCount = n;
      if (prof.on && n > 0) profBegin(r, k + (mainCam && cam !== mainCam ? '-mirror' : ''));
      if (k === 'glow') { const h = rt ? (rt.scissorTest ? rt.scissor.w : rt.height) : r.domElement.height; U.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; }
    };
    o.onAfterRender = () => { if (prof.cur) profEnd(); };
  }

  // per-guest renderer state
  const cur = new Uint8Array(MAXG).fill(255), prevA = new Uint8Array(MAXG), prevPh = new Float32Array(MAXG), t0 = new Float32Array(MAXG).fill(-1e4);
  const prevZ = new Float32Array(MAXG), lastPh = new Float32Array(MAXG), lastZ = new Float32Array(MAXG), sSpeed = new Float32Array(MAXG), prevSp = new Float32Array(MAXG);
  const seedOf = new Float32Array(MAXG).fill(-1), hOf = new Float32Array(MAXG), glowOf = new Uint8Array(MAXG);
  const buckets = { lod0: new Float32Array(MAXG), lod1: new Float32Array(MAXG), imp: new Float32Array(MAXG), glow: new Float32Array(MAXG), shadow: new Float32Array(MAXG) };
  const tmp = { lod0: new Float32Array(MAXG), lod1: new Float32Array(MAXG), imp: new Float32Array(MAXG), glow: new Float32Array(MAXG), shadow: new Float32Array(MAXG) };
  const stats = { count: 0, lod0: 0, lod1: 0, imp: 0, glow: 0, shadow: 0, mirror: 0, cpuMs: 0, simMs: 0, nearest: Infinity, tris: 0, lightGrid: false, standIn: false };

  // lake shore grid: guests here can show up in the lake's mirror (4 m cells, within 14 m of the lake polygon)
  const lake = manifest.lake || [], W0 = manifest.water_z ?? -0.8;
  const shore = { x0: 0, y0: 0, w: 0, h: 0, c: 4, g: null };
  if (lake.length > 2) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of lake) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 16; shore.x0 = x0 - pad; shore.y0 = y0 - pad; shore.w = Math.ceil((x1 - x0 + 2 * pad) / shore.c); shore.h = Math.ceil((y1 - y0 + 2 * pad) / shore.c);
    shore.g = new Uint8Array(shore.w * shore.h);
    for (let j = 0; j < shore.h; j++) for (let i = 0; i < shore.w; i++) {
      const px = shore.x0 + (i + 0.5) * shore.c, py = shore.y0 + (j + 0.5) * shore.c; let best = 1e9;
      for (let a = 0, b = lake.length - 1; a < lake.length; b = a++) {
        const [ax, ay] = lake[a], [bx, by] = lake[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)), ex = ax + t * dx - px, ey = ay + t * dy - py;
        best = Math.min(best, ex * ex + ey * ey);
      }
      shore.g[j * shore.w + i] = best < 16 * 16 ? 1 : 0;
    }
  }
  const nearShore = (x, y) => { if (!shore.g) return false; const i = Math.floor((x - shore.x0) / shore.c), j = Math.floor((y - shore.y0) / shore.c); return i >= 0 && j >= 0 && i < shore.w && j < shore.h && shore.g[j * shore.w + i] === 1; };

  // ground-light grid
  (async () => {
    try {
      const res = await fetch(DATA + 'guests.json' + (manifest.build ? '?v=' + manifest.build : ''), { cache: 'no-cache' });
      if (!res.ok) return;
      const js = await res.json(); const L = js.light; if (!L) return;
      const buf = await opts.fetchBin(L.file);
      if (buf.length < L.w * L.h * 4) return;
      const t = new THREE.DataTexture(buf.subarray(0, L.w * L.h * 4), L.w, L.h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
      U.tLight.value = t; tLight.dispose(); lightGrid = { data: buf, w: L.w, h: L.h, x0: L.x0, y0: L.y0, cell: L.cell, range: L.range || 32 };   // also read by fx/game (lightAt)
      U.uLightXf.value.set(L.x0, L.y0, 1 / (L.w * L.cell), 1 / (L.h * L.cell)); U.uLightOn.value = 1; stats.lightGrid = true;
      if (L.range) U.uLightRange.value = L.range;
      if (js.pois) stats.pois = js.pois.length;
    } catch (e) { console.warn('guests: no ground-light grid', e.message); }
  })();

  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), cpos = new THREE.Vector3(), PL = new Float32Array(24);
  function ensureCrowd() {
    if (crowd) return true;
    const nav = opts.nav && (typeof opts.nav === 'function' ? opts.nav() : opts.nav);
    if (!nav || opts.standIn === false) return false;       // standIn: false = wait for setCrowd() (the real simulation)
    crowd = createStandInCrowd({ nav, count: Math.min(cfg.count, MAXG), reduceMotion: st.reduceMotion, places: opts.places || STANDIN_PLACES, avenue: /guests-avenue/.test(hash) });
    ownCrowd = true; stats.standIn = true;
    return true;
  }
  let lastT = 0;
  function update(camera, dt) {
    const t0c = performance.now();
    if (camera) mainCam = camera;
    camera = mainCam;
    if (!st.visible || !ensureCrowd() || !camera) { for (const k in M) { M[k].visible = false; } return; }
    const time = uTime.value;
    profPoll();
    if (ownCrowd) {          // the stand-in, or a simulation handed over with setCrowd(c, {drive: true})
      const ts = performance.now();
      crowd.update(dt, time, opts.focus ? opts.focus() : { x: camera.position.x, y: -camera.position.z, z: camera.position.y, mode: 'orbit' });
      stats.simMs = stats.simMs * 0.95 + (performance.now() - ts) * 0.05;
    }
    const tr0 = performance.now();
    const n = Math.min(crowd.count, MAXG), S = crowd.state;
    const lim = crowd.setCount ? n : Math.floor(n * st.density);      // a crowd with setCount() thins itself out
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    for (let k = 0; k < 6; k++) { const pl = frustum.planes[k]; PL[k * 4] = pl.normal.x; PL[k * 4 + 1] = pl.normal.y; PL[k * 4 + 2] = pl.normal.z; PL[k * 4 + 3] = pl.constant; }
    const inFrustum = (x, y, z, r) => { for (let k = 0; k < 24; k += 4) if (PL[k] * x + PL[k + 1] * y + PL[k + 2] * z + PL[k + 3] < -r) return false; return true; };
    cpos.setFromMatrixPosition(camera.matrixWorld);
    const r = opts.renderer, pr = r ? r.getPixelRatio() : 1, H = r ? r.domElement.height / pr : 900;
    const fpx = 0.5 * H * camera.projectionMatrix.elements[5];          // CSS px per metre at 1 m
    const T0 = cfg.lod0Px * (st.step >= 2 ? 1.6 : 1), T1 = cfg.lod1Px * (st.step >= 3 ? 1.5 : 1), T2 = cfg.impPx * (st.step >= 3 ? 1.8 : 1);
    const cnt = { lod0: 0, lod1: 0, imp: 0, glow: 0, shadow: 0 }, cm = { lod0: 0, lod1: 0, imp: 0, glow: 0, shadow: 0 };
    const put = (k, i, shoreFirst) => { if (shoreFirst) buckets[k][cm[k]++] = i; else tmp[k][cnt[k]++] = i; };
    let lookDirty = false, nearest = Infinity;
    const ks = Math.min(1, dt * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 8, anim = S[o + 5], so = i * DYN * 4;
      if (i >= lim || !(anim >= 0 && anim < 255)) { cur[i] = 255; continue; }
      const seed = S[o + 7];
      if (seed !== seedOf[i]) {
        const L = guestLook(seed); packLook(L, lData, i * LOOKN * 4); seedOf[i] = seed; hOf[i] = L.height;
        const it = ITEMS[L.item]; glowOf[i] = it === 'stickLantern' || it === 'handLantern' || it === 'phone' || (it === 'balloon' && L.balloonGlow) ? 1 : 0;
        lookDirty = true; cur[i] = 255;
      }
      const x = S[o], y = S[o + 1], z = S[o + 2], ph = S[o + 6], sp = S[o + 4];
      if (anim !== cur[i]) {
        if (cur[i] !== 255) { prevA[i] = cur[i]; prevPh[i] = lastPh[i]; t0[i] = time; prevZ[i] = lastZ[i] - z; prevSp[i] = sSpeed[i]; }
        else { prevA[i] = anim; t0[i] = -1e4; prevZ[i] = 0; sSpeed[i] = sp; }
        cur[i] = anim;
      }
      sSpeed[i] += (sp - sSpeed[i]) * ks;
      lastPh[i] = ph; lastZ[i] = z;
      sData[so] = x; sData[so + 1] = y; sData[so + 2] = z; sData[so + 3] = S[o + 3];
      sData[so + 4] = sSpeed[i]; sData[so + 5] = anim; sData[so + 6] = ph; sData[so + 7] = seed;
      sData[so + 8] = prevA[i]; sData[so + 9] = prevPh[i]; sData[so + 10] = t0[i]; sData[so + 11] = prevZ[i];
      sData[so + 12] = prevSp[i];
      if (st.reduceMotion && anim === 0 && sp > 0.05) continue;          // no gliding statues: walkers are hidden
      const h = hOf[i], cy = z + 0.9 * h, cz = -y;
      const rad = 1.25 * h + (glowOf[i] ? 0.6 : 0);
      const vis = inFrustum(x, cy, cz, rad);
      const sh = nearShore(x, y);
      const mirror = sh && inFrustum(x, 2 * W0 - cy, cz, rad);
      if (!vis && !mirror) continue;
      const dx = x - cpos.x, dy = cy - cpos.y, dz = cz - cpos.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dx * dx + dz * dz < 0.72 && Math.abs(dy) < 1.6) continue;      // never draw a guest the camera is standing inside (Walk spawns, tight lanes)
      const px = 1.75 * h * fpx / Math.max(d, 0.1);
      if (vis && d - 0.95 * h < nearest) nearest = d - 0.95 * h;
      const first = sh && mirror;
      if (px > T0) { put('lod0', i, first); put('shadow', i, false); }
      else if (px > T1) { put('lod1', i, first); put('shadow', i, false); }
      else if (px > T2) put('imp', i, first);
      if (glowOf[i] || anim === 2) put('glow', i, first);
    }
    let tris = 0;
    for (const k in M) {
      const b = buckets[k], m = cm[k], tot = m + cnt[k];
      b.set(tmp[k].subarray(0, cnt[k]), m);
      const o = M[k], a = o.geometry.attributes.aIdx;
      a.array.set(b.subarray(0, tot)); a.clearUpdateRanges(); if (tot) a.addUpdateRange(0, tot); a.needsUpdate = tot > 0;
      o.userData.n = tot; o.userData.nm = m; o.geometry.instanceCount = tot; o.visible = tot > 0;
      stats[k] = tot;
      if (o.geometry.userData.tris) tris += tot * o.geometry.userData.tris;
    }
    stats.mirror = cm.lod0 + cm.lod1 + cm.imp;
    tState.needsUpdate = true;
    if (lookDirty) tLook.needsUpdate = true;
    stats.count = lim; stats.nearest = nearest; stats.tris = tris;
    if (opts.depth) opts.depth.cap = nearest < 30 ? Math.max(0.05, 0.5 * nearest) : Infinity;
    stats.cpuMs = stats.cpuMs * 0.95 + (performance.now() - tr0) * 0.05;
    lastT = time;
  }

  function setVisible(b) { st.visible = !!b; group.visible = st.visible; if (!b) { for (const k in M) M[k].visible = false; if (opts.depth) opts.depth.cap = Infinity; } }
  // density 0..1 of the crowd's size at the time of the first call: the simulation drops / adds guests itself
  let baseCount = -1;
  function setDensity(f) {
    st.density = Math.max(0, Math.min(1, f)); cfg.density = st.density;
    if (crowd && crowd.setCount) { if (baseCount < 0) baseCount = crowd.want ?? crowd.count; crowd.setCount(Math.round(baseCount * st.density)); }
  }
  function setReduceMotion(b) { st.reduceMotion = !!b; U.uMotion.value = b ? 0 : 1; if (crowd && crowd.setReduceMotion) crowd.setReduceMotion(b); }
  // app.js adapt() ladder: coarser LOD only. The crowd is never thinned or hidden for speed (only the Guests switch does that)
  function degrade(step) { st.step = step; }
  function dispose() {
    scene.remove(group);
    for (const k in M) { M[k].geometry.dispose(); }
    for (const m of [bodyMat, impMat, glowMat, shadowMat]) m.dispose();
    tState.dispose(); tLook.dispose(); if (U.tLight.value) U.tLight.value.dispose();
    if (opts.depth) opts.depth.cap = Infinity;
  }
  function profResult() {
    const per = {}; const fr = Object.keys(prof.acc).map(Number).sort((a, b) => a - b).slice(3, -2);
    for (const f of fr) { const row = prof.acc[f]; let sum = 0; for (const [k, v] of Object.entries(row)) { (per[k] ||= []).push(v); sum += v; } (per.total ||= []).push(sum); }
    const out = {}; for (const [k, a] of Object.entries(per)) { a.sort((x, y) => x - y); out[k] = +a[a.length >> 1].toFixed(3); }
    out.frames = fr.length; return out;
  }
  return { get light() { return lightGrid; }, update, setVisible, prof(on) { prof.on = !!on; prof.acc = {}; prof.frames = 0; prof.pending = []; prof.cur = null; prof.gl = null; }, profResult, setDensity, setReduceMotion, degrade, dispose, stats, meshes: M, group, uniforms: U, cfg,
    allowStandIn() { opts.standIn = true; },
    get crowd() { return crowd; }, setCrowd(c, o = {}) { crowd = c; ownCrowd = !!o.drive; baseCount = -1; if (st.density < 1) setDensity(st.density); stats.standIn = false; seedOf.fill(-1); cur.fill(255); if (c && c.setReduceMotion) c.setReduceMotion(st.reduceMotion); },
    get visible() { return st.visible; } };
}

// stand-in figures placed by hand (Blender x, y, z|null, yaw, anim) near the test poses: the avenue, the lake rail
const STANDIN_PLACES = [
  [276, 4.5, null, -2.6, 2], [276.8, 5.2, null, -2.4, 1], [262, -6, null, 2.9, 3], [262.6, -6.8, null, 2.7, 1],
  [250, 3, null, 0.4, 1], [250.7, 3.9, null, -2.6, 1], [244, -5, null, -1.7, 2], [230, 6, null, 3.1, 3],
  [104.0, 3.2, null, Math.PI, 5], [104.2, -2.8, null, Math.PI, 5], [104.1, -6.4, null, Math.PI, 2], [105.5, 7.5, null, 2.8, 1],
  [196, 4, null, -2.0, 1], [197, 3.2, null, 2.2, 1], [208, -4, null, 1.4, 2],
];
