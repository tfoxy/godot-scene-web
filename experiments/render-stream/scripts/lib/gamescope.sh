#!/usr/bin/env bash
# Private-gamescope lifecycle for Gate -1's RENDERED legs. Sourced (not executed) by
# run-gate-minus1.sh. Modeled on ../../../../sts2-couch-coop/scripts/bring-up-gamescope-instance.sh
# and the isolated-display rules in that repo's docs/agents/qa-recipes.md section 2.x.
#
# WHY GAMESCOPE AND NOT XVFB: see qa-recipes.md section 2.x and the project memory
# `xvfb-does-not-isolate-on-wayland` -- Xvfb does not reliably isolate a headed Godot/Chromium
# process on this box, and this repo's own guard (scripts/claude-guard-bash.sh) blocks nested
# xvfb-run outright. `gamescope --backend headless` gives a real GPU-backed X11 display with no
# surface on the user's desktop. NEVER fall back to Xvfb or a desktop display from here: if
# gamescope fails to start or dies, the caller's leg fails -- there is no second path.
#
# Usage (functions only -- this file does not run anything on its own):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/gamescope.sh"
#   gs_start 640 360 "$RUN_DIR"              # sets GS_PID GS_START_TICKS GS_SID GS_DISPLAY GS_VULKAN_DEVICE
#   gs_launch_godot "$GS_DISPLAY" "$BIN" "$PROJECT_DIR" "$LOG_FILE" -- --extra --godot --args
#   GODOT_PID=$GS_LAST_GODOT_PID
#   gs_verify_display_ownership "$GS_DISPLAY" "$GS_PID" "$GS_SID" "$GODOT_PID" "$RUN_DIR/display-ownership.json"
#   gs_teardown "$RUN_DIR"
#
# Every function that can fail calls `gs_die`, which prints to stderr and `exit 1`s the CALLING
# script (this file is sourced, not subshelled, so `exit` here ends run-gate-minus1.sh itself --
# that is intentional: a dead or fake compositor must fail the leg, not be silently skipped).

set -uo pipefail

GS_PID=""
GS_START_TICKS=""
GS_SID=""
GS_DISPLAY=""
GS_VULKAN_DEVICE=""
GS_LOG=""
GS_RUN_DIR=""
GS_LAST_GODOT_PID=""

gs_die() {
	echo "gamescope.sh: $*" >&2
	exit 1
}

# field 22 of /proc/<pid>/stat: start time in clock ticks since boot. Comm can contain spaces/
# parens, which is why this parses from the LAST ')' rather than splitting on whitespace naively.
gs_proc_start_ticks() {
	local pid="$1" stat
	stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
	stat="${stat##*) }"
	echo "$stat" | awk '{print $20}'
}

# field 6 of /proc/<pid>/stat: session id (setsid's PID, for a session leader and its session).
gs_proc_sid() {
	local pid="$1" stat
	stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
	stat="${stat##*) }"
	echo "$stat" | awk '{print $4}'
}

gs_proc_cmdline() {
	local pid="$1"
	tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null
}

# True iff $1 is still a gamescope process AND (no $2 given, or its start ticks still match $2).
# Never trusts a bare PID: PIDs recycle, so identity is always PID + start-ticks together.
gs_is_ours() {
	local pid="$1" expected_ticks="${2:-}"
	[ -d "/proc/$pid" ] || return 1
	gs_proc_cmdline "$pid" | grep -q gamescope || return 1
	if [ -n "$expected_ticks" ]; then
		[ "$(gs_proc_start_ticks "$pid")" = "$expected_ticks" ] || return 1
	fi
	return 0
}

gs_require_live() {
	local pid="${1:-$GS_PID}" ticks="${2:-$GS_START_TICKS}"
	if ! gs_is_ours "$pid" "$ticks"; then
		echo "--- gamescope log ($GS_LOG) ---" >&2
		tail -n 100 "$GS_LOG" >&2 2>/dev/null || true
		gs_die "private compositor pid $pid (start ticks $ticks) is gone or was replaced"
	fi
}

