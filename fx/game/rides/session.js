// One ride at a time: borrows the camera, blends in and out, lets the visitor look round by dragging, hides Wick,
// owns the "Get off" button and the tracker line, and puts the walker back where the ride began.
// A ride is { id, name, leave (button label), look: { yaw, pitch } limits (rad), sway (0..1), frame(dt, pose), exit(pose) -> { x, y, yaw },
// onEnd(why) }. frame() fills pose.pos (three.js Vector3), pose.yaw, pose.pitch (radians, yaw 0 looks along -z) and may set pose.blend = seconds
// to ease the camera from where it is to the new pose.
// Photo mode may borrow the camera from a ride (game.takeCamera by 'photo'): the ride is paused (no button, no camera), its own
// frame() keeps running so the boat, the train and the horses carry on, and `carry(out)` hands photo mode how far the seat has
// moved so the photographer travels with the ride. When photo mode lets go the camera is taken back and eased in; an end the ride
// reached meanwhile (the lap, the minute) is held back until then.
const CSS = `
#rides-leave{position:fixed;z-index:9;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 92px);appearance:none;border:1px solid rgba(255,181,71,.7);
  border-radius:999px;padding:12px 22px;min-height:44px;background:rgba(13,11,38,.78);color:var(--paper,#f5ecdc);font:600 14px var(--ui,system-ui);cursor:pointer;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);touch-action:manipulation;-webkit-user-select:none;user-select:none;max-width:calc(100vw - 32px);white-space:nowrap}
#rides-leave[hidden]{display:none} #rides-leave kbd{font:600 11px var(--ui,system-ui);border:1px solid var(--line,rgba(245,236,220,.22));border-radius:5px;padding:1px 5px;margin-left:8px;opacity:.8}
@media (pointer:coarse){ #rides-leave kbd{display:none} }
/* the walker's touch controls and the hop button have nothing to do on a ride */
body.rides-on .pf-touch,body.rides-on #stick,body.rides-on #hop{display:none!important}
@media (max-width:640px){ #rides-leave{bottom:calc(env(safe-area-inset-bottom,0px) + 240px)} }   /* above the caption card, which ends about 210 px up */
body.clean #rides-leave{opacity:0;pointer-events:none}
`;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function createSession(game) {
  const { THREE, camera, renderer } = game, canvas = renderer.domElement;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const btn = document.createElement('button'); btn.id = 'rides-leave'; btn.type = 'button'; btn.hidden = true; document.body.appendChild(btn);
  const pose = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, blend: 0 };
  const euler = new THREE.Euler(0, 0, 0, 'YXZ'), qT = new THREE.Quaternion(), blend = { p0: new THREE.Vector3(), q0: new THREE.Quaternion(), t: 9, dur: 1 };
  const look = { yaw: 0, pitch: 0, id: -1, x: 0, y: 0 };
  let cur = null, release = null, near0 = 0.22, wickWas = null, t = 0;
  const carryAcc = new THREE.Vector3(), lastPose = new THREE.Vector3();

  function startBlend(sec) { blend.p0.copy(camera.position); blend.q0.copy(camera.quaternion); blend.t = 0; blend.dur = Math.max(0.01, sec); }
  const wickGroup = () => { const pf = game.platformer; return pf && pf.character && pf.character.group; };

  function tick(dt) {
    if (!cur) return;
    t += dt; const d = cur.def;
    if (cur.resume) { cur.resume = false; startBlend(0.7); }              // photo mode has just given the camera back: ease in from where it left it
    d.frame(dt, pose);
    if (pose.blend) { startBlend(pose.blend); pose.blend = 0; }
    let k = 1;
    if (blend.t < blend.dur) { blend.t += dt; k = smooth(blend.t / blend.dur); }
    const lk = cur.ending ? 1 - k : 1;                                  // the look-round offset eases away as the camera goes back
    const sw = game.reduceMotion ? 0 : (d.sway ?? 1);
    euler.set(pose.pitch + look.pitch * lk + sw * 0.006 * Math.sin(t * 0.8), pose.yaw + look.yaw * lk, sw * 0.012 * Math.sin(t * 1.3 + 1));
    qT.setFromEuler(euler);
    if (k < 1) { camera.position.lerpVectors(blend.p0, pose.pos, k); camera.quaternion.slerpQuaternions(blend.q0, qT, k); }
    else { camera.position.copy(pose.pos); camera.quaternion.copy(qT); }
    if (sw) camera.position.y += sw * 0.012 * Math.sin(t * 2.1);
    const g = wickGroup(); if (g && g.visible) g.visible = false;
    if (cur.ending && blend.t >= blend.dur) finish(cur.why);
  }

  function start(def) {
    if (cur) return false;
    if (game.cameraHeld) return false;
    cur = { def, ending: false, why: '', paused: false, pending: '', resume: false }; t = 0; look.yaw = look.pitch = 0; look.id = -1;
    near0 = camera.near; camera.near = 0.08; camera.updateProjectionMatrix();
    const g = wickGroup(); wickWas = g ? g.visible : null; if (g) g.visible = false;
    release = game.takeCamera(tick, { name: 'rides' });
    startBlend(def.blendIn ?? 0.8);
    btn.hidden = false; setLeave(def.leave); document.body.classList.add('rides-on');
    return true;
  }
  function setLeave(label) { btn.innerHTML = label + '<kbd>Esc</kbd>'; }

  function end(why = 'button') {
    if (!cur || cur.ending) return;
    if (why === 'mode' || why === 'taken') { finish(why); return; }
    if (cur.paused) { cur.pending = cur.pending || why; return; }              // photo mode has the camera: the end waits for it
    cur.ending = true; cur.why = why;
    const e = cur.def.exit(); cur.exit = e;                              // { x, y, yaw: where the walker goes back to; pos (three.js), cyaw, cpitch: the camera's last pose }
    cur.def = { ...cur.def, frame() {} }; pose.pos.copy(e.pos); pose.yaw = e.cyaw; pose.pitch = e.cpitch ?? 0;
    startBlend(cur.def.blendOut ?? 0.9);
    btn.hidden = true;
  }

  function finish(why) {
    const c = cur; if (!c) return; cur = null;
    btn.hidden = true; document.body.classList.remove('rides-on');
    if (release && why !== 'taken') release(why); release = null;
    camera.near = near0; camera.updateProjectionMatrix();
    const g = wickGroup(); if (g && wickWas !== null) g.visible = game.ctx.getMode() === 'walk' && !!(game.platformer && game.platformer.active);
    try { c.def.onEnd && c.def.onEnd(why); } catch (e) { console.warn('rides: onEnd', e); }
    if (c.exit && (why === 'button' || why === 'done')) {
      game.teleport(c.exit.x, c.exit.y, c.exit.yaw);
      // setMode() always stands the walker on the lowest level; a platform or a deck needs its height put back (Wick spawns from walk.z too)
      const w = game.ctx.walk, z = c.exit.z; if (w && z > 1 && Math.abs(w.x - c.exit.x) < 1 && Math.abs(w.y - c.exit.y) < 1 && game.ground(w.x, w.y, z) !== null) { w.z = w.cz = game.ground(w.x, w.y, z); }
    }
    game.emit('rides:leave', { ride: c.def.id, why });
  }

  // look round by dragging (mouse or one finger); handled before the viewer's own pointer code
  const onDown = (e) => {
    if (!cur || cur.ending || cur.paused || e.target !== canvas) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (look.id !== -1) return;
    look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY; try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* gone */ }
  };
  const onMove = (e) => {
    if (!cur || cur.paused || e.target !== canvas) return;
    e.stopImmediatePropagation();
    if (e.pointerId !== look.id) return;
    const k = e.pointerType === 'touch' ? 0.0052 : 0.0034, L = cur.def.look || { yaw: 1.7, pitch: 0.7 };
    look.yaw = Math.max(-L.yaw, Math.min(L.yaw, look.yaw - (e.clientX - look.x) * k));
    look.pitch = Math.max(-L.pitch, Math.min(L.pitch * 0.7, look.pitch - (e.clientY - look.y) * k));
    look.x = e.clientX; look.y = e.clientY;
  };
  const onUp = (e) => { if (e.pointerId === look.id) look.id = -1; if (cur && !cur.paused && e.target === canvas) e.stopImmediatePropagation(); };
  for (const [n, f] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp]]) window.addEventListener(n, f, true);
  // capture phase, and stopped: the viewer's own Esc (and Wick's) would otherwise leave Walk for Explore first
  // Wick's action keys are swallowed too: the platformer latches them while its update waits, so E (its swing) pressed
  // on a ride swung the pole on the way out and boarded the monorail again
  const WICK_KEYS = /^(Space|Key[EFJKXCLZQ]|Shift(Left|Right))$/;
  window.addEventListener('keydown', (e) => {
    if (!cur || cur.paused) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end('button'); }
    else if (game.player.wick && WICK_KEYS.test(e.code) && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  btn.addEventListener('click', () => end('button'));
  // a place chip during a ride: get off at once and let the chip take the visitor there (the walker moved, the ride kept
  // the camera, and on getting off the visitor was put back where they boarded)
  document.addEventListener('click', (e) => { if (cur && e.target.closest && e.target.closest('.chip')) finish('mode'); }, true);
  // app.js re-derives the near plane every frame from the distance to the park's geometry (fx/depth.js), which knows
  // nothing of the boat's canopy or the carousel: over open water it rose to 0.8 m and cut the canopy and its posts.
  // While riding, cap it the way the guests and Wick do (the walk floor of 0.22 m still applies).
  const depth = window.__park && window.__park.depth;
  if (depth && typeof depth.update === 'function') { const du = depth.update; depth.update = (nf) => { if (cur) depth.cap = Math.min(depth.cap ?? Infinity, 0.1); return du(nf); }; }
  game.on('mode', ({ mode }) => { if (cur && mode !== 'walk') end('mode'); });
  function pause() { cur.paused = true; btn.hidden = true; look.id = -1; lastPose.copy(pose.pos); carryAcc.set(0, 0, 0); }
  function resume() {
    cur.paused = false; release = game.takeCamera(tick, { name: 'rides' }); cur.resume = true;
    const p = cur.pending; cur.pending = ''; if (p) end(p); else btn.hidden = false;
  }
  game.on('camera', ({ held, by }) => {
    if (!cur) return;
    if (held && by === 'photo' && !cur.ending && !cur.paused) pause();
    else if (held && by !== 'rides' && by !== 'photo') end('taken');
    else if (held && by === 'photo' && cur.ending) finish('taken');
    else if (!held && by === 'photo' && cur.paused) resume();
  });
  game.on('frame', ({ dt }) => {                          // paused for photo mode: the ride goes on without the camera
    if (!cur || !cur.paused || cur.pending) return;
    t += dt; cur.def.frame(dt, pose); pose.blend = 0;
    carryAcc.x += pose.pos.x - lastPose.x; carryAcc.y += pose.pos.y - lastPose.y; carryAcc.z += pose.pos.z - lastPose.z; lastPose.copy(pose.pos);
  });

  const carry = (out) => { out.copy(carryAcc); carryAcc.set(0, 0, 0); return out; };
  return { start, end, setLeave, carry, get photoOk() { return !!cur && !cur.ending && !cur.paused; }, get paused() { return !!cur && cur.paused; }, get active() { return !!cur; }, get ending() { return !!cur && cur.ending; }, look, get riding() { return cur && cur.def.id; } };
}
