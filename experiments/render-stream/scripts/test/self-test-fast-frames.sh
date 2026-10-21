#!/usr/bin/env bash
# GRT2b part B / GRT3: lib/legs.sh's fast frames with no launches -- the RS_FAST_FRAMES argv
# rewrite (legs__fast_argv), the fast host words it adds to LEG_ENV, the allowlist and denylist
# (legs_fast_applies), and the frames -> milliseconds conversion of stalls and the fetch delay
# (legs_frames_ms, legs_stall_spec).
#
#   bash test/self-test-fast-frames.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RS_QUIET_LOCK_DIR="$TMP/lock"
mkdir -p "$RS_QUIET_LOCK_DIR"

# in_legs <mode> <runner> <timing group> <timing label> <bash...>: runs bash code with legs.sh
# sourced as <runner> (LEGS_LOG), OUT=$TMP and RECEIVER_DIR=/r.
in_legs() {
	local mode="$1" runner="$2" group="$3" label="$4"
	shift 4
	RS_FAST_FRAMES="$mode" OUT="$TMP" SCRIPT_DIR="$SCRIPT_DIR" REPO_ROOT="$TMP" R="$runner" G="$group" \
		L="$label" CODE="$1" bash -c '
		set -euo pipefail
		LEGS_LOG="$R"
		RECEIVER_DIR=/r
		source "$SCRIPT_DIR/lib/gamescope.sh"
		source "$SCRIPT_DIR/lib/legs.sh"
		LEGS_TIMING_GROUP="$G"
		LEGS_TIMING_LABEL="$L"
		eval "$CODE"
	'
}

# case_of <mode> <runner> <leg dir under OUT> <timing group> <argv...>: the rewritten argv, then
# " | " and the LEG_ENV words it added, on one line.
case_of() {
	local mode="$1" runner="$2" leg="$3" group="$4"
	shift 4
	local q
	q="$(printf '%q ' "$@")"
	in_legs "$mode" "$runner" "$group" "" "LEG_ENV=(\${LEG_ENV_IN:-}); [ -z \"\${KIND_IN:-}\" ] || GATE7_LIVE_KIND=\$KIND_IN; LEGS_FAST_DIR=\"\$OUT/$leg\"; legs__fast_argv $q; echo \"\${LEGS_ARGV[*]} | \${LEG_ENV[*]}\""
}

fails=0
expect() {
	if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi
}
HOST_ENV="GRC_LOW_PROCESSOR_SLEEP_USEC=0"
expect "off leaves argv" "$(case_of off run-gate1 live/host "" b --headless --max-fps 60 --path /f)" \
	"b --headless --max-fps 60 --path /f | "
expect "all rewrites an allowlisted host (default 240) and adds the host words" \
	"$(case_of all run-gate1 live/host "" b --headless --max-fps 60 --path /f)" \
	"b --headless --max-fps 240 --disable-vsync --path /f | $HOST_ENV"
expect "a live host also holds for the first hello" \
	"$(LEG_ENV_IN=GRC_LIVE_LISTEN=127.0.0.1:0 case_of all run-gate1 live/host "" b --max-fps 60 --path /f)" \
	"b --max-fps 240 --disable-vsync --path /f | GRC_LIVE_LISTEN=127.0.0.1:0 $HOST_ENV GRC_LIVE_AWAIT_HELLO_MS=60000"
expect "all rewrites an allowlisted receiver, no host words" \
	"$(case_of all run-gate1 live/receiver "" --path /r --max-fps 60)" "--path /r --max-fps 240 --disable-vsync | "
expect "a browser receiver gets --max-fps alone" \
	"$(KIND_IN=gsw case_of all run-gate1 live/receiver "" --path /r --max-fps 60)" "--path /r --max-fps 240 | "
expect "RS_FAST_FRAMES_MAX_FPS sets the rate" \
	"$(RS_FAST_FRAMES_MAX_FPS=120 case_of all run-gate1 live/host "" b --max-fps 60 --path /f)" \
	"b --max-fps 120 --disable-vsync --path /f | $HOST_ENV"
expect "host skips a receiver" "$(case_of host run-gate1 live/receiver "" --path /r --max-fps 60)" "--path /r --max-fps 60 | "
expect "receiver skips a host" "$(case_of receiver run-gate1 live/host "" b --max-fps 60 --path /f)" "b --max-fps 60 --path /f | "
expect "other rates stay" "$(case_of all run-gate1 live/host "" b --max-fps 30 --path /f)" "b --max-fps 30 --path /f | "
expect "a glob entry (g5f)" "$(case_of all run-gate5 mesh/live-mesh-stall/receiver g5f --path /r --max-fps 60)" \
	"--path /r --max-fps 240 --disable-vsync | "
