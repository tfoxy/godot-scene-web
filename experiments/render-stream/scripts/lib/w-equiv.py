#!/usr/bin/env python3
"""Judge portable file-sink captures with the existing recording comparator."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

GATES = ('gate0', 'gate1', 'gate2', 'gate8')
PAIRS = {'linux-repeat': (0, 1), 'windows-repeat': (2, 3),
         'cross-a': (0, 2), 'cross-b': (1, 3)}
SESSION_PATHS = {'session_id', 'stream.stream_id', 'engine.sha256'}
RECORDING = re.compile(r'^recording[^/]*\.rs\d+$')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def paths(root, predicate):
    if not root.is_dir():
        return set()
    return {p.relative_to(root).as_posix() for p in root.rglob('*')
            if p.is_file() and predicate(p)}


def safe_relative(value):
    path = Path(value)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise ValueError(f'invalid table path: {value}')
    return path


def expected_table(path):
    rows = read_json(path)['legs']
    result = {}
    for gate in GATES:
        legs = [leg for leg in rows if leg['gate'] == gate]
        expected = [str(safe_relative(leg['path']) / safe_relative(sink))
                    for leg in legs for sink in leg['sinks']]
        if not expected:
            raise ValueError(f'empty expected set: {gate}')
        if len(set(expected)) != len(expected):
            raise ValueError(f'duplicate expected recording: {gate}')
        if any(not RECORDING.fullmatch(Path(p).name) for p in expected):
            raise ValueError(f'invalid expected recording: {gate}')
        result[gate] = (legs, set(expected))
    return result


def assemble_artifact(artifact, out):
    """Each manifest test owns one tree; never silently overwrite a duplicate."""
    source = artifact / 'artifacts'
    if not source.is_dir():
        raise ValueError(f'windows-art: missing artifacts directory: {source}')
    assembled = out / 'windows-input'
    if assembled.exists():
        shutil.rmtree(assembled)
    assembled.mkdir()
    seen = set()
    for gate in GATES:
        for rep in ('a', 'b'):
            name = f'wfile-{gate}-{rep}'
            entry = source / name
            candidates = [(r, g) for r in ('a', 'b') for g in GATES
                          if (entry / r / g).exists()]
            if candidates != [(rep, gate)]:
                raise ValueError(f'windows-art: missing or duplicate tree in {name}: {candidates}')
            for r, g in candidates:
                if (r, g) in seen:
                    raise ValueError(f'windows-art: duplicate {r}/{g}')
                seen.add((r, g))
                dest = assembled / r / g
                dest.parent.mkdir(exist_ok=True)
                shutil.copytree(entry / r / g, dest)
    return assembled, source / 'wfile-sabotage'


def compare(command, a, b, expected, cross, tree, logs, name, repo):
    argv = [*command, *(['--tree'] if tree else []), '--json',
            *(['--allow-session', 'engine.sha256'] if cross else []), str(a), str(b)]
    write_json(logs / f'{name}.argv.json', argv)
    result = subprocess.run(argv, cwd=repo, capture_output=True, text=True, timeout=300)
    (logs / f'{name}.stdout.txt').write_text(result.stdout, encoding='utf-8')
    (logs / f'{name}.stderr.txt').write_text(result.stderr, encoding='utf-8')
    errors, mapped = [], {}
    match = re.search(r'\ncmp-rec: (\d+)/(\d+) identical\s*\Z', result.stdout)
    report = {'rc': result.returncode, 'identical': 0, 'total': 0, 'rows': [], 'errors': errors}
    if not match:
        errors.append('comparator-count: missing trailer')
        return report, mapped
    identical, total = map(int, match.groups())
    report.update(identical=identical, total=total)
    try:
        rows = json.loads(result.stdout[:match.start()])
        if not isinstance(rows, list):
            raise ValueError('expected array')
        report['rows'] = rows
        if (total != len(expected) or len(rows) != total or
                identical != sum(row['identical'] is True for row in rows)):
            errors.append(f'comparator-count: {identical}/{total}, expected {len(expected)}')
        if result.returncode != (0 if identical == total else 1):
            errors.append(f'comparator-exit: rc={result.returncode}')
        for row in rows:
            if not isinstance(row['identical'], bool) or not isinstance(row['whole_file_identical'], bool):
                raise ValueError('invalid comparison booleans')
            source = Path(row['a']).resolve()
            key = source.relative_to(a.resolve()).as_posix() if tree else a.name
            wanted_b = b / key if tree else b
            if key in mapped or key not in expected or Path(row['b']).resolve() != wanted_b.resolve():
                errors.append(f'comparator-paths: duplicate or unexpected pair: {row["a"]} / {row["b"]}')
            mapped[key] = row
            # Preserve every record index and differing path in the report.
            if not isinstance(row['differing'], list) or not isinstance(row['allowed'], list):
                raise ValueError('invalid differing/allowed arrays')
            if row['identical'] != (len(row['differing']) == 0):
                raise ValueError('inconsistent differing array')
        if set(mapped) != expected:
            errors.append('comparator-paths: result set differs from expected recordings')
    except (ValueError, TypeError, KeyError) as exc:
        errors.append(f'comparator-json: {exc}')
    return report, mapped


def classify(values):
    if values[0] != values[1] or values[2] != values[3]:
        return 'noise'
    return 'ok' if values[0] == values[2] and values[1] == values[3] else 'finding'


def parsed_steps(path):
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'step', 'applied_frame', 'settle_frame'} or
                any(type(value) is not int for value in row.values())):
            raise ValueError('steps must contain integer step/applied_frame/settle_frame objects')
    return rows


def judge_aux(roots, legs, errors):
    stores, steps = {}, {}
    expected_steps = {f'{leg["path"]}/steps.jsonl' for leg in legs}
    store_roots = {f'{leg["path"]}/store/' for leg in legs if leg['store']}
    indexes = {prefix + 'index.jsonl' for prefix in store_roots}
    store_sets = [paths(root, lambda p: 'store' in p.relative_to(root).parts[:-1]) for root in roots]
    step_sets = [paths(root, lambda p: p.name == 'steps.jsonl') for root in roots]
    for key in sorted(set.union(indexes, *store_sets)):
        present = [key in inventory for inventory in store_sets]
        row = {'class': 'missing', 'present': present}
        if all(present) and any(key.startswith(prefix) for prefix in store_roots):
            data = [(root / key).read_bytes() for root in roots]
            row.update({'class': classify(data), 'sha256': [hashlib.sha256(d).hexdigest() for d in data],
                        'bytes': [len(d) for d in data]})
        stores[key] = row
    for key in sorted(set.union(expected_steps, *step_sets)):
        present = [key in inventory for inventory in step_sets]
        row = {'class': 'missing', 'present': present}
        if all(present) and key in expected_steps:
            try:
                values = [parsed_steps(root / key) for root in roots]
                row.update({'class': classify(values), 'values': values})
            except (ValueError, OSError) as exc:
                errors.append(f'steps-json: {key}: {exc}')
        steps[key] = row
    return stores, steps


def optional_json(path):
    try:
        return read_json(path)
    except (OSError, ValueError):
        return None


def info(roots, legs):
    result = {}
    for leg in legs:
        key = leg['path']
        dirs = [root / key for root in roots]
        counts = []
        for directory in dirs:
            value = optional_json(directory / 'evidence/counters.json')
            counts.append(value.get('counts') if isinstance(value, dict) else None)
        keys = sorted({k for value in counts if isinstance(value, dict) for k in value})
        diffs = {k: [c.get(k) if isinstance(c, dict) else None for c in counts] for k in keys}
        result[key] = {'counts': counts, 'counts_diffs': {k: v for k, v in diffs.items() if any(x != v[0] for x in v)},
                       'logs': {}}
        for name in ('textures.jsonl', 'root.jsonl'):
            values = [p.read_bytes() if p.is_file() else None for p in (d / name for d in dirs)]
            result[key]['logs'][name] = {'present': [v is not None for v in values],
                                        'equal': all(v == values[0] for v in values)}
    return result


def judge_gate(gate, legs, expected, roots, command, out, repo):
    errors = []
    inventories = [paths(root, lambda p: bool(RECORDING.fullmatch(p.name))) for root in roots]
    files = {key: {'class': 'missing', 'present': [key in inv for inv in inventories], 'pairs': {}}
             for key in sorted(set.union(expected, *inventories))}
    pairs = {}
    for name, (i, j) in PAIRS.items():
        pair, rows = compare(command, roots[i], roots[j], expected, name.startswith('cross'),
                             True, out / 'logs', f'{gate}-{name}', repo)
        pairs[name] = pair
        errors.extend(pair['errors'])
        for key, row in rows.items():
            if key in files:
                files[key]['pairs'][name] = row
    for key, file in files.items():
        if key not in expected or not all(file['present']) or len(file['pairs']) != 4:
            continue
        rows = file['pairs']
        if not all(rows[p]['identical'] for p in ('linux-repeat', 'windows-repeat')):
            file['class'] = 'noise'
        elif any(rows[p]['whole_file_identical'] for p in ('cross-a', 'cross-b')):
            file['class'] = 'same-file'
        else:
            file['class'] = 'ok' if all(r['identical'] for r in rows.values()) else 'finding'
        for name in ('cross-a', 'cross-b'):
            session = [p for row in rows[name]['allowed'] if row['type'] == 'session' for p in row['paths']]
            if 'session_id' not in session or not set(session).issubset(SESSION_PATHS):
                errors.append(f'session-allowance: {key}: {name}: {session}')
    provenance = []
    for index, root in enumerate(roots):
        evidence = optional_json(root / 'capture/evidence/calibration-check.json')
        checks = evidence.get('checks') if isinstance(evidence, dict) else None
        names = [c.get('name') if isinstance(c, dict) else None for c in checks] if isinstance(checks, list) else []
        provenance.append(names)
        want = 'exe_sha256' if index < 2 else 'image_sha256'
        if not names or names[0] != want:
            errors.append(f'provenance: {root}: expected first calibration check {want}; got {names[:1]}')
    stores, steps = judge_aux(roots, legs, errors)
    classes = Counter(row['class'] for group in (files, stores, steps) for row in group.values())
    return {'expected': len(expected), 'pairs': pairs, 'recordings': files, 'stores': stores,
            'steps': steps, 'provenance': provenance, 'info': info(roots, legs), 'classes': dict(classes),
            'errors': errors, 'ok': not errors and set(classes).issubset({'ok'})}


def judge_sabotage(directory, linux, sinks, command, out, repo):
    # Accept a driver output root or the capture directory itself.
    capture = directory / 'a/gate8/capture'
    if not capture.is_dir():
        capture = directory
    result = {}
    for sink in sinks:
        a, b = linux / 'a/gate8/capture' / sink, capture / sink
        row = {'ok': False, 'reason': 'sabotage-not-detected'}
        if a.is_file() and b.is_file():
            pair, mapped = compare(command, a, b, {sink}, True, False, out / 'logs', f'sabotage-{sink}', repo)
            cmp = mapped.get(sink, {})
            # A missing/corrupt file is not a successful sabotage. Require an
            # actual decoded content record beyond the session to differ.
            detected = (not pair['errors'] and cmp.get('identical') is False and
                        any(type(d.get('index')) is int and d['index'] > 0 and
                            d.get('type') not in ('session', 'end', 'error', 'missing') and d.get('paths')
                            for d in cmp.get('differing', [])))
            row.update(ok=bool(detected), comparison=pair)
        if row['ok']:
            row['reason'] = 'detected'
        result[sink] = row
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--linux', type=Path, required=True)
    windows = parser.add_mutually_exclusive_group(required=True)
    windows.add_argument('--windows', type=Path)
    windows.add_argument('--windows-art', type=Path)
    parser.add_argument('--sabotage', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--id', default='windows')
    parser.add_argument('--label', default='windows-equiv')
    parser.add_argument('--cmp-command', help=argparse.SUPPRESS)  # Test-only JSON argv; no decoder port.
    args = parser.parse_args()
    start = time.monotonic()
    out = args.out.resolve()
    (out / 'logs').mkdir(parents=True, exist_ok=True)
    repo = Path(__file__).resolve().parents[4]
    report = {'schema': 'render-stream-w-equiv/1', 'gates': {}, 'sabotage': {}, 'errors': []}
    rc = 0
    try:
        command = (json.loads(args.cmp_command) if args.cmp_command else
                   ['pnpm', 'exec', 'tsx', '--conditions=development',
                    str(repo / 'experiments/render-stream/scripts/cmp-rec.ts')])
        if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
            raise ValueError('cmp-command must be a non-empty JSON argv array')
        table = expected_table(Path(__file__).with_name('wfile-legs.json'))
        linux = args.linux.resolve()
        sabotage = args.sabotage.resolve() if args.sabotage else None
        if args.windows_art:
            win, art_sabotage = assemble_artifact(args.windows_art.resolve(), out)
            if sabotage is None:
                sabotage = art_sabotage
        else:
            win = args.windows.resolve()
        if not linux.is_dir() or not win.is_dir():
            raise ValueError(f'missing input trees: linux={linux}, windows={win}')
        for gate, (legs, expected) in table.items():
            roots = [base / rep / gate for base in (linux, win) for rep in ('a', 'b')]
            report['gates'][gate] = judge_gate(gate, legs, expected, roots, command, out, repo)
        sinks = next(leg['sinks'] for leg in table['gate8'][0] if leg['path'] == 'capture')
        if not sabotage:
            report['errors'].append('sabotage-not-detected: missing sabotage input')
        else:
            report['sabotage'] = judge_sabotage(sabotage, linux, sinks, command, out, repo)
        rc = int(any(not g['ok'] for g in report['gates'].values()) or bool(report['errors']) or
                 any(not row['ok'] for row in report['sabotage'].values()))
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError) as exc:
        report['errors'].append(str(exc))
        rc = 2
    wall = round(time.monotonic() - start, 3)
    report.update(rc=rc, wall_s=wall)
    write_json(out / 'w-equiv.json', report)
    if rc != 0:
        # The merge retains evidence after deleting the per-job artifacts. Keep
        # all comparison logs, including a pair interrupted before it was judged.
        evidence = out / 'evidence' / args.label
        evidence.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out / 'w-equiv.json', evidence / 'w-equiv.json')
        shutil.copytree(out / 'logs', evidence / 'logs', dirs_exist_ok=True)
    failing = [f'w-equiv:{g}' for g, row in report['gates'].items() if not row['ok']]
    failing.extend(f'w-equiv:sabotage:{s}' for s, row in report['sabotage'].items() if not row['ok'])
    if report['errors']:
        failing.append('w-equiv:inputs')
    row = {'id': args.id, 'phase': 'setup', 'rc': str(rc), 'wall_s': wall,
           'lock_wait_s': 0, 'lock_hold_s': 0, 'lock': {}, 'lock_summaries': 0,
           'skipped_by_tier': 0, 'skipped_remote': [], 'skipped_remote_groups': [],
           'unavailable': [], 'known_flakes': [], 'failing': failing}
    write_json(out / 'validate-summary.json', {'schema': 'render-stream-validate-summary/2',
               'partial': True, 'wall_s': wall, 'runs': [row], 'failed': int(rc != 0)})
    lines = ['| Gate | Expected | Linux repeat | Windows repeat | Cross A | Cross B | Classes | Result |',
             '| --- | ---: | --- | --- | --- | --- | --- | --- |']
    for gate, result in report['gates'].items():
        counts = [f"{p['identical']}/{p['total']}" for p in result['pairs'].values()]
        lines.append(f"| {gate} | {result['expected']} | " + ' | '.join(counts) +
                     f" | {result['classes']} | {'ok' if result['ok'] else 'FAIL'} |")
    for line in lines:
        print(line)
    for gate, result in report['gates'].items():
        for error in result['errors']:
            print(f'FAIL {gate}: {error}')
        for group in ('recordings', 'stores', 'steps'):
            for path, item in result[group].items():
                if item['class'] != 'ok':
                    print(f"FAIL {gate}/{path}: {item['class']}")
                    for pair, comparison in item.get('pairs', {}).items():
                        for difference in comparison['differing']:
                            print(f"  {pair}: index={difference['index']} type={difference['type']} "
                                  f"paths={', '.join(difference['paths'])}")
    for error in report['errors']:
        print('FAIL ' + error)
    for sink, result in report['sabotage'].items():
        print(f"sabotage {sink}: {result['reason']}")
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as stream:
            stream.write(f'\n{args.label}\n\n' + '\n'.join(lines) + '\n\n')
            stream.write(f'rc={rc}; failing: {", ".join(failing) or "none"}\n')
    print(f'w-equiv: rc={rc}; wall_s={wall}; report={out / "w-equiv.json"}')
    return rc


if __name__ == '__main__':
    sys.exit(main())
