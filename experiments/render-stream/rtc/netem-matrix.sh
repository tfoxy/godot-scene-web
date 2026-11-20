#!/usr/bin/env bash
# Linux-only RTC send-window matrix, using a private user/network namespace (no sudo).
# Run under quiet.sh exclusive; RTC_MATRIX_LOCK_WAIT_S records that admission wait per result.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ "${1:-}" = --inside ]; then
  shift
  root=$1 delay=$2 budget=$3 out=$4 skip=$5
  cd "$root"
  ip link set lo up
  ip link add rtc0 type dummy
  ip addr add 10.9.0.1/24 dev rtc0
  ip link set rtc0 up
  if [ "$delay" != 0 ]; then
    tc qdisc add dev lo root netem delay "${delay}ms" limit 100000
  fi
  RS_RTC_SEND_BUFFER="$budget" mise exec -- pnpm exec tsx --conditions=development \
    "$root/experiments/render-stream/rtc/run-browsers.ts" --ip 10.9.0.1 \
    --browsers chromium --no-negative --skip "$skip" --conc 64 --get 8388608 --out "$out"
  exit
fi
if [ "${1:-}" = --help ]; then
  echo "usage: $0 [--out /absolute/path/window.json] [--plan] [--stall]"
  exit
fi
out=""
plan=0
mode=window
delays="0 2 10 20"
budgets="262144 524288 1048576"
repeats="1 2"
skip=rtt,sequential
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out=$2; shift 2 ;;
    --plan) plan=1; shift ;;
    --stall) mode=stall; delays=0; budgets=4194304; repeats=1; skip=rtt,sequential,concurrent,get16384; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
out="${out:-$ROOT/.local/rtc-g1/${mode}.json}"
[ "$(uname -s)" = Linux ] || { echo 'Linux user/network namespaces required' >&2; exit 2; }
[[ "$out" = /* ]] || { echo '--out must be an absolute path' >&2; exit 2; }
for delay in $delays; do
  for budget in $budgets; do
    for repeat in $repeats; do
      if [ "$plan" = 1 ]; then
        echo "delay_ms=$delay budget_bytes=$budget repeat=$repeat get_bytes=8388608 skip=$skip"
        continue
      fi
      uptime
      "$ROOT/experiments/render-stream/scripts/lib/quiet.sh" status
      python3 -I - <<'PY'
from pathlib import Path
load = float(Path('/proc/loadavg').read_text().split()[0])
if load > 4:
    raise SystemExit(f"timing refused: one-minute load {load} exceeds 4; rerun when idle")
PY
      mkdir -p "$(dirname "$out")/window-runs"
      raw="$(dirname "$out")/window-runs/d${delay}-b${budget}-r${repeat}.json"
      read -r load1 load5 load15 _ < /proc/loadavg
      rc=0
      unshare -rn -- bash "$0" --inside "$ROOT" "$delay" "$budget" "$raw" "$skip" >"${raw}.log" 2>&1 || rc=$?
      python3 -I - "$out" "$raw" "$delay" "$budget" "$repeat" "$rc" "$load1,$load5,$load15" <<'PY'
import json, os, sys
from pathlib import Path
out, raw = map(Path, sys.argv[1:3])
result = json.loads(out.read_text()) if out.exists() else {"schema":"rtc-window/1", "runs":[]}
browser = json.loads(raw.read_text()) if raw.exists() else {}
phases = browser.get("results", {}).get("chromium", {}).get("phases", {})
row = dict(delay_ms=int(sys.argv[3]), budget_bytes=int(sys.argv[4]), repeat=int(sys.argv[5]),
           rc=int(sys.argv[6]), ok=browser.get("ok", False),
           load_average=[float(n) for n in sys.argv[7].split(",")],
           load_average_after=list(os.getloadavg()),
           lock_wait_s=float(os.environ["RTC_MATRIX_LOCK_WAIT_S"]) if "RTC_MATRIX_LOCK_WAIT_S" in os.environ else None, log=str(raw)+".log", raw=str(raw), phases=phases)
result["runs"].append(row)
result["status"] = "recorded"
result.pop("reason", None)
out.write_text(json.dumps(result, indent=2)+"\n")
print(json.dumps(row))
PY
      [ "$rc" = 0 ] || exit "$rc"
    done
  done
done
