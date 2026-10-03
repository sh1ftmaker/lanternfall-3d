// Remote visitors, drawn as copies of Wick the lamplighter (fx/platformer/character.js), posed by the platformer's own
// animator from the states the network hands over, about 120 ms behind each sender's own clock.
//
//   const av = createAvatars({ THREE, scene, surface, guests, manifest, game });
//   av.upsert(id, { name, kind: 'wick' | 'fp', x, y, z, yaw, anim, frame, t });   // every state that arrives
//   av.remove(id);                                                                 // fades out over a second, then frees
//   av.update(dt, time, camera);                                                   // every frame
//   av.count; av.setVisible(on); av.dispose();
//
// States are in the Blender frame (x east, y north, z up at the feet, metres; yaw as game.player.yaw), `anim` and
// `frame` a platformer animation id and frame (fx/platformer/anims.js; -1 for a first-person sender, who is shown
// walking or running by speed), `t` the sender's performance.now() in ms.
//
// Timing: each sender's clock offset is the smallest (arrival - t) seen (it creeps up slowly if the network gets
// slower); the avatar is drawn at sender time now - offset - 120 ms, interpolated between the two states around it.
// When no newer state has come it extrapolates along the last velocity for at most 250 ms, then holds. A state that
// arrives after extrapolation started changes where the avatar should be; the difference is kept as a correction that
// decays over about 0.2 s, so nothing snaps. A jump of more than 20 m between states is a teleport: cut, not slid.
//
// Drawing: one geometry (the local Wick's attributes, shared) and one material for all bodies; each body is its own
// mesh whose onBeforeRender points the shared uniforms at that avatar's bones, lantern and fade (one draw call per
// body), plus the lantern halo, and within 30 m the light pool and contact shadow. Only the 24 nearest the camera are
// drawn; the others are still interpolated. Poses are evaluated every frame within 20 m, every 2nd frame to 45 m,
// every 4th beyond, and not at all out of view (the last pose is carried along). Name tags (canvas sprites, a pool of
// 12) go on the nearest 12, a constant size on screen, readable at 15 m and faded out by 40 m. Nothing here casts the moon shadow (surface.js renders only the park meshes into it), collides, or registers
// with the game layer (no prompts, swings, rides or secrets).
//
// Development: `__park.mpSim(8)` in the console spawns 8 fake visitors walking near the player (fx/multiplayer/sim.js,
// with network-like timing and jitter); `__park.mpSim(0)` removes them.
import { createCharacter, SHADERS } from '../platformer/character.js';
import { createAnimator } from '../platformer/animator.js';
import { CLIP, LEN, LOOP, ID } from '../platformer/anims.js';

const DELAY = 120;          // ms behind the sender's timeline
const EXTRAP = 250;         // ms of extrapolation at most
const EXT_TAU = 120;        // ms: extrapolation eases off with this time constant
const TELEPORT = 20;        // m between consecutive states: cut
const MAX_DRAWN = 24;
const RING = 24;            // states kept per avatar (2.4 s while moving)
const FADE = 1.0;           // s
const NEAR_FX = 30;         // m: light pool and contact shadow within this
const TAG_FULL = 25, TAG_GONE = 40;      // m: name tag fades out between these
const TAG_PX = 26;          // CSS px: tag height on screen
const MAX_TAGS = 12;        // name tags on the nearest this many (a crowd of tags reads as noise)
const FP_WALK = ID.walk, FP_RUN = ID.run;
const POSE_ID = CLIP.indexOf('pose');
const SWIM = new Uint8Array(CLIP.length);
const STAND = new Uint8Array(CLIP.length);   // clips of a Wick standing still: a state with one of these is not extrapolated
for (let i = 0; i < CLIP.length; i++) if (CLIP[i] === 'pose') STAND[i] = 1;
for (const n of ['idleLook', 'idleLookBack', 'idleTrim', 'wallLean', 'lookAround', 'pant', 'sitDownStart', 'sitStretch', 'sitYawn', 'sitDown', 'doze', 'lieDown', 'sleepLying',
  'wakeFromDoze', 'wakeFromLying', 'warmHands', 'warmHandsEnd', 'shiver', 'crouch', 'crouchDown', 'crouchUp', 'ledgeHang']) if (ID[n] !== undefined) STAND[ID[n]] = 1;
