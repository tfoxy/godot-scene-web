#!/usr/bin/env bash
# Capture cost at a game's scale (P3-CAP, results/p3/p3-cap.md): runs fixtures/capture-scale on the
# stock release template, headless at --max-fps 60, once unarmed (no extension) and once armed, and
# compares the armed host with the unarmed one.
#
#   bash experiments/render-stream/scripts/bench-capture-scale.sh --extension EXT [--out DIR]
#     [--mode file|live] [--frames N] [--binary PATH] [--calibration PATH]
#     [--budget-callback-ms MS] [--min-fps-ratio R] [--perf] [-- NAME=value ...]
#
# Armed config (the C3 game leg's, protocol/gate8-product-handoff.md): GRC_STREAM_VERSION=8,
# GRC_ADOPT=arm, GRC_UNKNOWN_ITEM=skip, GRC_TEXTURE_DECODE=engine, GRC_TEXTURE_WORKERS=2,
# GRC_ROOT_SIZE=presentation:1920x1080, raised caps and budget, an evidence directory, and either
# a patch file sink plus a resource store (--mode file, the default) or a live listener with no
# subscriber (--mode live). NAME=value words after `--` go to both legs (fixture knobs RS_SCALE_*,
# fixtures/capture-scale/scale.gd, or GRC_* overrides such as GRC_FILE_WRITER=sync).
#
# Each leg is one timing leg: it holds the machine-wide quiet lock EXCLUSIVE (lib/quiet.sh) and runs
# in real time, so its numbers are rate numbers. Writes <out>/{unarmed,armed}/ (stdout, perf.json,
# /proc samples, the fixture's frame-time report), <out>/bench-capture-scale.json (both legs'
# summaries) and <out>/result.json (one check per verdict, read by lib/tier-verdict.py):
#   armed-fps        armed fps >= --min-fps-ratio (default 0.95) x unarmed fps
#   callback-p50     perf.json frame_callback_us p50 <= --budget-callback-ms (default 8)
# Exits 1 when a check fails. --perf wraps the armed leg in `perf record -g` (perf.data in its dir;
# its numbers are then not rate numbers). The recording, store and resources.jsonl are deleted after
# the summary unless RS_BENCH_KEEP=1.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE="$EXPERIMENT_DIR/fixtures/capture-scale"

EXTENSION="" OUT="" MODE="file" FRAMES=600 PERF=0
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
BUDGET_MS=8 MIN_RATIO=0.95 PORT="${RS_BENCH_PORT:-13793}"
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
	--extension) EXTENSION="$2" && shift 2 ;;
	--out) OUT="$2" && shift 2 ;;
	--mode) MODE="$2" && shift 2 ;;
	--frames) FRAMES="$2" && shift 2 ;;
	--binary) BINARY="$2" && shift 2 ;;
	--calibration) CALIBRATION="$2" && shift 2 ;;
	--budget-callback-ms) BUDGET_MS="$2" && shift 2 ;;
	--min-fps-ratio) MIN_RATIO="$2" && shift 2 ;;
	--perf) PERF=1 && shift ;;
	-h | --help) sed -n 2,26p "${BASH_SOURCE[0]}" && exit 0 ;;
	--) shift && EXTRA=("$@") && break ;;
	*) echo "bench-capture-scale: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] || { echo "bench-capture-scale: pass --extension /abs/path/render_stream_capture.gdextension" >&2; exit 2; }
[ -x "$BINARY" ] || { echo "bench-capture-scale: no template at $BINARY" >&2; exit 2; }
[ -f "$CALIBRATION" ] || { echo "bench-capture-scale: no calibration at $CALIBRATION" >&2; exit 2; }
case "$MODE" in file | live) ;; *) echo "bench-capture-scale: --mode file|live" >&2 && exit 2 ;; esac
EXTENSION="$(realpath "$EXTENSION")"
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/bench-capture-scale/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"

# leg <name> <armed 0|1>: one real-time run of the fixture under the exclusive quiet lock.
leg() {
	local name="$1" armed="$2" dir="$OUT/$1"
	rm -rf "$dir" && mkdir -p "$dir/evidence"
	local -a env=(HOME="$HOME" PATH="$PATH" RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME="$FRAMES"
		RS_SCALE_REPORT="$dir/scale-report.json")
	if [ "$armed" = 1 ]; then
		env+=(GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_VERSION=8 GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip
			GRC_TEXTURE_DECODE=engine GRC_TEXTURE_WORKERS=2 GRC_ROOT_SIZE=presentation:1920x1080
			GRC_MIRROR_MAX_ITEMS=32768 GRC_MIRROR_MAX_COMMANDS=16384
			GRC_RESOURCE_MAX_PAYLOAD_BYTES=268435456 GRC_RESOURCE_BUDGET_BYTES=8589934592)
		if [ "$MODE" = live ]; then
			env+=(GRC_LIVE_LISTEN="127.0.0.1:$PORT")
		else
			env+=(GRC_STREAM_PATCH_OUT="$dir/recording-patch.rs8" GRC_RESOURCE_STORE_DIR="$dir/store")
		fi
	fi
	if [ "${#EXTRA[@]}" -gt 0 ]; then
		env+=("${EXTRA[@]}")
	fi
	printf '%s\n' "${env[@]}" >"$dir/env.txt"
	local -a wrap=()
	[ "$armed" = 1 ] && [ "$PERF" = 1 ] && wrap=(perf record -F 999 -g -o "$dir/perf.data" --)
	echo "bench-capture-scale: $name ($([ "$armed" = 1 ] && echo "armed, $MODE" || echo unarmed), $FRAMES frames)"
	bash "$SCRIPT_DIR/lib/quiet.sh" exclusive --label "bench-capture-scale:$name" -- \
		python3 "$SCRIPT_DIR/lib/bench-capture-scale.py" run "$dir" -- \
		env -i "${env[@]}" "${wrap[@]}" "$BINARY" --headless --max-fps 60 --path "$FIXTURE"
	if [ "${RS_BENCH_KEEP:-0}" != 1 ]; then
		rm -rf "$dir/store" "$dir/recording-patch.rs8" "$dir/evidence/resources.jsonl"
	fi
}

leg unarmed 0
leg armed 1
python3 "$SCRIPT_DIR/lib/bench-capture-scale.py" verdict "$OUT" --mode "$MODE" \
	--budget-callback-ms "$BUDGET_MS" --min-fps-ratio "$MIN_RATIO" --perf "$PERF"
