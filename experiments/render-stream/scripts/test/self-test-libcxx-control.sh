#!/usr/bin/env bash
# Exercise driver refusal, gate selection, environment and seam status without Godot or clang.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
S="$TMP/repo/experiments/render-stream/scripts"
mkdir -p "$S/lib" "$TMP/bin"
cp "$HERE/libcxx-control.sh" "$S/"
cp "$HERE/lib/libcxx-verdict.py" "$HERE/lib/tier-verdict.py" "$S/lib/"
cat >"$S/run-gate0.sh" <<'RUN'
set -euo pipefail
args="$*"
out=""; legs=""
while [ "$#" -gt 0 ]; do
    case "$1" in --out) out="$2" ;; --legs) legs="$2" ;; esac
    shift 2
done
[ "$RS_RECEIVER_CORE" = rust ] && [ "$RS_SABOTAGE_TIER" = skip ]
[ "$RS_SKIP_TIMING_GROUPS" = 1 ] && [ -z "${HC_SHADOW:-}" ] && [ -z "${GRC_HC_SHADOW:-}" ]
case "$0" in
    *gate0.sh) [ -z "$legs" ] ;;
    *gate1.sh) [ "$legs" = g1a ] ;;
    *gate2.sh) [ "$legs" = g2a ] ;;
    *gate8.sh) [ "$legs" = g8t ] ;;
esac
mkdir -p "$out"
printf '%s\n' "$args" >>"$TEST_CALLS"
echo recording >"$out/recording.rs2"
case "$0" in
    *gate2.sh)
        passed=true
        case "$out" in */libcxx/gate2) [ "${TEST_GATE2_FAILURE:-0}" = 0 ] || passed=false ;; esac
        printf '{"gate_passed":false,"checks":[{"id":"texture-pixels","passed":%s},{"id":"group-g2b","passed":false,"status":"not-run","detail":"g2b was not in --legs"}]}\n' "$passed" >"$out/result.json"
        exit 1 ;;
esac
echo '{"checks":[{"id":"fixture","passed":true}],"gate_passed":true}' >"$out/result.json"
RUN
for g in 1 2 8; do cp "$S/run-gate0.sh" "$S/run-gate$g.sh"; done
cat >"$TMP/bin/mise" <<'CMP'
#!/usr/bin/env python3
import json, pathlib, sys
assert sys.argv[1:6] == ['exec', '--', 'pnpm', 'exec', 'tsx']
assert '--conditions=development' in sys.argv and '--tree' in sys.argv and '--json' in sys.argv
a, b = map(pathlib.Path, sys.argv[-2:])
rows = [{'a': str(f), 'b': str(b / f.relative_to(a)), 'identical': True, 'differing': []}
        for f in a.rglob('recording.rs2')]
print(json.dumps(rows))
print(f'cmp-rec: {len(rows)}/{len(rows)} identical')
CMP
chmod +x "$TMP/bin/mise"
export PATH="$TMP/bin:$PATH" TEST_CALLS="$TMP/calls"
lib="$(gcc -print-file-name=libstdc++.so)"
printf '[libraries]\nlinux.x86_64 = "%s"\n' "$lib" >"$TMP/test.gdextension"
echo '{}' >"$TMP/cal.json"
args=(--extension "$TMP/test.gdextension" --calibration "$TMP/cal.json")
rc=0
bash "$S/libcxx-control.sh" --extension >"$TMP/missing.log" 2>&1 || rc=$?
[ "$rc" = 2 ]
mkdir "$TMP/nonempty"; touch "$TMP/nonempty/kept"
rc=0
bash "$S/libcxx-control.sh" "${args[@]}" --out "$TMP/nonempty" >"$TMP/nonempty.log" 2>&1 || rc=$?
[ "$rc" = 2 ] && [ -f "$TMP/nonempty/kept" ]
rc=0
HC_SHADOW=1 GRC_HC_SHADOW=1 bash "$S/libcxx-control.sh" "${args[@]}" \
    --seam-libcxx-extension "$TMP/test.gdextension" --out "$TMP/seam" >"$TMP/seam.log" 2>&1 || rc=$?
[ "$rc" = 3 ] || { cat "$TMP/seam.log"; exit 1; }
python3 - "$TMP" <<'PY'
import json, pathlib, shlex, sys
p = pathlib.Path(sys.argv[1])
v = json.loads((p / 'seam/libcxx-control.json').read_text())
assert v['seam'] and v['rc'] == 3 and len(v['files']) == 4
assert all(f['class'] == 'ok' for f in v['files']) and not v['errors']
assert len((p / 'calls').read_text().splitlines()) == 12
calls = [shlex.split(line) for line in (p / 'calls').read_text().splitlines()]
assert [str(pathlib.Path(argv[argv.index('--out') + 1]).relative_to(p / 'seam')) for argv in calls] == [f'{label}/{gate}' for gate in ('gate0', 'gate1', 'gate2', 'gate8') for label in ('gcc-a', 'libcxx', 'gcc-b')]
PY
rc=0
TEST_GATE2_FAILURE=1 bash "$S/libcxx-control.sh" "${args[@]}" --gates gate2:g2a \
    --seam-libcxx-extension "$TMP/test.gdextension" --out "$TMP/real-failure" >"$TMP/real-failure.log" 2>&1 || rc=$?
[ "$rc" = 1 ] || { cat "$TMP/real-failure.log"; exit 1; }
python3 - "$TMP" <<'PYTEST'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]) / 'real-failure'
v = json.loads((p / 'libcxx-control.json').read_text())
assert v['rc'] == 1 and v['errors'] == ['gate2:verdict-parity-failed'], v
assert v['parity'] == [{'gate': 'gate2', 'new_failing': ['texture-pixels']}]
for label in ('gcc-a', 'libcxx', 'gcc-b'):
    tier = json.loads((p / label / 'gate2/tier-verdict.json').read_text())
    assert not tier.get('runner_unexplained'), tier
    assert tier['failing'] == (['texture-pixels'] if label == 'libcxx' else [])
PYTEST
cat >"$TMP/bin/clang++-20" <<'CLANG'
#!/bin/sh
exit 0
CLANG
chmod +x "$TMP/bin/clang++-20"
cat >"$S/build-capture.sh" <<'BUILD'
for i in $(seq 1 45); do echo "file.cpp:$i: error: synthetic build failure $i"; done
exit 1
BUILD
rc=0
bash "$S/libcxx-control.sh" "${args[@]}" --out "$TMP/build-failure" >"$TMP/build-failure.log" 2>&1 || rc=$?
[ "$rc" = 1 ]
python3 - "$TMP" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
output = (p / 'build-failure.log').read_text().splitlines()
errors = [line for line in output if line.startswith('file.cpp:')]
assert errors == [f'file.cpp:{i}: error: synthetic build failure {i}' for i in range(1, 41)], errors
assert len((p / 'build-failure/build-libcxx.log').read_text().splitlines()) == 45
verdict = json.loads((p / 'build-failure/libcxx-control.json').read_text())
assert verdict['rc'] == 1 and 'libcxx-build-failed' in verdict['errors']
PY
echo 'self-test-libcxx-control: 7/7 passed (15 stub legs)'
