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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate0"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
GOLDEN_DIR="$EXPERIMENT_DIR/protocol/golden"

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

gate0_tool() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate0-tool.ts" "$@")
}

# ---------------------------------------------------------------------------------------------
# Process plumbing. LEG_ENV holds the NAME=value words a launch passes; everything in
# GS_STRIP_VARS and every inherited RS_* is unset first.
# ---------------------------------------------------------------------------------------------
LEG_ENV=()

write_invocation() {
	local dir="$1"
	shift
	printf '%s\n' "$@" >"$dir/argv.txt"
	{
		echo "# unset: DISPLAY WAYLAND_DISPLAY (headless) / WAYLAND_DISPLAY (rendered), ${GS_STRIP_VARS[*]} and every inherited RS_*"
		if [ "${#LEG_ENV[@]}" -gt 0 ]; then
			printf '%s\n' "${LEG_ENV[@]}"
		fi
	} >"$dir/env.txt"
}

# Waits for an owned child, killing it after $2 seconds. Sets WAIT_EXIT (124 on timeout).
WAIT_EXIT=0
wait_owned() {
	local pid="$1" timeout_s="$2" ticks=0
	while kill -0 "$pid" 2>/dev/null; do
		if [ "$ticks" -ge $((timeout_s * 10)) ]; then
			echo "run-gate0: pid $pid exceeded ${timeout_s}s, killing it" >&2
			kill "$pid" 2>/dev/null || true
			sleep 1
			kill -9 "$pid" 2>/dev/null || true
			break
		fi
		sleep 0.1
		ticks=$((ticks + 1))
	done
	set +e
	wait "$pid" 2>/dev/null
	WAIT_EXIT=$?
	set -e
	[ "$ticks" -ge $((timeout_s * 10)) ] && WAIT_EXIT=124
	return 0
}

# run_headless <dir> <strace: none|capture|openat> -- <command...>
#   capture: strace -f -tt -e trace=mprotect,openat, plus a /proc maps/fd sample of the traced
#            process once <dir>/evidence/armed.marker exists (as gate -1's headless-armed leg).
#   openat:  strace -f -tt -e trace=openat.
run_headless() {
	local dir="$1" mode="$2"
	shift 3
	mkdir -p "$dir"
	gs_strip_env_args
	local -a cmd=(env -u DISPLAY -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}")
	if [ "${#LEG_ENV[@]}" -gt 0 ]; then
		cmd+=("${LEG_ENV[@]}")
	fi
	write_invocation "$dir" "$@"
	local traced=0
	if [ "$mode" != "none" ]; then
		if [ "$HAVE_STRACE" = "1" ]; then
			traced=1
			local trace_set="openat"
			[ "$mode" = "capture" ] && trace_set="mprotect,openat"
			cmd+=(strace -f -tt -e "trace=$trace_set" -o "$dir/strace.txt")
		else
			echo "unavailable" >"$dir/strace-status.txt"
		fi
	fi
	"${cmd[@]}" "$@" >"$dir/stdout.log" 2>&1 &
	local pid=$!
	CURRENT_CHILD_PID="$pid"

	if [ "$mode" = "capture" ]; then
		local waited=0
		while [ "$waited" -lt 300 ] && [ ! -f "$dir/evidence/armed.marker" ] && kill -0 "$pid" 2>/dev/null; do
			sleep 0.05
			waited=$((waited + 1))
		done
		local sample_pid="$pid"
		if [ "$traced" = "1" ]; then
			# strace's own pid is $pid; the traced Godot process is its child.
			sample_pid="$(pgrep -P "$pid" 2>/dev/null | head -1 || true)"
		fi
		if [ -n "$sample_pid" ] && [ -d "/proc/$sample_pid" ]; then
			cp "/proc/$sample_pid/maps" "$dir/maps.txt" 2>/dev/null || true
			ls -la "/proc/$sample_pid/fd" >"$dir/fd.txt" 2>/dev/null || true
		fi
	fi

	wait_owned "$pid" "$HEADLESS_TIMEOUT_S"
	CURRENT_CHILD_PID=""
	echo "$WAIT_EXIT" >"$dir/exit-code.txt"
	echo "run-gate0: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

# run_capture <dir> <quit frame> <strace mode> [scene] -- capture host on the release template,
# armed, writing recording.rs0 and steps.jsonl. CAPTURE_EXTRA_ENV adds sabotage/variant words.
CAPTURE_EXTRA_ENV=()
run_capture() {
	local dir="$1" quit="$2" mode="$3" scene="${4:-}"
	mkdir -p "$dir/evidence"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/recording.rs0"
		RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" RS_FIXTURE_QUIT_FRAME="$quit"
	)
	if [ "${#CAPTURE_EXTRA_ENV[@]}" -gt 0 ]; then
		LEG_ENV+=("${CAPTURE_EXTRA_ENV[@]}")
	fi
	local -a argv=("$BINARY" --headless --path "$FIXTURE_DIR")
	[ -n "$scene" ] && argv+=("$scene")
	run_headless "$dir" "$mode" -- "${argv[@]}"
	CAPTURE_EXTRA_ENV=()
}

