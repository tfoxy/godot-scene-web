#!/usr/bin/env bash
# G7xn (protocol/gate7-design.md "G7xn", D34): re-runs every FILE-mode native receiver leg of a
# finished gate run under another receiver core, against the SAME source (the run's own
# recordings, stores and libraries), so the two cores' legs compare byte for byte
# (scripts/compare-receiver-cores.ts). Live legs need their host and are not replayed: they run
# under the other core in a whole runner invocation instead (RS_RECEIVER_CORE=rust run-gateN.sh).
#
#   bash replay-receiver-legs.sh --run <gate run dir> --out <dir> [--core rust] \
#     [--binary <template>] [--core-ext <rs_core.gdextension>]
#
# A leg is a directory with argv.txt, env.txt and applied.json whose argv runs a project at
# `--path <...>/receiver` (no --import, no --script) and whose env has no RS_RECEIVER_MODE=live.
# Legs replay in their original order (env.txt mtime), each into <out>/<same relative path>,
# with the leg's own argv (the receiver project replaced by this checkout's) and env, except:
#   - RS_RECEIVER_OUT, _CACHE_DIR, _PERF_OUT, _RECEIVED_OUT and _RECORDING move from the run into
#     <out> (the recording is copied there first), so a warm-cache leg finds the cache its cold
#     leg filled in <out> (a warm cache the runner seeded itself, none filled in <out>, is
#     copied from the run's own: a warm leg reads its cache and never adds to it);
#   - RS_RECEIVER_CORE (and RS_RECEIVER_CORE_EXT) select the core;
#   - a rendered leg runs in a private `gamescope --backend headless` of the size its original
#     compositor had (its display-ownership.json names that compositor's pid). NEVER Xvfb.
# Stores, shader libraries and every other input stay where the run left them (read only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

RUN=""
OUT=""
CORE="rust"
CORE_EXT=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
HEADLESS_TIMEOUT_S=300
RENDERED_TIMEOUT_S=300
HAVE_STRACE=0

while [ $# -gt 0 ]; do
	case "$1" in
	--run) RUN="$(realpath "${2:-}")"; shift 2 ;;
	--out) OUT="${2:-}"; shift 2 ;;
	--core) CORE="${2:-}"; shift 2 ;;
	--core-ext) CORE_EXT="${2:-}"; shift 2 ;;
	--binary) BINARY="${2:-}"; shift 2 ;;
	--) shift ;;
	*) echo "replay-receiver-legs: unknown argument: $1" >&2; exit 2 ;;
	esac
done
if [ -z "$RUN" ] || [ ! -d "$RUN" ] || [ -z "$OUT" ]; then
	echo "usage: replay-receiver-legs.sh --run <gate run dir> --out <dir> [--core rust|gdscript] [--binary <template>] [--core-ext <path>]" >&2
	exit 2
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
if [ -n "$(ls -A "$OUT")" ]; then
	echo "replay-receiver-legs: $OUT is not empty" >&2
	exit 2
fi

LEGS_LOG="replay-receiver-legs"
# The runner's core selection does not apply here: this script sets RS_RECEIVER_CORE per leg.
RS_RECEIVER_CORE=gdscript
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

