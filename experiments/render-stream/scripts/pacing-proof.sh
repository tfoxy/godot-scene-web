#!/usr/bin/env bash
# Real-stream pacing proof with a prebuilt capture extension and client core.
# --core DIR --out DIR [--device desktop|g31|g86] [--device-serial SERIAL]
# --pacing fidelity|balanced|saver|w1..w8
# --gpu-load-hz none|N --one-way-ms N --host-fps N --publish-fps N
# --gpu-load-mode coupled|always --scene light|default --main-s N --frames N
# --matrix (legacy fidelity/balanced repeats), or --saver-matrix (four ordered arms)
# --loads none,45 --delays 0,24 override matrix cells; --dry-run prints commands.
# Saver matrix Sunaligned uses --publish-fps (default 30; set to round(panelHz/k)).
# Output: <out>/<load>/<one-way>/<arm>-h<host fps>-p<publish fps|none>[-rep].
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CORE="" OUT="" SERIAL="${ANDROID_SERIAL:-}" DEVICE=g31
EXTENSION="$REPO_ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
SCENE=light LOAD_MODE=coupled PRESET=balanced LOAD=30 ONE_WAY=0 MAIN_S=180 FRAMES=""
MATRIX=0 SAVER_MATRIX=0 DRY=0 REP="" HOST_FPS=60 PUBLISH_FPS="" LOADS="" DELAYS=0,24
fail() { echo "pacing-proof: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --matrix) MATRIX=1; shift ;;
    --saver-matrix) SAVER_MATRIX=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --rep) REP=-rep; shift ;;
    --help|-h) sed -n '2,10p' "$0"; exit 0 ;;
    --core|--out|--device-serial|--device|--extension|--scene|--pacing|--gpu-load-hz|--gpu-load-mode|--one-way-ms|--main-s|--frames|--host-fps|--publish-fps|--loads|--delays)
      [ $# -ge 2 ] || fail "missing value for $1"
      case "$1" in
        --core) CORE="$2" ;; --out) OUT="$2" ;; --device-serial) SERIAL="$2" ;;
        --device) DEVICE="$2" ;; --extension) EXTENSION="$2" ;; --pacing) PRESET="$2" ;;
        --scene) SCENE="$2" ;; --gpu-load-mode) LOAD_MODE="$2" ;;
        --gpu-load-hz) LOAD="$2" ;; --one-way-ms) ONE_WAY="$2" ;;
        --main-s) MAIN_S="$2" ;; --frames) FRAMES="$2" ;;
        --host-fps) HOST_FPS="$2" ;; --publish-fps) PUBLISH_FPS="$2" ;;
        --loads) LOADS="$2" ;; --delays) DELAYS="$2" ;;
      esac
      shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done
[ "$DEVICE" = desktop ] || [ -n "$SERIAL" ] || fail "ANDROID_SERIAL or --device-serial is required"
[ -n "$CORE" ] && [ -n "$OUT" ] || fail "--core (prebuilt) and --out are required"
[ "$MATRIX$SAVER_MATRIX" != 11 ] || fail "choose --matrix or --saver-matrix"
case "$DEVICE" in desktop|g31|g86) ;; *) fail "--device desktop|g31|g86" ;; esac
case "$PRESET" in fidelity|balanced|saver|w[1-8]) ;; *) fail "--pacing fidelity|balanced|saver|w1..w8" ;; esac
case "$SCENE" in light|default) ;; *) fail "--scene light|default" ;; esac
case "$LOAD_MODE" in coupled|always) ;; *) fail "--gpu-load-mode coupled|always" ;; esac
[ -n "$LOADS" ] || { if [ "$SAVER_MATRIX" = 1 ]; then LOADS=none,45; else LOADS=30,45; fi; }
IFS=, read -ra MATRIX_LOADS <<< "$LOADS"
IFS=, read -ra MATRIX_DELAYS <<< "$DELAYS"
python3 - "$LOAD" "$ONE_WAY" "$MAIN_S" "${FRAMES:-1}" "$HOST_FPS" "${PUBLISH_FPS:-30}" "$LOADS" "$DELAYS" <<'PY'
import math, sys
load, delay, seconds, frames, host, publish, loads, delays = sys.argv[1:]
def number(v, lower=0, integer=False):
    f=float(v)
    return math.isfinite(f) and f > lower and (not integer or f.is_integer())
try:
    assert load == 'none' or number(load)
    assert math.isfinite(float(delay)) and float(delay) >= 0
    assert number(seconds) and number(frames, integer=True)
    assert number(host, integer=True) and number(publish, integer=True) and float(publish) <= 240
    assert all(v == 'none' or number(v) for v in loads.split(','))
    assert all(math.isfinite(float(v)) and float(v) >= 0 for v in delays.split(','))
except (ValueError, AssertionError):
    sys.exit('pacing-proof: invalid load, delay, duration, fps or frame count')
PY
SCENE_ENV=()
[ "$SCENE" != light ] || SCENE_ENV=(RS_SCALE_MESH_UPDATES=0 RS_SCALE_PARAM_UPDATES=0)
CORE="$(realpath -m "$CORE")" OUT="$(realpath -m "$OUT")" EXTENSION="$(realpath -m "$EXTENSION")"
if [ "$DRY" = 0 ]; then
  [ -f "$CORE/build.json" ] && [ -f "$CORE/rs_gsw_wasm_bg.wasm" ] && [ -f "$CORE/rs_gsw_wasm_client.js" ] || fail "--core needs prebuilt build-web.sh output"
  [ -f "$EXTENSION" ] || fail "missing extension: $EXTENSION"
  [ "$DEVICE" = desktop ] || command -v adb >/dev/null || fail "adb unavailable"
