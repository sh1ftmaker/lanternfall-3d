# Platformer: credits, licences and exactly what is in `sm64.wasm`

## The movement code: libsm64 and the sm64 decompilation

Wick's movement (walking, running, jumps, flips, wall kicks, ledges, swimming, slides, knockbacks; the collision
response against the park) is computed by **libsm64**, which packages the player-movement code of the
**sm64 decompilation project** as a library.

| Project | Source | Version used | Licence as marked by the project |
|---|---|---|---|
| libsm64 | https://github.com/libsm64/libsm64 | commit `fd11813208272b4271d92bd92feb8f3fdbe61be5` (master, 2026-02-13, "Fix assignment of animFrame in outState") | CC0-1.0 (`LICENSE.md` in the repository) |
| sm64 decompilation (vendored inside libsm64 as `src/decomp/`) | https://github.com/n64decomp/sm64 | as vendored at the libsm64 commit above | CC0-1.0 (GitHub licence field of the repository) |

What the CC0 marks do and do not cover: CC0 is a waiver by the people who wrote that code of *their own* copyright
and related rights. libsm64's own glue code (the `src/*.c` files outside `src/decomp/`) is theirs to waive. The files
under `src/decomp/` are a hand-written C reconstruction ("decompilation") of the 1996 game's program, which Nintendo
owns; the decompilation's contributors can waive only what they hold, and whether such a reconstruction can be
distributed freely has not been settled. The project ships **no ROM data** (no textures, models, animations, sounds,
levels or text from the game) and needs none at run time; but the compiled movement logic is derived from the game's
program. Publishing a build of it on the public site is a decision for the site's owner.

## Exactly what `fx/platformer/sm64.wasm` contains

Built by `tools/platformer/build-wasm.sh` with wasi-sdk 34 (clang 23, `--target=wasm32-wasip1 -Oz -flto`,
`-DLIBSM64_NO_ROM -DLIBSM64_PARK -DVERSION_US -DGBI_FLOATS -DNO_SEGMENTED_MEMORY`, linked with `--gc-sections
--strip-all`, only the `park_*` entry points exported). 122,118 bytes (51 KB gzipped). Sources compiled:

- **libsm64 glue** (CC0): `src/libsm64.c`, `src/load_surfaces.c`, `src/load_anim_data.c`, `src/obj_pool.c`,
  `src/fake_interaction.c`, `src/debug_print.c`, with this project's patch `tools/platformer/libsm64-park.patch`
  applied (see below).
- **sm64 decompilation** (as vendored by libsm64): `src/decomp/global_state.c`, `src/decomp/memory.c`;
  `src/decomp/engine/`: `math_util.c` (vector/matrix maths and the 20 KB sine / 2 KB arctangent tables),
  `surface_collision.c`, `graph_node.c`, `graph_node_manager.c`, `geo_layout.c`, `guMtxF2L.c`;
  `src/decomp/game/`: the player core file, the player step file (`*_step.c`), the seven player action files
  (`*_actions_airborne.c`, `*_actions_automatic.c`, `*_actions_cutscene.c`, `*_actions_moving.c`,
  `*_actions_object.c`, `*_actions_stationary.c`, `*_actions_submerged.c`), the player misc file (`*_misc.c`),
  `interaction.c`, `object_stuff.c`, `platform_displacement.c`, `sound_init.c`. The linker keeps only what the
  exported entry points reach (`--gc-sections`).
- **This project's code**: `tools/platformer/park_stubs.c` (no-op stand-ins for the audio calls, the `park_*`
  interface used by `fx/platformer/sm64.js`).
- **wasi-libc** from wasi-sdk 34 (https://github.com/WebAssembly/wasi-sdk, malloc / string / stdio pieces;
  licences: Apache-2.0 WITH LLVM-exception, MIT, and others as listed in wasi-libc's `LICENSE` files).

Left out entirely (never compiled, never downloaded):
- the player **model** (`src/decomp/mario/*`: libsm64's `import-mario-geo.py` downloads it from the decompilation's
  repository at build time; the script is not run), `src/gfx_adapter.c` (display lists to triangles),
  `src/decomp/game/rendering_graph_node.c` and `behavior_actions.c` (draw-time code);
- every **ROM reader**: `src/load_tex_data.c` (textures), the ROM path of `src/load_anim_data.c` (compiled out),
  `src/load_audio_data.c`, `src/decomp/audio/*`, `src/decomp/pc/*`, `src/play_sound.c`, `src/decomp/tools/*`
  (MIO0 and N64 image decoders).

`tools/platformer/audit-wasm.mjs` checks every build: imports (WASI only), exports (`park_*`, `malloc`, `free`),
data size (< 40 KB: the trig tables and small movement tables), no model / texture / display-list / audio / ROM
symbols in the linker map, and neither the game's ROM title nor the original character's name anywhere in the binary.

## The patch (`tools/platformer/libsm64-park.patch`)

- `LIBSM64_NO_ROM`: `sm64_global_init_norom(animTable, count)` replaces the ROM-reading init. No textures, no audio,
  no model. The animation table (fx/platformer/anims.js, this project's own design) gives each of the library's
  animation slots a length, loop flag and start frame; the library only uses it as a clock (which frame an
  animation is on, whether it has ended). Each tick advances that clock the way the draw code used to.
- `LIBSM64_PARK`: a spatial grid over the static surfaces (libsm64 scans every surface for every collision query; the
  grid makes a tick cost ~0.06 ms with 50,000+ surfaces); near-vertical faces (|n.y| < 0.06) become exact walls;
  after a surface reload the player's floor / ceiling pointers are refreshed; debug messages are compiled out.

## Everything else is original

The character (Wick, the lamplighter: model, palette, rig), all of its animation clips (`fx/platformer/animator.js`),
the animation timing table (`fx/platformer/anims.js`), the camera, controls, collision export, streaming and tools
were written for this project. No asset, texture, model, animation, sound or name from the original game is used.
Action names shown in the `#pfdebug` overlay (`fx/platformer/actions.js`) are the decompilation's descriptive action
identifiers (e.g. "double jump", "ledge climb slow"), generated from its header.
