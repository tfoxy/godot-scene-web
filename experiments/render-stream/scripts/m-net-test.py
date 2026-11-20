#!/usr/bin/env python3
"""Host-independent regression checks for the native macOS net module build gates."""

import copy
import contextlib
import io
import importlib.util
from pathlib import Path
import os
import json
import shutil
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("m_net_check", HERE / "m-net-check.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Arguments(unittest.TestCase):
    def invoke(self, *args):
        with tempfile.TemporaryDirectory() as directory:
            uname = Path(directory) / "uname"
            uname.write_text("#!/bin/sh\necho Linux\n")
            uname.chmod(0o755)
            return subprocess.run(["bash", str(HERE / "build-rs-net.sh"), *args],
                                  env={**os.environ, "RS_QUIET_BUILD_WRAPPED": "1",
                                       "PATH": directory + os.pathsep + os.environ["PATH"]},
                                  capture_output=True, text=True, timeout=10)

    def test_macos_refuses_non_apple_host_before_building(self):
        for args in (("--target", "macos"), ("--target", "macos", "--no-test")):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("--target macos requires a macOS host", result.stderr)

    def test_invalid_arguments(self):
        for args in (("--target",), ("--target", "other"), ("--wat",),
                     ("--target", "macos", "--manifest-template", "file"),
                     ("--target", "macos", "--no-test", "extra")):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 2)
                self.assertRegex(result.stderr, r"usage:|--target requires")


