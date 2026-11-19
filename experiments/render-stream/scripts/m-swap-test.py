#!/usr/bin/env python3
"""Engine-free regression tests for the macOS swap bundle, driver and runner."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / 'lib' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bundle = load('mswap-bundle')
driver = load('mswap-driver').portable
runner = load('m-run')


class SwapBundle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runtime = self.root / 'runtime'
        m1 = self.runtime / 'm1'
        m1.mkdir(parents=True)
        (m1 / 'host').write_bytes(b'stock universal template')
        self.digest = hashlib.sha256((m1 / 'host').read_bytes()).hexdigest()
        for arch in ('arm64', 'x86_64'):
            (m1 / f'm1-{arch}.json').write_text(json.dumps({
                'target': 'macos', 'arch': arch, 'template': 'host', 'template_sha256': self.digest,
                'extension': 'ext/capture.gdextension', 'record': f'calibration/{arch}/record.json'}))

    def build(self, import_mode='ok'):
        def fake_import(argv, **kwargs):
            self.assertEqual(argv[-1], '--import')
            self.assertIn('--headless', argv)
            self.assertIn('shared', argv)
            self.assertNotIn('DISPLAY', kwargs['env'])
            self.assertNotIn('WAYLAND_DISPLAY', kwargs['env'])
            self.assertFalse(any(k.upper().startswith(('GRC_', 'RS_')) for k in kwargs['env']))
            if import_mode == 'fail':
                raise subprocess.CalledProcessError(1, argv)
            project = Path(argv[argv.index('--path') + 1])
            cache = project / '.godot'
            cache.mkdir()
            if import_mode == 'ok':
                (cache / 'imported').write_text('fake import')
        with patch.object(sys, 'argv', ['bundle', '--target', 'macos', '--out', str(self.runtime)]), \
             patch.object(bundle.subprocess, 'run', side_effect=fake_import), \
             patch.dict(os.environ, {'GRC_MODE': 'bad', 'RS_SCALE_CPU_REPORT': '1', 'DISPLAY': ':99'}), \
             contextlib.redirect_stdout(io.StringIO()):
            return bundle.main()

    def test_bundle_configs_import_manifest_and_driver_copies(self):
        for _ in range(2):
            self.assertEqual(self.build(), 0)
        dest = self.runtime / 'mswap'
        for arch in ('arm64', 'x86_64'):
            config = json.loads((dest / f'mswap-{arch}.json').read_text())
            self.assertEqual(config, {
                'target': 'macos', 'arch': arch, 'template': '../m1/host',
                'extension': '../m1/ext/capture.gdextension',
                'record': f'../m1/calibration/{arch}/record.json', 'template_sha256': self.digest,
                'fixture': 'fixtures/capture-scale', 'import': 'imports/capture-scale'})
        self.assertTrue((dest / 'fixtures/capture-scale/project.godot').is_file())
        self.assertFalse((dest / 'fixtures/capture-scale/.godot').exists())
        self.assertEqual((dest / 'imports/capture-scale/imported').read_text(), 'fake import')
        for name in ('mswap-driver.py', 'wswap-driver.py'):
            self.assertEqual((dest / name).read_bytes(), (HERE / 'lib' / name).read_bytes())
        manifest = runner.read_swap_manifest(self.runtime)
        self.assertEqual(manifest['tests'], [{
            'name': 'mswap', 'exe': 'mswap/mswap-driver.py', 'interpreter': 'python',
            'args': ['--config', 'mswap/mswap-{arch}.json'], 'env': {}, 'timeout_s': 1500}])

    def test_rejects_wrong_target_arch_or_digest(self):
        path = self.runtime / 'm1/m1-arm64.json'
        original = json.loads(path.read_text())
        for key, value in (('target', 'linux'), ('arch', 'x86_64'), ('template_sha256', '0' * 64)):
            with self.subTest(key=key):
                path.write_text(json.dumps({**original, key: value}))
                with self.assertRaises(ValueError):
                    self.build()

    def test_rejects_failed_or_empty_import(self):
        for mode, error in (('fail', subprocess.CalledProcessError), ('empty', ValueError)):
            with self.subTest(mode=mode), self.assertRaises(error):
                self.build(mode)


class SwapDriver(unittest.TestCase):
    def test_macos_omits_the_two_procfs_words_and_pins_the_scalable_zone_for_every_leg(self):
        for leg in driver.LEGS:
            with self.subTest(leg=leg):
                config = {'target': 'linux', 'extension': 'ext/capture', 'record': 'record.json'}
                linux = driver.leg_env(Path('/bundle'), config, Path('/run'), leg)
                config['target'] = 'macos'
                mac = driver.leg_env(Path('/bundle'), config, Path('/run'), leg)
                expected = {k: v for k, v in linux.items()
                            if k not in ('RS_SCALE_CPU_REPORT', 'RS_SCALE_FRAME_LOG')}
                expected['MallocNanoZone'] = '0'
                self.assertEqual(mac, expected)
                self.assertNotIn('MallocNanoZone', linux)
                config['target'] = 'windows'
                windows = driver.leg_env(Path('/bundle'), config, Path('/run'), leg)
                self.assertEqual({k: v for k, v in mac.items() if k != 'MallocNanoZone'}, windows)

    def test_macos_summary_accepts_absent_tsc_but_checks_all_legs(self):
        summary = {'platform': 'macos', 'template_sha256': 'a' * 64,
                   'tsc_hz': None, 'tsc_invariant': None,
                   'legs': {leg: {'exit': 0, 'wall_s': 1} for leg in driver.LEGS},
                   'checks': [{'id': c, 'verdict': 'pass', 'detail': ''} for c in driver.CHECKS]}
        self.assertEqual(driver.summary_problems(summary), [])
        del summary['legs']['swap']
        self.assertIn('summary/legs', driver.summary_problems(summary))

    def test_refuses_foreign_macos_launch_before_running_any_leg(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps({'target': 'macos', 'arch': 'arm64'}))
            for system, arch in (('Linux', 'arm64'), ('Darwin', 'x86_64')):
                with self.subTest(system=system, arch=arch), \
                     patch.object(sys, 'argv', ['driver', '--config', str(config)]), \
                     patch.object(driver.platform, 'system', return_value=system), \
                     patch.object(driver.platform, 'machine', return_value=arch), \
                     patch.object(driver, 'run_leg') as launch:
                    with self.assertRaisesRegex(ValueError, 'native macOS slice'):
                        driver.main(label='mswap', repo_env='MSWAP_REPO_ROOT', artifact_env='M_RUN_ARTIFACT_DIR')
                    launch.assert_not_called()


class SwapRunner(unittest.TestCase):
    def manifest(self, runtime):
        path = runtime / 'mswap/manifest.json'
        path.parent.mkdir(parents=True)
        manifest = {'schema': 'render-stream-m-manifest/1', 'tests': [
            {'name': 'mswap', 'exe': 'mswap/mswap-driver.py', 'interpreter': 'python',
             'args': ['--config', 'mswap/mswap-{arch}.json'], 'env': {}, 'timeout_s': 1500}]}
        path.write_text(json.dumps(manifest))
        return path, manifest

    def test_manifest_refuses_missing_duplicate_or_malformed_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            path, manifest = self.manifest(runtime)
            bad_schema = copy.deepcopy(manifest)
            bad_schema['schema'] = 'other'
            empty = {**manifest, 'tests': []}
            duplicate = {**manifest, 'tests': manifest['tests'] * 2}
            for bad in (bad_schema, empty, duplicate):
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    runner.read_swap_manifest(runtime)
            for key, value in (('name', 'other'), ('interpreter', 'bash'), ('timeout_s', 1),
                               ('exe', 'other.py'), ('args', []), ('env', {'GRC_MODE': 'bad'})):
                bad = copy.deepcopy(manifest)
                bad['tests'][0][key] = value
                path.write_text(json.dumps(bad))
                with self.subTest(key=key), self.assertRaises(ValueError):
                    runner.read_swap_manifest(runtime)

    def test_swap_dispatch_native_configs_groups_and_partial_failures(self):
        for arch in ('arm64', 'x86_64'):
            for fail in (False, True):
                with self.subTest(arch=arch, fail=fail), tempfile.TemporaryDirectory() as directory:
                    repo = Path(directory).resolve()
                    runtime, out = repo / 'runtime', repo / 'out'
                    self.manifest(runtime)
                    (runtime / 'm1/ext').mkdir(parents=True)
                    (runtime / 'm1/host').touch()
                    (runtime / 'm1' / f'm1-{arch}.json').write_text(json.dumps({'template': 'host'}))
                    native = repo / 'experiments/render-stream/capture/build/macos/bundle'
                    native.mkdir(parents=True)
                    (native / 'librender_stream_capture.dylib').write_bytes(b'capture')
                    calls = []
                    def check(name, argv, repo, out, **kwargs):
                        calls.append((name, argv, kwargs))
                        (out / 'logs' / (name + '.log')).write_text('synthetic swap result')
                        return {'name': name, 'rc': int(fail and name == 'mswap'), 'wall_s': 0.01}
                    with patch.object(sys, 'argv', ['m-run', '--suite', 'swap', '--repo', str(repo),
                                      '--out', str(out), '--runtime-bundle', str(runtime), '--label', 'macos-swap-' + arch]), \
                         patch.object(runner.platform, 'system', return_value='Darwin'), \
                         patch.object(runner.platform, 'machine', return_value=arch), \
                         patch.object(runner, 'run_check', side_effect=check), \
                         patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(out / 'summary.md')}), \
                         contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(runner.main(), int(fail))
                    self.assertEqual([c[0] for c in calls], ['m-build', 'm-imports', 'm-sign', 'mswap'])
                    argv, kwargs = calls[-1][1:]
                    self.assertIn(str(runtime / 'mswap' / f'mswap-{arch}.json'), argv)
                    self.assertEqual(kwargs['env']['M_RUN_ARTIFACT_DIR'], str(out / 'artifacts/mswap'))
                    self.assertEqual(kwargs['timeout_s'], 1500)
                    self.assertEqual((runtime / 'm1/ext/librender_stream_capture.dylib').read_bytes(), b'capture')
                    self.assertTrue((runtime / 'm1/host').stat().st_mode & 0o111)
                    report = json.loads((out / 'm-run.json').read_text())
                    self.assertEqual(report['groups']['m-swap'], {'passed': int(not fail), 'total': 1})
                    summary = json.loads((out / 'validate-summary.json').read_text())
                    self.assertEqual(summary['runs'][0]['id'], 'macos')
                    self.assertEqual(summary['failed'], int(fail))
                    self.assertEqual((out / 'evidence' / ('macos-swap-' + arch) / 'mswap.log').is_file(), fail)


if __name__ == '__main__':
    unittest.main()
