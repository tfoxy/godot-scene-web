#!/usr/bin/env bash
# Gate 1 runner: drives fixtures/gate1/ and receiver/ through the legs of
# protocol/gate1-design.md "Q7. Runner, legs, classification and report", then runs check-gate1.ts.
#
#   bash run-gate1.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g1a,g1b,g1c]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate1/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g1a (G1a), g1b
# (G1b2; it compares against g1a's capture, reference and receiver, so it needs g1a) and g1c (G1c2,
# live delivery over the capture library's WebSocket server; it compares against g1a's reference,
# so it needs g1a too).
#
# NEVER Xvfb and never a desktop window: rendered legs (reference and every receiver) share ONE
# private `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip
# DISPLAY and WAYLAND_DISPLAY. Live legs (g1c) serve on loopback only, on an ephemeral port the
# host names in evidence/live.json. Every launch strips every inherited GRC_* and RS_* variable and
# passes only what its leg wants (env.txt records it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate1"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
GOLDEN_DIR="$EXPERIMENT_DIR/protocol/golden-1"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order. G1b-G1d add theirs here.
LANDED_GROUPS=(g1a g1b g1c)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The fixture's default timeline (fixtures/gate1/expected.json start_frame_default,
# step_frames_default): step k >= 1 is applied at S + N*k. The capture leg runs 400 frames so its
# /proc maps/fd sample has time to run; every other host runs the fixture's default quit frame.
START_FRAME=1
STEP_FRAMES=10
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180

# sabotage-omit-<name> legs: omit-update at the applied frame of this step.
SABOTAGE_STEPS=(modulate:1 transform:2 order:3 visibility:7)
# g1b omit-op legs, <name>:<RenderingServer method>:<step>: the mirror drops that op from the
# step's applied frame on.
OMIT_OP_LEGS=(free:free:8 visible:canvas_item_set_visible:6)
# sabotage-patch-drop: the patch sink drops its highest-id item entry at step 5's frame.
PATCH_DROP_STEP=5
# The fixture's one-frame top-level draw-index tie: step 1 adds T, which holds index 0 (as P
# does) until the deferred _top_level_raise_self runs the next frame (expected.json
# draw_index_ties).
TIE_FRAME=$((START_FRAME + STEP_FRAMES * 1))

# Every gate 1 capture writes both sinks: recording.rs1 (full) and recording-patch.rs1 (patch).
CAPTURE_WITH_PATCH=1

# g1c (G1c2) live legs: the host paces at 60 frames per second and delays the timeline so the
# receiver joins before step 0 settles (gate1-design.md D10, Q7): S = 300, N = 60. The quit frame
# is S + 11 N (>= the fixture's default S + 10 N + 11), so the last step's window is as long as the
# others; the receiver's windows are [S + N k + 7, S + N (k + 1) - 1], the last ending at the quit
# frame. drop-message drops the first transaction formed at or after S + 4 N + 20.
LIVE_START_FRAME=300
LIVE_STEP_FRAMES=60
LIVE_QUIT_FRAME=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * 11))
DROP_MESSAGE_FRAME=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * 4 + 20))
LIVE_HOST_PID=""
LIVE_PORT=""

usage() {
	sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
		# `pnpm render-stream:gate1 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate1: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate1: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate1: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate1: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
for dir in "$FIXTURE_DIR" "$RECEIVER_DIR"; do
	if [ ! -f "$dir/project.godot" ]; then
		echo "run-gate1: $dir/project.godot is missing" >&2
		exit 1
	fi
done

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${LANDED_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case "$group" in
		g1a | g1b | g1c) ;;
		g1d)
			echo "run-gate1: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		*)
			echo "run-gate1: unknown leg group: $group (known: g1a g1b g1c g1d)" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
	case " ${GROUPS_RUN[*]} " in
	*" g1b "* | *" g1c "*)
		case " ${GROUPS_RUN[*]} " in
		*" g1a "*) ;;
		*)
			echo "run-gate1: leg groups g1b and g1c compare against g1a's capture, reference and receiver; pass --legs g1a,..." >&2
			exit 2
			;;
		esac
		;;
	esac
