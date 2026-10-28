#!/usr/bin/env bash
# Live throughput at a game's scale (P3-LV, results/p3/p3-lv.md): runs fixtures/capture-scale armed
# with the live listener on the stock release template (headless, --max-fps 60, real time) and ONE
# live receiver subscribed to it (or --viewers N of them, P3-SP), then judges how fast that receiver
# keeps up.
#
#   bash experiments/render-stream/scripts/bench-live-scale.sh --extension EXT --receiver KIND
#     [--window 1|2] [--protocol 8|9|10|11] [--bundle DIR] [--out DIR] [--frames N] [--binary PATH]
#     [--calibration PATH] [--min-rate R] [--max-credit-rtt-ms MS] [--viewers N] [--perf]
#     [-- NAME=value ...]
#
# --viewers N (1..4, P3-SP) subscribes N receivers of KIND at once (GRC_LIVE_MAX_CONNECTIONS=N, one
# page port each for a browser kind): their directories are <out>/rx1 .. rxN instead of <out>/rx,
# and the checks are judged on the slowest viewer. The summary adds the host's own cost (frame rate,
# frame callback, CPU cores, RSS) for every N. --perf samples the host with `perf record -g` for the
# whole leg (<out>/host/perf.data, kept, and perf-report.txt, the self-time report).
#
# KIND is native (receiver/ rendered in a private headless gamescope, lib/gamescope.sh), gsw or web
# (the gate 7 browser harness, gate7-tool.ts browser-receiver, with --bundle: a GSW bundle or a
# Rust-core web export bundle), or null (P3-SP: lib/null-receiver.ts, a WebSocket client that decodes
# nothing and acks every transaction on arrival, so the leg measures the host's own cost per viewer
# with every viewer caught up and no receiver competing for the machine; at --protocol 11 it sends
# the /11 hello offering live_coding, so the host codes as in the product, HC). The host runs P3-CAP's armed config (bench-capture-scale.sh, the
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
MIN_RATE=15 MAX_RTT_MS=100 VIEWERS=1 PERF=0
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
	--viewers) VIEWERS="$2" && shift 2 ;;
	--perf) PERF=1 && shift ;;
	-h | --help) sed -n 2,31p "${BASH_SOURCE[0]}" && exit 0 ;;
	--) shift && EXTRA=("$@") && break ;;
	*) echo "bench-live-scale: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] || { echo "bench-live-scale: pass --extension /abs/path/render_stream_capture.gdextension" >&2; exit 2; }
case "$KIND" in native | gsw | web | null) ;; *) echo "bench-live-scale: --receiver native|gsw|web|null" >&2 && exit 2 ;; esac
case "$WINDOW" in 1 | 2) ;; *) echo "bench-live-scale: --window 1|2" >&2 && exit 2 ;; esac
case "$PROTOCOL" in 8 | 9 | 10 | 11) ;; *) echo "bench-live-scale: --protocol 8|9|10|11" >&2 && exit 2 ;; esac
case "$VIEWERS" in 1 | 2 | 3 | 4) ;; *) echo "bench-live-scale: --viewers 1..4" >&2 && exit 2 ;; esac
case "$KIND" in native | null) ;; *) [ -d "$BUNDLE" ] || { echo "bench-live-scale: --receiver $KIND needs --bundle DIR" >&2; exit 2; } ;; esac
[ -x "$BINARY" ] || { echo "bench-live-scale: no template at $BINARY" >&2; exit 2; }
[ -f "$CALIBRATION" ] || { echo "bench-live-scale: no calibration at $CALIBRATION" >&2; exit 2; }
EXTENSION="$(realpath "$EXTENSION")"
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/bench-live-scale/$(date -u +%Y%m%dT%H%M%SZ)-$KIND-w$WINDOW"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"

# One page port per viewer (browser kinds), every one of them an allowed origin.
PAGES=() ORIGINS=""
for i in $(seq 1 "$VIEWERS"); do
	PAGES+=("$((PAGE + 10 * (i - 1)))")
	ORIGINS="${ORIGINS:+$ORIGINS,}http://127.0.0.1:$((PAGE + 10 * (i - 1)))"
done
RX_NAMES=(rx)
[ "$VIEWERS" = 1 ] || RX_NAMES=($(seq -f 'rx%g' 1 "$VIEWERS"))
HOST_ENV=(HOME="$HOME" PATH="$PATH" RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME="$FRAMES"
	RS_SCALE_REPORT="$OUT/host/scale-report.json"
	GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm GRC_EVIDENCE_DIR="$OUT/host/evidence"
	GRC_STREAM_VERSION="$PROTOCOL" GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_TEXTURE_DECODE=engine GRC_TEXTURE_WORKERS=2
	GRC_ROOT_SIZE=presentation:1920x1080 GRC_MIRROR_MAX_ITEMS=32768 GRC_MIRROR_MAX_COMMANDS=16384
	GRC_RESOURCE_MAX_PAYLOAD_BYTES=268435456 GRC_RESOURCE_BUDGET_BYTES=8589934592
	GRC_LIVE_LISTEN="127.0.0.1:$PORT" GRC_LIVE_ALLOWED_ORIGINS="$ORIGINS" GRC_LIVE_TAP_DIR="$OUT/host/tap")
