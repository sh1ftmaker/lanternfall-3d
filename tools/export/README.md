# Export pipeline (reference copy)

These scripts turn the Blender park into `data/`. They are kept here for reference and versioning; they run from the
Blender project (they import its `park_common.py` and `studio.py`), which is not part of this repository.

1. `bake.py` (inside Blender, headless): builds every part, bakes Cycles lighting to per-corner vertex colours
   (with the moon and without it), albedo and emission, and dumps one `.npz` per part.
2. `pack.py` (numpy): welds vertices, smooths the baked light, assigns a surface class per material, runs `hsr.py`,
   quantises and compresses the meshes, and builds the walk grid.
3. `hsr.py`: hidden-surface removal for stacked near-coplanar layers (the data-side z-fighting fix).
4. `zfight_measure.py`: reports remaining near-coplanar overlaps from a `--dump-tris` file.

`park-interiors.diff`: the changes the `interiors` branch made to the Blender park source (`parts/*.py`, not in git):
the Brine & Barrel's open taproom (three doorways, bar, hearth, tables, lamps; shallow steps at the back door and the deck; the upper floor's braces moved up where they belong), a smaller Guildhollow gate fountain,
shorter Signing Tables / Gallery rows and a narrower Paper Doors dais in the Wanderers' Hall, the Rose Maze's centre
benches and gateposts. Parts re-baked: brinewatch, guildhollow, rosewick, wanderers.

`park-crowd.diff`: the changes the `crowd-geo` branch made to the park source for crowd flow: the Shore Promenade's kerb is
dropped and its paving runs on over the grass verge where the lands' main lanes, the green-gap footpaths and the
Lamplighters' Walk meet it, with no planter, bench or lamp post of the promenade in those mouths, and its benches stand
0.45 m further from the rail; the Rosewick lake gate's sign board hangs from the arch (it stood across the gate at hip
height); the Rose Maze's hedges are 0.38 m thick (paths 2.2 m, were 1.8 m); Lantern Row's yatai stools are tucked in at
the counters and the Market Street stalls stand 0.3 m nearer the houses; the Brine & Barrel's doorways are 2.7-3 m (were
2 m); the Guildhollow terrace benches clear the Midway's mouth; the Frostmere overlook's railing leaves the ways past
its sign wall open; the East Gate's wing fences run on to the perimeter wall (they left a 2 m gap in the park's edge)
and its two middle turnstile lanes are one open 3.8 m way. Parts re-baked: core, transit, rosewick, lantern-row,
brinewatch, guildhollow, frostmere. In `pack.py` the walk grid now counts face-down ground slabs from -0.03 m as floor
and fills floorless seam cells (see `fill_nav_holes`); the nav format is unchanged.

`park-lands.diff`: the changes four land agents made to the park source on 2026-10-02 for room to move. Rosewick: the
Rose Maze has 11 cells of 3.07 m (were 13 of 2.6 m; paths 2.7 m) with benches in the secret garden and in dead ends.
Lantern Row: Market Street's stalls stand 0.7 m nearer the houses (a 5.2 m lane), the Night Market's back-to-back
rows have a 4 m opening every 17 m, its first row and the maypole moved to clear two pinches. Guildhollow: benches and
two stalls in the castle bailey, the Training Yard's south tiers shortened. Meridian: the Neon Arcade's cabinet rows
3.2 m apart with a cross aisle. Brinewatch: the Brine & Barrel's north door has a ramp (its steps closed it to guests),
doorways are 3.15 m high and the east porch roof higher (the third-person camera), wall sconces replace the hanging
lanterns, smaller tables stand against the walls. All nine parts re-baked.

`build.py` is the one command now (see its header): `--draft` for geometry work (no Cycles, about a minute for one
land, three for all), the default tier for final data, `--full` from scratch. The whole park at final quality took
11 minutes on 2026-10-02 (bake 497 s with two Blenders at once, pack 133 s); the old serial bake and pack took about 26.
Guest data afterwards: `GUESTS_NPZ=<cache>/npz python tools/guests/build.py`.

Lighting pass (agent `bake`, Blender-Park branch `bake`):
- `lights.py` (run by `pack.py`): `data/lights.json`, every light the bake uses in three.js axes (light objects matched to
  their glowing fittings, emissive fittings and glowing surfaces that act as lamps); fields in its header.
- `bake.py`: light-driven sampling. After the uniform grid cut, edges near lights are split until each is <= 0.5 x its
  distance to the nearest light (light objects and lamp / lantern / flame fittings; >= 8 cm, <= 6 passes), worst first,
  capped at +25 % triangles per part (`--lk --lmin --lpasses --lgrow`). The face attribute `elc` keeps each split face's
  detail class in `pack.py`. Lamp shape (`lampshape.py`, also used by `ground.py`): soft near field (Light Falloff
  Smooth 0.45 m) and point lamps / lanterns capped to 25 % upward light (`--lsoft --lcap`).
- `ground.py` (Blender, run by `build.py` after the bakes, ~10 min) + `groundmap.py` (run by `pack.py`): ground maps,
  contact AO and lamp-shadow detail on 12.5 cm texels over the walk grid's 16 m tiles -> `data/ground.bin`,
  `data/ground_lo.bin`, `manifest.ground`; runtime `fx/light/ground.js`.