# prepare_recording <src> <dir>: the receiver's own copy at <dir>/recording.rs0. Returns 1 (and
# records why) when there is no source recording to copy.
prepare_recording() {
	local src="$1" dir="$2"
	mkdir -p "$dir"
	if [ ! -f "$src" ]; then
		echo "no source recording at $src" >"$dir/skipped.txt"
		echo "run-gate0: $dir skipped: no source recording" >&2
		return 1
	fi
	[ "$src" = "$dir/recording.rs0" ] || cp "$src" "$dir/recording.rs0"
}

# run_receiver_headless <dir> <strace mode>: the template, --headless, on <dir>/recording.rs0.
run_receiver_headless() {
	local dir="$1" mode="$2"
	LEG_ENV=(RS_RECEIVER_RECORDING="$dir/recording.rs0" RS_RECEIVER_OUT="$dir/applied.json")
	run_headless "$dir" "$mode" -- "$BINARY" --headless --path "$RECEIVER_DIR"
}

# settle_seqs <capture dir> <receiver dir>: prints the CSV, or records step-join-failed.
settle_seqs() {
	local capture_dir="$1" receiver_dir="$2"
	mkdir -p "$receiver_dir"
	if ! gate0_tool settle-seqs "$capture_dir/steps.jsonl" "$capture_dir/recording.rs0" \
		>"$receiver_dir/shot-seqs.txt" 2>"$receiver_dir/step-join.log"; then
		echo "run-gate0: $receiver_dir: step-join-failed (see step-join.log)" >&2
		return 1
	fi
	cat "$receiver_dir/shot-seqs.txt"
}

