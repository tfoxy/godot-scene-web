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
# e.g. origin-refused's non-allowed one; reset after the call), GATE7_WEB_FETCH
# (G7wf: fetch, the default, or httpclient, the web export's payload GETs; read by the daemon).
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
	echo "$LEGS_LOG: GATE7_LIVE_KIND=$GATE7_LIVE_KIND: live receivers run in a browser (bundle $GATE7_BUNDLE_DIR, web fetch ${GATE7_WEB_FETCH:-fetch}, page origin http://127.0.0.1:$GATE7_HARNESS_PORT)"
	gate7_daemon_dir="$OUT/gate7-browser"
	mkdir -p "$gate7_daemon_dir"
	rm -f "$gate7_daemon_dir/daemon.json"
	gs_strip_env_args
	# G7u part D: the device daemon reverses the page and host ports onto the phone.
	gate7_daemon_env=()
	if [ "${GATE7_LIFECYCLE_ENV:-desktop}" = device ]; then
		gate7_daemon_env=(GATE7_HARNESS_PORT="$GATE7_HARNESS_PORT" GATE7_HOST_PORT="$GATE7_HOST_PORT")
	fi
	# R3: the CI-only software-renderer allowance (lib/browser-renderer.ts) is an RS_ name, which
	# gs_strip_env_args strips; the daemon launches the browsers, so it needs it back (without it a
	# hosted runner's live legs launched with the NVIDIA flags and got no WebGL2). Off a hosted
	# runner a set RS_BROWSER_PROVENANCE makes the daemon refuse at load, as everywhere else.
	if [ -n "${RS_BROWSER_PROVENANCE:-}" ]; then
		gate7_daemon_env+=(RS_BROWSER_PROVENANCE="$RS_BROWSER_PROVENANCE")
	fi
	env -C "$REPO_ROOT" -u DISPLAY -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}" ${gate7_daemon_env[@]+"${gate7_daemon_env[@]}"} \
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
	# G7q/G7wd: GATE7_CREDIT_WINDOW (lib/gamescope.sh): a live browser receiver asks for it
	# explicitly (the receivers' own default is 2 too, so window 1 must be written down).
	if [ "$(leg_env_value RS_RECEIVER_MODE || true)" = "live" ] &&
		! leg_env_value RS_RECEIVER_CREDIT_WINDOW >/dev/null; then
		LEG_ENV+=(RS_RECEIVER_CREDIT_WINDOW="$GATE7_CREDIT_WINDOW")
	fi
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

# G7xn (gate7-design.md "G7xn", D34): the runner's own RS_RECEIVER_CORE_EXT picks the native
# receiver's adapter (.gdextension) for every receiver launch of the run. Every launch strips
# inherited RS_* variables, so receiver_core_env adds it back as a NAME=value word, to receiver
# launches only (`--path "$RECEIVER_DIR"`), and only when it is set: a plain run's env.txt files
# carry no core words. G7gd removed the GDScript core, so the Rust core is the only one and a run
# started with RS_RECEIVER_CORE set to anything but rust refuses to start.
case "${RS_RECEIVER_CORE:-rust}" in
rust) ;;
*)
	echo "${LEGS_LOG:-legs}: RS_RECEIVER_CORE must be rust or unset (got ${RS_RECEIVER_CORE}); G7gd removed the GDScript core" >&2
	exit 2
	;;
esac
RECEIVER_CORE_EXT="${RS_RECEIVER_CORE_EXT:-}"

