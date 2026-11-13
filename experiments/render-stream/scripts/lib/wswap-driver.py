#!/usr/bin/env python3
"""Run the portable short swap legs and judge them with the shared TypeScript checks."""
import argparse
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

LEGS = ('swap', 'control', 'warm-workers', 'sabotage-keep-served',
        'sabotage-keep-listener', 'sabotage-keep-hub', 'sabotage-skip-mirror-reset')
CHECKS = ('swap-accounting', 'warm-capture-scale', 'swap-cycle-threads',
          'swap-cycle-fds', 'swap-cycle-rss', 'sabotage-keep-served-caught',
          'sabotage-keep-listener-caught', 'sabotage-keep-hub-caught',
          'sabotage-skip-mirror-reset-caught')


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def text(path):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return ''


def quit_frames(leg):
    return 240 + 3 * (240 + 240) + 60 if leg == 'control' else 3 * (240 + 240) + 900 + 400 * 3


def leg_env(base, config, directory, leg):
    """run_capture + G8SW_ENV, with only the two procfs CPU words omitted on Windows."""
    quit = str(quit_frames(leg))
    words = {
        'GRC_EXTENSION': str(base / config['extension']),
        'GRC_CALIBRATION': str(base / config['record']), 'GRC_MODE': 'arm',
        'GRC_EVIDENCE_DIR': str(directory / 'evidence'),
        'GRC_STREAM_OUT': str(directory / 'recording.rs8'),
        'RS_FIXTURE_STEP_LOG': str(directory / 'steps.jsonl'), 'GRC_VALIDATION_LOG': 'on',
        'GRC_RESOURCE_STORE_DIR': str(directory / 'store'), 'RS_FIXTURE_QUIT_FRAME': quit,
        'GRC_MIRROR_MAX_ITEMS': '32768', 'GRC_MIRROR_MAX_COMMANDS': '16384',
        'RS_FIXTURE_ARM': 'born', 'GRC_STREAM_VERSION': '12', 'GRC_UNKNOWN_ITEM': 'skip',
        'GRC_ROOT_SIZE': 'presentation:1920x1080', 'RS_SCALE_REDRAWS': '170',
        'RS_SCALE_REDRAW_VARY': '11', 'RS_SCALE_RESOURCE_CHURN': '16',
        'RS_SCALE_CPU_REPORT': '1', 'RS_SCALE_WARMUP': '300',
        'RS_SCALE_TEXTURES': '120', 'GRC_HTTP_ENCODING': 'off',
        'GRC_LIVE_LISTEN': '127.0.0.1:0', 'GRC_TEST_TRIM_AT_DISARM': '1',
        'GRC_TEST_MEMORY_ACCOUNTING': '1', 'RS_SCALE_VIEWER': '1',
        'MALLOC_MMAP_THRESHOLD_': '131072',
        'RS_SCALE_FRAME_LOG': str(directory / 'frames.csv'),
        'RS_SCALE_REPORT': str(directory / 'scale-report.json'),
        'GRC_SWAP_CYCLE': '240:240:3', 'RS_SCALE_PREALLOC_FRAMES': quit,
    }
    words['GRC_VALIDATION_LOG'] = 'off'
    if leg == 'control':
        words.update(GRC_MODE='standby', GRC_SWAP_CYCLE='240:240:3:control')
    else:
        words['GRC_ADOPT'] = 'arm'
    if leg == 'warm-workers':
        words['GRC_TEXTURE_WORKERS'] = '2'
    elif leg.startswith('sabotage-'):
        words['GRC_REARM_FAULT'] = leg.removeprefix('sabotage-')
    if config['target'] == 'windows':
        del words['RS_SCALE_CPU_REPORT']
        del words['RS_SCALE_FRAME_LOG']
    return words


def evaluate(directory, checker_exit):
    """Harness evidence only; swap accounting rules remain in the TypeScript checker."""
    checks = []
    for leg in LEGS:
        run = directory / 'g8sw/short' / leg
        checks.append((leg + '/exit', text(run / 'exit-code.txt').strip() == '0',
                       text(run / 'exit-code.txt').strip() or 'missing exit-code.txt'))
        errors = [line for line in text(run / 'stdout.log').splitlines()
                  if '[scale] error:' in line or '[fixture] error:' in line]
        checks.append((leg + '/fixture-errors', not errors, '\n'.join(errors[:10])))
        try:
            rows = [json.loads(line) for line in text(run / 'evidence/swap-cycle.jsonl').splitlines() if line.strip()]
            armed = [r for r in rows if r.get('phase') == 'armed']
            bad = [i for i, r in enumerate(armed) if r.get('net_module') is not False]
            ok = bool(armed) and not bad
            detail = f'{len(armed)} armed rows; non-false net_module rows={bad}'
        except (ValueError, AttributeError) as exc:
            ok, detail = False, str(exc)
        checks.append((leg + '/net-module', ok, detail))
    checks.append(('checker-exit', checker_exit == 0, str(checker_exit)))
    report = read_json(directory / 'checker.json', {})
    table = report.get('checks', [])
    valid = (isinstance(table, list) and len(table) == len(CHECKS)
             and {c.get('id') for c in table if isinstance(c, dict)} == set(CHECKS)
             and all(isinstance(c, dict) and c.get('passed') is True for c in table)
             and report.get('passed') is True)
    checks.append(('checker-results', valid, 'all nine named checks must pass'))
    return checks


