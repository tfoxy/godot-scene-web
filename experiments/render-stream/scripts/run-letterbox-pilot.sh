#!/usr/bin/env bash
# Rendered root-size pilot. Capture never writes the host window.
# Usage: run-letterbox-pilot.sh --extension PATH --calibration PATH --out DIR [--binary PATH] [--resize-only]
# Requires build-capture.sh, receiver import + build-rs-core-ext.sh, and build-rs-core.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-size"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
EXTENSION="" CALIBRATION="" OUT=""
RESIZE_ONLY=0
while [ "$#" -gt 0 ]; do
	case "$1" in
	--extension) EXTENSION="${2:?}"; shift 2 ;;
	--calibration) CALIBRATION="${2:?}"; shift 2 ;;
	--out) OUT="${2:?}"; shift 2 ;;
	--binary) BINARY="${2:?}"; shift 2 ;;
	--resize-only) RESIZE_ONLY=1; shift ;;
	*) echo "run-letterbox-pilot: unknown argument $1" >&2; exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] && [ -f "$CALIBRATION" ] && [ -x "$BINARY" ] && [ -n "$OUT" ] || {
	echo 'run-letterbox-pilot: requires --extension, --calibration, --out and an executable binary' >&2
	exit 2
}
[ ! -e "$OUT" ] || { echo "run-letterbox-pilot: output already exists: $OUT" >&2; exit 2; }
for tool in gamescope xdotool xwininfo import; do
	command -v "$tool" >/dev/null || { echo "run-letterbox-pilot: missing $tool" >&2; exit 2; }
done
[ -f "$RECEIVER_DIR/ext/build/librs_core_ext.so" ] &&
	[ -f "$REPO_ROOT/artifacts/render-stream/rs-core/latest/gsw-rs/rs_gsw_wasm_bg.wasm" ] || {
	echo 'run-letterbox-pilot: build-rs-core-ext.sh and build-rs-core.sh must finish first' >&2
	exit 2
}
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
BINARY="$(realpath "$BINARY")"
LEGS_LOG=run-letterbox-pilot
HAVE_STRACE=0 HEADLESS_TIMEOUT_S=180 RENDERED_TIMEOUT_S=180
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
cleanup() {
	[ -z "${CURRENT_CHILD_PID:-}" ] || kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	[ -z "${WINDOW_SHOT_PID:-}" ] || kill "$WINDOW_SHOT_PID" 2>/dev/null || true
	[ -z "${GS_RUN_DIR:-}" ] || gs_teardown "$GS_RUN_DIR"
}
trap cleanup EXIT

# The native window includes the black bars; the fixture's viewport readback may exclude them.
# Wait for the final static checkpoint, then read this private X11 window (never the desktop).
window_shot() {
	local dir="$1" id="" tries=0
	while [ ! -f "$dir/shots/step-2.png" ] && [ "$tries" -lt 300 ]; do
		sleep 0.1
		tries=$((tries + 1))
	done
	[ -f "$dir/shots/step-2.png" ] || return 1
	xwininfo -root -tree >"$dir/window-tree.txt"
	id="$(xdotool search --onlyvisible --class '^render-stream-gate8-size-fixture$')"
	[ -n "$id" ]
	[[ "$id" != *$'\n'* ]] || { echo 'expected exactly one fixture window' >&2; return 1; }
	xwininfo -id "$id" >"$dir/window-info.txt"
	import -window "$id" "$dir/window.png"
	if [ "$RESIZE_ONLY" = 1 ]; then
		xdotool windowsize --sync "$id" 1600 900
		sleep 2
		xwininfo -id "$id" >"$dir/window-resized-info.txt"
		import -window "$id" "$dir/window-resized.png"
	fi
}

