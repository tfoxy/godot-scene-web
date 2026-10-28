#!/usr/bin/env bash
# HC1 quiet-path legs (results/p3/hc1.md, protocol/host-cost-design.md D5, D6): small capture-scale
# hosts (stock release template, headless) armed with a live listener, a viewer that joins late, and
# the hook log on or off. Judged by scripts/lib/hc1-checks.ts:
#   hook-log-off-formats-nothing   counters.json hook_log_lines_formatted is 0 with GRC_HOOK_LOG=off
#                                  and equals resources.jsonl's line count with it on
#   no-snapshot-without-viewer     a listener with no viewer takes no snapshot (idle leg: 0)
#   late-join-served               a viewer joining a running host gets the full state a file sink
#                                  recorded and every GET it makes answers 200
#   sabotage-pin-late              (pin-late: no pin before the first transaction) 404s fail the above
#
#   bash experiments/render-stream/scripts/run-hc1.sh --extension EXT [--out DIR] [--calibration PATH]
#     [--binary PATH]
set -uo pipefail
if [ -z "${RS_QUIET_HC1_WRAPPED:-}" ]; then
	RS_QUIET_HC1_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label run-hc1 -- bash "${BASH_SOURCE[0]}" "$@"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE="$EXPERIMENT_DIR/fixtures/capture-scale"
EXTENSION="" OUT="" PORT="${RS_HC1_PORT:-13851}"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
while [ $# -gt 0 ]; do
	case "$1" in
	--extension) EXTENSION="$2" && shift 2 ;;
	--out) OUT="$2" && shift 2 ;;
	--calibration) CALIBRATION="$2" && shift 2 ;;
	--binary) BINARY="$2" && shift 2 ;;
	-h | --help) sed -n 2,14p "${BASH_SOURCE[0]}" && exit 0 ;;
	*) echo "run-hc1: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] || { echo "run-hc1: pass --extension /abs/path/render_stream_capture.gdextension" >&2; exit 2; }
[ -x "$BINARY" ] || { echo "run-hc1: no template at $BINARY" >&2; exit 2; }
EXTENSION="$(realpath "$EXTENSION")"
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/hc1/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" && OUT="$(realpath "$OUT")"

SMALL=(RS_SCALE_ITEMS=400 RS_SCALE_TEXTURES=60 RS_SCALE_TEX_W=64 RS_SCALE_TEX_H=48 RS_SCALE_DRAWN_TEXTURES=40
	RS_SCALE_MESHES=20 RS_SCALE_MATERIALS=40 RS_SCALE_SHADERS=4 RS_SCALE_FLOAT_TEXTURES=20 RS_SCALE_PARAMS=8)
STATIC=(RS_SCALE_MESH_UPDATES=0 RS_SCALE_MOVERS=0 RS_SCALE_PARAM_UPDATES=0)
CHURN=(RS_SCALE_MESH_UPDATES=10 RS_SCALE_MOVERS=10 RS_SCALE_PARAM_UPDATES=2 RS_SCALE_REDRAWS=20)
FRAMES=360 DELAY_MS=2500

# leg <name> <frames> <viewer 0|1> <sink 0|1> <hook on|off> <scene words...> [-- extra host env]
leg() {
	local name="$1" frames="$2" viewer="$3" sink="$4" hook="$5"
	shift 5
	local -a scene=() extra=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do scene+=("$1") && shift; done
	[ $# -gt 0 ] && shift
	extra=("$@")
	local dir="$OUT/$name"
	rm -rf "$dir" && mkdir -p "$dir/evidence" "$dir/viewer"
	local -a env=(HOME="$HOME" PATH="$PATH" RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME="$frames" RS_SCALE_WARMUP=30
		RS_SCALE_REPORT="$dir/scale-report.json" "${SMALL[@]}" "${scene[@]}"
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_VERSION=8 GRC_TEXTURE_DECODE=engine
		GRC_TEXTURE_WORKERS=sync GRC_ROOT_SIZE=presentation:1920x1080 GRC_HOOK_LOG="$hook"
		GRC_RESOURCE_INLINE_MAX_BYTES=256 GRC_RESOURCE_STORE_DIR="$dir/store")
	if [ "$sink" = 1 ]; then env+=(GRC_STREAM_OUT="$dir/recording-full.rs8"); fi
	if [ "$viewer" != x ]; then env+=(GRC_LIVE_LISTEN="127.0.0.1:$PORT" GRC_LIVE_TAP_DIR="$dir/tap"); fi
	[ "${#extra[@]}" -gt 0 ] && env+=("${extra[@]}")
	mkdir -p "$dir/tap"
	printf '%s\n' "${env[@]}" >"$dir/env.txt"
	echo "run-hc1: $name (viewer=$viewer sink=$sink hook_log=$hook, $frames frames)"
	local rx_pid=""
	if [ "$viewer" = 1 ]; then
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/null-receiver.ts" \
			--url "ws://127.0.0.1:$PORT/render-stream" --out "$dir/viewer" --protocol 8 --window 1 \
			--delay-ms "$DELAY_MS" --fetch-first "http://127.0.0.1:$PORT" --timeout-s 60 \
			>"$dir/viewer/stdout.log" 2>&1) &
		rx_pid=$!
	fi
	env -i "${env[@]}" "$BINARY" --headless --max-fps 60 --path "$FIXTURE" >"$dir/stdout.log" 2>"$dir/stderr.log"
	echo "$?" >"$dir/exit.txt"
	[ -n "$rx_pid" ] && { wait "$rx_pid"; echo "$?" >"$dir/viewer/exit.txt"; }
	return 0
}

leg ref-static "$FRAMES" x 1 on "${STATIC[@]}"
leg idle 120 0 0 on "${STATIC[@]}"
leg late-static "$FRAMES" 1 0 on "${STATIC[@]}"
leg late-static-off "$FRAMES" 1 0 off "${STATIC[@]}"
leg late-churn "$FRAMES" 1 1 on "${CHURN[@]}"
if [ "${RS_SABOTAGE_TIER:-run}" = skip ]; then
	# the smoke tier (lib/legs.sh's contract): tier-verdict.py excuses the check naming "sabotage"
	mkdir -p "$OUT/sabotage-pin-late"
	echo "skipped-by-tier: RS_SABOTAGE_TIER=skip" >"$OUT/sabotage-pin-late/skipped-by-tier.txt"
else
	leg sabotage-pin-late "$FRAMES" 1 0 on "${STATIC[@]}" -- GRC_HC_SABOTAGE=pin-late
fi

mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/hc1-checks.ts" "$OUT"
