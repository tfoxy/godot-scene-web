#!/usr/bin/env bash
# Shared process plumbing for the render-stream gate runners (run-gate0.sh, run-gate1.sh).
# Sourced, not executed; extracted from run-gate0.sh with no behaviour change
# (protocol/gate1-design.md D9).
#
# The caller sets, before using any function:
#   LEGS_LOG           log prefix, e.g. "run-gate0"
#   OUT                absolute evidence directory
#   BINARY EXTENSION CALIBRATION   absolute template, .gdextension and calibration record
#   FIXTURE_DIR        the fixture project run_capture launches (overridable per call through
#                      CAPTURE_FIXTURE_DIR)
#   RECEIVER_DIR       the receiver project
#   HAVE_STRACE        1 when strace is installed
#   HEADLESS_TIMEOUT_S RENDERED_TIMEOUT_S
#   SCRIPT_DIR REPO_ROOT
# and sources lib/gamescope.sh first (gs_strip_env_args, gs_launch_godot, ...).
#
# Every launch strips GS_STRIP_VARS and every inherited GRC_* / RS_* (gs_strip_env_args) and
# passes only the NAME=value words in LEG_ENV (env.txt records them).

# The recording file names: the full sink every capture writes (GRC_STREAM_OUT) and every receiver
# copy uses, and the patch sink (GRC_STREAM_PATCH_OUT) a capture also writes when
# CAPTURE_WITH_PATCH=1 (gate 1). Both are render-stream/2 since G2b2 (protocol/gate2-design.md).
RECORDING_NAME="${RECORDING_NAME:-recording.rs2}"
PATCH_RECORDING_NAME="${PATCH_RECORDING_NAME:-recording-patch.rs2}"
CAPTURE_WITH_PATCH="${CAPTURE_WITH_PATCH:-0}"

# The process the runner currently owns (its cleanup trap stops it).
CURRENT_CHILD_PID=""

LEG_ENV=()

gate0_tool() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate0-tool.ts" "$@")
}