cases=(wide downscale)
[ "$RESIZE_ONLY" = 0 ] || cases=(resize)
for case_id in "${cases[@]}"; do
	case "$case_id" in
	wide | resize) window=1920x1080; presentation=2520x1080 ;;
	downscale) window=2560x1440; presentation=1920x1080 ;;
	esac
	dir="$OUT/$case_id"
	project="$dir/project"
	mkdir -p "$project"
	cp -a "$FIXTURE_DIR/." "$project/"
	rm -rf "$project/.godot"
	cat >"$project/override.cfg" <<EOF
[application]
run/main_scene="res://born.tscn"
[display]
window/size/viewport_width=${presentation%x*}
window/size/viewport_height=${presentation#*x}
window/stretch/aspect="keep"
EOF
	LEG_ENV=()
	run_headless "$dir/import" none -- mise exec -- godot --headless --path "$project" --import
	[ "$(cat "$dir/import/exit-code.txt")" = 0 ]
	gs_start "${window%x*}" "${window#*x}" "$dir/gamescope-host"
	modes=(reference observe)
	[ "$RESIZE_ONLY" = 0 ] || modes=(observe)
	for mode in "${modes[@]}"; do
		leg="$dir/$mode"
		mkdir -p "$leg/shots" "$leg/evidence" "$leg/store"
		LEG_ENV=(RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME=240
			RS_FIXTURE_SHOT_DIR="$leg/shots" RS_FIXTURE_STEP_LOG="$leg/steps.jsonl"
			RS_FIXTURE_SIZE_LOG="$leg/sizes.jsonl")
		if [ "$RESIZE_ONLY" = 1 ]; then
			LEG_ENV+=(RS_FIXTURE_QUIT_FRAME=1800 RS_FIXTURE_RESIZE_PROBE=on)
		fi
		if [ "$mode" = observe ]; then
			LEG_ENV+=(GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm GRC_VALIDATION_LOG=on
				GRC_ROOT_SIZE=observe GRC_STREAM_VERSION=13 GRC_EVIDENCE_DIR="$leg/evidence"
				GRC_STREAM_OUT="$leg/$RECORDING_NAME" GRC_RESOURCE_STORE_DIR="$leg/store")
		fi
		(unset WAYLAND_DISPLAY; export DISPLAY="$GS_DISPLAY"; window_shot "$leg") >"$leg/window-shot.log" 2>&1 &
		WINDOW_SHOT_PID=$!
		RENDERED_EXTRA_ARGS=(--windowed --resolution "$window" --position 0,0 --max-fps 60)
		run_rendered "$leg" "$project"
		wait "$WINDOW_SHOT_PID"
		WINDOW_SHOT_PID=""
		[ "$(cat "$leg/exit-code.txt")" = 0 ]
	done
	gs_teardown "$GS_RUN_DIR"
	GS_RUN_DIR=""
	if [ "$RESIZE_ONLY" = 0 ]; then
		CAPTURE_FIXTURE_DIR="$project"
		CAPTURE_EXTRA_ENV=(RS_FIXTURE_ARM=born GRC_STREAM_VERSION=13 GRC_ROOT_SIZE="presentation:$presentation"
			RS_FIXTURE_QUIT_FRAME=50)
		run_capture "$dir/headless" "" none
		[ "$(cat "$dir/headless/exit-code.txt")" = 0 ]
	fi
	gs_start "${presentation%x*}" "${presentation#*x}" "$dir/gamescope-receiver"
	modes=(observe headless)
	[ "$RESIZE_ONLY" = 0 ] || modes=(observe)
	for mode in "${modes[@]}"; do
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_PROTOCOL=13)
		RECEIVER_STATE=1
		RENDERED_EXTRA_ARGS=(--resolution "$presentation")
		run_rendered_receiver "$dir/$mode" "$dir/$mode/receiver"
		[ "$(cat "$dir/$mode/receiver/exit-code.txt")" = 0 ]
	done
	gs_teardown "$GS_RUN_DIR"
	GS_RUN_DIR=""
done
checker_args=()
[ "$RESIZE_ONLY" = 0 ] || checker_args=(--resize-only)
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/letterbox-pilot.ts" "$OUT" "${checker_args[@]}"
