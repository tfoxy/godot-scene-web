#!/usr/bin/env bash
# Audio WT correctness through impaired UDP, in the private headless gamescope session.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(realpath "$SCRIPT_DIR/../../..")"
OUT="$(realpath -m "${2:-$REPO_ROOT/.local/audio-wt-browser}")"
if [ "$#" -gt 0 ] && { [ "$1" != --out ] || [ "$#" != 2 ]; }; then echo 'usage: run-audio-wt-browser.sh [--out DIR]' >&2; exit 2; fi
mkdir -p "$OUT"
LEGS_LOG=audio-wt-browser
HEADLESS_TIMEOUT_S=120
RENDERED_TIMEOUT_S=120
source "$SCRIPT_DIR/lib/gamescope.sh"
source "$SCRIPT_DIR/lib/legs.sh"
trap 'if [ -n "$CURRENT_CHILD_PID" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; fi; if [ -n "$GS_RUN_DIR" ]; then gs_teardown "$GS_RUN_DIR" || true; fi; quiet_release' EXIT
uptime > "$OUT/uptime.txt"
quiet__status_cmd > "$OUT/quiet-status.txt"
gs_start 640 360 "$OUT/gamescope"
run_headless "$OUT/leg" none -- mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/audio-wt-browser.ts" --out "$OUT/evidence"
gs_teardown "$OUT/gamescope"
GS_RUN_DIR=""
legs_quiet_summary
[ "$(cat "$OUT/leg/exit-code.txt")" = 0 ]
