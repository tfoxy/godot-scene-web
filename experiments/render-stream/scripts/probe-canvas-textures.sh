#!/usr/bin/env bash
# Opt-in late-load CanvasTexture proof, adopted payload hashes (no receiver dependency).
# Usage: probe-canvas-textures.sh --out DIR (--calibration FILE | --derived) --renderer forward_plus|gl_compatibility
# --negative-control disables resolution; --bad-record-control expects self-check refusal.
# --bad-derivation-control mutates a local instruction copy and requires zero storage/owner reads.
# --correctness-only makes no timing claim.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT=""; CALIBRATION=""; RENDERER=""; EXTENSION=""; NEGATIVE_CONTROL=0; CORRECTNESS_ONLY=0; BAD_RECORD_CONTROL=0; DERIVED=0; BAD_DERIVATION_CONTROL=0
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$(realpath -m "$2")"; shift 2 ;;
	--calibration) CALIBRATION="$(realpath "$2")"; shift 2 ;;
	--derived) DERIVED=1; shift ;;
	--bad-derivation-control) BAD_DERIVATION_CONTROL=1; DERIVED=1; shift ;;
	--extension) EXTENSION="$(realpath "$2")"; shift 2 ;;
	--renderer) RENDERER="$2"; shift 2 ;;
	--negative-control) NEGATIVE_CONTROL=1; shift ;;
	--correctness-only) CORRECTNESS_ONLY=1; shift ;;
	--bad-record-control) BAD_RECORD_CONTROL=1; shift ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -n "$OUT" ] || { echo '--out required' >&2; exit 2; }
if [ "$DERIVED" = 1 ]; then
	[ -z "$CALIBRATION" ] || { echo '--derived and --calibration are mutually exclusive' >&2; exit 2; }
else
	[ -f "$CALIBRATION" ] || { echo '--calibration or --derived required' >&2; exit 2; }
fi
[[ "$RENDERER" = forward_plus || "$RENDERER" = gl_compatibility ]] || { echo 'choose --renderer forward_plus|gl_compatibility' >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "output exists: $OUT" >&2; exit 2; }
mkdir -p "$OUT/project" "$OUT/evidence" "$OUT/store"
cp "$EXPERIMENT_DIR/fixtures/canvas-texture-resolve/probe.gd" "$OUT/project/"
cat >"$OUT/project/project.godot" <<PROJECT
config_version=5
[application]
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=320
window/size/viewport_height=180
[rendering]
renderer/rendering_method="$RENDERER"
PROJECT
cat >"$OUT/project/main.tscn" <<'SCENE'
[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://probe.gd" id="1"]
[node name="Probe" type="Node2D"]
script = ExtResource("1")
SCENE
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
EXTENSION="${EXTENSION:-$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension}"
RECEIVER_DIR=""; FIXTURE_DIR=""; HEADLESS_TIMEOUT_S=120; RENDERED_TIMEOUT_S=60
HAVE_STRACE=0; LEGS_LOG=probe-canvas-textures
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
run_headless "$OUT/import" none -- "$GODOT_EDITOR" --headless --path "$OUT/project" --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
if rg -q 'SCRIPT ERROR|Parse Error' "$OUT/import/stdout.log"; then tail -40 "$OUT/import/stdout.log"; exit 1; fi
gs_start 320 180 "$OUT/gamescope"
if [ "$NEGATIVE_CONTROL" = 1 ]; then export GRC_CANVAS_TEXTURE_RESOLVE=0; fi
CALIB_ENV=(GRC_CALIBRATION="$CALIBRATION" GRC_ABI_TABLE=)
if [ "$DERIVED" = 1 ]; then
	CALIB_ENV=(GRC_CALIBRATION= GRC_ABI_TABLE="$EXPERIMENT_DIR/calibration/abi/godot-4.5.1-rendering-server.json")
fi
SABOTAGE=""
if [ "$BAD_DERIVATION_CONTROL" = 1 ]; then SABOTAGE=derive-create-opcode; fi
LEG_ENV=(GRC_EXTENSION="$EXTENSION" "${CALIB_ENV[@]}" GRC_MODE=detached GRC_CTRES_SABOTAGE="$SABOTAGE"
	GRC_CANVAS_TEXTURE_RESOLVE="${GRC_CANVAS_TEXTURE_RESOLVE:-1}" GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip
	# A tiny budget forces the CanvasTexture/channel dependency across frame drains.
	GRC_ADOPT_FRAME_BUDGET_US=1 GRC_STREAM_VERSION=13 GRC_VALIDATION_LOG=off GRC_EVIDENCE_DIR="$OUT/evidence"
	GRC_STREAM_OUT="$OUT/capture.grs" GRC_RESOURCE_STORE_DIR="$OUT/store"
	RS_CTRES_OUT="$OUT" XDG_DATA_HOME="$OUT/xdg-data")
RENDERED_EXTRA_ARGS=(--max-fps 60 --rendering-method "$RENDERER")
if [ "$RENDERER" = forward_plus ]; then RENDERED_EXTRA_ARGS+=(--rendering-driver vulkan); fi
if [ "$NEGATIVE_CONTROL" = 1 ] || [ "$CORRECTNESS_ONLY" = 1 ] || [ "$BAD_RECORD_CONTROL" = 1 ] || [ "$BAD_DERIVATION_CONTROL" = 1 ]; then
	printf 'correctness only; resolve timings excluded\n' >"$OUT/timing-excluded.txt"
	run_rendered "$OUT/host" "$OUT/project"
else
	uptime >"$OUT/timing-preflight.log"
	bash "$SCRIPT_DIR/lib/quiet.sh" status >>"$OUT/timing-preflight.log"
	python3 - <<'PY_LOAD'
from pathlib import Path
load = float(Path("/proc/loadavg").read_text().split()[0])
if load > 4:
    raise SystemExit(f"timing deferred: load {load:.2f} exceeds 4; use --correctness-only")
PY_LOAD
	timing_leg "resolve-$RENDERER" run_rendered "$OUT/host" "$OUT/project"
fi
[ "$(cat "$OUT/host/exit-code.txt")" = 0 ]
CHECK_ARGS=()
if [ "$NEGATIVE_CONTROL" = 1 ]; then CHECK_ARGS+=(--negative-control); fi
if [ "$BAD_RECORD_CONTROL" = 1 ]; then CHECK_ARGS+=(--selfcheck-mismatch); fi
if [ "$DERIVED" = 1 ]; then CHECK_ARGS+=(--derived); fi
if [ "$BAD_DERIVATION_CONTROL" = 1 ]; then CHECK_ARGS+=(--bad-derivation); fi
legs_run_checker python3 "$SCRIPT_DIR/lib/check-canvas-textures.py" "$OUT" "$RENDERER" "${CHECK_ARGS[@]}"
