// 1. The Paper Doors. One of the twelve doors in the Wanderers' Hall opens onto a place that depends on the weather.
// A return door (a faint glowing paper frame, run-time) stands where you arrive for a minute.
const DOOR = { land: 'wanderers', lx: -1.33, ly: 22.6, z: 0.95 };           // door VI: arc centre (0, -0.5), radius 24, 5/11 of the way round
const AWAY = Math.PI;                                                         // add to the land's outward yaw to face the lake
// weather -> where the door opens (land-local x, y, z of the floor; yaw offset from "outward"; fp: where the walker can stand if the grid has no such place)
const DEST = {
  // the Spire's island: the terrace on the north side (away from the stamp post and the jetty), facing the lake. ((0, 5) was inside the
  // tower's ground hall, a wall ahead.) First person cannot stand on the island: the lake steps at the East Gate end, facing the Spire.
  clear: { name: 'spire', world: [0, 7.9], z: 0.6, yaw: Math.PI / 2, fp: { world: [99.5, 0], z: 0.2, yaw: Math.PI } },
  mist: { land: 'lantern-row', lx: 0, ly: 26.6, z: 1.95, yaw: 0 },                                     // the Shrine of Wishes, facing it, a step back from the offering box
  rain: { land: 'meridian', lx: 14, ly: 4.5, z: 35.05, yaw: AWAY },                                    // the Launch Deck, facing the lake
  storm: { land: 'guildhollow', lx: 0, ly: 22.6, z: 0.15, yaw: 0 },                                      // the castle courtyard, facing the keep
  snow: { land: 'frostmere', lx: 36, ly: 5, z: 0.15, yaw: 0 },                                        // the Crystal Court
};

