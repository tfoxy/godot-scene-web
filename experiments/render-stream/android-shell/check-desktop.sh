#!/usr/bin/env bash
# Desktop acceptance runner: real pack HTTP, original receiver oracle, private rendered replay.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$RS/../.." && pwd)"
BUILD="$HERE/build"
OUT="$ROOT/artifacts/p0a"
EDITOR="$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64"
only_bad=0
case "${1:-}" in --bad-sha-only) only_bad=1 ;; "") ;; *) echo "usage: $0 [--bad-sha-only]" >&2; exit 2 ;; esac
mkdir -p "$OUT"
if [[ "$only_bad" = 0 ]]; then rm -f "$OUT/desktop-summary.json"; fi
source "$RS/scripts/lib/quiet.sh"
source "$RS/scripts/lib/gamescope.sh"
QUIET_LOG="$OUT/quiet-lock.jsonl"
: > "$QUIET_LOG"
start="$EPOCHREALTIME"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  gs_teardown "$OUT/display"
  quiet_release
  quiet_summary "$OUT" "$(python3 - "$start" "$EPOCHREALTIME" <<'PY'
import sys
print(float(sys.argv[2]) - float(sys.argv[1]))
PY
)"
}
trap cleanup EXIT
quiet_acquire shared p0a-desktop
start_server() {
  local log="$1"
  shift
  python3 "$RS/scripts/serve-android-pack.py" --directory "$BUILD" --port 0 "$@" > "$log" 2>&1 &
  server_pid=$!
  local attempt
  for attempt in {1..100}; do
    base="$(sed -n 's/^pack server: //p' "$log")"
    [[ -n "$base" ]] && return
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
run_headless() {
  local log="$1" data="$2"
  shift 2
  env -u DISPLAY -u WAYLAND_DISPLAY XDG_DATA_HOME="$data" \
    timeout 60 "$EDITOR" --headless --path "$BUILD/shell" -- \
    "--pack-base=$base" --pack-quit "$@" > "$log" 2>&1
}
# A real body must arrive under the incorrect manifest hash: a 404 would not test verification.
rm -rf "$OUT/bad-user-data"
start_server "$OUT/bad-server.log" --bad-sha
bad_rc=0
run_headless "$OUT/bad-sha.log" "$OUT/bad-user-data" || bad_rc=$?
[[ "$bad_rc" = 1 ]] || { echo "bad-sha: expected exit 1, got $bad_rc" >&2; exit 1; }
grep -F '[shell] refused: sha256 mismatch; pack not loaded' "$OUT/bad-sha.log"
if grep -E '\[pack-demo\]|\[shell\] verified pack|SCRIPT ERROR:' "$OUT/bad-sha.log"; then exit 1; fi
stop_server
if [[ "$only_bad" = 1 ]]; then echo '[p0a-desktop] bad-sha passed'; exit 0; fi
rm -rf "$OUT/user-data" "$OUT/oracle"
mkdir -p "$OUT/oracle"
# The unchanged receiver is the rendered oracle, with the same editor, display and recording.
start_server "$OUT/server.log"
gs_start 640 360 "$OUT/display"
gs_launch_godot "$GS_DISPLAY" "$EDITOR" "$RS/receiver" "$OUT/oracle.log" --resolution 640x360 --max-fps 60 --quit-after 1800 -- \
  "--rs-env=RS_RECEIVER_RECORDING=$RS/protocol/golden-8/inline.rs8" \
  "--rs-env=RS_RECEIVER_OUT=$OUT/oracle/applied.json" \
  --rs-env=RS_RECEIVER_STATE_SEQS=6
wait "$GS_LAST_GODOT_PID"
GS_GODOT_ENV=("XDG_DATA_HOME=$OUT/user-data")
gs_launch_godot "$GS_DISPLAY" "$EDITOR" "$BUILD/shell" "$OUT/desktop.log" --rendering-method mobile --rendering-driver vulkan --resolution 640x360 --max-fps 60 --quit-after 1800 -- \
  "--pack-base=$base" "--pack-shot=$OUT/desktop-replay.png" --pack-quit \
  "--rs-env=RS_RECEIVER_OUT=$OUT/pack/applied.json"
godot_pid="$GS_LAST_GODOT_PID"
for attempt in {1..100}; do
  # Wait for the launcher to exec Godot before reading /proc for ownership proof.
  if tr '\0' '\n' < "/proc/$godot_pid/environ" 2>/dev/null | grep -Fxq "DISPLAY=$GS_DISPLAY"; then break; fi
  kill -0 "$godot_pid" 2>/dev/null || { cat "$OUT/desktop.log"; exit 1; }
  sleep 0.05
done
# The process is alive while replay frames are presented; prove display ownership before it exits.
gs_verify_display_ownership "$GS_DISPLAY" "$GS_PID" "$GS_SID" "$godot_pid" "$OUT/display-ownership.json"
wait "$godot_pid"
gs_teardown "$OUT/display"
# A different window aspect must not change the receiver's logical viewport or digest.
gs_start 960 600 "$OUT/display-letterbox"
gs_launch_godot "$GS_DISPLAY" "$EDITOR" "$BUILD/shell" "$OUT/letterbox.log" --rendering-method mobile --rendering-driver vulkan --resolution 960x600 --max-fps 60 --quit-after 1800 -- \
  "--pack-base=$base" "--pack-shot=$OUT/desktop-letterbox.png" --pack-quit \
  "--rs-env=RS_RECEIVER_OUT=$OUT/letterbox/applied.json"
wait "$GS_LAST_GODOT_PID"
gs_teardown "$OUT/display-letterbox"
run_headless "$OUT/cache.log" "$OUT/user-data" "--rs-env=RS_RECEIVER_OUT=$OUT/cached/applied.json"
# Corrupted on-disk cache must be hashed again, then replaced with a verified download.
cache_file="$(find "$OUT/user-data" -name pack.pck -print -quit)"
[[ -n "$cache_file" ]]
printf 'corrupt' > "$cache_file"
run_headless "$OUT/cache-recovery.log" "$OUT/user-data" "--rs-env=RS_RECEIVER_OUT=$OUT/recovered/applied.json"
stop_server
python3 - "$OUT" <<'PY'
import hashlib, json, re, struct, sys
from pathlib import Path
out = Path(sys.argv[1])
state = (out / 'oracle/state/seq-6.json').read_bytes()
assert state.endswith(b'\n')
expected = hashlib.sha256(state[:-1]).hexdigest()
oracle_text = (out / 'oracle.log').read_text()
assert 'SCRIPT ERROR:' not in oracle_text, oracle_text
oracle_errors = re.findall(r'^ERROR:.*', oracle_text, re.M)
for name in ['desktop', 'letterbox', 'cache', 'cache-recovery']:
    text = (out / (name + '.log')).read_text()
    assert 'SCRIPT ERROR:' not in text, text
    if name in ['desktop', 'letterbox']:
        assert re.search(r'Vulkan .* - Forward Mobile - ', text), text
    errors = re.findall(r'^ERROR:.*', text, re.M)
    assert errors == (oracle_errors if name in ['desktop', 'letterbox'] else []), (name, errors, oracle_errors)
    found = re.findall(r'\[pack-demo\] digest=([0-9a-f]{64}) records=(\d+)', text)
    assert found == [(expected, '17')], (name, found, expected)
for name in ['oracle', 'pack', 'letterbox', 'cached', 'recovered']:
    report = json.loads((out / name / 'applied.json').read_text())
    assert report['status'] == 'ok', (name, report.get('failure'))
    assert len(report['transactions']) == 6, name
# The cache leg made no pack GET; the recovery leg made exactly one more.
gets = re.findall(r'GET /client-pack/[0-9a-f]{64}\.pck ', (out / 'server.log').read_text())
assert len(gets) == 2, gets
assert 'cached pack sha256 mismatch; downloading again' in (out / 'cache-recovery.log').read_text()
assert (out / 'desktop-replay.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
letterbox = json.loads((out / 'letterbox/applied.json').read_text())['viewport']
assert letterbox['size'] == [640, 360] and letterbox['size_check'] == 'ok', letterbox
assert letterbox['window_size'] == [960, 600], letterbox
assert struct.unpack('>II', (out / 'desktop-letterbox.png').read_bytes()[16:24]) == (960, 600)
summary = {'passed': 6, 'failed': 0, 'skipped': 0, 'legs': ['bad-sha', 'receiver-oracle', 'desktop-replay', 'letterbox', 'cache', 'cache-recovery'], 'digest': expected, 'records': 17, 'transactions': 6, 'rendered_errors': oracle_errors}
(out / 'desktop-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print('[p0a-desktop] 6/6 passed: digest=' + expected + ' records=17 transactions=6')
PY