[ "$VIEWERS" = 1 ] || HOST_ENV+=(GRC_LIVE_MAX_CONNECTIONS="$VIEWERS")
# The receiver environment; @RX@ is each viewer's directory.
RX_ENV=(RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$PORT/render-stream" RS_RECEIVER_PROTOCOL="$PROTOCOL"
	RS_RECEIVER_CREDIT_WINDOW="$WINDOW" RS_RECEIVER_OUT="@RX@/applied.json" RS_RECEIVER_PERF_OUT="@RX@/perf.json"
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
	rm -rf "$OUT/host" "$OUT"/rx "$OUT"/rx[0-9] && mkdir -p "$OUT/host/evidence"
	printf '%s\n' "${HOST_ENV[@]}" >"$OUT/host/env.txt"
	for rx in "${RX_NAMES[@]}"; do
		mkdir -p "$OUT/$rx"
		printf '%s\n' "${RX_ENV[@]//@RX@/$OUT/$rx}" >"$OUT/$rx/env.txt"
	done
	echo "bench-live-scale: $VIEWERS $KIND receiver(s), window $WINDOW, /$PROTOCOL, $FRAMES host frames (load $(cut -d' ' -f1-3 /proc/loadavg))"
	RS_BENCH_LIVE_INSIDE=1 bash "$SCRIPT_DIR/lib/quiet.sh" exclusive --label "bench-live-scale:$KIND-w$WINDOW-x$VIEWERS" -- \
		bash "${BASH_SOURCE[0]}" --extension "$EXTENSION" --receiver "$KIND" --window "$WINDOW" --protocol "$PROTOCOL" \
		${BUNDLE:+--bundle "$BUNDLE"} --out "$OUT" --frames "$FRAMES" --binary "$BINARY" --calibration "$CALIBRATION" \
		--viewers "$VIEWERS" $([ "$PERF" = 1 ] && echo --perf) -- ${EXTRA[@]+"${EXTRA[@]}"}
	if [ "${RS_BENCH_KEEP:-0}" != 1 ]; then
		for rx in "${RX_NAMES[@]}"; do
			rm -rf "$OUT/$rx/cache" "$OUT/$rx/received.rs8" "$OUT/$rx/received.rs9" "$OUT/$rx/received.rs10" "$OUT/$rx/received.rs11"
		done
		rm -rf "$OUT"/host/tap/stream-* "$OUT/host/evidence/resources.jsonl"
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
# --perf: sample the host (the Godot process bench-capture-scale.py started) for the whole leg.
PERF_PID=""
if [ "$PERF" = 1 ]; then
	GODOT_PID="$(pgrep -P "$HOST_PID" | head -n 1)"
	if [ -n "$GODOT_PID" ]; then
		perf record -g -F 499 -p "$GODOT_PID" -o "$OUT/host/perf.data" >"$OUT/host/perf-record.log" 2>&1 &
		PERF_PID=$!
	fi
fi
# One receiver; $1 is its directory name, $2 its page port.
run_receiver() {
	local rx="$1" page="$2" dir="$OUT/$1"
	local env=("${RX_ENV[@]//@RX@/$dir}")
	date +%s%3N >"$dir/start.ms"
	case "$KIND" in
	native)
		GS_STRIP_VARS=(DISPLAY WAYLAND_DISPLAY)
		# shellcheck source=lib/gamescope.sh
		source "$SCRIPT_DIR/lib/gamescope.sh"
		RX_PID=""
		trap '[ -n "$RX_PID" ] && kill -KILL "$RX_PID" 2>/dev/null; gs_teardown "'"$dir"'/gamescope" || true' EXIT
		gs_start 1920 1080 "$dir/gamescope"
		GS_GODOT_ENV=("${env[@]}" RS_RECEIVER_CACHE_DIR="$dir/cache")
		gs_launch_godot "$GS_DISPLAY" "$BINARY" "$EXPERIMENT_DIR/receiver" "$dir/stdout.log" --max-fps 60 --resolution 1920x1080
		RX_PID="$GS_LAST_GODOT_PID"
		wait "$RX_PID"
		echo "$?" >"$dir/exit.txt"
		;;
	gsw | web)
		printf '%s\n' "${env[@]}" >"$dir/native-env.txt"
		printf '%s\n' "$BINARY" --path "$EXPERIMENT_DIR/receiver" --resolution 1920x1080 --max-fps 60 >"$dir/native-argv.txt"
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-tool.ts" browser-receiver \
			--dir "$dir" --kind "$KIND" --bundle "$BUNDLE" --static-root "$OUT" --port "$page" \
			--timeout-s "$((FRAMES / 20 + 120))") >"$dir/launcher.out" 2>&1
		echo "$?" >"$dir/exit.txt"
		;;
	null)
		# P3-SP: lib/null-receiver.ts decodes nothing and acks every transaction on arrival.
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/null-receiver.ts" \
			--url "ws://127.0.0.1:$PORT/render-stream" --out "$dir" --window "$WINDOW" \
			--protocol "$([ "$PROTOCOL" = 11 ] && echo 11 || echo 8)" --timeout-s "$((FRAMES / 20 + 120))") >"$dir/launcher.out" 2>&1
		echo "$?" >"$dir/exit.txt"
		;;
	esac
	date +%s%3N >"$dir/end.ms"
}
RX_JOBS=()
for i in "${!RX_NAMES[@]}"; do
	(run_receiver "${RX_NAMES[$i]}" "${PAGES[$i]}") &
	RX_JOBS+=($!)
done
wait "${RX_JOBS[@]}"
wait "$HOST_PID"
if [ -n "$PERF_PID" ]; then
	wait "$PERF_PID"
	perf report -i "$OUT/host/perf.data" --no-children --stdio --percent-limit 0.3 --sort symbol -g none \
		2>/dev/null | cut -c1-200 >"$OUT/host/perf-report.txt"
	perf report -i "$OUT/host/perf.data" --children --stdio --percent-limit 1 --sort symbol -g none \
		2>/dev/null | cut -c1-200 >"$OUT/host/perf-report-children.txt"
fi
