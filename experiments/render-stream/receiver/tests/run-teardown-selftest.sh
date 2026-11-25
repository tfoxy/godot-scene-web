#!/usr/bin/env bash
# Render the teardown regression on RD and GLES3 in a private gamescope session.
# Build the native extension and import the receiver project before running this script.
# Usage: run-teardown-selftest.sh [absolute evidence directory]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$HERE/../../scripts" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
RECEIVER_DIR="$(cd "$HERE/.." && pwd)"
OUT="${1:-$REPO_ROOT/.local/teardown-selftest-rendered}"
[[ "$OUT" = /* ]] || { echo 'Evidence directory must be absolute' >&2; exit 2; }
mkdir -p "$OUT"

LEGS_LOG=teardown-selftest
BINARY="$(mise which godot)"
HEADLESS_TIMEOUT_S=90
RENDERED_TIMEOUT_S=90
HAVE_STRACE=0
EXTENSION=""
CALIBRATION=""
FIXTURE_DIR="$RECEIVER_DIR"
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
trap 'gs_teardown "$OUT/gamescope"' EXIT

gs_start 640 360 "$OUT/gamescope"
failed=0
for method in mobile gl_compatibility; do
	driver=vulkan
	[ "$method" != gl_compatibility ] || driver=opengl3
	RENDERED_EXTRA_ARGS=(--rendering-method "$method" --rendering-driver "$driver"
		--verbose --script res://tests/teardown_selftest.gd)
	run_rendered "$OUT/$method" "$RECEIVER_DIR"
	if [ "$(cat "$OUT/$method/exit-code.txt")" != 0 ] ||
		rg -q 'ERROR:|RID allocations.*leaked|RIDs of type.*leaked' "$OUT/$method/stdout.log"; then
		failed=$((failed + 1))
		echo "$method: FAIL (see $OUT/$method/stdout.log)"
	else
		echo "$method: PASS"
	fi
done
quiet_summary "$OUT"
exit "$failed"