fi

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate1: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate1/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate1: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate1: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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
[ "$HAVE_STRACE" = "1" ] || echo "run-gate1: strace not installed -- headless-no-gpu and receiver-never-loaded-fixture will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
cleanup() {
	if [ -n "${LIVE_HOST_PID:-}" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; then
		echo "run-gate1: stopping owned live host $LIVE_HOST_PID" >&2
		kill "$LIVE_HOST_PID" 2>/dev/null || true
	fi
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate1: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

LEGS_LOG="run-gate1"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

run_g1a() {
	local name step frame

	# import: the release template cannot load a loose project until the editor generated .godot/.
	echo "run-gate1: import"
	for project in fixture receiver; do
		project_dir="$FIXTURE_DIR"
		[ "$project" = "receiver" ] && project_dir="$RECEIVER_DIR"
		LEG_ENV=()
		run_headless "$OUT/import/$project" none -- mise exec -- godot --headless --path "$project_dir" --import
		if [ "$(cat "$OUT/import/$project/exit-code.txt")" != "0" ]; then
			echo "run-gate1: import of $project_dir failed, see $OUT/import/$project/stdout.log" >&2
			exit 1
		fi
	done

	# receiver-typecheck (support, for receiver-typed-clean): the mise editor (debug, so GDScript
	# warnings are live) runs the render-stream/1 codec self-test, then one headless replay of
	# golden-1/full.rs1.
	echo "run-gate1: receiver-typecheck"
	LEG_ENV=(RS_SELFTEST_GOLDEN_DIR="$GOLDEN_DIR")
	run_headless "$OUT/receiver-typecheck/selftest" none -- \
		mise exec -- godot --headless --path "$RECEIVER_DIR" --script res://tests/codec1_selftest.gd
	local minimal_dir="$OUT/receiver-typecheck/minimal"
	prepare_recording "$GOLDEN_DIR/full.rs1" "$minimal_dir"
	LEG_ENV=(RS_RECEIVER_RECORDING="$minimal_dir/$RECORDING_NAME" RS_RECEIVER_OUT="$minimal_dir/applied.json")
	run_headless "$minimal_dir" none -- mise exec -- godot --headless --path "$RECEIVER_DIR"

	# Capture hosts (headless, release template, extension armed).
	echo "run-gate1: capture"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_ROOT_LOG="$OUT/capture/root.jsonl")
	run_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

	for entry in "${SABOTAGE_STEPS[@]}"; do
		name="${entry%%:*}"
		step="${entry##*:}"
		frame=$((START_FRAME + STEP_FRAMES * step))
		echo "run-gate1: sabotage-omit-$name (capture, omit-update at frame $frame)"
		CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE=omit-update GRC_SABOTAGE_FRAME="$frame")
		run_capture "$OUT/sabotage-omit-$name/capture" "" none
	done

	echo "run-gate1: root-size-observe (capture, GRC_ROOT_SIZE unset)"
	CAPTURE_EXTRA_ENV=(RS_FIXTURE_ROOT_LOG="$OUT/root-size-observe/capture/root.jsonl")
	run_capture "$OUT/root-size-observe/capture" "" none

	echo "run-gate1: receiver-headless-trace"
	if prepare_recording "$OUT/capture/$RECORDING_NAME" "$OUT/receiver-headless-trace"; then
		run_receiver_headless "$OUT/receiver-headless-trace" openat
	fi

	# Rendered legs: one private gamescope for all of them.
	echo "run-gate1: bringing up private gamescope for rendered legs"
	gs_start 640 360 "$OUT/gamescope"

	echo "run-gate1: reference"
	mkdir -p "$OUT/reference/shots"
	LEG_ENV=(
		RS_FIXTURE_SHOT_DIR="$OUT/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/reference/steps.jsonl"
		RS_FIXTURE_ROOT_LOG="$OUT/reference/root.jsonl" RS_FIXTURE_SHOT_FRAMES="$TIE_FRAME"
	)
	run_rendered "$OUT/reference" "$FIXTURE_DIR"

	echo "run-gate1: receiver"
	RECEIVER_EXTRA_SHOTS="$(seq_at_frame "$OUT/capture/$RECORDING_NAME" "$TIE_FRAME" || true)"
	RECEIVER_STATE=1
	run_rendered_receiver "$OUT/capture" "$OUT/receiver"

	for entry in "${SABOTAGE_STEPS[@]}"; do
		name="${entry%%:*}"
		echo "run-gate1: sabotage-omit-$name (receiver)"
		run_rendered_receiver "$OUT/sabotage-omit-$name/capture" "$OUT/sabotage-omit-$name/receiver"
	done

	echo "run-gate1: root-size-observe (receiver)"
	run_rendered_receiver "$OUT/root-size-observe/capture" "$OUT/root-size-observe/receiver"

	gs_teardown "$OUT/gamescope"
	GS_RUN_DIR=""
}

