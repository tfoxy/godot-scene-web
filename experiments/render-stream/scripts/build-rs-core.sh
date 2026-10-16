#!/usr/bin/env bash
# Build the shared Rust core (gate7-design.md D29, D30, Q14a):
#   - render-stream-core's native CLI, rs-core-check (goldens, diff, dump-pdl, bench);
#   - rs-gsw-wasm, the core and the renderer's canvas-items executor in ONE wasm32-unknown-unknown
#     module, with its wasm-bindgen (=0.2.129) `--target web` glue (the browser and Node load it).
# into ignored artifacts/render-stream/rs-core/<sha>/ ({bin,gsw-rs}/), and points
# artifacts/render-stream/rs-core/latest at it. Offline: every crate comes from the local registry.
#
# Usage: experiments/render-stream/scripts/build-rs-core.sh [--native-only|--wasm-only]
set -euo pipefail

# Measurement isolation: the build holds the machine-wide quiet lock SHARED (lib/quiet.sh), so it
# pauses while a timing leg runs (and inside a runner's hold it nests as a no-op).
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label "$(basename "${BASH_SOURCE[0]}")" -- bash "${BASH_SOURCE[0]}" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "${HERE}/.." && pwd)"
ROOT="$(cd "${RS}/../.." && pwd)"
CORE="${RS}/rs-core"
WASM="${RS}/web/gsw-rs"
WASM_BINDGEN="${GSW_WASM_BINDGEN_CLI:-wasm-bindgen}"

native=1
wasm=1
case "${1:-}" in
  --native-only) wasm=0 ;;
  --wasm-only) native=0 ;;
  "") ;;
  *) echo "usage: $0 [--native-only|--wasm-only]" >&2; exit 2 ;;
esac

sha="$(git -C "${ROOT}" rev-parse --short=12 HEAD)"
if ! git -C "${ROOT}" diff --quiet HEAD -- experiments/render-stream/rs-core experiments/render-stream/web/gsw-rs \
    packages/canvas/rust-draw-list packages/canvas/rust-prototype 2>/dev/null \
  || [ -n "$(git -C "${ROOT}" ls-files --others --exclude-standard -- experiments/render-stream/rs-core \
    experiments/render-stream/web/gsw-rs packages/canvas/rust-draw-list packages/canvas/rust-prototype)" ]; then
  sha="${sha}-dirty"
fi
OUT="${ROOT}/artifacts/render-stream/rs-core/${sha}"
mkdir -p "${OUT}/bin" "${OUT}/gsw-rs"

if [ "${native}" = 1 ]; then
  cargo build --offline --release --manifest-path "${CORE}/Cargo.toml"
  cp "${CORE}/target/release/rs-core-check" "${OUT}/bin/"
fi

if [ "${wasm}" = 1 ]; then
  cargo build --offline --release --target wasm32-unknown-unknown --manifest-path "${WASM}/Cargo.toml"
  "${WASM_BINDGEN}" --target web --out-name rs_gsw_wasm --out-dir "${OUT}/gsw-rs" \
    "${WASM}/target/wasm32-unknown-unknown/release/rs_gsw_wasm.wasm"
fi

ln -sfn "${sha}" "${ROOT}/artifacts/render-stream/rs-core/latest"
{
  echo "sha=${sha}"
  echo "rustc=$(rustc --version)"
  echo "wasm-bindgen=$("${WASM_BINDGEN}" --version)"
  [ -f "${OUT}/gsw-rs/rs_gsw_wasm_bg.wasm" ] && echo "wasm_bytes=$(stat -c %s "${OUT}/gsw-rs/rs_gsw_wasm_bg.wasm")"
  [ -f "${OUT}/gsw-rs/rs_gsw_wasm_bg.wasm" ] && echo "wasm_sha256=$(sha256sum "${OUT}/gsw-rs/rs_gsw_wasm_bg.wasm" | cut -d' ' -f1)"
} > "${OUT}/build.txt"
cat "${OUT}/build.txt"
echo "out: ${OUT}"