def make_summary(directory, config):
    report = read_json(directory / 'checker.json', {})
    clocks = []
    for path in (directory / 'g8sw/short').glob('*/evidence/swap-cycle.jsonl'):
        for line in path.read_text(encoding='utf-8').splitlines():
            row = json.loads(line)
            if 'tsc_invariant' in row or 'tsc_hz' in row:
                clocks.append({'tsc_invariant': row.get('tsc_invariant'), 'tsc_hz': row.get('tsc_hz')})
    return {'legs': {leg: read_json(directory / 'g8sw/short' / leg / 'leg.json', {}) for leg in LEGS},
            'checks': [{'id': c['id'], 'verdict': 'pass' if c.get('passed') is True else 'fail',
                        'detail': c.get('detail', '')} for c in report.get('checks', [])],
            'tsc_invariant': clocks[0]['tsc_invariant'] if clocks else None,
            'tsc_hz': clocks[-1]['tsc_hz'] if clocks else None,
            'template_sha256': config['template_sha256'], 'platform': config['target']}


def summary_problems(summary):
    problems = []
    if not isinstance(summary, dict):
        return ['summary missing']
    for key in ('legs', 'checks', 'tsc_invariant', 'tsc_hz', 'template_sha256', 'platform'):
        if key not in summary:
            problems.append('summary/' + key)
    legs = summary.get('legs', {})
    if (not isinstance(legs, dict) or set(legs) != set(LEGS)
            or any(not isinstance(v, dict) or v.get('exit') != 0
                   or not isinstance(v.get('wall_s'), (int, float))
                   or not math.isfinite(v['wall_s']) or v['wall_s'] < 0 for v in legs.values())):
        problems.append('summary/legs')
    checks = summary.get('checks', [])
    if (not isinstance(checks, list) or len(checks) != len(CHECKS)
            or {c.get('id') for c in checks if isinstance(c, dict)} != set(CHECKS)
            or any(not isinstance(c, dict) or c.get('verdict') != 'pass'
                   or not isinstance(c.get('detail'), str) for c in checks)):
        problems.append('summary/checks')
    if summary.get('platform') not in ('linux', 'windows'):
        problems.append('summary/platform')
    digest = summary.get('template_sha256', '')
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        problems.append('summary/template_sha256')
    if summary.get('platform') == 'windows':
        if not isinstance(summary.get('tsc_invariant'), bool):
            problems.append('summary/tsc_invariant')
        hz = summary.get('tsc_hz')
        if not isinstance(hz, (int, float)) or not math.isfinite(hz) or hz <= 0:
            problems.append('summary/tsc_hz')
    return sorted(set(problems))


def diagnostics(directory, failures):
    names = {name.split('/')[0] for name, ok, _ in failures if not ok}
    if names - set(LEGS):
        names.update(LEGS)
    for leg in LEGS:
        if leg not in names:
            continue
        run = directory / 'g8sw/short' / leg
        try:
            with (run / 'stdout.log').open(encoding='utf-8', errors='replace') as log:
                print(leg + ' last 200 host lines:\n' + ''.join(deque(log, maxlen=200)))
        except OSError:
            pass
        path = run / 'evidence/swap-cycle.jsonl'
        if path.is_file():
            with path.open('rb') as log:
                print(leg + ' swap-cycle.jsonl (first 64 KiB):\n' + log.read(65536).decode('utf-8', errors='replace'))
    print('checker output (last 64 KiB):\n' + text(directory / 'checker.log')[-65536:])


