// The game layer: things to do in the park. This file is the shared core; each feature is a module in
// fx/game/<name>/index.js exporting `init(game)` (the list is MODULES below; '#no-<name>' skips one, '#no-game' all).
// The contract for modules is fx/game/API.md. Everything here speaks the Blender frame the walk code uses:
// x east, y north, z up, metres (three.js world = (x, z, -y)); game.v3() converts.
import { ACTION_NAMES } from '../platformer/actions.js';

export const MODULES = ['clock', 'daynight', 'lamps', 'bounty', 'secrets', 'trials', 'rides', 'photo'];
const STORE = 'lanternfall.game.v1';
const CSS = `
#game-track{position:fixed;z-index:5;left:max(16px,env(safe-area-inset-left,0px));top:calc(env(safe-area-inset-top,0px) + 62px);max-width:min(300px,calc(100vw - 32px));
  display:flex;flex-direction:column;gap:2px;align-items:flex-start;appearance:none;border:1px solid var(--line);border-radius:14px;padding:7px 12px 8px;background:var(--glass);
  color:var(--paper);font:500 12.5px/1.35 var(--ui);text-align:left;cursor:pointer;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);transition:opacity .35s ease}
#game-track[hidden]{display:none} #game-track b{font-weight:600;color:var(--amber);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase}
#game-track span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
#game-prompt{position:fixed;z-index:6;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 168px);appearance:none;border:1px solid rgba(255,181,71,.7);
  border-radius:999px;padding:11px 20px;background:rgba(13,11,38,.72);color:var(--paper);font:600 14px var(--ui);cursor:pointer;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  touch-action:manipulation;-webkit-user-select:none;user-select:none;max-width:calc(100vw - 32px)}
#game-prompt[hidden]{display:none} #game-prompt kbd{font:600 11px var(--ui);border:1px solid var(--line);border-radius:5px;padding:1px 5px;margin-left:8px;opacity:.8}
@media (pointer:coarse){ #game-prompt kbd{display:none} #game-prompt{bottom:calc(env(safe-area-inset-bottom,0px) + 330px)} }
@media (max-width:640px){ #game-track{top:calc(env(safe-area-inset-top,0px) + 110px)} #game-toasts{top:calc(env(safe-area-inset-top,0px) + 170px)} #game-journal{top:calc(env(safe-area-inset-top,0px) + 110px)} }
#game-toasts{position:fixed;z-index:7;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 112px);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:min(420px,calc(100vw - 32px))}
.game-toast{padding:9px 16px;border-radius:14px;background:rgba(13,11,38,.8);border:1px solid var(--line);color:var(--paper);font:500 14px/1.35 var(--ui);text-align:center;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:game-toast-in .35s ease both}
.game-toast.good{border-color:rgba(255,181,71,.7)} .game-toast b{color:var(--amber)} .game-toast.out{opacity:0;transition:opacity .5s ease}
@keyframes game-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
#game-journal{left:max(16px,env(safe-area-inset-left,0px));right:auto;width:min(360px,calc(100vw - 32px))}
#game-journal .gj-sec{border-top:1px solid var(--line);padding:10px 0 8px} #game-journal .gj-sec:first-of-type{border-top:0}
#game-journal .gj-sec h3{margin:0 0 6px;font:600 10.5px var(--ui);letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
#game-journal .gj-body{font:400 13.5px/1.45 var(--ui);color:var(--paper)} #game-journal .gj-body p{margin:0 0 6px} #game-journal .gj-empty{opacity:.6;font:400 13px var(--ui)}
#game-journal .gj-reset{margin-top:10px;appearance:none;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--paper);opacity:.7;font:500 12px var(--ui);padding:6px 12px;cursor:pointer}
body.clean #game-track,body.clean #game-prompt,body.clean #game-toasts{opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){ .game-toast{animation:none} }
`;

