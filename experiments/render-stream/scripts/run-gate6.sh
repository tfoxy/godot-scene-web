#!/usr/bin/env bash
# Gate 6 runner: drives fixtures/gate6-scene through the legs of protocol/gate6-design.md
# "Q7. Runner, legs, checks, report" for the groups that have landed, then runs check-gate6.ts.
#
#   bash run-gate6.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g6a]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate6/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g6a (G6a, on
# render-stream/5): the fixture's and the receiver's import; under <out>/scene/ a 400-frame
# headless capture with both sinks and the store (capture-scene), an all-inline capture
# (capture-scene-inline), its rendered reference and a same-build repeat with the scene oracle on
# (reference-scene, -repeat), an extension-armed reference with the oracle off (-armed), and
# rendered receivers on the full sink, the patch sink with state dumps at the settle seqs and the
# inline capture (receiver-scene, -patch, -inline); under <out>/animate/ and <out>/refused/ the
# variant's capture, reference (oracle on) and receiver; and under <out>/scene/ the host sabotages
# freeze-frame @11, omit-op canvas_item_set_transform @21, perturb-vertex @21 and perturb-shader
# @21 (each a capture plus a rendered receiver) and the receiver sabotages ignore-clip and
# stale-texture on capture-scene. Every rendered leg shoots the settle frames and the
# intermediate frames 13, 53 and 93 (Q6c); receivers shoot the seqs published at those frames.
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Every capture runs with GRC_ROOT_SIZE=enforce-min-size
# (gate6-design.md D4: stretch `disabled`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
SCENE_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate6-scene"
FIXTURE_DIR="$SCENE_FIXTURE_DIR"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order.
LANDED_GROUPS=(g6a)
KNOWN_GROUPS=(g6a g6h g6b g6l g6s g6c g6p)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The capture runs 400 frames so the /proc maps/fd sample has time to run (gate4-design.md G4a
# amendment); rendered legs and sabotage captures run the fixture's default file timeline (S=1,
# N=10, step k at 1 + 10k, settle +7, quit S + 11N + 11 = 122).
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180
# Q6c: the file timeline's intermediate shot frames S + N k + 2, k in {1, 5, 9}.
MID_FRAMES=(13 53 93)

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
		# `pnpm render-stream:gate6 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate6: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate6: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate6: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate6: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
if [ ! -f "$SCENE_FIXTURE_DIR/project.godot" ]; then
	echo "run-gate6: $SCENE_FIXTURE_DIR/project.godot is missing" >&2
	exit 1
fi

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${LANDED_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate6: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate6: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate6: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate6/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate6: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate6: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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
[ "$HAVE_STRACE" = "1" ] || echo "run-gate6: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate6: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# The capture writes both sinks under gate 2's .rs2 names whatever wire version main speaks
# (render-stream/5 until G6b), and its payload store <capture>/store.
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate6"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# Every new GRC_*/RS_* variable gate 6 adds is covered by gs_strip_env_args's GRC_*/RS_* prefix
# strip; nothing else needs adding to GS_STRIP_VARS for G6a.

# A rendered fixture run (reference, reference-repeat, reference-armed): shots step-0..11 at the
# settle frames plus frame-13/53/93.png, and the step log. REFERENCE_ARMED=1 loads the capture
# extension armed with a full-sink stream and its store. REFERENCE_VARIANT sets
# RS_FIXTURE_VARIANT. REFERENCE_ORACLE=1 turns the scene oracle on
# (RS_FIXTURE_ORACLE_LOG=<dir>/oracle.jsonl). All are reset after the call.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
REFERENCE_ORACLE=0
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT" oracle="$REFERENCE_ORACLE"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	REFERENCE_ORACLE=0
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	if [ "$oracle" = "1" ]; then
		LEG_ENV+=(RS_FIXTURE_ORACLE_LOG="$dir/oracle.jsonl")
	fi
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store" GRC_ROOT_SIZE=enforce-min-size
		)
	fi
	run_rendered "$dir" "$SCENE_FIXTURE_DIR"
}

# scene_capture <dir> <quit frame | default> [extra env words...]: the capture host (headless,
# release template, extension armed, both sinks and the store unless CAPTURE_STORE_DIR=none, strace
# + /proc maps/fd sample for the main captures).
scene_capture() {
	local dir="$1" quit="$2" mode="none"
	shift 2
	if [ "$quit" = "default" ]; then
		quit=""
	else
		mode="capture"
	fi
	CAPTURE_FIXTURE_DIR="$SCENE_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "$quit" "$mode"
}

# The seqs a receiver of <capture dir> shoots besides the settle seqs: the transactions published
# at MID_FRAMES (Q6c's intermediate frames).
mid_seqs() {
	local capture_dir="$1" frame seq out="" sep=""
	for frame in "${MID_FRAMES[@]}"; do
		seq="$(seq_at_frame "$capture_dir/$RECORDING_NAME" "$frame" 2>/dev/null)" || continue
		out+="$sep$seq"
		sep=","
	done
	echo "$out"
}

