// Rides: the monorail loop, the harbor cruise across Stillwater, riders on the carousel. See README.md.
import { createSession } from './session.js';
import { createMonorail } from './monorail.js';
import { createCarousel } from './carousel.js';
import { createCruise } from './cruise.js';

export function init(game) {
  const session = createSession(game);
  // a missing, null, non-object or older-shaped save starts from zero; only whole non-negative numbers are kept
  const IDS = ['monorail', 'cruise', 'carousel'];
  const counts = (raw) => { const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; return Object.fromEntries(IDS.map((id) => [id, Number.isFinite(o[id]) && o[id] > 0 ? Math.floor(o[id]) : 0])); };
  const count = (id) => { game.save.update('rides', (s) => { const c = counts(s); c[id]++; return c; }, {}); game.journal.refresh(); };
  const mods = {};
  const tryInit = (name, fn) => { try { const m = fn(); if (m) mods[name] = m; } catch (e) { console.warn('rides:', name, e); } };
  tryInit('monorail', () => createMonorail(game, session, { count }));
  tryInit('cruise', () => createCruise(game, session, { count }));
  tryInit('carousel', () => createCarousel(game, session, { count }));
  const WHERE = {
    monorail: 'Board on the platform at the Meridian Rail station.',
    cruise: 'The jetty on the Brinewatch shore of Stillwater.',
    carousel: 'Rosewick Gardens.',
  };
  const NAMES = { monorail: 'Meridian Loop', cruise: 'Harbor Cruise', carousel: 'Pavilion of Wings' };
  game.journal.section({ id: 'rides', title: 'Rides', order: 60, render(el) {
    const st = counts(game.save.get('rides', {}));
    for (const id of IDS) {
      if (id !== 'monorail' && !mods[id]) continue;
      const n = st[id], p = document.createElement('p');
      p.innerHTML = `<b>${NAMES[id]}</b>: ${WHERE[id]} ${n ? `Ridden ${n} time${n === 1 ? '' : 's'}.` : 'Not ridden yet.'}`;
      el.appendChild(p);
    }
  } });
  return { session, counts: () => counts(game.save.get('rides', {})), photoOk: () => session.photoOk, carry: (out) => session.carry(out), ...mods };
}
