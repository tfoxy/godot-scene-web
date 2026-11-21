#!/usr/bin/env bash
# Pure opt-in checks: no engine, browser, device or remote wrapper is launched.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENE_FIXTURE_DIR="$SCRIPT_DIR/../fixtures/gate6-scene"
source "$SCRIPT_DIR/lib/gate6c-legs.sh"
unset RS_GPU_STRESS G6C_LEGS G6C_STRESS_SELECTION
for leg in gpu-heavy rate-uncapped; do
 ! g6c_wanted "$leg"
 RS_GPU_STRESS=1 g6c_wanted "$leg"
 G6C_LEGS="$leg" g6c_wanted "$leg"
 ! G6C_STRESS_SELECTION='' G6C_LEGS="$leg" g6c_wanted "$leg"
done
g6c_wanted rate-60
echo 'PASS runner default, env, explicit leaf and internal selection (9 assertions)'
python3 - "$SCRIPT_DIR/lib" <<'PY'
import contextlib, importlib.util, io, json, os, subprocess, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('policy', Path(sys.argv[1]) / 'stress-policy.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
for key in ('RS_GPU_STRESS', 'RS_DEVICE_LEGS', 'G6C_LEGS', 'G7R_LEGS'):
    os.environ.pop(key, None)
plan = {'runs': [{'id': 'native-rust-gate6', 'gate': 'gate6'},
                 {'id': 'g7x-device', 'kind': 'g7x'},
                 {'id': 'g7live-gsw-timing', 'groups': ['g7-r']}]}
assert all(s != 'run' for s in p.annotate(plan, set())['runs'][0]['gpu_stress'].values())
assert 'skip_reason' in plan['runs'][1]
assert p.device_allowed('g7x-device', {'g7x-device'})
os.environ['RS_GPU_STRESS'] = '1'
os.environ['RS_DEVICE_LEGS'] = '1'
assert all(s == 'run' for s in p.gpu_legs().values())
assert p.device_allowed('g7x-device', set())
os.environ.pop('RS_GPU_STRESS')
os.environ.pop('RS_DEVICE_LEGS')
os.environ['G7R_LEGS'] = 'rate-uncapped'
assert p.gpu_legs()['rate-uncapped'] == 'run'
assert p.gpu_legs()['gpu-heavy'] != 'run'
os.environ.pop('G7R_LEGS')
with tempfile.TemporaryDirectory() as d:
    path = Path(d) / 'plan.json'
    path.write_text(json.dumps(plan))
    got = subprocess.run([sys.executable, spec.origin, 'local', str(path), '',
                          'native-rust-gate6,g7x-device,g7live-gsw-timing'],
                         capture_output=True, text=True, check=True)
    assert got.stdout.strip() == 'native-rust-gate6,g7live-gsw-timing'
    assert 'refuses g7x-device: device legs: opt-in' in got.stderr
    assert got.stderr.count('gpu stress: opt-in') == 4
print('PASS planner and --and-local refusal policy (10 assertions)')
PY
echo '19 passed, 0 failed, 0 skipped (pure policy assertions)'
