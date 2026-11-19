#!/usr/bin/env python3
"""Engine-free regressions for native file-sink selection and the macOS equivalence gate."""
import contextlib
import importlib.util
import io
import json
import shutil
from pathlib import Path
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


driver = load('mfile-driver')
equiv = load('m-equiv')


class NativeDriver(unittest.TestCase):
    def test_native_slice_is_required_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'target': 'macos', 'arch': 'arm64'}))
            for system, arch, expected in [('Darwin', 'arm64', 0), ('Darwin', 'x86_64', 2), ('Linux', 'arm64', 2)]:
                with self.subTest(system=system, arch=arch), \
                     patch.object(sys, 'argv', ['mfile', '--config', str(path), '--gate', 'gate0']), \
                     patch.object(driver.platform, 'system', return_value=system), \
                     patch.object(driver.platform, 'machine', return_value=arch), \
                     patch.object(driver.portable, 'main', return_value=0) as launch, \
                     contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(driver.main(), expected)
                    self.assertEqual(launch.call_count, int(expected == 0))

    def test_linux_and_offline_inspection_use_the_shared_driver(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            for target, mode in [('linux', []), ('macos', ['--check-against-runner', directory]),
                                 ('macos', ['--evaluate-only', directory])]:
                path.write_text(json.dumps({'target': target, 'arch': 'arm64'}))
                with self.subTest(target=target, mode=mode), \
                     patch.object(sys, 'argv', ['mfile', '--config', str(path), '--gate', 'gate0', *mode]), \
                     patch.object(driver.platform, 'system', return_value='Linux'), \
                     patch.object(driver.portable, 'main', return_value=0) as launch:
                    self.assertEqual(driver.main(), 0)
                    launch.assert_called_once()


class EquivalenceGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.roots = [self.directory / name for name in ('linux-a', 'linux-b', 'macos-a', 'macos-b')]
        self.legs = [{'path': 'capture', 'sinks': ['recording.rs2'], 'store': True}]
        self.expected = {'capture/recording.rs2'}
        for index, root in enumerate(self.roots):
            capture = root / 'capture'
            (capture / 'evidence').mkdir(parents=True)
            (capture / 'store').mkdir()
            (capture / 'recording.rs2').write_bytes(b'content')
            (capture / 'store/index.jsonl').write_text('')
            (capture / 'store/payload').write_bytes(b'payload')
            (capture / 'steps.jsonl').write_text('{"step":1,"applied_frame":2,"settle_frame":3}\n')
            (capture / 'evidence/calibration-check.json').write_text(json.dumps({
                'checks': [{'name': 'exe_sha256' if index < 2 else 'slice_sha256'}]}))
        self.allowance = ['session_id', 'stream.stream_id', 'engine.sha256']
        self.calls = []

    def compare(self, command, a, b, expected, cross, tree, logs, name, repo):
        self.calls.append((a, b, cross, tree))
        mapped = {}
        for key in expected:
            pa, pb = (a / key, b / key) if tree else (a, b)
            different = not pa.is_file() or not pb.is_file() or pa.read_bytes() != pb.read_bytes()
            mapped[key] = {'identical': not different, 'whole_file_identical': False,
                           'allowed': [{'type': 'session', 'paths': self.allowance if cross else ['session_id']}],
                           'differing': [{'index': 1, 'type': 'transaction', 'paths': ['items.0.rect.x']}]
                           if different else []}
        return {'errors': [], 'rows': list(mapped.values())}, mapped

    def judge(self):
        with patch.object(equiv.portable, 'compare', side_effect=self.compare):
            return equiv.judge_gate('gate0', self.legs, self.expected, self.roots, [], self.directory, self.directory)

    def test_requires_both_repeats_and_every_cross_pair(self):
        report = self.judge()
        self.assertTrue(report['ok'], report)
        self.assertEqual(len(self.calls), 6)
        self.assertEqual({(a.name, b.name) for a, b, cross, _ in self.calls if cross}, {
            ('linux-a', 'macos-a'), ('linux-a', 'macos-b'), ('linux-b', 'macos-a'), ('linux-b', 'macos-b')})
        self.assertTrue(all(tree for _, _, _, tree in self.calls))

    def test_records_first_differing_index_and_fields_without_a_new_mask(self):
        for root in self.roots[2:]:
            (root / 'capture/recording.rs2').write_bytes(b'changed')
        report = self.judge()
        self.assertFalse(report['ok'])
        item = report['recordings']['capture/recording.rs2']
        self.assertEqual(item['class'], 'finding')
        self.assertEqual(item['pairs']['cross-aa']['differing'][0], {
            'index': 1, 'type': 'transaction', 'paths': ['items.0.rect.x']})

    def test_incomplete_extra_or_disagreeing_recordings_fail(self):
        for mode in ('missing', 'extra', 'repeat'):
            path = self.roots[3] / 'capture/recording.rs2'
            with self.subTest(mode=mode):
                if mode == 'missing':
                    path.unlink()
                elif mode == 'extra':
                    (path.parent / 'recording-extra.rs2').write_bytes(b'content')
                else:
                    path.write_bytes(b'changed')
                self.assertFalse(self.judge()['ok'])
                path.write_bytes(b'content')
                (path.parent / 'recording-extra.rs2').unlink(missing_ok=True)

    def test_blanket_or_unrelated_session_allowances_fail(self):
        for key in ('engine', 'engine.version_string', 'engine.sha256.child'):
            with self.subTest(key=key):
                self.allowance = ['session_id', key]
                report = self.judge()
                self.assertFalse(report['ok'])
                self.assertTrue(any('session-allowance' in error for error in report['errors']))

    def test_missing_or_wrong_platform_provenance_fails(self):
        path = self.roots[2] / 'capture/evidence/calibration-check.json'
        for value in ({'checks': [{'name': 'image_sha256'}]}, {}):
            with self.subTest(value=value):
                path.write_text(json.dumps(value))
                self.assertFalse(self.judge()['ok'])

    def test_store_bytes_and_step_schedule_remain_unmasked(self):
        for name, value in [('store/payload', b'different'),
                            ('steps.jsonl', b'{"step":1,"applied_frame":3,"settle_frame":4}\n')]:
            path = self.roots[3] / 'capture' / name
            old = path.read_bytes()
            with self.subTest(name=name):
                path.write_bytes(value)
                self.assertFalse(self.judge()['ok'])
                path.write_bytes(old)

    def test_negative_test_requires_decoded_content_difference_in_both_sinks(self):
        negative = self.directory / 'negative/a/gate8/capture'
        negative.mkdir(parents=True)
        linux = self.directory / 'linux'
        capture = linux / 'a/gate8/capture'
        capture.mkdir(parents=True)
        sinks = ['recording.rs8', 'recording-patch.rs8']
        for sink in sinks:
            (capture / sink).write_bytes(b'content')
            (negative / sink).write_bytes(b'changed')
        with patch.object(equiv.portable, 'compare', side_effect=self.compare):
            result = equiv.portable.judge_sabotage(self.directory / 'negative', linux, sinks, [], self.directory, self.directory)
            self.assertTrue(all(row['ok'] for row in result.values()))
            (negative / sinks[1]).write_bytes(b'content')
            result = equiv.portable.judge_sabotage(self.directory / 'negative', linux, sinks, [], self.directory, self.directory)
            self.assertFalse(result[sinks[1]]['ok'])
            (negative / sinks[0]).unlink()
            result = equiv.portable.judge_sabotage(self.directory / 'negative', linux, sinks, [], self.directory, self.directory)
            self.assertFalse(result[sinks[0]]['ok'])

    def test_complete_two_slice_artifacts_reach_all_gates_and_negative_tests(self):
        linux = self.directory / 'linux'
        artifacts = {arch: self.directory / arch for arch in equiv.ARCHES}
        table = {}
        for gate in equiv.portable.GATES:
            table[gate] = (self.legs, self.expected)
            for rep, source in zip(('a', 'b'), self.roots[:2]):
                shutil.copytree(source, linux / rep / gate)
            for artifact in artifacts.values():
                for rep, source in zip(('a', 'b'), self.roots[2:]):
                    shutil.copytree(source, artifact / 'mfile' / rep / gate)
        for artifact in artifacts.values():
            negative = artifact / 'mfile-negative/a/gate8/capture'
            negative.mkdir(parents=True)
            (negative / 'recording.rs2').write_bytes(b'changed')
        with patch.object(sys, 'argv', ['m-equiv', '--linux', str(linux),
                         '--arm64-art', str(artifacts['arm64']), '--x86_64-art', str(artifacts['x86_64']),
                         '--out', str(self.directory / 'out')]), \
             patch.object(equiv.portable, 'expected_table', return_value=table), \
             patch.object(equiv.portable, 'compare', side_effect=self.compare), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(equiv.main(), 0)
        report = json.loads((self.directory / 'out/m-equiv.json').read_text())
        self.assertEqual(set(report['architectures']), set(equiv.ARCHES))
        self.assertEqual(len(self.calls), 50)
        self.assertTrue(all(gate['ok'] for arch in report['architectures'].values()
                            for gate in arch['gates'].values()))
        self.assertEqual(json.loads((self.directory / 'out/validate-summary.json').read_text())['failed'], 0)

    def test_missing_architecture_artifacts_cannot_pass(self):
        with patch.object(sys, 'argv', ['m-equiv', '--linux', str(self.directory / 'linux'),
                         '--arm64-art', str(self.directory / 'arm64'), '--x86_64-art', str(self.directory / 'intel'),
                         '--out', str(self.directory / 'out')]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(equiv.main(), 1)
        report = json.loads((self.directory / 'out/m-equiv.json').read_text())
        self.assertTrue(report['errors'])
        self.assertIn('missing-native-slice', report['failing'])
        self.assertTrue((self.directory / 'out/evidence/macos-equiv/m-equiv.json').is_file())

    def test_shared_table_excludes_workers_by_name(self):
        table = json.loads((HERE / 'lib/wfile-legs.json').read_text())
        excluded = {row['path'] for row in table['excluded']}
        self.assertIn('gate8/workers/capture', excluded)
        self.assertIn('gate8/workers/sabotage-publish-before-ready/capture', excluded)
        self.assertEqual(len(table['legs']), 22)


if __name__ == '__main__':
    unittest.main()
