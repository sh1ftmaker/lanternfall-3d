// lamps: light the park. Dark lamps (run-time props; the park's own lamps are baked) that Wick lights with the pole, counts per land,
// the extra lamp in the tavern, the lamplighter before Wick, and the visitor's own wish lantern at the lake rail. See README.md.
import { LAMPS } from './positions.js';
import { TRAIL, NOTE, HIDDEN } from './story.js';

const STYLE = {   // per land: [post height m, head width, head height, colour rgb 0-1 (linear-ish)]
  guildhollow: [2.2, 1.0, 0.8, [1.0, 0.36, 0.2]], frostmere: [2.5, 0.8, 1.15, [0.6, 0.85, 1.0]], meridian: [2.9, 0.7, 1.3, [0.3, 1.0, 0.85]],
  wanderers: [2.3, 1.1, 1.0, [0.72, 0.55, 1.0]], brinewatch: [1.9, 0.9, 1.0, [1.0, 0.72, 0.28]], 'lantern-row': [2.4, 1.0, 1.1, [1.0, 0.6, 0.2]],
  rosewick: [2.6, 1.1, 0.9, [1.0, 0.5, 0.65]],
};
const DIRS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
const CSS = `
#lamps-wish,#lamps-card{left:50%;right:auto;transform:translateX(-50%);width:min(380px,calc(100vw - 32px));top:calc(env(safe-area-inset-top,0px) + 80px)}
#lamps-wish input{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(7,6,26,.6);color:var(--paper);font:400 16px var(--ui)}
#lamps-wish input:focus{outline:2px solid var(--amber);outline-offset:1px}
#lamps-wish .lw-row{display:flex;justify-content:space-between;gap:10px;margin:6px 2px 10px;font:400 12px var(--ui);color:var(--muted)}
#lamps-wish .lw-btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
#lamps-wish button.lw,#lamps-card button.lw{appearance:none;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--paper);font:500 14px var(--ui);padding:9px 16px;cursor:pointer;min-height:40px}
#lamps-wish button.go{border-color:rgba(255,181,71,.8);background:rgba(255,181,71,.18);font-weight:600}
#lamps-card{background:rgba(245,236,220,.95);color:#2a2018;border-color:rgba(255,181,71,.6)} #lamps-card h2{color:#5a3a12}
#lamps-card p{margin:0 0 9px;font:400 15px/1.5 var(--display,Georgia,serif)} #lamps-card .sg{font-style:italic;text-align:right} #lamps-card .sheet-close{color:#5a3a12}
#lamps-card button.lw{color:#2a2018;border-color:#8a6a3a}
.gj-lamps .row{display:flex;justify-content:space-between;gap:8px} .gj-lamps .done{color:var(--amber)} .gj-lamps small{display:block;opacity:.75;font-size:12.5px;margin:2px 0 6px}
.gj-lamps em{opacity:.8}
`;

