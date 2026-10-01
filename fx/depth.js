// Shared depth helpers for the fx shaders. Everything goes through the camera's inverse projection matrix
// (uProjInv), so near/far changes, a different FOV or an orthographic camera need nothing else.
//  - reversed depth (renderer.capabilities.reversedDepthBuffer, EXT_clip_control 0..1): REVERSED_DEPTH is defined
//    and the sky test flips (cleared depth is 0 instead of 1).
//  - logarithmic depth buffer: NOT supported by projection unprojection; LOG_DEPTH switches to the
//    log2(1 + w) / log2(far + 1) inverse three uses, which needs uLogFar = log2(far + 1).
import * as THREE from 'three';

export function depthDefines(renderer) {
  const c = renderer.capabilities, d = {};
  if (c.reversedDepthBuffer || c.reverseDepthBuffer) d.REVERSED_DEPTH = '';
  if (c.logarithmicDepthBuffer) d.LOG_DEPTH = '';
  return d;
}
export function depthUniforms() {
  return { uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uLogFar: { value: 1 } };
}
export function updateDepthUniforms(u, camera) {
  u.uProj.value.copy(camera.projectionMatrix); u.uProjInv.value.copy(camera.projectionMatrixInverse);
  u.uLogFar.value = Math.log2(camera.far + 1);
}
export const DEPTH_GLSL = /* glsl */`
  uniform mat4 uProj, uProjInv; uniform float uLogFar;
  bool isSky(float d){
    #ifdef REVERSED_DEPTH
      return d <= 0.0;
    #else
      return d >= 1.0;
    #endif
  }
  // uv in 0..1 of the full-resolution target, d the raw depth-texture value -> view-space position (z < 0)
  vec3 viewPos(vec2 uv, float d){
    #ifdef LOG_DEPTH
      float w = exp2(d * uLogFar) - 1.0;                       // view distance along -z
      vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, -1.0, 1.0); vec3 r = c.xyz / c.w;   // a point on the ray
      return r * (w / -r.z);
    #else
      #ifdef REVERSED_DEPTH
        vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d, 1.0);
      #else
        vec4 c = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
      #endif
      return c.xyz / c.w;
    #endif
  }
  float viewZ(vec2 uv, float d){ return viewPos(uv, d).z; }
`;

// full-screen-triangle vertex shader for ShaderMaterial passes
export const VERT = /* glsl */`varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
