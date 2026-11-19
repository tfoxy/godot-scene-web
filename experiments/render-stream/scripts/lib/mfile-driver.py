#!/usr/bin/env python3
"""Run the shared file-sink leg table on a native macOS slice or Linux."""
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


portable = sibling('wfile-driver')


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--evaluate-only')
    parser.add_argument('--check-against-runner')
    args, _ = parser.parse_known_args()
    try:
        config = json.loads(args.config.read_text(encoding='utf-8'))
        if not (args.evaluate_only or args.check_against_runner) and config['target'] == 'macos':
            if platform.system() != 'Darwin' or platform.machine() != config['arch']:
                raise ValueError('mfile requires the native macOS slice matching its stock record')
    except (OSError, ValueError, KeyError) as exc:
        print(f'mfile: {exc}', file=sys.stderr)
        return 2
    return portable.main()


if __name__ == '__main__':
    sys.exit(main())
