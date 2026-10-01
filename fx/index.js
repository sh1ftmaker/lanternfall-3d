// Atmosphere & motion effects for Lanternfall 3D. Each effect lives in its own module; this file owns the switches.
// Switches: Q.fx.<name>; URL hash tokens turn them on (#fireworks) or off (#no-motes), comma separated (#aurora,no-carousel).
import { buildLanternFall } from './lanterns.js';
import { buildAnimated } from './animate.js';
import { buildMotes } from './motes.js';
import { buildFireworks } from './fireworks.js';

export const FX_DEFAULTS = { lanternfall: true, carousel: true, motes: true, fireworks: true, 'fireworks-always': false };

export function fxConfig(Q, { mobile = false, reduceMotion = false } = {}) {
  const tok = new Set(decodeURIComponent(location.hash.slice(1)).split(/[,&+\s]/).filter(Boolean));
  Q.fx = {};
  for (const [k, v] of Object.entries(FX_DEFAULTS)) Q.fx[k] = tok.has(k) ? true : tok.has('no-' + k) ? false : v;
  Q.fx.motion = !reduceMotion || tok.has('motion');           // prefers-reduced-motion freezes everything that drifts
  Q.fx.scale = mobile ? 0.5 : 1;                              // particle budget multiplier (adapt() lowers it)
  return Q.fx;
}

const fx = { lanterns: null };

export function fxLanterns(Q, { f32, count, waterY, uTime }) {
  if (!Q.fx || !Q.fx.lanternfall) return null;
  fx.lanterns = buildLanternFall({ f32, count, waterY, uTime, motion: Q.fx.motion ? 1 : 0 });
  return fx.lanterns;
}

// called once the manifest is in (before the parts stream)
export function fxScene(Q, { scene, lands, uTime }) {
  if (Q.fx.motes) { fx.motes = buildMotes({ lands, uTime, motion: Q.fx.motion ? 1 : 0, scale: Q.fx.scale }); scene.add(fx.motes); }
  if (Q.fx.fireworks && Q.fx.motion) { fx.fireworks = buildFireworks({ uTime, scale: Q.fx.scale }); scene.add(fx.fireworks); }
}

// once per frame, before rendering
// ctx: { time, dt, tour } where tour is the tour clock in seconds (wrapped) or -1 outside the tour
export function fxUpdate(Q, camera, ctx) {
  if (fx.motes) fx.motes.userData.update(camera);
  if (fx.fireworks) fx.fireworks.userData.update(ctx.time, ctx.dt, { tour: ctx.tour, always: Q.fx['fireworks-always'] });
}

// called once all park parts are loaded
export function fxPark(Q, { park, uTime }) {
  if (Q.fx.carousel) { park.updateMatrixWorld(true); fx.animated = buildAnimated({ park, uTime, motion: Q.fx.motion ? 1 : 0 }); }
}

export function fxState() { return fx; }
