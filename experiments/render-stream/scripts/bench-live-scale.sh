#!/usr/bin/env bash
# Live throughput at a game's scale (P3-LV, results/p3/p3-lv.md): runs fixtures/capture-scale armed
# with the live listener on the stock release template (headless, --max-fps 60, real time) and ONE
# live receiver subscribed to it, then judges how fast that receiver keeps up.
#
#   bash experiments/render-stream/scripts/bench-live-scale.sh --extension EXT --receiver KIND
#     [--window 1|2] [--protocol 8|9] [--bundle DIR] [--out DIR] [--frames N] [--binary PATH]
#     [--calibration PATH] [--min-rate R] [--max-credit-rtt-ms MS] [-- NAME=value ...]
#
# KIND is native (receiver/ rendered in a private headless gamescope, lib/gamescope.sh), gsw or web
# (the gate 7 browser harness, gate7-tool.ts browser-receiver, with --bundle: a GSW bundle or a
# Rust-core web export bundle). The host runs P3-CAP's armed config (bench-capture-scale.sh, the
# product hand-off environment) with GRC_LIVE_LISTEN, the page origin allowed and a live tap.
# NAME=value words after `--` go to the host when they start with GRC_ or RS_SCALE_ (for example
# GRC_RESOURCE_INLINE_MAX_BYTES=4096, the hand-off's mesh setting) and to the receiver when they
# start with RS_RECEIVER_ (for example RS_RECEIVER_FETCH_CONCURRENCY=6).
#
# The pair is ONE timing leg: it holds the machine-wide quiet lock EXCLUSIVE (lib/quiet.sh) and runs
# in real time, so its numbers are rate numbers; report them with the load (`uptime`), which the
# lock does not see. Writes <out>/host/ (stdout, perf.json, live-summary.json, the tap's
# live-1.jsonl), <out>/rx/ (the receiver's applied.json, perf.json, stdout), <out>/bench-live-scale.json
# (lib/bench-live-scale.py: per-connection rate, latency, credit round trip, folds, bytes, GETs,
# inline records, first apply, receiver stage times) and <out>/result.json (lib/tier-verdict.py):
#   legs-ran     both processes exited 0 and the tap saw the connection
#   update-rate  distinct receiver applies per second over the leg >= --min-rate (default 15)
#   credit-rtt   credit round trip p50 <= --max-credit-rtt-ms (default 100)
# Exits 1 when a check fails. The tap's stream copy, the receiver's received bytes and its cache are
# deleted after the summary unless RS_BENCH_KEEP=1.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE="$EXPERIMENT_DIR/fixtures/capture-scale"

EXTENSION="" OUT="" KIND="" WINDOW=2 PROTOCOL=8 BUNDLE="" FRAMES=1200
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
MIN_RATE=15 MAX_RTT_MS=100
PORT="${RS_BENCH_PORT:-13831}" PAGE="${RS_BENCH_PAGE_PORT:-13832}"
EXTRA=()
while [ $# -gt 0 ]; do
	case "$1" in
	--extension) EXTENSION="$2" && shift 2 ;;
	--receiver) KIND="$2" && shift 2 ;;
	--window) WINDOW="$2" && shift 2 ;;
	--protocol) PROTOCOL="$2" && shift 2 ;;
	--bundle) BUNDLE="$2" && shift 2 ;;
	--out) OUT="$2" && shift 2 ;;
	--frames) FRAMES="$2" && shift 2 ;;
	--binary) BINARY="$2" && shift 2 ;;
	--calibration) CALIBRATION="$2" && shift 2 ;;
	--min-rate) MIN_RATE="$2" && shift 2 ;;
	--max-credit-rtt-ms) MAX_RTT_MS="$2" && shift 2 ;;
	-h | --help) sed -n 2,31p "${BASH_SOURCE[0]}" && exit 0 ;;
	--) shift && EXTRA=("$@") && break ;;
	*) echo "bench-live-scale: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] || { echo "bench-live-scale: pass --extension /abs/path/render_stream_capture.gdextension" >&2; exit 2; }
case "$KIND" in native | gsw | web) ;; *) echo "bench-live-scale: --receiver native|gsw|web" >&2 && exit 2 ;; esac
case "$WINDOW" in 1 | 2) ;; *) echo "bench-live-scale: --window 1|2" >&2 && exit 2 ;; esac
case "$PROTOCOL" in 8 | 9) ;; *) echo "bench-live-scale: --protocol 8|9" >&2 && exit 2 ;; esac
[ "$KIND" = native ] || [ -d "$BUNDLE" ] || { echo "bench-live-scale: --receiver $KIND needs --bundle DIR" >&2; exit 2; }
[ -x "$BINARY" ] || { echo "bench-live-scale: no template at $BINARY" >&2; exit 2; }
[ -f "$CALIBRATION" ] || { echo "bench-live-scale: no calibration at $CALIBRATION" >&2; exit 2; }
EXTENSION="$(realpath "$EXTENSION")"
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/bench-live-scale/$(date -u +%Y%m%dT%H%M%SZ)-$KIND-w$WINDOW"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"