class Build(unittest.TestCase):
    def test_native_build_orchestration(self):
        for host, host_triple in (("arm64", "aarch64-apple-darwin"), ("x86_64", "x86_64-apple-darwin")):
            for no_test in (False, True):
                with self.subTest(host=host, no_test=no_test), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    scripts, net, tools = root / "scripts", root / "rs-net", root / "tools"
                    for path in (scripts, net, tools):
                        path.mkdir()
                    shutil.copyfile(HERE / "build-rs-net.sh", scripts / "build-rs-net.sh")
                    # The binary gates have separate negative controls below. Here the fake tools
                    # exercise the actual shell orchestration and build-report generation.
                    stub = tools / "tool"
                    stub.write_text("#!" + sys.executable + "\n" + r'''import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ["FAKE_ROOT"])
with (root / "calls.jsonl").open("a") as out:
    out.write(json.dumps([name, args, os.environ.get("MACOSX_DEPLOYMENT_TARGET"), os.environ.get("SDKROOT")]) + "\n")
if name == "uname":
    print("Darwin" if args == ["-s"] else os.environ["FAKE_HOST"])
elif name == "cargo":
    if args == ["--version"]:
        print("cargo fake")
    else:
        triple = args[args.index("--target") + 1]
        dest = root / "rs-net/target" / triple / "release"
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "librender_stream_net.dylib").write_bytes(triple.encode())
        (dest / "rs-net-probe").write_bytes(b"probe")
elif name == "lipo" and args[0] == "-create":
    pathlib.Path(args[-1]).write_bytes(pathlib.Path(args[1]).read_bytes() + pathlib.Path(args[2]).read_bytes())
elif name == "xcrun":
    print("/sdk" if args == ["--show-sdk-path"] else "fake sdk/clang")
elif name in ("rustc", "xcodebuild"):
    print(name + " fake")
elif name == "python3":
    if len(args) > 1 and args[1].endswith("m-net-check.py"):
        pathlib.Path(args[3]).write_text(json.dumps({"path": args[4], "signature": {"path": args[4]}, "slices": []}))
    else:
        os.execv(sys.executable, [sys.executable, *args])
''')
                    stub.chmod(0o755)
                    for name in ("uname", "cargo", "rustc", "xcrun", "xcodebuild", "lipo",
                                 "install_name_tool", "codesign", "python3"):
                        (tools / name).symlink_to(stub)
                    result = subprocess.run(["bash", str(scripts / "build-rs-net.sh"), "--target", "macos",
                                             *(["--no-test"] if no_test else [])],
                        env={**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                             "FAKE_ROOT": str(root), "FAKE_HOST": host}, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
                    cargo = [c for c in calls if c[0] == "cargo" and c[1][0] in ("build", "test")]
                    self.assertEqual(len(cargo), 2 if no_test else 3)
                    for call, triple, minimum in zip(cargo[:2], ("aarch64-apple-darwin", "x86_64-apple-darwin"), ("11.0", "10.15")):
                        self.assertIn(triple, call[1])
                        self.assertTrue(all(flag in call[1] for flag in ("--offline", "--locked", "--release")))
                        self.assertEqual(call[2:], [minimum, "/sdk"])
                    if not no_test:
                        self.assertIn(host_triple, cargo[-1][1])
                        self.assertEqual(cargo[-1][1][0], "test")
                    self.assertTrue(any(c[0] == "install_name_tool" and c[1][:2] == ["-id", check.IDENTITY] for c in calls))
                    self.assertTrue(any(c[0] == "codesign" and c[1][:3] == ["-s", "-", "--force"] for c in calls))
                    out = root / "capture/build/macos/bundle"
                    report = json.loads((out / "rs-net-build.json").read_text())
                    self.assertEqual(report["tests"], {"target": host_triple, "ran": not no_test})
                    self.assertEqual(len(report["slices"]), 2)
                    self.assertEqual(report["checks"]["path"], str(out / "librender_stream_net.dylib"))
                    self.assertEqual(len(report["library_sha256"]), 64)


class Runner(unittest.TestCase):
    def test_crate_summary_requires_executed_tests_without_skips(self):
        spec = importlib.util.spec_from_file_location("m_run", HERE / "lib/m-run.py")
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "build.log"
            for passed, failed, ignored, filtered in ((0, 0, 0, 0), (1, 1, 0, 0), (1, 0, 1, 0), (1, 0, 0, 1)):
                with self.subTest(counts=(passed, failed, ignored, filtered)):
                    log.write_text(f"test result: ok. {passed} passed; {failed} failed; {ignored} ignored; "
                                   f"0 measured; {filtered} filtered out; finished in 0.00s\n")
                    with self.assertRaisesRegex(ValueError, "rs-net did not pass every crate test"):
                        runner.net_test_counts(log)
            log.write_text("cargo did not run any tests\n")
            with self.assertRaisesRegex(ValueError, "rs-net did not pass every crate test"):
                runner.net_test_counts(log)

    def test_net_build_and_failure_fold_into_native_summary(self):
        spec = importlib.util.spec_from_file_location("m_run", HERE / "lib/m-run.py")
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        for arch in ("arm64", "x86_64"):
            for fail_net in (False, True):
                with self.subTest(arch=arch, fail_net=fail_net), tempfile.TemporaryDirectory() as directory:
                    repo = Path(directory).resolve()
                    out = repo / "out"
                    bundle = repo / "experiments/render-stream/capture/build/macos/bundle"
                    (bundle / "bin").mkdir(parents=True)
                    (bundle / "bin/abi_convention_probe").touch()
                    (bundle / "librender_stream_capture.dylib").touch()
                    names = ("abi",) + tuple(runner.POSIX_CTESTS)
                    (bundle / "ctest.xml").write_text(
                        f'<testsuite tests="{len(names)}">'
                        + "".join(f'<testcase name="{name}"/>' for name in names)
                        + "</testsuite>")
                    (bundle / "build-info.txt").write_text("capture toolchain")
                    for thin in ("arm64", "x86_64"):
                        (bundle.parent / thin).mkdir()
                        (bundle.parent / thin / "CTestTestfile.cmake").touch()
                    calls = []
                    target = "aarch64-apple-darwin" if arch == "arm64" else "x86_64-apple-darwin"

                    def run(name, argv, repo, out, expected_rc=0, **kwargs):
                        calls.append((name, argv))
                        log = out / "logs" / (name + ".log")
                        log.write_text("fixture log\n")
                        if name == "m-net-build" and not fail_net:
                            for artifact in ("librender_stream_net.dylib", "rs-net-probe"):
                                (bundle / artifact).write_bytes(b"fixture")
                            (bundle / "rs-net-build.json").write_text(json.dumps({
                                "schema": "rs-net-build/1", "tests": {"target": target, "ran": True}}))
                            (bundle / "rs-net-check.json").write_text("{}")
                            log.write_text("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n"
                                           "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n")
                        if name == "m-imports-sabotage":
                            (out / "imports-sabotage.json").write_text(json.dumps({"binaries": [{"slices": [
                                {"disallowed": [str(out / "sabotage/non-system.dylib")]}]}]}))
                        failed = name == "m-net-build" and fail_net
                        return {"name": name, "rc": int(failed), "process_rc": 1 if failed else expected_rc,
                                "expected_rc": expected_rc, "wall_s": 0.01}

                    summary = out / "step-summary.md"
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with patch.object(sys, "argv", ["m-run", "--repo", str(repo), "--out", str(out), "--label", "macos-" + arch]), \
                         patch.object(runner.platform, "system", return_value="Darwin"), \
                         patch.object(runner.platform, "machine", return_value=arch), \
                         patch.object(runner, "run_check", side_effect=run), \
                         patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), \
                         contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        rc = runner.main()
                    diagnostics = f"stdout:\n{stdout.getvalue()}\nstderr:\n{stderr.getvalue()}"
                    self.assertEqual(rc, int(fail_net), diagnostics)
                    names = [name for name, _ in calls]
                    self.assertIn("m-net-build", names, diagnostics)
                    self.assertLess(names.index("m-build"), names.index("m-net-build"))
                    argv = dict(calls)["m-net-build"]
                    self.assertEqual(argv[-2:], ["--target", "macos"])
                    self.assertTrue(argv[1].endswith("build-rs-net.sh"))
                    folded = json.loads((out / "validate-summary.json").read_text())
                    self.assertEqual(folded["failed"], int(fail_net))
                    if fail_net:
                        self.assertIn("macos-" + arch + ":m-net-build", folded["runs"][0]["failing"])
                        self.assertTrue((out / "evidence" / ("macos-" + arch) / "m-net-build.log").exists())
                    else:
                        report = json.loads((out / "m-run.json").read_text())
                        self.assertEqual(report["net"]["test_counts"]["passed"], 3)
                        self.assertTrue((out / "rs-net-build.json").exists())
                        self.assertTrue((out / "rs-net-check.json").exists())
                        self.assertIn(str(bundle / "librender_stream_net.dylib"), dict(calls)["m-imports"])
                        self.assertIn("rs-net: 3 passed", summary.read_text())


