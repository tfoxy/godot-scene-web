#!/usr/bin/env python3
"""Bundle the live host, imported tag fixture and client core; Chrome is fetched on Windows."""
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
    live = out / 'wlive'
    live.mkdir(parents=True, exist_ok=True)
    windows = args.target == 'windows'
    ext = live / 'ext'
    ext.mkdir(exist_ok=True)
    library = 'render_stream_capture.dll' if windows else 'librender_stream_capture.so'
    net = 'render_stream_net.dll' if windows else 'librender_stream_net.so'
    source = out / 'bin' if windows else rs / 'capture/build'
    for name in (library, net):
        shutil.copy2(source / name, ext / name)
    descriptor = (rs / 'capture/render_stream_capture.gdextension.in').read_text()
    configuration = descriptor[descriptor.index('[configuration]'):descriptor.index('[libraries]')]
    (ext / 'render_stream_capture.gdextension').write_text(configuration + f'[libraries]\n{args.target}.x86_64 = "{library}"\n', encoding='utf-8')
    calibration = rs / 'calibration' / f'godot-4.5.1-stable-{args.target}-release.json'
    shutil.copyfile(calibration, live / 'calibration.json')
    pin = json.loads(calibration.read_text())['engine']['sha256']
    name = 'windows_release_x86_64.exe' if windows else 'linux_release.x86_64'
    # Reuse W1's pinned template in Windows bundles, without changing W1's extension directory.
    if windows:
        template = '../w1/' + name
        binary = live / template
    else:
        template = name
        binary = live / name
        shutil.copy2(Path.home() / '.cache/godot-render-stream/templates/4.5.1-stable' / name, binary)
    if hashlib.sha256(binary.read_bytes()).hexdigest() != pin:
        raise ValueError('template sha256 differs from calibration pin')
    project = live / 'fixtures/tag-scene'
    if project.exists():
        shutil.rmtree(project)
    shutil.copytree(rs / 'fixtures/tag-scene', project, ignore=shutil.ignore_patterns('.godot'))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    with (live / 'import.log').open('wb') as log:
        subprocess.run(['bash', str(rs / 'scripts/lib/quiet.sh'), 'shared', '--', 'mise', 'exec', '--', 'godot',
                        '--headless', '--path', str(project), '--import'], cwd=repo, env=env,
                       stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
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
                       cwd=repo, stdout=log, stderr=subprocess.STDOUT, check=True)
    for src, dest in ((Path(__file__).with_name('wlive-driver.py'), 'wlive-driver.py'),
                      (rs / 'scripts/fetch-cft-windows.py', 'fetch-cft-windows.py'),
                      (Path(__file__).with_name('wlive-probe.html'), 'wlive-probe.html')):
        shutil.copyfile(src, live / dest)
    config = {'target': args.target, 'template': template, 'template_sha256': pin,
              'extension': 'ext/render_stream_capture.gdextension', 'record': 'calibration.json',
              'fixture': 'fixtures/tag-scene', 'import': 'imports/tag-scene'}
    (live / 'wlive.json').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    manifest = {'schema': 'render-stream-w-manifest/1', 'tests': [
        {'name': 'wlive-' + leg, 'exe': 'wlive/wlive-driver.py', 'interpreter': 'python',
         'args': ['--config', 'wlive/wlive.json', '--leg', leg], 'env': {}, 'timeout_s': 900 if leg == 'carriers' else 600}
        for leg in ('carriers', 'wss')], 'imports_only': [], 'sabotage': []}
    (live / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    if size > 300_000_000:
        raise ValueError(f'bundle exceeds 300 MB: {size} bytes')
    print(f'wlive bundle: {live}, total bundle bytes={size}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
