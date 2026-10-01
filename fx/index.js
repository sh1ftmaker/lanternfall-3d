// Atmosphere & motion effects for Lanternfall 3D. Each effect lives in its own module; this file owns the switches.
// Switches: Q.fx.<name>; URL hash tokens turn them on (#fireworks) or off (#no-motes), comma separated (#aurora,no-carousel).
import { buildLanternFall } from './lanterns.js';
import { buildAnimated } from './animate.js';

export const FX_DEFAULTS = { lanternfall: true, carousel: true };

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

// called once all park parts are loaded
export function fxPark(Q, { park, uTime }) {
  if (Q.fx.carousel) { park.updateMatrixWorld(true); fx.animated = buildAnimated({ park, uTime, motion: Q.fx.motion ? 1 : 0 }); }
}

export function fxState() { return fx; }