class Gates(unittest.TestCase):
    def setUp(self):
        self.binary = {"path": "net.dylib", "slices": [
            {"arch": arch, "imports": ["/usr/lib/libSystem.B.dylib"], "disallowed": [],
             "identity": check.IDENTITY} for arch in ("arm64", "x86_64")]}
        self.signature = {"path": "net.dylib", "rc": 0, "output": ""}

    def inspect(self, exports=None):
        def sibling(name):
            if name == "m-imports":
                return SimpleNamespace(inspect=lambda *args: copy.deepcopy(self.binary))
            return SimpleNamespace(verify=lambda *args: self.signature)
        with patch.object(check, "sibling", side_effect=sibling), \
             patch.object(check.subprocess, "check_output",
                          side_effect=exports or ["_grc_net_module_v1\n_grc_net_rtc_v1\n_grc_net_tls_v1\n"] * 2) as nm:
            result = check.inspect(Path("net.dylib"))
        self.assertEqual(nm.call_count, 2)
        self.assertEqual([call.args[0][2] for call in nm.call_args_list], ["arm64", "x86_64"])
        return result

    def test_both_slices_pass(self):
        self.assertEqual([s["exports"] for s in self.inspect()["slices"]], [check.EXPECTED] * 2)

    def test_missing_slice_is_rejected(self):
        self.binary["slices"].pop()
        with self.assertRaisesRegex(ValueError, "exactly arm64 and x86_64"):
            self.inspect()

    def test_wrong_identity_is_rejected(self):
        self.binary["slices"][1]["identity"] = "net.dylib"
        with self.assertRaisesRegex(ValueError, "x86_64: expected install name"):
            self.inspect()

    def test_non_system_import_is_rejected(self):
        self.binary["slices"][1]["disallowed"] = ["/opt/homebrew/lib/libssl.dylib"]
        with self.assertRaisesRegex(ValueError, "x86_64: non-system imports"):
            self.inspect()

    def test_missing_or_extra_exports_on_either_slice_are_rejected(self):
        honest = "_grc_net_module_v1\n_grc_net_rtc_v1\n_grc_net_tls_v1\n"
        for index in (0, 1):
            missing = [honest.replace(symbol + "\n", "") for symbol in honest.splitlines()]
            for bad in (*missing, honest + "_accidental_export\n"):
                with self.subTest(index=index, exports=bad):
                    exports = [honest, honest]
                    exports[index] = bad
                    with self.assertRaisesRegex(ValueError, ("arm64", "x86_64")[index] + ": expected exports"):
                        self.inspect(exports)

    def test_invalid_signature_is_rejected(self):
        self.signature.update(rc=1, output="code object is not signed at all")
        with self.assertRaisesRegex(ValueError, "invalid net module signature"):
            self.inspect()


if __name__ == "__main__":
    unittest.main()