cleanup() {
	if [ -n "$CURRENT_CHILD_PID" ]; then
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "$GS_PID" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# The legs, in their original order.
mapfile -t LEGS < <(
	find "$RUN" -name env.txt -printf '%T@ %h\n' | sort -n | while read -r _ dir; do
		[ -f "$dir/argv.txt" ] && [ -f "$dir/applied.json" ] || continue
		grep -q '^RS_RECEIVER_MODE=live$' "$dir/env.txt" && continue
		grep -qx -- '--import' "$dir/argv.txt" && continue
		grep -qx -- '--script' "$dir/argv.txt" && continue
		awk 'prev == "--path" && $0 ~ /\/receiver$/ { found = 1 } { prev = $0 } END { exit !found }' "$dir/argv.txt" || continue
		echo "$dir"
	done
)
echo "replay-receiver-legs: ${#LEGS[@]} file-mode receiver legs in $RUN, core $CORE"

GS_SIZE=""
compositor_size() {
	local dir="$1" pid
	pid="$(jq -r '.compositorPid // empty' "$dir/display-ownership.json" 2>/dev/null || true)"
	if [ -n "$pid" ]; then
		find "$RUN" -name gamescope.json -exec jq -r --argjson pid "$pid" \
			'select(.pid == $pid) | "\(.width) \(.height)"' {} + 2>/dev/null | head -1
	fi
}

# The extra godot args of a rendered leg: argv after `--display-driver x11`.
rendered_extra() {
	awk 'done { print } prev == "--display-driver" && $0 == "x11" { done = 1 } { prev = $0 }' "$1/argv.txt"
}

replayed=0
for src in "${LEGS[@]}"; do
	rel="${src#"$RUN"/}"
	dst="$OUT/$rel"
	mkdir -p "$dst"
	LEG_ENV=()
	cache_src=""
	cache_dst=""
	cache_mode=""
	while IFS= read -r line; do
		case "$line" in
		'#'* | '' | DISPLAY=*) continue ;;
		esac
		name="${line%%=*}"
		value="${line#*=}"
		case "$name" in
		RS_RECEIVER_OUT | RS_RECEIVER_PERF_OUT | RS_RECEIVER_RECEIVED_OUT)
			value="${value/#"$RUN"/"$OUT"}"
			;;
		RS_RECEIVER_CACHE_DIR)
			cache_src="$value"
			value="${value/#"$RUN"/"$OUT"}"
			cache_dst="$value"
			;;
		RS_RECEIVER_CACHE_MODE) cache_mode="$value" ;;
		RS_RECEIVER_RECORDING)
			moved="${value/#"$RUN"/"$OUT"}"
			mkdir -p "$(dirname "$moved")"
			[ -f "$moved" ] || cp "$value" "$moved"
			value="$moved"
			;;
		RS_RECEIVER_CORE | RS_RECEIVER_CORE_EXT) continue ;;
		esac
		LEG_ENV+=("$name=$value")
	done <"$src/env.txt"
	# A warm leg whose cache no earlier replayed leg filled used one the runner seeded itself (gate
	# 2's ignore-cache sabotage copies receiver-cold's cache): seed it from the run's copy, which
	# a warm leg reads and never adds to.
	if [ "$cache_mode" = warm ] && [ -n "$cache_dst" ] && [ ! -e "$cache_dst" ] && [ -d "$cache_src" ]; then
		mkdir -p "$(dirname "$cache_dst")"
		cp -a "$cache_src" "$cache_dst"
		echo "replay-receiver-legs: $rel: seeded warm cache from the run's $cache_src"
	fi
	LEG_ENV+=(RS_RECEIVER_CORE="$CORE")
	[ -n "$CORE_EXT" ] && LEG_ENV+=(RS_RECEIVER_CORE_EXT="$CORE_EXT")
	if grep -qx -- '--headless' "$src/argv.txt"; then
		mapfile -t argv <"$src/argv.txt"
		for i in "${!argv[@]}"; do
			if [ "$i" -gt 0 ] && [ "${argv[$((i - 1))]}" = "--path" ]; then
				argv[i]="$RECEIVER_DIR"
			fi
		done
		run_headless "$dst" none -- "${argv[@]}"
	else
		size="$(compositor_size "$src")"
		[ -n "$size" ] || size="640 360"
		if [ "$size" != "$GS_SIZE" ]; then
			if [ -n "$GS_PID" ]; then
				gs_teardown "$GS_RUN_DIR"
				GS_PID=""
			fi
			# shellcheck disable=SC2086 # "<width> <height>"
			gs_start $size "$OUT/gamescope-${size/ /x}"
			GS_SIZE="$size"
		fi
		mapfile -t RENDERED_EXTRA_ARGS < <(rendered_extra "$src")
		run_rendered "$dst" "$RECEIVER_DIR"
	fi
	replayed=$((replayed + 1))
done
echo "replay-receiver-legs: replayed $replayed legs into $OUT"
