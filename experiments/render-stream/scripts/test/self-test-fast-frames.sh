#!/usr/bin/env bash
# GRT2b part B: lib/legs.sh's RS_FAST_FRAMES argv rewrite (legs__fast_argv), with no launches.
#
#   bash test/self-test-fast-frames.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RS_QUIET_LOCK_DIR="$TMP/lock"
mkdir -p "$RS_QUIET_LOCK_DIR"

# case <mode> <timing group> <argv...>: prints the rewritten argv on one line.
case_of() {
	local mode="$1" group="$2"
	shift 2
	RS_FAST_FRAMES="$mode" OUT="$TMP" SCRIPT_DIR="$SCRIPT_DIR" REPO_ROOT="$TMP" G="$group" bash -c '
		set -euo pipefail
		LEGS_LOG=selftest
		RECEIVER_DIR=/r
		source "$SCRIPT_DIR/lib/gamescope.sh"
		source "$SCRIPT_DIR/lib/legs.sh"
		LEGS_TIMING_GROUP="$G"
		legs__fast_argv "$@"
		echo "${LEGS_ARGV[*]}"
	' _ "$@"
}

fails=0
expect() {
	if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi
}
FAST="--fixed-fps 60 --max-fps 0 --disable-vsync"
expect "off leaves argv" "$(case_of off "" b --headless --max-fps 60 --path /f)" "b --headless --max-fps 60 --path /f"
expect "all rewrites a host" "$(case_of all "" b --headless --max-fps 60 --path /f)" "b --headless $FAST --path /f"
expect "all rewrites a receiver" "$(case_of all "" --path /r --max-fps 60)" "--path /r $FAST"
expect "host skips a receiver" "$(case_of host "" --path /r --max-fps 60)" "--path /r --max-fps 60"
expect "receiver skips a host" "$(case_of receiver "" b --max-fps 60 --path /f)" "b --max-fps 60 --path /f"
expect "other rates stay" "$(case_of all "" b --max-fps 30 --path /f)" "b --max-fps 30 --path /f"
expect "a max-fps cap scales real time without fixed-fps" \
	"$(RS_FAST_FRAMES_MAX_FPS=240 case_of all "" b --max-fps 60 --path /f)" "b --max-fps 240 --disable-vsync --path /f"
expect "a timing group stays real time" "$(case_of all g6c b --max-fps 60 --path /f)" "b --max-fps 60 --path /f"
if RS_FAST_FRAMES=bogus OUT="$TMP" SCRIPT_DIR="$SCRIPT_DIR" bash -c 'LEGS_LOG=t; source "$SCRIPT_DIR/lib/gamescope.sh"; source "$SCRIPT_DIR/lib/legs.sh"' 2>/dev/null; then
	echo "FAIL a bad mode is refused"
	fails=$((fails + 1))
else
	echo "ok   a bad mode is refused"
fi
[ "$fails" = 0 ] && echo "self-test-fast-frames: PASS" || { echo "self-test-fast-frames: FAIL ($fails)"; exit 1; }
