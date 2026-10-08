// Builds the HD post chain from Q.post (see settings.js). app.js calls buildFx() from buildComposer() when any
// fx token is set; with no token the original chain (RenderPass, UnrealBloom, OutputPass, grade) is unchanged.
//
//   [TAA jitter]       fx/taa.js      sub-pixel projection offset
//   scene (RenderPass into a half-float target with a depth texture)
//   [AO]               fx/ao.js       half-res AO texture only (applied in FinalPass, linear, before tone mapping)
//   [TAA resolve]      fx/taa.js      HDR reprojection + clamp, written back into the scene buffer
//   [DOF / tilt-shift] fx/tiltshift.js  half-res blur + CoC, composited in FinalPass
//   [bloom]            fx/bloom.js    mip chain (texture only) or the stock UnrealBloomPass
//   FinalPass          fx/final.js    AO + DOF + bloom + AgX + sRGB + grade + vignette (+ grain) in one pass
//   [FXAA / SMAA]      fx/aa.js       LDR, last
//   [style]            fx/styles.js   pixel / halftone toggles
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FinalPass } from './final.js';
import { MipBloomPass } from './bloom.js';
import { makeAO } from './ao.js';
import { makeAA } from './aa.js';
import { TiltShiftPass } from './tiltshift.js';
import { TAAPass } from './taa.js';
import { makeStyle } from './styles.js';

export const GRADE = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec3 s = c * c * (3.0 - 2.0 * c); c = mix(c, s, 0.42);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.14);
      vec2 q = vUv - 0.5; c *= 1.0 - 0.32 * dot(q, q);
      gl_FragColor = vec4(c, 1.0); }`,
};

// Does this browser render to R11F_G11F_B10F? (needs EXT_color_buffer_float; most phones lack it)
function canRG11(renderer) { return !!renderer.getContext().getExtension('EXT_color_buffer_float'); }

export function fxActive(F) { return !!(F.final || F.ao || F.aa || F.tilt || F.style || F.bloom !== 'unreal' || F.fmt || F.prof || F.streaks || F.rays); }

export function buildFx(ctx) {
  const { renderer, scene, camera, Q, size, mobile } = ctx;
  const F = Object.assign({}, Q.post);
  const dpr = renderer.getPixelRatio();
  // 'auto' AA: SMAA where pixels are scarce (replaces 4x MSAA, which also leaves dark AO specks on resolved
  // edges), nothing on dense screens and phones (as the original chain)
  if (F.aa === 'auto') F.aa = (!mobile && dpr <= 1.3) ? 'smaa' : 'none';
  const msaa = F.aa === 'msaa' ? 4 : (F.aa ? 0 : ctx.samples);                 // a post AA replaces MSAA
  const needDepth = !!(F.ao || F.tilt || F.aa === 'taa' || (Q.photo && Q.photo.depth));   // game hook: photo
  const rg11 = F.fmt === 'rg11' && canRG11(renderer) && !F.ao;                  // no alpha in RG11: AO uses it for lantern glow
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: rg11 ? THREE.UnsignedInt101111Type : THREE.HalfFloatType, format: rg11 ? THREE.RGBFormat : THREE.RGBAFormat,
    samples: msaa, depthTexture: needDepth ? new THREE.DepthTexture(size.x, size.y, THREE.FloatType) : null,
  });
  const composer = new EffectComposer(renderer, rt);
  const out = { composer, bloomPass: null, passes: {}, samples: msaa };
  const scenePass = new RenderPass(scene, camera); scenePass.__name = 'Scene';
  composer.addPass(scenePass);

  if (F.ao === 'n8') {        // N8AO renders the scene itself (beauty + depth) and composites AO: it replaces the RenderPass
    import('https://cdn.jsdelivr.net/npm/n8ao@2.0.1/dist/N8AO.js').then(({ N8AOPass }) => {
      const p = new N8AOPass(scene, camera, size.x, size.y); p.__name = 'N8AO';
      Object.assign(p.configuration, { aoRadius: 1.5, distanceFalloff: 1.0, intensity: 3, halfRes: true, depthAwareUpsampling: true, gammaCorrection: false, aoSamples: 16, denoiseSamples: 8, denoiseRadius: 12 });
      p.setSize(size.x, size.y);
      const i = composer.passes.indexOf(scenePass); composer.passes[i] = p; ctx.onSwap && ctx.onSwap();
    });
  }
  let ao = null;
  if (F.ao) { ao = makeAO(F.ao, ctx); if (ao) { composer.addPass(ao); out.passes.ao = ao; } }

  if (F.aa === 'taa') {                     // jitter goes in front of the scene render; resolve after AO (which wants the jittered matrix)
    const p = new TAAPass(camera, { mobile, renderer, scene }); composer.insertPass(p.jitterPass, 0); composer.addPass(p); out.passes.taa = p;
  }

  const useFinal = F.final || F.bloom === 'mip' || F.tilt || (ao && ao.isTextureOnly);
  let dof = null;
  if (F.tilt && useFinal) { dof = new TiltShiftPass(camera, ctx); composer.addPass(dof); out.passes.dof = dof; }

  let bloom = null;
  if (F.bloom === 'mip') {
    const hi = dpr > 1.3 || mobile;                                              // dense or weak screens: start at quarter res
    bloom = new MipBloomPass({ base: hi ? 4 : 2, levels: hi ? 5 : 6, threshold: 1.8, knee: 0.7, strength: 0.22, radius: 1.0, streaks: F.streaks });
    if (F.rays) bloom.enableRays(new THREE.Vector3(0, 47, 0), camera);         // the Spire beacon
    composer.addPass(bloom); out.passes.bloom = bloom;
  } else if (F.bloom !== 'off') {
    const b = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.10, 0.35, 1.8); b.__name = 'UnrealBloom';
    composer.addPass(b); out.bloomPass = b; out.passes.bloom = b;
  }

  if (useFinal) {
    const fin = new FinalPass({ camera, renderer, ao: !!(ao && ao.isTextureOnly), bloom: F.bloom === 'mip', dof: !!dof, grain: F.grain, aoDebug: F.aodebug, sharpen: F.aa === 'taa' });
    if (ao && ao.isTextureOnly) fin.ao = ao;
    if (F.bloom === 'mip') { fin.bloom = bloom; fin.uniforms.uBloom.value = bloom.strength; }
    fin.dof = dof;
    composer.addPass(fin); out.passes.final = fin;
  } else {
    const o = new OutputPass(); o.__name = 'Output'; composer.addPass(o);
    const g = new ShaderPass(GRADE); g.__name = 'Grade'; composer.addPass(g);
  }

  if (F.aa && F.aa !== 'taa' && F.aa !== 'msaa' && F.aa !== 'none') { const p = makeAA(F.aa, size); if (p) { composer.addPass(p); out.passes.aa = p; } }
  if (F.style) { const p = makeStyle(F.style, ctx); if (p) composer.addPass(p); }
  if (Q.photo && Q.photo.build) Q.photo.build(ctx, composer);   // game hook: photo (last pass; present only while photo mode needs it)
  return out;
}