receiver_core_env() {
	[ -n "$RECEIVER_CORE_EXT" ] || return 0
	local previous="" arg
	for arg in "${LEG_ENV[@]}"; do
		[ "${arg%%=*}" != "RS_RECEIVER_CORE_EXT" ] || return 0
	done
	for arg in "$@"; do
		if [ "$previous" = "--path" ] && [ "$arg" = "${RECEIVER_DIR:-}" ]; then
			LEG_ENV+=(RS_RECEIVER_CORE_EXT="$RECEIVER_CORE_EXT")
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

# --------------------------------------------------------------------------------------------
# Fast frames (GRT3, results/grt.md "Part 3"; scripts/README.md "Fast frames (GRT3)"). Opt-in:
# RS_FAST_FRAMES=all|host|receiver (default off) runs the ALLOWLISTED live correctness legs below
# faster than real time; validate-increment.sh's smoke and full tiers set it, milestone sweeps and
# a plain runner do not. On every side, hosts only, or receivers only (`--path $RECEIVER_DIR`), an
# allowlisted launch's `--max-fps 60` becomes `--max-fps $RS_FAST_FRAMES_MAX_FPS --disable-vsync`
# (default 240; a browser receiver gets the `--max-fps` alone, its Chromium is unthrottled by
# GATE7_FAST_FRAMES=1, lib/gate7-live-legs.ts). A fast host also gets
#   GRC_LOW_PROCESSOR_SLEEP_USEC=0  without it a headless host sleeps 6900 us per frame whatever
#                                   --max-fps says (~145 fps at most; capture/src/entry.cpp);
#   GRC_LIVE_AWAIT_HELLO_MS=<ms>    a live host holds its timeline at the first armed frame until
#                                   the first receiver's hello (RS_FAST_AWAIT_HELLO_MS, default
#                                   60000), so the 300-frame join window costs no real time.
# The gate fixtures count frames, never delta, and every check of an allowlisted leg counts host
# frames: stalls and the fetch delay are specified in frames at 60 fps and converted with
# legs_frames_ms against the host's own rate (exactly the old milliseconds at 60 fps, so a
# real-time leg's env and evidence are unchanged), and check-gate1.ts's sim-kept-running reads
# the host's --max-fps from its argv.txt.
#
# Never unbounded --fixed-fps: Godot 4.5.1 ignores --max-fps beside it (Main::iteration returns
# before OS::add_frame_delay), and a host that finishes its timeline before a receiver joins
# breaks every live leg (GRT2b), so RS_FAST_FRAMES_MAX_FPS must be 61..1000.
#
# The DENYLIST stays real time whatever is set: every timing group but RS_FAST_ALLOW_GROUPS
# (g1c-rate's live-rate-30, g6l, g6s, g6c, g6p: rate, cadence, phase, soak), every timing_leg
# label (g6s reference-step11), every leg RS_FAST_DENY_LEGS names (g2e's refusal legs, whose host
# may never see a hello), every leg not in RS_FAST_ALLOW_LEGS, and everything outside these
# runners: run-gate7.sh's g7-r pacing, g7-lc lifecycle, g7-k startup and soak groups, every
# gate7-bench.ts arm and every device leg. A timing leg keeps the exclusive quiet lock either way:
# the allowlisted timing groups (g1d, g2c-pins, g5f, g55f) and gate 7's live legs run fast UNDER
# their exclusive hold, never outside it.
RS_FAST_FRAMES_MODE="${RS_FAST_FRAMES:-off}"
RS_FAST_FRAMES_MAX_FPS="${RS_FAST_FRAMES_MAX_FPS:-240}"
RS_FAST_AWAIT_HELLO_MS="${RS_FAST_AWAIT_HELLO_MS:-60000}"
case "$RS_FAST_FRAMES_MODE" in
off | all | host | receiver) ;;
*)
	echo "$LEGS_LOG: RS_FAST_FRAMES must be off, all, host or receiver (got $RS_FAST_FRAMES_MODE)" >&2
	exit 2
	;;
esac
case "$RS_FAST_FRAMES_MAX_FPS" in
'' | *[!0-9]*) RS_FAST_FRAMES_MAX_FPS=bad ;;
esac
if [ "$RS_FAST_FRAMES_MODE" != off ] && { [ "$RS_FAST_FRAMES_MAX_FPS" = bad ] ||
	[ "$RS_FAST_FRAMES_MAX_FPS" -le 60 ] || [ "$RS_FAST_FRAMES_MAX_FPS" -gt 1000 ]; }; then
	echo "$LEGS_LOG: RS_FAST_FRAMES_MAX_FPS must be 61..1000 (never unbounded --fixed-fps; got ${RS_FAST_FRAMES_MAX_FPS:-})" >&2
	exit 2
