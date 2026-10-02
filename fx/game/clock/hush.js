// The silent four minutes (23:00-23:04): music and murmur duck to almost nothing, the crowd inside the lake ring stops and
// faces the Spire (fx/guests/sim.js params.hush), and a single great lantern hangs low over the water that only the lake
// shows: it is drawn only when the rendering camera is the water's mirror camera (so never in the sky). Where the water
// has no planar mirror (tier 0) it simply does not appear.
const TOP = [42, -24, 2.8];                    // x, y, z (Blender): low over the water east of the Spire, where the rail's view of the mirror is longest

export function createHush(game) {
  const THREE = game.THREE;
  const h = { on: false, k: 0, get mesh() { return mesh; }, start() { h.on = true; crowd(true); }, stop() { h.on = false; crowd(false); } };
  const crowd = (on) => { const c = game.guests && game.guests.crowd; if (c && c.setParams) c.setParams({ hush: on }); };

  let mesh = null, mat = null;
  function build() {
    mat = new THREE.ShaderMaterial({
      uniforms: { uShow: { value: 0 }, uK: { value: 0 }, uTime: game.uTime, uSize: { value: 5 } },
      vertexShader: /* glsl */`uniform float uShow, uK, uSize, uTime; varying vec2 vQ;
        void main(){ vQ = position.xy; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += position.xy * uSize * (1.0 + 0.03 * sin(uTime * 0.8));
          gl_Position = projectionMatrix * mv; if (uShow * uK < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`,
      fragmentShader: /* glsl */`uniform float uShow, uK, uTime; varying vec2 vQ;
        void main(){
          vec2 q = vQ * vec2(1.0, 1.0);                                     // paper lantern: wider at the top, a flame in its mouth
          float hw = mix(0.42, 0.62, smoothstep(-0.9, 0.8, q.y));
          float sdf = max(abs(q.x) - hw, abs(q.y) - 0.92);
          float body = smoothstep(0.04, -0.04, sdf);
          float paper = (1.2 - 0.6 * smoothstep(-0.9, 0.9, q.y)) * (1.0 - 0.5 * (q.x * q.x) / (hw * hw));
          float fl = exp(-dot(q - vec2(0.0, -0.55), q - vec2(0.0, -0.55)) * 14.0) * (0.8 + 0.2 * sin(uTime * 9.0));
          float halo = exp(-max(sdf, 0.0) * 5.0) * (1.0 - body);
          vec3 c = vec3(1.0, 0.62, 0.22) * (paper * 1.5 * body + fl * 3.0 + halo * 0.5) * (0.85 + 0.15 * sin(uTime * 1.7));
          float a = max(body, halo * 0.5);
          if (a < 0.01) discard;
          gl_FragColor = vec4(c * uK * 2.0, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    });
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    game.v3(TOP[0], TOP[1], TOP[2], mesh.position); mesh.frustumCulled = false; mesh.renderOrder = 9; mesh.layers.enable(1);
    mesh.onBeforeRender = (r, s, cam) => { const w = game.ctx.getWater && game.ctx.getWater(), mc = w && w.mirror && w.mirror.cam; mat.uniforms.uShow.value = mc && cam === mc ? 1 : 0; mat.uniformsNeedUpdate = true; };
    game.scene.add(mesh);
  }

  /* ── sound: the engine's own music and ambience buses (fx/audio/engine.js), only once it exists ── */
  let aT = 0, applied = -1;
  function audio(k) {
    const e = game.ctx.sound && game.ctx.sound.engine, N = e && e.debug && e.debug.nodes, ctx = e && e.debug && e.debug.ctx; if (!N || !ctx) { applied = -1; return; }
    const st = e.debug.st, now = ctx.currentTime;
    N.music.gain.setTargetAtTime(st.music ? 1 - 0.97 * k : 0, now, 0.4);
    N.amb.gain.setTargetAtTime(st.ambience ? 1 - 0.92 * k : 0, now, 0.4);
    applied = k;
  }

  h.frame = (dt) => {
    const tgt = h.on ? 1 : 0;
    if (h.k !== tgt) { h.k += Math.sign(tgt - h.k) * Math.min(Math.abs(tgt - h.k), dt / 3); }
    if (h.k > 0 && !mesh) build();
    if (mesh) { mat.uniforms.uK.value = h.k; mesh.visible = h.k > 0; }
    if ((aT -= dt) <= 0) { aT = 0.5; if (h.k !== applied || (h.k > 0 && applied < 0)) audio(h.k); }
  };
  return h;
}