# g1b (G1b2): the patch sink against the full sink, the omit-op and patch-drop sabotages, and the
# fixture's draw-index tie made to overlap. Runs after g1a, whose capture (both sinks), reference
# (with the tie frame shot) and receiver it compares against.
run_g1b() {
	local name op step frame tie_seq next_seq

	for entry in "${OMIT_OP_LEGS[@]}"; do
		name="${entry%%:*}"
		op="${entry#*:}"
		op="${op%%:*}"
		step="${entry##*:}"
		frame=$((START_FRAME + STEP_FRAMES * step))
		echo "run-gate1: sabotage-omit-$name (capture, omit-op $op from frame $frame)"
		CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP="$op" GRC_SABOTAGE_FRAME="$frame")
		run_capture "$OUT/sabotage-omit-$name/capture" "" none
	done

	frame=$((START_FRAME + STEP_FRAMES * PATCH_DROP_STEP))
	echo "run-gate1: sabotage-patch-drop (capture, patch-drop-item at frame $frame)"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE=patch-drop-item GRC_SABOTAGE_FRAME="$frame")
	run_capture "$OUT/sabotage-patch-drop/capture" "" none

	echo "run-gate1: tie-overlap (capture, RS_FIXTURE_TIE=overlap)"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_TIE=overlap)
	run_capture "$OUT/tie-overlap/capture" "" none

	echo "run-gate1: bringing up private gamescope for g1b rendered legs"
	gs_start 640 360 "$OUT/gamescope-g1b"

	echo "run-gate1: receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_EXTRA_SHOTS="$(seq_at_frame "$OUT/capture/$RECORDING_NAME" "$TIE_FRAME" || true)"
	RECEIVER_STATE=1
	run_rendered_receiver "$OUT/capture" "$OUT/receiver-patch"

	for entry in "${OMIT_OP_LEGS[@]}"; do
		name="${entry%%:*}"
		echo "run-gate1: sabotage-omit-$name (receiver)"
		run_rendered_receiver "$OUT/sabotage-omit-$name/capture" "$OUT/sabotage-omit-$name/receiver"
	done

	echo "run-gate1: sabotage-patch-drop (receiver on the patch recording)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/sabotage-patch-drop/capture" "$OUT/sabotage-patch-drop/receiver"

	# The tie frame and the frame after it (the raise) are shot on both sides: measured, not gated.
	echo "run-gate1: tie-overlap (reference and receiver, frames $TIE_FRAME and $((TIE_FRAME + 1)) shot)"
	mkdir -p "$OUT/tie-overlap/reference/shots"
	LEG_ENV=(
		RS_FIXTURE_TIE=overlap RS_FIXTURE_SHOT_DIR="$OUT/tie-overlap/reference/shots"
		RS_FIXTURE_STEP_LOG="$OUT/tie-overlap/reference/steps.jsonl"
		RS_FIXTURE_SHOT_FRAMES="$TIE_FRAME,$((TIE_FRAME + 1))"
	)
	run_rendered "$OUT/tie-overlap/reference" "$FIXTURE_DIR"
	tie_seq="$(seq_at_frame "$OUT/tie-overlap/capture/$RECORDING_NAME" "$TIE_FRAME" || true)"
	next_seq="$(seq_at_frame "$OUT/tie-overlap/capture/$RECORDING_NAME" "$((TIE_FRAME + 1))" || true)"
	RECEIVER_EXTRA_SHOTS="$tie_seq,$next_seq"
	run_rendered_receiver "$OUT/tie-overlap/capture" "$OUT/tie-overlap/receiver"

	gs_teardown "$OUT/gamescope-g1b"
	GS_RUN_DIR=""
}

