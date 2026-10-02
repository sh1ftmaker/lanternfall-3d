// The park seen from straight above, rendered once (like the moon shadow map in fx/surface.js): rgb = the baked light
// of the topmost surface, a = its height. Rain uses it to stop at roofs, arcades and the monorail viaduct and to splash
// on whatever is on top; wet shading uses it to keep covered ground dry and to find the coloured light a wet floor
// would mirror (the mip chain of rgb is a cheap blur of that light). Built only when weather other than Clear is
// wanted, again when more of the park has loaded or the context was restored.
import * as THREE from 'three';

export const COVER_R = 384;                         // half size of the square (m); the park fits in +-372

// shared GLSL: uniforms + lookups (world xz -> texture)
export const COVER_GLSL = /* glsl */`
  uniform sampler2D tCover; uniform vec2 uCovK;      // x: 1 / (2 R), y: height scale (1 for float targets, 80 for 8-bit); stored height = y + 8 m
  vec2 covUV(vec2 xz){ return vec2(xz.x, -xz.y) * uCovK.x + 0.5; }
  float covH(vec2 xz){ vec2 uv = covUV(xz); if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return -50.0;
    return textureLod(tCover, uv, 0.0).a * uCovK.y - 8.0; }        // cleared (nothing there) = -8 m
  vec3 covL(vec2 xz, float lod){ return textureLod(tCover, covUV(xz), lod).rgb * (uCovK.y > 1.5 ? 4.0 : 1.0); }`;

export function createCover({ renderer, scene, mobile, hdr }) {
  const size = Math.min(mobile ? 1024 : 2048, renderer.capabilities.maxTextureSize);
  const uniforms = { tCover: { value: null }, uCovK: { value: new THREE.Vector2(1 / (2 * COVER_R), hdr ? 1 : 80) } };
  const st = { rt: null, ms: 0, count: 0, parts: -1, dirty: true };
  const mat = (glass) => new THREE.ShaderMaterial({
    defines: hdr ? {} : { LDR: '' },
    uniforms: { uRange: { value: 32 } },
    vertexShader: /* glsl */`attribute vec4 aCol; uniform float uRange; varying vec3 vC; varying float vY;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y;
        vC = ${glass ? 'aCol.rgb * aCol.rgb * 0.25' : 'aCol.rgb * (aCol.a * uRange)'};
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`varying vec3 vC; varying float vY;
      void main(){
        #ifdef LDR
        gl_FragColor = vec4(min(vC / 4.0, 1.0), clamp((vY + 8.0) / 80.0, 0.0, 1.0));
        #else
        gl_FragColor = vec4(vC, vY + 8.0);
        #endif
      }`,
    side: THREE.DoubleSide,
  });
  const solid = mat(false), glass = mat(true);
  const cam = new THREE.OrthographicCamera(-COVER_R, COVER_R, COVER_R, -COVER_R, 1, 1200);
  cam.position.set(0, 600, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();   // screen right = +x, up = -z

  // meshes: the park's opaque + glass meshes (trains, forest, sprites and the lake surface are left out)
  function build(meshes, range) {
    const t0 = performance.now();
    if (!st.rt) {
      st.rt = new THREE.WebGLRenderTarget(size, size, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    }
    solid.uniforms.uRange.value = glass.uniforms.uRange.value = range;
    const set = new Set(meshes), hidden = [], swapped = [];
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.visible) return;
      if (set.has(o)) { swapped.push([o, o.material, o.geometry.drawRange.count]); o.material = o.material.transparent ? glass : solid; o.geometry.setDrawRange(0, Infinity); }
      else { o.visible = false; hidden.push(o); }
    });
    const prevRT = renderer.getRenderTarget(), prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
    const obr = scene.onBeforeRender, oar = scene.onAfterRender; scene.onBeforeRender = () => {}; scene.onAfterRender = () => {};
    const bg = scene.background; scene.background = null;
    renderer.setRenderTarget(st.rt); renderer.setClearColor(0x000000, 0); renderer.autoClear = true; renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevCol, prevA); renderer.autoClear = prevAuto;
    scene.onBeforeRender = obr; scene.onAfterRender = oar; scene.background = bg;
    for (const o of hidden) o.visible = true;
    for (const [o, m, c] of swapped) { o.material = m; o.geometry.setDrawRange(0, c); }
    uniforms.tCover.value = st.rt.texture;
    st.ms = Math.round(performance.now() - t0); st.count++; st.dirty = false;
  }
  function dispose() { if (st.rt) st.rt.dispose(); st.rt = null; uniforms.tCover.value = null; st.dirty = true; }
  return { uniforms, build, dispose, st, size, get ready() { return !!uniforms.tCover.value && !st.dirty; } };
}
