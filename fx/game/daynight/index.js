// fx/game/daynight: dusk to night, driven by game.clock. See README.md.
// The module owns a pure function of the clock (at(t)): sun, sky, ambient light, fog, stars, moon, lamps. Every frame the
// eased state is written to the shared uniforms (fx/game/daynight/uniforms.js, created in app.js and used by the park
// surface, the sky, the lake, the forest, glass, guests and Wick). From 19:30 the state IS the night one, bit for bit.
import { NIGHT } from './uniforms.js';

const T0 = 17 * 60 + 30, T_NIGHT = 19 * 60 + 30, T_LAMPS = 19 * 60 + 15;
// keyframes (minutes, linear colours before tone mapping). The last one is night: nothing of the dusk is left in it.
const K = [
  { t: T0, zen: [0.030, 0.052, 0.19], mid: [0.19, 0.115, 0.30], hor: [0.80, 0.30, 0.15], sg: [1.3, 0.45, 0.11], as: [0.115, 0.115, 0.22], ag: [0.12, 0.07, 0.06], aw: [0.28, 0.10, 0.035], fog: [0.26, 0.15, 0.17], star: 0.0, moon: 0.3 },
  { t: 18 * 60, zen: [0.018, 0.034, 0.13], mid: [0.10, 0.065, 0.24], hor: [0.46, 0.15, 0.13], sg: [0.8, 0.2, 0.06], as: [0.075, 0.075, 0.17], ag: [0.06, 0.035, 0.05], aw: [0.14, 0.05, 0.04], fog: [0.15, 0.075, 0.10], star: 0.02, moon: 0.5 },
  { t: 18 * 60 + 30, zen: [0.012, 0.02, 0.07], mid: [0.05, 0.045, 0.14], hor: [0.17, 0.08, 0.14], sg: [0.28, 0.08, 0.05], as: [0.04, 0.042, 0.10], ag: [0.022, 0.018, 0.035], aw: [0.06, 0.025, 0.03], fog: [0.06, 0.035, 0.08], star: 0.45, moon: 0.8 },
  { t: 19 * 60, zen: [0.0085, 0.013, 0.045], mid: [0.036, 0.04, 0.115], hor: [0.10, 0.07, 0.155], sg: [0.05, 0.02, 0.02], as: [0.009, 0.011, 0.03], ag: [0.005, 0.004, 0.01], aw: [0.01, 0.005, 0.007], fog: [0.025, 0.02, 0.055], star: 0.95, moon: 1 },
  { t: T_NIGHT, zen: NIGHT.zen, mid: NIGHT.mid, hor: NIGHT.hor, sg: [0, 0, 0], as: [0, 0, 0], ag: [0, 0, 0], aw: [0, 0, 0], fog: null, star: 1, moon: 1 },
];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

