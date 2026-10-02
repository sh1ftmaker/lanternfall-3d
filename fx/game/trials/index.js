// fx/game/trials: time trials. A start post per course, checkpoints passed in order, splits against your best, a ghost
// lantern replaying your best run (a fixed-pace one the first time), medals, and the journal's "Trials" section.
import { COURSES } from './courses.js';

const KEY = 'trials', DT = 0.1, QN = 4, KF = 60, MEDALS = ['Bronze', 'Silver', 'Gold'];
const CSS = `
#trials-count{position:fixed;z-index:7;left:50%;top:34%;transform:translate(-50%,-50%);pointer-events:none;font:700 84px/1 var(--ui);color:var(--amber);
  text-shadow:0 2px 24px rgba(255,160,40,.55);opacity:0;transition:opacity .2s ease} #trials-count.on{opacity:1}
#trials-count small{display:block;font:600 13px var(--ui);letter-spacing:.16em;text-transform:uppercase;color:var(--paper);text-align:center;margin-top:8px;text-shadow:none}
body.clean #trials-count{display:none}
#game-journal{box-sizing:border-box}  /* the core sheet is 34 px wider than the phone screen without this */
.tr-row{padding:4px 0 8px} .tr-row b{font-weight:600} .tr-row .tr-t{color:var(--amber);font-weight:600} .tr-row .tr-sub{opacity:.72;font-size:12.5px;line-height:1.4}
.tr-go{margin-top:5px;appearance:none;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--paper);font:500 12px var(--ui);padding:4px 11px;cursor:pointer}
`;
const fmt = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };
const medalOf = (c, t, style) => { const k = style === 'f' ? c.fp : 1; return t <= c.medals.gold * k ? 2 : t <= c.medals.silver * k ? 1 : 0; };

// a run is a flat Float32Array [x, y, z, ...] at 10 Hz; saved as keyframes every KF samples plus one char per component delta (quarter metres)
function encode(rec) {
  const n = rec.length / 3, keys = []; let s = '', c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const q = Math.round(rec[i * 3 + k] * QN);
    if (i % KF === 0) { keys.push(q); c[k] = q; } else { const d = Math.max(-45, Math.min(45, q - c[k])); s += String.fromCharCode(80 + d); c[k] += d; }
  }
  return { n, k: keys, d: s };
}
function decode(g) {
  const out = new Float32Array(g.n * 3), c = [0, 0, 0]; let p = 0;
  for (let i = 0; i < g.n; i++) for (let k = 0; k < 3; k++) {
    if (i % KF === 0) c[k] = g.k[(i / KF) * 3 + k]; else c[k] += g.d.charCodeAt(p++) - 80;
    out[i * 3 + k] = c[k] / QN;
  }
  return out;
}
function segDist(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l > 1e-6 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0; return Math.hypot(px - ax - dx * t, py - ay - dy * t); }

