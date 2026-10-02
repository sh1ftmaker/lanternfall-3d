// fx/game/clock: the evening as a clock (17:30 gates -> 23:40 close, looping; the page opens at 23:00, mid-fall).
// Runs game.clock, announces the programme, drives the lantern fall (fx/lanterns.js setFall), the closing fireworks,
// the crowd's drift (crowd.js), the silent four minutes (hush.js) and the storyteller (story.js). See README.md.
import { drift } from './crowd.js';
import { createHush } from './hush.js';
import { createStory } from './story.js';

export const START = 17 * 60 + 30, FALL = 23 * 60, HUSH_END = FALL + 4, END = 23 * 60 + 40;
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
// the programme: `short` for the tracker, `toast` when it begins, `text` in the journal
export const EVENTS = [
  { id: 'gates', t: hm('17:30'), title: 'Gates open', short: 'Gates open', toast: "The gates are open. The first lanterns are lit down the Lamplighters' Walk.", text: "The first lanterns are lit down the Lamplighters' Walk as the sun slips away." },
  { id: 'frostfair', t: hm('19:00'), title: 'The Frost Fair', short: 'The Frost Fair', toast: 'The Frost Fair is on at <b>Frostmere</b>.', text: 'Skates, stalls and cold breath at Frostmere Keep.' },
  { id: 'stories', t: hm('21:15'), until: hm('22:00'), title: 'Ghost stories', short: 'Ghost stories', toast: 'Ghost stories begin in <b>Lantern Row</b>.', text: 'A storyteller by the shrine in Lantern Row, until ten.' },
  { id: 'fall', t: hm('23:00'), title: 'The lantern fall', short: 'The lantern fall', toast: 'The lamplighters are releasing the lanterns from the Spire.', text: 'Ten thousand paper lanterns, released from the Spire\'s gallery onto Stillwater.' },
  { id: 'hush', t: hm('23:00'), until: HUSH_END, title: 'The silent four minutes', short: 'The hush', toast: 'Nobody talks for the next four minutes.', text: 'Nobody talks. Stand at the lake rail.' },
  { id: 'close', t: hm('23:40'), title: 'The park closes', short: 'Closing time', toast: 'The park is closing. Good night.', text: 'The lanterns thin out and the evening begins again.' },
];
const ORDER = EVENTS.map((e) => e.id);
// park minutes per real second: about twenty minutes for the evening, the fall itself 5.5
export function rateAt(t) { return t < 1140 ? 0.5 : t < 1275 ? 0.45 : t < 1320 ? 0.2 : t < FALL ? 0.4 : 40 / 330; }
const FALL_RATE = 40 / 330;

const CSS = `
.ck-list{display:flex;flex-direction:column;gap:2px;margin:2px 0 8px}
.ck-row{appearance:none;box-sizing:border-box;display:grid;grid-template-columns:48px 1fr;gap:2px 8px;text-align:left;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--paper);font:500 13.5px/1.35 var(--ui);padding:6px 8px;cursor:pointer;width:100%}
.ck-row:hover{background:rgba(255,255,255,.06)} .ck-row[disabled]{cursor:default;opacity:.7}
.ck-row i{font:600 12.5px var(--ui);font-style:normal;color:var(--amber);opacity:.85;grid-row:span 2;padding-top:1px}
.ck-row small{font:400 12px/1.35 var(--ui);opacity:.65;grid-column:2}
.ck-row.now{border-color:rgba(255,181,71,.6);background:rgba(255,181,71,.08)} .ck-row.now b::after{content:" · now";color:var(--amber);font-weight:500}
.ck-hold{display:flex;align-items:center;gap:10px;margin:6px 0 4px;font:500 13.5px var(--ui);cursor:pointer}
.ck-hold input{appearance:none;width:38px;height:22px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.1);position:relative;cursor:pointer;margin:0;transition:background .2s}
.ck-hold input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--paper);transition:transform .2s}
.ck-hold input:checked{background:rgba(255,181,71,.55)} .ck-hold input:checked::after{transform:translateX(16px)}
.ck-note{font:400 12px/1.4 var(--ui);opacity:.6;margin:2px 0 0}
#ck-close{position:fixed;inset:0;z-index:15;display:grid;place-items:center;align-content:center;gap:6px;background:#04030c;opacity:0;pointer-events:none;padding:24px;text-align:center}
#ck-close[hidden]{display:none} #ck-close p{margin:0;color:var(--paper);font:400 clamp(18px,4.6vw,26px)/1.4 var(--serif,Georgia,serif);letter-spacing:.01em;opacity:0}
#ck-close p+p{color:var(--amber);font-size:clamp(15px,3.8vw,20px)}
`;

