// Rides: the monorail loop, the harbor cruise across Stillwater, riders on the carousel. See README.md.
import { createSession } from './session.js';
import { createMonorail } from './monorail.js';
import { createCarousel } from './carousel.js';
import { createCruise } from './cruise.js';

export function init(game) {
  const session = createSession(game);
  const count = (id) => { game.save.update('rides', (s) => ({ ...s, [id]: (s[id] || 0) + 1 }), {}); game.journal.refresh(); };
  const mods = {};
  const tryInit = (name, fn) => { try { const m = fn(); if (m) mods[name] = m; } catch (e) { console.warn('rides:', name, e); } };
  tryInit('monorail', () => createMonorail(game, session, { count }));
  tryInit('cruise', () => createCruise(game, session, { count }));
  tryInit('carousel', () => createCarousel(game, session, { count }));
  const WHERE = {
    monorail: 'Board on the Meridian Loop platform, Meridian Rail.',
    cruise: 'The jetty on the Brinewatch shore of Stillwater.',
    carousel: 'The Pavilion of Wings, Rosewick Gardens.',
  };
  const NAMES = { monorail: 'Monorail', cruise: 'Harbor cruise', carousel: 'Carousel' };
  game.journal.section({ id: 'rides', title: 'Rides', order: 60, render(el) {
    const st = game.save.get('rides', {});
    for (const id of ['monorail', 'cruise', 'carousel']) {
      if (id !== 'monorail' && !mods[id]) continue;
      const n = st[id] || 0, p = document.createElement('p');
      p.innerHTML = `<b>${NAMES[id]}</b>: ${WHERE[id]} ${n ? `Ridden ${n} time${n === 1 ? '' : 's'}.` : 'Not ridden yet.'}`;
      el.appendChild(p);
    }
  } });
  return { session, ...mods };
}
