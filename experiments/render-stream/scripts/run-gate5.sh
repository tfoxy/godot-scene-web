#!/usr/bin/env bash
# Gate 5 runner: drives fixtures/gate5/ through the legs of protocol/gate5-design.md "Q7. Runner,
# legs, checks, report" for the groups that have landed, then runs check-gate5.ts.
#
#   bash run-gate5.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g5b,g5c,g5d,g5e]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate5/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g5b (G5b: the
# immediate-geometry fixture's import, a 400-frame headless capture with both sinks and the store
# -- `success` on render-stream/4 since G5d, `unsupported` with every geometry op typed on /3 --,
# its rendered reference, a same-build repeat, and an extension-armed reference), g5c (G5c:
# fixtures/gate5-mesh's import, a 400-frame headless capture with both sinks and the store,
# `success` since G5e (the mirror's mesh table; `unsupported` with canvas_item_add_mesh typed
# before), whose mesh hook log is the census, its rendered reference and a same-build repeat with
# the mesh oracle on, and an extension-armed reference with the oracle off; under <out>/mesh/), g5d
# (G5d: the rendered receiver on g5b's capture's full and patch sinks, a headless receiver under
# strace, the `canvas` variant's headless capture, and the sabotages -- freeze-frame @11,
# perturb-vertex @21 and omit-op canvas_item_add_polygon @21 captures each with a rendered
# receiver, and the receiver sabotages ignore-set-transform and ignore-clip-ignore on the main
# capture; g5d needs g5b's capture and reference in the same run), g5e (G5e: meshes end to end on
# fixtures/gate5-mesh, under <out>/mesh/ -- rendered receivers on g5c's capture's full and patch
# sinks, a headless receiver under strace, an all-inline 400-frame capture and its receiver, the
# host sabotages freeze-frame @11, omit-op mesh_surface_update_vertex_region @21 and perturb-vertex
# @21 each with a rendered receiver, and the receiver sabotages drop-mesh-surface and stale-mesh on
# g5c's capture; g5e needs g5c's capture and reference in the same run), g5f (G5f: live legs on
# fixtures/gate5-mesh with gate 1's and gate 2's live timeline (S=300, N=60, LAST_STEP=9, quit=851)
# under <out>/mesh/ -- a rendered reference at that same timeline (so DF's per-frame band lines up
# with the live shots), live-mesh (host + rendered live receiver, fresh cache), live-mesh-warm (a
# new host + a new rendered receiver on live-mesh's cache), live-mesh-stall
# (RS_RECEIVER_STALL=1:2000, step 1) and sabotage-mesh-stale-coalesce (the same stall, host
# GRC_SABOTAGE=stale-coalesce from step 1's frame); g5f imports both projects itself and does not
# need g5c's own legs) and g5g (G5g: fixtures/gate5-style under <out>/style/ -- import, capture
# (`success` on /4), reference, repeat and armed reference, rendered receivers on both sinks, a
# headless receiver under strace and the receiver sabotage ignore-nine-patch-axis; it imports
# receiver/ itself).
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Every capture runs with GRC_ROOT_SIZE=enforce-min-size
# (gate5-design.md Q6).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate5"
MESH_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate5-mesh"
STYLE_DIR="$EXPERIMENT_DIR/fixtures/gate5-style"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order.
LANDED_GROUPS=(g5b g5c g5d g5e g5f g5g)
KNOWN_GROUPS=(g5b g5c g5d g5e g5f g5g)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The capture runs 400 frames so the /proc maps/fd sample has time to run (gate4-design.md G4a
# amendment); the rendered legs run the fixture's default quit frame (S + N*9 + 11 = 102).
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180

# G5f: the live timeline (gate 1's and gate 2's pattern) on fixtures/gate5-mesh's own step model
# (LAST_STEP 9, SETTLE_OFFSET 7, QUIT_AFTER_LAST_SETTLE 4): S=300, N=60 so a 60 fps receiver has
# slack between steps, quit = S + N*LAST_STEP + 7 + 4.
G5F_LAST_STEP=9
G5F_START_FRAME=300
G5F_STEP_FRAMES=60
G5F_QUIT_FRAME=$((G5F_START_FRAME + G5F_STEP_FRAMES * G5F_LAST_STEP + 11))
# <step>:<ms> (gate1-design.md G1d, memory rs-g1d-stall-facts): after step 1's shot, block the
# receiver long enough that DF (every-frame geometry) changes for well over 60 frames and step 2's
# applied change (frame S+2N) lands inside the stall.
G5F_STALL_SPEC="1:2000"

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--extension)
		EXTENSION="${2:-}"
		shift 2
		;;
	--calibration)
		CALIBRATION="${2:-}"
		shift 2
		;;
	--binary)
		BINARY="${2:-}"
		shift 2
		;;
	--out)
		OUT="${2:-}"
		shift 2
		;;
	--legs)
		LEGS_ARG="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate5 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate5: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate5: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate5: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate5: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