fi
# "<runner>:<leg>" globs; <leg> is the leg directory under --out, a trailing host/ or receiver/
# dropped (legs__fast_leg). Gate 7's live groups run these same runners (GATE7_LIVE_KIND), so
# g7-1, g7-2, g7-5 and g7-55 follow this list leg by leg.
RS_FAST_ALLOW_LEGS=(
	# gate 1 g1c (live delivery) and g1d (stall, coalescing, reconnect, resync, kill, sabotages)
	run-gate1:live-headless run-gate1:live run-gate1:sabotage-drop-message
	run-gate1:live-receiver-killed run-gate1:live-stall run-gate1:live-reconnect
	run-gate1:live-resync run-gate1:sabotage-ignore-credit run-gate1:sabotage-stale-coalesce
	# gate 2 g2b live-inline and g2c (live resources, stall, reconnect, pins)
	run-gate2:live-inline run-gate2:live-headless run-gate2:sabotage-drop-resource
	run-gate2:sabotage-wrong-hash-live run-gate2:live run-gate2:live-warm run-gate2:live-stall
	run-gate2:live-reconnect run-gate2:live-animate run-gate2:sabotage-unpin
	# gate 5 g5f and gate 5.5 g55f (live mesh / shader through a stall)
	'run-gate5:mesh/live-mesh*' run-gate5:mesh/sabotage-mesh-stale-coalesce
	'run-gate55:shader-live/live-shader*' run-gate55:shader-live/sabotage-shader-stale-coalesce
)
# Named real-time legs (documentation as much as policy: they are outside the allowlist anyway).
RS_FAST_DENY_LEGS=(
	run-gate1:live-rate-30 run-gate2:sabotage-no-token run-gate2:sabotage-bad-http-token
	run-gate2:origin-refused run-gate2:sabotage-no-cors run-gate2:live-auth 'run-gate6:*'
)
# Timing groups whose legs may run fast (still under their exclusive hold): their checks count
# frames once the stalls do.
RS_FAST_ALLOW_GROUPS=(g1d g2c-pins g5f g55f)

legs__fast_leg() {
	local rel="${1#"$OUT"/}"
	case "${rel##*/}" in
	host | receiver | receiver-*) rel="${rel%/*}" ;;
	esac
	printf '%s' "$rel"
}

# legs_fast_applies <leg dir>: true when RS_FAST_FRAMES is on and the leg is allowlisted here.
legs_fast_applies() {
	[ "$RS_FAST_FRAMES_MODE" != off ] || return 1
	local key pat g ok=0
	if [ -n "$LEGS_TIMING_GROUP" ]; then
		for g in "${RS_FAST_ALLOW_GROUPS[@]}"; do
			[ "$g" = "$LEGS_TIMING_GROUP" ] && ok=1
		done
		[ "$ok" = 1 ] || return 1
	elif [ -n "$LEGS_TIMING_LABEL" ]; then
		case "$LEGS_TIMING_LABEL" in
		gate7-live:*) ;;
		*) return 1 ;;
		esac
	fi
	key="$LEGS_LOG:$(legs__fast_leg "$1")"
	for pat in "${RS_FAST_DENY_LEGS[@]}"; do
		# shellcheck disable=SC2053 # a glob on purpose
		[[ $key == $pat ]] && return 1
	done
	for pat in "${RS_FAST_ALLOW_LEGS[@]}"; do
		# shellcheck disable=SC2053
		[[ $key == $pat ]] && return 0
	done
	return 1
}

# legs_fast_host_fps <host dir>: the frame rate the host launched at <host dir> runs at (60, or
# RS_FAST_FRAMES_MAX_FPS when it runs fast).
legs_fast_host_fps() {
	case "$RS_FAST_FRAMES_MODE" in
	all | host)
		if legs_fast_applies "$1"; then
			echo "$RS_FAST_FRAMES_MAX_FPS"
			return 0
		fi
		;;
	esac
	echo 60
}

