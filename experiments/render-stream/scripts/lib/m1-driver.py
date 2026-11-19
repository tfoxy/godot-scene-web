#!/usr/bin/env python3
"""Run the five stock-template capture legs on native macOS or Linux (stdlib only)."""
import argparse
import importlib.util
import json
from pathlib import Path
import platform
import sys


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Keep the Windows launcher, fixture assertions and diagnostics shared. Only the
# fingerprint check sequence differs: Darwin checks a slice, UUID, CPU and extent.
portable = sibling('w1-driver')
LEGS = portable.LEGS


def evaluate(directory, leg, config):
    checks = portable.evaluate(directory, leg, config)
    if leg == 'control':
        return checks
    names = config['check_names'] + ['hook_plan']
    if leg == 'refuse-image':
        names = names[:names.index('singleton_available')]
    elif leg == 'refuse-shift':
        names = names[:names.index('behaviour_probe')]
    rejected = names[0] if leg == 'refuse-image' else 'anchors_implemented' if leg == 'refuse-shift' else None
    expected = [name != rejected for name in names]
    table = portable.read_json(directory / 'evidence/calibration-check.json', {}).get('checks', [])
    ok = [c.get('name') for c in table] == names and [c.get('ok') for c in table] == expected
    return [(name, ok, json.dumps(table)) if name == 'calibration-checks' else (name, passed, detail)
            for name, passed, detail in checks]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--leg', required=True, choices=LEGS)
    parser.add_argument('--evaluate-only', type=Path)
    args = parser.parse_args()
    print(f'm1: Python {platform.python_version()} OS {platform.platform()}', flush=True)
    try:
        config = json.loads(args.config.read_text(encoding='utf-8'))
        if not args.evaluate_only and config['target'] == 'macos':
            if platform.system() != 'Darwin' or platform.machine() != config['arch']:
                raise ValueError('m1 requires the native macOS slice matching its stock record')
        directory = args.evaluate_only or portable.launch(args.config, config, args.leg)
        checks = evaluate(directory, args.leg, config)
    except (OSError, ValueError, KeyError) as exc:
        print(f'FAIL launch: {exc}', flush=True)
        return 1
    for name, ok, detail in checks:
        print(f"{'ok' if ok else 'FAIL'} {name}: {detail}")
    failed = sum(not ok for _, ok, _ in checks)
    portable.diagnostics(directory, failed != 0)
    print(f'm1-{args.leg}: {len(checks) - failed} passed, {failed} failed')
    return int(failed != 0)


if __name__ == '__main__':
    sys.exit(main())
