#!/usr/bin/env bash
# Build the `canvas-items-test` module (no wgpu renderer, no `RustRenderer`): the canvas-items
# executor plus `CanvasItemsTestHarness`, for packages/test-harness/test/canvasItemsRustPixel.test.ts.
# It is also the proof that `--no-default-features --features canvas-items` builds for wasm32.
# Output (ignored): artifacts/canvas-items-pixel/wasm/canvas_items.js and canvas_items_bg.wasm.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CRATE="$ROOT/packages/canvas/rust-prototype"
OUT="${GSW_CANVAS_ITEMS_OUT:-$ROOT/artifacts/canvas-items-pixel/wasm}"
TARGET="${GSW_CANVAS_ITEMS_TARGET:-$ROOT/artifacts/canvas-items-pixel/target}"
mkdir -p "$OUT"
cargo build --manifest-path "$CRATE/Cargo.toml" --locked --offline --target wasm32-unknown-unknown \
  --no-default-features --features canvas-items-test --release --target-dir "$TARGET"
"${GSW_WASM_BINDGEN_CLI:-wasm-bindgen}" --target web --out-name canvas_items --out-dir "$OUT" \
  "$TARGET/wasm32-unknown-unknown/release/godot_scene_web_rust_prototype.wasm"