HOST_ENV=(HOME="$HOME" PATH="$PATH" RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME="$FRAMES"
	RS_SCALE_REPORT="$OUT/host/scale-report.json"
	GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm GRC_EVIDENCE_DIR="$OUT/host/evidence"
	GRC_STREAM_VERSION="$PROTOCOL" GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_TEXTURE_DECODE=engine GRC_TEXTURE_WORKERS=2
	GRC_ROOT_SIZE=presentation:1920x1080 GRC_MIRROR_MAX_ITEMS=32768 GRC_MIRROR_MAX_COMMANDS=16384
	GRC_RESOURCE_MAX_PAYLOAD_BYTES=268435456 GRC_RESOURCE_BUDGET_BYTES=8589934592
	GRC_LIVE_LISTEN="127.0.0.1:$PORT" GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$PAGE" GRC_LIVE_TAP_DIR="$OUT/host/tap")
RX_ENV=(RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$PORT/render-stream" RS_RECEIVER_PROTOCOL="$PROTOCOL"
	RS_RECEIVER_CREDIT_WINDOW="$WINDOW" RS_RECEIVER_OUT="$OUT/rx/applied.json" RS_RECEIVER_PERF_OUT="$OUT/rx/perf.json"
	RS_RECEIVER_LOG=summary RS_RECEIVER_RECEIVED_MAX_BYTES=16777216)
if [ "${#EXTRA[@]}" -gt 0 ]; then
	for kv in "${EXTRA[@]}"; do
		case "$kv" in
		GRC_* | RS_SCALE_*) HOST_ENV+=("$kv") ;;
		RS_RECEIVER_*) RX_ENV+=("$kv") ;;
		*) echo "bench-live-scale: $kv is neither GRC_*/RS_SCALE_* (host) nor RS_RECEIVER_* (receiver)" >&2 && exit 2 ;;
		esac
	done
fi

# The pair, inside the exclusive quiet lock (re-entered through quiet.sh so the lock is held for
# exactly this leg).
if [ -z "${RS_BENCH_LIVE_INSIDE:-}" ]; then
	rm -rf "$OUT/host" "$OUT/rx" && mkdir -p "$OUT/host/evidence" "$OUT/rx"
	printf '%s\n' "${HOST_ENV[@]}" >"$OUT/host/env.txt"
	printf '%s\n' "${RX_ENV[@]}" >"$OUT/rx/env.txt"
	echo "bench-live-scale: $KIND receiver, window $WINDOW, /$PROTOCOL, $FRAMES host frames (load $(cut -d' ' -f1-3 /proc/loadavg))"
	RS_BENCH_LIVE_INSIDE=1 bash "$SCRIPT_DIR/lib/quiet.sh" exclusive --label "bench-live-scale:$KIND-w$WINDOW" -- \
		bash "${BASH_SOURCE[0]}" --extension "$EXTENSION" --receiver "$KIND" --window "$WINDOW" --protocol "$PROTOCOL" \
		${BUNDLE:+--bundle "$BUNDLE"} --out "$OUT" --frames "$FRAMES" --binary "$BINARY" --calibration "$CALIBRATION" \
		-- ${EXTRA[@]+"${EXTRA[@]}"}
	if [ "${RS_BENCH_KEEP:-0}" != 1 ]; then
		rm -rf "$OUT/rx/cache" "$OUT/rx/received.rs8" "$OUT/rx/received.rs9" "$OUT"/host/tap/stream-* \
			"$OUT/host/evidence/resources.jsonl"
	fi
	python3 "$SCRIPT_DIR/lib/bench-live-scale.py" verdict "$OUT" --min-rate "$MIN_RATE" --max-credit-rtt-ms "$MAX_RTT_MS"
	exit $?
fi

python3 "$SCRIPT_DIR/lib/bench-capture-scale.py" run "$OUT/host" -- \
	env -i "${HOST_ENV[@]}" "$BINARY" --headless --max-fps 60 --path "$FIXTURE" &
HOST_PID=$!
for _ in $(seq 1 300); do
	[ -f "$OUT/host/evidence/live.json" ] && break
	sleep 0.1
done
date +%s%3N >"$OUT/rx/start.ms"
case "$KIND" in
native)
	GS_STRIP_VARS=(DISPLAY WAYLAND_DISPLAY)
	# shellcheck source=lib/gamescope.sh
	source "$SCRIPT_DIR/lib/gamescope.sh"
	RX_PID=""
	trap '[ -n "$RX_PID" ] && kill -KILL "$RX_PID" 2>/dev/null; gs_teardown "$OUT/rx/gamescope" || true' EXIT
	gs_start 1920 1080 "$OUT/rx/gamescope"
	GS_GODOT_ENV=("${RX_ENV[@]}" RS_RECEIVER_CACHE_DIR="$OUT/rx/cache")
	gs_launch_godot "$GS_DISPLAY" "$BINARY" "$EXPERIMENT_DIR/receiver" "$OUT/rx/stdout.log" --max-fps 60 --resolution 1920x1080
	RX_PID="$GS_LAST_GODOT_PID"
	wait "$RX_PID"
	echo "$?" >"$OUT/rx/exit.txt"
	;;
gsw | web)
	printf '%s\n' "${RX_ENV[@]}" >"$OUT/rx/native-env.txt"
	printf '%s\n' "$BINARY" --path "$EXPERIMENT_DIR/receiver" --resolution 1920x1080 --max-fps 60 >"$OUT/rx/native-argv.txt"
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-tool.ts" browser-receiver \
		--dir "$OUT/rx" --kind "$KIND" --bundle "$BUNDLE" --static-root "$OUT" --port "$PAGE" \
		--timeout-s "$((FRAMES / 20 + 120))") >"$OUT/rx/launcher.out" 2>&1
	echo "$?" >"$OUT/rx/exit.txt"
	;;
esac
date +%s%3N >"$OUT/rx/end.ms"
wait "$HOST_PID"
