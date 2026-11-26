#!/usr/bin/env bash
# Self-test for lib/gamescope.sh's compositor lifetime contract. Needs a real gamescope and GPU, so
# it is not part of run-pure-self-tests.sh.
#
#   bash test/self-test-gamescope-owner.sh
#
# (a) a runner killed with SIGKILL (no EXIT trap runs) still takes its compositor and that
#     compositor's Xwayland down with it;
# (b) gs_start refuses a run dir that already records a live compositor, leaving that one running
#     and recorded;
# (c) the normal gs_start -> gs_teardown path still works.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$SCRIPT_DIR/lib/gamescope.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/gs-owner-test.XXXXXX")"
RUNNER_PIDS=()
fails=0

source "$LIB"

cleanup() {
	local pid dir
	for pid in "${RUNNER_PIDS[@]:-}"; do
		[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
	done
	for dir in "$TMP"/*/; do
		[ -f "$dir/gamescope.pid" ] && (gs_teardown "$dir") 2>/dev/null
	done
	rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
	echo "self-test-gamescope-owner: FAIL: $*"
	fails=$((fails + 1))
}

# Starts a runner bash that owns one compositor in $1 and then idles. Prints the runner's pid. The
# runner's stdout must not be the caller's $(...) pipe, or the substitution waits for it to exit.
start_runner() {
	local dir="$1"
	bash -c 'source "$1"; gs_start 320 180 "$2" 2>"$2.stderr"; echo ready >"$2.ready"; exec sleep 600' \
		gs-owner-runner "$LIB" "$dir" >/dev/null &
	echo $!
}

wait_file() {
	local file="$1" waited=0
	while [ ! -f "$file" ] && [ "$waited" -lt 300 ]; do
		sleep 0.1
		waited=$((waited + 1))
	done
	[ -f "$file" ]
}

# gone <pid> <ticks> [seconds]: true once that exact process has exited
gone() {
	local pid="$1" ticks="$2" limit=$((${3:-5} * 10)) waited=0
	while [ "$waited" -lt "$limit" ]; do
		[ "$(gs_proc_start_ticks "$pid" 2>/dev/null)" = "$ticks" ] || return 0
		sleep 0.1
		waited=$((waited + 1))
	done
	return 1
}

# xwayland_of <compositor sid>: pids of the Xwayland gamescope started in that session
xwayland_of() {
	ps -o pid=,comm= -s "$1" 2>/dev/null | awk '$2 == "Xwayland" {print $1}'
}

# (a) SIGKILLed runner
dir_a="$TMP/killed"
runner="$(start_runner "$dir_a")"
RUNNER_PIDS+=("$runner")
if ! wait_file "$dir_a.ready"; then
	fail "(a) runner never became ready: $(cat "$dir_a.stderr" 2>/dev/null)"
else
	pid="$(cat "$dir_a/gamescope.pid")"
	ticks="$(cat "$dir_a/gamescope.start-ticks")"
	xwl="$(xwayland_of "$pid")"
	[ -n "$xwl" ] || fail "(a) found no Xwayland in compositor session $pid"
	grep -q "\"ownerPid\": $runner," "$dir_a/gamescope.json" || fail "(a) gamescope.json does not name owner $runner"
	kill -9 "$runner"
	wait "$runner" 2>/dev/null
	if gone "$pid" "$ticks" 5; then
		for x in $xwl; do
			[ -d "/proc/$x" ] && fail "(a) Xwayland $x outlived its compositor"
		done
		echo "self-test-gamescope-owner: (a) compositor $pid exited after its runner was SIGKILLed"
	else
		fail "(a) compositor $pid survived its SIGKILLed runner $runner"
	fi
fi

# (b) second gs_start into a live run dir
dir_b="$TMP/reused"
runner="$(start_runner "$dir_b")"
RUNNER_PIDS+=("$runner")
if ! wait_file "$dir_b.ready"; then
	fail "(b) runner never became ready: $(cat "$dir_b.stderr" 2>/dev/null)"
else
	pid="$(cat "$dir_b/gamescope.pid")"
	ticks="$(cat "$dir_b/gamescope.start-ticks")"
	if (gs_start 320 180 "$dir_b") 2>"$TMP/b-second.stderr"; then
		fail "(b) a second gs_start into a live run dir succeeded"
		(gs_teardown "$dir_b") 2>/dev/null
	elif ! grep -q "already records live compositor pid $pid" "$TMP/b-second.stderr"; then
		fail "(b) unexpected refusal: $(cat "$TMP/b-second.stderr")"
	fi
	if gs_is_ours "$pid" "$ticks" && [ "$(cat "$dir_b/gamescope.pid")" = "$pid" ]; then
		echo "self-test-gamescope-owner: (b) refused to reuse a live run dir; compositor $pid kept its record"
	else
		fail "(b) the first compositor $pid lost its process or its record"
	fi
	kill -9 "$runner"
	wait "$runner" 2>/dev/null
	gone "$pid" "$ticks" 5 || fail "(b) compositor $pid survived its SIGKILLed runner"
fi

# (c) normal teardown
dir_c="$TMP/teardown"
if (gs_start 320 180 "$dir_c") 2>"$TMP/c.stderr"; then
	pid="$(cat "$dir_c/gamescope.pid")"
	ticks="$(cat "$dir_c/gamescope.start-ticks")"
	if (gs_teardown "$dir_c") 2>>"$TMP/c.stderr" && gone "$pid" "$ticks" 1 && [ ! -f "$dir_c/gamescope.pid" ]; then
		echo "self-test-gamescope-owner: (c) gs_teardown stopped compositor $pid"
	else
		fail "(c) gs_teardown left compositor $pid or its record: $(cat "$TMP/c.stderr")"
	fi
else
	fail "(c) gs_start failed: $(cat "$TMP/c.stderr")"
fi

if [ "$fails" = 0 ]; then
	echo "self-test-gamescope-owner: PASS"
else
	echo "self-test-gamescope-owner: FAIL ($fails)"
	exit 1
fi