# Starts `gamescope --backend headless`, private session, no desktop display inherited. Blocks
# until the compositor's own XWayland announces a DISPLAY (never a fixed sleep-and-hope). Sets the
# GS_* globals and writes run_dir/gamescope.json. Dies (never falls back) if gamescope does not
# produce a display within the timeout, or exits before doing so.
gs_start() {
	local width="$1" height="$2" run_dir="$3"
	mkdir -p "$run_dir"
	GS_RUN_DIR="$run_dir"
	GS_LOG="$run_dir/gamescope.log"

	command -v gamescope >/dev/null 2>&1 || gs_die "gamescope is not installed"

	# THE WAYLAND TRAP (same one qa-recipes.md and bring-up-gamescope-instance.sh document): with
	# an inherited WAYLAND_DISPLAY, a client's display auto-detection can sail past this private
	# display onto the real desktop compositor. -u strips both before gamescope even forks; the
	# launched godot process (gs_launch_godot) strips them again on top of that, belt and braces.
	#
	# gamescope 3.16 segfaults in its own exit path after SIGTERM (right after "Primary child shut
	# down!"); harmless, so the subshell only stops it writing a core file each run. `exec` keeps
	# $! the compositor's own pid.
	(
		ulimit -c 0
		exec env -u DISPLAY -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 \
			setsid gamescope --backend headless -W "$width" -H "$height" -w "$width" -h "$height" \
			-- sh -c 'echo "GAMESCOPE_CHILD_DISPLAY=$DISPLAY"; sleep infinity'
	) >"$GS_LOG" 2>&1 &
	GS_PID=$!
	echo "$GS_PID" >"$run_dir/gamescope.pid"

	local waited=0
	while [ "$waited" -lt 200 ]; do
		GS_DISPLAY="$(grep -oE 'GAMESCOPE_CHILD_DISPLAY=:[0-9]+' "$GS_LOG" 2>/dev/null | head -1 | cut -d= -f2 || true)"
		[ -n "$GS_DISPLAY" ] && break
		if [ ! -d "/proc/$GS_PID" ]; then
			echo "--- gamescope log ---" >&2
			cat "$GS_LOG" >&2 2>/dev/null || true
			gs_die "gamescope exited before it produced a display"
		fi
		sleep 0.1
		waited=$((waited + 1))
	done
	[ -n "$GS_DISPLAY" ] || { cat "$GS_LOG" >&2 2>/dev/null || true; gs_die "gamescope produced no XWayland display within 20s"; }

	GS_START_TICKS="$(gs_proc_start_ticks "$GS_PID")"
	[ -n "$GS_START_TICKS" ] || gs_die "gamescope exited before its process identity could be recorded"
	GS_SID="$(gs_proc_sid "$GS_PID")"
	echo "$GS_START_TICKS" >"$run_dir/gamescope.start-ticks"

	# Positive GPU evidence, not assumed hardware: gamescope logs which Vulkan device it bound.
	GS_VULKAN_DEVICE="$(grep -oE "selecting physical device '[^']+'" "$GS_LOG" | head -1 | sed "s/.*'\\(.*\\)'/\\1/" || true)"

	cat >"$run_dir/gamescope.json" <<JSON
{
  "schema": "render-stream-gamescope-bringup/1",
  "pid": $GS_PID,
  "startTicks": "$GS_START_TICKS",
  "sid": "$GS_SID",
  "display": "$GS_DISPLAY",
  "vulkanDevice": $([ -n "$GS_VULKAN_DEVICE" ] && echo "\"$GS_VULKAN_DEVICE\"" || echo null),
  "width": $width,
  "height": $height,
  "backend": "headless",
  "log": "$GS_LOG"
}
JSON
	echo "gamescope.sh: compositor pid $GS_PID ready on DISPLAY=$GS_DISPLAY (GPU: ${GS_VULKAN_DEVICE:-UNKNOWN})" >&2
}

# Launches godot against the private display: strips WAYLAND_DISPLAY (the same trap as gs_start),
# forces the x11 driver, and backgrounds it with stdout/stderr to $log_file. Sets GS_LAST_GODOT_PID.
# Does NOT wait for godot to do anything -- callers decide what readiness means for their leg.
#
# Every inherited capture, fixture and receiver variable is stripped too (gs_strip_env_args); the
# caller passes the ones a leg wants through GS_GODOT_ENV (an array of NAME=value words).
GS_GODOT_ENV=()