# A rendered receiver on <capture dir> shooting the settle seqs and the intermediate seqs; the
# RECEIVER_* knobs of lib/legs.sh may be set before the call.
scene_receiver() {
	local capture_dir="$1" dir="$2"
	if [ -f "$capture_dir/$RECORDING_NAME" ]; then
		RECEIVER_EXTRA_SHOTS="$(mid_seqs "$capture_dir")"
	fi
	run_rendered_receiver "$capture_dir" "$dir"
}

run_g6a() {
	local D="$OUT/scene" A="$OUT/animate" R="$OUT/refused" kind
	mkdir -p "$D/import"
	echo "run-gate6: g6a: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $SCENE_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi
	# The release template cannot run a loose project until the editor generated .godot/ (memory
	# receiver-needs-import-before-script).
	LEG_ENV=()
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate6: g6a: capture-scene"
	scene_capture "$D/capture" "$CAPTURE_QUIT_FRAME"
	echo "run-gate6: g6a: capture-scene-inline (every payload inline, no store)"
	CAPTURE_STORE_DIR=none
	scene_capture "$D/capture-inline" "$CAPTURE_QUIT_FRAME" GRC_RESOURCE_INLINE_MAX_BYTES=16777216 \
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216
	echo "run-gate6: g6a: capture-animate"
	scene_capture "$A/capture" "$CAPTURE_QUIT_FRAME" RS_FIXTURE_VARIANT=animate
	echo "run-gate6: g6a: capture-refused"
	scene_capture "$R/capture" "$CAPTURE_QUIT_FRAME" RS_FIXTURE_VARIANT=refused

	# Host sabotages on the default scene; predictions are fixtures/gate6-scene/expected.json
	# "predictions" (make_expected.py, never hand-edited). Frames: step 1 at 11, step 2 at 21.
	echo "run-gate6: g6a: sabotage-freeze (capture, freeze-frame @11)"
	scene_capture "$D/sabotage-freeze/capture" default GRC_SABOTAGE=freeze-frame GRC_SABOTAGE_FRAME=11
	echo "run-gate6: g6a: sabotage-omit-transform (capture, omit-op canvas_item_set_transform @21)"
	scene_capture "$D/sabotage-omit-transform/capture" default GRC_SABOTAGE=omit-op \
		GRC_SABOTAGE_OP=canvas_item_set_transform GRC_SABOTAGE_FRAME=21
	echo "run-gate6: g6a: sabotage-perturb-vertex (capture, perturb-vertex @21)"
	scene_capture "$D/sabotage-perturb-vertex/capture" default GRC_SABOTAGE=perturb-vertex GRC_SABOTAGE_FRAME=21
	echo "run-gate6: g6a: sabotage-perturb-shader (capture, perturb-shader @21)"
	scene_capture "$D/sabotage-perturb-shader/capture" default GRC_SABOTAGE=perturb-shader GRC_SABOTAGE_FRAME=21

	echo "run-gate6: bringing up private gamescope for g6a rendered legs"
	gs_start 640 360 "$OUT/gamescope-g6a"

	echo "run-gate6: g6a: reference-scene (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$D/reference"
	echo "run-gate6: g6a: reference-scene-repeat (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$D/reference-repeat"
	echo "run-gate6: g6a: reference-scene-armed (extension armed, stream on, oracle off)"
	REFERENCE_ARMED=1
	run_reference "$D/reference-armed"
	echo "run-gate6: g6a: reference-animate (oracle on)"
	REFERENCE_VARIANT=animate
	REFERENCE_ORACLE=1
	run_reference "$A/reference"
	echo "run-gate6: g6a: reference-refused (oracle on)"
	REFERENCE_VARIANT=refused
	REFERENCE_ORACLE=1
	run_reference "$R/reference"

	echo "run-gate6: g6a: receiver-scene (full sink)"
	scene_receiver "$D/capture" "$D/receiver"
	echo "run-gate6: g6a: receiver-scene-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	scene_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate6: g6a: receiver-scene-inline (capture-inline, no store)"
	scene_receiver "$D/capture-inline" "$D/receiver-inline"
	echo "run-gate6: g6a: receiver-animate"
	scene_receiver "$A/capture" "$A/receiver"
	echo "run-gate6: g6a: receiver-refused"
	scene_receiver "$R/capture" "$R/receiver"
	for kind in freeze omit-transform perturb-vertex perturb-shader; do
		echo "run-gate6: g6a: sabotage-$kind (receiver)"
		scene_receiver "$D/sabotage-$kind/capture" "$D/sabotage-$kind/receiver"
	done
	for kind in ignore-clip stale-texture; do
		echo "run-gate6: g6a: sabotage-receiver-$kind (RS_RECEIVER_SABOTAGE=$kind on scene/capture)"
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE="$kind")
		scene_receiver "$D/capture" "$D/sabotage-receiver-$kind"
	done

	gs_teardown "$OUT/gamescope-g6a"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g6a) run_g6a ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate6: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate6.ts" --out "$OUT"
