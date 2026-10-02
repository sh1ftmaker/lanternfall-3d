#!/usr/bin/env bash
# Builds fx/platformer/sm64.wasm: libsm64's player-movement library (decompiled SM64 movement code) compiled to
# WebAssembly WITHOUT anything taken from a game ROM: no texture loader, no model / display lists, no audio engine,
# no ROM animation reader. Animation timing comes from the park's own table at run time (fx/platformer/anims.js).
#
# Usage: tools/platformer/build-wasm.sh <wasi-sdk dir> [work dir]
#   wasi-sdk 34 (https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34), x86_64 Linux tarball.
#   The work dir (default: a temp dir) receives a clean clone of libsm64 at the pinned commit, with
#   tools/platformer/libsm64-park.patch applied. Nothing from it is committed; only the .wasm is.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
WASI="${1:?wasi-sdk directory}"; WORK="${2:-$(mktemp -d)}"
COMMIT=fd11813208272b4271d92bd92feb8f3fdbe61be5          # libsm64 master, 2026-02-13 ("Fix assignment of animFrame in outState")
CC="$WASI/bin/clang"; SYSROOT="$WASI/share/wasi-sysroot"
OUT="$ROOT/fx/platformer/sm64.wasm"

if [ ! -d "$WORK/libsm64/.git" ]; then git clone -q https://github.com/libsm64/libsm64.git "$WORK/libsm64"; fi
cd "$WORK/libsm64"
git checkout -q "$COMMIT"; git reset -q --hard; git clean -qfdx
git apply "$HERE/libsm64-park.patch"

# Sources: the movement / collision / object glue only. Left out on purpose:
#   src/decomp/mario/*           (the player model: never downloaded, import-mario-geo.py is not run)
#   src/gfx_adapter.c            (turns display lists into triangles)
#   src/load_tex_data.c          (reads textures from a ROM)       src/load_audio_data.c, src/decomp/audio/*, src/decomp/pc/*
#   src/decomp/tools/*           (MIO0 / N64 image decoders)       src/play_sound.c (audio queue; replaced by park_stubs.c)
#   src/decomp/game/rendering_graph_node.c, behavior_actions.c     (draw-time code)
SRCS=$(find src -name '*.c' | grep -v -E 'decomp/audio|decomp/tools|decomp/pc|decomp/mario|gfx_adapter|load_tex_data|load_audio_data|play_sound\.c|rendering_graph_node|behavior_actions' | sort)
FLAGS=(--target=wasm32-wasip1 --sysroot="$SYSROOT" -Oz -flto -fno-strict-aliasing -fvisibility=hidden -Wno-everything
       -DLIBSM64_NO_ROM -DLIBSM64_PARK -DSM64_LIB_EXPORT -DGBI_FLOATS -DVERSION_US -DNO_SEGMENTED_MEMORY
       -I src -I src/decomp/include)
mkdir -p build-park; OBJS=()
for f in $SRCS "$HERE/park_stubs.c"; do o="build-park/$(echo "$f" | tr '/' '_').o"; "$CC" "${FLAGS[@]}" -c "$f" -o "$o"; OBJS+=("$o"); done
"$CC" "${FLAGS[@]}" -mexec-model=reactor -Wl,--export-dynamic -Wl,--export=malloc -Wl,--export=free \
  -Wl,--gc-sections -Wl,--strip-debug -Wl,-Map=build-park/sm64.map -o "$OUT" "${OBJS[@]}"
echo "built $OUT ($(stat -c %s "$OUT") bytes) from libsm64 $COMMIT"
node "$HERE/audit-wasm.mjs" "$OUT" build-park/sm64.map