fi
print_command() { printf '%q ' "$@"; printf '\n'; }
run_leg() (
  local preset="$1" load="$2" delay="$3" suffix="$4" host_fps="$5" publish_fps="$6" arm="$7" rx_cmd rc=0
  local dir="$OUT/$load/$delay/$arm-h$host_fps-p${publish_fps:-none}$suffix"
  local frames="${FRAMES:-$(python3 -c 'import math,sys; print(math.ceil((float(sys.argv[1])+180)*int(sys.argv[2])))' "$MAIN_S" "$host_fps")}"
  local credit=(--pacing "$preset")
  case "$preset" in w[1-8]) credit=(--credit-stage submitted --window "${preset#w}") ;; esac
  local rx=(mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/client-device-check.ts"
    --core "$CORE" --device "$DEVICE" --protocol 18 "${credit[@]}"
    --gpu-load-hz "$load" --gpu-load-mode "$LOAD_MODE" --one-way-ms "$delay" --main-s "$MAIN_S" --remounts 0 --attrib-s 0)
  printf -v rx_cmd '%q ' "${rx[@]}"
  rx_cmd+='--dir "$RS_BENCH_RX_DIR" --port "$RS_BENCH_PAGE_PORT" --ws "$RS_BENCH_WS_URL" --http "$RS_BENCH_HTTP_ORIGIN" --token-file "$RS_BENCH_TOKEN_FILE"'
  local publish_env=()
  [ -z "$publish_fps" ] || publish_env=("GRC_PUBLISH_FPS=$publish_fps")
  local bench=(env "ANDROID_SERIAL=$SERIAL" bash "$SCRIPT_DIR/bench-live-scale.sh"
    --extension "$EXTENSION" --receiver host-only --protocol 18 --window 8 --max-fps "$host_fps"
    --frames "$frames" --out "$dir" --rx-cmd "$rx_cmd" -- GRC_LIVE_AUTH=token GRC_LIVE_CREDIT_WINDOW_MAX=8 "${publish_env[@]}" "${SCENE_ENV[@]}")
  if [ "$DRY" = 1 ]; then
    printf '# arm=%s load=%s one-way=%s host-fps=%s publish-fps=%s\n' "$arm" "$load" "$delay" "$host_fps" "${publish_fps:-none}"
    print_command "${bench[@]}"
    if [ "$DEVICE" != desktop ]; then print_command adb -s "$SERIAL" shell am force-stop com.android.chrome; fi
    exit 0
  fi
  if [ "$DEVICE" != desktop ]; then
    trap 'adb -s "$SERIAL" shell am force-stop com.android.chrome' EXIT
  fi
  trap 'exit 130' INT
  trap 'exit 143' TERM
  uptime || exit 2
  bash "$SCRIPT_DIR/lib/quiet.sh" status || exit 2
  python3 -c 'import os,sys; n=os.getloadavg()[0]; sys.exit(f"pacing-proof: load {n:.2f} exceeds 3.5; defer timing leg" if n > 3.5 else 0)' || exit 2
  if [ "$DEVICE" != desktop ]; then
    adb -s "$SERIAL" shell am start -a android.intent.action.VIEW -d about:blank com.android.chrome >/dev/null || exit 2
    local up=0
    for _ in $(seq 1 60); do
      adb -s "$SERIAL" shell cat /proc/net/unix 2>/dev/null | grep -q "@chrome_devtools_remote" && up=1 && break
      sleep 0.5
    done
    [ "$up" = 1 ] || { echo "pacing-proof: Chrome DevTools socket not up after 30 s" >&2; exit 2; }
  fi
  mkdir -p "$dir"
  python3 - "$dir/scene-profile.json" "$SCENE" "RS_SCALE_REPORT=$dir/host/scale-report.json" "${SCENE_ENV[@]}" <<'PYSCENE'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "profile": sys.argv[2], "rs_scale_env": dict(kv.split("=", 1) for kv in sys.argv[3:])
}, indent=2) + "\n")
PYSCENE
  "${bench[@]}" || rc=$?
  exit "$rc"
)
rc=0
if [ "$SAVER_MATRIX" = 1 ]; then
  for load in "${MATRIX_LOADS[@]}"; do
    for delay in "${MATRIX_DELAYS[@]}"; do
      run_leg fidelity "$load" "$delay" "$REP" 60 "" F60 || rc=1
      run_leg fidelity "$load" "$delay" "$REP" 144 "" F144 || rc=1
      run_leg saver "$load" "$delay" "$REP" 60 "" Saver || rc=1
      run_leg saver "$load" "$delay" "$REP" 60 "${PUBLISH_FPS:-30}" Sunaligned || rc=1
    done
  done
elif [ "$MATRIX" = 1 ]; then
  presets=(fidelity balanced)
  cell=0
  for load in "${MATRIX_LOADS[@]}"; do
    for delay in "${MATRIX_DELAYS[@]}"; do
      for suffix in "" -rep; do
        for offset in 0 1; do
          preset="${presets[$(((cell + offset) % 2))]}"
          run_leg "$preset" "$load" "$delay" "$suffix" "$HOST_FPS" "$PUBLISH_FPS" "$preset" || rc=1
        done
      done
      cell=$((cell + 1))
    done
  done
else
  run_leg "$PRESET" "$LOAD" "$ONE_WAY" "$REP" "$HOST_FPS" "$PUBLISH_FPS" "$PRESET" || rc=1
fi
if [ "$DRY" = 0 ]; then python3 "$SCRIPT_DIR/lib/pacing-proof-summary.py" "$OUT" || rc=1; fi
exit "$rc"
