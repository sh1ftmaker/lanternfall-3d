// Fun look toggles that run after the final pass (LDR):
//   #style=pixel     chunky pixels with a small colour ramp (cheap stand-in for webgl_postprocessing_pixel, whose
//                    RenderPixelatedPass needs a normal pre-pass of the whole scene)
//   #style=halftone  three's HalftonePass (webgl_postprocessing_rgb_halftone) tuned for a night palette
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { HalftonePass } from 'three/addons/postprocessing/HalftonePass.js';

const PIXEL = {
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2() }, uBlock: { value: 4 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uBlock; varying vec2 vUv;
    void main(){
      vec2 cell = uBlock / uRes; vec2 uv = (floor(vUv / cell) + 0.5) * cell;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      ivec2 b = ivec2(floor(vUv / cell)) & 3;                                 // ordered (Bayer) dither per chunky pixel
      int bi = b.x + 4 * b.y; float th = float(bi == 0 ? 0 : bi == 1 ? 8 : bi == 2 ? 2 : bi == 3 ? 10 : bi == 4 ? 12 : bi == 5 ? 4 : bi == 6 ? 14 : bi == 7 ? 6 : bi == 8 ? 3 : bi == 9 ? 11 : bi == 10 ? 1 : bi == 11 ? 9 : bi == 12 ? 15 : bi == 13 ? 7 : bi == 14 ? 13 : 5) / 16.0;
      c = floor(c * 12.0 + th) / 12.0;                                        // 13 levels per channel, dithered
      vec2 f = fract(vUv / cell);                                             // a faint dark seam between pixels
      c *= 0.9 + 0.1 * step(0.12, min(f.x, f.y));
      gl_FragColor = vec4(c, 1.0); }`,
};

export function makeStyle(kind, ctx) {
  const s = ctx.size;
  if (kind === 'pixel') {
    const p = new ShaderPass(PIXEL); p.__name = 'Pixel';
    p.uniforms.uBlock.value = Math.max(3, Math.round(4 * ctx.renderer.getPixelRatio()));
    p.setSize = (w, h) => p.uniforms.uRes.value.set(w, h); p.setSize(s.x, s.y);
    return p;
  }
  if (kind === 'halftone') {
    const p = new HalftonePass({ shape: 1, radius: 3 * ctx.renderer.getPixelRatio(), rotateR: Math.PI / 12, rotateG: Math.PI / 6, rotateB: Math.PI / 4, scatter: 0, blending: 0.35, blendingMode: 1, greyscale: false });
    p.__name = 'Halftone'; return p;
  }
  return null;
}
