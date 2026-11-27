#!/usr/bin/env bash
# Sourced by the remote workflow. Print evidence into the durable job log as well as artifacts.
watchdog_snapshot() {
  local out="$1" reason="$2" w="$RUNNER_TEMP/watchdog" f
  mkdir -p "$w"
  echo "::group::watchdog $reason ($out)"
  {
    date -u
    uptime
    ps -eo pid,ppid,etimes,pcpu,rss,args --forest
    bash experiments/render-stream/scripts/lib/quiet.sh status || true
    # Do not follow source-view symlinks; only this run's newest logs are relevant.
    while IFS= read -r -d '' f; do
      printf '\n--- %s ---\n' "$f"
      tail -c 20000 "$f" || true
    done < <(find "$out" -type f \( -name '*.log' -o -name '*timing.jsonl' \) -printf '%T@ %p\0' 2>/dev/null | sort -zrn | head -z -n 10 | cut -z -d' ' -f2-)
  } 2>&1 | tee "$w/$reason-$(basename "$out").txt"
  echo "::endgroup::"
}