write_invocation() {
	local dir="$1"
	shift
	printf '%s\n' "$@" >"$dir/argv.txt"
	{
		echo "# unset: DISPLAY WAYLAND_DISPLAY (headless) / WAYLAND_DISPLAY (rendered), ${GS_STRIP_VARS[*]} and every inherited GRC_* and RS_*"
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
			echo "$LEGS_LOG: pid $pid exceeded ${timeout_s}s, killing it" >&2
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
	echo "$LEGS_LOG: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

# start_headless_bg <dir> -- <command...>: as run_headless with no strace, but returns at once with
# the child's pid in BG_PID (gate 1 live hosts run while their receiver does). finish_bg waits.
BG_PID=""
start_headless_bg() {
	local dir="$1"
	shift 2
	mkdir -p "$dir"
	gs_strip_env_args
	local -a cmd=(env -u DISPLAY -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}")
	if [ "${#LEG_ENV[@]}" -gt 0 ]; then
		cmd+=("${LEG_ENV[@]}")
	fi
	write_invocation "$dir" "$@"
	"${cmd[@]}" "$@" >"$dir/stdout.log" 2>&1 &
	BG_PID=$!
}

# finish_bg <dir> <pid> <timeout s>: waits for a start_headless_bg child, writes exit-code.txt.
finish_bg() {
	local dir="$1" pid="$2" timeout_s="$3"
	wait_owned "$pid" "$timeout_s"
	echo "$WAIT_EXIT" >"$dir/exit-code.txt"
	echo "$LEGS_LOG: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

# run_capture <dir> <quit frame|""> <strace mode> [scene] -- capture host on the release template,
# armed, writing <dir>/$RECORDING_NAME and steps.jsonl from CAPTURE_FIXTURE_DIR (default
# FIXTURE_DIR). CAPTURE_EXTRA_ENV adds sabotage/variant/policy words. CAPTURE_STORE_DIR picks the
# out-of-band resource store (GRC_RESOURCE_STORE_DIR, which a file sink needs unless delivery is
# inline): unset or empty -> <dir>/store; the literal `none` -> no GRC_RESOURCE_STORE_DIR at all;
# anything else -> that directory. All three are reset after the call.
CAPTURE_EXTRA_ENV=()
CAPTURE_FIXTURE_DIR=""
CAPTURE_STORE_DIR=""
run_capture() {
	local dir="$1" quit="$2" mode="$3" scene="${4:-}"
	local fixture="${CAPTURE_FIXTURE_DIR:-$FIXTURE_DIR}"
	local store="${CAPTURE_STORE_DIR:-$dir/store}"
	CAPTURE_STORE_DIR=""
	mkdir -p "$dir/evidence"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
	)
	if [ "$store" != "none" ]; then
		LEG_ENV+=(GRC_RESOURCE_STORE_DIR="$store")
	fi
	if [ "$CAPTURE_WITH_PATCH" = "1" ]; then
		LEG_ENV+=(GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME")
	fi
	# An empty quit frame leaves the fixture at its own default.
	if [ -n "$quit" ]; then
		LEG_ENV+=(RS_FIXTURE_QUIT_FRAME="$quit")
	fi
	if [ "${#CAPTURE_EXTRA_ENV[@]}" -gt 0 ]; then
		LEG_ENV+=("${CAPTURE_EXTRA_ENV[@]}")
	fi
	local -a argv=("$BINARY" --headless --path "$fixture")
	[ -n "$scene" ] && argv+=("$scene")
	run_headless "$dir" "$mode" -- "${argv[@]}"
	CAPTURE_EXTRA_ENV=()
	CAPTURE_FIXTURE_DIR=""
}

# prepare_recording <src> <dir>: the receiver's own copy at <dir>/$RECORDING_NAME. Returns 1 (and
# records why) when there is no source recording to copy.
prepare_recording() {
	local src="$1" dir="$2"
	mkdir -p "$dir"
	if [ ! -f "$src" ]; then
		echo "no source recording at $src" >"$dir/skipped.txt"
		echo "$LEGS_LOG: $dir skipped: no source recording" >&2
		return 1
	fi
	[ "$src" = "$dir/$RECORDING_NAME" ] || cp "$src" "$dir/$RECORDING_NAME"
}

# run_receiver_headless <dir> <strace mode>: the template, --headless, on <dir>/$RECORDING_NAME,
# with a fresh content-addressed cache at <dir>/cache (RS_RECEIVER_CACHE_DIR). RECEIVER_STORE_DIR
# (optional, reset after the call), when non-empty, is the capture's store the receiver fetches
# out-of-band payloads from (RS_RECEIVER_STORE_DIR).
RECEIVER_STORE_DIR=""
run_receiver_headless() {
	local dir="$1" mode="$2" store="$RECEIVER_STORE_DIR"
	RECEIVER_STORE_DIR=""
	LEG_ENV=(
		RS_RECEIVER_RECORDING="$dir/$RECORDING_NAME" RS_RECEIVER_OUT="$dir/applied.json"
		RS_RECEIVER_CACHE_DIR="$dir/cache"
	)
	if [ -n "$store" ]; then
		LEG_ENV+=(RS_RECEIVER_STORE_DIR="$store")
	fi
	run_headless "$dir" "$mode" -- "$BINARY" --headless --path "$RECEIVER_DIR"
}

# settle_seqs <capture dir> <receiver dir>: prints the CSV, or records step-join-failed.
settle_seqs() {
	local capture_dir="$1" receiver_dir="$2"
	mkdir -p "$receiver_dir"
	if ! gate0_tool settle-seqs "$capture_dir/steps.jsonl" "$capture_dir/$RECORDING_NAME" \
		>"$receiver_dir/shot-seqs.txt" 2>"$receiver_dir/step-join.log"; then
		echo "$LEGS_LOG: $receiver_dir: step-join-failed (see step-join.log)" >&2
		return 1
	fi
	cat "$receiver_dir/shot-seqs.txt"
}

# run_rendered <dir> <project dir>: the template inside the private gamescope with LEG_ENV.
# RENDERED_EXTRA_ARGS (reset after the call) are appended to the command line, e.g. --max-fps 60
# for a live receiver (gate1-design.md Q5: live legs pass --max-fps 60 to the receiver).
RENDERED_EXTRA_ARGS=()
run_rendered() {
	local dir="$1" project="$2"
	local -a extra=()
	if [ "${#RENDERED_EXTRA_ARGS[@]}" -gt 0 ]; then
		extra=("${RENDERED_EXTRA_ARGS[@]}")
	fi
	RENDERED_EXTRA_ARGS=()
	mkdir -p "$dir"
	gs_require_live
	write_invocation "$dir" "$BINARY" --path "$project" --rendering-driver opengl3 --display-driver x11 "${extra[@]}"
	echo "DISPLAY=$GS_DISPLAY" >>"$dir/env.txt"
	GS_GODOT_ENV=()
	if [ "${#LEG_ENV[@]}" -gt 0 ]; then
		GS_GODOT_ENV=("${LEG_ENV[@]}")
	fi
	gs_launch_godot "$GS_DISPLAY" "$BINARY" "$project" "$dir/stdout.log" "${extra[@]}"
	local pid="$GS_LAST_GODOT_PID"
	CURRENT_CHILD_PID="$pid"
	sleep 0.3
	if [ -d "/proc/$pid" ]; then
		gs_verify_display_ownership "$GS_DISPLAY" "$GS_PID" "$GS_SID" "$pid" "$dir/display-ownership.json" ||
			echo "$LEGS_LOG: WARNING: $dir display ownership check failed, see display-ownership.json" >&2
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
	echo "$LEGS_LOG: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

# seq_at_frame <recording> <frame>: prints the seq of the transaction published at <frame>.
seq_at_frame() {
	gate0_tool seq-at-frame "$1" "$2"
}

# run_rendered_receiver <capture dir> <receiver dir>: a rendered receiver on a copy of the
# capture's recording, shooting the settle seqs of its steps.jsonl. Optional, reset after the call:
#   RECEIVER_SOURCE      the capture recording to replay (default $RECORDING_NAME); the copy is
#                        always <receiver dir>/$RECORDING_NAME
#   RECEIVER_EXTRA_SHOTS CSV of extra seqs to shoot
#   RECEIVER_STATE=1     also dump the resolved state at the settle seqs (RS_RECEIVER_STATE_SEQS)
#   RECEIVER_EXTRA_ENV   an array of extra NAME=value words appended to LEG_ENV
# The receiver always gets a fresh cache at <receiver dir>/cache (RS_RECEIVER_CACHE_DIR) and, when
# <capture dir>/store exists, that store as its out-of-band origin (RS_RECEIVER_STORE_DIR).
RECEIVER_SOURCE=""
RECEIVER_EXTRA_SHOTS=""
RECEIVER_STATE=0
RECEIVER_EXTRA_ENV=()
run_rendered_receiver() {
	local capture_dir="$1" dir="$2" seqs shots source="${RECEIVER_SOURCE:-$RECORDING_NAME}"
	local extra="$RECEIVER_EXTRA_SHOTS" state="$RECEIVER_STATE"
	local -a extra_env=()
	if [ "${#RECEIVER_EXTRA_ENV[@]}" -gt 0 ]; then
		extra_env=("${RECEIVER_EXTRA_ENV[@]}")
	fi
	RECEIVER_SOURCE=""
	RECEIVER_EXTRA_SHOTS=""
	RECEIVER_STATE=0
	RECEIVER_EXTRA_ENV=()
	prepare_recording "$capture_dir/$source" "$dir" || return 0
	seqs="$(settle_seqs "$capture_dir" "$dir")" || return 0
	shots="$seqs"
	[ -n "$extra" ] && shots="$seqs,$extra"
	mkdir -p "$dir/shots"
	LEG_ENV=(
		RS_RECEIVER_RECORDING="$dir/$RECORDING_NAME" RS_RECEIVER_OUT="$dir/applied.json"
		RS_RECEIVER_SHOT_SEQS="$shots" RS_RECEIVER_CACHE_DIR="$dir/cache"
	)
	if [ -d "$capture_dir/store" ]; then
		LEG_ENV+=(RS_RECEIVER_STORE_DIR="$capture_dir/store")
	fi
	if [ "$state" = "1" ]; then
		LEG_ENV+=(RS_RECEIVER_STATE_SEQS="$seqs")
	fi
	if [ "${#extra_env[@]}" -gt 0 ]; then
		LEG_ENV+=("${extra_env[@]}")
	fi
	run_rendered "$dir" "$RECEIVER_DIR"
}
