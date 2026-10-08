// Glare on real fittings: a wide, dim glow sprite at every visible lamp globe, lantern glass and festoon bulb, so a
// clear-glass lamp with a small flame still reads as lit from across a square. From the bake's own light list
// (data/lights.json, Blender-Park/web_export/lights.py): only rows with a fitting (fx fy fz not null), so helper lights
// (facade washes, uplights, fills) never draw an orb in mid-air; windows and neon are surfaces, not fittings, and
// flames already have their flicker halos (fx/emitters.js). A light object and its own glowing globe are merged.
// Size ~0.2-0.8 m from sqrt(brightness), lifted towards the camera so the globe's glass does not cut it; depth-tested,
// additive, fogged like the park. One draw call (THREE.Points); far sprites under a pixel or two keep their energy
// by shrinking their brightness instead of their size, then drop out; near ones stop growing at 7 % of the picture
// height (fill cost on a phone).
import * as THREE from 'three';
import { LOOK, FOG_GLSL } from './look.js';

export async function loadGlare({ scene, url = 'data/lights.json', fog }) {
  let d;
  try { const r = await fetch(url); if (!r.ok) return null; d = await r.json(); } catch (e) { return null; }
  const F = Object.fromEntries(d.fields.map((k, i) => [k, i])), K = d.kinds;
  const want = new Set(['lamp', 'lantern']);
  // merge rows that share a fitting (within 0.2 m): a light object plus its emissive globe
  const cells = new Map(), out = [];
  for (const r of d.rows) {
    if (r[F.fx] === null || !want.has(K[r[F.kind]])) continue;
    const x = r[F.fx], y = r[F.fy], z = r[F.fz], key = `${Math.round(x / 0.4)},${Math.round(y / 0.4)},${Math.round(z / 0.4)}`;
    const o = cells.get(key);
    if (o && Math.hypot(o[0] - x, o[1] - y, o[2] - z) < 0.2) { const w = r[F.i]; o[3] += r[F.r] * w; o[4] += r[F.g] * w; o[5] += r[F.b] * w; o[6] += w; continue; }
    const n = [x, y, z, r[F.r] * r[F.i], r[F.g] * r[F.i], r[F.b] * r[F.i], r[F.i]]; cells.set(key, n); out.push(n);
  }
  const n = out.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 4);
  out.forEach((o, i) => { pos.set(o.slice(0, 3), i * 3); const m = Math.max(o[3], o[4], o[5], 1e-6); col.set([o[3] / m, o[4] / m, o[5] / m, o[6]], i * 4); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 600);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 500 }, uGlare: LOOK.uGlare, uFog: fog.uFog, uFogD: fog.uFogD, uFogK: LOOK.uFogK, uFogH: LOOK.uFogH, uFogBase: LOOK.uFogBase, uFogFloor: LOOK.uFogFloor },
    vertexShader: /* glsl */`
      attribute vec4 aCol; uniform float uScale, uGlare, uFogD; varying vec3 vC; varying float vF;
      ${FOG_GLSL}
      void main(){
        float i = aCol.a, r = clamp(0.12 + 0.22 * sqrt(i), 0.15, 0.8);            // sprite radius (m) from sqrt(brightness)
        vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 toCam = cameraPosition - w; float dist = length(toCam);
        w += toCam / max(dist, 1e-3) * min(r * 0.6, dist * 0.5);                  // in front of the globe's glass
        vec4 mv = viewMatrix * vec4(w, 1.0);
        float px = 2.0 * r * uScale / max(-mv.z, 0.05), sz = clamp(px, 2.0, 0.07 * uScale);   // near ones capped: the fitting itself is in view
        vC = aCol.rgb * (0.35 * sqrt(i)) * uGlare * min(1.0, px * px / (sz * sz)) * smoothstep(0.3, 1.5, dist);
        vF = lookFog(dist, cameraPosition.y, w.y, uFogD);
        gl_PointSize = sz;
        gl_Position = projectionMatrix * mv;
        if (px < 0.4 || uGlare <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFog; varying vec3 vC; varying float vF;
      void main(){
        vec2 q = gl_PointCoord * 2.0 - 1.0; float d2 = dot(q, q);
        if (d2 > 1.0) discard;
        float m = exp(-d2 * 4.0) * 0.8 + exp(-d2 * 18.0) * 0.6;                    // wide skirt + soft core
        m *= 1.0 - d2 * d2;
        gl_FragColor = vec4(vC * m * (1.0 - vF), 0.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 7; pts.name = 'glare';
  pts.onBeforeRender = (r, s, cam) => { const rt = r.getRenderTarget(); const h = rt ? rt.height : r.domElement.height; mat.uniforms.uScale.value = h * 0.5 * cam.projectionMatrix.elements[5]; };
  scene.add(pts);
  return { points: pts, count: n };
}
