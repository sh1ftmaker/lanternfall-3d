// Shared helpers for the secrets module: land-local coordinates, moving the visitor anywhere (also off the walk grid), small maths.
// Land frame (the Blender scripts): +y outward (away from the lake), -y lakeward, x to the right when looking outward.
export function makeLib(game) {
  const lands = () => game.manifest.lands;
  const land = (id) => lands().find((l) => l.id === id);
  // land-local (lx, ly) -> world (x, y)
  const world = (id, lx, ly) => { const l = land(id), s = Math.sin(l.phi), c = Math.cos(l.phi); return [l.center[0] + lx * s + ly * c, l.center[1] - lx * c + ly * s]; };
  const outward = (id) => land(id).phi;                          // yaw that looks away from the lake
  // Move the visitor to (x, y, z) facing yaw. The walk grid cannot hold places such as the Spire island or a tower deck, so
  // Wick is placed with the platformer and the first-person walker is set by hand (only where the grid has the place).
  function goTo(x, y, z, yaw) {
    const pf = game.platformer;
    if (game.player.mode === 'walk' && pf && pf.active && pf.enter) { pf.enter({ x, y, z, yaw }); return true; }   // the platformer re-spawns Wick anywhere
    game.setMode('walk', { at: [x, y], yaw });                                                       // first person: the nearest spot on the walk grid
    return false;
  }
  return { land, world, outward, goTo };
}