def run_leg(base, config, directory, leg, repo):
    run = directory / 'g8sw/short' / leg
    (run / 'evidence').mkdir(parents=True)
    project = run / 'project'
    shutil.copytree(base / config['fixture'], project, ignore=shutil.ignore_patterns('.godot'))
    shutil.copytree(base / config['import'], project / '.godot')
    user = run / 'user'
    user.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    if os.name == 'nt':
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
        env.update(APPDATA=str(user), LOCALAPPDATA=str(user))
    else:
        env.update({k: str(user / k) for k in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME')})
    words = leg_env(base, config, run, leg)
    env.update(words)
    (run / 'env.txt').write_text(''.join(k + '=' + v + '\n' for k, v in words.items()), encoding='utf-8')
    argv = [str(base / config['template']), '--headless', '--path', str(project), '--max-fps', '60']
    write_json(run / 'argv.json', argv)
    start = time.monotonic()
    code = -1
    with (run / 'stdout.log').open('wb') as log:
        try:
            code = subprocess.run(argv, cwd=run, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180).returncode
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.write(('\n[fixture] error: ' + str(exc) + '\n').encode())
    wall = round(time.monotonic() - start, 3)
    (run / 'exit-code.txt').write_text(str(code), encoding='utf-8')
    write_json(run / 'leg.json', {'exit': code, 'wall_s': wall})
    print(f'wswap leg {leg}: exit={code} wall_s={wall}', flush=True)
    # Save the shared mirror scan before dropping the potentially large recording and stores.
    pnpm = shutil.which('pnpm')
    if not pnpm:
        raise ValueError('pnpm missing')
    with (run / 'mirror-check.log').open('wb') as log:
        subprocess.run([pnpm, 'exec', 'tsx', '--conditions=development',
                        str(repo / 'experiments/render-stream/scripts/lib/gate8-scale-checks.ts'),
                        '--capture', str(run)], cwd=repo, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
    for path in list(run.glob('recording.rs8*')) + list(run.glob('store*')) + list((run / 'evidence').rglob('resources.jsonl')):
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--repo', type=Path, default=os.environ.get('WSWAP_REPO_ROOT', Path.cwd()))
    parser.add_argument('--expect-platform', choices=('linux', 'windows'))
    parser.add_argument('--evaluate-only', type=Path)
    args = parser.parse_args()
    config = read_json(args.config)
    if not isinstance(config, dict):
        raise ValueError('missing or invalid config')
    expected = args.expect_platform or config['target']
    if expected != config['target']:
        raise ValueError('expected platform differs from bundle target')
    directory = (args.evaluate_only or Path(os.environ.get('W_RUN_ARTIFACT_DIR', str(args.config.parent / 'runs')))).resolve()
    repo = args.repo.resolve()
    if not args.evaluate_only and not (repo / 'experiments/render-stream/scripts/check-g8sw.ts').is_file():
        raise ValueError('checker missing: use --repo or WSWAP_REPO_ROOT for the source checkout')
    if args.evaluate_only:
        code = read_json(directory / 'checker-exit.json', -1)
    else:
        base = args.config.resolve().parent
        if directory.exists() and any(directory.iterdir()):
            raise ValueError('artifact directory must be empty')
        directory.mkdir(parents=True, exist_ok=True)
        if hashlib.sha256((base / config['template']).read_bytes()).hexdigest() != config['template_sha256']:
            raise ValueError('template sha256 differs from pin')
        for leg in LEGS:
            try:
                run_leg(base, config, directory, leg, repo)
            except (OSError, ValueError, subprocess.SubprocessError):
                diagnostics(directory, [(leg + '/launch', False, 'launch failed')])
                raise
        pnpm = shutil.which('pnpm')
        if not pnpm:
            raise ValueError('pnpm missing')
        with (directory / 'checker.log').open('wb') as log:
            code = subprocess.run([pnpm, 'exec', 'tsx', '--conditions=development',
                                   str(repo / 'experiments/render-stream/scripts/check-g8sw.ts'),
                                   '--out', str(directory), '--checks', ','.join(CHECKS),
                                   '--expect-platform', expected, '--json', str(directory / 'checker.json')],
                                  cwd=repo, stdout=log, stderr=subprocess.STDOUT, timeout=120).returncode
        write_json(directory / 'checker-exit.json', code)
        write_json(directory / 'wswap-summary.json', make_summary(directory, config))
    checks = evaluate(directory, code)
    summary = read_json(directory / 'wswap-summary.json')
    checks.extend((p, False, 'missing or invalid success evidence') for p in summary_problems(summary))
    if isinstance(summary, dict) and summary.get('platform') != expected:
        checks.append(('summary/platform', False, f'expected {expected}, got {summary.get("platform")}'))
    for c in read_json(directory / 'checker.json', {}).get('checks', []):
        print(f"wswap check {c.get('id')}: {'PASS' if c.get('passed') is True else 'FAIL'} {c.get('detail', '')}", flush=True)
    failed = [c for c in checks if not c[1]]
    for name, _, detail in failed:
        print(f'FAIL {name}: {detail}', flush=True)
    if failed:
        diagnostics(directory, failed)
    print(f'wswap: {len(checks) - len(failed)} harness checks passed, {len(failed)} failed; 9 swap checks requested', flush=True)
    return int(bool(failed))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(f'FAIL wswap: {exc}', flush=True)
        sys.exit(1)
