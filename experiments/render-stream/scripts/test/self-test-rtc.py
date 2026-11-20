#!/usr/bin/env python3
"""RTC hosted artifact failure propagation and planner coverage, without a browser or a Mac."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / "lib" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


merge = load("remote-merge-rtc")
runner = load("rtc-run")
spec = importlib.util.spec_from_file_location("rtc_sizes", SCRIPTS / "rtc-sizes.py")
size_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(size_runner)


def artifact(host):
    labels = (["chromium", "webkit"] if host == "linux" else ["safari", "iphone-safari"])
    value = {"ok": True, "platform": host, "browser": {"ok": True, "persistence": True,
             "results": {label + suffix: {"ok": True, "phases": {"connect": {"ok": True},
                         "workerFetch": {"ok": True, "controlled": True, "workerFetchIntercepted": True}}}
                         for label in labels for suffix in ["", "-negative"]}}}
    if host == "macos":
        value["sizes"] = {"targets": {target: {"default_bytes": 100, "rtc_bytes": 200, "delta_bytes": 100}
                                     for target in ["aarch64-apple-darwin", "x86_64-apple-darwin"]}}
    return value


class Hosted(unittest.TestCase):
    def test_worker_fetch_false_is_recorded_but_missing_or_untyped_is_failure(self):
        for host in ["linux", "macos"]:
            browser = artifact(host)["browser"]
            labels = list(browser["results"])
            for label in labels:
                phase = browser["results"][label]["phases"]["workerFetch"]
                phase.update(controlled=False, workerFetchIntercepted=False, error="unavailable")
            self.assertTrue(runner.result_ok(browser, labels))
            for label in labels:
                if label.endswith("-negative"):
                    continue
                phase = browser["results"][label]["phases"].pop("workerFetch")
                self.assertFalse(runner.result_ok(browser, labels))
                browser["results"][label]["phases"]["workerFetch"] = phase
                phase["controlled"] = "false"
                self.assertFalse(runner.result_ok(browser, labels))
                phase["controlled"] = False

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.jobs = Path(self.temp.name)
        self.summary = {"runs": [{"id": "rtc", "rc": "0", "failing": []}], "failed": 0}
        for host in ["linux", "macos"]:
            (self.jobs / host).mkdir()
            self.write(host, artifact(host))

    def write(self, host, value):
        (self.jobs / host / f"rtc-{host}.json").write_text(json.dumps(value))

    def verdict(self):
        return merge.fold(copy.deepcopy(self.summary), self.jobs)

    def test_both_platforms_and_phase_results_retained(self):
        result = self.verdict()
        self.assertEqual(result["failed"], 0)
        self.assertEqual(set(result["runs"][0]["rtc"]), {"linux", "macos"})
        self.assertTrue(result["runs"][0]["rtc"]["linux"]["browser"]["results"]["chromium"]["phases"]["connect"]["ok"])

    def test_missing_each_platform_fails(self):
        for host in ["linux", "macos"]:
            path = self.jobs / host / f"rtc-{host}.json"
            path.unlink()
            self.assertEqual(self.verdict()["failed"], 1)
            self.write(host, artifact(host))

    def test_failed_or_missing_each_browser_fails(self):
        for host in ["linux", "macos"]:
            for label in artifact(host)["browser"]["results"]:
                for missing in [False, True]:
                    value = artifact(host)
                    if missing:
                        del value["browser"]["results"][label]
                    else:
                        value["browser"]["results"][label]["ok"] = False
                    self.write(host, value)
                    self.assertEqual(self.verdict()["failed"], 1, label)
                self.write(host, artifact(host))

    def test_missing_sizes_and_corrupt_artifacts_fail(self):
        for value in [{}, {"targets": {}}]:
            mac = artifact("macos")
            mac["sizes"] = value
            self.write("macos", mac)
            self.assertEqual(self.verdict()["failed"], 1)
        (self.jobs / "macos/rtc-macos.json").write_text("broken")
        self.assertEqual(self.verdict()["failed"], 1)

    def test_duplicate_artifact_fails(self):
        (self.jobs / "duplicate").mkdir()
        (self.jobs / "duplicate/rtc-macos.json").write_text(json.dumps(artifact("macos")))
        self.assertEqual(self.verdict()["failed"], 1)

    def test_existing_failure_is_never_overridden(self):
        self.summary["runs"][0]["rc"] = "missing"
        self.assertEqual(self.verdict()["failed"], 1)

    def test_other_runs_unchanged(self):
        summary = {"runs": [{"id": "pure", "rc": "0"}], "failed": 0}
        self.assertEqual(merge.fold(copy.deepcopy(summary), self.jobs), summary)

    def test_runner_rejects_missing_or_failed_results(self):
        browser = artifact("linux")["browser"]
        self.assertTrue(runner.result_ok(browser, ["chromium", "webkit"]))
        self.assertFalse(runner.result_ok(None, ["chromium"]))
        self.assertFalse(runner.result_ok(browser, ["safari"]))
        browser["persistence"] = False
        self.assertFalse(runner.result_ok(browser, ["chromium"]))

    def test_generic_merge_requires_both_platform_summaries(self):
        for host in ["linux", "macos"]:
            result = artifact(host) | {"wall_s": 1, "lock_wait_s": 0}
            (self.jobs / host / "validate-summary.json").write_text(json.dumps({"runs": [runner.row(result)]}))
        remote = self.jobs / "remote.json"
        remote.write_text(json.dumps({"shards": {"rtc": 2}}))
        out = self.jobs / "merged"
        command = ["python3", "-I", str(SCRIPTS / "lib/validate-summary.py"), "--merge", "--out", str(out),
                   "--expect", "rtc", "--remote-json", str(remote)]
        both = subprocess.run(command + [str(self.jobs / host) for host in ["linux", "macos"]], capture_output=True)
        self.assertEqual(both.returncode, 0, both.stderr)
        merged = merge.fold(json.loads((out / "validate-summary.json").read_text()), self.jobs)
        self.assertEqual(merged["failed"], 0)
        self.assertEqual(len(merged["runs"][0]["shards"]), 2)
        missing = subprocess.run(command + [str(self.jobs / "linux")], capture_output=True)
        self.assertEqual(missing.returncode, 1, missing.stderr)
        self.assertEqual(json.loads((out / "validate-summary.json").read_text())["runs"][0]["rc"], "missing")


class ProbeEvidence(unittest.TestCase):
    def test_handshake_logs_keep_timestamps_and_collapse_repeated_channel_events(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            events = [
                {"event":"first-stun", "source":"192.0.2.2:42", "tMs":1},
                {"source":"192.0.2.2:42", "detail":{"event":"dtls-connected"}, "tMs":3},
                {"event":"sctp-up", "source":"192.0.2.2:42", "tMs":4},
                *[{"source":"192.0.2.2:42", "detail":{"event":"channel-open"}, "tMs":n} for n in [5, 6]],
            ]
            (out / "browsers.json.probe.jsonl").write_text("\n".join(map(json.dumps, events))+"\nbroken\n")
            evidence = runner.probe_evidence(out)
            self.assertEqual(len(evidence), 1)
            self.assertEqual([e["tMs"] for e in evidence[0]["milestones"]], [1, 3, 4, 5])
            self.assertEqual(evidence[0]["counts"]["channel-open"], 2)
            self.assertEqual(evidence[0]["invalid_lines"], 1)

class DarwinRunner(unittest.TestCase):
    def run_host(self, failure=None, host="Darwin"):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                effective = command[3:] if command[0].endswith("quiet.sh") else command
                if effective[:2] == ["cargo", "test"] and failure:
                    if isinstance(failure, Exception):
                        raise failure
                    kwargs["stdout"].write("quiet.sh: line 610: BASHPID: unbound variable\n")
                    return subprocess.CompletedProcess(command, 7)
                if command[0] == "node":
                    kwargs["stdout"].write('{"ip":"10.0.0.4"}')
                if "--out" in command:
                    dest = Path(command[command.index("--out") + 1])
                    dest.write_text(json.dumps(artifact("macos")["sizes" if any(arg.endswith("rtc-sizes.py") for arg in command) else "browser"]))
                    if dest.name == "browsers.json":
                        (out / "browsers.json.probe.jsonl").write_text(json.dumps({"event":"sctp-up","source":"192.0.2.2:42","tMs":123})+"\n")
                return subprocess.CompletedProcess(command, 0)

            with patch.object(runner.platform, "system", return_value=host), \
                 patch.object(runner.subprocess, "run", side_effect=run), \
                 patch("sys.argv", ["rtc-run.py", "--out", temp, "--summary"]):
                rc = runner.main()
            result = json.loads((out / f"rtc-{'macos' if host == 'Darwin' else 'linux'}.json").read_text())
            summary = json.loads((out / "validate-summary.json").read_text())
            return rc, result, summary, commands

    def test_darwin_runs_without_quiet_lock(self):
        rc, result, summary, commands = self.run_host()
        self.assertEqual(rc, 0, result)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(result["lock_wait_s"], 0)
        self.assertEqual(result["probe_events"][0]["milestones"][0]["tMs"], 123)
        self.assertTrue(any(command[:2] == ["cargo", "test"] for command in commands))
        self.assertTrue(any(command[:2] == ["cargo", "build"] for command in commands))
        self.assertFalse(any("quiet.sh" in arg for command in commands for arg in command))

    def test_linux_keeps_shared_feature_test_lock(self):
        _, _, _, commands = self.run_host(host="Linux")
        self.assertTrue(any(command[1:5] == ["shared", "--", "cargo", "test"] for command in commands))

    def test_command_failures_include_reason_and_log_tail(self):
        rc, result, summary, _ = self.run_host(failure=True)
        self.assertEqual(rc, 1)
        failed = next(c for c in result["commands"] if c["name"] == "feature-tests")
        self.assertEqual(failed["rc"], 7)
        self.assertEqual(result["probe_events"][0]["milestones"][0]["event"], "sctp-up")
        self.assertIn("exit status 7", failed["error"])
        self.assertIn("BASHPID: unbound variable", failed["log_tail"])
        self.assertTrue(failed["log"].endswith("feature-tests.log"))
        self.assertEqual(failed["argv"][:2], ["cargo", "test"])
        self.assertIn("feature-tests", summary["runs"][0]["failing"][0])

    def test_timeout_and_spawn_errors_are_preserved(self):
        for error in [subprocess.TimeoutExpired(["cargo"], 1200), FileNotFoundError("cargo missing")]:
            with self.subTest(error=error):
                rc, result, _, _ = self.run_host(failure=error)
                self.assertEqual(rc, 1)
                failed = next(c for c in result["commands"] if c["name"] == "feature-tests")
                self.assertIn(str(error), failed["error"])

    def test_darwin_size_builds_use_native_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                effective = command[3:] if command[0].endswith("quiet.sh") else command
                if effective[:2] == ["cargo", "build"]:
                    target = effective[effective.index("--target") + 1]
                    library = root / "target" / target / "release/librender_stream_net.dylib"
                    library.parent.mkdir(parents=True, exist_ok=True)
                    if "--features" in command:
                        self.assertEqual(command[command.index("--features") + 1], "rtc")
                    library.write_bytes(b"rtc" if "--features" in command else b"base")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("platform.system", return_value="Darwin"), \
                 patch.object(size_runner, "NET", root), \
                 patch.object(size_runner.shutil, "which", return_value="/usr/bin/strip"), \
                 patch.object(size_runner.subprocess, "run", side_effect=run):
                sizes = size_runner.measure(["aarch64-apple-darwin", "x86_64-apple-darwin"], root / "sizes.json")
            self.assertEqual(len(sizes), 2)
            self.assertEqual(sum(c[:2] == ["cargo", "build"] for c in commands), 4)
            self.assertEqual(sum(c[:2] == ["/usr/bin/strip", "-x"] for c in commands), 4)
            self.assertFalse(any("quiet.sh" in arg for command in commands for arg in command))

    def test_size_build_failure_includes_underlying_error(self):
        with tempfile.TemporaryDirectory() as temp:
            def run(command, **kwargs):
                kwargs["stdout"].write("error: native linker failed\n")
                return subprocess.CompletedProcess(command, 9)

            with patch("platform.system", return_value="Darwin"), \
                 patch.object(size_runner.subprocess, "run", side_effect=run), \
                 self.assertRaisesRegex(RuntimeError, "native linker failed"):
                size_runner.measure(["aarch64-apple-darwin"], Path(temp) / "sizes.json")

    def test_shell_probe_bypasses_quiet_on_darwin(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / "experiments/render-stream/scripts"
            (scripts / "lib").mkdir(parents=True)
            script = scripts / "rtc-g0.sh"
            script.write_text((SCRIPTS / "rtc-g0.sh").read_text())
            (scripts / "lib/quiet.sh").write_text("#!/bin/sh\nexit 99\n")
            (scripts / "lib/quiet.sh").chmod(0o755)
            tools = root / "tools"
            tools.mkdir()
            for name, body in {"uname": "echo Darwin", "mise": "exit 0", "node": "exit 0"}.items():
                path = tools / name
                path.write_text(f"#!/bin/sh\n{body}\n")
                path.chmod(0o755)
            result = subprocess.run(["bash", str(script), "probe", "--ip", "10.0.0.4"],
                                    env=dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}"), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


class ShippedExports(unittest.TestCase):
    def test_macos_requires_exact_three_exports_in_each_slice(self):
        spec = importlib.util.spec_from_file_location("net_check", SCRIPTS / "m-net-check.py")
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)
        symbols = ["_grc_net_module_v1", "_grc_net_rtc_v1", "_grc_net_tls_v1"]
        def sibling(name):
            if name == "m-imports":
                return SimpleNamespace(inspect=lambda *_: {"slices": [
                    {"arch": arch, "identity": checker.IDENTITY, "disallowed": []}
                    for arch in ["arm64", "x86_64"]]})
            return SimpleNamespace(verify=lambda *_: {"rc": 0})
        with patch.object(checker, "sibling", side_effect=sibling):
            with patch.object(checker.subprocess, "check_output", return_value="\n".join(symbols)):
                result = checker.inspect(Path("net.dylib"))
                for image in result["slices"]:
                    self.assertEqual(image["exports"], [s[1:] for s in symbols])
            for arch in ["arm64", "x86_64"]:
                for bad in [symbols[::2], symbols + ["_extra"]]:
                    def nm(argv, **_):
                        return "\n".join(bad if arch in argv else symbols)
                    with patch.object(checker.subprocess, "check_output", side_effect=nm):
                        with self.assertRaisesRegex(ValueError, arch + ": expected exports"):
                            checker.inspect(Path("net.dylib"))


if __name__ == "__main__":
    unittest.main()
