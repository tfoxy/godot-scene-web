#!/usr/bin/env bash
# One rendered 192 MiB pre-attach texture cycle, both with and without disarm trim.
# Usage: probe-capture-memory.sh --out DIR [--alloc-tracer FILE] [--renderer gl|vulkan] [--compressed] [--extension FILE] [--timing|--paired-timing] [--trim 0|1|both]
# --timing takes the runner timing lock and refuses load >=4; runs are always real-time.
# --paired-timing uses the runner's shared lock and records load without a quiet-machine
# threshold. Run interleaved pairs under the rendered-probe flock; compare within pairs only.
# No browser/receiver build is required.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
OUT=""
ALLOC_TRACER=""
RENDERER=gl
COMPRESSED=0
TIMING=0
PAIRED_TIMING=0
TRIMS=(0 1)
EXTENSION="$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension"
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$(realpath -m "$2")"; shift 2 ;;
	--alloc-tracer) ALLOC_TRACER="$(realpath "$2")"; shift 2 ;;
	--timing) TIMING=1; shift ;;
	--paired-timing) TIMING=1; PAIRED_TIMING=1; shift ;;
	--trim)
		case "$2" in
		0|1) TRIMS=("$2") ;;
		both) TRIMS=(0 1) ;;
		*) echo '--trim must be 0, 1 or both' >&2; exit 2 ;;
		esac
		shift 2 ;;
	--extension) EXTENSION="$(realpath "$2")"; shift 2 ;;
	--compressed) COMPRESSED=1; shift ;;
	--renderer) RENDERER="$2"; shift 2 ;;
	*) echo 'usage: probe-capture-memory.sh --out DIR [--alloc-tracer FILE] [--renderer gl|vulkan] [--compressed] [--extension FILE] [--timing]' >&2; exit 2 ;;
	esac
done
[ "$RENDERER" = gl ] || [ "$RENDERER" = vulkan ] || { echo 'renderer must be gl or vulkan' >&2; exit 2; }
[ -f "$EXTENSION" ] || { echo "extension not found: $EXTENSION" >&2; exit 2; }
[ -n "$OUT" ] || { echo '--out is required' >&2; exit 2; }
[ -z "$ALLOC_TRACER" ] || [ -f "$ALLOC_TRACER" ] || { echo 'allocation tracer not found' >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "output already exists: $OUT" >&2; exit 2; }
mkdir -p "$OUT/project"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
FIXTURE_DIR=""
HEADLESS_TIMEOUT_S=120
RENDERED_TIMEOUT_S=120
HAVE_STRACE=0
LEGS_LOG=probe-capture-memory
unset RS_SMOKE_LEGS RS_SABOTAGE_TIER RS_FAST_FRAMES RS_LEG_SHARDS
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
trap 'if [ -n "${GS_RUN_DIR:-}" ]; then gs_teardown "$GS_RUN_DIR" || true; fi' EXIT
cp "$SCRIPT_DIR/lib/capture-memory-probe.gd" "$OUT/project/probe.gd"
cat >"$OUT/project/project.godot" <<'PROJECT'
config_version=5
[application]
config/name="capture-memory-probe"
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=640
window/size/viewport_height=360
window/vsync/vsync_mode=0
[rendering]
renderer/rendering_method="gl_compatibility"
PROJECT
cat >"$OUT/project/main.tscn" <<'SCENE'
[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://probe.gd" id="1"]
[node name="MemoryProbe" type="Node2D"]
script = ExtResource("1")
SCENE
if [ "$RENDERER" = vulkan ]; then
	sed -i 's/gl_compatibility/mobile/' "$OUT/project/project.godot"
fi
printf '%s\n' "$RENDERER" >"$OUT/renderer.txt"
printf '%s\n' "$COMPRESSED" >"$OUT/compressed.txt"
LEG_ENV=()
run_headless "$OUT/import" none -- mise exec -- godot --headless --path "$OUT/project" --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
! rg -q 'SCRIPT ERROR|Parse Error' "$OUT/import/stdout.log"
gs_start 640 360 "$OUT/gamescope"
for trim in "${TRIMS[@]}"; do
	mkdir -p "$OUT/trim-$trim/evidence"
	LEG_ENV=(GRC_EXTENSION="$EXTENSION"
		GRC_CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
		GRC_MODE=detached GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_VALIDATION_LOG=off
		GRC_STREAM_VERSION=12 GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=33554432
		GRC_TEST_MEMORY_COMPRESSED="$COMPRESSED" GRC_TEST_MEMORY_ACCOUNTING=1 GRC_TEST_MEMORY_PHASE=initial GRC_TEST_TRIM_AT_DISARM="$trim"
		GRC_STREAM_OUT="$OUT/trim-$trim/stream.rs12"
		GRC_RESOURCE_STORE_DIR="$OUT/trim-$trim/store"
		GRC_EVIDENCE_DIR="$OUT/trim-$trim/evidence" XDG_DATA_HOME="$OUT/trim-$trim/xdg-data")
	if [ -n "$ALLOC_TRACER" ]; then
		LEG_ENV+=(LD_PRELOAD="$ALLOC_TRACER" RS_ALLOC_TRACE="$OUT/trim-$trim/alloc-trace.log")
	fi
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	[ "$RENDERER" != vulkan ] || RENDERED_EXTRA_ARGS+=(--rendering-driver vulkan --rendering-method mobile)
	if [ "$TIMING" = 1 ]; then
		uptime | tee -a "$OUT/load.txt"
		"$SCRIPT_DIR/lib/quiet.sh" status >>"$OUT/load.txt"
		if [ "$PAIRED_TIMING" != 1 ]; then
			python3 -c 'import os, sys; load = os.getloadavg()[0]; sys.exit(0 if load < 4 else "timing refused: load >= 4")'
		fi
		if [ "$PAIRED_TIMING" = 1 ]; then
			run_rendered "$OUT/trim-$trim/host" "$OUT/project"
		else
			timing_leg "trim-$trim" run_rendered "$OUT/trim-$trim/host" "$OUT/project"
		fi
	else
		run_rendered "$OUT/trim-$trim/host" "$OUT/project"
	fi
	# Also sample after the leg: a load average before a lock wait is insufficient evidence.
	uptime >>"$OUT/load.txt"
	[ "$(cat "$OUT/trim-$trim/host/exit-code.txt")" = 0 ]
	! rg -q 'SCRIPT ERROR|Assertion failed' "$OUT/trim-$trim/host/stdout.log"
done
legs_quiet_summary
python3 "$SCRIPT_DIR/lib/capture-memory-report.py" "$OUT"
