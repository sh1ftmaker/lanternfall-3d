// 4. The guest in the red coat: always a little ahead. In each land a figure stands at a fixed vantage looking at you, visible from a
// distance; it is gone (faded, never popped) once you come within about 12 m or look away for long. Seen in all seven lands, it
// appears once more at the lake rail facing the Spire and leaves a red button on the rail.
import { buildFigure, RED_COAT } from './figure.js';

// land-local vantage (lx, ly): along the land's axis, a little way in from the promenade where the visitor arrives
const VANTAGE = {
  wanderers: [3, -14], meridian: [0, -12], frostmere: [0, -3], guildhollow: [0, 2], rosewick: [2, 3], 'lantern-row': [-4, 14], brinewatch: [-3, 0],
};
const RAIL = { world: [85.5, 31.1] };                           // the lake rail at the Spire viewpoint (north-east of the avenue); the Spire is straight ahead
const SHOW_MAX = 95, GONE = 12, CONE = Math.cos(0.75), OFF = Math.cos(1.25), LOOK_AWAY = 2.8, SEEN_T = 1.4;

export function init(S) {
  const { game, lib, THREE } = S;
  const geo = buildFigure(THREE, RED_COAT);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: true });
  const fig = new THREE.Mesh(geo, mat); fig.visible = false; fig.frustumCulled = false; fig.renderOrder = 6; game.scene.add(fig);
  const spots = []; let rail = null, button = null, cur = null, op = 0, offT = 0, viewT = 0, vanishing = false, ready = false;
  const fwd = new THREE.Vector3(), tmp = new THREE.Vector3();
  const coat = () => { const c = S.state().coat; return c && typeof c === 'object' && Array.isArray(c.seen) ? c : { seen: [], button: (c && c.button) || null }; };
  const saveCoat = (c) => S.put({ coat: c });

  // fix the vantage points on the walk grid once the park is in (nearest cell with ground)
  function setup() {
    for (const l of game.manifest.lands) {
      const [lx, ly] = VANTAGE[l.id] || [0, 8]; let best = null;
      for (let r = 0; r <= 14 && !best; r += 1) for (let k = 0; k < Math.max(1, r * 4) && !best; k++) {
        const a = k / Math.max(1, r * 4) * 6.283, w = lib.world(l.id, lx + Math.cos(a) * r, ly + Math.sin(a) * r), h = game.ground(w[0], w[1]);
        if (h !== null && game.ground(w[0] + 0.7, w[1]) !== null && game.ground(w[0] - 0.7, w[1]) !== null && game.ground(w[0], w[1] + 0.7) !== null && game.ground(w[0], w[1] - 0.7) !== null) best = { x: w[0], y: w[1], z: h };
      }
      if (best) spots.push({ id: l.id, ...best, tint: null });
    }
    const gz = game.ground(RAIL.world[0], RAIL.world[1]);
    rail = { id: 'rail', x: RAIL.world[0], y: RAIL.world[1], z: gz ?? 0.1, face: Math.atan2(-RAIL.world[1], -RAIL.world[0]), tint: null };
    ready = true; restoreButton();
  }
  function tintAt(s) {                                          // lit once by the baked light there, like props.mesh, but never darker than a faint glow
    const L = game.lightAt(s.x, s.y), k = L ? [L[0] + 0.05, L[1] + 0.05, L[2] + 0.07] : [0.3, 0.26, 0.24];
    const m = Math.max(k[0], k[1], k[2]), f = m < 0.9 ? 0.9 / m : 1;
    return (s.tint = new THREE.Color(Math.min(1.6, k[0] * f), Math.min(1.6, k[1] * f), Math.min(1.6, k[2] * f)));
  }
  function show(s) {
    cur = s; vanishing = false; offT = 0; viewT = 0;
    mat.color.copy(s.tint || tintAt(s)); game.v3(s.x, s.y, s.z, fig.position); fig.visible = true;
    if (s.face !== undefined) fig.rotation.y = faceY(s.face);
  }
  const faceY = (yaw) => Math.atan2(Math.cos(yaw), -Math.sin(yaw));          // Blender yaw (x,y) -> rotation about three.js y for a figure whose front is +z
  const turn = (a, b, k) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * k; };
  function hide() { cur = null; fig.visible = false; op = 0; mat.opacity = 0; }

  function restoreButton() {
    const c = coat(); if (c.button !== 'left' || button) return;
    placeButton();
  }
  function placeButton() {
    if (button || !rail) return;
    const dx = Math.cos(rail.face), dy = Math.sin(rail.face), x = rail.x + dx * 0.8, y = rail.y + dy * 0.8, z = rail.z + 0.13;
    const g = new THREE.CylinderGeometry(0.07, 0.07, 0.025, 14);
    const m = game.props.mesh(g, { x, y, z, color: [0.6, 0.02, 0.03], emissive: [0.9, 0.05, 0.06], lit: false });
    const glow = game.props.glow({ x, y, z: z + 0.05, color: [0.6, 0.04, 0.04], size: 0.6 });
    const it = game.interact({ id: 'secrets-button', x, y, z, r: 2.2, label: 'Pick up the red button', use() { take(); } });
    button = { m, glow, it, x, y, z };
  }
  function take() {
    if (!button) return;
    button.it.remove(); button.m.userData.remove(); button.glow.remove(); button = null;
    const c = coat(); c.button = 'taken'; saveCoat(c); S.found('redcoat');
  }

  let tried = false;
  game.on('frame', ({ dt }) => {
    if (!ready) { if (!tried && game.nav) { tried = true; try { setup(); } catch (e) { console.warn('secrets: redcoat setup', e); } } return; }
    if (api.force) { if (cur !== api.force) show(api.force); op = 1; mat.opacity = 1; return; }          // tests and screenshots
    const p = game.player, on = p.mode === 'walk';
    if (button) { button.glow.sprite.material.opacity = 0.7 + 0.3 * Math.sin(performance.now() / 700); }
    if (!on) { if (cur) hide(); return; }
    if (game.cameraHeld) return;              // photo mode or a ride has the camera: hold still (vanishing here would pop out of the picture)
    game.camera.getWorldDirection(fwd); const fl = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fl, fy = -fwd.z / fl;                      // heading in the Blender frame
    if (!cur) {
      const c = coat(); let pick = null, pd = 1e9;
      const all = c.seen.length >= spots.length && c.button !== 'taken' && c.button !== 'left' && rail ? [rail, ...spots] : spots;
      for (const s of all) {
        const dx = s.x - p.x, dy = s.y - p.y, d = Math.hypot(dx, dy);
        if (s.cool) { if (d > 130) s.cool = false; continue; }
        if (d < GONE + 4 || d > SHOW_MAX || d > pd) continue;
        if ((dx * fx + dy * fy) / d < CONE) continue;
        if (Math.abs(s.z - p.z) > 12) continue;
        pick = s; pd = d;
      }
      if (pick) show(pick);
      return;
    }
    const s = cur, dx = s.x - p.x, dy = s.y - p.y, d = Math.hypot(dx, dy), ca = (dx * fx + dy * fy) / (d || 1);
    if (s.id !== 'rail') fig.rotation.y = turn(fig.rotation.y, faceY(Math.atan2(-dy, -dx)), Math.min(1, dt * 3));
    const gone = s.id === 'rail' ? d < 7 : d < GONE, away = ca < OFF || d > SHOW_MAX + 15 || Math.abs(s.z - p.z) > 14;
    if (away) offT += dt; else if (ca > CONE) offT = Math.max(0, offT - dt);
    if (gone || offT > LOOK_AWAY) vanishing = true;
    const rate = game.reduceMotion ? 1 / 0.3 : vanishing ? (gone ? 1 / 0.6 : 1 / 1.6) : 1 / 1.3;
    op = Math.max(0, Math.min(1, op + (vanishing ? -rate : rate) * dt)); mat.opacity = op;
    if (!vanishing && op > 0.6 && ca > CONE && d >= GONE) {
      viewT += dt;
      if (viewT > SEEN_T && s.id !== 'rail') { const c = coat(); if (!c.seen.includes(s.id)) { c.seen.push(s.id); saveCoat(c); game.emit('secrets:coat', { id: s.id, seen: c.seen.length }); } }
    }
    if (vanishing && op <= 0) {
      if (s.id === 'rail') { const c = coat(); c.button = 'left'; saveCoat(c); placeButton(); }
      s.cool = true; hide();
    } else if (s.id === 'rail' && gone && !button) { const c = coat(); if (c.button !== 'left') { c.button = 'left'; saveCoat(c); placeButton(); } }
  });
  const api = { force: null, show, hide, take, setup };
  for (const [k, f] of Object.entries({ spots: () => spots, rail: () => rail, current: () => cur, button: () => button })) Object.defineProperty(api, k, { get: f });
  return api;
}
