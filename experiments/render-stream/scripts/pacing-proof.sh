#!/usr/bin/env bash
# One real-stream phone leg, or 16 legs (4 per load/one-way cell):
#   bash experiments/render-stream/scripts/pacing-proof.sh --core DIR --out DIR \
#     --device-serial SERIAL [--pacing fidelity|balanced|w1..w8] [--gpu-load-hz 30] [--one-way-ms 24] \
#     [--gpu-load-mode coupled|always] \
#     [--scene light|default] [--main-s 180] [--frames N] [--extension FILE] [--device g31] [--rep]
#   ... --matrix [--dry-run]
# Loads: 30/45 Hz; one-way delay: 0/24 ms (added RTT: 0/48 ms).
# Fidelity/balanced order alternates per cell; each gets one repeat. Output:
# <out>/<load Hz>/<one-way ms>/<preset>[-rep]/{host,rx}/...
# Scene light (default): disable mesh/param updates; movers retain fixture defaults.
# GPU load defaults to coupled. Use separate --out roots for different load modes.
# Uses prebuilt capture and client core. No build/download is performed here.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CORE="" OUT="" SERIAL="${ANDROID_SERIAL:-}" DEVICE=g31
EXTENSION="$REPO_ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
SCENE=light
LOAD_MODE=coupled
PRESET=balanced LOAD=30 ONE_WAY=0 MAIN_S=180 FRAMES="" MATRIX=0 DRY=0 REP=""
fail() { echo "pacing-proof: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --matrix) MATRIX=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --rep) REP=-rep; shift ;;
    --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
    --core|--out|--device-serial|--device|--extension|--scene|--pacing|--gpu-load-hz|--gpu-load-mode|--one-way-ms|--main-s|--frames)
      [ $# -ge 2 ] || fail "missing value for $1"
      case "$1" in
        --core) CORE="$2" ;; --out) OUT="$2" ;; --device-serial) SERIAL="$2" ;;
        --device) DEVICE="$2" ;; --extension) EXTENSION="$2" ;; --pacing) PRESET="$2" ;;
        --scene) SCENE="$2" ;;
        --gpu-load-mode) LOAD_MODE="$2" ;;
        --gpu-load-hz) LOAD="$2" ;; --one-way-ms) ONE_WAY="$2" ;;
        --main-s) MAIN_S="$2" ;; --frames) FRAMES="$2" ;;
      esac
      shift 2 ;;
    *) fail "unknown argument $1" ;;
  esac
done
[ -n "$SERIAL" ] || fail "ANDROID_SERIAL or --device-serial is required"
[ -n "$CORE" ] && [ -n "$OUT" ] || fail "--core (prebuilt) and --out are required"
case "$PRESET" in fidelity|balanced|w[1-8]) ;; *) fail "--pacing fidelity|balanced|w1..w8 (w<N>: explicit submitted window N)" ;; esac
case "$SCENE" in light|default) ;; *) fail "--scene light|default" ;; esac
case "$LOAD_MODE" in coupled|always) ;; *) fail "--gpu-load-mode coupled|always" ;; esac
SCENE_ENV=()
[ "$SCENE" != light ] || SCENE_ENV=(RS_SCALE_MESH_UPDATES=0 RS_SCALE_PARAM_UPDATES=0)
python3 - "$LOAD" "$ONE_WAY" "$MAIN_S" "${FRAMES:-1}" <<'PY'
import math, sys
load, delay, seconds, frames = map(float, sys.argv[1:])
if not all(map(math.isfinite, (load, delay, seconds, frames))) or load <= 0 or delay < 0 or seconds <= 0 or frames <= 0 or not frames.is_integer():
    sys.exit("pacing-proof: invalid load, delay, duration or frame count")
PY
CORE="$(realpath -m "$CORE")" OUT="$(realpath -m "$OUT")" EXTENSION="$(realpath -m "$EXTENSION")"
# Allow 180 s for page/device setup, calibration (at most 24 x 2.5 s), and teardown.
# The host runs in real time at 60 fps, and must outlive the receiver's window.
[ -n "$FRAMES" ] || FRAMES="$(python3 -c 'import math,sys; print(math.ceil((float(sys.argv[1])+180)*60))' "$MAIN_S")"
if [ "$DRY" = 0 ]; then
  [ -f "$CORE/build.json" ] && [ -f "$CORE/rs_gsw_wasm_bg.wasm" ] && [ -f "$CORE/rs_gsw_wasm_client.js" ] || fail "--core needs prebuilt build-web.sh output"
  [ -f "$EXTENSION" ] || fail "missing extension: $EXTENSION"
  command -v adb >/dev/null || fail "adb unavailable"
