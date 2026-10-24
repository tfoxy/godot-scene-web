#!/usr/bin/env bash
# Build GSW's KTX2 transcoder wasm (G8kb, protocol/texture-delivery-design.md D14, D15, Q6 "GSW"):
# web/basis-transcoder/transcoder.cpp over the vendored basisu 1.60 transcoder
# (third_party/basis_universal/transcoder, the revision every other receiver runs) and zstd 1.5.7's
# decompressor (capture/vendor/zstd), compiled by the pinned emscripten 4.0.11
# (~/.cache/godot-render-stream/emsdk, the web export's) into ONE standalone wasm with no JS glue:
# web/basis-transcoder/worker.ts instantiates it in a Web Worker.
#
# Usage: experiments/render-stream/scripts/build-basis-transcoder.sh
#
# Output: artifacts/render-stream/basis-transcoder/<digest>/{basis_transcoder.wasm,build.json},
# where <digest> is the sha256 (first 16 hex) of every input file and the flags below, so an
# unchanged source reuses its build; `latest` points at it. The last stdout line is the directory.
#
# Transcoder defines: Godot's (modules/basis_universal/SCsub: KTX2 + Zstandard, no ATC, FXT1,
# PVRTC1/2), plus BASISD_SUPPORT_UASTC_HDR=0 (LDR only) and BASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=1,
# which basisu defaults to 0 under emscripten and 1 natively: 1 is the native receiver's (the oracle's)
# table. Neither changes a UASTC LDR transcode; both are pinned so the blocks never depend on the
# compiler.
set -euo pipefail

# Measurement isolation: a build holds the machine-wide quiet lock SHARED (lib/quiet.sh).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
  RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
    --label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "${HERE}/.." && pwd)"
ROOT="$(cd "${RS}/../.." && pwd)"
SRC="${RS}/web/basis-transcoder/transcoder.cpp"
BASISU="${RS}/third_party/basis_universal"
ZSTD="${RS}/capture/vendor/zstd"
EMSDK="${EMSDK_DIR:-${HOME}/.cache/godot-render-stream/emsdk}"
EXPECTED_EMCC="4.0.11"

case "${1:-}" in
  "") ;;
  *) echo "usage: $0" >&2; exit 2 ;;
esac

DEFINES=(-DBASISD_SUPPORT_KTX2=1 -DBASISD_SUPPORT_KTX2_ZSTD=1 -DBASISD_SUPPORT_ATC=0
  -DBASISD_SUPPORT_FXT1=0 -DBASISD_SUPPORT_PVRTC1=0 -DBASISD_SUPPORT_PVRTC2=0
  -DBASISD_SUPPORT_UASTC_HDR=0 -DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=1
  -DZSTD_DISABLE_ASM=1 -DZSTD_MULTITHREAD=0 -DDEBUGLEVEL=0)
CFLAGS=(-O3 -fno-exceptions -fno-rtti -w)
LDFLAGS=(-O3 --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB
  -sSTACK_SIZE=256KB -sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=1)
ZSTD_SOURCES=("${ZSTD}"/common/*.c "${ZSTD}"/decompress/*.c)
INPUTS=("${SRC}" "${BASISU}"/transcoder/* "${ZSTD}"/zstd.h "${ZSTD}"/zstd_errors.h
  "${ZSTD}"/common/* "${ZSTD}"/decompress/* "${HERE}/$(basename "${BASH_SOURCE[0]}")")

digest="$(
  {
    for f in "${INPUTS[@]}"; do
      printf '%s %s\n' "$(sha256sum "${f}" | cut -d' ' -f1)" "${f#"${RS}/"}"
    done
    printf '%s\n' "${DEFINES[*]}" "${CFLAGS[*]}" "${LDFLAGS[*]}" "emcc ${EXPECTED_EMCC}"
  } | sha256sum | cut -c1-16
)"
BASE="${ROOT}/artifacts/render-stream/basis-transcoder"
OUT="${BASE}/${digest}"
if [ -f "${OUT}/build.json" ] && [ -f "${OUT}/basis_transcoder.wasm" ]; then
  ln -sfn "${digest}" "${BASE}/latest"
  echo "build-basis-transcoder: reusing ${OUT}" >&2
  echo "${OUT}"
  exit 0
fi

if [ ! -f "${EMSDK}/emsdk_env.sh" ]; then
  echo "build-basis-transcoder: emsdk is missing at ${EMSDK} (gate7-design.md Q13e)" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "${EMSDK}/emsdk_env.sh" >/dev/null 2>&1
emcc_version="$(emcc --version | head -1)"
case "${emcc_version}" in
  *" ${EXPECTED_EMCC} "*) ;;
  *) echo "build-basis-transcoder: emcc is not ${EXPECTED_EMCC}: ${emcc_version}" >&2; exit 1 ;;
esac

TMP="${OUT}.tmp.$$"
rm -rf "${TMP}"
mkdir -p "${TMP}/obj"
objs=()
for c in "${ZSTD_SOURCES[@]}"; do
  o="${TMP}/obj/zstd_$(basename "${c}" .c).o"
  emcc "${CFLAGS[@]/-fno-rtti/}" "${DEFINES[@]}" -I "${ZSTD}" -c "${c}" -o "${o}" >&2
  objs+=("${o}")
done
em++ -std=c++17 "${CFLAGS[@]}" "${DEFINES[@]}" -I "${BASISU}" -I "${ZSTD}" \
  -c "${BASISU}/transcoder/basisu_transcoder.cpp" -o "${TMP}/obj/basisu_transcoder.o" >&2
em++ -std=c++17 "${CFLAGS[@]}" "${DEFINES[@]}" -I "${BASISU}" -I "${ZSTD}" \
  -c "${SRC}" -o "${TMP}/obj/transcoder.o" >&2
objs+=("${TMP}/obj/basisu_transcoder.o" "${TMP}/obj/transcoder.o")
em++ "${LDFLAGS[@]}" "${objs[@]}" -o "${TMP}/basis_transcoder.wasm" >&2

python3 - "${TMP}/build.json" "${TMP}/basis_transcoder.wasm" <<PY
import hashlib, json, sys
wasm = open(sys.argv[2], "rb").read()
json.dump({
  "schema": "render-stream-basis-transcoder/1",
  "digest": "${digest}",
  "emcc": """${emcc_version}""",
  "defines": "${DEFINES[*]}".split(" "),
  "cflags": "${CFLAGS[*]}".split(" "),
  "ldflags": "${LDFLAGS[*]}".split(" "),
  "basisu": "1.60 (third_party/basis_universal/PROVENANCE.md)",
  "zstd": "1.5.7 (capture/vendor/PROVENANCE.md)",
  "wasm_bytes": len(wasm),
  "wasm_sha256": hashlib.sha256(wasm).hexdigest(),
}, open(sys.argv[1], "w"), indent=2)
PY
rm -rf "${TMP}/obj" "${OUT}"
mv "${TMP}" "${OUT}"
ln -sfn "${digest}" "${BASE}/latest"
echo "${OUT}"