export function init(game) {
  const { THREE, scene, player } = game;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const countEl = document.createElement('div'); countEl.id = 'trials-count'; countEl.setAttribute('aria-hidden', 'true'); document.body.appendChild(countEl);
  // saved state may be old, partial or hand-edited: never let it throw (a best needs a time; a bad ghost falls back to the pace lantern)
  const store = () => { const s = game.save.get(KEY, null); return s && typeof s === 'object' && s.c && typeof s.c === 'object' ? s : { c: {} }; };
  const bestOf = (id, st) => { const e = store().c[id + '.' + st]; return e && typeof e === 'object' && Number.isFinite(e.t) ? e : null; };
  const bits = {};                 // shared geometry, built once
  let race = null;
  for (const c of COURSES) c.pts = c.cps;

  /* ── start posts: a short iron post with a teal pennant, a faint glow, and a name that shows up close ── */
  const posts = new Map();
  function labelSprite(text) {
    const cv = document.createElement('canvas'); cv.width = 384; cv.height = 72; const g = cv.getContext('2d');
    g.font = '600 30px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(13,11,38,.55)'; g.beginPath(); g.roundRect(4, 8, 376, 56, 28); g.fill();
    g.fillStyle = '#ffd9a0'; g.fillText(text, 192, 37);
    const tex = new THREE.CanvasTexture(cv), mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    const s = new THREE.Sprite(mat); s.scale.set(2.6, 0.49, 1); s.renderOrder = 9; return s;
  }
  for (const c of COURSES) {
    const [x, y, z, yaw] = c.post, g = { c, parts: [] };
    g.parts.push(game.props.mesh(new THREE.CylinderGeometry(0.07, 0.11, 3.1, 8).translate(0, 1.55, 0), { x, y, z, color: [0.1, 0.1, 0.11] }));
    g.parts.push(game.props.mesh(new THREE.BoxGeometry(0.7, 0.42, 0.04).translate(0.4, 2.6, 0), { x, y, z, yaw, emissive: [0.08, 0.34, 0.32], lit: false }));
    g.parts.push(game.props.mesh(new THREE.SphereGeometry(0.16, 8, 6).translate(0, 3.2, 0), { x, y, z, emissive: [0.9, 0.55, 0.2], lit: false }));
    g.glow = game.props.glow({ x, y, z: z + 3.2, color: [0.1, 0.32, 0.3], size: 2.2 });
    g.label = labelSprite(c.short.toUpperCase() + ' · TIME TRIAL'); game.v3(x, y, z + 4.1, g.label.position); g.label.visible = false; scene.add(g.label);
    g.it = game.interact({
      id: 'trial-' + c.id, x, y, z: z + 1, r: 3.4,
      label: () => (race && race.c === c ? 'Cancel the race' : 'Race: ' + c.name + (c.wick && !player.wick ? ' (Wick only)' : '')),
      show: () => !game.cameraHeld, use: () => (race && race.c === c ? cancel('post', true) : start(c.id)),
    });
    posts.set(c.id, g);
  }
  let lblT = 0;

  /* ── what is drawn only during a race: two rings (next bright, the one after dim), a light column on the next, the ghost ── */
  function build() {
    if (bits.ring) return;
    bits.ring = new THREE.TorusGeometry(3, 0.16, 8, 44); bits.beam = new THREE.CylinderGeometry(0.22, 0.22, 40, 8, 1, true).translate(0, 20, 0);
  }
  function marker() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const bmat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.14, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const grp = new THREE.Group(), ring = new THREE.Mesh(bits.ring, mat), beam = new THREE.Mesh(bits.beam, bmat); ring.position.y = 2.4; ring.renderOrder = 8; beam.renderOrder = 8;
    grp.add(ring, beam); grp.visible = false; scene.add(grp);
    return { grp, ring, beam, mat, bmat, glow: game.props.glow({ x: 0, y: 0, z: 0, color: [1.2, 0.75, 0.3], size: 6, visible: false }) };
  }
  function place(m, c, i, bright) {
    if (i >= c.pts.length) { m.grp.visible = false; m.glow.set({ visible: false }); return; }
    const p = c.pts[i], a = c.pts[Math.max(0, i - 1)], b = c.pts[Math.min(c.pts.length - 1, i + 1)], fin = i === c.pts.length - 1;
    game.v3(p[0], p[1], p[2], m.grp.position); m.grp.rotation.y = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
    const k = bright ? 1 : 0.28; m.mat.opacity = k * 0.95; m.bmat.opacity = bright ? 0.14 : 0; m.beam.visible = bright;
    m.mat.color.set(fin ? 0xfff0c0 : 0xffb040); m.ring.scale.setScalar((p[3] || 5) > 5 ? (p[3] / 5) : 1);
    m.grp.visible = true; m.glow.set({ x: p[0], y: p[1], z: p[2] + 2.4, visible: true, color: bright ? [1.3, 0.8, 0.3] : [0.4, 0.25, 0.1], size: bright ? 7 : 4 });
  }
  const gcol = [[0.35, 0.65, 1.4], [0.3, 0.55, 1.1], [0.26, 0.46, 0.9], [0.2, 0.36, 0.7], [0.15, 0.28, 0.5], [0.1, 0.2, 0.35], [0.06, 0.12, 0.2]];
  function makeGhost(c, st) {
    const best = bestOf(c.id, st); let a, dur, kind = 'best';
    if (best && best.g) { try { a = decode(best.g); if (a.length < 6 || !a.every(Number.isFinite)) a = null; } catch (e) { a = null; } if (a) dur = (a.length / 3 - 1) * DT; }
    if (!a) {                                   // first run: a pace lantern along the course at a modest fixed speed
      kind = 'pace'; const sp = c.pace * (st === 'f' ? 0.6 : 1), path = [c.post.slice(0, 3), ...c.pts]; let L = 0; for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      dur = L / sp; const n = Math.ceil(dur / DT) + 1; a = new Float32Array(n * 3); let seg = 1, acc = 0, segL = Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]);
      for (let i = 0; i < n; i++) {
        const s = Math.min(i * DT * sp, L); while (seg < path.length - 1 && s > acc + segL) { acc += segL; seg++; segL = Math.hypot(path[seg][0] - path[seg - 1][0], path[seg][1] - path[seg - 1][1]); }
        const f = segL > 0 ? Math.min(1, (s - acc) / segL) : 1, A = path[seg - 1], B = path[seg];
        a[i * 3] = A[0] + (B[0] - A[0]) * f; a[i * 3 + 1] = A[1] + (B[1] - A[1]) * f; a[i * 3 + 2] = A[2] + (B[2] - A[2]) * f;
      }
    }
    const sp = [];
    for (let i = 0; i < gcol.length; i++) sp.push(game.props.glow({ x: 0, y: 0, z: 0, color: gcol[i].map((v) => v * (kind === 'pace' ? 0.6 : 1)), size: 0.85 - i * 0.09, visible: false }));
    return { a, dur, sp, kind };
  }
  const tmp = [0, 0, 0];
  function sampleAt(a, t, out) {
    const n = a.length / 3, f = Math.max(0, Math.min(n - 1, t / DT)), i = Math.min(n - 2, Math.floor(f)), u = f - i; if (n < 2) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
    for (let k = 0; k < 3; k++) out[k] = a[i * 3 + k] + (a[i * 3 + 3 + k] - a[i * 3 + k]) * u; return out;
  }
  function drawGhost(gh, t) {
    for (let i = 0; i < gh.sp.length; i++) {
      sampleAt(gh.a, Math.max(0, t - i * 0.13), tmp); const s = gh.sp[i], done = t > gh.dur + 2 && !game.reduceMotion;
      s.set({ x: tmp[0], y: tmp[1], z: tmp[2] + 1.3 + (game.reduceMotion ? 0 : Math.sin(t * 3 + i * 0.7) * 0.12), visible: !done });
    }
  }

  /* ── running a race ── */
  function start(id) {
    const c = COURSES.find((q) => q.id === id); if (!c) return false;
    if (!game.started || player.mode !== 'walk') { game.toast('Trials run in Walk mode.'); return false; }
    if (c.wick && !player.wick) { game.toast('The ' + c.name + ' needs Wick. Press <b>P</b> for the lamplighter.'); return false; }
    if (race) cancel('restart');
    build(); const st = player.wick ? 'w' : 'f'; 
    race = { c, st, phase: 'count', cd: game.reduceMotion ? 0 : 2.4, t: 0, n: 0, splits: [], rec: [], recN: 0, px: player.x, py: player.y, pz: player.z, stray: 0, shown: '', ghost: makeGhost(c, st), mA: marker(), mB: marker(), best: bestOf(c.id, st) };
    place(race.mA, c, 0, true); place(race.mB, c, 1, false);
    if (c.pole !== undefined) { const q = c.cps[c.pole]; race.pole = [game.props.mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.4, 8).translate(0, 1.7, 0), { x: q[0], y: q[1], z: q[2], color: [0.1, 0.1, 0.11] }), game.props.mesh(new THREE.SphereGeometry(0.2, 8, 6).translate(0, 3.5, 0), { x: q[0], y: q[1], z: q[2], emissive: [0.9, 0.55, 0.2], lit: false })]; }
    game.track('trials', c.short + ' · ready', { order: 5 });
    if (!game.reduceMotion) countEl.innerHTML = '3<small>' + c.short + '</small>', countEl.classList.add('on');
    drawGhost(race.ghost, 0);
    return true;
  }
  function end(why) {
    if (!race) return; const r = race; race = null;
    for (const m of [r.mA, r.mB]) { scene.remove(m.grp); m.mat.dispose(); m.bmat.dispose(); m.glow.remove(); }
    for (const s of r.ghost.sp) s.remove();
    if (r.pole) for (const m of r.pole) m.userData.remove();
    game.track('trials', null); countEl.classList.remove('on');
  }
  function cancel(why, say) { if (!race) return; end(why); if (say) game.toast('Race called off.', { ms: 1800 }); }
  function go() {
    race.phase = 'run'; race.t = 0; race.px = player.x; race.py = player.y; race.pz = player.z; race.rec.length = 0; race.recN = 0;
    if (!game.reduceMotion) { countEl.innerHTML = 'Go<small>' + race.c.short + '</small>'; setTimeout(() => countEl.classList.remove('on'), 700); }
    game.emit('trials:start', { course: race.c.id, style: race.st });
  }
  function finish() {
    const r = race, c = r.c, t = +r.t.toFixed(2), prev = r.best, nb = !prev || t < prev.t;
    const medal = medalOf(c, t, r.st), key = c.id + '.' + r.st;
    game.save.update(KEY, (s) => {
      if (!s || typeof s !== 'object' || !s.c || typeof s.c !== 'object') s = { c: {} };
      const e = s.c[key] && typeof s.c[key] === 'object' ? s.c[key] : { runs: 0 }; e.runs = (e.runs | 0) + 1;
      if (nb) { e.t = t; e.sp = r.splits.map((v) => +v.toFixed(1)); e.g = encode(Float32Array.from(r.rec)); e.m = medal; }
      s.c[key] = e; return s;
    }, { c: {} });
    const best = nb ? t : prev.t;
    end('finish');
    const first = !prev, words = first ? 'First time on the board' : nb ? `New best, ${fmt(prev.t - t)} faster` : `Best ${fmt(prev.t)}`;
    game.toast(`<b>${c.short} ${fmt(t)}</b><br>${words} · ${MEDALS[medal]}`, { ms: 7000, tone: 'good' });
    game.emit('trials:finish', { course: c.id, time: t, best, newBest: nb, medal: MEDALS[medal], style: r.st });
    if (game.journal.isOpen) game.journal.refresh();
  }
  function onFrame({ dt }) {
    if (lblT -= dt, lblT < 0) { lblT = 0.5; for (const g of posts.values()) { const d = Math.hypot(g.c.post[0] - player.x, g.c.post[1] - player.y); g.label.visible = d < 60 && d > 7 && player.mode === 'walk'; } }
    if (!race) return;
    const r = race, c = r.c; dt = Math.min(dt, 0.1);
    if (r.phase === 'count') {
      r.cd -= dt; const n = Math.ceil(r.cd / 0.8);
      if (r.cd > 0) { if (!game.reduceMotion && n >= 1 && countEl.firstChild.nodeValue !== String(n)) countEl.firstChild.nodeValue = String(n); r.px = player.x; r.py = player.y; return; }
      go();
    }
    // a jump of tens of metres in one frame is a teleport (the journal's "Take me there", a paper door, a long nap), not running:
    // the path from the old spot to the new one must not pass a ring, and the race is off
    if (Math.hypot(player.x - r.px, player.y - r.py) > 20) { cancel('teleport'); return; }
    r.t += dt;
    while (r.recN * DT <= r.t) { r.rec.push(player.x, player.y, player.z); r.recN++; }
    const cp = c.pts[r.n], hr = cp[3] || 5, hz = cp[4] || 7;
    if (Math.abs(player.z - cp[2]) < hz && segDist(cp[0], cp[1], r.px, r.py, player.x, player.y) < hr) {
      r.n++; r.splits.push(r.t);
      const bs = r.best && r.best.sp && r.best.sp[r.n - 1], d = bs !== undefined ? r.t - bs : null;
      game.emit('trials:checkpoint', { course: c.id, index: r.n, count: c.pts.length, time: +r.t.toFixed(2), best: r.best ? r.best.t : null });
      if (r.n >= c.pts.length) { r.px = player.x; r.py = player.y; finish(); return; }
      game.toast(`<b>${r.n} / ${c.pts.length}</b> ${fmt(r.t)}` + (d === null ? '' : ` <b>${d <= 0 ? '' : '+'}${d.toFixed(1)}</b>`), { ms: 1900, tone: d !== null && d <= 0 ? 'good' : '' });
      place(r.mA, c, r.n, true); place(r.mB, c, r.n + 1, false);
    }
    r.px = player.x; r.py = player.y;
    drawGhost(r.ghost, r.t);
    const txt = `${c.short} ${fmt(r.t)} · ${r.n} / ${c.pts.length}`; if (txt !== r.shown) { r.shown = txt; game.track('trials', txt, { order: 5 }); }
    if ((r.stray -= dt) < 0) {            // far from the course: the race lapses
      r.stray = 0.5; let m = Infinity; const pts = [c.post, ...c.pts];
      for (let i = 1; i < pts.length; i++) m = Math.min(m, segDist(player.x, player.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
      if (m > c.stray) cancel('stray');
    }
  }
  game.on('frame', onFrame);
  game.on('mode', () => cancel('mode'));
  game.on('camera', (e) => { if (e.held) cancel('camera'); });

  /* ── journal ── */
  game.journal.section({
    id: 'trials', title: 'Trials', order: 40,
    render(el) {
      for (const c of COURSES) {
        const w = bestOf(c.id, 'w'), f = bestOf(c.id, 'f'), row = document.createElement('div'); row.className = 'tr-row';
        const line = (b, tag) => `<span class="tr-t">${fmt(b.t)}</span> · ${MEDALS[b.m] || MEDALS[medalOf(c, b.t, tag)]}${tag === 'f' ? ' (first person)' : ''}`;
        row.innerHTML = `<b>${c.name}</b>${c.wick ? ' <span class="tr-sub">Wick only</span>' : ''}<br>` + (w ? line(w, 'w') + (f ? '<br>' + line(f, 'f') : '') : f ? line(f, 'f') : '<span class="tr-sub">No time yet. Bronze for finishing, silver ' + fmt(c.medals.silver) + ', gold ' + fmt(c.medals.gold) + '.</span>') +
          `<div class="tr-sub">${c.blurb} Start post: ${c.where}.</div>`;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-go'; b.textContent = 'Take me there';
        b.addEventListener('click', () => { game.journal.close(); game.teleport(c.post[0] - Math.cos(c.post[3]) * 3, c.post[1] - Math.sin(c.post[3]) * 3, c.post[3]); });
        row.appendChild(b); el.appendChild(row);
      }
    },
  });
  return {
    courses: COURSES, start, cancel: (why) => cancel(why || 'api'), get race() { return race && { course: race.c.id, phase: race.phase, t: race.t, n: race.n, style: race.st, ghost: race.ghost.kind }; },
    best: (id, st = 'w') => bestOf(id, st), posts, encode, decode, medalOf,
  };
}