for (const n of ['tread', 'treadStart', 'stroke', 'strokeGlide', 'flutter', 'waterSwing', 'waterSwingBack', 'waterSwingEnd', 'waterKnockBack', 'waterKnockForward']) if (ID[n] !== undefined) SWIM[ID[n]] = 1;

// body fades with a screen-door dither (the body stays opaque, so it sorts and writes depth like the local Wick)
const FS_FADE = SHADERS.FS
  .replace('varying vec3 vW, vAlb;', 'uniform float uFade;\n  varying vec3 vW, vAlb;')
  .replace('void main(){', 'void main(){\n    if (uFade < 0.999) { float th = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); if (th >= uFade) discard; }');

const cleanName = (s) => {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return (Array.from(s).slice(0, 24).join('')) || 'Visitor';
};
const wrapPi = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };

export function createAvatars({ THREE, scene, surface, guests, manifest, game }) {
  // ── shared geometry and materials: built once from a template Wick (never added to the drawing) ──
  const T = createCharacter({ THREE, scene, surface, guests, manifest });
  scene.remove(T.group);
  const tg = T.mesh.geometry;
  const bodyGeo = new THREE.BufferGeometry();          // the same GPU buffers, with a real bound for culling
  for (const k of ['position', 'aCol', 'aBone', 'aEmit']) bodyGeo.setAttribute(k, tg.getAttribute(k));
  bodyGeo.setIndex(tg.getIndex());
  bodyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.6);     // feet-relative; covers poses and the pole
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
  quadGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3.2);       // halo, pool (r 2.6) around the feet
  const U = { ...T.uniforms, uBones: { value: null }, uLantern: { value: new THREE.Vector3() }, uFlicker: { value: 1 }, uGround: { value: new THREE.Vector3() },
    uShadowK: { value: 0 }, uPoolK: { value: 0 }, uFade: { value: 1 } };
  const tm = { halo: null, pool: null, shadow: null };
  for (const o of T.group.children) { if (o === T.mesh) continue; const m = o.material; if (m.vertexShader === SHADERS.HALO_VS) tm.halo = m; else if (m.vertexShader === SHADERS.POOL_VS) tm.pool = m; else tm.shadow = m; }
  const mk = (src, vs, fs) => { const m = new THREE.ShaderMaterial({ uniforms: U, vertexShader: vs, fragmentShader: fs }); for (const k of ['blending', 'blendEquation', 'blendSrc', 'blendDst', 'blendSrcAlpha', 'blendDstAlpha', 'transparent', 'depthWrite']) m[k] = src[k]; return m; };
  const bodyMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: SHADERS.VS, fragmentShader: FS_FADE });
  const haloMat = mk(tm.halo, SHADERS.HALO_VS, SHADERS.HALO_FS); haloMat.userData.glowMarked = true;
  const poolMat = mk(tm.pool, SHADERS.POOL_VS, SHADERS.POOL_FS);
  const shadowMat = mk(tm.shadow, SHADERS.SHADOW_VS, SHADERS.SHADOW_FS);

  const root = new THREE.Group(); root.name = 'mp-avatars'; root.matrixAutoUpdate = false; scene.add(root);
  const reduce = () => { try { return !!(game && game.reduceMotion); } catch (e) { return false; } };

  // ── name tags: a pool of canvas sprites, handed to the nearest avatars ──
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const TW = Math.round(192 * dpr), TH = Math.round(36 * dpr);
  const tags = [];
  const css = (k, d) => { try { return getComputedStyle(document.documentElement).getPropertyValue(k).trim() || d; } catch (e) { return d; } };
  const PAPER = css('--paper', '#f4e9d2');
  function newTag() {
    const canvas = document.createElement('canvas'); canvas.width = TW; canvas.height = TH;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, toneMapped: false, fog: false });
    const sp = new THREE.Sprite(mat); sp.name = 'mp-tag'; sp.renderOrder = 10; sp.matrixAutoUpdate = false; sp.matrixWorldAutoUpdate = false; sp.center.set(0.5, 0); sp.visible = false;
    root.add(sp);
    return { sp, mat, tex, canvas, g: canvas.getContext('2d'), owner: null, text: null };
  }
  function drawTag(tag, text) {
    const g = tag.g; tag.text = text;
    g.clearRect(0, 0, TW, TH);
    g.font = `600 ${Math.round(TH * 0.56)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const w = Math.min(TW - 4, g.measureText(text).width + TH * 0.8), x0 = (TW - w) / 2, r = TH * 0.42;
    g.fillStyle = 'rgba(14, 12, 24, 0.86)';      // dense: the park behind is HDR, a light veil would vanish after tone mapping
    g.beginPath(); g.moveTo(x0 + r, 2); g.lineTo(x0 + w - r, 2); g.arc(x0 + w - r, TH / 2, TH / 2 - 2, -Math.PI / 2, Math.PI / 2); g.lineTo(x0 + r, TH - 2); g.arc(x0 + r, TH / 2, TH / 2 - 2, Math.PI / 2, Math.PI * 1.5); g.fill();
    g.fillStyle = PAPER; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, TW / 2, TH * 0.53, TW - TH * 0.6);
    tag.tex.needsUpdate = true;
  }

  // ── avatars ──
  const map = new Map(), list = [];
  let leaving = 0, visibleOn = true, frameNo = 0;
  const smp = { x: 0, y: 0, z: 0, yaw: 0, anim: 0, frame: 0, vx: 0, vy: 0, vz: 0, cut: false, extrap: false };
  function makeAvatar(id) {
    const a = {
      id, name: 'Visitor', rawName: undefined, kind: 'wick', rank: MAX_DRAWN, extrap: false,
      st: Array.from({ length: RING }, () => ({ t: 0, rx: 0, x: 0, y: 0, z: 0, yaw: 0, anim: 0, frame: 0 })), head: -1, n: 0,
      off: 0, play: 0, lastRx: 0,
      raw: new THREE.Vector3(), corr: new THREE.Vector3(), pos: new THREE.Vector3(), feet: new THREE.Vector3(), yaw: 0, yawCorr: 0, init: false,
      animId: POSE_ID, u: 0, speed: 0, vy: 0, fpSpeed: 0, fpAnim: POSE_ID,
      fade: 0, leaving: false, dist2: 0, drawn: false, inView: false, tag: null, flPh: Math.random() * 20,
      animator: createAnimator(THREE), world: null, animAt: new THREE.Vector3(), animDt: 0, animated: false,
      ctx: { speed: 0, vy: 0, reduceMotion: false }, animIn: { id: 0, u: 0 }, body: { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0 },
      lantern: new THREE.Vector3(), ground: new THREE.Vector3(), flicker: 1, shadowK: 0, poolK: 0, near: false,
      mBody: null, mHalo: null, mPool: null, mShadow: null,
    };
    // the shared uniforms are pointed at this avatar just before each of its draws
    const set = (m) => { U.uBones.value = a.world; U.uLantern.value = a.lantern; U.uGround.value = a.ground; m.uniformsNeedUpdate = true; };
    const ob = (mesh, fn) => { mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false; mesh.onBeforeRender = fn; root.add(mesh); return mesh; };
    a.mBody = ob(new THREE.Mesh(bodyGeo, bodyMat), () => { set(bodyMat); U.uFlicker.value = a.flicker; U.uFade.value = a.fade; });
    a.mHalo = ob(new THREE.Mesh(quadGeo, haloMat), () => { set(haloMat); U.uFlicker.value = a.flicker * a.fade; });
    a.mPool = ob(new THREE.Mesh(quadGeo, poolMat), () => { set(poolMat); U.uFlicker.value = a.flicker; U.uPoolK.value = a.poolK * a.fade; });
    a.mShadow = ob(new THREE.Mesh(quadGeo, shadowMat), () => { set(shadowMat); U.uShadowK.value = a.shadowK * a.fade; });
    a.mBody.name = 'mp-avatar'; a.mHalo.renderOrder = 9; a.mPool.renderOrder = 3; a.mShadow.renderOrder = 2;
    for (const m of [a.mBody, a.mHalo, a.mPool, a.mShadow]) m.visible = false;
    return a;
  }
  function freeAvatar(a) {
    for (const m of [a.mBody, a.mHalo, a.mPool, a.mShadow]) { root.remove(m); m.onBeforeRender = () => {}; }
    if (a.tag) { a.tag.owner = null; a.tag.sp.visible = false; a.tag = null; }
    map.delete(a.id); const i = list.indexOf(a); if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
  }

  // sender time to draw at, for an avatar, at local time `now` (ms)
  const renderT = (a, now) => now - a.play - DELAY;
  // sample the state buffer at sender time t into smp (no allocation)
  function sample(a, t) {
    const S = a.st, n = a.n, h = a.head;
    smp.cut = false; smp.extrap = false; smp.vx = smp.vy = smp.vz = 0;
    let k = 0, i = h;
    while (k < n - 1 && S[i].t > t) { i = (i - 1 + RING) % RING; k++; }
    const A = S[i];
    if (A.t > t || n === 1) {               // before the oldest state kept (or only one): hold it
      smp.x = A.x; smp.y = A.y; smp.z = A.z; smp.yaw = A.yaw; smp.anim = A.anim; smp.frame = A.frame; return smp;
    }
    if (k === 0) {
      // past the newest state: extrapolate briefly. The velocity is the last segment's, lowered if the sender was
      // slowing down (a stop: the last state is usually short of the one before), and the step eases off (it reaches
      // about 0.1 s of travel at the 250 ms limit), so a sender who has just stopped does not run on;
      // none at all when the last state shows Wick standing.
      const pi = (i - 1 + RING) % RING, P = S[pi], dx = A.x - P.x, dy = A.y - P.y, dz = A.z - P.z;
      const gap = A.t - heldUntil(a, pi, A.t);
      if (gap > 0 && gap < 1200 && !(A.anim >= 0 && STAND[A.anim]) && dx * dx + dy * dy + dz * dz < TELEPORT * TELEPORT) {
        const s1 = Math.sqrt(dx * dx + dy * dy + dz * dz) / gap;
        let s0 = s1;
        if (n >= 3) { const qi = (pi - 1 + RING) % RING, Q = S[qi], g0 = P.t - heldUntil(a, qi, P.t); if (g0 > 0 && g0 < 1200) s0 = Math.hypot(P.x - Q.x, P.y - Q.y, P.z - Q.z) / g0; }
        const sA = Math.min(1.5 * s1, Math.max(0, s1 + 0.5 * (s1 - s0))), m = s1 > 0 ? sA / s1 / gap : 0;
        smp.vx = dx * m; smp.vy = dy * m; smp.vz = dz * m;
      }
      const e = EXT_TAU * (1 - Math.exp(-Math.min(t - A.t, EXTRAP) / EXT_TAU));
      smp.x = A.x + smp.vx * e; smp.y = A.y + smp.vy * e; smp.z = A.z + smp.vz * e; smp.yaw = A.yaw;
      if (smp.vz < 0 && game && game.ground) { const g = game.ground(smp.x, smp.y, A.z); if (g !== null && A.z - g < 0.8 && smp.z < g) smp.z = g; }   // landing: not into the floor
      smp.anim = A.anim; smp.frame = advance(A.anim, A.frame, t - A.t); smp.extrap = true; return smp;
    }
    const B = S[(i + 1) % RING], ta = heldUntil(a, i, B.t), span = B.t - ta, f = span > 0 ? Math.max(0, (t - ta) / span) : 1;
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
    if (dx * dx + dy * dy + dz * dz > TELEPORT * TELEPORT) {        // teleport: stay, then cut at B's time
      smp.x = A.x; smp.y = A.y; smp.z = A.z; smp.yaw = A.yaw; smp.anim = A.anim; smp.frame = advance(A.anim, A.frame, t - A.t); smp.cut = true; return smp;
    }
    smp.x = A.x + dx * f; smp.y = A.y + dy * f; smp.z = A.z + dz * f;
    smp.yaw = A.yaw + wrapPi(B.yaw - A.yaw) * f;
    if (span > 0) { smp.vx = dx / span; smp.vy = dy / span; smp.vz = dz / span; }
    if (A.anim === B.anim) {
      const L = LEN[A.anim] || 20; let fb = B.frame;
      if (A.anim >= 0 && LOOP[A.anim] && fb < A.frame) fb += L;
      smp.anim = A.anim; smp.frame = A.frame + (fb - A.frame) * f; if (A.anim >= 0 && LOOP[A.anim]) smp.frame %= L;
    } else { smp.anim = A.anim; smp.frame = advance(A.anim, A.frame, t - A.t); }
    return smp;
  }
  // A sender at rest sends twice a second; when it sets off, the state before is up to 500 ms old. If state i was a
  // resting one (same place as the one before it) and the next comes more than 160 ms later, take it that the sender
  // stayed there until one send interval before the next, instead of spreading the start over the whole gap.
  function heldUntil(a, i, tNext) {
    const S = a.st, A = S[i];
    if (tNext - A.t <= 160) return A.t;
    const oldest = (a.head - a.n + 1 + RING) % RING;
    if (i !== oldest) { const P = S[(i - 1 + RING) % RING], dx = A.x - P.x, dy = A.y - P.y, dz = A.z - P.z; if (dx * dx + dy * dy + dz * dz > 1e-4) return A.t; }
    return Math.max(A.t, tNext - 110);
  }
  function advance(id, fr, ms) {
    if (id < 0) return 0;
    const L = LEN[id] || 20, f = fr + ms * 0.03;
    return LOOP[id] ? f % L : Math.min(f, L - 1);
  }

  function upsert(id, s) {
    if (!s) return;
    const now = performance.now();
    let a = map.get(id);
    if (!a) { a = makeAvatar(id); map.set(id, a); list.push(a); }
    if (a.leaving) { a.leaving = false; leaving--; }
    if (s.name !== undefined && s.name !== a.rawName) { a.rawName = s.name; a.name = cleanName(s.name); if (a.tag) a.tag.text = null; }
    if (s.kind === 'fp' || s.kind === 'wick') a.kind = s.kind;
    const t = +s.t, x = +s.x, y = +s.y, z = +s.z;
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (a.n && t <= a.st[a.head].t) return;                      // stale or repeated
    const o = now - t;
    if (!a.n) { a.off = a.play = o; }
    else { a.off = Math.min(o, a.off + Math.max(0, now - a.lastRx) * 0.01); }      // the fastest arrival; creeps up 1% if latency grows
    a.lastRx = now;
    // where the avatar is right now, before and after this state goes in: the difference becomes a decaying correction
    const had = a.n > 0 && a.init;
    let bx = 0, by = 0, bz = 0, byaw = 0;
    if (had) { sample(a, renderT(a, now)); bx = smp.x; by = smp.y; bz = smp.z; byaw = smp.yaw; }
    a.head = (a.head + 1) % RING; a.n = Math.min(RING, a.n + 1);
    const S = a.st[a.head];
    S.t = t; S.rx = now; S.x = x; S.y = y; S.z = z; S.yaw = +s.yaw || 0;
    S.anim = a.kind === 'fp' ? -1 : (Number.isInteger(s.anim) && s.anim >= 0 && s.anim < CLIP.length ? s.anim : POSE_ID); S.frame = +s.frame || 0;
    if (had) {
      sample(a, renderT(a, now));
      const dx = bx - smp.x, dy = by - smp.y, dz = bz - smp.z;
      if (dx * dx + dy * dy + dz * dz < TELEPORT * TELEPORT) { a.corr.x += dx; a.corr.y += dy; a.corr.z += dz; a.yawCorr = wrapPi(a.yawCorr + wrapPi(byaw - smp.yaw)); }
    }
  }
  function remove(id) {
    const a = map.get(id); if (!a || a.leaving) return;
    a.leaving = true; leaving++;
  }

  // ── per frame ──
  const near = new Array(MAX_DRAWN).fill(null);
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), sph = new THREE.Sphere(new THREE.Vector3(), 1.8);
  const stats = { drawn: 0, animated: 0, tags: 0, cpuMs: 0 };
  function update(dt, time, camera) {
    const t0 = performance.now(), now = t0;
    frameNo++;
    const k = 1 - Math.exp(-dt / 0.2), cut = dt > 0.3;              // a long pause (hidden tab): cut to where they are
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const rm = reduce();
    let nn = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      // fade
      a.fade += (a.leaving ? -dt : dt) / FADE;
      if (a.fade <= 0 && a.leaving) { leaving--; freeAvatar(a); continue; }
      a.fade = Math.min(1, Math.max(0, a.fade));
      if (!a.n) continue;
      // clock: the drawing offset slews toward the measured one at most 10% faster or slower than real time
      const dp = a.off - a.play, lim = dt * 100;
      a.play += dp > lim ? lim : dp < -lim ? -lim : dp;
      if (!a.init || cut) a.play = a.off;
      sample(a, renderT(a, now));
      const jump = (smp.x - a.raw.x) ** 2 + (smp.y - a.raw.y) ** 2 + (smp.z - a.raw.z) ** 2 > TELEPORT * TELEPORT;
      if (!a.init || jump || cut) { a.corr.set(0, 0, 0); a.yawCorr = 0; a.init = true; a.animated = false; }
      a.raw.set(smp.x, smp.y, smp.z); a.extrap = smp.extrap;
      a.corr.multiplyScalar(1 - k); a.yawCorr *= 1 - k;
      a.pos.set(smp.x + a.corr.x, smp.y + a.corr.y, smp.z + a.corr.z);
      a.yaw = smp.yaw + a.yawCorr;
      const hs = Math.hypot(smp.vx, smp.vy) * 1000;
      a.speed = a.kind === 'fp' ? hs : (SWIM[smp.anim] ? Math.hypot(smp.vx, smp.vy, smp.vz) * 1000 : hs);
      a.vy = smp.vz * 1000;
      if (a.kind === 'fp') {                                // a first-person visitor: idle, walk or run by speed
        a.fpSpeed += (hs - a.fpSpeed) * Math.min(1, dt * 6);
        const s = a.fpSpeed, cur = a.fpAnim;
        a.fpAnim = cur === FP_RUN ? (s < 3.2 ? (s < 0.3 ? POSE_ID : FP_WALK) : FP_RUN) : cur === FP_WALK ? (s > 3.8 ? FP_RUN : s < 0.3 ? POSE_ID : FP_WALK) : (s > 0.6 ? (s > 3.8 ? FP_RUN : FP_WALK) : POSE_ID);
        a.animId = a.fpAnim; a.u = 0;
      } else { a.animId = smp.anim; const L = LEN[smp.anim] || 20; a.u = Math.min(1, smp.frame / Math.max(1, L - 1)); }
      // three.js feet position and distance to the camera
      a.feet.set(a.pos.x, a.pos.z, -a.pos.y);
      const ddx = a.feet.x - cx, ddy = a.feet.y + 0.9 - cy, ddz = a.feet.z - cz;
      a.dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
      a.drawn = false;
      // keep the nearest MAX_DRAWN (insertion into a short sorted list)
      if (nn < MAX_DRAWN || a.dist2 < near[nn - 1].dist2) {
        let j = nn < MAX_DRAWN ? nn++ : nn - 1;
        while (j > 0 && near[j - 1].dist2 > a.dist2) { near[j] = near[j - 1]; j--; }
        near[j] = a;
      }
    }
    for (let i = 0; i < list.length; i++) list[i].rank = MAX_DRAWN;
    for (let j = 0; j < nn; j++) { near[j].drawn = true; near[j].rank = j; }
    for (let j = nn; j < MAX_DRAWN; j++) near[j] = null;
    // frustum, for skipping the pose of avatars out of view
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const tanH = Math.tan(((camera.fov || 50) * Math.PI) / 360), cssH = (typeof innerHeight === 'number' && innerHeight) || 720;
    let animated = 0, tagsOn = 0;
    // release tags of avatars that are no longer drawn or too far
    for (let i = 0; i < tags.length; i++) { const tg = tags[i], o = tg.owner; if (o && (!o.drawn || o.rank >= MAX_TAGS || o.dist2 > TAG_GONE * TAG_GONE || !map.has(o.id))) { o.tag = null; tg.owner = null; tg.sp.visible = false; } }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const on = a.drawn && visibleOn && a.n > 0;
      if (!on) { a.mBody.visible = a.mHalo.visible = a.mPool.visible = a.mShadow.visible = false; a.animated = false; continue; }
      const d = Math.sqrt(a.dist2);
      sph.center.set(a.feet.x, a.feet.y + 0.8, a.feet.z);
      a.inView = frustum.intersectsSphere(sph);
      // pose: every frame near, every 2nd frame to 45 m, every 4th beyond; in between (and out of view) the last pose
      // is carried along with the body so it does not stutter
      a.animDt += dt;
      const every = d < 20 ? 1 : d < 45 ? 2 : 4;
      if (!a.animated || (a.inView && (frameNo + (a.flPh * 7 | 0)) % every === 0)) {
        a.ctx.speed = a.speed; a.ctx.vy = a.vy; a.ctx.reduceMotion = rm;
        a.animIn.id = a.animId; a.animIn.u = a.u;
        a.body.pos.copy(a.feet); a.body.yaw = Math.atan2(Math.cos(a.yaw), -Math.sin(a.yaw));
        a.world = a.animator.update(a.animated ? Math.min(a.animDt, 0.25) : 0, a.animIn, a.ctx, a.body);
        a.lantern.copy(a.animator.st.lanternWorld); a.animAt.copy(a.feet); a.animDt = 0; a.animated = true; animated++;
      } else if (a.animAt.x !== a.feet.x || a.animAt.y !== a.feet.y || a.animAt.z !== a.feet.z) {
        const ox = a.feet.x - a.animAt.x, oy = a.feet.y - a.animAt.y, oz = a.feet.z - a.animAt.z, W = a.world;
        for (let b = 0; b < W.length; b++) { const e = W[b].elements; e[12] += ox; e[13] += oy; e[14] += oz; }
        a.lantern.x += ox; a.lantern.y += oy; a.lantern.z += oz; a.animAt.copy(a.feet);
      }
      // lantern, pool, contact shadow (as fx/platformer/index.js does for the local Wick)
      a.flicker = rm ? 1 : 0.9 + 0.06 * Math.sin(time * 13.1 + a.flPh) + 0.04 * Math.sin(time * 7.3 + 1 + a.flPh * 1.7);
      const swim = SWIM[a.animId] === 1;
      a.near = d < NEAR_FX;
      if (a.near) {
        let g = game && game.ground ? game.ground(a.pos.x, a.pos.y, a.pos.z + 0.3) : null;
        if (g === null || g > a.pos.z + 0.5) g = a.pos.z;
        const above = Math.max(0, a.pos.z - g);
        a.ground.set(a.feet.x, g, a.feet.z);
        a.shadowK = 0.55 * Math.max(0, 1 - above / 6) * (swim ? 0 : 1);
        a.poolK = 0.06 * Math.max(0, 1 - (a.lantern.y - g) / 5) * (swim ? 0.4 : 1);
      }
      a.mBody.matrixWorld.makeTranslation(a.feet.x, a.feet.y, a.feet.z);
      a.mHalo.matrixWorld.copy(a.mBody.matrixWorld); a.mPool.matrixWorld.copy(a.mBody.matrixWorld); a.mShadow.matrixWorld.copy(a.mBody.matrixWorld);
      a.mBody.visible = a.mHalo.visible = true; a.mPool.visible = a.mShadow.visible = a.near;
    }
    // name tags on the nearest MAX_TAGS within TAG_GONE, constant size on screen
    for (let j = 0; j < nn && j < MAX_TAGS; j++) {
      const a = near[j]; if (!visibleOn || !a.animated) continue;
      const d = Math.sqrt(a.dist2), swim = SWIM[a.animId] === 1;
      if (d < TAG_GONE) {
        let tg = a.tag;
        if (!tg) { for (let i2 = 0; i2 < tags.length; i2++) if (!tags[i2].owner) { tg = tags[i2]; break; } if (!tg && tags.length < MAX_TAGS) { tg = newTag(); tags.push(tg); } if (tg) { tg.owner = a; a.tag = tg; } }
        if (tg) {
          if (tg.text !== a.name) drawTag(tg, a.name);
          const h = (TAG_PX * 2 * Math.max(d, 1.5) * tanH) / cssH, w = h * TW / TH;
          const hy = swim ? 0.55 : 1.85;
          const e = tg.sp.matrixWorld.makeScale(w, h, 1).elements; e[12] = a.feet.x; e[13] = a.feet.y + hy; e[14] = a.feet.z;
          tg.mat.opacity = a.fade * Math.min(1, Math.max(0, (TAG_GONE - d) / (TAG_GONE - TAG_FULL)));
          tg.sp.visible = tg.mat.opacity > 0.01; if (tg.sp.visible) tagsOn++;
        }
      }
    }
    stats.drawn = nn; stats.animated = animated; stats.tags = tagsOn; stats.cpuMs = performance.now() - t0;
  }

  function setVisible(on) { visibleOn = !!on; root.visible = visibleOn; }
  function dispose() {
    for (let i = list.length - 1; i >= 0; i--) freeAvatar(list[i]);
    leaving = 0;
    for (const tg of tags) { root.remove(tg.sp); tg.tex.dispose(); tg.mat.dispose(); } tags.length = 0;
    scene.remove(root);
    for (const m of [bodyMat, haloMat, poolMat, shadowMat]) m.dispose();
    bodyGeo.dispose(); quadGeo.dispose(); T.dispose();
  }
  // for tests and tools: the drawn state of one avatar (Blender frame), and counters
  function debug(id) { const a = map.get(id); return a ? { x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw, drawn: a.drawn, fade: a.fade, anim: a.animId, tag: !!(a.tag && a.tag.sp.visible), name: a.name, play: a.play, off: a.off, corr: +a.corr.length().toFixed(3), extrap: a.extrap, inView: a.inView } : null; }
  return {
    upsert, remove, update, setVisible, dispose, debug, stats, root, tags,
    get count() { return map.size - leaving; },
    get drawnCount() { return stats.drawn; },
  };
}
