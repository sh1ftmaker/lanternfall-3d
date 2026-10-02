// fx/game/secrets: mysteries and Easter eggs. Nothing here is announced; each find is written in the journal's "Curiosities".
// See README.md. Each secret is its own file exporting init(S); S carries what they share.
import { makeLib } from './lib.js';

const KEY = 'secrets';
// the order is the journal's order. line: what is written once found; hint: a faint nudge (shown after three finds)
export const LIST = [
  { id: 'doors', line: 'A paper door that answers to the sky.', hint: 'Some doors listen to the weather.' },
  { id: 'redcoat', line: 'A red button, left by someone always a little ahead.', hint: 'Somebody keeps walking ahead of you.' },
  { id: 'lakebed', line: 'A carousel horse that slipped into the lake long ago.', hint: 'The water shimmers over something.' },
  { id: 'bell', line: 'Twenty-three rings, and the Spire answers.', hint: 'The crooked bell has a number.' },
  { id: 'nap', line: 'You fell asleep somewhere ordinary and woke somewhere better.', hint: 'A good bench is worth a long sleep.' },
  { id: 'keep', line: 'Someone watches the storm from the keep.', hint: 'Look up when the sky breaks.' },
  { id: 'snow', line: 'Small footprints in the snow, and a box that still plays.', hint: 'Snow keeps a trail for the curious.' },
  { id: 'garden', line: 'A garden nobody planted, up where only the quick can climb.', hint: 'Neon towers hide a roof for the nimble.' },
];
const FILES = ['doors', 'redcoat', 'lakebed', 'bell', 'nap', 'keep', 'snow', 'garden'];
const CSS = `#sx-fade{position:fixed;inset:0;z-index:30;pointer-events:none;opacity:0;background:var(--sx-fade,#f5ecdc);transition:opacity .45s ease}
#sx-fade.on{opacity:1} #sx-fade.slow{transition-duration:.9s} @media (prefers-reduced-motion:reduce){#sx-fade{transition:none}}
.sx-jrow{display:flex;gap:8px;margin:0 0 7px} .sx-jrow i{font-style:normal;opacity:.55;min-width:14px;text-align:center}
.sx-jrow.hint{opacity:.45;font-style:italic} .sx-jrow.none{opacity:.4}
#game-journal{box-sizing:border-box}   /* workaround: the core sheet is content-box, so on a 390 px screen it runs 34 px off the right edge */`;

export function init(game) {
  const lib = makeLib(game);
  const state = () => game.save.get(KEY, null) || {};
  const found = (id) => {
    const s = state(); s.found = s.found || {};
    if (s.found[id]) return false;
    s.found[id] = 1; game.save.set(KEY, s);
    const count = Object.keys(s.found).length, e = LIST.find((x) => x.id === id);
    game.toast(`<b>A curiosity.</b> ${e ? e.line : id}`, { ms: 6000, tone: 'good' });
    game.emit('secrets:found', { id, count, total: LIST.length });
    game.journal.refresh();
    return true;
  };
  const isFound = (id) => !!(state().found || {})[id];
  const put = (patch) => { const s = state(); Object.assign(s, patch); game.save.set(KEY, s); return s; };

  /* a full-screen fade: to paper-white (or another colour), run fn in the middle, back; instant with Reduce motion */
  const fadeEl = document.createElement('div'); fadeEl.id = 'sx-fade'; fadeEl.setAttribute('aria-hidden', 'true');
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); document.body.appendChild(fadeEl);
  let fading = false;
  function fade(fn, { color = '#f5ecdc', slow = false } = {}) {
    if (fading) return Promise.resolve(false);
    fading = true; fadeEl.style.setProperty('--sx-fade', color); fadeEl.classList.toggle('slow', slow);
    const ms = game.reduceMotion ? 0 : slow ? 950 : 480;
    return new Promise((res) => {
      fadeEl.classList.add('on');
      setTimeout(() => {
        try { fn(); } catch (e) { console.warn('secrets: fade', e); }
        setTimeout(() => { fadeEl.classList.remove('on'); setTimeout(() => { fading = false; res(true); }, ms); }, game.reduceMotion ? 0 : 160);
      }, ms);
    });
  }

  const S = { game, lib, found, isFound, state, put, fade, LIST, THREE: game.THREE, api: {} };
  game.journal.section({
    id: 'secrets', title: 'Curiosities', order: 90,
    render(el) {
      const f = state().found || {}, n = Object.keys(f).length;
      for (const e of LIST) {
        const row = document.createElement('div'); row.className = 'sx-jrow' + (f[e.id] ? '' : ' none');
        const i = document.createElement('i'); i.textContent = f[e.id] ? '◆' : '—';
        const t = document.createElement('span'); t.textContent = f[e.id] ? e.line : '';
        row.append(i, t); el.appendChild(row);
      }
      const hints = n >= 3 ? LIST.filter((e) => !f[e.id]) : [];
      if (hints.length) { const h = hints[Math.floor((performance.now() / 60000) % hints.length)]; const row = document.createElement('div'); row.className = 'sx-jrow hint'; row.innerHTML = '<i></i>'; const t = document.createElement('span'); t.textContent = h.hint; row.appendChild(t); el.appendChild(row); }
    },
  });
  for (const f of FILES) {
    import(`./${f}.js`).then((m) => { if (m.init) S.api[f] = m.init(S) || true; }).catch((e) => console.warn('secrets: ' + f, e));
  }
  return { found, isFound, state, S, LIST, lib, fade };
}
