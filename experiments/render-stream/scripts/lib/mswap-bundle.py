#!/usr/bin/env python3
"""Bundle macOS capture-scale and its import cache, referencing the existing M1 runtime."""
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
    parser.add_argument('--target', required=True, choices=('macos',))
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    out = args.out.resolve()
    dest = out / 'mswap'
    dest.mkdir(parents=True, exist_ok=True)
    configs = {}
    for arch in ('arm64', 'x86_64'):
        m1 = json.loads((out / f'm1/m1-{arch}.json').read_text(encoding='utf-8'))
        if m1['target'] != args.target or m1['arch'] != arch:
            raise ValueError('m1 target or architecture differs')
        config = {key: '../m1/' + m1[key] for key in ('template', 'extension', 'record')}
        config.update(target=args.target, arch=arch, template_sha256=m1['template_sha256'],
                      fixture='fixtures/capture-scale', **{'import': 'imports/capture-scale'})
        if hashlib.sha256((dest / config['template']).read_bytes()).hexdigest() != config['template_sha256']:
            raise ValueError('template sha256 differs from pin')
        configs[arch] = config
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
    for name in ('mswap-driver.py', 'wswap-driver.py'):
        shutil.copyfile(Path(__file__).with_name(name), dest / name)
    for arch, config in configs.items():
        (dest / f'mswap-{arch}.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    manifest = {'schema': 'render-stream-m-manifest/1', 'tests': [
        {'name': 'mswap', 'exe': 'mswap/mswap-driver.py', 'interpreter': 'python',
         'args': ['--config', 'mswap/mswap-{arch}.json'], 'env': {}, 'timeout_s': 1500}]}
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'mswap bundle: {dest}, total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
