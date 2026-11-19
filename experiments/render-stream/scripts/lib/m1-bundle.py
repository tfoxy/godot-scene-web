#!/usr/bin/env python3
"""Prepare pinned macOS/Linux templates, stock records and an editor-imported gate -1 fixture."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

CHECKS = 'singleton_available concrete_vptr slot_indices_in_range anchors_implemented hooked_slots_pure_in_abstract hooked_slots_implemented_in_concrete slot_count_tail behaviour_probe'.split()
FINGERPRINTS = {
    'linux': 'exe_sha256 version_string build_id pie_and_bias platform'.split(),
    'macos': 'slice_sha256 uuid cpu slice_extent version_string pie_and_bias platform'.split(),
}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def negative_records(record):
    shifted, image = copy.deepcopy(record), copy.deepcopy(record)
    shifted['rendering_server']['object_prefix'] += 1
    for key in ('slots', 'anchors'):
        shifted[key] = {name: slot + 1 for name, slot in shifted[key].items()}
    digest = image['engine']['sha256']
    image['engine']['sha256'] = '0123456789abcdef'[(int(digest[0], 16) + 1) % 16] + digest[1:]
    return shifted, image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=('linux', 'macos'))
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--library', type=Path, help='Capture library; macOS may attach its native-built universal dylib later')
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    dest = args.out.resolve() / 'm1'
    dest.mkdir(parents=True, exist_ok=True)
    macos = args.target == 'macos'
    pin_script = rs / 'scripts' / ('fetch-macos-template.sh' if macos else 'run-gate-minus1.sh')
    key = 'EXPECTED_MACOS_TEMPLATE_SHA256' if macos else 'EXPECTED_BINARY_SHA256'
    pin = re.search(key + r'="([0-9a-f]{64})"', pin_script.read_text()).group(1)
    name = 'godot_macos_release.universal' if macos else 'linux_release.x86_64'
    source = Path(os.environ.get('GRC_MACOS_TEMPLATE', str(Path.home() / '.cache/godot-render-stream/templates/4.5.1-stable' / name))) if macos else Path.home() / '.cache/godot-render-stream/templates/4.5.1-stable' / name
    if hashlib.sha256(source.read_bytes()).hexdigest() != pin:
        raise ValueError('template sha256 differs from script pin')
    shutil.copy2(source, dest / name)
    (dest / name).chmod(0o755)  # Artifact download does not preserve executable mode.
    ext = dest / 'ext'
    ext.mkdir(exist_ok=True)
    library_name = 'librender_stream_capture.' + ('dylib' if macos else 'so')
    library = args.library or (None if macos else rs / 'capture/build' / library_name)
    if library is not None:
        shutil.copy2(library, ext / library_name)
    descriptor = (rs / 'capture/render_stream_capture.gdextension.in').read_text()
    configuration = descriptor[descriptor.index('[configuration]'):descriptor.index('[libraries]')]
    arches = ('arm64', 'x86_64') if macos else ('x86_64',)
    (ext / 'render_stream_capture.gdextension').write_text(configuration + '[libraries]\n' + ''.join(
        f'{args.target}.{arch} = "{library_name}"\n' for arch in arches), encoding='utf-8')
    project = dest / 'spike'
    if project.exists():
        shutil.rmtree(project)
    shutil.copytree(rs / 'fixtures/spike', project, ignore=shutil.ignore_patterns('.godot'))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_')) and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
    result = subprocess.run(['mise', 'exec', '--', 'godot', '--headless', '--path', str(project), '--import'],
                            cwd=repo, env=env, capture_output=True, timeout=180)
    (dest / 'import.log').write_bytes(result.stdout + result.stderr)
    result.check_returncode()
    imported = project / '.godot'
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob('*')):
        raise ValueError('editor import produced no .godot files')
    cache = dest / 'spike-import'
    if cache.exists():
        shutil.rmtree(cache)
    shutil.move(str(imported), cache)
    for arch in arches:
        record_name = f'godot-4.5.1-stable-macos-{arch}-release.json' if macos else 'godot-4.5.1-stable-linux-release.json'
        record = json.loads((rs / 'calibration' / record_name).read_text())
        if record['engine']['file_sha256' if macos else 'sha256'] != pin:
            raise ValueError('template pin differs from stock record')
        cal = dest / 'calibration' / arch
        cal.mkdir(parents=True, exist_ok=True)
        write_json(cal / 'record.json', record)
        shifted, image = negative_records(record)
        write_json(cal / 'shift.json', shifted)
        write_json(cal / 'image.json', image)
        config = {'target': args.target, 'arch': arch, 'template': name, 'template_sha256': pin,
                  'extension': 'ext/render_stream_capture.gdextension', 'fixture': 'spike', 'import': 'spike-import',
                  'check_names': FINGERPRINTS[args.target] + CHECKS, 'expected_anchors': None, 'timeout_s': 180,
                  'expected': json.loads((project / 'expected.json').read_text())}
        config.update({key: f'calibration/{arch}/{file}.json' for key, file in
                       (('record', 'record'), ('shift_record', 'shift'), ('image_record', 'image'))})
        write_json(dest / (f'm1-{arch}.json' if macos else 'm1.json'), config)
    for script in ('m1-driver.py', 'w1-driver.py'):
        shutil.copyfile(Path(__file__).with_name(script), dest / script)
    print(f'm1 bundle: {dest}; native records: {", ".join(arches)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
