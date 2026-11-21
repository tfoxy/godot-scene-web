#!/usr/bin/env bash
# Pure calibration regressions: all host/receiver launches are stubs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENE_FIXTURE_DIR="$SCRIPT_DIR/../fixtures/gate6-scene"
HD_FIXTURE_DIR=stub
EXPERIMENT_DIR=stub
source "$SCRIPT_DIR/lib/gate6c-legs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HD_FIXTURE_DIR=stub
G6C_PORT=0
G6C_RECEIVER_PID=0
runs=0
g6c_start_host() { runs=$((runs + 1)); }
g6c_start_receiver() { :; }
g6c_wait_receiver() { :; }
g6c_finish_host() { :; }
passed=0
for scenario in missing unreadable empty zero negative receiver-error receiver-error-with-perf valid ceiling; do
 G6C="$TMP/$scenario"
 perf="$G6C/gpu-heavy-calibration/round-1/receiver/perf.json"
 mkdir -p "$(dirname "$perf")"
 case "$scenario" in
 missing | receiver-error) ;;
 unreadable) echo 'invalid json' >"$perf" ;;
 empty) echo '{"histograms":{"gpu_render_us":{"buckets":[]}}}' >"$perf" ;;
 *)
  gpu=0
  case "$scenario" in negative) gpu=-1 ;; valid | receiver-error-with-perf) gpu=40000 ;; ceiling) gpu=1 ;; esac
  printf '{"histograms":{"gpu_render_us":{"buckets":[[%s,1]]},"frame_interval_us":{"buckets":[[40000,1]]}}}\n' "$gpu" >"$perf"
  ;;
 esac
 case "$scenario" in
 receiver-error | receiver-error-with-perf)
  echo 2 >"${perf%/*}/exit-code.txt"
  printf '%s\n' 'ERROR: generic loader error' '[receiver] error: rs_core.gdextension load_extension returned 1' >"${perf%/*}/stdout.log"
  ;;
 esac
 runs=0
 G6C_BURN_START=8000
 [ "$scenario" != ceiling ] || G6C_BURN_START="$G6C_BURN_CEILING"
 G6C_BURN_ITERATIONS=stale
 if g6c_calibrate_gpu_heavy >"$TMP/$scenario.log" 2>&1; then
  [ "$scenario" = valid ] || { echo "FAIL $scenario: calibration accepted unavailable/unsafe timing"; exit 1; }
  [ "$G6C_BURN_ITERATIONS" = 8000 ]
 else
  [ "$scenario" != valid ] || { cat "$TMP/$scenario.log"; exit 1; }
  [ "$runs" = 1 ]
  [ -z "$G6C_BURN_ITERATIONS" ]
  [ -s "$G6C/gpu-heavy/failed.txt" ]
  if [ "$scenario" != ceiling ]; then
   rg -q 'gpu timing unavailable:' "$G6C/gpu-heavy/failed.txt"
  fi
 fi
 case "$scenario" in
 receiver-error | receiver-error-with-perf)
  rg -Fq 'receiver exited 2: [receiver] error: rs_core.gdextension load_extension returned 1' "$G6C/gpu-heavy/failed.txt"
  ;;
 esac
 passed=$((passed + 1))
 echo "PASS $scenario"
done
echo "$passed passed, 0 failed, 0 skipped (stub calibration only)"