fi
print_command() { printf '%q ' "$@"; printf '\n'; }
run_leg() (
  local preset="$1" load="$2" delay="$3" suffix="$4" rx_cmd rc=0
  local dir="$OUT/$load/$delay/$preset$suffix"
  local credit=(--pacing "$preset")
  case "$preset" in w[1-8]) credit=(--credit-stage submitted --window "${preset#w}") ;; esac
  local rx=(mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/client-device-check.ts"
    --core "$CORE" --device "$DEVICE" --protocol 18 "${credit[@]}"
    --gpu-load-hz "$load" --gpu-load-mode "$LOAD_MODE" --one-way-ms "$delay" --main-s "$MAIN_S" --remounts 0 --attrib-s 0)
  printf -v rx_cmd '%q ' "${rx[@]}"
  # These variables belong to bench-live-scale's receiver environment, expanded there.
  rx_cmd+='--dir "$RS_BENCH_RX_DIR" --port "$RS_BENCH_PAGE_PORT" --ws "$RS_BENCH_WS_URL" --http "$RS_BENCH_HTTP_ORIGIN" --token-file "$RS_BENCH_TOKEN_FILE"'
  local bench=(env "ANDROID_SERIAL=$SERIAL" bash "$SCRIPT_DIR/bench-live-scale.sh"
    --extension "$EXTENSION" --receiver host-only --protocol 18 --window 8
    --frames "$FRAMES" --out "$dir" --rx-cmd "$rx_cmd" -- GRC_LIVE_AUTH=token GRC_LIVE_CREDIT_WINDOW_MAX=8 "${SCENE_ENV[@]}")
  local cleanup=(adb -s "$SERIAL" shell am force-stop com.android.chrome)
  if [ "$DRY" = 1 ]; then
    printf '# scene=%s scene-profile.json RS_SCALE_REPORT=%q' "$SCENE" "$dir/host/scale-report.json"
    [ "${#SCENE_ENV[@]}" = 0 ] || printf ' %q' "${SCENE_ENV[@]}"
    printf '\n'
    print_command "${bench[@]}"
    print_command "${cleanup[@]}"
    exit 0
  fi
  trap '"${cleanup[@]}"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  uptime || exit 2
  bash "$SCRIPT_DIR/lib/quiet.sh" status || exit 2
  python3 -c 'import os,sys; n=os.getloadavg()[0]; sys.exit(f"pacing-proof: load {n:.2f} exceeds 4; defer timing leg" if n > 4 else 0)' || exit 2
  # The previous leg force-stopped Chrome; the DevTools socket exists only while it runs.
  adb -s "$SERIAL" shell am start -a android.intent.action.VIEW -d about:blank com.android.chrome >/dev/null || exit 2
  local up=0
  for _ in $(seq 1 60); do
    adb -s "$SERIAL" shell cat /proc/net/unix 2>/dev/null | grep -q "@chrome_devtools_remote" && up=1 && break
    sleep 0.5
  done
  [ "$up" = 1 ] || { echo "pacing-proof: Chrome DevTools socket not up after 30 s" >&2; exit 2; }
  mkdir -p "$dir"
  # env -i in bench-live-scale gives the host only these RS_SCALE_* settings.
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
if [ "$MATRIX" = 1 ]; then
  presets=(fidelity balanced)
  cell=0
  for load in 30 45; do
    for delay in 0 24; do
      for offset in 0 1; do
        run_leg "${presets[$(((cell + offset) % 2))]}" "$load" "$delay" "" || rc=1
      done
      for offset in 0 1; do
        run_leg "${presets[$(((cell + offset) % 2))]}" "$load" "$delay" -rep || rc=1
      done
      cell=$((cell + 1))
    done
  done
else
  run_leg "$PRESET" "$LOAD" "$ONE_WAY" "$REP" || rc=1
fi
if [ "$DRY" = 0 ]; then
  python3 "$SCRIPT_DIR/lib/pacing-proof-summary.py" "$OUT" || rc=1
fi
exit "$rc"
