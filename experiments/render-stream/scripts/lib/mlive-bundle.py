#!/usr/bin/env python3
"""Prepare macOS live fixture/core inputs on Ubuntu; attach native dylibs on macOS."""
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
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    out = args.out.resolve()
    live = out / 'mlive'
    live.mkdir(parents=True, exist_ok=True)
    project = live / 'fixtures/tag-scene'
    if project.exists():
        shutil.rmtree(project)
    shutil.copytree(rs / 'fixtures/tag-scene', project, ignore=shutil.ignore_patterns('.godot'))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))
           and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
    with (live / 'import.log').open('wb') as log:
        subprocess.run(['bash', str(rs / 'scripts/lib/quiet.sh'), 'shared', '--', 'mise', 'exec', '--',
                        'godot', '--headless', '--path', str(project), '--import'],
                       cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
    imported = project / '.godot'
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob('*')):
        raise ValueError('tag-scene import cache missing or empty')
    cache = live / 'imports/tag-scene'
    if cache.exists():
        shutil.rmtree(cache)
    cache.parent.mkdir(exist_ok=True)
    shutil.move(str(imported), cache)
    with (live / 'core-build.log').open('wb') as log:
        subprocess.run(['bash', str(repo / 'packages/render-stream-client/scripts/build-web.sh'), str(live / 'core')],
                       cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    for arch in ('arm64', 'x86_64'):
        runtime = json.loads((out / f'm1/m1-{arch}.json').read_text())
        if runtime['target'] != 'macos' or runtime['arch'] != arch:
            raise ValueError('m1 target or architecture differs')
        binary = out / 'm1' / runtime['template']
        if hashlib.sha256(binary.read_bytes()).hexdigest() != runtime['template_sha256']:
            raise ValueError('template sha256 differs from pin')
        config = {k: '../m1/' + runtime[k] for k in ('template', 'extension', 'record')}
        config.update(target='macos', arch=arch, template_sha256=runtime['template_sha256'],
                      fixture='fixtures/tag-scene', import_cache='imports/tag-scene')
        (live / f'mlive-{arch}.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    for source in (Path(__file__).with_name('mlive-driver.py'), rs / 'scripts/fetch-cft-macos.py'):
        shutil.copyfile(source, live / source.name)
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'mlive bundle: {live}; total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
