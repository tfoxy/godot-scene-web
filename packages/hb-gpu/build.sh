#!/usr/bin/env bash
#
# Compile HarfBuzz's Slug (GPU glyph) encoder to wasm.
#
# WHAT THIS BUILDS, AND WHAT IT DOES NOT. Upstream's own `util/gpu/web/build.sh` links the whole
# GLFW demo — a window, a view, a font cache, a GL renderer and a `main()`. None of that is wanted
# here: the browser already has a WebGL2 context and `src/webgl.ts` already owns the pipeline. So
# this compiles exactly ONE translation unit, `src/harfbuzz-world.cc`, which under `HB_HAS_GPU`
# already `#include`s `hb-gpu-draw.cc` / `hb-gpu-paint.cc` / `hb-gpu.cc` / `hb-static.cc`, and lets
# `hb-gpu.symbols` plus `-flto` throw the rest away.
#
# EMCC IS NOT INSTALLED ON THIS HOST AND MUST STAY THAT WAY. The compile runs inside the official
# `emscripten/emsdk` image, bind-mounting the repo, as the invoking uid so the outputs are not
# root-owned. Nothing is installed, and nothing is downloaded except the pinned tarball below.
#
# IDEMPOTENT. The tarball is fetched once, checksummed against a literal pinned here, and extracted
# once. Re-running rebuilds only the wasm.
#
# THE OUTPUT IS VENDORED, NOT BUILT. It lands in `vendor/`, which is COMMITTED — see
# `vendor/VENDOR.md`. `dist/` is the tsdown TypeScript build and stays gitignored. A rebuild that
# changes `vendor/` must update the digests in `VENDOR.md` in the same commit; if nothing here
# changed, a rebuild is byte-identical and `git status` stays clean.
#
# Usage: packages/hb-gpu/build.sh   (from anywhere; paths are derived)

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PKG_DIR/../.." && pwd)"

HB_VERSION="14.4.0"
# sha256 of https://github.com/harfbuzz/harfbuzz/archive/refs/tags/14.4.0.tar.gz.
#
# A TAG IS NOT A PIN. GitHub builds these archives on demand and a tag can be moved; the digest is
# what makes "the binary a measurement was taken with" a reproducible statement. A mismatch stops
# the build rather than silently compiling different source.
HB_SHA256="46dc4f3b6aefc4d8256b10017186f5ebe50ea086714ab8948cdac4695a7a80a8"
HB_URL="https://github.com/harfbuzz/harfbuzz/archive/refs/tags/${HB_VERSION}.tar.gz"

WORK_DIR="$REPO_DIR/artifacts/hb-gpu"
SRC_DIR="$WORK_DIR/harfbuzz-${HB_VERSION}"
TARBALL="$WORK_DIR/harfbuzz-${HB_VERSION}.tar.gz"
INCLUDE_DIR="$WORK_DIR/include"
CACHE_DIR="$WORK_DIR/emcache"
OUT_DIR="$PKG_DIR/vendor"

# THE TOOLCHAIN IS PINNED THE SAME WAY THE SOURCE IS. `emscripten/emsdk:latest` moves — the tag was
# `latest` while the HarfBuzz tarball was sha256-pinned, which made "the binary a measurement was
# taken with" reproducible on one side and a moving target on the other. This is the multi-arch
# manifest-list digest, so it resolves on any host arch.
#
# To re-resolve after a deliberate toolchain bump:
#
#   docker buildx imagetools inspect emscripten/emsdk:latest   # -> Digest: sha256:...
#
# and record the new digest here AND in vendor/VENDOR.md, in the same commit as the rebuilt wasm.
IMAGE="emscripten/emsdk@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc"

mkdir -p "$WORK_DIR" "$OUT_DIR" "$INCLUDE_DIR" "$CACHE_DIR"

# ---------------------------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------------------------

verify_tarball () {
  local actual
  actual="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
  if [ "$actual" != "$HB_SHA256" ]; then
    echo "hb-gpu: harfbuzz-${HB_VERSION}.tar.gz sha256 is $actual, expected $HB_SHA256" >&2
    echo "hb-gpu: refusing to build — the pinned tag no longer resolves to the pinned bytes" >&2
    exit 1
  fi
}

if [ -f "$TARBALL" ]; then
  echo "hb-gpu: reusing $TARBALL"
