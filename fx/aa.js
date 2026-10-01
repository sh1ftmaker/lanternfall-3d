// Post anti-aliasing on the final LDR image (after tone mapping, as FXAA and SMAA expect).
//   fxaa: three's FXAAPass, one full-res pass.   smaa: SMAAPass, three passes (edges, weights, blend).
// Temporal AA lives in taa.js (it runs on HDR, before bloom).
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
export function makeAA(kind, size) {
  if (kind === 'fxaa') { const p = new FXAAPass(); p.__name = 'FXAA'; return p; }
  if (kind === 'smaa') { const p = new SMAAPass(size.x, size.y); p.__name = 'SMAA'; return p; }
  return null;
}