for project in "$FIXTURE_DIR" "$MESH_FIXTURE_DIR"; do
	if [ ! -f "$project/project.godot" ]; then
		echo "run-gate5: $project/project.godot is missing" >&2
		exit 1
	fi
done

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${LANDED_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate5: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate5: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate5: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate5/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate5: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate5: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
printf '{"path": "%s", "sha256": "%s"}\n' "$BINARY" "$ACTUAL_BINARY_SHA256" >"$OUT/binary.json"
{
	printf '{"groups_run": ['
	sep=""
	for group in "${GROUPS_RUN[@]}"; do
		printf '%s"%s"' "$sep" "$group"
		sep=", "
	done
	printf '], "groups_landed": ['
	sep=""
	for group in "${LANDED_GROUPS[@]}"; do
		printf '%s"%s"' "$sep" "$group"
		sep=", "
	done
	printf ']}\n'
} >"$OUT/legs.json"

HAVE_STRACE=0
command -v strace >/dev/null 2>&1 && HAVE_STRACE=1
[ "$HAVE_STRACE" = "1" ] || echo "run-gate5: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate5: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# render-stream/4 since G5d (/3 from G4e2; the file names keep their .rs2 spelling, as the rs2
# modules do): every capture writes both sinks (recording.rs2 full, recording-patch.rs2 patch) and
# its payload store <capture>/store.
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate5"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# A rendered fixture run (reference, reference-repeat, reference-armed): shots step-0..9 at the
# settle frames and the step log. REFERENCE_ARMED=1 loads the capture extension armed with a
# full-sink stream and its store. REFERENCE_VARIANT sets RS_FIXTURE_VARIANT. REFERENCE_FIXTURE_DIR
# picks the project (default FIXTURE_DIR) and REFERENCE_MESH_ORACLE=1 turns the mesh oracle on
# (RS_FIXTURE_MESH_LOG=<dir>/meshes.jsonl, fixtures/gate5-mesh only). REFERENCE_START_FRAME /
# _STEP_FRAMES / _QUIT_FRAME (G5f) override the fixture's own step timeline, so the shots land on
# the live timeline's own frames (DF's per-frame band only lines up with a live shot taken at the
# identical frame number). All are reset after the call.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
REFERENCE_FIXTURE_DIR=""
REFERENCE_MESH_ORACLE=0
REFERENCE_START_FRAME=""
REFERENCE_STEP_FRAMES=""
REFERENCE_QUIT_FRAME=""
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT"
	local project="${REFERENCE_FIXTURE_DIR:-$FIXTURE_DIR}" oracle="$REFERENCE_MESH_ORACLE"
	local start="$REFERENCE_START_FRAME" span="$REFERENCE_STEP_FRAMES" quit="$REFERENCE_QUIT_FRAME"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	REFERENCE_FIXTURE_DIR=""
	REFERENCE_MESH_ORACLE=0
	REFERENCE_START_FRAME=""
	REFERENCE_STEP_FRAMES=""
	REFERENCE_QUIT_FRAME=""
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	if [ "$oracle" = "1" ]; then
		LEG_ENV+=(RS_FIXTURE_MESH_LOG="$dir/meshes.jsonl")
	fi
	if [ -n "$start" ]; then
		LEG_ENV+=(RS_FIXTURE_START_FRAME="$start")
	fi
	if [ -n "$span" ]; then
		LEG_ENV+=(RS_FIXTURE_STEP_FRAMES="$span")
	fi
	if [ -n "$quit" ]; then
		LEG_ENV+=(RS_FIXTURE_QUIT_FRAME="$quit")
	fi
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store"
		)
	fi
	run_rendered "$dir" "$project"
}

