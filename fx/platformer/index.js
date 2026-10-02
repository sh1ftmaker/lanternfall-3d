// The Platformer: an alternative to Walk mode. Wick, the park's lamplighter, moves with libsm64's movement code
// (decompiled SM64 player physics, built without any game data: see CREDITS.md), in a Worker, on the park's own
// collision streamed around them; drawn and animated by this project's own character, rig and clips.
//
// app.js loads this module the first time the visitor switches (Walk mode control, or P / Tab) and calls
//   const pf = await createPlatformer(ctx);  pf.enter() / pf.exit();  pf.update(dt) in Walk mode;  pf.frame(dt, mode) every frame.
// Nothing here costs anything before that.
import { createCollision, UNITS } from './collision.js';
import { createCharacter } from './character.js';
import { createAnimator } from './animator.js';
import { createInput } from './input.js';
import { actionName } from './actions.js';
import { CLIP, LEN, LOOP, ID } from './anims.js';
import { ACT_GROUP, ACT_FLAG } from './sm64.js';

const STEP = 1 / 30;
const CSS = `
.pf-touch{position:fixed;inset:0;z-index:6;pointer-events:none}
.pf-touch[hidden]{display:none}
.pf-stick{position:fixed;width:116px;height:116px;margin:-58px 0 0 -58px;border-radius:50%;border:1px solid rgba(245,236,220,.22);background:rgba(13,11,38,.35)}
.pf-stick[hidden]{display:none}
.pf-stick i{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:rgba(255,181,71,.85)}
.pf-btns{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:calc(env(safe-area-inset-bottom,0px) + 112px);width:176px;height:176px;pointer-events:none}
.pf-b{position:absolute;pointer-events:auto;appearance:none;border:1px solid rgba(245,236,220,.3);background:rgba(13,11,38,.55);color:#f5ecdc;border-radius:50%;
  font:600 12px Figtree,system-ui,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.pf-b.on{background:rgba(255,181,71,.85);color:#2a1a02}
.pf-jump{right:0;bottom:0;width:84px;height:84px;border-color:rgba(255,181,71,.7)}
.pf-crouch{right:98px;bottom:2px;width:62px;height:62px}
.pf-act{right:14px;bottom:100px;width:62px;height:62px}
body.pf-on #stick{display:none}
#pfdebug{position:fixed;left:12px;top:64px;z-index:9;font:11px/1.35 ui-monospace,Menlo,monospace;color:#cfe;background:rgba(5,4,15,.72);padding:8px 10px;border-radius:8px;white-space:pre;pointer-events:none;max-width:calc(100vw - 24px);overflow:hidden}
`;