# run_rendered <dir> <project dir>: the template inside the private gamescope with LEG_ENV.
run_rendered() {
	local dir="$1" project="$2"
	mkdir -p "$dir"
	gs_require_live
	write_invocation "$dir" "$BINARY" --path "$project" --rendering-driver opengl3 --display-driver x11
	echo "DISPLAY=$GS_DISPLAY" >>"$dir/env.txt"
	GS_GODOT_ENV=()
	if [ "${#LEG_ENV[@]}" -gt 0 ]; then
		GS_GODOT_ENV=("${LEG_ENV[@]}")
	fi
	gs_launch_godot "$GS_DISPLAY" "$BINARY" "$project" "$dir/stdout.log"
	local pid="$GS_LAST_GODOT_PID"
	CURRENT_CHILD_PID="$pid"
	sleep 0.3
	if [ -d "/proc/$pid" ]; then
		gs_verify_display_ownership "$GS_DISPLAY" "$GS_PID" "$GS_SID" "$pid" "$dir/display-ownership.json" ||
			echo "run-gate0: WARNING: $dir display ownership check failed, see display-ownership.json" >&2
	fi
	local ticks=0
	while [ -d "/proc/$pid" ] && [ "$ticks" -lt $((RENDERED_TIMEOUT_S * 10)) ]; do
		gs_require_live
		sleep 0.1
		ticks=$((ticks + 1))
	done
	wait_owned "$pid" 5
	CURRENT_CHILD_PID=""
	[ "$ticks" -ge $((RENDERED_TIMEOUT_S * 10)) ] && WAIT_EXIT=124
	echo "$WAIT_EXIT" >"$dir/exit-code.txt"
	echo "run-gate0: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

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
# codec self-test, then one headless replay of the golden minimal.bin.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: receiver-typecheck"
LEG_ENV=(RS_SELFTEST_GOLDEN_DIR="$GOLDEN_DIR")
run_headless "$OUT/receiver-typecheck/selftest" none -- \
	mise exec -- godot --headless --path "$RECEIVER_DIR" --script res://tests/codec_selftest.gd
MINIMAL_DIR="$OUT/receiver-typecheck/minimal"
prepare_recording "$GOLDEN_DIR/minimal.bin" "$MINIMAL_DIR"
LEG_ENV=(RS_RECEIVER_RECORDING="$MINIMAL_DIR/recording.rs0" RS_RECEIVER_OUT="$MINIMAL_DIR/applied.json")
run_headless "$MINIMAL_DIR" none -- mise exec -- godot --headless --path "$RECEIVER_DIR"

# ---------------------------------------------------------------------------------------------
# Capture hosts (headless, release template, extension armed).
# ---------------------------------------------------------------------------------------------
echo "run-gate0: capture"
run_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

echo "run-gate0: preexisting"
run_capture "$OUT/preexisting" "$SHORT_QUIT_FRAME" none "res://preexisting.tscn"

echo "run-gate0: unsupported"
CAPTURE_EXTRA_ENV=(RS_FIXTURE_VARIANT=unsupported)
run_capture "$OUT/unsupported/capture" "$SHORT_QUIT_FRAME" none
if prepare_recording "$OUT/unsupported/capture/recording.rs0" "$OUT/unsupported/receiver"; then
	run_receiver_headless "$OUT/unsupported/receiver" none
fi

for kind in freeze omit perturb; do
	case "$kind" in
	freeze) sabotage=freeze-frame ;;
	omit) sabotage=omit-update ;;
	perturb) sabotage=perturb-transform ;;
	esac
	echo "run-gate0: sabotage-$kind (capture)"
	CAPTURE_EXTRA_ENV=(GRC_SABOTAGE="$sabotage" GRC_SABOTAGE_FRAME="$SABOTAGE_FRAME")
	run_capture "$OUT/sabotage-$kind/capture" "$SHORT_QUIT_FRAME" none
done

# ---------------------------------------------------------------------------------------------
# Headless receivers on the capture leg's recording.
# ---------------------------------------------------------------------------------------------
echo "run-gate0: corrupt"
mkdir -p "$OUT/corrupt"
if [ -f "$OUT/capture/recording.rs0" ] &&
	gate0_tool corrupt "$OUT/capture/recording.rs0" "$OUT/corrupt/recording.rs0" "$CORRUPT_SEQ" \
		>"$OUT/corrupt/corrupt-tool.log" 2>&1; then
	run_receiver_headless "$OUT/corrupt" none
else
	echo "could not build the corrupted copy (see corrupt-tool.log)" >"$OUT/corrupt/skipped.txt"
	echo "run-gate0: corrupt skipped: no corrupted copy" >&2
fi

echo "run-gate0: receiver-headless-trace"
if prepare_recording "$OUT/capture/recording.rs0" "$OUT/receiver-headless-trace"; then
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

# run_rendered_receiver <capture dir> <receiver dir>
run_rendered_receiver() {
	local capture_dir="$1" dir="$2" seqs
	prepare_recording "$capture_dir/recording.rs0" "$dir" || return 0
	seqs="$(settle_seqs "$capture_dir" "$dir")" || return 0
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_RECEIVER_RECORDING="$dir/recording.rs0" RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_SHOT_SEQS="$seqs")
	run_rendered "$dir" "$RECEIVER_DIR"
}

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
