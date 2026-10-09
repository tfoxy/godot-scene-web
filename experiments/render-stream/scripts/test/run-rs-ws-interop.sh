#!/usr/bin/env bash
# rs_ws interop tests: the WebSocket transport (protocol/gate1-design.md G1c1
# "Pass criteria") and its HTTP GET resource serving (protocol/gate2-design.md
# G2c1 "Pass criteria"). Both the Node self-test and the two Godot self-tests
# drive the same capture/test/rs_ws_echo.cpp binary built by build-capture.sh.
#
# Usage, from the repo root:
#   experiments/render-stream/scripts/build-capture.sh
#   experiments/render-stream/scripts/test/run-rs-ws-interop.sh
#
# Equivalent to running each piece by hand:
#   mise exec -- pnpm exec tsx --conditions=development \
#     experiments/render-stream/scripts/test/self-test-rs-ws.ts
#     # (spawns and kills its own rs_ws_echo; covers WS and HTTP GET)
#
#   experiments/render-stream/capture/build/rs_ws_echo --port=0
#     # note the printed "RS_WS_ECHO_PORT <port>" line
#   mise exec -- godot --headless --path experiments/render-stream/receiver --import  # once
#   RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
#     --path experiments/render-stream/receiver --script res://tests/ws_selftest.gd
#   RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
#     --path experiments/render-stream/receiver --script res://tests/http_selftest.gd
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER_STREAM_DIR="$(cd "${HERE}/../.." && pwd)"
CAPTURE_DIR="${RENDER_STREAM_DIR}/capture"
RECEIVER_DIR="${RENDER_STREAM_DIR}/receiver"
ECHO_BINARY="${CAPTURE_DIR}/build/rs_ws_echo"

if [ ! -x "${ECHO_BINARY}" ]; then
	echo "run-rs-ws-interop: ${ECHO_BINARY} does not exist; run scripts/build-capture.sh first" >&2
	exit 1
fi

echo "run-rs-ws-interop: Node interop (self-test-rs-ws.ts)"
mise exec -- pnpm exec tsx --conditions=development "${HERE}/self-test-rs-ws.ts" "${ECHO_BINARY}"

if [ ! -d "${RECEIVER_DIR}/.godot" ]; then
	echo "run-rs-ws-interop: importing ${RECEIVER_DIR} (first run)"
	mise exec -- godot --headless --path "${RECEIVER_DIR}" --import
fi

echo "run-rs-ws-interop: Godot interop (ws_selftest.gd)"
ECHO_LOG="$(mktemp)"
"${ECHO_BINARY}" --port=0 --max-clients=4 >"${ECHO_LOG}" 2>&1 &
ECHO_PID=$!
trap 'kill "${ECHO_PID}" >/dev/null 2>&1 || true; wait "${ECHO_PID}" 2>/dev/null || true; rm -f "${ECHO_LOG}"' EXIT

PORT=""
for _ in $(seq 1 50); do
	if PORT="$(grep -m1 '^RS_WS_ECHO_PORT ' "${ECHO_LOG}" 2>/dev/null | awk '{print $2}')" && [ -n "${PORT}" ]; then
		break
	fi
	sleep 0.1
done
if [ -z "${PORT}" ]; then
	echo "run-rs-ws-interop: rs_ws_echo never printed its port; see ${ECHO_LOG}" >&2
	cat "${ECHO_LOG}" >&2
	exit 1
fi
echo "run-rs-ws-interop: rs_ws_echo listening on 127.0.0.1:${PORT}"

RS_WS_ECHO_PORT="${PORT}" mise exec -- godot --headless --path "${RECEIVER_DIR}" \
	--script res://tests/ws_selftest.gd

echo "run-rs-ws-interop: Godot interop (http_selftest.gd)"
RS_WS_ECHO_PORT="${PORT}" mise exec -- godot --headless --path "${RECEIVER_DIR}" \
	--script res://tests/http_selftest.gd

echo "run-rs-ws-interop: all interop tests passed"
