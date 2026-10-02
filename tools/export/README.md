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
