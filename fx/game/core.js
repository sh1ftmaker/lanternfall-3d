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
#game-toasts{position:fixed;z-index:7;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 112px);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:min(420px,calc(100vw - 32px))}
.game-toast{padding:9px 16px;border-radius:14px;background:rgba(13,11,38,.8);border:1px solid var(--line);color:var(--paper);font:500 14px/1.35 var(--ui);text-align:center;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:game-toast-in .35s ease both}
.game-toast.good{border-color:rgba(255,181,71,.7)} .game-toast b{color:var(--amber)} .game-toast.out{opacity:0;transition:opacity .5s ease}
@keyframes game-toast-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
#game-journal{left:max(16px,env(safe-area-inset-left,0px));right:auto;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
#game-journal{max-height:calc(100dvh - 64px - 104px - env(safe-area-inset-top,0px))}   /* desktop: ends above the mode buttons and the places row */
#game-journal .gj-chips{position:sticky;top:-14px;z-index:1;display:flex;gap:6px;overflow-x:auto;margin:0 -16px 2px;padding:7px 16px;background:rgba(13,11,38,.97);scrollbar-width:none;border-bottom:1px solid var(--line)}
#game-journal .gj-chips::-webkit-scrollbar{display:none} #game-journal .gj-chips[hidden]{display:none}
#game-journal .gj-chips [role=button]{flex:none;appearance:none;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--paper);font:600 11px var(--ui);letter-spacing:.06em;padding:5px 11px;cursor:pointer;white-space:nowrap;touch-action:manipulation;user-select:none}
#game-journal .gj-chips [role=button]:hover,#game-journal .gj-chips [role=button]:focus-visible{border-color:rgba(255,181,71,.7);color:var(--amber)}
#game-journal .gj-sec{scroll-margin-top:44px}
#game-journal .gj-sec{border-top:1px solid var(--line);padding:10px 0 8px} #game-journal .gj-sec:first-of-type{border-top:0}
#game-journal .gj-sec h3{margin:0 0 6px;font:600 10.5px var(--ui);letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
#game-journal .gj-body{font:400 13.5px/1.45 var(--ui);color:var(--paper)} #game-journal .gj-body p{margin:0 0 6px} #game-journal .gj-empty{opacity:.6;font:400 13px var(--ui)}
#game-journal .gj-reset{margin-top:10px;appearance:none;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--paper);opacity:.7;font:500 12px var(--ui);padding:6px 12px;cursor:pointer}
/* phones: after the rules above, or they lose (the toasts sat over the tracker pill); toasts start below a three-line pill */
@media (max-width:640px){ #game-track{top:calc(env(safe-area-inset-top,0px) + 110px)} #game-toasts{top:calc(env(safe-area-inset-top,0px) + 200px)} #game-journal{top:calc(env(safe-area-inset-top,0px) + 110px);max-height:calc(100dvh - 126px - env(safe-area-inset-top,0px))} }
body.clean #game-track,body.clean #game-prompt,body.clean #game-toasts{opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){ .game-toast{animation:none} }
`;

export function createGame(ctx) {
  const { THREE, scene, camera, walk } = ctx;
  const hash = new Set(location.hash.slice(1).split(/[&,+]/));
  const off = hash.has('no-game');
  /* ── saved state: one JSON object, one key per module. A write merges this tab's changed keys into what is stored (another
     tab may have saved its own keys meanwhile); a changed key that does not fit keeps its last stored value (and lasts this
     visit only) rather than costing everyone's progress; a blob that will not parse is kept aside under STORE + '.bad' ── */
  let badRaw = null;
  const read = () => {
    let raw = null; try { raw = localStorage.getItem(STORE); } catch (e) { return {}; }
    if (raw == null) return {};
    try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { /* below */ }
    if (raw !== badRaw) { badRaw = raw; try { localStorage.setItem(STORE + '.bad', raw); } catch (e) { /* no room: it is lost */ } console.warn('game: saved progress could not be read; kept aside as', STORE + '.bad'); }
    return {};
  };
  let data = read(), dirty = 0; const changed = new Set(), unsaved = new Set();
  function flush() {
    clearTimeout(dirty); dirty = 0; if (!changed.size) return;
    const stored = read(), out = { ...stored }, keys = [...changed]; changed.clear();
    for (const k of keys) { if (data[k] === undefined) delete out[k]; else out[k] = data[k]; }
    for (;;) {
      try { localStorage.setItem(STORE, JSON.stringify(out)); for (const k of keys) unsaved.delete(k); break; } catch (e) {
        if (!/quota/i.test(e.name + ' ' + e.message)) break;                       // storage off (private mode): this visit only
        let big = null, bs = -1; for (const k of keys) { if (out[k] === stored[k]) continue; const n = JSON.stringify(out[k] ?? null).length; if (n > bs) { bs = n; big = k; } }
        if (big === null) break;
        if (big in stored) out[big] = stored[big]; else delete out[big];             // the last value that fitted
        if (!unsaved.has(big)) { unsaved.add(big); console.warn('game: no room to save', big, '(' + bs + ' characters); it lasts this visit only'); }
      }
    }
    for (const k in stored) if (!changed.has(k) && !unsaved.has(k) && !keys.includes(k)) data[k] = stored[k];   // another tab's keys
  }
  const save = {
    get: (k, d) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d),
    set(k, v) { data[k] = v; changed.add(k); if (!dirty) dirty = setTimeout(flush, 400); return v; },
    update(k, fn, d) { return save.set(k, fn(save.get(k, d))); },
    flush,
    reset() { data = {}; changed.clear(); unsaved.clear(); clearTimeout(dirty); dirty = 0; try { localStorage.removeItem(STORE); } catch (e) { /* nothing stored */ } },
    get size() { try { return (localStorage.getItem(STORE) || '').length; } catch (e) { return 0; } },
  };
  addEventListener('pagehide', flush); document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  /* ── events ── */
  const subs = new Map();
  const on = (type, fn) => { if (!subs.has(type)) subs.set(type, new Set()); subs.get(type).add(fn); return () => subs.get(type).delete(fn); };
  // a listener that throws is reported once; one that throws 30 times within ten seconds (a 'frame' listener failing every
  // frame) is switched off so it cannot flood the console or cost every frame
  const bad = new WeakMap();
  function fail(what, fn, e, s) {
    const now = performance.now(), b = bad.get(fn) || { n: 0, t0: now }; if (now - b.t0 > 10000) { b.n = 0; b.t0 = now; } b.n++; bad.set(fn, b);
    if (b.n === 1) console.warn('game:', what, e);
    if (b.n >= 30 && s) { s.delete(fn); console.warn('game: a', what, 'listener kept failing and was switched off', e); }
  }
  const emit = (type, d) => { const s = subs.get(type); if (s) for (const fn of s) { try { fn(d); } catch (e) { fail(type, fn, e, s); } } };   // (a Set may lose members while it is walked)

  /* ── DOM: tracker pill (opens the journal), prompt button, toasts, journal sheet ── */
  const el = (tag, id, cls) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; return e; };
  const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
  const trackEl = el('button', 'game-track'); trackEl.type = 'button'; trackEl.hidden = true; trackEl.title = 'Journal (B)'; trackEl.setAttribute('aria-label', 'Open the journal');
  const promptEl = el('button', 'game-prompt'); promptEl.type = 'button'; promptEl.hidden = true;
  const toastsEl = el('div', 'game-toasts'); toastsEl.setAttribute('aria-live', 'polite');
  const journalEl = el('div', 'game-journal', 'sheet'); journalEl.hidden = true; journalEl.setAttribute('role', 'dialog'); journalEl.setAttribute('aria-label', 'Journal');
  journalEl.innerHTML = '<div class="sheet-head"><h2>Journal</h2><button type="button" class="sheet-close" aria-label="Close the journal">&times;</button></div><div class="gj-chips" role="group" aria-label="Sections" hidden></div><div class="gj-list"></div><button type="button" class="gj-reset">Start over</button>';
  if (!off) document.body.append(trackEl, promptEl, toastsEl, journalEl);
  // anything typed by the visitor or read back from storage goes in with esc(), as text: { text } or a Node
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fill = (e, v) => { if (v instanceof Node) e.replaceChildren(v); else if (v && typeof v === 'object' && 'text' in v) e.textContent = v.text; else e.innerHTML = v; };
  // toasts: three at most on screen; more wait their turn (a burst from several modules used to push the first ones out
  // unseen), and while some wait, each one up is cut to 2 s on screen
  const shown = [], waiting = [];
  function toast(text, { ms = 4200, tone = '' } = {}) {
    const t = el('div', null, 'game-toast' + (tone ? ' ' + tone : '')); fill(t, text); if (ctx.reduceMotion && ctx.reduceMotion()) t.style.animation = 'none';   // the in-app setting, not only the system one
    waiting.push({ t, ms }); pump(); return t;
  }
  function pump() {
    while (shown.length < 3 && waiting.length) {
      const w = waiting.shift(); toastsEl.appendChild(w.t); w.at = performance.now(); w.timer = setTimeout(() => hideToast(w), w.ms); shown.push(w);
    }
    if (waiting.length) for (const w of shown) { const left = 2000 - (performance.now() - w.at); if (left < w.ms) { clearTimeout(w.timer); w.ms = Math.max(0, left); w.timer = setTimeout(() => hideToast(w), w.ms); } }
  }
  function hideToast(w) {
    if (w.gone) return; w.gone = true; w.t.classList.add('out');
    setTimeout(() => { w.t.remove(); const i = shown.indexOf(w); if (i >= 0) shown.splice(i, 1); pump(); }, 600);
  }
  // tracker: up to three short lines, lowest `order` first. A line shows at least 2 s before it can go (several modules
  // changing their lines at once used to make the pill flicker), and a line whose text has not changed is left alone
  const lines = new Map(), spans = new Map(), MIN_SHOW = 2000;
  const keyOf = (v) => (v && typeof v === 'object' && 'text' in v ? 't:' + v.text : typeof v === 'string' ? 's:' + v : v);
  const head = el('b'); head.textContent = 'Journal'; trackEl.appendChild(head);
  function drawTrack() {
    const list = [...lines.entries()].sort((a, b) => a[1].order - b[1].order).slice(0, 3), want = new Set();
    for (const [id, l] of list) {
      want.add(id); let sp = spans.get(id);
      if (!sp) { sp = el('span'); spans.set(id, sp); sp.k = undefined; }
      if (sp.k !== l.k) { fill(sp, l.v); sp.k = l.k; }
    }
    for (const [id, sp] of spans) if (!want.has(id)) { sp.remove(); spans.delete(id); }
    let prev = head; for (const [id] of list) { const sp = spans.get(id); if (sp.previousSibling !== prev) prev.after(sp); prev = sp; }
    trackEl.hidden = !started || (!list.length && (!sections.size || player.mode === 'tour'));   // Tour keeps today's first look: no empty pill
  }
  function track(id, text, { order = 50 } = {}) {
    const now = performance.now(), l = lines.get(id);
    if (text == null || text === '') {
      if (!l) return drawTrack();
      const wait = l.at + MIN_SHOW - now;
      if (wait > 0) { if (!l.gone) { l.gone = true; l.timer = setTimeout(() => { if (lines.get(id) === l && l.gone) { lines.delete(id); drawTrack(); } }, wait); } return; }
      clearTimeout(l.timer); lines.delete(id); return drawTrack();
    }
    if (l) { l.gone = false; clearTimeout(l.timer); l.v = text; l.k = keyOf(text); l.order = order; }
    else lines.set(id, { v: text, k: keyOf(text), order, at: now, gone: false, timer: 0 });
    drawTrack();
  }
  // journal: modules add sections; render(el) is called whenever the journal opens or journal.refresh() runs
  const sections = new Map(); let lastScroll = 0;      // the sheet's scroll position, kept while it is closed
  const journal = {
    section(s) { sections.set(s.id, { order: 50, ...s }); track('', null); if (!journalEl.hidden) journal.refresh(); },
    refresh() {
      if (journalEl.hidden) return;
      const list = journalEl.querySelector('.gj-list'), chips = journalEl.querySelector('.gj-chips'), keep = journalEl.scrollTop; list.textContent = ''; chips.textContent = '';
      for (const s of [...sections.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {   // equal orders: by id, not by which module happened to load first
        const sec = el('div', null, 'gj-sec'), h = el('h3'), body = el('div', null, 'gj-body'); h.textContent = s.title; sec.append(h, body); list.appendChild(sec);
        const chip = el('span'); chip.setAttribute('role', 'button'); chip.tabIndex = 0; chip.textContent = String(s.title); chip.addEventListener('click', () => sec.scrollIntoView({ block: 'start', behavior: ctx.reduceMotion && ctx.reduceMotion() ? 'auto' : 'smooth' })); chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); } }); chips.appendChild(chip);   // spans, not buttons: tests find the journal's own buttons by text

        try { s.render(body); } catch (e) { console.warn('game: journal', s.id, e); }
      }
      if (!sections.size) list.innerHTML = '<p class="gj-empty">Nothing yet. Walk the park.</p>';
      chips.hidden = sections.size < 2; journalEl.scrollTop = keep;     // a refresh keeps the place in the sheet
    },
    open() { const st = ctx.getSettings && ctx.getSettings(); if (st && st.open) st.close(); journalEl.hidden = false; journalEl.scrollTop = lastScroll; journal.refresh(); emit('journal', { open: true }); },   // one sheet at a time
    close() { if (!journalEl.hidden) lastScroll = journalEl.scrollTop; journalEl.hidden = true; emit('journal', { open: false }); },
    get isOpen() { return !journalEl.hidden; },
  };
  trackEl.addEventListener('click', () => (journal.isOpen ? journal.close() : journal.open()));
  const setBtn = document.getElementById('btn-set'); if (setBtn) setBtn.addEventListener('click', () => { if (journal.isOpen) journal.close(); }, true);
  const modesEl = document.querySelector('.modes'); if (modesEl) modesEl.addEventListener('click', () => { if (journal.isOpen && matchMedia('(max-width:640px)').matches) journal.close(); }, true);   // on a phone the sheet covers the buttons
  journalEl.querySelector('.sheet-close').addEventListener('click', journal.close);
  journalEl.querySelector('.gj-reset').addEventListener('click', () => { if (journalEl.querySelector('.gj-reset').dataset.sure) { save.reset(); location.reload(); } else { const b = journalEl.querySelector('.gj-reset'); b.dataset.sure = '1'; b.textContent = 'Erase all progress? Tap again'; } });

  /* ── the first walk: one toast that says there are things to do (once, saved) ── */
  let hello = 0;
  on('mode', ({ mode }) => {
    clearTimeout(hello); const c = save.get('core'); if (mode !== 'walk' || (c && typeof c === 'object' && c.welcomed === true)) return;
    hello = setTimeout(() => {
      if (player.mode !== 'walk' || journal.isOpen) return; const c2 = save.get('core');
      save.set('core', { ...(c2 && typeof c2 === 'object' ? c2 : {}), welcomed: true });
      toast(ctx.coarse ? 'There are things to do in the park. Tap <b>Journal</b>, top left, to see them.' : 'There are things to do in the park. Press <b>B</b> to open the journal.', { ms: 7000 });
    }, 2500);
  });

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
  const inter = []; let near = null;          // an array: walked every frame without an iterator
  function interact(o) {
    const it = { r: 2.2, swing: true, enabled: true, z: 0, ...o }; if (!Number.isFinite(it.priority)) it.priority = 0;   // priority: the highest in reach wins, the nearest among equals
    it.remove = () => { const i = inter.indexOf(it); if (i >= 0) inter.splice(i, 1); if (near === it) { near = null; promptEl.hidden = true; promptKey.it = null; } };
    it.move = (x, y, z = it.z) => { it.x = x; it.y = y; it.z = z; };
    inter.push(it); return it;
  }
  const usable = (it) => { if (!it.enabled) return false; if (!it.show) return true; try { return !!it.show(); } catch (e) { fail('interact show ' + it.id, it.show, e); return false; } };
  const labelOf = (it) => { try { return String((typeof it.label === 'function' ? it.label() : it.label) ?? ''); } catch (e) { it.enabled = false; console.warn('game: interact', it.id, 'label failed; switched off', e); return ''; } };
  function findNear(extra = 0, swing = false) {     // swing: only what the pole can use (a swing passes over a swing: false thing)
    let best = null, bd = Infinity, bp = -Infinity;
    const px = player.x, py = player.y, pz = player.z;
    for (let i = 0; i < inter.length; i++) {      // squared distances, inline: this runs every frame over every interactable
      const it = inter[i]; if (swing && !it.swing) continue;
      const dx = it.x - px, dy = it.y - py, dz = (it.z - pz) * 0.6, d = dx * dx + dy * dy + dz * dz, r = it.r + extra;
      if (d < r * r && (it.priority > bp || (it.priority === bp && d < bd)) && usable(it)) { bd = d; bp = it.priority; best = it; }     // show() only for those in reach
    }
    return best;
  }
  function use(it = near) { if (!it || !inter.includes(it) || !usable(it)) return false; try { it.use(it); } catch (e) { console.warn('game: use', it.id, e); } emit('use', { id: it.id }); return true; }
  const kbdE = el('kbd'); kbdE.textContent = 'E';
  promptEl.addEventListener('click', () => use());
  addEventListener('keydown', (e) => {
    if (off || e.ctrlKey || e.metaKey || e.altKey || e.repeat || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'KeyB') { journal.isOpen ? journal.close() : journal.open(); return; }
    if ((e.code === 'KeyE' || (e.code === 'Enter' && e.target.tagName !== 'BUTTON')) && player.mode === 'walk' && !player.wick && near) { e.preventDefault(); use(); }
  });

  /* ── props: small things added to the scene at run time (the park itself is baked) ── */
  let glowTex = null;
  const materials = new Set();   // every material props.glow / props.mesh made and not yet removed (daynight lights them); 'prop' fires as each is made
  const made = (material, kind) => { materials.add(material); emit('prop', { material, kind }); return material; };
  const props = {
    materials,
    // a soft additive light: { x, y, z, color: [r,g,b] linear (may exceed 1 to bloom), size (m) } -> { sprite, set({..}), remove() }
    glow(o) {
      if (!glowTex) { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); glowTex = new THREE.CanvasTexture(c); }
      const m = made(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }), 'glow');
      const s = new THREE.Sprite(m); s.renderOrder = 8;
      const h = { sprite: s, set(p) { if (p.color) m.color.setRGB(p.color[0], p.color[1], p.color[2]); if (p.size) s.scale.setScalar(p.size); if (p.x !== undefined) v3(p.x, p.y, p.z ?? 0, s.position); if (p.visible !== undefined) s.visible = p.visible; return h; }, remove() { scene.remove(s); materials.delete(m); m.dispose(); } };
      h.set({ color: [1, 0.7, 0.35], size: 1, ...o }); scene.add(s); return h;
    },
    // a mesh in the park: geometry in three.js axes (y up), placed at Blender (x, y, z), turned by yaw about the vertical.
    // color: linear albedo; it is lit once by the baked light at its spot (lit: false or emissive: [r,g,b] for things that glow)
    mesh(geometry, { x = 0, y = 0, z = 0, yaw = 0, color = [0.5, 0.5, 0.5], emissive = null, lit = true, scale = 1 } = {}) {
      const L = lit && !emissive ? lightAt(x, y) : null, k = L ? [L[0] + 0.02, L[1] + 0.022, L[2] + 0.035] : lit && !emissive ? [0.3, 0.24, 0.18] : [1, 1, 1], c = emissive || [color[0] * k[0], color[1] * k[1], color[2] * k[2]];
      const m = made(new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(c[0], c[1], c[2]), fog: false }), 'mesh');
      const o = new THREE.Mesh(geometry, m); v3(x, y, z, o.position); o.rotation.y = yaw; o.scale.setScalar(scale); scene.add(o);
      o.userData.remove = () => { scene.remove(o); materials.delete(m); m.dispose(); };
      return o;
    },
  };

  /* ── the clock: minutes since midnight. It stands at 23:00 (the fall) until a module runs it (fx/game/clock/) ── */
  const clock = {
    t: 23 * 60, running: false, rate: 1,                          // rate: park minutes per real second
    set(t) { const prev = clock.t; clock.t = ((t % 1440) + 1440) % 1440; emit('clock', { t: clock.t, prev, jump: true }); },
    fmt: (t = clock.t) => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(Math.floor(t % 60)).padStart(2, '0'),
    // fn() when the clock passes hh:mm going forward (also on a set() that lands within 1 minute after it)
    // (while running, prev is below 0 on the frame the clock passes midnight, so a time late in the day still fires)
    at(hhmm, fn) { const [h, m] = hhmm.split(':').map(Number), T = h * 60 + m; return on('clock', ({ t, prev, jump }) => { if (jump ? t >= T && t < T + 1 : (prev < T && t >= T) || (prev < T - 1440 && t >= T - 1440)) fn(); }); },
  };

  /* ── per frame ── */
  let started = false, lastAction = '', lastWeather = '', landT = 0; const promptKey = { it: null, label: '', wick: false };
  function frame(dt, time) {
    if (off || !started) return;
    const mode = ctx.getMode(), pf = ctx.getPlatformer(), wick = !!(pf && pf.active);
    if (mode !== player.mode || wick !== player.wick) { player.mode = mode; player.wick = wick; track('', null); emit('mode', { mode, wick }); }
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
      if (act === 'punching' || act === 'move punching' || act === 'jump kick') { emit('swing', { x: player.x, y: player.y, z: player.z }); const it = driver ? null : findNear(0.9, true); if (it) use(it); }
      if (act === 'ground pound land') emit('pound', { x: player.x, y: player.y, z: player.z });
    }
    // which land the visitor is in (app.js nearestPlace(): a place id such as 'meridian', 'spire', 'gate', or null)
    if ((landT -= dt) < 0) { landT = 0.5; const p = mode === 'walk' ? ctx.nearestPlace() : null, id = p ? p.id : null; if (id !== player.land) { const prev = player.land; player.land = id; emit('land', { id, prev }); } }
    const w = ctx.weather ? ctx.weather.state : 'clear'; if (w !== lastWeather) { const prev = lastWeather; lastWeather = w; emit('weather', { state: w, prev }); }
    if (clock.running) { const prev = clock.t; clock.t = (clock.t + dt * clock.rate) % 1440; emit('clock', { t: clock.t, prev: prev > clock.t ? prev - 1440 : prev, jump: false }); }
    // the prompt: the nearest thing that can be used, in Walk mode only and not while a module holds the camera
    near = mode === 'walk' && !driver ? findNear() : null;
    let label = near ? labelOf(near) : ''; if (near && !near.enabled) { near = findNear(); label = near ? labelOf(near) : ''; }
    if (near !== promptKey.it || label !== promptKey.label || wick !== promptKey.wick) {
      promptKey.it = near; promptKey.label = label; promptKey.wick = wick; promptEl.hidden = !near;
      if (near) { promptEl.textContent = label; if (!wick) promptEl.appendChild(kbdE); }     // the label is text, never markup
    }
    emit('frame', { dt, time });
  }

  /* ── moving the visitor: teleport(x, y, yaw) stands the walker on the walk grid near (x, y), on its lowest level and never
     on the Spire island (as before). With { z }, the spot is taken as given: the walk-grid level nearest z when there is
     one within 1.5 m (an upper deck, a platform), else, for Wick only, (x, y, z) itself (a roof, a ledge, the Spire island, the
     lake bed); the first-person walker, which lives on the grid, then gets the nearest grid spot as before. Returns the
     height used, or null if Walk could not start (the park still loading). Wick spawns from the walker's spot (app.js) ── */
  function teleport(x, y, yaw, { z } = {}) {
    ctx.setMode('walk', { at: [x, y], yaw });
    if (ctx.getMode() !== 'walk') return null;
    if (z === undefined || !Number.isFinite(z)) return walk.z;
    const g = ground(x, y, z), wick = ctx.wickWanted ? ctx.wickWanted() : !!(ctx.getPlatformer() && ctx.getPlatformer().active);
    const h = g !== null && Math.abs(g - z) < 1.5 ? g : wick ? z : null;
    if (h === null) return walk.z;
    walk.x = x; walk.y = y; walk.z = walk.cz = h; walk.hop = walk.vh = 0;
    return h;
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
    setMode: ctx.setMode, teleport, esc, get interactables() { return inter.slice(); },
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
