#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Pure swap-driver guards: synthetic evidence and parsed runner env, no engine launch.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "wswap-guards-"));
let passed = 0;
let failed = 0;
try {
  const child = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      String.raw`
import contextlib, importlib.util, io, json, re, shlex, shutil, sys
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('driver', sys.argv[1])
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
root = Path(sys.argv[2])
repo = Path(sys.argv[3])
results = []
def check(name, ok): results.append([name, bool(ok)])
def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')
def fixture():
    if root.exists(): shutil.rmtree(root)
    for leg in d.LEGS:
        run = root / 'g8sw/short' / leg
        put(run / 'leg.json', {'exit': 0, 'wall_s': 1.25})
        (run / 'exit-code.txt').write_text('0')
        (run / 'stdout.log').write_text('normal host output\n')
        put(run / 'evidence/swap-cycle.jsonl', {'phase': 'armed', 'net_module': False})
    put(root / 'checker.json', {'passed': True, 'checks': [{'id': c, 'passed': True, 'detail': 'synthetic pass'} for c in d.CHECKS]})
    put(root / 'checker-exit.json', 0)
    put(root / 'wswap-summary.json', d.make_summary(root, {'template_sha256': 'a' * 64, 'target': 'linux'}))
def failures(code=0): return [name for name, ok, _ in d.evaluate(root, code) if not ok]
fixture()
check('valid seven-leg evidence and nine checker results', failures() == [])
check('valid Linux success summary', d.summary_problems(d.read_json(root / 'wswap-summary.json')) == [])
for leg in d.LEGS:
    fixture()
    run = root / 'g8sw/short' / leg
    (run / 'exit-code.txt').unlink()
    check(leg + ': missing exit fails only exit', failures() == [leg + '/exit'])
    fixture()
    (run / 'exit-code.txt').write_text('1')
    check(leg + ': nonzero exit fails only exit', failures() == [leg + '/exit'])
    for label in ('scale', 'fixture'):
        fixture()
        (run / 'stdout.log').write_text('[' + label + '] error: synthetic sabotage\n')
        check(leg + ': ' + label + ' error fails only fixture-errors', failures() == [leg + '/fixture-errors'])
    fixture()
    put(run / 'evidence/swap-cycle.jsonl', {'phase': 'armed', 'net_module': True})
    check(leg + ': armed net_module true fails only net-module', failures() == [leg + '/net-module'])
    fixture()
    (run / 'evidence/swap-cycle.jsonl').write_text('')
    check(leg + ': zero rows fails net-module', failures() == [leg + '/net-module'])
fixture()
shutil.rmtree(root / 'g8sw')
check('zero leg tree fails even with successful synthetic checker', len(failures()) == 2 * len(d.LEGS))
fixture()
check('checker nonzero exit fails only checker-exit', failures(1) == ['checker-exit'])
for mutation in ('missing', 'empty', 'absent-id', 'false-check', 'false-overall'):
    fixture()
    report = d.read_json(root / 'checker.json')
    if mutation == 'missing': (root / 'checker.json').unlink()
    else:
        if mutation == 'empty': report['checks'] = []
        elif mutation == 'absent-id': report['checks'].pop()
        elif mutation == 'false-check': report['checks'][0]['passed'] = False
        else: report['passed'] = False
        put(root / 'checker.json', report)
    check('checker ' + mutation + ' fails only checker-results', failures() == ['checker-results'])
fixture()
(root / 'g8sw/short/swap/evidence/swap-cycle.jsonl').write_text('{bad json')
check('malformed swap rows fail only net-module', failures() == ['swap/net-module'])
fixture()
put(root / 'g8sw/short/swap/evidence/swap-cycle.jsonl', {'phase': 'armed'})
check('missing net_module fails only net-module', failures() == ['swap/net-module'])
fixture()
summary = d.read_json(root / 'wswap-summary.json')
for key in summary:
    value = {k: v for k, v in summary.items() if k != key}
    check('summary missing ' + key + ' fails by name', d.summary_problems(value) == ['summary/' + key])
check('missing summary file fails closed', d.summary_problems(None) == ['summary missing'])
for key, value in [('legs', {}), ('checks', []), ('template_sha256', 'bad'), ('platform', 'other')]:
    bad = dict(summary); bad[key] = value
    check('summary invalid ' + key + ' fails by name', d.summary_problems(bad) == ['summary/' + key])
windows = dict(summary, platform='windows', tsc_invariant=False, tsc_hz=2.4e9)
check('Windows reports non-invariant TSC without refusing', d.summary_problems(windows) == [])
for key in ('tsc_invariant', 'tsc_hz'):
    bad = dict(windows); bad[key] = None
    check('Windows missing ' + key + ' fails by name', d.summary_problems(bad) == ['summary/' + key])
fixture()
config = root / 'config.json'
put(config, {'target': 'linux'})
with patch.object(sys, 'argv', ['driver', '--config', str(config), '--evaluate-only', str(root)]), contextlib.redirect_stdout(io.StringIO()):
    check('evaluate-only valid tree exits zero', d.main() == 0)
(root / 'wswap-summary.json').unlink()
with patch.object(sys, 'argv', ['driver', '--config', str(config), '--evaluate-only', str(root)]), contextlib.redirect_stdout(io.StringIO()):
    check('evaluate-only missing summary exits nonzero', d.main() == 1)
# Resolve shell array words and variables as data, never source or execute the runner.
runner = (repo / 'experiments/render-stream/scripts/run-gate8.sh').read_text()
legs = (repo / 'experiments/render-stream/scripts/lib/legs.sh').read_text()
arrays = {}
for name in ('SCALE_MIRROR_ENV', 'G8A_VLC_ENV', 'G8SW_ENV'):
    match = re.search(r'^' + name + r'=\((.*?)\)', runner, re.M | re.S)
    assert match, name
    words = shlex.split(match[1], comments=True)
    arrays[name] = []
    for word in words:
        ref = re.fullmatch(r'\$\{(\w+)\[@\]\}', word)
        arrays[name].extend(arrays[ref[1]] if ref else [word])
body = re.search(r'^run_capture\(\) \{(.*?)^\}', legs, re.M | re.S)[1]
base_words = shlex.split(re.search(r'LEG_ENV=\((.*?)\)', body, re.S)[1], comments=True)
# Include the store, no patch, nonempty quit, and CAPTURE_EXTRA_ENV as run_g8sw_leg does.
append = re.findall(r'LEG_ENV\+=\((.*?)\)', body, re.S)
check('run_capture env append structure guarded', len(append) == 4 and [shlex.split(x)[0].split('=')[0] for x in append[:3]] == ['GRC_RESOURCE_STORE_DIR', 'GRC_STREAM_PATCH_OUT', 'RS_FIXTURE_QUIT_FRAME'] and shlex.split(append[3]) == ['$' + '{CAPTURE_EXTRA_ENV[@]}'])
run_body = re.search(r'^run_g8sw_leg\(\) \{(.*?)^\}', runner, re.M | re.S)[1]
extra_words = shlex.split(re.search(r'CAPTURE_EXTRA_ENV=\((.*?)\)', run_body, re.S)[1])
base = Path('/bundle/wswap')
run = Path('/output/g8sw/short/swap')
config = {'target': 'linux', 'extension': '../w1/ext/capture.gdextension', 'record': '../w1/calibration/record.json'}
variables = {'armed': '240', 'idle': '240', 'n': '3', 'EXTENSION': str(base / config['extension']), 'CALIBRATION': str(base / config['record']), 'dir': str(run), 'RECORDING_NAME': 'recording.rs8', 'store': str(run / 'store'), 'quit': str(d.quit_frames('swap'))}
def resolve(word):
    return re.sub(r'\$(\w+)|\$\{(\w+)\}', lambda m: variables[m[1] or m[2]], word)
expected = {}
branches = re.search(r'if \[ \"\$kind\" = control \]; then(.*?)\n\telse(.*?)\n\tfi', run_body, re.S)
assert branches, 'swap/control env branches'
swap_words = shlex.split(re.search(r'CAPTURE_EXTRA_ENV\+=\((.*?)\)', branches[2], re.S)[1])
prealloc = shlex.split(re.search(r'CAPTURE_EXTRA_ENV\+=\((RS_SCALE_PREALLOC_FRAMES=.*?)\)', run_body, re.S)[1])
check('run_g8sw extra env expansion and forwarding guarded', extra_words[0] == '$' + '{G8SW_ENV[@]}' and prealloc[-1] == '$@')
for word in base_words + shlex.split(append[0]) + shlex.split(append[2]) + arrays['G8SW_ENV'] + extra_words[1:] + swap_words + prealloc[:-1]:
    k, v = resolve(word).split('=', 1); expected[k] = v
actual = d.leg_env(base, config, run, 'swap')
check('Linux env equals parsed G8SW/G8A_VLC/SCALE_MIRROR/run_capture words', actual == expected)
config['target'] = 'windows'
win = d.leg_env(base, config, run, 'swap')
check('Windows env omits exactly the two CPU words', set(actual) - set(win) == {'RS_SCALE_CPU_REPORT', 'RS_SCALE_FRAME_LOG'} and win == {k:v for k,v in expected.items() if k not in ('RS_SCALE_CPU_REPORT', 'RS_SCALE_FRAME_LOG')})
check('Windows keeps MALLOC_MMAP_THRESHOLD_', win.get('MALLOC_MMAP_THRESHOLD_') == '131072')
# Compare every leg, including the control override and per-leg worker/fault words.
short = re.search(r'^run_g8sw\(\) \{(.*?)^\}', runner, re.M | re.S)[1]
check('runner short quit formulas guarded', 'quit=$((idle + n * (armed + idle) + 60))' in run_body and 'quit=$((n * (armed + idle) + 900 + 400 * n))' in run_body)
for leg in d.LEGS:
    variables['quit'] = str(d.quit_frames(leg))
    variables['kind'] = leg.removeprefix('sabotage-')
    label = 'sabotage-$kind' if leg.startswith('sabotage-') else leg
    line = next(x.strip() for x in short.splitlines() if x.strip().startswith('run_g8sw_leg') and '/short/' + label + '\"' in x)
    invocation = shlex.split(line)
    check(leg + ': runner phase counts guarded', invocation[2:6] == ['240', '240', '3', 'control' if leg == 'control' else 'swap'])
    mode_words = shlex.split(re.search(r'CAPTURE_EXTRA_ENV\+=\((.*?)\)', branches[1 if leg == 'control' else 2], re.S)[1])
    expected_leg = {}
    for word in base_words + shlex.split(append[0]) + shlex.split(append[2]) + arrays['G8SW_ENV'] + extra_words[1:] + mode_words + prealloc[:-1] + invocation[6:]:
        k, v = resolve(word).split('=', 1); expected_leg[k] = v
    config['target'] = 'linux'
    check(leg + ': exact parsed Linux env', d.leg_env(base, config, run, leg) == expected_leg)
    config['target'] = 'windows'
    check(leg + ': exact parsed Windows env', d.leg_env(base, config, run, leg) == {k:v for k,v in expected_leg.items() if k not in ('RS_SCALE_CPU_REPORT', 'RS_SCALE_FRAME_LOG')})

check('quit frames match short control and swap budgets', d.quit_frames('control') == 1740 and all(d.quit_frames(x) == 3540 for x in d.LEGS if x != 'control'))
for leg in d.LEGS:
    env = d.leg_env(base, config, run, leg)
    check(leg + ': correct mode/cycle/quit', env['RS_FIXTURE_QUIT_FRAME'] == str(d.quit_frames(leg)) and env['RS_SCALE_PREALLOC_FRAMES'] == str(d.quit_frames(leg)) and env['GRC_MODE'] == ('standby' if leg == 'control' else 'arm') and env['GRC_SWAP_CYCLE'] == ('240:240:3:control' if leg == 'control' else '240:240:3'))
# Diagnostics are failure-only at the call site and cap both host lines and JSONL bytes.
fixture()
run = root / 'g8sw/short/swap'
(run / 'stdout.log').write_text(''.join('host-line-' + str(i) + '\n' for i in range(300)))
(run / 'evidence/swap-cycle.jsonl').write_text('x' * 70000)
output = io.StringIO()
with contextlib.redirect_stdout(output): d.diagnostics(root, [('swap/exit', False, 'crash')])
check('failure diagnostics keep last 200 host lines and 64 KiB JSONL', 'host-line-99\n' not in output.getvalue() and 'host-line-100\n' in output.getvalue() and 'host-line-299\n' in output.getvalue() and output.getvalue().count('x') == 65536)
print(json.dumps(results))
`,
      fileURLToPath(new URL("../lib/wswap-driver.py", import.meta.url)),
      root,
      fileURLToPath(new URL("../../../../", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  if (child.status !== 0) {
    failed++;
    console.error(child.stderr || child.stdout);
  } else {
    for (const [name, ok] of JSON.parse(child.stdout) as [string, boolean][]) {
      if (ok) passed++;
      else failed++;
      console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`self-test-wswap-driver: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
