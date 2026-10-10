#!/usr/bin/env bash
# Gate 0 runner: drives fixtures/gate0/ and receiver/ through every leg of
# protocol/gate0-design.md "Q6. Runner, legs and checker", then runs check-gate0.ts.
#
#   bash run-gate0.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate0/<UTC>/ and must not already hold files.
#
# NEVER Xvfb and never a desktop window: rendered legs (reference, receiver, the three sabotage
# receivers) share ONE private `gamescope --backend headless` (scripts/lib/gamescope.sh). Headless
# legs strip DISPLAY and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_*
# variable and passes only what its leg wants (env.txt records it).
#
# Since G1b2 (protocol/gate1-design.md) every capture runs under GRC_ROOT_SIZE=enforce-min-size;
# without the policy the 64x64 headless host would declare degenerate-host-size and classify
# unsupported. Since G2b2 (protocol/gate2-design.md) every capture publishes render-stream/2 (since
# G4e2 render-stream/3, gate4-design.md; since G5d render-stream/4, gate5-design.md)
# (recording.rs2) with its out-of-band resource store at <capture>/store (GRC_RESOURCE_STORE_DIR),
# and every file-mode receiver gets a fresh cache (<receiver>/cache) and that store.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate0"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
GOLDEN_DIR="$EXPERIMENT_DIR/protocol/golden-2"
# G5d: the receiver speaks render-stream/4, so the typecheck replay is golden-4's inline vector
# (golden-3's from G4e2; codec2_selftest.gd checks golden-2, -3 and -4 at their own versions).
GOLDEN4_DIR="$EXPERIMENT_DIR/protocol/golden-4"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""

# Frames: the capture leg runs 400 so its /proc maps/fd sample has time to run; every other host
# runs the fixture's default 52. Sabotage starts at frame 21 (step 2's applied frame).
CAPTURE_QUIT_FRAME=400
SHORT_QUIT_FRAME=52
SABOTAGE_FRAME=21
CORRUPT_SEQ=3
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180

usage() {
	sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate0 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate0: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate0: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate0: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate0: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
for dir in "$FIXTURE_DIR" "$RECEIVER_DIR"; do
	if [ ! -f "$dir/project.godot" ]; then
		echo "run-gate0: $dir/project.godot is missing" >&2
		exit 1
	fi
done

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate0: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate0/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate0: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate0: evidence directory: $OUT"
printf '{"path": "%s", "sha256": "%s"}\n' "$BINARY" "$ACTUAL_BINARY_SHA256" >"$OUT/binary.json"

HAVE_STRACE=0
command -v strace >/dev/null 2>&1 && HAVE_STRACE=1
[ "$HAVE_STRACE" = "1" ] || echo "run-gate0: strace not installed -- headless-no-gpu and receiver-never-loaded-fixture will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
CURRENT_CHILD_PID=""
cleanup() {
	if [ -n "$CURRENT_CHILD_PID" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate0: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# Process plumbing (write_invocation, wait_owned, run_headless, run_capture, prepare_recording,
# run_receiver_headless, settle_seqs, run_rendered, run_rendered_receiver): lib/legs.sh.
LEGS_LOG="run-gate0"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# ---------------------------------------------------------------------------------------------
# import: the release template cannot load a loose project until the editor generated .godot/.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: import"
for project in fixture receiver; do
	project_dir="$FIXTURE_DIR"
	[ "$project" = "receiver" ] && project_dir="$RECEIVER_DIR"
	LEG_ENV=()
	run_headless "$OUT/import/$project" none -- mise exec -- godot --headless --path "$project_dir" --import
	if [ "$(cat "$OUT/import/$project/exit-code.txt")" != "0" ]; then
		echo "run-gate0: import of $project_dir failed, see $OUT/import/$project/stdout.log" >&2
		exit 1
	fi
done

# ---------------------------------------------------------------------------------------------
# receiver-typecheck: the mise editor (a debug build, so GDScript warnings are live) runs the
# render-stream/2, /3 and /4 codec self-test, then one headless replay of golden-4/inline.rs4 (inline
# resource records, so it needs no store; it still gets a fresh cache).
# ---------------------------------------------------------------------------------------------
echo "run-gate0: receiver-typecheck"
LEG_ENV=(RS_SELFTEST_GOLDEN_DIR="$GOLDEN_DIR")
run_headless "$OUT/receiver-typecheck/selftest" none -- \
	mise exec -- godot --headless --path "$RECEIVER_DIR" --script res://tests/codec2_selftest.gd
MINIMAL_DIR="$OUT/receiver-typecheck/minimal"
prepare_recording "$GOLDEN4_DIR/inline.rs4" "$MINIMAL_DIR"
LEG_ENV=(
	RS_RECEIVER_RECORDING="$MINIMAL_DIR/$RECORDING_NAME" RS_RECEIVER_OUT="$MINIMAL_DIR/applied.json"
	RS_RECEIVER_CACHE_DIR="$MINIMAL_DIR/cache"
)
run_headless "$MINIMAL_DIR" none -- mise exec -- godot --headless --path "$RECEIVER_DIR"

# ---------------------------------------------------------------------------------------------
# Capture hosts (headless, release template, extension armed).
# ---------------------------------------------------------------------------------------------
echo "run-gate0: capture"
CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
run_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

echo "run-gate0: preexisting"
CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
run_capture "$OUT/preexisting" "$SHORT_QUIT_FRAME" none "res://preexisting.tscn"

echo "run-gate0: unsupported"
CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_VARIANT=unsupported)
run_capture "$OUT/unsupported/capture" "$SHORT_QUIT_FRAME" none
if prepare_recording "$OUT/unsupported/capture/$RECORDING_NAME" "$OUT/unsupported/receiver"; then
	RECEIVER_STORE_DIR="$OUT/unsupported/capture/store"
	run_receiver_headless "$OUT/unsupported/receiver" none
fi

for kind in freeze omit perturb; do
	case "$kind" in
	freeze) sabotage=freeze-frame ;;
	omit) sabotage=omit-update ;;
	perturb) sabotage=perturb-transform ;;
	esac
	echo "run-gate0: sabotage-$kind (capture)"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE="$sabotage" GRC_SABOTAGE_FRAME="$SABOTAGE_FRAME")
	run_capture "$OUT/sabotage-$kind/capture" "$SHORT_QUIT_FRAME" none
