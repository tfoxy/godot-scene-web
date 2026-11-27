#!/usr/bin/env bash
set -euo pipefail
WT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/../../../..")"
TMP=$(mktemp -d)
trap 'rc=$?; if [ "$rc" != 0 ]; then echo "FAIL watchdog regression (exit $rc)"; fi; rm -rf "$TMP"' EXIT
export RUNNER_TEMP="$TMP"
mkdir -p "$TMP/v/job/run/leg"
printf 'newest leg output\n' > "$TMP/v/job/run/leg/stdout.log"
source "$WT/experiments/render-stream/scripts/lib/watchdog-diagnostics.sh"
watchdog_snapshot "$TMP/v" pre-deadline > "$TMP/pre.log"
watchdog_snapshot "$TMP/v" killed > "$TMP/kill.log"
for file in "$TMP/pre.log" "$TMP/kill.log"; do
 grep -Eq '::group::watchdog' "$file"
 grep -Eq 'ELAPSED' "$file"
 grep -Eq '^newest leg output$' "$file"
 grep -Eq '::endgroup::' "$file"
done
echo 'PASS pre-deadline and kill snapshots print process ages/arguments and newest leg log'
# Execute the ACTUAL workflow vi function under errexit: a timed-out single run still reports.
python3 - "$WT/.github/workflows/remote-validate.yml" "$TMP/vi.sh" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
a=s.index('          vi() {');b=s.index('          if [ -z "$REPEAT" ]; then',a)
Path(sys.argv[2]).write_text('\n'.join(line[10:] for line in s[a:b].splitlines())+'\n')
PY
rc=0
bash -e -c '
 source "$1/experiments/render-stream/scripts/lib/watchdog-diagnostics.sh"
 WATCHDOG_MIN=35
 timeout() { return 124; }
 source "$2/vi.sh"
 vi "$2/v"
' _ "$WT" "$TMP" > "$TMP/vi.log" 2>&1 || rc=$?
[ "$rc" = 124 ]
grep -Eq '::error::watchdog:' "$TMP/vi.log"
grep -Eq '::group::watchdog killed' "$TMP/vi.log"
grep -Eq '^newest leg output$' "$TMP/vi.log"
echo 'PASS single-run errexit preserves timeout status and durable kill diagnostics'
# Native leg helper writes directly to a private log; normal redirected runner output is separate.
python3 - "$WT/experiments/render-stream/scripts/lib/legs.sh" "$TMP/heartbeat.sh" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text();a=s.index('legs_heartbeat() {');b=s.index('\n}',a)+2
Path(sys.argv[2]).write_text(s[a:b]+'\n')
PY
RS_PHASE_LOG="$TMP/heartbeat.log"
source "$TMP/heartbeat.sh"
legs_heartbeat leg start gate6/receiver > "$TMP/redirected.log"
legs_heartbeat leg end gate6/receiver >> "$TMP/redirected.log"
grep -Eq 'leg start gate6/receiver' "$TMP/heartbeat.log"
grep -Eq 'leg end gate6/receiver' "$TMP/heartbeat.log"
[ ! -s "$TMP/redirected.log" ]
echo 'PASS native leg heartbeats survive runner output redirection'
