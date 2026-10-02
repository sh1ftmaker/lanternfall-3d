// 7. The bell, 23 times. Another module registers the Guildhollow strength bell as an interactable (id 'strength-bell'); count its `use`
// events. On the 23rd ring within one visit the Spire answers: a deep bell if sound is on and a column of light up the Spire.
// If nobody has registered a bell ten seconds in, a simple bell of our own is put at the bell's spot so the secret still works.
const IDS = new Set(['strength-bell', 'secrets-bell']);
const BELL = [-130.2, 8.6];             // the crooked strength bell's foot in the Guild Fair Midway (land-local 9.5, -55)
const RINGS = 23, SPIRE = [0, 0], TOP = 68;

export function init(S) {
  const { game, THREE } = S;
  let count = 0, realSeen = false, own = null, col = null;

  /* the column of light: an open cylinder up the Spire, additive, gradient fading toward the top and the sides */
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uK: { value: 0 }, uRise: { value: 0 }, uTop: { value: TOP } },
    vertexShader: 'varying vec3 vP; varying vec3 vN; void main(){ vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vP.z = mv.z; vP.y = position.y; }',
    fragmentShader: `varying vec3 vP; varying vec3 vN; uniform float uK, uRise, uTop;
      void main(){
        float y = vP.y / uTop + 0.5;                                        // 0 at the foot, 1 at the top
        float edge = pow(abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0))), 1.4);   // soft sides
        float reach = smoothstep(uRise + 0.08, uRise - 0.04, y);               // the front climbing the shaft
        float a = uK * reach * (0.25 + 0.75 * edge) * (1.0 - 0.45 * y);
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.42) * a * 2.4, a);
      }`,
  });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 5.2, TOP, 28, 1, true), mat);
  cyl.frustumCulled = false; cyl.renderOrder = 9; cyl.visible = false; cyl.position.set(SPIRE[0], 0.6 + TOP / 2, -SPIRE[1]); game.scene.add(cyl);
  const top = game.props.glow({ x: SPIRE[0], y: SPIRE[1], z: TOP, color: [1, 0.7, 0.35], size: 18 }); top.sprite.visible = false;
  let tl = -1;
  function answer() {
    tl = 0; cyl.visible = true; top.sprite.visible = true;
    const eng = () => { const e = game.ctx.sound && game.ctx.sound.engine; return e && e.enabled ? e : null; };
    const deep = (rate, gain, tries) => { const e = eng(); if (e && !e.play('spire_bell', [SPIRE[0], SPIRE[1], 44], { gain, rate, ref: 80, max: 1200 }) && tries > 0) setTimeout(() => deep(rate, gain, tries - 1), 1200); };
    deep(0.5, 1.4, 3); setTimeout(() => deep(0.38, 1.0, 1), 2600);
    S.found('bell');
  }
  game.on('frame', ({ dt }) => {
    if (tl < 0) return;
    tl += dt; const rise = game.reduceMotion ? 1.2 : Math.min(1.2, tl / 1.6), k = Math.min(1, tl / 0.5) * Math.max(0, Math.min(1, (6.5 - tl) / 2.2)) * (0.9 + 0.1 * Math.sin(tl * 5));
    mat.uniforms.uRise.value = rise; mat.uniforms.uK.value = k; top.sprite.material.opacity = Math.min(1, k * 1.2);
    if (tl > 6.6) { tl = -1; cyl.visible = false; top.sprite.visible = false; }
  });

  // after the third ring the bell keeps a count, in a small toast, until the Spire answers
  function ring() {
    count++;
    if (count === RINGS) answer();
    else if (count >= 3 && count < RINGS && !S.isFound('bell')) game.toast(`The bell has rung ${count} times`, { ms: 1400 });
  }
  game.on('use', ({ id }) => {
    if (!IDS.has(id)) return;
    if (id === 'strength-bell') { realSeen = true; if (own) own.enabled = false; }
    ring();
  });
  // our own bell, only if nobody else has put one in by ten seconds
  setTimeout(() => {
    if (realSeen || (game.modules.bounty && game.modules.bounty.positions)) return;       // bounty puts the real one there: nothing to add
    const gz = game.ground(BELL[0], BELL[1]);
    own = game.interact({ id: 'secrets-bell', x: BELL[0], y: BELL[1], z: gz ?? 0.3, r: 3.2, label: 'Ring the bell', show: () => !game.cameraHeld, use() { game.sound('guild_strength_bell', [BELL[0], BELL[1], 2.5]); } });
  }, 10000);
  return { get count() { return count; }, get own() { return own; }, answer, ring, reset: () => { count = 0; } };
}
