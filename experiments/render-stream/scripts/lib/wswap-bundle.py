#!/usr/bin/env python3
"""Bundle capture-scale and its import cache, referencing the existing W1 runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=('windows', 'linux'))
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    out = args.out.resolve()
    w1 = json.loads((out / 'w1/w1.json').read_text(encoding='utf-8'))
    if w1['target'] != args.target:
        raise ValueError('w1 target differs')
    dest = out / 'wswap'
    dest.mkdir(parents=True, exist_ok=True)
    config = {key: '../w1/' + w1[key] for key in ('template', 'extension', 'record')}
    config.update(target=args.target, template_sha256=w1['template_sha256'],
                  fixture='fixtures/capture-scale', **{'import': 'imports/capture-scale'})
    if hashlib.sha256((dest / config['template']).read_bytes()).hexdigest() != config['template_sha256']:
        raise ValueError('template sha256 differs from pin')
    project = dest / config['fixture']
    cache = dest / config['import']
    for path in (project, cache):
        if path.exists():
            shutil.rmtree(path)
    shutil.copytree(rs / 'fixtures/capture-scale', project, ignore=shutil.ignore_patterns('.godot'))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    with (dest / 'import.log').open('wb') as log:
        subprocess.run(['bash', str(rs / 'scripts/lib/quiet.sh'), 'shared', '--', 'mise', 'exec', '--', 'godot',
                        '--headless', '--path', str(project), '--import'], cwd=repo, env=env,
                       stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
    imported = project / '.godot'
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob('*')):
        raise ValueError('capture-scale import cache missing or empty')
    cache.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(imported), cache)
    shutil.copyfile(Path(__file__).with_name('wswap-driver.py'), dest / 'wswap-driver.py')
    (dest / 'wswap.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    manifest = {'schema': 'render-stream-w-manifest/1', 'tests': [
        {'name': 'wswap', 'exe': 'wswap/wswap-driver.py', 'interpreter': 'python',
         'args': ['--config', 'wswap/wswap.json'], 'env': {}, 'timeout_s': 1500}],
        'imports_only': [], 'sabotage': []}
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'wswap bundle: {dest}, total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