export function init(game) {
  const clock = game.clock, save = game.save;
  const st = { hold: !!(save.get('clock', {}) || {}).hold };
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const persist = () => save.update('clock', (o) => ({ ...o, hold: st.hold }), {});

  /* ── the evening is saved (every few park minutes and when the page is hidden) and restored unless the address sets a time ── */
  const parseT = (s) => { const m = /^(\d{1,2}):?(\d{2})$/.exec(s || ''); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
  let closing = null;                                                    // the closing transition (below): { ph: 'out' | 'hold' | 'in', k }
  let urlT = null; for (const h of game.hash) { const m = /^t(?:ime)?=(.+)$/.exec(h); if (m) urlT = parseT(m[1].replace('%3A', ':')); }
  const savedT = (() => { const v = (save.get('clock', {}) || {}).t; return typeof v === 'number' && Number.isFinite(v) && v >= START && v < END ? v : null; })();
  let pendingT = urlT === null ? savedT : null, lastSaved = -1e9;
  const saveT = () => { const t = clock.t; if (tour || closing || t < START || t >= END) return; lastSaved = t; save.update('clock', (o) => ({ ...(o && typeof o === 'object' ? o : {}), t: Math.round(t * 10) / 10 }), {}); };

  /* ── toasts, one at a time so a burst of events (close, gates) can be read ── */
  const queue = []; let qBusy = 0;
  const say = (html) => { if (game.player.mode === 'tour') return; queue.push(html); pump(); };
  function pump() { if (qBusy || closing || !queue.length) return; game.toast(queue.shift(), { tone: 'good', ms: 4600 }); qBusy = 1; setTimeout(() => { qBusy = 0; pump(); }, 2200); }

  const lanternMesh = () => { const L = game.ctx.getFx && game.ctx.getFx(); return L && L.lanterns && L.lanterns.userData.setFall ? L.lanterns : null; };
  const fireworks = () => { const f = game.ctx.getFx && game.ctx.getFx(); return f && f.fireworks; };
  const now = () => game.uTime.value;

  /* ── the lantern fall follows the clock ── */
  let thinUntil = 0;
  function lanterns(t, prev, jump) {
    const L = lanternMesh(); if (!L) return; const S = L.userData.fallState || 'classic';
    const inFall = t >= FALL && t < END;
    if (!inFall) {
      if (!jump && t >= END) { if (S === 'classic' || S === 'fall') { L.userData.setFall('thin', now()); thinUntil = now() + 60; } }   // the evening ends: the sky thins out
      else if (S !== 'none' && !(S === 'thin' && !jump)) { L.userData.setFall('none', now()); thinUntil = 0; }                                        // a jump away from the fall
    } else if (jump) {                                           // a jump into the fall: to its start = released afresh, later = already full
      const into = t - FALL;
      if (into < 4) L.userData.setFall('fall', now() - into / FALL_RATE); else if (S !== 'classic') L.userData.setFall('classic', now());
    } else if (S === 'none' || S === 'thin') L.userData.setFall('fall', now());
    const f = fireworks(); if (f) f.userData.finale = inFall && t >= END - 6 && game.player.mode !== 'tour';
  }

  /* ── events ── */
  const announced = new Set();
  const hush = createHush(game);
  function fire(e, jump) {
    if (announced.has(e.id)) return; announced.add(e.id);
    game.emit('clock:event', { id: e.id, t: clock.t });
    if (e.id !== 'close') say(e.toast);                             // closing time has its own line, on the fade
    if (e.id === 'hush') hush.start();
    if (e.id === 'close') hush.stop();
    if (journalOpen()) game.journal.refresh();
  }
  const journalOpen = () => game.journal.isOpen;
  game.on('clock', ({ t, prev, jump }) => {
    if (jump && closing && closing.ph === 'out' && t < END) { closing.ph = 'in'; closing.k = 1 - closing.k; }                       // someone jumped away from closing time: fade back
    if (jump && t < prev) for (const e of EVENTS) if (e.t >= t) announced.delete(e.id);
    if (jump && hush.on && !(t >= FALL && t < HUSH_END)) hush.stop();
    for (const e of EVENTS) if (jump ? t >= e.t && t < e.t + 1 : prev < e.t && t >= e.t) fire(e, jump);
    lanterns(t, prev, jump);
    drift(game, t);
    story.update(t, jump);
  });

  /* ── running ── */
  let lastMin = -1, lastCur = '', tour = game.player.mode === 'tour';
  function applyRun() { clock.running = !st.hold && !tour && !closing; }
  game.on('mode', ({ mode }) => {
    const was = tour; tour = mode === 'tour';
    if (tour && !was) { cancelClosing(); hush.stop(); if (!(clock.t === FALL || (clock.t >= HUSH_END && clock.t < END))) clock.set(FALL + 10); }
    if (!tour && was && pendingT !== null) { const p = pendingT; pendingT = null; if (clock.t >= FALL && clock.t < END) clock.set(p); }   // the saved evening, once the visitor leaves the opening tour
    applyRun(); track(true); if (game.journal.isOpen) game.journal.refresh();
  });
  game.on('frame', ({ dt }) => {
    clock.rate = rateAt(clock.t);
    if (clock.t >= END && !closing && !tour) startClosing();
    else if (clock.t >= END && tour) clock.set(FALL + 10);
    closeFrame(dt);
    if (!tour && !closing && Math.abs(clock.t - lastSaved) >= 3) saveT();
    if (thinUntil && now() > thinUntil) { thinUntil = 0; const L = lanternMesh(); if (L && L.userData.fallState === 'thin') L.userData.setFall('none', now()); }
    if (hush.on && (clock.t >= HUSH_END || clock.t < FALL)) hush.stop();
    hush.frame(dt);
    story.frame(dt);
    track(false);
  });

  /* ── closing time: a fade through dark, the evening starts again behind it (the Tour never gets here: it holds the fall) ── */
  let veil = null, veilP = null;
  const OUT = 1.4, HOLD = 3, IN = 1.8, ease = (k) => k * k * (3 - 2 * k);
  function startClosing() {
    if (closing) return;
    if (!veil) { veil = document.createElement('div'); veil.id = 'ck-close'; veil.hidden = true; veil.setAttribute('role', 'status'); veil.innerHTML = '<p>The park closes.</p><p>A new evening begins.</p>'; document.body.appendChild(veil); veilP = veil.querySelectorAll('p'); }
    closing = { ph: 'out', k: 0 }; veil.hidden = false; applyRun();
  }
  function cancelClosing() { if (!closing) return; closing = null; if (veil) { veil.style.opacity = '0'; veil.hidden = true; } applyRun(); pump(); }
  function closeFrame(dt) {
    if (!closing) return; const c = closing, d = Math.min(dt, 0.1);
    c.k += d / (c.ph === 'out' ? OUT : c.ph === 'hold' ? HOLD : IN);
    if (c.ph === 'out' && c.k >= 1) { c.ph = 'hold'; c.k = 0; clock.set(START); if (game.journal.isOpen) game.journal.refresh(); }     // fully dark: the next evening
    else if (c.ph === 'hold' && c.k >= 1) { c.ph = 'in'; c.k = 0; }
    else if (c.ph === 'in' && c.k >= 1) { cancelClosing(); return; }
    const a = c.ph === 'out' ? ease(c.k) : c.ph === 'hold' ? 1 : 1 - ease(c.k);
    veil.style.opacity = String(a);
    const line = (i, from, to) => { veilP[i].style.opacity = String(c.ph === 'out' ? 0 : c.ph === 'in' ? 1 - ease(c.k) : ease(Math.min(1, Math.max(0, (c.k * HOLD - from) / (to - from))))); };
    line(0, 0.1, 0.8); line(1, 0.8, 1.5);
  }

  /* ── tracker ── */
  function current(t = clock.t) { let c = null; for (const e of EVENTS) if (e.id !== 'hush' && t >= e.t) c = e; return c; }
  function next(t = clock.t) { for (const e of EVENTS) if (e.id !== 'hush' && e.t > t) return e; return null; }
  function track(force) {
    const t = clock.t, min = Math.floor(t);
    if (!force && min === lastMin) return; lastMin = min;
    if (tour) { game.track('clock', null); return; }
    const n = next(t), c = current(t), air = t >= FALL && t < END;      // from 23:00 the lanterns are in the air, until the park closes
    const what = air ? (t < HUSH_END ? 'Lanterns in the air · silent until ' + game.clock.fmt(HUSH_END) : 'Lanterns in the air · closing at ' + game.clock.fmt(END)) : n ? `${n.short} at ${game.clock.fmt(n.t)}` : c ? c.short : '';
    game.track('clock', `<b style="color:inherit;font-size:inherit;letter-spacing:0;text-transform:none">${clock.fmt()}</b> · ` + what, { order: 90 });
    const cur = (c ? c.id : '') + (hush.on ? 'h' : '') + (air ? 'a' : ''); if (cur !== lastCur) { lastCur = cur; if (game.journal.isOpen) game.journal.refresh(); }
  }

  /* ── the journal: tonight ── */
  const story = createStory(game, { st, persist });
  game.journal.section({ id: 'clock', title: 'Tonight', order: 5, render(el) {
    const t = clock.t, c = current(t);
    const list = document.createElement('div'); list.className = 'ck-list';
    for (const e of EVENTS) {
      const on = c && c.id === e.id || (e.id === 'hush' && hush.on);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ck-row' + (on ? ' now' : ''); b.disabled = tour;
      b.innerHTML = `<i>${clock.fmt(e.t)}</i><b>${e.title}</b><small>${e.text}</small>`;
      b.addEventListener('click', () => { if (!tour) { clock.set(e.t); game.journal.refresh(); } });
      list.appendChild(b);
    }
    el.appendChild(list);
    const h = document.createElement('label'); h.className = 'ck-hold'; h.innerHTML = '<input type="checkbox"><span>Hold the time</span>';
    const inp = h.querySelector('input'); inp.checked = st.hold; inp.addEventListener('change', () => { st.hold = inp.checked; persist(); applyRun(); });
    el.appendChild(h);
    const note = document.createElement('p'); note.className = 'ck-note';
    note.textContent = tour ? 'The tour keeps the evening at eleven, mid-fall.' : st.hold ? 'The evening is standing still.' : 'Tap an hour to jump to it.';
    el.appendChild(note);
    story.journal(el);
  } });

  addEventListener('pagehide', saveT); document.addEventListener('visibilitychange', () => { if (document.hidden) saveT(); });
  if (urlT !== null) clock.set(urlT);
  else if (pendingT !== null && !tour) { const p = pendingT; pendingT = null; clock.set(p); }
  clock.running = false; applyRun(); track(true);
  return { EVENTS, rateAt, get hold() { return st.hold; }, set hold(v) { st.hold = !!v; persist(); applyRun(); }, hush, story, say, announced, get closing() { return closing && closing.ph; }, startClosing, lanterns: () => lanternMesh() && lanternMesh().userData.fallState };
}