# The variables a launcher must never inherit (gate0-design.md "Environment"): gate -1's GRC_*
# five plus its two spike screenshot variables, gate 0's stream and sabotage variables, and the
# documented RS_* fixture/receiver variables. gs_strip_env_args adds every other inherited RS_* on
# top, so a future fixture variable cannot leak in from the caller's shell either.
GS_STRIP_VARS=(
	GRC_EXTENSION GRC_MODE GRC_EVIDENCE_DIR GRC_CALIBRATION GRC_DISARM_AFTER_FRAMES
	GRC_SCREENSHOT GRC_SCREENSHOT_FRAME
	GRC_STREAM_OUT GRC_SABOTAGE GRC_SABOTAGE_FRAME
	RS_FIXTURE_STEP_LOG RS_FIXTURE_SHOT_DIR RS_FIXTURE_VARIANT RS_FIXTURE_QUIT_FRAME
	RS_RECEIVER_RECORDING RS_RECEIVER_OUT RS_RECEIVER_SHOT_SEQS RS_SELFTEST_GOLDEN_DIR
	# gate 1 (protocol/gate1-design.md): every variable it introduces, landed or not
	GRC_ROOT_SIZE GRC_STREAM_PATCH_OUT GRC_SABOTAGE_OP
	GRC_LIVE_LISTEN GRC_LIVE_TAP_DIR GRC_LIVE_MAX_MESSAGE_BYTES GRC_LIVE_HELLO_TIMEOUT_MS
	RS_FIXTURE_ROOT_LOG RS_FIXTURE_START_FRAME RS_FIXTURE_STEP_FRAMES RS_FIXTURE_SHOT_FRAMES RS_FIXTURE_TIE
	RS_RECEIVER_MODE RS_RECEIVER_STATE_SEQS RS_RECEIVER_URL RS_RECEIVER_SHOT_WINDOWS
	RS_RECEIVER_RECEIVED_OUT RS_RECEIVER_INBOUND_BYTES RS_RECEIVER_CREDIT_STAGE
	RS_RECEIVER_CONNECT_TIMEOUT RS_RECEIVER_STALL RS_RECEIVER_RECONNECT RS_RECEIVER_RESYNC
	# gate 2 (protocol/gate2-design.md): every variable it introduces, landed or not
	GRC_RESOURCE_FORMATS GRC_RESOURCE_MAX_PAYLOAD_BYTES GRC_RESOURCE_STORE_DIR
	GRC_RESOURCE_INLINE_MAX_BYTES GRC_RESOURCE_BUDGET_BYTES GRC_LIVE_AUTH
	RS_FIXTURE_TEXTURE_LOG
	RS_RECEIVER_CACHE_DIR RS_RECEIVER_CACHE_MODE RS_RECEIVER_STORE_DIR RS_RECEIVER_FETCH_TIMEOUT_MS
	RS_RECEIVER_FETCH_DELAY_MS RS_RECEIVER_SABOTAGE RS_RECEIVER_TOKEN_FILE
	# gate 4 (protocol/gate4-design.md Q7): the glyph oracle and the fixture environment log
	RS_FIXTURE_GLYPH_LOG RS_FIXTURE_ENV_LOG
	# gate 5 (protocol/gate5-design.md Q7): the mesh oracle
	RS_FIXTURE_MESH_LOG
)

# Sets GS_STRIP_ARGS to `-u NAME` words for `env`: GS_STRIP_VARS plus every inherited GRC_* and
# RS_*.
GS_STRIP_ARGS=()
gs_strip_env_args() {
	GS_STRIP_ARGS=()
	local name
	for name in "${GS_STRIP_VARS[@]}"; do
		GS_STRIP_ARGS+=(-u "$name")
	done
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		case " ${GS_STRIP_VARS[*]} " in
		*" $name "*) ;;
		*) GS_STRIP_ARGS+=(-u "$name") ;;
		esac
	done < <(compgen -e | grep -E '^(RS|GRC)_' || true)
}

gs_launch_godot() {
	local display="$1" binary="$2" project_dir="$3" log_file="$4"
	shift 4
	gs_require_live
	gs_strip_env_args
	env -u WAYLAND_DISPLAY "${GS_STRIP_ARGS[@]}" \
		XDG_SESSION_TYPE=x11 DISPLAY="$display" "${GS_GODOT_ENV[@]}" \
		"$binary" --path "$project_dir" --rendering-driver opengl3 --display-driver x11 "$@" \
		>"$log_file" 2>&1 &
	GS_LAST_GODOT_PID=$!
}