run_g5b() {
	# import: the release template cannot load a loose project until the editor generated .godot/.
	echo "run-gate5: import"
	mkdir -p "$OUT/import"
	LEG_ENV=()
	run_headless "$OUT/import/fixture" none -- mise exec -- godot --headless --path "$FIXTURE_DIR" --import
	if [ "$(cat "$OUT/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $FIXTURE_DIR failed, see $OUT/import/fixture/stdout.log" >&2
		exit 1
	fi

	# The capture host (headless, release template, extension armed, both sinks and the store,
	# strace + /proc maps/fd sample). On render-stream/4 every geometry op is a command (G5d).
	echo "run-gate5: capture"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

	# Rendered legs: one private gamescope for all of them.
	echo "run-gate5: bringing up private gamescope for rendered legs"
	gs_start 640 360 "$OUT/gamescope"

	echo "run-gate5: reference"
	run_reference "$OUT/reference"
	echo "run-gate5: reference-repeat"
	run_reference "$OUT/reference-repeat"
	echo "run-gate5: reference-armed (extension armed, stream on)"
	REFERENCE_ARMED=1
	run_reference "$OUT/reference-armed"

	gs_teardown "$OUT/gamescope"
	GS_RUN_DIR=""
}

run_g5c() {
	local M="$OUT/mesh"
	mkdir -p "$M/import"
	echo "run-gate5: g5c: import"
	LEG_ENV=()
	run_headless "$M/import/fixture" none -- mise exec -- godot --headless --path "$MESH_FIXTURE_DIR" --import
	if [ "$(cat "$M/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $MESH_FIXTURE_DIR failed, see $M/import/fixture/stdout.log" >&2
		exit 1
	fi

	# capture-mesh: as g5b's capture; since G5e every add_mesh is a /4 command naming the mirror's
	# mesh table (success); evidence/resources.jsonl's mesh lines are the census and the hook hashes.
	echo "run-gate5: capture-mesh"
	CAPTURE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$M/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate5: bringing up private gamescope for g5c rendered legs"
	gs_start 640 360 "$OUT/gamescope-g5c"

	echo "run-gate5: reference-mesh (oracle on)"
	REFERENCE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	REFERENCE_MESH_ORACLE=1
	run_reference "$M/reference"
	echo "run-gate5: reference-mesh-repeat (oracle on)"
	REFERENCE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	REFERENCE_MESH_ORACLE=1
	run_reference "$M/reference-repeat"
	echo "run-gate5: reference-mesh-armed (extension armed, stream on, oracle off)"
	REFERENCE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	REFERENCE_ARMED=1
	run_reference "$M/reference-armed"

	gs_teardown "$OUT/gamescope-g5c"
	GS_RUN_DIR=""
}

# Step k's applied frame (S=1, N=10; gate5-design.md Q6).
step_frame5() { echo $((1 + 10 * $1)); }

# A headless sabotage or variant capture on the fixture's own default run (102 frames), both sinks
# and its store.
g5_capture() {
	local dir="$1"
	shift
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "" none
}

run_g5d() {
	if [ ! -f "$OUT/capture/$RECORDING_NAME" ]; then
		echo "run-gate5: g5d needs g5b's capture in the same run (pass --legs g5b,g5d)" >&2
		exit 2
	fi
	# The release template cannot run a loose project until the editor generated .godot/ (memory
	# receiver-needs-import-before-script): import the receiver once.
	echo "run-gate5: import (receiver)"
	LEG_ENV=()
	run_headless "$OUT/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$OUT/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $RECEIVER_DIR failed, see $OUT/import/receiver/stdout.log" >&2
		exit 1
	fi

	# A headless receiver under strace on the main capture (receiver-never-loaded-fixture).
	echo "run-gate5: receiver-headless-trace"
	if prepare_recording "$OUT/capture/$RECORDING_NAME" "$OUT/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$OUT/capture/store"
		run_receiver_headless "$OUT/receiver-headless-trace" openat
	fi

	# D11: the canvas variant's headless capture (classified from its recording alone).
	echo "run-gate5: capture-canvas (RS_FIXTURE_VARIANT=canvas)"
	g5_capture "$OUT/capture-canvas" RS_FIXTURE_VARIANT=canvas

	# Sabotage captures; predictions are fixtures/gate5/expected.json "predictions"
	# (make_expected.py, never hand-edited).
	echo "run-gate5: sabotage-freeze (capture, freeze-frame @$(step_frame5 1))"
	g5_capture "$OUT/sabotage-freeze/capture" GRC_SABOTAGE=freeze-frame GRC_SABOTAGE_FRAME="$(step_frame5 1)"
	echo "run-gate5: sabotage-perturb-vertex (capture, perturb-vertex @$(step_frame5 2))"
	g5_capture "$OUT/sabotage-perturb-vertex/capture" GRC_SABOTAGE=perturb-vertex GRC_SABOTAGE_FRAME="$(step_frame5 2)"
	echo "run-gate5: sabotage-omit-polygon (capture, omit-op canvas_item_add_polygon @$(step_frame5 2))"
	g5_capture "$OUT/sabotage-omit-polygon/capture" GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=canvas_item_add_polygon GRC_SABOTAGE_FRAME="$(step_frame5 2)"

	echo "run-gate5: bringing up private gamescope for g5d receiver legs"
	gs_start 640 360 "$OUT/gamescope-g5d"

	echo "run-gate5: receiver (full sink)"
	run_rendered_receiver "$OUT/capture" "$OUT/receiver"
	echo "run-gate5: receiver-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	run_rendered_receiver "$OUT/capture" "$OUT/receiver-patch"

	for kind in freeze perturb-vertex omit-polygon; do
		echo "run-gate5: sabotage-$kind (receiver)"
		run_rendered_receiver "$OUT/sabotage-$kind/capture" "$OUT/sabotage-$kind/receiver"
	done
	for kind in ignore-set-transform ignore-clip-ignore; do
		echo "run-gate5: sabotage-receiver-$kind (RS_RECEIVER_SABOTAGE=$kind on the main capture)"
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE="$kind")
		run_rendered_receiver "$OUT/capture" "$OUT/sabotage-receiver-$kind"
	done

	gs_teardown "$OUT/gamescope-g5d"
	GS_RUN_DIR=""
}

run_g5e() {
	local M="$OUT/mesh"
	if [ ! -f "$M/capture/$RECORDING_NAME" ] || [ ! -d "$M/reference/shots" ]; then
		echo "run-gate5: g5e needs g5c's capture and reference in the same run (pass --legs g5c,g5e)" >&2
		exit 2
	fi
	echo "run-gate5: g5e: import (receiver)"
	LEG_ENV=()
	run_headless "$M/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$M/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $RECEIVER_DIR failed, see $M/import/receiver/stdout.log" >&2
		exit 1
	fi

	# A headless receiver under strace on the mesh capture (receiver-never-loaded-fixture-mesh).
	echo "run-gate5: g5e: receiver-headless-trace (mesh)"
	if prepare_recording "$M/capture/$RECORDING_NAME" "$M/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$M/capture/store"
		run_receiver_headless "$M/receiver-headless-trace" openat
	fi

	# Every payload in band (no store): the 400-frame capture again with both thresholds raised
	# (memory rs-g2b2-texture-wire-facts: the inline capture also raises the max payload size).
	echo "run-gate5: g5e: capture-inline (every payload inline, no store)"
	CAPTURE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	CAPTURE_STORE_DIR=none
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_RESOURCE_INLINE_MAX_BYTES=16777216
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216)
	run_capture "$M/capture-inline" "$CAPTURE_QUIT_FRAME" none

	# Host sabotages on the mesh fixture's own default run; predictions are fixtures/gate5-mesh/
	# expected.json "predictions" (make_expected.py, never hand-edited).
	echo "run-gate5: g5e: sabotage-mesh-freeze (capture, freeze-frame @$(step_frame5 1))"
	CAPTURE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	g5_capture "$M/sabotage-mesh-freeze/capture" GRC_SABOTAGE=freeze-frame GRC_SABOTAGE_FRAME="$(step_frame5 1)"
	echo "run-gate5: g5e: sabotage-mesh-omit-vertex-region (capture, omit-op mesh_surface_update_vertex_region @$(step_frame5 2))"
	CAPTURE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	g5_capture "$M/sabotage-mesh-omit-vertex-region/capture" GRC_SABOTAGE=omit-op \
		GRC_SABOTAGE_OP=mesh_surface_update_vertex_region GRC_SABOTAGE_FRAME="$(step_frame5 2)"
	echo "run-gate5: g5e: sabotage-mesh-perturb-vertex (capture, perturb-vertex @$(step_frame5 2))"
	CAPTURE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	g5_capture "$M/sabotage-mesh-perturb-vertex/capture" GRC_SABOTAGE=perturb-vertex GRC_SABOTAGE_FRAME="$(step_frame5 2)"

	echo "run-gate5: bringing up private gamescope for g5e receiver legs"
	gs_start 640 360 "$OUT/gamescope-g5e"

	echo "run-gate5: g5e: receiver-mesh (full sink)"
	run_rendered_receiver "$M/capture" "$M/receiver"
	echo "run-gate5: g5e: receiver-mesh-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	run_rendered_receiver "$M/capture" "$M/receiver-patch"
	echo "run-gate5: g5e: receiver-mesh-inline (capture-inline, no store)"
	run_rendered_receiver "$M/capture-inline" "$M/receiver-inline"
	for kind in freeze omit-vertex-region perturb-vertex; do
		echo "run-gate5: g5e: sabotage-mesh-$kind (receiver)"
		run_rendered_receiver "$M/sabotage-mesh-$kind/capture" "$M/sabotage-mesh-$kind/receiver"
	done
	echo "run-gate5: g5e: sabotage-mesh-receiver-drop-surface (RS_RECEIVER_SABOTAGE=drop-mesh-surface)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=drop-mesh-surface)
	run_rendered_receiver "$M/capture" "$M/sabotage-mesh-receiver-drop-surface"
	echo "run-gate5: g5e: sabotage-mesh-receiver-stale (RS_RECEIVER_SABOTAGE=stale-mesh)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=stale-mesh)
	run_rendered_receiver "$M/capture" "$M/sabotage-mesh-receiver-stale"

	gs_teardown "$OUT/gamescope-g5e"
	GS_RUN_DIR=""
}