export function init(S) {
  const { game, lib, THREE } = S;
  let ret = null;                                                              // { group, it, t }
  const doorWorld = () => lib.world(DOOR.land, DOOR.lx, DOOR.ly);

  function dest(state, wick = true) {
    let d = DEST[state] || DEST.clear; if (!wick && d.fp) d = d.fp;
    if (d.world) return { x: d.world[0], y: d.world[1], z: d.z, yaw: d.yaw };
    const w = lib.world(d.land, d.lx, d.ly); return { x: w[0], y: w[1], z: d.z, yaw: lib.outward(d.land) + d.yaw };
  }
  // a paper frame, 2.6 m tall, facing the way back toward the visitor who stands `yaw`-ward of it
  const shoji = (() => { let t = null; return () => { if (t) return t; const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#ffe9c4'; g.fillRect(0, 0, 64, 128); g.strokeStyle = 'rgba(120,70,30,.55)'; g.lineWidth = 2; for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 128); g.stroke(); } for (let j = 0; j <= 4; j++) { g.beginPath(); g.moveTo(0, j * 32); g.lineTo(64, j * 32); g.stroke(); } t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }; })();
  function makeFrame(x, y, z, yaw) {
    const grp = new THREE.Group(), W = 1.3, H = 2.6, T = 0.08;
    const paper = new THREE.MeshBasicMaterial({ map: shoji(), color: new THREE.Color(0.55, 0.5, 0.42), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const wood = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.45, 0.2), transparent: true, opacity: 1, fog: false });
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(W, H), paper); pl.position.y = H / 2; grp.add(pl);
    for (const [bx, by, bw, bh] of [[-W / 2, H / 2, T, H], [W / 2, H / 2, T, H], [0, H, W + T, T], [0, 0.04, W + T, T], [0, H / 2, W, T * 0.6]]) { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, T), wood); m.position.set(bx, by, 0); grp.add(m); }
    game.v3(x, y, z, grp.position); grp.rotation.y = yaw - Math.PI / 2; game.scene.add(grp);
    const glow = game.props.glow({ x, y, z: z + 1.3, color: [0.8, 0.55, 0.28], size: 5 });
    return { grp, paper, wood, glow, set(o) { paper.opacity = 0.75 * o; wood.opacity = o; glow.sprite.material.opacity = o; }, remove() { game.scene.remove(grp); grp.traverse((o) => o.geometry && o.geometry.dispose()); paper.dispose(); wood.dispose(); glow.remove(); } };
  }
  function dropReturn() { if (!ret) return; ret.it.remove(); ret.fr.remove(); ret = null; }
  function placeReturn(back, at) {                                              // `at`: where the visitor was put (known, not read back: Wick takes a moment to arrive)
    dropReturn();
    // 2.6 m ahead, unless the walk grid says the way there is blocked or falls away (a box, steps into the water): then to one side
    // or behind, wherever the visitor can walk straight to it. Off the grid (the island, a deck) it stays ahead.
    const reach = (yaw) => { let z = at.z; for (let k = 1; k <= 6; k++) { const g = game.ground(at.x + Math.cos(yaw) * 2.6 * k / 6, at.y + Math.sin(yaw) * 2.6 * k / 6, z); if (g === null || Math.abs(g - z) > 0.45 || Math.abs(g - at.z) > 0.6) return null; z = g; } return z; };
    let yaw = at.yaw, z = null;
    for (const turn of [0, -0.7, 0.7, -1.57, 1.57, Math.PI]) if ((z = reach(at.yaw + turn)) !== null) { yaw = at.yaw + turn; break; }
    const ax = at.x + Math.cos(yaw) * 2.6, ay = at.y + Math.sin(yaw) * 2.6;
    if (z === null) { const gz = game.ground(ax, ay, at.z); z = gz !== null && Math.abs(gz - at.z) < 1.5 ? gz : at.z; }
    const fr = makeFrame(ax, ay, z, yaw + Math.PI);                         // the frame faces the visitor: its normal points back along -yaw
    const it = game.interact({ id: 'secrets-door-back', x: ax, y: ay, z: z + 0.8, r: 2.4, label: 'Step back through', use() { go(back); } });
    ret = { fr, it, t: 0 };
  }
  function go(to) {
    S.fade(() => {
      const ground = game.ground(to.x, to.y), z = ground !== null && Math.abs(ground - to.z) < 3 ? ground : to.z;
      lib.goTo(to.x, to.y, z + 0.6, to.yaw); dropReturn();
    });
  }
  const d0 = doorWorld(), g0 = game.ground(d0[0], d0[1]);
  game.interact({
    id: 'secrets-door', x: d0[0], y: d0[1], z: g0 ?? DOOR.z, r: 2.6, label: 'Open door VI',
    use() {
      const pf = game.platformer, t = dest(game.weather ? game.weather.state : 'clear', !!(pf && pf.active)), here = lib.world(DOOR.land, DOOR.lx, DOOR.ly - 1.3), back = { x: here[0], y: here[1], z: DOOR.z, yaw: lib.outward(DOOR.land) };
      S.fade(() => {
        const gz = game.ground(t.x, t.y), z = gz !== null && Math.abs(gz - t.z) < 3 ? gz : t.z;
        // Wick is put exactly there; the first-person walker lands on the nearest walk-grid spot, so read where it ended up
        if (lib.goTo(t.x, t.y, z + 0.6, t.yaw)) placeReturn(back, { x: t.x, y: t.y, z, yaw: t.yaw });
        else setTimeout(() => { const p = game.player; placeReturn(back, { x: p.x, y: p.y, z: p.z, yaw: p.yaw }); }, 200);
      });
      S.found('doors');
    },
  });
  // the return door lasts a minute, then fades away
  game.on('frame', ({ dt }) => {
    if (!ret) return;
    ret.t += dt; ret.fr.set(Math.min(1, ret.t / 1.2) * Math.max(0, Math.min(1, (60 - ret.t) / 3)) * (0.88 + 0.12 * Math.sin(ret.t * 2.4)));
    if (ret.t > 60) dropReturn();
  });
  return { dest, doorWorld, get returnDoor() { return ret; }, DEST };
}
