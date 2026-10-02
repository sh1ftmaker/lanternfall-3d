// Shared day/night uniforms and GLSL (fx/game/daynight/README.md). Every value defaults to "night": with uDay = 0 each
// shader takes exactly the path it always had, so the park at 23:00 is unchanged; the daynight module moves them.
import * as THREE from 'three';

// the night sky's colours (app.js sky, fx/water.js skyCol)
export const NIGHT = { zen: [0.007, 0.010, 0.036], mid: [0.030, 0.036, 0.105], hor: [0.075, 0.062, 0.145], glow: [0.060, 0.034, 0.016] };

export function createDayUniforms() {
  const v = (a) => new THREE.Vector3().fromArray(a);
  return {
    uDay: { value: 0 },                                   // 0 = night, exactly; > 0 = any dusk term is live
    uSunDir: { value: new THREE.Vector3(-1, 0.05, 0).normalize() }, uSunCol: { value: v([0, 0, 0]) }, uSunOn: { value: 0 },
    uAmbSky: { value: v([0, 0, 0]) }, uAmbGnd: { value: v([0, 0, 0]) }, uAmbGlow: { value: v([0, 0, 0]) },     // sky light on albedo: from above, from the ground, towards the sunset
    uLamps: { value: 1 },                                 // 0..1: baked lamp / lantern / window light (sweeps out from the East Gate)
    uSkyZen: { value: v(NIGHT.zen) }, uSkyMid: { value: v(NIGHT.mid) }, uSkyHor: { value: v(NIGHT.hor) }, uSkyGlow: { value: v(NIGHT.glow) },
    uSunGlow: { value: v([0, 0, 0]) }, uSunDisc: { value: v([0, 0, 0]) }, uSkyLift: { value: v([0, 0, 0]) },
    uStar: { value: 1 }, uMoonAmt: { value: 1 },
    uGlassSky: { value: v([0, 0, 0]) },
  };
}

// uniform declarations for a fragment or vertex shader that uses the chunks below
export const DN_DECL = /* glsl */`
  uniform float uDay, uSunOn, uLamps, uStar, uMoonAmt;
  uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGnd, uAmbGlow, uSkyZen, uSkyMid, uSkyHor, uSkyGlow, uSunGlow, uSunDisc, uSkyLift, uGlassSky;
`;
// lamp sweep: 0..1 per world position (xz, three.js axes). The gate is at (288, 0); lamps fade up there first and the
// light spreads west along the avenue, then round the lands. uLamps >= 1 returns exactly 1.
export const DN_LAMP = /* glsl */`
  float dnLamp(vec2 xz){
    if (uLamps >= 1.0) return 1.0;
    float s = min(length(xz - vec2(288.0, 0.0)) * (1.0 / 640.0), 1.0), k = clamp((uLamps - 0.6 * s) / 0.4, 0.0, 1.0);
    return k * k * (3.0 - 2.0 * k);
  }`;
// the sun in the sky: disc, glow and the bright belt along the sunset horizon (added to the sky colour; h = clamp(d.y))
export const DN_SKY = /* glsl */`
  vec3 dnSunSky(vec3 d, float h){
    float ang = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
    vec2 f = normalize(uSunDir.xz + vec2(1e-5)), a = normalize(d.xz + vec2(1e-5));
    float az = max(dot(a, f), 0.0), belt = exp(-max(h, 0.0) * 7.0), lo = exp(-max(h, 0.0) * 22.0);
    vec3 c = uSunGlow * (belt * (0.18 + 0.82 * az * az * az * az) * 0.6 + lo * (0.4 + 0.6 * az * az) * 0.5 + 0.55 * exp(-ang * 3.2) + 1.1 * exp(-ang * 11.0));
    c += uSunDisc * (smoothstep(0.019, 0.0145, ang) * 26.0 + 2.2 * exp(-ang * 55.0));
    return c;
  }`;
