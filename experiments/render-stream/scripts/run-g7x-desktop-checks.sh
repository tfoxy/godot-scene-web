#!/usr/bin/env bash
# Gate 7x desktop correctness (gate7-design.md "G7x" R1), on D9's harness, against the built
# rs-gsw-wasm (scripts/build-rs-core.sh):
#   1. every input through the Rust arm once (draw-count-parity, record-digest-complete);
#   2. the pace input with expected.json's shots: 0 px against the model and the native reference;
#   3. the gate 6 scene's settle seqs against the native receiver's shots (report-only), when a
#      native receiver dir (scripts/run-g7x-scene-native.sh) is given;
#   4. the page-level sabotages (run-g7x-sabotages.sh), each of which must fail.
#
# Usage: run-g7x-desktop-checks.sh <inputs.json> <out dir> <pace reference shots> [<scene native dir>]
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUTS="$1"
OUT="$2"
REF="$3"
NATIVE="${4:-}"
FRAMES="$(python3 -c "import json;e=json.load(open('$HERE/../fixtures/gate7-pace/expected.json'));print(','.join(str(s['frame']) for s in e['steps']))")"
run() {
	mise exec -- pnpm exec tsx --conditions=development "$HERE/gate7-bench.ts" --arm gsw-rs --inputs "$INPUTS" \
		--warmup 0 --repeats 1 "$@"
}
check() {
	mise exec -- pnpm exec tsx --conditions=development "$HERE/gate7x-checks.ts" "$@"
}
rm -rf "$OUT/all" "$OUT/pace" "$OUT/scene"
mkdir -p "$OUT"
status=0
run --out "$OUT/all" >"$OUT/all.log" 2>&1
check --run "$OUT/all" || status=1
run --only pace-patch --shot-frames "$FRAMES" --out "$OUT/pace" >"$OUT/pace.log" 2>&1
check --run "$OUT/pace" --reference "$REF" || status=1
if [ -n "$NATIVE" ]; then
	SEQS="$(cat "$NATIVE/shot-seqs.txt")"
	run --only scene-patch --shot-seqs "$SEQS" --out "$OUT/scene" >"$OUT/scene.log" 2>&1
	check --run "$OUT/scene" --scene-native "$NATIVE" || status=1
fi
"$HERE/run-g7x-sabotages.sh" "$INPUTS" "$OUT" "$REF" || status=1
exit "$status"
