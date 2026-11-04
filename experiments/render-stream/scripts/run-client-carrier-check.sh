#!/usr/bin/env bash
# CAR5 live leg: one headless tag-scene capture at /13 with GRC_LIVE_CARRIERS=ws,wt and a live tap,
# and scripts/client-carrier-check.ts driving the client package against it over both carriers
# (see that file for the legs and checks). Needs build-capture.sh and build-rs-net.sh first.
#
#   bash experiments/render-stream/scripts/run-client-carrier-check.sh --out DIR [--core DIR]
#     [--binary PATH] [--quit-frame N]
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
TAG_DIR="$EXPERIMENT_DIR/fixtures/tag-scene"
EXTENSION="$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT="" CORE="" QUIT=1500
while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT="$2" && shift 2 ;;
	--core) CORE="$2" && shift 2 ;;
	--binary) BINARY="$2" && shift 2 ;;
	--quit-frame) QUIT="$2" && shift 2 ;;
	*) echo "run-client-carrier-check: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -n "$OUT" ] || { echo "run-client-carrier-check: --out DIR" >&2; exit 2; }
mkdir -p "$OUT" && OUT="$(realpath "$OUT")"
[ -f "$EXTENSION" ] && [ -x "$BINARY" ] || { echo "run-client-carrier-check: build the capture first" >&2; exit 2; }
[ -f "$EXPERIMENT_DIR/capture/build/librender_stream_net.so" ] || { echo "run-client-carrier-check: build-rs-net.sh first" >&2; exit 2; }
Q="$SCRIPT_DIR/lib/quiet.sh"

if [ -z "$CORE" ]; then
	CORE="$OUT/core"
	bash "$Q" shared -- bash "$REPO_ROOT/packages/render-stream-client/scripts/build-web.sh" "$CORE" >"$OUT/core-build.log" 2>&1 \
		|| { echo "run-client-carrier-check: core build failed ($OUT/core-build.log)" >&2; exit 1; }
fi
(cd "$REPO_ROOT" && bash "$Q" shared -- mise exec -- godot --headless --path "$TAG_DIR" --import >"$OUT/import.log" 2>&1)

pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
PAGE="$(pick_port)"
# One number for TCP (ws) and UDP (wt): a free TCP port whose UDP twin is free too.
for _ in 1 2 3 4 5 6 7 8; do
	PORT="$(pick_port)"
	python3 -c "import socket,sys; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('127.0.0.1', $PORT))" 2>/dev/null && break
done
HOST="$OUT/host"
mkdir -p "$HOST/evidence" "$HOST/tap" "$OUT/page"
run() {
	env GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm \
		GRC_EVIDENCE_DIR="$HOST/evidence" GRC_STREAM_VERSION=13 GRC_ROOT_SIZE="presentation:640x360" \
		GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip RS_FIXTURE_ARM=late RS_FIXTURE_QUIT_FRAME="$QUIT" \
		RS_FIXTURE_TAG_START=60 GRC_LIVE_LISTEN="127.0.0.1:$PORT" GRC_LIVE_CARRIERS=ws,wt \
		GRC_LIVE_AUTH=token GRC_LIVE_TAP_DIR="$HOST/tap" GRC_LIVE_MAX_CONNECTIONS=4 \
		GRC_LIVE_AWAIT_HELLO_MS=60000 GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$PAGE" \
		"$BINARY" --headless --max-fps 60 --path "$TAG_DIR" >"$HOST/stdout.log" 2>&1 &
	HOST_PID=$!
	waited=0
	while [ "$waited" -lt 600 ] && { [ ! -s "$HOST/evidence/live-cert-sha256" ] || ! grep -q '"status": "listening"' "$HOST/evidence/live.json" 2>/dev/null; } && kill -0 "$HOST_PID" 2>/dev/null; do
		sleep 0.05 && waited=$((waited + 1))
	done
	if [ ! -s "$HOST/evidence/live-cert-sha256" ]; then
		echo "run-client-carrier-check: the host did not listen (see $HOST/stdout.log)" >&2
		kill "$HOST_PID" 2>/dev/null
		return 1
	fi
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/client-carrier-check.ts" \
		--dir "$OUT/page" --port "$PAGE" --ws "ws://127.0.0.1:$PORT/render-stream" \
		--http "http://127.0.0.1:$PORT" --wt "https://127.0.0.1:$PORT/render-stream" \
		--evidence "$HOST/evidence" --tap "$HOST/tap" --core "$CORE") 2>&1 | tee "$OUT/page/stdout.log"
	rc=${PIPESTATUS[0]}
	wait_s=0
	while kill -0 "$HOST_PID" 2>/dev/null && [ "$wait_s" -lt 120 ]; do sleep 1 && wait_s=$((wait_s + 1)); done
	kill "$HOST_PID" 2>/dev/null
	echo "$rc" >"$OUT/page/exit-code.txt"
	return "$rc"
}
START=$(date +%s)
run
RC=$?
echo "run-client-carrier-check: exit $RC, wall $(($(date +%s) - START)) s"
exit "$RC"
