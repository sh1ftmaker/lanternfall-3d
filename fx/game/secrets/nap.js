// 8. The long nap. Left alone, Wick falls asleep (the `action` event says `sleeping`). Asleep on or beside one particular bench, with the
// lake in front of it, for five seconds: the screen fades and Wick wakes on the Spire's gallery, facing the shore he fell asleep on.
const BENCH = [-100.4, -8.2];                     // a bench on the west side of the lake promenade (data/guests.json pois), facing the Spire
const NEAR = 3.2, NEED = 5;
const WAKE = { x: -4.3, y: 0, z: 25.0, yaw: Math.PI };   // the Spire's lowest gallery (floor at 24.4), west side, looking out west at the bench

export function init(S) {
  const { game, lib } = S;
  let asleep = false, t = 0, busy = false;
  game.on('action', ({ name }) => { asleep = name === 'sleeping'; if (!asleep) t = 0; });
  game.on('frame', ({ dt }) => {
    if (!asleep || busy || game.player.mode !== 'walk' || game.cameraHeld) return;      // not while photo mode or a ride has the camera
    const p = game.player;
    if (Math.hypot(p.x - BENCH[0], p.y - BENCH[1]) > NEAR) { t = 0; return; }
    if ((t += dt) < NEED) return;
    busy = true; t = 0;
    S.fade(() => {
      lib.goTo(WAKE.x, WAKE.y, WAKE.z, WAKE.yaw);
      setTimeout(() => game.toast("You wake on the Spire's gallery, and the whole lake is quiet below.", { ms: 6500 }), 600);
    }, { color: '#0d0b26', slow: true }).then(() => { busy = false; });
    S.found('nap');
  });
  return { BENCH, WAKE, get asleep() { return asleep; }, get t() { return t; } };
}
