#!/usr/bin/env bash
# Correctness only: real Godot sample worker and client in the private browser session.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(realpath "$HERE/../../..")"
OUT="$(realpath -m "${2:-$ROOT/.local/audio-assets-live}")"
if [ "$#" -gt 0 ] && { [ "$1" != --out ] || [ "$#" != 2 ]; }; then echo 'usage: run-audio-assets.sh [--out DIR]' >&2; exit 2; fi
mkdir -p "$OUT/host/evidence" "$OUT/control"
: > "$OUT/quiet-lock.jsonl"
bash "$HERE/run-audio-samples.sh" --import-only --stereo --out "$OUT/prep"
cp "$OUT/prep/project/assets.gd" "$OUT/prep/project/main.gd"
LEGS_LOG=audio-assets
HEADLESS_TIMEOUT_S=90
RENDERED_TIMEOUT_S=90
source "$HERE/lib/gamescope.sh"
source "$HERE/lib/legs.sh"
trap 'if [ -n "${BG_PID:-}" ]; then kill "$BG_PID" 2>/dev/null || true; fi; if [ -n "$GS_RUN_DIR" ]; then gs_teardown "$GS_RUN_DIR" || true; fi; quiet_release' EXIT
rm -f "$OUT/control/start" "$OUT/control/quit" "$OUT/host/evidence/live.json" "$OUT/host/evidence/audio-fixture.json"
page_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
LEG_ENV=(GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$page_port" GRC_EXTENSION="$ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
 GRC_UNKNOWN_ITEM=skip GRC_CALIBRATION="$HERE/../calibration/godot-4.5.1-stable-linux-release.json" GRC_MODE=arm GRC_STREAM_VERSION=8
 GRC_AUDIO_ABI_TABLE="$HERE/../calibration/abi/godot-4.5.1-audio-driver.json" GRC_AUDIO=sample
 GRC_LIVE_AUDIO_NO_STORE_BUSES=Private
 GRC_LIVE_TRACKS=audio GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_AUTH=token
 GRC_EVIDENCE_DIR="$OUT/host/evidence" GRC_AUDIO_TEST_CONTROL="$OUT/control"
 GRC_LIVE_TRACK_KEEPALIVE_MS=30000)
start_headless_bg "$OUT/host" -- "$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64" --headless --path "$OUT/prep/project"
host_pid="$BG_PID"
gs_start 640 360 "$OUT/gamescope"
LEG_ENV=()
run_headless "$OUT/client" none -- mise exec -- pnpm exec tsx --conditions=development "$HERE/audio-assets-browser.ts" --out "$OUT" --port "$page_port"
[ "$(cat "$OUT/client/exit-code.txt")" = 0 ]
touch "$OUT/control/quit"
finish_bg "$OUT/host" "$host_pid" 15
[ "$(cat "$OUT/host/exit-code.txt")" = 0 ]
if grep -En 'SCRIPT ERROR|Parse Error|ERROR:' "$OUT/host/stdout.log"; then exit 1; fi
gs_teardown "$OUT/gamescope"
GS_RUN_DIR=""
legs_quiet_summary
