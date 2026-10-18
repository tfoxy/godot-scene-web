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

# --------------------------------------------------------------------------------------------
# Measurement isolation (lib/quiet.sh; results/measurement-isolation.md): the machine-wide quiet
# lock, taken here per leg, never around a whole run.
#   - Every launch below (run_headless, run_rendered, start_headless_bg ... finish_bg) holds the
#     SHARED lock while it runs; a live leg's background host and its receivers share one hold,
#     released once the last of them has finished. Correctness legs never block each other, but
#     pause while a timing leg holds or waits for the lock.
#   - A TIMING leg holds the EXCLUSIVE lock from its host's start to its host's finish_bg:
#     every start_headless_bg while LEGS_TIMING_GROUP is set (the runner sets it around a timing
#     group: g1d, g5f, g55f, g6l, g6s, g6c, g6p, ...), and every live host (GRC_LIVE_LISTEN)
#     under GATE7_LIVE_KIND (gate 7's live legs, whose cadence and rate are checked), opens one.
#     timing_leg <label> <command...> brackets anything else (a realtime reference render).
#     Inside a timing leg nothing else is taken.
#   - legs_run_checker runs the checker under the shared lock, then writes the run's lock summary
#     (<out>/quiet-lock-summary.json; the per-event log is <out>/quiet-lock.jsonl).
# shellcheck source=lib/quiet.sh
source "$(dirname "${BASH_SOURCE[0]}")/quiet.sh"
QUIET_LOG="$OUT/quiet-lock.jsonl"
LEGS_QUIET_T0="$EPOCHREALTIME"
LEGS_TIMING_GROUP="${LEGS_TIMING_GROUP:-}"
LEGS_TIMING_LABEL=""
LEGS_TIMING_OPENER=""
LEGS_LOCK_MODE=""
LEGS_LOCK_FG=0
LEGS_LOCK_BG=()

legs__rel() {
	local rel="${1#"$OUT"/}"
	printf '%s' "${rel%/host}"
}

# legs__lock_prune: forgets tracked background pids that have exited (zombies included).
legs__lock_prune() {
	local -a keep=()
	local pid
	for pid in ${LEGS_LOCK_BG[@]+"${LEGS_LOCK_BG[@]}"}; do
		quiet__stat "$pid" && keep+=("$pid")
	done
	LEGS_LOCK_BG=(${keep[@]+"${keep[@]}"})
}

# legs_lock_enter <dir>: the shared hold for a launch (no-op inside a timing leg or a hold).
legs_lock_enter() {
	[ -z "$LEGS_TIMING_LABEL" ] || return 0
	legs__lock_prune
	[ -z "$LEGS_LOCK_MODE" ] || return 0
	quiet_acquire shared "$LEGS_LOG:$(legs__rel "$1")"
	LEGS_LOCK_MODE=shared
}

# legs_lock_leave: releases the shared hold once no launch of this runner is running.
legs_lock_leave() {
	[ -z "$LEGS_TIMING_LABEL" ] || return 0
	[ -n "$LEGS_LOCK_MODE" ] || return 0
	legs__lock_prune
	[ "$LEGS_LOCK_FG" -le 0 ] || return 0
	[ "${#LEGS_LOCK_BG[@]}" = 0 ] || return 0
	quiet_release
	LEGS_LOCK_MODE=""
}

# timing_leg_begin <label> / timing_leg_end: one timing leg's exclusive hold. A shared hold this
# runner still has (a background process of an earlier leg) is dropped first.
timing_leg_begin() {
	[ -z "$LEGS_TIMING_LABEL" ] || return 0
	if [ -n "$LEGS_LOCK_MODE" ]; then
		quiet_release
		LEGS_LOCK_MODE=""
		LEGS_LOCK_BG=()
	fi
	LEGS_TIMING_LABEL="$1"
	quiet_acquire exclusive "$LEGS_LOG:$1"
}

timing_leg_end() {
	[ -n "$LEGS_TIMING_LABEL" ] || return 0
	quiet_release
	LEGS_TIMING_LABEL=""
	LEGS_TIMING_OPENER=""
}

