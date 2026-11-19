#!/usr/bin/env python3
"""Regression checks for the stock-template bundle and platform-aware runtime judge."""
import contextlib
import copy
import importlib.util
import io
import json
import os
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


driver = load('m1-driver')
bundle = load('m1-bundle')
evaluate = driver.portable.evaluate if os.environ.get('M1_TEST_BASELINE') else driver.evaluate


class CalibrationJudge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        (self.directory / 'evidence').mkdir()
        (self.directory / 'stdout.txt').write_text('frames=400\n[fixture] extension load status=OK\n')
        (self.directory / 'exit-code.txt').write_text('0\n')

    def fixture(self, target, leg):
        config = {'target': target, 'check_names': bundle.FINGERPRINTS[target] + bundle.CHECKS,
                  'expected_anchors': None}
        names = config['check_names'] + ['hook_plan']
        if leg == 'refuse-image':
            names = bundle.FINGERPRINTS[target]
        elif leg == 'refuse-shift':
            names = names[:-2]
        table = [{'name': name, 'ok': not (leg == 'refuse-image' and index == 0
                                         or leg == 'refuse-shift' and name == 'anchors_implemented')}
                 for index, name in enumerate(names)]
        result = {'status': 'validated' if leg == 'validate' else 'refused', 'vptr_written': False}
        if leg != 'validate':
            result['reason'] = 'fingerprint-mismatch' if leg == 'refuse-image' else 'slot-mask-mismatch'
        self.write('result.json', result)
        self.write('calibration-check.json', {'checks': table})
        return config, table

    def write(self, name, data):
        (self.directory / 'evidence' / name).write_text(json.dumps(data))

    def test_macos_validate_checks_all_15_and_hook_plan(self):
        config, _ = self.fixture('macos', 'validate')
        checks = evaluate(self.directory, 'validate', config)
        self.assertTrue(all(ok for _, ok, _ in checks), checks)

    def test_macos_refuse_image_checks_all_seven_identity_fields(self):
        config, _ = self.fixture('macos', 'refuse-image')
        checks = evaluate(self.directory, 'refuse-image', config)
        self.assertTrue(all(ok for _, ok, _ in checks), checks)

    def test_macos_refuse_shift_checks_all_14_before_behaviour_probe(self):
        config, _ = self.fixture('macos', 'refuse-shift')
        checks = evaluate(self.directory, 'refuse-shift', config)
        self.assertTrue(all(ok for _, ok, _ in checks), checks)

    def test_linux_unchanged_checks_and_negative_tests(self):
        for leg in ('validate', 'refuse-image', 'refuse-shift'):
            with self.subTest(leg=leg):
                config, _ = self.fixture('linux', leg)
                checks = evaluate(self.directory, leg, config)
                self.assertTrue(all(ok for _, ok, _ in checks), checks)

    def test_missing_extra_reordered_and_failed_checks_are_refused(self):
        for leg in ('validate', 'refuse-image', 'refuse-shift'):
            config, table = self.fixture('macos', leg)
            bad_value = copy.deepcopy(table)
            bad_value[-1]['ok'] = not bad_value[-1]['ok']
            for bad in (table[:-1], table + [table[0]], list(reversed(table)), bad_value):
                with self.subTest(leg=leg, table=bad):
                    self.write('calibration-check.json', {'checks': bad})
                    checks = evaluate(self.directory, leg, config)
                    self.assertFalse(dict((name, ok) for name, ok, _ in checks)['calibration-checks'])

    def test_native_launch_refuses_a_foreign_macos_slice(self):
        config, _ = self.fixture('macos', 'validate')
        config['arch'] = 'arm64'
        path = self.directory / 'm1.json'
        path.write_text(json.dumps(config))
        for system, arch in (('Linux', 'arm64'), ('Darwin', 'x86_64')):
            with self.subTest(system=system, arch=arch), \
                 patch.object(sys, 'argv', ['m1-driver', '--config', str(path), '--leg', 'validate']), \
                 patch.object(driver.platform, 'system', return_value=system), \
                 patch.object(driver.platform, 'machine', return_value=arch), \
                 patch.object(driver.portable, 'launch') as launch, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(driver.main(), 1)
                launch.assert_not_called()

    def test_other_fixture_assertions_still_fail(self):
        config, _ = self.fixture('macos', 'validate')
        (self.directory / 'exit-code.txt').write_text('1\n')
        checks = evaluate(self.directory, 'validate', config)
        self.assertFalse(dict((name, ok) for name, ok, _ in checks)['exit-code'])


