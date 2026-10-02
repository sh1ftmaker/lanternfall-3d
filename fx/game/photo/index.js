// fx/game/photo: photo mode. Stop, frame the park, take a picture home. See README.md.
// Borrows the camera (game.takeCamera), shows the clean view, adds one post pass while an effect is on (pass.js).
import { makePhotoPass, LOOKS } from './pass.js';

const CSS = `
#ph-root{position:fixed;inset:0;z-index:8;overflow:hidden;pointer-events:none;font:500 13px var(--ui);color:var(--paper)} #ph-root[hidden]{display:none}
#ph-pad{position:absolute;inset:0;pointer-events:auto;touch-action:none;cursor:grab} #ph-pad:active{cursor:grabbing}
#ph-crop{position:absolute;box-sizing:border-box;border:1px solid rgba(245,236,220,.55);pointer-events:none;box-shadow:0 0 0 100vmax rgba(5,4,15,.62)}
#ph-crop.free{box-shadow:none;border-color:transparent}
#ph-crop.thirds::before{content:"";position:absolute;inset:0;background:
  linear-gradient(to right,transparent calc(33.33% - .5px),rgba(245,236,220,.4) calc(33.33% - .5px),rgba(245,236,220,.4) calc(33.33% + .5px),transparent calc(33.33% + .5px),transparent calc(66.66% - .5px),rgba(245,236,220,.4) calc(66.66% - .5px),rgba(245,236,220,.4) calc(66.66% + .5px),transparent calc(66.66% + .5px)),
  linear-gradient(to bottom,transparent calc(33.33% - .5px),rgba(245,236,220,.4) calc(33.33% - .5px),rgba(245,236,220,.4) calc(33.33% + .5px),transparent calc(33.33% + .5px),transparent calc(66.66% - .5px),rgba(245,236,220,.4) calc(66.66% - .5px),rgba(245,236,220,.4) calc(66.66% + .5px),transparent calc(66.66% + .5px))}
#ph-ring{position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border:2px solid var(--amber);border-radius:50%;opacity:0;pointer-events:none;transition:opacity .5s ease}
#ph-ring.on{opacity:1;transition:none}
#ph-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none} #ph-flash.go{animation:ph-flash .26s ease-out}
@keyframes ph-flash{from{opacity:.9}to{opacity:0}}
#ph-note{position:absolute;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;max-width:calc(100vw - 32px);padding:6px 14px 6px 6px;border-radius:14px;background:rgba(13,11,38,.82);border:1px solid var(--line);pointer-events:none;opacity:0;transition:opacity .4s ease;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
#ph-note.on{opacity:1} #ph-note img{height:40px;border-radius:8px;display:block} #ph-note span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ph-bar{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 8px);width:min(560px,calc(100vw - 16px));box-sizing:border-box;padding:8px 10px 10px;border-radius:20px;
  background:var(--glass);border:1px solid var(--line);pointer-events:auto;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
#ph-bar button{appearance:none;font:inherit;color:inherit;cursor:pointer;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.ph-panel{display:flex;flex-direction:column;gap:8px;padding:2px 2px 10px;margin-bottom:8px;border-bottom:1px solid var(--line)} .ph-panel[hidden]{display:none}
.ph-chips{display:flex;gap:6px;flex-wrap:wrap} .ph-chips button,.ph-btn{min-height:36px;padding:0 11px;border-radius:999px;border:1px solid var(--line);background:transparent;font-size:12.5px;white-space:nowrap}
.ph-chips button[aria-pressed="true"],.ph-tab[aria-selected="true"]{border-color:var(--amber);color:var(--amber)}
.ph-chips button{flex:1 1 auto;padding:0 6px}
.ph-two{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;align-items:end} .ph-two.one{grid-template-columns:1fr}
.ph-sl{display:flex;flex-direction:column;gap:0;min-width:0} .ph-sl label{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.8} .ph-sl label b{font-weight:600;color:var(--amber);letter-spacing:0}
.ph-sl input{width:100%;height:34px;margin:0;background:transparent;-webkit-appearance:none;appearance:none;touch-action:pan-y}
.ph-sl input::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(245,236,220,.28)} .ph-sl input::-moz-range-track{height:4px;border-radius:2px;background:rgba(245,236,220,.28)}
.ph-sl input::-webkit-slider-thumb{-webkit-appearance:none;width:26px;height:26px;margin-top:-11px;border-radius:50%;background:var(--amber);border:2px solid rgba(13,11,38,.7)}
.ph-sl input::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:var(--amber);border:2px solid rgba(13,11,38,.7)}
.ph-s{display:none} @media (max-width:480px){ .ph-l{display:none} .ph-s{display:inline} }
.ph-hint{font-size:12.5px;opacity:.82;line-height:1.35;margin:0}
.ph-main{display:flex;align-items:center;gap:6px}
.ph-tabs{display:flex;gap:6px;flex:1;min-width:0;justify-content:center} .ph-tab{flex:1 1 0;min-height:44px;border-radius:14px;border:1px solid transparent;background:transparent;font-size:13px}
.ph-done{min-height:44px;padding:0 12px;border-radius:14px;border:1px solid var(--line);background:transparent;font-size:13px}
#ph-shutter{flex:none;width:60px;height:60px;border-radius:50%;border:3px solid var(--paper);background:radial-gradient(circle,var(--amber) 0 62%,transparent 64%);padding:0}
#ph-shutter:active{transform:scale(.94)}
#ph-lightbox{position:fixed;inset:0;z-index:12;display:grid;place-items:center;align-content:center;gap:10px;background:rgba(5,4,15,.88);padding:16px;cursor:pointer;font:500 14px var(--ui);color:var(--paper)} #ph-lightbox[hidden]{display:none}
#ph-lightbox img{max-width:min(92vw,720px);max-height:72vh;border-radius:10px;box-shadow:0 10px 50px rgba(0,0,0,.6)}
.ph-sheet{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px} .ph-sheet button{appearance:none;padding:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#0d0b26;cursor:pointer;aspect-ratio:1;display:block} .ph-sheet img{width:100%;height:100%;object-fit:cover;display:block}
.ph-take{appearance:none;border:1px solid var(--amber);border-radius:999px;background:transparent;color:var(--amber);font:600 13px var(--ui);padding:8px 16px;cursor:pointer}
body.photo-on .pf-touch,body.photo-on #hop,body.photo-on #stick,body.photo-on #hint,body.photo-on #btn-show,body.photo-on #game-track{display:none!important}
#btn-photo{display:none} @media (min-width:641px){ #btn-photo{display:grid} }
@media (prefers-reduced-motion:reduce){ #ph-flash.go{animation:none} #ph-ring,#ph-note{transition:none} }
`;
const ASPECTS = [['free', 'Free', 0], ['1:1', '1:1', 1], ['4:5', '4:5', 4 / 5], ['16:9', '16:9', 16 / 9]];
const KEEP = 12, RADIUS = 25, MIN_FOV = 20, MAX_FOV = 75;
const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function init(game) {
  const { THREE, camera, renderer, Q, ctx } = game;
  const el = (tag, id, cls, html) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
  const prefs = { aspect: 'free', thirds: true, look: 'natural', ...(game.save.get('photo', {}).prefs || {}) };
  const saved = () => game.save.get('photo', { shots: [], prefs });
  const st = { aperture: 0, focus: [0.5, 0.5], look: 'natural', vig: 0, crop: [0, 0, 1, 1] };   // read live by the post pass
  const cam = { p: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, fov: 52, minFov: MIN_FOV, maxFov: MAX_FOV, home: new THREE.Vector3(), floor: 0 };
  let active = false, release = null, prev = null, wasClean = false, aspect = prefs.aspect, thirds = prefs.thirds, tab = 'frame';
  let lensTouched = false, setFov = 0, builtSig = '', passRef = null, want = false, noteT = 0, ringT = 0;
  const keys = new Set(), ptrs = new Map(); let pinch = 0, mid = null;
  const e = new THREE.Euler(0, 0, 0, 'YXZ'), fwd = new THREE.Vector3(), right = new THREE.Vector3(), tmp = new THREE.Vector3();

  /* ── DOM ── */
  const root = el('div', 'ph-root'); root.hidden = true;
  const pad = el('div', 'ph-pad'), crop = el('div', 'ph-crop'), ring = el('div', 'ph-ring'), flash = el('div', 'ph-flash'), note = el('div', 'ph-note'), bar = el('div', 'ph-bar');
  note.setAttribute('aria-live', 'polite'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Photo controls');
  const slider = (id, label, min, max, step) => `<div class="ph-sl"><label for="${id}">${label}<b id="${id}-v"></b></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"></div>`;
  bar.innerHTML = `
    <div class="ph-panel" data-p="frame"><div class="ph-chips" role="radiogroup" aria-label="Crop">${ASPECTS.map(([id, t]) => `<button type="button" data-asp="${id}" aria-pressed="false">${t}</button>`).join('')}<button type="button" data-thirds aria-pressed="false">Thirds</button></div>
      <div class="ph-two">${slider('ph-lens', 'Lens', 0, 1000, 1)}${slider('ph-roll', 'Roll', -15, 15, 0.5)}</div></div>
    <div class="ph-panel" data-p="focus" hidden><p class="ph-hint" id="ph-fhint">Tap the picture to focus there.</p><div class="ph-two one">${slider('ph-blur', 'Blur', 0, 100, 1)}</div></div>
    <div class="ph-panel" data-p="look" hidden><div class="ph-chips" role="radiogroup" aria-label="Look">${Object.entries(LOOKS).map(([id, k]) => `<button type="button" data-look="${id}" aria-pressed="false" aria-label="${k.name}" title="${k.name}"><span class="ph-l">${k.name}</span><span class="ph-s">${k.short}</span></button>`).join('')}</div>
      <div class="ph-two">${slider('ph-vig', 'Vignette', 0, 100, 1)}<div class="ph-sl"><button type="button" class="ph-btn" id="ph-pose" hidden>Pose</button></div></div></div>
    <div class="ph-main"><button type="button" class="ph-done" id="ph-done">Done</button>
      <div class="ph-tabs" role="tablist"><button type="button" class="ph-tab" role="tab" data-tab="frame">Frame</button><button type="button" class="ph-tab" role="tab" data-tab="focus">Focus</button><button type="button" class="ph-tab" role="tab" data-tab="look">Look</button></div>
      <button type="button" id="ph-shutter" aria-label="Take the picture" title="Take the picture (Space)"></button></div>`;
  root.append(pad, crop, ring, note, flash, bar); document.body.appendChild(root);
  const $ = (s) => bar.querySelector(s), $$ = (s) => [...bar.querySelectorAll(s)];
  const lens = $('#ph-lens'), roll = $('#ph-roll'), blur = $('#ph-blur'), vig = $('#ph-vig');
  const lightbox = el('div', 'ph-lightbox', '', '<img alt=""><span></span>'); lightbox.hidden = true; document.body.appendChild(lightbox);
  lightbox.addEventListener('click', () => { lightbox.hidden = true; });

  /* ── the controls ── */
  const mm = (fov) => Math.round(12 / Math.tan(fov * Math.PI / 360));
  const fovOf = (s) => lerp(cam.maxFov, MIN_FOV, s / 1000), sOf = (f) => Math.round(1000 * (cam.maxFov - f) / (cam.maxFov - MIN_FOV));
  function syncUI() {
    $('#ph-lens-v').textContent = mm(cam.fov) + ' mm'; $('#ph-roll-v').textContent = (cam.roll * 180 / Math.PI).toFixed(1) + '°';
    $('#ph-blur-v').textContent = st.aperture ? Math.round(st.aperture * 100) : 'Off'; $('#ph-vig-v').textContent = st.vig ? Math.round(st.vig * 100) : 'Off';
    for (const b of $$('[data-asp]')) b.setAttribute('aria-pressed', String(b.dataset.asp === aspect));
    for (const b of $$('[data-look]')) b.setAttribute('aria-pressed', String(b.dataset.look === st.look));
    $('[data-thirds]').setAttribute('aria-pressed', String(thirds));
    for (const b of $$('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of $$('[data-p]')) p.hidden = p.dataset.p !== tab;
    crop.classList.toggle('thirds', thirds);
  }
  function layoutCrop() {
    const vw = innerWidth, vh = innerHeight, r = ASPECTS.find((a) => a[0] === aspect)[2];
    let x = 0, y = 0, w = vw, h = vh;
    if (r) {
      const top = bar.getBoundingClientRect().top, aw = vw - 16, ah = Math.max(80, top - 16);
      w = Math.min(aw, ah * r); h = w / r; x = (vw - w) / 2; y = 8 + (ah - h) / 2;
    }
    crop.className = (r ? '' : 'free ') + (thirds ? 'thirds' : '');
    Object.assign(crop.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    st.crop = [x / vw, 1 - (y + h) / vh, w / vw, h / vh];
    return { x, y, w, h, vw, vh };
  }
  const setTab = (t) => { tab = tab === t ? '' : t; syncUI(); layoutCrop(); };
  for (const b of $$('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of $$('[data-asp]')) b.addEventListener('click', () => { aspect = b.dataset.asp; remember(); syncUI(); layoutCrop(); });
  $('[data-thirds]').addEventListener('click', () => { thirds = !thirds; remember(); syncUI(); layoutCrop(); });
  for (const b of $$('[data-look]')) b.addEventListener('click', () => { st.look = b.dataset.look; remember(); syncUI(); syncPass(); });
  lens.addEventListener('input', () => { lensTouched = true; cam.fov = fovOf(+lens.value); syncUI(); });
  roll.addEventListener('input', () => { cam.roll = +roll.value * Math.PI / 180; syncUI(); });
  $('label[for=ph-roll]').addEventListener('click', (ev) => { ev.preventDefault(); cam.roll = 0; roll.value = 0; syncUI(); });
  blur.addEventListener('input', () => { st.aperture = +blur.value / 100; syncUI(); syncPass(); });
  vig.addEventListener('input', () => { st.vig = +vig.value / 100; syncUI(); syncPass(); });
  $('#ph-done').addEventListener('click', () => leave());
  $('#ph-shutter').addEventListener('click', () => shoot());
  function remember() { game.save.update('photo', (s) => ({ ...s, prefs: { aspect, thirds, look: st.look } }), { shots: [] }); }

  /* ── the post pass: present only while an effect is on; the composer is rebuilt when that changes ── */
  const canBlur = () => !!Q.hdr;
  function syncPass() {
    const dof = active && canBlur() && st.aperture > 0, need = active && (dof || st.look !== 'natural' || st.vig > 0), sig = need ? (dof ? 'd' : 'p') : '';
    $('#ph-fhint').textContent = canBlur() ? 'Tap the picture to focus there.' : 'Blur needs HD or Cinematic: this picture setting has no post chain here.';
    if (sig === builtSig) return;
    builtSig = sig; if (!sig) passRef = null; Q.photo = need ? { depth: dof, build: (c, comp) => { passRef = makePhotoPass(c, comp, st, dof); } } : null;
    const P = window.__park; if (P && P.post && P.post.rebuild) P.post.rebuild();
  }

  /* ── entering and leaving ── */
  function enter() {
    if (active || !game.started) return false;
    const held = game.cameraHeld; if (held) { game.toast('Not just now.'); return false; }
    if (game.journal.isOpen) game.journal.close();
    prev = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, mode: game.player.mode };
    e.setFromQuaternion(camera.quaternion, 'YXZ'); cam.yaw = e.y; cam.pitch = e.x; cam.roll = e.z; cam.p.copy(camera.position); cam.home.copy(camera.position); cam.fov = camera.fov;
    cam.maxFov = Math.max(MAX_FOV, camera.fov); cam.minFov = MIN_FOV;
    const home = game.ctx.isClean(); wasClean = home; game.ctx.setClean(true);
    active = true; document.body.classList.add('photo-on'); root.hidden = false;
    st.look = prefs.look in LOOKS ? prefs.look : 'natural'; st.aperture = 0; st.vig = 0; st.focus = [0.5, 0.5];
    lens.value = sOf(clamp(cam.fov, MIN_FOV, cam.maxFov)); roll.value = clamp(cam.roll * 180 / Math.PI, -15, 15); blur.value = 0; vig.value = 0;
    $('#ph-pose').hidden = !(game.player.wick && game.player.mode === 'walk');
    keys.clear(); ptrs.clear(); tab = 'frame'; lensTouched = false; setFov = 0; syncUI(); layoutCrop(); syncPass();
    release = game.takeCamera(drive, { name: 'photo' });
    Q.afterRender = afterRender;
    game.emit('photo:mode', { on: true });
    return true;
  }
  function leave(why) {
    if (!active) return;
    active = false; if (release && why !== 'replaced') release(); release = null;
    document.body.classList.remove('photo-on'); root.hidden = true; Q.afterRender = null; want = false; keys.clear(); ptrs.clear();
    unpose();
    camera.position.copy(prev.pos); camera.quaternion.copy(prev.quat); camera.fov = prev.fov; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    syncPass(); game.ctx.setClean(wasClean);
    game.emit('photo:mode', { on: false });
  }
  game.on('camera', (d) => { if (active && d.held && d.by !== 'photo') leave('replaced'); });

  /* ── the camera, every frame ── */
  function drive(dt) {
    const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 18 : 6) * dt, lk = 1.2 * dt * clamp(cam.fov / 52, 0.3, 1.5);
    const k = (c) => keys.has(c);
    if (k('ArrowLeft')) cam.yaw += lk; if (k('ArrowRight')) cam.yaw -= lk; if (k('ArrowUp')) cam.pitch += lk; if (k('ArrowDown')) cam.pitch -= lk;
    if (k('KeyW') || k('KeyS') || k('KeyA') || k('KeyD') || k('KeyQ') || k('KeyE')) {
      basis(); cam.p.addScaledVector(fwd, ((k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0)) * sp).addScaledVector(right, ((k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0)) * sp);
      cam.p.y += ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * sp;
    }
    place(); poseFrame(dt);
  }
  function basis() { e.set(cam.pitch, cam.yaw, 0, 'YXZ'); fwd.set(0, 0, -1).applyEuler(e); right.set(1, 0, 0).applyEuler(e); }
  function place() {
    cam.pitch = clamp(cam.pitch, -1.45, 1.45);
    // within RADIUS of where it started, and above the ground there
    tmp.copy(cam.p).sub(cam.home); if (tmp.length() > RADIUS) cam.p.copy(cam.home).addScaledVector(tmp, RADIUS / tmp.length());
    const g = game.ground(cam.p.x, -cam.p.z, cam.p.y), floor = g === null ? Math.min(cam.home.y, 0.5) : Math.min(g + 0.45, Math.max(cam.home.y, g + 0.45));
    if (cam.p.y < floor) cam.p.y = floor;
    camera.position.copy(cam.p); e.set(cam.pitch, cam.yaw, cam.roll, 'YXZ'); camera.quaternion.setFromEuler(e);
    // the viewer re-derives its fov when the clean view takes the interface's offset away: follow it until the lens is touched
    if (!lensTouched && camera.fov !== setFov && setFov) { cam.fov = camera.fov; cam.maxFov = Math.max(MAX_FOV, cam.fov); lens.value = sOf(clamp(cam.fov, MIN_FOV, cam.maxFov)); syncUI(); }
    if (camera.fov !== cam.fov) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
    setFov = camera.fov;
  }
  /* ── input: drag looks, two fingers (or right-drag) slide and pinch moves, wheel and keys move, a tap focuses ── */
  const sens = () => cam.fov * Math.PI / 180 / innerHeight;
  function slide(dx, dy) { basis(); tmp.set(0, 1, 0).applyEuler(e); const s = 0.03 * clamp(cam.fov / 52, 0.4, 1.4); cam.p.addScaledVector(right, -dx * s).addScaledVector(tmp, dy * s); }
  const move = (d) => { basis(); cam.p.addScaledVector(fwd, d); };
  pad.addEventListener('pointerdown', (ev) => { pad.setPointerCapture(ev.pointerId); ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY, t: performance.now(), moved: false, b: ev.button }); if (ptrs.size === 2) pinch = 0; ev.preventDefault(); });
  pad.addEventListener('pointermove', (ev) => {
    const p = ptrs.get(ev.pointerId); if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y; p.x = ev.clientX; p.y = ev.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > 7) p.moved = true;
    if (ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch) move((d - pinch) * 0.06); pinch = d; if (mid) slide(mx - mid[0], my - mid[1]); mid = [mx, my]; a.moved = b.moved = true;
    } else if (p.b === 2 || (ev.buttons & 2)) slide(dx, dy);
    else if (p.moved) { cam.yaw += dx * sens(); cam.pitch += dy * sens(); }
  });
  const up = (ev) => {
    const p = ptrs.get(ev.pointerId); ptrs.delete(ev.pointerId); if (ptrs.size < 2) { pinch = 0; mid = null; }
    if (p && !p.moved && ev.type === 'pointerup' && p.b === 0 && performance.now() - p.t < 450 && !ptrs.size) focusAt(p.x, p.y);
  };
  pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up); pad.addEventListener('contextmenu', (ev) => ev.preventDefault());
  pad.addEventListener('wheel', (ev) => { ev.preventDefault(); move(-clamp(ev.deltaY, -120, 120) * 0.04); }, { passive: false });
  function focusAt(x, y) {
    st.focus = [clamp(x / innerWidth, 0, 1), clamp(1 - y / innerHeight, 0, 1)];
    ring.style.left = x + 'px'; ring.style.top = y + 'px'; ring.classList.add('on'); clearTimeout(ringT); ringT = setTimeout(() => ring.classList.remove('on'), 700);
    if (st.aperture === 0 && canBlur()) { st.aperture = 0.35; blur.value = 35; syncUI(); syncPass(); }
  }
  // keys: everything is ours while photo mode is on; capture phase so the viewer's own shortcuts never see them
  addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || (/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName) && ev.target.type !== 'range')) return;
    if (active && ev.target.type === 'range' && /^Arrow|^Page|^Home$|^End$/.test(ev.code)) { ev.stopPropagation(); return; }     // the slider keeps its own arrows
    if (!lightbox.hidden && ev.code === 'Escape') { lightbox.hidden = true; ev.stopPropagation(); return; }
    if (!active) return;
    // immediate: Wick's own capture listener on window would otherwise still see the key (Esc after leave() took Walk
    // to Explore; Space and E were latched as a jump and a swing for when the camera came back)
    ev.stopImmediatePropagation();
    if (ev.code === 'Escape' || ev.code === 'KeyO') { if (!ev.repeat) leave(); ev.preventDefault(); return; }
    if ((ev.code === 'Space' || ev.code === 'Enter') && ev.target.tagName !== 'BUTTON') { if (!ev.repeat) shoot(); ev.preventDefault(); return; }
    if (/^(Key[WASDQE]|Arrow(Left|Right|Up|Down)|Shift(Left|Right))$/.test(ev.code)) { keys.add(ev.code); if (ev.code.startsWith('Arrow')) ev.preventDefault(); }
  }, true);
  addEventListener('keyup', (ev) => keys.delete(ev.code));
  addEventListener('blur', () => keys.clear());
  addEventListener('keydown', (ev) => {       // outside photo mode: O
    if (active || ev.code !== 'KeyO' || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) return;
    enter();
  });
  addEventListener('resize', () => { if (active) layoutCrop(); });

  /* ── Wick's pose: the platformer only animates inside its own update (which waits while the camera is held), so
     while a pose is chosen we run the animator ourselves each frame and hand the bones to the character ── */
  const POSES = [['Stand', 'pose'], ['Look around', 'lookAround'], ['Trim the lantern', 'idleTrim'], ['Warm hands', 'warmHands']];
  let poseI = -1;
  function unpose() { poseI = -1; $('#ph-pose').textContent = 'Pose'; }
  function poseFrame(dt) {
    const pf = game.platformer, a = pf && pf.animator, v = pf && pf.view; if (poseI < 0 || !a || !v || !v.pos || !pf.character) return;
    const fn = a.clips[POSES[poseI][1]], keep = a.clips.pose; if (!fn) return;
    a.clips.pose = (u, c) => fn((c.t * 0.12) % 1, c);               // the clip table is looked up by name: stand in for 'pose' for this one call
    try {
      const bones = a.update(dt, { id: -1, u: 0 }, { speed: 0, vy: 0, reduceMotion: game.reduceMotion }, { pos: v.pos, yaw: v.yaw, pitch: 0, roll: 0 });
      for (let i = 0; i < bones.length; i++) pf.character.bones[i].copy(bones[i]);
      pf.character.uniforms.uLantern.value.copy(a.st.lanternWorld);
    } finally { a.clips.pose = keep; }
  }
  $('#ph-pose').addEventListener('click', () => { poseI = (poseI + 1) % POSES.length; $('#ph-pose').textContent = POSES[poseI][0]; });

  /* ── saving ── */
  const pad2 = (n) => String(n).padStart(2, '0');
  function placeName() {
    const p = game.player;
    if (p.mode === 'walk' && game.ctx.nearestPlace) { const n = game.ctx.nearestPlace(); if (n) return n.name; }
    const r = Math.hypot(camera.position.x, camera.position.z), phi = Math.atan2(-camera.position.z, camera.position.x);
    if (r < 112) return 'The Spire'; let best = null, bd = 0.34;
    for (const q of game.places) if (q.land) { const d = Math.abs(((phi - q.land.phi + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (d < bd) { bd = d; best = q; } }
    return best ? best.name : 'Lanternfall';
  }
  function shoot() {
    if (!active || want) return; want = true;
    if (!game.reduceMotion) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
  }
  function afterRender() {                    // right after composer.render(): the drawing buffer is still readable
    if (!want) return; want = false;
    const c = renderer.domElement, r = layoutCrop(), sx = Math.round(r.x / r.vw * c.width), sy = Math.round(r.y / r.vh * c.height);
    const sw = Math.min(c.width - sx, Math.round(r.w / r.vw * c.width)), sh = Math.min(c.height - sy, Math.round(r.h / r.vh * c.height));
    const out = document.createElement('canvas'); out.width = sw; out.height = sh; out.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    const th = document.createElement('canvas'); th.width = 192; th.height = Math.max(1, Math.round(192 * sh / sw)); th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
    const thumb = th.toDataURL('image/jpeg', 0.72), place = placeName(), t = game.clock.fmt(), d = new Date();
    const name = `lanternfall-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.jpg`;   // seconds: two pictures in a minute must not share a name
    out.toBlob((blob) => { if (blob) deliver(blob, name, { thumb, place, t, w: sw, h: sh }); }, 'image/jpeg', 0.92);
  }
  async function deliver(blob, name, m) {
    const shot = { img: m.thumb, place: m.place, t: m.t, w: m.w, h: m.h, at: Date.now() };
    game.save.update('photo', (s) => ({ ...s, shots: [shot, ...(s.shots || [])].slice(0, KEEP) }), { shots: [] });
    api.last = { blob, name, ...m }; game.emit('photo:taken', { place: m.place, t: m.t });
    let shared = false, cancelled = false;
    try {
      const f = new File([blob], name, { type: 'image/jpeg' });
      if (game.coarse && navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'Lanternfall' }); shared = true; }
    } catch (err) { cancelled = !!err && err.name === 'AbortError'; }      // the visitor closed the share sheet: no download behind their back
    if (!shared && !cancelled) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    note.innerHTML = `<img alt="" src="${m.thumb}"><span>${shared ? 'Shared' : cancelled ? 'Not shared' : 'Saved'} · ${m.place} · ${m.t}</span>`; note.style.bottom = (innerHeight - bar.getBoundingClientRect().top + 10) + 'px';
    note.classList.add('on'); clearTimeout(noteT); noteT = setTimeout(() => note.classList.remove('on'), 3200);
    game.journal.refresh();
  }

  /* ── the top-bar button (desktop widths only: the phone bar is full) and the journal ── */
  const bh = document.getElementById('btn-hide');
  if (bh && bh.parentNode) {
    const b = el('button', 'btn-photo', 'icon-btn', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg>');
    b.type = 'button'; b.title = 'Take a photo (O)'; b.setAttribute('aria-label', 'Take a photo'); b.addEventListener('click', () => enter()); bh.parentNode.insertBefore(b, bh);
  }
  game.journal.section({ id: 'photo', title: 'Photographs', order: 90, render(box) {
    const shots = saved().shots || [];
    box.innerHTML = '<div class="gj-body"><p>Frame the park, then keep a picture of it.</p><button type="button" class="ph-take">Take a photo</button></div>';
    box.querySelector('.ph-take').addEventListener('click', () => enter());
    if (!shots.length) return;
    const g = el('div', '', 'ph-sheet'); box.appendChild(g);
    shots.forEach((s) => { const b = el('button'); b.type = 'button'; b.title = `${s.place} · ${s.t}`; b.setAttribute('aria-label', `Photograph: ${s.place}, ${s.t}`); b.innerHTML = `<img alt="" src="${s.img}">`;
      b.addEventListener('click', () => { lightbox.querySelector('img').src = s.img; lightbox.querySelector('span').textContent = `${s.place} · ${s.t}`; lightbox.hidden = false; }); g.appendChild(b); });
  } });

  const api = { enter, leave, get active() { return active; }, state: st, cam, last: null, shoot, get shots() { return saved().shots || []; }, get pass() { return passRef; }, cropRect: layoutCrop };
  return api;
}