# The denylist.
expect "a denied leg (live-rate-30) stays" "$(case_of all run-gate1 live-rate-30/host "" b --max-fps 60 --path /f)" \
	"b --max-fps 60 --path /f | "
expect "a denied timing group (g1c-rate) stays" "$(case_of all run-gate1 live/host g1c-rate b --max-fps 60 --path /f)" \
	"b --max-fps 60 --path /f | "
expect "a denied timing group (g6c) stays" "$(case_of all run-gate6 rates/host g6c b --max-fps 60 --path /f)" "b --max-fps 60 --path /f | "
expect "a gate 6 leg stays even outside a group" "$(case_of all run-gate6 live/host "" b --max-fps 60 --path /f)" \
	"b --max-fps 60 --path /f | "
expect "an unlisted leg stays" "$(case_of all run-gate3 live/host "" b --max-fps 60 --path /f)" "b --max-fps 60 --path /f | "
expect "a g2e refusal leg stays" "$(case_of all run-gate2 sabotage-no-token/host "" b --max-fps 60 --path /f)" \
	"b --max-fps 60 --path /f | "
expect "an allowed timing group (g1d) runs fast" \
	"$(case_of all run-gate1 live-stall/host g1d b --max-fps 60 --path /f)" "b --max-fps 240 --disable-vsync --path /f | $HOST_ENV"
applies() { in_legs all "$1" "$2" "$3" "legs_fast_applies \"\$OUT/$4\" && echo yes || echo no"; }
expect "a timing_leg label stays real time" "$(applies run-gate1 "" g6s:reference-step11 live/host)" no
expect "gate 7's live-leg label runs fast" "$(applies run-gate1 "" gate7-live:live live/host)" yes
# Frames -> milliseconds at the host's own rate: exactly the old milliseconds at 60 fps.
ms() { in_legs "$1" "$2" "$3" "" "legs_frames_ms \"\$OUT/$4\" $5"; }
expect "120 frames at real time = 2000 ms" "$(ms off run-gate1 g1d live-stall/host 120)" 2000
expect "78 frames at real time = 1300 ms" "$(ms off run-gate2 "" live-stall/host 78)" 1300
expect "30 frames at real time = 500 ms" "$(ms off run-gate1 g1d sabotage-ignore-credit/host 30)" 500
expect "6 frames at real time = 100 ms" "$(ms off run-gate2 g2c-pins live-animate/host 6)" 100
expect "120 frames at 240 = 500 ms" "$(ms all run-gate1 g1d live-stall/host 120)" 500
expect "78 frames at 240 = 325 ms" "$(ms all run-gate2 "" live-stall/host 78)" 325
expect "6 frames at 240 = 25 ms" "$(ms all run-gate2 g2c-pins live-animate/host 6)" 25
expect "receiver-only fast keeps the host's 60 fps" "$(ms receiver run-gate1 g1d live-stall/host 120)" 2000
expect "a denied leg keeps 60 fps" "$(ms all run-gate6 g6l live-stall/host 120)" 2000
expect "78 frames at 145 rounds (538 ms)" \
	"$(RS_FAST_FRAMES_MAX_FPS=145 ms all run-gate2 "" live-stall/host 78)" 538
expect "legs_stall_spec" "$(in_legs all run-gate5 g5f "" 'legs_stall_spec "$OUT/mesh/live-mesh-stall/host" 1 120')" "1:500"
refused() {
	if env "$@" OUT="$TMP" SCRIPT_DIR="$SCRIPT_DIR" bash -c 'LEGS_LOG=t; source "$SCRIPT_DIR/lib/gamescope.sh"; source "$SCRIPT_DIR/lib/legs.sh"' 2>/dev/null; then
		echo no
	else
		echo yes
	fi
}
expect "a bad mode is refused" "$(refused RS_FAST_FRAMES=bogus)" yes
expect "unbounded (0) is refused" "$(refused RS_FAST_FRAMES=all RS_FAST_FRAMES_MAX_FPS=0)" yes
expect "60 is refused (not fast)" "$(refused RS_FAST_FRAMES=all RS_FAST_FRAMES_MAX_FPS=60)" yes
expect "a stale rate is ignored while off" "$(refused RS_FAST_FRAMES_MAX_FPS=0)" no
[ "$fails" = 0 ] && echo "self-test-fast-frames: PASS" || {
	echo "self-test-fast-frames: FAIL ($fails)"
	exit 1
}
