#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CRATE="$ROOT/packages/canvas/msdf-generator"
OUT="${GSW_MSDF_GENERATOR_OUT:-$ROOT/.sts2/msdf-generator-web}"
TARGET="${GSW_MSDF_GENERATOR_TARGET:-$ROOT/.sts2/msdf-generator-target}"
mkdir -p "$OUT"
cargo build --manifest-path "$CRATE/Cargo.toml" --locked --target wasm32-unknown-unknown --release --target-dir "$TARGET"
"${GSW_WASM_BINDGEN_CLI:-wasm-bindgen}" --target web --out-name msdf_generator --out-dir "$OUT" \
  "$TARGET/wasm32-unknown-unknown/release/godot_scene_web_msdf_generator.wasm"
