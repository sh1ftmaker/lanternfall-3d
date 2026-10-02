// Shared helpers for the secrets module: land-local coordinates, moving the visitor anywhere (also off the walk grid), small maths.
// Land frame (the Blender scripts): +y outward (away from the lake), -y lakeward, x to the right when looking outward.
export function makeLib(game) {
  const lands = () => game.manifest.lands;
  const land = (id) => lands().find((l) => l.id === id);
  // land-local (lx, ly) -> world (x, y)
  const world = (id, lx, ly) => { const l = land(id), s = Math.sin(l.phi), c = Math.cos(l.phi); return [l.center[0] + lx * s + ly * c, l.center[1] - lx * c + ly * s]; };
  const outward = (id) => land(id).phi;                          // yaw that looks away from the lake
  // Move the visitor to (x, y, z) facing yaw, also where the walk grid has no place (the Spire island, a tower deck): game.teleport takes z.
  // Returns true when Wick was placed (the first-person walker lands on the nearest grid spot instead).
  function goTo(x, y, z, yaw) {
    game.teleport(x, y, yaw, { z });
    const pf = game.platformer, w = game.ctx.wickWanted ? game.ctx.wickWanted() : !!(pf && pf.active);
    return !!w;
  }
  return { land, world, outward, goTo };
}