else
  echo "hb-gpu: fetching harfbuzz ${HB_VERSION}"
  curl -sSL -o "$TARBALL.part" "$HB_URL"
  mv "$TARBALL.part" "$TARBALL"
fi
verify_tarball

if [ -f "$SRC_DIR/src/harfbuzz-world.cc" ]; then
  echo "hb-gpu: reusing $SRC_DIR"
else
  echo "hb-gpu: extracting"
  tar xzf "$TARBALL" -C "$WORK_DIR"
fi

# The build configuration is upstream's own, copied rather than pointed at, so the include path
# holds these two files and nothing else from `util/gpu/web` (which is a GLFW demo). `config.h` is
# `HB_TINY` + `HB_HAS_GPU`; `config-override.h` puts back DRAW / METRICS / COLOR / PAINT / VAR,
# which `HB_TINY` strips and the encoder needs.
cp "$SRC_DIR/util/gpu/web/config.h" "$INCLUDE_DIR/config.h"
cp "$SRC_DIR/util/gpu/web/config-override.h" "$INCLUDE_DIR/config-override.h"

# ---------------------------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------------------------

REL_WORK="artifacts/hb-gpu"
REL_PKG="packages/hb-gpu"

# `-sINITIAL_MEMORY=2097152` because the DEFAULT MAKES `heapBytes` A LIE. Emscripten reserves
# 16 MiB up front, and `HEAPU8.byteLength` — which is what this package publishes as its wasm-heap
# cost, to be read next to `hb-atlas`'s "two 1.25 MiB wasm heaps" — then reports 16.19 MiB whatever
# the font is. Measured at 2 MiB instead: the heap holds the 826 KB Noto Sans SC subset, encodes
# 300 distinct Han glyphs, and NEVER GROWS, so the real footprint is under 2 MiB and the default was
# overstating this arm's memory by about 8x. `ALLOW_MEMORY_GROWTH` is still on, so a larger face
# simply grows and reports the truth.
#
# RE-MEASURED WHEN THE SHAPER LANDED, BECAUSE THE OLD NUMBER WAS TUNED TO ONE FACE AND NO SHAPING.
# Shaping allocates a buffer whose arrays are sized by the LONGEST RUN — roughly 80 bytes a glyph,
# `hb_glyph_info_t` plus `hb_glyph_position_t`, doubled for the output buffer — plus a shape plan
# per (face, script, direction). Both were measured rather than guessed, on a probe build with
# `-sMEMORY_GROWTH_LINEAR_STEP=65536` so that `heapBytes` tracks the high-water mark to a 64 KiB
# page instead of overshooting by emscripten's geometric step:
#
#   0.500 MiB  module instantiated, no font
#   1.000 MiB  + Noto Sans SC bench face (826 KB)
#   1.063 MiB  + Roboto bench face (23 KB) — S9 loads both
#   1.063 MiB  + 80 runs shaped (2080 more made no difference)
#   1.125 MiB  + 340 outlines encoded — the ENCODER's blob buffer, not the shaper's
#   1.438 MiB  + one pathological 4000-glyph run in a single buffer
#
# So the realistic two-face workload high-waters at 1.125 MiB and shaping's own contribution at S9
# run lengths is below one 64 KiB page. AT THE SHIPPED 2 MiB NOTHING ABOVE GROWS THE HEAP AT ALL,
# and neither does a single run of up to 8000 glyphs; 16 000 in one buffer is the first thing that
# does (2.438 MiB). 2 MiB therefore stays: it still bounds the truth rather than inventing it, with
# 0.875 MiB of headroom over the measured workload, and raising it would put `heapBytes` back to
# reporting a reservation instead of a cost.
#
# `HEAPU8,HEAP32,HEAPU16` in the runtime methods, and they are NOT optional. `UTF8ToString` alone is
# what the shader-source getters need, but without the heap views the glue creates only
# `HEAP8`/`HEAPU8` as module-private locals and attaches neither to the module object — so
# `hb_glyph_extents_t` (four int32) could not be read back out of the out-param at all. `HEAPU16`
# joined them with the shaper: `hb_buffer_add_utf16` takes `const uint16_t *`, and a JS string is
# already UTF-16, so the text goes in through one `HEAPU16.set` rather than a hand-written
# little-endian byte loop — which would be a fourth place in this package to get byte order wrong.
#
# `-sENVIRONMENT=web,worker` because the node branch of emscripten's ES6 glue contains
# `await import("node:module")`, and esbuild bundling this package for a page cannot resolve a node
# builtin. This is a browser pipeline — the encoder feeds a WebGL2 program — so the node branch is
# dead weight that only breaks the bundle.
#
# `-fno-exceptions -fno-rtti` is what makes emscripten choose its `libc++-noexcept` /
# `libc++abi-noexcept` variants, which is the observable form of "no exceptions, no RTTI".
#
# `-sINCOMING_MODULE_JS_API=wasmBinary` IS LOAD-BEARING AND WAS MISSING. Emscripten emits the
# `Module["wasmBinary"]` pickup ONLY for keys named here, and its default list does not include it —
# so without this flag `createHbGpu(factory, bytes)` silently ignored the bytes and the glue fell
# back to fetching `hb-gpu.wasm` relative to its own `import.meta.url`. In a browser served over
# HTTP that happens to work, which is exactly why it went unnoticed: the pixel test passed while the
# documented API did nothing. It also made the module unusable from node, where the `web,worker`
# glue has no fetch path at all and aborts with "both async and sync fetching of the wasm failed".
# The caller owning the bytes is the whole reason the factory is injected rather than imported.
#
# `--user` so `vendor/` and the emscripten cache come out owned by the caller; `EM_CACHE` because
# the image's own cache lives under root-owned `/emsdk` and a non-root build cannot populate it. The
# cache is inside `artifacts/`, which is gitignored, and it makes a rebuild seconds rather than a
# minute.
#
# NO `-DHB_GPU_ATLAS_2D`. It was here and it was dead: that macro is read only by
# `util/gpu/demo-atlas.cc`, which is not in this translation unit — the `#ifdef` that actually
# selects the 2D atlas layout lives in `GLSL_PREAMBLE` in `src/webgl.ts`, on the JavaScript side.
# Verified by rebuilding with and without it: both wasm and glue came out byte-identical.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_DIR:/repo" \
  -w /repo \
  -e "EM_CACHE=/repo/$REL_WORK/emcache" \
  "$IMAGE" \
  em++ \
    -std=c++17 \
    -Oz -flto \
    -fno-exceptions -fno-rtti \
    -DHAVE_CONFIG_H \
    -I"/repo/$REL_WORK/include" \
    -I"/repo/$REL_WORK/harfbuzz-${HB_VERSION}/src" \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=2097152 \
    -sFILESYSTEM=0 \
    -sENVIRONMENT=web,worker \
    -sINCOMING_MODULE_JS_API=wasmBinary \
    -sEXPORTED_FUNCTIONS="@/repo/$REL_PKG/hb-gpu.symbols" \
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,HEAP32,HEAPU16 \
    "/repo/$REL_WORK/harfbuzz-${HB_VERSION}/src/harfbuzz-world.cc" \
    -o "/repo/$REL_PKG/vendor/hb-gpu.mjs"

# ---------------------------------------------------------------------------------------------
# Attribution
# ---------------------------------------------------------------------------------------------

# PRINTED, NOT JUST BUILT. Every number this package reports — blob bytes per glyph, atlas
# reservation, frame cost — is a property of one binary. Without a digest beside it, a measurement
# cannot be attributed to the encoder that produced it. These are the digests `vendor/VENDOR.md`
# records and `test/vendor.test.ts` asserts, so a rebuild that moves them turns the suite red until
# `VENDOR.md` is updated to match.
WASM="$OUT_DIR/hb-gpu.wasm"
GLUE="$OUT_DIR/hb-gpu.mjs"
echo
echo "hb-gpu: harfbuzz   ${HB_VERSION} (tarball sha256 ${HB_SHA256})"
echo "hb-gpu: emsdk      ${IMAGE#*@}"
echo "hb-gpu: wasm       $(stat -c%s "$WASM") bytes"
echo "hb-gpu: wasm  sha256 $(sha256sum "$WASM" | cut -d' ' -f1)"
echo "hb-gpu: glue       $(stat -c%s "$GLUE") bytes"
echo "hb-gpu: glue  sha256 $(sha256sum "$GLUE" | cut -d' ' -f1)"