done

# ---------------------------------------------------------------------------------------------
# Headless receivers on the capture leg's recording.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: corrupt"
mkdir -p "$OUT/corrupt"
if [ -f "$OUT/capture/$RECORDING_NAME" ] &&
	gate0_tool corrupt "$OUT/capture/$RECORDING_NAME" "$OUT/corrupt/$RECORDING_NAME" "$CORRUPT_SEQ" \
		>"$OUT/corrupt/corrupt-tool.log" 2>&1; then
	RECEIVER_STORE_DIR="$OUT/capture/store"
	run_receiver_headless "$OUT/corrupt" none
else
	echo "could not build the corrupted copy (see corrupt-tool.log)" >"$OUT/corrupt/skipped.txt"
	echo "run-gate0: corrupt skipped: no corrupted copy" >&2
fi

echo "run-gate0: receiver-headless-trace"
if prepare_recording "$OUT/capture/$RECORDING_NAME" "$OUT/receiver-headless-trace"; then
	RECEIVER_STORE_DIR="$OUT/capture/store"
	run_receiver_headless "$OUT/receiver-headless-trace" openat
fi

# ---------------------------------------------------------------------------------------------
# Rendered legs: one private gamescope for all of them.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: bringing up private gamescope for rendered legs"
gs_start 640 360 "$OUT/gamescope"

echo "run-gate0: reference"
mkdir -p "$OUT/reference/shots"
LEG_ENV=(RS_FIXTURE_SHOT_DIR="$OUT/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/reference/steps.jsonl")
run_rendered "$OUT/reference" "$FIXTURE_DIR"

echo "run-gate0: receiver"
run_rendered_receiver "$OUT/capture" "$OUT/receiver"

for kind in freeze omit perturb; do
	echo "run-gate0: sabotage-$kind (receiver)"
	run_rendered_receiver "$OUT/sabotage-$kind/capture" "$OUT/sabotage-$kind/receiver"
done

gs_teardown "$OUT/gamescope"
GS_RUN_DIR=""

# ---------------------------------------------------------------------------------------------
# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate0.ts" --out "$OUT"
