// The storyteller (21:15-22:00): a figure with a ring of lantern light on the ghost-story stage in Lantern Row. Using it
// tells one of three short stories (a small card); each names a real spot in the park, where a keepsake then waits.
import { STAGE } from './crowd.js';

const T0 = 21 * 60 + 15, T1 = 22 * 60;
export const STORIES = [
  { id: 'pagoda', title: 'The last floor', spot: 'the pagoda terrace', at: [68.9, -178.6],
    keep: { name: 'a ribbon of red silk', color: [1.6, 0.25, 0.2] },
    text: ['They say the pagoda at the east end of the Row has a lamp on its top floor that nobody has ever lit.', 'Yet on still nights it is warm to the touch, and a red ribbon is found tied to the terrace rail below the first roof.', 'The monk who kept it never came down. Go and look: he tied it there to be found.'] },
  { id: 'torii', title: 'The one who stayed', spot: 'the great torii', at: [35.6, -127.8],
    keep: { name: 'an old brass coin', color: [1.5, 1.0, 0.3] },
    text: ['Count the steps from the great torii to the shrine, going in. Count them again going out.', 'The numbers never agree. The lamplighters say the difference is one, and that the one is still here.', 'Whoever it was left a coin at the western pillar, on the lake side, so the way back would be paid for.'] },
  { id: 'market', title: 'The stall without a keeper', spot: 'the Night Market square', at: [3.4, -186.2],
    keep: { name: 'a paper lantern, still warm', color: [1.5, 0.8, 0.35] },
    text: ['At the far end of the Night Market there is a stall nobody has ever seen open.', 'Each night a single paper lantern is set out in the square in front of it, lit, with no one near.', 'Take it, if you like. It has been waiting for somebody to carry it home.'] },
];
const CSS = `
#ck-card{position:fixed;z-index:8;left:50%;top:max(160px,24%);transform:translateX(-50%);width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:16px 18px 14px;border-radius:16px;
  background:rgba(13,11,38,.9);border:1px solid rgba(255,181,71,.6);color:var(--paper);font:400 15px/1.5 var(--ui);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:game-toast-in .35s ease both}
#ck-card[hidden]{display:none} #ck-card h4{margin:0 0 8px;font:600 10.5px var(--ui);letter-spacing:.14em;text-transform:uppercase;color:var(--amber)}
#ck-card p{margin:0 0 12px;font-family:var(--serif,Georgia,serif);font-size:16px;line-height:1.5} #ck-card .ck-nav{display:flex;justify-content:space-between;align-items:center;font:500 12px var(--ui);opacity:.9}
#ck-card button{appearance:none;border:1px solid rgba(255,181,71,.7);border-radius:999px;background:transparent;color:var(--paper);font:600 13px var(--ui);padding:7px 16px;cursor:pointer}
`;