# timing_leg <label> <command...>: the command as one timing leg.
timing_leg() {
	local label="$1"
	shift
	timing_leg_begin "$label"
	"$@"
	local rc=$?
	timing_leg_end
	return "$rc"
}

# legs__timing_opens: true when the background launch about to start opens a timing leg.
legs__timing_opens() {
	if [ -n "$LEGS_TIMING_OPENER" ] && ! quiet__stat "$LEGS_TIMING_OPENER"; then
		# its opener exited without a finish_bg: that leg is over
		timing_leg_end
	fi
	[ -z "$LEGS_TIMING_LABEL" ] || return 1
	[ -n "$LEGS_TIMING_GROUP" ] && return 0
	[ -n "$GATE7_LIVE_KIND" ] && leg_env_value GRC_LIVE_LISTEN >/dev/null && return 0
	return 1
}

# legs_run_checker <command...>: the run's checker under the shared lock, then the lock summary.
legs_run_checker() {
	local rc=0
	quiet_run shared "$LEGS_LOG:checker" -- "$@" || rc=$?
	legs_quiet_summary
	return "$rc"
}

legs_quiet_summary() {
	quiet_summary "$OUT" "$(quiet__secs "$LEGS_QUIET_T0" "$EPOCHREALTIME")" | sed "s/^/$LEGS_LOG: /"
}

gate0_tool() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate0-tool.ts" "$@")
}

# --------------------------------------------------------------------------------------------
# G7l (gate7-design.md Q4 "Live client", Q8): browser receivers inside the gate's own runner.
# With GATE7_LIVE_KIND=web|gsw in the runner's environment (never an RS_/GRC_ name: those are
# stripped from launched processes):
#   - a capture HOST launch (start_headless_bg with GRC_LIVE_LISTEN= in LEG_ENV) gets
#     GRC_LIVE_ALLOWED_ORIGINS=http://127.0.0.1:$GATE7_HARNESS_PORT appended (unless the leg sets
#     one);
#   - a RECEIVER launch (run_headless, run_rendered, start_headless_bg of --path $RECEIVER_DIR)
#     whose LEG_ENV has RS_RECEIVER_MODE=live, or whose RS_RECEIVER_RECORDING is a GRS7 recording
#     (a live-replay of received.rs7), goes to run_browser_receiver instead: a browser receiver of
#     that kind (scripts/lib/gate7-live-legs.ts), always rendered, with the leg's own words. Every
#     other launch is unchanged.
# Legs run in one browser daemon per runner (gate7-tool.ts browser-daemon, started here; it keeps
# the next leg's fresh browser launched and checked, and exits when the runner does), each leg
# through one `curl` (SIGTERM to it SIGKILLs the leg's browser: the gate-1 killed leg). Its files
# are under $OUT/gate7-browser/. run-gate7.sh's own sourcing of this file never substitutes.
# GATE7_HARNESS_PORT and GATE7_HOST_PORT (the page's and every live host's port; default: free
# ports picked here, fixed for the run; see gate7_host_env), GATE7_BUNDLE_DIR
# (required: build-web-receiver.sh's bundle/ or the GSW bundle), GATE7_STATIC_ROOT (default $OUT),
# GATE7_BUILD_SHA256 and GATE7_MANIFEST_SHA256 (optional), GATE7_PAGE_PORT (one leg's page port,
# e.g. origin-refused's non-allowed one; reset after the call), GATE7_WEB_CORE (G7xwl: gdscript
# or rust, the web export's core; read by the daemon, as is GATE7_WEB_CORE_SABOTAGE).
# LIVE_RECEIVED_NAME is the live receiver's received tap: received.rs2 (/6, native) or
# received.rs7 (/7, a browser receiver).
GATE7_LIVE_KIND="${GATE7_LIVE_KIND:-}"
[ "$LEGS_LOG" = "run-gate7" ] && GATE7_LIVE_KIND=""
LIVE_RECEIVED_NAME="received.rs2"
GATE7_PAGE_PORT=""
GATE7_DAEMON_PORT=""
if [ -n "$GATE7_LIVE_KIND" ]; then
	case "$GATE7_LIVE_KIND" in
	web | gsw) ;;
	*)
		echo "$LEGS_LOG: GATE7_LIVE_KIND must be web or gsw (got $GATE7_LIVE_KIND)" >&2
		exit 2
		;;
	esac
	if [ -z "${GATE7_BUNDLE_DIR:-}" ] || [ ! -f "$GATE7_BUNDLE_DIR/receiver.html" ]; then
		echo "$LEGS_LOG: GATE7_LIVE_KIND=$GATE7_LIVE_KIND needs GATE7_BUNDLE_DIR (a bundle with receiver.html; got ${GATE7_BUNDLE_DIR:-<unset>})" >&2
		exit 2
	fi
	GATE7_BUNDLE_DIR="$(realpath "$GATE7_BUNDLE_DIR")"
	if [ -z "${GATE7_HARNESS_PORT:-}" ]; then
		GATE7_HARNESS_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
	fi
	if [ -z "${GATE7_HOST_PORT:-}" ]; then
		GATE7_HOST_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
	fi
	LIVE_RECEIVED_NAME="received.rs7"
	echo "$LEGS_LOG: GATE7_LIVE_KIND=$GATE7_LIVE_KIND: live receivers run in a browser (bundle $GATE7_BUNDLE_DIR, web core ${GATE7_WEB_CORE:-rust}, page origin http://127.0.0.1:$GATE7_HARNESS_PORT)"
	gate7_daemon_dir="$OUT/gate7-browser"
	mkdir -p "$gate7_daemon_dir"
	rm -f "$gate7_daemon_dir/daemon.json"
	gs_strip_env_args
	env -C "$REPO_ROOT" -u DISPLAY -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}" \
		mise exec -- node --conditions=development --import tsx "$SCRIPT_DIR/gate7-tool.ts" browser-daemon \
		--ready-file "$gate7_daemon_dir/daemon.json" --parent "$$" --kind "$GATE7_LIVE_KIND" \
		--bundle "$GATE7_BUNDLE_DIR" --static-root "${GATE7_STATIC_ROOT:-$OUT}" \
		>"$gate7_daemon_dir/daemon.log" 2>&1 &
	gate7_waited=0
	while [ "$gate7_waited" -lt 1200 ] && [ ! -s "$gate7_daemon_dir/daemon.json" ]; do
		sleep 0.1
		gate7_waited=$((gate7_waited + 1))
	done
	GATE7_DAEMON_PORT="$(sed -n 's/^{"port":\([0-9][0-9]*\),.*$/\1/p' "$gate7_daemon_dir/daemon.json" 2>/dev/null || true)"
	if [ -z "$GATE7_DAEMON_PORT" ]; then
		echo "$LEGS_LOG: the gate 7 browser daemon did not start (see $gate7_daemon_dir/daemon.log)" >&2
		exit 1
	fi
	echo "$LEGS_LOG: gate 7 browser daemon on 127.0.0.1:$GATE7_DAEMON_PORT"
