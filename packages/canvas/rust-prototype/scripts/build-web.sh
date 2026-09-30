#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CRATE="$ROOT/packages/canvas/rust-prototype"
OUT="${GSW_RUST_PROTOTYPE_OUT:-$ROOT/.sts2/rust-prototype-web}"
TARGET="${GSW_RUST_PROTOTYPE_TARGET:-$ROOT/.sts2/rust-prototype-target}"
FEATURES="${GSW_RUST_PROTOTYPE_FEATURES:-webgl}"
OUT_NAME="${GSW_RUST_PROTOTYPE_OUT_NAME:-rust_prototype}"
mkdir -p "$OUT"
cargo build --manifest-path "$CRATE/Cargo.toml" --locked --target wasm32-unknown-unknown --features "$FEATURES" --release --target-dir "$TARGET"
"${GSW_WASM_BINDGEN_CLI:-wasm-bindgen}" --target web --out-name "$OUT_NAME" --out-dir "$OUT" "$TARGET/wasm32-unknown-unknown/release/godot_scene_web_rust_prototype.wasm"
