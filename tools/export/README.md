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