# Finds every pid holding an fd for socket inode $1, by walking /proc/*/fd once. Best-effort: a
# process that exits mid-scan, or one this user can't read, is silently skipped (never fatal --
# the caller decides whether an empty result is a problem).
gs_socket_owners() {
	local inode="$1" pid link owners=()
	for pid_dir in /proc/[0-9]*; do
		pid="${pid_dir#/proc/}"
		[ -d "$pid_dir/fd" ] || continue
		for fd in "$pid_dir"/fd/*; do
			link="$(readlink "$fd" 2>/dev/null)" || continue
			if [ "$link" = "socket:[$inode]" ]; then
				owners+=("$pid")
				break
			fi
		done
	done
	printf '%s\n' "${owners[@]:-}"
}

# Listening-socket row(s) in /proc/net/unix for X11 socket path $1 (plain or '@'-abstract),
# printed as "<inode> <flags-hex>". Columns per `man 5 proc` / net/unix: Num RefCount Protocol
# Flags Type St Inode Path (Flags bit 0x10000 = SO_ACCEPTCON i.e. listening; St "01" = listening).
gs_unix_listeners() {
	local path="$1"
	awk -v p="$path" -v p2="@$path" '
		NR>1 {
			flags=strtonum("0x" $4)
			if ($6 == "01" && (flags % 131072) >= 65536 && ($8 == p || $8 == p2)) print $7, $4
		}
	' /proc/net/unix
}

# Proves the godot process's display connection belongs to OUR compositor session, not some other
# X server on the box (this box already has at least one real desktop X server running). Two
# checks, both required, mirroring qa-recipes.md 2.x ("environment values alone are insufficient
# proof; inspect the server/socket ownership or its client/window tree"):
#
#   1. Environment: godot's own DISPLAY equals $display and it inherited no WAYLAND_DISPLAY.
#   2. Socket ownership: every pid holding the LISTENING socket for that display number is either
#      the compositor pid itself, or shares the compositor's session id ($compositor_sid). SID
#      rather than parent/child: gamescope's XWayland is started detached and gets reparented to
#      the box's subreaper (ppid changes), but a process never changes its session id just by
#      being reparented, and the whole gamescope invocation runs under its own `setsid`, so SID ==
#      the compositor's own pid for everything gamescope started. ss -xp (when available) adds a
#      direct peer-correlated evidence line for the godot pid, on top of the inode-ownership proof.
#
# Writes a JSON evidence file to $5 regardless of outcome and returns 0 only if both checks pass.
gs_verify_display_ownership() {
	local display="$1" compositor_pid="$2" compositor_sid="$3" godot_pid="$4" out_json="$5"
	local problems=() ok=1

	local godot_display godot_wayland
	godot_display="$(tr '\0' '\n' <"/proc/$godot_pid/environ" 2>/dev/null | awk -F= '$1=="DISPLAY"{print substr($0,index($0,"=")+1)}')"
	godot_wayland="$(tr '\0' '\n' <"/proc/$godot_pid/environ" 2>/dev/null | awk -F= '$1=="WAYLAND_DISPLAY"{print "set"}')"
	if [ "$godot_display" != "$display" ]; then
		problems+=("godot DISPLAY env is '$godot_display', expected '$display'")
		ok=0
	fi
	if [ "$godot_wayland" = "set" ]; then
		problems+=("godot inherited WAYLAND_DISPLAY (a desktop route)")
		ok=0
	fi

	local number socket_path listeners owner_pids=() foreign=() mine=()
	number="$(echo "$display" | sed -nE 's/^:([0-9]+)(\.[0-9]+)?$/\1/p')"
	socket_path="/tmp/.X11-unix/X${number}"
	listeners="$(gs_unix_listeners "$socket_path")"
	if [ -z "$listeners" ]; then
		problems+=("no X server is listening on $socket_path")
		ok=0
	else
		while read -r inode _flags; do
			[ -n "$inode" ] || continue
			while read -r owner_pid; do
				[ -n "$owner_pid" ] || continue
				owner_pids+=("$owner_pid")
				local owner_sid
				owner_sid="$(gs_proc_sid "$owner_pid" 2>/dev/null || true)"
				if [ "$owner_pid" = "$compositor_pid" ] || [ "$owner_sid" = "$compositor_sid" ]; then
					mine+=("$owner_pid")
				else
					foreign+=("$owner_pid")
				fi
			done < <(gs_socket_owners "$inode")
		done <<<"$listeners"
		if [ "${#mine[@]}" -eq 0 ]; then
			problems+=("$socket_path is listened on, but no holder shares the compositor's session $compositor_sid (holders: ${owner_pids[*]:-none})")
			ok=0
		fi
		if [ "${#foreign[@]}" -gt 0 ]; then
			problems+=("$socket_path also has holder(s) outside the compositor session: ${foreign[*]}")
			ok=0
		fi
	fi

	# Best-effort direct peer evidence; absence of `ss` or of a matching line does not fail the
	# check on its own -- the inode-ownership proof above is the load-bearing one.
	local ss_evidence="null"
	if command -v ss >/dev/null 2>&1; then
		local ss_lines
		ss_lines="$(ss -xp 2>/dev/null | grep -F "pid=$godot_pid," || true)"
		if [ -n "$ss_lines" ]; then
			ss_evidence="$(printf '%s' "$ss_lines" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))' 2>/dev/null || echo "[]")"
		else
			ss_evidence="[]"
		fi
	fi

	local problems_json="[]"
	if [ "${#problems[@]}" -gt 0 ]; then
		problems_json="$(printf '%s\n' "${problems[@]}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))')"
	fi
	local mine_json="[]" foreign_json="[]"
	[ "${#mine[@]}" -gt 0 ] && mine_json="$(printf '%s\n' "${mine[@]}" | sort -un | python3 -c 'import json,sys; print(json.dumps([int(x) for x in sys.stdin.read().split()]))')"
	[ "${#foreign[@]}" -gt 0 ] && foreign_json="$(printf '%s\n' "${foreign[@]}" | sort -un | python3 -c 'import json,sys; print(json.dumps([int(x) for x in sys.stdin.read().split()]))')"

	cat >"$out_json" <<JSON
{
  "schema": "render-stream-gamescope-display-ownership/1",
  "display": "$display",
  "socketPath": "$socket_path",
  "compositorPid": $compositor_pid,
  "compositorSid": "$compositor_sid",
  "godotPid": $godot_pid,
  "godotDisplayEnv": "$godot_display",
  "godotHasWaylandDisplay": $([ "$godot_wayland" = "set" ] && echo true || echo false),
  "listenerOwnersOurs": $mine_json,
  "listenerOwnersForeign": $foreign_json,
  "ssPeerEvidenceForGodotPid": $ss_evidence,
  "ok": $([ "$ok" = "1" ] && echo true || echo false),
  "problems": $problems_json
}
JSON
	[ "$ok" = "1" ]
}

# Kills ONLY the pid this script recorded, after re-verifying it is still that exact process
# (pid + start ticks) -- never a pkill pattern (project convention: see
# bring-up-gamescope-instance.sh's own comment on this). Waits for it to actually exit.
gs_teardown() {
	local run_dir="${1:-$GS_RUN_DIR}"
	local pidfile="$run_dir/gamescope.pid" ticksfile="$run_dir/gamescope.start-ticks"
	[ -f "$pidfile" ] || return 0
	local pid ticks
	pid="$(cat "$pidfile")"
	ticks="$(cat "$ticksfile" 2>/dev/null || true)"
	if gs_is_ours "$pid" "$ticks"; then
		kill "$pid" 2>/dev/null || true
		local waited=0
		while [ "$waited" -lt 100 ]; do
			gs_is_ours "$pid" "$ticks" || break
			sleep 0.1
			waited=$((waited + 1))
		done
		if gs_is_ours "$pid" "$ticks"; then
			kill -9 "$pid" 2>/dev/null || true
			sleep 0.2
			gs_is_ours "$pid" "$ticks" && gs_die "gamescope pid $pid survived teardown (SIGKILL included)"
		fi
	fi
	rm -f "$pidfile" "$ticksfile"
	echo "gamescope.sh: torn down compositor (was pid ${pid:-?})" >&2
}