export async function createPlatformer(ctx) {
  const { THREE, scene, camera, renderer, manifest, depth, surface, walk } = ctx;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const status = (t) => ctx.status && ctx.status(t);
  const dbgOn = /pfdebug/.test(location.hash);
  const S = { active: false, ready: false, seq: 0, posted: 0, acc: 0, pending: false, states: new Map(), latest: -1, loads: 0, lastLoad: null, window: null, gathering: false,
    lastSafe: null, safeT: 0, respawns: 0, cam: { yaw: 0, pitch: 0.3, dist: 6.2, distNow: 6.2, target: new THREE.Vector3(), init: false, lastUser: -10, frac: 1 }, t: 0, tickMs: 0, events: [], spawnAt: null };
  // ── worker + library ──
  const worker = new Worker(new URL('./pf-worker.js', import.meta.url), { type: 'module' });
  const waiters = {};
  const once = (type) => new Promise((res, rej) => { waiters[type] = res; setTimeout(() => rej(new Error('platformer worker: no ' + type)), 30000); });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'state') { S.pending = false; S.states.set(m.seq, m.s); S.latest = Math.max(S.latest, m.seq); S.camFrac = m.cam; S.tickMs = m.tickMs; for (const k of S.states.keys()) if (k < m.seq - 4) S.states.delete(k); return; }
    if (m.type === 'loaded') { S.loads++; S.lastLoad = m; S.events.push(`load #${S.loads}: ${m.count} surfaces, ${m.ms} ms (+${m.rayMs} ms rays)`); if (S.events.length > 6) S.events.shift(); }
    if (m.type === 'error') { console.warn('platformer worker:', m.message); }
    const w = waiters[m.type]; if (w) { delete waiters[m.type]; w(m); }
  };
  status('Waking the lamplighter…');
  worker.postMessage({ type: 'init' });
  const ready = await once('ready');
  // ── collision index (time-sliced: a few ms per frame) ──
  const col = createCollision({ park: ctx.park, lodMeshes: ctx.lodMeshes, manifest, nav: ctx.nav });
  await new Promise((res) => {
    const it = col.prepareSteps(6);
    const stepFn = () => { const r = it.next(); status(`Mapping the park for the lamplighter… ${Math.round(col.stats.progress * 100)}%`); if (r.done) res(); else requestAnimationFrame(stepFn); };
    stepFn();
  });
  status(null);
  // ── character, animation, input ──
  const ch = createCharacter({ THREE, scene, surface, guests: ctx.guests && ctx.guests(), manifest });
  const anim = createAnimator(THREE);
  const input = createInput({ canvas: renderer.domElement, coarse: ctx.coarse, onExit: () => api.exit(), onSwitch: () => api.exit() });

  // collision windows: 60 m squares; built a few ms per frame (gatherSteps), then handed to the worker
  let job = null;
  function loadWindow(x, y, z, now = false) {     // x, y, z in metres (three.js)
    if (now) { job = null; const g = col.gather(x, z, 30); send(g, x, y, z); return; }
    job = { x, y, z, it: col.gatherSteps(x, z, 30, 2.5) };
  }
  function send(g, x, y, z) { S.window = { x, y, z, stats: g.stats }; worker.postMessage({ type: 'surfaces', packed: g.packed, count: g.count, seq: ++S.seq }, [g.packed.buffer]); }
  function runJob() { if (!job) return; const r = job.it.next(); if (r.done) { const j = job; job = null; send(r.value, j.x, j.y, j.z); } }
  // ── state interpolation ──
  const lerp = (a, b, t) => a + (b - a) * t;
  const angLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
  const view = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, vel: new THREE.Vector3(), action: 0, animID: 0, frame: 0, s: null };
  function sample(alphaTick) {
    const i = Math.floor(alphaTick), f = alphaTick - i;
    let a = S.states.get(i), b = S.states.get(i + 1);
    if (!b) { b = S.states.get(S.latest); a = S.states.get(S.latest - 1) || b; return blend(a, b, 1); }
    if (!a) a = b;
    return blend(a, b, f);
  }
  function blend(a, b, f) {
    if (!b) return null;
    view.pos.set(lerp(a.pos[0], b.pos[0], f), lerp(a.pos[1], b.pos[1], f), lerp(a.pos[2], b.pos[2], f)).divideScalar(UNITS);
    view.vel.set(b.vel[0], b.vel[1], b.vel[2]).multiplyScalar(30 / UNITS);
    // big jumps (teleport, ledge climb end) are not interpolated
    if (Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) > 300) view.pos.set(b.pos[0], b.pos[1], b.pos[2]).divideScalar(UNITS);
    view.yaw = angLerp(a.gfxYaw, b.gfxYaw, f); view.pitch = angLerp(a.gfxPitch, b.gfxPitch, f); view.roll = angLerp(a.gfxRoll, b.gfxRoll, f);
    view.action = b.action; view.animID = b.animID; view.s = b;
    // animation frame: continuous between ticks (accelerated animations advance by animAccel per tick)
    const len = LEN[b.animID] || 20, fa = a.animID === b.animID ? (a.animAccel ? a.animFrameF : a.animFrame) : null, fb = b.animAccel ? b.animFrameF : b.animFrame;
    let fr = fb;
    if (fa !== null) { let d = fb - fa; if (LOOP[b.animID] && d < -len / 2) d += len; fr = fa + d * f; if (fr >= len) fr -= len; }
    view.frame = Math.max(0, fr);
    return view;
  }
  // ── camera ──
  const tmpV = new THREE.Vector3(), headV = new THREE.Vector3(), look = new THREE.Vector3();
  function updateCamera(dt, inp, v) {
    const C = S.cam, rm = ctx.reduceMotion();
    const head = headV.set(v.pos.x, v.pos.y + 1.15, v.pos.z);
    if (!C.init) { C.target.copy(head); C.init = true; }
    // lag: horizontal follows tightly, vertical eases (jumps do not shake the view); less lag with Reduce motion
    const kx = rm ? 30 : 9, ky = rm ? 20 : 4.5;
    C.target.x += (head.x - C.target.x) * (1 - Math.exp(-dt * kx)); C.target.z += (head.z - C.target.z) * (1 - Math.exp(-dt * kx));
    const swim = v.s && (v.s.action & ACT_GROUP.mask) === ACT_GROUP.submerged;
    C.target.y += (head.y - C.target.y) * (1 - Math.exp(-dt * (swim || Math.abs(head.y - C.target.y) > 3 ? 10 : ky)));
    if (Math.abs(head.y - C.target.y) > 6) C.target.y = head.y - Math.sign(head.y - C.target.y) * 6;
    // user orbit
    if (inp.orbitX || inp.orbitY) { C.yaw -= inp.orbitX; C.pitch = Math.min(1.25, Math.max(-0.45, C.pitch + inp.orbitY)); C.lastUser = S.t; }
    if (inp.zoom) C.dist = Math.min(12, Math.max(2.5, C.dist * (inp.zoom > 0 ? 1.12 : 1 / 1.12)));
    // gentle follow: when moving and not steered for a while, swing behind the direction of travel (not with Reduce motion)
    const sp = Math.hypot(v.vel.x, v.vel.z);
    if (!rm && S.t - C.lastUser > 1.2 && sp > 1.5 && !inp.dragging) {
      const behind = Math.atan2(-v.vel.x, -v.vel.z);
      let d = ((behind - C.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      if (Math.abs(d) < 2.6) C.yaw += d * Math.min(1, dt * 0.55 * Math.min(1, sp / 6));
    }
    // collision: the worker casts head -> wanted camera each tick; pull in fast, ease back out
    const want = C.dist, frac = S.camFrac ?? 1;
    const lim = frac < 1 ? Math.max(0.9, want * frac - 0.35) : want;
    C.distNow += (lim - C.distNow) * (1 - Math.exp(-dt * (lim < C.distNow ? 18 : 2.5)));
    const cp = Math.cos(C.pitch), off = tmpV.set(Math.sin(C.yaw) * cp, Math.sin(C.pitch), Math.cos(C.yaw) * cp);
    camera.position.copy(C.target).addScaledVector(off, C.distNow);
    // stay above the lake surface (the mirror needs the camera above it)
    if (col.lakeContains(camera.position.x, camera.position.z) && camera.position.y < col.waterY + 0.35) camera.position.y = col.waterY + 0.35;
    look.copy(C.target); look.y = C.target.y + (head.y - C.target.y) * 0.7 - 0.15;      // keep a jumping lamplighter in frame
    camera.lookAt(look);
    return off;
  }
  // ── per frame ──
  let lastFrameMs = 0;
  const api = {
    get active() { return S.active; }, S, col, character: ch, animator: anim, input, worker,
    stats: () => ({ loads: S.loads, lastLoad: S.lastLoad, window: S.window && S.window.stats, tickMs: S.tickMs, prepMs: col.stats.prepMs, kept: col.stats.kept, frameMs: lastFrameMs, respawns: S.respawns }),
    // spawn at the walker's position (Blender frame x, y; yaw about +z)
    enter(at) {
      const bx = at ? at.x : walk.x, by = at ? at.y : walk.y, bz = at ? at.z : walk.z, byaw = at ? at.yaw : walk.yaw;
      const x = bx, z = -by, y = bz;
      loadWindow(x, y, z, true);
      const face = Math.atan2(Math.cos(byaw), -Math.sin(byaw));
      worker.postMessage({ type: 'spawn', x: x * UNITS, y: (y + 0.05) * UNITS, z: z * UNITS, yaw: face });
      S.states.clear(); S.latest = -1; S.posted = 0; S.acc = 0; S.pending = false; S.lastSafe = [x, y, z, face];
      S.cam.yaw = face + Math.PI; S.cam.pitch = 0.3; S.cam.init = false; S.cam.distNow = S.cam.dist; S.cam.lastUser = -10;
      S.active = true; ch.setVisible(true); input.setActive(true); document.body.classList.add('pf-on'); pressed(true);
      if (ctx.setFov) ctx.setFov(58);
      if (dbgOn) ensureDebug();
      ctx.hint && ctx.hint(ctx.coarse ? 'Left thumb moves · Jump, Crouch, Swing on the right · drag to look' : 'WASD move · Space jump · Shift crouch · E swing · drag to look · P back to Walk');
    },
    exit(toMode) {
      if (!S.active) return;
      S.active = false; ch.setVisible(false); input.setActive(false); document.body.classList.remove('pf-on'); pressed(false);
      if (depth.cap !== undefined) depth.cap = Infinity;
      const s = S.states.get(S.latest);
      if (toMode !== 'none' && ctx.setMode) {
        const p = s ? s.pos : [walk.x * UNITS, walk.z * UNITS, -walk.y * UNITS], face = s ? s.gfxYaw : 0;
        const yaw = Math.atan2(-Math.cos(face), Math.sin(face));
        ctx.setMode('walk', { at: [p[0] / UNITS, -p[2] / UNITS], yaw });
      }
      if (ctx.setFov) ctx.setFov(null);
    },
    // called by app.js every frame (any mode): leaves the Platformer when the mode changes
    frame(dt, mode) { if (S.active && mode !== 'walk') api.exit('none'); if (dbg) dbg.hidden = !S.active; },
    update(dt) {
      if (!S.active) return;
      const t0 = performance.now(); S.t += dt;
      const inp = input.read(dt);
      // fixed 30 Hz ticks in the worker; never more than one in flight
      S.acc += dt;
      if (S.acc > STEP * 4) S.acc = STEP * 4;
      while (S.acc >= STEP && !S.pending) {
        S.acc -= STEP;
        const last = S.states.get(S.latest), C = S.cam;
        const px = last ? last.pos[0] / UNITS : walk.x, py = last ? last.pos[1] / UNITS : walk.z, pz = last ? last.pos[2] / UNITS : -walk.y;
        const camDX = camera.position.x - px, camDZ = camera.position.z - pz, cl = Math.hypot(camDX, camDZ) || 1;
        const water = col.lakeContains(px, pz) ? Math.round(col.waterY * UNITS) : -100000;
        const cp = Math.cos(C.pitch), cam = [px * UNITS, (py + 1.15) * UNITS, pz * UNITS, (px + Math.sin(C.yaw) * cp * C.dist) * UNITS, (py + 1.15 + Math.sin(C.pitch) * C.dist) * UNITS, (pz + Math.cos(C.yaw) * cp * C.dist) * UNITS];
        worker.postMessage({ type: 'tick', seq: ++S.posted, water, cam,
          input: { camLookX: camDX / cl, camLookZ: camDZ / cl, stickX: -inp.mx, stickY: inp.my, a: inp.a ? 1 : 0, b: inp.b ? 1 : 0, z: inp.z ? 1 : 0 } });
        S.pending = true;
      }
      const v = S.latest > 0 ? sample(S.posted - 1 + S.acc / STEP) : null;
      if (!v) { lastFrameMs = performance.now() - t0; return; }
      const s = v.s;
      // collision window: re-centre ahead of the player when they near its edge (hysteresis: 12 m of 36)
      const w = S.window;
      if (job) runJob();
      else if (w && (Math.hypot(v.pos.x - w.x, v.pos.z - w.z) > 10 || Math.abs(v.pos.y - w.y) > 25)) loadWindow(v.pos.x + v.vel.x * 0.6, v.pos.y, v.pos.z + v.vel.z * 0.6);
      // safety: remember solid ground; bring the lamplighter back if they leave the world
      const grp = s.action & ACT_GROUP.mask;
      if ((grp === ACT_GROUP.stationary || grp === ACT_GROUP.moving) && s.floorN[1] > 0.9 && !col.lakeContains(v.pos.x, v.pos.z) && Math.abs(s.pos[1] - s.floorY) < 5) {
        S.safeT += dt; if (S.safeT > 0.4) { S.safeT = 0; S.lastSafe = [v.pos.x, v.pos.y, v.pos.z, s.faceAngle]; }
      }
      if (v.pos.y < col.bedY - 2 || v.pos.y < -20 || (s.floorY < -1000 && grp === ACT_GROUP.airborne && v.pos.y < -5)) respawn('fell out of the world');
      // animation
      const id = s.animID, len = LEN[id] || 20;
      const swimming = grp === ACT_GROUP.submerged;
      const speed = swimming ? Math.hypot(v.vel.x, v.vel.y, v.vel.z) : Math.hypot(v.vel.x, v.vel.z);
      const bones = anim.update(dt, { id, u: Math.min(1, v.frame / Math.max(1, len - 1)) }, { speed, vy: v.vel.y, reduceMotion: ctx.reduceMotion() },
        { pos: v.pos, yaw: v.yaw, pitch: swimming ? 0 : v.pitch, roll: v.roll });
      for (let i = 0; i < bones.length; i++) ch.bones[i].copy(bones[i]);
      const U = ch.uniforms; U.uLantern.value.copy(anim.st.lanternWorld);
      U.uFlicker.value = ctx.reduceMotion() ? 1 : 0.9 + 0.06 * Math.sin(S.t * 13.1) + 0.04 * Math.sin(S.t * 7.3 + 1);
      const fy = s.floorY > -1000 ? s.floorY / UNITS : v.pos.y;
      const above = Math.max(0, v.pos.y - fy);
      U.uGround.value.set(v.pos.x, fy, v.pos.z); U.uShadowK.value = 0.55 * Math.max(0, 1 - above / 6) * (swimming ? 0 : 1);
      U.uPoolK.value = 0.06 * Math.max(0, 1 - (anim.st.lanternWorld.y - fy) / 5) * (swimming ? 0.4 : 1);
      // guests treat the lamplighter like the walker; captions follow
      walk.x = v.pos.x; walk.y = -v.pos.z; walk.z = fy; walk.yaw = Math.atan2(-Math.cos(v.yaw), Math.sin(v.yaw));
      updateCamera(dt, inp, v);
      // the dynamic near plane must not cut the character
      S.capNear = Math.max(0.05, 0.45 * (camera.position.distanceTo(v.pos) - 0.9));
      if (dbg) drawDebug(v, s, inp);
      lastFrameMs = performance.now() - t0;
    },
    dispose() { api.exit('none'); worker.terminate(); ch.dispose(); input.dispose(); style.remove(); if (dbg) dbg.remove(); depth.update = depthUpdate; },
  };
  function pressed(on) { const b = document.getElementById('btn-pf'); if (b) b.setAttribute('aria-pressed', String(on)); }
  function respawn(why) {
    const p = S.lastSafe; if (!p) return;
    S.respawns++; S.events.push(`respawn (${why}) -> ${p.slice(0, 3).map((x) => x.toFixed(1)).join(', ')}`); if (S.events.length > 6) S.events.shift();
    loadWindow(p[0], p[1], p[2], true);
    worker.postMessage({ type: 'teleport', x: p[0] * UNITS, y: (p[1] + 0.3) * UNITS, z: p[2] * UNITS, yaw: p[3], action: 0x0100088C });
    S.states.clear(); S.latest = -1; S.posted = 0; S.acc = 0; S.pending = false; S.cam.init = false;
  }
  api.respawn = respawn;
  // the near-plane cap is applied after the guests set theirs (they run later in the frame)
  const depthUpdate = depth.update;
  depth.update = (nearFloor) => { if (S.active && S.capNear !== undefined) depth.cap = Math.min(depth.cap ?? Infinity, S.capNear); return depthUpdate(nearFloor); };
  // ── #pfdebug overlay ──
  let dbg = null;
  function ensureDebug() { if (dbg) return; dbg = document.createElement('div'); dbg.id = 'pfdebug'; document.body.appendChild(dbg); }
  let dbgT = 0;
  function drawDebug(v, s, inp) {
    if ((dbgT++ & 3) !== 0) return;
    const w = S.window && S.window.stats, f = (x, n = 2) => (Math.round(x * 10 ** n) / 10 ** n).toFixed(n);
    dbg.textContent = [
      `action   ${actionName(s.action)}  (0x${(s.action >>> 0).toString(16)})  state ${s.actionState} timer ${s.actionTimer}`,
      `anim     ${CLIP[s.animID]} #${s.animID}  frame ${s.animFrame}/${LEN[s.animID]}${s.animAccel ? '  accel ' + f(s.animAccel) : ''}`,
      `pos m    ${f(v.pos.x)} ${f(v.pos.y)} ${f(v.pos.z)}   blender ${f(v.pos.x, 1)} ${f(-v.pos.z, 1)}`,
      `speed    ${f(s.fwd * 30 / UNITS)} m/s fwd   vy ${f(s.vel[1] * 30 / UNITS)}   face ${f(s.gfxYaw)}`,
      `floor    ${s.floorY > -1000 ? f(s.floorY / UNITS) : 'none'}  ceil ${s.ceilY < 15000 ? f(s.ceilY / UNITS) : '-'}  water ${s.waterY > -50000 ? f(s.waterY / UNITS) : 'off'}  n.y ${f(s.floorN[1])}`,
      `surfaces ${w ? w.count : 0} (floors ${w ? w.floors : 0}, walls ${w ? w.walls : 0}, flipped ${w ? w.flipped : 0}, ice ${w ? w.ice : 0}, bed ${w ? w.bed : 0}, edge ${w ? w.perimeter : 0})  gather ${w ? w.ms : 0} ms`,
      `window   ${S.window ? f(S.window.x, 1) + ', ' + f(S.window.z, 1) : '-'}   loads ${S.loads}   respawns ${S.respawns}`,
      `timing   tick ${f(S.tickMs, 3)} ms (worker)  main ${f(lastFrameMs, 3)} ms  cam ${f(S.camFrac ?? 1)}  input ${inp.device}`,
      ...S.events,
    ].join('\n');
  }
  return api;
}