# G5f: live legs on fixtures/gate5-mesh, gate 1's and gate 2's live timeline (G5F_START_FRAME,
# G5F_STEP_FRAMES, G5F_QUIT_FRAME above). start_live_mesh_host <dir> [extra env words...]: the
# mesh fixture host (headless, armed, both file sinks and their store, --max-fps 60) serving on
# 127.0.0.1:0 in the background. Waits for evidence/live.json and sets LIVE_PORT ("" when the host
# is not listening).
start_live_mesh_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME" GRC_RESOURCE_STORE_DIR="$dir/store"
		GRC_ROOT_SIZE=enforce-min-size GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		RS_FIXTURE_START_FRAME="$G5F_START_FRAME" RS_FIXTURE_STEP_FRAMES="$G5F_STEP_FRAMES"
		RS_FIXTURE_QUIT_FRAME="$G5F_QUIT_FRAME" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" "$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$MESH_FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate5: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

# The live receiver's shot windows for G5f's timeline: <step>:<from>-<to>, steps 0..G5F_LAST_STEP
# (gate 1's rule: from the settle frame to the frame before the next step; the last to the quit).
g5f_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 "$G5F_LAST_STEP"); do
		from=$((G5F_START_FRAME + G5F_STEP_FRAMES * k + 7))
		to=$((G5F_START_FRAME + G5F_STEP_FRAMES * (k + 1) - 1))
		[ "$k" -eq "$G5F_LAST_STEP" ] && to=$G5F_QUIT_FRAME
		out+="$sep$k:$from-$to"
		sep=","
	done
	echo "$out"
}

