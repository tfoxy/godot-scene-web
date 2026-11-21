#!/usr/bin/env bash
# Build the canvas-items test wasm and gate both pixel suites. File parallelism is disabled:
# each suite can build the same wasm, and concurrent builds would race over its output.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if [ "$#" != 2 ] || [ "$1" != --out ]; then
	echo "usage: run-canvas-pixel.sh --out DIR" >&2
	exit 2
fi
mkdir -p "$2"
OUT="$(realpath "$2")"
rc=0
bash "$SCRIPT_DIR/lib/quiet.sh" shared --label validate:canvas-pixel --log "$OUT/quiet-lock.jsonl" -- \
	bash -euo pipefail -c '
		cd "$1"
		export GSW_CANVAS_ITEMS_PIXEL=1
		export GSW_CANVAS_ITEMS_OUT="$1/artifacts/canvas-items-pixel/wasm"
		export GSW_CANVAS_ITEMS_TARGET="$1/artifacts/canvas-items-pixel/target"
		export GSW_CANVAS_ITEMS_WASM="$GSW_CANVAS_ITEMS_OUT"
		mise exec -- bash packages/canvas/rust-prototype/scripts/build-canvas-items-test.sh
		mise exec -- pnpm exec vitest run --no-file-parallelism \
			packages/test-harness/test/canvasItemsRustPixel.test.ts \
			packages/test-harness/test/canvasItemsProgramPixel.test.ts
	' _ "$ROOT" || rc=$?
bash "$SCRIPT_DIR/lib/quiet.sh" summary "$OUT/quiet-lock.jsonl" \
	--out "$OUT/quiet-lock-summary.json" >/dev/null
exit "$rc"