export function init(game) {
  const { THREE, ctx } = game, DN = ctx.DN, surface = ctx.surface, FOG = ctx.FOG;
  if (!DN) return null;
  const FOG0 = FOG.clone();                                         // the park's own night fog (what the weather's Clear keeps)
  const FOGN = [FOG0.r, FOG0.g, FOG0.b];
  K[K.length - 1].fog = FOGN;

  // ── the pure part: state at clock time t (minutes) ──
  function at(t) {
    const night = t >= T_NIGHT || t < 600;
    const tt = night ? T_NIGHT : Math.max(t, 900);
    const el = tt >= T_NIGHT ? -40 : 6.5 - (tt - T0) * 0.2;           // sun elevation (deg): 6.5 at 17:30, sets about 18:02, -17.5 at 19:30
    const az = Math.max(0, tt - T0) * 0.0005;                          // due west at 17:30 (behind the Spire from the East Gate), drifting north
    const ce = Math.cos(el * Math.PI / 180), se = Math.sin(el * Math.PI / 180);
    const sun = { x: -ce * Math.cos(az), y: ce * Math.sin(az), z: se };    // Blender frame
    let a = K[0], b = K[0], f = 0;
    if (tt >= K[K.length - 1].t) a = b = K[K.length - 1];
    else if (tt > K[0].t) { let i = 1; while (K[i].t < tt) i++; a = K[i - 1]; b = K[i]; f = (tt - a.t) / (b.t - a.t); }
    const m = (k) => (night ? K[K.length - 1][k] : mix3(a[k], b[k], f));
    const sunK = sstep(-1.2, 1.2, el), warm = sstep(-1, 6, el), high = sstep(6, 30, el);
    const sunCol = night ? [0, 0, 0] : [(2.1 - 0.2 * warm) * sunK, (0.36 + 0.4 * warm + 0.4 * high) * sunK, (0.08 + 0.2 * warm + 0.4 * high) * sunK];
    const disc = night ? 0 : sstep(-1.9, -0.7, el);
    const lamps = night || tt >= T_LAMPS ? 1 : sstep(T0, T_LAMPS, tt);
    const fogv = m('fog');
    return {
      t, night, phase: night ? 'night' : 'dusk', el,
      sun: { x: sun.x, y: sun.y, z: sun.z }, sunCol, sunDisc: [1.0 * disc, 0.52 * disc, 0.22 * disc],
      zen: m('zen'), mid: m('mid'), hor: m('hor'), sunGlow: m('sg'),
      ambSky: m('as'), ambGnd: m('ag'), ambGlow: m('aw'), fog: fogv,
      stars: night ? 1 : mix3([a.star, 0, 0], [b.star, 0, 0], f)[0], moon: night ? 1 : mix3([a.moon, 0, 0], [b.moon, 0, 0], f)[0],
      lamps,
    };
  }

  // ── applying it ──
  const U = DN, tmp = new THREE.Vector3(), fogAdd = [0, 0, 0];
  let state = at(game.clock.t), tc = clampT(game.clock.t), lastTc = NaN, lastCloud = NaN, phase = state.phase, applied = false;
  function clampT(t) { return t >= T_NIGHT || t < 600 ? T_NIGHT : Math.min(Math.max(t, 900), T_NIGHT); }
  let shadowDir = null, envT = -1e9, envDusk = false;
  const setV = (u, a) => u.value.set(a[0], a[1], a[2]);
  const wx = () => (game.weather && game.weather.now ? game.weather.now : null);

  function apply(s, cloud) {
    if (s.night) {
      if (U.uDay.value === 0 && applied === false) return;
      U.uDay.value = 0; U.uSunOn.value = 0; U.uLamps.value = 1; U.uStar.value = 1; U.uMoonAmt.value = 1;
      setV(U.uSunCol, [0, 0, 0]); setV(U.uAmbSky, [0, 0, 0]); setV(U.uAmbGnd, [0, 0, 0]); setV(U.uAmbGlow, [0, 0, 0]);
      setV(U.uSkyZen, NIGHT.zen); setV(U.uSkyMid, NIGHT.mid); setV(U.uSkyHor, NIGHT.hor); setV(U.uSkyGlow, NIGHT.glow);
      setV(U.uSunGlow, [0, 0, 0]); setV(U.uSunDisc, [0, 0, 0]); setV(U.uSkyLift, [0, 0, 0]); setV(U.uGlassSky, [0, 0, 0]);
      fogAdd[0] = fogAdd[1] = fogAdd[2] = 0; applied = false; return;
    }
    applied = true;
    U.uDay.value = 1;
    tmp.set(s.sun.x, s.sun.z, -s.sun.y).normalize(); U.uSunDir.value.copy(tmp);
    setV(U.uSunCol, s.sunCol); U.uSunOn.value = s.sunCol[0] > 0.01 ? 1 : 0;
    setV(U.uAmbSky, s.ambSky); setV(U.uAmbGnd, s.ambGnd); setV(U.uAmbGlow, s.ambGlow);
    U.uLamps.value = s.lamps; U.uStar.value = s.stars; U.uMoonAmt.value = s.moon;
    setV(U.uSkyZen, s.zen); setV(U.uSkyMid, s.mid); setV(U.uSkyHor, s.hor); setV(U.uSkyGlow, NIGHT.glow);
    setV(U.uSunGlow, s.sunGlow); setV(U.uSunDisc, s.sunDisc);
    // a weather deck hides the dusk sky: light it by the sky instead (added after the deck in the sky shader)
    const l = clamp(cloud, 0, 1);
    U.uSkyLift.value.set((s.mid[0] - NIGHT.mid[0]) * 0.55 * l, (s.mid[1] - NIGHT.mid[1]) * 0.55 * l, (s.mid[2] - NIGHT.mid[2]) * 0.55 * l);
    U.uGlassSky.value.set(s.mid[0] * 0.45, s.mid[1] * 0.45, s.mid[2] * 0.5);
    for (let i = 0; i < 3; i++) fogAdd[i] = s.fog[i] - FOGN[i];
  }

  // fog: the weather writes FOG (when it is not Clear); the dusk colour is added after it, taken off before it next frame
  const base = new THREE.Color().copy(FOG0); let fogOn = false;
  ctx.dayFog.pre = () => { if (fogOn) FOG.copy(base); };
  ctx.dayFog.post = () => {
    const any = fogAdd[0] !== 0 || fogAdd[1] !== 0 || fogAdd[2] !== 0;
    if (!any && !fogOn) return;
    base.copy(FOG); fogOn = any;
    if (any) FOG.setRGB(Math.max(0, base.r + fogAdd[0]), Math.max(0, base.g + fogAdd[1]), Math.max(0, base.b + fogAdd[2]));
  };

  // separate emissive draws that blaze in daylight: beams, flames, the dance floor (each has one gain)
  const dim = new Map();
  function dimThings(lamps) {
    const fx = ctx.getFx && ctx.getFx(); if (!fx) return;
    if (fx.beams && fx.beams.children) fx.beams.traverse((o) => { const u = o.material && o.material.uniforms && o.material.uniforms.uStrength; if (u) { if (!dim.has(u)) dim.set(u, u.value); u.value = lamps >= 1 ? dim.get(u) : dim.get(u) * lamps; } });
    for (const k of ['emitters', 'dance']) { const u = fx[k] && fx[k].material && fx[k].material.uniforms.uGain; if (u) { if (!dim.has(u)) dim.set(u, u.value); u.value = lamps >= 1 ? dim.get(u) : dim.get(u) * (k === 'dance' ? lamps : 0.4 + 0.6 * lamps); } }
  }

  // ── the sun's shadow map: rendered for the sun's direction, again when the sun has moved ~1.2 degrees ──
  const casters = () => {
    const out = [], park = ctx.getPark();
    for (const o of park.children) if (o.isMesh && o.material === surface.material) out.push(o);
    for (const g of ctx.getTrains()) for (const o of g.children) if (o.isMesh && o.material === surface.material) out.push(o);
    return out;
  };
  function shadowStep() {
    if (U.uSunOn.value < 0.5 || /noshadow/.test(location.hash) || !surface.uniforms.uMoonOn.value) return;
    tmp.copy(U.uSunDir.value);
    if (shadowDir && tmp.dot(shadowDir) > 0.99978 && surface.uniforms.uShadowOnS.value) return;
    if (!shadowDir) shadowDir = new THREE.Vector3();
    shadowDir.copy(tmp); surface.buildSunShadow(game.renderer, game.scene, casters(), tmp);
  }
  game.renderer.domElement.addEventListener('webglcontextrestored', () => { shadowDir = null; surface.uniforms.uShadowOnS.value = 0; envT = -1e9; });

  // the map is the biggest thing here (4096 x 4096 depth on desktop): free it when night comes (the sun builds it again, first thing, at dusk)
  function freeSunShadow() {
    const S = surface.sunShadow; shadowDir = null;
    surface.uniforms.uShadowOnS.value = 0; surface.uniforms.tShadowS.value = null;
    if (S && S.rt) { S.rt.dispose(); S.rt = null; }
  }

  // ── run-time props (game.props.materials, fx/game/core.js): lit once from the baked NIGHT light when made, so at dusk they are
  // dark beside a park that the sun lights. One shared uniform each: a lit prop's colour is multiplied by (lamps + sun and sky light
  // as the park's surfaces get them, relative to a typical night prop), a glowing one is dimmed with the lamps, a glow sprite by its opacity.
  const propGain = { value: new THREE.Vector3(1, 1, 1) }, propEmit = { value: 1 };
  const seenProps = new WeakSet();
  function adopt(m) {
    if (!m || seenProps.has(m)) return; seenProps.add(m);
    if (m.isSpriteMaterial) { m.userData.dnSprite = true; m.opacity = propEmit.value; return; }
    if (!m.isMeshBasicMaterial) return;
    const c = m.color, glowing = Math.max(c.r, c.g, c.b) >= 0.9;                 // props.mesh: emissive colours are >= 1, lit ones are albedo x a baked light well below it
    const u = glowing ? propEmit : propGain, line = glowing ? 'diffuseColor.rgb *= vec3(dnPropGain);' : 'diffuseColor.rgb *= dnPropGain;';
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(m, sh, r);
      sh.uniforms.dnPropGain = u; sh.fragmentShader = sh.fragmentShader.replace('void main() {', (glowing ? 'uniform float dnPropGain;' : 'uniform vec3 dnPropGain;') + '\nvoid main() {').replace('#include <color_fragment>', '#include <color_fragment>\n' + line);
    };
    const key = m.customProgramCacheKey; m.customProgramCacheKey = () => (key ? key.call(m) : '') + (glowing ? 'dnPE' : 'dnPL');
    m.needsUpdate = true;
  }
  const propSet = () => { const P = game.props; return P && P.materials && typeof P.materials.forEach === 'function' ? P.materials : null; };
  let lastGain = '';
  function lightProps(s) {
    const g = propGain.value;
    if (s.night) { g.set(1, 1, 1); propEmit.value = 1; }
    else {
      const sk = s.sunCol, am = [s.ambSky[0] * 0.5 + s.ambGnd[0] * 0.5, s.ambSky[1] * 0.5 + s.ambGnd[1] * 0.5, s.ambSky[2] * 0.5 + s.ambGnd[2] * 0.5];
      const f = (i) => Math.min(9, s.lamps + (sk[i] * 0.45 + am[i] * 1.3) / 0.7);
      g.set(f(0), f(1), f(2)); propEmit.value = 0.3 + 0.7 * s.lamps;
    }
    const key = g.x.toFixed(3) + g.y.toFixed(3) + g.z.toFixed(3) + propEmit.value.toFixed(3); if (key === lastGain) return; lastGain = key;
    const set = propSet(); if (!set) return;
    set.forEach((m) => { adopt(m); if (m.userData && m.userData.dnSprite) m.opacity = propEmit.value; });
  }
  game.on('prop', ({ material }) => { adopt(material); if (material && material.isSpriteMaterial) material.opacity = propEmit.value; });
  { const set = propSet(); if (set) set.forEach(adopt); }

  function frame(dt) {
    const target = clampT(game.clock.t);
    if (tc !== target) { const d = target - tc; tc = Math.abs(d) < 0.02 ? target : tc + d * (1 - Math.exp(-Math.min(dt, 0.25) / 0.5)); }
    const w = wx(), cloud = tc >= T_NIGHT ? 0 : w ? w.cloud : 0;     // the cloud deck only matters at dusk: at night a weather change costs nothing here
    if (tc !== lastTc || cloud !== lastCloud) {
      lastTc = tc; lastCloud = cloud; state = at(tc); state.t = game.clock.t;
      apply(state, cloud);
      if (state.phase !== phase) { phase = state.phase; game.emit('daynight:phase', { phase }); }
      dimThings(state.lamps); lightProps(state);
    }
    if (!state.night) {
      shadowStep();
      // the lake's no-mirror environment cube holds the park's light as it was when captured
      if (Math.abs(tc - envT) > 4 && ctx.getWater && ctx.getWater()) { envT = tc; ctx.getWater().recaptureEnv(); }
      envDusk = true;
    } else if (envDusk) { envDusk = false; envT = -1e9; freeSunShadow(); if (ctx.getWater && ctx.getWater()) ctx.getWater().recaptureEnv(); }       // back to night: capture the night again
  }
  game.on('frame', ({ dt }) => frame(dt));
  // snap (no easing) on the first frame so a clock set before the module started shows at once
  frame(0);

  return {
    get state() { return state; }, get time() { return tc; }, at,
    get props() { return { gain: propGain.value.toArray(), emit: propEmit.value, count: propSet() ? propSet().size : -1 }; },     // tests
    // test helper: show time t at once (no easing)
    snap(t) { game.clock.set(t); tc = clampT(t); frame(0); },
  };
}
