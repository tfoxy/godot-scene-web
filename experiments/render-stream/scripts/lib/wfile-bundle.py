#!/usr/bin/env python3
"""Ship portable file-sink fixtures and their editor import caches."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=('linux', 'windows'), required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    out = args.out.resolve()
    dest = out / 'wfile'
    dest.mkdir(parents=True, exist_ok=True)
    w1 = json.loads((out / 'w1/w1.json').read_text())
    if w1['target'] != args.target:
        raise ValueError('w1 target differs')
    table = json.loads(Path(__file__).with_name('wfile-legs.json').read_text())
    shutil.copyfile(Path(__file__).with_name('wfile-legs.json'), dest / 'wfile-legs.json')
    shutil.copyfile(Path(__file__).with_name('wfile-driver.py'), dest / 'wfile-driver.py')
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_')) and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
    for fixture in sorted({leg['fixture'] for leg in table['legs']}):
        project = dest / 'fixtures' / fixture
        imported = dest / 'imports' / fixture
        for path in (project, imported):
            if path.exists():
                shutil.rmtree(path)
        shutil.copytree(rs / 'fixtures' / fixture, project, ignore=shutil.ignore_patterns('.godot'))
        commands = []
        if fixture == 'gate8-tex':
            commands.append(['--script', 'res://make_sources.gd'])
        commands.append(['--import'])
        with (dest / f'{fixture}-import.log').open('wb') as log:
            for tail in commands:
                subprocess.run(['mise', 'exec', '--', 'godot', '--headless', '--path', str(project), *tail], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
        cache = project / '.godot'
        if not cache.is_dir() or not any(p.is_file() for p in cache.rglob('*')):
            raise ValueError(f'missing or empty import: {fixture}')
        imported.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(cache), imported)
    config = {key: '../w1/' + w1[key] for key in ('template', 'extension', 'record')}
    config.update(target=args.target, template_sha256=w1['template_sha256'], legs='wfile-legs.json', timeout_s=180)
    (dest / 'wfile.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    if args.target == 'windows':
        manifest_path = out / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        for gate in ('gate0', 'gate1', 'gate2', 'gate8'):
            for rep in ('a', 'b'):
                manifest['tests'].append({'name': f'wfile-{gate}-{rep}', 'exe': 'wfile/wfile-driver.py', 'interpreter': 'python', 'args': ['--config', 'wfile/wfile.json', '--gate', gate, '--rep', rep], 'env': {}, 'timeout_s': 900})
        manifest['tests'].append({'name': 'wfile-sabotage', 'exe': 'wfile/wfile-driver.py', 'interpreter': 'python', 'args': ['--config', 'wfile/wfile.json', '--gate', 'gate8', '--rep', 'a', '--sabotage', 'decode-off'], 'env': {}, 'timeout_s': 900})
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'wfile bundle: {dest}; total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