# legs_frames_ms <host dir> <frames>: <frames> host frames in milliseconds at that host's rate,
# rounded (a stall or fetch delay given in frames at 60 fps: 78 -> 1300 ms at 60, 325 at 240).
legs_frames_ms() {
	local fps
	fps="$(legs_fast_host_fps "$1")"
	echo $((($2 * 1000 + fps / 2) / fps))
}

# legs_stall_spec <host dir> <step> <frames>: the receiver's RS_RECEIVER_STALL (<step>:<ms>) for a
# stall of <frames> host frames after <step>'s shot.
legs_stall_spec() {
	echo "$2:$(legs_frames_ms "$1" "$3")"
}

# legs__fast_argv <argv...>: sets LEGS_ARGV (the rewrite above, or argv unchanged) for the launch
# in LEGS_FAST_DIR (its leg directory, set by the caller) and, for a rewritten host, adds the fast
# host words to LEG_ENV.
LEGS_ARGV=()
LEGS_FAST_DIR=""
legs__fast_argv() {
	local dir="$LEGS_FAST_DIR"
	LEGS_ARGV=("$@")
	legs_fast_applies "$dir" || return 0
	local -a args=("$@") out=()
	local i recv=0 prev="" browser=0 rewrote=0
	for i in "${args[@]}"; do
		[ "$prev" = "--path" ] && [ "$i" = "${RECEIVER_DIR:-}" ] && recv=1
		prev="$i"
	done
	case "$RS_FAST_FRAMES_MODE" in
	host) [ "$recv" = 0 ] || return 0 ;;
	receiver) [ "$recv" = 1 ] || return 0 ;;
	esac
	[ "$recv" = 1 ] && [ -n "${GATE7_LIVE_KIND:-}" ] && browser=1
	for ((i = 0; i < ${#args[@]}; i++)); do
		if [ "${args[$i]}" = "--max-fps" ] && [ "${args[$((i + 1))]:-}" = 60 ]; then
			out+=(--max-fps "$RS_FAST_FRAMES_MAX_FPS")
			[ "$browser" = 1 ] || out+=(--disable-vsync)
			i=$((i + 1))
			rewrote=1
		else
			out+=("${args[$i]}")
		fi
	done
	LEGS_ARGV=("${out[@]}")
	[ "$rewrote" = 1 ] && [ "$recv" = 0 ] || return 0
	LEG_ENV+=(GRC_LOW_PROCESSOR_SLEEP_USEC=0)
	if leg_env_value GRC_LIVE_LISTEN >/dev/null; then
		LEG_ENV+=(GRC_LIVE_AWAIT_HELLO_MS="$RS_FAST_AWAIT_HELLO_MS")
	fi
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
	LEGS_FAST_DIR="$dir"
	legs__fast_argv "$@"
	set -- "${LEGS_ARGV[@]}"
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
	LEGS_FAST_DIR="$dir"
	if gate7_browser_leg "$@"; then
		legs__fast_argv "$@"
		run_browser_receiver "$dir" bg -- "${LEGS_ARGV[@]}"
		return 0
	fi
	gate7_host_env
	# G7q/G7wd: GATE7_CREDIT_WINDOW (lib/gamescope.sh): a live host's window maximum.
	local credit_word
	for credit_word in $(gs_credit_window_words ${LEG_ENV[@]+"${LEG_ENV[@]}"}); do
		LEG_ENV+=("$credit_word")
	done
	legs__fast_argv "$@"
	set -- "${LEGS_ARGV[@]}"
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
	LEGS_FAST_DIR="$dir"
	legs__fast_argv --path "$project" ${extra[@]+"${extra[@]}"}
	extra=(${LEGS_ARGV[@]+"${LEGS_ARGV[@]:2}"})
	if gate7_browser_leg "$BINARY" --path "$project" ${extra[@]+"${extra[@]}"}; then
		run_browser_receiver "$dir" fg -- "$BINARY" --path "$project" ${extra[@]+"${extra[@]}"}
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
	# a parallel region (RS_LEG_SHARDS, below) runs the whole leg -- its tsx settle-seqs step too
	if legs__par_dispatch run_rendered_receiver "$@"; then
		RECEIVER_SOURCE=""
		RECEIVER_EXTRA_SHOTS=""
		RECEIVER_STATE=0
		RECEIVER_EXTRA_ENV=()
		return 0
	fi
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

# GRT smoke tier (scripts/validate-increment.sh, results/grt.md): two env switches skip a leg
# without launching it; its directory gets skipped-by-tier.txt instead, and a receiver leg on a
# skipped capture finds no recording and skips itself (prepare_recording). The checker then fails
# the checks that needed that evidence; validate-increment.sh's tier verdict excuses exactly the
# ones whose failure list names only skipped legs.
#   RS_SABOTAGE_TIER=skip   a SABOTAGE leg (a path component of its directory, relative to $OUT,
#                           contains "sabotage") is skipped
#   RS_SMOKE_LEGS=a,b,...   only legs whose directory, relative to $OUT, equals one of the entries
#                           or lies under one (entry/...) run; every other leg is skipped
# Milestone sweeps, full-tier runs and plain runner calls set neither and run every leg.
legs_sabotage_skipped() {
	local rel why=""
	rel="$(legs__rel "$1")"
	if [ "${RS_SABOTAGE_TIER:-run}" = skip ]; then
		case "/$rel/" in
		*/*sabotage*/*) why="RS_SABOTAGE_TIER=skip" ;;
		esac
	fi
	if [ -z "$why" ] && [ -n "${RS_SMOKE_LEGS:-}" ]; then
		local e keep=0
		local -a entries
		IFS=, read -r -a entries <<<"$RS_SMOKE_LEGS"
		for e in "${entries[@]}"; do
			case "$rel" in
			"$e" | "$e"/*) keep=1 ;;
			esac
		done
		[ "$keep" = 1 ] || why="RS_SMOKE_LEGS (the smoke tier runs one representative leg)"
	fi
	[ -n "$why" ] || return 1
	mkdir -p "$1"
	echo "skipped-by-tier: $why" >"$1/skipped-by-tier.txt"
	echo "$LEGS_LOG: $rel skipped by tier ($why)" >&2
	return 0
}

# legs_skip_group <timing group> <leg dir>...: RS_SKIP_TIMING_GROUPS=1 (remote runs only, set by
# .github/workflows/remote-validate.yml, never a default) skips a whole timing group inside a
# correctness gate (g1c-rate, g1d, g2c-pins, g5f, g55f: wall-clock legs a shared hosted VM would
# only make noisy). Each leg dir gets skipped-remote.txt instead of evidence; lib/tier-verdict.py
# excuses the checks that name those legs like skipped-by-tier, and lists them (and the group) as
# skipped_remote[] in the run's verdict and validate-summary.json. Returns 0 when the group is
# skipped (the caller does not run it), 1 otherwise: unset, it changes nothing. R3: the value may
# instead be a comma-separated list of groups, skipping only those (gate 7's live jobs pass
# g1c-rate: g1d, g2c-pins, g5f and g55f are frame-counted under fast frames, RS_FAST_ALLOW_LEGS
# above, and are those groups' only correctness legs on a browser).
legs_skip_group() {
	local want="${RS_SKIP_TIMING_GROUPS:-}" group="$1" d
	[ -n "$want" ] || return 1
	[ "$want" = 1 ] || [[ ",$want," == *",$group,"* ]] || return 1
	shift
	for d in "$@"; do
		mkdir -p "$d"
		echo "skipped-remote: RS_SKIP_TIMING_GROUPS=$want (timing group $group: wall-clock legs stay local)" \
			>"$d/skipped-remote.txt"
	done
	echo "$LEGS_LOG: timing group $group skipped on this runner (RS_SKIP_TIMING_GROUPS=$want): ${*#"$OUT"/}" >&2
	return 0
}

# The launch functions, each under the quiet lock (header above).
run_headless() {
	legs_sabotage_skipped "$1" && return 0
	legs__par_dispatch run_headless "$@" && return 0
	legs_lock_enter "$1"
	LEGS_LOCK_FG=$((LEGS_LOCK_FG + 1))
	legs__run_headless "$@"
	local rc=$?
	LEGS_LOCK_FG=$((LEGS_LOCK_FG - 1))
	legs_lock_leave
	return "$rc"
}

run_rendered() {
	legs_sabotage_skipped "$1" && return 0
	legs__par_dispatch run_rendered "$@" && return 0
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
	if legs_sabotage_skipped "$1"; then
		BG_PID=""
		return 0
	fi
	# a background (live) host never runs beside parallel workers (legs_par_begin below)
	legs_par_wait
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
	if [ -z "${2:-}" ] && [ -f "$1/skipped-by-tier.txt" ]; then
		return 0
	fi
	legs__finish_bg "$@"
	local rc=$? pid="$2"
	if [ -n "$LEGS_TIMING_OPENER" ] && [ "$pid" = "$LEGS_TIMING_OPENER" ]; then
		timing_leg_end
	fi
	legs_lock_leave
	return "$rc"
}

# --------------------------------------------------------------------------------------------
# Parallel file-mode legs (GRT2b, results/grt.md "Part 2b", scripts/README.md "Sharded legs").
# Opt-in: RS_LEG_SHARDS=N (`on` = 2; unset, 0, 1 or `off` = serial, the default) runs the launches
# inside a runner's PARALLEL REGIONS on up to N workers at once, each a subshell with its own
# private gamescope (slot 0 reuses the runner's; slots 1..N-1 start beside it, same size) and its
# own per-leg shared quiet-lock hold, exactly as a serial leg holds it.
#   legs_par_begin          opens a region (a no-op when serial, inside a timing group, in a
#                           browser-receiver run, or inside a worker). Call it after gs_start.
#   legs_par_end            waits for every worker, tears the extra gamescopes down, closes the
#                           region; fails when a worker failed (as the serial leg would have).
#   legs_par_unit <fn> ...  runs `fn ...` as ONE unit on one worker: legs that must run in order
#                           (gate 2's cold -> warm cache pairs) go in one unit. Outside a region,
#                           or serial, it just calls the function.
# Inside an open region every run_rendered_receiver (its recording copy and tsx settle-seqs step
# included), run_headless and run_rendered becomes a unit by itself; a gate's own helpers' setup
# before such a launch stays in the runner, in order. A live receiver (RS_RECEIVER_MODE=live) is
# never a unit, and a background host (start_headless_bg) first waits for every worker. So a
# region may hold only legs that read nothing another leg of the region writes,
# and the runner must not read a leg's outputs before legs_par_end. One-shot globals the launch
# functions reset after a call are reset in the runner at dispatch time too. Timing legs never run
# in a region (legs_par_begin refuses inside LEGS_TIMING_GROUP or a timing leg). A runner's cleanup
# calls legs_par_cleanup (stops workers and their Godot children, tears the extra gamescopes down).
LEGS_PAR_N=1
case "${RS_LEG_SHARDS:-}" in
"" | 0 | 1 | off) LEGS_PAR_N=1 ;;
on) LEGS_PAR_N=2 ;;
*[!0-9]*)
	echo "$LEGS_LOG: RS_LEG_SHARDS must be a worker count, on (2) or off (got $RS_LEG_SHARDS)" >&2
	exit 2
	;;
*) LEGS_PAR_N="$RS_LEG_SHARDS" ;;
esac
LEGS_PAR_OPEN=0
LEGS_PAR_CHILD=""
LEGS_PAR_PIDS=()
LEGS_PAR_LABELS=()
LEGS_PAR_GS=()
LEGS_PAR_RC=0
LEGS_PAR_SLOT=""

# legs__par_gs_save / legs__par_gs_load <saved>: one gamescope session's GS_* globals.
legs__par_gs_save() {
	printf '%s\t%s\t%s\t%s\t%s\t%s' "${GS_PID:-}" "${GS_START_TICKS:-}" "${GS_SID:-}" \
		"${GS_DISPLAY:-}" "${GS_RUN_DIR:-}" "${GS_LOG:-}"
}
legs__par_gs_load() {
	IFS=$'\t' read -r GS_PID GS_START_TICKS GS_SID GS_DISPLAY GS_RUN_DIR GS_LOG <<<"$1" || true
}

legs_par_begin() {
	[ "$LEGS_PAR_N" -gt 1 ] || return 0
	[ -z "$LEGS_PAR_CHILD" ] || return 0
	[ "$LEGS_PAR_OPEN" = 0 ] || return 0
	if [ -n "$LEGS_TIMING_GROUP" ] || [ -n "$LEGS_TIMING_LABEL" ]; then
		echo "$LEGS_LOG: parallel region refused inside a timing group: serial" >&2
		return 0
	fi
	if [ -n "$GATE7_LIVE_KIND" ]; then
		# browser receivers share one daemon, one page port and one host port per run: serial
		return 0
	fi
	LEGS_PAR_OPEN=1
	LEGS_PAR_RC=0
	LEGS_PAR_PIDS=()
	LEGS_PAR_LABELS=()
	LEGS_PAR_GS=()
	local k main base
	main="$(legs__par_gs_save)"
	if [ -n "${GS_PID:-}" ] && gs_is_ours "$GS_PID" "$GS_START_TICKS"; then
		LEGS_PAR_GS[0]="$main"
		base="$GS_RUN_DIR"
		for ((k = 1; k < LEGS_PAR_N; k++)); do
			gs_start "$GS_WIDTH" "$GS_HEIGHT" "$base-shard$k"
			LEGS_PAR_GS[k]="$(legs__par_gs_save)"
			legs__par_gs_load "$main"
		done
	fi
	echo "$LEGS_LOG: parallel region open: $LEGS_PAR_N workers"
}

# legs__par_reap <slot>: fails while the slot's worker runs; else records its status, frees it.
legs__par_reap() {
	local k="$1" pid="${LEGS_PAR_PIDS[$1]:-}" rc=0
	[ -n "$pid" ] || return 0
	kill -0 "$pid" 2>/dev/null && return 1
	wait "$pid" || rc=$?
	if [ "$rc" != 0 ]; then
		echo "$LEGS_LOG: parallel unit ${LEGS_PAR_LABELS[$k]} failed (exit $rc)" >&2
		[ "$LEGS_PAR_RC" != 0 ] || LEGS_PAR_RC="$rc"
	fi
	LEGS_PAR_PIDS[k]=""
	return 0
}

# legs__par_free_slot: waits for a free worker slot; sets LEGS_PAR_SLOT.
legs__par_free_slot() {
	local k
	while :; do
		for ((k = 0; k < LEGS_PAR_N; k++)); do
			if legs__par_reap "$k"; then
				LEGS_PAR_SLOT="$k"
				return 0
			fi
		done
		sleep 0.1
	done
}

# legs__par_child_term: a worker told to stop stops the Godot process it owns first.
legs__par_child_term() {
	if [ -n "$CURRENT_CHILD_PID" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	exit 143
}

# legs__par_child <slot> <command...>: a worker's body (in its own subshell).
legs__par_child() {
	LEGS_PAR_CHILD="$1"
	shift
	trap - EXIT
	trap legs__par_child_term TERM INT
	# the runner's holds are the runner's: this worker takes its own, per leg
	LEGS_LOCK_MODE=""
	LEGS_LOCK_FG=0
	LEGS_LOCK_BG=()
	QUIET__DEPTH=0
	QUIET__HOLDER=""
	QUIET__MODE=""
	CURRENT_CHILD_PID=""
	if [ -n "${LEGS_PAR_GS[$LEGS_PAR_CHILD]:-}" ]; then
		legs__par_gs_load "${LEGS_PAR_GS[$LEGS_PAR_CHILD]}"
	fi
	"$@"
}

# legs__par_dispatch <command...>: inside an open region (in the runner, outside any timing leg),
# starts the command on a free worker and succeeds; otherwise fails, and the caller runs it inline.
legs__par_dispatch() {
	[ "$LEGS_PAR_OPEN" = 1 ] || return 1
	[ -z "$LEGS_PAR_CHILD" ] || return 1
	[ -z "$LEGS_TIMING_LABEL" ] || return 1
	if [ "$(leg_env_value RS_RECEIVER_MODE || true)" = live ]; then
		# a live receiver is never a parallel unit: it runs inline, alone
		legs_par_wait
		return 1
	fi
	legs__par_free_slot
	local k="$LEGS_PAR_SLOT" label="$1"
	case "$1" in
	run_headless | run_rendered) label="$(legs__rel "$2")" ;;
	run_rendered_receiver) label="$(legs__rel "$3")" ;;
	legs_par_unit) label="$2 $(legs__rel "${3:-}")" ;;
	esac
	(legs__par_child "$k" "$@") &
	LEGS_PAR_PIDS[k]=$!
	LEGS_PAR_LABELS[k]="$label"
	echo "$LEGS_LOG: worker $k: $label"
	# the one-shot globals a launch resets after its call (the worker has its own copies)
	RENDERED_EXTRA_ARGS=()
	RECEIVER_STORE_DIR=""
	GATE7_PAGE_PORT=""
	return 0
}

legs_par_unit() {
	legs__par_dispatch legs_par_unit "$@" && return 0
	"$@"
}

# legs_par_wait: a barrier inside a region -- waits for every running worker (the region stays
# open, its compositors up). For legs that replay what earlier legs of the region wrote.
legs_par_wait() {
	[ "$LEGS_PAR_OPEN" = 1 ] || return 0
	[ -z "$LEGS_PAR_CHILD" ] || return 0
	local k
	for ((k = 0; k < LEGS_PAR_N; k++)); do
		while ! legs__par_reap "$k"; do
			sleep 0.1
		done
	done
}

legs_par_end() {
	[ "$LEGS_PAR_OPEN" = 1 ] || return 0
	legs_par_wait
	legs__par_teardown
	LEGS_PAR_OPEN=0
	echo "$LEGS_LOG: parallel region closed"
	local rc="$LEGS_PAR_RC"
	LEGS_PAR_RC=0
	return "$rc"
}

# legs__par_teardown: the extra gamescope sessions (slot 0 is the runner's own).
legs__par_teardown() {
	local k main
	main="$(legs__par_gs_save)"
	for ((k = 1; k < ${#LEGS_PAR_GS[@]}; k++)); do
		[ -n "${LEGS_PAR_GS[$k]:-}" ] || continue
		legs__par_gs_load "${LEGS_PAR_GS[$k]}"
		gs_teardown "$GS_RUN_DIR" || true
		LEGS_PAR_GS[k]=""
	done
	legs__par_gs_load "$main"
}

# legs_par_cleanup: for a runner's EXIT trap -- stops running workers (each stops its Godot child)
# and tears the extra gamescopes down. Safe to call when no region is open.
legs_par_cleanup() {
	[ -z "$LEGS_PAR_CHILD" ] || return 0
	local k pid n
	for ((k = 0; k < ${#LEGS_PAR_PIDS[@]}; k++)); do
		pid="${LEGS_PAR_PIDS[$k]:-}"
		[ -n "$pid" ] || continue
		kill -TERM "$pid" 2>/dev/null || true
		n=0
		while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 50 ]; do
			sleep 0.1
			n=$((n + 1))
		done
	done
	LEGS_PAR_PIDS=()
	[ "${#LEGS_PAR_GS[@]}" = 0 ] || legs__par_teardown
	LEGS_PAR_OPEN=0
}
