#!/usr/bin/env python3
"""Run a prebuilt Windows capture test bundle and emit a partial validation summary."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def run_check(name, argv, bundle, out, env=None):
    start = time.monotonic()
    log = out / "logs" / (name + ".log")
    timed_out = False
    with log.open("wb") as stream:
        try:
            result = subprocess.run(argv, cwd=bundle, env={**os.environ, **(env or {})},
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=300)
            rc = result.returncode
        except subprocess.TimeoutExpired:
            timed_out, rc = True, 124
            stream.write(b"\nw-run: timed out after 300 s\n")
        except OSError as exc:
            rc = 1
            stream.write(("w-run: " + str(exc) + "\n").encode("utf-8"))
    wall = round(time.monotonic() - start, 3)
    print(f"{'ok  ' if rc == 0 else 'FAIL'} {name}: rc={rc}, {wall:.3f} s", flush=True)
    return {"name": name, "rc": rc, "wall_s": wall, "timed_out": timed_out}


def read_manifest(bundle):
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "render-stream-w-manifest/1":
        raise ValueError("unsupported bundle manifest schema")
    for group in ("tests", "imports_only", "sabotage"):
        if not isinstance(manifest.get(group), list):
            raise ValueError(f"manifest {group} must be a list")
        for entry in manifest[group]:
            if not isinstance(entry.get("exe"), str):
                raise ValueError(f"manifest {group} entry needs exe")
            if group == "tests" and not isinstance(entry.get("name"), str):
                raise ValueError("manifest test entry needs name")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--id", default="windows")
    parser.add_argument("--label", default="windows-win")
    parser.add_argument("--imports-tool", required=True)
    args = parser.parse_args()
    start = time.monotonic()
    bundle, out = Path(args.bundle).resolve(), Path(args.out).resolve()
    (out / "logs").mkdir(parents=True, exist_ok=True)
    tests, checks, toolchain = [], [], None
    rc = 0
    try:
        manifest = read_manifest(bundle)
        toolchain = json.loads((bundle / "toolchain.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        rc = 2
        log = out / "logs" / "bundle.log"
        log.write_text(f"w-run: bundle unavailable: {exc}\n", encoding="utf-8")
        print(log.read_text(encoding="utf-8"), end="", file=sys.stderr)
        checks.append({"name": "bundle", "rc": 2, "wall_s": 0})
    else:
        for test in manifest["tests"]:
            tests.append(run_check(test["name"], [str(bundle / test["exe"]), *test.get("args", [])],
                                   bundle, out, test.get("env", {})))
        imports = [str(bundle / e["exe"]) for e in manifest["tests"] + manifest["imports_only"]]
        tool = [sys.executable, "-I", str(Path(args.imports_tool).resolve())]
        checks.append(run_check("w-imports", tool + imports, bundle, out))
        for index, entry in enumerate(manifest["imports_only"]):
            if "expect_exports" in entry:
                checks.append(run_check(f"w-exports-{index + 1}", tool + ["--expect-exports",
                                        ",".join(entry["expect_exports"]), str(bundle / entry["exe"])],
                                        bundle, out))
        # Keep one named check and log even when several sabotage binaries are specified.
        sabotage_results = []
        for index, entry in enumerate(manifest["sabotage"]):
            name = "w-imports-sabotage" if index == 0 else f"w-imports-sabotage-{index + 1}"
            sabotage_results.append(run_check(name, tool + ["--expect-disallowed",
                                    ",".join(entry["expect_disallowed"]), str(bundle / entry["exe"])],
                                    bundle, out))
        if sabotage_results:
            combined = {"name": "w-imports-sabotage",
                        "rc": int(any(r["rc"] != 0 for r in sabotage_results)),
                        "wall_s": round(sum(r["wall_s"] for r in sabotage_results), 3)}
            for result in sabotage_results[1:]:
                with (out / "logs/w-imports-sabotage.log").open("ab") as stream:
                    stream.write((out / "logs" / (result["name"] + ".log")).read_bytes())
            checks.append(combined)
        rc = int(any(r["rc"] != 0 for r in tests + checks))
    failing = [r["name"] for r in tests + checks if r["rc"] != 0]
    wall = round(time.monotonic() - start, 3)
    write_json(out / "w-run.json", {"schema": "render-stream-w-run/1", "python": platform.python_version(),
               "platform": platform.platform(), "toolchain": toolchain, "tests": tests, "checks": checks,
               "wall_s": wall, "rc": rc})
    row = {"id": args.id, "phase": "setup", "rc": str(rc), "wall_s": wall,
           "lock_wait_s": 0, "lock_hold_s": 0, "lock": {}, "lock_summaries": 0,
           "skipped_by_tier": 0, "skipped_remote": [], "skipped_remote_groups": [],
           "unavailable": [], "known_flakes": [], "failing": failing}
    write_json(out / "validate-summary.json", {"schema": "render-stream-validate-summary/2",
               "partial": True, "wall_s": wall, "runs": [row], "failed": int(rc != 0)})
    for name in failing:
        evidence = out / "evidence" / args.label
        evidence.mkdir(parents=True, exist_ok=True)
        log = out / "logs" / (name + ".log")
        with log.open("rb") as stream:
            stream.seek(max(0, log.stat().st_size - 20 * 1024))
            (evidence / log.name).write_bytes(stream.read())
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as stream:
            stream.write(f"\n{args.label}\n\n| Check | rc | Wall (s) |\n| --- | --- | --- |\n")
            for result in tests + checks:
                stream.write(f"| {result['name']} | {result['rc']} | {result['wall_s']:.3f} |\n")
    print(f"w-run: {sum(r['rc'] == 0 for r in tests + checks)}/{len(tests + checks)} checks pass")
    return rc


if __name__ == "__main__":
    sys.exit(main())