# The receiver's shot windows for the live timeline: <step>:<from>-<to>, steps 0..10.
live_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 10); do
		from=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * k + 7))
		to=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * (k + 1) - 1))
		[ "$k" -eq 10 ] && to=$LIVE_QUIT_FRAME
		out+="$sep$k:$from-$to"
		sep=","
	done
	echo "$out"
}

# start_live_host <host dir> [extra env words...]: the capture host (release template, headless,
# armed, both file sinks, --max-fps 60, the live timeline) serving on 127.0.0.1:0, started in the
# background. Waits for evidence/live.json and sets LIVE_PORT ("" when the host is not listening).
start_live_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME" GRC_ROOT_SIZE=enforce-min-size
		GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		RS_FIXTURE_START_FRAME="$LIVE_START_FRAME" RS_FIXTURE_STEP_FRAMES="$LIVE_STEP_FRAMES"
		RS_FIXTURE_QUIT_FRAME="$LIVE_QUIT_FRAME" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
		"$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	# Plain text parsing on purpose: a tsx start-up here would eat into the receiver's join budget.
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate1: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

finish_live_host() {
	finish_bg "$1" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
}

# live_receiver <leg dir> <rendered|headless>: a live receiver on the current host's port, with
# --max-fps 60. Rendered receivers shoot the step windows (credit stage submitted); the headless
# one runs under strace -e openat (receiver-never-loaded-fixture) with credit stage applied.
live_receiver() {
	local leg="$1" kind="$2" dir="$1/receiver"
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate1: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json"
	)
	if [ "$kind" = "headless" ]; then
		run_headless "$dir" openat -- "$BINARY" --headless --max-fps 60 --path "$RECEIVER_DIR"
	else
		LEG_ENV+=(RS_RECEIVER_SHOT_WINDOWS="$(live_windows)")
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$dir" "$RECEIVER_DIR"
	fi
}

# g1c (G1c2): live delivery. Each leg starts its capture host, waits for the listener, runs one
# receiver against it, then waits for the host to reach its quit frame.
run_g1c() {
	local seqs

	echo "run-gate1: live-headless (host + headless live receiver, credit stage applied)"
	start_live_host "$OUT/live-headless/host"
	live_receiver "$OUT/live-headless" headless
	finish_live_host "$OUT/live-headless/host"

	echo "run-gate1: bringing up private gamescope for g1c rendered legs"
	gs_start 640 360 "$OUT/gamescope-g1c"

	echo "run-gate1: live (host + rendered live receiver, shot windows $(live_windows))"
	start_live_host "$OUT/live/host"
	live_receiver "$OUT/live" rendered
	finish_live_host "$OUT/live/host"

	echo "run-gate1: live-replay (rendered file-mode receiver on live/receiver/received.rs1)"
	if prepare_recording "$OUT/live/receiver/received.rs1" "$OUT/live-replay" &&
		seqs="$(gate0_tool live-shot-seqs "$OUT/live/receiver/applied.json")"; then
		mkdir -p "$OUT/live-replay/shots"
		LEG_ENV=(
			RS_RECEIVER_RECORDING="$OUT/live-replay/$RECORDING_NAME"
			RS_RECEIVER_OUT="$OUT/live-replay/applied.json" RS_RECEIVER_SHOT_SEQS="$seqs"
			RS_RECEIVER_STATE_SEQS="$seqs"
		)
		run_rendered "$OUT/live-replay" "$RECEIVER_DIR"
	fi

	echo "run-gate1: sabotage-drop-message (host drops the first transaction formed at frame >= $DROP_MESSAGE_FRAME)"
	start_live_host "$OUT/sabotage-drop-message/host" GRC_SABOTAGE=drop-message GRC_SABOTAGE_FRAME="$DROP_MESSAGE_FRAME"
	live_receiver "$OUT/sabotage-drop-message" rendered
	finish_live_host "$OUT/sabotage-drop-message/host"

	gs_teardown "$OUT/gamescope-g1c"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g1a) run_g1a ;;
	g1b) run_g1b ;;
	g1c) run_g1c ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate1: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate1.ts" --out "$OUT"