fi

# leg_env_value <NAME>: prints NAME's value in LEG_ENV (the last one); fails when absent.
leg_env_value() {
	local name="$1" word value="" found=1
	for word in ${LEG_ENV[@]+"${LEG_ENV[@]}"}; do
		case "$word" in
		"$name="*)
			value="${word#*=}"
			found=0
			;;
		esac
	done
	[ "$found" = 0 ] && printf '%s\n' "$value"
	return "$found"
}

# gate7_browser_leg <command...>: true when GATE7 mode is on and the command launches the receiver
# project as a live receiver, or as a file-mode replay of a GRS7 recording.
gate7_browser_leg() {
	[ -n "$GATE7_LIVE_KIND" ] || return 1
	local prev="" word on_receiver=0 recording
	for word in "$@"; do
		if [ "$prev" = "--path" ] && [ "$word" = "$RECEIVER_DIR" ]; then
			on_receiver=1
		fi
		prev="$word"
	done
	[ "$on_receiver" = 1 ] || return 1
	[ "$(leg_env_value RS_RECEIVER_MODE || true)" = "live" ] && return 0
	recording="$(leg_env_value RS_RECEIVER_RECORDING || true)"
	[ -n "$recording" ] && [ -f "$recording" ] && [ "$(head -c 4 "$recording")" = "GRS7" ] && return 0
	return 1
}

