#!/usr/bin/env python3
"""Build and check the native macOS capture bundle, preserving a partial validation summary."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


POSIX_CTESTS = ("rs_ws", "rs_carrier_set", "rs_texture_cache", "rs_publish",
               "rs_sigpipe", "rs_sigpipe_no_nosigpipe")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run_check(name, argv, repo, out, expected_rc=0, timeout_s=300, env=None):
    start = time.monotonic()
    log = out / "logs" / (name + ".log")
    with log.open("wb") as stream:
        try:
            rc = subprocess.run(argv, cwd=repo, stdout=stream, stderr=subprocess.STDOUT,
                                timeout=timeout_s, env={**os.environ, **(env or {})}).returncode
        except (OSError, subprocess.TimeoutExpired) as exc:
            rc = 124 if isinstance(exc, subprocess.TimeoutExpired) else 2
            stream.write(f"m-run: {exc}\n".encode())
    wall = round(time.monotonic() - start, 3)
    ok = rc == expected_rc
    print(f"{'ok  ' if ok else 'FAIL'} {name}: rc={rc}, expected={expected_rc}, {wall:.3f} s", flush=True)
    if not ok:
        print(log.read_text(encoding="utf-8", errors="replace")[-20000:], flush=True)
    return {"name": name, "rc": int(not ok), "process_rc": rc,
            "expected_rc": expected_rc, "wall_s": wall}


def ctest_counts(path, required=()):
    suite = ET.parse(path).getroot()
    counts = {key: int(suite.attrib.get(key, 0)) for key in ("tests", "failures", "disabled", "skipped", "errors")}
    cases = suite.findall("testcase")
    bad_cases = any(case.find(tag) is not None for case in cases for tag in ("failure", "error", "skipped"))
    if (counts["tests"] == 0 or len(cases) != counts["tests"] or bad_cases
            or any(counts[key] for key in ("failures", "disabled", "skipped", "errors"))):
        raise ValueError(f"ctest did not pass every test: {counts}")
    missing = set(required) - {case.attrib.get("name") for case in cases}
    if missing:
        raise ValueError(f"ctest missing required tests: {sorted(missing)}")
    return counts


def ctest_retries(path):
    # JUnit retains the final result only. CTest's output keeps each attempt, including
    # the failed first attempt of a recovered test and tests that exhaust both attempts.
    try:
        output = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return []
    attempts = {}
    for name, status, wall in re.findall(
            r"^\s*(?:\d+/\d+\s+)?Test\s+#\d+:\s+(\S+)\s+\.{2,}\s*(.*?)\s+(\d+(?:\.\d+)?)\s+sec\s*$",
            output, re.MULTILINE):
        attempts.setdefault(name, []).append({"status": status, "wall_s": float(wall)})
    return [{"name": name, "attempts": rows, "recovered": rows[-1]["status"] == "Passed"}
            for name, rows in attempts.items() if len(rows) > 1]


def net_test_counts(path):
    rows = re.findall(r"^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; "
                      r"\d+ measured; (\d+) filtered out;", path.read_text(encoding="utf-8"), re.MULTILINE)
    counts = {key: sum(int(row[index]) for row in rows)
              for index, key in enumerate(("passed", "failed", "ignored", "filtered_out"))}
    if not counts["passed"] or counts["failed"] or counts["ignored"] or counts["filtered_out"]:
        raise ValueError(f"rs-net did not pass every crate test: {counts}")
    return counts


def read_swap_manifest(bundle):
    manifest = json.loads((bundle / "mswap/manifest.json").read_text(encoding="utf-8"))
    expected = [{"name": "mswap", "exe": "mswap/mswap-driver.py", "interpreter": "python",
                 "args": ["--config", "mswap/mswap-{arch}.json"], "env": {}, "timeout_s": 1500}]
    if manifest.get("schema") != "render-stream-m-manifest/1" or manifest.get("tests") != expected:
        raise ValueError("swap manifest must contain exactly one Python mswap entry with timeout_s 1500")
    return manifest


def run_swap(check, repo, out, runtime_bundle):
    if runtime_bundle is None:
        raise ValueError("--suite swap requires --runtime-bundle")
    runtime = runtime_bundle.resolve()
    manifest = read_swap_manifest(runtime)
    scripts = repo / "experiments/render-stream/scripts"
    native = repo / "experiments/render-stream/capture/build/macos/bundle"
    check("m-build", ["bash", str(scripts / "build-capture.sh"), "--target", "macos"], timeout_s=1800)
    dylib = native / "librender_stream_capture.dylib"
    shutil.copy2(dylib, runtime / "m1/ext/librender_stream_capture.dylib")
    config = json.loads((runtime / f"m1/m1-{platform.machine()}.json").read_text())
    template = runtime / "m1" / config["template"]
    template.chmod(0o755)
    # Only the locally built capture is signed; the stock template stays byte-for-byte intact.
    check("m-imports", [sys.executable, "-I", str(scripts / "m-imports.py"),
          "--require-universal", "--json", str(out / "imports.json"), str(dylib)])
    check("m-sign", [sys.executable, "-I", str(scripts / "m-sign.py"),
          "--json", str(out / "signatures.json"), str(runtime / "m1/ext/librender_stream_capture.dylib")])
    for test in manifest["tests"]:
        argv = [sys.executable, "-I", "-B", str(runtime / test["exe"]),
                "--config", str(runtime / test["args"][1].format(arch=platform.machine())),
                "--repo", str(repo)]
        check(test["name"], argv, timeout_s=test["timeout_s"],
              env={"M_RUN_ARTIFACT_DIR": str(out / "artifacts" / test["name"])})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("capture", "swap"), default="capture")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--runtime-bundle", type=Path, help="Ubuntu-prepared stock template and imported fixture")
    args = parser.parse_args()
    start = time.monotonic()
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    (out / "logs").mkdir(parents=True, exist_ok=True)
    scripts = repo / "experiments/render-stream/scripts"
    build = repo / "experiments/render-stream/capture/build/macos"
    bundle = build / "bundle"
    checks, counts, net = [], None, None
    retries = []

    def check(name, argv, **kwargs):
        nonlocal retries
        result = run_check(name, argv, repo, out, **kwargs)
        checks.append(result)
        if name == "m-build":
            retries = ctest_retries(out / "logs/m-build.log")
        if name.startswith("m1-") and args.runtime_bundle:
            source = args.runtime_bundle.resolve() / "m1/runs" / name.removeprefix("m1-")
            if source.is_dir():
                shutil.copytree(source, out / "m1" / name.removeprefix("m1-"), dirs_exist_ok=True)
        if result["rc"]:
            raise ValueError(f"{name} failed")

    try:
        if platform.system() != "Darwin" or platform.machine() not in ("arm64", "x86_64"):
            raise ValueError("m-run requires a native arm64 or x86_64 macOS runner")
        if args.suite == "swap":
            run_swap(check, repo, out, args.runtime_bundle)
        else:
            check("m-build", ["bash", str(scripts / "build-capture.sh"), "--target", "macos"], timeout_s=1800)
            counts = ctest_counts(bundle / "ctest.xml", required=POSIX_CTESTS)
            binaries = sorted((bundle / "bin").glob("*"))
            if not binaries or not (bundle / "bin/abi_convention_probe").is_file():
                raise ValueError("universal test bundle is missing the ABI convention probe")
            dylib = bundle / "librender_stream_capture.dylib"
            if not dylib.is_file():
                raise ValueError("universal capture dylib is missing")
            binaries.append(dylib)
            for arch in ("arm64", "x86_64"):
                shutil.copyfile(build / arch / "CTestTestfile.cmake", out / f"ctest-{arch}.cmake")
            shutil.copyfile(bundle / "ctest.xml", out / "ctest.xml")
            shutil.copyfile(bundle / "build-info.txt", out / "build-info.txt")
            check("m-net-tests", [sys.executable, "-I", str(scripts / "m-net-test.py")])
            check("m-net-build", ["bash", str(scripts / "build-rs-net.sh"), "--target", "macos"], timeout_s=1800)
            net = json.loads((bundle / "rs-net-build.json").read_text())
            host_target = "aarch64-apple-darwin" if platform.machine() == "arm64" else "x86_64-apple-darwin"
            if net["tests"] != {"target": host_target, "ran": True}:
                raise ValueError(f"rs-net must run the host slice's crate tests: {net['tests']}")
            net["test_counts"] = net_test_counts(out / "logs/m-net-build.log")
            for artifact in ("rs-net-build.json", "rs-net-check.json"):
                shutil.copyfile(bundle / artifact, out / artifact)
            binaries.append(bundle / "librender_stream_net.dylib")
            imports = [sys.executable, "-I", str(scripts / "m-imports.py")]
            sign = [sys.executable, "-I", str(scripts / "m-sign.py")]
            check("m-imports", imports + ["--require-universal", "--json", str(out / "imports.json"),
                                         *map(str, binaries)])
            check("m-sign", sign + ["--json", str(out / "signatures.json"), *map(str, binaries), str(bundle / "rs-net-probe")])

            if args.runtime_bundle:
                runtime = args.runtime_bundle.resolve() / "m1"
                config = runtime / f"m1-{platform.machine()}.json"
                # The template is used byte-for-byte. Only restore mode lost by artifact transport.
                template = runtime / "godot_macos_release.universal"
                template.chmod(0o755)
                shutil.copy2(dylib, runtime / "ext/librender_stream_capture.dylib")
                check("m-runtime-tests", [sys.executable, "-I", "-B", str(scripts / "m-runtime-test.py")])
                for leg in ("control", "validate", "arm", "refuse-shift", "refuse-image"):
                    check("m1-" + leg, [sys.executable, "-I", "-B", str(runtime / "m1-driver.py"),
                          "--config", str(config), "--leg", leg], timeout_s=240)
                files = args.runtime_bundle.resolve() / "mfile"
                file_command = [sys.executable, "-I", "-B", str(files / "mfile-driver.py"),
                                "--config", str(files / f"mfile-{platform.machine()}.json")]
                for rep in ("a", "b"):
                    for gate in ("gate0", "gate1", "gate2", "gate8"):
                        check(f"mfile-{gate}-{rep}", file_command + ["--gate", gate, "--rep", rep,
                              "--out", str(out / "mfile")], timeout_s=900)
                check("mfile-negative", file_command + ["--gate", "gate8", "--rep", "a",
                      "--sabotage", "decode-off", "--out", str(out / "mfile-negative")], timeout_s=900)

            sabotage = out / "sabotage"
            sabotage.mkdir(exist_ok=True)
            (sabotage / "dependency.c").write_text("int external_value(void) { return 42; }\n")
            (sabotage / "host.c").write_text("int external_value(void); int main(void) { return external_value() != 42; }\n")
            dependency = sabotage / "non-system.dylib"
            host = sabotage / "non-system-host"
            check("m-imports-sabotage-library", ["xcrun", "clang", "-dynamiclib", str(sabotage / "dependency.c"),
                  "-Wl,-install_name," + str(dependency), "-o", str(dependency)])
            check("m-imports-sabotage-host", ["xcrun", "clang", str(sabotage / "host.c"),
                  str(dependency), "-o", str(host)])
            check("m-imports-sabotage", imports + ["--json", str(out / "imports-sabotage.json"), str(host)], expected_rc=1)
            rejected = json.loads((out / "imports-sabotage.json").read_text())
            if rejected["binaries"][0]["slices"][0]["disallowed"] != [str(dependency)]:
                raise ValueError("import sabotage did not identify the non-system dylib")

            unsigned = sabotage / "unsigned-arm64"
            check("m-sign-sabotage-thin", ["lipo", str(bundle / "bin/abi_convention_probe"),
                  "-thin", "arm64", "-output", str(unsigned)])
            # Establish that the copy is valid before changing exactly its signature.
            check("m-sign-sabotage-control", sign + [str(unsigned)])
            check("m-sign-sabotage-remove", ["codesign", "--remove-signature", str(unsigned)])
            check("m-sign-sabotage", sign + [str(unsigned)], expected_rc=1)
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as exc:
        log = out / "logs/m-bundle.log"
        log.write_text(f"m-run: {exc}\n", encoding="utf-8")
        checks.append({"name": "m-bundle", "rc": 1, "wall_s": 0})
        print(log.read_text(), end="", file=sys.stderr)

    groups = {}
    if args.suite == "swap":
        swap = [r for r in checks if r["name"] == "mswap"]
        groups["m-swap"] = {"passed": sum(r["rc"] == 0 for r in swap), "total": len(swap)}
        print(f"gate M: m-swap {groups['m-swap']['passed']}/{groups['m-swap']['total']}", flush=True)
    failing = [r["name"] for r in checks if r["rc"]]
    rc = int(bool(failing))
    wall = round(time.monotonic() - start, 3)
    write_json(out / "m-run.json", {"schema": "render-stream-m-run/1", "platform": platform.platform(),
               "arch": platform.machine(), "ctest": counts, "ctest_retries": retries,
               "net": net, "checks": checks, "groups": groups, "wall_s": wall, "rc": rc})
    row = {"id": "macos", "phase": "setup", "rc": str(rc), "wall_s": wall,
           "lock_wait_s": 0, "lock_hold_s": 0, "lock": {}, "lock_summaries": 0,
           "skipped_by_tier": 0, "skipped_remote": [], "skipped_remote_groups": [],
           "unavailable": [], "known_flakes": [args.label + ":ctest:" + r["name"] for r in retries if r["recovered"]],
           "ctest_retries": retries, "failing": [args.label + ":" + name for name in failing]}
    write_json(out / "validate-summary.json", {"schema": "render-stream-validate-summary/2",
               "partial": True, "wall_s": wall, "runs": [row], "failed": rc})
    for name in failing:
        evidence = out / "evidence" / args.label
        evidence.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out / "logs" / (name + ".log"), evidence / (name + ".log"))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"\n{args.label}\n\n| Check | rc | Wall (s) |\n| --- | --- | --- |\n")
            for result in checks:
                stream.write(f"| {result['name']} | {result['rc']} | {result['wall_s']:.3f} |\n")
            if counts:
                stream.write(f"\nctest: {counts['tests']} passed, 0 failed/skipped.\n")
            if retries:
                stream.write("\n| Retried ctest | Attempts (status, wall s) | Recovered |\n| --- | --- | --- |\n")
                for retry in retries:
                    attempts = "; ".join(f"{a['status']} ({a['wall_s']:.3f})" for a in retry["attempts"])
                    stream.write(f"| {retry['name']} | {attempts} | {retry['recovered']} |\n")
            if net and "test_counts" in net:
                stream.write(f"\nrs-net: {net['test_counts']['passed']} passed, 0 failed/skipped "
                             f"({net['tests']['target']}).\n")
    print(f"m-run: {sum(r['rc'] == 0 for r in checks)}/{len(checks)} checks pass", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
