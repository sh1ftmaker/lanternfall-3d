// Platformer controls: keyboard, gamepad (Gamepad API) and touch (left stick, three buttons, drag to orbit).
// While the Platformer is active its listeners sit on `window` in the capture phase and stop the events they use, so
// the Walk controller in app.js never sees them; mode keys (1, 2, 3) and Esc handling are left to the caller.
//
// read() -> { mx, my (move, -1..1, my = forward), a, b, z (held), orbitX, orbitY (camera, rad this frame), zoom, used }
export function createInput({ canvas, coarse, onExit, onSwitch }) {
  const keys = new Set();
  const st = { on: false, stick: { id: -1, ox: 0, oy: 0, x: 0, y: 0 }, orbit: { id: -1, x: 0, y: 0, dx: 0, dy: 0 }, btn: { a: false, b: false, z: false }, wheel: 0, lastDevice: coarse ? 'touch' : 'keyboard', pad: null };
  const KEYMAP = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1, ShiftLeft: 1, ShiftRight: 1, KeyC: 1, KeyE: 1, KeyF: 1, KeyQ: 1, KeyJ: 1, KeyK: 1, KeyL: 1, KeyX: 1, KeyZ: 1 };
  const onKeyDown = (e) => {
    if (!st.on || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Escape') { e.stopPropagation(); e.preventDefault(); onExit && onExit(); return; }
    if (e.code === 'KeyP' || e.code === 'Tab') { e.stopPropagation(); e.preventDefault(); if (!e.repeat) onSwitch && onSwitch(); return; }
    if (KEYMAP[e.code]) { keys.add(e.code); st.lastDevice = 'keyboard'; e.stopPropagation(); e.preventDefault(); }
  };
  const onKeyUp = (e) => { if (keys.delete(e.code) && st.on) e.stopPropagation(); };
  addEventListener('keydown', onKeyDown, true); addEventListener('keyup', onKeyUp, true);
  addEventListener('blur', () => keys.clear());

  // ── pointer: on the canvas, captured so app.js's Walk handlers stay out ──
  const R = 52;
  const ui = document.createElement('div'); ui.className = 'pf-touch'; ui.hidden = true;
  ui.innerHTML = `<div class="pf-stick" hidden><i></i></div>
    <div class="pf-btns" role="group" aria-label="Platformer actions">
      <button type="button" class="pf-b pf-act" data-k="b" aria-label="Lantern swing / dive">Swing</button>
      <button type="button" class="pf-b pf-crouch" data-k="z" aria-label="Crouch">Crouch</button>
      <button type="button" class="pf-b pf-jump" data-k="a" aria-label="Jump">Jump</button>
    </div>`;
  document.body.appendChild(ui);
  const stickEl = ui.querySelector('.pf-stick'), knob = stickEl.firstElementChild;
  for (const b of ui.querySelectorAll('.pf-b')) {
    const k = b.dataset.k;
    const down = (e) => { e.preventDefault(); e.stopPropagation(); st.btn[k] = true; b.classList.add('on'); st.lastDevice = 'touch'; try { b.setPointerCapture(e.pointerId); } catch (er) { /* fine */ } };
    const up = (e) => { e.preventDefault(); st.btn[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const onDown = (e) => {
    if (!st.on || e.target !== canvas) return;
    e.stopPropagation(); e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (er) { /* fine */ }
    if (e.pointerType === 'touch' && e.clientX < innerWidth * 0.42 && st.stick.id === -1) {
      Object.assign(st.stick, { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
      stickEl.hidden = false; stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px'; knob.style.transform = ''; st.lastDevice = 'touch';
    } else if (st.orbit.id === -1) { Object.assign(st.orbit, { id: e.pointerId, x: e.clientX, y: e.clientY }); if (e.pointerType !== 'touch') st.lastDevice = 'keyboard'; }
  };
  const onMove = (e) => {
    if (!st.on) return;
    if (e.pointerId === st.stick.id) {
      e.stopPropagation();
      let dx = e.clientX - st.stick.ox, dy = e.clientY - st.stick.oy; const m = Math.hypot(dx, dy);
      if (m > R) { dx *= R / m; dy *= R / m; }
      st.stick.x = dx / R; st.stick.y = dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
    } else if (e.pointerId === st.orbit.id) {
      e.stopPropagation();
      st.orbit.dx += e.clientX - st.orbit.x; st.orbit.dy += e.clientY - st.orbit.y; st.orbit.x = e.clientX; st.orbit.y = e.clientY;
    }
  };
  const onUp = (e) => {
    if (e.pointerId === st.stick.id) { st.stick.id = -1; st.stick.x = st.stick.y = 0; stickEl.hidden = true; }
    if (e.pointerId === st.orbit.id) st.orbit.id = -1;
  };
  addEventListener('pointerdown', onDown, true); addEventListener('pointermove', onMove, true);
  addEventListener('pointerup', onUp, true); addEventListener('pointercancel', onUp, true);
  canvas.addEventListener('wheel', (e) => { if (!st.on) return; st.wheel += Math.sign(e.deltaY); e.stopPropagation(); }, { capture: true, passive: true });

  // ── gamepad ──
  const dz = (v, d = 0.18) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
  function readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i) => !!(p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5));
      const r = { mx: dz(p.axes[0] || 0), my: -dz(p.axes[1] || 0), ox: dz(p.axes[2] || 0), oy: dz(p.axes[3] || 0), a: b(0), b: b(2) || b(1), z: b(6) || b(7) || b(4) || b(5), any: false };
      r.any = r.a || r.b || r.z || Math.abs(r.mx) + Math.abs(r.my) + Math.abs(r.ox) + Math.abs(r.oy) > 0;
      if (r.any) st.lastDevice = 'gamepad';
      return r;
    }
    return null;
  }

  function read(dt) {
    const k = (c) => keys.has(c);
    let mx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let my = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    const kl = Math.hypot(mx, my); if (kl > 1) { mx /= kl; my /= kl; }
    let a = k('Space') || k('KeyJ'), b = k('KeyE') || k('KeyF') || k('KeyK') || k('KeyX'), z = k('ShiftLeft') || k('ShiftRight') || k('KeyC') || k('KeyL') || k('KeyZ');
    let ox = (st.orbit.dx) * 0.006, oy = (st.orbit.dy) * 0.005; st.orbit.dx = st.orbit.dy = 0;
    if (k('KeyQ')) ox -= dt * 2.2;
    if (st.stick.id !== -1) { mx += st.stick.x; my += -st.stick.y; }
    a = a || st.btn.a; b = b || st.btn.b; z = z || st.btn.z;
    const pad = readPad(); st.pad = pad;
    if (pad) { mx += pad.mx; my += pad.my; a = a || pad.a; b = b || pad.b; z = z || pad.z; ox += pad.ox * dt * 2.6; oy += pad.oy * dt * 1.8; }
    const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
    const zoom = st.wheel; st.wheel = 0;
    return { mx, my, a, b, z, orbitX: ox, orbitY: oy, zoom, dragging: st.orbit.id !== -1, device: st.lastDevice };
  }
  function setActive(on) {
    st.on = on; keys.clear(); st.btn.a = st.btn.b = st.btn.z = false;
    ui.hidden = !(on && (coarse || st.lastDevice === 'touch'));
    if (!on) { st.stick.id = -1; stickEl.hidden = true; st.orbit.id = -1; }
  }
  return { read, setActive, ui, st, dispose() { removeEventListener('keydown', onKeyDown, true); removeEventListener('keyup', onKeyUp, true); removeEventListener('pointerdown', onDown, true); removeEventListener('pointermove', onMove, true); removeEventListener('pointerup', onUp, true); removeEventListener('pointercancel', onUp, true); ui.remove(); } };
}
