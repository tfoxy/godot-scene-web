#!/usr/bin/env python3
"""Add the shared file-sink fixtures and native slice configs to an m-1 bundle."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('linux', 'macos'), required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    out = args.out.resolve()
    dest = out / 'mfile'
    dest.mkdir(parents=True, exist_ok=True)
    table = json.loads(Path(__file__).with_name('wfile-legs.json').read_text())
    for name in ('mfile-driver.py', 'wfile-driver.py', 'wfile-legs.json'):
        shutil.copyfile(Path(__file__).with_name(name), dest / name)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))
           and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
    for fixture in sorted({leg['fixture'] for leg in table['legs']}):
        project, imported = dest / 'fixtures' / fixture, dest / 'imports' / fixture
        for path in (project, imported):
            if path.exists():
                shutil.rmtree(path)
        shutil.copytree(rs / 'fixtures' / fixture, project, ignore=shutil.ignore_patterns('.godot'))
        commands = [['--script', 'res://make_sources.gd']] if fixture == 'gate8-tex' else []
        commands.append(['--import'])
        with (dest / f'{fixture}-import.log').open('wb') as log:
            for tail in commands:
                subprocess.run(['mise', 'exec', '--', 'godot', '--headless', '--path', str(project), *tail],
                               cwd=rs.parents[1], env=env, stdout=log, stderr=subprocess.STDOUT,
                               timeout=180, check=True)
        cache = project / '.godot'
        if not cache.is_dir() or not any(p.is_file() for p in cache.rglob('*')):
            raise ValueError(f'missing or empty import: {fixture}')
        imported.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(cache), imported)
    for arch in (('arm64', 'x86_64') if args.target == 'macos' else ('x86_64',)):
        name = f'm1-{arch}.json' if args.target == 'macos' else 'm1.json'
        runtime = json.loads((out / 'm1' / name).read_text())
        if runtime['target'] != args.target or runtime['arch'] != arch:
            raise ValueError('m1 target or architecture differs')
        config = {key: '../m1/' + runtime[key] for key in ('template', 'extension', 'record')}
        config.update(target=args.target, arch=arch, template_sha256=runtime['template_sha256'],
                      legs='wfile-legs.json', timeout_s=180)
        name = f'mfile-{arch}.json' if args.target == 'macos' else 'mfile.json'
        (dest / name).write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'mfile bundle: {dest}; total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
