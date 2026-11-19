#!/usr/bin/env python3
"""Compare both native macOS file-sink captures against two Linux references."""
import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('w_equiv', Path(__file__).with_name('w-equiv.py'))
portable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portable)
PAIRS = {'linux-repeat': (0, 1), 'macos-repeat': (2, 3),
         'cross-aa': (0, 2), 'cross-ab': (0, 3), 'cross-ba': (1, 2), 'cross-bb': (1, 3)}
ARCHES = ('arm64', 'x86_64')


def judge_gate(gate, legs, expected, roots, command, out, repo):
    errors = []
    inventories = [portable.paths(root, lambda p: bool(portable.RECORDING.fullmatch(p.name))) for root in roots]
    files = {key: {'class': 'missing', 'present': [key in inv for inv in inventories], 'pairs': {}}
             for key in sorted(set.union(expected, *inventories))}
    pairs = {}
    for name, (i, j) in PAIRS.items():
        pair, rows = portable.compare(command, roots[i], roots[j], expected, name.startswith('cross'),
                                      True, out / 'logs', f'{gate}-{name}', repo)
        pairs[name] = pair
        errors.extend(pair['errors'])
        for key, row in rows.items():
            if key in files:
                files[key]['pairs'][name] = row
    for key, file in files.items():
        if key not in expected or not all(file['present']) or len(file['pairs']) != len(PAIRS):
            continue
        rows = file['pairs']
        if not all(rows[p]['identical'] for p in ('linux-repeat', 'macos-repeat')):
            file['class'] = 'noise'
        elif any(rows[p]['whole_file_identical'] for p in PAIRS if p.startswith('cross')):
            file['class'] = 'same-file'
        else:
            file['class'] = 'ok' if all(r['identical'] for r in rows.values()) else 'finding'
        for name in PAIRS:
            if not name.startswith('cross'):
                continue
            session = [p for row in rows[name]['allowed'] if row['type'] == 'session' for p in row['paths']]
            if 'session_id' not in session or not set(session).issubset(portable.SESSION_PATHS):
                errors.append(f'session-allowance: {key}: {name}: {session}')
    provenance = []
    for index, root in enumerate(roots):
        evidence = portable.optional_json(root / 'capture/evidence/calibration-check.json')
        checks = evidence.get('checks') if isinstance(evidence, dict) else None
        names = [c.get('name') if isinstance(c, dict) else None for c in checks] if isinstance(checks, list) else []
        provenance.append(names)
        want = 'exe_sha256' if index < 2 else 'slice_sha256'
        if not names or names[0] != want:
            errors.append(f'provenance: {root}: expected first calibration check {want}; got {names[:1]}')
    stores, steps = portable.judge_aux(roots, legs, errors)
    classes = Counter(row['class'] for group in (files, stores, steps) for row in group.values())
    return {'expected': len(expected), 'pairs': pairs, 'recordings': files, 'stores': stores,
            'steps': steps, 'provenance': provenance, 'info': portable.info(roots, legs),
            'classes': dict(classes), 'errors': errors, 'ok': not errors and set(classes) == {'ok'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--linux', type=Path, required=True)
    for arch in ARCHES:
        parser.add_argument('--' + arch + '-art', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--cmp-command', help=argparse.SUPPRESS)
    args = parser.parse_args()
    start = time.monotonic()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    repo = Path(__file__).resolve().parents[4]
    report = {'schema': 'render-stream-m-equiv/1', 'architectures': {}, 'errors': []}
    try:
        command = (json.loads(args.cmp_command) if args.cmp_command else
                   ['pnpm', 'exec', 'tsx', '--conditions=development',
                    str(repo / 'experiments/render-stream/scripts/cmp-rec.ts')])
        if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
            raise ValueError('cmp-command must be a non-empty JSON argv array')
        table = portable.expected_table(Path(__file__).with_name('wfile-legs.json'))
        linux = args.linux.resolve()
        for arch in ARCHES:
            artifact = getattr(args, arch + '_art').resolve()
            dest = out / arch
            (dest / 'logs').mkdir(parents=True, exist_ok=True)
            macos = artifact / 'mfile'
            result = {'gates': {}, 'negative_test': {}, 'errors': []}
            report['architectures'][arch] = result
            if not linux.is_dir() or not macos.is_dir():
                raise ValueError(f'missing input trees: linux={linux}, macos={macos}')
            for gate, (legs, expected) in table.items():
                roots = [base / rep / gate for base in (linux, macos) for rep in ('a', 'b')]
                result['gates'][gate] = judge_gate(gate, legs, expected, roots, command, dest, repo)
            sinks = next(leg['sinks'] for leg in table['gate8'][0] if leg['path'] == 'capture')
            result['negative_test'] = portable.judge_sabotage(
                artifact / 'mfile-negative', linux, sinks, command, dest, repo)
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError) as exc:
        report['errors'].append(str(exc))
    failing = list(report['errors'])
    for arch, result in report['architectures'].items():
        for gate, row in result['gates'].items():
            print(f"{arch}/{gate}: expected={row['expected']} classes={row['classes']} errors={row['errors']}")
            if not row['ok']:
                failing.append(f'{arch}:{gate}')
                for path, item in row['recordings'].items():
                    for pair, comparison in item['pairs'].items():
                        for diff in comparison['differing']:
                            print(f"FAIL {arch}/{gate}/{path} {pair}: index={diff['index']} "
                                  f"type={diff['type']} paths={', '.join(diff['paths'])}")
                for group in ('recordings', 'stores', 'steps'):
                    for path, item in row[group].items():
                        if item['class'] != 'ok':
                            print(f"FAIL {arch}/{gate}/{path}: {item['class']}")
        for sink, row in result['negative_test'].items():
            print(f"{arch} texture-decode negative test {sink}: {row['reason']}")
            if not row['ok']:
                failing.append(f'{arch}:negative-test:{sink}')
    if set(report['architectures']) != set(ARCHES):
        failing.append('missing-native-slice')
    rc = int(bool(failing))
    wall = round(time.monotonic() - start, 3)
    report.update(rc=rc, wall_s=wall, failing=failing)
    portable.write_json(out / 'm-equiv.json', report)
    if rc:
        evidence = out / 'evidence/macos-equiv'
        evidence.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out / 'm-equiv.json', evidence / 'm-equiv.json')
        for arch in report['architectures']:
            shutil.copytree(out / arch / 'logs', evidence / arch, dirs_exist_ok=True)
        for failure in failing:
            print('FAIL ' + failure)
    row = {'id': 'macos', 'phase': 'setup', 'rc': str(rc), 'wall_s': wall,
           'lock_wait_s': 0, 'lock_hold_s': 0, 'lock': {}, 'lock_summaries': 0,
           'skipped_by_tier': 0, 'skipped_remote': [], 'skipped_remote_groups': [],
           'unavailable': [], 'known_flakes': [], 'failing': failing}
    portable.write_json(out / 'validate-summary.json', {'schema': 'render-stream-validate-summary/2',
                        'partial': True, 'wall_s': wall, 'runs': [row], 'failed': rc})
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as stream:
            stream.write(f'\nmacos-equiv: rc={rc}; failing: {", ".join(failing) or "none"}\n')
    print(f'macos-equiv: rc={rc}; wall_s={wall}; report={out / "m-equiv.json"}')
    return rc


if __name__ == '__main__':
    sys.exit(main())
