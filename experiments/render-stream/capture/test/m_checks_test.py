#!/usr/bin/env python3
"""Engine-free regression tests for Mach-O import/signature gates and native result plumbing."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


imports = load("m_imports", SCRIPTS / "m-imports.py")
sign = load("m_sign", SCRIPTS / "m-sign.py")
runner = load("m_run", SCRIPTS / "lib/m-run.py")
planner = load("smoke_plan", SCRIPTS / "lib/smoke-plan.py")
matrix = load("remote_matrix", SCRIPTS / "lib/remote-matrix.py")


def macho(arch="arm64", names=("/usr/lib/libSystem.B.dylib",), endian="<", identity=None):
    commands = []
    entries = [(0xC, name) if isinstance(name, str) else name for name in names]
    if identity:
        entries.insert(0, (0xD, identity))
    for cmd, name in entries:
        name = name.encode() + b"\0"
        length = (24 + len(name) + 7) & ~7
        commands.append(struct.pack(endian + "6I", cmd, length, 24, 0, 0, 0)
                        + name + bytes(length - 24 - len(name)))
    header = struct.pack(endian + "8I", 0xFEEDFACF,
                         next(cpu for cpu, label in imports.ARCHES.items() if label == arch),
                         0, 6 if identity else 2, len(commands), sum(map(len, commands)), 0, 0)
    return header + b"".join(commands)


def fat(images, endian=">", wide=False):
    stride = 32 if wide else 20
    offset = 8 + stride * len(images)
    offset = (offset + 7) & ~7
    entries, payload = [], bytes(offset - 8 - stride * len(images))
    for arch, data in images:
        cpu = next(cpu for cpu, label in imports.ARCHES.items() if label == arch)
        values = (cpu, 0, offset, len(data), 3) + ((0,) if wide else ())
        entries.append(struct.pack(endian + ("IIQQII" if wide else "5I"), *values))
        padding = (-len(data)) % 8
        payload += data + bytes(padding)
        offset += len(data) + padding
    return struct.pack(endian + "II", 0xCAFEBABF if wide else 0xCAFEBABE, len(images)) + b"".join(entries) + payload


class ImportTests(unittest.TestCase):
    def test_thin_byte_orders(self):
        for endian in ("<", ">"):
            for arch in ("arm64", "x86_64"):
                with self.subTest(endian=endian, arch=arch):
                    self.assertEqual(imports.slices(macho(arch, endian=endian))[0]["arch"], arch)

    def test_all_dylib_load_commands(self):
        for command in imports.LOADS:
            with self.subTest(command=command):
                self.assertEqual(imports.slices(macho(names=[(command, "@rpath/libc++.dylib")]))[0]["imports"],
                                 ["@rpath/libc++.dylib"])

    def test_universal_formats(self):
        for endian in ("<", ">"):
            for wide in (False, True):
                with self.subTest(endian=endian, wide=wide):
                    images = [(arch, macho(arch)) for arch in ("arm64", "x86_64")]
                    self.assertEqual([s["arch"] for s in imports.slices(fat(images, endian, wide))],
                                     ["arm64", "x86_64"])

    def test_allowlist(self):
        for path in ("/usr/lib/libc++.1.dylib", "/System/Library/Frameworks/Security.framework/Security"):
            self.assertTrue(imports.allowed(path))
        for path in ("/opt/homebrew/lib/libc++.dylib", "/usr/local/lib/foo.dylib", "@rpath/libc++.dylib",
                     "@loader_path/foo.dylib", "/usr/library/foo", "/usr/lib/../../opt/foo"):
            self.assertFalse(imports.allowed(path), path)

    def test_identity_is_not_import(self):
        image = imports.slices(macho(identity="@rpath/self.dylib"))[0]
        self.assertEqual(image["identity"], "@rpath/self.dylib")
        self.assertNotIn(image["identity"], image["imports"])

    def test_disallowed_in_only_one_slice_fails_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fat"
            path.write_bytes(fat([("x86_64", macho("x86_64")),
                                  ("arm64", macho(names=[(0x80000018, "/opt/homebrew/lib/bad.dylib")]))]))
            result = subprocess.run([sys.executable, "-I", str(SCRIPTS / "m-imports.py"),
                                     "--otool", "", "--require-universal", str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("/opt/homebrew/lib/bad.dylib", result.stdout)
            self.assertIn("FAIL", result.stdout)

    def test_require_universal_rejects_thin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "thin"
            path.write_bytes(macho())
            with patch.object(sys, "argv", ["m-imports", "--otool", "", "--require-universal", str(path)]):
                self.assertEqual(imports.main(), 2)

    def test_otool_crosscheck_including_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "image"
            path.write_bytes(macho(identity="@rpath/self.dylib"))
            output = "image:\n\t@rpath/self.dylib (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n"
            with patch.object(imports.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)) as call:
                imports.inspect(path, "otool")
                self.assertEqual(call.call_args.args[0], ["otool", "-arch", "arm64", "-L", str(path)])
            with patch.object(imports.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "image:\n")):
                with self.assertRaisesRegex(ValueError, "otool disagreement"):
                    imports.inspect(path, "otool")

    def test_truncation_and_command_corruption_fail_closed(self):
        valid = macho()
        malformed = [valid[:n] for n in (0, 3, 20, len(valid) - 1)]
        for field, value in ((16, 2), (20, 0), (36, 7), (40, 8)):
            data = bytearray(valid)
            struct.pack_into("<I", data, field, value)
            malformed.append(data)
        for index, data in enumerate(malformed):
            with self.subTest(index=index), self.assertRaises(ValueError):
                imports.slices(data)

    def test_unterminated_name(self):
        data = bytearray(macho(names=["x" * 7]))
        data[-1] = 120
        with self.assertRaisesRegex(ValueError, "unterminated"):
            imports.slices(data)

    def test_duplicate_overlapping_and_mismatched_slices(self):
        images = [(arch, macho(arch)) for arch in ("arm64", "x86_64")]
        valid = fat(images)
        malformed = [fat([images[0], images[0]])]
        for field, value in ((28, 0x0100000C), (36, struct.unpack_from(">I", valid, 16)[0]), (24, 64)):
            data = bytearray(valid)
            struct.pack_into(">I", data, field, value)
            malformed.append(data)
        for data in malformed:
            with self.assertRaises(ValueError):
                imports.slices(data)


class PlanningTests(unittest.TestCase):
    @unittest.skipUnless(platform.system() == "Linux", "local non-Darwin dispatcher regression")
    def test_local_capture_and_milestone_sweeps_defer_macos(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, extra in (("capture", []), ("milestone", ["--milestone"])):
                with self.subTest(sweep=name):
                    out = Path(directory) / name
                    env = dict(os.environ)
                    env.pop("RS_VALIDATE_STUB", None)
                    result = subprocess.run([
                        "bash", str(SCRIPTS / "validate-increment.sh"),
                        "--paths", "experiments/render-stream/capture/src/rs_platform.h",
                        "--only", "macos", "--out", str(out), *extra,
                    ], env=env, text=True, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("macos deferred: needs scripts/remote-validate.sh --only macos",
                                  result.stdout)
                    plan = json.loads((out / "plan.json").read_text())
                    self.assertIn("macos", [run["id"] for run in plan["runs"]])
                    summary = json.loads((out / "validate-summary.json").read_text())
                    self.assertEqual(summary["failed"], 0)
                    self.assertEqual(summary["runs"], [])
                    self.assertEqual(summary["deferred"], [{
                        "id": "macos", "reason": "needs scripts/remote-validate.sh --only macos",
                    }])
                    self.assertFalse((out / "macos").exists(), "native runner must not launch")

    @unittest.skipUnless(platform.system() == "Linux", "explicit non-Darwin build refusal")
    def test_explicit_macos_build_still_refuses_linux(self):
        result = subprocess.run(["bash", str(SCRIPTS / "build-capture.sh"), "--target", "macos"],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--target macos requires a macOS host", result.stderr)

    @unittest.skipUnless(platform.system() == "Linux", "Linux local dispatcher stubs")
    def test_dispatcher_stubs_still_run_and_preserve_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / "stub.sh"
            for rc in (0, 7):
                with self.subTest(rc=rc):
                    stub.write_text(f'exit {rc}\n')
                    out = root / str(rc)
                    result = subprocess.run([
                        "bash", str(SCRIPTS / "validate-increment.sh"),
                        "--paths", "experiments/render-stream/capture/src/rs_platform.h",
                        "--only", "macos", "--out", str(out),
                    ], env={**os.environ, "RS_VALIDATE_STUB": str(stub)},
                        text=True, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, int(rc != 0), result.stdout + result.stderr)
                    summary = json.loads((out / "validate-summary.json").read_text())
                    self.assertEqual(summary["deferred"], [])
                    self.assertEqual(summary["failed"], int(rc != 0))
                    self.assertEqual([(row["id"], row["rc"]) for row in summary["runs"]],
                                     [("macos", str(rc))])

    def test_macos_toolchain_reaches_native_plan(self):
        mapping = json.loads((SCRIPTS / "smoke-map.json").read_text())
        plan = planner.plan(mapping, ["experiments/render-stream/capture/cmake/macos.cmake"],
                            str(SCRIPTS.parents[2]), only="macos")
        self.assertIn({"id": "macos", "kind": "macos", "phase": "setup"}, plan["runs"])
        self.assertIn("macos", mapping["remote"]["capable"])

    def test_macos_is_two_native_jobs_plus_equivalence_without_generic_ubuntu_jobs(self):
        for det in ([], [3, 1]):
            with self.subTest(determinism=det):
                plan = matrix.expand(["macos"], determinism=det, table={})
                self.assertEqual(plan["include"], [])
                self.assertEqual(plan["shards"], {"macos": 3})
                mixed = matrix.expand(["macos", "capture-build"], determinism=det, table={})
                self.assertTrue(mixed["include"])
                self.assertTrue(all(job["id"] == "capture-build" for job in mixed["include"]))
                self.assertEqual(mixed["shards"]["macos"], 3)

    def test_merge_requires_both_architectures_and_equivalence_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote.json"
            remote.write_text(json.dumps({"shards": matrix.expand(["macos"], table={})["shards"]}))
            jobs = []
            for name in ("arm64", "x86_64", "equivalence"):
                job = root / name
                job.mkdir()
                row = {"id": "macos", "phase": "setup", "rc": "0", "wall_s": 12,
                       "lock_wait_s": 0, "lock_hold_s": 0, "lock": {}, "lock_summaries": 0,
                       "skipped_by_tier": 0, "skipped_remote": [], "skipped_remote_groups": [],
                       "unavailable": [], "known_flakes": [], "failing": []}
                (job / "validate-summary.json").write_text(json.dumps({"partial": True, "runs": [row]}))
                jobs.append(str(job))
            selections = [(jobs, 0, "0"), ([], 1, "missing")]
            selections.extend((jobs[:i] + jobs[i + 1:], 1, "missing") for i in range(len(jobs)))
            for selected, expected_rc, expected_row_rc in selections:
                with self.subTest(jobs=selected):
                    result = subprocess.run([sys.executable, "-I", str(SCRIPTS / "lib/validate-summary.py"),
                        "--merge", "--out", str(root / "merged"), "--expect", "macos", "--remote-json",
                        str(remote), *selected], capture_output=True, text=True)
                    self.assertEqual(result.returncode, expected_rc, result.stdout + result.stderr)
                    summary = json.loads((root / "merged/validate-summary.json").read_text())
                    self.assertEqual(len(summary["runs"]), 1)
                    self.assertEqual(summary["runs"][0]["rc"], expected_row_rc)
                    self.assertEqual(summary["failed"], expected_rc)
                    if not expected_rc:
                        self.assertEqual(len(summary["runs"][0]["shards"]), 3)


class SignatureAndRunnerTests(unittest.TestCase):
    def test_sign_verifies_every_architecture(self):
        with patch.object(sign.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as call:
            self.assertEqual(sign.verify("image", "codesign")["rc"], 0)
            self.assertEqual(call.call_args.args[0], ["codesign", "--verify", "--strict", "--all-architectures", "image"])

    def test_unsigned_rejected(self):
        with patch.object(sys, "argv", ["m-sign", "--codesign", "codesign", "arm64-image"]), \
                patch.object(sign.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "code object is not signed at all")):
            self.assertEqual(sign.main(), 1)

    def test_missing_codesign_is_error(self):
        with patch.object(sys, "argv", ["m-sign", "image"]), patch.object(sign.shutil, "which", return_value=None):
            self.assertEqual(sign.main(), 2)

    def test_sabotage_requires_exact_rejection_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            for actual, want in ((0, 1), (1, 0), (2, 1)):
                result = runner.run_check("negative", [sys.executable, "-c", f"raise SystemExit({actual})"],
                                          root, root, expected_rc=1)
                self.assertEqual(result["rc"], want)

    def test_ctest_counts_and_skipped_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ctest.xml"
            path.write_text('<testsuite tests="1" failures="0"><testcase name="abi"/></testsuite>')
            self.assertEqual(runner.ctest_counts(path)["tests"], 1)
            for xml in ('<testsuite tests="0"/>', '<testsuite tests="1" skipped="1"><testcase/></testsuite>',
                        '<testsuite tests="1"><testcase><skipped/></testcase></testsuite>',
                        '<testsuite tests="2"><testcase/></testsuite>'):
                path.write_text(xml)
                with self.assertRaises(ValueError):
                    runner.ctest_counts(path)

    def test_ctest_requires_posix_suites_and_sigpipe_control_and_sabotage(self):
        names = ("rs_ws", "rs_carrier_set", "rs_texture_cache", "rs_publish",
                 "rs_sigpipe", "rs_sigpipe_no_nosigpipe")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ctest.xml"
            for omitted in (None, *names):
                selected = [name for name in names if name != omitted]
                path.write_text(f'<testsuite tests="{len(selected)}">' +
                                ''.join(f'<testcase name="{name}"/>' for name in selected) +
                                '</testsuite>')
                if omitted is None:
                    self.assertEqual(runner.ctest_counts(path, required=names)["tests"], 6)
                else:
                    with self.assertRaisesRegex(ValueError, "missing required tests"):
                        runner.ctest_counts(path, required=names)

    def test_native_run_rejects_missing_sigpipe_sabotage_before_import_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            bundle = repo / "experiments/render-stream/capture/build/macos/bundle"
            bundle.mkdir(parents=True)
            names = ("rs_ws", "rs_carrier_set", "rs_texture_cache", "rs_publish", "rs_sigpipe")
            (bundle / "ctest.xml").write_text('<testsuite tests="5">' +
                ''.join(f'<testcase name="{name}"/>' for name in names) + '</testsuite>')
            out = repo / "out"
            with patch.object(sys, "argv", ["m-run", "--repo", str(repo), "--out", str(out),
                                            "--label", "macos-arm64"]), \
                    patch.object(runner.platform, "system", return_value="Darwin"), \
                    patch.object(runner.platform, "machine", return_value="arm64"), \
                    patch.object(runner, "run_check", return_value={"name": "m-build", "rc": 0,
                                                                   "wall_s": 0}) as build:
                self.assertEqual(runner.main(), 1)
            self.assertEqual(build.call_count, 1)
            self.assertIn("ctest missing required tests: ['rs_sigpipe_no_nosigpipe']",
                          (out / "logs/m-bundle.log").read_text())

    def test_wrong_host_preserves_failed_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(sys, "argv", ["m-run", "--repo", str(root), "--out", str(root / "out"), "--label", "macos-arm64"]), \
                    patch.object(runner.platform, "system", return_value="Linux"):
                self.assertEqual(runner.main(), 1)
            summary = json.loads((root / "out/validate-summary.json").read_text())
            self.assertEqual(summary["runs"][0]["id"], "macos")
            self.assertEqual(summary["failed"], 1)
            self.assertTrue((root / "out/evidence/macos-arm64/m-bundle.log").exists())


if __name__ == "__main__":
    # Expected negative diagnostics are useful under -v, but keep passing ctest output quiet.
    with contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
