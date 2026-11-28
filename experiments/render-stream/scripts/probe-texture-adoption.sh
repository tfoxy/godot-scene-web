#!/usr/bin/env bash
# Rendered late texture adoption against renderer-specific fixture expectations.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT=""; RENDERER=""; EXTENSION=""; PROBE_FIXTURE=gate8-adopt
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$(realpath -m "$2")"; shift 2 ;;
	--extension) EXTENSION="$(realpath "$2")"; shift 2 ;;
	--renderer) RENDERER="$2"; shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -n "$OUT" ] || { echo '--out required' >&2; exit 2; }
[[ "$RENDERER" = forward_plus || "$RENDERER" = gl_compatibility ]] || { echo 'choose --renderer forward_plus|gl_compatibility' >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "output exists: $OUT" >&2; exit 2; }
EXTENSION="${EXTENSION:-$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension}"
mkdir -p "$OUT/project" "$OUT/evidence" "$OUT/store" "$OUT/shots"
cp -aL "$EXPERIMENT_DIR/fixtures/$PROBE_FIXTURE/." "$OUT/project/"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
RECEIVER_DIR=""; FIXTURE_DIR=""; HEADLESS_TIMEOUT_S=120; RENDERED_TIMEOUT_S=60
HAVE_STRACE=0; LEGS_LOG=probe-texture-adoption
unset RS_SMOKE_LEGS RS_SABOTAGE_TIER RS_FAST_FRAMES GATE7_SMOKE_LEGS GATE7_FAST_FRAMES RS_LEG_SHARDS
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; fi
	if [ -n "${GS_RUN_DIR:-}" ]; then gs_teardown "$GS_RUN_DIR" || true; fi
}
trap cleanup EXIT
# Resolve mise's installed editor before changing XDG_DATA_HOME (which also relocates mise).
GODOT_EDITOR="$(mise which godot)"
LEG_ENV=(XDG_DATA_HOME="$OUT/xdg-data")
if [ -f "$OUT/project/make_sources.gd" ]; then
  run_headless "$OUT/sources" none -- "$GODOT_EDITOR" --headless --path "$OUT/project" --script res://make_sources.gd
fi
run_headless "$OUT/import" none -- "$GODOT_EDITOR" --headless --path "$OUT/project" --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
if rg -q 'SCRIPT ERROR|Parse Error' "$OUT/import/stdout.log"; then tail -40 "$OUT/import/stdout.log"; exit 1; fi
gs_start 640 360 "$OUT/gamescope"
ALLOW_RD=0
if [ "$RENDERER" = forward_plus ]; then ALLOW_RD=1; fi
LEG_ENV=(GRC_TEST_ALLOW_RD_READBACK="$ALLOW_RD" GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION= GRC_ABI_TABLE="$EXPERIMENT_DIR/calibration/abi/godot-4.5.1-rendering-server.json"
	GRC_MODE=arm RS_FIXTURE_ARM=late RS_FIXTURE_ARM_FRAME=12 RS_FIXTURE_STEP_LOG="$OUT/steps.jsonl" RS_FIXTURE_SHOT_DIR="$OUT/shots" GRC_CANVAS_TEXTURE_RESOLVE=0 GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip
	GRC_ADOPT_FRAME_BUDGET_US=1 GRC_STREAM_VERSION=13 GRC_VALIDATION_LOG=off GRC_EVIDENCE_DIR="$OUT/evidence"
	GRC_STREAM_OUT="$OUT/capture.grs" GRC_RESOURCE_STORE_DIR="$OUT/store"
	RS_CTRES_OUT="$OUT" XDG_DATA_HOME="$OUT/xdg-data")
RENDERED_EXTRA_ARGS=(--max-fps 60 --rendering-method "$RENDERER")
if [ "$RENDERER" = gl_compatibility ]; then
	RENDERED_EXTRA_ARGS+=(--rendering-driver opengl3)
else
	RENDERED_EXTRA_ARGS+=(--rendering-driver vulkan)
fi
run_rendered "$OUT/host" "$OUT/project"
[ "$(cat "$OUT/host/exit-code.txt")" = 0 ]
legs_run_checker python3 "$SCRIPT_DIR/lib/check-texture-adoption.py" "$OUT" "$RENDERER" "$EXPERIMENT_DIR/fixtures/$PROBE_FIXTURE/expected.json"
