#!/usr/bin/env bash
# Real-time Godot -> capture -> playground check. No desktop display or downloads.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/experiments/render-stream/scripts"
OUT="${1:?usage: run.sh /absolute/ignored-output [--self-test-only|--sabotage-unannounced|--sabotage-disabled]}"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
[ ! -e "$OUT/start" ] || { echo "client-tweens: use a fresh output directory" >&2; exit 2; }
BINARY="${GODOT_TEMPLATE:-$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64}"
EXTENSION="$REPO_ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
CALIBRATION="$REPO_ROOT/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
LEGS_LOG=client-tweens
HEADLESS_TIMEOUT_S=60
RENDERED_TIMEOUT_S=60
HAVE_STRACE=0
GATE7_LIVE_KIND=""
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
cleanup() {
  if [ -n "${CURRENT_CHILD_PID:-}" ]; then
    kill "$CURRENT_CHILD_PID" 2>/dev/null || true
    wait "$CURRENT_CHILD_PID" 2>/dev/null || true
  fi
  quiet_release || true
  legs_quiet_summary || true
}
trap cleanup EXIT
mkdir -p "$OUT/project/scripts"
cp "$REPO_ROOT/godot/project/scripts/announced_tween.gd" "$REPO_ROOT/godot/project/scripts/client_tweens_check.gd" "$OUT/project/scripts/"
cat > "$OUT/project/project.godot" <<'PROJECT'
config_version=5
[application]
run/main_scene="res://main.tscn"
[display]
window/size/viewport_width=640
window/size/viewport_height=360
window/stretch/mode="canvas_items"
window/vsync/vsync_mode=0
[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.1, 0.13, 0.2, 1)
PROJECT
cat > "$OUT/project/main.tscn" <<'SCENE'
[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://scripts/client_tweens_check.gd" id="1"]
[node name="ClientTweensCheck" type="Node"]
script = ExtResource("1")
SCENE
if [ "${2:-}" = --sabotage-unannounced ]; then
  # A deliberate negative control: native Godot motion remains, helper announcements disappear.
  sed -i 's/if Engine.has_singleton("RenderStreamCapture"):/if false:/' "$OUT/project/scripts/announced_tween.gd"
fi
LEG_ENV=()
run_headless "$OUT/import" none -- mise exec -- godot --headless --editor --path "$OUT/project" --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
run_headless "$OUT/helper" none -- mise exec -- godot --headless --max-fps 60 --path "$OUT/project" -- --self-test
[ "$(cat "$OUT/helper/exit-code.txt")" = 0 ]
grep -q 'helper: 9 assertions passed' "$OUT/helper/stdout.log"
if [ "${2:-}" = --self-test-only ]; then exit 0; fi
# Build the final core revision, including the client's factory glue and build.json.
mise exec -- "$REPO_ROOT/packages/render-stream-client/scripts/build-web.sh" "$OUT/core" > "$OUT/core-build.log" 2>&1
uptime > "$OUT/uptime.txt"
bash "$SCRIPT_DIR/lib/quiet.sh" status > "$OUT/quiet-before.txt"
python3 - <<'PY'
import os
load = os.getloadavg()[0]
if load > 4:
    raise SystemExit(f"client-tweens: real-time leg deferred: load {load:.2f} > 4")
PY
PAGE_PORT="$(legs_free_port)"
LEGS_TIMING_GROUP=client-tweens
LEG_ENV=(GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
  GRC_EVIDENCE_DIR="$OUT/host/evidence" GRC_LIVE_LISTEN=127.0.0.1:0
  GRC_STREAM_VERSION=17 GRC_PUBLISH_FPS=10 GRC_LIVE_AUTH=none GRC_LIVE_MAX_CONNECTIONS=2
  GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$PAGE_PORT"
  GRC_ROOT_SIZE=presentation:640x360 GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip
  GRC_VALIDATION_LOG=on TWEEN_CHECK_OUT="$OUT")
mkdir -p "$OUT/host/evidence"
start_headless_bg "$OUT/host" -- "$BINARY" --headless --max-fps 60 --path "$OUT/project"
pid="$BG_PID"
CURRENT_CHILD_PID="$pid"
port=""
for ((i=0;i<600;i++)); do
  if [ -f "$OUT/host/evidence/live.json" ]; then
    port="$(python3 - "$OUT/host/evidence/live.json" <<'PY'
import json, sys
try:
    j=json.load(open(sys.argv[1])); print(j.get('port', '') if j.get('status') == 'listening' else '')
except (ValueError, OSError): pass
PY
)"
  fi
  [ -z "$port" ] || break
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.05
done
[ -n "$port" ] || { cat "$OUT/host/stdout.log"; exit 1; }
rc=0
mise exec -- pnpm exec tsx --conditions=development "$HERE/check.ts" "$OUT" "$port" "$PAGE_PORT" "${2:-}" > "$OUT/browser.log" 2>&1 || rc=$?
finish_bg "$OUT/host" "$pid" 60
CURRENT_CHILD_PID=""
[ "$(cat "$OUT/host/exit-code.txt")" = 0 ] || rc=1
cat "$OUT/browser.log"
exit "$rc"
