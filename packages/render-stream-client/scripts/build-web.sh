#!/usr/bin/env bash
# Build the render-stream client's core (MIR-1, mirror-client-design.md "The wasm"): the existing
# rs-gsw-wasm crate (experiments/render-stream/web/gsw-rs), `cargo --release --target
# wasm32-unknown-unknown` offline and `wasm-bindgen =0.2.129 --target web`, into
# $GSW_RENDER_STREAM_CLIENT_OUT (or the first argument):
#
#   rs_gsw_wasm_bg.wasm     the module
#   rs_gsw_wasm_client.js   wasm-bindgen's glue wrapped in a factory (glue-factory.mjs): serve it by
#                           URL as the client's `core.glueUrl`, never bundle it
#   build.json              schema render-stream-client-core/1: rs_core_build (`sha=<HEAD 12>[-dirty]`,
#                           build-rs-core.sh's rule), rs_core_tree (core-tree.sh), wasm_sha256,
#                           wasm_bytes, wasm_bindgen, glue, wasm
#
# Nothing here is committed. The build holds the machine-wide quiet lock shared when the repo's
# render-stream lock script is present (it pauses while a timing leg runs).
#
# Usage: packages/render-stream-client/scripts/build-web.sh [OUT]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
QUIET="${ROOT}/experiments/render-stream/scripts/lib/quiet.sh"
if [ -z "${RS_QUIET_BUILD_WRAPPED:-}" ] && [ -f "$QUIET" ]; then
	RS_QUIET_BUILD_WRAPPED=1 exec bash "$QUIET" shared --label "render-stream-client build-web.sh" -- \
		bash "${BASH_SOURCE[0]}" "$@"
fi
OUT="${1:-${GSW_RENDER_STREAM_CLIENT_OUT:-}}"
[ -n "$OUT" ] || { echo "build-web.sh: pass OUT or set GSW_RENDER_STREAM_CLIENT_OUT" >&2; exit 2; }
WASM="${ROOT}/experiments/render-stream/web/gsw-rs"
WASM_BINDGEN="${GSW_WASM_BINDGEN_CLI:-wasm-bindgen}"
want="wasm-bindgen 0.2.129"
have="$("$WASM_BINDGEN" --version)"
[ "$have" = "$want" ] || { echo "build-web.sh: need $want (got $have)" >&2; exit 2; }

sha="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if ! git -C "$ROOT" diff --quiet HEAD -- experiments/render-stream/rs-core experiments/render-stream/web/gsw-rs \
	packages/canvas/rust-draw-list packages/canvas/rust-prototype 2>/dev/null ||
	[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard -- experiments/render-stream/rs-core \
		experiments/render-stream/web/gsw-rs packages/canvas/rust-draw-list packages/canvas/rust-prototype)" ]; then
	sha="${sha}-dirty"
fi
tree="$(bash "${HERE}/core-tree.sh" "$ROOT")"

# From the crate's directory, so cargo reads web/gsw-rs/.cargo/config.toml (wasm SIMD, W13p).
(cd "$WASM" && cargo build --offline --release --target wasm32-unknown-unknown --manifest-path "${WASM}/Cargo.toml")
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d "${OUT}/.stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
"$WASM_BINDGEN" --target web --out-name rs_gsw_wasm --out-dir "$STAGE" \
	"${WASM}/target/wasm32-unknown-unknown/release/rs_gsw_wasm.wasm"
node "${HERE}/glue-factory.mjs" "${STAGE}/rs_gsw_wasm.js" "${STAGE}/rs_gsw_wasm_client.js"
mv "${STAGE}/rs_gsw_wasm_bg.wasm" "${OUT}/rs_gsw_wasm_bg.wasm"
mv "${STAGE}/rs_gsw_wasm_client.js" "${OUT}/rs_gsw_wasm_client.js"
wasm_sha="$(sha256sum "${OUT}/rs_gsw_wasm_bg.wasm" | cut -d' ' -f1)"
wasm_bytes="$(stat -c %s "${OUT}/rs_gsw_wasm_bg.wasm")"
cat >"${OUT}/build.json" <<JSON
{
  "schema": "render-stream-client-core/1",
  "rs_core_build": "sha=${sha}",
  "rs_core_tree": "${tree}",
  "wasm_sha256": "${wasm_sha}",
  "wasm_bytes": ${wasm_bytes},
  "wasm_bindgen": "0.2.129",
  "glue": "rs_gsw_wasm_client.js",
  "wasm": "rs_gsw_wasm_bg.wasm"
}
JSON
cat "${OUT}/build.json"
echo "out: ${OUT}"