export function init(game) {
  const { THREE, scene, camera } = game;
  const hash = game.hash;
  const lands = game.manifest.lands, landBy = Object.fromEntries(lands.map((l) => [l.id, l]));
  const st = game.save.get('lamps', null) || {};
  st.lit = st.lit || []; st.read = st.read || []; st.done = st.done || []; st.wishes = st.wishes || []; st.all = !!st.all; st.pole = !!st.pole;
  const persist = () => game.save.set('lamps', st);
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  /* ── the lamp table ── */
  const L = [], byId = {};
  const trailAt = (land, k) => TRAIL.find((t) => t.land === land && t.k === k);
  for (const land of Object.keys(LAMPS)) LAMPS[land].forEach(([x, y, z], k) => { const t = trailAt(land, k); L.push({ id: land + ':' + k, land, k, x, y, z, ini: t ? t.n : 0, hidden: false, lit: false, litAt: -1 }); });
  L.push({ id: HIDDEN.land + ':8', land: HIDDEN.land, k: 8, x: HIDDEN.at[0], y: HIDDEN.at[1], z: HIDDEN.at[2], ini: 0, hidden: true, lit: false, litAt: -1 });
  L.forEach((l, i) => { l.i = i; byId[l.id] = l; l.lit = st.lit.includes(l.id); });
  const total = (land) => L.filter((l) => l.land === land).length;
  const count = (land) => L.filter((l) => l.land === land && l.lit).length;
  const countAll = () => L.filter((l) => l.lit).length;
  const nameOf = (id) => (landBy[id] ? landBy[id].name : id);

  /* ── instanced posts and heads ── */
  const N = L.length, tmp = new THREE.Object3D(), col = new THREE.Color();
  const postG = new THREE.CylinderGeometry(0.04, 0.07, 1, 6).translate(0, 0.5, 0);
  const lathe = [[0.001, 0], [0.13, 0], [0.13, 0.04], [0.28, 0.1], [0.37, 0.34], [0.38, 0.5], [0.36, 0.7], [0.27, 0.92], [0.13, 0.96], [0.13, 1], [0.001, 1]].map(([a, b]) => new THREE.Vector2(a, b));
  const headG = new THREE.LatheGeometry(lathe, 8); headG.scale(1, 0.5, 1);
  { const p = headG.attributes.position, c = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { const y = p.getY(i), v = (y < 0.021 || y > 0.479) ? 0.1 : 1; c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; } headG.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
  const mk = (g, mat, n) => { const m = new THREE.InstancedMesh(g, mat, n); m.frustumCulled = false; m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); scene.add(m); return m; };
  const posts = mk(postG, new THREE.MeshBasicMaterial({ fog: false }), N);
  const heads = mk(headG, new THREE.MeshBasicMaterial({ fog: false, vertexColors: true }), N);
  const tint = new Float32Array(N * 3).fill(0.3); let tinted = 0, tintTries = 0;
  const styleOf = (l) => STYLE[l.land] || STYLE['lantern-row'];
  L.forEach((l) => {
    const [h, w, hh] = styleOf(l);
    tmp.position.set(l.x, l.z, -l.y); tmp.rotation.set(0, 0, 0); tmp.scale.set(1, h, 1); tmp.updateMatrix(); posts.setMatrixAt(l.i, tmp.matrix);
    tmp.position.set(l.x, l.z + h - 0.02, -l.y); tmp.rotation.y = l.i * 1.3; tmp.scale.set(w, hh, w); tmp.updateMatrix(); heads.setMatrixAt(l.i, tmp.matrix);
  });
  posts.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  function paint(l, e = 0) {      // e: 0 dark paper .. 1 lit; > 1 flare
    const s = styleOf(l)[3], k = tint[l.i * 3];
    posts.setColorAt(l.i, col.setRGB(0.05 * (k + 0.03), 0.04 * (k + 0.03), 0.03 * (k + 0.03)));
    const dark = 0.012 + k * 0.12, lit = 1.7 * e;
    heads.setColorAt(l.i, col.setRGB(s[0] * dark * (1 - Math.min(1, e)) + (s[0] * 0.5 + 0.55) * lit, s[1] * dark * (1 - Math.min(1, e)) + (s[1] * 0.5 + 0.35) * lit, s[2] * dark * (1 - Math.min(1, e)) + (s[2] * 0.4 + 0.15) * lit));
  }
  const paintAll = () => { L.forEach((l) => paint(l, l.lit ? 1 : 0)); posts.instanceColor.needsUpdate = heads.instanceColor.needsUpdate = true; };
  function retint() {      // the baked light grid arrives late: tint each lamp by the light that reaches its foot, once
    let ok = true;
    for (const l of L) { if (tint[l.i * 3 + 1] > 0) continue; const b = game.lightAt(l.x, l.y); if (!b) { ok = false; continue; } tint[l.i * 3] = Math.min(0.35, 0.08 + (b[0] + b[1] + b[2]) / 3 * 1.2); tint[l.i * 3 + 1] = 1; }
    paintAll(); return ok;
  }
  paintAll();

  /* ── pools of light under the lit lamps (one instanced disc mesh), glows near the visitor (pooled sprites) ── */
  const discTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const discs = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: discTex, color: new THREE.Color(0.55, 0.32, 0.12), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), N);
  discs.frustumCulled = false; discs.renderOrder = 7; discs.count = 0; scene.add(discs);
  const discOrder = []; // lit lamps in the order of their disc slot
  function setDisc(slot, l, s) { tmp.position.set(l.x, l.z + 0.05, -l.y); tmp.rotation.set(0, 0, 0); tmp.scale.setScalar(s * 3.4); tmp.updateMatrix(); discs.setMatrixAt(slot, tmp.matrix); }
  function rebuildDiscs() { discOrder.length = 0; for (const l of L) if (l.lit) { setDisc(discOrder.length, l, l.litAt >= 0 && now() - l.litAt < 1 ? Math.min(1, (now() - l.litAt)) : 1); discOrder.push(l); } discs.count = discOrder.length; discs.instanceMatrix.needsUpdate = true; }
  const POOL = 12, glows = [];
  const glowSize = (l) => 1.7 * (styleOf(l)[2] * 0.5 + 0.5), glowCol = (l) => { const s = styleOf(l)[3]; return [0.6 + s[0] * 0.35, 0.38 + s[1] * 0.22, 0.16 + s[2] * 0.15]; };
  const gl = () => { while (glows.length < POOL) glows.push({ h: game.props.glow({ x: 0, y: 0, z: -100, size: 2.6, visible: false }), at: null }); };
  let glowT = 0;
  function assignGlows() {
    gl(); const lit = L.filter((l) => l.lit), p = game.player;
    lit.sort((a, b) => ((a.x - p.x) ** 2 + (a.y - p.y) ** 2) - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2));
    glows.forEach((g, i) => { const l = lit[i]; g.at = l && ((l.x - p.x) ** 2 + (l.y - p.y) ** 2 < 150 * 150) ? l : null; if (g.at) { const [h] = styleOf(g.at); g.h.set({ x: g.at.x, y: g.at.y, z: g.at.z + h + 0.2, color: glowCol(g.at), size: glowSize(g.at), visible: true }); } else g.h.set({ visible: false }); });
  }

  /* ── sparks: one Points object, a ring buffer of 160 ── */
  const SP = 160, spPos = new Float32Array(SP * 3).fill(-1e4), spV = new Float32Array(SP * 3), spLife = new Float32Array(SP), spAge = new Float32Array(SP).fill(99); let spN = 0, spLive = 0;
  const spGeo = new THREE.BufferGeometry(); spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
  const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ size: 0.14, color: new THREE.Color(2.2, 1.3, 0.5), sizeAttenuation: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  sparks.frustumCulled = false; sparks.visible = false; sparks.renderOrder = 9; scene.add(sparks);
  function burst(x, y, z, n = 26) {
    if (game.reduceMotion) n = 8;
    for (let i = 0; i < n; i++) { const k = spN++ % SP, a = Math.random() * 6.283, r = Math.random() * 0.35;
      spPos[k * 3] = x + Math.cos(a) * r; spPos[k * 3 + 1] = z; spPos[k * 3 + 2] = -(y + Math.sin(a) * r);
      spV[k * 3] = Math.cos(a) * (0.2 + Math.random() * 0.7); spV[k * 3 + 1] = 0.7 + Math.random() * 1.6; spV[k * 3 + 2] = -Math.sin(a) * (0.2 + Math.random() * 0.7); spLife[k] = 1.3 + Math.random() * 1.4; spAge[k] = 0; }
    spLive = 4; sparks.visible = true;
  }
  function stepSparks(dt) {
    if (!spLive) return; let any = false;
    for (let k = 0; k < SP; k++) { if (spAge[k] >= spLife[k]) continue; spAge[k] += dt; if (spAge[k] >= spLife[k]) { spPos[k * 3 + 1] = -1e4; continue; } any = true;
      spPos[k * 3] += spV[k * 3] * dt; spPos[k * 3 + 1] += spV[k * 3 + 1] * dt; spPos[k * 3 + 2] += spV[k * 3 + 2] * dt; spV[k * 3] *= 1 - dt * 0.8; spV[k * 3 + 2] *= 1 - dt * 0.8; spV[k * 3 + 1] *= 1 - dt * 0.25; }
    spGeo.attributes.position.needsUpdate = true; if (!any) { if ((spLive -= dt) <= 0) { sparks.visible = false; spLive = 0; } } else spLive = 4;
  }

  /* ── floaters: small paper lanterns (celebration bursts, the finale, your wish, past wishes hanging over the lake) ── */
  const FN = 240, fl = { x: new Float32Array(FN), y: new Float32Array(FN), z: new Float32Array(FN), vz: new Float32Array(FN), age: new Float32Array(FN).fill(1e9), life: new Float32Array(FN), s: new Float32Array(FN), seed: new Float32Array(FN), hang: new Uint8Array(FN), delay: new Float32Array(FN) };
  const flM = mk(new THREE.CylinderGeometry(0.2, 0.15, 0.34, 6).translate(0, 0.17, 0), new THREE.MeshBasicMaterial({ fog: false }), FN); flM.count = 0; let flTop = 0, flBusy = 0;
  const hide = (i) => { tmp.position.set(0, -1e4, 0); tmp.scale.setScalar(0.0001); tmp.updateMatrix(); flM.setMatrixAt(i, tmp.matrix); };
  for (let i = 0; i < FN; i++) hide(i);
  function floater(x, y, z, { vz = 2, life = 14, s = 1, c = [1.5, 0.9, 0.4], hang = 0, delay = 0 } = {}) {
    let i = -1; for (let k = 0; k < FN; k++) if (fl.age[k] >= fl.life[k] && !fl.hang[k]) { i = k; break; } if (i < 0) return -1;
    fl.x[i] = x; fl.y[i] = y; fl.z[i] = z; fl.vz[i] = vz; fl.age[i] = -delay; fl.life[i] = life; fl.s[i] = s; fl.seed[i] = Math.random() * 100; fl.hang[i] = hang;
    flM.setColorAt(i, col.setRGB(c[0], c[1], c[2])); flM.instanceColor.needsUpdate = true; flTop = Math.max(flTop, i + 1); flM.count = flTop; flBusy++; return i;
  }
  function stepFloaters(dt, time) {
    if (!flBusy) return; let busy = 0;
    for (let i = 0; i < flTop; i++) {
      if (fl.age[i] >= fl.life[i] && !fl.hang[i]) continue; fl.age[i] += dt; const a = fl.age[i];
      if (a < 0) { busy++; continue; }
      let s = fl.s[i], x = fl.x[i], y = fl.y[i], z = fl.z[i];
      if (fl.hang[i]) { z += Math.sin(time * 0.7 + fl.seed[i]) * 0.18; x += Math.sin(time * 0.31 + fl.seed[i] * 2) * 0.4; s *= Math.min(1, a * 0.8); busy++; }
      else {
        if (a >= fl.life[i]) { hide(i); continue; } busy++;
        const k = a * fl.vz[i]; z = fl.z[i] + k; x += Math.sin(a * 0.5 + fl.seed[i]) * 2.2 + a * 0.35; y += Math.cos(a * 0.4 + fl.seed[i] * 1.7) * 1.6;
        s *= Math.min(1, a * 1.2) * Math.min(1, (fl.life[i] - a) / 3);
      }
      tmp.position.set(x, z, -y); tmp.rotation.set(0, a * 0.3 + fl.seed[i], 0); tmp.scale.setScalar(Math.max(s, 0.0001)); tmp.updateMatrix(); flM.setMatrixAt(i, tmp.matrix);
    }
    flBusy = busy; flM.instanceMatrix.needsUpdate = true;
  }
  const landCol = (id, k = 1.6) => { const s = (STYLE[id] || STYLE['lantern-row'])[3]; return [s[0] * k + 0.4, s[1] * k + 0.25, s[2] * k + 0.15]; };
  function celebrate(land) {
    const c = landBy[land]; if (!c) return; const [cx, cy] = c.center, z0 = game.ground(cx, cy) ?? 0;
    for (let i = 0; i < 40; i++) { const a = Math.random() * 6.283, r = Math.random() * 14; floater(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0 + 1, { vz: 2.2 + Math.random() * 1.8, life: 12 + Math.random() * 5, s: 0.9 + Math.random() * 0.5, c: landCol(land), delay: Math.random() * 6 }); }
  }
  function finale() {
    for (let i = 0; i < 110; i++) { const a = Math.random() * 6.283, r = 20 + Math.random() * 70; floater(Math.cos(a) * r, Math.sin(a) * r, -0.3, { vz: 1.8 + Math.random() * 2.4, life: 22 + Math.random() * 8, s: 1 + Math.random() * 0.8, c: [1.7 + Math.random() * 0.8, 0.9 + Math.random() * 0.5, 0.35], delay: Math.random() * 10 }); }
  }

  /* ── lighting a lamp ── */
  const now = () => performance.now() / 1000;
  const flaring = new Set();
  function light(l, { silent = false } = {}) {
    if (l.lit) return false; l.lit = true; l.litAt = silent ? -1 : now(); st.lit.push(l.id); persist();
    if (!silent) { flaring.add(l); const [h] = styleOf(l); burst(l.x, l.y, l.z + h + 0.1); game.sound?.('lantern_release', game.v3(l.x, l.y, l.z + 1.5)); } else paint(l, 1);
    rebuildDiscs(); assignGlows(); posts.instanceColor.needsUpdate = heads.instanceColor.needsUpdate = true;
    if (silent) return true;
    const c = count(l.land), t = total(l.land);
    game.emit('lamps:lit', { id: l.id, land: l.land, count: c, total: t });
    if (l.hidden) revealPole();
    const complete = c >= t;
    if (complete && !st.done.includes(l.land)) { st.done.push(l.land); persist(); game.toast(`<b>${nameOf(l.land)} is lit.</b> Every lamp, every corner.`, { ms: 6000, tone: 'good' }); celebrate(l.land); game.emit('lamps:land', { land: l.land }); }
    else if (!l.hidden) game.toast(`<b>Lamp lit</b> · ${nameOf(l.land)} ${c} / ${t}`, { ms: 2600, tone: 'good' });
    if (countAll() >= L.length && !st.all) { st.all = true; persist(); setTimeout(() => { game.toast('<b>The whole park is lit.</b> Look at the lake.', { ms: 8000, tone: 'good' }); finale(); }, 2500); game.emit('lamps:all', {}); }
    game.journal.refresh(); updateTrack(true); return true;
  }
  function read(l) {
    const t = TRAIL.find((x) => x.n === l.ini); if (!t) return;
    game.toast(`<b>${t.who}</b><br><i>${t.line}</i>`, { ms: 7500 });
    if (!st.read.includes(t.n)) { st.read.push(t.n); persist(); game.emit('lamps:read', { n: t.n }); game.journal.refresh(); }
  }
  L.forEach((l) => {
    const [h] = styleOf(l);
    l.it = game.interact({ id: 'lamp:' + l.id, x: l.x, y: l.y, z: l.z + 1.2, r: 2.4,
      label: () => (l.lit ? 'Look closer' : 'Light the lamp'), show: () => !l.lit || l.ini > 0,
      use: () => { if (!l.lit) light(l); else read(l); } });
  });
  // a lit scratched post is read by tapping the prompt or E, not by an accidental swing
  game.on('lamps:lit', ({ id }) => { const l = byId[id]; if (l) l.it.swing = false; });
  L.forEach((l) => { if (l.lit) l.it.swing = false; });

  /* ── the old pole in the hearth corner and the note ── */
  let pole = null, poleIt = null;
  const card = document.createElement('div'); card.id = 'lamps-card'; card.className = 'sheet'; card.hidden = true; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'A note');
  card.innerHTML = `<div class="sheet-head"><h2>${NOTE.title}</h2><button type="button" class="sheet-close" aria-label="Close the note">&times;</button></div>${NOTE.body.map((p) => `<p>${p}</p>`).join('')}<p class="sg">${NOTE.sign}</p><button type="button" class="lw">Put it back</button>`;
  const closeCard = () => { card.hidden = true; };
  card.querySelector('.sheet-close').onclick = card.querySelector('.lw').onclick = closeCard;
  function revealPole() {
    if (pole) return; const [x, y, z] = HIDDEN.pole, g = new THREE.Group(), dark = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.07, 0.045, 0.03), fog: false });
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 2.3, 6).translate(0, 1.15, 0), dark); rod.rotation.z = -0.22; g.add(rod);
    const hd = new THREE.Mesh(headG, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.4, 0.14), vertexColors: true, fog: false })); hd.position.set(-0.5, 2.22, 0); hd.scale.set(0.8, 0.8, 0.8); hd.rotation.z = -0.22; g.add(hd);
    g.position.set(x, z, -y); g.rotation.y = 0.6; scene.add(g); pole = g;
    poleIt = game.interact({ id: 'lamps:note', x, y, z: z + 1, r: 2.2, label: 'Read the note', swing: false, use: () => { card.hidden = false; if (!st.pole) { st.pole = true; persist(); game.emit('lamps:pole', {}); game.journal.refresh(); } } });
    if (!st.pole) game.toast('<b>An old lantern pole</b> leans in the corner by the fire. There is a note.', { ms: 6500 });
  }
  if (byId[HIDDEN.land + ':8'].lit) revealPole();

  /* ── the lake rail: write a wish ── */
  const wish = document.createElement('div'); wish.id = 'lamps-wish'; wish.className = 'sheet'; wish.hidden = true; wish.setAttribute('role', 'dialog'); wish.setAttribute('aria-label', 'Write a wish');
  wish.innerHTML = '<div class="sheet-head"><h2>Write a wish</h2><button type="button" class="sheet-close" aria-label="Cancel">&times;</button></div><input type="text" maxlength="80" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" placeholder="A few words for the lake" aria-label="Your wish"><div class="lw-row"><span>Kept on this device. Nothing is sent.</span><span class="n">0 / 80</span></div><div class="lw-btns"><button type="button" class="lw rd">Read your wishes</button><button type="button" class="lw go">Release</button></div>';
  document.body.append(wish, card);
  const winp = wish.querySelector('input'), wn = wish.querySelector('.n'); let railAt = null;
  const closeWish = () => { wish.hidden = true; winp.blur(); };
  function openWish() { if (!railAt) return; document.exitPointerLock?.(); wish.hidden = false; wish.querySelector('.rd').hidden = !st.wishes.length; winp.value = ''; wn.textContent = '0 / 80'; setTimeout(() => winp.focus(), 50); }
  function release() {
    const text = winp.value.trim().slice(0, 80); if (!text) { winp.focus(); return; }
    const w = { t: Date.now(), text }; st.wishes.unshift(w); st.wishes = st.wishes.slice(0, 12); persist(); closeWish();
    const p = railAt || game.player, yaw = railAt ? railAt.yaw : game.player.yaw;
    floater(p.x + Math.cos(yaw) * 1.4, p.y + Math.sin(yaw) * 1.4, (p.z || 0) + 1.1, { vz: 3.2, life: 30, s: 1.5, c: [3, 1.7, 0.6] });
    game.sound?.('lantern_release', game.v3(p.x, p.y, 1.5)); game.toast('<b>Released.</b> It rises over the water and joins the others.', { ms: 5200, tone: 'good' }); game.emit('lamps:wish', { text, t: w.t }); game.journal.refresh();
  }
  winp.addEventListener('input', () => { wn.textContent = winp.value.length + ' / 80'; });
  winp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); release(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWish(); } });
  wish.querySelector('.go').onclick = release; wish.querySelector('.sheet-close').onclick = closeWish;
  wish.querySelector('.rd').onclick = () => { closeWish(); game.journal.open(); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !card.hidden) closeCard(); }, true);
  let rail = [];
  const railIt = game.interact({ id: 'lamps:wish', x: 0, y: 0, z: 0, r: 3, label: 'Write a wish', swing: false, show: () => !!railAt && wish.hidden && !game.cameraHeld, use: openWish });
  fetch(game.ctx.DATA + 'guests.json').then((r) => r.json()).then((d) => { rail = d.pois.filter((p) => p.land === 'core' && p.type === 'view' && p.rail); }).catch(() => {});
  let railT = 0;
  function updateRail() {
    const p = game.player; railAt = null; let bd = 1e9;
    if (p.mode === 'walk') for (const q of rail) { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; railAt = q; } }
    if (railAt && bd > 3.2 * 3.2) railAt = null; if (railAt) railIt.move(railAt.x, railAt.y, railAt.z ?? 0);
  }
  // past wishes hang low over the lake, a little brighter than the rest
  const hung = [];
  function hangWishes() {
    for (const i of hung) { fl.hang[i] = 0; fl.age[i] = fl.life[i] = 0; hide(i); } hung.length = 0;
    st.wishes.forEach((w) => { const r1 = Math.abs(Math.sin(w.t * 0.000013)), r2 = Math.abs(Math.sin(w.t * 0.000007 + 2)), a = (w.t * 0.00031) % 6.283, rad = 32 + r1 * 52;
      const i = floater(Math.cos(a) * rad, Math.sin(a) * rad, 2.6 + r2 * 3, { hang: 1, life: 1e9, s: 1.15, c: [2.6, 1.55, 0.6] }); if (i >= 0) hung.push(i); });
  }
  hangWishes(); game.on('lamps:wish', hangWishes);

  /* ── tracker and journal ── */
  const dirName = (dx, dy) => DIRS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
  const landNow = () => {
    const p = game.player; if (p.mode !== 'walk') return null; if (landBy[p.land]) return p.land;
    let best = null, bd = 95 * 95; for (const l of lands) { const d = (l.center[0] - p.x) ** 2 + (l.center[1] - p.y) ** 2; if (d < bd) { bd = d; best = l.id; } } return best;
  };
  function nearestDark(land) { const p = game.player; let best = null, bd = 1e12; for (const l of L) if (l.land === land && !l.lit && !l.hidden) { const d = (l.x - p.x) ** 2 + (l.y - p.y) ** 2; if (d < bd) { bd = d; best = l; } } return best && { l: best, d: Math.sqrt(bd) }; }
  const approx = (d) => (d < 12 ? 'close by' : d < 100 ? `about ${Math.round(d / 5) * 5} m` : `about ${Math.round(d / 10) * 10} m`);
  const hintFor = (land) => {
    const n = nearestDark(land);
    if (!n) return count(land) >= total(land) ? 'Every lamp here is lit.' : 'The streets are lit. One more lamp is somewhere it should not be.';
    const p = game.player, up = n.l.z - p.z > 1.1 ? ', up high' : '';
    return `Nearest dark lamp: ${approx(n.d)} ${n.d < 12 ? '' : 'to the ' + dirName(n.l.x - p.x, n.l.y - p.y)}${up}.`.replace('  ', ' ');
  };
  let trackKey = '';
  function updateTrack(force) {
    const land = landNow(); const n = land ? nearestDark(land) : null;
    const key = land ? land + count(land) + (n && n.d < 45 ? 'n' : '') : ''; if (key === trackKey && !force) return; trackKey = key;
    game.track('lamps', land ? `${nameOf(land)} lamps ${count(land)} / ${total(land)}` : null, { order: n && n.d < 45 ? 25 : 70 });
  }
  game.journal.section({ id: 'lamps', title: 'Lamps', order: 20, render(el) {
    el.className += ' gj-lamps'; const here = landNow();
    el.innerHTML = lands.map((l) => `<div class="row${count(l.id) >= total(l.id) ? ' done' : ''}"><span>${l.name}</span><span>${count(l.id)} / ${total(l.id)}</span></div>`).join('') + `<small>${countAll()} of ${L.length} lit.${here ? ' ' + hintFor(here) : ''}</small>`;
  } });
  game.journal.section({ id: 'lamps-trail', title: 'The lamplighter before you', order: 21, render(el) {
    el.className += ' gj-lamps';
    if (!st.read.length && !st.pole) { el.innerHTML = '<span class="gj-empty">Some lamp posts have initials scratched low on the wood. Light one, then look closer.</span>'; return; }
    el.innerHTML = TRAIL.map((t) => st.read.includes(t.n) ? `<small><b>${t.who}</b><br><em>${t.line}</em></small>` : `<small>${'?'} · not found yet</small>`).join('') + (st.pole ? '<small><b>The note</b>: found by the fire in the Brine & Barrel.</small>' : '');
    el.querySelectorAll('small').forEach((s) => { s.style.margin = '0 0 5px'; });
  } });
  game.journal.section({ id: 'lamps-wish', title: 'Wish lanterns', order: 22, render(el) {
    el.className += ' gj-lamps';
    el.innerHTML = st.wishes.length ? st.wishes.map((w) => `<small><b>${new Date(w.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</b> · ${w.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</small>`).join('') : '<span class="gj-empty">At the rail round the lake you can write a wish and let it go.</span>';
  } });

  /* ── per frame ── */
  let t = 0;
  game.on('frame', ({ dt, time }) => {
    t += dt;
    if (flaring.size) {
      for (const l of flaring) { const a = now() - l.litAt; if (a > 1.6) { flaring.delete(l); paint(l, 1); setDisc(discOrder.indexOf(l), l, 1); continue; } paint(l, Math.min(1, a / 0.5) + 1.4 * Math.exp(-a * 2.4) * Math.min(1, a * 8)); const s = Math.min(1, a); setDisc(discOrder.indexOf(l), l, s * s * (3 - 2 * s)); }
      posts.instanceColor.needsUpdate = heads.instanceColor.needsUpdate = discs.instanceMatrix.needsUpdate = true;
    }
    stepSparks(dt); stepFloaters(dt, time);
    for (const g of glows) if (g.at) { const f = flaring.has(g.at) ? 1 + 1.8 * Math.exp(-(now() - g.at.litAt) * 2.2) : 1; g.h.set({ size: glowSize(g.at) * f * (1 + 0.05 * Math.sin(time * 7 + g.at.i * 1.7) + 0.03 * Math.sin(time * 13 + g.at.i)) }); }
    if ((glowT -= dt) < 0) { glowT = 0.35; assignGlows(); if (tintTries < 40 && !tinted) { tintTries++; if (retint()) tinted = 1; } updateTrack(); }
    if ((railT -= dt) < 0) { railT = 0.2; updateRail(); }
  });
  game.on('mode', ({ mode }) => { if (mode !== 'walk') { game.track('lamps', null); trackKey = ''; closeWish(); closeCard(); } });
  rebuildDiscs(); assignGlows();

  return {
    lamps: L, byId, lit: countAll, count, total, state: st, light, read, celebrate, finale, burst, floater, railPoints: () => rail, openWish, release, hung: () => hung.length, flBusy: () => flBusy,
    // tests: light every lamp of a land except one, silently (no toast, no events)
    lightAllBut(land, except) { for (const l of L) if (l.land === land && l.id !== except && !l.lit) light(l, { silent: true }); game.journal.refresh(); updateTrack(true); },
    lightAll() { for (const l of L) light(l, { silent: true }); },
  };
}
