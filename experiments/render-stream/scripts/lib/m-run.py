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


def run_check(name, argv, repo, out, expected_rc=0, timeout_s=300):
    start = time.monotonic()
    log = out / "logs" / (name + ".log")
    with log.open("wb") as stream:
        try:
            rc = subprocess.run(argv, cwd=repo, stdout=stream, stderr=subprocess.STDOUT,
                                timeout=timeout_s).returncode
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


def net_test_counts(path):
    rows = re.findall(r"^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; "
                      r"\d+ measured; (\d+) filtered out;", path.read_text(encoding="utf-8"), re.MULTILINE)
    counts = {key: sum(int(row[index]) for row in rows)
              for index, key in enumerate(("passed", "failed", "ignored", "filtered_out"))}
    if not counts["passed"] or counts["failed"] or counts["ignored"] or counts["filtered_out"]:
        raise ValueError(f"rs-net did not pass every crate test: {counts}")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    start = time.monotonic()
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    (out / "logs").mkdir(parents=True, exist_ok=True)
    scripts = repo / "experiments/render-stream/scripts"
    build = repo / "experiments/render-stream/capture/build/macos"
    bundle = build / "bundle"
    checks, counts, net = [], None, None

    def check(name, argv, **kwargs):
        result = run_check(name, argv, repo, out, **kwargs)
        checks.append(result)
        if result["rc"]:
            raise ValueError(f"{name} failed")

    try:
        if platform.system() != "Darwin" or platform.machine() not in ("arm64", "x86_64"):
            raise ValueError("m-run requires a native arm64 or x86_64 macOS runner")
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

    failing = [r["name"] for r in checks if r["rc"]]
    rc = int(bool(failing))
    wall = round(time.monotonic() - start, 3)
    write_json(out / "m-run.json", {"schema": "render-stream-m-run/1", "platform": platform.platform(),
               "arch": platform.machine(), "ctest": counts, "net": net, "checks": checks, "wall_s": wall, "rc": rc})
    row = {"id": "macos", "phase": "setup", "rc": str(rc), "wall_s": wall,
           "lock_wait_s": 0, "lock_hold_s": 0, "lock": {}, "lock_summaries": 0,
           "skipped_by_tier": 0, "skipped_remote": [], "skipped_remote_groups": [],
           "unavailable": [], "known_flakes": [], "failing": [args.label + ":" + name for name in failing]}
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
            if net and "test_counts" in net:
                stream.write(f"\nrs-net: {net['test_counts']['passed']} passed, 0 failed/skipped "
                             f"({net['tests']['target']}).\n")
    print(f"m-run: {sum(r['rc'] == 0 for r in checks)}/{len(checks)} checks pass", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
