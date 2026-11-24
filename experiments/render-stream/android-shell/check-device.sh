#!/usr/bin/env bash
# Device acceptance uses only the locked phone wrapper; ANDROID_SERIAL selects the leased device.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RS/../.." && pwd)"
OUT="$ROOT/artifacts/p0a"
[[ $# = 0 ]] || { echo "usage: ANDROID_SERIAL=<serial> $0" >&2; exit 2; }
: "${ANDROID_SERIAL:?set ANDROID_SERIAL to the leased device}"
[[ -f "$OUT/desktop-summary.json" ]] || { echo 'run check-desktop.sh first' >&2; exit 1; }
# A failed screenshot must not reuse evidence left by an earlier leg.
rm -f "$OUT/device-summary.json" "$OUT/device/device-replay.png"
server_pid=""
start="$EPOCHREALTIME"
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start_server() {
  local log="$1"
  shift
  python3 "$RS/scripts/serve-android-pack.py" --port 8765 "$@" > "$log" 2>&1 &
  server_pid=$!
  for attempt in {1..100}; do
    if grep -q '^pack server: ' "$log"; then return; fi
    kill -0 "$server_pid" 2>/dev/null || { cat "$log"; return 1; }
    sleep 0.1
  done
  echo 'pack server failed to become ready' >&2
  return 1
}
stop_server() {
  kill "$server_pid"
  wait "$server_pid" 2>/dev/null || true
  server_pid=""
}
start_server "$OUT/device-server.log"
"$ROOT/scripts/phone-leg.sh" run --pkg dev.gsw.shellspike --apk "$HERE/build/shell.apk" \
  --clear-data --reverse tcp:8765 --seconds 60 --shot 20:device-replay.png \
  --until-log '\[pack-demo\] digest=' --out "$OUT/device"
stop_server
start_server "$OUT/device-bad-server.log" --bad-sha
"$ROOT/scripts/phone-leg.sh" run --pkg dev.gsw.shellspike --reverse tcp:8765 --seconds 60 \
  --until-log '\[shell\] refused: sha256 mismatch; pack not loaded' --out "$OUT/device-bad-sha"
stop_server
# Preserve the successful leg's cache; the bad-sha leg must not replace it.
start_server "$OUT/device-cache-server.log"
"$ROOT/scripts/phone-leg.sh" run --pkg dev.gsw.shellspike --reverse tcp:8765 --seconds 60 \
  --until-log '\[pack-demo\] digest=' --out "$OUT/device-cache"
stop_server
python3 - "$OUT" "$start" "$EPOCHREALTIME" <<'PY'
import json, re, sys
from pathlib import Path
out = Path(sys.argv[1])
expected = json.loads((out / 'desktop-summary.json').read_text())['digest']
for name in ['device', 'device-cache']:
    text = (out / name / 'logcat-app.txt').read_text()
    for marker in ['[shell] sha256 verified:', '[shell] load_resource_pack succeeded:',
                   '[pack-demo] RsCore instantiated by pack']:
        assert marker in text, (name, marker)
    assert 'SCRIPT ERROR:' not in text, text
    found = re.findall(r'\[pack-demo\] digest=([0-9a-f]{64}) records=(\d+)', text)
    assert found == [(expected, '17')], (name, found, expected)
    assert ('[shell] cache hit sha256=' if name == 'device-cache' else '[shell] downloading pack sha256=') in text
bad = (out / 'device-bad-sha/logcat-app.txt').read_text()
assert '[shell] refused: sha256 mismatch; pack not loaded' in bad, bad
assert '[pack-demo]' not in bad and '[shell] load_resource_pack succeeded:' not in bad, bad
for name, count in [('device', 1), ('device-bad', 1), ('device-cache', 0)]:
    log = (out / (name + '-server.log')).read_text()
    assert 'GET /client-pack/manifest.json ' in log, log
    gets = re.findall(r'GET /client-pack/[0-9a-f]{64}\.pck ', log)
    assert len(gets) == count, (name, gets)
assert (out / 'device/device-replay.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
summary = {'passed': 3, 'failed': 0, 'skipped': 0, 'legs': ['download', 'bad-sha', 'cache'],
           'digest': expected, 'records': 17, 'wall_s': float(sys.argv[3]) - float(sys.argv[2]),
           'lock_wait_s': None, 'lock_note': 'phone-leg.sh serializes legs but does not report wait time'}
(out / 'device-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('[p0a-device] 3/3 passed: digest=' + expected + ' records=17')
PY