# g5f_receiver <leg dir> <rendered|headless> [extra env words...]: a live receiver on the current
# host's port with a fresh cache at <leg>/receiver/cache (the extra words may override it) and
# --max-fps 60. Rendered receivers shoot the step windows (credit stage submitted); headless ones
# run with credit stage applied under strace -e openat.
g5f_receiver() {
	local leg="$1" kind="$2" dir="$1/receiver"
	shift 2
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate5: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_CACHE_DIR="$dir/cache" "$@"
	)
	if [ "$kind" = "headless" ]; then
		LEG_ENV+=(RS_RECEIVER_CREDIT_STAGE=applied)
		run_headless "$dir" openat -- "$BINARY" --headless --max-fps 60 --path "$RECEIVER_DIR"
	else
		LEG_ENV+=(RS_RECEIVER_SHOT_WINDOWS="$(g5f_windows)")
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$dir" "$RECEIVER_DIR"
	fi
}

# g5f_leg <leg> <rendered|headless> <host words...> -- <receiver words...>: one live host and one
# receiver against it, then the host to its quit frame.
g5f_leg() {
	local leg="$1" kind="$2"
	shift 2
	local -a host_words=() receiver_words=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		host_words+=("$1")
		shift
	done
	[ $# -gt 0 ] && shift
	receiver_words=("$@")
	start_live_mesh_host "$M/$leg/host" ${host_words[@]+"${host_words[@]}"}
	g5f_receiver "$M/$leg" "$kind" ${receiver_words[@]+"${receiver_words[@]}"}
	finish_bg "$M/$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
}

run_g5f() {
	local M="$OUT/mesh" f1
	f1=$((G5F_START_FRAME + G5F_STEP_FRAMES * 1))
	mkdir -p "$M/import"
	echo "run-gate5: g5f: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$M/import/fixture-g5f" none -- mise exec -- godot --headless --path "$MESH_FIXTURE_DIR" --import
	if [ "$(cat "$M/import/fixture-g5f/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $MESH_FIXTURE_DIR failed, see $M/import/fixture-g5f/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$M/import/receiver-g5f" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$M/import/receiver-g5f/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $RECEIVER_DIR failed, see $M/import/receiver-g5f/stdout.log" >&2
		exit 1
	fi

	echo "run-gate5: bringing up private gamescope for g5f legs"
	gs_start 640 360 "$OUT/gamescope-g5f"

	echo "run-gate5: g5f: reference-live (S=$G5F_START_FRAME N=$G5F_STEP_FRAMES quit=$G5F_QUIT_FRAME)"
	REFERENCE_FIXTURE_DIR="$MESH_FIXTURE_DIR"
	REFERENCE_START_FRAME="$G5F_START_FRAME"
	REFERENCE_STEP_FRAMES="$G5F_STEP_FRAMES"
	REFERENCE_QUIT_FRAME="$G5F_QUIT_FRAME"
	run_reference "$M/reference-live"

	echo "run-gate5: g5f: live-mesh (host + rendered live receiver, fresh cache, shot windows $(g5f_windows))"
	g5f_leg live-mesh rendered
	echo "run-gate5: g5f: live-mesh-warm (a new host + a new rendered receiver on live-mesh's cache, mode warm)"
	g5f_leg live-mesh-warm rendered -- \
		RS_RECEIVER_CACHE_DIR="$M/live-mesh/receiver/cache" RS_RECEIVER_CACHE_MODE=warm
	echo "run-gate5: g5f: live-mesh-stall (RS_RECEIVER_STALL=$G5F_STALL_SPEC)"
	g5f_leg live-mesh-stall rendered -- RS_RECEIVER_STALL="$G5F_STALL_SPEC"
	echo "run-gate5: g5f: sabotage-mesh-stale-coalesce (stale-coalesce @$f1, RS_RECEIVER_STALL=$G5F_STALL_SPEC)"
	g5f_leg sabotage-mesh-stale-coalesce rendered GRC_SABOTAGE=stale-coalesce GRC_SABOTAGE_FRAME="$f1" -- \
		RS_RECEIVER_STALL="$G5F_STALL_SPEC"

	gs_teardown "$OUT/gamescope-g5f"
	GS_RUN_DIR=""
}

# G5g: fixtures/gate5-style through G5b's and G5d's legs, evidence under <out>/style/ in their
# shape. Predictions are fixtures/gate5-style/expected.json's (make_expected.py).
run_g5g() {
	local L="$OUT/style"
	echo "run-gate5: g5g: import (fixture, receiver)"
	mkdir -p "$L/import"
	LEG_ENV=()
	run_headless "$L/import/fixture" none -- mise exec -- godot --headless --path "$STYLE_DIR" --import
	if [ "$(cat "$L/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $STYLE_DIR failed, see $L/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$L/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$L/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate5: import of $RECEIVER_DIR failed, see $L/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate5: capture-style"
	CAPTURE_FIXTURE_DIR="$STYLE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$L/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate5: g5g: receiver-headless-trace"
	if prepare_recording "$L/capture/$RECORDING_NAME" "$L/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$L/capture/store"
		run_receiver_headless "$L/receiver-headless-trace" openat
	fi

	echo "run-gate5: bringing up private gamescope for g5g rendered legs"
	gs_start 640 360 "$OUT/gamescope-g5g"

	echo "run-gate5: reference-style"
	REFERENCE_FIXTURE_DIR="$STYLE_DIR"
	run_reference "$L/reference"
	echo "run-gate5: reference-style-repeat"
	REFERENCE_FIXTURE_DIR="$STYLE_DIR"
	run_reference "$L/reference-repeat"
	echo "run-gate5: reference-style-armed (extension armed, stream on)"
	REFERENCE_FIXTURE_DIR="$STYLE_DIR"
	REFERENCE_ARMED=1
	run_reference "$L/reference-armed"

	echo "run-gate5: receiver-style (full sink)"
	run_rendered_receiver "$L/capture" "$L/receiver"
	echo "run-gate5: receiver-style-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	run_rendered_receiver "$L/capture" "$L/receiver-patch"
	echo "run-gate5: sabotage-style-receiver-ignore-axis (RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis)
	run_rendered_receiver "$L/capture" "$L/sabotage-receiver-ignore-axis"

	gs_teardown "$OUT/gamescope-g5g"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g5b) run_g5b ;;
	g5c) run_g5c ;;
	g5d) run_g5d ;;
	g5e) run_g5e ;;
	g5f) run_g5f ;;
	g5g) run_g5g ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate5: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate5.ts" --out "$OUT"