export function createGame(ctx) {
  const { THREE, scene, camera, walk } = ctx;
  const hash = new Set(location.hash.slice(1).split(/[&,+]/));
  const off = hash.has('no-game');
  /* ── saved state: one JSON object, one key per module ── */
  let data = {}; try { data = JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { data = {}; }
  let dirty = 0;
  const flush = () => { dirty = 0; try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (e) { /* private mode: this visit only */ } };
  const save = {
    get: (k, d) => (k in data ? data[k] : d),
    set(k, v) { data[k] = v; if (!dirty) dirty = setTimeout(flush, 400); return v; },
    update(k, fn, d) { return save.set(k, fn(save.get(k, d))); },
    reset() { data = {}; flush(); },
  };
  /* ── events ── */
  const subs = new Map();
  const on = (type, fn) => { if (!subs.has(type)) subs.set(type, new Set()); subs.get(type).add(fn); return () => subs.get(type).delete(fn); };
  const emit = (type, d) => { const s = subs.get(type); if (s) for (const fn of [...s]) { try { fn(d); } catch (e) { console.warn('game:', type, e); } } };

  /* ── DOM: tracker pill (opens the journal), prompt button, toasts, journal sheet ── */
  const el = (tag, id, cls) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; return e; };
  const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
  const trackEl = el('button', 'game-track'); trackEl.type = 'button'; trackEl.hidden = true; trackEl.title = 'Journal (B)'; trackEl.setAttribute('aria-label', 'Open the journal');
  const promptEl = el('button', 'game-prompt'); promptEl.type = 'button'; promptEl.hidden = true;
  const toastsEl = el('div', 'game-toasts'); toastsEl.setAttribute('aria-live', 'polite');
  const journalEl = el('div', 'game-journal', 'sheet'); journalEl.hidden = true; journalEl.setAttribute('role', 'dialog'); journalEl.setAttribute('aria-label', 'Journal');
  journalEl.innerHTML = '<div class="sheet-head"><h2>Journal</h2><button type="button" class="sheet-close" aria-label="Close the journal">&times;</button></div><div class="gj-list"></div><button type="button" class="gj-reset">Start over</button>';
  if (!off) document.body.append(trackEl, promptEl, toastsEl, journalEl);
  function toast(text, { ms = 4200, tone = '' } = {}) {
    const t = el('div', null, 'game-toast' + (tone ? ' ' + tone : '')); t.innerHTML = text; toastsEl.appendChild(t);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 600); }, ms);
  }
  // tracker: up to three short lines, lowest `order` first; a line is { text, order }
  const lines = new Map();
  function track(id, text, { order = 50 } = {}) {
    if (text == null || text === '') lines.delete(id); else lines.set(id, { text, order });
    const list = [...lines.values()].sort((a, b) => a.order - b.order).slice(0, 3);
    trackEl.innerHTML = '<b>Journal</b>' + list.map((l) => `<span>${l.text}</span>`).join('');
    trackEl.hidden = !started || (!list.length && !sections.size);
  }
  // journal: modules add sections; render(el) is called whenever the journal opens or journal.refresh() runs
  const sections = new Map();
  const journal = {
    section(s) { sections.set(s.id, { order: 50, ...s }); track('', null); if (!journalEl.hidden) journal.refresh(); },
    refresh() {
      if (journalEl.hidden) return;
      const list = journalEl.querySelector('.gj-list'); list.textContent = '';
      for (const s of [...sections.values()].sort((a, b) => a.order - b.order)) {
        const sec = el('div', null, 'gj-sec'), h = el('h3'), body = el('div', null, 'gj-body'); h.textContent = s.title; sec.append(h, body); list.appendChild(sec);
        try { s.render(body); } catch (e) { console.warn('game: journal', s.id, e); }
      }
      if (!sections.size) list.innerHTML = '<p class="gj-empty">Nothing yet. Walk the park.</p>';
    },
    open() { journalEl.hidden = false; journal.refresh(); emit('journal', { open: true }); },
    close() { journalEl.hidden = true; emit('journal', { open: false }); },
    get isOpen() { return !journalEl.hidden; },
  };
  trackEl.addEventListener('click', () => (journal.isOpen ? journal.close() : journal.open()));
  journalEl.querySelector('.sheet-close').addEventListener('click', journal.close);
  journalEl.querySelector('.gj-reset').addEventListener('click', () => { if (journalEl.querySelector('.gj-reset').dataset.sure) { save.reset(); location.reload(); } else { const b = journalEl.querySelector('.gj-reset'); b.dataset.sure = '1'; b.textContent = 'Erase all progress? Tap again'; } });

  /* ── the player, read once per frame ── */
  const player = { x: 0, y: 0, z: 0, yaw: 0, mode: 'tour', wick: false, action: '', speed: 0, land: null, three: new THREE.Vector3() };
  const v3 = (x, y, z = 0, out = new THREE.Vector3()) => out.set(x, z, -y);
  const nav = () => ctx.getNav();
  function ground(x, y, zRef) {            // walk-grid height at (x, y): the level nearest zRef (default: the lower), or null off the grid
    const n = nav(); if (!n) return null;
    const i = Math.floor((x - n.x0) / n.cell), j = Math.floor((y - n.y0) / n.cell); if (i < 0 || j < 0 || i >= n.w || j >= n.h) return null;
    const k = j * n.w + i, a = n.A[k], b = n.B[k], ha = a ? (a - 1) / 100 - 2 : null, hb = b ? (b - 1) / 100 - 2 : null;
    if (ha === null) return hb; if (hb === null || zRef === undefined) return ha;
    return Math.abs(hb - zRef) < Math.abs(ha - zRef) ? hb : ha;
  }
  // baked light (linear rgb irradiance, moon excluded) arriving at the ground at (x, y); null until the guests' light grid is in
  function lightAt(x, y) {
    const g = ctx.getGuests(), L = g && g.light; if (!L || !L.data) return null;
    const i = Math.min(L.w - 1, Math.max(0, Math.floor((x - L.x0) / L.cell))), j = Math.min(L.h - 1, Math.max(0, Math.floor((y - L.y0) / L.cell))), o = (j * L.w + i) * 4, d = L.data, m = d[o + 3] / 255 * L.range / 255;
    return [d[o] * m, d[o + 1] * m, d[o + 2] * m];
  }

  /* ── interactables ── */
  const inter = new Set(); let near = null;
  function interact(o) {
    const it = { r: 2.2, swing: true, enabled: true, z: 0, ...o };
    it.remove = () => { inter.delete(it); if (near === it) { near = null; promptEl.hidden = true; } };
    it.move = (x, y, z = it.z) => { it.x = x; it.y = y; it.z = z; };
    inter.add(it); return it;
  }
  const dist = (it) => Math.hypot(it.x - player.x, it.y - player.y, (it.z - player.z) * 0.6);
  const usable = (it) => it.enabled && (!it.show || it.show());
  function findNear(extra = 0) {
    let best = null, bd = Infinity;
    for (const it of inter) { if (!usable(it)) continue; const d = dist(it); if (d < it.r + extra && d < bd) { bd = d; best = it; } }
    return best;
  }
  function use(it = near) { if (!it || !usable(it)) return false; try { it.use(it); } catch (e) { console.warn('game: use', it.id, e); } emit('use', { id: it.id }); return true; }
  promptEl.addEventListener('click', () => use());
  addEventListener('keydown', (e) => {
    if (off || e.ctrlKey || e.metaKey || e.altKey || e.repeat || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'KeyB') { journal.isOpen ? journal.close() : journal.open(); return; }
    if ((e.code === 'KeyE' || (e.code === 'Enter' && e.target.tagName !== 'BUTTON')) && player.mode === 'walk' && !player.wick && near) { e.preventDefault(); use(); }
  });

  /* ── props: small things added to the scene at run time (the park itself is baked) ── */
  let glowTex = null;
  const props = {
    // a soft additive light: { x, y, z, color: [r,g,b] linear (may exceed 1 to bloom), size (m) } -> { sprite, set({..}), remove() }
    glow(o) {
      if (!glowTex) { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); glowTex = new THREE.CanvasTexture(c); }
      const m = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
      const s = new THREE.Sprite(m); s.renderOrder = 8;
      const h = { sprite: s, set(p) { if (p.color) m.color.setRGB(p.color[0], p.color[1], p.color[2]); if (p.size) s.scale.setScalar(p.size); if (p.x !== undefined) v3(p.x, p.y, p.z ?? 0, s.position); if (p.visible !== undefined) s.visible = p.visible; return h; }, remove() { scene.remove(s); m.dispose(); } };
      h.set({ color: [1, 0.7, 0.35], size: 1, ...o }); scene.add(s); return h;
    },
    // a mesh in the park: geometry in three.js axes (y up), placed at Blender (x, y, z), turned by yaw about the vertical.
    // color: linear albedo; it is lit once by the baked light at its spot (lit: false or emissive: [r,g,b] for things that glow)
    mesh(geometry, { x = 0, y = 0, z = 0, yaw = 0, color = [0.5, 0.5, 0.5], emissive = null, lit = true, scale = 1 } = {}) {
      const L = lit && !emissive ? lightAt(x, y) : null, k = L ? [L[0] + 0.02, L[1] + 0.022, L[2] + 0.035] : lit && !emissive ? [0.3, 0.24, 0.18] : [1, 1, 1], c = emissive || [color[0] * k[0], color[1] * k[1], color[2] * k[2]];
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(c[0], c[1], c[2]), fog: false });
      const o = new THREE.Mesh(geometry, m); v3(x, y, z, o.position); o.rotation.y = yaw; o.scale.setScalar(scale); scene.add(o);
      o.userData.remove = () => { scene.remove(o); m.dispose(); };
      return o;
    },
  };

  /* ── the clock: minutes since midnight. It stands at 23:00 (the fall) until a module runs it (fx/game/clock/) ── */
  const clock = {
    t: 23 * 60, running: false, rate: 1,                          // rate: park minutes per real second
    set(t) { const prev = clock.t; clock.t = ((t % 1440) + 1440) % 1440; emit('clock', { t: clock.t, prev, jump: true }); },
    fmt: (t = clock.t) => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(Math.floor(t % 60)).padStart(2, '0'),
    // fn() when the clock passes hh:mm going forward (also on a set() that lands within 1 minute after it)
    at(hhmm, fn) { const [h, m] = hhmm.split(':').map(Number), T = h * 60 + m; return on('clock', ({ t, prev, jump }) => { if (jump ? t >= T && t < T + 1 : prev < T && t >= T) fn(); }); },
  };

  /* ── per frame ── */
  let started = false, lastAction = '', lastWeather = '', landT = 0, promptKey = '';
  function frame(dt, time) {
    if (off || !started) return;
    const mode = ctx.getMode(), pf = ctx.getPlatformer(), wick = !!(pf && pf.active);
    if (mode !== player.mode || wick !== player.wick) { player.mode = mode; player.wick = wick; emit('mode', { mode, wick }); }
    const px = player.x, py = player.y;
    if (mode === 'walk') {
      player.x = walk.x; player.y = walk.y; player.yaw = walk.yaw;
      player.z = wick && pf.view ? pf.view.pos.y : walk.z + (walk.hop || 0);
    } else { player.x = camera.position.x; player.y = -camera.position.z; player.z = camera.position.y; }
    player.speed = dt > 0 ? Math.hypot(player.x - px, player.y - py) / dt : 0; v3(player.x, player.y, player.z, player.three);
    // Wick's action, by name (fx/platformer/actions.js): 'punching', 'ground pound land', 'wall kick air', 'sleeping', ...
    const act = wick && pf.view && pf.view.s ? ACTION_NAMES[pf.view.s.action] || '' : '';
    if (act !== lastAction) {
      const prev = lastAction; lastAction = player.action = act; emit('action', { name: act, prev });
      if (act === 'punching' || act === 'move punching' || act === 'jump kick') { emit('swing', { x: player.x, y: player.y, z: player.z }); const it = findNear(0.9); if (it && it.swing) use(it); }
      if (act === 'ground pound land') emit('pound', { x: player.x, y: player.y, z: player.z });
    }
    // which land the visitor is in (app.js nearestPlace(): a place id such as 'meridian', 'spire', 'gate', or null)
    if ((landT -= dt) < 0) { landT = 0.5; const p = mode === 'walk' ? ctx.nearestPlace() : null, id = p ? p.id : null; if (id !== player.land) { const prev = player.land; player.land = id; emit('land', { id, prev }); } }
    const w = ctx.weather ? ctx.weather.state : 'clear'; if (w !== lastWeather) { const prev = lastWeather; lastWeather = w; emit('weather', { state: w, prev }); }
    if (clock.running) { const prev = clock.t; clock.t = (clock.t + dt * clock.rate) % 1440; emit('clock', { t: clock.t, prev: prev > clock.t ? prev - 1440 : prev, jump: false }); }
    // the prompt: the nearest thing that can be used, in Walk mode only
    near = mode === 'walk' ? findNear() : null;
    const key = near ? (wick ? 'w' : 'f') + near.id + '|' + (typeof near.label === 'function' ? near.label() : near.label) : '';
    if (key !== promptKey) { promptKey = key; promptEl.hidden = !near; if (near) promptEl.innerHTML = key.slice(key.indexOf('|') + 1) + (wick ? '' : '<kbd>E</kbd>'); }
    emit('frame', { dt, time });
  }

  /* ── the camera, on loan: while a module holds it, fn(dt) places the camera each frame and the mode's own update
     (tour, orbit, the walker, Wick) does not run. One holder at a time; taking it again replaces the holder ── */
  let driver = null;
  function takeCamera(fn, { name = '' } = {}) {
    if (driver) { const old = driver; driver = null; emit('camera', { held: false, by: old.name, why: 'replaced' }); }      // the old holder hears it lost the camera
    const d = { fn, name }; driver = d; emit('camera', { held: true, by: name });
    return (why) => { if (driver === d) { driver = null; emit('camera', { held: false, by: name, why }); } };
  }
  function drive(dt) { if (!driver) return false; try { driver.fn(dt); } catch (e) { console.warn('game: camera', driver.name, e); driver = null; return false; } return true; }

  const game = {
    THREE, scene, camera, renderer: ctx.renderer, Q: ctx.Q, uTime: ctx.uTime, mobile: ctx.mobile, coarse: ctx.coarse, hash, ctx,
    get manifest() { return ctx.getManifest(); }, places: ctx.places, get nav() { return nav(); }, get guests() { return ctx.getGuests(); }, get platformer() { return ctx.getPlatformer(); },
    get weather() { return ctx.weather; }, get reduceMotion() { return ctx.reduceMotion(); },
    save, on, emit, player, v3, ground, lightAt, interact, use, toast, track, journal, props, clock, frame,
    takeCamera, drive, get cameraHeld() { return driver ? driver.name || true : false; },
    sound: (name, pos) => ctx.sound.play(name, pos),
    setMode: ctx.setMode, teleport: (x, y, yaw) => ctx.setMode('walk', { at: [x, y], yaw }),
    modules: {}, get started() { return started; },
    // app.js calls this once the park can be walked: loads the modules, then 'start' fires
    async start() {
      if (off || started) return; started = true;
      await Promise.all(MODULES.filter((n) => !hash.has('no-' + n)).map((n) => import(`./${n}/index.js`).then((m) => { if (m.init) game.modules[n] = m.init(game) || true; }).catch((e) => console.warn('game: module', n, e))));
      track('', null); emit('start', {});
    },
  };
  return game;
}