# gate7_host_env: GATE7 mode only. Appends the page origin to a live host's LEG_ENV, and moves a
# host listening on 127.0.0.1:0 to the run's fixed GATE7_HOST_PORT: a browser's HTTP cache is
# keyed by the resource URL, host port included, so a warm leg's new host must serve the cold
# leg's payload URLs (hosts run one at a time, and rs_ws binds with SO_REUSEADDR).
gate7_host_env() {
	[ -n "$GATE7_LIVE_KIND" ] || return 0
	leg_env_value GRC_LIVE_LISTEN >/dev/null || return 0
	local i
	for i in "${!LEG_ENV[@]}"; do
		if [ "${LEG_ENV[$i]}" = "GRC_LIVE_LISTEN=127.0.0.1:0" ]; then
			LEG_ENV[i]="GRC_LIVE_LISTEN=127.0.0.1:$GATE7_HOST_PORT"
		fi
	done
	leg_env_value GRC_LIVE_ALLOWED_ORIGINS >/dev/null && return 0
	LEG_ENV+=(GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$GATE7_HARNESS_PORT")
}

# run_browser_receiver <dir> <fg|bg> -- <native command...>: the browser receiver for a native
# receiver launch (header above). Writes <dir>/native-env.txt (LEG_ENV) and native-argv.txt (the
# native command) for the daemon, which writes env.txt, argv.txt, page-config.json,
# provenance.json, console.jsonl, stdout.log, timings.json and exit-code.txt; the request's own
# output goes to <dir>/launcher.log. fg waits (RENDERED_TIMEOUT_S plus start-up slack); bg returns
# at once with the request's pid in BG_PID (SIGTERM to it SIGKILLs the leg's browser at once).
run_browser_receiver() {
	local dir="$1" how="$2"
	shift 3
	mkdir -p "$dir"
	printf '%s\n' ${LEG_ENV[@]+"${LEG_ENV[@]}"} >"$dir/native-env.txt"
	printf '%s\n' "$@" >"$dir/native-argv.txt"
	local -a cmd=(curl -sS -N --get --max-time $((RENDERED_TIMEOUT_S + 120))
		--data-urlencode "dir=$dir" --data-urlencode "port=${GATE7_PAGE_PORT:-$GATE7_HARNESS_PORT}"
		--data-urlencode "timeout_s=$RENDERED_TIMEOUT_S" "http://127.0.0.1:$GATE7_DAEMON_PORT/run")
	GATE7_PAGE_PORT=""
	"${cmd[@]}" >"$dir/launcher.log" 2>&1 &
	local pid=$!
	if [ "$how" = "bg" ]; then
		BG_PID="$pid"
		return 0
	fi
	CURRENT_CHILD_PID="$pid"
	wait_owned "$pid" $((RENDERED_TIMEOUT_S + 60))
	CURRENT_CHILD_PID=""
	[ -s "$dir/exit-code.txt" ] || echo "$WAIT_EXIT" >"$dir/exit-code.txt"
	echo "$LEGS_LOG: ${dir#"$OUT"/} exit=$(cat "$dir/exit-code.txt") ($GATE7_LIVE_KIND browser receiver)"
}

# G7xn (gate7-design.md "G7xn", D34; G7xd flipped the default): the runner's own RS_RECEIVER_CORE
# (rust, the default since G7xd, or gdscript, frozen at /7 and selectable for milestone sweeps)
# and RS_RECEIVER_CORE_EXT pick the native receiver's core for every receiver launch of the run.
# Every launch strips inherited RS_* variables, so receiver_core_env adds them back as NAME=value
# words, to receiver launches only (`--path "$RECEIVER_DIR"`), and only when something is not the
# default: a plain default run's env.txt files are what they were, even though RECEIVER_CORE
# itself already reads "rust" (a non-empty RECEIVER_CORE_EXT still needs forwarding under it).
RECEIVER_CORE="${RS_RECEIVER_CORE:-rust}"
RECEIVER_CORE_EXT="${RS_RECEIVER_CORE_EXT:-}"

receiver_core_env() {
	{ [ "$RECEIVER_CORE" != "rust" ] || [ -n "$RECEIVER_CORE_EXT" ]; } || return 0
	local previous="" arg
	for arg in "${LEG_ENV[@]}"; do
		[ "${arg%%=*}" != "RS_RECEIVER_CORE" ] || return 0
	done
	for arg in "$@"; do
		if [ "$previous" = "--path" ] && [ "$arg" = "${RECEIVER_DIR:-}" ]; then
			LEG_ENV+=(RS_RECEIVER_CORE="$RECEIVER_CORE")
			if [ -n "$RECEIVER_CORE_EXT" ]; then
				LEG_ENV+=(RS_RECEIVER_CORE_EXT="$RECEIVER_CORE_EXT")
			fi
			return 0
		fi
		previous="$arg"
	done
}

# write_invocation <dir> <argv...>: records argv.txt and env.txt. Every launch calls it right
# before it starts the process, so it is also where receiver_core_env adds the core's words to
# LEG_ENV.
write_invocation() {
	local dir="$1"
	shift
	receiver_core_env "$@"
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
legs__run_headless() {
	local dir="$1" mode="$2"
	shift 3
	if gate7_browser_leg "$@"; then
		run_browser_receiver "$dir" fg -- "$@"
		return 0
	fi
	mkdir -p "$dir"
	gs_strip_env_args
	receiver_core_env "$@"
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
legs__start_headless_bg() {
	local dir="$1"
	shift 2
	if gate7_browser_leg "$@"; then
		run_browser_receiver "$dir" bg -- "$@"
		return 0
	fi
	gate7_host_env
	mkdir -p "$dir"
	gs_strip_env_args
	receiver_core_env "$@"
	local -a cmd=(env -u DISPLAY -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}")
	if [ "${#LEG_ENV[@]}" -gt 0 ]; then
		cmd+=("${LEG_ENV[@]}")
	fi
	write_invocation "$dir" "$@"
	"${cmd[@]}" "$@" >"$dir/stdout.log" 2>&1 &
	BG_PID=$!
}

# finish_bg <dir> <pid> <timeout s>: waits for a start_headless_bg child, writes exit-code.txt.
legs__finish_bg() {
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
legs__run_rendered() {
	local dir="$1" project="$2"
	local -a extra=()
	if [ "${#RENDERED_EXTRA_ARGS[@]}" -gt 0 ]; then
		extra=("${RENDERED_EXTRA_ARGS[@]}")
	fi
	RENDERED_EXTRA_ARGS=()
	if gate7_browser_leg "$BINARY" --path "$project" "${extra[@]}"; then
		run_browser_receiver "$dir" fg -- "$BINARY" --path "$project" "${extra[@]}"
		return 0
	fi
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

# The launch functions, each under the quiet lock (header above).
run_headless() {
	legs_lock_enter "$1"
	LEGS_LOCK_FG=$((LEGS_LOCK_FG + 1))
	legs__run_headless "$@"
	local rc=$?
	LEGS_LOCK_FG=$((LEGS_LOCK_FG - 1))
	legs_lock_leave
	return "$rc"
}

run_rendered() {
	legs_lock_enter "$1"
	LEGS_LOCK_FG=$((LEGS_LOCK_FG + 1))
	legs__run_rendered "$@"
	local rc=$?
	LEGS_LOCK_FG=$((LEGS_LOCK_FG - 1))
	legs_lock_leave
	return "$rc"
}

start_headless_bg() {
	local opens=0
	if legs__timing_opens; then
		opens=1
		timing_leg_begin "${LEGS_TIMING_GROUP:-gate7-live}:$(legs__rel "$1")"
	else
		legs_lock_enter "$1"
	fi
	legs__start_headless_bg "$@"
	if [ "$opens" = 1 ]; then
		LEGS_TIMING_OPENER="$BG_PID"
	elif [ -z "$LEGS_TIMING_LABEL" ] && [ -n "$BG_PID" ]; then
		LEGS_LOCK_BG+=("$BG_PID")
	fi
}

finish_bg() {
	legs__finish_bg "$@"
	local rc=$? pid="$2"
	if [ -n "$LEGS_TIMING_OPENER" ] && [ "$pid" = "$LEGS_TIMING_OPENER" ]; then
		timing_leg_end
	fi
	legs_lock_leave
	return "$rc"
}