export function createStory(game, { st }) {
  const THREE = game.THREE, v3 = game.v3;
  const state = () => game.save.get('clock', {}) || {};
  const heard = new Set(state().heard || []), found = new Set(state().found || []);
  const keep = () => game.save.update('clock', (o) => ({ ...o, heard: [...heard], found: [...found] }), {});
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  let present = false, group = null, lant = null, ring = null, headM = null, built = false, card = null, sway = 0;
  const [sx, sy] = STAGE, sz = game.ground(sx, sy) ?? 3.19;

  function build() {
    built = true;
    const P = game.props, G = new THREE.Group(); G.rotation.y = Math.atan2(-(-176 - sy), -(26 - sx)) ;   // faces the benches (south-west of the stage)
    G.position.copy(v3(sx, sy, sz)); G.visible = false; game.scene.add(G); group = G;
    const part = (geo, x, y, z, o) => { const m = P.mesh(geo, { x: sx, y: sy, z: sz, ...o }); game.scene.remove(m); m.position.set(x, y, z); G.add(m); return m; };
    part(new THREE.CylinderGeometry(0.2, 0.44, 1.25, 9), 0, 0.62, 0, { color: [0.14, 0.08, 0.2] });                       // robe
    part(new THREE.CylinderGeometry(0.22, 0.2, 0.34, 9), 0, 1.38, 0, { color: [0.09, 0.07, 0.17] });                      // shoulders
    part(new THREE.CylinderGeometry(0.235, 0.235, 0.07, 9), 0, 1.2, 0, { color: [0.6, 0.32, 0.08] });                      // sash
    headM = part(new THREE.SphereGeometry(0.135, 10, 8), 0, 1.68, 0.02, { color: [0.45, 0.33, 0.26] });                     // head
    part(new THREE.SphereGeometry(0.175, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 1.7, -0.025, { color: [0.07, 0.05, 0.14] });   // hood
    part(new THREE.BoxGeometry(0.1, 0.5, 0.1), 0.27, 1.2, 0.1, { color: [0.07, 0.05, 0.14] }).rotation.x = -0.5;             // arms
    part(new THREE.BoxGeometry(0.1, 0.5, 0.1), -0.27, 1.22, 0.05, { color: [0.07, 0.05, 0.14] }).rotation.x = -0.25;
    part(new THREE.CylinderGeometry(0.022, 0.022, 1.9, 5), 0.36, 0.95, 0.38, { color: [0.2, 0.12, 0.05] });                // staff
    part(new THREE.BoxGeometry(0.16, 0.2, 0.16), 0.36, 1.98, 0.38, { emissive: [1.7, 0.95, 0.4] });                         // lantern
    lant = P.glow({ x: sx, y: sy, z: sz + 1.95, color: [1.3, 0.7, 0.28], size: 3.2 }); lant.sprite.visible = false;
    // the circle of light on the stage boards
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,190,100,.55)'); gr.addColorStop(0.55, 'rgba(255,150,60,.22)'); gr.addColorStop(1, 'rgba(255,120,40,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    ring = new THREE.Mesh(new THREE.CircleGeometry(2.6, 28), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    ring.rotation.x = -Math.PI / 2; ring.position.copy(v3(sx, sy, sz + 0.04)); ring.visible = false; ring.renderOrder = 7; game.scene.add(ring);
    game.interact({ id: 'clock-story', x: sx, y: sy, z: sz, r: 4, label: () => (heard.size >= STORIES.length ? 'Hear a story again' : 'Hear a story'), swing: false, show: () => present && !card && !game.cameraHeld, use: tell });
  }
  const show = (on) => { if (!built) build(); group.visible = on; ring.visible = on; lant.sprite.visible = on; };

  /* ── the card ── */
  function closeCard() { if (card) { card.remove(); card = null; removeEventListener('keydown', onKey, true); } }
  const onKey = (e) => { if (e.key === 'Escape') { closeCard(); e.stopPropagation(); } };
  function tell() {
    const left = STORIES.filter((s) => !heard.has(s.id)), s = (left.length ? left : STORIES)[left.length ? 0 : Math.floor(Math.random() * STORIES.length)];
    let i = 0;
    closeCard(); card = document.createElement('div'); card.id = 'ck-card'; document.body.appendChild(card); addEventListener('keydown', onKey, true);
    const draw = () => {
      const last = i === s.text.length - 1;
      card.innerHTML = `<h4>${s.title}</h4><p></p><div class="ck-nav"><span>${i + 1} / ${s.text.length}</span><button type="button">${last ? 'Close' : 'Next'}</button></div>`;
      card.querySelector('p').textContent = s.text[i];
      card.querySelector('button').addEventListener('click', () => { if (last) { done(); } else { i++; draw(); } });
    };
    const done = () => {
      closeCard();
      if (!heard.has(s.id)) { heard.add(s.id); keep(); game.toast(`Go to <b>${s.spot}</b>. Something is waiting there.`, { tone: 'good', ms: 6000 }); game.emit('clock:story', { id: s.id }); }
      spots(); if (game.journal.isOpen) game.journal.refresh();
    };
    draw();
  }

  /* ── keepsakes: a glow where the story said ── */
  const marks = new Map();
  function spots() {
    for (const s of STORIES) {
      const want = heard.has(s.id) && !found.has(s.id);
      if (want && !marks.has(s.id)) {
        const [x, y] = s.at, z = (game.ground(x, y) ?? 1.9) + 0.25;
        const glow = game.props.glow({ x, y, z: z + 0.15, color: s.keep.color, size: 1.3 });
        const it = game.interact({ id: 'clock-keep-' + s.id, x, y, z, r: 2.6, label: 'Take ' + s.keep.name, swing: true, show: () => !game.cameraHeld,
          use: () => { found.add(s.id); keep(); glow.remove(); it.remove(); marks.delete(s.id); game.toast(`You take <b>${s.keep.name}</b>.`, { tone: 'good' }); game.emit('clock:keepsake', { id: s.id }); game.sound('ui_click'); if (game.journal.isOpen) game.journal.refresh(); } });
        marks.set(s.id, { glow, it });
      }
    }
  }
  spots();

  return {
    get present() { return present; }, heard, found, STORIES, tell, spots, closeCard, get card() { return card; },
    update(t) { const p = t >= T0 && t < T1; if (p !== present) { present = p; if (p || built) show(p); if (!p) closeCard(); if (game.journal.isOpen) game.journal.refresh(); } },
    frame(dt) {
      if (!present || !built) return;
      sway += dt; headM.rotation.y = Math.sin(sway * 0.7) * 0.35; group.rotation.z = Math.sin(sway * 0.5) * 0.015;
      const k = 0.85 + 0.15 * Math.sin(sway * 9) * Math.sin(sway * 5.3); lant.set({ color: [1.3 * k, 0.7 * k, 0.28 * k] });
    },
    journal(el) {
      const h = document.createElement('div'); h.className = 'ck-story'; h.style.marginTop = '10px';
      const lines = [];
      lines.push(present ? 'The storyteller is on the stage in Lantern Row, by the shrine.' : 'The storyteller comes back at 21:15 and stays until ten.');
      for (const s of STORIES) if (heard.has(s.id)) lines.push(found.has(s.id) ? `${s.title}: found ${s.keep.name} at ${s.spot}.` : `${s.title}: something waits at ${s.spot}.`);
      if (!heard.size) lines.push('Nothing heard yet.');
      for (const l of lines) { const p = document.createElement('p'); p.className = 'ck-note'; p.style.opacity = '.8'; p.textContent = l; h.appendChild(p); }
      el.appendChild(h);
    },
  };
}