class NegativeRecords(unittest.TestCase):
    def test_both_stock_slices_change_only_the_named_identity_or_slots(self):
        for arch in ('arm64', 'x86_64'):
            with self.subTest(arch=arch):
                record = json.loads((HERE.parent / 'calibration' / f'godot-4.5.1-stable-macos-{arch}-release.json').read_text())
                original = copy.deepcopy(record)
                shifted, image = bundle.negative_records(record)
                self.assertEqual(record, original)
                self.assertEqual(shifted['rendering_server']['object_prefix'], record['rendering_server']['object_prefix'] + 1)
                for key in ('slots', 'anchors'):
                    self.assertEqual(shifted[key], {k: v + 1 for k, v in record[key].items()})
                self.assertEqual(image['engine']['sha256'][1:], record['engine']['sha256'][1:])
                self.assertNotEqual(image['engine']['sha256'][0], record['engine']['sha256'][0])
                image['engine']['sha256'] = record['engine']['sha256']
                self.assertEqual(image, record)


class RuntimeRunner(unittest.TestCase):
    def test_ctest_retries_accepts_missing_or_empty_log(self):
        runner = load('m-run')
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'm-build.log'
            with self.subTest(log='missing'):
                self.assertEqual(runner.ctest_retries(log), [])
            log.touch()
            with self.subTest(log='empty'):
                self.assertEqual(runner.ctest_retries(log), [])

    def test_ctest_retry_attempts_are_reported_without_hiding_failures(self):
        runner = load('m-run')
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'm-build.log'
            log.write_text('''      Start 1: rs_ws
1/3 Test #1: rs_ws ........................***Failed   21.77 sec
FAIL linger flood deadline returns/closes within bound
      Start 1: rs_ws
    Test #1: rs_ws ........................   Passed   20.02 sec
      Start 2: rs_publish
2/3 Test #2: rs_publish ...................   Passed    0.03 sec
      Start 3: rs_sigpipe
3/3 Test #3: rs_sigpipe ...................***Timeout   10.00 sec
      Start 3: rs_sigpipe
3/3 Test #3: rs_sigpipe ...................***Failed    0.01 sec
''')
            self.assertEqual(runner.ctest_retries(log), [
                {'name': 'rs_ws', 'attempts': [
                    {'status': '***Failed', 'wall_s': 21.77},
                    {'status': 'Passed', 'wall_s': 20.02}], 'recovered': True},
                {'name': 'rs_sigpipe', 'attempts': [
                    {'status': '***Timeout', 'wall_s': 10.0},
                    {'status': '***Failed', 'wall_s': 0.01}], 'recovered': False}])
            log.write_text('build stopped before ctest\n')
            self.assertEqual(runner.ctest_retries(log), [])

    def test_build_failure_keeps_retry_evidence(self):
        runner = load('m-run')
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve()
            out = repo / 'out'

            def run(name, argv, repo, out, **kwargs):
                (out / 'logs/m-build.log').write_text(
                    '1/1 Test #1: rs_ws ....***Failed 21.77 sec\n'
                    '    Test #1: rs_ws ....***Failed 21.80 sec\n')
                return {'name': name, 'rc': 1, 'wall_s': 43.57}

            with patch.object(sys, 'argv', ['m-run', '--repo', str(repo), '--out', str(out), '--label', 'macos-arm64']), \
                 patch.object(runner.platform, 'system', return_value='Darwin'), \
                 patch.object(runner.platform, 'machine', return_value='arm64'), \
                 patch.object(runner, 'run_check', side_effect=run), \
                 patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(out / 'summary.md')}), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(runner.main(), 1)
            report = json.loads((out / 'm-run.json').read_text())
            self.assertFalse(report['ctest_retries'][0]['recovered'])
            self.assertEqual(len(report['ctest_retries'][0]['attempts']), 2)
            summary = json.loads((out / 'validate-summary.json').read_text())
            self.assertEqual(summary['failed'], 1)
            self.assertEqual(summary['runs'][0]['known_flakes'], [])
            self.assertIn('rs_ws', (out / 'summary.md').read_text())
            self.assertIn('***Failed', (out / 'summary.md').read_text())

    def test_native_record_selection_and_evidence_on_success_and_failure(self):
        runner = load('m-run')
        for arch in ('arm64', 'x86_64'):
            for fail_leg in (None, 'refuse-image'):
                with self.subTest(arch=arch, fail_leg=fail_leg), tempfile.TemporaryDirectory() as directory:
                    repo = Path(directory).resolve()
                    out, runtime = repo / 'out', repo / 'runtime'
                    build = repo / 'experiments/render-stream/capture/build/macos'
                    native = build / 'bundle'
                    (native / 'bin').mkdir(parents=True)
                    (native / 'bin/abi_convention_probe').touch()
                    (native / 'librender_stream_capture.dylib').write_bytes(b'capture')
                    (native / 'rs-net-build.json').write_text(json.dumps({'tests': {
                        'target': 'aarch64-apple-darwin' if arch == 'arm64' else 'x86_64-apple-darwin', 'ran': True}}))
                    (native / 'rs-net-check.json').write_text('{}')
                    (native / 'build-info.txt').touch()
                    (native / 'ctest.xml').write_text('<testsuite tests="6">' + ''.join(
                        f'<testcase name="{name}"/>' for name in runner.POSIX_CTESTS) + '</testsuite>')
                    for thin in ('arm64', 'x86_64'):
                        (build / thin).mkdir()
                        (build / thin / 'CTestTestfile.cmake').touch()
                    (runtime / 'm1/ext').mkdir(parents=True)
                    template = runtime / 'm1/godot_macos_release.universal'
                    template.write_bytes(b'pinned-template')
                    template.chmod(0o644)
                    calls = []

                    def run(name, argv, repo, out, expected_rc=0, **kwargs):
                        calls.append((name, argv))
                        log = out / 'logs' / (name + '.log')
                        log.write_text('test result: ok. 3 passed; 0 failed; 0 ignored; '
                                       '0 measured; 0 filtered out; finished in 0.00s\n')
                        if name == 'm-build':
                            log.write_text('1/6 Test #1: rs_ws ....***Failed 21.77 sec\n'
                                           '    Test #1: rs_ws ....   Passed 20.02 sec\n')
                        if name == 'm-imports-sabotage':
                            (out / 'imports-sabotage.json').write_text(json.dumps({'binaries': [{'slices': [
                                {'disallowed': [str(out / 'sabotage/non-system.dylib')]}]}]}))
                        if name.startswith('m1-'):
                            leg = name.removeprefix('m1-')
                            evidence = runtime / 'm1/runs' / leg / 'evidence'
                            evidence.mkdir(parents=True)
                            (evidence / 'result.json').write_text(leg)
                            self.assertEqual(argv[-3:], [str(runtime / 'm1' / f'm1-{arch}.json'), '--leg', leg])
                        failed = name == 'm1-' + str(fail_leg)
                        return {'name': name, 'rc': int(failed), 'wall_s': 0.01}

                    with patch.object(sys, 'argv', ['m-run', '--repo', str(repo), '--out', str(out),
                                      '--label', 'macos-' + arch, '--runtime-bundle', str(runtime)]), \
                         patch.object(runner.platform, 'system', return_value='Darwin'), \
                         patch.object(runner.platform, 'machine', return_value=arch), \
                         patch.object(runner, 'run_check', side_effect=run), \
                         patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(out / 'summary.md')}), \
                         contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        rc = runner.main()
                    self.assertEqual(rc, int(fail_leg is not None))
                    self.assertEqual([name[3:] for name, _ in calls if name.startswith('m1-')], list(driver.LEGS))
                    self.assertEqual(template.read_bytes(), b'pinned-template')
                    self.assertTrue(template.stat().st_mode & 0o111)
                    self.assertEqual((runtime / 'm1/ext/librender_stream_capture.dylib').read_bytes(), b'capture')
                    for leg in driver.LEGS:
                        self.assertEqual((out / 'm1' / leg / 'evidence/result.json').read_text(), leg)
                    summary = json.loads((out / 'validate-summary.json').read_text())
                    self.assertEqual(summary['failed'], rc)
                    retries = json.loads((out / 'm-run.json').read_text())['ctest_retries']
                    self.assertEqual([row['name'] for row in retries], ['rs_ws'])
                    self.assertTrue(retries[0]['recovered'])
                    self.assertEqual(summary['runs'][0]['known_flakes'], ['macos-' + arch + ':ctest:rs_ws'])
                    step_summary = (out / 'summary.md').read_text()
                    self.assertIn('rs_ws', step_summary)
                    self.assertIn('***Failed', step_summary)
                    self.assertIn('Passed', step_summary)
                    if fail_leg:
                        self.assertIn('macos-' + arch + ':m1-' + fail_leg, summary['runs'][0]['failing'])
                        self.assertTrue((out / 'evidence' / ('macos-' + arch) / ('m1-' + fail_leg + '.log')).is_file())
                    else:
                        self.assertNotIn(str(template), dict(calls)['m-sign'])
                        file_calls = [(name, argv) for name, argv in calls if name.startswith('mfile-')]
                        self.assertEqual([name for name, _ in file_calls], [
                            f'mfile-{gate}-{rep}' for rep in ('a', 'b')
                            for gate in ('gate0', 'gate1', 'gate2', 'gate8')] + ['mfile-negative'])
                        for name, argv in file_calls:
                            self.assertEqual(argv[5], str(runtime / 'mfile' / f'mfile-{arch}.json'))
                            self.assertEqual(argv[-1], str(out / ('mfile-negative' if name == 'mfile-negative' else 'mfile')))
                        self.assertIn('--sabotage', file_calls[-1][1])
                        self.assertIn('decode-off', file_calls[-1][1])


if __name__ == '__main__':
    unittest.main()
